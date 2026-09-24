import { validateEvent } from "./validator.js";

/**
 * 超慢跑风险接力服务。
 *
 * 设计要点：
 * - 事件溯源：所有结论都由只追加事件重放得到，进程中断后重读事件流即可继续
 *   待复核、到期观察与未确认通知，不依赖内存。
 * - 计划版本冻结：适用人群、负荷区间、停止条件、批准角色随 PLAN_APPROVED 冻结，
 *   复训必须产生新版本的批准，不能沿用旧批准。
 * - 时间分离：observed_at（事实发生时间）与 received_at（系统接收时间）分别保留；
 *   迟到记录按 observed_at 解释历史，按 received_at 采取当下行动。
 * - 系统只提出风险等级（RISK_ASSESSED.level），是否复训由合格角色决定。
 */

export const RULE_VERSION = "risk-rules-1.0";

/** 可批准计划的角色。 */
export const PLAN_APPROVER_ROLES = new Set([
  "community_sport_instructor",
  "sports_medicine_physician",
  "rehabilitation_specialist",
]);

/** 可确认复训的角色（须具备医疗/康复职责；社区指导员不能单独确认）。 */
export const RESUME_ROLES = new Set([
  "sports_medicine_physician",
  "rehabilitation_specialist",
]);

export class ServiceError extends Error {}

const t = (iso) => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new ServiceError(`非法时间：${iso}`);
  return ms;
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * 风险规则：仅输出建议等级。
 * 命中观察发生时有效计划版本中冻结的停止条件 → stop_line；
 * 医疗紧急建议/高 → high；中 → elevated；其余 low。
 * 内容冲突不在规则层自动消解：每个观察独立评估，交由复核处理。
 */
function assessLevel(content, source, planAtTime) {
  const code = content?.code;
  const severity = content?.severity;
  if (planAtTime && code && planAtTime.stop_conditions.some((c) => c.code === code)) {
    return { level: "stop_line", stopConditionCode: code };
  }
  if (source?.type === "medical_advice" && ["high", "urgent", "stop"].includes(severity)) {
    return { level: "high", stopConditionCode: null };
  }
  if (severity === "high") return { level: "high", stopConditionCode: null };
  if (severity === "moderate") return { level: "elevated", stopConditionCode: null };
  return { level: "low", stopConditionCode: null };
}

export class RiskHandoffService {
  /**
   * @param {object} store InMemoryEventStore 或 FileEventStore
   * @param {{now?: () => string}} [opts]
   */
  constructor(store, opts = {}) {
    this.store = store;
    this.clock = opts.now ?? (() => new Date().toISOString());
  }

  // ---------- 内部：读取与追加 ----------

