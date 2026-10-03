/**
 * mixed-race-allocation-wakuban.test.ts — 配分計算に渡す馬へ枠番(wakuban)を載せる配線のテスト
 * (Issue #148・#26-E2)。
 *
 * 枠連(bracketQuinella)の候補が1件でもあると、core `allocateGeneralBets` は全馬の`wakuban`を
 * 検査して的中判定に使う(`combo-bet-allocation.ts`の`resolveWakubanByUmaban`)。ところが#148の
 * 時点では`resolveMixedBetTypes`が枠連を返さなかった(配分接続は#150のスコープだった。設定の配管は#149で完了)ため、
 * production で枠連候補が`allocateGeneralBets`に届く経路が無く、「wakuban が渡っている」ことを
 * 実挙動(枠連の買い目が配分に出る)で確認できなかった(#150で接続した現在は、
 * `bracket-quinella-allocation-setting-wiring.test.ts`が実挙動で確認する)。そこで`allocateGeneralBets`を素通しの
 * スパイに差し替え、`mixed-race-allocation.ts`が組み立てる`horses`に、行(`AnalysisRow`)の
 * 枠番が載っていることを直接確認する(殺す変異: `horses`の組み立てから`wakuban`を落とす)。
 * #150で枠連が配分に入れば、実挙動のテストが同じ配線を覆う(本ファイルは#148の間の固定)。
 *
 * ## Web Worker経路について
 * Workerへ渡すのは`race: AnalysisResult`全体(`mixed-allocation-worker-handler.ts`の
 * `AllocationWorkerRequest`)であり、馬の配列(`JointModelHorse`)はWorker内で`race.rows`から
 * 組み立てる。`AnalysisRow.wakuban`は必須フィールドなので直列化(structured clone)では落ちない
 * (`mixed-candidates.test.ts`の枠連describeが`structuredClone`した入力で同じ候補が作られることを固定)。
 */

import { describe, expect, it, vi } from "vitest";

const allocateGeneralBetsCalls: unknown[][] = [];

vi.mock("@keiba/core/ev/combo-bet-allocation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keiba/core/ev/combo-bet-allocation")>();
  return {
    ...actual,
    allocateGeneralBets: (
      ...args: Parameters<typeof actual.allocateGeneralBets>
    ): ReturnType<typeof actual.allocateGeneralBets> => {
      allocateGeneralBetsCalls.push(args);
      return actual.allocateGeneralBets(...args);
    },
  };
});

const { buildMixedRaceAllocationWithOutcome } = await import("../src/shared/mixed-race-allocation.js");
import type { AnalysisRow } from "../src/shared/analysis-types.js";
import type { MixedAllocationSettings } from "../src/shared/mixed-race-allocation.js";

function row(umaban: number, wakuban: number): AnalysisRow {
  return {
    umaban,
    wakuban,
    horseName: `${umaban}番`,
    prior: 0.3,
    adjustedProb: 0.5,
    placeOddsMin: 3,
    winOdds: 1000,
    ev: 1.5,
    isPositive: true,
    reason: null,
    careerRunCount: 999,
    mark: null,
    evEstimated: false,
    conditionChangeTags: [],
  };
}

const settings: MixedAllocationSettings = {
  bankroll: 300000,
  perRaceCap: 20000,
  kellyFraction: 0.5,
  evThreshold: 1.0,
  includeComboOdds: true,
  includeWideInAllocation: true,
  includeTrioInAllocation: false,
  includeQuinellaInAllocation: false,
  includeExactaInAllocation: false,
  includeTrifectaInAllocation: false,
  includeBracketQuinellaInAllocation: false,
};

describe("配分計算に渡す馬へ枠番を載せる(Issue #148・#26-E2)", () => {
  it("allocateGeneralBetsに渡るhorsesが、行の枠番(馬番とは異なる値)を馬ごとに持っていること", () => {
    allocateGeneralBetsCalls.length = 0;
    // 馬番1..4 → 枠[1,2,2,3](馬番≠枠番。枠番を馬番で代用する実装は検知できる)。
    const wakubans = [1, 2, 2, 3];
    const rows = [1, 2, 3, 4].map((umaban, i) => row(umaban, wakubans[i]!));
    const wideCombo: Record<string, number> = {};
    for (let a = 1; a <= 4; a++) {
      for (let b = a + 1; b <= 4; b++) {
        wideCombo[`${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`] = 999;
      }
    }

    const result = buildMixedRaceAllocationWithOutcome(
      { oddsStatus: "result", rows, wideCombo },
      settings,
    );

    // 前提固定(空振り防止): 混在配分が実際に計算され、allocateGeneralBetsが1回呼ばれたこと。
    expect(result.outcome.route).toBe("mixed");
    expect(allocateGeneralBetsCalls).toHaveLength(1);
    const horses = allocateGeneralBetsCalls[0]![0] as ReadonlyArray<{
      umaban: number;
      wakuban?: number;
    }>;
    expect(horses.map((h) => [h.umaban, h.wakuban])).toEqual([
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 3],
    ]);
  });
});
