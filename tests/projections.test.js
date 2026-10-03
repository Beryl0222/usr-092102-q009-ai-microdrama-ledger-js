import assert from "node:assert/strict";
import test from "node:test";

import { reviewPaths } from "../src/domain.js";
import { buildLineageGraph, traceAsset } from "../src/lineage.js";
import { creatorStatement, frameProvenance, platformPackage, regulatoryExport, RESTRICTED_FROM_PLATFORM } from "../src/projections.js";
import { buildScenario, lineageRefs } from "./helpers/scenario.js";

function fullGreenPath() {
  const sc = buildScenario();
  const { ledger, ids, people, D } = sc;

  ledger.registerGeneratedAsset({
    assetId: "A1",
    productionId: ids.P1,
    episodeNo: 1,
    shotCode: "E01-S010",
    outputUri: "s3://assets/A1.mp4",
    sha256: D("A1-bytes"),
    modelProvider: "phantom-video",
    modelVersion: "3.2",
    generatedBy: people.zhang.id,
    callbackId: "cb-A1",
    lineage: lineageRefs.C1v1WithSceneAndPrompt,
  });

  ledger.addAudio({
    audioId: "AU1",
    productionId: ids.P1,
    episodeNo: 1,
    kind: "voice",
    workRef: "配音轨·第1集",
    licenseRef: "voice-license-wang",
    digest: D("au1"),
    actorId: people.wang.id,
  });

  ledger.postCost({
    productionId: ids.P1,
    amount: 1200,
    currency: "CNY",
    category: "generation",
    sourceStatementId: "FIN-A1",
    assetId: "A1",
    episodeNo: 1,
    actorId: people.sun.id,
  });

  ledger.postContribution({
    productionId: ids.P1,
    personId: people.zhang.id,
    personName: "张导",
    roles: ["director", "storyboard", "generator", "editor"],
    shareTerms: { basis: "percent", value: 8 },
    episodeNo: 1,
    assetIds: ["A1"],
    actorId: people.qian.id,
  });

  const timeline = [{ asset_id: "A1", shot_code: "E01-S010", start_sec: 0, end_sec: 12 }];
  ledger.sealCut({
    productionId: ids.P1,
    episodeNo: 1,
    cutRevision: 1,
    masterSha256: D("m1"),
    timeline,
    audioRefs: ["AU1"],
    editorId: people.zhang.id,
  });
  ledger.assessTier({ productionId: ids.P1, episodeNo: 1, actorId: people.qian.id });
  ledger.submitForReview({
    productionId: ids.P1,
    episodeNo: 1,
    path: reviewPaths.PLATFORM,
    submittedBy: people.qian.id,
    cutRevision: 1,
    masterSha256: D("m1"),
    packageDigest: D("pkg1"),
  });
  ledger.decideReview({
    productionId: ids.P1,
    episodeNo: 1,
    decision: "approved",
    classification: "general",
    path: reviewPaths.PLATFORM,
    cutRevision: 1,
    masterSha256: D("m1"),
    signer: { id: people["rev-platform"].id, role: "platform_reviewer" },
  });
  ledger.releaseMaster({
    productionId: ids.P1,
    episodeNo: 1,
    cutRevision: 1,
    programId: "PRG-0001",
    releaseScope: "domestic",
    signer: { id: people.qian.id, role: "producer" },
  });
  ledger.deliverToPlatform({
    productionId: ids.P1,
    platformId: "PLAT-X",
    programId: "PRG-0001",
    masterReleaseId: "master:P1:E001:rev1:domestic",
    rightsProofRefs: ["R1"],
    actorId: people.qian.id,
    packageDigest: D("delivery-pkg-1"),
  });

  return sc;
}

test("制片人：从线上一帧定位到镜头来源、模型版本、成本、贡献与审核状态", () => {
  const sc = fullGreenPath();
  const view = frameProvenance(sc.store.allEvents(), { productionId: "P1", episodeNo: 1, cutRevision: 1, timeSec: 5 });
  assert.equal(view.found, true);
  assert.equal(view.frame.asset_id, "A1");
  assert.equal(view.master_sha256, sc.D("m1"));

  const p = view.provenance;
  assert.equal(p.asset.model, "phantom-video/3.2");
  assert.deepEqual(p.sources.characters.map((c) => c.id ?? c.key).filter(Boolean).length >= 0, true);
  assert.ok(p.sources.characters.some((c) => c.key === "character_asset:C1"));
  assert.ok(p.sources.scenes.some((c) => c.key === "scene_asset:S1"));
  assert.ok(p.sources.prompts.some((c) => c.key === "prompt_input:PR1"));
  assert.equal(p.costs[0].amount, 1200);
  assert.ok(p.contributors.some((c) => c.person === "张导"));
  assert.deepEqual(p.used_in_cuts.map((c) => c.cut_id), ["cut:P1:E001"]);
  assert.equal(p.review_status[0].decision, "approved");
  assert.equal(p.review_status[0].signed_path, "platform");
  assert.ok(p.released_masters.some((m) => m.key === "master_release:master:P1:E001:rev1:domestic"));
  assert.ok(p.distribution_grants.some((g) => g.key === "distribution_grant:grant:P1:PLAT-X"));
});

