import { validateEvent } from "./validator.js";
import { ErrorCodes, LedgerError } from "./errors.js";

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * 业务指纹：识别“是否同一真实产物”，忽略 event_id/occurred_at/version 等投递层字段。
 * 以事件类型、聚合与负载核心标识（asset_id / content_hash / uri / kind / model）为准。
 */
function businessFingerprint(record) {
  const p = record.payload ?? {};
  const core = {
    asset_id: p.asset_id,
    content_hash: p.content_hash,
    uri: p.uri,
    kind: p.kind,
    model: p.model,
    shot_id: p.shot_id,
    episode_id: p.episode_id,
    entry_id: p.entry_id,
    cost_id: p.cost_id,
    amount: p.amount,
    package_id: p.package_id,
    receiver_id: p.receiver_id,
  };
  return JSON.stringify({
    event_type: record.event_type,
    aggregate_type: record.aggregate_type,
    aggregate_id: record.aggregate_id,
    actor: record.actor?.person_id ?? null,
    payload: core,
  });
}

/**
 * 追加式事件账本：只追加、不修改、不删除。
 *
 * 幂等规则（对应“外部工具回调乱序或重试只登记一次真实产物”）：
 * - event_id 全局唯一：同一 event_id 重复提交且内容一致 → 返回已登记事件（duplicate=true）；
 *   内容不一致 → DUPLICATE_EVENT 冲突。
 * - idempotency_key：同一键只能对应一个 event_id；不同产物冒用同一键 → IDEMPOTENCY_CONFLICT。
 * - version：每个 aggregate_id 流内从 1 起连续；未显式给出时自动分配；
 *   显式给出但与流位置不符 → STREAM_VERSION_CONFLICT（乱序送达不会插队重写历史）。
 */
export class Ledger {
  #events = [];
  #byEventId = new Map();
  #byStream = new Map();
  #byIdempotency = new Map();

  static fromEvents(events) {
    const ledger = new Ledger();
    for (const event of events) ledger.append(event);
    return ledger;
  }

  /**
   * @param {object} record 完整事件（含可选 payload / idempotency_key 等）
   * @param {{expectedVersion?: number}} [opts] 乐观并发：期望流当前长度
   * @returns {{event: object, duplicate: boolean}}
   */
  append(record, opts = {}) {
    const errors = validateEvent(record);
    if (errors.length > 0) {
      throw new LedgerError(ErrorCodes.VALIDATION_FAILED, `事件校验失败：${errors.join("；")}`, { errors });
    }

    // 同一事件重试
    const existing = this.#byEventId.get(record.event_id);
    if (existing) {
      if (deepEqual(existing, record)) return { event: existing, duplicate: true };
      throw new LedgerError(
        ErrorCodes.DUPLICATE_EVENT,
        `event_id ${record.event_id} 已登记为不同内容，禁止覆盖`,
      );
    }

    // 外部回调幂等键：同一键再次送达时，
    // - 业务指纹一致（同一真实产物，只是 event_id 由网关另行分配）→ 返回原事件（duplicate）；
    // - 业务指纹不同（冒用同键登记不同产物）→ 冲突。
    if (record.idempotency_key) {
      const ownerEventId = this.#byIdempotency.get(record.idempotency_key);
      if (ownerEventId && ownerEventId !== record.event_id) {
        const owner = this.#byEventId.get(ownerEventId);
        if (businessFingerprint(owner) === businessFingerprint(record)) {
          return { event: owner, duplicate: true };
        }
        throw new LedgerError(
          ErrorCodes.IDEMPOTENCY_CONFLICT,
          `幂等键 ${record.idempotency_key} 已被不同产物的事件 ${ownerEventId} 占用`,
          { idempotency_key: record.idempotency_key, owner_event_id: ownerEventId },
        );
      }
    }

    const stream = this.#byStream.get(record.aggregate_id) ?? [];
    const nextVersion = stream.length + 1;
    if (record.version !== nextVersion) {
      throw new LedgerError(
        ErrorCodes.STREAM_VERSION_CONFLICT,
        `聚合 ${record.aggregate_id} 下一序号应为 ${nextVersion}，收到 ${record.version}`,
        { expected: nextVersion, actual: record.version },
      );
    }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== stream.length) {
      throw new LedgerError(
        ErrorCodes.STREAM_VERSION_CONFLICT,
        `期望流版本 ${opts.expectedVersion}，实际 ${stream.length}`,
      );
    }

    const stored = Object.freeze(
      record.payload
        ? { ...record, payload: Object.freeze({ ...record.payload }) }
        : { ...record },
    );
    this.#events.push(stored);
    this.#byEventId.set(stored.event_id, stored);
    stream.push(stored);
    this.#byStream.set(record.aggregate_id, stream);
    if (stored.idempotency_key) this.#byIdempotency.set(stored.idempotency_key, stored.event_id);
    return { event: stored, duplicate: false };
  }

  get(eventId) {
    return this.#byEventId.get(eventId) ?? null;
  }

  stream(aggregateId) {
    return (this.#byStream.get(aggregateId) ?? []).map((e) => e);
  }

  streamVersion(aggregateId) {
    return (this.#byStream.get(aggregateId) ?? []).length;
  }

  /** 全部事件，按登记（追加）顺序。 */
  all() {
    return [...this.#events];
  }

  get size() {
    return this.#events.length;
  }
}
