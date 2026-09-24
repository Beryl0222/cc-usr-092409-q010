import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileEventStore, InMemoryEventStore } from "../src/event-store.js";
import {
  RiskHandoffService,
  RULE_VERSION,
  RESUME_ROLES,
} from "../src/risk-handoff.js";
import { validateEvent } from "../src/validator.js";

const INSTRUCTOR = { person_id: "staff-007", role: "community_sport_instructor", name: "李指导" };
const PHYSICIAN = { person_id: "staff-012", role: "sports_medicine_physician", name: "王医生" };

const LADDER_V1 = [
  { level: 1, zone: { metric: "heart_rate", min: 90, max: 110, unit: "bpm" } },
  { level: 2, zone: { metric: "heart_rate", min: 100, max: 120, unit: "bpm" } },
  { level: 3, zone: { metric: "heart_rate", min: 110, max: 130, unit: "bpm" } },
];
const STOP_CONDITIONS = [
  { code: "CHEST_PAIN", description: "运动中或运动后胸痛、胸闷", threshold: null },
  { code: "SYNCOPE", description: "晕厥或近乎晕厥", threshold: null },
];
const LADDER_V2 = [
  { level: 1, zone: { metric: "heart_rate", min: 85, max: 100, unit: "bpm" } },
  { level: 2, zone: { metric: "heart_rate", min: 95, max: 110, unit: "bpm" } },
];

function makeService(store = new InMemoryEventStore()) {
  return new RiskHandoffService(store, { now: () => "2026-09-24T09:00:00+08:00" });
}

function approveV1(service, participant = "p-001", planId = "plan-jog", overrides = {}) {
  return service.approvePlan(participant, {
    plan_id: planId,
    applicable_group: { conditions: ["社区超慢跑常规参与者", "近6个月无心血管急性事件"] },
    load_ladder: LADDER_V1,
    stop_conditions: STOP_CONDITIONS,
    approver: INSTRUCTOR,
    approved_at: "2026-09-20T18:00:00+08:00",
    effective_from: "2026-09-21T07:00:00+08:00",
    ...overrides,
  });
}

function schedule(service, sid, slot, level = 1, plan = ["plan-jog", 1]) {
  return service.scheduleSession("p-001", {
    plan_id: plan[0],
    plan_version: plan[1],
    session_id: sid,
    slot_at: slot,
    load_level: level,
    scheduled_at: "2026-09-20T19:00:00+08:00",
  });
}

/** 主场景：9/21–9/24 的训练周，9/22 训练中胸痛，9/23 中午才迟到上报。 */
function setupLateReportWeek(
  service,
  { participant = "p-001", reportReceivedAt = "2026-09-23T12:00:00+08:00", record0923 = true } = {}
) {
  approveV1(service, participant);
  schedule(service, "s-0921", "2026-09-21T07:00:00+08:00");
  schedule(service, "s-0922", "2026-09-22T07:00:00+08:00");
  schedule(service, "s-0923", "2026-09-23T07:00:00+08:00");
  schedule(service, "s-0924", "2026-09-24T07:00:00+08:00");
  service.recordSession(participant, {
    session_id: "s-0921",
    completed: true,
    started_at: "2026-09-21T07:00:00+08:00",
    finished_at: "2026-09-21T07:35:00+08:00",
    recorded_facts: { peak_hr: 104, note: "无不适" },
    recorded_at: "2026-09-21T08:00:00+08:00",
  });
  service.recordSession(participant, {
    session_id: "s-0922",
    completed: true,
    started_at: "2026-09-22T07:00:00+08:00",
    finished_at: "2026-09-22T07:40:00+08:00",
    recorded_facts: { peak_hr: 108, note: "正常" },
    recorded_at: "2026-09-22T08:00:00+08:00",
  });
  // 9/23 的训练在任何人知情前已按旧计划完成（先于不适上报）。
  if (record0923) {
    service.recordSession(participant, {
      session_id: "s-0923",
      completed: true,
      started_at: "2026-09-23T07:00:00+08:00",
      finished_at: "2026-09-23T07:38:00+08:00",
      recorded_facts: { peak_hr: 112 },
      recorded_at: "2026-09-23T08:30:00+08:00",
    });
  }
  const imported = service.importObservation(participant, {
    observation_id: "obs-late-chestpain",
    source: { type: "self_report", person_id: participant },
    observed_at: "2026-09-22T07:25:00+08:00", // 症状发生在 9/22 训练中
    received_at: reportReceivedAt, // 跨日迟到
    content: { code: "CHEST_PAIN", severity: "high", detail: "跑到第20分钟胸闷，停下后缓解", session_id: "s-0922" },
  });
  return imported;
}

