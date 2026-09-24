import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { validateEvent } from "./validator.js";

/**
 * 事件存储：只追加、不可改写。
 * 参与者以 participantId 隔离，事件流可整体重放以还原状态，
 * 因此服务进程中断后重新读取即可继续待办，不依赖内存状态。
 */
export class InMemoryEventStore {
  constructor() {
    /** @type {Map<string, object[]>} */
    this.streams = new Map();
  }

  append(participantId, event) {
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`事件校验失败：${errors.join("；")}`);
    const list = this.streams.get(participantId) ?? [];
    list.push(event);
    this.streams.set(participantId, list);
    return event;
  }

  read(participantId) {
    return [...(this.streams.get(participantId) ?? [])];
  }

  participants() {
    return [...this.streams.keys()];
  }
}

/**
 * JSONL 文件存储：每个参与者一个 <dir>/<participantId>.events.jsonl。
 * 每行一个完整事件 JSON；读取时容忍末尾半个写入行（原子追加下不应出现）。
 */
export class FileEventStore {
  constructor(dir) {
    this.dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  #path(participantId) {
    if (!/^[A-Za-z0-9_\-.]+$/.test(participantId)) throw new Error("participantId 仅允许字母数字 . _ -");
    return join(this.dir, `${participantId}.events.jsonl`);
  }

  append(participantId, event) {
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`事件校验失败：${errors.join("；")}`);
    appendFileSync(this.#path(participantId), `${JSON.stringify(event)}\n`);
    return event;
  }

  read(participantId) {
    const file = this.#path(participantId);
    if (!existsSync(file)) return [];
    const events = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // 末尾不完整行：跳过，等待写入方的完整版本
      }
    }
    return events;
  }

  participants() {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".events.jsonl"))
      .map((name) => name.slice(0, -".events.jsonl".length));
  }
}
