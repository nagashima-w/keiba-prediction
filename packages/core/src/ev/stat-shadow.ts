/**
 * 統計モデルの並走(影の計算。Issue #649 段階 2・3): 学習済みのロジスティック回帰で、勝率・2着内率・3着内率を計算する純関数。
 *
 * **買い目・配分・EV・画面・LLM のどれにも使わない。** 発走前の分析の保存のときに別の表へ記録するだけ(結果が出たあとに、いまのやり方と並べて比べる)。
 * ネットワーク・D1 には触れない(`analysis-pipeline.ts` が呼び、cloud が保存する)。
 *
 * ## 特徴量(学習 `scripts/stat-model-649/fit.py`・`export_coef.py` と同じ作り。突き合わせは `test/ev/stat-shadow.test.ts`)
 *  - `m_logit` = logit(q)。q = (1/単勝オッズ)をレース内(出走する全頭)で合計 1 に割り戻した値。1 頭でもオッズが無い(null・0 以下・非有限)と q は作れない → オッズ入りの版は計算しない。
 *  - `log_n` = ln(頭数)。頭数は出走する全頭(取消・除外を除く。`scrapeRace` が除いている)。
 *  - `prior_logit` = logit(clamp(prior, 1e-4, 1−1e-4))。prior は LLM の補正の前の統計モデルの 3着内率。
 *  - `c_<名前>` = 15 項目の寄与(補正値)。名前が無ければ 0(学習の `contrib.get(k, 0.0)` と同じ)。
 * 学習は走った馬が 5 頭以上のレースだけなので、**5 頭未満は計算しない**。
 *
 * ## 確率にする
 * 馬ごとのスコア(ログオッズ)に、レースの全馬に共通のロジットを足して、合計を 1(勝率)・2(2着内率)・3(3着内率)に合わせる(`normalizeLogitShift`。学習後の評価 `scripts/stat-model-649/lib.ts` と同じ式)。
 * 確率は [1e-6, 1−1e-6] に切る。
 *
 * ## 本番で使えない特徴量
 * 学習でも使っていない(調教〈oikiri〉はレコードに無く入力から外した。15 項目の寄与は `computeFieldPriors` の出力そのもの)。
 */

import type { PriorResult } from "../scorer/prior.js";
import {
  SHADOW_COEF_NODDS,
  SHADOW_COEF_ODDS,
  SHADOW_MODEL_NODDS,
  SHADOW_MODEL_ODDS,
  type ShadowModelCoef,
} from "./stat-shadow-coef.js";

export { SHADOW_MODEL_NODDS, SHADOW_MODEL_ODDS };

/** 学習に使ったレースの最小頭数(これ未満は計算しない)。 */
export const SHADOW_MIN_FIELD = 5;

const PROB_EPS = 1e-6;
const clampProb = (p: number): number => Math.min(1 - PROB_EPS, Math.max(PROB_EPS, p));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const logit = (p: number): number => Math.log(p / (1 - p));

/**
 * 全馬に共通のロジット c を足して、Σ sigmoid(l_i + c) = target にする(二分法)。target が頭数以上なら全頭 1。
 * `scripts/stat-model-649/lib.ts` の `normalizeLogitShift` と同じ式(あちらは評価用の写し。突き合わせはテストで固定する)。
 */
export function normalizeLogitShift(logits: readonly number[], target: number): number[] {
  if (target >= logits.length) {
    return logits.map(() => 1);
  }
  let lo = -60;
  let hi = 60;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const total = logits.reduce((s, l) => s + sigmoid(l + mid), 0);
    if (total > target) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  const c = (lo + hi) / 2;
  return logits.map((l) => sigmoid(l + c));
}

/**
 * 単勝オッズから市場の確率 q(1/オッズをレース内で合計 1 に割り戻す)。1 頭でもオッズが無い(null・0 以下・非有限)なら null。
 */
