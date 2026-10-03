/**
 * AI 短剧制片总账 —— 领域目录（事件类型 / 聚合类型 / 角色 / 枚举的唯一事实源）。
 *
 * 兼容性约定（只做加法，不做破坏式修改）：
 * - 信封必填字段仍为 domainEventFields 列出的 7 项；
 * - 既有事件 ASSET_GENERATED / CUT_SEALED / TIER_ASSESSED / REVIEW_DECIDED /
 *   RELEASE_DELIVERED 继续可用，语义不收紧；
 * - version 仍是“同一聚合流上从 1 开始严格递增的正整数”；
 * - 新增能力全部通过新事件类型与可选信封字段表达。
 */

// ---------------------------------------------------------------------------
// 事件信封
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DomainEvent
 * @property {string} event_id        事件唯一标识
 * @property {string} event_type      事件类型（见 eventTypes）
 * @property {string} aggregate_type  聚合类型（见 aggregateTypes）
 * @property {string} aggregate_id    聚合流标识
 * @property {string} occurred_at     ISO-8601 发生时间
 * @property {number} version         聚合流内版本号，从 1 起严格递增
 * @property {string} summary         人类可读摘要
 * @property {string} [idempotency_key] 幂等键（外部工具回调重试时复用，登记且只登记一次）
 * @property {string} [correlation_id]  关联标识（如一个制作单贯穿全链）
 * @property {string} [causation_id]     因果事件（本事件由哪条事件触发）
 * @property {string} [actor_id]         执行人账号
 * @property {Signature} [signature]     有权人员签署（最终分类 / 放行等决定类事件必须携带）
 * @property {LineageRef[]} [lineage]    直接输入产物（构成有向谱系的边）
 * @property {Object} [payload]          事件载荷，键约定见 eventCatalog
 */

/**
 * @typedef {Object} Signature
 * @property {string} signer_id
 * @property {string} signer_role   见 roles
 * @property {string} algorithm     目前固定 HS256（HMAC-SHA256 规范串）
 * @property {string} value         十六进制摘要
 * @property {string} signed_at     ISO-8601
 */

/**
 * @typedef {Object} LineageRef
 * @property {string} aggregate_type
 * @property {string} aggregate_id
 * @property {number} version       引用发生时的上游版本（谱系边带版本，防止漂移）
 */

export const domainEventFields = Object.freeze([
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
]);

// ---------------------------------------------------------------------------
// 聚合类型（前四项为既有契约，顺序保留）
// ---------------------------------------------------------------------------

export const aggregateTypes = Object.freeze({
  PRODUCTION_ASSET: "production_asset", // 既有：生成产物（镜头/图/片段的统称）
  EPISODE_CUT: "episode_cut", // 既有：单集成片（封版 / 重剪流）
  REVIEW_SUBMISSION: "review_submission", // 既有：审核链（建议/提交/决定/重审）
  CONTRIBUTION_ENTRY: "contribution_entry", // 既有：人员贡献与署名分账
  PRODUCTION: "production", // 制作单（节目）：冻结题材与投资口径
  SCRIPT_RIGHT: "script_right", // 剧本权利
  CHARACTER_ASSET: "character_asset", // 角色图
  SCENE_ASSET: "scene_asset", // 场景资产
  CONTINUITY_BASELINE: "continuity_baseline", // 跨集复用角色的连续性基线
  PROMPT_INPUT: "prompt_input", // 提示输入摘要（摘要/密文引用，非明文）
  SHOT: "shot", // 镜头（带时间轴信息的生成产物）
  AUDIO_TRACK: "audio_track", // 配音 / 音乐
  COST_ENTRY: "cost_entry", // 实际成本
  MASTER_RELEASE: "master_release", // 已放行母版（含海外版本）
  DISTRIBUTION_GRANT: "distribution_grant", // 面向发行平台的交付授权
});

// ---------------------------------------------------------------------------
// 事件类型（前五项为既有契约）
// ---------------------------------------------------------------------------