  #events(participantId) {
    return this.store.read(participantId);
  }

  #append(participantId, event) {
    const errors = validateEvent(event);
    if (errors.length) throw new ServiceError(`事件校验失败：${errors.join("；")}`);
    return this.store.append(participantId, event);
  }

  #next(participantId, type, aggregateType, aggregateId, occurredAt, summary, payload) {
    const seq = this.#events(participantId).length + 1;
    return {
      event_id: `${participantId}-e${String(seq).padStart(4, "0")}`,
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: occurredAt,
      version: seq,
      summary,
      payload: clone(payload),
    };
  }

  // ---------- 状态重放 ----------

  /**
   * 重放参与者的全部事件得到当前状态。纯派生，可随时重建。
   */
  getState(participantId, nowIso = this.clock()) {
    const events = this.#events(participantId);
    const state = {
      participantId,
      plans: [],
      sessions: new Map(),
      observations: [],
      assessments: [],
      pauses: [],
      reviews: new Map(),
      resumes: [],
      events,
    };
    const planIndex = new Map(); // plan_id -> [versions]

    for (const e of events) {
      const p = e.payload;
      switch (e.event_type) {
        case "PLAN_APPROVED": {
          const plan = {
            ...clone(p),
            status: "active",
            supersededByResumeEventId: null,
            approvedEventId: e.event_id,
          };
          state.plans.push(plan);
          if (!planIndex.has(p.plan_id)) planIndex.set(p.plan_id, []);
          planIndex.get(p.plan_id).push(plan);
          break;
        }
        case "SESSION_SCHEDULED": {
          state.sessions.set(p.session_id, {
            session_id: p.session_id,
            plan_id: p.plan_id,
            plan_version: p.plan_version,
            slot_at: p.slot_at,
            expected_duration_minutes: p.expected_duration_minutes ?? 60,
            load_level: p.load_level,
            scheduled_at: e.occurred_at,
            record: null,
            scheduleEventId: e.event_id,
          });
          break;
        }
        case "SESSION_RECORDED": {
          const s = state.sessions.get(p.session_id);
          if (s) {
            s.record = {
              completed: p.completed,
              started_at: p.started_at ?? null,
              finished_at: p.finished_at ?? null,
              load_level: p.load_level ?? s.load_level,
              facts: p.recorded_facts ?? {},
              recorded_at: p.recorded_at,
              note: p.note ?? "",
              recordEventId: e.event_id,
            };
          }
          break;
        }
        case "OBSERVATION_IMPORTED":
          state.observations.push({ ...clone(p), eventId: e.event_id, eventOccurredAt: e.occurred_at });
          break;
        case "RISK_ASSESSED":
          state.assessments.push({ ...clone(p), eventId: e.event_id });
          break;
        case "ACTIVITY_PAUSED":
          state.pauses.push({ ...clone(p), eventId: e.event_id });
          // 停止线后相关旧计划冻结：在被“风险解除”解冻或被新版本取代前，
          // 不能再按旧批准排期；其他计划（局部暂停范围外）不受影响。
          for (const pl of state.plans) {
            if (pl.status === "active" && p.scope.plan_id === pl.plan_id) pl.status = "paused";
          }
          break;
        case "REVIEW_OPENED":
          state.reviews.set(p.review_id, {
            ...clone(p),
            status: "open",
            completion: null,
            openEventId: e.event_id,
          });
          break;
        case "REVIEW_COMPLETED": {
          const r = state.reviews.get(p.review_id);
          if (r) {
            r.status = "completed";
            r.completion = { ...clone(p), completedEventId: e.event_id };
          }
          // 结论为风险解除：仅解冻该复核对应暂停所冻结的计划。
          // 之后若再触发停止线，后续 ACTIVITY_PAUSED 会在重放顺序中再次冻结。
          if (p.decision === "resolved") {
            const pause = state.pauses.find((pa) => pa.eventId === r.trigger_event_id);
            for (const pl of state.plans) {
              if (pl.status === "paused" && (!pause?.scope.plan_id || pause.scope.plan_id === pl.plan_id)) {
                pl.status = "active";
              }
            }
          }
          break;
        }
        case "TRAINING_RESUMED": {
          state.resumes.push({ ...clone(p), eventId: e.event_id });
          // 旧批准不沿用：复训点之前的所有版本一律标记 superseded。
          for (const pl of state.plans) {
            if (pl.plan_id === p.previous_plan_id && pl.plan_version < p.new_plan_version) {
              pl.status = "superseded";
            }
          }
          const fresh = state.plans.find(
            (pl) => pl.plan_id === p.new_plan_id && pl.plan_version === p.new_plan_version
          );
          if (fresh) fresh.status = "active";
          break;
        }
      }
    }

    state.planAt = (atIso) => {
      const at = t(atIso);
      let hit = null;
      for (const versions of planIndex.values()) {
        for (const plan of versions) {
          if (t(plan.effective_from) <= at && (!hit || t(plan.effective_from) > t(hit.effective_from))) {
            hit = plan;
          }
        }
      }
      return hit;
    };
    state.latestPlanVersion = (planId) => {
      const versions = planIndex.get(planId) ?? [];
      return versions.reduce((m, pl) => Math.max(m, pl.plan_version), 0);
    };
    state.findPlan = (planId, version) =>
      state.plans.find((pl) => pl.plan_id === planId && pl.plan_version === version) ?? null;

    // 判断一次暂停是否已被“风险解除”复核关闭（require_new_plan 由复训事件另行取代）。
    const isPauseResolved = (pauseEventId) =>
      [...state.reviews.values()].some(
        (r) => r.trigger_event_id === pauseEventId && r.status === "completed" && r.completion?.decision === "resolved"
      );

    // 计划级暂停对场次的覆盖：该暂停之后若出现更晚的复训（新版本生效），
    // 则只约束早于新版本的旧场次；没有后续复训时约束该计划全部场次。
    const resumesAfter = (pause) =>
      state.resumes
        .filter((r) => r.new_plan_id === pause.scope.plan_id && t(r.resumed_at) > t(pause.effective_from))
        .sort((a, b) => t(a.resumed_at) - t(b.resumed_at))[0]?.new_plan_version ?? Number.POSITIVE_INFINITY;

    // 场次派生状态：暂停只覆盖“暂停生效时尚未开始”的场次；取最新一次匹配暂停，
    // 已被“风险解除”关闭、或已被暂停之后的新版计划复训越过的旧计划级暂停不再约束场次。
    const nowMs = t(nowIso);
    for (const s of state.sessions.values()) {
      let coveringPause = null;
      for (const pa of state.pauses) {
        const sc = pa.scope;
        let matches;
        if (sc.kind === "plan") {
          matches = sc.plan_id === s.plan_id && s.plan_version < resumesAfter(pa);
        } else {
          matches = (sc.activity_ids ?? []).includes(s.session_id);
        }
        if (matches) coveringPause = pa; // 取最后一次（事件顺序）
      }
      if (coveringPause && isPauseResolved(coveringPause.eventId)) coveringPause = null;
      s.pauseEventId = coveringPause?.eventId ?? null;
      if (s.record) {
        s.status = s.record.completed ? "completed" : "interrupted";
        if (coveringPause && t(s.record.started_at ?? s.slot_at) >= t(coveringPause.effective_from)) {
          // 暂停生效后仍完成：事实保留，但属于违例完成，recordSession 时会补开复核。
          s.status = "completed_after_pause";
        }
      } else if (coveringPause && t(s.slot_at) > t(coveringPause.effective_from)) {
        s.status = "paused_before_start";
      } else if (coveringPause) {
        s.status = "scheduled_paused_span";
      } else {
        s.status = t(s.slot_at) < nowMs ? "unscheduled_done" : "scheduled";
      }
    }
    return state;
  }

  // ---------- 命令：计划 ----------

  /**
   * 批准（冻结）一版计划。
   * @returns {object} PLAN_APPROVED 事件
   */
  approvePlan(participantId, input) {
    const existing = this.#events(participantId);
    const payload = {
      plan_id: input.plan_id ?? `plan-${participantId}`,
      plan_version: input.plan_version,
      supersedes_plan_id: input.supersedes_plan_id ?? null,
      applicable_group: input.applicable_group,
      load_ladder: input.load_ladder,
      stop_conditions: input.stop_conditions,
      approver: input.approver,
      approved_at: input.approved_at ?? this.clock(),
      effective_from: input.effective_from ?? input.approved_at ?? this.clock(),
    };
    if (!PLAN_APPROVER_ROLES.has(input.approver?.role)) {
      throw new ServiceError(`角色 ${input.approver?.role} 无权批准计划`);
    }
    if (!payload.applicable_group?.conditions?.length) throw new ServiceError("必须冻结适用人群条件");
    if (!Array.isArray(payload.load_ladder) || !payload.load_ladder.length) throw new ServiceError("必须冻结负荷阶梯");
    for (const rung of payload.load_ladder) {
      const z = rung.zone;
      if (!z || typeof z.metric !== "string" || !(z.min < z.max)) throw new ServiceError("负荷区间必须含 metric 且 min < max");
    }
    if (!Array.isArray(payload.stop_conditions) || !payload.stop_conditions.length) {
      throw new ServiceError("必须冻结至少一条停止条件");
    }
    const state = existing.length ? this.getState(participantId) : null;
    if (payload.plan_version == null) {
      payload.plan_version = state ? state.latestPlanVersion(payload.plan_id) + 1 : 1;
    } else if (state && payload.plan_version <= state.latestPlanVersion(payload.plan_id)) {
      throw new ServiceError("计划版本号必须递增，旧版本已冻结不可改写");
    }
    const event = this.#next(
      participantId,
      "PLAN_APPROVED",
      "participant_plan",
      payload.plan_id,
      payload.approved_at,
      `批准计划 ${payload.plan_id} v${payload.plan_version}（冻结适用人群、负荷区间、停止条件）`,
      payload
    );
    return this.#append(participantId, event);
  }

  // ---------- 命令：场次 ----------

  scheduleSession(participantId, input) {
    const state = this.getState(participantId);
    const plan = state.findPlan(input.plan_id, input.plan_version);
    if (!plan) throw new ServiceError("计划版本不存在，场次必须挂在已冻结的计划版本上");
    if (plan.status !== "active") throw new ServiceError(`计划 ${input.plan_id} v${input.plan_version} 已被新版本取代或暂停`);
    if (state.sessions.has(input.session_id)) throw new ServiceError("场次已存在，更正请产生后继记录");
    if (!plan.load_ladder.some((r) => r.level === input.load_level)) throw new ServiceError("负荷等级不在冻结阶梯内");
    if (t(input.slot_at) < t(plan.effective_from)) throw new ServiceError("场次时间早于该版本计划生效时间");
    const scheduledAt = input.scheduled_at ?? this.clock();
    const payload = {
      plan_id: input.plan_id,
      plan_version: input.plan_version,
      session_id: input.session_id,
      slot_at: input.slot_at,
      expected_duration_minutes: input.expected_duration_minutes ?? 60,
      load_level: input.load_level,
    };
    const event = this.#next(
      participantId,
      "SESSION_SCHEDULED",
      "activity_session",
      input.session_id,
      scheduledAt,
      `排期场次 ${input.session_id}（依据 ${input.plan_id} v${input.plan_version}）`,
      payload
    );
    return this.#append(participantId, event);
  }

  /**
   * 记录场次事实。事实一经记录不原地改写；
   * 即使场次后来被暂停或进入复核，已记录事实仍按当时情况保留。
   */
  recordSession(participantId, input) {
    const state = this.getState(participantId);
    const s = state.sessions.get(input.session_id);
    if (!s) throw new ServiceError("场次不存在，无法记录");
    if (s.record) throw new ServiceError("场次已有记录，事实不可原地改写；更正应产生后继记录");
    const recordedAt = input.recorded_at ?? this.clock();
    const payload = {
      plan_id: s.plan_id,
      plan_version: s.plan_version,
      session_id: input.session_id,
      started_at: input.started_at ?? s.slot_at,
      finished_at: input.finished_at ?? null,
      completed: Boolean(input.completed),
      load_level: input.load_level ?? s.load_level,
      recorded_facts: input.recorded_facts ?? {},
      recorded_at: recordedAt,
      note: input.note ?? "",
    };
    const event = this.#next(
      participantId,
      "SESSION_RECORDED",
      "activity_session",
      input.session_id,
      recordedAt,
      `记录场次 ${input.session_id}：${payload.completed ? "已完成" : "中断"}（事实保留）`,
      payload
    );
    this.#append(participantId, event);

    // 暂停生效后补录完成的场次（迟到补录）：事实不可改写，立即补开复核收纳。
    const after = this.getState(participantId);
    const updated = after.sessions.get(input.session_id);
    let lateReview = null;
    if (updated.status === "completed_after_pause") {
      const alreadyReviewed = [...after.reviews.values()].some((r) =>
        r.included_session_ids.includes(input.session_id)
      );
      if (!alreadyReviewed) {
        const reviewId = `review:late:${input.session_id}`;
        lateReview = this.#append(
          participantId,
          this.#next(
            participantId,
            "REVIEW_OPENED",
            "clinical_handoff",
            `handoff:${participantId}`,
            recordedAt,
            `迟到补录：场次 ${input.session_id} 在暂停生效后完成，事实保留并补入复核`,
            {
              review_id: reviewId,
              trigger_event_id: updated.pauseEventId,
              reason: `场次 ${input.session_id} 完成时间晚于暂停生效时间（迟到补录），保持当时事实并进入复核`,
              opened_at: recordedAt,
              included_session_ids: [input.session_id],
              observation_ids: [],
            }
          )
        );
      }
    }
    return { recorded: event, late_review: lateReview };
  }

  // ---------- 命令：观察导入（含迟到、幂等、冲突隔离） ----------

  /**
   * 导入一条自述 / 现场观察 / 医疗建议。
   * - 同一 observation_id 完全重放：直接返回既有结果，不重复评估与升级。
   * - 迟到记录：按 observed_at 解释它影响哪些历史场次，按 received_at 立即采取行动。
   * - 冲突：不同 conflict_key 的矛盾观察各自留存、独立评估，不互相覆盖。
   *
   * @returns {{duplicate: boolean, imported?: object, assessment?: object, pause?: object|null, review?: object|null}}
   */
  importObservation(participantId, input) {
    const receivedAt = input.received_at ?? this.clock();
    const observedAt = input.observed_at;
    if (!observedAt) throw new ServiceError("观察必须含发生时间 observed_at");
    if (t(observedAt) > t(receivedAt)) throw new ServiceError("发生时间不能晚于接收时间");

    const state = this.getState(participantId);
    const duplicate = state.observations.find((o) => o.observation_id === input.observation_id);
    if (duplicate) {
      const assessment = state.assessments.find((a) => a.observation_ids.includes(input.observation_id)) ?? null;
      const pause = assessment ? state.pauses.find((p) => p.trigger_event_id === assessment.eventId) ?? null : null;
      const review = pause
        ? [...state.reviews.values()].find((r) => r.trigger_event_id === pause.eventId && r.observation_ids?.includes(input.observation_id)) ?? null
        : null;
      return { duplicate: true, imported: duplicate, assessment, pause, review };
    }

    const obsPayload = {
      observation_id: input.observation_id,
      source: input.source,
      observed_at: observedAt,
      received_at: receivedAt,
      content: input.content,
      conflict_key: input.conflict_key ?? null,
    };
    const imported = this.#append(
      participantId,
      this.#next(
        participantId,
        "OBSERVATION_IMPORTED",
        "risk_observation",
        input.observation_id,
        observedAt, // 事件发生时间取业务事实时间
        sourceLabel(input.source) + `：${input.content.code}`,
        obsPayload
      )
    );

    // 风险判断只针对观察所归属活动线“发生时”有效的冻结计划版本
    //（迟到记录影响历史解释；多计划并存时优先按关联/重叠场次定位）。
    const planAtTime = resolveObservationPlan(state, input, observedAt);
    const verdict = assessLevel(input.content, input.source, planAtTime);
    const rationale = buildRationale(input, planAtTime, verdict);
    const assessed = this.#append(
      participantId,
      this.#next(
        participantId,
        "RISK_ASSESSED",
        "risk_observation",
        `risk:${input.observation_id}`,
        receivedAt,
        `系统提出风险等级：${verdict.level}`,
        {
          observation_ids: [input.observation_id],
          level: verdict.level,
          stop_condition_code: verdict.stopConditionCode,
          rule_version: RULE_VERSION,
          rationale,
          assessed_at: receivedAt,
        }
      )
    );

    let pause = null;
    let review = null;
    if (verdict.level === "stop_line") {
      ({ pause, review } = this.#triggerStopLine(participantId, {
        state: this.getState(participantId),
        observation: obsPayload,
        assessmentEvent: assessed,
        receivedAt,
      }));
    }
    return { duplicate: false, imported, assessment: assessed, pause, review };
  }

  #triggerStopLine(participantId, { state, observation, assessmentEvent, receivedAt }) {
    const observedAt = observation.observed_at;
    const planAtTime = resolveObservationPlan(state, { content: observation.content }, observedAt);
    const affectedPlanId = planAtTime?.plan_id ?? null;

    // 历史解释（按 observed_at）：
    // 1) 与症状发生时间重叠的已记录场次（包括显式关联场次）；
    // 2) 停止线之后、记录到达之前仍完成的场次——迟到期间“已按旧计划练完”的场次。
    const includedSessionIds = [];
    const pauseTargetIds = [];
    for (const s of state.sessions.values()) {
      if (affectedPlanId && s.plan_id !== affectedPlanId) continue;
      if (s.record) {
        const { start, end } = sessionWindow(s);
        const overlaps = start <= t(observedAt) && end >= t(observedAt);
        const referenced = observation.content.session_id === s.session_id;
        const doneBetween = t(s.slot_at) > t(observedAt) && end <= t(receivedAt);
        if (overlaps || referenced || doneBetween) includedSessionIds.push(s.session_id);
      } else if (t(s.slot_at) > t(receivedAt)) {
        // 行动时刻（received_at）尚未开始：立即暂停。
        pauseTargetIds.push(s.session_id);
      }
    }

    const scope = pauseTargetIds.length
      ? { kind: "activity", plan_id: affectedPlanId, activity_ids: [...new Set(pauseTargetIds)].sort() }
      : { kind: "plan", plan_id: affectedPlanId, activity_ids: [] };

    const pause = this.#append(
      participantId,
      this.#next(
        participantId,
        "ACTIVITY_PAUSED",
        "clinical_handoff",
        `handoff:${participantId}`,
        receivedAt,
        pauseTargetIds.length
          ? `触发停止线 ${observation.content.code}，立即暂停 ${pauseTargetIds.length} 场尚未开始的活动`
          : `触发停止线 ${observation.content.code}，计划进入暂停`,
        {
          scope,
          reason: `观察 ${observation.observation_id} 命中停止条件 ${observation.content.code}`,
          trigger_event_id: assessmentEvent.event_id,
          stop_condition_code: observation.content.code,
          effective_from: receivedAt,
        }
      )
    );

    const reviewId = `review-${observation.observation_id}`;
    const review = this.#append(
      participantId,
      this.#next(
        participantId,
        "REVIEW_OPENED",
        "clinical_handoff",
        `handoff:${participantId}`,
        receivedAt,
        `开启复核：${includedSessionIds.length} 场已完成场次保持事实进入复核`,
        {
          review_id: reviewId,
          trigger_event_id: pause.event_id,
          reason: `停止线 ${observation.content.code}（观察 ${observation.observation_id}，发生于 ${observedAt}）`,
          opened_at: receivedAt,
          included_session_ids: [...new Set(includedSessionIds)].sort(),
          observation_ids: [observation.observation_id],
        }
      )
    );
    return { pause, review };
  }

  // ---------- 命令：复核与复训 ----------

  completeReview(participantId, input) {
    const state = this.getState(participantId);
    const review = state.reviews.get(input.review_id);
    if (!review) throw new ServiceError("复核不存在");
    if (review.status === "completed") throw new ServiceError("复核已完成，结论不可原地改写");
    if (!PLAN_APPROVER_ROLES.has(input.reviewer?.role)) throw new ServiceError(`角色 ${input.reviewer?.role} 无权出具复核结论`);
    if (!["remain_paused", "require_new_plan", "resolved"].includes(input.decision)) {
      throw new ServiceError("复核结论非法");
    }
    const completedAt = input.completed_at ?? this.clock();
    const payload = {
      review_id: input.review_id,
      reviewer: input.reviewer,
      decision: input.decision,
      findings: input.findings ?? "",
      evidence_event_ids: input.evidence_event_ids ?? deriveReviewEvidence(state, review),
      completed_at: completedAt,
    };
    return this.#append(
      participantId,
      this.#next(
        participantId,
        "REVIEW_COMPLETED",
        "clinical_handoff",
        `handoff:${participantId}`,
        completedAt,
        `复核完成：${decisionLabel(input.decision)}`,
        payload
      )
    );
  }

  /**
   * 确认复训：合格角色冻结新的负荷阶梯与观察期限，产生新版计划批准。
   * 旧批准不沿用；旧计划版本标记 superseded，旧排期未来场次保持暂停。
   */
  resumeTraining(participantId, input) {
    const state = this.getState(participantId);
    if (!RESUME_ROLES.has(input.confirmer?.role)) {
      throw new ServiceError(`角色 ${input.confirmer?.role} 不具备确认复训的职责`);
    }
    const review = state.reviews.get(input.review_id);
    if (!review) throw new ServiceError("复训必须基于一次复核");
    if (review.status !== "completed") throw new ServiceError("复核尚未完成，不能复训");
    if (review.completion.decision !== "require_new_plan") {
      throw new ServiceError("只有结论为 require_new_plan 的复核可以进入新版计划复训");
    }
    const resumedAt = input.resumed_at ?? this.clock();
    if (!input.observation_window_until || t(input.observation_window_until) <= t(resumedAt)) {
      throw new ServiceError("必须确认晚于复训时间的观察期限");
    }
    if (!Array.isArray(input.load_ladder) || !input.load_ladder.length) throw new ServiceError("必须确认新的负荷阶梯");

    const previousPlanId = input.previous_plan_id ?? state.planAt(review.opened_at)?.plan_id;
    if (!previousPlanId) throw new ServiceError("无法确定被取代的旧计划");
    const previousVersion = state.latestPlanVersion(previousPlanId);
    const previousPlan = state.findPlan(previousPlanId, previousVersion);
    if (!previousPlan) throw new ServiceError("旧计划版本不存在");

    // 先冻结新版计划（新批准，不沿用旧批准）。
    const approved = this.approvePlan(participantId, {
      plan_id: previousPlanId,
      plan_version: previousVersion + 1,
      supersedes_plan_id: previousPlanId,
      applicable_group: input.applicable_group ?? previousPlan.applicable_group,
      load_ladder: input.load_ladder,
      stop_conditions: input.stop_conditions ?? previousPlan.stop_conditions,
      approver: input.confirmer,
      approved_at: resumedAt,
      effective_from: resumedAt,
    });

    const evidence = input.based_on_event_ids?.length
      ? input.based_on_event_ids
      : deriveResumeEvidence(state, review, approved.event_id, previousPlanId, previousVersion);

    const payload = {
      new_plan_id: previousPlanId,
      new_plan_version: previousVersion + 1,
      previous_plan_id: previousPlanId,
      confirmer: input.confirmer,
      load_ladder: clone(input.load_ladder),
      observation_window_until: input.observation_window_until,
      based_on_event_ids: [...new Set(evidence)],
      resumed_at: resumedAt,
    };
    return this.#append(
      participantId,
      this.#next(
        participantId,
        "TRAINING_RESUMED",
        "clinical_handoff",
        `handoff:${participantId}`,
        resumedAt,
        `复训确认：启用 ${previousPlanId} v${previousVersion + 1}，观察期至 ${input.observation_window_until}`,
        payload
      )
    );
  }

  // ---------- 查询：待办（中断恢复后继续） ----------

  /**
   * 纯派生待办：进程中断后重放事件流即可得到同一结果。
   * @param {string} nowIso
   */
  getPendingWork(participantId, nowIso = this.clock()) {
    const state = this.getState(participantId);
    const now = t(nowIso);

    const pendingReviews = [...state.reviews.values()]
      .filter((r) => r.status === "open")
      .map((r) => ({
        review_id: r.review_id,
        reason: r.reason,
        opened_at: r.opened_at,
        included_session_ids: r.included_session_ids,
        overdue: t(r.opened_at) < now,
      }));

    // 未确认通知：stop_line 判断尚未被针对该观察的复核结论闭环。
    const closedByObservation = new Set();
    for (const r of state.reviews.values()) {
      if (r.status === "completed") for (const oid of r.observation_ids ?? []) closedByObservation.add(oid);
    }
    const unconfirmedAlerts = state.assessments
      .filter((a) => a.level === "stop_line")
      .map((a) => ({
        assessment_event_id: a.eventId,
        observed_at: state.observations.find((o) => a.observation_ids.includes(o.observation_id))?.observed_at,
        confirmed: a.observation_ids.every((oid) => closedByObservation.has(oid)),
      }))
      .filter((x) => !x.confirmed);

    // 到期观察：复训观察窗到期检查；窗口内出现新 stop_line 则要求重新复核。
    const dueObservationWindows = state.resumes.map((r) => {
      const laterStopLine = state.assessments.some((a) => {
        if (a.level !== "stop_line") return false;
        const obs = state.observations.find((o) => a.observation_ids.includes(o.observation_id));
        return obs && t(obs.observed_at) >= t(r.resumed_at);
      });
      return {
        resume_event_id: r.eventId,
        plan_id: r.new_plan_id,
        plan_version: r.new_plan_version,
        window_until: r.observation_window_until,
        status: laterStopLine ? "new_risk_requires_review" : t(r.observation_window_until) <= now ? "due" : "within_window",
      };
    });

    return { pending_reviews: pendingReviews, unconfirmed_alerts: unconfirmedAlerts, due_observation_windows: dueObservationWindows };
  }

  // ---------- 查询：视图 ----------

  /** 参与者视图：只暴露必要提示，不含医疗代码、证据链与他人信息。 */
  participantView(participantId, nowIso = this.clock()) {
    const state = this.getState(participantId);
    const now = t(nowIso);
    const latestResume = state.resumes.at(-1) ?? null;
    const openReview = [...state.reviews.values()].find((r) => r.status === "open") ?? null;

    const pausedSessions = [...state.sessions.values()]
      .filter((s) => s.status === "paused_before_start")
      .sort((a, b) => t(a.slot_at) - t(b.slot_at))
      .map((s) => ({ session_id: s.session_id, slot_at: s.slot_at }));

    const inWindow = latestResume && t(latestResume.observation_window_until) > now;
    let status;
    let message;
    if (openReview) {
      status = pausedSessions.length ? "paused_partial_pending_review" : "paused_pending_review";
      message = "你的部分活动已暂停，指导员会联系你安排复核，复核后再告知恢复安排。";
    } else if (inWindow) {
      status = "resumed_under_observation";
      message = `你已按调整后的计划恢复训练，观察期至 ${latestResume.observation_window_until}，如有不适请立即告知指导员。`;
    } else if (pausedSessions.length) {
      status = "activities_paused";
      message = "你近期有活动已暂停，请等待指导员通知。";
    } else {
      status = "normal";
      message = "按当前计划参加活动，运动中如有不适请立即停止并告知指导员。";
    }

    return {
      status,
      message,
      paused_sessions: pausedSessions,
      observation_window_until: inWindow ? latestResume.observation_window_until : null,
      schedule: [...state.sessions.values()]
        .sort((a, b) => t(a.slot_at) - t(b.slot_at))
        .map((s) => ({
          session_id: s.session_id,
          slot_at: s.slot_at,
          status: participantSessionStatus(s.status),
        })),
    };
  }

  /** 专业人员视图：完整证据、版本与派生状态。 */
  professionalView(participantId, nowIso = this.clock()) {
    const state = this.getState(participantId);
    return {
      plans: state.plans.map((p) => ({
        plan_id: p.plan_id,
        plan_version: p.plan_version,
        status: p.status,
        applicable_group: p.applicable_group,
        load_ladder: p.load_ladder,
        stop_conditions: p.stop_conditions,
        approver: p.approver,
        approved_at: p.approved_at,
        effective_from: p.effective_from,
        approved_event_id: p.approvedEventId,
      })),
      sessions: [...state.sessions.values()].map((s) => ({
        session_id: s.session_id,
        plan_id: s.plan_id,
        plan_version: s.plan_version,
        slot_at: s.slot_at,
        load_level: s.load_level,
        status: s.status,
        record: s.record,
        pause_event_id: s.pauseEventId,
      })),
      observations: state.observations,
      assessments: state.assessments,
      pauses: state.pauses,
      reviews: [...state.reviews.values()],
      resumes: state.resumes,
      pending_work: this.getPendingWork(participantId, nowIso),
      timeline: this.reconstructTimeline(participantId),
    };
  }

  /**
   * 还原一次暂停、调整与复训使用了哪些证据和计划版本。
   * 返回按因果顺序排列、标注阶段的事件清单。
   */
  reconstructTimeline(participantId) {
    const events = this.#events(participantId);
    const phase = {
      PLAN_APPROVED: "计划冻结",
      SESSION_SCHEDULED: "场次排期",
      SESSION_RECORDED: "场次事实",
      OBSERVATION_IMPORTED: "证据导入",
      RISK_ASSESSED: "风险判断",
      ACTIVITY_PAUSED: "暂停",
      REVIEW_OPENED: "复核",
      REVIEW_COMPLETED: "复核",
      TRAINING_RESUMED: "复训",
    };
    return events.map((e) => ({
      phase: phase[e.event_type],
      event_id: e.event_id,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      version: e.version,
      summary: e.summary,
      plan_ref: planRefOf(e),
      payload: e.payload,
    }));
  }
}

