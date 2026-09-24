import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { RiskRelay, BusinessError } from "../src/risk-handoff.js";
import { JournaledRiskRelay } from "../src/journal.js";
import { evaluateLevel, isolateConflicts, matchStopLines } from "../src/rules.js";

/** 可控时钟，便于构造跨日迟到记录。 */
function clock(startIso) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms).toISOString(),
    advance: (minutes) => {
      ms += minutes * 60_000;
    },
    set: (iso) => {
      ms = Date.parse(iso);
    },
  };
}

const PLAN_V1 = {
  participant_id: "P01",
  plan_version: "v1",
  supersedes: null,
  population: { cohort: "社区超慢跑入门者", contraindications: ["未控制高血压"] },
  intensity_bands: [
    { code: "WALK", hr_zone: [80, 100], rpe_max: 3, duration_minutes_max: 20 },
    { code: "SLOW_JOG", hr_zone: [100, 120], rpe_max: 4, duration_minutes_max: 30 },
  ],
  stop_lines: [
    { code: "CHEST_PAIN", min_severity: "mild", scope: { all_future: true }, note: "胸痛停全部" },
    { code: "SYNCOPE", min_severity: "mild", scope: { all_future: true } },
    { code: "JOINT_PAIN", min_severity: "moderate", scope: { activity_refs: ["SLOW_JOG"] }, note: "关节痛只停慢跑" },
  ],
  approver: { party_id: "DR-LIN", role: "PHYSICIAN", name: "林医生" },
  effective_from: "2026-09-20T00:00:00+08:00",
  return_authority_roles: ["PHYSICIAN"],
};

function types(events) {
  return events.map((e) => e.event_type);
}

describe("计划批准冻结", () => {
  test("批准事件冻结人群、负荷区间、停止条件与批准角色", () => {
    const svc = new RiskRelay({ now: () => "2026-09-20T10:00:00+08:00" });
    svc.approvePlan(PLAN_V1);
    const plan = svc.events[0].payload;
    assert.equal(plan.population.cohort, "社区超慢跑入门者");
    assert.deepEqual(plan.intensity_bands.map((b) => b.code), ["WALK", "SLOW_JOG"]);
    assert.deepEqual(plan.stop_lines.map((l) => l.code), ["CHEST_PAIN", "SYNCOPE", "JOINT_PAIN"]);
    assert.equal(plan.approver.role, "PHYSICIAN");
    assert.deepEqual(plan.return_authority_roles, ["PHYSICIAN"]);
  });

  test("同一计划版本不能重复批准", () => {
    const svc = new RiskRelay({ now: () => "2026-09-20T10:00:00+08:00" });
    svc.approvePlan(PLAN_V1);
    assert.throws(() => svc.approvePlan(PLAN_V1), (e) => e.code === "DUPLICATE_PLAN_VERSION");
  });
});

