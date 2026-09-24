# 超慢跑风险接力

社区超慢跑场景下的**风险观察与复训接力**领域服务：计划批准时冻结安全边界，多来源观察（参与者自述、现场观察、医疗建议）带着来源与发生时间进入只追加的事件流；自动判断只提出风险等级，触发停止线时立即暂停尚未开始的相关活动，已完成场次保持事实并进入复核；复训必须由具备职责的人员基于新版本计划确认负荷阶梯与观察期限。

## 领域规则

- **计划冻结**（`PLAN_APPROVED`）：每版计划冻结适用人群、负荷区间（心率区间/RPE 上限/时长）、停止条件（症状码 + 最低严重度 + 暂停范围）与批准角色，并声明哪些角色有权确认复训（`return_authority_roles`）。
- **证据保留来源与时间**（`EVIDENCE_RECORDED`）：`observed_at` 是事实发生时间，`received_at` 是系统接收时间。次日才录入的不适按事实时间解释历史（迟到记录），但暂停等动作只作用于接收时刻仍未开始的活动。
- **自动判断只提等级**（`RISK_FLAGGED`）：LOW/MEDIUM/HIGH 由确定性规则得出（`src/rules.js`），不产生诊疗结论；是否恢复由人决定。
- **停止线**（`STOP_LINE_TRIGGERED` → `ACTIVITY_PAUSED` / `REVIEW_OPENED`）：
  - 立即暂停尚未开始的相关活动，支持**局部暂停**（如关节痛只暂停 `SLOW_JOG`，保留 `WALK`）。
  - 已完成/已中断场次保持当时事实（不改写为取消），进入复核范围。
  - 同一计划周期内同一停止线不重复升级。
- **冲突隔离**：同一症状（或同一 `topic`）出现正反两种说法时，该组发现被隔离，不参与自动升级，转专业人员人工判断；同事件中无关发现仍生效。
- **重复导入幂等**：来源记录号相同，或来源 + 发生时间 + 内容指纹完全一致，视为同一观察的重放，不追加事件、不重复升级。
- **复训不得沿用旧批准**（`RETURN_CONFIRMED` → `ACTIVITY_RESUMED`）：复核完成后，由新版本计划 `return_authority_roles` 中的角色确认新的负荷阶梯与观察期限；触发停止线的旧版本、停止前批准的计划都不能作为复训依据。恢复开启新周期。
- **中断恢复**：事件持久化为 JSONL（`src/journal.js`），重启重放后继续列出待复核案件（含超期标记）、到期观察与未确认通知；重放不重复触发暂停和通知。
- **最小可见性**：参与者视图只有场次状态与暂停/恢复的大白话提示；专业人员时间线可还原一次暂停、调整与复训分别使用了哪些证据和哪版计划。

## 目录

- `contracts/domain.schema.json`：事件信封与各类负载的 JSON Schema。
- `src/validator.js`：事件结构校验（零依赖）。
- `src/rules.js`：风险等级、停止线匹配、冲突隔离、指纹去重、计划时点选择。
- `src/risk-handoff.js`：`RiskRelay` 领域服务（命令、投影、自动化接力、查询）。
- `src/journal.js`：`JournaledRiskRelay`，JSONL 持久化与中断恢复摘要。
- `src/domain.ts`：TypeScript 类型定义。
- `data/sample.json`：冻结计划批准事件样例。
- `tests/`：契约测试与场景测试（跨日迟到记录、局部暂停、重复导入、冲突隔离、复训授权、重启恢复、可见性）。

## 最小用法

```js
import { JournaledRiskRelay } from "./src/journal.js";

const svc = new JournaledRiskRelay("events.jsonl", { now: () => new Date().toISOString() });

svc.approvePlan(plan);                       // 冻结 v1
svc.scheduleSession({ session_id: "S2", activity_ref: "SLOW_JOG", scheduled_at, participant_id: "P01" });
svc.importEvidence({                          // 迟到的胸痛自述
  participant_id: "P01",
  observed_at: "2026-09-21T08:45:00+08:00",
  source: { type: "SELF_REPORT", party_id: "P01" },
  findings: [{ code: "CHEST_PAIN", polarity: "POSITIVE", severity: "mild" }],
});
// => S2 自动暂停，已完成场次进入复核，参与者与专业人员各收到必要通知

svc.completeReview({ review_id, decision: "RETURN_WITH_RESTRICTION", decided_by: { role: "PHYSICIAN", ... } });
svc.approvePlan({ ...plan, plan_version: "v2", supersedes: "v1" });
svc.confirmReturn({ review_id, new_plan_version: "v2", load_ladder, observation_until, confirmed_by: { role: "PHYSICIAN", ... } });

svc.participantView("P01");                  // 参与者：必要提示
svc.professionalTimeline("P01");             // 专业人员：证据—计划版本—暂停—复训链条
svc.resume();                                // 中断后：待复核 / 到期观察 / 未确认通知
```

## 本地检查

```bash
npm test     # node --test，14 个测试
npm run build # 各源文件语法检查
```

事件一旦被接收，其标识、发生时间和版本不应被原地改写；业务更正应产生后继记录。涉及个人或医疗敏感信息时，调用方只读取完成职责所必需的字段。
