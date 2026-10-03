import { replay, totalCost } from "./state.js";
import { aggregateOf } from "./domain.js";
import { ErrorCodes, LedgerError } from "./errors.js";
import { assertAssetAdmissible } from "./lineage.js";
import { assertAssetsClean, assertMasterReleasable } from "./release.js";
import {
  DEFAULT_RULES,
  detectCostCrossing,
  detectScopeAmendment,
  suggestPath,
} from "./review.js";

/**
 * 应用服务：把业务命令翻译为追加事件，并在登记前强制执行不变量。
 * 所有命令都要求显式传入 event_id / occurred_at / actor，保证可重放、可审计。
 */

function requireRoles(cmd, allowed, label) {
  const roles = cmd.actor?.roles ?? [];
  if (!roles.some((r) => allowed.includes(r))) {
    throw new LedgerError(
      ErrorCodes.SIGNER_UNAUTHORIZED,
      `${label}需要角色之一：${allowed.join("、")}；当前为：${roles.join("、") || "无"}`,
      { required_roles: allowed, actual_roles: roles },
    );
  }
}

function emit(ledger, { eventId, type, aggregateId, occurredAt, actor, summary, payload = {}, idempotencyKey, causationId, correlationId, expectedVersion }) {
  const record = {
    event_id: eventId,
    event_type: type,
    aggregate_type: aggregateOf(type),
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version: ledger.streamVersion(aggregateId) + 1,
    summary,
  };
  if (actor) record.actor = actor;
  if (idempotencyKey) record.idempotency_key = idempotencyKey;
  if (causationId) record.causation_id = causationId;
  if (correlationId) record.correlation_id = correlationId;
  record.payload = { schema_version: 2, ...payload };
  const { event, duplicate } = ledger.append(record, expectedVersion ? { expectedVersion } : undefined);
  return { event, duplicate };
}