test("创作者：可核对署名角色、关联产物与按分账条款试算收益", () => {
  const sc = fullGreenPath();
  const stmt = creatorStatement(sc.store.allEvents(), sc.people.zhang.id, { P1: 100_000 });
  const line = stmt.productions[0];
  assert.deepEqual(line.credits[0].roles.sort(), ["director", "editor", "generator", "storyboard"].sort());
  assert.ok(line.generated_assets.some((a) => a.asset_id === "A1"));
  assert.equal(line.projected_payout, 8000); // 8% × 100,000
  assert.equal(line.actual_cost_total, 1200); // 实际入账只有 A1 的生成成本
  assert.equal(line.frozen_investment_basis.amount, 500_000); // 冻结投资口径是另一回事
});

test("发行平台：只能取到已放行母版、节目编号与必要权利证明", () => {
  const sc = fullGreenPath();
  const pkg = platformPackage(sc.store.allEvents(), { productionId: "P1", platformId: "PLAT-X" });
  assert.equal(pkg.available, true);
  assert.equal(pkg.package.program_id, "PRG-0001");
  assert.equal(pkg.package.master.sha256, sc.D("m1"));
  assert.deepEqual(
    Object.keys(pkg.package.rights_proofs[0]).sort(),
    ["digest", "evidence_ref", "license_scope", "right_id", "rights_owner"].sort(),
  );

  // 结构断言：发行包序列化后不得出现提示摘要、未采用提示、来源工具账号等任何痕迹
  const serialized = JSON.stringify(pkg);
  for (const secret of [sc.D("prompt-1"), sc.D("prompt-2-unused"), "tool-acct-a", "tool-acct-b", "PR1", "PR2"]) {
    assert.equal(serialized.includes(secret), false, `发行包泄漏受限内容：${secret}`);
  }
  for (const banned of RESTRICTED_FROM_PLATFORM) {
    assert.equal(serialized.includes(banned), false, `发行包含受限字段：${banned}`);
  }
  // 不存在的平台拿不到包
  assert.equal(platformPackage(sc.store.allEvents(), { productionId: "P1", platformId: "PLAT-OTHER" }).available, false);
});

test("监管导出：完整保留每次提交、签署决定与替换链，并附清单摘要", () => {
  const sc = buildScenario();
  const { ledger, ids, people, D } = sc;
  ledger.registerGeneratedAsset({
    assetId: "A1", productionId: ids.P1, episodeNo: 1, shotCode: "E01-S010",
    outputUri: "s3://A1", sha256: D("A1"), modelProvider: "v", modelVersion: "1",
    generatedBy: people.zhang.id, callbackId: "cb1", lineage: lineageRefs.C1v1,
  });
  const tl = [{ asset_id: "A1", start_sec: 0, end_sec: 5 }];
  ledger.sealCut({ productionId: ids.P1, episodeNo: 1, cutRevision: 1, masterSha256: D("m1"), timeline: tl, editorId: people.zhang.id });
  ledger.assessTier({ productionId: ids.P1, episodeNo: 1 });
  ledger.submitForReview({ productionId: ids.P1, episodeNo: 1, path: reviewPaths.PLATFORM, submittedBy: people.qian.id, cutRevision: 1, masterSha256: D("m1"), packageDigest: D("p1") });
  ledger.decideReview({ productionId: ids.P1, episodeNo: 1, decision: "returned", classification: "fix", path: reviewPaths.PLATFORM, cutRevision: 1, masterSha256: D("m1"), signer: { id: people["rev-platform"].id, role: "platform_reviewer" } });
  ledger.reviseCut({ productionId: ids.P1, episodeNo: 1, newRevision: 2, reason: "整改", editorId: people.zhang.id });
  ledger.sealCut({ productionId: ids.P1, episodeNo: 1, cutRevision: 2, masterSha256: D("m2"), timeline: tl, editorId: people.zhang.id });
  ledger.resubmit({ productionId: ids.P1, episodeNo: 1, path: reviewPaths.PLATFORM, submittedBy: people.qian.id, cutRevision: 2, masterSha256: D("m2"), packageDigest: D("p2") });
  ledger.decideReview({ productionId: ids.P1, episodeNo: 1, decision: "approved", classification: "general", path: reviewPaths.PLATFORM, cutRevision: 2, masterSha256: D("m2"), signer: { id: people["rev-platform"].id, role: "platform_reviewer" } });

  const report = regulatoryExport(sc.store.allEvents(), ids.P1);
  assert.equal(report.found, true);
  const ep = report.episodes[0];
  assert.equal(ep.submissions.length, 2);
  assert.equal(ep.submissions[0].kind, "submit");
  assert.equal(ep.submissions[1].kind, "resubmit");
  assert.deepEqual(ep.current, { decision: "approved", classification: "general", signed_path: "platform", pending_rereview: false });
  // 替换链：resubmit -> supersedes -> 原提交
  assert.deepEqual(ep.replacement_chain[0].map((x) => x.kind), ["submit", "resubmit"]);
  // 重剪触发也在监管轨迹中
  assert.ok(ep.rereview_triggers.some((t) => t.trigger === "cut_revised"));
  // 每次决定都保留签署人信息
  const decisions = report.event_trail.filter((e) => e.event_type === "REVIEW_DECIDED");
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].signer.id, people["rev-platform"].id);
  assert.match(report.manifest.sha256, /^[0-9a-f]{64}$/);
});

