const ENVELOPE_REQUIRED = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
  "payload",
];

export const EVENT_TYPES = [
  "PLAN_APPROVED",
  "EVIDENCE_RECORDED",
  "SESSION_SCHEDULED",
  "SESSION_RECORDED",
  "RISK_FLAGGED",
  "STOP_LINE_TRIGGERED",
  "ACTIVITY_PAUSED",
  "REVIEW_OPENED",
  "REVIEW_COMPLETED",
  "RETURN_CONFIRMED",
  "ACTIVITY_RESUMED",
  "NOTIFICATION_QUEUED",
  "NOTIFICATION_ACKED",
];

export const AGGREGATE_TYPES = [
  "participant_plan",
  "activity_session",
  "risk_observation",
  "clinical_handoff",
];

export const EVIDENCE_SOURCES = ["SELF_REPORT", "FIELD_OBSERVATION", "MEDICAL_ADVICE"];

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkRequired(obj, fields, prefix) {
  const errors = [];
  for (const name of fields) {
    if (!(name in obj)) errors.push(`${prefix}缺少字段：${name}`);
  }
  return errors;
}

/** 只做结构校验；业务规则（升级、暂停、复训授权）见 rules.js / risk-handoff.js。 */
export function validateEvent(record) {
  const errors = [];
  if (!isObject(record)) return ["记录必须是对象"];

  for (const name of ENVELOPE_REQUIRED) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if (errors.length) return errors;

  if (typeof record.event_id !== "string" || !record.event_id) errors.push("event_id 必须是非空字符串");
  if (!EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if (typeof record.aggregate_id !== "string" || !record.aggregate_id) errors.push("aggregate_id 必须是非空字符串");
  if (typeof record.occurred_at !== "string" || !ISO_DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是带时区的 ISO 日期时间");
  }
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if (typeof record.summary !== "string" || !record.summary) errors.push("summary 必须是非空字符串");
  if (!isObject(record.payload)) {
    errors.push("payload 必须是对象");
    return errors;
  }

  errors.push(...validatePayload(record.event_type, record.payload));
  return errors;
}

function validatePayload(type, p) {
  switch (type) {
    case "PLAN_APPROVED": {
      const errors = checkRequired(
        p,
        ["participant_id", "plan_version", "population", "intensity_bands", "stop_lines", "approver", "effective_from", "return_authority_roles"],
        "payload.",
      );
      if (Array.isArray(p.intensity_bands) && p.intensity_bands.length === 0) {
        errors.push("payload.intensity_bands 至少包含一个负荷区间");
      }
      if (Array.isArray(p.return_authority_roles) && p.return_authority_roles.length === 0) {
        errors.push("payload.return_authority_roles 至少包含一个可批准复训的角色");
      }
      if (isObject(p.approver)) errors.push(...checkRequired(p.approver, ["party_id", "role"], "payload.approver."));
      return errors;
    }
    case "EVIDENCE_RECORDED": {
      const errors = checkRequired(p, ["participant_id", "observed_at", "source", "findings"], "payload.");
      if (isObject(p.source)) {
        errors.push(...checkRequired(p.source, ["type", "party_id"], "payload.source."));
        if (p.source.type && !EVIDENCE_SOURCES.includes(p.source.type)) {
          errors.push(`未知证据来源类型：${p.source.type}`);
        }
      }
      if (typeof p.observed_at === "string" && !ISO_DATE_TIME.test(p.observed_at)) {
        errors.push("payload.observed_at 必须是带时区的 ISO 日期时间");
      }
      if (Array.isArray(p.findings)) {
        p.findings.forEach((f, i) => {
          if (!isObject(f) || !f.code || !f.polarity) {
            errors.push(`payload.findings[${i}] 必须包含 code 与 polarity`);
          }
        });
      }
      return errors;
    }
    case "SESSION_SCHEDULED":
    case "SESSION_RECORDED": {
      const errors = checkRequired(p, ["participant_id", "session_id", "planned_plan_version", "scheduled_at"], "payload.");
      if (type === "SESSION_RECORDED") {
        errors.push(...checkRequired(p, ["started_at", "outcome"], "payload."));
      }
      return errors;
    }
    case "RISK_FLAGGED":
    case "STOP_LINE_TRIGGERED": {
      const errors = checkRequired(p, ["participant_id", "level"], "payload.");
      if (type === "STOP_LINE_TRIGGERED") errors.push(...checkRequired(p, ["stop_line_code", "evidence_event_ids"], "payload."));
      return errors;
    }
    case "ACTIVITY_PAUSED":
    case "ACTIVITY_RESUMED": {
      const errors = checkRequired(p, ["participant_id", "scope"], "payload.");
      if (type === "ACTIVITY_PAUSED") errors.push(...checkRequired(p, ["reason", "reason_event_id"], "payload."));
      if (type === "ACTIVITY_RESUMED") errors.push(...checkRequired(p, ["return_event_id", "plan_version"], "payload."));
      return errors;
    }
    case "REVIEW_OPENED":
    case "REVIEW_COMPLETED": {
      const errors = checkRequired(p, ["participant_id", "review_id", "scope"], "payload.");
      if (type === "REVIEW_COMPLETED") {
        errors.push(...checkRequired(p, ["decision", "decided_by"], "payload."));
      }
      return errors;
    }
    case "RETURN_CONFIRMED":
      return checkRequired(
        p,
        ["participant_id", "review_id", "new_plan_version", "load_ladder", "observation_until", "confirmed_by"],
        "payload.",
      );
    case "NOTIFICATION_QUEUED":
      return checkRequired(p, ["participant_id", "audience", "template", "reason_event_id"], "payload.");
    case "NOTIFICATION_ACKED":
      return checkRequired(p, ["participant_id", "notification_event_id"], "payload.");
    default:
      return [];
  }
}
