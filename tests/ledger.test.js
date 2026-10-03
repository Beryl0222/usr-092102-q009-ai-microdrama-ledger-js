import assert from "node:assert/strict";
import test from "node:test";

import { ProductionLedger, LedgerError } from "../src/ledger.js";
import { EventStore } from "../src/store.js";
import { suggestReviewPath, detectTierCrossing, evaluateRereviewTriggers } from "../src/policy.js";
import { reviewPaths } from "../src/domain.js";
import { buildScenario, lineageRefs } from "./helpers/scenario.js";

const assetCmd = ({ ledger, ids, people, D }, overrides = {}) => ({
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
  ...overrides,
});

const timelineOf = (D, overrides = {}) => [
  { asset_id: "A1", shot_code: "E01-S010", start_sec: 0, end_sec: 12 },
  overrides.extra ?? null,
].filter(Boolean);

// -- 外部工具回调：真实产物只登记一次 ----------------------------------------

test("生成回调重试/乱序：同一 callbackId 只产生一条 ASSET_GENERATED", () => {
  const sc = buildScenario();
  const first = sc.ledger.registerGeneratedAsset(assetCmd(sc));
  const again = sc.ledger.registerGeneratedAsset(assetCmd(sc, { outputUri: "s3://assets/RETRY.mp4", sha256: sc.D("A1-bytes") }));
  assert.equal(again.event_id, first.event_id);
  assert.equal(sc.store.allEvents().filter((e) => e.event_type === "ASSET_GENERATED").length, 1);
});

// -- 否决镜头：id 与内容摘要双键，永不复活 -----------------------------------

test("被否决镜头不能以新身份重新登记，也不能被人工修订复活", () => {
  const sc = buildScenario();
  sc.ledger.registerGeneratedAsset(assetCmd(sc, { assetId: "A3", shotCode: "E01-S020", callbackId: "cb-A3", sha256: sc.D("A3-bytes") }));
  sc.ledger.rejectShot({ assetId: "A3", productionId: sc.ids.P1, reason: "穿帮镜头", rejectedBy: sc.people.zhang.id });

  // 直接用同 id
  assert.throws(
    () => sc.ledger.registerGeneratedAsset(assetCmd(sc, { assetId: "A3", callbackId: "cb-A3-retry" })),
    (e) => e.code === "ASSET_REJECTED",
  );
  // 换 id、换 callback，但内容摘要相同（同一镜头改头换面）
  assert.throws(
    () =>
      sc.ledger.registerGeneratedAsset(
        assetCmd(sc, { assetId: "A4", shotCode: "E02-S005", episodeNo: 2, callbackId: "cb-A4", sha256: sc.D("A3-bytes") }),
      ),
    (e) => e.code === "ASSET_REJECTED_DIGEST",
  );
  // 人工修订被否决对象也被拒
  assert.throws(
    () =>
      sc.ledger.recordHumanRevision({
        assetId: "A5",
        productionId: sc.ids.P1,
        revisionOf: "A3",
        editorId: sc.people.zhang.id,
        outputUri: "s3://assets/A5.mp4",
        sha256: sc.D("A5"),
      }),
    (e) => e.code === "ASSET_REJECTED",
  );
});

test("被否决镜头混入后继集次时间轴时，封版被拒绝", () => {
  const sc = buildScenario();
  sc.ledger.registerGeneratedAsset(assetCmd(sc));
  sc.ledger.registerGeneratedAsset(
    assetCmd(sc, { assetId: "A3", shotCode: "E02-S001", episodeNo: 2, callbackId: "cb-A3", sha256: sc.D("A3") }),
  );
  sc.ledger.rejectShot({ assetId: "A3", productionId: sc.ids.P1, reason: "导演否决", rejectedBy: sc.people.zhang.id });

  assert.throws(
    () =>
      sc.ledger.sealCut({
        productionId: sc.ids.P1,
        episodeNo: 2,
        cutRevision: 1,
        masterSha256: sc.D("master-E02"),
        timeline: [{ asset_id: "A3", shot_code: "E02-S001", start_sec: 0, end_sec: 8 }],
        editorId: sc.people.zhang.id,
      }),
    (e) => e.code === "ASSET_REJECTED",
  );
});

// -- 连续性基线 -------------------------------------------------------------

