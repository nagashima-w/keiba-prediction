/**
 * 統計モデルの並走(影の計算。Issue #649)の純関数のテスト。
 *
 * 突き合わせ(`stat-shadow-golden.json`): 学習のスクリプト(`scripts/stat-model-649/export_coef.py`)が、**sklearn の標準化 + ロジスティック回帰の
 * `decision_function`** と、numpy で独立に書いたロジットシフトで計算した確率。本番の `computeShadowProbs`(標準化を畳み込んだ重み)が 1e-9 以内で一致する
 * = 学習の特徴量の作り方と本番の作り方がずれていないこと(`prior` の clamp・q の割り戻し・log(頭数)・15 項目を名前で引く・正規化の目標)を固定する。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SHADOW_MIN_FIELD,
  SHADOW_MODEL_NODDS,
  SHADOW_MODEL_ODDS,
  computeShadowProbs,
  marketShares,
  normalizeLogitShift,
  type ShadowHorseInput,
} from "../../src/ev/stat-shadow.js";
import { SHADOW_COEF_NODDS, SHADOW_COEF_ODDS, SHADOW_CONTRIB_NAMES } from "../../src/ev/stat-shadow-coef.js";

interface GoldenHorse {
  umaban: number;
  prior: number;
  contrib: Record<string, number>;
  winOdds: number;
}
interface GoldenRace {
  raceId: string;
  horses: GoldenHorse[];
  expected: Record<"odds" | "noodds", Record<"win" | "top2" | "top3", number[]>>;
}
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./stat-shadow-golden.json", import.meta.url)), "utf8")) as { races: GoldenRace[] };

const toInput = (h: GoldenHorse, winOdds: number | null = h.winOdds): ShadowHorseInput => ({
  umaban: h.umaban,
  prior: h.prior,
  winOdds,
  contributions: Object.entries(h.contrib).map(([biasName, correction]) => ({ biasName, applied: true, weight: 1, correction, sampleCount: null, targetRate: null, overallRate: null })) as unknown as ShadowHorseInput["contributions"],
});

const sum = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0);

describe("computeShadowProbs: 学習(Python)との突き合わせ", () => {
  it("突き合わせ用のレースが、頭数の違う 12 レースある(退化した入力だけではない)", () => {
    expect(golden.races.length).toBe(12);
    expect(new Set(golden.races.map((r) => r.horses.length)).size).toBeGreaterThanOrEqual(8);
  });
  for (const race of golden.races) {
    it(`${race.raceId}(${race.horses.length} 頭): オッズ入り・オッズなしの 3 目的が 1e-9 以内で一致する`, () => {
      const probs = computeShadowProbs(race.horses.map((h) => toInput(h)));
      expect(probs.length).toBe(race.horses.length * 2);
      for (const [model, key] of [
        [SHADOW_MODEL_ODDS, "odds"],
        [SHADOW_MODEL_NODDS, "noodds"],
      ] as const) {
        const mine = probs.filter((p) => p.model === model);
        expect(mine.map((p) => p.umaban)).toEqual(race.horses.map((h) => h.umaban));
        mine.forEach((p, i) => {
          expect(Math.abs(p.winProb - race.expected[key].win[i]!)).toBeLessThan(1e-9);
          expect(Math.abs(p.top2Prob - race.expected[key].top2[i]!)).toBeLessThan(1e-9);
          expect(Math.abs(p.top3Prob - race.expected[key].top3[i]!)).toBeLessThan(1e-9);
        });
        // 合計が目標に一致する(勝率 1・2着内率 2・3着内率 3)。
        expect(sum(mine.map((p) => p.winProb))).toBeCloseTo(1, 6);
        expect(sum(mine.map((p) => p.top2Prob))).toBeCloseTo(2, 6);
        expect(sum(mine.map((p) => p.top3Prob))).toBeCloseTo(3, 6);
      }
    });
  }
  it("突き合わせの値は馬ごとに違う(全馬同じ確率で通る空振りではない)", () => {
    const e = golden.races[0]!.expected.odds.win;
    expect(Math.max(...e) - Math.min(...e)).toBeGreaterThan(0.05);
  });
});

describe("computeShadowProbs: 入力の条件", () => {
  const race = golden.races.find((r) => r.horses.length >= 12)!;
  it(`頭数が ${SHADOW_MIN_FIELD} 頭未満なら何も作らない(学習は 5 頭以上だけ)`, () => {
    expect(computeShadowProbs(race.horses.slice(0, SHADOW_MIN_FIELD - 1).map((h) => toInput(h)))).toEqual([]);
    expect(computeShadowProbs(race.horses.slice(0, SHADOW_MIN_FIELD).map((h) => toInput(h))).length).toBe(SHADOW_MIN_FIELD * 2);
  });
  it("オッズが 1 頭でも欠けるレースは、オッズなしの版だけ(オッズ入りは作らない)。オッズなしの値はオッズの有無で変わらない", () => {
    const full = computeShadowProbs(race.horses.map((h) => toInput(h)));
    const missing = computeShadowProbs(race.horses.map((h, i) => toInput(h, i === 2 ? null : h.winOdds)));
    expect(new Set(missing.map((p) => p.model))).toEqual(new Set([SHADOW_MODEL_NODDS]));
    expect(missing.length).toBe(race.horses.length);
    expect(missing).toEqual(full.filter((p) => p.model === SHADOW_MODEL_NODDS));
    // 0 以下・非有限も欠けとして扱う。
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const m = computeShadowProbs(race.horses.map((h, i) => toInput(h, i === 0 ? bad : h.winOdds)));
      expect(m.every((p) => p.model === SHADOW_MODEL_NODDS)).toBe(true);
    }
  });
  it("寄与の名前が無ければ 0(学習の contrib.get(k, 0.0) と同じ)。名前が一致しない寄与は無視される", () => {
    const h = race.horses.map((x) => toInput(x));
    const stripped = h.map((x) => ({ ...x, contributions: [] }));
    const renamed = h.map((x) => ({ ...x, contributions: x.contributions.map((c) => ({ ...c, biasName: `x${c.biasName}` })) }));
    const a = computeShadowProbs(stripped);
    expect(computeShadowProbs(renamed)).toEqual(a);
    // 「名前が無い」は「寄与 0」と同じ(学習の contrib.get(k, 0.0))。デフォルト値を 0 以外にすると、これが落ちる。
    const zeros = h.map((x) => ({ ...x, contributions: x.contributions.map((c) => ({ ...c, correction: 0 })) }));
    expect(computeShadowProbs(stripped)).toEqual(computeShadowProbs(zeros));
    // 寄与が実際に効いている(外すと値が変わる)ことを固定する。
    const full = computeShadowProbs(h);
    expect(Math.max(...full.map((p, i) => Math.abs(p.top3Prob - a[i]!.top3Prob)))).toBeGreaterThan(1e-3);
  });
  it("入力の順序を入れ替えても、馬ごとの確率は同じ", () => {
    const rev = [...race.horses].reverse().map((h) => toInput(h));
    const a = computeShadowProbs(race.horses.map((h) => toInput(h)));
    const b = computeShadowProbs(rev);
    for (const p of a) {
      const q = b.find((x) => x.umaban === p.umaban && x.model === p.model)!;
      expect(Math.abs(q.winProb - p.winProb)).toBeLessThan(1e-12);
    }
  });
  it("確率は [1e-6, 1−1e-6] に収まる(極端な prior でも)", () => {
    const extreme = race.horses.map((h, i) => toInput({ ...h, prior: i === 0 ? 0.999999 : 1e-9 }));
    for (const p of computeShadowProbs(extreme)) {
      for (const v of [p.winProb, p.top2Prob, p.top3Prob]) {
        expect(v).toBeGreaterThanOrEqual(1e-6);
        expect(v).toBeLessThanOrEqual(1 - 1e-6);
      }
    }
  });
});

describe("係数ファイルの形(自動生成物の取り違え防止)", () => {
  it("オッズ入りは 3 + 15 個、オッズなしは 2 + 15 個の特徴量で、重みの数と一致する。15 項目の名前は昇順", () => {
    expect(SHADOW_CONTRIB_NAMES.length).toBe(15);
    expect([...SHADOW_CONTRIB_NAMES]).toEqual([...SHADOW_CONTRIB_NAMES].sort());
    expect(SHADOW_COEF_ODDS.features.length).toBe(18);
    expect(SHADOW_COEF_NODDS.features.length).toBe(17);
    for (const c of [SHADOW_COEF_ODDS, SHADOW_COEF_NODDS]) {
      for (const o of [c.win, c.top2, c.top3]) expect(o.weights.length).toBe(c.features.length);
      expect(c.features.slice(c.features.length - 15)).toEqual(SHADOW_CONTRIB_NAMES.map((n) => `c_${n}`));
    }
    expect(SHADOW_COEF_ODDS.features.slice(0, 3)).toEqual(["m_logit", "log_n", "prior_logit"]);
    expect(SHADOW_COEF_NODDS.features.slice(0, 2)).toEqual(["log_n", "prior_logit"]);
    expect(SHADOW_MODEL_ODDS).not.toBe(SHADOW_MODEL_NODDS);
  });
});

describe("marketShares・normalizeLogitShift", () => {
  it("q は 1/オッズを合計 1 に割り戻す(2・4・4 倍 → 0.5・0.25・0.25)。欠けは null", () => {
    expect(marketShares([2, 4, 4])).toEqual([0.5, 0.25, 0.25]);
    expect(marketShares([2, null, 4])).toBeNull();
  });
  it("目標に合わせ、順序と共通のシフト(ロジット差)を保つ。目標が頭数以上なら全頭 1", () => {
    const l = [-2, -1, 0, 1, 2, -3];
    const p = normalizeLogitShift(l, 2);
    expect(sum(p)).toBeCloseTo(2, 9);
    expect(Math.log(p[4]! / (1 - p[4]!)) - Math.log(p[0]! / (1 - p[0]!))).toBeCloseTo(l[4]! - l[0]!, 9);
    expect(normalizeLogitShift([0, 1, 2], 3)).toEqual([1, 1, 1]);
  });
});
