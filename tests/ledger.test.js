import assert from "node:assert/strict";
import test from "node:test";

import { Ledger } from "../src/ledger.js";
import { ErrorCodes } from "../src/errors.js";
import { validateEvent } from "../src/validator.js";

function ev(over = {}) {
  return {
    event_id: "e-1",
    event_type: "ASSET_GENERATED",
    aggregate_type: "production_asset",
    aggregate_id: "a-1",
    occurred_at: "2026-09-21T09:00:00+08:00",
    version: 1,
    summary: "test",
    ...over,
  };
}

test("流版本从 1 起连续，跳号/复用被拒", () => {
  const ledger = new Ledger();
  ledger.append(ev());
  assert.equal(ledger.streamVersion("a-1"), 1);
  assert.throws(() => ledger.append(ev({ event_id: "e-2", version: 3 })), (err) =>
    err.code === ErrorCodes.STREAM_VERSION_CONFLICT);
  ledger.append(ev({ event_id: "e-2", version: 2 }));
  assert.equal(ledger.size, 2);
});

test("同一 event_id 完全相同的重试返回 duplicate，不增加事件", () => {
  const ledger = new Ledger();
  const r1 = ledger.append(ev());
  const r2 = ledger.append(ev());
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.equal(ledger.size, 1);
});

test("同一 event_id 内容不同视为冲突，禁止覆盖", () => {
  const ledger = new Ledger();
  ledger.append(ev());
  assert.throws(() => ledger.append(ev({ summary: "篡改内容" })), (err) =>
    err.code === ErrorCodes.DUPLICATE_EVENT);
});

test("idempotency_key 只登记一次真实产物：同键同指纹重试去重，同键异产物冲突", () => {
  const ledger = new Ledger();
  const first = ledger.append(ev({
    event_id: "e-1", idempotency_key: "cb-001", version: 1,
    payload: { schema_version: 2, asset_id: "a-1", content_hash: "h-1", kind: "shot_take" },
  }));
  assert.equal(first.duplicate, false);

  // 回调乱序/重试：网关换了 event_id，但指向同一真实产物（同 asset/hash）
  const retry = ledger.append(ev({
    event_id: "e-1-redelivered",
    idempotency_key: "cb-001",
    version: 2,
    occurred_at: "2026-09-21T09:05:00+08:00",
    payload: { schema_version: 2, asset_id: "a-1", content_hash: "h-1", kind: "shot_take" },
  }));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.event.event_id, "e-1");
  assert.equal(ledger.size, 1);

  // 冒用同一幂等键登记另一个产物 → 冲突
  assert.throws(
    () => ledger.append(ev({
      event_id: "e-9",
      idempotency_key: "cb-001",
      version: 2,
      payload: { schema_version: 2, asset_id: "a-1", content_hash: "h-DIFFERENT", kind: "shot_take" },
    })),
    (err) => err.code === ErrorCodes.IDEMPOTENCY_CONFLICT,
  );
  assert.equal(ledger.size, 1);
});

test("乱序送达不会插队：version 不匹配即冲突，历史不可变", () => {
  const ledger = new Ledger();
  ledger.append(ev({ event_id: "e-1", version: 1 }));
  ledger.append(ev({ event_id: "e-2", version: 2 }));
  // 试图用一个更早的版本号插入
  assert.throws(() => ledger.append(ev({ event_id: "e-late", version: 1 })), (err) =>
    err.code === ErrorCodes.STREAM_VERSION_CONFLICT);
});

test("全部事件按追加顺序返回且对象被冻结", () => {
  const ledger = new Ledger();
  const { event } = ledger.append(ev({ payload: { schema_version: 2, k: 1 } }));
  assert.throws(() => { event.summary = "x"; }, TypeError);
  assert.equal(ledger.all()[0].payload.k, 1);
});

test("v1 无 payload 事件可与 v2 事件混合重放且全部通过信封校验", async () => {
  const { buildScenario } = await import("../scripts/scenario.js");
  const { events } = buildScenario();
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `${event.event_id} 未通过信封校验`);
  }
});