describe("跨日迟到记录", () => {
  test("次日才收到的胸痛按事实时间解释：暂停未来场次、已完成场次入复核且不改写", () => {
    const clk = clock("2026-09-21T07:00:00+08:00");
    const svc = new RiskRelay({ now: clk.now });
    svc.approvePlan(PLAN_V1);

    // 9/21 已完成一场慢跑（当时无任何不适记录）
    svc.scheduleSession({
      participant_id: "P01", session_id: "S1", activity_ref: "SLOW_JOG",
      scheduled_at: "2026-09-21T08:00:00+08:00",
    });
    clk.set("2026-09-21T08:30:00+08:00");
    svc.recordSession({
      participant_id: "P01", session_id: "S1", started_at: "2026-09-21T08:00:00+08:00",
      outcome: "COMPLETED", load: { band_code: "SLOW_JOG", rpe: 3, duration_minutes: 25 },
    });

    // 9/22、9/23 排了后续场次
    clk.set("2026-09-21T09:00:00+08:00");
    svc.scheduleSession({ participant_id: "P01", session_id: "S2", activity_ref: "SLOW_JOG", scheduled_at: "2026-09-22T08:00:00+08:00" });
    svc.scheduleSession({ participant_id: "P01", session_id: "W2", activity_ref: "WALK", scheduled_at: "2026-09-22T09:00:00+08:00" });
    svc.scheduleSession({ participant_id: "P01", session_id: "S3", activity_ref: "SLOW_JOG", scheduled_at: "2026-09-23T08:00:00+08:00" });

    // 9/23 才导入：9/21 慢跑后出现胸痛（跨日迟到，发生时间早于 S2 等场次）
    clk.set("2026-09-23T12:00:00+08:00");
    const r = svc.importEvidence({
      participant_id: "P01",
      observed_at: "2026-09-21T08:45:00+08:00",
      source: { type: "SELF_REPORT", party_id: "P01" },
      source_record_id: "late-001",
      findings: [{ code: "CHEST_PAIN", polarity: "POSITIVE", severity: "mild" }],
    });

    assert.equal(r.status, "accepted");
    assert.ok(types(r.events).includes("STOP_LINE_TRIGGERED"));
    assert.ok(types(r.events).includes("ACTIVITY_PAUSED"));
    assert.ok(types(r.events).includes("REVIEW_OPENED"));

    const trigger = r.events.find((e) => e.event_type === "STOP_LINE_TRIGGERED");
    assert.equal(trigger.payload.evidence_observed_at, "2026-09-21T08:45:00+08:00");
    assert.equal(trigger.payload.late_arrival, true);
    // 历史解释使用的是事实时点生效的计划版本
    assert.equal(trigger.payload.plan_version, "v1");

    // 已完成的 S1 保持 COMPLETED 事实；S1 与停止事实之后的未记录场次都进入复核范围
    const review = r.events.find((e) => e.event_type === "REVIEW_OPENED");
    assert.deepEqual(review.payload.session_ids.sort(), ["S1", "S2", "S3", "W2"]);
    const view = svc.participantView("P01", clk.now());
    const s1 = view.sessions.find((x) => x.session_id === "S1");
    assert.equal(s1.status, "COMPLETED");
    // 尚未开始的相关场次显示为暂停
    for (const id of ["S2", "S3", "W2"]) {
      assert.equal(view.sessions.find((x) => x.session_id === id).status, "PAUSED");
    }
  });
});

describe("局部暂停", () => {
  test("关节中度疼痛只暂停慢跑，步行等其他活动照常", () => {
    const clk = clock("2026-09-21T07:00:00+08:00");
    const svc = new RiskRelay({ now: clk.now });
    svc.approvePlan(PLAN_V1);
    svc.scheduleSession({ participant_id: "P01", session_id: "J1", activity_ref: "SLOW_JOG", scheduled_at: "2026-09-22T08:00:00+08:00" });
    svc.scheduleSession({ participant_id: "P01", session_id: "K1", activity_ref: "WALK", scheduled_at: "2026-09-22T09:00:00+08:00" });

    clk.set("2026-09-21T18:00:00+08:00");
    const r = svc.importEvidence({
      participant_id: "P01",
      observed_at: "2026-09-21T17:50:00+08:00",
      source: { type: "FIELD_OBSERVATION", party_id: "INS-9", party_role: "SPORTS_INSTRUCTOR" },
      findings: [{ code: "JOINT_PAIN", polarity: "POSITIVE", severity: "moderate" }],
    });

    const pause = r.events.find((e) => e.event_type === "ACTIVITY_PAUSED");
    assert.ok(pause, "应产生暂停事件");
    assert.deepEqual(pause.payload.scope.activity_refs, ["SLOW_JOG"]);
    assert.ok(!pause.payload.scope.all_future, "不是全部暂停");

    const view = svc.participantView("P01", clk.now());
    assert.equal(view.sessions.find((x) => x.session_id === "J1").status, "PAUSED");
    assert.equal(view.sessions.find((x) => x.session_id === "K1").status, "SCHEDULED");

    // 轻度关节痛不达停止线（min_severity=moderate）
    const svc2 = new RiskRelay({ now: clk.now });
    svc2.approvePlan(PLAN_V1);
    const r2 = svc2.importEvidence({
      participant_id: "P01",
      observed_at: "2026-09-21T17:50:00+08:00",
      source: { type: "SELF_REPORT", party_id: "P01" },
      findings: [{ code: "JOINT_PAIN", polarity: "POSITIVE", severity: "mild" }],
    });
    assert.ok(!types(r2.events).includes("STOP_LINE_TRIGGERED"));
  });

  test("暂停范围里的场次恢复前不能登记为完成，但中断可登记", () => {
    const clk = clock("2026-09-21T07:00:00+08:00");
    const svc = new RiskRelay({ now: clk.now });
    svc.approvePlan(PLAN_V1);
    svc.scheduleSession({ participant_id: "P01", session_id: "J1", activity_ref: "SLOW_JOG", scheduled_at: "2026-09-22T08:00:00+08:00" });
    clk.set("2026-09-21T18:00:00+08:00");
    svc.importEvidence({
      participant_id: "P01", observed_at: "2026-09-21T17:50:00+08:00",
      source: { type: "SELF_REPORT", party_id: "P01" },
      findings: [{ code: "JOINT_PAIN", polarity: "POSITIVE", severity: "moderate" }],
    });
    clk.set("2026-09-22T08:05:00+08:00");
    assert.throws(
      () => svc.recordSession({ participant_id: "P01", session_id: "J1", started_at: "2026-09-22T08:00:00+08:00", outcome: "COMPLETED" }),
      (e) => e.code === "ACTIVITY_PAUSED",
    );
    const r = svc.recordSession({ participant_id: "P01", session_id: "J1", started_at: "2026-09-22T08:00:00+08:00", outcome: "INTERRUPTED" });
    assert.ok(types(r.events).includes("SESSION_RECORDED"));
  });
});

