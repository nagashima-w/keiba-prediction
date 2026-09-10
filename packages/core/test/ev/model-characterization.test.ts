import { describe, expect, it } from "vitest";

import { allocateBets, type AllocationHorse, DEFAULT_BET_ALLOCATION_CONFIG } from "../../src/ev/bet-allocation.js";
import { PLACKETT_LUCE_MODEL } from "../../src/ev/plackett-luce-model.js";
import { fitPlackettLuceStrengths } from "../../src/ev/plackett-luce-strength.js";
import type { JointModelHorse } from "../../src/ev/place-joint-model.js";

/**
 * model-characterization — Issue #80(#78-A)のAC-A7(本タスクの主目的)。
 *
 * `CONDITIONAL_BERNOULLI_MODEL`(既定)と`PLACKETT_LUCE_MODEL`が、**同一の入力(候補馬・オッズ・
 * 配分設定)**に対してどれだけ異なる配分結果を返すかを、テーブル駆動でリテラル固定する。
 * これは#81(既定モデルをPLへ切り替える)が実際に配分額を動かすことを検出するための土台であり、
 * 本タスク自体は既定モデル・数値を一切変更しない(#80着手前ゲート確定)。
 *
 * ## フィクスチャの出処(boss着手前ゲートで指定・本テストで独立に再実測)
 * 6フィクスチャ(F1〜F6)は境界条件を打ち抜くよう設計されている(bankroll=500000・
 * kellyFraction=0.5・betUnit=100・greedySteps=1000で固定):
 * - F1: Σp=k厳密(dyadic)。PLの反復フィッタはFIT_TOLERANCE(1e-6)未満で停止するため
 *   marginalDeviationMaxは理論上の0にはならない(`toBe(0)`は使わない。boss訂正3)。
 * - F2: k≥nの退化ケース(全馬が上位k枠に厳密固定)。CBとPLの結果が完全一致する対照。
 * - F3: Σp<k・capが実質無拘束。betCount(7 vs 8)を含め内訳が大きく割れる。
 * - F4: Σp>k。`isSkip`がCB=false/PL=trueと反転する最強の判別ケース。
 * - F5: p=1を含む(θ=Infinityで厳格固定される馬がいる)。PLのmdevがCBより**良い**少数派の例
 *   (F3・F6が示す「PLの方が悪い」が多数派であることの対照)。
 * - F6: Σp<k・cap拘束。totalStakeはほぼ一致するが内訳(各馬のstake)は割れる
 *   (「totalStakeは判別指標にならない」ことを積極的に示す証跡。boss訂正2)。
 *
 * `totalStake`はここでは補助情報として残すが、**判別に使うのはallocations[].stake配列・
 * betCount・isSkip・marginalDeviationMaxである**(F3・F6のtotalStakeが近接しているにも
 * かかわらずstake配列は別物であることをテストで直接示す)。
 *
 * *殺す変異*: 既定モデルをPLに差し替える(#81の先取り)→ F2(CB=PLが元々同一)を除く
 * 全フィクスチャのCB行の期待値が崩れ、必ず赤くなる(下記「変異の実行結果」参照)。
 */

