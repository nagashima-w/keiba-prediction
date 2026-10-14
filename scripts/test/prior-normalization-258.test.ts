/**
 * #258 第1段の比較用モジュール(`scripts/prior-normalization-258/`)のテスト。
 *
 * - `normalizers.ts` の「旧(乗算)」は、#258 より前の `computeFieldPriors` の正規化を**凍結したコピー**である。
 *   凍結が正しいことを、旧テスト(`prior-calibration.test.ts` の「巻き添え防止」2件と `prior.test.ts` の
 *   「合計が 3 付近に戻る」・`probability-quality-regression.test.ts` の「Σ=3.04 は素通し」)が固定していた
 *   数値で確かめる(ここで旧版の挙動を再現できなければ、比較の「前」が嘘になる)。
 * - データセット(`docs/investigations/prior-normalization-258/dataset.json`)の整合(名前を含まない・件数・Σ)。
 * - 比較の数値(report.md に書いた値)の固定。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCORER_CONFIG } from "../../packages/core/src/scorer/config.js";
import { normalizeFieldPriors } from "../../packages/core/src/scorer/prior.js";
import {
  additiveShiftNormalize,
  legacyMultiplicativeNormalize,
} from "../prior-normalization-258/normalizers.js";
import { computeComparison, type PriorNormalizationDataset } from "../prior-normalization-258/compare.js";

const CFG = DEFAULT_SCORER_CONFIG.prior;
const sum = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0);

describe("旧(乗算)の凍結コピーが、#258 前のテストの固定値を再現する", () => {
  it("平均馬 1 頭 + 弱い 9 頭(旧 prior-calibration 「scale>1」): 平均馬 0.95(再クランプ)・弱い馬 0.125", () => {
    const out = legacyMultiplicativeNormalize([0.3, ...new Array(9).fill(0.02)], CFG);
    expect(out[0]).toBeCloseTo(0.95, 10);
    for (const v of out.slice(1)) expect(v).toBeCloseTo(0.125, 10);
  });

  it("飽和 1 頭 + 平均馬 15 頭(旧 prior-calibration 「巻き添え防止」): 平均馬は 0.13 超 0.1875 以下・強馬は 0.5 超", () => {
    const out = legacyMultiplicativeNormalize([3.0, ...new Array(15).fill(0.1875)], CFG);
    for (const v of out.slice(1)) {
      expect(v).toBeGreaterThan(0.13);
      expect(v).toBeLessThanOrEqual(0.1875);
    }
    expect(out[0]).toBeGreaterThan(0.5);
  });

  it("Σ が目標の ±10% 以内(偏差 1.3%)なら何もしない(旧 regression 「Σ=3.04」): クランプ後の値がそのまま", () => {
    const raws = [0.04, 0.3, 0.5, 0.6, 0.8, 0.8]; // Σ=3.04
    const out = legacyMultiplicativeNormalize(raws, CFG);
    expect(sum(out)).toBeCloseTo(3.04, 10);
    out.forEach((v, i) => expect(v).toBeCloseTo(raws[i]!, 12));
  });

  it("Σ が目標を大きく上回ると全馬に 1 より小さい同じ倍率を掛ける(広がりを縮める)", () => {
    const raws = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]; // Σ=3.6
    const out = legacyMultiplicativeNormalize(raws, CFG);
    expect(sum(out)).toBeCloseTo(3, 10);
    const scale = out[0]! / raws[0]!;
    expect(scale).toBeLessThan(0.9); // 空振り防止: 倍率は 1 から離れている
    out.forEach((v, i) => expect(v / raws[i]!).toBeCloseTo(scale, 10));
  });
});

describe("加算シフト(参考。ユーザーは採用せず、ロジットシフトを選んだ)", () => {
  it("Σ=目標で、クランプに当たらない馬どうしの確率の差が保たれる", () => {
    const raws = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7];
    const out = additiveShiftNormalize(raws, CFG);
    expect(sum(out)).toBeCloseTo(3, 10);
    for (let i = 1; i < raws.length; i++) {
      expect(out[i]! - out[i - 1]!).toBeCloseTo(raws[i]! - raws[i - 1]!, 10);
    }
    expect(out[0]).not.toBeCloseTo(raws[0]!, 3); // 空振り防止: 実際にずらされている
  });
});

describe("normalizeFieldPriors(採用)と旧・加算の違い", () => {
  // Σraw=4.0(目標 3 を ±10% より大きく上回る。旧のゲートが発動する)。
  const raws = [0.1, 0.167, 0.233, 0.3, 0.367, 0.433, 0.5, 0.567, 0.633, 0.7];
  it("三者とも Σ=目標(前提: この入力の Σraw は目標の ±10% の外で、旧のゲートが発動する)", () => {
    expect(Math.abs(sum(raws) - 3) / 3).toBeGreaterThan(0.1);
    for (const out of [
      legacyMultiplicativeNormalize(raws, CFG),
      additiveShiftNormalize(raws, CFG),
      normalizeFieldPriors(raws, CFG),
    ]) {
      expect(sum(out)).toBeCloseTo(3, 10);
    }
  });
  it("広がり(sd)は 旧 < ロジットシフト(同じ入力で、旧は縮む)", () => {
    const sd = (xs: number[]): number => {
      const m = sum(xs) / xs.length;
      return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / xs.length);
    };
    const legacy = sd(legacyMultiplicativeNormalize(raws, CFG));
    const logitShift = sd(normalizeFieldPriors(raws, CFG));
    expect(logitShift).toBeGreaterThan(legacy);
  });
});

// ---------------------------------------------------------------------------
// データセット
// ---------------------------------------------------------------------------

const DATASET_URL = new URL(
  "../../docs/investigations/prior-normalization-258/dataset.json",
  import.meta.url,
);
const dataset = JSON.parse(readFileSync(fileURLToPath(DATASET_URL), "utf-8")) as PriorNormalizationDataset;

describe("データセット(docs/investigations/prior-normalization-258/dataset.json)", () => {
  it("33 レース・429 頭で、頭数は fieldSize と一致する", () => {
    expect(dataset.races).toHaveLength(33);
    expect(dataset.races.reduce((s, r) => s + r.horses.length, 0)).toBe(429);
    for (const r of dataset.races) {
      expect(r.horses).toHaveLength(r.fieldSize);
      expect(r.fieldSize).toBeGreaterThanOrEqual(8);
    }
  });

  it("馬名・騎手名などの名前を含まない(キー名にも値にも。馬番・数値・ID・人気・着順だけ)", () => {
    const text = readFileSync(fileURLToPath(DATASET_URL), "utf-8");
    for (const key of ["horseName", "jockeyName", "name", "trainerName", "jockeyId", "horseId"]) {
      expect(text.includes(`"${key}"`)).toBe(false);
    }
    // 馬の項目は数値・真偽のみ(文字列の値はレース ID・地域・開催日・説明だけ)。
    for (const r of dataset.races) {
      for (const h of r.horses) {
        for (const [k, v] of Object.entries(h)) {
          expect(typeof v === "number" || v === null, `${r.raceId} ${k}`).toBe(true);
        }
      }
    }
  });

  it("馬ごとの項目が揃っている(rawPrior は有限・人気は 1〜頭数・3 着内/1 着は 0 か 1)", () => {
    for (const r of dataset.races) {
      for (const h of r.horses) {
        expect(Number.isFinite(h.rawPrior)).toBe(true);
        expect(h.popularity).toBeGreaterThanOrEqual(1);
        expect(h.popularity).toBeLessThanOrEqual(r.fieldSize);
        expect([0, 1]).toContain(h.placed);
        expect([0, 1]).toContain(h.won);
      }
      // 各レースの 3 着内は 1 頭以上(同着を含め 3 頭前後)。
      expect(r.horses.reduce((s, h) => s + h.placed, 0)).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// 比較の数値(report.md に書いた値)
// ---------------------------------------------------------------------------

describe("比較の数値(report.md に書いた値を固定する)", () => {
  const cmp = computeComparison(dataset);
  const legacy = cmp.variants[0]!;
  const additive = cmp.variants[1]!;
  const logitShift = cmp.variants[2]!;

  it("3 方式(旧・加算 A・ロジットシフト)が、この順で揃っている。対象は 33 レース・429 頭で、旧の正規化が発動したのは 25 レース", () => {
    expect(cmp.variants.map((v) => v.name)).toEqual(["旧(乗算)", "加算シフト(参考)", "ロジットシフト(採用)"]);
    expect(cmp.raceCount).toBe(33);
    expect(cmp.horseCount).toBe(429);
    expect(cmp.legacyNormalizedRaceCount).toBe(25);
  });

  it("Σ/目標: 旧はゲートで素通しのレースがあり 0.92〜1.10。加算・ロジットシフトは常に 1(9 桁)", () => {
    expect(legacy.sumRatioMin).toBeCloseTo(0.922, 3);
    expect(legacy.sumRatioMax).toBeCloseTo(1.1, 2);
    expect(legacy.sumRatioMax - legacy.sumRatioMin).toBeGreaterThan(0.1); // 空振り防止: 旧は実際にばらつく
    for (const v of [additive, logitShift]) {
      expect(v.sumRatioMin).toBeCloseTo(1, 9);
      expect(v.sumRatioMax).toBeCloseTo(1, 9);
    }
  });

  it("Brier: 旧 0.1661 ≒ ロジットシフト 0.1662。旧との差の区間は 0 をまたぐ(有意に動かない)。旧自身との差は 0", () => {
    expect(legacy.brier).toBeCloseTo(0.1661, 4);
    expect(logitShift.brier).toBeCloseTo(0.1662, 4);
    expect(legacy.brierDiffVsLegacy.value).toBeCloseTo(0, 12);
    const d = logitShift.brierDiffVsLegacy;
    expect(d.value).toBeCloseTo(0.00012, 5);
    expect(d.lower!).toBeLessThan(0);
    expect(d.upper!).toBeGreaterThan(0);
    // 区間が自明に狭くない(旧自身との差は幅 0 だが、新旧は異なる prior を比べている)。
    expect(d.upper! - d.lower!).toBeGreaterThan(0.001);
  });

  it("広がり: sd(prior)/sd(raw) の中央値は 旧 0.772 < ロジットシフト 0.856 < 加算 1.000(ロジットシフトは確率の sd を完全には戻さない)", () => {
    expect(legacy.sdOverRawMedian).toBeCloseTo(0.772, 3);
    expect(logitShift.sdOverRawMedian).toBeCloseTo(0.856, 3);
    expect(additive.sdOverRawMedian).toBeCloseTo(1, 3);
    expect(logitShift.sdVsLegacyMedian).toBeCloseTo(1.106, 3);
    expect(legacy.sdRatioMarketMedian).toBeCloseTo(0.389, 3);
    expect(logitShift.sdRatioMarketMedian).toBeCloseTo(0.411, 3);
  });

  it("床・天井: 旧 4/0・ロジットシフト 4/0 に対し、加算は 25/0(25 頭が同値の床に潰れる。6 レースで 2 頭以上)", () => {
    expect([legacy.atFloor, legacy.atCeiling]).toEqual([4, 0]);
    expect([logitShift.atFloor, logitShift.atCeiling]).toEqual([4, 0]);
    expect([additive.atFloor, additive.atCeiling]).toEqual([25, 0]);
    expect(additive.racesWithTies).toBe(6);
    expect(additive.tiePairs).toBe(25);
    expect(logitShift.tiePairs).toBe(0);
    // 加算で床に落ちた馬は、実際には 3 着内に入る馬が混ざる(情報の喪失)。
    expect(additive.floorHorses.n).toBe(25);
    expect(additive.floorHorses.actualPlaceRate!).toBeCloseTo(0.16, 3);
  });

  it("prior の最大: 旧 0.478 → ロジットシフト 0.616(加算 0.619)。人気 1 番の平均 prior は 旧 0.305 → ロジットシフト 0.308", () => {
    expect(legacy.priorMax).toBeCloseTo(0.478, 3);
    expect(logitShift.priorMax).toBeCloseTo(0.616, 3);
    expect(additive.priorMax).toBeCloseTo(0.619, 3);
    expect(legacy.rankMeans["1"]).toBeCloseTo(0.305, 3);
    expect(logitShift.rankMeans["1"]).toBeCloseTo(0.308, 3);
    expect(legacy.rankMeans["10以下"]).toBeCloseTo(0.167, 3);
    expect(logitShift.rankMeans["10以下"]).toBeCloseTo(0.163, 3);
  });

  it("順序: 旧とロジットシフト・加算で、レース内の馬対の大小が入れ替わった数は 0。市場との ρ の中央値も同じ", () => {
    expect(logitShift.pairInversionsVsLegacy).toBe(0);
    expect(additive.pairInversionsVsLegacy).toBe(0);
    expect(logitShift.spearmanRhoMarketMedian).toBeCloseTo(legacy.spearmanRhoMarketMedian, 9);
    expect(legacy.spearmanRhoMarketMedian).toBeCloseTo(0.615, 3);
  });

  it("PL フィットの失敗(#84): 旧は全て 0。ロジットシフトは『窓の外に答える LLM』で ±0.10 が 1/19800・±0.15 が 1/19800(同じレース 202606040911 の突出馬)", () => {
    const rows = (v: typeof legacy) => Object.fromEntries(v.plFailures.map((r) => [r.scenario, [r.failures, r.fits]]));
    const L = rows(legacy);
    const N = rows(logitShift);
    expect(L["prior のみ"]).toEqual([0, 33]);
    expect(N["prior のみ"]).toEqual([0, 33]);
    expect(N["prior + LLM 補正量(実測の対応・±0.10)"]).toEqual([0, 33]);
    expect(L["窓の外に答える LLM(±0.10・各レース 600 回)"]).toEqual([0, 19800]);
    expect(L["窓の外に答える LLM(±0.15・各レース 600 回)"]).toEqual([0, 19800]);
    expect(N["窓の外に答える LLM(±0.10・各レース 600 回)"]).toEqual([1, 19800]);
    expect(N["窓の外に答える LLM(±0.15・各レース 600 回)"]).toEqual([1, 19800]);
  });
});
