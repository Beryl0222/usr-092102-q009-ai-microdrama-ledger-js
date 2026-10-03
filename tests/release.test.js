import assert from "node:assert/strict";
import test from "node:test";

import { Ledger } from "../src/ledger.js";
import { createProductionService } from "../src/service.js";
import { ErrorCodes } from "../src/errors.js";
import { releaseView, assertMasterReleasable } from "../src/release.js";
import { contributorStatement, productionOverview, regulatorDossier } from "../src/projections.js";
import { traceFrame } from "../src/lineage.js";

let scenario;
test.before(async () => {
  const { buildScenario } = await import("../scripts/scenario.js");
  scenario = buildScenario();
});

test("发行视图只含母版/节目编号/权利证明，无提示词、个人素材、废镜头、成本与人员明细", () => {
  const view = releaseView(scenario.events, "pkg-ep01-domestic");
  assert.equal(view.program_id, "PRG-CD-01");
  assert.equal(view.master.hash, "hash-master-ep01-v2");
  assert.deepEqual(Object.keys(view).sort(), ["deliveries", "episode_id", "master", "package_id", "program_id", "rights_proofs"]);

  const json = JSON.stringify(view);
  for (const secret of ["prompt", "未采用", "ref-lin-face", "take-a", "personal", "revenue_share", "p-lin", "成本", "8000"]) {
    assert.ok(!json.includes(secret), `发行视图泄露：${secret}`);
  }
  // 权利证明只给核验字段，无底稿
  const proof = view.rights_proofs[0];
  assert.deepEqual(Object.keys(proof).sort(), ["doc_hash", "expires_at", "license_scope", "script_id", "territories"]);
});

test("只有审核通过的当前母版可放行；重剪后旧批准不能放行新母版", () => {
  const { ledger, svc } = miniApprovedEpisode();
  // 通过后可校验
  const events = ledger.all();
  assert.doesNotThrow(() => assertMasterReleasable(events, { episodeId: "E1", master: { hash: "m1", uri: "u1" }, assetIds: ["a1"] }));

  // 替换为 m2 后，m2 未过审
  svc.replaceMaster({ eventId: "e-repl", occurredAt: "2026-10-01T09:06:00+08:00", actor: { person_id: "p-dir", roles: ["director", "editor"] }, episodeId: "E1", master: { hash: "m2", uri: "u2" } });
  const officer = { person_id: "p-off", roles: ["classification_officer"] };
  // 触发重审→重签→重送审前，放行新母版必须失败
  svc.signClassification({ eventId: "e-sig2", occurredAt: "2026-10-01T09:07:00+08:00", actor: officer, episodeId: "E1", path: "platform_self_review" });
  // 未重新提交并通过，approve 状态缺失
  assert.throws(
    () => svc.publishReleasePackage({ eventId: "e-pkg-bad", occurredAt: "2026-10-01T09:08:00+08:00", actor: { person_id: "p-rel", roles: ["release_manager"] }, packageId: "pkg-x", programId: "P1", episodeId: "E1" }),
    (e) => e.code === ErrorCodes.NOT_SIGNED,
  );
});

function miniApprovedEpisode() {
  const ledger = new Ledger();
  const svc = createProductionService(ledger);
  const producer = { person_id: "p-prod", roles: ["producer"] };
  const officer = { person_id: "p-off", roles: ["classification_officer"] };
  const authority = { person_id: "p-auth", roles: ["review_authority"] };
  const director = { person_id: "p-dir", roles: ["director", "editor"] };
  const T = (m) => `2026-10-01T09:${String(m).padStart(2, "0")}:00+08:00`;
  svc.freezeScope({ eventId: "e-frz", occurredAt: T(0), actor: producer, episodeId: "E1", programId: "P1", genre: "other", investmentAmount: 800_000 });
  svc.registerAssetGenerated({ eventId: "e-a1", occurredAt: T(1), actor: director, assetId: "a1", kind: "shot_take", hash: "h1", model: {}, promptSummary: "s" });
  svc.sealCut({ eventId: "e-cut", occurredAt: T(2), actor: director, episodeId: "E1", assetIds: ["a1"], master: { hash: "m1", uri: "u1" } });
  svc.signClassification({ eventId: "e-sig", occurredAt: T(3), actor: officer, episodeId: "E1", path: "platform_self_review" });
  svc.submitForReview({ eventId: "e-sub", occurredAt: T(4), actor: producer, episodeId: "E1" });
  svc.approveReview({ eventId: "e-app", occurredAt: T(5), actor: authority, episodeId: "E1" });
  return { ledger, svc };
}

