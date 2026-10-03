# AI 短剧制片总账

把剧本权利、角色与场景资产、提示输入摘要、模型版本、镜头生成、人工修订、配音音乐、
人员贡献、实际成本与成片校验值串成**一条有向谱系**的事件溯源总账。系统只依据冻结口径
**提示**审核路径；最终分类、放行与内容决定必须由有权人员**签署**。

## 设计原则

- **只追加的事件日志**：事实不可改写；退回、替换、重剪、重审都以新事件表达，历史完整可导出。
- **契约只做加法**：建仓时的 5 个事件、4 个聚合、7 个信封字段与 `version` 语义全部保留；
  新能力通过新事件类型与可选信封字段（`payload` / `lineage` / `signature` / `idempotency_key` …）承载。
- **建议与决定分离**：`TIER_ASSESSED` 永远只是系统建议；`REVIEW_DECIDED` / `MASTER_RELEASED`
  必须携带授权角色的 HMAC-SHA256 签署，且签署绑定确切封版版本与母版摘要。
- **访问边界固化在投影里**：发行平台视图在结构上不引用提示、个人素材与未采用产物。

## 目录

| 路径 | 作用 |
| --- | --- |
| `contracts/domain.schema.json` | 事件信封 JSON Schema（枚举与新字段的对外契约） |
| `src/domain.js` | 事件/聚合/角色/枚举的唯一事实源与事件目录 `eventCatalog` |
| `src/store.js` | 只追加事件存储：流内版本、乐观并发、全局幂等键、历史回放 |
| `src/validator.js` | `validateEvent`（建仓时宽松校验，保持不回归）与 `validateEventStrict` |
| `src/crypto.js` | 规范串、HMAC-SHA256 人工签署与验签、内容指纹 |
| `src/policy.js` | 纯规则：冻结口径 → 路径建议、跨档检测、精确重审触发白名单 |
| `src/state.js` | 事件流 → 当前状态的纯归约器（含角色版本指纹史、否决名单等） |
| `src/ledger.js` | 命令层：全部不变量检查与签署后落库 |
| `src/lineage.js` | 有向谱系图、祖先/后继遍历、单件产物完整溯源 |
| `src/projections.js` | 四方只读投影：制片人 / 创作者 / 发行平台 / 监管导出 |
| `tests/` | 32 项测试：契约兼容、存储语义、总账不变量、端到端投影 |

## 关键不变量（均有测试覆盖）

1. **否决镜头永不复活**：`SHOT_REJECTED` 同时按资产 id 与内容 `sha256` 入制作级黑名单；
   换 id 重新登记、人工修订、混入后继集次时间轴一律拒绝。
2. **跨集复用必须锁定连续性基线**：角色首用集自由使用；跨集引用前必须
   `CONTINUITY_BASELINE_LOCKED`，且引用版本+指纹必须精确命中基线（角色资产后续演进不影响基线）。
3. **外部回调只登记一次真实产物**：`idempotency_key`（如 `callback:<工具回调id>`、
   `cost-statement:<财务单号>`）全总账唯一；乱序/重试返回首条事件，不覆盖、不二次通知。
4. **系统只建议路径**：口径未冻结不建议；投资额达阈值或题材标记可独立指向省级送审档。
5. **决定必须签署且角色匹配**：平台档/省级档/海外路径各有授权角色；签署覆盖事件 id、
   流、版本、时刻与 payload，落库后二次验签；母版摘要与封版记录不一致即拒。
6. **精确重审**：仅四类变化各自触发——追加成本恰好越线（`cost_threshold_crossed`）、
   冻结口径修订跨档（`scope_revised`）、重剪（`cut_revised`）、海外版本（`overseas_version`）；
   重审待决期间母版不得放行，已交付平台的授权被 `DISTRIBUTION_SUSPENDED` 挂起。
7. **退回替换可追溯**：仅"退回补正"状态可 `REVIEW_RESUBMITTED`，且必须基于更新的封版版本，
   事件带 `supersedes_event_id` 形成替换链。
8. **发行最小披露**：平台包只含已放行母版（引用+sha256）、节目编号、必要权利证明；
   序列化结构中断言不含提示摘要、工具来源账号、个人素材、内部成本。

## 四方投影

- 制片人：`frameProvenance(events, {productionId, episodeNo, cutRevision, timeSec})`
  —— 从线上一帧定位镜头，展开来源（剧本/角色/场景/提示/音轨）、模型版本、成本、贡献者、
  所属封版、审核状态、放行母版与发行去向。
- 创作者：`creatorStatement(events, personId, distributableByProduction)`
  —— 核对署名角色、本人操作产物，并按分账条款（百分比/固定）试算收益。
- 发行平台：`platformPackage(events, {productionId, platformId})`
  —— 最小披露包；授权挂起时 `available:false`。
- 监管：`regulatoryExport(events, productionId)`
  —— 冻结口径、成本、每集的建议/每次提交/替换链/每次决定/重审触发、完整事件轨迹，
  附规范 JSON 的清单 `sha256`。

## 事件目录速览

```
制作单  PRODUCTION_OPENED · SCOPE_FROZEN · SCOPE_REVISED
资产    SCRIPT_RIGHT_REGISTERED · CHARACTER_REGISTERED · SCENE_REGISTERED
        CONTINUITY_BASELINE_LOCKED · PROMPT_DIGEST_RECORDED
        ASSET_GENERATED · SHOT_REJECTED · HUMAN_REVISION_RECORDED · AUDIO_ADDED
账目    COST_POSTED · CONTRIBUTION_POSTED
成片    CUT_SEALED · CUT_REVISED
审核    TIER_ASSESSED(建议) · REVIEW_SUBMITTED · REVIEW_RESUBMITTED
        REVIEW_DECIDED(签署) · REREVIEW_TRIGGERED
发行    MASTER_RELEASED(签署) · OVERSEAS_VERSION_CREATED
        RELEASE_DELIVERED · DISTRIBUTION_SUSPENDED
```

每个事件允许落到的聚合流与 payload 最低键集合见 `src/domain.js` 的 `eventCatalog`，
与 `contracts/domain.schema.json` 的枚举在测试中互相校验。

## 本地检查

```bash
npm test
```
