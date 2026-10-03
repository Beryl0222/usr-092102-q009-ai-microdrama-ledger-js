import { randomUUID } from "node:crypto";

import { validateEventStrict } from "./validator.js";

/**
 * 只追加（append-only）的领域事件存储。
 *
 * 关键语义：
 * - 每个聚合流（aggregate_type + aggregate_id）独立维护从 1 开始严格递增的 version；
 * - expectedVersion 提供乐观并发控制，防止两人同时改同一聚合；
 * - idempotency_key 在全总账范围内去重：外部工具回调乱序到达或重复重试，
 *   同一把钥匙只会登记一条事件，重复投递原样返回已登记事件；
 * - 存储不回放、不就地修改事件（替换历史通过 REVIEW_RESUBMITTED 等新事件表达）。
 */

export class ConcurrencyError extends Error {
  constructor(streamId, expected, actual) {
    super(`流 ${streamId} 版本冲突：期望 ${expected}，实际 ${actual}`);
    this.code = "CONCURRENCY_CONFLICT";
    this.expected = expected;
    this.actual = actual;
  }
}

export class ValidationError extends Error {
  constructor(errors) {
    super(`事件校验失败：${errors.join("；")}`);
    this.code = "VALIDATION_FAILED";
    this.errors = errors;
  }
}

export function streamIdOf(event) {
  return `${event.aggregate_type}:${event.aggregate_id}`;
}

export class EventStore {
  constructor({ now = () => new Date().toISOString(), strict = true } = {}) {
    this.#now = now;
    this.#strict = strict;
    /** @type {object[]} */
    this.#events = [];
    /** @type {Map<string, number>} streamId -> 已登记事件数（= 当前版本） */
    this.#streamVersions = new Map();
    /** @type {Map<string, string>} idempotency_key -> event_id（全总账唯一） */
    this.#idempotency = new Map();
    /** @type {Set<string>} 已占用 event_id */
    this.#eventIds = new Set();
    /** @type {Set<(event: object, meta: object) => void>} */
    this.#listeners = new Set();
  }

  #now;
  #strict;
  #events;
  #streamVersions;
  #idempotency;
  #eventIds;
  #listeners;

  /**
   * 预分配下一条事件的版本号/事件 id/发生时刻，但不写入。
   * 供“先签署、后落库”的决定类事件使用：签署必须绑定最终版本与事件 id。
   * 注意：prepare 与 append 之间若有其他写入，append 会以版本冲突失败。
   */
  prepare(draft) {
    const streamId = `${draft.aggregate_type}:${draft.aggregate_id}`;
    const version = (this.#streamVersions.get(streamId) ?? 0) + 1;
    return {
      ...draft,
      event_id: draft.event_id ?? `${streamId}#${version}-${randomUUID().slice(0, 8)}`,
      occurred_at: draft.occurred_at ?? this.#now(),
      version,
    };
  }

  /**
   * 追加一条事件。
   * @param {object} draft 事件草稿（version 由存储分配；event_id/occurred_at 缺省自动生成）
   * @param {{expectedVersion?: number}} [opts]
   * @returns {{event: object, duplicate: boolean}}
   */
  append(draft, opts = {}) {
    if (!draft || typeof draft !== "object") throw new ValidationError(["事件草稿必须是对象"]);

    if (draft.idempotency_key) {
      const existingId = this.#idempotency.get(draft.idempotency_key);
      if (existingId) {
        const existing = this.#events.find((e) => e.event_id === existingId);
        return { event: existing, duplicate: true };
      }
    }

    const streamId = `${draft.aggregate_type}:${draft.aggregate_id}`;
    const currentVersion = this.#streamVersions.get(streamId) ?? 0;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== currentVersion) {
      throw new ConcurrencyError(streamId, opts.expectedVersion, currentVersion);
    }
    // 版本号原则上由存储分配；命令层在签署前需要预知版本时可显式传入，
    // 但必须恰好等于下一个版本，防止调用方跳号或重放旧号。
    const version = draft.version ?? currentVersion + 1;
    if (version !== currentVersion + 1) {
      throw new ConcurrencyError(streamId, currentVersion, currentVersion);
    }

    const event = {
      event_id: draft.event_id ?? `${streamId}#${version}-${randomUUID().slice(0, 8)}`,
      event_type: draft.event_type,
      aggregate_type: draft.aggregate_type,
      aggregate_id: draft.aggregate_id,
      occurred_at: draft.occurred_at ?? this.#now(),
      version,
      summary: draft.summary,
      ...(draft.idempotency_key ? { idempotency_key: draft.idempotency_key } : {}),
      ...(draft.correlation_id ? { correlation_id: draft.correlation_id } : {}),
      ...(draft.causation_id ? { causation_id: draft.causation_id } : {}),
      ...(draft.actor_id ? { actor_id: draft.actor_id } : {}),
      ...(draft.lineage ? { lineage: draft.lineage } : {}),
      ...(draft.signature ? { signature: draft.signature } : {}),
      payload: draft.payload ?? {},
    };

    if (this.#eventIds.has(event.event_id)) throw new ValidationError([`event_id 重复：${event.event_id}`]);

    if (this.#strict) {
      const errors = validateEventStrict(event);
      if (errors.length > 0) throw new ValidationError(errors);
    }

    this.#events.push(event);
    this.#streamVersions.set(streamId, version);
    this.#eventIds.add(event.event_id);
    if (event.idempotency_key) this.#idempotency.set(event.idempotency_key, event.event_id);

    for (const listener of this.#listeners) listener(event, { duplicate: false });
    return { event, duplicate: false };
  }

  /** 订阅此后追加的事件（重复投递不会二次通知）。返回退订函数。 */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** @returns {object[]} 全量事件（按登记顺序，只读副本） */
  allEvents() {
    return this.#events.map((e) => structuredClone(e));
  }

  stream(aggregateType, aggregateId) {
    const prefix = `${aggregateType}:`;
    const key = aggregateId.startsWith(prefix) ? aggregateId : `${aggregateType}:${aggregateId}`;
    return this.#events.filter((e) => streamIdOf(e) === key).map((e) => structuredClone(e));
  }

  versionOf(aggregateType, aggregateId) {
    return this.#streamVersions.get(`${aggregateType}:${aggregateId}`) ?? 0;
  }

  /** 从历史快照装载（重建索引；不校验顺序，供仓储启动回放使用）。 */
  load(events) {
    for (const event of events) {
      if (this.#eventIds.has(event.event_id)) continue;
      if (event.idempotency_key && this.#idempotency.has(event.idempotency_key)) continue;
      this.#events.push(structuredClone(event));
      const streamId = streamIdOf(event);
      this.#streamVersions.set(streamId, Math.max(this.#streamVersions.get(streamId) ?? 0, event.version));
      this.#eventIds.add(event.event_id);
      if (event.idempotency_key) this.#idempotency.set(event.idempotency_key, event.event_id);
    }
  }

  toJSON() {
    return this.#events.map((e) => structuredClone(e));
  }
}
