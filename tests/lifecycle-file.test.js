import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { Ledger } from "../src/ledger.js";

test("data/lifecycle.json 可整体载入追加账本，且每条事件通过信封校验", async () => {
  const file = JSON.parse(await readFile(new URL("../data/lifecycle.json", import.meta.url), "utf8"));
  assert.ok(file.events.length > 0);
  assert.equal(file.event_count, file.events.length);

  const ledger = Ledger.fromEvents(file.events);
  assert.equal(ledger.size, file.events.length);

  for (const event of file.events) {
    assert.deepEqual(validateEvent(event), [], `${event.event_id} 校验失败`);
  }

  // 流版本连续性
  const versions = new Map();
  for (const event of file.events) {
    const seen = versions.get(event.aggregate_id) ?? 0;
    assert.equal(event.version, seen + 1, `${event.aggregate_id} 流版本不连续`);
    versions.set(event.aggregate_id, event.version);
  }
});

test("lifecycle.json 记录的违规拦截均为不变量错误码", async () => {
  const file = JSON.parse(await readFile(new URL("../data/lifecycle.json", import.meta.url), "utf8"));
  const codes = file.invariants_blocked.map((b) => b.code);
  assert.deepEqual(codes.sort(), [
    "BASELINE_DRIFT",
    "BASELINE_NOT_LOCKED",
    "NOT_SIGNED",
    "REJECTED_ANCESTOR",
    "REJECTED_ANCESTOR",
  ]);
  assert.equal(file.callback_retry.duplicate, true);
});
