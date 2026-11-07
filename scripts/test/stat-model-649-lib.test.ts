/**
 * #649 段階 1(統計モデルで勝率・2着内率を直接見積もる)の測る道具の、純粋な部分のテスト。
 * 対象は `scripts/stat-model-649/lib.ts`(特徴量の組み立て・正規化・評価の指標)。
 * データの読み書きと Python の学習はここでは試さない(データはリポジトリに入れない)。
 */

import { describe, expect, it } from "vitest";
import {
  RideIndex,
  brier,
  fitLogistic,
  logLoss,
  logit,
  marketShares,
  monthOf,
  normalizeLogitShift,
  pairedRaceBootstrap,
  sigmoid,
  singleWinRoi,
} from "../stat-model-649/lib.js";

const sum = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0);

describe("marketShares: 単勝オッズから市場の確率", () => {
  it("1/オッズをレース内で合計 1 に割り戻す(2 倍と 4 倍と 4 倍 → 0.5・0.25・0.25)", () => {
    const q = marketShares([2, 4, 4])!;
    expect(q[0]).toBeCloseTo(0.5, 12);
    expect(q[1]).toBeCloseTo(0.25, 12);
    expect(sum(q)).toBeCloseTo(1, 12);
  });
  it("オッズが 1 頭でも欠けている(null・0 以下)レースは null(黙って埋めない)", () => {
    expect(marketShares([2, null, 4])).toBeNull();
    expect(marketShares([2, 0, 4])).toBeNull();
  });
});

describe("normalizeLogitShift: 全馬に共通のロジットを足して合計を目標に合わせる", () => {
  const cases: Array<[string, number[], number]> = [
    ["勝率(目標 1)", [-2, -1, 0, 1, 2, -3], 1],
    ["2着内率(目標 2)", [-2, -1, 0, 1, 2, -3, 0.5, 0.2], 2],
    ["3着内率(目標 3)", [-2, -1, 0, 1, 2, -3, 0.5, 0.2, -1], 3],
  ];
  for (const [name, logits, target] of cases) {
    it(`${name}: 合計が目標に一致し、順序が保たれ、ロジット差が保たれる`, () => {
      const p = normalizeLogitShift(logits, target);
      expect(sum(p)).toBeCloseTo(target, 6);
      // 入力は互いに異なるので、順序の保存は自明ではない(差が 0 でないことを先に固定する)。
      expect(logits[4]! - logits[3]!).not.toBe(0);
      expect(p[4]!).toBeGreaterThan(p[3]!);
      // 共通のシフト: logit(p_i) − logit(p_j) = l_i − l_j。
      expect(logit(p[4]!) - logit(p[0]!)).toBeCloseTo(logits[4]! - logits[0]!, 6);
    });
  }
  it("目標が頭数以上なら全頭 1(実現不能を throw しない)", () => {
    expect(normalizeLogitShift([0, 1, 2], 3)).toEqual([1, 1, 1]);
  });
});

describe("logLoss・brier", () => {
  it("手計算: p=[0.8,0.3], y=[1,0] の対数損失は −(ln0.8 + ln0.7)/2", () => {
    expect(logLoss([0.8, 0.3], [1, 0])).toBeCloseTo(-(Math.log(0.8) + Math.log(0.7)) / 2, 12);
  });
  it("0 と 1 の確率でも有限(下限・上限で切る)", () => {
    expect(Number.isFinite(logLoss([0, 1], [1, 0]))).toBe(true);
    expect(logLoss([0, 1], [1, 0])).toBeGreaterThan(5);
  });
  it("brier: p=[0.8,0.3], y=[1,0] は (0.04 + 0.09)/2", () => {
    expect(brier([0.8, 0.3], [1, 0])).toBeCloseTo(0.065, 12);
  });
});

describe("fitLogistic: 市場への係数(y ~ 1 + logit(モデル) + logit(市場))", () => {
  // 乱数に頼らず、決定的に作った標本。真の係数は [-0.3, 0.0, 1.0](市場だけが効く)。
  const rows: number[][] = [];
  const ys: number[] = [];
  let s = 12345;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  for (let i = 0; i < 4000; i++) {
    const m = (rnd() - 0.5) * 4;
    const k = (rnd() - 0.5) * 4;
    const p = sigmoid(-0.3 + 1.0 * m);
    rows.push([k, m]);
    ys.push(rnd() < p ? 1 : 0);
  }
  it("市場の係数は 1 に近く、効いていないモデルの係数は 0 に近い(z で 3 未満)", () => {
    const fit = fitLogistic(rows, ys);
    expect(fit.coef.length).toBe(3);
    expect(fit.coef[2]!).toBeGreaterThan(0.8);
    expect(fit.coef[2]!).toBeLessThan(1.2);
    expect(Math.abs(fit.coef[1]! / fit.se[1]!)).toBeLessThan(3);
    expect(fit.se[2]!).toBeGreaterThan(0);
  });
  it("完全分離でも収束しない無限ループにならない(反復の上限)", () => {
    const fit = fitLogistic([[-1], [-2], [1], [2]], [0, 0, 1, 1]);
    expect(Number.isFinite(fit.coef[1]!)).toBe(true);
  });
});

