/**
 * 领域事件信封字段约定。
 *
 * @typedef {Object} DomainEvent
 * @property {string} event_id          事件全局唯一 id（重复登记只保留首次）
 * @property {string} event_type        见 EVENT_TYPES
 * @property {string} aggregate_type    见 AGGREGATE_TYPES
 * @property {string} aggregate_id      聚合流 id
 * @property {string} occurred_at       ISO-8601 发生时间
 * @property {number} version           聚合流内序号，从 1 起逐加 1（不是结构版本）
 * @property {string} summary           人读摘要
 * @property {string} [idempotency_key] 外部回调幂等键
 * @property {{person_id:string, display_name?:string, roles?:string[]}} [actor]
 * @property {string} [causation_id]    命令/上游事件 id
 * @property {string} [correlation_id]  流程关联 id
 * @property {{schema_version?:number} & Record<string, unknown>} [payload]
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

/**
 * 事件类型。前 5 个为 v1 既有事件，顺序与原契约一致，永不删改语义；
 * 新增事件只能追加在后面。每项记录：
 * - aggregate：归属聚合类型
 * - since：引入时的 payload schema_version（信封 version 语义不变）
 * - signable：是否为必须由有权真人签署的决定类事件
 */
const EVENT_CATALOG = {
  ASSET_GENERATED: { aggregate: "production_asset", since: 1 },
  CUT_SEALED: { aggregate: "episode_cut", since: 1 },
  TIER_ASSESSED: { aggregate: "review_submission", since: 1 },
  REVIEW_DECIDED: { aggregate: "review_submission", since: 1, signable: true },
  RELEASE_DELIVERED: { aggregate: "episode_cut", since: 1 },

  SCRIPT_RIGHTS_REGISTERED: { aggregate: "script_rights", since: 2 },
  PRODUCTION_SCOPE_FROZEN: { aggregate: "production_scope", since: 2 },
  PRODUCTION_SCOPE_AMENDED: { aggregate: "production_scope", since: 2 },
  CHARACTER_BASELINE_LOCKED: { aggregate: "character_baseline", since: 2 },
  SHOT_REJECTED: { aggregate: "shot", since: 2 },
  SHOT_REGENERATION_REQUESTED: { aggregate: "shot", since: 2 },
  SHOT_MANUALLY_REVISED: { aggregate: "shot", since: 2 },
  TAKE_ACCEPTED: { aggregate: "shot", since: 2 },
  VOICE_MUSIC_LINKED: { aggregate: "production_asset", since: 2 },
  CONTRIBUTION_LEDGERED: { aggregate: "contribution_entry", since: 2 },
  COST_LEDGERED: { aggregate: "episode_cut", since: 2 },
  REVIEW_PATH_SUGGESTED: { aggregate: "episode_review", since: 2 },
  REVIEW_CLASSIFICATION_SIGNED: { aggregate: "episode_review", since: 2, signable: true },
  REVIEW_SUBMITTED: { aggregate: "episode_review", since: 2, signable: true },
  REVIEW_RETURNED: { aggregate: "episode_review", since: 2, signable: true },
  REVIEW_APPROVED: { aggregate: "episode_review", since: 2, signable: true },
  REVIEW_RESUBMITTED: { aggregate: "episode_review", since: 2, signable: true },
  REVIEW_REASSESSMENT_TRIGGERED: { aggregate: "episode_review", since: 2 },
  MASTER_REPLACED: { aggregate: "episode_cut", since: 2 },
  RELEASE_PACKAGE_PUBLISHED: { aggregate: "release_package", since: 2, signable: true },
  RELEASE_ACCESS_GRANTED: { aggregate: "release_package", since: 2 },
};

/**
 * 聚合类型。前 4 个为 v1 既有聚合，只能追加。
 * @type {readonly string[]}
 */
const AGGREGATE_CATALOG = {
  production_asset: { since: 1 },
  episode_cut: { since: 1 },
  review_submission: { since: 1 },
  contribution_entry: { since: 1 },

  script_rights: { since: 2 },
  production_scope: { since: 2 },
  character_baseline: { since: 2 },
  shot: { since: 2 },
  episode_review: { since: 2 },
  release_package: { since: 2 },
};

export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_CATALOG));
export const AGGREGATE_TYPES = Object.freeze(Object.keys(AGGREGATE_CATALOG));
export const LEGACY_EVENT_TYPES = Object.freeze(
  EVENT_TYPES.filter((t) => EVENT_CATALOG[t].since === 1),
);
export const LEGACY_AGGREGATE_TYPES = Object.freeze(
  AGGREGATE_TYPES.filter((t) => AGGREGATE_TYPES.indexOf(t) < 4),
);

export const SIGNABLE_EVENTS = Object.freeze(
  EVENT_TYPES.filter((t) => EVENT_CATALOG[t].signable),
);

export function eventSpec(eventType) {
  return EVENT_CATALOG[eventType] ?? null;
}

export function aggregateOf(eventType) {
  return EVENT_CATALOG[eventType]?.aggregate ?? null;
}

/** 制作口径中的题材冻结值。系统只提示路径，不自动分类。 */
export const GENRES = Object.freeze([
  "other",
  "historical",
  "major_revolution",
  "foreign_affairs",
  "minority_religion",
  "judicial_public_security",
  "diplomacy",
]);

/**
 * 审核路径（按中国网络剧片常见分层建模为业务枚举，数值以平台/属地规则为准）。
 * 系统依据冻结口径给出 advisory（建议），最终路径必须由分类签署人决定。
 */
export const REVIEW_PATHS = Object.freeze({
  PLATFORM: "platform_self_review",
  PROVINCIAL: "provincial_administration_submission",
  NATIONAL: "national_administration_submission",
});

/** 触发重审的变更类型；追加成本、重剪、海外版本必须精确命中。 */
export const REASSESSMENT_TRIGGERS = Object.freeze([
  "investment_threshold_crossed",
  "scope_amended",
  "master_reedited",
  "overseas_version_added",
  "rights_change",
]);

/** 镜头被否决的原因分类；被否决镜头禁止重新混入后继集次。 */
export const SHOT_REJECTION_REASONS = Object.freeze([
  "rights",
  "safety_policy",
  "continuity_violation",
  "quality",
  "other",
]);

/** 资产种类。未采用提示与个人素材不进入发行投影。 */
export const ASSET_KINDS = Object.freeze([
  "character_sheet",
  "scene_plate",
  "shot_take",
  "voice",
  "music",
  "master",
  "prompt_input",
  "personal_reference",
]);

export const CONTRIBUTOR_ROLES = Object.freeze([
  "screenwriter",
  "director",
  "storyboard_artist",
  "generation_operator",
  "editor",
  "voice_artist",
  "music_composer",
  "reviewer",
]);
