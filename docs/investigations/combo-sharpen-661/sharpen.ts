/**
 * 組合せの確率の平たさを直す試算(Issue #661 段階 1)の純粋な部分。本番には入れない。
 *
 * - {@link sharpenedPlModel}: 候補 A。本番と同じ `fitPlackettLuceStrengths` で求めた θ を τ 乗した Plackett–Luce の同時分布モデル。
 *   本番の `buildOutcomesFromFullTheta` 等は非 export なので、頭数が最大 18・上位 3 着(最大 4,896 通り)の列挙をここで書き直した。
 *   τ = 1 で `PLACKETT_LUCE_MODEL` と一致することをテストで固定している。
 *   θ に 0(除外)・Infinity(固定)が出る入力と縮退(k ≥ 頭数・0 頭・k = 0)は尖らせず本番モデルに委ね、その回数を数える。
 * - {@link substituteProbsModel}: 候補 B。同時分布に渡す馬ごとの確率だけを差し替えて本番モデルを呼ぶ(複勝の的中確率と EV は `adjustedProb` から直接作られ、
 *   このモデルを通らない)。差し替えた確率で本番モデルが例外を投げたら、元の確率で呼び直し、その回数を数える。
 * - 人気の帯・前半後半の分け方。
 */
import type { JointModelHorse, OrderedOutcome, OrderedPlaceJointModel, PlaceOutcome } from "../../../packages/core/src/ev/place-joint-model.js";
import { PLACKETT_LUCE_MODEL } from "../../../packages/core/src/ev/plackett-luce-model.js";
import { fitPlackettLuceStrengths } from "../../../packages/core/src/ev/plackett-luce-strength.js";
import { parseComboOddsKey } from "../../../packages/core/src/scraper/combo-odds-key.js";

export interface CountedModel {
  readonly model: OrderedPlaceJointModel;
}

/** 順序付きの列挙(上位 k 着。確率 = ∏ θ_i / (残りの θ の合計))。 */
function enumerateOrdered(horses: readonly JointModelHorse[], pow: readonly number[], k: number): OrderedOutcome[] {
  const n = horses.length;
  const out: OrderedOutcome[] = [];
  const used = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  const total = pow.reduce((a, b) => a + b, 0);
  const rec = (denom: number, prob: number): void => {
    if (order.length === k) {
      out.push({ order: order.map((i) => horses[i]!.umaban), probability: prob });
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      order.push(i);
      rec(denom - pow[i]!, prob * (pow[i]! / denom));
      order.pop();
      used[i] = false;
    }
  };
  rec(total, 1);
  return out;
}

/** 候補 A。τ は正の有限値。`delegated()` は、尖らせずに本番モデルへ委ねた呼び出しの数(集合・順序の呼び出しごとに 1)。 */
export function sharpenedPlModel(tau: number): CountedModel & { delegated: () => number } {
  if (!Number.isFinite(tau) || tau <= 0) throw new RangeError(`τ は正の有限値です: ${String(tau)}`);
  let delegated = 0;
  /** 尖らせた θ^τ。委ねるべき入力なら null。 */
  const powered = (horses: readonly JointModelHorse[], k: number): number[] | null => {
    if (horses.length === 0 || k === 0 || k >= horses.length) return null;
    const fit = fitPlackettLuceStrengths(horses, k);
    if (!fit.ok || fit.theta.some((t) => !(Number.isFinite(t) && t > 0))) return null;
    const pow = fit.theta.map((t) => t ** tau);
    return pow.every((v) => Number.isFinite(v) && v > 0) ? pow : null;
  };
  const model: OrderedPlaceJointModel = {
    id: `plackett-luce-theta-pow-${tau}`,
    approximate: false,
    buildDistribution(horses, k) {
      const pow = powered(horses, k);
      if (pow === null) {
        delegated++;
        return PLACKETT_LUCE_MODEL.buildDistribution(horses, k);
      }
      const byKey = new Map<string, PlaceOutcome>();
      for (const o of enumerateOrdered(horses, pow, k)) {
        const placed = [...o.order].sort((a, b) => a - b);
        const key = placed.join(",");
        const cur = byKey.get(key);
        byKey.set(key, { placed, probability: (cur?.probability ?? 0) + o.probability });
      }
      return [...byKey.values()];
    },
    buildOrderedDistribution(horses, k) {
      const pow = powered(horses, k);
      if (pow === null) {
        delegated++;
        return PLACKETT_LUCE_MODEL.buildOrderedDistribution(horses, k);
      }
      return enumerateOrdered(horses, pow, k);
    },
  };
  return { model, delegated: () => delegated };
}