describe("RideIndex: 騎手・調教師の年別成績をレース日より前の騎乗だけで集計する", () => {
  const idx = new RideIndex();
  idx.add("J1", "2024-12-20", true);
  idx.add("J1", "2025-01-05", false);
  idx.add("J1", "2025-03-01", true);
  idx.add("J1", "2025-06-01", true);
  idx.add("J2", "2025-02-01", true);
  idx.finalize();
  it("基準日と同日の騎乗は含めない(先読みの境界)。同日を含めると 2025 の騎乗数が変わる", () => {
    const before = idx.records("J1", "2025-06-01", [2024, 2025]);
    const after = idx.records("J1", "2025-06-02", [2024, 2025]);
    expect(before!.find((r) => r.year === 2025)!.starts).toBe(2);
    expect(after!.find((r) => r.year === 2025)!.starts).toBe(3);
  });
  it("年ごとに騎乗数と 3 着内の数を返す", () => {
    const r = idx.records("J1", "2026-01-01", [2024, 2025]);
    expect(r).toEqual([
      { year: 2024, starts: 1, placed: 1 },
      { year: 2025, starts: 3, placed: 2 },
    ]);
  });
  it("知らない ID は undefined(データなし。0 件とは別)", () => {
    expect(idx.records("J9", "2026-01-01", [2025])).toBeUndefined();
  });
  it("add の順序に依存しない(finalize で整列)", () => {
    const a = new RideIndex();
    a.add("X", "2025-05-01", true);
    a.add("X", "2025-01-01", false);
    a.finalize();
    expect(a.records("X", "2025-03-01", [2025])).toEqual([{ year: 2025, starts: 1, placed: 0 }]);
  });
});

describe("monthOf", () => {
  it("YYYY-MM-DD から YYYY-MM", () => {
    expect(monthOf("2026-08-09")).toBe("2026-08");
  });
});

describe("pairedRaceBootstrap: 同じレース集合の 2 つのモデルの損失の差", () => {
  // 各レースの (モデル A の損失の合計, モデル B の損失の合計, 頭数)。A は常に B より 0.1/頭 小さい。
  const races = Array.from({ length: 200 }, (_, i) => ({ a: 5 + (i % 7) * 0.1 - 0.1 * 10, b: 5 + (i % 7) * 0.1, n: 10 }));
  it("差の平均は −0.1 で、CI は 0 を含まず、再現できる(シード固定)", () => {
    const r1 = pairedRaceBootstrap(races, 500, 7);
    const r2 = pairedRaceBootstrap(races, 500, 7);
    expect(r1.meanDiff).toBeCloseTo(-0.1, 9);
    expect(r1.ciHigh).toBeLessThan(0);
    expect(r1).toEqual(r2);
  });
  it("差が無い(A=B)なら、CI は 0 をまたぐ", () => {
    const same = races.map((r) => ({ a: r.b, b: r.b, n: r.n }));
    const r = pairedRaceBootstrap(same, 200, 1);
    expect(r.meanDiff).toBe(0);
    expect(r.ciLow).toBeLessThanOrEqual(0);
    expect(r.ciHigh).toBeGreaterThanOrEqual(0);
  });
});

describe("singleWinRoi: 確率 × オッズが 1 を超える馬に 1 ずつ賭ける", () => {
  it("賭けた馬だけを数え、的中の払い戻しはオッズ", () => {
    const r = singleWinRoi([
      { p: 0.5, odds: 3, win: true }, // 1.5 > 1 → 賭ける・的中 → +3
      { p: 0.2, odds: 4, win: false }, // 0.8 → 賭けない
      { p: 0.4, odds: 3, win: false }, // 1.2 → 賭ける・外れ
    ]);
    expect(r.bets).toBe(2);
    expect(r.stake).toBe(2);
    expect(r.payout).toBe(3);
    expect(r.roi).toBeCloseTo(1.5, 12);
  });
  it("賭けが 0 件なら roi は null(0 と区別する)", () => {
    expect(singleWinRoi([{ p: 0.1, odds: 2, win: true }]).roi).toBeNull();
  });
});