// ---------- 辅助 ----------

function sourceLabel(source) {
  switch (source?.type) {
    case "self_report":
      return "参与者自述";
    case "field_observation":
      return "现场观察";
    case "medical_advice":
      return "医疗建议";
    default:
      return "观察";
  }
}

/**
 * 场次的实际/预期时间窗口（毫秒）。
 * 已记录：以记录的开始/结束时间为准；未记录：按排期时间加预期时长。
 */
function sessionWindow(s) {
  const start = t(s.record?.started_at ?? s.slot_at);
  let end;
  if (s.record) {
    end = t(s.record.finished_at ?? s.record.recorded_at ?? s.slot_at);
  } else {
    end = start + (s.expected_duration_minutes ?? 60) * 60_000;
  }
  return { start, end };
}

/**
 * 解析一条观察归属的活动线及其发生时有效的冻结计划版本：
 * 1) 观察显式关联场次 → 该场次的计划版本；
 * 2) 否则取与发生时间重叠、且其计划停止条件包含该代码的场次；
 * 3) 再退化为任意时间重叠场次；
 * 4) 最后回退到 observed_at 时生效的计划。
 */
function resolveObservationPlan(state, input, observedAt) {
  const at = t(observedAt);
  const sessions = [...state.sessions.values()];
  const referenced = input.content?.session_id
    ? sessions.find((s) => s.session_id === input.content.session_id)
    : null;
  if (referenced) return state.findPlan(referenced.plan_id, referenced.plan_version);

  const overlapping = sessions.filter((s) => {
    const { start, end } = sessionWindow(s);
    return start <= at && end >= at;
  });
  const matchingCode = overlapping.find((s) => {
    const plan = state.findPlan(s.plan_id, s.plan_version);
    return plan?.stop_conditions.some((c) => c.code === input.content?.code);
  });
  if (matchingCode) return state.findPlan(matchingCode.plan_id, matchingCode.plan_version);
  if (overlapping[0]) return state.findPlan(overlapping[0].plan_id, overlapping[0].plan_version);
  return state.planAt(observedAt);
}

