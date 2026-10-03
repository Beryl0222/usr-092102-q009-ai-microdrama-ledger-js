# 领域事件目录与不变量

本文档是“AI 短剧制片总账”的领域契约说明。代码词汇表以 `src/domain.js` 为准，JSON 交换格式以 `contracts/domain.schema.json` 为准。

## 1. 版本策略：信封 version 与 payload.schema_version 分离

- 信封 `version`：**聚合流内追加序号**，从 1 起连续递增，不跳号、不复用。它不是结构版本号。
- `payload.schema_version`：该事件类型负载的结构版本，按事件类型独立演进。
- v1 兼容性（硬性要求，测试守护）：
  - 前 5 个事件类型与前 4 个聚合类型的枚举值、顺序与原义**永不删改**；
  - 无 `payload` 的 v1 旧信封继续合法、可回放（见 `tests/contract.test.js`）；
  - 新事件类型 / 聚合类型只能在枚举尾部追加。
- 账本只追加（append-only）：事件不可修改、不可删除；任何“改变”都是新事件（修订、退回、替换、重审）。

## 2. 事件目录

| 事件 | 聚合 | since | 需签署 | 含义 |
|---|---|---|---|---|
| `ASSET_GENERATED` | production_asset | 1 | | 登记一次真实生成产物（角色图/场景/镜头/配音/音乐/提示/个人素材） |
| `CUT_SEALED` | episode_cut | 1 | | 成片封版（含母版校验值与封版资产清单） |
| `TIER_ASSESSED` | review_submission | 1 | | v1 遗留档位评估，继续可回放 |
| `REVIEW_DECIDED` | review_submission | 1 | 是 | v1 遗留审核决定 |
| `RELEASE_DELIVERED` | episode_cut | 1 | | v1 遗留交付 |
| `SCRIPT_RIGHTS_REGISTERED` | script_rights | 2 | | 剧本权利链：权利人、作者、授权范围、地域、到期、底稿 hash |
| `PRODUCTION_SCOPE_FROZEN` | production_scope | 2 | | 冻结题材与投资口径（审核口径基准） |
| `PRODUCTION_SCOPE_AMENDED` | production_scope | 2 | | 口径修订（只记事实，是否触发重审由规则判定） |
| `CHARACTER_BASELINE_LOCKED` | character_baseline | 2 | | 锁定角色连续性基线（资产+指纹） |
| `SHOT_REJECTED` | shot | 2 | | 镜头否决（原因分类；hash 进入跨集拉黑集） |
| `SHOT_REGENERATION_REQUESTED` | shot | 2 | | 请求重生成（指向父镜头） |
| `SHOT_MANUALLY_REVISED` | shot | 2 | | 人工修订（剪辑/手绘等，指向修订后资产） |
| `TAKE_ACCEPTED` | shot | 2 | | 镜头采用某资产 |
| `VOICE_MUSIC_LINKED` | production_asset | 2 | | 配音/音乐关联资产与授权底稿 |
| `CONTRIBUTION_LEDGERED` | contribution_entry | 2 | | 人员贡献与分账基点（bps） |
| `COST_LEDGERED` | episode_cut | 2 | | 实际成本明细，可挂因果事件 id |
| `REVIEW_PATH_SUGGESTED` | episode_review | 2 | | 系统**建议**路径（advisory，不是决定） |
| `REVIEW_CLASSIFICATION_SIGNED` | episode_review | 2 | 是 | 有权人员签署最终分类（覆盖建议须留 justification） |
| `REVIEW_SUBMITTED` | episode_review | 2 | 是 | 提交送审（首轮） |
| `REVIEW_RETURNED` | episode_review | 2 | 是 | 审核退回（原因留痕） |
| `REVIEW_APPROVED` | episode_review | 2 | 是 | 审核通过（绑定母版 hash） |
| `REVIEW_RESUBMITTED` | episode_review | 2 | 是 | 退回后重新提交（新轮次） |
| `REVIEW_REASSESSMENT_TRIGGERED` | episode_review | 2 | | 精确重审触发（见 §4） |
| `MASTER_REPLACED` | episode_cut | 2 | | 母版替换（重剪/海外版本，保留前后 hash） |
| `RELEASE_PACKAGE_PUBLISHED` | release_package | 2 | 是 | 放行发行包（最小披露内容） |
| `RELEASE_ACCESS_GRANTED` | release_package | 2 | | 向发行平台交付 |