interface Fixture {
  readonly name: string;
  readonly p: readonly number[];
  readonly odds: readonly number[];
  readonly k: number;
  readonly cap: number;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: "F1: Σp=k厳密(dyadic)",
    p: [0.75, 0.625, 0.5, 0.5, 0.375, 0.25],
    odds: [1.7, 2.0, 2.5, 2.5, 3.4, 5.0],
    k: 3,
    cap: 20000,
  },
  {
    name: "F2: 退化k≥n(CB=PL対照)",
    p: [0.7, 0.5, 0.4],
    odds: [1.9, 2.6, 3.4],
    k: 3,
    cap: 20000,
  },
  {
    name: "F3: Σp<k・cap非拘束(内訳が最も割れる)",
    p: [0.55, 0.35, 0.3, 0.25, 0.2, 0.15, 0.12, 0.08],
    odds: [2.0, 3.2, 3.8, 4.6, 6.0, 8.0, 10.0, 15.0],
    k: 3,
    cap: 1000000,
  },
  {
    name: "F4: Σp>k・isSkipが反転",
    p: [0.75, 0.65, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3],
    odds: [1.5, 1.7, 2.0, 2.3, 2.6, 3.0, 3.5, 4.2],
    k: 3,
    cap: 20000,
  },
  {
    name: "F5: p=1を含む(PLの方が良い少数派の対照)",
    p: [1.0, 0.45, 0.35, 0.28, 0.22, 0.18, 0.14, 0.1],
    odds: [1.1, 2.6, 3.4, 4.4, 5.6, 7.0, 9.0, 13.0],
    k: 3,
    cap: 20000,
  },
  {
    name: "F6: Σp<k・cap拘束(総額は近接するが内訳が割れる)",
    p: [0.62, 0.3, 0.22, 0.18, 0.15, 0.1, 0.08, 0.05],
    odds: [1.8, 3.9, 5.2, 6.4, 7.8, 12.0, 16.0, 25.0],
    k: 3,
    cap: 20000,
  },
];

const CONFIG_BASE = {
  ...DEFAULT_BET_ALLOCATION_CONFIG,
  bankroll: 500000,
  kellyFraction: 0.5,
  betUnit: 100,
  greedySteps: 1000,
};

function horsesOf(f: Fixture): AllocationHorse[] {
  return f.p.map((placeProb, i) => ({
    umaban: i + 1,
    placeProb,
    placeOddsMin: f.odds[i]!,
    ev: placeProb * f.odds[i]!,
    isPositive: true,
  }));
}

function stakesByUmaban(result: { allocations: readonly { umaban: number; stake: number }[] }, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  for (const a of result.allocations) {
    out[a.umaban - 1] = a.stake;
  }
  return out;
}

