import { describe, expect, it } from "vitest";

import { diffAllocationBets } from "../../src/analysis/allocation-diff.js";

/** Issue #338(#335-A1): 配分(買い目の一覧)の差分。追加・削除・金額の変化。 */

const bet = (betType: string, comboKey: string, stake: number, odds: number | null = 5, ev: number | null = 1.2) => ({ betType, comboKey, stake, odds, ev });

describe("diffAllocationBets", () => {
  it.each([
    {
      name: "同一なら変化なし(オッズだけが動いても、賭け金が同じなら変化に数えない)",
      before: [bet("place", "03", 300, 2.5), bet("wide", "0305", 200)],
      after: [bet("place", "03", 300, 2.1), bet("wide", "0305", 200)],
      added: [],
      removed: [],
      changed: [],
      unchanged: 2,
      hasChange: false,
    },
    {
      name: "追加",
      before: [bet("place", "03", 300)],
      after: [bet("place", "03", 300), bet("wide", "0305", 200)],
      added: ["wide:0305"],
      removed: [],
      changed: [],
      unchanged: 1,
      hasChange: true,
    },
    {
      name: "削除",
      before: [bet("place", "03", 300), bet("wide", "0305", 200)],
      after: [bet("place", "03", 300)],
      added: [],
      removed: ["wide:0305"],
      changed: [],
      unchanged: 1,
      hasChange: true,
    },
    {
      name: "金額の変化(増・減)",
      before: [bet("place", "03", 300), bet("wide", "0305", 200)],
      after: [bet("place", "03", 400), bet("wide", "0305", 100)],
      added: [],
      removed: [],
      changed: ["place:03:300>400", "wide:0305:200>100"],
      unchanged: 0,
      hasChange: true,
    },
    {
      name: "両方空は変化なし",
      before: [],
      after: [],
      added: [],
      removed: [],
      changed: [],
      unchanged: 0,
      hasChange: false,
    },
    {
      name: "追加・削除・変化が混在(出力は券種・キーの昇順)",
      before: [bet("wide", "0305", 200), bet("place", "03", 300), bet("trio", "030507", 100)],
      after: [bet("place", "03", 500), bet("exacta", "0503", 100), bet("trio", "030507", 100)],
      added: ["exacta:0503"],
      removed: ["wide:0305"],
      changed: ["place:03:300>500"],
      unchanged: 1,
      hasChange: true,
    },
  ])("$name", ({ before, after, added, removed, changed, unchanged, hasChange }) => {
    const diff = diffAllocationBets(before, after);
    expect(diff.added.map((b) => `${b.betType}:${b.comboKey}`)).toEqual(added);
    expect(diff.removed.map((b) => `${b.betType}:${b.comboKey}`)).toEqual(removed);
    expect(diff.changed.map((c) => `${c.betType}:${c.comboKey}:${c.beforeStake}>${c.afterStake}`)).toEqual(changed);
    expect(diff.unchanged).toBe(unchanged);
    expect(diff.hasChange).toBe(hasChange);
    expect(diff.totalStakeBefore).toBe(before.reduce((s, b) => s + b.stake, 0));
    expect(diff.totalStakeAfter).toBe(after.reduce((s, b) => s + b.stake, 0));
  });

  it("変化した買い目は、前後のオッズ・期待値を持つ", () => {
    const diff = diffAllocationBets([bet("place", "03", 300, 2.5, 1.3)], [bet("place", "03", 200, 2.0, 1.05)]);
    expect(diff.changed).toEqual([
      { betType: "place", comboKey: "03", beforeStake: 300, afterStake: 200, beforeOdds: 2.5, afterOdds: 2.0, beforeEv: 1.3, afterEv: 1.05 },
    ]);
  });
});