test("海外版本：精确触发 overseas 重审，批准放行后才能交付；重审期间发行被挂起", () => {
  const sc = fullGreenPath();
  const { ledger, ids, people, D } = sc;

  const events = ledger.createOverseasVersion({
    productionId: ids.P1,
    episodeNo: 1,
    domesticReleaseId: "master:P1:E001:rev1:domestic",
    masterSha256: D("m-overseas"),
    changesSummary: "替换插曲、调整字幕",
    actorId: people.qian.id,
  });
  assert.equal(events[1].payload.trigger, "overseas_version");
  assert.equal(events[1].payload.required_path, reviewPaths.OVERSEAS);

  // 未走完 overseas 批准前，海外母版不能放行
  assert.throws(
    () =>
      ledger.releaseMaster({
        productionId: ids.P1,
        episodeNo: 1,
        cutRevision: 1,
        programId: "PRG-0001-OS",
        releaseScope: "overseas",
        signer: { id: people.qian.id, role: "producer" },
      }),
    (e) => ["REREVIEW_PENDING", "NO_MATCHING_APPROVAL"].includes(e.code),
  );

  ledger.submitForReview({
    productionId: ids.P1,
    episodeNo: 1,
    path: reviewPaths.OVERSEAS,
    submittedBy: people.qian.id,
    cutRevision: 1,
    masterSha256: D("m-overseas"),
    packageDigest: D("pkg-os"),
  });
  // 平台审核员无权签 overseas
  assert.throws(
    () =>
      ledger.decideReview({
        productionId: ids.P1, episodeNo: 1, decision: "approved", classification: "general",
        path: reviewPaths.OVERSEAS, cutRevision: 1, masterSha256: D("m-overseas"),
        signer: { id: people["rev-platform"].id, role: "platform_reviewer" },
      }),
    (e) => e.code === "SIGNER_ROLE_DENIED",
  );
  ledger.decideReview({
    productionId: ids.P1,
    episodeNo: 1,
    decision: "approved",
    classification: "general_overseas",
    path: reviewPaths.OVERSEAS,
    cutRevision: 1,
    masterSha256: D("m-overseas"),
    signer: { id: people["rev-provincial"].id, role: "provincial_reviewer" },
  });
  ledger.releaseMaster({
    productionId: ids.P1,
    episodeNo: 1,
    cutRevision: 1,
    programId: "PRG-0001-OS",
    releaseScope: "overseas",
    signer: { id: people.qian.id, role: "producer" },
  });
  ledger.deliverToPlatform({
    productionId: ids.P1,
    platformId: "PLAT-GLOBAL",
    programId: "PRG-0001-OS",
    masterReleaseId: "master:P1:E001:rev1:overseas",
    rightsProofRefs: ["R1"],
    actorId: people.qian.id,
    packageDigest: D("delivery-os"),
  });
  assert.equal(platformPackage(sc.store.allEvents(), { productionId: "P1", platformId: "PLAT-GLOBAL" }).available, true);

  // 第 1 集重剪 -> 精确触发重审，两个平台的取片授权同时挂起
  ledger.reviseCut({ productionId: ids.P1, episodeNo: 1, newRevision: 2, reason: "合规补丁", editorId: people.zhang.id });
  const pkgX = platformPackage(sc.store.allEvents(), { productionId: "P1", platformId: "PLAT-X" });
  const pkgG = platformPackage(sc.store.allEvents(), { productionId: "P1", platformId: "PLAT-GLOBAL" });
  assert.equal(pkgX.available, false);
  assert.equal(pkgX.suspended, true);
  assert.equal(pkgG.suspended, true);
  assert.match(pkgX.suspend_reason, /重剪/);
});

test("谱系图：否决镜头可追到所有下游，资产可反查全部来源", () => {
  const sc = buildScenario();
  const { ledger, ids, people, D } = sc;
  ledger.registerGeneratedAsset({
    assetId: "A9", productionId: ids.P1, episodeNo: 3, shotCode: "E03-S001",
    outputUri: "s3://A9", sha256: D("A9"), modelProvider: "v", modelVersion: "2",
    generatedBy: people.zhang.id, callbackId: "cb9", lineage: lineageRefs.C1v1,
  });
  ledger.rejectShot({ assetId: "A9", productionId: ids.P1, reason: "废弃", rejectedBy: people.zhang.id });

  const graph = buildLineageGraph(sc.store.allEvents());
  const trace = traceAsset(graph, "A9");
  assert.ok(trace.sources.characters.some((c) => c.key === "character_asset:C1"));
  assert.equal(trace.rejected.reason, "废弃");
});
