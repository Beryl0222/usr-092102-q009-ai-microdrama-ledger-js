/**
 * 事件归约：把追加账本回放为当前总账投影。
 * 纯函数 fold(state, event)，状态可整体重建；v1 五类无 payload 的旧事件同样可回放。
 */

export function createState() {
  return {
    /** @type {Map<string, object>} asset_id → 资产 */
    assets: new Map(),
    /** @type {Map<string, object>} */
    characters: new Map(),
    /** @type {Map<string, object>} episode_id → 冻结制作口径 */
    scopes: new Map(),
    /** @type {Map<string, object>} shot_id → 镜头 */
    shots: new Map(),
    /** @type {Map<string, object>} episode_id → 成片 */
    cuts: new Map(),
    /** @type {Map<string, object>} script_id → 剧本权利 */
    rights: new Map(),
    /** @type {object[]} 贡献明细分账 */
    contributions: [],
    /** @type {Map<string, object[]>} episode_id → 实际成本明细 */
    costs: new Map(),
    /** @type {Map<string, object>} episode_id → 审核卷宗 */
    reviews: new Map(),
    /** @type {Map<string, object>} v1 遗留 review_submission 流 */
    legacySubmissions: new Map(),
    /** @type {Map<string, object>} package_id → 发行包 */
    releases: new Map(),
    /** 所有曾被否决的资产 hash，跨集永久拉黑 */
    rejectedAssetHashes: new Set(),
    /** content_hash → asset_id 索引（帧溯源） */
    hashIndex: new Map(),
  };
}

function p(event) {
  return event.payload ?? {};
}

