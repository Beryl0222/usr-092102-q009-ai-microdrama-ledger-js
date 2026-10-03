import assert from "node:assert/strict";
import test from "node:test";

import { Ledger } from "../src/ledger.js";
import { createProductionService } from "../src/service.js";
import { ErrorCodes } from "../src/errors.js";
import { detectCostCrossing, detectScopeAmendment, investmentBand, suggestPath } from "../src/review.js";
import { replay } from "../src/state.js";

const AT = "2026-10-01T09:00";
const at = (min) => `2026-10-01T09:${String(min).padStart(2, "0")}:00+08:00`;

const officer = { person_id: "p-officer", roles: ["classification_officer"] };
const producer = { person_id: "p-producer", roles: ["producer"] };
const authority = { person_id: "p-authority", roles: ["review_authority"] };
const director = { person_id: "p-director", roles: ["director", "editor"] };

function episodeFixture({ investment = 800_000, genre = "other" } = {}) {
  const ledger = new Ledger();
  const svc = createProductionService(ledger);
  svc.freezeScope({ eventId: "e-freeze", occurredAt: at(0), actor: producer, episodeId: "E1", programId: "P1", genre, investmentAmount: investment });
  return { ledger, svc };
}

test("建议规则：投资档位与题材取更严者，但只是 advisory", () => {
  assert.equal(investmentBand(800_000), 0);
  assert.equal(investmentBand(3_000_000), 1);
  assert.equal(investmentBand(30_000_000), 2);
  assert.equal(suggestPath({ genre: "other", investment_amount: 800_000 }).suggested_path, "platform_self_review");
  const sensitive = suggestPath({ genre: "historical", investment_amount: 100_000 });
  assert.equal(sensitive.suggested_path, "provincial_administration_submission");
  const major = suggestPath({ genre: "major_revolution", investment_amount: 100_000 });
  assert.equal(major.suggested_path, "national_administration_submission");
});

test("最终分类必须有权人员签署；无角色被拒；覆盖建议必须留 justification", () => {
  const { svc } = episodeFixture();
  assert.throws(
    () => svc.signClassification({ eventId: "e-s1", occurredAt: at(1), actor: producer, episodeId: "E1", path: "platform_self_review" }),
    (e) => e.code === ErrorCodes.SIGNER_UNAUTHORIZED,
  );
  // 签署人与系统建议不同却不写理由 → 拒绝
  assert.throws(
    () => svc.signClassification({ eventId: "e-s2", occurredAt: at(1), actor: officer, episodeId: "E1", path: "provincial_administration_submission" }),
    (e) => e.code === ErrorCodes.NOT_SIGNED,
  );
  const signed = svc.signClassification({
    eventId: "e-s3", occurredAt: at(1), actor: officer, episodeId: "E1",
    path: "provincial_administration_submission", justification: "属地预审要求，分类人承担责任",
  });
  assert.equal(signed.event_type, "REVIEW_CLASSIFICATION_SIGNED");
  const state = replay(svc.ledger.all());
  assert.equal(state.reviews.get("E1").advisory_override, true);
});

test("未签署不能送审；签署路径与送审路径必须一致", () => {
  const { svc } = episodeFixture();
  svc.registerAssetGenerated({ eventId: "e-a1", occurredAt: at(1), actor: director, assetId: "a1", kind: "shot_take", hash: "h1", model: {}, promptSummary: "s" });
  svc.sealCut({ eventId: "e-cut", occurredAt: at(2), actor: director, episodeId: "E1", assetIds: ["a1"], master: { hash: "m1", uri: "u" } });
  assert.throws(() => svc.submitForReview({ eventId: "e-sub0", occurredAt: at(3), actor: producer, episodeId: "E1" }), (e) => e.code === ErrorCodes.NOT_SIGNED);

  svc.signClassification({ eventId: "e-sig", occurredAt: at(4), actor: officer, episodeId: "E1", path: "platform_self_review" });
  assert.throws(
    () => svc.submitForReview({ eventId: "e-sub1", occurredAt: at(5), actor: producer, episodeId: "E1", path: "provincial_administration_submission" }),
    (e) => e.code === ErrorCodes.REVIEW_PATH_MISMATCH,
  );
});

test("口径修订：跨档精确触发重审，同档追加不触发；触发后必须重签", () => {
  const { svc } = episodeFixture();
  svc.registerAssetGenerated({ eventId: "e-a1", occurredAt: at(1), actor: director, assetId: "a1", kind: "shot_take", hash: "h1", model: {}, promptSummary: "s" });
  svc.sealCut({ eventId: "e-cut", occurredAt: at(2), actor: director, episodeId: "E1", assetIds: ["a1"], master: { hash: "m1", uri: "u" } });
  svc.signClassification({ eventId: "e-sig", occurredAt: at(3), actor: officer, episodeId: "E1", path: "platform_self_review" });
  svc.submitForReview({ eventId: "e-sub", occurredAt: at(4), actor: producer, episodeId: "E1" });

  // 80 万 → 200 万：仍在平台档，不触发
  const within = svc.amendScope({ eventId: "e-amend0", occurredAt: at(5), actor: producer, episodeId: "E1", investmentAmount: 2_000_000 });
  assert.equal(within.triggered, null);
  // 直接验证检测函数
  assert.equal(detectScopeAmendment({ genre: "other", investment_amount: 800_000 }, { genre: "other", investment_amount: 2_000_000 }).changed, false);

  // → 320 万：跨省级，精确触发
  const crossed = svc.amendScope({ eventId: "e-amend1", occurredAt: at(6), actor: producer, episodeId: "E1", investmentAmount: 3_200_000 });
  assert.equal(crossed.triggered.payload.trigger, "scope_amended");
  const state = replay(svc.ledger.all());
  assert.equal(state.reviews.get("E1").status, "reassessment_required");
  assert.equal(state.reviews.get("E1").signed_path, null);
  assert.equal(state.reviews.get("E1").suggestions.length, 2);
});

