import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  aggregateTypes,
  allAggregateTypes,
  allEventTypes,
  domainEventFields,
  eventCatalog,
  eventTypes,
} from "../src/domain.js";
import { validateEvent, validateEventStrict } from "../src/validator.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

test("样例符合领域约定（既有宽松校验保持可用）", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("建仓时的五个事件与四个聚合在扩展后仍然存在且值不变", () => {
  for (const t of ["ASSET_GENERATED", "CUT_SEALED", "TIER_ASSESSED", "REVIEW_DECIDED", "RELEASE_DELIVERED"]) {
    assert.equal(eventTypes[t], t);
    assert.ok(allEventTypes.includes(t));
    assert.ok(schema.properties.event_type.enum.includes(t));
  }
  for (const a of ["production_asset", "episode_cut", "review_submission", "contribution_entry"]) {
    assert.ok(allAggregateTypes.includes(a));
    assert.ok(schema.properties.aggregate_type.enum.includes(a));
  }
  assert.deepEqual(domainEventFields, ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"]);
  assert.deepEqual(schema.required, domainEventFields);
});

test("事件目录中的每个事件类型与允许聚合都登记在 JSON Schema 枚举内", () => {
  for (const [type, spec] of Object.entries(eventCatalog)) {
    assert.ok(schema.properties.event_type.enum.includes(type), `schema 缺少事件 ${type}`);
    for (const agg of spec.aggregates) {
      assert.ok(schema.properties.aggregate_type.enum.includes(agg), `schema 缺少聚合 ${agg}（${type}）`);
    }
  }
  // 所有非聚合枚举均为合法 schema 值
  for (const agg of Object.values(aggregateTypes)) assert.equal(typeof agg, "string");
});

test("严格校验接受最小合法新事件，拒绝缺 payload 的事件", () => {
  const event = {
    event_id: "e1",
    event_type: eventTypes.PRODUCTION_OPENED,
    aggregate_type: aggregateTypes.PRODUCTION,
    aggregate_id: "P1",
    occurred_at: "2026-10-01T08:00:00+08:00",
    version: 1,
    summary: "开立",
    payload: { title: "t", genre_scope: {}, investment_basis: {} },
  };
  assert.deepEqual(validateEventStrict(event), []);
  assert.ok(validateEventStrict({ ...event, payload: {} }).some((m) => m.includes("缺少字段")));
});

test("旧调用方只给七个信封字段时，宽松校验行为不回归", () => {
  const legacy = {
    event_id: "x",
    event_type: "WHATEVER_THEY_USED",
    aggregate_type: "legacy_thing",
    aggregate_id: "y",
    occurred_at: "not-a-date",
    version: 2,
    summary: "旧系统事件",
  };
  assert.deepEqual(validateEvent(legacy), []);
});