export const eventTypes = Object.freeze({
  // —— 既有事件（语义保持不变）——
  ASSET_GENERATED: "ASSET_GENERATED", // 外部模型工具登记一件生成产物
  CUT_SEALED: "CUT_SEALED", // 单集封版，产生带校验值的母版
  TIER_ASSESSED: "TIER_ASSESSED", // 系统依据冻结口径“建议”审核路径（非决定）
  REVIEW_DECIDED: "REVIEW_DECIDED", // 有权人员签署最终分类与内容决定
  RELEASE_DELIVERED: "RELEASE_DELIVERED", // 向发行平台交付最小披露包

  // —— 制作单与口径 ——
  PRODUCTION_OPENED: "PRODUCTION_OPENED",
  SCOPE_FROZEN: "SCOPE_FROZEN", // 冻结题材与投资口径
  SCOPE_REVISED: "SCOPE_REVISED", // 财务口径变更（触发重新评估）

  // —— 权利 / 角色 / 场景 ——
  SCRIPT_RIGHT_REGISTERED: "SCRIPT_RIGHT_REGISTERED",
  CHARACTER_REGISTERED: "CHARACTER_REGISTERED",
  SCENE_REGISTERED: "SCENE_REGISTERED",
  CONTINUITY_BASELINE_LOCKED: "CONTINUITY_BASELINE_LOCKED", // 锁定连续性基线

  // —— 提示 / 生成 / 人工 ——
  PROMPT_DIGEST_RECORDED: "PROMPT_DIGEST_RECORDED",
  SHOT_REJECTED: "SHOT_REJECTED", // 镜头被否决：制作级黑名单，不得混入后继集次
  HUMAN_REVISION_RECORDED: "HUMAN_REVISION_RECORDED", // 人工修订
  AUDIO_ADDED: "AUDIO_ADDED",

  // —— 成本 / 贡献 ——
  COST_POSTED: "COST_POSTED",
  CONTRIBUTION_POSTED: "CONTRIBUTION_POSTED",

  // —— 剪辑 / 审核 / 母版 / 发行 ——
  CUT_REVISED: "CUT_REVISED", // 重剪登记（随后新 CUT_SEALED）
  REVIEW_SUBMITTED: "REVIEW_SUBMITTED",
  REVIEW_RESUBMITTED: "REVIEW_RESUBMITTED", // 退回后的替换提交
  REREVIEW_TRIGGERED: "REREVIEW_TRIGGERED", // 成本追加/重剪/海外版本精确触发的重审
  MASTER_RELEASED: "MASTER_RELEASED",
  OVERSEAS_VERSION_CREATED: "OVERSEAS_VERSION_CREATED",
  DISTRIBUTION_SUSPENDED: "DISTRIBUTION_SUSPENDED", // 重审期间冻结平台取片
});

/**
 * 事件目录：事件允许落到哪些聚合流，以及 payload 至少要携带的业务键。
 * payloadRequired 只规定最低集合，允许追加键（additionalProperties 放开）。
 */