test("计划批准冻结适用人群、负荷区间、停止条件和批准角色", () => {
  const service = makeService();
  const event = approveV1(service);
  assert.equal(event.event_type, "PLAN_APPROVED");
  assert.deepEqual(event.payload.applicable_group.conditions[0], "社区超慢跑常规参与者");
  assert.equal(event.payload.load_ladder.length, 3);
  assert.equal(event.payload.stop_conditions[0].code, "CHEST_PAIN");
  assert.equal(event.payload.approver.role, "community_sport_instructor");

  // 无权角色不能批准。
  assert.throws(
    () => approveV1(service, "p-x", "plan-x", { approver: { person_id: "z", role: "participant" } }),
    /无权批准/
  );
  // 已冻结版本号不可复用。
  assert.throws(
    () => approveV1(service, "p-001", "plan-jog", { plan_version: 1 }),
    /版本号必须递增/
  );
  // 场次必须挂在已冻结版本与阶梯内。
  assert.throws(
    () => schedule(service, "s-bad", "2026-09-25T07:00:00+08:00", 9),
    /负荷等级不在冻结阶梯内/
  );
});

test("跨日迟到记录：按实际发生时间解释历史，已完成场次保事实入复核，未开始场次立即暂停", () => {
  const service = makeService();
  const result = setupLateReportWeek(service);
  const state = service.getState("p-001");

  // 风险判断依据“发生时有效”的 v1 计划冻结停止条件。
  assert.equal(result.assessment.payload.level, "stop_line");
  assert.equal(result.assessment.payload.stop_condition_code, "CHEST_PAIN");
  assert.match(result.assessment.payload.rationale, /plan-jog v1/);
  assert.equal(result.assessment.payload.rule_version, RULE_VERSION);

  // 暂停只覆盖尚未开始的 9/24；9/21–9/23 已完成事实不动。
  assert.deepEqual(result.pause.payload.scope, {
    kind: "activity",
    plan_id: "plan-jog",
    activity_ids: ["s-0924"],
  });
  assert.equal(state.sessions.get("s-0921").status, "completed");
  assert.equal(state.sessions.get("s-0922").status, "completed");
  assert.equal(state.sessions.get("s-0923").status, "completed");
  assert.equal(state.sessions.get("s-0924").status, "paused_before_start");

  // 9/22（症状当场）与 9/23（迟到期间仍按旧计划练完）都进入复核范围。
  assert.deepEqual(result.review.payload.included_session_ids, ["s-0922", "s-0923"]);
  // 当时事实原样保留，不被后到的自述改写。
  assert.equal(state.sessions.get("s-0922").record.facts.note, "正常");
  assert.equal(state.sessions.get("s-0923").record.facts.peak_hr, 112);

  // 旧计划冻结，不能再按旧批准排期；但复核前不能直接复训。
  assert.equal(state.plans[0].status, "paused");
});

test("局部暂停：只暂停相关活动，其他计划与场次不受影响", () => {
  const service = makeService();
  setupLateReportWeek(service);
  // 同一参与者另有一份力量计划（不同活动线）。
  service.approvePlan("p-001", {
    plan_id: "plan-strength",
    applicable_group: { conditions: ["常规参与者"] },
    load_ladder: [{ level: 1, zone: { metric: "rpe", min: 2, max: 4, unit: "级" } }],
    stop_conditions: [{ code: "JOINT_PAIN", description: "关节锐痛" }],
    approver: INSTRUCTOR,
    approved_at: "2026-09-21T09:00:00+08:00",
    effective_from: "2026-09-21T09:00:00+08:00",
  });
  service.scheduleSession("p-001", {
    plan_id: "plan-strength",
    plan_version: 1,
    session_id: "w-0924",
    slot_at: "2026-09-24T09:00:00+08:00",
    load_level: 1,
  });
  const state = service.getState("p-001");
  assert.equal(state.sessions.get("w-0924").status, "scheduled"); // 未被连带暂停
  assert.equal(state.findPlan("plan-strength", 1).status, "active"); // 仍可执行
  assert.equal(state.findPlan("plan-jog", 1).status, "paused");
});