describe("重复导入", () => {
  test("同一观察完全重放不重复升级", () => {
    const svc = new RiskRelay({ now: () => "2026-09-21T18:00:00+08:00" });
    svc.approvePlan(PLAN_V1);
    const payload = {
      participant_id: "P01",
      observed_at: "2026-09-21T17:50:00+08:00",
      source: { type: "SELF_REPORT", party_id: "P01" },
      findings: [{ code: "CHEST_PAIN", polarity: "POSITIVE", severity: "mild" }],
    };
    const first = svc.importEvidence(payload);
    const stopCountAfterFirst = svc.events.filter((e) => e.event_type === "STOP_LINE_TRIGGERED").length;
    assert.equal(first.status, "accepted");

    const again = svc.importEvidence({ ...payload });
    assert.equal(again.status, "duplicated");
    assert.deepEqual(again.events, []);
    assert.equal(svc.events.filter((e) => e.event_type === "STOP_LINE_TRIGGERED").length, stopCountAfterFirst);
    assert.equal(svc.events.filter((e) => e.event_type === "EVIDENCE_RECORDED").length, 1);
    // 停止线的专业人员通知 + 参与者暂停通知，各仅一次
    assert.equal(svc.events.filter((e) => e.event_type === "NOTIFICATION_QUEUED").length, 2);
  });

  test("来源记录号相同即视为同一观察，即使其他字段不同也不重复导入", () => {
    const svc = new RiskRelay({ now: () => "2026-09-21T18:00:00+08:00" });
    svc.approvePlan(PLAN_V1);
    const base = {
      participant_id: "P01", observed_at: "2026-09-21T17:50:00+08:00",
      source: { type: "SELF_REPORT", party_id: "P01" }, source_record_id: "EXT-77",
      findings: [{ code: "DYSPNEA", polarity: "POSITIVE", severity: "mild" }],
    };
    assert.equal(svc.importEvidence(base).status, "accepted");
    assert.equal(svc.importEvidence({ ...base, note: "重发" }).status, "duplicated");
  });
});

