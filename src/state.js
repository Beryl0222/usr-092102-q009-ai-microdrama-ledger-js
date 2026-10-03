import { aggregateTypes, eventTypes, reviewDecisions } from "./domain.js";

/**
 * 只归约器：把总账事件折叠成命令层所需的当前状态。
 * 归约是纯函数（同一事件序列必得同一状态），不做权限判断。
 */

function emptyProductionState() {
  return {
    opened: false,
    title: null,
    scope: null, // 最近一次冻结口径（含 frozen: true）
    scopeVersion: 0,
    costTotal: 0,
    currency: null,
    costPostedAfterSeal: new Set(), // 在首版封版后入账的 cost event_id
    sealedEpisodeCutRev: new Map(), // episode_no -> 首版封版时 cut_revision
  };
}

function emptyEpisodeState() {
  return {
    production_id: null,
    episode_no: null,
    currentRevision: 0,
    sealedRevisions: new Map(), // cut_revision -> {master_sha256, timeline, event_id}
    lastSealEventId: null,
    revisionReasons: new Map(), // cut_revision -> reason
  };
}

function emptyReviewState() {
  return {
    production_id: null,
    episode_no: null,
    suggestion: null, // 最近一次系统建议 {path, reasons, scope_snapshot}
    decided: null, // 最近一次签署决定 {decision, classification, path, cut_revision, master_sha256}
    pendingRereview: false,
    rereviewTriggers: [],
    submissions: [], // 每次提交/替换提交
    history: [], // 完整审核生命周期事件（提交/建议/决定/重审），供监管导出
  };
}