describe("AC-A7: CONDITIONAL_BERNOULLI_MODELとPLACKETT_LUCE_MODELの配分結果の特性化(#81検出力の土台)", () => {
  describe.each(FIXTURES)("$name", (f) => {
    const horses = horsesOf(f);

    it("CB(既定モデル。#81検出のためmodel引数を渡さず既定値に依存する)の配分結果がリテラルと一致すること", () => {
      // #81(既定モデルをPLへ切り替える)がここを壊すことを意図してmodel引数を省略する
      // (production呼び出し元もmodel引数を渡さない設計であり、ここも同じ形にすることで
      // 「既定を差し替えると本テストが赤くなる」というAC-A7の殺す変異が成立する。
      // 明示的にCONDITIONAL_BERNOULLI_MODELを渡すと、#81の既定切替と無関係に常に緑のまま
      // になってしまい検出力が無い)。
      const result = allocateBets(horses, f.k, { ...CONFIG_BASE, perRaceCap: f.cap });
      expect(result.modelId).toBe("conditional-bernoulli");
      expect(result.isSkip).toBe(EXPECTED_CB[f.name]!.isSkip);
      expect(result.betCount).toBe(EXPECTED_CB[f.name]!.betCount);
      expect(result.totalStake).toBe(EXPECTED_CB[f.name]!.totalStake);
      expect(stakesByUmaban(result, f.p.length)).toEqual(EXPECTED_CB[f.name]!.stakes);
      expect(result.diagnostics.marginalDeviationMax).toBe(EXPECTED_CB[f.name]!.marginalDeviationMax);
    });

    it("PL(PLACKETT_LUCE_MODEL)の配分結果がリテラルと一致すること", () => {
      const result = allocateBets(horses, f.k, { ...CONFIG_BASE, perRaceCap: f.cap }, PLACKETT_LUCE_MODEL);
      expect(result.modelId).toBe("plackett-luce");
      expect(result.isSkip).toBe(EXPECTED_PL[f.name]!.isSkip);
      expect(result.betCount).toBe(EXPECTED_PL[f.name]!.betCount);
      expect(result.totalStake).toBe(EXPECTED_PL[f.name]!.totalStake);
      expect(stakesByUmaban(result, f.p.length)).toEqual(EXPECTED_PL[f.name]!.stakes);
      expect(result.diagnostics.marginalDeviationMax).toBe(EXPECTED_PL[f.name]!.marginalDeviationMax);
    });
  });

  it("前提固定(空振り防止): F2以外はCBとPLのstakes配列が互いに異なること(#55: 単なる恒等式でないこと)", () => {
    for (const f of FIXTURES) {
      if (f.name.startsWith("F2")) continue;
      expect(EXPECTED_CB[f.name]!.stakes).not.toEqual(EXPECTED_PL[f.name]!.stakes);
    }
  });

  it("F2(退化k≥n)はCBとPLのstakes・totalStakeが完全一致すること(対照)", () => {
    expect(EXPECTED_CB["F2: 退化k≥n(CB=PL対照)"]).toEqual({
      isSkip: false,
      betCount: 1,
      totalStake: 20000,
      stakes: [0, 0, 20000],
      marginalDeviationMax: 0.6,
    });
    expect(EXPECTED_PL["F2: 退化k≥n(CB=PL対照)"]).toEqual({
      isSkip: false,
      betCount: 1,
      totalStake: 20000,
      stakes: [0, 0, 20000],
      marginalDeviationMax: 0.6,
    });
  });

  it("F1(Σp=k厳密): PLのmarginalDeviationMaxはFIT_TOLERANCE未満だが厳密な0ではないこと(boss訂正3)", () => {
    const mdev = EXPECTED_PL["F1: Σp=k厳密(dyadic)"]!.marginalDeviationMax;
    // 述語検査(toBeLessThan単独)は使わず、実測リテラル自体を上のdescribe.eachで既に固定している。
    // ここでは「0ではない」ことと「FIT_TOLERANCE(1e-6)未満」であることの両方を、
    // 実測リテラルに対する散文的な確認として付け加える(toBe(0)・toBeCloseTo(0)は使わない)。
    expect(mdev).toBe(9.963638852861223e-7);
    expect(mdev).not.toBe(0);
    expect(mdev < 1e-6).toBe(true);
  });

  it("F3・F6: totalStakeが近接していても内訳(betCount・stakes配列)は別物であること(訂正2の直接証拠)", () => {
    const f3cb = EXPECTED_CB["F3: Σp<k・cap非拘束(内訳が最も割れる)"]!;
    const f3pl = EXPECTED_PL["F3: Σp<k・cap非拘束(内訳が最も割れる)"]!;
    expect(f3cb.totalStake).toBe(249800);
    expect(f3pl.totalStake).toBe(249800); // 総額は完全一致
    expect(f3cb.betCount).not.toBe(f3pl.betCount); // だが点数は割れる(7 vs 8)
    expect(f3cb.stakes).not.toEqual(f3pl.stakes);

    const f6cb = EXPECTED_CB["F6: Σp<k・cap拘束(総額は近接するが内訳が割れる)"]!;
    const f6pl = EXPECTED_PL["F6: Σp<k・cap拘束(総額は近接するが内訳が割れる)"]!;
    expect(Math.abs(f6cb.totalStake - f6pl.totalStake)).toBeLessThan(f6cb.totalStake * 0.1); // 総額は近接
    expect(f6cb.stakes).not.toEqual(f6pl.stakes); // だが内訳は別物
  });

  it("F4: isSkipがCB=false/PL=trueと反転すること(最強の判別指標)", () => {
    expect(EXPECTED_CB["F4: Σp>k・isSkipが反転"]!.isSkip).toBe(false);
    expect(EXPECTED_PL["F4: Σp>k・isSkipが反転"]!.isSkip).toBe(true);
  });

  it("F3・F6: PLのmarginalDeviationMaxがCBより悪い(多数派)ことのリテラル固定", () => {
    const f3cb = EXPECTED_CB["F3: Σp<k・cap非拘束(内訳が最も割れる)"]!.marginalDeviationMax;
    const f3pl = EXPECTED_PL["F3: Σp<k・cap非拘束(内訳が最も割れる)"]!.marginalDeviationMax;
    expect(f3cb).toBe(0.19507729125133355);
    expect(f3pl).toBe(0.27500069958051765);
    expect(f3pl).toBeGreaterThan(f3cb);
  });

  it("F5: PLのmarginalDeviationMaxがCBより良い(少数派の対照)ことのリテラル固定", () => {
    const f5cb = EXPECTED_CB["F5: p=1を含む(PLの方が良い少数派の対照)"]!.marginalDeviationMax;
    const f5pl = EXPECTED_PL["F5: p=1を含む(PLの方が良い少数派の対照)"]!.marginalDeviationMax;
    expect(f5cb).toBe(0.09869838058191277);
    expect(f5pl).toBe(0.07325680868077372);
    expect(f5pl).toBeLessThan(f5cb);
  });

  describe("フィクスチャが対称・退化して分岐を無効化していないことの証跡(PLフィット診断値をリテラルで併記)", () => {
    const table: Array<{
      name: string;
      expected: {
        degenerateZeroCount: number;
        degenerateFixedCount: number;
        rescaleInducedFixedCount: number;
        rescaleApplied: boolean;
        reducedHorseCount: number;
      };
    }> = [
      {
        name: "F1: Σp=k厳密(dyadic)",
        expected: {
          degenerateZeroCount: 0,
          degenerateFixedCount: 0,
          rescaleInducedFixedCount: 0,
          rescaleApplied: false,
          reducedHorseCount: 6,
        },
      },
      {
        name: "F2: 退化k≥n(CB=PL対照)",
        expected: {
          degenerateZeroCount: 0,
          degenerateFixedCount: 3,
          rescaleInducedFixedCount: 0,
          rescaleApplied: false,
          reducedHorseCount: 0,
        },
      },
      {
        name: "F3: Σp<k・cap非拘束(内訳が最も割れる)",
        expected: {
          degenerateZeroCount: 0,
          degenerateFixedCount: 0,
          rescaleInducedFixedCount: 0,
          rescaleApplied: true,
          reducedHorseCount: 8,
        },
      },
      {
        name: "F4: Σp>k・isSkipが反転",
        expected: {
          degenerateZeroCount: 0,
          degenerateFixedCount: 0,
          rescaleInducedFixedCount: 0,
          rescaleApplied: true,
          reducedHorseCount: 8,
        },
      },
      {
        name: "F5: p=1を含む(PLの方が良い少数派の対照)",
        expected: {
          degenerateZeroCount: 0,
          degenerateFixedCount: 1,
          rescaleInducedFixedCount: 0,
          rescaleApplied: true,
          reducedHorseCount: 7,
        },
      },
      {
        name: "F6: Σp<k・cap拘束(総額は近接するが内訳が割れる)",
        expected: {
          degenerateZeroCount: 0,
          degenerateFixedCount: 1,
          rescaleInducedFixedCount: 1,
          rescaleApplied: true,
          reducedHorseCount: 7,
        },
      },
    ];

    it.each(table)("$name", ({ name, expected }) => {
      const f = FIXTURES.find((x) => x.name === name)!;
      const jointHorses: JointModelHorse[] = f.p.map((placeProb, i) => ({ umaban: i + 1, placeProb }));
      const fit = fitPlackettLuceStrengths(jointHorses, f.k);
      expect(fit.ok).toBe(true);
      if (!fit.ok) return;
      expect(fit.degenerateZeroCount).toBe(expected.degenerateZeroCount);
      expect(fit.degenerateFixedCount).toBe(expected.degenerateFixedCount);
      expect(fit.rescaleInducedFixedCount).toBe(expected.rescaleInducedFixedCount);
      expect(fit.rescaleApplied).toBe(expected.rescaleApplied);
      expect(fit.reducedHorseCount).toBe(expected.reducedHorseCount);
    });

    it("F5・F6がdegenerateFixedCount>0(p=1相当の縮約経路)を実際に通っていること(対称・退化していないことの直接証拠)", () => {
      expect(table.find((t) => t.name.startsWith("F5"))!.expected.degenerateFixedCount).toBeGreaterThan(0);
      expect(table.find((t) => t.name.startsWith("F6"))!.expected.degenerateFixedCount).toBeGreaterThan(0);
    });

    it("F6がrescaleInducedFixedCount>0(再スケール由来の固定。入力に境界値が無くても発生する経路)を通っていること", () => {
      expect(table.find((t) => t.name.startsWith("F6"))!.expected.rescaleInducedFixedCount).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// 期待値リテラル(自分の手元での実測。scratchpad/compute-fixtures.tsで独立に算出し、
// bossの報告値とは突き合わせのみ行った。転記ではない)
// ============================================================================

interface ExpectedRow {
  readonly isSkip: boolean;
  readonly betCount: number;
  readonly totalStake: number;
  readonly stakes: readonly number[];
  readonly marginalDeviationMax: number;
}

const EXPECTED_CB: Record<string, ExpectedRow> = {
  "F1: Σp=k厳密(dyadic)": {
    isSkip: false,
    betCount: 6,
    totalStake: 19700,
    stakes: [7300, 4600, 2800, 2800, 1600, 600],
    marginalDeviationMax: 0.03739002932551322,
  },
  "F2: 退化k≥n(CB=PL対照)": {
    isSkip: false,
    betCount: 1,
    totalStake: 20000,
    stakes: [0, 0, 20000],
    marginalDeviationMax: 0.6,
  },
  "F3: Σp<k・cap非拘束(内訳が最も割れる)": {
    isSkip: false,
    betCount: 7,
    totalStake: 249800,
    stakes: [0, 53000, 51000, 44200, 37700, 27700, 22000, 14200],
    marginalDeviationMax: 0.19507729125133355,
  },
  "F4: Σp>k・isSkipが反転": {
    isSkip: false,
    betCount: 1,
    totalStake: 6700,
    stakes: [6700, 0, 0, 0, 0, 0, 0, 0],
    marginalDeviationMax: 0.1348964037371408,
  },
  "F5: p=1を含む(PLの方が良い少数派の対照)": {
    isSkip: false,
    betCount: 7,
    totalStake: 19700,
    stakes: [0, 5500, 4200, 3300, 2400, 1900, 1400, 1000],
    marginalDeviationMax: 0.09869838058191277,
  },
  "F6: Σp<k・cap拘束(総額は近接するが内訳が割れる)": {
    isSkip: false,
    betCount: 7,
    totalStake: 19600,
    stakes: [0, 4500, 4000, 3400, 3000, 2000, 1700, 1000],
    marginalDeviationMax: 0.26261563619051426,
  },
};

const EXPECTED_PL: Record<string, ExpectedRow> = {
  "F1: Σp=k厳密(dyadic)": {
    isSkip: false,
    betCount: 6,
    totalStake: 19900,
    stakes: [5500, 3900, 3200, 3200, 2500, 1600],
    marginalDeviationMax: 9.963638852861223e-7,
  },
  "F2: 退化k≥n(CB=PL対照)": {
    isSkip: false,
    betCount: 1,
    totalStake: 20000,
    stakes: [0, 0, 20000],
    marginalDeviationMax: 0.6,
  },
  "F3: Σp<k・cap非拘束(内訳が最も割れる)": {
    isSkip: false,
    betCount: 8,
    totalStake: 249800,
    stakes: [34000, 48000, 43700, 37200, 32000, 23700, 18700, 12500],
    marginalDeviationMax: 0.27500069958051765,
  },
  "F4: Σp>k・isSkipが反転": {
    isSkip: true,
    betCount: 0,
    totalStake: 0,
    stakes: [0, 0, 0, 0, 0, 0, 0, 0],
    marginalDeviationMax: 0.1803789349767816,
  },
  "F5: p=1を含む(PLの方が良い少数派の対照)": {
    isSkip: false,
    betCount: 7,
    totalStake: 19800,
    stakes: [0, 4800, 4000, 3300, 2600, 2200, 1700, 1200],
    marginalDeviationMax: 0.07325680868077372,
  },
  "F6: Σp<k・cap拘束(総額は近接するが内訳が割れる)": {
    isSkip: false,
    betCount: 7,
    totalStake: 19700,
    stakes: [0, 5500, 3900, 3200, 2700, 1900, 1600, 900],
    marginalDeviationMax: 0.37999999999999967,
  },
};
