import { replay } from "./state.js";
import { ErrorCodes, LedgerError } from "./errors.js";

/**
 * 谱系与连续性不变量。
 *
 * 谱系由 ASSET_GENERATED.payload.source_asset_ids 构成有向图：
 * 新产物的边指向其全部来源（角色图、场景板、提示摘要对应资产、被修订镜头等）。
 */

/** 构建资产有向谱系（邻接表，asset_id → 来源 asset_id[]）。 */
export function buildLineage(events) {
  const edges = new Map();
  const meta = new Map();
  for (const e of events) {
    if (e.event_type !== "ASSET_GENERATED") continue;
    const id = e.payload?.asset_id ?? e.aggregate_id;
    if (!meta.has(id)) {
      meta.set(id, {
        asset_id: id,
        kind: e.payload?.kind ?? "unknown",
        content_hash: e.payload?.content_hash ?? null,
        character_id: e.payload?.character_id ?? null,
        shot_id: e.payload?.shot_id ?? null,
        episode_id: e.payload?.episode_id ?? null,
        model: e.payload?.model ?? null,
        generated_event: e.event_id,
      });
    }
    const sources = e.payload?.source_asset_ids ?? [];
    edges.set(id, [...new Set([...(edges.get(id) ?? []), ...sources])]);
  }
  return { edges, meta };
}

/** 沿 source_asset_ids 向上收集全部祖先（含自身）。 */
export function ancestorsOf(lineage, assetId) {
  const out = new Set();
  const stack = [assetId];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    out.add(cur);
    for (const src of lineage.edges.get(cur) ?? []) stack.push(src);
  }
  return out;
}

/**
 * 被否决的镜头不得重新混入后继集次：
 * 检查候选资产（及任意深度来源）是否落在被否决集合中。
 * rejectedAssetHashes 来自归约状态（跨集持久），shotRejectedAssetIds 为本次候选集内显式否决的资产。
 */
export function assertNoRejectedAncestor(lineage, candidateAssetId, rejectedHashes, extraRejectedAssetIds = []) {
  const ancestors = ancestorsOf(lineage, candidateAssetId);
  for (const ancestorId of ancestors) {
    const info = lineage.meta.get(ancestorId);
    if (extraRejectedAssetIds.includes(ancestorId)) {
      throw new LedgerError(
        ErrorCodes.REJECTED_ANCESTOR,
        `资产 ${candidateAssetId} 的来源 ${ancestorId} 属于被否决镜头，禁止混入后继集次`,
        { candidate: candidateAssetId, rejected_ancestor: ancestorId },
      );
    }
    if (info?.content_hash && rejectedHashes.has(info.content_hash)) {
      throw new LedgerError(
        ErrorCodes.REJECTED_ANCESTOR,
        `资产 ${candidateAssetId} 的来源 ${ancestorId}（hash ${info.content_hash}）已被否决，禁止复用`,
        { candidate: candidateAssetId, rejected_ancestor: ancestorId, content_hash: info.content_hash },
      );
    }
  }
}

/**
 * 跨集复用角色时锁定连续性基线：
 * 新资产若声明 continuity_base.character_id，其指纹必须与该角色锁定基线一致；
 * 未锁定基线的角色不允许在锁定集之外使用。
 */
export function assertBaselineLock(state, lineage, candidate) {
  const base = candidate.payload?.continuity_base;
  if (!base?.character_id) return; // 非角色资产不适用

  const character = state.characters.get(base.character_id);
  if (!character) {
    throw new LedgerError(
      ErrorCodes.BASELINE_NOT_LOCKED,
      `角色 ${base.character_id} 尚未锁定连续性基线，跨集复用前必须先锁定`,
    );
  }
  const expected = character.baseline_hash;
  const actual = base.baseline_hash;
  if (actual !== expected) {
    throw new LedgerError(
      ErrorCodes.BASELINE_DRIFT,
      `资产 ${candidate.payload?.asset_id ?? candidate.aggregate_id} 偏离角色 ${base.character_id} 的锁定基线`,
      { character_id: base.character_id, expected, actual },
    );
  }
}

