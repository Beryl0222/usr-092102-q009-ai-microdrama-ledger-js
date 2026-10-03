import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AGGREGATE_TYPES,
  EVENT_TYPES,
  LEGACY_AGGREGATE_TYPES,
  LEGACY_EVENT_TYPES,
  aggregateOf,
} from "../src/domain.js";
import { validateEvent } from "../src/validator.js";

test("v1 样例仍符合领域约定（旧信封无 payload）", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("v1 事件与聚合枚举原序保留，新枚举只能追加", () => {
  assert.deepEqual(
    LEGACY_EVENT_TYPES,
    ["ASSET_GENERATED", "CUT_SEALED", "TIER_ASSESSED", "REVIEW_DECIDED", "RELEASE_DELIVERED"],
  );
  assert.deepEqual(LEGACY_AGGREGATE_TYPES, [
    "production_asset",
    "episode_cut",
    "review_submission",
    "contribution_entry",
  ]);
  assert.ok(EVENT_TYPES.indexOf("RELEASE_ACCESS_GRANTED") > LEGACY_EVENT_TYPES.length - 1);
});

test("JSON Schema 枚举与代码词汇表保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.event_type.enum, EVENT_TYPES);
  assert.deepEqual(schema.properties.aggregate_type.enum, AGGREGATE_TYPES);
});

test("每个事件类型绑定唯一且存在的聚合", () => {
  for (const type of EVENT_TYPES) {
    assert.ok(AGGREGATE_TYPES.includes(aggregateOf(type)), `${type} 绑定了未知聚合`);
  }
});

test("校验：时间格式、错误聚合绑定、签署事件必须有 actor", () => {
  assert.ok(validateEvent({
    event_id: "x", event_type: "ASSET_GENERATED", aggregate_type: "shot",
    aggregate_id: "a", occurred_at: "2026-09-21T09:00:00+08:00", version: 1, summary: "s",
  }).some((e) => e.includes("聚合必须是 production_asset")));

  const signErrors = validateEvent({
    event_id: "y", event_type: "REVIEW_DECIDED", aggregate_type: "review_submission",
    aggregate_id: "rs-1", occurred_at: "2026-09-21T09:00:00+08:00", version: 1, summary: "s",
  });
  assert.ok(signErrors.some((e) => e.includes("必须由有权人员")));

  assert.ok(validateEvent({
    event_id: "z", event_type: "ASSET_GENERATED", aggregate_type: "production_asset",
    aggregate_id: "a", occurred_at: "2026-09-21 09:00:00", version: 1, summary: "s",
  }).some((e) => e.includes("ISO-8601")));

  assert.deepEqual(validateEvent({
    event_id: "z", event_type: "REVIEW_APPROVED", aggregate_type: "episode_review",
    aggregate_id: "ep-1", occurred_at: "2026-09-21T09:00:00+08:00", version: 1, summary: "s",
    actor: { person_id: "p-1" },
  }), []);
});
