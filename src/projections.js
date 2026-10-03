import { aggregateTypes as AT, eventTypes as ET } from "./domain.js";
import { canonicalJson, sha256Hex } from "./crypto.js";
import { buildLineageGraph, nodeKey, traceAsset } from "./lineage.js";
import { reduceEvents } from "./state.js";

/**
 * 只读投影：同一条事件日志，面向四类读者给出不同形状的视图。
 * 投影不持有任何写权限；访问边界在投影结构里固化——
 * 尤其是发行平台视图，构造上就不引用提示、个人素材与未采用产物。
 */

// ---------------------------------------------------------------------------
// 1. 制片人：线上一帧 -> 来源 / 成本 / 贡献 / 审核状态
// ---------------------------------------------------------------------------

/**
 * @param {object} events
 * @param {object} opts
 * @param {string} opts.productionId
 * @param {number} opts.episodeNo
 * @param {number} opts.cutRevision 定位的封版版本
 * @param {number} opts.timeSec    线上时间点（秒）
 */
export function frameProvenance(events, opts) {
  const state = reduceEvents(events);
  const graph = buildLineageGraph(events, state);
  const cutKey = nodeKey(AT.EPISODE_CUT, `cut:${opts.productionId}:E${String(opts.episodeNo).padStart(3, "0")}`);
  const ep = state.episodes.get(cutKey.slice(`${AT.EPISODE_CUT}:`.length));
  if (!ep) return { found: false, reason: "集次不存在" };
  const seal = ep.sealedRevisions.get(opts.cutRevision);
  if (!seal) return { found: false, reason: `封版 rev${opts.cutRevision} 不存在` };

  const segment = (seal.timeline ?? []).find((s) => opts.timeSec >= s.start_sec && opts.timeSec < s.end_sec);
  if (!segment) return { found: false, reason: "该时间点不在任何镜头段内" };

  const trace = traceAsset(graph, segment.asset_id);
  return {
    found: true,
    query: { ...opts },
    master_sha256: seal.master_sha256,
    frame: {
      asset_id: segment.asset_id,
      shot_code: segment.shot_code ?? null,
      window: { start_sec: segment.start_sec, end_sec: segment.end_sec },
    },
    provenance: trace,
  };
}

// ---------------------------------------------------------------------------
// 2. 创作者：署名与分账自检
// ---------------------------------------------------------------------------

export function creatorStatement(events, personId, distributableByProduction = {}) {
  const state = reduceEvents(events);
  const entries = [...state.contributions.values()].filter((c) => c.person_id === personId);

  const perProduction = new Map();
  for (const c of entries) {
    const bucket = perProduction.get(c.production_id) ?? {
      production_id: c.production_id,
      person: { id: c.person_id, name: c.person_name },
      credits: [],
      share_lines: [],
      generated_assets: [],
      cost_basis_total: null,
      projected_payout: 0,
      payout_computable: true,
    };

    bucket.credits.push({ episode_no: c.episode_no, roles: c.roles, asset_ids: c.asset_ids });

    const terms = c.share_terms ?? {};
    const distributable = distributableByProduction[c.production_id];
    let lineAmount = null;
    if (terms.basis === "percent") {
      if (typeof distributable === "number") lineAmount = (distributable * Number(terms.value)) / 100;
      else bucket.payout_computable = false;
      bucket.share_lines.push({
        episode_no: c.episode_no,
        basis: "percent",
        value: terms.value,
        amount: lineAmount,
      });
    } else if (terms.basis === "fixed") {
      lineAmount = Number(terms.value);
      bucket.share_lines.push({ episode_no: c.episode_no, basis: "fixed", value: terms.value, amount: lineAmount });
    } else {
      bucket.share_lines.push({ episode_no: c.episode_no, ...terms, amount: null });
      bucket.payout_computable = false;
    }
    if (lineAmount != null) bucket.projected_payout += lineAmount;

    perProduction.set(c.production_id, bucket);
  }

  for (const bucket of perProduction.values()) {
    const prod = state.productions.get(bucket.production_id);
    // 冻结投资口径（财务统计基准）与实际入账成本是两个口径，分开展示
    bucket.frozen_investment_basis = prod?.scope?.investment_basis ?? null;
    bucket.actual_cost_total = prod ? prod.costTotal : null;
    bucket.cost_basis_total = bucket.actual_cost_total;
    // 本人实际操作过的产物（生成/修订），便于核对署名是否覆盖
    bucket.generated_assets = [...state.assets.values()]
      .filter((a) => a.generated_by === personId)
      .map((a) => ({ asset_id: a.asset_id, episode_no: a.episode_no, shot_code: a.shot_code, via: a.event_type }));
    if (!bucket.payout_computable) bucket.projected_payout = null;
  }

  return { person_id: personId, productions: [...perProduction.values()] };
}

// ---------------------------------------------------------------------------
// 3. 发行平台：最小披露包（结构上不包含提示/个人素材/未采用产物）
// ---------------------------------------------------------------------------

/** 明确不进入发行包的字段与产物类型（测试会对输出包做缺席断言）。 */
export const RESTRICTED_FROM_PLATFORM = Object.freeze([
  "prompt_input",
  "prompt_digest",
  "source_account_id",
  "personal_material",
  "rejected_shot",
  "unused_asset",
  "internal_cost",
  "person_contact",
]);

