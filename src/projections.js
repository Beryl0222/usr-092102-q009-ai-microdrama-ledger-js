import { replay, totalCost } from "./state.js";
import { ancestorsOf, buildLineage } from "./lineage.js";

/**
 * 只读投影：服务不同角色的查询需要，且各自只能看到该角色应见的字段。
 */

/** 资产目录快照（含状态、模型、提示摘要是否被采用）。 */
export function assetCatalog(events) {
  const state = replay(events);
  const lineage = buildLineage(events);
  return [...state.assets.values()].map((a) => ({
    asset_id: a.asset_id,
    kind: a.kind,
    status: a.status,
    content_hash: a.content_hash,
    model: a.model,
    character_id: a.character_id,
    shot_id: a.shot_id,
    episode_id: a.episode_id,
    sources: lineage.edges.get(a.asset_id) ?? [],
    generated_at: a.generated_at,
  }));
}

/**
 * 创作者视角：核对署名与分账。
 * 返回该人员在指定集（或全部集）的贡献明细、角色、分成基点、
 * 以及所贡献资产最终是否进入已放行母版。
 */
export function contributorStatement(events, personId, episodeId = null) {
  const state = replay(events);
  const lineage = buildLineage(events);
  const entries = state.contributions.filter(
    (c) => c.person_id === personId && (episodeId === null || c.episode_id === episodeId),
  );

  const acceptedPackages = new Set(
    [...state.releases.values()].filter((p) => p.active).map((p) => p.master.hash),
  );

  const lines = entries.map((c) => {
    const cut = state.cuts.get(c.episode_id);
    const cutAssets = new Set(cut?.asset_ids ?? []);
    // 贡献资产本身或其后代进入成片，即视为该贡献进入成片（沿谱系向下）
    const contributedInCut = c.asset_ids.filter((id) =>
      [...cutAssets].some((cutId) => id === cutId || ancestorsOf(lineage, cutId).has(id)),
    );
    const masterReleased = cut?.master ? acceptedPackages.has(cut.master.hash) : false;
    return {
      entry_id: c.entry_id,
      episode_id: c.episode_id,
      roles: c.roles,
      asset_ids: c.asset_ids,
      assets_in_cut: contributedInCut,
      revenue_share_bps: c.revenue_share_bps,
      master_hash: cut?.master?.hash ?? null,
      master_released: masterReleased,
      ledgered_at: c.ledgered_at,
    };
  });

  return {
    person_id: personId,
    display_name: entries.find((e) => e.display_name)?.display_name ?? null,
    total_revenue_share_bps: lines.reduce((s, l) => s + l.revenue_share_bps, 0),
    entries: lines,
  };
}

/**
 * 监管导出：每次提交、退回、替换的完整历史，一条不删。
 * 含冻结口径与历次修订、建议与签署（含人工覆盖理由）、送审轮次、重审触发、母版版本链。
 */
export function regulatorDossier(events, episodeId) {
  const state = replay(events);
  const scope = state.scopes.get(episodeId) ?? null;
  const review = state.reviews.get(episodeId) ?? null;
  const cut = state.cuts.get(episodeId) ?? null;
  const costs = state.costs.get(episodeId) ?? [];

  // 原始事件留痕：监管卷宗同时给出可核验的事件 id 序列
  const rawTimeline = events
    .filter((e) => {
      const ep = e.payload?.episode_id;
      if (ep === episodeId) return true;
      // 成片流按 aggregate_id = episodeId
      return (e.event_type === "CUT_SEALED" || e.event_type === "COST_LEDGERED" || e.event_type === "MASTER_REPLACED")
        && (e.aggregate_id === episodeId || ep === episodeId);
    })
    .map((e) => ({
      event_id: e.event_id,
      event_type: e.event_type,
      aggregate_type: e.aggregate_type,
      aggregate_id: e.aggregate_id,
      version: e.version,
      occurred_at: e.occurred_at,
      actor: e.actor?.person_id ?? null,
      summary: e.summary,
    }));

  return {
    episode_id: episodeId,
    program_id: cut?.program_id ?? scope?.program_id ?? null,
    frozen_scope: scope
      ? {
          genre: scope.genre,
          investment_amount: scope.investment_amount,
          currency: scope.currency,
          frozen_at: scope.frozen_at,
          frozen_by: scope.frozen_by,
          amendments: scope.amendments,
        }
      : null,
    actual_cost_total: costs.reduce((s, c) => s + c.amount, 0),
    cost_entries: costs,
    review: review
      ? {
          status: review.status,
          suggestions: review.suggestions,
          classification: review.signed_path
            ? { path: review.signed_path, signed_by: review.signed_by, signed_at: review.signed_at,
                override: review.advisory_override ?? false, justification: review.justification ?? null }
            : null,
          submissions: review.submissions,
          reassessments: review.reassessments,
          approved_master_hash: review.approved_master_hash,
        }
      : null,
    master_versions: cut?.versions ?? [],
    current_master: cut?.master
      ? { hash: cut.master.hash, uri: cut.master.uri, checksum_alg: cut.master.checksum_alg ?? "sha256" }
      : null,
    timeline: rawTimeline,
  };
}

/** 制片主管的生产总账总览。 */
export function productionOverview(events) {
  const state = replay(events);
  return {
    counts: {
      scripts: state.rights.size,
      episodes_scoped: state.scopes.size,
      characters_locked: state.characters.size,
      assets: state.assets.size,
      shots: state.shots.size,
      contributions: state.contributions.length,
      release_packages: state.releases.size,
    },
    episodes: [...state.scopes.keys()].map((episodeId) => {
      const review = state.reviews.get(episodeId);
      const cut = state.cuts.get(episodeId);
      return {
        episode_id: episodeId,
        genre: state.scopes.get(episodeId).genre,
        frozen_investment: state.scopes.get(episodeId).investment_amount,
        actual_cost_total: totalCost(state, episodeId),
        review_status: review?.status ?? "not_started",
        signed_path: review?.signed_path ?? null,
        master_hash: cut?.master?.hash ?? null,
        amendments: state.scopes.get(episodeId).amendments.length,
      };
    }),
    rejected_hashes: [...state.rejectedAssetHashes],
  };
}
