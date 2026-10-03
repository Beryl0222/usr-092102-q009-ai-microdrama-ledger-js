import { aggregateTypes as AT, eventTypes as ET } from "./domain.js";
import { reduceEvents } from "./state.js";

/**
 * 有向谱系图：节点是聚合产物，边表示“输入 -> 输出”。
 * 边有三个来源：
 *  1. 事件信封上的 lineage（镜头生成、封版、放行、交付等显式引用，带版本）；
 *  2. CUT_SEALED.payload.timeline / audio_refs（封版消费镜头与音轨）；
 *  3. 成本与贡献事件上挂载的 asset_id / episode_no（钱和人的去向可回溯）。
 */

export const nodeKey = (type, id) => `${type}:${id}`;

export function buildLineageGraph(events, state = reduceEvents(events)) {
  const nodes = new Map(); // key -> {type,id,meta}
  const edges = []; // {from:{type,id}, to:{type,id}, viaEventId, label}
  const digestIndex = new Map(); // sha256 -> [keys]

  const ensureNode = (type, id, meta = {}) => {
    const key = nodeKey(type, id);
    if (!nodes.has(key)) nodes.set(key, { type, id, meta: { ...meta } });
    else Object.assign(nodes.get(key).meta, meta);
    return key;
  };

  const addEdge = (fromType, fromId, toType, toId, viaEventId, label) => {
    const from = ensureNode(fromType, fromId);
    const to = ensureNode(toType, toId);
    if (!edges.some((e) => e.from === from && e.to === to && e.viaEventId === viaEventId)) {
      edges.push({ from, to, viaEventId, label });
    }
  };

  for (const e of events) {
    const p = e.payload ?? {};
    const targetKey = ensureNode(e.aggregate_type, e.aggregate_id, {
      event_type: e.event_type,
      version: e.version,
      occurred_at: e.occurred_at,
      summary: e.summary,
    });

    for (const ref of e.lineage ?? []) {
      addEdge(ref.aggregate_type, ref.aggregate_id, e.aggregate_type, e.aggregate_id, e.event_id, "lineage");
    }

    if (e.event_type === ET.CUT_SEALED) {
      for (const seg of p.timeline ?? []) {
        addEdge(AT.PRODUCTION_ASSET, seg.asset_id, AT.EPISODE_CUT, e.aggregate_id, e.event_id, "timeline");
      }
      for (const audioId of p.audio_refs ?? []) {
        addEdge(AT.AUDIO_TRACK, audioId, AT.EPISODE_CUT, e.aggregate_id, e.event_id, "audio");
      }
    }

    if (e.event_type === ET.COST_POSTED) {
      if (p.asset_id) addEdge(AT.COST_ENTRY, e.aggregate_id, AT.PRODUCTION_ASSET, p.asset_id, e.event_id, "cost");
      else if (p.episode_no != null)
        addEdge(AT.COST_ENTRY, e.aggregate_id, AT.EPISODE_CUT, `cut:${p.production_id}:E${String(p.episode_no).padStart(3, "0")}`, e.event_id, "cost");
    }

    if (e.event_type === ET.CONTRIBUTION_POSTED) {
      for (const assetId of p.asset_ids ?? []) {
        addEdge(AT.CONTRIBUTION_ENTRY, e.aggregate_id, AT.PRODUCTION_ASSET, assetId, e.event_id, "contribution");
      }
      if (!(p.asset_ids?.length) && p.episode_no != null)
        addEdge(AT.CONTRIBUTION_ENTRY, e.aggregate_id, AT.EPISODE_CUT, `cut:${p.production_id}:E${String(p.episode_no).padStart(3, "0")}`, e.event_id, "contribution");
    }
  }

  // 用归约状态丰富节点元数据
  for (const asset of state.assets.values()) {
    ensureNode(AT.PRODUCTION_ASSET, asset.asset_id, {
      production_id: asset.production_id,
      sha256: asset.sha256,
      model: asset.model_provider ? `${asset.model_provider}/${asset.model_version}` : null,
      output_uri: asset.output_uri,
      episode_no: asset.episode_no,
      shot_code: asset.shot_code,
      generated_by: asset.generated_by,
    });
    if (asset.sha256) {
      const list = digestIndex.get(asset.sha256) ?? [];
      list.push(nodeKey(AT.PRODUCTION_ASSET, asset.asset_id));
      digestIndex.set(asset.sha256, list);
    }
  }
  for (const c of state.characters.values())
    ensureNode(AT.CHARACTER_ASSET, c.id, { code: c.character_code, digest: c.digest, source_account_id: c.source_account_id });
  for (const s of state.scenes.values())
    ensureNode(AT.SCENE_ASSET, s.id, { code: s.scene_code, digest: s.digest, source_account_id: s.source_account_id });
  for (const pr of state.prompts.values()) ensureNode(AT.PROMPT_INPUT, pr.id, { adopted: pr.adopted_by !== null });
  for (const sr of state.scripts.values())
    ensureNode(AT.SCRIPT_RIGHT, sr.id, { rights_owner: sr.rights_owner, license_scope: sr.license_scope });
  for (const a of state.audios.values()) ensureNode(AT.AUDIO_TRACK, a.id, { kind: a.kind, work_ref: a.work_ref });
  for (const m of state.masters.values())
    ensureNode(AT.MASTER_RELEASE, m.release_id, { master_sha256: m.master_sha256, program_id: m.program_id, scope: m.release_scope });
  for (const e of events) {
    if (e.event_type === ET.COST_POSTED) {
      ensureNode(AT.COST_ENTRY, e.aggregate_id, {
        amount: e.payload.amount,
        currency: e.payload.currency,
        category: e.payload.category,
      });
    }
    if (e.event_type === ET.CONTRIBUTION_POSTED) {
      ensureNode(AT.CONTRIBUTION_ENTRY, e.aggregate_id, {
        person: e.payload.person_name,
        roles: e.payload.roles,
      });
    }
  }

  return { nodes, edges, digestIndex, state };
}

