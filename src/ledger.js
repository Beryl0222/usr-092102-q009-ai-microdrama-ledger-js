import {
  aggregateTypes as AT,
  eventTypes as ET,
  pathSignerRoles,
  reviewDecisions,
  reviewPaths,
  roles,
} from "./domain.js";
import { signEvent, verifySignature } from "./crypto.js";
import { detectTierCrossing, PATH_RULES, suggestReviewPath } from "./policy.js";
import { reduceEvents } from "./state.js";
import { EventStore } from "./store.js";

/**
 * 制片总账命令层。
 *
 * 所有写入都经过这里：命令 -> 归约当前状态 -> 不变量检查 -> 追加事件。
 * 关键不变量：
 *  1. 否决镜头（按资产 id 与内容 sha256 双键）永远不能再登记、修订、入时间轴；
 *  2. 角色跨集复用必须命中已锁定的连续性基线（版本+摘要）；
 *  3. 系统只“建议”路径；分类与放行只能由授权角色携带有效 HMAC 签署作出；
 *  4. 追加成本跨档 / 重剪 / 口径修订 / 海外版本各自精确产生对应的重审触发；
 *  5. 重审待决期间，已交付平台的授权被挂起，母版不得放行；
 *  6. 发行交付只引用已放行母版与权利证明，不携带未采用提示或个人素材。
 */

export class LedgerError extends Error {
  constructor(message, code = "LEDGER_REJECTED") {
    super(message);
    this.code = code;
  }
}

const pad = (n) => String(n).padStart(3, "0");
const cutId = (productionId, episodeNo) => `cut:${productionId}:E${pad(episodeNo)}`;
const reviewId = (productionId, episodeNo) => `review:${productionId}:E${pad(episodeNo)}`;

export class ProductionLedger {
  /**
   * @param {object} options
   * @param {EventStore} options.store
   * @param {(signerId: string) => ({id:string, roles:string[], secret:string}|null)} [options.directory]
   *        人员目录：返回该人员拥有的角色与签名密钥；未提供时决定类命令必须自带已签事件。
   */
  constructor({ store, directory = null }) {
    if (!(store instanceof EventStore)) throw new TypeError("store 必须是 EventStore");
    this.store = store;
    this.directory = directory;
  }

  get state() {
    return reduceEvents(this.store.allEvents());
  }