/**
 * @param {object} events
 * @param {object} opts
 * @param {string} opts.productionId
 * @param {string} opts.platformId
 */
export function platformPackage(events, opts) {
  const state = reduceEvents(events);
  const grant = [...state.grants.values()].find(
    (g) => g.production_id === opts.productionId && g.platform_id === opts.platformId,
  );
  if (!grant) return { available: false, reason: "不存在交付授权" };

  const master = state.masters.get(grant.master_ref);
  const rights = grant.rights_proof_refs.map((ref) => {
    const r = state.scripts.get(ref);
    // 必要权利证明：仅释放对外履约所需的字段，证据以引用+摘要形式给出
    return {
      right_id: ref,
      rights_owner: r.rights_owner,
      license_scope: r.license_scope,
      evidence_ref: r.evidence_ref,
      digest: r.digest,
    };
  });

  return {
    available: !grant.suspended,
    suspended: grant.suspended,
    suspend_reason: grant.suspend_reason ?? null,
    delivered_at: grant.delivered_at,
    package: {
      program_id: grant.program_id,
      platform_id: grant.platform_id,
      production_id: grant.production_id,
      master: { ref: grant.master_ref, sha256: master?.master_sha256 ?? grant.master_sha256 },
      rights_proofs: rights,
      package_digest: grant.package_digest,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. 监管导出：每次提交、退回、替换的完整历史
// ---------------------------------------------------------------------------

export function regulatoryExport(events, productionId, opts = {}) {
  const state = reduceEvents(events);
  const prod = state.productions.get(productionId);
  if (!prod) return { production_id: productionId, found: false };

  const relevantTypes = new Set([
    ET.SCOPE_FROZEN,
    ET.SCOPE_REVISED,
    ET.COST_POSTED,
    ET.CUT_SEALED,
    ET.CUT_REVISED,
    ET.TIER_ASSESSED,
    ET.REVIEW_SUBMITTED,
    ET.REVIEW_RESUBMITTED,
    ET.REVIEW_DECIDED,
    ET.REREVIEW_TRIGGERED,
    ET.MASTER_RELEASED,
    ET.OVERSEAS_VERSION_CREATED,
    ET.RELEASE_DELIVERED,
    ET.DISTRIBUTION_SUSPENDED,
  ]);

  const trail = events
    .filter(
      (e) =>
        (e.correlation_id === productionId || e.payload?.production_id === productionId) && relevantTypes.has(e.event_type),
    )
    .map((e) => ({
      event_id: e.event_id,
      event_type: e.event_type,
      aggregate_type: e.aggregate_type,
      aggregate_id: e.aggregate_id,
      version: e.version,
      occurred_at: e.occurred_at,
      actor_id: e.actor_id ?? null,
      causation_id: e.causation_id ?? null,
      payload: e.payload,
      ...(e.signature
        ? { signer: { id: e.signature.signer_id, role: e.signature.signer_role, signed_at: e.signature.signed_at } }
        : {}),
    }));

  // 按集组织的审核档案：建议、每次提交/替换、每次决定、每次重审触发，保留 supersedes 链
  const episodes = [...state.reviews.values()]
    .filter((r) => r.production_id === productionId)
    .map((r) => ({
      episode_no: r.episode_no,
      suggested_path: r.suggestion?.path ?? null,
      suggestion_reasons: r.suggestion?.reasons ?? [],
      scope_snapshot_at_assessment: r.suggestion?.scope_snapshot ?? null,
      submissions: r.submissions,
      decisions: r.history.filter((h) => h.kind === "decision"),
      rereview_triggers: r.rereviewTriggers,
      replacement_chain: buildReplacementChain(r.submissions),
      current: {
        decision: r.decided?.decision ?? null,
        classification: r.decided?.classification ?? null,
        signed_path: r.decided?.path ?? null,
        pending_rereview: r.pendingRereview,
      },
    }))
    .sort((a, b) => a.episode_no - b.episode_no);

  const body = {
    production_id: productionId,
    found: true,
    title: prod.title,
    frozen_scope: prod.scope,
    cost_total: prod.costTotal,
    currency: prod.currency,
    exported_at: opts.exportedAt ?? new Date().toISOString(),
    episodes,
    event_trail: trail,
  };
  return { ...body, manifest: { event_count: trail.length, sha256: sha256Hex(canonicalJson(body)) } };
}

function buildReplacementChain(submissions) {
  const byId = new Map(submissions.map((s) => [s.event_id, s]));
  const chains = [];
  for (const s of submissions) {
    if (s.kind !== "resubmit") continue;
    const chain = [];
    let cur = s;
    const guard = new Set();
    while (cur && !guard.has(cur.event_id)) {
      guard.add(cur.event_id);
      chain.unshift({ event_id: cur.event_id, kind: cur.kind, at: cur.at, cut_revision: cur.cut_revision, status: cur.status });
      cur = cur.supersedes_event_id ? byId.get(cur.supersedes_event_id) : null;
    }
    chains.push(chain);
  }
  return chains;
}