/** 沿“输入 -> 输出”反向收集全部祖先（即某产物的完整来源）。 */
export function ancestorsOf(graph, startKey) {
  const incoming = new Map();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }
  const seen = new Set();
  const walk = (key) => {
    for (const edge of incoming.get(key) ?? []) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      walk(edge.from);
    }
  };
  walk(startKey);
  return seen;
}

/** 沿正向收集全部后继（某镜头被哪些后继集次使用）。 */
export function descendantsOf(graph, startKey) {
  const outgoing = new Map();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const seen = new Set();
  const walk = (key) => {
    for (const edge of outgoing.get(key) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      walk(edge.to);
    }
  };
  walk(startKey);
  return seen;
}

/**
 * 从一件产物（镜头/资产）生成完整溯源报告：
 * 来源素材、模型版本、人工修订、成本、人员贡献、所属封版、审核、母版与发行去向。
 */
export function traceAsset(graph, assetId, aggregateType = AT.PRODUCTION_ASSET) {
  const startKey = nodeKey(aggregateType, assetId);
  if (!graph.nodes.has(startKey)) return null;

  const ancestorKeys = ancestorsOf(graph, startKey);
  const descendantKeys = descendantsOf(graph, startKey);
  const node = graph.nodes.get(startKey);

  const pick = (keys, type) =>
    [...keys].filter((k) => k.startsWith(`${type}:`)).map((k) => ({ key: k, ...graph.nodes.get(k).meta }));

  const state = graph.state;

  const cuts = pick(descendantKeys, AT.EPISODE_CUT).map((c) => {
    const ep = state.episodes.get(c.key.split(":").slice(1).join(":"));
    return {
      cut_id: c.key.slice(`${AT.EPISODE_CUT}:`.length),
      episode_no: ep?.episode_no ?? null,
      sealed_revisions: ep ? [...ep.sealedRevisions.keys()] : [],
    };
  });

  // 审核流与镜头之间没有直接谱系边，按“本资产所属集次 + 下游集次”关联
  const episodeNos = new Set([node.meta.episode_no, ...cuts.map((c) => c.episode_no)].filter((n) => n != null));
  const reviewStatus = [...state.reviews.values()]
    .filter((r) => episodeNos.has(r.episode_no))
    .map((r) => ({
      review_id: `review:${r.production_id}:E${String(r.episode_no).padStart(3, "0")}`,
      episode_no: r.episode_no,
      suggested_path: r.suggestion?.path ?? null,
      decision: r.decided?.decision ?? null,
      classification: r.decided?.classification ?? null,
      signed_path: r.decided?.path ?? null,
      pending_rereview: r.pendingRereview,
    }));

  return {
    asset: { id: assetId, aggregate_type: aggregateType, ...node.meta },
    sources: {
      script_rights: pick(ancestorKeys, AT.SCRIPT_RIGHT),
      characters: pick(ancestorKeys, AT.CHARACTER_ASSET),
      scenes: pick(ancestorKeys, AT.SCENE_ASSET),
      prompts: pick(ancestorKeys, AT.PROMPT_INPUT),
      audio: pick(ancestorKeys, AT.AUDIO_TRACK),
    },
    costs: pick(ancestorKeys, AT.COST_ENTRY),
    contributors: pick(ancestorKeys, AT.CONTRIBUTION_ENTRY),
    used_in_cuts: cuts,
    review_status: reviewStatus,
    released_masters: pick(descendantKeys, AT.MASTER_RELEASE),
    distribution_grants: pick(descendantKeys, AT.DISTRIBUTION_GRANT),
    rejected: state.rejectedAssets.has(assetId) ? state.rejectedAssets.get(assetId) : null,
  };
}
