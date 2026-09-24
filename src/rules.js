/**
 * 确定性风险规则：证据 -> 风险等级 / 停止线命中。
 * 自动判断只产出风险等级，不给出诊疗结论；是否复训由具备职责的人员决定。
 */

export const RISK_LEVELS = /** @type {const} */ (["LOW", "MEDIUM", "HIGH", "STOP"]);
const LEVEL_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, STOP: 3 };

export const SEVERITY_RANK = { mild: 1, moderate: 2, severe: 3 };

/** 心血管/循环相关症状：同等严重度下比肌肉骨骼问题升级更快。 */
const CARDIO_CODES = new Set([
  "CHEST_PAIN",
  "CHEST_DISCOMFORT",
  "DYSPNEA",
  "PALPITATION",
  "DIZZINESS",
  "SYNCOPE",
  "ABNORMAL_HR",
  "BLOOD_PRESSURE_HIGH",
  "MEDICAL_DIAGNOSIS",
  "MEDICAL_RESTRICTION",
]);

export function maxLevel(a, b) {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/**
 * 冲突分组键：显式 topic 优先，否则用症状码。
 * 同一键下同时出现 POSITIVE 与 NEGATIVE 时，该组证据全部隔离，不参与自动升级，
 * 留给复核人员人工判断。
 */
export function conflictKey(finding, evidence) {
  return evidence.topic ? `topic:${evidence.topic}` : `code:${finding.code}`;
}

/** 完整重放指纹：来源、发生时间与内容全部一致才算同一条观察。 */
export function evidenceFingerprint(payload) {
  const findings = [...(payload.findings || [])]
    .map((f) => `${f.code}|${f.polarity}|${f.severity ?? ""}|${f.note ?? ""}`)
    .sort()
    .join(";");
  return [
    payload.source?.type,
    payload.source?.party_id,
    payload.observed_at,
    payload.topic ?? "",
    payload.note ?? "",
    findings,
  ].join("#");
}

/**
 * 从证据集合中隔离冲突发现，细化到 finding 粒度：
 * 同一事件内与冲突无关的发现仍可参与判定。
 * @param {Array<{event_id:string,payload:any}>} evidenceEvents
 * @returns {{active: Array<{event_id:string, finding:any}>, conflicts: Array<{event_id:string, keys:string[]}>}}
 */
export function isolateConflicts(evidenceEvents) {
  const polarityByKey = new Map();
  for (const ev of evidenceEvents) {
    for (const f of ev.payload.findings || []) {
      const key = conflictKey(f, ev.payload);
      const set = polarityByKey.get(key) ?? new Set();
      set.add(f.polarity);
      polarityByKey.set(key, set);
    }
  }
  const conflictedKeys = new Set(
    [...polarityByKey.entries()].filter(([, pol]) => pol.has("POSITIVE") && pol.has("NEGATIVE")).map(([k]) => k),
  );

  const active = [];
  const conflicts = [];
  for (const ev of evidenceEvents) {
    const hitKeys = new Set();
    for (const f of ev.payload.findings || []) {
      const key = conflictKey(f, ev.payload);
      if (conflictedKeys.has(key)) {
        hitKeys.add(key);
      } else {
        active.push({ event_id: ev.event_id, finding: f });
      }
    }
    if (hitKeys.size) conflicts.push({ event_id: ev.event_id, keys: [...hitKeys] });
  }
  return { active, conflicts };
}

/** 单条阳性发现的基础等级。 */
function findingLevel(finding) {
  if (finding.polarity !== "POSITIVE") return "LOW";
  const severity = finding.severity ?? "mild";
  if (severity === "severe") return "HIGH";
  if (severity === "moderate") return CARDIO_CODES.has(finding.code) ? "HIGH" : "MEDIUM";
  return CARDIO_CODES.has(finding.code) ? "MEDIUM" : "LOW";
}

/**
 * 评估一组证据的综合等级（不含停止线判定）。
 * 多个不同症状码达到 MEDIUM 及以上时升至 HIGH。
 */
export function evaluateLevel(evidenceEvents) {
  const { active } = isolateConflicts(evidenceEvents);
  let level = "LOW";
  const escalatedCodes = new Set();
  for (const { finding } of active) {
    const next = findingLevel(finding);
    if (next !== "LOW") escalatedCodes.add(finding.code);
    level = maxLevel(level, next);
  }
  if (level === "MEDIUM" && escalatedCodes.size >= 2) level = "HIGH";
  return level;
}

/**
 * 对照冻结计划中的停止线判定命中。
 * @param {Array<{event_id:string,payload:any}>} evidenceEvents 已去重、可含冲突
 * @param {Array<{code:string,min_severity:string,scope?:object}>} stopLines
 * @returns {Array<{stop_line_code:string,scope:object,evidence_event_ids:string[],note?:string}>}
 */
export function matchStopLines(evidenceEvents, stopLines) {
  const { active } = isolateConflicts(evidenceEvents);
  const activeByEvent = new Map();
  for (const { event_id, finding } of active) {
    if (!activeByEvent.has(event_id)) activeByEvent.set(event_id, []);
    activeByEvent.get(event_id).push(finding);
  }
  const hits = [];
  for (const line of stopLines || []) {
    const threshold = SEVERITY_RANK[line.min_severity] ?? SEVERITY_RANK.mild;
    const ids = [];
    for (const [event_id, findings] of activeByEvent) {
      const matched = findings.some(
        (f) =>
          f.polarity === "POSITIVE" &&
          f.code === line.code &&
          (SEVERITY_RANK[f.severity ?? "mild"] >= threshold),
      );
      if (matched) ids.push(event_id);
    }
    if (ids.length) {
      hits.push({
        stop_line_code: line.code,
        min_severity: line.min_severity,
        scope: line.scope ?? { all_future: true },
        note: line.note,
        evidence_event_ids: ids,
      });
    }
  }
  return hits;
}

/** 在按生效时间排序的计划版本中，找出某事实发生时刻适用的冻结计划。 */
export function planEffectiveAt(plans, at) {
  let chosen = null;
  for (const plan of plans) {
    if (plan.payload.effective_from <= at) chosen = plan;
  }
  return chosen;
}
