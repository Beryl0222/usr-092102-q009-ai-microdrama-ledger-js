/**
 * 领域事件严格校验。
 *
 * validateEvent 保持建仓时的宽松行为（仅查信封必填与 version 正整数），
 * 既有样例与既有调用方不受影响；新业务代码统一使用 validateEventStrict。
 */

import { allAggregateTypes, allEventTypes, eventCatalog } from "./domain.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/**
 * @returns {string[]} 错误信息数组；空数组表示通过
 */
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  return errors;
}

const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 严格校验：枚举归属、payload 最低键集合、签署要求、谱系边形状。
 * @param {object} record
 * @param {{requireKnownType?: boolean}} [opts]
 */
export function validateEventStrict(record, opts = {}) {
  const errors = validateEvent(record);
  if (errors.length > 0) return errors;

  const { event_type, aggregate_type, occurred_at, payload, lineage, signature, idempotency_key } = record;

  if (!allEventTypes.includes(event_type)) {
    if (opts.requireKnownType !== false) errors.push(`未知事件类型：${event_type}`);
  }
  if (!allAggregateTypes.includes(aggregate_type)) errors.push(`未知聚合类型：${aggregate_type}`);

  if (typeof record.event_id !== "string" || record.event_id.length === 0) errors.push("event_id 必须是非空字符串");
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0)
    errors.push("aggregate_id 必须是非空字符串");
  if (typeof record.summary !== "string" || record.summary.length === 0) errors.push("summary 必须是非空字符串");
  if (!isoDateTime.test(occurred_at)) errors.push("occurred_at 必须是 ISO-8601 date-time");

  if (idempotency_key !== undefined && (typeof idempotency_key !== "string" || idempotency_key.length === 0)) {
    errors.push("idempotency_key 必须是非空字符串");
  }

  const spec = eventCatalog[event_type];
  if (spec) {
    if (!spec.aggregates.includes(aggregate_type)) {
      errors.push(`事件 ${event_type} 不能落到聚合流 ${aggregate_type}（允许：${spec.aggregates.join(" / ")}）`);
    }
    if (payload === undefined || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      errors.push(`事件 ${event_type} 必须携带 payload 对象`);
    } else {
      for (const key of spec.payloadRequired) {
        if (!(key in payload) || payload[key] === undefined || payload[key] === null) {
          errors.push(`事件 ${event_type} 的 payload 缺少字段：${key}`);
        }
      }
    }
    if (spec.requiresSignature && !signature) {
      errors.push(`事件 ${event_type} 必须由有权人员签署（signature）`);
    }
  }

  if (lineage !== undefined) {
    if (!Array.isArray(lineage)) {
      errors.push("lineage 必须是数组");
    } else {
      lineage.forEach((ref, i) => {
        if (!ref || typeof ref !== "object") {
          errors.push(`lineage[${i}] 必须是对象`);
          return;
        }
        if (!allAggregateTypes.includes(ref.aggregate_type)) errors.push(`lineage[${i}].aggregate_type 未知`);
        if (typeof ref.aggregate_id !== "string" || ref.aggregate_id.length === 0)
          errors.push(`lineage[${i}].aggregate_id 必须非空`);
        if (!Number.isInteger(ref.version) || ref.version < 1) errors.push(`lineage[${i}].version 必须是正整数`);
      });
    }
  }

  if (signature !== undefined) errors.push(...validateSignature(signature));

  return errors;
}

export function validateSignature(signature) {
  const errors = [];
  if (!signature || typeof signature !== "object") return ["signature 必须是对象"];
  for (const key of ["signer_id", "signer_role", "algorithm", "value", "signed_at"]) {
    if (!(key in signature)) errors.push(`signature 缺少字段：${key}`);
  }
  if (signature.algorithm !== undefined && signature.algorithm !== "HS256")
    errors.push("signature.algorithm 目前仅支持 HS256");
  if (typeof signature.value === "string" && !/^[0-9a-f]{64}$/.test(signature.value))
    errors.push("signature.value 必须是 64 位十六进制 HMAC-SHA256 摘要");
  if (signature.signed_at !== undefined && !isoDateTime.test(signature.signed_at))
    errors.push("signature.signed_at 必须是 ISO-8601 date-time");
  return errors;
}
