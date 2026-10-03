import { Ledger } from "../src/ledger.js";
import { createProductionService } from "../src/service.js";
import { LedgerError } from "../src/errors.js";

/**
 * 端到端联调场景：系列剧《长安谍影》并行制作 EP01 / EP02。
 *
 * 覆盖：剧本权利 → 口径冻结与系统建议 → 角色基线锁定 → 生成/否决/重生成/人工修订 →
 * 配音音乐 → 贡献与成本 → 签署 → 送审/退回/重审触发（口径跨档、成本跨档、重剪、海外版）→
 * 放行与最小披露。同时登记一组 v1 遗留事件验证旧契约回放。
 *
 * 返回 { ledger, events, ids, blocked, retries }：
 * blocked 记录被不变量拦截的违规尝试（不产生事件）。
 */

const A = {
  lin: { person_id: "p-lin", display_name: "林一（兼导演/分镜/生成/剪辑）", roles: ["director", "storyboard_artist", "generation_operator", "editor"] },
  su: { person_id: "p-su", display_name: "苏禾（连续性总监）", roles: ["continuity_supervisor"] },
  he: { person_id: "p-he", display_name: "何律（分类签署人）", roles: ["classification_officer"] },
  chen: { person_id: "p-chen", display_name: "陈制片", roles: ["producer"] },
  jian: { person_id: "p-jian", display_name: "省局经办人", roles: ["review_authority"] },
  yin: { person_id: "p-yin", display_name: "殷声（配音）", roles: ["voice_artist"] },
  qu: { person_id: "p-qu", display_name: "曲谱（作曲）", roles: ["music_composer"] },
  fang: { person_id: "p-fang", display_name: "方放行", roles: ["release_manager"] },
};

const base = Date.parse("2026-09-21T09:00:00+08:00");
const at = (minute) => {
  const d = new Date(base + minute * 60_000);
  const local = new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 19);
  return `${local}+08:00`;
};

function tryGuard(fn) {
  try {
    fn();
    return { blocked: false };
  } catch (err) {
    if (err instanceof LedgerError) return { blocked: true, code: err.code, message: err.message, details: err.details };
    throw err;
  }
}

