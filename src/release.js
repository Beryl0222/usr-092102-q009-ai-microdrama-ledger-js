import { replay } from "./state.js";
import { ancestorsOf, buildLineage } from "./lineage.js";
import { ErrorCodes, LedgerError } from "./errors.js";

/**
 * 发行披露边界。
 *
 * 发行平台只能取得：已放行母版、节目编号、必要权利证明。
 * 绝不输出：未采用提示（prompt_input）、个人素材（personal_reference）、
 * 被否决镜头、人工修订草稿、未被母版引用的其他集资产。
 *
 * 语义分层：
 * - 内部谱系允许引用提示/个人素材（制片与审核需要溯源）；
 * - 被否决资产是硬禁令：无论直接成员还是任意深度来源，一律不得进入成片/母版；
 * - 提示/个人素材是披露边界：约束点在发行投影与发行包成员，releaseView 只投影最小字段。
 */

const SENSITIVE_KINDS = new Set(["prompt_input", "personal_reference"]);

/**
 * 检查一组资产的整条来源链：不含任何被否决资产（任意深度）。
 * 封版与放行共用，保证“被否决镜头不得重新混入后继集次/成片”。
 */
export function assertAssetsClean(events, assetIds) {
  const state = replay(events);
  const lineage = buildLineage(events);
  for (const id of assetIds) {
    const asset = state.assets.get(id);
    if (!asset) throw new LedgerError(ErrorCodes.UNKNOWN_ASSET, `资产不存在：${id}`);
    if (asset.status === "rejected") {
      throw new LedgerError(ErrorCodes.REJECTED_SHOT_REUSED, `资产 ${id} 已被否决，禁止使用`);
    }
    for (const ancestorId of ancestorsOf(lineage, id)) {
      const ancestor = state.assets.get(ancestorId);
      if (!ancestor) continue;
      if (ancestor.status === "rejected") {
        throw new LedgerError(
          ErrorCodes.REJECTED_ANCESTOR,
          `来源链含被否决资产：${ancestorId}`,
          { rejected_ancestor: ancestorId },
        );
      }
    }
  }
  return true;
}

/**
 * 发行包直接成员不得是敏感资产：发行包只允许母版与权利证明，
 * 提示资产、个人素材即使已被采用也只能留在内部总账，不得对外交付。
 */
export function assertNoSensitivePackaged(events, memberAssetIds) {
  const state = replay(events);
  for (const id of memberAssetIds) {
    const asset = state.assets.get(id);
    if (asset && (SENSITIVE_KINDS.has(asset.kind) || asset.personal_reference)) {
      throw new LedgerError(
        ErrorCodes.SENSITIVE_ASSET,
        `发行包成员 ${id}（${asset.kind}）属于最小披露边界之外，禁止对外交付`,
        { asset_id: id, kind: asset.kind },
      );
    }
  }
  return true;
}

/**
 * 发布前校验：待放行母版必须是该集当前母版、已通过审核、
 * 声明资产均进入成片、来源链不含被否决资产、发行包成员不含敏感资产。
 */
export function assertMasterReleasable(events, { episodeId, master, assetIds, memberAssetIds = [] }) {
  const state = replay(events);

  const cut = state.cuts.get(episodeId);
  if (!cut) throw new LedgerError(ErrorCodes.MASTER_NOT_RELEASED, `第 ${episodeId} 集尚无成片`);
  if (cut.master?.hash !== master.hash) {
    throw new LedgerError(
      ErrorCodes.MASTER_MISMATCH,
      `待放行母版 ${master.hash} 不是第 ${episodeId} 集当前母版（${cut.master?.hash ?? "无"}）`,
    );
  }
  const sealedAssets = new Set(cut.asset_ids ?? []);
  for (const id of assetIds) {
    if (!sealedAssets.has(id)) {
      throw new LedgerError(
        ErrorCodes.ASSET_NOT_IN_CUT,
        `资产 ${id} 未进入第 ${episodeId} 集成片，不能随母版放行`,
      );
    }
  }
  assertAssetsClean(events, assetIds);
  assertNoSensitivePackaged(events, memberAssetIds);
  return true;
}

/**
 * 构造给发行平台的最小化视图。只包含：
 * { package_id, program_id, episode_id, master, rights_proofs, deliveries }
 * 不含提示词、个人素材、成本、人员明细、未采用镜头。
 */
export function releaseView(events, packageId) {
  const state = replay(events);
  const pkg = state.releases.get(packageId);
  if (!pkg) {
    throw new LedgerError(ErrorCodes.MASTER_NOT_RELEASED, `发行包 ${packageId} 不存在或尚未放行`);
  }
  if (!pkg.active) {
    throw new LedgerError(ErrorCodes.PACKAGE_PUBLISHED, `发行包 ${packageId} 已停用`);
  }

  return {
    package_id: pkg.package_id,
    program_id: pkg.program_id,
    episode_id: pkg.episode_id,
    master: {
      hash: pkg.master.hash,
      uri: pkg.master.uri,
      duration_seconds: pkg.master.duration_seconds ?? null,
      checksum_alg: pkg.master.checksum_alg ?? "sha256",
    },
    // 权利证明仅给出核验所需字段，不暴露底稿全文
    rights_proofs: pkg.rights_proofs.map((r) => ({
      script_id: r.script_id,
      doc_hash: r.doc_hash,
      license_scope: r.license_scope,
      territories: r.territories ?? [],
      expires_at: r.expires_at ?? null,
    })),
    deliveries: pkg.grants.map((g) => ({
      receiver_id: g.receiver_id,
      receiver_name: g.receiver_name,
      scope: g.scope,
      delivered_at: g.at,
    })),
  };
}
