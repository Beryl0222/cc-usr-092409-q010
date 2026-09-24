const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary", "payload"];

const EVENT_TYPES = new Set([
  "PLAN_APPROVED",
  "SESSION_SCHEDULED",
  "SESSION_RECORDED",
  "OBSERVATION_IMPORTED",
  "RISK_ASSESSED",
  "ACTIVITY_PAUSED",
  "REVIEW_OPENED",
  "REVIEW_COMPLETED",
  "TRAINING_RESUMED",
]);

const AGGREGATE_TYPES = new Set([
  "participant_plan",
  "activity_session",
  "risk_observation",
  "clinical_handoff",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const PAYLOAD_REQUIRED = {
  PLAN_APPROVED: ["plan_id", "plan_version", "applicable_group", "load_ladder", "stop_conditions", "approver", "approved_at", "effective_from"],
  SESSION_SCHEDULED: ["plan_id", "plan_version", "session_id", "slot_at", "load_level"],
  SESSION_RECORDED: ["plan_id", "plan_version", "session_id", "completed", "recorded_at"],
  OBSERVATION_IMPORTED: ["observation_id", "source", "observed_at", "received_at", "content"],
  RISK_ASSESSED: ["observation_ids", "level", "rule_version", "assessed_at"],
  ACTIVITY_PAUSED: ["scope", "reason", "trigger_event_id", "effective_from"],
  REVIEW_OPENED: ["review_id", "trigger_event_id", "reason", "opened_at", "included_session_ids"],
  REVIEW_COMPLETED: ["review_id", "reviewer", "decision", "completed_at"],
  TRAINING_RESUMED: [
    "new_plan_id",
    "new_plan_version",
    "previous_plan_id",
    "confirmer",
    "load_ladder",
    "observation_window_until",
    "based_on_event_ids",
    "resumed_at",
  ],
};

/**
 * 校验领域事件信封与按类型区分的最小负载。
 * 业务流程（停止线、角色权限等）由 risk-handoff 服务负责。
 * @returns {string[]} 错误信息列表，空数组表示通过。
 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);
  if (errors.length) return errors;

  if (typeof record.event_id !== "string" || !record.event_id) errors.push("event_id 必须是非空字符串");
  if (!EVENT_TYPES.has(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if (!AGGREGATE_TYPES.has(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if (typeof record.aggregate_id !== "string" || !record.aggregate_id) errors.push("aggregate_id 必须是非空字符串");
  if (typeof record.occurred_at !== "string" || !ISO_DATE.test(record.occurred_at)) errors.push("occurred_at 必须是带时区的 ISO 时间");
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if (typeof record.summary !== "string" || !record.summary) errors.push("summary 必须是非空字符串");
  if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
    errors.push("payload 必须是对象");
    return errors;
  }

  const requiredPayload = PAYLOAD_REQUIRED[record.event_type];
  if (requiredPayload) {
    for (const name of requiredPayload) {
      if (!(name in record.payload)) errors.push(`payload 缺少字段：${name}`);
    }
  }

  const p = record.payload;
  if (record.event_type === "OBSERVATION_IMPORTED" && p.source && typeof p.source === "object") {
    if (!["self_report", "field_observation", "medical_advice"].includes(p.source.type)) {
      errors.push("观察来源 type 必须是 self_report / field_observation / medical_advice");
    }
  }
  if (record.event_type === "RISK_ASSESSED" && p.level) {
    if (!["low", "elevated", "high", "stop_line"].includes(p.level)) {
      errors.push("风险等级必须是 low / elevated / high / stop_line");
    }
  }
  if (record.event_type === "PLAN_APPROVED") {
    if (!Array.isArray(p.load_ladder) || p.load_ladder.length === 0) errors.push("load_ladder 至少包含一个负荷阶梯");
    if (!Array.isArray(p.stop_conditions) || p.stop_conditions.length === 0) errors.push("stop_conditions 至少包含一条停止条件");
    if (!p.approver || typeof p.approver.role !== "string" || !p.approver.role) errors.push("approver 必须含 role");
  }
  if (record.event_type === "ACTIVITY_PAUSED" && p.scope) {
    if (!["plan", "activity"].includes(p.scope.kind)) errors.push("暂停 scope.kind 必须是 plan / activity");
  }
  return errors;
}
