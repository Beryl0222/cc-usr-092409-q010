/** 超慢跑风险接力使用的领域事件信封。 */

export type EventType =
  | "PLAN_APPROVED"
  | "EVIDENCE_RECORDED"
  | "SESSION_SCHEDULED"
  | "SESSION_RECORDED"
  | "RISK_FLAGGED"
  | "STOP_LINE_TRIGGERED"
  | "ACTIVITY_PAUSED"
  | "REVIEW_OPENED"
  | "REVIEW_COMPLETED"
  | "RETURN_CONFIRMED"
  | "ACTIVITY_RESUMED"
  | "NOTIFICATION_QUEUED"
  | "NOTIFICATION_ACKED";

export type AggregateType = "participant_plan" | "activity_session" | "risk_observation" | "clinical_handoff";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "STOP";

export type ProfessionalRole = "PHYSICIAN" | "SPORTS_INSTRUCTOR" | "COMMUNITY_GUIDE";
export type AnyRole = ProfessionalRole | "PARTICIPANT";

export type EvidenceSourceType = "SELF_REPORT" | "FIELD_OBSERVATION" | "MEDICAL_ADVICE";

/** 事件只追加；occurred_at 是系统接收时间，事实发生时间保留在 payload 内。 */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload: TPayload;
}

/** 计划批准时冻结的内容：适用人群、负荷区间、停止条件、批准角色。 */
export interface PlanApprovedPayload {
  participant_id: string;
  plan_version: string;
  supersedes: string | null;
  population: { cohort: string; contraindications?: string[]; [k: string]: unknown };
  intensity_bands: Array<{
    code: string;
    hr_zone?: [number, number];
    rpe_max: number;
    duration_minutes_max?: number;
  }>;
  stop_lines: Array<{
    code: string;
    min_severity: "mild" | "moderate" | "severe";
    scope?: PauseScope;
    note?: string;
  }>;
  approver: { party_id: string; role: AnyRole; name?: string };
  effective_from: string;
  /** 只有列出的角色可以在停止后确认复训；批准旧计划的角色不自动复用到新版本。 */
  return_authority_roles: ProfessionalRole[];
}

export interface EvidenceSource {
  type: EvidenceSourceType;
  party_id: string;
  party_role?: string;
  party_name?: string;
}

/** 导入的自述、现场观察与医疗建议：保留来源与实际发生时间。 */
export interface EvidenceRecordedPayload {
  participant_id: string;
  observed_at: string;
  source: EvidenceSource;
  source_record_id?: string;
  /** 同一题目的冲突标识；同题正反极性互相隔离，不参与自动升级。 */
  topic?: string;
  findings: Array<{
    code: string;
    polarity: "POSITIVE" | "NEGATIVE";
    severity?: "mild" | "moderate" | "severe";
    note?: string;
  }>;
  note?: string;
}

export interface PauseScope {
  activity_refs?: string[];
  session_ids?: string[];
  all_future?: boolean;
}

export interface SessionRecordedPayload {
  participant_id: string;
  session_id: string;
  planned_plan_version: string;
  scheduled_at: string;
  started_at: string;
  ended_at?: string;
  outcome: "COMPLETED" | "INTERRUPTED" | "NOT_HELD";
  load?: { band_code?: string; rpe?: number; duration_minutes?: number };
  findings?: EvidenceRecordedPayload["findings"];
}

export interface ReturnConfirmedPayload {
  participant_id: string;
  review_id: string;
  new_plan_version: string;
  /** 新负荷阶梯，逐级回升，不能沿用旧批准。 */
  load_ladder: Array<{ step: number; band_code: string; duration_minutes_max: number; gate?: string }>;
  observation_until: string;
  confirmed_by: { party_id: string; role: ProfessionalRole; name?: string };
  note?: string;
}