export function reduceEvents(events) {
  const state = {
    productions: new Map(),
    episodes: new Map(),
    reviews: new Map(),
    /** 制作级否决名单：asset_id -> {production_id, reason, event_id} */
    rejectedAssets: new Map(),
    /** 已登记产物指纹：sha256 -> 首次登记的 asset_id（防止否决镜头以新身份复活） */
    assetDigests: new Map(),
    /** 已登记生成产物：asset_id -> 元数据 */
    assets: new Map(),
    /** 角色连续性基线：`${production_id}:${character_id}` -> 基线 */
    baselines: new Map(),
    /** 角色首次被生成产物引用的集次（用于判定“跨集复用”） */
    characterFirstUse: new Map(),
    characters: new Map(),
    scenes: new Map(),
    prompts: new Map(),
    scripts: new Map(),
    audios: new Map(),
    contributions: new Map(), // entry id
    masters: new Map(), // release id
    releasesByEpisode: new Map(), // `${production_id}:${episode_no}:${scope}` -> release
    grants: new Map(), // platform_id -> grant 状态
    /** 已放行母版指纹集合（交付/取片校验） */
    releasedMasterDigests: new Set(),
  };

  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case eventTypes.PRODUCTION_OPENED: {
        state.productions.set(e.aggregate_id, {
          ...emptyProductionState(),
          opened: true,
          title: p.title,
          scope: { genre_scope: p.genre_scope, investment_basis: p.investment_basis, frozen: false },
          currency: p.investment_basis?.currency ?? null,
        });
        break;
      }
      case eventTypes.SCOPE_FROZEN: {
        const prod = state.productions.get(e.aggregate_id) ?? emptyProductionState();
        prod.opened = true;
        prod.scope = { genre_scope: p.genre_scope, investment_basis: p.investment_basis, frozen: true, frozen_at: p.frozen_at };
        prod.scopeVersion = e.version;
        prod.currency = p.investment_basis?.currency ?? prod.currency;
        state.productions.set(e.aggregate_id, prod);
        break;
      }
      case eventTypes.SCOPE_REVISED: {
        const prod = state.productions.get(e.aggregate_id);
        if (prod && prod.scope) {
          prod.scope = {
            ...prod.scope,
            investment_basis: p.investment_basis,
            frozen: true,
            frozen_at: p.revised_at ?? e.occurred_at,
            change_request_id: p.change_request_id,
          };
          prod.scopeVersion = e.version;
          prod.currency = p.investment_basis?.currency ?? prod.currency;
        }
        break;
      }
      case eventTypes.COST_POSTED: {
        const prod = state.productions.get(p.production_id);
        if (prod) {
          prod.costTotal += Number(p.amount) || 0;
          const firstSeal = [...prod.sealedEpisodeCutRev.values()][0];
          if (firstSeal) prod.costPostedAfterSeal.add(e.event_id);
        }
        break;
      }

      case eventTypes.SCRIPT_RIGHT_REGISTERED:
        state.scripts.set(e.aggregate_id, { ...p, id: e.aggregate_id });
        break;
      case eventTypes.CHARACTER_REGISTERED:
        state.characters.set(e.aggregate_id, {
          ...p,
          id: e.aggregate_id,
          version: e.version,
          digest: p.digest,
          // 同一角色流每次登记都留下版本指纹，供连续性基线按引用版本核验
          versions: new Map([...(state.characters.get(e.aggregate_id)?.versions ?? []), [e.version, p.digest]]),
        });
        break;
      case eventTypes.SCENE_REGISTERED:
        state.scenes.set(e.aggregate_id, { ...p, id: e.aggregate_id, version: e.version });
        break;
      case eventTypes.PROMPT_DIGEST_RECORDED:
        state.prompts.set(e.aggregate_id, { ...p, id: e.aggregate_id });
        break;
      case eventTypes.AUDIO_ADDED:
        state.audios.set(e.aggregate_id, { ...p, id: e.aggregate_id });
        break;
      case eventTypes.CONTRIBUTION_POSTED:
        state.contributions.set(e.aggregate_id, { ...p, id: e.aggregate_id });
        break;

      case eventTypes.CONTINUITY_BASELINE_LOCKED: {
        state.baselines.set(`${p.production_id}:${p.character_id}`, {
          ...p,
          baselineId: e.aggregate_id,
          lockedEventId: e.event_id,
          lockedVersion: e.version,
        });
        break;
      }

      case eventTypes.ASSET_GENERATED:
      case eventTypes.HUMAN_REVISION_RECORDED: {
        const meta = {
          asset_id: e.aggregate_id,
          production_id: p.production_id,
          sha256: p.sha256,
          model_provider: p.model_provider,
          model_version: p.model_version,
          output_uri: p.output_uri,
          asset_kind: p.asset_kind,
          episode_no: p.episode_no ?? null,
          shot_code: p.shot_code ?? null,
          generated_by: p.generated_by ?? e.actor_id ?? null,
          event_id: e.event_id,
          event_type: e.event_type,
          revision_of: p.revision_of ?? null,
          lineage: e.lineage ?? [],
          occurred_at: e.occurred_at,
        };
        state.assets.set(e.aggregate_id, meta);
        if (p.sha256 && !state.assetDigests.has(p.sha256)) state.assetDigests.set(p.sha256, e.aggregate_id);
        // 记录角色首用集次（取最早引用）
        if (p.episode_no != null) {
          for (const ref of e.lineage ?? []) {
            if (ref.aggregate_type === "character_asset" && !state.characterFirstUse.has(ref.aggregate_id)) {
              state.characterFirstUse.set(ref.aggregate_id, p.episode_no);
            }
          }
        }
        break;
      }
      case eventTypes.SHOT_REJECTED: {
        state.rejectedAssets.set(e.aggregate_id, {
          asset_id: e.aggregate_id,
          production_id: p.production_id,
          reason: p.reason,
          rejected_by: p.rejected_by,
          event_id: e.event_id,
          occurred_at: e.occurred_at,
        });
        break;
      }

      case eventTypes.CUT_SEALED: {
        const ep = state.episodes.get(e.aggregate_id) ?? emptyEpisodeState();
        ep.production_id = p.production_id;
        ep.episode_no = p.episode_no;
        ep.currentRevision = Math.max(ep.currentRevision, p.cut_revision);
        ep.sealedRevisions.set(p.cut_revision, {
          master_sha256: p.master_sha256,
          timeline: p.timeline,
          event_id: e.event_id,
          occurred_at: e.occurred_at,
        });
        ep.lastSealEventId = e.event_id;
        state.episodes.set(e.aggregate_id, ep);

        const prod = state.productions.get(p.production_id);
        if (prod && !prod.sealedEpisodeCutRev.has(p.episode_no)) {
          prod.sealedEpisodeCutRev.set(p.episode_no, p.cut_revision);
        }
        break;
      }
      case eventTypes.CUT_REVISED: {
        const ep = state.episodes.get(e.aggregate_id) ?? emptyEpisodeState();
        ep.production_id = p.production_id;
        ep.episode_no = p.episode_no;
        ep.currentRevision = Math.max(ep.currentRevision, p.cut_revision ?? 0) ;
        if (p.cut_revision) ep.revisionReasons.set(p.cut_revision, p.reason);
        state.episodes.set(e.aggregate_id, ep);
        break;
      }

      case eventTypes.TIER_ASSESSED: {
        const r = state.reviews.get(e.aggregate_id) ?? emptyReviewState();
        r.production_id = p.production_id;
        r.episode_no = p.episode_no;
        r.suggestion = { path: p.suggested_path, reasons: p.reasons, scope_snapshot: p.scope_snapshot, at: e.occurred_at };
        r.history.push({ kind: "suggestion", event_id: e.event_id, at: e.occurred_at, path: p.suggested_path, reasons: p.reasons });
        state.reviews.set(e.aggregate_id, r);
        break;
      }
      case eventTypes.REVIEW_SUBMITTED:
      case eventTypes.REVIEW_RESUBMITTED: {
        const r = state.reviews.get(e.aggregate_id) ?? emptyReviewState();
        r.production_id = p.production_id;
        r.episode_no = p.episode_no;
        const sub = {
          kind: e.event_type === eventTypes.REVIEW_SUBMITTED ? "submit" : "resubmit",
          event_id: e.event_id,
          at: e.occurred_at,
          path: p.path,
          submitted_by: p.submitted_by,
          cut_revision: p.cut_revision,
          master_sha256: p.master_sha256,
          package_digest: p.package_digest,
          supersedes_event_id: p.supersedes_event_id ?? null,
          status: "pending",
        };
        r.submissions.push(sub);
        r.history.push(sub);
        state.reviews.set(e.aggregate_id, r);
        break;
      }
      case eventTypes.REVIEW_DECIDED: {
        const r = state.reviews.get(e.aggregate_id) ?? emptyReviewState();
        r.production_id = p.production_id;
        r.episode_no = p.episode_no;
        r.decided = {
          decision: p.decision,
          classification: p.classification,
          path: p.path,
          cut_revision: p.cut_revision,
          master_sha256: p.master_sha256,
          signer: e.signature?.signer_id ?? null,
          signer_role: e.signature?.signer_role ?? null,
          at: e.occurred_at,
          event_id: e.event_id,
        };
        r.pendingRereview = false;
        const last = r.submissions[r.submissions.length - 1];
        if (last) last.status = p.decision;
        r.history.push({
          kind: "decision",
          event_id: e.event_id,
          at: e.occurred_at,
          decision: p.decision,
          classification: p.classification,
          path: p.path,
          cut_revision: p.cut_revision,
          master_sha256: p.master_sha256,
          signer: e.signature?.signer_id ?? null,
        });
        state.reviews.set(e.aggregate_id, r);
        break;
      }
      case eventTypes.REREVIEW_TRIGGERED: {
        const r = state.reviews.get(e.aggregate_id) ?? emptyReviewState();
        r.production_id = p.production_id;
        r.episode_no = p.episode_no;
        r.pendingRereview = true;
        r.rereviewTriggers.push({
          trigger: p.trigger,
          required_path: p.required_path,
          evidence_event_ids: p.evidence_event_ids,
          at: e.occurred_at,
          event_id: e.event_id,
        });
        r.history.push({
          kind: "rereview",
          event_id: e.event_id,
          at: e.occurred_at,
          trigger: p.trigger,
          required_path: p.required_path,
          evidence_event_ids: p.evidence_event_ids,
        });
        state.reviews.set(e.aggregate_id, r);
        break;
      }

      case eventTypes.MASTER_RELEASED: {
        const release = {
          release_id: e.aggregate_id,
          ...p,
          signer: e.signature?.signer_id ?? null,
          released_event_id: e.event_id,
          released_at: e.occurred_at,
        };
        state.masters.set(e.aggregate_id, release);
        state.releasesByEpisode.set(`${p.production_id}:${p.episode_no}:${p.release_scope}`, release);
        state.releasedMasterDigests.add(p.master_sha256);
        break;
      }
      case eventTypes.OVERSEAS_VERSION_CREATED: {
        state.masters.set(e.aggregate_id, {
          release_id: e.aggregate_id,
          ...p,
          is_overseas_version: true,
          created_event_id: e.event_id,
        });
        // 注意：海外草稿尚未放行，不加入 releasedMasterDigests。
        break;
      }
      case eventTypes.RELEASE_DELIVERED: {
        const grant = {
          grant_id: e.aggregate_id,
          ...p,
          delivered_event_id: e.event_id,
          delivered_at: e.occurred_at,
          suspended: false,
        };
        state.grants.set(e.aggregate_id, grant);
        break;
      }
      case eventTypes.DISTRIBUTION_SUSPENDED: {
        for (const grant of state.grants.values()) {
          if (grant.production_id === p.production_id && grant.platform_id === p.platform_id) {
            grant.suspended = true;
            grant.suspend_reason = p.reason;
          }
        }
        break;
      }

      default:
        // 未知事件（未来版本）不破坏归约
        break;
    }
  }

  return state;
}

export { aggregateTypes, reviewDecisions };