“需签署”事件必须携带具有相应角色的 `actor.person_id`（真人负责，系统不得自动签署）。

## 3. 核心不变量

1. **幂等登记一次真实产物**：`event_id` 全局唯一；`idempotency_key` 按业务指纹（asset/hash/…）去重。回调乱序或重试：同指纹 → 返回原事件（`duplicate=true`），异指纹冒用同键 → `IDEMPOTENCY_CONFLICT`。
2. **流顺序不可变**：version 必须等于流内下一序号；乱序送达不插队、不重写历史。
3. **被否决镜头不得回流**：被否资产（按 id 与 content_hash）及其**任意深度后代**不得登记进入任何集次；封版与放行再做一次来源链洁净检查。
4. **跨集角色基线锁定**：声明 `continuity_base` 的资产，其角色必须已 `CHARACTER_BASELINE_LOCKED`，且基线指纹一致，否则 `BASELINE_NOT_LOCKED` / `BASELINE_DRIFT`。
5. **建议 ≠ 决定**：系统依据冻结口径产出 `REVIEW_PATH_SUGGESTED`；分类只能由分类签署人 `REVIEW_CLASSIFICATION_SIGNED`；与建议不同必须填写 `justification`。未签署不得送审，送审路径必须等于签署路径。
6. **放行只认真实通过的当前母版**：放行时母版 hash 必须是该集当前母版且等于审核通过绑定的 hash；母版一旦替换，旧批准不覆盖新母版。

## 4. 精确重审触发

只有以下情形触发 `REVIEW_REASSESSMENT_TRIGGERED`（触发即清空签署分类、要求重签，并同步产出新的系统建议）：

| 触发值 | 何时发生 |
|---|---|
| `scope_amended` | 冻结口径的题材改变，或投资额跨入更高审核档位 |
| `investment_threshold_crossed` | **累计实际成本**（不是单笔）跨入更高档位 |
| `master_reedited` | 母版重剪替换 |
| `overseas_version_added` | 新增海外版本母版 |
| `rights_change` | 权利链变更（命令显式声明） |

档位内的小额追加、同档口径波动**不**触发。阈值表在 `src/review.js` 的 `DEFAULT_RULES`，可按属地规则注入；示例数值不构成监管口径。

## 5. 披露边界

- **发行平台**（`releaseView`）：仅 `master`（hash/uri/时长/算法）、`program_id`、必要 `rights_proofs`（核验字段，无底稿全文）、交付记录。绝不输出提示词、个人素材、废镜头、成本、人员明细。
- **制片人**（`traceFrame`）：可从线上一帧回溯整条谱系——来源资产、模型版本、提示摘要、人工修订、配音音乐、成本、贡献、审核状态。
- **创作者**（`contributorStatement`）：本人署名角色、分成基点、贡献资产是否进入已放行母版。
- **监管**（`regulatorDossier`）：冻结口径与全部修订、建议与签署（含覆盖理由）、每一轮提交/退回/重提/通过、母版版本链，以及带 `event_id` 的完整时间线。

## 6. 端到端样例

`scripts/scenario.js` 构建两集并行制作的完整生命周期（含 5 起被拦截的违规尝试），可通过

```bash
node scripts/build-lifecycle.mjs   # 写出 data/lifecycle.json
npm test
```

复现：回调重试去重、被否镜头本集/跨集复用拦截、未锁基线/基线漂移拦截、口径与成本精确跨档、退回重审、海外版本重审、发行最小披露、帧溯源、创作者对账与监管卷宗。
