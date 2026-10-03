import { ProductionLedger } from "../../src/ledger.js";
import { EventStore } from "../../src/store.js";
import { sha256Hex } from "../../src/crypto.js";

/**
 * 构造一个可复用的端到端测试场景：
 * 制作单 P1 已冻结口径，权利/角色/场景/提示已登记，角色基线已锁定，
 * 另有一个角色 C2 已在基线锁定后被更新到 v2（用于连续性违规测试）。
 */
export function buildScenario() {
  let tick = 0;
  const now = () => `2026-10-01T0${Math.min(tick, 9)}:${String(10 + tick).padStart(2, "0")}:00+08:00`;
  const clock = { next: () => (tick += 1, now()) };

  const people = {
    li: { id: "u-li", roles: ["scriptwriter"], secret: "secret:li" },
    zhang: { id: "u-zhang", roles: ["director", "storyboard", "generator", "editor"], secret: "secret:zhang" },
    wang: { id: "u-wang", roles: ["voice"], secret: "secret:wang" },
    qian: { id: "u-qian", roles: ["producer"], secret: "secret:qian" },
    sun: { id: "u-sun", roles: ["finance"], secret: "secret:sun" },
    "rev-platform": { id: "u-revp", roles: ["platform_reviewer"], secret: "secret:revp" },
    "rev-provincial": { id: "u-revx", roles: ["provincial_reviewer"], secret: "secret:revx" },
    admin: { id: "u-admin", roles: ["compliance_admin"], secret: "secret:admin" },
  };
  const directory = (id) => Object.values(people).find((p) => p.id === id) ?? null;
  const store = new EventStore({ now: clock.next });
  const ledger = new ProductionLedger({ store, directory });

  const D = (s) => sha256Hex(s);
  const P1 = "P1";

  ledger.openProduction({
    productionId: P1,
    title: "夜色未央",
    genreScope: { code: "urban_romance", requiresProvincial: false },
    investmentBasis: { amount: 500_000, currency: "CNY", statement_id: "FIN-202609-01" },
    actorId: people.qian.id,
  });
  ledger.freezeScope({ productionId: P1, frozenAt: "2026-10-01T08:00:00+08:00", actorId: people.admin.id });

  ledger.registerScriptRight({
    rightId: "R1",
    productionId: P1,
    title: "夜色未央·剧本",
    rightsOwner: "本厂编剧组",
    licenseScope: "exclusive_audiovisual",
    evidenceRef: "contracts/R1.pdf",
    digest: D("R1-contract"),
    actorId: people.li.id,
  });

  ledger.registerCharacter({
    characterId: "C1",
    productionId: P1,
    characterCode: "CHAR_LIN",
    sourceAccountId: "tool-acct-a",
    digest: D("C1-v1"),
    actorId: people.zhang.id,
  });
  ledger.registerCharacter({
    characterId: "C2",
    productionId: P1,
    characterCode: "CHAR_YE",
    sourceAccountId: "tool-acct-b",
    digest: D("C2-v1"),
    actorId: people.zhang.id,
  });
  ledger.registerScene({
    sceneId: "S1",
    productionId: P1,
    sceneCode: "SCENE_ROOFTOP",
    sourceAccountId: "tool-acct-a",
    digest: D("S1"),
    actorId: people.zhang.id,
  });

  ledger.lockContinuityBaseline({
    baselineId: "B1",
    productionId: P1,
    characterId: "C1",
    lockedFromEpisode: 1,
    traitsSnapshot: { hairstyle: "short_black", costume: "navy_coat" },
    actorId: people.qian.id,
  });
  ledger.lockContinuityBaseline({
    baselineId: "B2",
    productionId: P1,
    characterId: "C2",
    lockedFromEpisode: 1,
    traitsSnapshot: { hairstyle: "long" },
    actorId: people.qian.id,
  });
  // 基线锁定后，C2 被更新到 v2
  ledger.registerCharacter({
    characterId: "C2",
    productionId: P1,
    characterCode: "CHAR_YE",
    sourceAccountId: "tool-acct-b",
    digest: D("C2-v2"),
    actorId: people.zhang.id,
  });

  // 一条被采用的提示、一条未采用的提示（发行包必须看不到二者）
  ledger.recordPromptDigest({ promptId: "PR1", productionId: P1, promptDigest: D("prompt-1"), createdBy: people.zhang.id, adoptedBy: "A1" });
  ledger.recordPromptDigest({ promptId: "PR2", productionId: P1, promptDigest: D("prompt-2-unused"), createdBy: people.zhang.id, adoptedBy: null });

  return { ledger, store, people, ids: { P1, R1: "R1", C1: "C1", C2: "C2", S1: "S1", PR1: "PR1", PR2: "PR2", B1: "B1", B2: "B2" }, D, clock };
}

export const lineageRefs = {
  C1v1: [{ aggregate_type: "character_asset", aggregate_id: "C1", version: 1 }],
  C1v1WithSceneAndPrompt: [
    { aggregate_type: "character_asset", aggregate_id: "C1", version: 1 },
    { aggregate_type: "scene_asset", aggregate_id: "S1", version: 1 },
    { aggregate_type: "prompt_input", aggregate_id: "PR1", version: 1 },
  ],
};