/** 候補 B。表に無い馬は元の確率のまま。`fallbacks()` は、差し替えた確率で例外になり元の確率で呼び直した回数。 */
export function substituteProbsModel(
  probs: ReadonlyMap<number, number>,
  base: OrderedPlaceJointModel,
): CountedModel & { fallbacks: () => number } {
  let fallbacks = 0;
  const swap = (horses: readonly JointModelHorse[]): JointModelHorse[] =>
    horses.map((h) => ({ umaban: h.umaban, placeProb: probs.get(h.umaban) ?? h.placeProb }));
  const tryOr = <T>(f: (hs: readonly JointModelHorse[]) => T, horses: readonly JointModelHorse[]): T => {
    try {
      return f(swap(horses));
    } catch {
      fallbacks++;
      return f(horses);
    }
  };
  const model: OrderedPlaceJointModel = {
    id: base.id,
    approximate: base.approximate,
    buildDistribution: (horses, k) => tryOr((hs) => base.buildDistribution(hs, k), horses),
    buildOrderedDistribution: (horses, k) => tryOr((hs) => base.buildOrderedDistribution(hs, k), horses),
  };
  return { model, fallbacks: () => fallbacks };
}

export interface RankHorse { readonly umaban: number; readonly winOdds: number | null }

/** 単勝人気(オッズの小さい順の競争順位。同オッズは同順位)。単勝オッズの無い馬は最後(オッズのある馬の数 + 1)。 */
export function popularityRanks(horses: readonly RankHorse[]): Map<number, number> {
  const has = (h: RankHorse): boolean => h.winOdds !== null && Number.isFinite(h.winOdds) && h.winOdds > 0;
  const withOdds = horses.filter(has);
  const out = new Map<number, number>();
  for (const h of horses) out.set(h.umaban, has(h) ? 1 + withOdds.filter((x) => (x.winOdds as number) < (h.winOdds as number)).length : withOdds.length + 1);
  return out;
}

export type PopularityBand = "1〜3番人気" | "4〜6番人気" | "7番人気〜";
export const POPULARITY_BANDS: readonly PopularityBand[] = ["1〜3番人気", "4〜6番人気", "7番人気〜"];
export function bandOf(rank: number): PopularityBand {
  return rank <= 3 ? "1〜3番人気" : rank <= 6 ? "4〜6番人気" : "7番人気〜";
}

/**
 * 買い目に含む馬のうち、単勝人気の一番低い(順位の最大の)馬の順位。順序付きキーも集合として読む。
 * 枠連は枠に入る馬(`wakubanOf`: 馬番 → 枠番)のうち一番低い馬。読めないキー・人気の分からない馬を含むときは null。
 */
export function betMinRank(betType: string, comboKey: string, ranks: ReadonlyMap<number, number>, wakubanOf: ReadonlyMap<number, number>): number | null {
  const keys = parseComboOddsKey(comboKey);
  if (keys === null) return null;
  const umabans = betType === "bracketQuinella" ? [...wakubanOf].filter(([, w]) => keys.includes(w)).map(([u]) => u) : [...keys];
  if (umabans.length === 0) return null;
  const rs = umabans.map((u) => ranks.get(u));
  return rs.some((r) => r === undefined) ? null : Math.max(...(rs as number[]));
}

/** レース数がほぼ半々になる日付の境目。前半に入る日付の集合を返す(同じ日は同じ側。差が同じなら前半が少ないほう)。 */
export function frontHalfDates(dates: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(d, (counts.get(d) ?? 0) + 1);
  const days = [...counts.keys()].sort();
  if (days.length < 2) throw new Error("日付が 2 日以上ないと前半・後半に分けられません");
  const half = dates.length / 2;
  let acc = 0;
  let best = { diff: Infinity, upTo: 0 };
  for (let i = 0; i < days.length - 1; i++) {
    acc += counts.get(days[i]!)!;
    const diff = Math.abs(acc - half);
    if (diff < best.diff) best = { diff, upTo: i };
  }
  return new Set(days.slice(0, best.upTo + 1));
}