export function createProductionService(ledger, options = {}) {
  const rules = options.rules ?? DEFAULT_RULES;
  const roles = {
    classificationOfficer: options.classificationOfficerRoles ?? ["classification_officer"],
    reviewAuthority: options.reviewAuthorityRoles ?? ["review_authority"],
    releaseManager: options.releaseManagerRoles ?? ["release_manager"],
    continuitySupervisor: options.continuitySupervisorRoles ?? ["continuity_supervisor"],
    producer: options.producerRoles ?? ["producer"],
  };

  function state() {
    return replay(ledger.all());
  }

  /**
   * 口径变化后重算并登记系统建议（advisory）。只给建议，不改变分类：
   * 已触发重审时签署状态已清空，必须由有权人员重新签署。
   */
  function emitSuggestion(episodeId, occurredAt, basis, { causationId, eventId, note }) {
    const advisory = suggestPath(basis, rules);
    return emit(ledger, {
      eventId,
      type: "REVIEW_PATH_SUGGESTED",
      aggregateId: episodeId,
      occurredAt,
      causationId,
      correlationId: episodeId,
      summary: note ?? `系统重新建议路径：${advisory.suggested_path}（最终分类待有权人员签署）`,
      payload: {
        episode_id: episodeId,
        suggested_path: advisory.suggested_path,
        reasons: advisory.reasons,
        based_on: advisory.based_on,
      },
    }).event;
  }

  function ensureSignedForSubmit(s, episodeId, path) {
    const review = s.reviews.get(episodeId);
    if (!review?.signed_path) {
      throw new LedgerError(ErrorCodes.NOT_SIGNED, `第 ${episodeId} 集尚未完成分类签署，不能送审`);
    }
    if (review.status === "reassessment_required") {
      throw new LedgerError(ErrorCodes.NOT_SIGNED, `第 ${episodeId} 集处于重审待签署状态，必须重新分类签署后再送审`);
    }
    if (path && path !== review.signed_path) {
      throw new LedgerError(
        ErrorCodes.REVIEW_PATH_MISMATCH,
        `送审路径 ${path} 与签署路径 ${review.signed_path} 不一致`,
      );
    }
    return review;
  }

  return {
    ledger,

    registerScriptRights(cmd) {
      return emit(ledger, {
        ...cmd,
        type: "SCRIPT_RIGHTS_REGISTERED",
        aggregateId: cmd.scriptId,
        summary: cmd.summary ?? `登记剧本权利：${cmd.title ?? cmd.scriptId}`,
        payload: {
          script_id: cmd.scriptId,
          title: cmd.title,
          right_holder: cmd.rightHolder,
          authors: cmd.authors ?? [],
          license_scope: cmd.licenseScope,
          territories: cmd.territories ?? [],
          expires_at: cmd.expiresAt ?? null,
          doc_hash: cmd.docHash,
        },
      }).event;
    },

    /** 冻结制作口径（题材+投资），并由系统据此产出“建议路径”（仅建议）。 */
    freezeScope(cmd) {
      const frozen = emit(ledger, {
        ...cmd,
        type: "PRODUCTION_SCOPE_FROZEN",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `冻结第 ${cmd.episodeId} 集题材与投资口径`,
        payload: {
          episode_id: cmd.episodeId,
          series_id: cmd.seriesId ?? null,
          program_id: cmd.programId ?? null,
          genre: cmd.genre,
          investment_amount: cmd.investmentAmount,
          currency: cmd.currency ?? "CNY",
        },
      }).event;

      const scopeView = {
        genre: cmd.genre,
        investment_amount: cmd.investmentAmount,
        currency: cmd.currency ?? "CNY",
        frozen_at: cmd.occurredAt,
      };
      const advisory = suggestPath(scopeView, rules);
      const suggested = emit(ledger, {
        eventId: cmd.suggestEventId ?? `${cmd.episodeId}-path-suggested-1`,
        type: "REVIEW_PATH_SUGGESTED",
        aggregateId: cmd.episodeId,
        occurredAt: cmd.occurredAt,
        correlationId: cmd.correlationId ?? cmd.episodeId,
        causationId: frozen.event_id,
        summary: `系统建议路径：${advisory.suggested_path}（最终分类待有权人员签署）`,
        payload: {
          episode_id: cmd.episodeId,
          suggested_path: advisory.suggested_path,
          reasons: advisory.reasons,
          based_on: advisory.based_on,
        },
      }).event;

      return { frozen, suggested };
    },

    /**
     * 修订冻结口径。仅当题材变化或投资跨档时精确触发重审建议；
     * 档位内的口径修订不触发重审。
     */
    amendScope(cmd) {
      const s = state();
      const before = s.scopes.get(cmd.episodeId);
      if (!before) throw new LedgerError(ErrorCodes.SCOPE_NOT_FROZEN, `第 ${cmd.episodeId} 集口径尚未冻结`);

      const after = {
        genre: cmd.genre ?? before.genre,
        investment_amount: cmd.investmentAmount ?? before.investment_amount,
      };
      const detection = detectScopeAmendment(before, after, rules);
      const changedFields = [];
      if (cmd.genre !== undefined && cmd.genre !== before.genre) changedFields.push("genre");
      if (cmd.investmentAmount !== undefined && cmd.investmentAmount !== before.investment_amount) {
        changedFields.push("investment_amount");
      }

      const amended = emit(ledger, {
        ...cmd,
        type: "PRODUCTION_SCOPE_AMENDED",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `修订第 ${cmd.episodeId} 集口径：${changedFields.join("、") || "无实质变化"}`,
        payload: {
          episode_id: cmd.episodeId,
          genre: cmd.genre,
          investment_amount: cmd.investmentAmount,
          changed_fields: changedFields,
          reason: cmd.reason ?? null,
        },
      }).event;

      let triggered = null;
      let resuggested = null;
      if (detection.changed) {
        triggered = emit(ledger, {
          eventId: cmd.reassessmentEventId ?? `${cmd.episodeId}-reassess-scope-${before.amendments.length + 1}`,
          type: "REVIEW_REASSESSMENT_TRIGGERED",
          aggregateId: cmd.episodeId,
          occurredAt: cmd.occurredAt,
          causationId: amended.event_id,
          correlationId: cmd.correlationId ?? cmd.episodeId,
          summary: `口径${detection.genreChanged ? "题材变化" : ""}${detection.genreChanged && detection.afterBand > detection.beforeBand ? "且" : ""}${detection.afterBand > detection.beforeBand ? "投资跨档" : ""}，触发重审`,
          payload: {
            episode_id: cmd.episodeId,
            trigger: detection.trigger,
            before_path: s.reviews.get(cmd.episodeId)?.signed_path ?? null,
            reason: { genreChanged: detection.genreChanged, beforeBand: detection.beforeBand, afterBand: detection.afterBand },
          },
        }).event;
        resuggested = emitSuggestion(
          cmd.episodeId,
          cmd.occurredAt,
          { genre: after.genre, investment_amount: after.investment_amount, currency: before.currency, frozen_at: cmd.occurredAt },
          {
            causationId: triggered.event_id,
            eventId: `${cmd.episodeId}-path-resuggested-${before.amendments.length + 1}`,
            note: "口径修订后系统重新建议路径（仍须人工签署）",
          },
        );
      }
      return { amended, triggered, resuggested };
    },

    lockCharacterBaseline(cmd) {
      requireRoles(cmd, roles.continuitySupervisor, "锁定角色连续性基线");
      return emit(ledger, {
        ...cmd,
        type: "CHARACTER_BASELINE_LOCKED",
        aggregateId: cmd.characterId,
        summary: cmd.summary ?? `锁定角色 ${cmd.characterId} 连续性基线（集 ${cmd.episodeId}）`,
        payload: {
          character_id: cmd.characterId,
          name: cmd.name ?? cmd.characterId,
          baseline_asset_id: cmd.baselineAssetId,
          baseline_hash: cmd.baselineHash,
          episode_id: cmd.episodeId,
        },
      }).event;
    },

    /**
     * 登记一次真实生成产物（外部工具回调入口）。
     * - idempotency_key 保证同一回调重试/乱序只登记一次；
     * - 登记前强制：被否决来源禁入、角色基线一致。
     */
    registerAssetGenerated(cmd) {
      const payload = {
        asset_id: cmd.assetId,
        kind: cmd.kind,
        uri: cmd.uri ?? null,
        content_hash: cmd.hash,
        model: cmd.model ?? null,
        prompt_summary: cmd.promptSummary ?? null,
        prompt_input_ref: cmd.promptInputRef ?? null,
        personal_reference: cmd.personalReference ?? false,
        source_asset_ids: cmd.sourceAssetIds ?? [],
        character_id: cmd.characterId ?? null,
        continuity_base: cmd.continuityBase ?? null,
        shot_id: cmd.shotId ?? null,
        episode_id: cmd.episodeId ?? null,
      };
      // 同一命令重试：直接走追加层的 event_id / idempotency_key 去重，
      // 不重复执行准入检查，也绝不登记第二个真实产物。
      if (ledger.get(cmd.eventId)) {
        return emit(ledger, {
          ...cmd,
          type: "ASSET_GENERATED",
          aggregateId: cmd.assetId,
          idempotencyKey: cmd.idempotencyKey,
          summary: cmd.summary ?? `生成资产 ${cmd.assetId}（${cmd.kind}）`,
          payload,
        });
      }
      const candidate = { aggregate_id: cmd.assetId, payload };
      assertAssetAdmissible(ledger, candidate);
      return emit(ledger, {
        ...cmd,
        type: "ASSET_GENERATED",
        aggregateId: cmd.assetId,
        idempotencyKey: cmd.idempotencyKey,
        summary: cmd.summary ?? `生成资产 ${cmd.assetId}（${cmd.kind}）`,
        payload,
      });
    },

    rejectShot(cmd) {
      const s = state();
      return emit(ledger, {
        ...cmd,
        type: "SHOT_REJECTED",
        aggregateId: cmd.shotId,
        summary: cmd.summary ?? `镜头 ${cmd.shotId} 被否决：${cmd.reason}`,
        payload: {
          shot_id: cmd.shotId,
          episode_id: cmd.episodeId ?? s.shots.get(cmd.shotId)?.episode_id ?? null,
          asset_id: cmd.assetId ?? s.shots.get(cmd.shotId)?.accepted_asset_id ?? null,
          asset_hash: cmd.assetHash ?? null,
          reason: cmd.reason,
          note: cmd.note ?? null,
        },
      }).event;
    },

    requestRegeneration(cmd) {
      return emit(ledger, {
        ...cmd,
        type: "SHOT_REGENERATION_REQUESTED",
        aggregateId: cmd.newShotId,
        summary: cmd.summary ?? `请求重生成镜头 ${cmd.newShotId}（父镜头 ${cmd.parentShotId}）`,
        payload: {
          new_shot_id: cmd.newShotId,
          parent_shot_id: cmd.parentShotId,
          episode_id: cmd.episodeId ?? null,
        },
      }).event;
    },

    reviseShotManually(cmd) {
      return emit(ledger, {
        ...cmd,
        type: "SHOT_MANUALLY_REVISED",
        aggregateId: cmd.shotId,
        summary: cmd.summary ?? `人工修订镜头 ${cmd.shotId} → 资产 ${cmd.revisedAssetId}`,
        payload: {
          shot_id: cmd.shotId,
          episode_id: cmd.episodeId ?? null,
          revised_asset_id: cmd.revisedAssetId,
          note: cmd.note ?? null,
        },
      }).event;
    },

    acceptTake(cmd) {
      const s = state();
      const asset = s.assets.get(cmd.assetId);
      if (!asset) throw new LedgerError(ErrorCodes.UNKNOWN_ASSET, `接受镜头前资产必须已登记：${cmd.assetId}`);
      if (asset.status === "rejected") {
        throw new LedgerError(ErrorCodes.REJECTED_SHOT_REUSED, `资产 ${cmd.assetId} 已被否决，不能接受`);
      }
      return emit(ledger, {
        ...cmd,
        type: "TAKE_ACCEPTED",
        aggregateId: cmd.shotId,
        summary: cmd.summary ?? `镜头 ${cmd.shotId} 采用资产 ${cmd.assetId}`,
        payload: { shot_id: cmd.shotId, asset_id: cmd.assetId, episode_id: cmd.episodeId ?? asset.episode_id },
      }).event;
    },

    linkVoiceMusic(cmd) {
      return emit(ledger, {
        ...cmd,
        type: "VOICE_MUSIC_LINKED",
        aggregateId: cmd.assetId,
        summary: cmd.summary ?? `关联${cmd.audioKind === "voice" ? "配音" : "音乐"}：${cmd.title ?? cmd.assetId}`,
        payload: {
          asset_id: cmd.assetId,
          audio_kind: cmd.audioKind,
          title: cmd.title ?? null,
          contributor_id: cmd.contributorId ?? null,
          source: cmd.source ?? null,
          license_doc_hash: cmd.licenseDocHash ?? null,
        },
      }).event;
    },

    ledgerContribution(cmd) {
      return emit(ledger, {
        ...cmd,
        type: "CONTRIBUTION_LEDGERED",
        aggregateId: cmd.entryId,
        summary: cmd.summary ?? `${cmd.displayName ?? cmd.personId} 贡献入账：${(cmd.roles ?? []).join("、")}`,
        payload: {
          entry_id: cmd.entryId,
          person_id: cmd.personId,
          display_name: cmd.displayName ?? null,
          episode_id: cmd.episodeId,
          asset_ids: cmd.assetIds ?? [],
          roles: cmd.roles ?? [],
          revenue_share_bps: cmd.revenueShareBps ?? 0,
          note: cmd.note ?? null,
        },
      }).event;
    },

    /**
     * 登记实际成本；当累计实际成本跨入更高审核档位时，精确触发重审。
     */
    ledgerCost(cmd) {
      const s = state();
      const scope = s.scopes.get(cmd.episodeId);
      if (!scope) throw new LedgerError(ErrorCodes.SCOPE_NOT_FROZEN, `第 ${cmd.episodeId} 集口径尚未冻结，不能登记成本`);
      const currency = cmd.currency ?? "CNY";
      const beforeTotal = totalCost(s, cmd.episodeId, currency);
      const afterTotal = beforeTotal + cmd.amount;

      const cost = emit(ledger, {
        ...cmd,
        type: "COST_LEDGERED",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `登记成本 ${cmd.amount} ${currency}（${cmd.category}）`,
        payload: {
          episode_id: cmd.episodeId,
          cost_id: cmd.costId ?? cmd.eventId,
          amount: cmd.amount,
          currency,
          category: cmd.category,
          causal_event_id: cmd.causalEventId ?? null,
        },
      }).event;

      const crossing = detectCostCrossing(scope, beforeTotal, afterTotal, rules);
      let triggered = null;
      let resuggested = null;
      if (crossing) {
        triggered = emit(ledger, {
          eventId: cmd.reassessmentEventId ?? `${cmd.episodeId}-reassess-cost-${afterTotal}`,
          type: "REVIEW_REASSESSMENT_TRIGGERED",
          aggregateId: cmd.episodeId,
          occurredAt: cmd.occurredAt,
          causationId: cost.event_id,
          correlationId: cmd.correlationId ?? cmd.episodeId,
          summary: `实际成本 ${afterTotal} 跨入更高审核档位，触发重审`,
          payload: {
            episode_id: cmd.episodeId,
            trigger: crossing.trigger,
            before_path: s.reviews.get(cmd.episodeId)?.signed_path ?? null,
            reason: { from_band: crossing.from_band, to_band: crossing.to_band, actual_total: crossing.actual_total },
          },
        }).event;
        resuggested = emitSuggestion(
          cmd.episodeId,
          cmd.occurredAt,
          { genre: scope.genre, investment_amount: afterTotal, currency: scope.currency ?? "CNY", frozen_at: scope.frozen_at },
          {
            causationId: triggered.event_id,
            eventId: `${cmd.episodeId}-path-resuggested-cost-${afterTotal}`,
            note: "实际成本跨档后系统重新建议路径（仍须人工签署）",
          },
        );
      }
      return { cost, triggered, resuggested, actualTotal: afterTotal };
    },

    /** 最终分类签署：系统只建议，分类必须由有权人员签署。 */
    signClassification(cmd) {
      requireRoles(cmd, roles.classificationOfficer, "审核分类签署");
      const s = state();
      const scope = s.scopes.get(cmd.episodeId);
      if (!scope) throw new LedgerError(ErrorCodes.SCOPE_NOT_FROZEN, `第 ${cmd.episodeId} 集口径尚未冻结`);
      const review = s.reviews.get(cmd.episodeId);
      if (!review) throw new LedgerError(ErrorCodes.NOT_SIGNED, "尚不存在系统建议路径，无法签署");

      const advisory = review.suggested_path;
      const override = cmd.path !== advisory;
      if (override && !cmd.justification) {
        throw new LedgerError(
          ErrorCodes.NOT_SIGNED,
          `签署路径 ${cmd.path} 与系统建议 ${advisory} 不一致，必须填写 justification 并承担分类责任`,
        );
      }
      return emit(ledger, {
        ...cmd,
        type: "REVIEW_CLASSIFICATION_SIGNED",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `签署审核路径：${cmd.path}${override ? "（人工覆盖建议）" : ""}`,
        payload: {
          episode_id: cmd.episodeId,
          path: cmd.path,
          advisory_override: override,
          justification: cmd.justification ?? null,
        },
      }).event;
    },

    submitForReview(cmd) {
      const s = state();
      const review = ensureSignedForSubmit(s, cmd.episodeId, cmd.path);
      if (review.status === "returned") {
        throw new LedgerError(ErrorCodes.ALREADY_DECIDED, `第 ${cmd.episodeId} 集已被退回，必须使用重新提交（REVIEW_RESUBMITTED）`);
      }
      if (review.status === "submitted" || review.status === "approved") {
        throw new LedgerError(ErrorCodes.ALREADY_DECIDED, `第 ${cmd.episodeId} 集已处于 ${review.status} 状态，不能重复提交`);
      }
      const cut = s.cuts.get(cmd.episodeId);
      if (!cut?.master) throw new LedgerError(ErrorCodes.MASTER_NOT_RELEASED, "送审包必须包含已定版母版");
      requireRoles(cmd, roles.producer, "提交送审");
      return emit(ledger, {
        ...cmd,
        type: "REVIEW_SUBMITTED",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `第 ${cmd.episodeId} 集按 ${cmd.path ?? s.reviews.get(cmd.episodeId).signed_path} 提交送审`,
        payload: {
          episode_id: cmd.episodeId,
          path: cmd.path ?? s.reviews.get(cmd.episodeId).signed_path,
          target_authority: cmd.targetAuthority ?? null,
          package_hash: cmd.packageHash ?? cut.master.hash,
        },
      }).event;
    },

    resubmitForReview(cmd) {
      const s = state();
      const review = ensureSignedForSubmit(s, cmd.episodeId, cmd.path);
      if (review.status !== "returned") {
        throw new LedgerError(ErrorCodes.ALREADY_DECIDED, `第 ${cmd.episodeId} 集当前状态 ${review.status}，只有退回后才能重新提交`);
      }
      requireRoles(cmd, roles.producer, "重新提交送审");
      return emit(ledger, {
        ...cmd,
        type: "REVIEW_RESUBMITTED",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `第 ${cmd.episodeId} 集第 ${review.current_round + 1} 轮重新送审`,
        payload: {
          episode_id: cmd.episodeId,
          path: cmd.path ?? review.signed_path,
          target_authority: cmd.targetAuthority ?? null,
          package_hash: cmd.packageHash ?? s.cuts.get(cmd.episodeId)?.master?.hash ?? null,
        },
      }).event;
    },

    returnReview(cmd) {
      requireRoles(cmd, roles.reviewAuthority, "审核退回决定");
      const s = state();
      if (s.reviews.get(cmd.episodeId)?.status !== "submitted") {
        throw new LedgerError(ErrorCodes.ALREADY_DECIDED, "仅已提交状态可退回");
      }
      return emit(ledger, {
        ...cmd,
        type: "REVIEW_RETURNED",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `第 ${cmd.episodeId} 集审核退回：${(cmd.reasons ?? []).join("、")}`,
        payload: { episode_id: cmd.episodeId, reasons: cmd.reasons ?? [] },
      }).event;
    },

    approveReview(cmd) {
      requireRoles(cmd, roles.reviewAuthority, "审核通过决定");
      const s = state();
      const review = s.reviews.get(cmd.episodeId);
      if (review?.status !== "submitted") {
        throw new LedgerError(ErrorCodes.ALREADY_DECIDED, "仅已提交状态可作出通过决定");
      }
      const masterHash = cmd.masterHash ?? s.cuts.get(cmd.episodeId)?.master?.hash;
      return emit(ledger, {
        ...cmd,
        type: "REVIEW_APPROVED",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `第 ${cmd.episodeId} 集审核通过（母版 ${masterHash}）`,
        payload: { episode_id: cmd.episodeId, master_hash: masterHash, approval_doc_hash: cmd.approvalDocHash ?? null },
      }).event;
    },

    /** 显式重审触发：重剪 / 海外版本 / 权利变更等。 */
    triggerReassessment(cmd) {
      const s = state();
      if (!s.reviews.get(cmd.episodeId)) throw new LedgerError(ErrorCodes.NOT_SIGNED, "尚无审核卷宗，无需触发重审");
      return emit(ledger, {
        ...cmd,
        type: "REVIEW_REASSESSMENT_TRIGGERED",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `第 ${cmd.episodeId} 集因 ${cmd.trigger} 触发重审`,
        payload: {
          episode_id: cmd.episodeId,
          trigger: cmd.trigger,
          before_path: s.reviews.get(cmd.episodeId).signed_path,
          reason: cmd.reason ?? null,
        },
      }).event;
    },

    /** 成片封版：封版资产来源链必须洁净（无否决、无个人素材）。 */
    sealCut(cmd) {
      assertAssetsClean(ledger.all(), cmd.assetIds);
      return emit(ledger, {
        ...cmd,
        type: "CUT_SEALED",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `第 ${cmd.episodeId} 集成片封版（${cmd.assetIds.length} 个资产）`,
        payload: {
          episode_id: cmd.episodeId,
          program_id: cmd.programId ?? null,
          asset_ids: cmd.assetIds,
          master: cmd.master,
        },
      }).event;
    },

    /**
     * 替换母版（重剪或海外版本）。必须声明触发类型，
     * 并对已有审核结论精确触发重审；替换后原通过决定不再覆盖新母版。
     */
    replaceMaster(cmd) {
      const s = state();
      const cut = s.cuts.get(cmd.episodeId);
      if (!cut?.master) throw new LedgerError(ErrorCodes.MASTER_NOT_RELEASED, "尚无已封版母版，无法替换");
      assertAssetsClean(ledger.all(), cmd.assetIds ?? cut.asset_ids);

      const trigger = cmd.overseasVersion ? "overseas_version_added" : "master_reedited";
      const replaced = emit(ledger, {
        ...cmd,
        type: "MASTER_REPLACED",
        aggregateId: cmd.episodeId,
        summary: cmd.summary ?? `第 ${cmd.episodeId} 集母版替换：${cmd.overseasVersion ? "海外版本" : "重剪"}`,
        payload: {
          episode_id: cmd.episodeId,
          previous_master_hash: cut.master.hash,
          master: cmd.master,
          asset_ids: cmd.assetIds ?? cut.asset_ids,
          reason: cmd.reason ?? trigger,
          overseas_version: cmd.overseasVersion ?? false,
        },
      }).event;

      const review = s.reviews.get(cmd.episodeId);
      let triggered = null;
      if (review && review.status !== "reassessment_required") {
        triggered = emit(ledger, {
          eventId: cmd.reassessmentEventId ?? `${cmd.episodeId}-reassess-${trigger}-${cmd.master.hash.slice(0, 12)}`,
          type: "REVIEW_REASSESSMENT_TRIGGERED",
          aggregateId: cmd.episodeId,
          occurredAt: cmd.occurredAt,
          causationId: replaced.event_id,
          correlationId: cmd.correlationId ?? cmd.episodeId,
          summary: `${cmd.overseasVersion ? "新增海外版本" : "母版重剪"}，新母版需重新审核`,
          payload: {
            episode_id: cmd.episodeId,
            trigger,
            before_path: review.signed_path,
            reason: { previous_master_hash: cut.master.hash, new_master_hash: cmd.master.hash },
          },
        }).event;
      }
      return { replaced, triggered };
    },

    /** 发行放行：仅对审核通过的当前母版打包，包内容受最小披露约束。 */
    publishReleasePackage(cmd) {
      requireRoles(cmd, roles.releaseManager, "发行放行");
      const s = state();
      const review = s.reviews.get(cmd.episodeId);
      if (review?.status !== "approved") {
        throw new LedgerError(ErrorCodes.NOT_SIGNED, `第 ${cmd.episodeId} 集未处于审核通过状态，不能放行`);
      }
      const cut = s.cuts.get(cmd.episodeId);
      const master = cmd.master ?? cut?.master;
      if (review.approved_master_hash && master?.hash !== review.approved_master_hash) {
        throw new LedgerError(
          ErrorCodes.MASTER_MISMATCH,
          `待放行母版 ${master?.hash} 未通过审核（审核通过的是 ${review.approved_master_hash}）`,
        );
      }
      assertMasterReleasable(ledger.all(), { episodeId: cmd.episodeId, master, assetIds: cut.asset_ids });

      const rightsProofs = (cmd.rightsScriptIds ?? []).map((scriptId) => {
        const r = s.rights.get(scriptId);
        if (!r) throw new LedgerError(ErrorCodes.UNKNOWN_ASSET, `权利证明不存在：${scriptId}`);
        return {
          script_id: r.script_id,
          doc_hash: r.doc_hash,
          license_scope: r.license_scope,
          territories: r.territories,
          expires_at: r.expires_at,
        };
      });

      return emit(ledger, {
        ...cmd,
        type: "RELEASE_PACKAGE_PUBLISHED",
        aggregateId: cmd.packageId,
        summary: cmd.summary ?? `发行包 ${cmd.packageId} 放行（节目 ${cmd.programId}）`,
        payload: {
          package_id: cmd.packageId,
          program_id: cmd.programId,
          episode_id: cmd.episodeId,
          master: { hash: master.hash, uri: master.uri, duration_seconds: master.duration_seconds ?? null, checksum_alg: master.checksum_alg ?? "sha256" },
          rights_proofs: rightsProofs,
        },
      }).event;
    },

    grantReleaseAccess(cmd) {
      const s = state();
      if (!s.releases.has(cmd.packageId)) {
        throw new LedgerError(ErrorCodes.RECEIVER_UNKNOWN, `发行包不存在：${cmd.packageId}`);
      }
      return emit(ledger, {
        ...cmd,
        type: "RELEASE_ACCESS_GRANTED",
        aggregateId: cmd.packageId,
        summary: cmd.summary ?? `向 ${cmd.receiverName ?? cmd.receiverId} 交付发行包 ${cmd.packageId}`,
        payload: {
          package_id: cmd.packageId,
          receiver_id: cmd.receiverId,
          receiver_name: cmd.receiverName ?? null,
          scope: cmd.scope ?? "master_delivery",
        },
      }).event;
    },
  };
}
