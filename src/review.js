import { REVIEW_PATHS, REASSESSMENT_TRIGGERS } from "./domain.js";
import { ErrorCodes, LedgerError } from "./errors.js";

/**
 * 审核路径规则。
 *
 * 系统职责边界：依据【已冻结】的题材与投资口径给出 advisory（建议路径），
 * 但最终分类与内容决定只能由有权人员签署（REVIEW_CLASSIFICATION_SIGNED）。
 *
 * 阈值为可注入规则表；DEFAULT_RULES 中的数值仅为联调示例，
 * 实际数值以平台规则与属地主管部门口径为准。
 */
export const DEFAULT_RULES = Object.freeze({
  currency: "CNY",
  platformToProvincialAt: 3_000_000,
  provincialToNationalAt: 30_000_000,
  nationalGenres: new Set([
    "major_revolution",
    "foreign_affairs",
    "minority_religion",
    "diplomacy",
  ]),
  provincialGenres: new Set(["historical", "judicial_public_security"]),
});

/** 仅按投资额判定档位带：0=平台，1=省级，2=国家级。 */
export function investmentBand(amount, rules = DEFAULT_RULES) {
  if (amount >= rules.provincialToNationalAt) return 2;
  if (amount >= rules.platformToProvincialAt) return 1;
  return 0;
}

const BAND_PATH = [REVIEW_PATHS.PLATFORM, REVIEW_PATHS.PROVINCIAL, REVIEW_PATHS.NATIONAL];

/**
 * 依据冻结口径计算建议路径与理由。纯建议，不做任何分类决定。
 * @param {{genre:string, investment_amount:number}} frozenScope
 */
export function suggestPath(frozenScope, rules = DEFAULT_RULES) {
  const reasons = [];
  let band = investmentBand(frozenScope.investment_amount, rules);

  if (rules.nationalGenres.has(frozenScope.genre)) {
    band = Math.max(band, 2);
    reasons.push({ code: "genre_major", genre: frozenScope.genre, detail: "重大题材进入国家级送审建议" });
  } else if (rules.provincialGenres.has(frozenScope.genre)) {
    band = Math.max(band, 1);
    reasons.push({ code: "genre_sensitive", genre: frozenScope.genre, detail: "题材进入省级送审建议" });
  }

  if (frozenScope.investment_amount >= rules.provincialToNationalAt) {
    reasons.push({ code: "investment_band", band: 2, amount: frozenScope.investment_amount });
  } else if (frozenScope.investment_amount >= rules.platformToProvincialAt) {
    reasons.push({ code: "investment_band", band: 1, amount: frozenScope.investment_amount });
  }

  return {
    suggested_path: BAND_PATH[band],
    band,
    reasons,
    based_on: {
      genre: frozenScope.genre,
      investment_amount: frozenScope.investment_amount,
      currency: frozenScope.currency ?? rules.currency,
      frozen_at: frozenScope.frozen_at ?? null,
    },
  };
}

/**
 * 口径修订检测：只有当修订真正改变题材或跨越投资档位时才构成重审触发，
 * 普通的小额追加以成本触发另行判断——做到“精确触发”。
 * @returns {{trigger?:string, beforeBand:number, afterBand:number, changed:boolean}}
 */
export function detectScopeAmendment(beforeScope, afterScope, rules = DEFAULT_RULES) {
  const beforeBand = investmentBand(beforeScope.investment_amount, rules);
  const afterBand = investmentBand(afterScope.investment_amount, rules);
  const genreChanged = beforeScope.genre !== afterScope.genre;
  const crossed = afterBand > beforeBand;
  return {
    changed: genreChanged || crossed,
    trigger: genreChanged || crossed ? "scope_amended" : null,
    genreChanged,
    beforeBand,
    afterBand,
  };
}

/**
 * 追加成本检测：累计实际成本跨入更高档位才触发；档位内波动不触发。
 * @param {object} scope 冻结口径
 * @param {number} previousTotal 追加前累计实际成本
 * @param {number} nextTotal 追加后累计实际成本
 */
export function detectCostCrossing(scope, previousTotal, nextTotal, rules = DEFAULT_RULES) {
  const frozenBand = investmentBand(scope.investment_amount, rules);
  const beforeBand = investmentBand(previousTotal, rules);
  const afterBand = investmentBand(nextTotal, rules);
  if (afterBand > Math.max(beforeBand, frozenBand)) {
    return {
      trigger: "investment_threshold_crossed",
      from_band: Math.max(beforeBand, frozenBand),
      to_band: afterBand,
      actual_total: nextTotal,
    };
  }
  return null;
}

/** 重剪/海外/权利变更属于精确触发：由命令显式声明，引擎只校验枚举。 */
export function assertKnownTrigger(trigger) {
  if (!REASSESSMENT_TRIGGERS.includes(trigger)) {
    throw new LedgerError(
      ErrorCodes.REASSESSMENT_NOT_TRIGGERED,
      `未知重审触发类型：${trigger}`,
    );
  }
}

export function pathLabel(path) {
  return {
    [REVIEW_PATHS.PLATFORM]: "平台自审档",
    [REVIEW_PATHS.PROVINCIAL]: "省级送审档",
    [REVIEW_PATHS.NATIONAL]: "国家级送审档",
  }[path] ?? path;
}