/** 便捷重放 + 双不变量校验（服务层登记新资产前调用）。 */
export function assertAssetAdmissible(ledger, candidate) {
  const events = ledger.all();
  const state = replay(events);
  const lineage = buildLineage(events);
  const assetId = candidate.payload?.asset_id ?? candidate.aggregate_id;

  // 将候选资产自身的来源边虚拟接入谱系，使其任意深度来源都可被遍历到
  lineage.edges.set(assetId, candidate.payload?.source_asset_ids ?? []);

  // 先查直接/历史否决（hash 拉黑 + 显式 rejected 状态资产）
  const rejectedAssetIds = [...state.assets.values()].filter((a) => a.status === "rejected").map((a) => a.asset_id);
  assertNoRejectedAncestor(lineage, assetId, state.rejectedAssetHashes, rejectedAssetIds);
  assertBaselineLock(state, lineage, candidate);
}

/**
 * 帧溯源：给定成片中一帧的 content_hash（或资产 id），
 * 沿谱系回溯完整来源链：模型版本、提示摘要、人工修订、配音音乐、成本、贡献与审核状态。
 */
export function traceFrame(ledger, { contentHash = null, assetId = null, episodeId = null }) {
  const events = ledger.all();
  const state = replay(events);
  const lineage = buildLineage(events);

  let rootId = assetId;
  if (!rootId && contentHash) rootId = state.hashIndex.get(contentHash) ?? null;
  if (!rootId) return null;

  const relatedIds = ancestorsOf(lineage, rootId);
  // 与该帧同一集成片的音轨/音乐虽不在镜头来源链上，但属于该帧所在母版，一并可溯
  const cut = episodeId ? state.cuts.get(episodeId) : null;
  const cutMemberIds = new Set(cut?.asset_ids ?? []);
  const audioIds = new Set([...relatedIds, ...cutMemberIds]);
  const generatedEvents = events.filter(
    (e) => e.event_type === "ASSET_GENERATED" && relatedIds.has(e.payload?.asset_id ?? e.aggregate_id),
  );

  const chain = generatedEvents.map((e) => ({
    asset_id: e.payload?.asset_id ?? e.aggregate_id,
    kind: e.payload?.kind ?? "unknown",
    content_hash: e.payload?.content_hash ?? null,
    model: e.payload?.model ?? null,
    prompt_summary: e.payload?.prompt_summary ?? null,
    personal_reference: e.payload?.personal_reference ?? false,
    sources: e.payload?.source_asset_ids ?? [],
    created_by: e.actor?.person_id ?? null,
    generated_at: e.occurred_at,
  }));

  // 人工修订
  const revisions = events
    .filter((e) => e.event_type === "SHOT_MANUALLY_REVISED")
    .filter((e) => relatedIds.has(e.payload?.revised_asset_id))
    .map((e) => ({
      asset_id: e.payload.revised_asset_id,
      editor_id: e.actor?.person_id ?? null,
      note: e.payload?.note ?? null,
      at: e.occurred_at,
    }));

  // 配音/音乐：镜头来源链 + 同集成片成员
  const audio = [...audioIds]
    .map((id) => state.assets.get(id))
    .filter((a) => a?.audio)
    .map((a) => ({ asset_id: a.asset_id, ...a.audio }));

  // 成本：按 causal_event_id 精确归集链上的生成与人工修订事件；
  // 未标注因果的集级公共成本（causal_event_id=null）一并列出。
  const causalIds = new Set(generatedEvents.map((e) => e.event_id));
  for (const e of events) {
    if (e.event_type === "SHOT_MANUALLY_REVISED" && relatedIds.has(e.payload?.revised_asset_id)) {
      causalIds.add(e.event_id);
    }
  }
  const epCosts = episodeId ? state.costs.get(episodeId) ?? [] : [];
  const costs = epCosts.filter((c) => c.causal_event_id === null || causalIds.has(c.causal_event_id));

  // 贡献：覆盖链上任一资产或本集
  const contributions = state.contributions.filter(
    (c) => c.episode_id === episodeId && c.asset_ids.some((id) => relatedIds.has(id)),
  );

  const review = episodeId ? state.reviews.get(episodeId) ?? null : null;

  return {
    query: { content_hash: contentHash, asset_id: assetId, episode_id: episodeId },
    root_asset: rootId,
    lineage_chain: chain,
    manual_revisions: revisions,
    voice_music: audio,
    costs: episodeId ? epCosts : [],
    contributions,
    review_status: review
      ? {
          status: review.status,
          suggested_path: review.suggested_path,
          signed_path: review.signed_path,
          signed_by: review.signed_by,
          current_round: review.current_round,
        }
      : null,
  };
}