export function fold(state, event) {
  const payload = p(event);
  switch (event.event_type) {
    // ---------- v1 遗留事件：无 payload 时保留最小语义 ----------
    case "ASSET_GENERATED": {
      const id = payload.asset_id ?? event.aggregate_id;
      if (!state.assets.has(id)) {
        state.assets.set(id, {
          asset_id: id,
          kind: payload.kind ?? "unknown",
          uri: payload.uri ?? null,
          content_hash: payload.content_hash ?? null,
          model: payload.model ?? null,
          prompt_summary: payload.prompt_summary ?? event.summary,
          prompt_input_ref: payload.prompt_input_ref ?? null,
          personal_reference: payload.personal_reference ?? false,
          source_asset_ids: payload.source_asset_ids ?? [],
          character_id: payload.character_id ?? null,
          continuity_base: payload.continuity_base ?? null,
          shot_id: payload.shot_id ?? null,
          episode_id: payload.episode_id ?? null,
          created_by: event.actor?.person_id ?? null,
          generated_event: event.event_id,
          generated_at: event.occurred_at,
          status: "generated",
        });
        if (payload.content_hash) state.hashIndex.set(payload.content_hash, id);
      }
      return state;
    }
    case "CUT_SEALED": {
      const episodeId = payload.episode_id ?? event.aggregate_id;
      const existing = state.cuts.get(episodeId);
      const record = existing ?? {
        episode_id: episodeId,
        program_id: payload.program_id ?? null,
        versions: [],
        master: null,
        asset_ids: [],
      };
      record.program_id = payload.program_id ?? record.program_id;
      record.asset_ids = payload.asset_ids ?? record.asset_ids;
      if (payload.master) record.master = { ...payload.master, sealed_event: event.event_id, sealed_at: event.occurred_at };
      record.versions.push({ type: "sealed", event_id: event.event_id, at: event.occurred_at, master_hash: payload.master?.hash ?? null });
      state.cuts.set(episodeId, record);
      return state;
    }
    case "TIER_ASSESSED": {
      // v1：档位评估遗留流，保留为历史，不替代 v2 签署卷宗
      state.legacySubmissions.set(event.aggregate_id, {
        submission_id: event.aggregate_id,
        tier_assessment: { event_id: event.event_id, at: event.occurred_at, summary: event.summary, payload },
      });
      return state;
    }
    case "REVIEW_DECIDED": {
      const legacy = state.legacySubmissions.get(event.aggregate_id) ?? { submission_id: event.aggregate_id };
      legacy.decision = { event_id: event.event_id, at: event.occurred_at, summary: event.summary, by: event.actor?.person_id ?? null, payload };
      state.legacySubmissions.set(event.aggregate_id, legacy);
      return state;
    }
    case "RELEASE_DELIVERED": {
      const episodeId = payload.episode_id ?? event.aggregate_id;
      const cut = state.cuts.get(episodeId);
      if (cut) {
        cut.legacy_delivery = { event_id: event.event_id, at: event.occurred_at, summary: event.summary };
        state.cuts.set(episodeId, cut);
      }
      return state;
    }

    // ---------- v2 ----------
    case "SCRIPT_RIGHTS_REGISTERED": {
      state.rights.set(payload.script_id, {
        script_id: payload.script_id,
        title: payload.title,
        right_holder: payload.right_holder,
        authors: payload.authors ?? [],
        license_scope: payload.license_scope,
        territories: payload.territories ?? [],
        expires_at: payload.expires_at ?? null,
        doc_hash: payload.doc_hash,
        registered_at: event.occurred_at,
      });
      return state;
    }

    case "PRODUCTION_SCOPE_FROZEN": {
      state.scopes.set(payload.episode_id, {
        episode_id: payload.episode_id,
        series_id: payload.series_id ?? null,
        program_id: payload.program_id ?? null,
        genre: payload.genre,
        investment_amount: payload.investment_amount,
        currency: payload.currency ?? "CNY",
        frozen_at: event.occurred_at,
        frozen_by: event.actor?.person_id ?? null,
        amendments: [],
      });
      return state;
    }

    case "PRODUCTION_SCOPE_AMENDED": {
      const scope = state.scopes.get(payload.episode_id);
      if (scope) {
        const before = { genre: scope.genre, investment_amount: scope.investment_amount };
        if (payload.genre !== undefined) scope.genre = payload.genre;
        if (payload.investment_amount !== undefined) scope.investment_amount = payload.investment_amount;
        scope.amendments.push({
          event_id: event.event_id,
          at: event.occurred_at,
          changed_fields: payload.changed_fields ?? [],
          before,
          after: { genre: scope.genre, investment_amount: scope.investment_amount },
          reason: payload.reason ?? null,
        });
      }
      return state;
    }

    case "CHARACTER_BASELINE_LOCKED": {
      state.characters.set(payload.character_id, {
        character_id: payload.character_id,
        name: payload.name ?? payload.character_id,
        baseline_asset_id: payload.baseline_asset_id,
        baseline_hash: payload.baseline_hash,
        locked_in_episode: payload.episode_id,
        locked_at: event.occurred_at,
        locked_by: event.actor?.person_id ?? null,
      });
      return state;
    }

    case "SHOT_REJECTED": {
      const shot = state.shots.get(payload.shot_id) ?? { shot_id: payload.shot_id, episode_id: payload.episode_id ?? null, revisions: [] };
      shot.status = "rejected";
      shot.rejected_at = event.occurred_at;
      shot.rejection_reason = payload.reason;
      shot.rejection_note = payload.note ?? null;
      shot.rejected_by = event.actor?.person_id ?? null;
      state.shots.set(payload.shot_id, shot);
      if (payload.asset_id) {
        const asset = state.assets.get(payload.asset_id);
        if (asset) {
          asset.status = "rejected";
          asset.rejection_reason = payload.reason;
          state.assets.set(payload.asset_id, asset);
        }
        if (payload.asset_hash) state.rejectedAssetHashes.add(payload.asset_hash);
      }
      return state;
    }

    case "SHOT_REGENERATION_REQUESTED": {
      state.shots.set(payload.new_shot_id, {
        shot_id: payload.new_shot_id,
        episode_id: payload.episode_id ?? null,
        parent_shot_id: payload.parent_shot_id,
        status: "requested",
        revisions: [],
        requested_at: event.occurred_at,
      });
      return state;
    }

    case "SHOT_MANUALLY_REVISED": {
      const shot = state.shots.get(payload.shot_id) ?? { shot_id: payload.shot_id, episode_id: payload.episode_id ?? null, revisions: [] };
      shot.revisions.push({
        event_id: event.event_id,
        revised_asset_id: payload.revised_asset_id,
        editor_id: event.actor?.person_id ?? null,
        note: payload.note ?? null,
        at: event.occurred_at,
      });
      if (shot.status !== "rejected") shot.status = "revised";
      state.shots.set(payload.shot_id, shot);
      return state;
    }

    case "TAKE_ACCEPTED": {
      const shot = state.shots.get(payload.shot_id) ?? { shot_id: payload.shot_id, revisions: [] };
      shot.status = "accepted";
      shot.accepted_asset_id = payload.asset_id;
      shot.accepted_at = event.occurred_at;
      state.shots.set(payload.shot_id, shot);
      const asset = state.assets.get(payload.asset_id);
      if (asset) {
        asset.status = "accepted";
        state.assets.set(payload.asset_id, asset);
      }
      return state;
    }

    case "VOICE_MUSIC_LINKED": {
      const asset = state.assets.get(payload.asset_id);
      if (asset) {
        asset.audio = {
          kind: payload.audio_kind, // voice | music
          title: payload.title ?? null,
          contributor_id: payload.contributor_id ?? null,
          source: payload.source ?? null,
          license_doc_hash: payload.license_doc_hash ?? null,
        };
        state.assets.set(payload.asset_id, asset);
      }
      return state;
    }

    case "CONTRIBUTION_LEDGERED": {
      state.contributions.push({
        entry_id: payload.entry_id ?? event.aggregate_id,
        person_id: payload.person_id,
        display_name: payload.display_name ?? null,
        episode_id: payload.episode_id,
        asset_ids: payload.asset_ids ?? [],
        roles: payload.roles ?? [],
        revenue_share_bps: payload.revenue_share_bps ?? 0,
        note: payload.note ?? null,
        ledgered_at: event.occurred_at,
      });
      return state;
    }

    case "COST_LEDGERED": {
      const list = state.costs.get(payload.episode_id) ?? [];
      list.push({
        cost_id: payload.cost_id ?? event.event_id,
        amount: payload.amount,
        currency: payload.currency ?? "CNY",
        category: payload.category,
        causal_event_id: payload.causal_event_id ?? null,
        at: event.occurred_at,
      });
      state.costs.set(payload.episode_id, list);
      return state;
    }

    case "REVIEW_PATH_SUGGESTED": {
      const existing = state.reviews.get(payload.episode_id);
      const review = existing ?? {
        episode_id: payload.episode_id,
        suggestions: [],
        signed_path: null,
        signed_by: null,
        signed_at: null,
        submissions: [],
        reassessments: [],
        status: "suggested",
        current_round: 0,
        approved_master_hash: null,
      };
      review.suggestions.push({
        event_id: event.event_id,
        suggested_path: payload.suggested_path,
        reasons: payload.reasons ?? [],
        based_on: payload.based_on ?? null,
        at: event.occurred_at,
      });
      review.suggested_path = payload.suggested_path;
      review.suggested_reasons = payload.reasons ?? [];
      review.suggested_at = event.occurred_at;
      state.reviews.set(payload.episode_id, review);
      return state;
    }

    case "REVIEW_CLASSIFICATION_SIGNED": {
      const review = state.reviews.get(payload.episode_id);
      if (review) {
        review.signed_path = payload.path;
        review.signed_by = event.actor.person_id;
        review.signed_at = event.occurred_at;
        review.advisory_override = payload.advisory_override ?? false;
        review.justification = payload.justification ?? null;
        review.status = "signed";
        state.reviews.set(payload.episode_id, review);
      }
      return state;
    }

    case "REVIEW_SUBMITTED":
    case "REVIEW_RESUBMITTED": {
      const review = state.reviews.get(payload.episode_id);
      if (review) {
        const round = (review.current_round ?? 0) + 1;
        review.current_round = round;
        review.submissions.push({
          round,
          kind: event.event_type === "REVIEW_SUBMITTED" ? "submit" : "resubmit",
          event_id: event.event_id,
          path: payload.path ?? review.signed_path,
          target_authority: payload.target_authority ?? null,
          package_hash: payload.package_hash ?? null,
          at: event.occurred_at,
          by: event.actor.person_id,
          decision: null,
        });
        review.status = "submitted";
        state.reviews.set(payload.episode_id, review);
      }
      return state;
    }

    case "REVIEW_RETURNED": {      const review = state.reviews.get(payload.episode_id);
      if (review) {
        const open = [...review.submissions].reverse().find((s) => s.decision === null);
        const record = open ?? {
          round: (review.current_round || 1),
          kind: "submit",
          event_id: null,
          at: null,
          by: null,
        };
        record.decision = "returned";
        record.returned_event_id = event.event_id;
        record.return_reasons = payload.reasons ?? [];
        record.returned_at = event.occurred_at;
        record.returned_by = event.actor?.person_id ?? null;
        if (!open) review.submissions.push(record);
        review.status = "returned";
        state.reviews.set(payload.episode_id, review);
      }
      return state;
    }

    case "REVIEW_APPROVED": {
      const review = state.reviews.get(payload.episode_id);
      if (review) {
        const open = [...review.submissions].reverse().find((s) => s.decision === null);
        if (open) {
          open.decision = "approved";
          open.approved_event_id = event.event_id;
          open.approved_at = event.occurred_at;
          open.approved_by = event.actor?.person_id ?? null;
          open.approval_doc_hash = payload.approval_doc_hash ?? null;
        }
        review.status = "approved";
        review.approved_master_hash = payload.master_hash ?? review.approved_master_hash;
        state.reviews.set(payload.episode_id, review);
      }
      return state;
    }

    case "REVIEW_REASSESSMENT_TRIGGERED": {
      const review = state.reviews.get(payload.episode_id);
      if (review) {
        review.reassessments.push({
          event_id: event.event_id,
          trigger: payload.trigger,
          reason: payload.reason ?? null,
          before_path: payload.before_path ?? review.signed_path,
          at: event.occurred_at,
          by: event.actor?.person_id ?? "system",
        });
        // 触发重审后，原签署分类失效，等待重新签署；已提交的不撤回（历史保留）
        review.status = "reassessment_required";
        review.signed_path = null;
        review.signed_by = null;
        review.signed_at = null;
        state.reviews.set(payload.episode_id, review);
      }
      return state;
    }

    case "MASTER_REPLACED": {
      const cut = state.cuts.get(payload.episode_id);
      if (cut) {
        cut.versions.push({
          type: "replaced",
          event_id: event.event_id,
          at: event.occurred_at,
          previous_master_hash: payload.previous_master_hash,
          master_hash: payload.master?.hash ?? null,
          reason: payload.reason,
          overseas_version: payload.overseas_version ?? false,
        });
        cut.master = { ...payload.master, sealed_event: event.event_id, replaced_at: event.occurred_at };
        state.cuts.set(payload.episode_id, cut);
      }
      return state;
    }

    case "RELEASE_PACKAGE_PUBLISHED": {
      state.releases.set(payload.package_id, {
        package_id: payload.package_id,
        program_id: payload.program_id,
        episode_id: payload.episode_id,
        master: payload.master,
        rights_proofs: payload.rights_proofs ?? [],
        published_at: event.occurred_at,
        published_by: event.actor.person_id,
        active: true,
        grants: [],
      });
      return state;
    }

    case "RELEASE_ACCESS_GRANTED": {
      const pkg = state.releases.get(payload.package_id);
      if (pkg) {
        pkg.grants.push({
          receiver_id: payload.receiver_id,
          receiver_name: payload.receiver_name ?? null,
          scope: payload.scope ?? "master_delivery",
          at: event.occurred_at,
        });
        state.releases.set(payload.package_id, pkg);
      }
      return state;
    }

    default:
      return state;
  }
}

export function replay(events) {
  const state = createState();
  for (const event of events) fold(state, event);
  return state;
}

/** 实际成本汇总。 */
export function totalCost(state, episodeId, currency = "CNY") {
  return (state.costs.get(episodeId) ?? [])
    .filter((c) => c.currency === currency)
    .reduce((sum, c) => sum + c.amount, 0);
}