test("同一观察完全重放不重复升级（幂等）", () => {
  const service = makeService();
  const first = setupLateReportWeek(service);
  const before = service.getState("p-001").events.length;

  const replay = service.importObservation("p-001", {
    observation_id: "obs-late-chestpain",
    source: { type: "self_report", person_id: "p-001" },
    observed_at: "2026-09-22T07:25:00+08:00",
    received_at: "2026-09-25T10:00:00+08:00", // 即使再次“送达”也不产生新事件
    content: { code: "CHEST_PAIN", severity: "high", detail: "重放" },
  });
  const after = service.getState("p-001").events.length;

  assert.equal(replay.duplicate, true);
  assert.equal(after, before, "重放不得追加任何事件");
  assert.equal(replay.assessment.eventId, first.assessment.event_id);
  assert.equal(service.getState("p-001").pauses.length, 1, "不得重复暂停");
});

test("内容冲突隔离：矛盾观察各自留存、独立评估，不互相覆盖", () => {
  const service = makeService();
  approveV1(service);
  schedule(service, "s-1001", "2026-10-01T07:00:00+08:00");

  const a = service.importObservation("p-001", {
    observation_id: "obs-a",
    source: { type: "field_observation", person_id: "staff-007", role: "community_sport_instructor" },
    observed_at: "2026-10-01T07:20:00+08:00",
    received_at: "2026-10-01T08:00:00+08:00",
    content: { code: "MILD_FATIGUE", severity: "moderate", detail: "略有疲劳，可继续" },
    conflict_key: "field:2026-10-01",
  });
  const b = service.importObservation("p-001", {
    observation_id: "obs-b",
    source: { type: "self_report", person_id: "p-001" },
    observed_at: "2026-10-01T07:20:00+08:00",
    received_at: "2026-10-01T09:00:00+08:00",
    content: { code: "CHEST_PAIN", severity: "high", detail: "实际当时胸痛" },
    conflict_key: "self:2026-10-01",
  });

  const state = service.getState("p-001");
  assert.equal(state.observations.length, 2);
  assert.notEqual(state.observations[0].conflict_key, state.observations[1].conflict_key);
  assert.equal(state.observations[0].content.detail, "略有疲劳，可继续");
  assert.equal(state.observations[1].content.detail, "实际当时胸痛");

  // 独立评估：现场观察 elevated；自述命中停止线 stop_line（不自动消解冲突，交复核）。
  assert.equal(a.assessment.payload.level, "elevated");
  assert.equal(b.assessment.payload.level, "stop_line");
});

test("暂停后补录完成的场次：事实保留并自动补开复核", () => {
  const service = makeService();
  // 9/23 清晨 06:30 收到前一日胸痛上报，07:00 的场次尚未开始 → 立即暂停。
  const r = setupLateReportWeek(service, {
    reportReceivedAt: "2026-09-23T06:30:00+08:00",
    record0923: false,
  });
  assert.deepEqual(r.pause.payload.scope.activity_ids.sort(), ["s-0923", "s-0924"]);
  assert.deepEqual(r.review.payload.included_session_ids, ["s-0922"]);

  // 参与者 9/23 仍到场完成，事后 09:00 补录：事实保留，另开迟到复核。
  const rec = service.recordSession("p-001", {
    session_id: "s-0923",
    completed: true,
    started_at: "2026-09-23T07:00:00+08:00",
    finished_at: "2026-09-23T07:30:00+08:00",
    recorded_facts: { peak_hr: 116 },
    recorded_at: "2026-09-23T09:00:00+08:00",
  });
  assert.ok(rec.late_review, "应自动补开复核");
  assert.deepEqual(rec.late_review.payload.included_session_ids, ["s-0923"]);
  const state = service.getState("p-001");
  assert.equal(state.sessions.get("s-0923").status, "completed_after_pause");
  assert.equal(state.sessions.get("s-0923").record.facts.peak_hr, 116);
  assert.equal(state.sessions.get("s-0924").status, "paused_before_start");
});