describe("内容冲突隔离", () => {
  test("同题正反说法隔离，不触发停止线，转人工复核通知", () => {
    const svc = new RiskRelay({ now: () => "2026-09-22T10:00:00+08:00" });
    svc.approvePlan(PLAN_V1);
    svc.importEvidence({
      participant_id: "P01", observed_at: "2026-09-22T08:10:00+08:00",
      source: { type: "SELF_REPORT", party_id: "P01" }, source_record_id: "a",
      findings: [{ code: "CHEST_PAIN", polarity: "POSITIVE", severity: "mild" }],
    });
    // 先触发了停止线
    assert.equal(svc.events.filter((e) => e.event_type === "STOP_LINE_TRIGGERED").length, 1);

    // 现场观察否认胸痛（同 code 冲突）-> 该组隔离，并通知专业人员
    const r = svc.importEvidence({
      participant_id: "P01", observed_at: "2026-09-22T08:20:00+08:00",
      source: { type: "FIELD_OBSERVATION", party_id: "INS-9" }, source_record_id: "b",
      findings: [{ code: "CHEST_PAIN", polarity: "NEGATIVE" }],
    });
    const conflictNote = r.events.find(
      (e) => e.event_type === "NOTIFICATION_QUEUED" && e.payload.template === "EVIDENCE_CONFLICT",
    );
    assert.ok(conflictNote, "冲突应通知专业人员");

    // 规则层：冲突组不参与判定
    const { active, conflicts } = isolateConflicts([
      { event_id: "a", payload: { findings: [{ code: "CHEST_PAIN", polarity: "POSITIVE" }] } },
      { event_id: "b", payload: { findings: [{ code: "CHEST_PAIN", polarity: "NEGATIVE" }] } },
    ]);
    assert.equal(active.length, 0);
    assert.equal(conflicts.length, 2);
    assert.equal(
      matchStopLines(
        [
          { event_id: "a", payload: { findings: [{ code: "CHEST_PAIN", polarity: "POSITIVE", severity: "mild" }] } },
          { event_id: "b", payload: { findings: [{ code: "CHEST_PAIN", polarity: "NEGATIVE" }] } },
        ],
        PLAN_V1.stop_lines,
      ).length,
      0,
    );

    // 同事件中不冲突的其他症状仍然生效
    const level = evaluateLevel([
      {
        event_id: "c",
        payload: {
          findings: [
            { code: "CHEST_PAIN", polarity: "POSITIVE" },
            { code: "JOINT_PAIN", polarity: "NEGATIVE" },
          ],
        },
      },
      { event_id: "d", payload: { findings: [{ code: "CHEST_PAIN", polarity: "NEGATIVE" }] } },
    ]);
    assert.equal(level, "LOW");
  });
});

function runToStop(nowIso) {
  const svc = new RiskRelay({ now: () => nowIso });
  svc.approvePlan(PLAN_V1);
  svc.scheduleSession({ participant_id: "P01", session_id: "S9", activity_ref: "SLOW_JOG", scheduled_at: "2026-09-25T08:00:00+08:00" });
  svc.importEvidence({
    participant_id: "P01", observed_at: "2026-09-22T08:45:00+08:00",
    source: { type: "SELF_REPORT", party_id: "P01" }, source_record_id: "late-chest",
    findings: [{ code: "CHEST_PAIN", polarity: "POSITIVE", severity: "mild" }],
  });
  return svc;
}

