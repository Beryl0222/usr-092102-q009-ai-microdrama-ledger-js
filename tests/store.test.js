import assert from "node:assert/strict";
import test from "node:test";

import { EventStore, ConcurrencyError, ValidationError } from "../src/store.js";
import { aggregateTypes as AT, eventTypes as ET } from "../src/domain.js";

const baseDraft = (overrides = {}) => ({
  event_type: ET.ASSET_GENERATED,
  aggregate_type: AT.PRODUCTION_ASSET,
  aggregate_id: "A1",
  summary: "测试产物",
  payload: {
    production_id: "P1",
    output_uri: "s3://x/a.bin",
    sha256: "a".repeat(64),
    model_provider: "vendor",
    model_version: "v1",
  },
  ...overrides,
});

test("流内版本从 1 严格递增，跨流互不影响", () => {
  const store = new EventStore();
  const e1 = store.append(baseDraft()).event;
  const e2 = store.append(baseDraft()).event;
  const e3 = store.append(baseDraft({ aggregate_id: "A2" })).event;
  assert.equal(e1.version, 1);
  assert.equal(e2.version, 2);
  assert.equal(e3.version, 1);
  assert.deepEqual(store.stream(AT.PRODUCTION_ASSET, "A1").map((e) => e.version), [1, 2]);
});

test("expectedVersion 乐观并发：过期版本号被拒绝", () => {
  const store = new EventStore();
  store.append(baseDraft());
  assert.throws(() => store.append(baseDraft(), { expectedVersion: 0 }), ConcurrencyError);
  // 正确的期望版本通过
  assert.equal(store.append(baseDraft(), { expectedVersion: 1 }).event.version, 2);
});

test("同一幂等键的重试只登记一次，并原样返回首条事件", () => {
  const store = new EventStore();
  const first = store.append(baseDraft({ idempotency_key: "callback:cb-9" }));
  const second = store.append(
    baseDraft({ idempotency_key: "callback:cb-9", payload: { ...baseDraft().payload, output_uri: "s3://x/RETRY.bin" } }),
  );
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.event.event_id, first.event.event_id);
  assert.equal(second.event.payload.output_uri, "s3://x/a.bin"); // 以先到登记为准
  assert.equal(store.allEvents().length, 1);
});

test("乱序回调：后到的重复投递不会覆盖先登记的真实产物", () => {
  const store = new EventStore();
  // 模拟工具先返回“重试包”，再返回“首发包”——同键，只认第一条
  store.append(baseDraft({ idempotency_key: "callback:cb-1", summary: "先到的一条" }));
  const again = store.append(baseDraft({ idempotency_key: "callback:cb-1", summary: "逻辑上更早但网络后到" }));
  assert.equal(again.duplicate, true);
  assert.equal(store.allEvents().length, 1);
  assert.equal(store.allEvents()[0].summary, "先到的一条");
});

test("严格校验拒绝未知事件类型与缺失 payload 键", () => {
  const store = new EventStore();
  assert.throws(
    () => store.append(baseDraft({ event_type: "NOT_A_REAL_EVENT" })),
    (err) => err instanceof ValidationError,
  );
  assert.throws(
    () => store.append(baseDraft({ payload: { production_id: "P1" } })),
    /payload 缺少字段/,
  );
});

test("订阅者只在真实新增时收到通知，重复投递不通知", () => {
  const store = new EventStore();
  const seen = [];
  store.subscribe((e) => seen.push(e.event_id));
  const a = store.append(baseDraft({ idempotency_key: "k" })).event;
  store.append(baseDraft({ idempotency_key: "k" }));
  assert.deepEqual(seen, [a.event_id]);
});

test("历史回放后索引可重建（version 与幂等键恢复）", () => {
  const store = new EventStore();
  store.append(baseDraft());
  const dump = store.toJSON();
  const rebuilt = new EventStore();
  rebuilt.load(dump);
  assert.equal(rebuilt.versionOf(AT.PRODUCTION_ASSET, "A1"), 1);
  assert.equal(rebuilt.append(baseDraft({ idempotency_key: "callback:cb-9" })).duplicate, false);
});