test("恢复训练：合格角色确认新负荷阶梯与观察期限，旧批准不沿用", () => {
  const service = makeService();
  setupLateReportWeek(service);
  const reviewId = "review-obs-late-chestpain";

  // 医疗建议先到（复训证据之一）。
  service.importObservation("p-001", {
    observation_id: "obs-med-001",
    source: { type: "medical_advice", person_id: "staff-012", role: "sports_medicine_physician", org: "社区卫生中心" },
    observed_at: "2026-09-24T10:00:00+08:00",
    received_at: "2026-09-24T10:30:00+08:00",
    content: { code: "RETURN_WITH_REDUCED_LOAD", severity: "moderate", detail: "检查未见急性异常，降阶梯复训并观察两周" },
  });

  // 未复核不能复训；社区指导员不具备确认复训职责。
  assert.throws(
    () =>
      service.resumeTraining("p-001", {
        review_id: reviewId,
        confirmer: INSTRUCTOR,
        load_ladder: LADDER_V2,
        observation_window_until: "2026-10-08T07:00:00+08:00",
      }),
    /不具备确认复训的职责/
  );

  // 指导员可出具复核结论，但“继续暂停”不能复训。
  service.completeReview("p-001", {
    review_id: reviewId,
    reviewer: INSTRUCTOR,
    decision: "require_new_plan",
    findings: "9/22 胸痛事实成立，9/23 违例训练无新发症状，转医生评估后降阶复训",
    completed_at: "2026-09-24T11:00:00+08:00",
  });

  // 观察期限必须晚于复训时间。
  assert.throws(
    () =>
      service.resumeTraining("p-001", {
        review_id: reviewId,
        confirmer: PHYSICIAN,
        load_ladder: LADDER_V2,
        observation_window_until: "2026-09-01T00:00:00+08:00",
      }),
    /观察期限/
  );

  const resumed = service.resumeTraining("p-001", {
    review_id: reviewId,
    confirmer: PHYSICIAN,
    load_ladder: LADDER_V2,
    observation_window_until: "2026-10-08T07:00:00+08:00",
    resumed_at: "2026-09-25T08:00:00+08:00",
  });
  assert.equal(resumed.event_type, "TRAINING_RESUMED");
  assert.equal(resumed.payload.new_plan_version, 2);
  assert.equal(resumed.payload.previous_plan_id, "plan-jog");
  assert.equal(resumed.payload.confirmer.role, "sports_medicine_physician");

  const state = service.getState("p-001");
  assert.equal(state.findPlan("plan-jog", 1).status, "superseded", "旧批准不沿用");
  assert.equal(state.findPlan("plan-jog", 2).status, "active");
  assert.deepEqual(state.findPlan("plan-jog", 2).load_ladder, LADDER_V2);

  // 旧版本上的未开始场次保持暂停；新版本可正常排期。
  assert.equal(state.sessions.get("s-0924").status, "paused_before_start");
  assert.doesNotThrow(() =>
    service.scheduleSession("p-001", {
      plan_id: "plan-jog",
      plan_version: 2,
      session_id: "s-1001",
      slot_at: "2026-09-26T07:00:00+08:00",
      load_level: 1,
    })
  );
  assert.throws(
    () =>
      service.scheduleSession("p-001", {
        plan_id: "plan-jog",
        plan_version: 1,
        session_id: "s-old",
        slot_at: "2026-09-26T08:00:00+08:00",
        load_level: 1,
      }),
    /已被新版本取代|暂停/
  );

  // 证据链可还原：旧计划冻结版本、复核开启/结论、医疗建议、新批准都在 based_on 中。
  const ids = new Set(resumed.payload.based_on_event_ids);
  assert.ok([...state.events].some((e) => e.event_type === "PLAN_APPROVED" && e.payload.plan_version === 1 && ids.has(e.event_id)));
  assert.ok([...state.events].some((e) => e.event_type === "REVIEW_COMPLETED" && ids.has(e.event_id)));
  assert.ok([...state.events].some((e) => e.event_type === "OBSERVATION_IMPORTED" && e.payload.source.type === "medical_advice" && ids.has(e.event_id)));
  assert.ok(RESUME_ROLES.has("sports_medicine_physician"));
});