describe("复训授权", () => {
  test("复训必须由有权角色用停止后新批准的计划确认负荷阶梯与观察期", () => {
    const svc = runToStop("2026-09-23T12:00:00+08:00");
    const reviewId = svc.events.find((e) => e.event_type === "REVIEW_OPENED").payload.review_id;

    // 未完成复核不能复训
    assert.throws(
      () => svc.confirmReturn({
        participant_id: "P01", review_id: reviewId, new_plan_version: "v2",
        load_ladder: [{ step: 1, band_code: "WALK", duration_minutes_max: 10 }],
        observation_until: "2026-10-07T00:00:00+08:00",
        confirmed_by: { party_id: "DR-LIN", role: "PHYSICIAN" },
      }),
      (e) => e.code === "REVIEW_OPEN",
    );

    svc.completeReview({
      participant_id: "P01", review_id: reviewId, decision: "RETURN_WITH_RESTRICTION",
      decided_by: { party_id: "DR-LIN", role: "PHYSICIAN" }, note: "心电图无异常，降阶恢复",
    });

    // 新计划尚未批准
    assert.throws(
      () => svc.confirmReturn({
        participant_id: "P01", review_id: reviewId, new_plan_version: "v2",
        load_ladder: [{ step: 1, band_code: "WALK", duration_minutes_max: 10 }],
        observation_until: "2026-10-07T00:00:00+08:00",
        confirmed_by: { party_id: "DR-LIN", role: "PHYSICIAN" },
      }),
      (e) => e.code === "UNKNOWN_PLAN",
    );

    // 社区指导员无权复训（v1 只授权 PHYSICIAN）
    svc.approvePlan({ ...PLAN_V1, plan_version: "v2", supersedes: "v1", effective_from: "2026-09-24T00:00:00+08:00" });
    assert.throws(
      () => svc.confirmReturn({
        participant_id: "P01", review_id: reviewId, new_plan_version: "v2",
        load_ladder: [{ step: 1, band_code: "WALK", duration_minutes_max: 10 }],
        observation_until: "2026-10-07T00:00:00+08:00",
        confirmed_by: { party_id: "INS-9", role: "COMMUNITY_GUIDE" },
      }),
      (e) => e.code === "FORBIDDEN_ROLE",
    );

    const r = svc.confirmReturn({
      participant_id: "P01", review_id: reviewId, new_plan_version: "v2",
      load_ladder: [
        { step: 1, band_code: "WALK", duration_minutes_max: 10, gate: "无胸痛" },
        { step: 2, band_code: "SLOW_JOG", duration_minutes_max: 15 },
      ],
      observation_until: "2026-10-07T00:00:00+08:00",
      confirmed_by: { party_id: "DR-LIN", role: "PHYSICIAN" },
    });
    assert.deepEqual(types(r.events), ["RETURN_CONFIRMED", "ACTIVITY_RESUMED", "NOTIFICATION_QUEUED", "NOTIFICATION_QUEUED", "NOTIFICATION_QUEUED"]);
    assert.equal(svc.events.find((e) => e.event_type === "ACTIVITY_RESUMED").payload.plan_version, "v2");

    // 恢复后场次不再暂停；旧周期的胸痛不重新触发停止线
    const view = svc.participantView("P01", "2026-09-24T12:00:00+08:00");
    assert.equal(view.sessions.find((x) => x.session_id === "S9").status, "SCHEDULED");
  });

  test("不能沿用触发停止线的旧批准：v2 若批准时间早于停止事件也被拒绝", () => {
    const svc = runToStop("2026-09-23T12:00:00+08:00");
    const reviewId = svc.events.find((e) => e.event_type === "REVIEW_OPENED").payload.review_id;
    svc.completeReview({
      participant_id: "P01", review_id: reviewId, decision: "RETURN_WITH_RESTRICTION",
      decided_by: { party_id: "DR-LIN", role: "PHYSICIAN" },
    });
    // 直接尝试用 v1（停止时的版本）复训
    assert.throws(
      () => svc.confirmReturn({
        participant_id: "P01", review_id: reviewId, new_plan_version: "v1",
        load_ladder: [{ step: 1, band_code: "WALK", duration_minutes_max: 10 }],
        observation_until: "2026-10-07T00:00:00+08:00",
        confirmed_by: { party_id: "DR-LIN", role: "PHYSICIAN" },
      }),
      (e) => e.code === "PLAN_TOO_OLD" || e.code === "PLAN_USED_WHEN_STOPPED",
    );
  });
});

