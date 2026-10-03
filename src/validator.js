import { aggregateOf, EVENT_TYPES, AGGREGATE_TYPES, SIGNABLE_EVENTS } from "./domain.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 校验领域事件信封。保持 v1 行为：返回错误字符串数组，[] 表示通过；
 * v1 样例（无 payload）依然合法。
 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("occurred_at" in record && !ISO_DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是带时区的 ISO-8601 日期时间");
  }
  if ("event_type" in record) {
    if (!EVENT_TYPES.includes(record.event_type)) {
      errors.push(`未知 event_type：${record.event_type}`);
    } else if ("aggregate_type" in record) {
      const expected = aggregateOf(record.event_type);
      if (!AGGREGATE_TYPES.includes(record.aggregate_type)) {
        errors.push(`未知 aggregate_type：${record.aggregate_type}`);
      } else if (record.aggregate_type !== expected) {
        errors.push(
          `${record.event_type} 的聚合必须是 ${expected}，实际为 ${record.aggregate_type}`,
        );
      }
    }
  } else if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知 aggregate_type：${record.aggregate_type}`);
  }

  if (SIGNABLE_EVENTS.includes(record.event_type) && !record.actor?.person_id) {
    errors.push(`${record.event_type} 必须由有权人员 actor.person_id 签署`);
  }
  if ("idempotency_key" in record && (typeof record.idempotency_key !== "string" || !record.idempotency_key)) {
    errors.push("idempotency_key 必须是非空字符串");
  }
  return errors;
}