test("跨集复用角色必须命中锁定基线：C2 漂移到 v2 的生成被拒绝", () => {
  const sc = buildScenario();
  // C1 v1 命中基线 B1 → 通过
  sc.ledger.registerGeneratedAsset(assetCmd(sc));
  // C2 已在基线锁定后更新为 v2，引用 v2 违反 B2
  assert.throws(
    () =>
      sc.ledger.registerGeneratedAsset(
        assetCmd(sc, {
          assetId: "A2",
          shotCode: "E01-S011",
          callbackId: "cb-A2",
          sha256: sc.D("A2"),
          lineage: [{ aggregate_type: "character_asset", aggregate_id: "C2", version: 2 }],
        }),
      ),
    (e) => e.code === "CONTINUITY_VIOLATION",
  );
  // 仍引用基线版本 v1 → 通过（即使资产已演进，复用必须钉在基线上）
  assert.doesNotThrow(() =>
    sc.ledger.registerGeneratedAsset(
      assetCmd(sc, {
        assetId: "A2b",
        shotCode: "E01-S012",
        callbackId: "cb-A2b",
        sha256: sc.D("A2b"),
        lineage: [{ aggregate_type: "character_asset", aggregate_id: "C2", version: 1 }],
      }),
    ),
  );
});

test("连续性基线不可重复锁定", () => {
  const sc = buildScenario();
  assert.throws(
    () =>
      sc.ledger.lockContinuityBaseline({
        baselineId: "B1b",
        productionId: sc.ids.P1,
        characterId: "C1",
        lockedFromEpisode: 2,
        traitsSnapshot: {},
        actorId: sc.people.qian.id,
      }),
    (e) => e.code === "BASELINE_ALREADY_LOCKED",
  );
});

test("未锁定基线的角色可在首用集自由使用，但跨集复用必须先锁基线", () => {
  const sc = buildScenario();
  // 新角色 C3 不锁基线
  sc.ledger.registerCharacter({
    characterId: "C3",
    productionId: sc.ids.P1,
    characterCode: "CHAR_NEW",
    sourceAccountId: "tool-acct-c",
    digest: sc.D("C3"),
    actorId: sc.people.zhang.id,
  });
  // 首用集（第 4 集）自由使用
  assert.doesNotThrow(() =>
    sc.ledger.registerGeneratedAsset(
      assetCmd(sc, {
        assetId: "A30",
        episodeNo: 4,
        shotCode: "E04-S001",
        callbackId: "cb-A30",
        sha256: sc.D("A30"),
        lineage: [{ aggregate_type: "character_asset", aggregate_id: "C3", version: 1 }],
      }),
    ),
  );
  // 第 5 集复用且未锁基线 → 拒绝
  assert.throws(
    () =>
      sc.ledger.registerGeneratedAsset(
        assetCmd(sc, {
          assetId: "A31",
          episodeNo: 5,
          shotCode: "E05-S001",
          callbackId: "cb-A31",
          sha256: sc.D("A31"),
          lineage: [{ aggregate_type: "character_asset", aggregate_id: "C3", version: 1 }],
        }),
      ),
    (e) => e.code === "BASELINE_REQUIRED",
  );
});

// -- 审核路径建议只提示，决定必须签署 ----------------------------------------

test("系统只给建议：未冻结口径不提示；阈值与题材可独立触发省级建议", () => {
  assert.equal(suggestReviewPath({ frozen: false }).path, null);
  assert.equal(
    suggestReviewPath({
      frozen: true,
      genre_scope: { code: "g", requiresProvincial: false },
      investment_basis: { amount: 500_000, currency: "CNY" },
    }).path,
    reviewPaths.PLATFORM,
  );
  assert.equal(
    suggestReviewPath({
      frozen: true,
      genre_scope: { code: "g", requiresProvincial: true },
      investment_basis: { amount: 100, currency: "CNY" },
    }).path,
    reviewPaths.PROVINCIAL,
  );
});