export function buildScenario() {
  const ledger = new Ledger();
  const svc = createProductionService(ledger);
  const blocked = [];
  const retries = {};
  let m = 0;
  const next = () => ++m;
  const ids = {};

  const cmd = (extra) => ({ occurredAt: at(next()), ...extra });

  // ---------- v1 遗留事件（无 payload 的旧信封）必须继续可回放 ----------
  ledger.append({
    event_id: "legacy-asset-001", event_type: "ASSET_GENERATED", aggregate_type: "production_asset",
    aggregate_id: "asset-legacy-001", occurred_at: at(next()), version: 1, summary: "v1 遗留资产",
  });
  ledger.append({
    event_id: "legacy-cut-001", event_type: "CUT_SEALED", aggregate_type: "episode_cut",
    aggregate_id: "ep-legacy", occurred_at: at(next()), version: 1, summary: "v1 遗留成片",
  });
  ledger.append({
    event_id: "legacy-tier-001", event_type: "TIER_ASSESSED", aggregate_type: "review_submission",
    aggregate_id: "rs-legacy", occurred_at: at(next()), version: 1, summary: "v1 遗留档位评估",
  });
  ledger.append({
    event_id: "legacy-decision-001", event_type: "REVIEW_DECIDED", aggregate_type: "review_submission",
    aggregate_id: "rs-legacy", occurred_at: at(next()), version: 2, summary: "v1 遗留审核决定",
    actor: { person_id: "p-legacy-officer" },
  });
  ledger.append({
    event_id: "legacy-delivery-001", event_type: "RELEASE_DELIVERED", aggregate_type: "episode_cut",
    aggregate_id: "ep-legacy", occurred_at: at(next()), version: 2, summary: "v1 遗留交付",
  });

  // ---------- 剧本权利 ----------
  svc.registerScriptRights(cmd({
    eventId: "ev-rights-cd01", actor: A.chen,
    scriptId: "script-cd-01", title: "长安谍影", rightHolder: "制片方A",
    authors: ["编剧Z"], licenseScope: "exclusive_av_remake",
    territories: ["CN", "ROW"], expiresAt: "2031-12-31", docHash: "hash-rights-cd01",
  }));

  // ================= EP01 =================
  // 口径冻结：80 万、普通题材 → 系统建议平台自审
  svc.freezeScope(cmd({
    eventId: "ev-ep01-freeze-1", actor: A.chen,
    episodeId: "EP01", seriesId: "series-cd-01", programId: "PRG-CD-01",
    genre: "other", investmentAmount: 800_000,
  }));

  // 个人素材 + 提示词资产（内部溯源可见，永不进入发行视图）
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep01-ref-1", actor: A.lin,
    assetId: "ref-lin-face-01", kind: "personal_reference", hash: "hash-ref-01",
    promptSummary: "演员本人照片（个人素材，禁对外）", personalReference: true,
    model: null, episodeId: "EP01",
  }));
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep01-prompt-char", actor: A.lin,
    assetId: "prompt-char-a-01", kind: "prompt_input", hash: "hash-prompt-char-01",
    promptSummary: "未采用的角色提示词草稿 v0", model: null, episodeId: "EP01",
  }));

  // 主角角色图 → 锁定连续性基线
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep01-chara-v1", actor: A.lin, correlationId: "EP01",
    assetId: "char-a-v1", kind: "character_sheet", hash: "hash-char-a-v1",
    model: { name: "img-gen", version: "v3.1", provider: "internal" },
    promptSummary: "沈彦角色定稿：圆领袍、刀痕眉", promptInputRef: "prompt-char-a-02",
    sourceAssetIds: ["ref-lin-face-01"],
    characterId: "char-a", episodeId: "EP01",
  }));
  svc.lockCharacterBaseline(cmd({
    eventId: "ev-ep01-baseline-a", actor: A.su,
    characterId: "char-a", name: "沈彦",
    baselineAssetId: "char-a-v1", baselineHash: "hash-char-a-v1", episodeId: "EP01",
  }));

  // 场景板
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep01-plate-street", actor: A.lin,
    assetId: "plate-street-01", kind: "scene_plate", hash: "hash-plate-street",
    model: { name: "img-gen", version: "v3.1" },
    promptSummary: "长安西市夜街场景板", episodeId: "EP01",
  }));

  // 镜头 1：第一版被安全策略否决
  svc.requestRegeneration(cmd({
    eventId: "ev-ep01-shot01-req", actor: A.lin,
    newShotId: "ep01-shot-01", parentShotId: null, episodeId: "EP01",
  }));
  const genRejected = svc.registerAssetGenerated(cmd({
    eventId: "ev-ep01-take-a", actor: A.lin, idempotencyKey: "cb-ep01-take-a",
    assetId: "ep01-take-a", kind: "shot_take", hash: "hash-take-a-bad",
    model: { name: "video-gen", version: "v12" },
    promptSummary: "夜街追逐第一版（含违规元素）",
    sourceAssetIds: ["char-a-v1", "plate-street-01"],
    shotId: "ep01-shot-01", episodeId: "EP01",
  }));
  ids.rejectedTakeEventId = genRejected.event.event_id;
  svc.rejectShot(cmd({
    eventId: "ev-ep01-take-a-reject", actor: A.lin,
    shotId: "ep01-shot-01", assetId: "ep01-take-a", assetHash: "hash-take-a-bad",
    reason: "safety_policy", note: "危险动作模仿风险", episodeId: "EP01",
  }));

  // 外部回调重试：相同事件原文再次送达（乱序/重试），必须 duplicate=true、不产生第二条产物
  retries.callbackRetry = ledger.append(ledger.get("ev-ep01-take-a"));

  // 镜头 2：重生成，第二版采用
  svc.requestRegeneration(cmd({
    eventId: "ev-ep01-shot02-req", actor: A.lin,
    newShotId: "ep01-shot-02", parentShotId: "ep01-shot-01", episodeId: "EP01",
  }));
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep01-take-b", actor: A.lin, idempotencyKey: "cb-ep01-take-b",
    assetId: "ep01-take-b", kind: "shot_take", hash: "hash-take-b",
    model: { name: "video-gen", version: "v12.1" },
    promptSummary: "夜街追逐第二版（已消除违规元素）",
    sourceAssetIds: ["char-a-v1", "plate-street-01"],
    shotId: "ep01-shot-02", episodeId: "EP01",
  }));
  svc.acceptTake(cmd({
    eventId: "ev-ep01-take-b-accept", actor: A.lin,
    shotId: "ep01-shot-02", assetId: "ep01-take-b", episodeId: "EP01",
  }));

  // 违规尝试 1：把被否决的 take-a 当来源做“新镜头”，必须拦截
  blocked.push({ case: "rejected_ancestor_reuse", ...tryGuard(() => svc.registerAssetGenerated({
    eventId: "ev-ep01-take-x", occurredAt: at(next()), actor: A.lin,
    assetId: "ep01-take-x", kind: "shot_take", hash: "hash-take-x",
    model: { name: "video-gen", version: "v12.1" },
    promptSummary: "试图基于被否决镜头改头换面",
    sourceAssetIds: ["ep01-take-a"],
    shotId: "ep01-shot-09", episodeId: "EP01",
  })) });

  // 配音 / 音乐
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep01-voice-1", actor: A.yin,
    assetId: "ep01-voice-01", kind: "voice", hash: "hash-voice-01",
    model: null, promptSummary: "主角配音第一集", episodeId: "EP01",
  }));
  svc.linkVoiceMusic(cmd({
    eventId: "ev-ep01-voice-link", actor: A.yin,
    assetId: "ep01-voice-01", audioKind: "voice", title: "EP01 主角配音",
    contributorId: "p-yin", source: "studio-recorded", licenseDocHash: "hash-voice-license",
  }));
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep01-music-1", actor: A.qu,
    assetId: "ep01-music-01", kind: "music", hash: "hash-music-01",
    model: null, promptSummary: "EP01 片尾配乐", episodeId: "EP01",
  }));
  svc.linkVoiceMusic(cmd({
    eventId: "ev-ep01-music-link", actor: A.qu,
    assetId: "ep01-music-01", audioKind: "music", title: "《西市灯》",
    contributorId: "p-qu", source: "original-work", licenseDocHash: "hash-music-license",
  }));

  // 贡献与分账
  svc.ledgerContribution(cmd({
    eventId: "ev-ep01-contr-lin", actor: A.lin,
    entryId: "contr-ep01-lin", personId: "p-lin", displayName: A.lin.display_name,
    episodeId: "EP01",
    assetIds: ["ep01-take-b", "char-a-v1", "plate-street-01"],
    roles: ["director", "storyboard_artist", "generation_operator", "editor"],
    revenueShareBps: 400,
  }));
  svc.ledgerContribution(cmd({
    eventId: "ev-ep01-contr-yin", actor: A.yin,
    entryId: "contr-ep01-yin", personId: "p-yin", displayName: A.yin.display_name,
    episodeId: "EP01",
    assetIds: ["ep01-voice-01"], roles: ["voice_artist"], revenueShareBps: 100,
  }));
  svc.ledgerContribution(cmd({
    eventId: "ev-ep01-contr-qu", actor: A.qu,
    entryId: "contr-ep01-qu", personId: "p-qu", displayName: A.qu.display_name,
    episodeId: "EP01",
    assetIds: ["ep01-music-01"], roles: ["music_composer"], revenueShareBps: 80,
  }));

  // 成本（部分按生成/修订事件归集，供帧溯源）
  svc.ledgerCost(cmd({
    eventId: "ev-ep01-cost-gen", actor: A.chen,
    episodeId: "EP01", category: "generation", amount: 12_000,
    causalEventId: "ev-ep01-take-b",
  }));
  svc.ledgerCost(cmd({
    eventId: "ev-ep01-cost-voice", actor: A.chen,
    episodeId: "EP01", category: "voice", amount: 8_000, causalEventId: null,
  }));

  // 封版 m1
  svc.sealCut(cmd({
    eventId: "ev-ep01-seal-1", actor: A.lin,
    episodeId: "EP01", programId: "PRG-CD-01",
    assetIds: ["ep01-take-b", "ep01-voice-01", "ep01-music-01"],
    master: { hash: "hash-master-ep01-v1", uri: "s3://masters/EP01/v1.mp4", duration_seconds: 180, checksum_alg: "sha256" },
  }));

  // 先按平台档签署、送审
  svc.signClassification(cmd({
    eventId: "ev-ep01-sign-1", actor: A.he,
    episodeId: "EP01", path: "platform_self_review",
  }));
  svc.submitForReview(cmd({
    eventId: "ev-ep01-submit-1", actor: A.chen,
    episodeId: "EP01", targetAuthority: "platform-review-desk",
  }));
  // 平台退回
  svc.returnReview(cmd({
    eventId: "ev-ep01-return-1", actor: A.jian,
    episodeId: "EP01", reasons: ["需补对白字幕", "片头署名不全"],
  }));

  // 财务口径调整：80 万 → 320 万，跨入省级档 → 精确触发重审 + 新建议
  const amend = svc.amendScope(cmd({
    eventId: "ev-ep01-amend-1", actor: A.chen,
    episodeId: "EP01", investmentAmount: 3_200_000,
    reason: "财务复核实际投资额上调",
  }));
  ids.ep01ScopeTrigger = amend.triggered.event_id;

  // 同档内的小额追加（320 万→325 万）不得重复触发
  const amendNoTrigger = svc.amendScope(cmd({
    eventId: "ev-ep01-amend-2", actor: A.chen,
    episodeId: "EP01", investmentAmount: 3_250_000, reason: "杂项追加",
  }));
  ids.ep01AmendNoTrigger = amendNoTrigger.triggered;

  // 返工：重生成镜头 3 → 人工修订 → 采用 → 重新封版 m2
  svc.requestRegeneration(cmd({
    eventId: "ev-ep01-shot03-req", actor: A.lin,
    newShotId: "ep01-shot-03", parentShotId: "ep01-shot-02", episodeId: "EP01",
  }));
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep01-take-b2", actor: A.lin, idempotencyKey: "cb-ep01-take-b2",
    assetId: "ep01-take-b2", kind: "shot_take", hash: "hash-take-b2",
    model: { name: "video-gen", version: "v12.1" },
    promptSummary: "夜街追逐第三版：补字幕安全区、修正署名卡",
    sourceAssetIds: ["ep01-take-b"],
    shotId: "ep01-shot-03", episodeId: "EP01",
  }));
  svc.reviseShotManually(cmd({
    eventId: "ev-ep01-take-b2-revise", actor: A.lin,
    shotId: "ep01-shot-03", revisedAssetId: "ep01-take-b2",
    note: "剪辑手工调整字幕节奏与署名卡时长", episodeId: "EP01",
  }));
  svc.ledgerCost(cmd({
    eventId: "ev-ep01-cost-edit", actor: A.chen,
    episodeId: "EP01", category: "manual_revision", amount: 3_000,
    causalEventId: "ev-ep01-take-b2-revise",
  }));
  svc.acceptTake(cmd({
    eventId: "ev-ep01-take-b2-accept", actor: A.lin,
    shotId: "ep01-shot-03", assetId: "ep01-take-b2", episodeId: "EP01",
  }));
  svc.sealCut(cmd({
    eventId: "ev-ep01-seal-2", actor: A.lin,
    episodeId: "EP01", programId: "PRG-CD-01",
    assetIds: ["ep01-take-b2", "ep01-voice-01", "ep01-music-01"],
    master: { hash: "hash-master-ep01-v2", uri: "s3://masters/EP01/v2.mp4", duration_seconds: 182, checksum_alg: "sha256" },
  }));

  // 重新签署为省级送审（与系统新建议一致），重新送审、通过、放行
  svc.signClassification(cmd({
    eventId: "ev-ep01-sign-2", actor: A.he,
    episodeId: "EP01", path: "provincial_administration_submission",
  }));
  svc.submitForReview(cmd({
    eventId: "ev-ep01-submit-2", actor: A.chen,
    episodeId: "EP01", targetAuthority: "省广电局政务窗口",
  }));
  svc.approveReview(cmd({
    eventId: "ev-ep01-approve-1", actor: A.jian,
    episodeId: "EP01", approvalDocHash: "hash-approval-ep01-1",
  }));
  svc.publishReleasePackage(cmd({
    eventId: "ev-ep01-pkg-1", actor: A.fang,
    packageId: "pkg-ep01-domestic", programId: "PRG-CD-01", episodeId: "EP01",
    rightsScriptIds: ["script-cd-01"],
  }));
  svc.grantReleaseAccess(cmd({
    eventId: "ev-ep01-grant-1", actor: A.fang,
    packageId: "pkg-ep01-domestic", receiverId: "plat-shortv", receiverName: "短视频发行平台",
  }));

  // ================= EP02（跨集连续性 + 成本跨档 + 海外版本） =================
  svc.freezeScope(cmd({
    eventId: "ev-ep02-freeze-1", actor: A.chen,
    episodeId: "EP02", seriesId: "series-cd-01", programId: "PRG-CD-02",
    genre: "other", investmentAmount: 2_800_000,
  }));

  // 违规尝试 2：跨集复用未锁基线角色 char-b
  blocked.push({ case: "baseline_not_locked", ...tryGuard(() => svc.registerAssetGenerated({
    eventId: "ev-ep02-charb-x", occurredAt: at(next()), actor: A.lin,
    assetId: "char-b-v1", kind: "character_sheet", hash: "hash-char-b-v1",
    model: { name: "img-gen", version: "v3.1" }, promptSummary: "新角色",
    continuityBase: { character_id: "char-b", baseline_hash: "hash-char-b-v1" },
    characterId: "char-b", episodeId: "EP02",
  })) });

  // 违规尝试 3：跨集复用 char-a 但基线指纹漂移
  blocked.push({ case: "baseline_drift", ...tryGuard(() => svc.registerAssetGenerated({
    eventId: "ev-ep02-chara-drift", occurredAt: at(next()), actor: A.lin,
    assetId: "char-a-v2-drift", kind: "character_sheet", hash: "hash-char-a-drift",
    model: { name: "img-gen", version: "v3.1" }, promptSummary: "走形的沈彦",
    continuityBase: { character_id: "char-a", baseline_hash: "hash-tampered" },
    sourceAssetIds: ["char-a-v1"],
    characterId: "char-a", episodeId: "EP02",
  })) });

  // 违规尝试 4：EP02 镜头谱系里混入 EP01 被否决 hash（跨集拉黑）
  blocked.push({ case: "cross_episode_rejected_reuse", ...tryGuard(() => svc.registerAssetGenerated({
    eventId: "ev-ep02-take-x", occurredAt: at(next()), actor: A.lin,
    assetId: "ep02-take-x", kind: "shot_take", hash: "hash-ep02-take-x",
    model: { name: "video-gen", version: "v12.1" }, promptSummary: "盗用旧集废镜头",
    sourceAssetIds: ["ep01-take-a"],
    shotId: "ep02-shot-09", episodeId: "EP02",
  })) });

  // 合规跨集复用：基线指纹一致
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep02-chara-v2", actor: A.lin,
    assetId: "char-a-v2", kind: "character_sheet", hash: "hash-char-a-v2",
    model: { name: "img-gen", version: "v3.1" },
    promptSummary: "沈彦第二集造型（冬装），连续性基线一致",
    continuityBase: { character_id: "char-a", baseline_hash: "hash-char-a-v1" },
    sourceAssetIds: ["char-a-v1"],
    characterId: "char-a", episodeId: "EP02",
  }));
  svc.requestRegeneration(cmd({
    eventId: "ev-ep02-shot01-req", actor: A.lin,
    newShotId: "ep02-shot-01", parentShotId: null, episodeId: "EP02",
  }));
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep02-take-a", actor: A.lin, idempotencyKey: "cb-ep02-take-a",
    assetId: "ep02-take-a", kind: "shot_take", hash: "hash-ep02-take-a",
    model: { name: "video-gen", version: "v12.1" },
    promptSummary: "EP02 开场镜头",
    sourceAssetIds: ["char-a-v2", "plate-street-01"],
    shotId: "ep02-shot-01", episodeId: "EP02",
  }));
  svc.acceptTake(cmd({
    eventId: "ev-ep02-take-accept", actor: A.lin,
    shotId: "ep02-shot-01", assetId: "ep02-take-a", episodeId: "EP02",
  }));

  // 实际成本累计跨档：240 万不触发，再加 80 万 → 越过 300 万 → 精确触发
  const cost1 = svc.ledgerCost(cmd({
    eventId: "ev-ep02-cost-1", actor: A.chen,
    episodeId: "EP02", category: "generation", amount: 2_400_000, causalEventId: null,
  }));
  ids.ep02Cost1Trigger = cost1.triggered;
  const cost2 = svc.ledgerCost(cmd({
    eventId: "ev-ep02-cost-2", actor: A.chen,
    episodeId: "EP02", category: "postproduction", amount: 800_000, causalEventId: null,
  }));
  ids.ep02Cost2Trigger = cost2.triggered.event_id;

  // 按系统新建议签省级，封版送审通过放行
  svc.signClassification(cmd({
    eventId: "ev-ep02-sign-1", actor: A.he,
    episodeId: "EP02", path: "provincial_administration_submission",
  }));
  svc.registerAssetGenerated(cmd({
    eventId: "ev-ep02-voice-1", actor: A.yin,
    assetId: "ep02-voice-01", kind: "voice", hash: "hash-ep02-voice",
    model: null, promptSummary: "EP02 配音", episodeId: "EP02",
  }));
  svc.sealCut(cmd({
    eventId: "ev-ep02-seal-1", actor: A.lin,
    episodeId: "EP02", programId: "PRG-CD-02",
    assetIds: ["ep02-take-a", "ep02-voice-01"],
    master: { hash: "hash-master-ep02-v1", uri: "s3://masters/EP02/v1.mp4", duration_seconds: 175 },
  }));
  svc.submitForReview(cmd({
    eventId: "ev-ep02-submit-1", actor: A.chen,
    episodeId: "EP02", targetAuthority: "省广电局政务窗口",
  }));
  svc.approveReview(cmd({
    eventId: "ev-ep02-approve-1", actor: A.jian,
    episodeId: "EP02", approvalDocHash: "hash-approval-ep02-1",
  }));
  svc.publishReleasePackage(cmd({
    eventId: "ev-ep02-pkg-1", actor: A.fang,
    packageId: "pkg-ep02-domestic", programId: "PRG-CD-02", episodeId: "EP02",
    rightsScriptIds: ["script-cd-01"],
  }));

  // 海外版本：精确触发重审；重签后放行海外包
  const overseas = svc.replaceMaster(cmd({
    eventId: "ev-ep02-master-intl", actor: A.lin,
    episodeId: "EP02", overseasVersion: true,
    master: { hash: "hash-master-ep02-intl", uri: "s3://masters/EP02/intl.mp4", duration_seconds: 176 },
    reason: "北美平台剪辑版",
  }));
  ids.ep02OverseasTrigger = overseas.triggered.event_id;

  blocked.push({ case: "submit_before_resign_after_reassessment", ...tryGuard(() => svc.submitForReview({
    eventId: "ev-ep02-submit-x", occurredAt: at(next()), actor: A.chen,
    episodeId: "EP02", targetAuthority: "省广电局政务窗口",
  })) });

  svc.signClassification(cmd({
    eventId: "ev-ep02-sign-2", actor: A.he,
    episodeId: "EP02", path: "provincial_administration_submission",
  }));
  svc.submitForReview(cmd({
    eventId: "ev-ep02-submit-2", actor: A.chen,
    episodeId: "EP02", targetAuthority: "省广电局政务窗口",
  }));
  svc.approveReview(cmd({
    eventId: "ev-ep02-approve-2", actor: A.jian,
    episodeId: "EP02", approvalDocHash: "hash-approval-ep02-2",
  }));
  svc.publishReleasePackage(cmd({
    eventId: "ev-ep02-pkg-intl", actor: A.fang,
    packageId: "pkg-ep02-intl", programId: "PRG-CD-02-I", episodeId: "EP02",
    rightsScriptIds: ["script-cd-01"],
  }));
  svc.grantReleaseAccess(cmd({
    eventId: "ev-ep02-grant-intl", actor: A.fang,
    packageId: "pkg-ep02-intl", receiverId: "plat-overseas", receiverName: "海外流媒体平台",
  }));

  return { ledger, events: ledger.all(), ids, blocked, retries, actors: A };
}
