/**
 * 风险接力服务：在只追加的事件流上提供
 * 计划冻结、多源证据导入、停止线自动暂停、复核与有职责角色的复训确认。
 *
 * 时间约定：
 *  - 事件 occurred_at 是系统接收时间（接收时间线）。
 *  - payload.observed_at / started_at / effective_from 是事实发生时间（事实时间线）。
 *  - 迟到记录按事实时间参与历史解释；动作（暂停/通知）只作用于"现在"仍未开始的活动。
 */

import { validateEvent } from "./validator.js";
import {
  evidenceFingerprint,
  evaluateLevel,
  isolateConflicts,
  matchStopLines,
  planEffectiveAt,
} from "./rules.js";

const LATE_TOLERANCE_MS = 60_000;
const REVIEW_SLA_MS = 24 * 3600_000;

export class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function t(value) {
  return Date.parse(value);
}

function defaultClock() {
  return new Date().toISOString();
}

export class RiskRelay {
  /**
   * @param {{now?: () => string, idPrefix?: string}} options
   */
  constructor(options = {}) {
    this._now = options.now ?? defaultClock;
    this._prefix = options.idPrefix ?? "evt";
    this._counter = 0;
    /** @type {object[]} 全部事件 */
    this.events = [];
    this._seenIds = new Set();
    this._aggVersion = new Map();
    this._state = new Map();
  }

  _nextId() {
    let id;
    do {
      this._counter += 1;
      id = `${this._prefix}-${String(this._counter).padStart(4, "0")}`;
    } while (this._seenIds.has(id)); // 与日志中已有标识错开
    return id;
  }

  // ---------------------------------------------------------------- 事件追加

  /**
   * 追加一条已校验事件。同一 event_id（服务重启重放 / 同一观察完全重放）幂等：
   * 已存在的标识直接跳过，不产生第二次效果。
   */
  append(event) {
    const errors = validateEvent(event);
    if (errors.length) throw new BusinessError("INVALID_EVENT", errors.join("；"));
    if (this._seenIds.has(event.event_id)) return event;
    this._seenIds.add(event.event_id);
    this.events.push(event);
    this._apply(event);
    return event;
  }

  /** 从历史日志重放：只重建投影，不触发任何自动化（效果已固化在历史事件中）。 */
  restore(events) {
    for (const event of events) {
      const errors = validateEvent(event);
      if (errors.length) throw new BusinessError("INVALID_EVENT", errors.join("；"));
      if (this._seenIds.has(event.event_id)) continue;
      this._seenIds.add(event.event_id);
      this.events.push(event);
    }
    this._rebuild();
    // 新事件编号接续日志中已有的生成标识，避免重放后撞号。
    const suffix = new RegExp(`^${this._prefix}-(\\d+)$`);
    for (const id of this._seenIds) {
      const m = suffix.exec(id);
      if (m) this._counter = Math.max(this._counter, Number(m[1]));
    }
    return this;
  }

  _rebuild() {
    this._aggVersion = new Map();
    this._state = new Map();
    for (const event of [...this.events].sort((a, b) => t(a.occurred_at) - t(b.occurred_at))) {
      this._apply(event);
    }
  }

  _emit(type, aggregateType, aggregateId, payload, summary, at) {
    const version = (this._aggVersion.get(aggregateId) ?? 0) + 1;
    this._aggVersion.set(aggregateId, version);
    return this.append({
      event_id: this._nextId(),
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: at ?? this._now(),
      version,
      summary,
      payload,
    });
  }

  // ---------------------------------------------------------------- 投影状态

  _p(id) {
    let s = this._state.get(id);
    if (!s) {
      s = {
        plans: [],
        evidence: [],
        dedupe: new Map(),
        sessions: new Map(),
        riskFlags: [],
        stopTriggers: [],
        pauses: [],
        reviews: [],
        returns: [],
        notifications: [],
        /** 当前计划周期内已触发的停止线码（恢复后清空） */
        activeStopCodes: new Set(),
        activePauseScopes: [],
        openReview: null,
        /** 本周期风险基线时间点（恢复后重新计），等级只升不降在周期内成立 */
        cycleStartedAt: null,
        currentPlanVersion: null,
      };
      this._state.set(id, s);
    }
    return s;
  }