test("无签署 / 角色不匹配 / 路径越权的审核决定一律被拒", () => {
  const sc = buildScenario();
  sc.ledger.registerGeneratedAsset(assetCmd(sc));
  sc.ledger.sealCut({
    productionId: sc.ids.P1,
    episodeNo: 1,
    cutRevision: 1,
    masterSha256: sc.D("master-E01-rev1"),
    timeline: timelineOf(sc.D),
    editorId: sc.people.zhang.id,
  });
  sc.ledger.assessTier({ productionId: sc.ids.P1, episodeNo: 1, actorId: sc.people.qian.id });
  sc.ledger.submitForReview({
    productionId: sc.ids.P1,
    episodeNo: 1,
    path: reviewPaths.PLATFORM,
    submittedBy: sc.people.qian.id,
    cutRevision: 1,
    masterSha256: sc.D("master-E01-rev1"),
    packageDigest: sc.D("pkg-E01-1"),
  });

  const decide = (over) =>
    sc.ledger.decideReview({
      productionId: sc.ids.P1,
      episodeNo: 1,
      decision: "approved",
      classification: "general",
      path: reviewPaths.PLATFORM,
      cutRevision: 1,
      masterSha256: sc.D("master-E01-rev1"),
      signer: { id: sc.people["rev-platform"].id, role: "platform_reviewer" },
      ...over,
    });

  // 省级审核员试图在平台档签署 → 无权
  assert.throws(
    () => decide({ signer: { id: sc.people["rev-provincial"].id, role: "platform_reviewer" } }),
    (e) => e.code === "SIGNER_ROLE_DENIED",
  );
  // 平台审核员持平台角色但送去省级 path → 角色不匹配
  assert.throws(
    () => decide({ path: reviewPaths.PROVINCIAL, signer: { id: sc.people["rev-platform"].id, role: "provincial_reviewer" } }),
    (e) => e.code === "SIGNER_ROLE_DENIED",
  );
  // 签署的母版摘要与封版不一致 → 拒绝
  assert.throws(() => decide({ masterSha256: sc.D("tampered-master") }), (e) => e.code === "MASTER_MISMATCH");
  // 正确签署通过，事件携带 HMAC
  const ok = decide();
  assert.match(ok.signature.value, /^[0-9a-f]{64}$/);
  assert.equal(ok.signature.signer_role, "platform_reviewer");
});

test("未批准的封版不能放行母版；放行后重审待决会挂起发行", () => {
  const sc = buildScenario();
  sc.ledger.registerGeneratedAsset(assetCmd(sc));
  sc.ledger.sealCut({
    productionId: sc.ids.P1,
    episodeNo: 1,
    cutRevision: 1,
    masterSha256: sc.D("m1"),
    timeline: timelineOf(sc.D),
    editorId: sc.people.zhang.id,
  });
  assert.throws(
    () =>
      sc.ledger.releaseMaster({
        productionId: sc.ids.P1,
        episodeNo: 1,
        cutRevision: 1,
        programId: "PRG-0001",
        signer: { id: sc.people.qian.id, role: "producer" },
      }),
    (e) => e.code === "NO_MATCHING_APPROVAL",
  );
});

// -- 精确重审触发 -----------------------------------------------------------

