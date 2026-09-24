# 超慢跑风险接力

社区超慢跑场景下，把「计划批准 → 场次记录 → 风险提示 → 暂停 → 复核 → 复训」做成一条可追溯、可在中断后继续的风险接力服务。核心问题：参与者的不适记录常常**迟到**（练完后续场次后才上报），简单把计划整体标暂停既说不清哪些场次受影响，也无法安全衔接医生建议后的复训。

## 领域事件（只追加，不可原地改写）

| 事件 | 含义 |
| --- | --- |
| `PLAN_APPROVED` | 批准并**冻结**一版计划：适用人群、负荷阶梯（区间）、停止条件、批准角色。版本号只增不减。 |
| `SESSION_SCHEDULED` | 场次排期，挂在某个已冻结的计划版本上。 |
| `SESSION_RECORDED` | 场次事实记录。已发生事实不随后到信息改写；暂停后补录完成的场次标记为违例完成并自动补开复核。 |
| `OBSERVATION_IMPORTED` | 导入参与者自述 / 现场观察 / 医疗建议，分别保留来源、`observed_at`（发生时间）与 `received_at`（接收时间）。 |
| `RISK_ASSESSED` | 系统**只提出风险等级**（low/elevated/high/stop_line）及依据，不代替专业决策。 |
| `ACTIVITY_PAUSED` | 触发停止线后立即暂停「尚未开始」的相关活动（可局部暂停 `activity`，或计划级 `plan`）；已完成场次不动。 |
| `REVIEW_OPENED` / `REVIEW_COMPLETED` | 复核开启/结论（继续暂停 / 需新版计划复训 / 风险解除），收纳受影响的已完成场次与证据。 |
| `TRAINING_RESUMED` | 具备职责的角色确认**新**负荷阶梯与观察期限，产生新版计划批准；旧批准不沿用。 |

## 关键规则

- **计划版本冻结**：适用人群、负荷区间、停止条件、批准角色随版本固化。复训必须由具备职责的角色（运动医学医生 / 康复专员）确认新版本；社区指导员可批准常规计划与出具复核结论，但不能单独确认复训。
- **迟到记录按实际发生时间解释历史**：风险判断使用 `observed_at` 时有效的计划版本；暂停等当下行动按 `received_at` 执行。症状发生之后、上报之前已练完的场次保持当时事实并进入复核；上报之时尚未开始的场次立即暂停。
- **幂等导入**：同一 `observation_id` 完全重放直接返回既有判断，不重复评估、不重复升级、不重复暂停。
- **内容冲突隔离**：不同 `conflict_key` 的矛盾观察各自留存、独立评估，系统不自动消解，交复核处理。
- **局部暂停**：观察按「显式关联场次 → 时间重叠场次 → 当时生效计划」归属活动线，只暂停该活动线上尚未开始的场次，其他计划（如力量训练）不受影响。
- **中断恢复**：状态全部由事件流重放得到。使用 `FileEventStore`（每参与者一个 JSONL 文件）时，进程重启后 `getPendingWork` 会继续给出待复核、未确认的停止线通知与复训观察窗（到期 / 期内新风险需重新复核）。
- **最小知情**：`participantView` 只返回必要提示（暂停、复训观察期），不含医疗代码、证据链与人员标识；`professionalView` 与 `reconstructTimeline` 可完整还原一次暂停、调整与复训使用了哪些证据和计划版本。

## 目录

- `contracts/domain.schema.json`：领域事件信封与按类型区分的负载约定。
- `src/domain.ts`：事件与负载的 TypeScript 类型。
- `src/validator.js`：事件信封与最小负载校验。
- `src/event-store.js`：`InMemoryEventStore` / `FileEventStore`（JSONL 追加存储）。
- `src/risk-handoff.js`：风险接力核心服务（命令、状态重放、待办与视图、溯源时间线）。
- `data/sample.json`：冻结计划批准样例。
- `tests/contract.test.js`、`tests/risk-handoff.test.js`：契约与业务场景测试。

## 最小用法

```js
import { FileEventStore } from "./src/event-store.js";
import { RiskHandoffService } from "./src/risk-handoff.js";

const svc = new RiskHandoffService(new FileEventStore("./data/streams"));

svc.approvePlan("p-001", {
  plan_id: "plan-jog",
  applicable_group: { conditions: ["社区超慢跑常规参与者"] },
  load_ladder: [{ level: 1, zone: { metric: "heart_rate", min: 90, max: 110, unit: "bpm" } }],
  stop_conditions: [{ code: "CHEST_PAIN", description: "胸痛、胸闷" }],
  approver: { person_id: "staff-007", role: "community_sport_instructor" },
});

// observed_at 早于 received_at：跨日迟到记录
svc.importObservation("p-001", {
  observation_id: "obs-1",
  source: { type: "self_report", person_id: "p-001" },
  observed_at: "2026-09-22T07:25:00+08:00",
  received_at: "2026-09-23T12:00:00+08:00",
  content: { code: "CHEST_PAIN", severity: "high", session_id: "s-0922" },
});
// → RISK_ASSESSED(stop_line) + ACTIVITY_PAUSED(仅未开始场次) + REVIEW_OPENED(受影响已完成场次)
```

## 本地检查

```bash
npm test   # node --test：契约样例 + 11 个业务场景（跨日迟到、局部暂停、重复导入、冲突隔离、中断恢复、复训等）
npm run build
```

上述命令均在单个 Linux 应用容器内执行，不需要外部服务。