test("实际成本：仅累计跨档才触发，档位内多笔不触发", () => {
  const { svc } = episodeFixture({ investment: 1_000_000 });
  const c1 = svc.ledgerCost({ eventId: "e-cost1", occurredAt: at(1), actor: producer, episodeId: "E1", category: "generation", amount: 2_500_000 });
  assert.equal(c1.triggered, null); // 250 万仍平台档
  const c2 = svc.ledgerCost({ eventId: "e-cost2", occurredAt: at(2), actor: producer, episodeId: "E1", category: "post", amount: 700_000 });
  assert.equal(c2.triggered.payload.trigger, "investment_threshold_crossed"); // 320 万省级
  // 检测函数边界
  assert.equal(detectCostCrossing({ genre: "other", investment_amount: 1_000_000 }, 2_900_000, 2_990_000), null);
  assert.ok(detectCostCrossing({ genre: "other", investment_amount: 1_000_000 }, 2_900_000, 3_100_000));
});

test("送审→退回→返工→重签→重送审→通过 的完整轮次历史", () => {
  const { svc } = episodeFixture();
  svc.registerAssetGenerated({ eventId: "e-a1", occurredAt: at(1), actor: director, assetId: "a1", kind: "shot_take", hash: "h1", model: {}, promptSummary: "s" });
  svc.sealCut({ eventId: "e-cut1", occurredAt: at(2), actor: director, episodeId: "E1", assetIds: ["a1"], master: { hash: "m1", uri: "u1" } });
  svc.signClassification({ eventId: "e-sig1", occurredAt: at(3), actor: officer, episodeId: "E1", path: "platform_self_review" });
  svc.submitForReview({ eventId: "e-sub1", occurredAt: at(4), actor: producer, episodeId: "E1" });
  svc.returnReview({ eventId: "e-ret", occurredAt: at(5), actor: authority, episodeId: "E1", reasons: ["字幕问题"] });

  // 非退回状态不能重送
  const state1 = replay(svc.ledger.all());
  assert.equal(state1.reviews.get("E1").status, "returned");

  svc.registerAssetGenerated({ eventId: "e-a2", occurredAt: at(6), actor: director, assetId: "a2", kind: "shot_take", hash: "h2", model: {}, promptSummary: "s2", sourceAssetIds: ["a1"] });
  svc.sealCut({ eventId: "e-cut2", occurredAt: at(7), actor: director, episodeId: "E1", assetIds: ["a2"], master: { hash: "m2", uri: "u2" } });
  // 退回后必须走重新提交；普通提交会被状态机拒绝
  assert.throws(() => svc.submitForReview({ eventId: "e-sub2-bad", occurredAt: at(8), actor: producer, episodeId: "E1" }), (e) => e.code === ErrorCodes.ALREADY_DECIDED);
  svc.resubmitForReview({ eventId: "e-sub2", occurredAt: at(8), actor: producer, episodeId: "E1" });
  const st = replay(svc.ledger.all());
  assert.equal(st.reviews.get("E1").submissions.length, 2);
  assert.equal(st.reviews.get("E1").submissions[1].kind, "resubmit");

  // 非审核机关不能作通过决定
  assert.throws(() => svc.approveReview({ eventId: "e-app-x", occurredAt: at(9), actor: producer, episodeId: "E1" }), (e) => e.code === ErrorCodes.SIGNER_UNAUTHORIZED);
  svc.approveReview({ eventId: "e-app", occurredAt: at(10), actor: authority, episodeId: "E1" });
  assert.equal(replay(svc.ledger.all()).reviews.get("E1").status, "approved");
});

test("重剪/海外版本替换母版精确触发重审，旧通过不覆盖新母版", () => {
  const { ledger, svc } = episodeFixture();
  svc.registerAssetGenerated({ eventId: "e-a1", occurredAt: at(1), actor: director, assetId: "a1", kind: "shot_take", hash: "h1", model: {}, promptSummary: "s" });
  svc.sealCut({ eventId: "e-cut1", occurredAt: at(2), actor: director, episodeId: "E1", assetIds: ["a1"], master: { hash: "m1", uri: "u1" } });
  svc.signClassification({ eventId: "e-sig", occurredAt: at(3), actor: officer, episodeId: "E1", path: "platform_self_review" });
  svc.submitForReview({ eventId: "e-sub", occurredAt: at(4), actor: producer, episodeId: "E1" });
  svc.approveReview({ eventId: "e-app", occurredAt: at(5), actor: authority, episodeId: "E1" });

  const r = svc.replaceMaster({
    eventId: "e-repl", occurredAt: at(6), actor: director, episodeId: "E1",
    master: { hash: "m2", uri: "u2" }, reason: "重剪",
  });
  assert.equal(r.triggered.payload.trigger, "master_reedited");
  assert.equal(replay(ledger.all()).reviews.get("E1").status, "reassessment_required");
});