export const eventCatalog = Object.freeze({
  ASSET_GENERATED: {
    aggregates: [aggregateTypes.PRODUCTION_ASSET, aggregateTypes.SHOT],
    payloadRequired: ["output_uri", "sha256", "model_provider", "model_version"],
    label: "生成产物登记（外部回调，幂等）",
  },
  CUT_SEALED: {
    aggregates: [aggregateTypes.EPISODE_CUT],
    payloadRequired: ["production_id", "episode_no", "cut_revision", "master_sha256", "timeline"],
    label: "单集封版",
  },
  TIER_ASSESSED: {
    aggregates: [aggregateTypes.REVIEW_SUBMISSION],
    payloadRequired: ["production_id", "episode_no", "scope_snapshot", "suggested_path", "reasons"],
    label: "审核路径建议（系统提示，非决定）",
  },
  REVIEW_DECIDED: {
    aggregates: [aggregateTypes.REVIEW_SUBMISSION],
    payloadRequired: ["production_id", "episode_no", "decision", "classification", "cut_revision", "master_sha256"],
    label: "最终分类与内容决定（人工签署）",
    requiresSignature: true,
  },
  RELEASE_DELIVERED: {
    aggregates: [aggregateTypes.DISTRIBUTION_GRANT],
    payloadRequired: ["production_id", "platform_id", "program_id", "master_ref", "rights_proof_refs", "package_digest"],
    label: "发行交付（最小披露包）",
  },

  PRODUCTION_OPENED: {
    aggregates: [aggregateTypes.PRODUCTION],
    payloadRequired: ["title", "genre_scope", "investment_basis"],
    label: "开立制作单",
  },
  SCOPE_FROZEN: {
    aggregates: [aggregateTypes.PRODUCTION],
    payloadRequired: ["genre_scope", "investment_basis", "frozen_at"],
    label: "冻结题材与投资口径",
  },
  SCOPE_REVISED: {
    aggregates: [aggregateTypes.PRODUCTION],
    payloadRequired: ["investment_basis", "change_request_id"],
    label: "投资口径变更（财务统计调整）",
  },

  SCRIPT_RIGHT_REGISTERED: {
    aggregates: [aggregateTypes.SCRIPT_RIGHT],
    payloadRequired: ["production_id", "title", "rights_owner", "license_scope", "evidence_ref", "digest"],
    label: "剧本权利登记",
  },
  CHARACTER_REGISTERED: {
    aggregates: [aggregateTypes.CHARACTER_ASSET],
    payloadRequired: ["production_id", "character_code", "source_account_id", "digest"],
    label: "角色图登记",
  },
  SCENE_REGISTERED: {
    aggregates: [aggregateTypes.SCENE_ASSET],
    payloadRequired: ["production_id", "scene_code", "source_account_id", "digest"],
    label: "场景资产登记",
  },
  CONTINUITY_BASELINE_LOCKED: {
    aggregates: [aggregateTypes.CONTINUITY_BASELINE],
    payloadRequired: [
      "production_id",
      "character_id",
      "locked_from_episode",
      "character_asset_version",
      "character_digest",
      "traits_snapshot",
    ],
    label: "锁定角色连续性基线",
  },

  PROMPT_DIGEST_RECORDED: {
    aggregates: [aggregateTypes.PROMPT_INPUT],
    payloadRequired: ["production_id", "prompt_digest", "created_by"],
    label: "提示输入摘要登记（不留明文给发行侧）",
  },
  SHOT_REJECTED: {
    aggregates: [aggregateTypes.PRODUCTION_ASSET, aggregateTypes.SHOT],
    payloadRequired: ["production_id", "reason", "rejected_by"],
    label: "镜头否决（制作级黑名单）",
  },
  HUMAN_REVISION_RECORDED: {
    aggregates: [aggregateTypes.PRODUCTION_ASSET, aggregateTypes.SHOT],
    payloadRequired: ["production_id", "revision_of", "editor_id", "output_uri", "sha256"],
    label: "人工修订",
  },
  AUDIO_ADDED: {
    aggregates: [aggregateTypes.AUDIO_TRACK],
    payloadRequired: ["production_id", "episode_no", "kind", "work_ref", "license_ref", "digest"],
    label: "配音 / 音乐登记",
  },

  COST_POSTED: {
    aggregates: [aggregateTypes.COST_ENTRY],
    payloadRequired: ["production_id", "amount", "currency", "category", "source_statement_id"],
    label: "实际成本入账",
  },
  CONTRIBUTION_POSTED: {
    aggregates: [aggregateTypes.CONTRIBUTION_ENTRY],
    payloadRequired: ["production_id", "person_id", "person_name", "roles", "share_terms"],
    label: "人员贡献 / 署名 / 分账依据",
  },

  CUT_REVISED: {
    aggregates: [aggregateTypes.EPISODE_CUT],
    payloadRequired: ["production_id", "episode_no", "based_on_cut_revision", "reason"],
    label: "重剪登记",
  },
  REVIEW_SUBMITTED: {
    aggregates: [aggregateTypes.REVIEW_SUBMISSION],
    payloadRequired: ["production_id", "episode_no", "path", "submitted_by", "cut_revision", "master_sha256", "package_digest"],
    label: "送审提交",
  },
  REVIEW_RESUBMITTED: {
    aggregates: [aggregateTypes.REVIEW_SUBMISSION],
    payloadRequired: ["production_id", "episode_no", "path", "submitted_by", "supersedes_event_id", "cut_revision", "master_sha256", "package_digest"],
    label: "退回后替换提交",
  },
  REREVIEW_TRIGGERED: {
    aggregates: [aggregateTypes.REVIEW_SUBMISSION],
    payloadRequired: ["production_id", "episode_no", "trigger", "evidence_event_ids", "required_path"],
    label: "精确触发重审",
  },
  MASTER_RELEASED: {
    aggregates: [aggregateTypes.MASTER_RELEASE],
    payloadRequired: ["production_id", "episode_no", "cut_id", "cut_revision", "master_sha256", "program_id", "release_scope"],
    label: "母版放行（签署）",
    requiresSignature: true,
  },
  OVERSEAS_VERSION_CREATED: {
    aggregates: [aggregateTypes.MASTER_RELEASE],
    payloadRequired: ["production_id", "episode_no", "domestic_release_id", "master_sha256", "changes_summary"],
    label: "海外版本制作（触发海外重审）",
  },
  DISTRIBUTION_SUSPENDED: {
    aggregates: [aggregateTypes.DISTRIBUTION_GRANT],
    payloadRequired: ["production_id", "platform_id", "reason", "trigger_event_id"],
    label: "重审期间暂停发行授权",
  },
});

