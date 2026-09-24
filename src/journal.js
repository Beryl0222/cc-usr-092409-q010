/**
 * JSONL 事件日志：把 RiskRelay 的事件持久化为每行一条 JSON。
 * 服务重启时从日志重放投影，并继续待复核、到期观察与未确认通知。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { RiskRelay } from "./risk-handoff.js";

export class JournaledRiskRelay extends RiskRelay {
  /**
   * @param {string} filePath
   * @param {{now?: () => string, idPrefix?: string}} options
   */
  constructor(filePath, options = {}) {
    super(options);
    this._file = filePath;
    if (filePath && existsSync(filePath)) {
      const lines = readFileSync(filePath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      this.restore(lines);
    }
  }

  append(event) {
    const existed = this._seenIds.has(event.event_id);
    const result = super.append(event);
    if (!existed && this._file) {
      appendFileSync(this._file, `${JSON.stringify(event)}\n`);
    }
    return result;
  }

  /**
   * 中断恢复摘要：继续待复核案件、到期观察和未确认通知。
   * 自动化事件本身已固化在日志中，恢复只做投影重建与待办列举，不会重复暂停或重复通知。
   */
  resume(now = this._now()) {
    return {
      resumed_at: now,
      replayed_events: this.events.length,
      pending_reviews: this.pendingReviews(now),
      due_observations: this.dueObservations(now),
      unacked_notifications: this.unackedNotifications(now),
    };
  }
}
