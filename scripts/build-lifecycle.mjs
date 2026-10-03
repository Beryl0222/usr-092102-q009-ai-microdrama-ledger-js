#!/usr/bin/env node
/**
 * 生成端到端联调样例 data/lifecycle.json：
 * 完整两集制作生命周期事件流 + 被不变量拦截的违规尝试记录。
 * 运行：node scripts/build-lifecycle.mjs
 */
import { writeFile } from "node:fs/promises";
import { buildScenario } from "./scenario.js";

const scenario = buildScenario();
const out = {
  description: "AI短剧制片总账端到端联调样例：剧本权利→口径/建议→基线锁定→生成/否决/修订→配音音乐→贡献成本→签署送审→精确重审→放行最小披露",
  generated_at: "2026-09-21T18:00:00+08:00",
  event_count: scenario.events.length,
  invariants_blocked: scenario.blocked,
  callback_retry: { duplicate: scenario.retries.callbackRetry.duplicate },
  events: scenario.events,
};

await writeFile(new URL("../data/lifecycle.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`, "utf8");
console.log(`已写出 ${scenario.events.length} 个事件到 data/lifecycle.json；拦截违规 ${scenario.blocked.length} 起。`);