export function marketShares(odds: ReadonlyArray<number | null>): number[] | null {
  const inv: number[] = [];
  for (const o of odds) {
    if (o === null || !Number.isFinite(o) || o <= 0) {
      return null;
    }
    inv.push(1 / o);
  }
  const total = inv.reduce((s, v) => s + v, 0);
  return inv.map((v) => v / total);
}

/** 1 頭分の入力。 */
export interface ShadowHorseInput {
  readonly umaban: number;
  /** 統計モデルの 3着内率(LLM の補正の前。`PriorResult.prior`)。 */
  readonly prior: number;
  /** 寄与度ログ(`PriorResult.contributions`)。名前で引く。 */
  readonly contributions: PriorResult["contributions"];
  /** 分析の時点の単勝オッズ。取れていない馬は null。 */
  readonly winOdds: number | null;
}

/** 1 頭 1 モデルの確率。 */
export interface ShadowProb {
  readonly umaban: number;
  /** モデルの版の名前(`SHADOW_MODEL_ODDS`・`SHADOW_MODEL_NODDS`)。 */
  readonly model: string;
  readonly winProb: number;
  readonly top2Prob: number;
  readonly top3Prob: number;
}

function featureValue(
  name: string,
  h: ShadowHorseInput,
  n: number,
  q: number | null,
): number {
  if (name === "m_logit") {
    if (q === null) throw new Error("m_logit にはオッズが要ります");
    return logit(Math.min(1 - 1e-6, Math.max(1e-6, q)));
  }
  if (name === "log_n") return Math.log(n);
  if (name === "prior_logit") return logit(Math.min(1 - 1e-4, Math.max(1e-4, h.prior)));
  if (name.startsWith("c_")) {
    const key = name.slice(2);
    return h.contributions.find((c) => c.biasName === key)?.correction ?? 0;
  }
  throw new Error(`知らない特徴量です: ${name}`);
}

function scoreAll(
  coef: ShadowModelCoef,
  horses: readonly ShadowHorseInput[],
  q: readonly number[] | null,
): { win: number[]; top2: number[]; top3: number[] } {
  const n = horses.length;
  const rows = horses.map((h, i) => coef.features.map((f) => featureValue(f, h, n, q === null ? null : q[i]!)));
  const score = (o: { intercept: number; weights: readonly number[] }): number[] =>
    rows.map((r) => r.reduce((s, x, k) => s + x * o.weights[k]!, o.intercept));
  return { win: score(coef.win), top2: score(coef.top2), top3: score(coef.top3) };
}

/**
 * 全馬の確率を、オッズ入りの版・オッズなしの版で計算する。
 *  - 頭数が {@link SHADOW_MIN_FIELD} 未満 → 空(どちらも計算しない)。
 *  - オッズが 1 頭でも欠ける → オッズなしの版だけ。
 * 入力の順序は変えない(出力は馬ごと・モデルごとに並ぶ)。
 */
export function computeShadowProbs(horses: readonly ShadowHorseInput[]): ShadowProb[] {
  if (horses.length < SHADOW_MIN_FIELD) {
    return [];
  }
  const q = marketShares(horses.map((h) => h.winOdds));
  const models: Array<{ model: string; coef: ShadowModelCoef; q: readonly number[] | null }> = [];
  if (q !== null) models.push({ model: SHADOW_MODEL_ODDS, coef: SHADOW_COEF_ODDS, q });
  models.push({ model: SHADOW_MODEL_NODDS, coef: SHADOW_COEF_NODDS, q: null });
  const out: ShadowProb[] = [];
  for (const m of models) {
    const s = scoreAll(m.coef, horses, m.q);
    const win = normalizeLogitShift(s.win, 1).map(clampProb);
    const top2 = normalizeLogitShift(s.top2, 2).map(clampProb);
    const top3 = normalizeLogitShift(s.top3, 3).map(clampProb);
    horses.forEach((h, i) => {
      out.push({ umaban: h.umaban, model: m.model, winProb: win[i]!, top2Prob: top2[i]!, top3Prob: top3[i]! });
    });
  }
  return out;
}