describe("中断恢复", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("重启后继续待复核、到期观察和未确认通知，且不重复自动化", () => {
    const file = join(dir, "events.jsonl");
    let svc = new JournaledRiskRelay(file, { now: () => "2026-09-23T12:00:00+08:00" });
    svc.approvePlan(PLAN_V1);
    svc.scheduleSession({ participant_id: "P01", session_id: "S9", activity_ref: "SLOW_JOG", scheduled_at: "2026-09-25T08:00:00+08:00" });
    svc.importEvidence({
      participant_id: "P01", observed_at: "2026-09-22T08:45:00+08:00",
      source: { type: "SELF_REPORT", party_id: "P01" }, source_record_id: "late-chest",
      findings: [{ code: "CHEST_PAIN", polarity: "POSITIVE", severity: "mild" }],
    });

    const linesBefore = readFileSync(file, "utf8").trim().split("\n").length;
    // 模拟服务中断后重启
    svc = new JournaledRiskRelay(file, { now: () => "2026-09-25T08:00:00+08:00" });
    const summary = svc.resume("2026-09-25T08:00:00+08:00");
    assert.equal(summary.pending_reviews.length, 1);
    assert.equal(summary.pending_reviews[0].participant_id, "P01");
    assert.equal(summary.pending_reviews[0].overdue, true);
    assert.ok(summary.unacked_notifications.some((n) => n.template === "STOP_REVIEW_REQUIRED"));
    // 重放没有产生任何重复事件
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, linesBefore);
    // 暂停状态正确恢复
    assert.equal(svc.participantView("P01").sessions.find((x) => x.session_id === "S9").status, "PAUSED");

    // 完成复核 + 复训，观察期设为过去时间，恢复摘要应列到期观察
    const reviewId = summary.pending_reviews[0].review_id;
    svc.completeReview({
      participant_id: "P01", review_id: reviewId, decision: "RETURN_WITH_RESTRICTION",
      decided_by: { party_id: "DR-LIN", role: "PHYSICIAN" },
    });
    svc.approvePlan({ ...PLAN_V1, plan_version: "v2", supersedes: "v1", effective_from: "2026-09-24T00:00:00+08:00" });
    svc.confirmReturn({
      participant_id: "P01", review_id: reviewId, new_plan_version: "v2",
      load_ladder: [{ step: 1, band_code: "WALK", duration_minutes_max: 10 }],
      observation_until: "2026-09-24T00:00:00+08:00",
      confirmed_by: { party_id: "DR-LIN", role: "PHYSICIAN" },
    });
    const after = new JournaledRiskRelay(file, { now: () => "2026-09-26T08:00:00+08:00" })
      .resume("2026-09-26T08:00:00+08:00");
    assert.equal(after.pending_reviews.length, 0);
    assert.equal(after.due_observations.length, 1);
    assert.ok(after.unacked_notifications.some((n) => n.template === "OBSERVATION_DUE"));
  });
});

describe("可见性与审计", () => {
  test("参与者只看到必要提示，专业人员可还原证据与计划版本链条", () => {
    const svc = runToStop("2026-09-23T12:00:00+08:00");
    const view = svc.participantView("P01");
    for (const notice of view.notices) {
      assert.ok(!/STOP|HIGH|胸痛|MEDICAL/.test(notice.message), "参与者提示不应暴露等级或症状细节");
    }
    assert.ok(view.notices.some((n) => /暂停/.test(n.message)));

    const timeline = svc.professionalTimeline("P01");
    const stop = timeline.find((x) => x.kind === "STOP");
    assert.equal(stop.plan_version, "v1");
    assert.equal(stop.based_on.length, 1);
    assert.ok(stop.late);
    const evidence = timeline.find((x) => x.kind === "EVIDENCE");
    assert.equal(evidence.applied_plan, "v1");
    assert.equal(evidence.source.type, "SELF_REPORT");
    const pause = timeline.find((x) => x.kind === "PAUSE");
    assert.equal(pause.reason_event_id, stop.event_id, "暂停可回溯到停止事件");
  });

  test("自动判断只提出风险等级，不产生诊疗决定", () => {
    const svc = new RiskRelay({ now: () => "2026-09-21T18:00:00+08:00" });
    svc.approvePlan(PLAN_V1);
    svc.importEvidence({
      participant_id: "P01", observed_at: "2026-09-21T17:50:00+08:00",
      source: { type: "FIELD_OBSERVATION", party_id: "INS-9" },
      findings: [{ code: "DYSPNEA", polarity: "POSITIVE", severity: "mild" }],
    });
    const flag = svc.events.find((e) => e.event_type === "RISK_FLAGGED");
    assert.equal(flag.payload.level, "MEDIUM");
    assert.equal(flag.payload.automated, true);
    // 未达停止线：没有暂停，也没有复核
    assert.ok(!svc.events.some((e) => e.event_type === "ACTIVITY_PAUSED"));
    assert.ok(!svc.events.some((e) => e.event_type === "REVIEW_OPENED"));
  });
});