  _apply(event) {
    const p = event.payload;
    const id = p.participant_id;
    if (typeof id !== "string") return;
    const s = this._p(id);
    this._aggVersion.set(event.aggregate_id, event.version);

    switch (event.event_type) {
      case "PLAN_APPROVED":
        s.plans.push(event);
        s.currentPlanVersion = p.plan_version;
        break;
      case "EVIDENCE_RECORDED":
        s.evidence.push(event);
        s.dedupe.set(p.source_record_id ?? evidenceFingerprint(stripRuntime(p)), event.event_id);
        break;
      case "SESSION_SCHEDULED":
        s.sessions.set(p.session_id, {
          session_id: p.session_id,
          activity_ref: p.activity_ref ?? null,
          scheduled_at: p.scheduled_at,
          planned_plan_version: p.planned_plan_version,
          recorded: null,
        });
        break;
      case "SESSION_RECORDED": {
        const sess = s.sessions.get(p.session_id) ?? {
          session_id: p.session_id,
          activity_ref: p.activity_ref ?? null,
          scheduled_at: p.scheduled_at,
          planned_plan_version: p.planned_plan_version,
        };
        sess.recorded = event;
        s.sessions.set(p.session_id, sess);
        break;
      }
      case "RISK_FLAGGED":
        s.riskFlags.push(event);
        break;
      case "STOP_LINE_TRIGGERED":
        s.stopTriggers.push(event);
        s.activeStopCodes.add(p.stop_line_code);
        break;
      case "ACTIVITY_PAUSED":
        s.pauses.push(event);
        s.activePauseScopes.push({ scope: p.scope, at: event.occurred_at });
        break;
      case "REVIEW_OPENED":
        s.reviews.push({ opened: event, completed: null });
        s.openReview = p.review_id;
        break;
      case "REVIEW_COMPLETED": {
        const review = s.reviews.find((r) => r.opened.payload.review_id === p.review_id);
        if (review) review.completed = event;
        if (s.openReview === p.review_id && p.decision !== "REOPEN") s.openReview = null;
        break;
      }
      case "RETURN_CONFIRMED":
        s.returns.push(event);
        break;
      case "ACTIVITY_RESUMED":
        // 进入新计划周期：停止线与暂停范围清零，旧批准不再约束也不再庇护。
        s.activeStopCodes = new Set();
        s.activePauseScopes = [];
        s.cycleStartedAt = event.occurred_at;
        s.currentPlanVersion = p.plan_version;
        break;
      case "NOTIFICATION_QUEUED":
        s.notifications.push({ queued: event, acked: null });
        break;
      case "NOTIFICATION_ACKED": {
        const note = s.notifications.find((n) => n.queued.event_id === p.notification_event_id);
        if (note) note.acked = event;
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- 命令：计划

  /** 批准一版计划并冻结适用人群、负荷区间、停止条件与批准角色。 */
  approvePlan(input) {
    const at = this._now();
    const s = this._p(input.participant_id);
    if (s.plans.some((e) => e.payload.plan_version === input.plan_version)) {
      throw new BusinessError("DUPLICATE_PLAN_VERSION", `计划版本已存在：${input.plan_version}`);
    }
    if (input.supersedes && !s.plans.some((e) => e.payload.plan_version === input.supersedes)) {
      throw new BusinessError("UNKNOWN_PARENT_PLAN", `被取代的计划版本不存在：${input.supersedes}`);
    }
    if (input.approver?.role === "PARTICIPANT") {
      throw new BusinessError("FORBIDDEN_ROLE", "参与者不能批准训练计划");
    }
    return this._emit(
      "PLAN_APPROVED",
      "participant_plan",
      `plan-${input.participant_id}-${input.plan_version}`,
      { ...input, effective_from: input.effective_from ?? at },
      `批准 ${input.participant_id} 计划 ${input.plan_version}，冻结适用人群/负荷区间/停止条件`,
      at,
    );
  }

  // ---------------------------------------------------------------- 命令：证据

  /**
   * 导入一条自述 / 现场观察 / 医疗建议。
   * observed_at 为事实发生时间；迟到（observed_at 早于接收时间）按事实时间解释历史。
   * 同一观察完全重放（来源记录号或来源+发生时间+内容指纹一致）返回 duplicated，
   * 不追加事件、不重复升级。
   */
  importEvidence(input) {
    const receivedAt = this._now();
    const s = this._p(input.participant_id);
    const payload = {
      participant_id: input.participant_id,
      observed_at: input.observed_at,
      source: input.source,
      source_record_id: input.source_record_id,
      topic: input.topic,
      findings: input.findings,
      note: input.note,
    };
    const dedupeKey = input.source_record_id ?? evidenceFingerprint(payload);
    if (s.dedupe.has(dedupeKey)) {
      return { status: "duplicated", events: [], evidence_event_id: s.dedupe.get(dedupeKey) };
    }

    // 事实时间线：该观察发生时刻适用的冻结计划；没有计划无法解释停止条件。
    const plan = planEffectiveAt(s.plans, input.observed_at) ?? s.plans[s.plans.length - 1];
    if (!plan) throw new BusinessError("NO_PLAN", "证据导入前必须存在已批准计划");

    const evidence = this._emit(
      "EVIDENCE_RECORDED",
      "risk_observation",
      `obs-${input.participant_id}-${input.source_record_id ?? this._counter}`,
      {
        ...payload,
        received_at: receivedAt,
        late_arrival: t(receivedAt) - t(input.observed_at) > LATE_TOLERANCE_MS,
      },
      `导入${sourceLabel(input.source.type)}（事实时间 ${input.observed_at}）`,
      receivedAt,
    );

    const produced = [evidence, ...this._assessRisk(s, evidence, plan, receivedAt)];
    return { status: "accepted", events: produced, evidence_event_id: evidence.event_id };
  }

  /** 基于截至事实时点的证据评估等级与停止线；只产出等级建议与确定性接力动作。 */
  _assessRisk(s, evidence, plan, receivedAt) {
    const out = [];
    const observedAt = evidence.payload.observed_at;
    // 历史重放视角：事实时间不晚于本观察的全部已接收证据；
    // 复训开启新周期后，只采用恢复时点之后观察到的事实，旧周期证据已在复核中处理。
    const cycleStart = s.cycleStartedAt ? t(s.cycleStartedAt) : -Infinity;
    const evidenceAsOf = s.evidence.filter(
      (e) => t(e.payload.observed_at) <= t(observedAt) && t(e.payload.observed_at) >= cycleStart,
    );
    const { conflicts } = isolateConflicts(evidenceAsOf);

    // 风险等级在当前周期内单调；恢复后以 cycleStartedAt 为新基线。
    const level = evaluateLevel(evidenceAsOf);
    const cycleFlags = s.riskFlags.filter((e) => !s.cycleStartedAt || t(e.occurred_at) >= t(s.cycleStartedAt));
    const priorMax = maxFlaggedLevel(cycleFlags);
    if (rank(level) > rank(priorMax)) {
      out.push(
        this._emit(
          "RISK_FLAGGED",
          "risk_observation",
          `risk-${plan.payload.participant_id}`,
          {
            participant_id: plan.payload.participant_id,
            level,
            as_of_observed_at: observedAt,
            plan_version: plan.payload.plan_version,
            evidence_event_ids: evidenceAsOf.map((e) => e.event_id),
            quarantined: conflicts,
            automated: true,
          },
          `自动评估风险等级：${level}（仅建议，不构成诊疗结论）`,
          receivedAt,
        ),
      );
    }

    const hits = matchStopLines(evidenceAsOf, plan.payload.stop_lines);
    for (const hit of hits) {
      if (s.activeStopCodes.has(hit.stop_line_code)) continue; // 本周期已触发，不重复升级

      const trigger = this._emit(
        "STOP_LINE_TRIGGERED",
        "risk_observation",
        `stop-${plan.payload.participant_id}-${hit.stop_line_code}`,
        {
          participant_id: plan.payload.participant_id,
          level: "STOP",
          stop_line_code: hit.stop_line_code,
          min_severity: hit.min_severity,
          scope: hit.scope,
          evidence_event_ids: hit.evidence_event_ids,
          evidence_observed_at: observedAt,
          plan_version: plan.payload.plan_version,
          late_arrival: t(receivedAt) - t(observedAt) > LATE_TOLERANCE_MS,
          note: hit.note,
        },
        `触发停止线 ${hit.stop_line_code}（事实时间 ${observedAt}）`,
        receivedAt,
      );
      out.push(trigger);
      out.push(...this._openReviewIfNeeded(s, hit, trigger, plan, observedAt, receivedAt));
      out.push(...this._pauseFutureActivities(s, plan.payload.participant_id, hit, trigger, plan, receivedAt));
      this._notify(plan.payload.participant_id, "PROFESSIONAL", "STOP_REVIEW_REQUIRED", trigger.event_id, receivedAt, {
        stop_line_code: hit.stop_line_code,
        plan_version: plan.payload.plan_version,
      });
    }

    if (conflicts.some((c) => c.event_id === evidence.event_id)) {
      out.push(this._notify(plan.payload.participant_id, "PROFESSIONAL", "EVIDENCE_CONFLICT", evidence.event_id, receivedAt, {
        quarantined: conflicts,
      }));
    }
    return out;
  }

  _openReviewIfNeeded(s, hit, trigger, plan, observedAt, at) {
    if (s.openReview) return []; // 同一暂停周期合并为一次复核
    const reviewId = `review-${plan.payload.participant_id}-${s.reviews.length + 1}`;
    return [
      this._emit(
        "REVIEW_OPENED",
        "clinical_handoff",
        `handoff-${plan.payload.participant_id}`,
        {
          participant_id: plan.payload.participant_id,
          review_id: reviewId,
          scope: hit.scope,
          trigger_event_id: trigger.event_id,
          stop_line_code: hit.stop_line_code,
          plan_version: plan.payload.plan_version,
          session_ids: this._sessionsInReview(s, hit, observedAt),
        },
        `停止线 ${hit.stop_line_code} 触发，开立复核`,
        at,
      ),
    ];
  }

  /**
   * 受停止线影响、需要复核的场次：
   *  - 已记录（完成/中断）且在停止范围内：保持当时事实，纳入复核；
   *  - 未记录但排期不早于停止事实时间：可能在停止条件尚不被知晓时举行过，需人工确认。
   */
  _sessionsInReview(s, hit, observedAt) {
    const ids = [];
    for (const sess of s.sessions.values()) {
      if (!scopeCovers(hit.scope, sess)) continue;
      if (sess.recorded) {
        ids.push(sess.recorded.payload.session_id);
      } else if (t(sess.scheduled_at) >= t(observedAt)) {
        ids.push(sess.session_id);
      }
    }
    return ids;
  }

  /** 立即暂停尚未开始的相关活动；已完成场次不动（保持事实，进入复核）。 */
  _pauseFutureActivities(s, participantId, hit, trigger, plan, at) {
    const now = t(at);
    const toPause = [];
    for (const sess of s.sessions.values()) {
      if (sess.recorded) continue; // 已完成/已记录：事实不改写
      if (t(sess.scheduled_at) < now) continue; // 已过开始时刻不追溯取消
      if (!scopeCovers(hit.scope, sess)) continue;
      if (this._isPaused(s, sess, at)) continue;
      toPause.push(sess.session_id);
    }

    const scope = normalizeScope(hit.scope, toPause);
    const already = s.activePauseScopes.some((a) => sameScope(a.scope, scope));
    if (already || (!scope.all_future && !scope.activity_refs?.length && !scope.session_ids?.length)) return [];

    const paused = this._emit(
      "ACTIVITY_PAUSED",
      "participant_plan",
      `plan-${participantId}`,
      {
        participant_id: participantId,
        scope,
        reason: `停止线 ${hit.stop_line_code}`,
        reason_event_id: trigger.event_id,
        plan_version: plan.payload.plan_version,
      },
      `暂停尚未开始的相关活动（${describeScope(scope)}）`,
      at,
    );
    this._notify(participantId, "PARTICIPANT", "ACTIVITY_PAUSED_NOTICE", paused.event_id, at, {
      scope_summary: describeScope(scope),
    });
    return [paused];
  }

  _notify(participantId, audience, template, reasonEventId, at, extra = {}) {
    return this._emit(
      "NOTIFICATION_QUEUED",
      "clinical_handoff",
      `inbox-${participantId}`,
      {
        participant_id: participantId,
        audience,
        template,
        reason_event_id: reasonEventId,
        deliver_at: at,
        ...extra,
      },
      `${AUDIENCE_LABEL[audience]}通知：${template}`,
      at,
    );
  }

  // ---------------------------------------------------------------- 命令：场次

  scheduleSession(input) {
    const at = this._now();
    const s = this._p(input.participant_id);
    if (s.sessions.has(input.session_id)) {
      throw new BusinessError("DUPLICATE_SESSION", `场次已存在：${input.session_id}`);
    }
    const plan = planEffectiveAt(s.plans, input.scheduled_at);
    const sess = {
      session_id: input.session_id,
      activity_ref: input.activity_ref ?? null,
      scheduled_at: input.scheduled_at,
      planned_plan_version: input.planned_plan_version ?? plan?.payload.plan_version,
    };
    const event = this._emit(
      "SESSION_SCHEDULED",
      "activity_session",
      `session-${input.participant_id}-${input.session_id}`,
      { participant_id: input.participant_id, ...sess },
      `排期场次 ${input.session_id}（${input.activity_ref ?? "活动"} @ ${input.scheduled_at}）`,
      at,
    );
    return { event, paused: this._isPaused(s, sess, at) };
  }

  /**
   * 记录场次事实。暂停范围内未恢复时不允许把场后记为 COMPLETED；
   * INTERRUPTED（现场触发停止线）始终允许。现场 findings 走同一证据评估管道。
   */
  recordSession(input) {
    const at = this._now();
    const s = this._p(input.participant_id);
    if (s.sessions.get(input.session_id)?.recorded) {
      throw new BusinessError("SESSION_ALREADY_RECORDED", input.session_id);
    }
    const existing = s.sessions.get(input.session_id);
    const sessView = {
      session_id: input.session_id,
      activity_ref: input.activity_ref ?? existing?.activity_ref ?? null,
    };
    if (input.outcome === "COMPLETED" && this._isPaused(s, sessView, input.started_at)) {
      throw new BusinessError("ACTIVITY_PAUSED", "该场次处于暂停范围，恢复前不得完成");
    }

    const out = [];
    if (input.findings?.length) {
      const r = this.importEvidence({
        participant_id: input.participant_id,
        observed_at: input.observed_at ?? input.started_at,
        source: {
          type: "FIELD_OBSERVATION",
          party_id: input.observer_id ?? "INSTRUCTOR",
          party_role: "SPORTS_INSTRUCTOR",
        },
        source_record_id: `session:${input.session_id}`,
        findings: input.findings,
        note: `场次 ${input.session_id} 现场观察`,
      });
      out.push(...r.events);
    }

    const event = this._emit(
      "SESSION_RECORDED",
      "activity_session",
      `session-${input.participant_id}-${input.session_id}`,
      {
        participant_id: input.participant_id,
        session_id: input.session_id,
        activity_ref: sessView.activity_ref,
        scheduled_at: input.scheduled_at ?? existing?.scheduled_at ?? input.started_at,
        planned_plan_version: input.planned_plan_version ?? existing?.planned_plan_version,
        started_at: input.started_at,
        ended_at: input.ended_at ?? at,
        outcome: input.outcome,
        load: input.load,
      },
      `记录场次 ${input.session_id}：${input.outcome}`,
      at,
    );
    out.push(event);
    return { events: out };
  }

  _isPaused(s, sess, at) {
    return s.activePauseScopes.some((a) => t(a.at) <= t(at) && scopeCovers(a.scope, sess));
  }

  // ---------------------------------------------------------------- 命令：复核与复训

  completeReview(input) {
    const at = this._now();
    const s = this._p(input.participant_id);
    const review = s.reviews.find((r) => r.opened.payload.review_id === input.review_id);
    if (!review) throw new BusinessError("NO_REVIEW", input.review_id);
    if (review.completed) throw new BusinessError("REVIEW_CLOSED", input.review_id);
    return this._emit(
      "REVIEW_COMPLETED",
      "clinical_handoff",
      review.opened.aggregate_id,
      {
        participant_id: input.participant_id,
        review_id: input.review_id,
        scope: review.opened.payload.scope,
        decision: input.decision,
        decided_by: input.decided_by,
        based_on_trigger: review.opened.payload.trigger_event_id,
        note: input.note,
      },
      `复核结论：${input.decision}`,
      at,
    );
  }

  /**
   * 确认复训：必须由新计划 return_authority_roles 中的角色，
   * 基于本次停止之后批准的新版本确认负荷阶梯与观察期限；不能沿用旧批准。
   */
  confirmReturn(input) {
    const at = this._now();
    const s = this._p(input.participant_id);

    const review = s.reviews.find((r) => r.opened.payload.review_id === input.review_id);
    if (!review) throw new BusinessError("NO_REVIEW", "复训前必须存在复核");
    if (!review.completed) throw new BusinessError("REVIEW_OPEN", "复核尚未完成，不能确认复训");
    if (!input.load_ladder?.length) throw new BusinessError("NO_LADDER", "必须确认新的负荷阶梯");
    if (!input.observation_until) throw new BusinessError("NO_OBSERVATION_UNTIL", "必须确认观察期限");

    const newPlan = s.plans.find((e) => e.payload.plan_version === input.new_plan_version);
    if (!newPlan) throw new BusinessError("UNKNOWN_PLAN", `新计划版本未批准：${input.new_plan_version}`);

    const latestStopAt = Math.max(0, ...s.stopTriggers.map((e) => t(e.occurred_at)));
    if (latestStopAt > 0 && t(newPlan.occurred_at) < latestStopAt) {
      throw new BusinessError("PLAN_TOO_OLD", "复训依据的计划必须在本次停止事件之后重新批准，不能沿用旧批准");
    }
    if (s.stopTriggers.some((e) => e.payload.plan_version === input.new_plan_version)) {
      throw new BusinessError("PLAN_USED_WHEN_STOPPED", "复训不能使用触发停止线时生效的计划版本");
    }

    const authority = newPlan.payload.return_authority_roles ?? [];
    if (!authority.includes(input.confirmed_by?.role)) {
      throw new BusinessError("FORBIDDEN_ROLE", `角色 ${input.confirmed_by?.role} 无权确认复训`);
    }

    const out = [];
    const confirmed = this._emit(
      "RETURN_CONFIRMED",
      "clinical_handoff",
      review.opened.aggregate_id,
      {
        participant_id: input.participant_id,
        review_id: input.review_id,
        new_plan_version: input.new_plan_version,
        load_ladder: input.load_ladder,
        observation_until: input.observation_until,
        confirmed_by: input.confirmed_by,
        note: input.note,
      },
      `${input.confirmed_by.role} 依据 ${input.new_plan_version} 确认复训阶梯与观察期`,
      at,
    );
    out.push(confirmed);

    const resumeScope = mergeScopes(s.pauses.map((e) => e.payload.scope));
    const resumed = this._emit(
      "ACTIVITY_RESUMED",
      "participant_plan",
      `plan-${input.participant_id}`,
      {
        participant_id: input.participant_id,
        scope: resumeScope,
        return_event_id: confirmed.event_id,
        plan_version: input.new_plan_version,
      },
      `按 ${input.new_plan_version} 恢复训练`,
      at,
    );
    out.push(resumed);

    out.push(this._notify(input.participant_id, "PARTICIPANT", "ACTIVITY_RESUMED_NOTICE", resumed.event_id, at, {
      plan_version: input.new_plan_version,
    }));
    out.push(this._notify(input.participant_id, "PROFESSIONAL", "RETURN_RECORDED", confirmed.event_id, at, {
      plan_version: input.new_plan_version,
    }));
    // 观察期限到期提醒：中断恢复后由 dueObservations / 未确认通知继续跟进。
    out.push(this._notify(input.participant_id, "PROFESSIONAL", "OBSERVATION_DUE", confirmed.event_id, input.observation_until, {
      plan_version: input.new_plan_version,
      return_event_id: confirmed.event_id,
      deliver_at: input.observation_until,
    }));
    return { events: out };
  }

  ackNotification(input) {
    const at = this._now();
    const s = this._p(input.participant_id);
    const note = s.notifications.find((n) => n.queued.event_id === input.notification_event_id);
    if (!note) throw new BusinessError("NO_NOTIFICATION", input.notification_event_id);
    if (note.acked) throw new BusinessError("ALREADY_ACKED", input.notification_event_id);
    return this._emit(
      "NOTIFICATION_ACKED",
      "clinical_handoff",
      `inbox-${input.participant_id}`,
      {
        participant_id: input.participant_id,
        notification_event_id: input.notification_event_id,
        acked_by: input.acked_by,
      },
      "通知已确认",
      at,
    );
  }

  // ---------------------------------------------------------------- 查询

  /** 参与者视图：只看到必要提示（暂停/恢复的大白话），不含风险等级与症状细节。 */
  participantView(participantId, now = this._now()) {
    const s = this._state.get(participantId);
    if (!s) return { participant_id: participantId, sessions: [], notices: [] };
    const sessions = [...s.sessions.values()]
      .sort((a, b) => t(a.scheduled_at) - t(b.scheduled_at))
      .map((sess) => ({
        session_id: sess.session_id,
        scheduled_at: sess.scheduled_at,
        status: sessionStatus(s, sess, t(now)),
      }));
    const notices = s.notifications
      .filter((n) => n.queued.payload.audience === "PARTICIPANT")
      .map((n) => ({
        notification_event_id: n.queued.event_id,
        message: participantCopy(n.queued.payload.template, n.queued.payload),
        acked: Boolean(n.acked),
      }));
    return { participant_id: participantId, sessions, notices };
  }

  /** 专业人员视图：按事实时间还原一次暂停、调整与复训使用了哪些证据和计划版本。 */
  professionalTimeline(participantId, now = this._now()) {
    const s = this._state.get(participantId);
    if (!s) return [];
    const items = [];
    for (const e of s.plans) {
      items.push({
        at: e.payload.effective_from,
        received_at: e.occurred_at,
        kind: "PLAN_APPROVED",
        plan_version: e.payload.plan_version,
        supersedes: e.payload.supersedes ?? null,
        approver: e.payload.approver,
        population: e.payload.population,
        bands: e.payload.intensity_bands,
        stop_lines: e.payload.stop_lines,
        event_id: e.event_id,
      });
    }
    for (const e of s.evidence) {
      items.push({
        at: e.payload.observed_at,
        received_at: e.occurred_at,
        kind: "EVIDENCE",
        source: e.payload.source,
        findings: e.payload.findings,
        late: Boolean(e.payload.late_arrival),
        applied_plan: planEffectiveAt(s.plans, e.payload.observed_at)?.payload.plan_version ?? null,
        event_id: e.event_id,
      });
    }
    for (const sess of s.sessions.values()) {
      if (!sess.recorded) {
        items.push({
          at: sess.scheduled_at,
          kind: "SESSION_SCHEDULED",
          session_id: sess.session_id,
          activity_ref: sess.activity_ref,
          plan_version: sess.planned_plan_version,
          paused: this._isPaused(s, sess, now),
        });
      } else {
        const p = sess.recorded.payload;
        items.push({
          at: p.started_at,
          kind: "SESSION_RECORDED",
          session_id: p.session_id,
          activity_ref: sess.activity_ref,
          outcome: p.outcome,
          load: p.load,
          plan_version: p.planned_plan_version,
          in_review: s.reviews.some((r) => (r.opened.payload.session_ids ?? []).includes(p.session_id)),
          event_id: sess.recorded.event_id,
        });
      }
    }
    for (const e of s.riskFlags) {
      items.push({
        at: e.payload.as_of_observed_at,
        received_at: e.occurred_at,
        kind: "RISK_LEVEL",
        level: e.payload.level,
        plan_version: e.payload.plan_version,
        based_on: e.payload.evidence_event_ids,
        quarantined: e.payload.quarantined ?? [],
        event_id: e.event_id,
      });
    }
    for (const e of s.stopTriggers) {
      items.push({
        at: e.payload.evidence_observed_at,
        received_at: e.occurred_at,
        kind: "STOP",
        stop_line_code: e.payload.stop_line_code,
        scope: e.payload.scope,
        plan_version: e.payload.plan_version,
        based_on: e.payload.evidence_event_ids,
        late: Boolean(e.payload.late_arrival),
        event_id: e.event_id,
      });
    }
    for (const e of s.pauses) {
      items.push({
        at: e.occurred_at,
        kind: "PAUSE",
        scope: e.payload.scope,
        reason_event_id: e.payload.reason_event_id,
        plan_version: e.payload.plan_version,
        event_id: e.event_id,
      });
    }
    for (const r of s.reviews) {
      items.push({
        at: r.opened.occurred_at,
        kind: "REVIEW_OPENED",
        review_id: r.opened.payload.review_id,
        trigger_event_id: r.opened.payload.trigger_event_id,
        sessions: r.opened.payload.session_ids,
        plan_version: r.opened.payload.plan_version,
      });
      if (r.completed) {
        items.push({
          at: r.completed.occurred_at,
          kind: "REVIEW_COMPLETED",
          review_id: r.completed.payload.review_id,
          decision: r.completed.payload.decision,
          decided_by: r.completed.payload.decided_by,
        });
      }
    }
    for (const e of s.returns) {
      items.push({
        at: e.occurred_at,
        kind: "RETURN_CONFIRMED",
        plan_version: e.payload.new_plan_version,
        ladder: e.payload.load_ladder,
        observation_until: e.payload.observation_until,
        confirmed_by: e.payload.confirmed_by,
        review_id: e.payload.review_id,
        event_id: e.event_id,
      });
    }
    return items.sort((a, b) => t(a.at) - t(b.at));
  }

  /** 服务中断恢复后：仍待复核的案件。 */
  pendingReviews(now = this._now()) {
    const out = [];
    for (const [participantId, s] of this._state) {
      for (const r of s.reviews) {
        if (!r.completed) {
          out.push({
            participant_id: participantId,
            review_id: r.opened.payload.review_id,
            opened_at: r.opened.occurred_at,
            stop_line_code: r.opened.payload.stop_line_code,
            overdue: t(now) - t(r.opened.occurred_at) > REVIEW_SLA_MS,
          });
        }
      }
    }
    return out;
  }

  /** 复训后的观察期限到期/逾期。 */
  dueObservations(now = this._now()) {
    const out = [];
    for (const [participantId, s] of this._state) {
      for (const e of s.returns) {
        if (t(e.payload.observation_until) <= t(now)) {
          out.push({
            participant_id: participantId,
            plan_version: e.payload.new_plan_version,
            observation_until: e.payload.observation_until,
            return_event_id: e.event_id,
          });
        }
      }
    }
    return out;
  }

  /** 到投递时间且未确认的通知（含到期观察提醒）。 */
  unackedNotifications(now = this._now()) {
    const out = [];
    for (const [participantId, s] of this._state) {
      for (const n of s.notifications) {
        const deliverAt = n.queued.payload.deliver_at ?? n.queued.occurred_at;
        if (!n.acked && t(deliverAt) <= t(now)) {
          out.push({ participant_id: participantId, event_id: n.queued.event_id, ...n.queued.payload });
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- 辅助函数

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, STOP: 3 };
function rank(level) {
  return RANK[level] ?? 0;
}
function maxFlaggedLevel(flags) {
  let max = "LOW";
  for (const f of flags) if (rank(f.payload.level) > rank(max)) max = f.payload.level;
  return max;
}

/** 指纹只取业务字段，剔除 received_at/late_arrival 等运行时字段。 */
function stripRuntime(p) {
  return {
    source: p.source,
    observed_at: p.observed_at,
    topic: p.topic,
    note: p.note,
    findings: p.findings,
  };
}

function sourceLabel(type) {
  return { SELF_REPORT: "参与者自述", FIELD_OBSERVATION: "现场观察", MEDICAL_ADVICE: "医疗建议" }[type] ?? type;
}

const AUDIENCE_LABEL = { PARTICIPANT: "参与者", PROFESSIONAL: "专业人员" };

/** scope 是否覆盖某场次。 */
export function scopeCovers(scope, sess) {
  if (!scope) return true;
  if (scope.all_future) return true;
  if (scope.session_ids?.includes(sess.session_id)) return true;
  if (scope.activity_refs?.length && sess.activity_ref && scope.activity_refs.includes(sess.activity_ref)) {
    return true;
  }
  return false;
}

function normalizeScope(scope, sessionIds) {
  const out = {};
  if (scope?.all_future) out.all_future = true;
  if (scope?.activity_refs?.length) out.activity_refs = [...scope.activity_refs];
  const ids = new Set([...(scope?.session_ids ?? []), ...sessionIds]);
  if (ids.size) out.session_ids = [...ids];
  return out;
}

function sameScope(a, b) {
  return Boolean(a?.all_future) === Boolean(b?.all_future)
    && JSON.stringify([...(a?.activity_refs ?? [])].sort()) === JSON.stringify([...(b?.activity_refs ?? [])].sort())
    && JSON.stringify([...(a?.session_ids ?? [])].sort()) === JSON.stringify([...(b?.session_ids ?? [])].sort());
}

function mergeScopes(scopes) {
  const merged = { allFuture: false, activityRefs: new Set(), sessionIds: new Set() };
  for (const sc of scopes) {
    if (sc?.all_future) merged.allFuture = true;
    (sc?.activity_refs ?? []).forEach((x) => merged.activityRefs.add(x));
    (sc?.session_ids ?? []).forEach((x) => merged.sessionIds.add(x));
  }
  const out = {};
  if (merged.allFuture) out.all_future = true;
  if (merged.activityRefs.size) out.activity_refs = [...merged.activityRefs];
  if (merged.sessionIds.size) out.session_ids = [...merged.sessionIds];
  return out;
}

function describeScope(scope) {
  const parts = [];
  if (scope.all_future) parts.push("全部后续活动");
  if (scope.activity_refs?.length) parts.push(`活动 ${scope.activity_refs.join("/")}`);
  if (scope.session_ids?.length) parts.push(`场次 ${scope.session_ids.join("/")}`);
  return parts.join("、") || "相关活动";
}

function participantCopy(template, payload) {
  switch (template) {
    case "ACTIVITY_PAUSED_NOTICE":
      return `为安全考虑，${payload.scope_summary ?? "相关活动"}已暂停，请等待指导人员联系后再恢复。`;
    case "ACTIVITY_RESUMED_NOTICE":
      return `可以按指导人员给你的新阶梯逐步恢复训练（计划 ${payload.plan_version}），如有不适请立即停下并告知。`;
    default:
      return "有一条新的活动安排提示。";
  }
}

function sessionStatus(s, sess, now) {
  if (sess.recorded) return sess.recorded.payload.outcome;
  if (s.activePauseScopes.some((a) => t(a.at) <= now && scopeCovers(a.scope, sess))) return "PAUSED";
  return "SCHEDULED";
}