test("创作者分账对账单：角色、分成基点、贡献资产是否进入已放行母版", () => {
  const lin = contributorStatement(scenario.events, "p-lin", "EP01");
  assert.equal(lin.total_revenue_share_bps, 400);
  assert.ok(lin.entries[0].roles.includes("director"));
  // take-b 是封版 take-b2 的直接来源；char/plate 沿谱系也是成片来源，均计入
  assert.deepEqual(lin.entries[0].assets_in_cut.sort(), ["char-a-v1", "ep01-take-b", "plate-street-01"]);
  assert.equal(lin.entries[0].master_released, true);
});

test("帧溯源：从线上一帧回溯模型版本、提示摘要、人工修订、配音、成本、贡献、审核状态", () => {
  const trace = traceFrame(scenario.ledger, { contentHash: "hash-take-b2", episodeId: "EP01" });
  assert.equal(trace.root_asset, "ep01-take-b2");
  const models = trace.lineage_chain.map((c) => c.model?.version).filter(Boolean);
  assert.ok(models.includes("v12.1"));
  assert.ok(trace.lineage_chain.some((c) => typeof c.prompt_summary === "string"));
  assert.equal(trace.manual_revisions.length, 1);
  assert.equal(trace.manual_revisions[0].editor_id, "p-lin");
  assert.ok(trace.voice_music.some((a) => a.kind === "voice"));
  assert.ok(trace.voice_music.some((a) => a.kind === "music"));
  assert.ok(trace.costs.some((c) => c.category === "manual_revision"));
  assert.ok(trace.contributions.some((c) => c.person_id === "p-lin"));
  assert.equal(trace.review_status.status, "approved");
  // 溯源中不暴露个人素材内容本身，但保留链上引用关系（内部视角）
  assert.ok(trace.lineage_chain.some((c) => c.asset_id === "ref-lin-face-01"));
});

test("监管卷宗：每次提交/退回/替换完整历史，一条不删", () => {
  const dossier = regulatorDossier(scenario.events, "EP01");
  assert.equal(dossier.review.submissions.length, 2);
  assert.equal(dossier.review.submissions[0].decision, "returned");
  assert.equal(dossier.review.submissions[1].decision, "approved");
  assert.ok(dossier.review.reassessments.length >= 1);
  assert.equal(dossier.master_versions.length, 2); // 封版 v1 + 封版 v2
  // 口径修订留痕（80万→320万→325万）
  assert.equal(dossier.frozen_scope.amendments.length, 2);
  // 时间线包含关键事件且可核验 event_id（两次提交均完整留痕）
  const types = dossier.timeline.map((e) => e.event_type);
  for (const need of ["CUT_SEALED", "REVIEW_SUBMITTED", "REVIEW_RETURNED", "REVIEW_APPROVED", "PRODUCTION_SCOPE_AMENDED", "COST_LEDGERED"]) {
    assert.ok(types.includes(need), `监管时间线缺少 ${need}`);
  }
  // 每次提交都带轮次与决定（含第一轮退回、第二轮通过）
  assert.equal(dossier.review.submissions[0].round, 1);
  assert.equal(dossier.review.submissions[1].round, 2);
});

test("总览：两集制作状态、否决 hash 拉黑清单可查", () => {
  const overview = productionOverview(scenario.events);
  assert.equal(overview.counts.episodes_scoped, 2);
  const ep01 = overview.episodes.find((e) => e.episode_id === "EP01");
  assert.equal(ep01.review_status, "approved");
  assert.ok(overview.rejected_hashes.includes("hash-take-a-bad"));
});