test("服务中断后继续：待复核、未确认通知与到期观察从事件流重建", () => {
  const dir = mkdtempSync(join(tmpdir(), "risk-handoff-"));
  try {
    const store1 = new FileEventStore(dir);
    const s1 = makeService(store1);
    setupLateReportWeek(s1);

    // 模拟进程重启：新服务实例只靠磁盘事件流恢复。
    const s2 = makeService(new FileEventStore(dir));
    let pending = s2.getPendingWork("p-001", "2026-09-24T09:00:00+08:00");
    assert.equal(pending.pending_reviews.length, 1);
    assert.equal(pending.pending_reviews[0].review_id, "review-obs-late-chestpain");
    assert.deepEqual(pending.pending_reviews[0].included_session_ids, ["s-0922", "s-0923"]);
    assert.equal(pending.unconfirmed_alerts.length, 1);
    assert.equal(pending.unconfirmed_alerts[0].observed_at, "2026-09-22T07:25:00+08:00");

    // 完成复核并复训（由重启后的实例继续办理）。
    s2.completeReview("p-001", {
      review_id: "review-obs-late-chestpain",
      reviewer: INSTRUCTOR,
      decision: "require_new_plan",
      completed_at: "2026-09-24T11:00:00+08:00",
    });
    s2.resumeTraining("p-001", {
      review_id: "review-obs-late-chestpain",
      confirmer: PHYSICIAN,
      load_ladder: LADDER_V2,
      observation_window_until: "2026-10-08T07:00:00+08:00",
      resumed_at: "2026-09-25T08:00:00+08:00",
    });
    pending = s2.getPendingWork("p-001", "2026-09-25T09:00:00+08:00");
    assert.equal(pending.pending_reviews.length, 0);
    assert.equal(pending.unconfirmed_alerts.length, 0);
    assert.equal(pending.due_observation_windows[0].status, "within_window");

    // 观察期到期 → 到期观察；期内再触发停止线 → 要求重新复核。
    assert.equal(s2.getPendingWork("p-001", "2026-10-09T08:00:00+08:00").due_observation_windows[0].status, "due");
    s2.scheduleSession("p-001", {
      plan_id: "plan-jog",
      plan_version: 2,
      session_id: "s-1005",
      slot_at: "2026-10-02T07:00:00+08:00",
      load_level: 1,
    });
    s2.importObservation("p-001", {
      observation_id: "obs-relapse",
      source: { type: "field_observation", person_id: "staff-007", role: "community_sport_instructor" },
      observed_at: "2026-10-02T07:20:00+08:00",
      received_at: "2026-10-02T08:00:00+08:00",
      content: { code: "SYNCOPE", severity: "high", detail: "短暂黑朦" },
    });
    const after = s2.getPendingWork("p-001", "2026-10-02T09:00:00+08:00");
    assert.equal(after.pending_reviews.length, 1, "观察期内新风险须重新复核");
    assert.equal(after.due_observation_windows[0].status, "new_risk_requires_review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("参与者只看到必要提示；专业人员可还原暂停—调整—复训的证据与版本", () => {
  const service = makeService();
  setupLateReportWeek(service);

  const pv = service.participantView("p-001", "2026-09-23T13:00:00+08:00");
  assert.match(pv.message, /暂停/);
  assert.deepEqual(pv.paused_sessions, [{ session_id: "s-0924", slot_at: "2026-09-24T07:00:00+08:00" }]);
  assert.ok(!JSON.stringify(pv).includes("CHEST_PAIN"), "不向参与者暴露医疗代码");
  assert.ok(!JSON.stringify(pv).includes("staff-012"), "不向参与者暴露人员标识");

  service.completeReview("p-001", {
    review_id: "review-obs-late-chestpain",
    reviewer: INSTRUCTOR,
    decision: "require_new_plan",
    completed_at: "2026-09-24T11:00:00+08:00",
  });
  service.resumeTraining("p-001", {
    review_id: "review-obs-late-chestpain",
    confirmer: PHYSICIAN,
    load_ladder: LADDER_V2,
    observation_window_until: "2026-10-08T07:00:00+08:00",
    resumed_at: "2026-09-25T08:00:00+08:00",
  });

  const pv2 = service.participantView("p-001", "2026-09-26T09:00:00+08:00");
  assert.equal(pv2.status, "resumed_under_observation");
  assert.match(pv2.message, /恢复训练/);

  const pro = service.professionalView("p-001");
  const phases = pro.timeline.map((x) => x.phase);
  assert.ok(phases.includes("计划冻结") && phases.includes("证据导入") && phases.includes("暂停") && phases.includes("复核") && phases.includes("复训"));
  // 每个阶段都能定位到所用计划版本。
  const pauseItem = pro.timeline.find((x) => x.event_type === "ACTIVITY_PAUSED");
  assert.ok(pauseItem.payload.trigger_event_id);
  const resumeItem = pro.timeline.find((x) => x.event_type === "TRAINING_RESUMED");
  assert.deepEqual(resumeItem.plan_ref, { plan_id: "plan-jog", plan_version: 2 });
  // 复核收纳的证据完整。
  const review = pro.reviews.find((r) => r.review_id === "review-obs-late-chestpain");
  assert.ok(review.completion.evidence_event_ids.length >= 3);
});

test("多计划并存：观察按活动线归属，跑步停止线不波及力量计划", () => {
  const service = makeService();
  approveV1(service);
  service.approvePlan("p-001", {
    plan_id: "plan-strength",
    applicable_group: { conditions: ["常规参与者"] },
    load_ladder: [{ level: 1, zone: { metric: "rpe", min: 2, max: 4, unit: "级" } }],
    stop_conditions: [{ code: "JOINT_PAIN", description: "关节锐痛" }],
    approver: INSTRUCTOR,
    approved_at: "2026-09-25T18:00:00+08:00",
    effective_from: "2026-09-25T18:00:00+08:00",
  });
  // 跑步场次 10/01 早 7 点；力量场次同日上午 10 点（力量计划生效更晚，
  // 若错误地“取当时最新生效计划”会把胸痛算到力量计划上）。
  service.scheduleSession("p-001", {
    plan_id: "plan-jog", plan_version: 1, session_id: "j-1001",
    slot_at: "2026-10-01T07:00:00+08:00", load_level: 1,
  });
  service.scheduleSession("p-001", {
    plan_id: "plan-strength", plan_version: 1, session_id: "w-1001",
    slot_at: "2026-10-01T10:00:00+08:00", load_level: 1,
  });
  service.scheduleSession("p-001", {
    plan_id: "plan-jog", plan_version: 1, session_id: "j-1002",
    slot_at: "2026-10-02T07:00:00+08:00", load_level: 1,
  });
  service.scheduleSession("p-001", {
    plan_id: "plan-strength", plan_version: 1, session_id: "w-1002",
    slot_at: "2026-10-02T10:00:00+08:00", load_level: 1,
  });

  // 不关联场次，仅靠发生时间重叠归属到跑步场次。
  const r = service.importObservation("p-001", {
    observation_id: "obs-jog-pain",
    source: { type: "self_report", person_id: "p-001" },
    observed_at: "2026-10-01T07:20:00+08:00",
    received_at: "2026-10-01T12:00:00+08:00",
    content: { code: "CHEST_PAIN", severity: "high" },
  });
  assert.match(r.assessment.payload.rationale, /plan-jog v1/);
  assert.deepEqual(r.pause.payload.scope.activity_ids, ["j-1002"], "只暂停后续跑步场次");
  const state = service.getState("p-001");
  assert.equal(state.sessions.get("w-1002").status, "scheduled", "力量场次不被波及");
  assert.equal(state.findPlan("plan-strength", 1).status, "active");
  assert.equal(state.findPlan("plan-jog", 1).status, "paused");
});

test("所有落库事件均通过信封与负载校验", () => {
  const service = makeService();
  setupLateReportWeek(service);
  for (const event of service.getState("p-001").events) {
    assert.deepEqual(validateEvent(event), [], `${event.event_type} ${event.event_id} 校验失败`);
  }
});