function buildRationale(input, planAtTime, verdict) {
  const base = `${sourceLabel(input.source)}（发生 ${input.observed_at}，接收 ${input.received_at}）代码 ${input.content.code}`;
  if (verdict.level === "stop_line" && planAtTime) {
    return `${base} 命中计划 ${planAtTime.plan_id} v${planAtTime.plan_version} 冻结停止条件，建议等级 stop_line`;
  }
  return `${base} 未命中冻结停止条件，按规则 ${RULE_VERSION} 建议等级 ${verdict.level}`;
}

function deriveReviewEvidence(state, review) {
  const ids = [...review.observation_ids];
  for (const sid of review.included_session_ids) {
    const s = state.sessions.get(sid);
    if (s?.record?.recordEventId) ids.push(s.record.recordEventId);
    if (s?.scheduleEventId) ids.push(s.scheduleEventId);
  }
  const pause = state.pauses.find((p) => p.eventId === review.trigger_event_id);
  if (pause) {
    ids.push(pause.eventId);
    const assessment = state.assessments.find((a) => a.eventId === pause.trigger_event_id);
    if (assessment) ids.push(assessment.eventId);
  }
  return [...new Set(ids)];
}

function deriveResumeEvidence(state, review, newPlanEventId, previousPlanId, previousVersion) {
  const ids = [
    review.openEventId,
    review.completion.completedEventId,
    newPlanEventId,
  ];
  // 被取代的旧计划冻结版本。
  const previousPlan = state.findPlan(previousPlanId, previousVersion);
  if (previousPlan) ids.push(previousPlan.approvedEventId);
  // 复核收纳的全部证据（观察、场次记录、暂停与判断）。
  ids.push(...(review.completion.evidence_event_ids ?? []));
  // 所有医疗建议均纳入复训证据。
  for (const o of state.observations) if (o.source.type === "medical_advice") ids.push(o.eventId);
  return [...new Set(ids)];
}

function decisionLabel(d) {
  return { remain_paused: "继续暂停", require_new_plan: "需新版计划复训", resolved: "风险解除" }[d];
}

function participantSessionStatus(status) {
  // 参与者侧不暴露“违例完成”等内部判定，仅给必要状态。
  switch (status) {
    case "paused_before_start":
    case "scheduled_paused_span":
      return "已暂停";
    case "completed":
    case "completed_after_pause":
      return "已完成";
    case "interrupted":
      return "已中断";
    default:
      return "待进行";
  }
}

function planRefOf(event) {
  const p = event.payload;
  if (!p) return null;
  if (event.event_type === "TRAINING_RESUMED") return { plan_id: p.new_plan_id, plan_version: p.new_plan_version };
  if (p.plan_id) return { plan_id: p.plan_id, plan_version: p.plan_version };
  return null;
}