test("追加成本跨档：恰好越线的那一次触发省级重审，未越线不触发", () => {
  const sc = buildScenario();
  sc.ledger.registerGeneratedAsset(assetCmd(sc));
  // 封版前的成本不触发重审（还没有在审作品）
  sc.ledger.postCost({
    productionId: sc.ids.P1,
    amount: 600_000,
    currency: "CNY",
    category: "generation",
    sourceStatementId: "FIN-A",
    actorId: sc.people.sun.id,
  });
  sc.ledger.sealCut({
    productionId: sc.ids.P1,
    episodeNo: 1,
    cutRevision: 1,
    masterSha256: sc.D("m1"),
    timeline: timelineOf(sc.D),
    editorId: sc.people.zhang.id,
  });
  sc.ledger.assessTier({ productionId: sc.ids.P1, episodeNo: 1, actorId: sc.people.qian.id });
  sc.ledger.submitForReview({
    productionId: sc.ids.P1,
    episodeNo: 1,
    path: reviewPaths.PLATFORM,
    submittedBy: sc.people.qian.id,
    cutRevision: 1,
    masterSha256: sc.D("m1"),
    packageDigest: sc.D("pkg1"),
  });
  sc.ledger.decideReview({
    productionId: sc.ids.P1,
    episodeNo: 1,
    decision: "approved",
    classification: "general",
    path: reviewPaths.PLATFORM,
    cutRevision: 1,
    masterSha256: sc.D("m1"),
    signer: { id: sc.people["rev-platform"].id, role: "platform_reviewer" },
  });

  // 再入账 30 万：累计 90 万，未越线 → 无重审
  const r1 = sc.ledger.postCost({
    productionId: sc.ids.P1,
    amount: 300_000,
    currency: "CNY",
    category: "voice",
    sourceStatementId: "FIN-B",
    actorId: sc.people.sun.id,
  });
  assert.equal(r1.crossedThreshold, false);

  // 再入账 20 万：累计 110 万越过 100 万 → 精确触发，required_path=provincial
  const r2 = sc.ledger.postCost({
    productionId: sc.ids.P1,
    amount: 200_000,
    currency: "CNY",
    category: "overtime",
    sourceStatementId: "FIN-C",
    actorId: sc.people.sun.id,
  });
  assert.equal(r2.crossedThreshold, true);
  const state = sc.ledger.state;
  const review = state.reviews.get("review:P1:E001");
  assert.equal(review.pendingRereview, true);
  assert.deepEqual(
    review.rereviewTriggers.map((t) => t.trigger),
    ["cost_threshold_crossed"],
  );
  assert.equal(review.rereviewTriggers[0].required_path, reviewPaths.PROVINCIAL);

  // 重审待决期间放行被拒
  assert.throws(
    () =>
      sc.ledger.releaseMaster({
        productionId: sc.ids.P1,
        episodeNo: 1,
        cutRevision: 1,
        programId: "PRG-0001",
        signer: { id: sc.people.qian.id, role: "producer" },
      }),
    (e) => e.code === "REREVIEW_PENDING",
  );

  // 同一张财务单重试不重复入账、不重复触发
  const dup = sc.ledger.postCost({
    productionId: sc.ids.P1,
    amount: 200_000,
    currency: "CNY",
    category: "overtime",
    sourceStatementId: "FIN-C",
    actorId: sc.people.sun.id,
  });
  assert.equal(dup.duplicate, true);
  assert.equal(sc.ledger.state.reviews.get("review:P1:E001").rereviewTriggers.length, 1);
});

test("冻结投资口径上调跨档：平台档在审作品精确转省级重审", () => {
  const sc = buildScenario();
  sc.ledger.registerGeneratedAsset(assetCmd(sc));
  sc.ledger.sealCut({
    productionId: sc.ids.P1,
    episodeNo: 1,
    cutRevision: 1,
    masterSha256: sc.D("m1"),
    timeline: timelineOf(sc.D),
    editorId: sc.people.zhang.id,
  });
  sc.ledger.assessTier({ productionId: sc.ids.P1, episodeNo: 1, actorId: sc.people.qian.id });
  sc.ledger.submitForReview({
    productionId: sc.ids.P1,
    episodeNo: 1,
    path: reviewPaths.PLATFORM,
    submittedBy: sc.people.qian.id,
    cutRevision: 1,
    masterSha256: sc.D("m1"),
    packageDigest: sc.D("pkg1"),
  });

  const crossing = detectTierCrossing(
    { frozen: true, genre_scope: { requiresProvincial: false }, investment_basis: { amount: 500_000, currency: "CNY" } },
    { frozen: true, genre_scope: { requiresProvincial: false }, investment_basis: { amount: 1_500_000, currency: "CNY" } },
  );
  assert.deepEqual([crossing.crossed, crossing.from, crossing.to], [true, reviewPaths.PLATFORM, reviewPaths.PROVINCIAL]);

  const res = sc.ledger.reviseScope({
    productionId: sc.ids.P1,
    investmentBasis: { amount: 1_500_000, currency: "CNY", statement_id: "FIN-REV-9" },
    changeRequestId: "CR-9",
    actorId: sc.people.sun.id,
  });
  assert.equal(res.crossing.to, reviewPaths.PROVINCIAL);
  const trig = sc.ledger.state.reviews.get("review:P1:E001").rereviewTriggers;
  assert.equal(trig.at(-1).trigger, "scope_revised");
  assert.equal(trig.at(-1).required_path, reviewPaths.PROVINCIAL);

  // 同一变更单重试幂等
  const again = sc.ledger.reviseScope({
    productionId: sc.ids.P1,
    investmentBasis: { amount: 1_500_000, currency: "CNY", statement_id: "FIN-REV-9" },
    changeRequestId: "CR-9",
    actorId: sc.people.sun.id,
  });
  assert.equal(again.duplicate, true);
});

