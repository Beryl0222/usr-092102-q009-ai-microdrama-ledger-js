import { rereviewTriggers, reviewPaths } from "./domain.js";

/**
 * 审核路径策略（纯函数，无副作用）。
 *
 * 边界（来自业务要求）：
 * - 系统只依据【已冻结】的题材与投资口径“提示”适用路径；口径未冻结时不给建议。
 * - 财务统计的投资额变化导致作品跨档时，以最新冻结口径重算并生成重审触发；
 * - 系统永远不做最终分类与内容决定——那是 REVIEW_DECIDED 上人工签署的效力。
 */

/**
 * 路径规则表。阈值单位与口径快照一致（人民币元，含税总投资）。
 * 题材敏感标记在冻结口径中以布尔字段给出，由合规管理员维护，不由系统猜判。
 */
export const PATH_RULES = Object.freeze({
  currency: "CNY",
  // 达到或超过省级送审投资阈值，或题材被标记为需省级送审
  provincialInvestmentThreshold: 1_000_000,
});

/**
 * @param {object} scope 冻结口径 {genre_scope:{code,requiresProvincial:boolean}, investment_basis:{amount,currency,frozen_at,statement_id}}
 * @returns {{path: string, reasons: string[]}}
 */
export function suggestReviewPath(scope) {
  if (!scope || scope.frozen !== true) {
    return { path: null, reasons: ["题材与投资口径尚未冻结，系统不提示审核路径"] };
  }

  const reasons = [];
  const basis = scope.investment_basis ?? {};
  const genre = scope.genre_scope ?? {};

  if (basis.currency && basis.currency !== PATH_RULES.currency) {
    reasons.push(`投资口径币种 ${basis.currency} 与规则币种 ${PATH_RULES.currency} 不一致，需人工核对`);
  }

  const amount = Number(basis.amount) || 0;
  const crossesByInvestment = amount >= PATH_RULES.provincialInvestmentThreshold;
  const crossesByGenre = genre.requiresProvincial === true;

  if (crossesByGenre) reasons.push(`题材 ${genre.code ?? "?"} 属省级送审范围（冻结口径标记）`);
  if (crossesByInvestment)
    reasons.push(`冻结投资额 ${amount} 已达省级送审阈值 ${PATH_RULES.provincialInvestmentThreshold}`);

  if (crossesByInvestment || crossesByGenre) return { path: reviewPaths.PROVINCIAL, reasons };

  reasons.push(`冻结投资额 ${amount} 未达省级阈值，且题材不要求省级送审`);
  return { path: reviewPaths.PLATFORM, reasons };
}

/**
 * 口径修订后判断是否跨档（旧建议 -> 新建议）。
 * @returns {{crossed: boolean, from: string|null, to: string|null, trigger: string|null}}
 */
export function detectTierCrossing(previousScope, nextScope) {
  const before = suggestReviewPath(previousScope).path;
  const after = suggestReviewPath(nextScope).path;
  const crossed = before !== null && after !== null && before !== after;
  return {
    crossed,
    from: before,
    to: after,
    trigger: crossed ? rereviewTriggers.COST_THRESHOLD_CROSSED : null,
  };
}

/**
 * 计算“精确重审”要求。每个触发源独立判定，调用方按实际发生的事件登记，
 * 不允许“重剪顺手重审成本档”之外的泛化——一个变化只产生它对应的触发。
 *
 * @param {object} input
 * @param {boolean} input.scopeRevised      冻结口径发生 SCOPE_REVISED
 * @param {boolean} input.additionalCosts   封版后又有 COST_POSTED（追加成本）
 * @param {boolean} input.overThreshold     累计实际成本是否越过省级阈值
 * @param {boolean} input.cutRevised        发生 CUT_REVISED
 * @param {boolean} input.overseasVersion   生成 OVERSEAS_VERSION_CREATED
 * @param {string}  input.currentPath       现行已签署路径
 */
export function evaluateRereviewTriggers(input) {
  const triggers = [];

  if (input.scopeRevised) {
    triggers.push({
      trigger: rereviewTriggers.SCOPE_REVISED,
      requiredPath: null, // 交由 TIER_ASSESSED 按新口径重新建议
    });
  }
  if (input.additionalCosts && input.overThreshold) {
    triggers.push({
      trigger: rereviewTriggers.COST_THRESHOLD_CROSSED,
      requiredPath: reviewPaths.PROVINCIAL,
    });
  }
  if (input.cutRevised) {
    triggers.push({
      trigger: rereviewTriggers.CUT_REVISED,
      requiredPath: input.currentPath ?? null,
    });
  }
  if (input.overseasVersion) {
    triggers.push({
      trigger: rereviewTriggers.OVERSEAS_VERSION,
      requiredPath: reviewPaths.OVERSEAS,
    });
  }
  return triggers;
}

/** 只有这四类事件/变化允许创建重审单，白名单外的事件一律不触发。 */
export const KNOWN_TRIGGERS = new Set(Object.values(rereviewTriggers));