  #append(draft) {
    const { event, duplicate } = this.store.append(draft);
    return { event, duplicate };
  }

  #requireProduction(state, productionId) {
    const prod = state.productions.get(productionId);
    if (!prod?.opened) throw new LedgerError(`制作单不存在或未开立：${productionId}`, "PRODUCTION_NOT_FOUND");
    return prod;
  }

  #requireFrozenScope(prod) {
    if (!prod.scope?.frozen) throw new LedgerError("题材与投资口径尚未冻结，不能评估路径或送审", "SCOPE_NOT_FROZEN");
    return prod.scope;
  }

  #sign(eventDraft, signer) {
    if (!this.directory) throw new LedgerError("未配置人员目录，无法代为签署", "NO_DIRECTORY");
    const record = this.directory(signer.id);
    if (!record) throw new LedgerError(`签署人不在目录中：${signer.id}`, "SIGNER_UNKNOWN");
    if (!record.roles.includes(signer.role)) {
      throw new LedgerError(`签署人 ${signer.id} 不具备角色 ${signer.role}`, "SIGNER_ROLE_DENIED");
    }
    // 先定稿 event_id/occurred_at/version 再签，保证落库事件可通过验签
    const prepared = this.store.prepare(eventDraft);
    const signature = signEvent(prepared, { signer_id: record.id, signer_role: signer.role }, record.secret);
    return { prepared, signature };
  }

  #verifySignedEvent(event, expectedRoles) {
    if (!event.signature) throw new LedgerError(`事件 ${event.event_type} 缺少签署`, "SIGNATURE_MISSING");
    if (!this.directory) throw new LedgerError("未配置人员目录，无法核验签署", "NO_DIRECTORY");
    const record = this.directory(event.signature.signer_id);
    if (!record) throw new LedgerError("签署人不在目录中", "SIGNER_UNKNOWN");
    if (!expectedRoles.includes(event.signature.signer_role)) {
      throw new LedgerError(`角色 ${event.signature.signer_role} 无权作出该决定`, "SIGNER_ROLE_DENIED");
    }
    if (!record.roles.includes(event.signature.signer_role)) {
      throw new LedgerError(`签署人实际不具备角色 ${event.signature.signer_role}`, "SIGNER_ROLE_DENIED");
    }
    if (!verifySignature(event, record.secret)) throw new LedgerError("签署摘要校验失败", "SIGNATURE_INVALID");
  }

  #assertNotRejected(state, { assetId = null, digest = null }) {
    if (assetId && state.rejectedAssets.has(assetId)) {
      const r = state.rejectedAssets.get(assetId);
      throw new LedgerError(`资产 ${assetId} 已被否决（${r.reason}），不得重新使用`, "ASSET_REJECTED");
    }
    if (digest) {
      const firstId = state.assetDigests.get(digest);
      if (firstId && state.rejectedAssets.has(firstId)) {
        throw new LedgerError(`内容摘要 ${digest} 对应镜头已被否决，禁止换身份重新混入`, "ASSET_REJECTED_DIGEST");
      }
      if ([...state.rejectedAssets.keys()].some((id) => state.assets.get(id)?.sha256 === digest)) {
        throw new LedgerError(`内容摘要命中否决镜头黑名单：${digest}`, "ASSET_REJECTED_DIGEST");
      }
    }
  }

  #checkContinuity(state, productionId, episodeNo, lineage) {
    for (const ref of lineage ?? []) {
      if (ref.aggregate_type !== AT.CHARACTER_ASSET) continue;
      const character = state.characters.get(ref.aggregate_id);
      if (!character) throw new LedgerError(`谱系引用了不存在的角色资产：${ref.aggregate_id}`, "LINEAGE_BROKEN");
      const baseline = state.baselines.get(`${productionId}:${ref.aggregate_id}`);
      const firstUseEpisode = state.characterFirstUse.get(ref.aggregate_id);
      const reuseAcrossEpisodes = episodeNo != null && firstUseEpisode != null && firstUseEpisode !== episodeNo;

      if (!baseline) {
        // 角色可在首用集自由使用；一旦跨集复用，必须先锁定连续性基线
        if (reuseAcrossEpisodes) {
          throw new LedgerError(
            `角色 ${ref.aggregate_id} 跨集复用（首用于第 ${firstUseEpisode} 集）前未锁定连续性基线`,
            "BASELINE_REQUIRED",
          );
        }
        continue;
      }
      // 基线钉的是“锁定时的版本+指纹”：引用版本必须等于基线版本，
      // 且该版本上的历史指纹（而非资产当前最新指纹）必须与基线一致。
      const digestAtVersion = character.versions?.get(ref.version) ?? character.digest;
      if (ref.version !== baseline.character_asset_version || digestAtVersion !== baseline.character_digest) {
        throw new LedgerError(
          `角色 ${ref.aggregate_id} 违反连续性基线：要求 v${baseline.character_asset_version}/${baseline.character_digest.slice(0, 12)}，` +
            `实际 v${ref.version}/${String(digestAtVersion).slice(0, 12)}`,
          "CONTINUITY_VIOLATION",
        );
      }
    }
  }

  #assertLineageExists(state, lineage) {
    const existTables = {
      [AT.PRODUCTION_ASSET]: state.assets,
      [AT.SHOT]: state.assets,
      [AT.CHARACTER_ASSET]: state.characters,
      [AT.SCENE_ASSET]: state.scenes,
      [AT.PROMPT_INPUT]: state.prompts,
      [AT.AUDIO_TRACK]: state.audios,
      [AT.SCRIPT_RIGHT]: state.scripts,
    };
    for (const ref of lineage ?? []) {
      const table = existTables[ref.aggregate_type];
      if (table && !table.has(ref.aggregate_id)) {
        throw new LedgerError(`谱系引用不存在：${ref.aggregate_type}:${ref.aggregate_id}`, "LINEAGE_BROKEN");
      }
    }
  }

  // -- 制作单与口径 ---------------------------------------------------------

  openProduction({ productionId, title, genreScope, investmentBasis, actorId, correlationId }) {
    const state = this.state;
    if (state.productions.has(productionId)) throw new LedgerError(`制作单已存在：${productionId}`, "ALREADY_EXISTS");
    return this.#append({
      event_type: ET.PRODUCTION_OPENED,
      aggregate_type: AT.PRODUCTION,
      aggregate_id: productionId,
      summary: `开立制作单：${title}`,
      actor_id: actorId,
      correlation_id: correlationId,
      payload: { title, genre_scope: genreScope, investment_basis: investmentBasis },
    }).event;
  }

  freezeScope({ productionId, frozenAt, actorId }) {
    const state = this.state;
    const prod = this.#requireProduction(state, productionId);
    if (prod.scope?.frozen) throw new LedgerError("口径已经冻结；变更需走 SCOPE_REVISED", "SCOPE_ALREADY_FROZEN");
    return this.#append({
      event_type: ET.SCOPE_FROZEN,
      aggregate_type: AT.PRODUCTION,
      aggregate_id: productionId,
      summary: `冻结《${prod.title}》题材与投资口径`,
      actor_id: actorId,
      payload: {
        genre_scope: prod.scope.genre_scope,
        investment_basis: prod.scope.investment_basis,
        frozen_at: frozenAt ?? new Date().toISOString(),
      },
    }).event;
  }

  /**
   * 财务统计口径变更。以变更请求单为幂等键；跨档时为所有在途/已决审核流
   * 精确登记 REREVIEW_TRIGGERED(SCOPE_REVISED)，并挂起平台授权。
   */
  reviseScope({ productionId, investmentBasis, changeRequestId, actorId }) {
    const state = this.state;
    const prod = this.#requireProduction(state, productionId);
    this.#requireFrozenScope(prod);

    const created = [];
    const primary = this.#append({
      event_type: ET.SCOPE_REVISED,
      aggregate_type: AT.PRODUCTION,
      aggregate_id: productionId,
      idempotency_key: `scope-revise:${productionId}:${changeRequestId}`,
      summary: `投资口径按财务变更单 ${changeRequestId} 调整为 ${investmentBasis.amount}`,
      actor_id: actorId,
      payload: {
        investment_basis: investmentBasis,
        change_request_id: changeRequestId,
        revised_at: investmentBasis.revised_at ?? new Date().toISOString(),
      },
    });
    created.push(primary.event);
    if (primary.duplicate) return { events: created, duplicate: true };

    // 用追加后的状态判断跨档
    const next = reduceEvents(this.store.allEvents());
    const nextProd = next.productions.get(productionId);
    const crossing = detectTierCrossing(prod.scope, nextProd.scope);

    for (const [rid, r] of next.reviews) {
      if (r.production_id !== productionId) continue;
      // 口径重算只影响真正进入过审核流程（提交或已决）的集次；
      // 尚未提交的集次下次 assessTier 自会按新口径建议。
      if (!r.submissions.length && !r.decided) continue;
      if (r.pendingRereview && r.rereviewTriggers.some((t) => t.trigger === "scope_revised")) continue;
      const triggered = this.#append({
        event_type: ET.REREVIEW_TRIGGERED,
        aggregate_type: AT.REVIEW_SUBMISSION,
        aggregate_id: rid,
        summary: crossing.crossed
          ? `口径变更导致审核档由 ${crossing.from} 变为 ${crossing.to}，触发重审`
          : "冻结口径变更，按新口径重新核验",
        actor_id: actorId,
        causation_id: primary.event.event_id,
        payload: {
          production_id: productionId,
          episode_no: r.episode_no,
          trigger: "scope_revised",
          evidence_event_ids: [primary.event.event_id],
          required_path: crossing.to,
        },
      }).event;
      created.push(triggered);
    }
    this.#suspendGrants(reduceEvents(this.store.allEvents()), { productionId, reason: "冻结口径变更触发重审", triggerEventId: primary.event.event_id, actorId });
    return { events: created, duplicate: false, crossing };
  }

  // -- 权利 / 角色 / 场景 ----------------------------------------------------

  registerScriptRight(cmd) {
    return this.#append({
      event_type: ET.SCRIPT_RIGHT_REGISTERED,
      aggregate_type: AT.SCRIPT_RIGHT,
      aggregate_id: cmd.rightId,
      summary: `登记剧本权利：${cmd.title}`,
      actor_id: cmd.actorId,
      correlation_id: cmd.productionId,
      payload: {
        production_id: cmd.productionId,
        title: cmd.title,
        rights_owner: cmd.rightsOwner,
        license_scope: cmd.licenseScope,
        evidence_ref: cmd.evidenceRef,
        digest: cmd.digest,
      },
    }).event;
  }

  registerCharacter({ characterId, productionId, characterCode, sourceAccountId, digest, actorId, lineage = [] }) {
    const state = this.state;
    this.#requireProduction(state, productionId);
    return this.#append({
      event_type: ET.CHARACTER_REGISTERED,
      aggregate_type: AT.CHARACTER_ASSET,
      aggregate_id: characterId,
      summary: `登记角色图 ${characterCode}（来源账号 ${sourceAccountId}）`,
      actor_id: actorId,
      correlation_id: productionId,
      lineage,
      payload: {
        production_id: productionId,
        character_code: characterCode,
        source_account_id: sourceAccountId,
        digest,
      },
    }).event;
  }

  registerScene({ sceneId, productionId, sceneCode, sourceAccountId, digest, actorId, lineage = [] }) {
    const state = this.state;
    this.#requireProduction(state, productionId);
    return this.#append({
      event_type: ET.SCENE_REGISTERED,
      aggregate_type: AT.SCENE_ASSET,
      aggregate_id: sceneId,
      summary: `登记场景资产 ${sceneCode}（来源账号 ${sourceAccountId}）`,
      actor_id: actorId,
      correlation_id: productionId,
      lineage,
      payload: {
        production_id: productionId,
        scene_code: sceneCode,
        source_account_id: sourceAccountId,
        digest,
      },
    }).event;
  }

  /** 跨集复用角色前锁定连续性基线；基线即“后续所有引用必须命中的版本+摘要”。 */
  lockContinuityBaseline({ baselineId, productionId, characterId, lockedFromEpisode, traitsSnapshot, actorId }) {
    const state = this.state;
    this.#requireProduction(state, productionId);
    const character = state.characters.get(characterId);
    if (!character || character.production_id !== productionId) {
      throw new LedgerError(`角色资产不存在于本制作单：${characterId}`, "CHARACTER_NOT_FOUND");
    }
    if (state.baselines.has(`${productionId}:${characterId}`)) {
      throw new LedgerError("连续性基线已锁定，不可重复锁定（如需演进须另立基线并走变更评审）", "BASELINE_ALREADY_LOCKED");
    }
    const charVersion = this.store.versionOf(AT.CHARACTER_ASSET, characterId);
    return this.#append({
      event_type: ET.CONTINUITY_BASELINE_LOCKED,
      aggregate_type: AT.CONTINUITY_BASELINE,
      aggregate_id: baselineId,
      summary: `锁定角色 ${character.character_code} 连续性基线（自第 ${lockedFromEpisode} 集起复用）`,
      actor_id: actorId,
      correlation_id: productionId,
      lineage: [{ aggregate_type: AT.CHARACTER_ASSET, aggregate_id: characterId, version: charVersion }],
      payload: {
        production_id: productionId,
        character_id: characterId,
        locked_from_episode: lockedFromEpisode,
        character_asset_version: charVersion,
        character_digest: character.digest,
        traits_snapshot: traitsSnapshot,
      },
    }).event;
  }

  // -- 提示 / 生成 / 否决 / 修订 --------------------------------------------

  recordPromptDigest({ promptId, productionId, promptDigest, createdBy, adoptedBy = null }) {
    const state = this.state;
    this.#requireProduction(state, productionId);
    return this.#append({
      event_type: ET.PROMPT_DIGEST_RECORDED,
      aggregate_type: AT.PROMPT_INPUT,
      aggregate_id: promptId,
      summary: "登记提示输入摘要",
      actor_id: createdBy,
      correlation_id: productionId,
      payload: {
        production_id: productionId,
        prompt_digest: promptDigest,
        created_by: createdBy,
        adopted_by: adoptedBy, // null = 未采用；发行投影据此排除
      },
    }).event;
  }

  /**
   * 外部模型工具回调登记真实产物。
   * 以工具方回调 id 为幂等键：乱序或重试只登记一次；先到先得，后到原样返回。
   */
  registerGeneratedAsset(cmd) {
    const state = this.state;
    this.#requireProduction(state, cmd.productionId);
    this.#assertNotRejected(state, { assetId: cmd.assetId, digest: cmd.sha256 });
    this.#assertLineageExists(state, cmd.lineage);
    this.#checkContinuity(state, cmd.productionId, cmd.episodeNo ?? null, cmd.lineage);

    return this.#append({
      event_type: ET.ASSET_GENERATED,
      aggregate_type: cmd.aggregateType ?? AT.PRODUCTION_ASSET,
      aggregate_id: cmd.assetId,
      idempotency_key: cmd.callbackId ? `callback:${cmd.callbackId}` : undefined,
      summary: `登记生成产物 ${cmd.assetId}（${cmd.modelProvider}/${cmd.modelVersion}）`,
      actor_id: cmd.generatedBy,
      correlation_id: cmd.productionId,
      lineage: cmd.lineage,
      payload: {
        production_id: cmd.productionId,
        episode_no: cmd.episodeNo ?? null,
        shot_code: cmd.shotCode ?? null,
        asset_kind: cmd.assetKind ?? "shot",
        output_uri: cmd.outputUri,
        sha256: cmd.sha256,
        model_provider: cmd.modelProvider,
        model_version: cmd.modelVersion,
        generated_by: cmd.generatedBy ?? null,
        callback_id: cmd.callbackId ?? null,
      },
    }).event;
  }

  rejectShot({ assetId, productionId, reason, rejectedBy }) {
    const state = this.state;
    const asset = state.assets.get(assetId);
    if (!asset || asset.production_id !== productionId) {
      throw new LedgerError(`待否决资产不存在于本制作单：${assetId}`, "ASSET_NOT_FOUND");
    }
    if (state.rejectedAssets.has(assetId)) throw new LedgerError("该镜头已在否决名单中", "ALREADY_REJECTED");
    return this.#append({
      event_type: ET.SHOT_REJECTED,
      aggregate_type: AT.PRODUCTION_ASSET,
      aggregate_id: assetId,
      summary: `镜头否决：${reason}`,
      actor_id: rejectedBy,
      correlation_id: productionId,
      payload: { production_id: productionId, reason, rejected_by: rejectedBy },
    }).event;
  }

  recordHumanRevision(cmd) {
    const state = this.state;
    this.#requireProduction(state, cmd.productionId);
    // 不允许以“人工修订”为名让被否决镜头复活：修订对象与新内容摘要都不能命中黑名单。
    this.#assertNotRejected(state, { assetId: cmd.revisionOf, digest: cmd.sha256 });
    this.#assertLineageExists(state, cmd.lineage);
    this.#checkContinuity(state, cmd.productionId, cmd.episodeNo ?? null, cmd.lineage);
    return this.#append({
      event_type: ET.HUMAN_REVISION_RECORDED,
      aggregate_type: cmd.aggregateType ?? AT.PRODUCTION_ASSET,
      aggregate_id: cmd.assetId,
      summary: `人工修订 ${cmd.revisionOf} -> ${cmd.assetId}`,
      actor_id: cmd.editorId,
      correlation_id: cmd.productionId,
      lineage: cmd.lineage ?? [
        { aggregate_type: AT.PRODUCTION_ASSET, aggregate_id: cmd.revisionOf, version: this.store.versionOf(AT.PRODUCTION_ASSET, cmd.revisionOf) },
      ],
      payload: {
        production_id: cmd.productionId,
        episode_no: cmd.episodeNo ?? null,
        revision_of: cmd.revisionOf,
        editor_id: cmd.editorId,
        output_uri: cmd.outputUri,
        sha256: cmd.sha256,
      },
    }).event;
  }

  addAudio({ audioId, productionId, episodeNo, kind, workRef, licenseRef, digest, actorId, lineage = [] }) {
    const state = this.state;
    this.#requireProduction(state, productionId);
    return this.#append({
      event_type: ET.AUDIO_ADDED,
      aggregate_type: AT.AUDIO_TRACK,
      aggregate_id: audioId,
      summary: `登记${kind === "music" ? "音乐" : "配音"}：${workRef}`,
      actor_id: actorId,
      correlation_id: productionId,
      lineage,
      payload: { production_id: productionId, episode_no: episodeNo, kind, work_ref: workRef, license_ref: licenseRef, digest },
    }).event;
  }

  // -- 成本 / 贡献 ----------------------------------------------------------

  postCost(cmd) {
    const state = this.state;
    const prod = this.#requireProduction(state, cmd.productionId);
    if (cmd.currency && prod.currency && cmd.currency !== prod.currency) {
      throw new LedgerError(`币种 ${cmd.currency} 与制作单币种 ${prod.currency} 不一致`, "CURRENCY_MISMATCH");
    }
    const beforeTotal = prod.costTotal;

    const created = this.#append({
      event_type: ET.COST_POSTED,
      aggregate_type: AT.COST_ENTRY,
      aggregate_id: cmd.costId ?? `cost:${cmd.productionId}:${cmd.sourceStatementId}`,
      // 同一张财务单据的重试/乱序重投只入账一次
      idempotency_key: `cost-statement:${cmd.productionId}:${cmd.sourceStatementId}`,
      summary: `成本入账 ${cmd.amount}（${cmd.category}）`,
      actor_id: cmd.actorId,
      correlation_id: cmd.productionId,
      payload: {
        production_id: cmd.productionId,
        amount: cmd.amount,
        currency: cmd.currency ?? prod.currency,
        category: cmd.category,
        source_statement_id: cmd.sourceStatementId,
        episode_no: cmd.episodeNo ?? null,
        asset_id: cmd.assetId ?? null,
      },
    });
    if (created.duplicate) return { event: created.event, duplicate: true };

    // 追加成本跨档的精确重审：仅当本制作单已有封版集且本次入账推动总额越过省级阈值。
    const after = reduceEvents(this.store.allEvents());
    const nextProd = after.productions.get(cmd.productionId);
    const threshold = PATH_RULES.provincialInvestmentThreshold;
    const hadSeal = nextProd.sealedEpisodeCutRev.size > 0;
    const crosses = beforeTotal < threshold && nextProd.costTotal >= threshold;
    if (hadSeal && crosses) {
      for (const [rid, r] of after.reviews) {
        if (r.production_id !== cmd.productionId) continue;
        if (!r.submissions.length && !r.decided) continue;
        if (r.pendingRereview && r.rereviewTriggers.some((t) => t.trigger === "cost_threshold_crossed")) continue;
        this.#append({
          event_type: ET.REREVIEW_TRIGGERED,
          aggregate_type: AT.REVIEW_SUBMISSION,
          aggregate_id: rid,
          summary: `追加成本使累计投资 ${nextProd.costTotal} 越过省级阈值，精确触发重审`,
          actor_id: cmd.actorId,
          causation_id: created.event.event_id,
          payload: {
            production_id: cmd.productionId,
            episode_no: r.episode_no,
            trigger: "cost_threshold_crossed",
            evidence_event_ids: [created.event.event_id],
            required_path: reviewPaths.PROVINCIAL,
          },
        });
      }
      this.#suspendGrants(reduceEvents(this.store.allEvents()), {
        productionId: cmd.productionId,
        reason: "追加成本跨档触发重审",
        triggerEventId: created.event.event_id,
        actorId: cmd.actorId,
      });
    }
    return { event: created.event, duplicate: false, crossedThreshold: hadSeal && crosses };
  }

  postContribution(cmd) {
    const state = this.state;
    this.#requireProduction(state, cmd.productionId);
    return this.#append({
      event_type: ET.CONTRIBUTION_POSTED,
      aggregate_type: AT.CONTRIBUTION_ENTRY,
      aggregate_id: cmd.entryId ?? `contrib:${cmd.productionId}:${cmd.personId}`,
      idempotency_key: cmd.statementId ? `contrib:${cmd.productionId}:${cmd.personId}:${cmd.statementId}` : undefined,
      summary: `${cmd.personName} 贡献登记：${cmd.roles.join("、")}`,
      actor_id: cmd.actorId,
      correlation_id: cmd.productionId,
      payload: {
        production_id: cmd.productionId,
        person_id: cmd.personId,
        person_name: cmd.personName,
        roles: cmd.roles,
        share_terms: cmd.shareTerms,
        episode_no: cmd.episodeNo ?? null,
        asset_ids: cmd.assetIds ?? [],
      },
    }).event;
  }

  // -- 封版 / 重剪 ----------------------------------------------------------

  sealCut({ productionId, episodeNo, cutRevision, masterSha256, timeline, audioRefs = [], editorId }) {
    const state = this.state;
    this.#requireProduction(state, productionId);
    const cid = cutId(productionId, episodeNo);
    const ep = state.episodes.get(cid);
    if (ep?.sealedRevisions.has(cutRevision)) throw new LedgerError(`封版版本已存在：rev${cutRevision}`, "CUT_REVISION_EXISTS");

    // 时间轴上每个镜头都必须真实存在、未被否决；角色引用必须命中连续性基线。
    const shotLineage = [];
    for (const seg of timeline) {
      const asset = state.assets.get(seg.asset_id);
      if (!asset) throw new LedgerError(`时间轴引用不存在的镜头：${seg.asset_id}`, "SHOT_NOT_FOUND");
      if (asset.production_id !== productionId) throw new LedgerError(`镜头 ${seg.asset_id} 不属于本制作单`, "SHOT_FOREIGN");
      this.#assertNotRejected(state, { assetId: seg.asset_id, digest: asset.sha256 });
      shotLineage.push({ aggregate_type: AT.PRODUCTION_ASSET, aggregate_id: seg.asset_id, version: this.store.versionOf(AT.PRODUCTION_ASSET, seg.asset_id) });
    }
    for (const audioId of audioRefs) {
      const audio = state.audios.get(audioId);
      if (!audio || audio.production_id !== productionId) throw new LedgerError(`音轨不存在或不属于本制作单：${audioId}`, "AUDIO_NOT_FOUND");
      shotLineage.push({ aggregate_type: AT.AUDIO_TRACK, aggregate_id: audioId, version: this.store.versionOf(AT.AUDIO_TRACK, audioId) });
    }

    return this.#append({
      event_type: ET.CUT_SEALED,
      aggregate_type: AT.EPISODE_CUT,
      aggregate_id: cid,
      summary: `第 ${episodeNo} 集封版 rev${cutRevision}（母版 ${masterSha256.slice(0, 12)}…）`,
      actor_id: editorId,
      correlation_id: productionId,
      lineage: shotLineage,
      payload: {
        production_id: productionId,
        episode_no: episodeNo,
        cut_revision: cutRevision,
        master_sha256: masterSha256,
        timeline,
        audio_refs: audioRefs,
      },
    }).event;
  }

  reviseCut({ productionId, episodeNo, newRevision, reason, editorId }) {
    const state = this.state;
    this.#requireProduction(state, productionId);
    const cid = cutId(productionId, episodeNo);
    const ep = state.episodes.get(cid);
    if (!ep?.lastSealEventId) throw new LedgerError("尚未封版的集次不能重剪", "CUT_NOT_SEALED");
    if (newRevision <= ep.currentRevision) throw new LedgerError(`新版本号必须大于 ${ep.currentRevision}`, "BAD_REVISION");

    const created = [];
    const revised = this.#append({
      event_type: ET.CUT_REVISED,
      aggregate_type: AT.EPISODE_CUT,
      aggregate_id: cid,
      summary: `第 ${episodeNo} 集重剪 rev${newRevision}：${reason}`,
      actor_id: editorId,
      correlation_id: productionId,
      payload: {
        production_id: productionId,
        episode_no: episodeNo,
        cut_revision: newRevision,
        based_on_cut_revision: ep.currentRevision,
        reason,
      },
    }).event;
    created.push(revised);

    // 重剪精确触发重审：只要该集进入过审核流程。
    const after = reduceEvents(this.store.allEvents());
    const rid = reviewId(productionId, episodeNo);
    const r = after.reviews.get(rid);
    if (r && (r.submissions.length || r.decided)) {
      if (!(r.pendingRereview && r.rereviewTriggers.some((t) => t.trigger === "cut_revised"))) {
        const trig = this.#append({
          event_type: ET.REREVIEW_TRIGGERED,
          aggregate_type: AT.REVIEW_SUBMISSION,
          aggregate_id: rid,
          summary: `第 ${episodeNo} 集重剪，精确触发重审`,
          actor_id: editorId,
          causation_id: revised.event_id,
          payload: {
            production_id: productionId,
            episode_no: episodeNo,
            trigger: "cut_revised",
            evidence_event_ids: [revised.event_id],
            required_path: r.decided?.path ?? r.suggestion?.path ?? null,
          },
        }).event;
        created.push(trig);
      }
      this.#suspendGrants(reduceEvents(this.store.allEvents()), {
        productionId: productionId,
        episodeNo,
        reason: "重剪触发重审",
        triggerEventId: revised.event_id,
        actorId: editorId,
      });
    }
    return created;
  }

  // -- 审核路径建议 / 送审 / 决定 -------------------------------------------

  #findReviewedMaster(state, productionId, episodeNo, cutRevision, masterSha256, path) {
    const ep = state.episodes.get(cutId(productionId, episodeNo));
    const seal = ep?.sealedRevisions.get(cutRevision);
    if (seal && seal.master_sha256 === masterSha256) return { kind: "seal", seal };
    // overseas 路径允许针对海外版本母版（OVERSEAS_VERSION_CREATED 登记的独立指纹）送审
    if (path === reviewPaths.OVERSEAS) {
      const overseas = state.masters.get(`master:${productionId}:E${pad(episodeNo)}:overseas`);
      if (overseas?.is_overseas_version && overseas.master_sha256 === masterSha256) {
        return { kind: "overseas", overseas };
      }
    }
    return null;
  }

  assessTier({ productionId, episodeNo, actorId }) {
    const state = this.state;
    const prod = this.#requireProduction(state, productionId);
    const scope = this.#requireFrozenScope(prod);
    const { path, reasons } = suggestReviewPath(scope);
    return this.#append({
      event_type: ET.TIER_ASSESSED,
      aggregate_type: AT.REVIEW_SUBMISSION,
      aggregate_id: reviewId(productionId, episodeNo),
      summary: `系统建议第 ${episodeNo} 集走${path === reviewPaths.PROVINCIAL ? "省级送审" : "平台审核"}档（仅建议）`,
      actor_id: actorId,
      correlation_id: productionId,
      payload: {
        production_id: productionId,
        episode_no: episodeNo,
        scope_snapshot: scope,
        suggested_path: path,
        reasons,
      },
    }).event;
  }

  submitForReview({ productionId, episodeNo, path, submittedBy, cutRevision, masterSha256, packageDigest }) {
    const state = this.state;
    this.#requireFrozenScope(this.#requireProduction(state, productionId));
    const reviewed = this.#findReviewedMaster(state, productionId, episodeNo, cutRevision, masterSha256, path);
    if (!reviewed) throw new LedgerError("送审母版与已封版/已登记版本不一致，不能送审", "MASTER_MISMATCH");

    return this.#append({
      event_type: ET.REVIEW_SUBMITTED,
      aggregate_type: AT.REVIEW_SUBMISSION,
      aggregate_id: reviewId(productionId, episodeNo),
      summary: `第 ${episodeNo} 集 rev${cutRevision} 提交${path === reviewPaths.PROVINCIAL ? "省级送审" : "平台审核"}`,
      actor_id: submittedBy,
      correlation_id: productionId,
      payload: {
        production_id: productionId,
        episode_no: episodeNo,
        path,
        submitted_by: submittedBy,
        cut_revision: cutRevision,
        master_sha256: masterSha256,
        package_digest: packageDigest,
      },
    }).event;
  }

  resubmit({ productionId, episodeNo, path, submittedBy, cutRevision, masterSha256, packageDigest }) {
    const state = this.state;
    const r = state.reviews.get(reviewId(productionId, episodeNo));
    const lastSub = r?.submissions[r.submissions.length - 1];
    if (!lastSub) throw new LedgerError("没有可替换的历史提交，请使用首提交", "NO_PRIOR_SUBMISSION");
    if (r.decided?.decision !== reviewDecisions.RETURNED) {
      throw new LedgerError("只有处于“退回补正”状态的提交可以替换重交", "NOT_RETURNED");
    }
    // 替换提交必须指向比被替换提交更新的封版版本（退回补正后重剪重封）
    if (cutRevision <= lastSub.cut_revision) {
      throw new LedgerError(
        `替换提交必须基于更新的封版版本（被替换版本 rev${lastSub.cut_revision}）`,
        "REPLACEMENT_REVISION_REQUIRED",
      );
    }
    const ep = state.episodes.get(cutId(productionId, episodeNo));
    const seal = ep?.sealedRevisions.get(cutRevision);
    if (!seal || seal.master_sha256 !== masterSha256) throw new LedgerError("替换提交的母版与封版记录不一致", "MASTER_MISMATCH");

    return this.#append({
      event_type: ET.REVIEW_RESUBMITTED,
      aggregate_type: AT.REVIEW_SUBMISSION,
      aggregate_id: reviewId(productionId, episodeNo),
      summary: `第 ${episodeNo} 集退回后替换提交 rev${cutRevision}`,
      actor_id: submittedBy,
      correlation_id: productionId,
      payload: {
        production_id: productionId,
        episode_no: episodeNo,
        path,
        submitted_by: submittedBy,
        supersedes_event_id: lastSub.event_id,
        cut_revision: cutRevision,
        master_sha256: masterSha256,
        package_digest: packageDigest,
      },
    }).event;
  }

  /**
   * 最终分类与内容决定。只能由该路径授权角色签署；签署绑定确切封版版本与母版摘要。
   */
  decideReview({ productionId, episodeNo, decision, classification, path, cutRevision, masterSha256, signer, notes }) {
    const state = this.state;
    const rid = reviewId(productionId, episodeNo);
    const r = state.reviews.get(rid);
    if (!r?.submissions.length) throw new LedgerError("尚无送审提交，不能作出决定", "NO_SUBMISSION");
    if (!Object.values(reviewDecisions).includes(decision)) throw new LedgerError(`未知决定：${decision}`, "BAD_DECISION");
    const ep = state.episodes.get(cutId(productionId, episodeNo));
    const reviewed = this.#findReviewedMaster(state, productionId, episodeNo, cutRevision, masterSha256, path);
    if (!reviewed) throw new LedgerError(`决定对应的版本 rev${cutRevision} 与已登记母版不一致`, "MASTER_MISMATCH");

    const draft = {
      event_type: ET.REVIEW_DECIDED,
      aggregate_type: AT.REVIEW_SUBMISSION,
      aggregate_id: rid,
      summary: `第 ${episodeNo} 集 rev${cutRevision} 审核决定：${decision}`,
      actor_id: signer.id,
      correlation_id: productionId,
      payload: {
        production_id: productionId,
        episode_no: episodeNo,
        decision,
        classification,
        path,
        cut_revision: cutRevision,
        master_sha256: masterSha256,
        notes: notes ?? null,
      },
    };
    const { prepared, signature } = this.#sign(draft, signer);
    const event = this.#append({ ...prepared, signature }).event;
    // 二次核验：落库事件必须通过角色授权与 HMAC 校验
    this.#verifySignedEvent(event, pathSignerRoles[path]);
    return event;
  }

  // -- 母版放行 / 海外版本 / 发行交付 ---------------------------------------

  releaseMaster({ productionId, episodeNo, cutRevision, programId, releaseScope = "domestic", signer, releaseId }) {
    const state = this.state;
    const rid = reviewId(productionId, episodeNo);
    const r = state.reviews.get(rid);
    if (r?.pendingRereview) throw new LedgerError("重审待决期间不得放行母版", "REREVIEW_PENDING");

    const isOverseas = releaseScope === "overseas";
    let masterSha256;
    if (isOverseas) {
      const overseas = state.masters.get(`master:${productionId}:E${pad(episodeNo)}:overseas`);
      if (!overseas?.is_overseas_version) throw new LedgerError("海外放行必须对应已登记的海外版本母版", "OVERSEAS_VERSION_NOT_FOUND");
      masterSha256 = overseas.master_sha256;
    } else {
      const ep = state.episodes.get(cutId(productionId, episodeNo));
      const seal = ep?.sealedRevisions.get(cutRevision);
      if (!seal) throw new LedgerError(`封版 rev${cutRevision} 不存在`, "CUT_REVISION_NOT_FOUND");
      masterSha256 = seal.master_sha256;
    }

    const d = r?.decided;
    if (
      !d ||
      d.decision !== reviewDecisions.APPROVED ||
      d.cut_revision !== cutRevision ||
      d.master_sha256 !== masterSha256
    ) {
      throw new LedgerError("只有与该版本严格匹配的已批准决定可以放行", "NO_MATCHING_APPROVAL");
    }
    if (isOverseas && d.path !== reviewPaths.OVERSEAS) {
      throw new LedgerError("海外版本必须持有 overseas 路径的批准决定", "OVERSEAS_APPROVAL_REQUIRED");
    }

    const id = releaseId ?? `master:${productionId}:E${pad(episodeNo)}:rev${cutRevision}:${releaseScope}`;
    if (state.masters.has(id)) throw new LedgerError(`母版放行单已存在：${id}`, "ALREADY_EXISTS");

    const baseLineage = isOverseas
      ? [
          {
            aggregate_type: AT.MASTER_RELEASE,
            aggregate_id: `master:${productionId}:E${pad(episodeNo)}:overseas`,
            version: this.store.versionOf(AT.MASTER_RELEASE, `master:${productionId}:E${pad(episodeNo)}:overseas`),
          },
        ]
      : [
          {
            aggregate_type: AT.EPISODE_CUT,
            aggregate_id: cutId(productionId, episodeNo),
            version: this.store.versionOf(AT.EPISODE_CUT, cutId(productionId, episodeNo)),
          },
        ];

    const draft = {
      event_type: ET.MASTER_RELEASED,
      aggregate_type: AT.MASTER_RELEASE,
      aggregate_id: id,
      summary: `第 ${episodeNo} 集 rev${cutRevision} 母版放行（${releaseScope}）`,
      actor_id: signer.id,
      correlation_id: productionId,
      lineage: baseLineage,
      payload: {
        production_id: productionId,
        episode_no: episodeNo,
        cut_id: cutId(productionId, episodeNo),
        cut_revision: cutRevision,
        master_sha256: masterSha256,
        program_id: programId,
        release_scope: releaseScope,
      },
    };
    const { prepared, signature } = this.#sign(draft, signer);
    const event = this.#append({ ...prepared, signature }).event;
    this.#verifySignedEvent(event, [roles.PRODUCER, roles.COMPLIANCE_ADMIN]);
    return event;
  }

  createOverseasVersion({ productionId, episodeNo, domesticReleaseId, masterSha256, changesSummary, actorId }) {
    const state = this.state;
    const domestic = state.masters.get(domesticReleaseId);
    if (!domestic || domestic.production_id !== productionId || domestic.release_scope !== "domestic") {
      throw new LedgerError("海外版本必须基于已放行的境内母版", "DOMESTIC_RELEASE_NOT_FOUND");
    }
    const created = [];
    const id = `master:${productionId}:E${pad(episodeNo)}:overseas`;
    const made = this.#append({
      event_type: ET.OVERSEAS_VERSION_CREATED,
      aggregate_type: AT.MASTER_RELEASE,
      aggregate_id: id,
      summary: `第 ${episodeNo} 集制作海外版本`,
      actor_id: actorId,
      correlation_id: productionId,
      lineage: [{ aggregate_type: AT.MASTER_RELEASE, aggregate_id: domesticReleaseId, version: this.store.versionOf(AT.MASTER_RELEASE, domesticReleaseId) }],
      payload: {
        production_id: productionId,
        episode_no: episodeNo,
        domestic_release_id: domesticReleaseId,
        master_sha256: masterSha256,
        changes_summary: changesSummary,
      },
    });
    created.push(made.event);

    // 海外版本精确触发 overseas 重审。
    const after = reduceEvents(this.store.allEvents());
    const rid = reviewId(productionId, episodeNo);
    const r = after.reviews.get(rid);
    if (r && !r.rereviewTriggers.some((t) => t.trigger === "overseas_version" && t.evidence_event_ids.includes(made.event.event_id))) {
      created.push(
        this.#append({
          event_type: ET.REREVIEW_TRIGGERED,
          aggregate_type: AT.REVIEW_SUBMISSION,
          aggregate_id: rid,
          summary: "海外版本触发 overseas 路径重审",
          actor_id: actorId,
          causation_id: made.event.event_id,
          payload: {
            production_id: productionId,
            episode_no: episodeNo,
            trigger: "overseas_version",
            evidence_event_ids: [made.event.event_id],
            required_path: reviewPaths.OVERSEAS,
          },
        }).event,
      );
    }
    return created;
  }

  deliverToPlatform({ productionId, platformId, programId, masterReleaseId, rightsProofRefs, actorId, packageDigest }) {
    const state = this.state;
    this.#requireProduction(state, productionId);
    const master = state.masters.get(masterReleaseId);
    if (!master || master.production_id !== productionId) throw new LedgerError("交付目标母版不存在", "MASTER_NOT_FOUND");
    if (!state.releasedMasterDigests.has(master.master_sha256) || master.is_overseas_version) {
      throw new LedgerError("只能交付已通过 MASTER_RELEASED 放行的母版", "MASTER_NOT_RELEASED");
    }
    const r = state.reviews.get(reviewId(productionId, master.episode_no));
    if (r?.pendingRereview) throw new LedgerError("该集重审待决，不能交付", "REREVIEW_PENDING");
    for (const ref of rightsProofRefs) {
      if (!state.scripts.has(ref)) throw new LedgerError(`权利证明不存在：${ref}`, "RIGHTS_NOT_FOUND");
    }

    return this.#append({
      event_type: ET.RELEASE_DELIVERED,
      aggregate_type: AT.DISTRIBUTION_GRANT,
      aggregate_id: `grant:${productionId}:${platformId}`,
      summary: `向 ${platformId} 交付节目 ${programId} 的放行母版与权利证明`,
      actor_id: actorId,
      correlation_id: productionId,
      lineage: [
        { aggregate_type: AT.MASTER_RELEASE, aggregate_id: masterReleaseId, version: this.store.versionOf(AT.MASTER_RELEASE, masterReleaseId) },
        ...rightsProofRefs.map((ref) => ({ aggregate_type: AT.SCRIPT_RIGHT, aggregate_id: ref, version: this.store.versionOf(AT.SCRIPT_RIGHT, ref) })),
      ],
      payload: {
        production_id: productionId,
        platform_id: platformId,
        program_id: programId,
        master_ref: masterReleaseId,
        master_sha256: master.master_sha256,
        rights_proof_refs: rightsProofRefs,
        package_digest: packageDigest,
        disclosure: "released_master_and_rights_only",
      },
    }).event;
  }

  #suspendGrants(state, { productionId, episodeNo = null, reason, triggerEventId, actorId }) {
    const suspended = [];
    for (const grant of state.grants.values()) {
      if (grant.production_id !== productionId || grant.suspended) continue;
      if (episodeNo !== null) {
        const master = state.masters.get(grant.master_ref);
        if (!master || master.episode_no !== episodeNo) continue;
      }
      suspended.push(
        this.#append({
          event_type: ET.DISTRIBUTION_SUSPENDED,
          aggregate_type: AT.DISTRIBUTION_GRANT,
          aggregate_id: grant.grant_id,
          summary: `挂起平台 ${grant.platform_id} 取片：${reason}`,
          actor_id: actorId,
          causation_id: triggerEventId,
          payload: {
            production_id: productionId,
            platform_id: grant.platform_id,
            reason,
            trigger_event_id: triggerEventId,
          },
        }).event,
      );
    }
    return suspended;
  }
}

export { cutId, reviewId };