test("重剪精确触发重审；未进入审核流程的集次不触发", () => {
  const sc = buildScenario();
  // 第 2 集只封版未送审
  sc.ledger.registerGeneratedAsset(assetCmd(sc, { assetId: "A2", episodeNo: 2, shotCode: "E02-S001", callbackId: "cb-A2", sha256: sc.D("A2") }));
  sc.ledger.sealCut({
    productionId: sc.ids.P1,
    episodeNo: 2,
    cutRevision: 1,
    masterSha256: sc.D("E02-m1"),
    timeline: [{ asset_id: "A2", shot_code: "E02-S001", start_sec: 0, end_sec: 10 }],
    editorId: sc.people.zhang.id,
  });
  const events = sc.ledger.reviseCut({
    productionId: sc.ids.P1,
    episodeNo: 2,
    newRevision: 2,
    reason: "节奏调整",
    editorId: sc.people.zhang.id,
  });
  assert.equal(events.length, 1); // 只有 CUT_REVISED，没有 REREVIEW_TRIGGERED
  assert.equal(sc.ledger.state.reviews.has("review:P1:E002"), false);
});

test("evaluateRereviewTriggers 白名单：四类变化各自独立映射", () => {
  const t = evaluateRereviewTriggers({
    scopeRevised: true,
    additionalCosts: true,
    overThreshold: true,
    cutRevised: true,
    overseasVersion: true,
    currentPath: reviewPaths.PLATFORM,
  });
  assert.deepEqual(
    t.map((x) => x.trigger).sort(),
    ["cost_threshold_crossed", "cut_revised", "overseas_version", "scope_revised"].sort(),
  );
  // 追加了成本但没越线 → 不触发
  assert.deepEqual(evaluateRereviewTriggers({ additionalCosts: true, overThreshold: false }), []);
});

// -- 退回 / 替换提交链 -------------------------------------------------------

test("退回后只能以替换提交重交，且替换母版必须与新封版一致", () => {
  const sc = buildScenario();
  sc.ledger.registerGeneratedAsset(assetCmd(sc));
  sc.ledger.sealCut({
    productionId: sc.ids.P1,
    episodeNo: 1,
    cutRevision: 1,
    masterSha256: sc.D("m1"),
    timeline: timelineOf(sc.D),
    editorId: sc.people.zhang.id,
  });
  sc.ledger.assessTier({ productionId: sc.ids.P1, episodeNo: 1 });
  sc.ledger.submitForReview({
    productionId: sc.ids.P1,
    episodeNo: 1,
    path: reviewPaths.PLATFORM,
    submittedBy: sc.people.qian.id,
    cutRevision: 1,
    masterSha256: sc.D("m1"),
    packageDigest: sc.D("pkg1"),
  });
  sc.ledger.decideReview({
    productionId: sc.ids.P1,
    episodeNo: 1,
    decision: "returned",
    classification: "needs_fix",
    path: reviewPaths.PLATFORM,
    cutRevision: 1,
    masterSha256: sc.D("m1"),
    signer: { id: sc.people["rev-platform"].id, role: "platform_reviewer" },
    notes: "片尾字幕错误",
  });

  // 未产出新封版前（仍指向被退回的 rev1）不能替换提交
  assert.throws(
    () =>
      sc.ledger.resubmit({
        productionId: sc.ids.P1,
        episodeNo: 1,
        path: reviewPaths.PLATFORM,
        submittedBy: sc.people.qian.id,
        cutRevision: 1,
        masterSha256: sc.D("m1"),
        packageDigest: sc.D("pkg1b"),
      }),
    (e) => e.code === "REPLACEMENT_REVISION_REQUIRED",
  );

  // 重剪 rev2 并重新封版
  sc.ledger.reviseCut({ productionId: sc.ids.P1, episodeNo: 1, newRevision: 2, reason: "字幕修正", editorId: sc.people.zhang.id });
  sc.ledger.sealCut({
    productionId: sc.ids.P1,
    episodeNo: 1,
    cutRevision: 2,
    masterSha256: sc.D("m2"),
    timeline: timelineOf(sc.D),
    editorId: sc.people.zhang.id,
  });
  const resub = sc.ledger.resubmit({
    productionId: sc.ids.P1,
    episodeNo: 1,
    path: reviewPaths.PLATFORM,
    submittedBy: sc.people.qian.id,
    cutRevision: 2,
    masterSha256: sc.D("m2"),
    packageDigest: sc.D("pkg2"),
  });
  assert.equal(resub.event_type, "REVIEW_RESUBMITTED");
  assert.equal(resub.payload.supersedes_event_id.includes("review:P1:E001#"), true);
});