// ---------------------------------------------------------------------------
// 人员角色（一个人可兼任多角色，贡献事件按 roles 数组记录）
// ---------------------------------------------------------------------------

export const roles = Object.freeze({
  SCRIPTWRITER: "scriptwriter", // 编剧
  DIRECTOR: "director", // 导演
  STORYBOARD: "storyboard", // 分镜
  GENERATOR: "generator", // 生成操作
  EDITOR: "editor", // 剪辑
  VOICE: "voice", // 配音
  PRODUCER: "producer", // 制片人
  FINANCE: "finance", // 财务
  PLATFORM_REVIEWER: "platform_reviewer", // 平台审核档签署人
  PROVINCIAL_REVIEWER: "provincial_reviewer", // 省级送审档签署人
  COMPLIANCE_ADMIN: "compliance_admin", // 合规管理员（口径冻结 / 黑名单等）
});

// ---------------------------------------------------------------------------
// 业务枚举
// ---------------------------------------------------------------------------

// 系统可“建议”的审核路径；最终生效路径以 REVIEW_DECIDED 签署为准
export const reviewPaths = Object.freeze({
  PLATFORM: "platform", // 平台审核档
  PROVINCIAL: "provincial", // 省级送审档
  OVERSEAS: "overseas", // 海外版本路径
});

export const reviewDecisions = Object.freeze({
  APPROVED: "approved", // 放行
  RETURNED: "returned", // 退回补正（替换后重交）
  REJECTED: "rejected", // 内容否决
});

export const rereviewTriggers = Object.freeze({
  COST_THRESHOLD_CROSSED: "cost_threshold_crossed", // 追加成本导致跨档
  SCOPE_REVISED: "scope_revised", // 冻结口径变化
  CUT_REVISED: "cut_revised", // 重剪
  OVERSEAS_VERSION: "overseas_version", // 海外版本
});

export const audioKinds = Object.freeze({
  VOICE: "voice",
  MUSIC: "music",
});

export const releaseScopes = Object.freeze({
  DOMESTIC: "domestic",
  OVERSEAS: "overseas",
});

/**
 * 路径 → 有权签署的角色。系统建议（TIER_ASSESSED）不在此表中：它不产生效力。
 */
export const pathSignerRoles = Object.freeze({
  [reviewPaths.PLATFORM]: [roles.PLATFORM_REVIEWER],
  [reviewPaths.PROVINCIAL]: [roles.PROVINCIAL_REVIEWER],
  [reviewPaths.OVERSEAS]: [roles.PROVINCIAL_REVIEWER, roles.COMPLIANCE_ADMIN],
});

export const allEventTypes = Object.freeze(Object.values(eventTypes));
export const allAggregateTypes = Object.freeze(Object.values(aggregateTypes));
