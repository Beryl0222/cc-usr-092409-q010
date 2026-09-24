/** 超慢跑风险接力使用的领域事件信封。 */

export type EventType =
  | "PLAN_APPROVED"
  | "SESSION_SCHEDULED"
  | "SESSION_RECORDED"
  | "OBSERVATION_IMPORTED"
  | "RISK_ASSESSED"
  | "ACTIVITY_PAUSED"
  | "REVIEW_OPENED"
  | "REVIEW_COMPLETED"
  | "TRAINING_RESUMED";

export type AggregateType =
  | "participant_plan"
  | "activity_session"
  | "risk_observation"
  | "clinical_handoff";

/** 观察来源：参与者自述、现场（指导员/同伴）观察、医疗建议。 */
export type ObservationSourceType =
  | "self_report"
  | "field_observation"
  | "medical_advice";

/** 系统自动判断只提出风险等级，不代替专业人员决策。 */
export type RiskLevel = "low" | "elevated" | "high" | "stop_line";

export interface RoleRef {
  person_id: string;
  role: string;
  name?: string;
  org?: string;
}

export interface LoadZone {
  metric: string;
  min: number;
  max: number;
  unit: string;
}

export interface LoadRung {
  level: number;
  zone: LoadZone;
}

export interface StopCondition {
  code: string;
  description: string;
  threshold?: number | string | null;
}

export interface ObservationSource {
  type: ObservationSourceType;
  person_id?: string;
  role?: string;
  name?: string;
  org?: string;
}

export interface ObservationContent {
  /** 对应计划停止条件 code，或非停止线症状代码。 */
  code: string;
  severity?: string;
  detail?: string;
}

export type EventPayload =
  | PlanApprovedPayload
  | SessionScheduledPayload
  | SessionRecordedPayload
  | ObservationImportedPayload
  | RiskAssessedPayload
  | ActivityPausedPayload
  | ReviewOpenedPayload
  | ReviewCompletedPayload
  | TrainingResumedPayload;

export interface PlanApprovedPayload {
  plan_id: string;
  plan_version: number;
  supersedes_plan_id?: string | null;
  /** 冻结的适用人群条件。 */
  applicable_group: { conditions: string[] };
  /** 冻结的负荷阶梯（区间）。 */
  load_ladder: LoadRung[];
  /** 冻结的停止条件。 */
  stop_conditions: StopCondition[];
  /** 批准角色：只有具备职责的角色可批准/确认。 */
  approver: RoleRef;
  approved_at: string;
  effective_from: string;
}

export interface SessionScheduledPayload {
  plan_id: string;
  plan_version: number;
  session_id: string;
  slot_at: string;
  /** 预期时长（分钟），用于未记录场次的时间窗口与观察归属。 */
  expected_duration_minutes?: number;
  load_level: number;
}

export interface SessionRecordedPayload {
  plan_id: string;
  plan_version: number;
  session_id: string;
  started_at?: string | null;
  finished_at?: string | null;
  completed: boolean;
  load_level?: number;
  recorded_facts?: Record<string, unknown>;
  recorded_at: string;
  note?: string;
}

export interface ObservationImportedPayload {
  observation_id: string;
  source: ObservationSource;
  /** 症状/建议实际发生时间（迟到记录按此时间进入历史解释）。 */
  observed_at: string;
  /** 系统接收时间。 */
  received_at: string;
  content: ObservationContent;
  /** 内容冲突隔离键；不同键的矛盾观察各自留存，不互相覆盖。 */
  conflict_key?: string | null;
}

export interface RiskAssessedPayload {
  observation_ids: string[];
  level: RiskLevel;
  stop_condition_code?: string | null;
  rule_version: string;
  rationale?: string;
  assessed_at: string;
}

export interface PauseScope {
  /** plan：冻结整个计划；activity：仅暂停尚未开始的相关活动。 */
  kind: "plan" | "activity";
  plan_id?: string;
  activity_ids?: string[];
}

export interface ActivityPausedPayload {
  scope: PauseScope;
  reason: string;
  trigger_event_id: string;
  stop_condition_code?: string | null;
  effective_from: string;
}

export interface ReviewOpenedPayload {
  review_id: string;
  trigger_event_id: string;
  reason: string;
  opened_at: string;
  /** 进入复核范围的已完成场次（保持当时事实）。 */
  included_session_ids: string[];
  observation_ids?: string[];
}

export interface ReviewCompletedPayload {
  review_id: string;
  reviewer: RoleRef;
  decision: "remain_paused" | "require_new_plan" | "resolved";
  findings?: string;
  evidence_event_ids?: string[];
  completed_at: string;
}

export interface TrainingResumedPayload {
  new_plan_id: string;
  new_plan_version: number;
  previous_plan_id: string;
  /** 确认复训的人员，须具备合格职责角色。 */
  confirmer: RoleRef;
  load_ladder: LoadRung[];
  /** 观察期限。 */
  observation_window_until: string;
  /** 本次恢复依据的事件（复核结论、医疗建议等）。 */
  based_on_event_ids: string[];
  resumed_at: string;
}

export interface DomainEvent<P extends EventPayload = EventPayload> {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload: P;
}
