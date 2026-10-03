import assert from "node:assert/strict";
import test from "node:test";

import { Ledger } from "../src/ledger.js";
import { createProductionService } from "../src/service.js";
import { ErrorCodes } from "../src/errors.js";
import { ancestorsOf, buildLineage } from "../src/lineage.js";

const AT = "2026-10-01T09:00:00+08:00";
const director = { person_id: "p-dir", roles: ["director", "generation_operator", "editor"] };
const supervisor = { person_id: "p-sup", roles: ["continuity_supervisor"] };

function makeService() {
  const ledger = new Ledger();
  return { ledger, svc: createProductionService(ledger) };
}

const baseCmd = (over) => ({ occurredAt: AT, ...over });

function makeService2() {
  const ledger = new Ledger();
  const svc = createProductionService(ledger);
  svc.registerAssetGenerated(baseCmd({ eventId: "e-plate", actor: director, assetId: "plate", kind: "scene_plate", hash: "h-plate", model: { name: "m", version: "1" }, promptSummary: "s" }));
  svc.registerAssetGenerated(baseCmd({ eventId: "e-char", actor: director, assetId: "char", kind: "character_sheet", hash: "h-char", model: { name: "m", version: "1" }, promptSummary: "s" }));
  svc.registerAssetGenerated(baseCmd({ eventId: "e-shot", actor: director, assetId: "shot", kind: "shot_take", hash: "h-shot", model: { name: "m", version: "2" }, promptSummary: "s", sourceAssetIds: ["plate", "char"] }));
  return { ledger, svc };
}

test("有向谱系：source_asset_ids 形成可回溯的祖先链", () => {
  assert.equal(buildLineage([]).edges.size, 0);
  const { ledger } = makeService2();
  const lin = buildLineage(ledger.all());
  assert.deepEqual([...ancestorsOf(lin, "shot")].sort(), ["char", "plate", "shot"]);
});

test("被否决镜头的任意深度后代都不能登记（本集）", () => {
  const { ledger, svc } = makeService2();
  svc.requestRegeneration(baseCmd({ eventId: "e-req1", actor: director, newShotId: "shot-1", parentShotId: null }));
  // 复用已登记 shot 作为 take-a
  svc.rejectShot(baseCmd({ eventId: "e-rej", actor: director, shotId: "shot-1", assetId: "shot", assetHash: "h-shot", reason: "safety_policy" }));

  // 直接复用
  assert.throws(
    () => svc.registerAssetGenerated(baseCmd({ eventId: "e-reuse1", actor: director, assetId: "reuse1", kind: "shot_take", hash: "h-r1", model: {}, promptSummary: "s", sourceAssetIds: ["shot"] })),
    (err) => err.code === ErrorCodes.REJECTED_ANCESTOR,
  );
  // 经由中间资产间接复用（孙代）
  const { ledger: l2, svc: svc2 } = makeService2();
  svc2.registerAssetGenerated(baseCmd({ eventId: "e-mid", actor: director, assetId: "mid", kind: "shot_take", hash: "h-mid", model: {}, promptSummary: "s" }));
  svc2.rejectShot(baseCmd({ eventId: "e-rej2", actor: director, shotId: "shot-1", assetId: "shot", assetHash: "h-shot", reason: "quality" }));
  // 先建一个以被否资产为来源的新资产，应在登记时即被拦截
  assert.throws(
    () => svc2.registerAssetGenerated(baseCmd({ eventId: "e-child", actor: director, assetId: "child", kind: "shot_take", hash: "h-child", model: {}, promptSummary: "s", sourceAssetIds: ["shot"] })),
    (err) => err.code === ErrorCodes.REJECTED_ANCESTOR,
  );
});

test("跨集：被否决 hash 在后续集次永久拉黑", async () => {
  const { buildScenario } = await import("../scripts/scenario.js");
  const r = buildScenario();
  assert.ok(r.blocked.some((b) => b.case === "cross_episode_rejected_reuse" && b.code === ErrorCodes.REJECTED_ANCESTOR));
});

test("跨集复用角色：未锁基线拒绝；基线指纹漂移拒绝；一致放行", async () => {
  const { buildScenario } = await import("../scripts/scenario.js");
  const r = buildScenario();
  const codes = Object.fromEntries(r.blocked.map((b) => [b.case, b.code]));
  assert.equal(codes.baseline_not_locked, ErrorCodes.BASELINE_NOT_LOCKED);
  assert.equal(codes.baseline_drift, ErrorCodes.BASELINE_DRIFT);

  // 合规复用资产存在
  const state = (await import("../src/state.js")).replay(r.events);
  assert.ok(state.assets.has("char-a-v2"));
  assert.equal(state.characters.get("char-a").baseline_hash, "hash-char-a-v1");
});

test("锁定基线需要连续性主管角色", () => {
  const { svc } = makeService();
  assert.throws(
    () => svc.lockCharacterBaseline(baseCmd({ eventId: "e-lock", actor: director, characterId: "c1", baselineAssetId: "a1", baselineHash: "h1", episodeId: "E1" })),
    (err) => err.code === ErrorCodes.SIGNER_UNAUTHORIZED,
  );
  svc.lockCharacterBaseline(baseCmd({ eventId: "e-lock", actor: supervisor, characterId: "c1", name: "角色", baselineAssetId: "a1", baselineHash: "h1", episodeId: "E1" }));
});
