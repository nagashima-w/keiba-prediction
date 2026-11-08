/**
 * 補正後の 3着内率を市場(単勝オッズ)の 3着内率に寄せる(Issue #656)。配分と EV の計算に渡す確率だけに使い、画面に出す確率・LLM の入力は変えない。
 *
 * ## 式
 *  - 市場の 3着内率 m: 馬ごとに q = (1/単勝オッズ) をレース内で合計 1 に割り戻し、切片 + logit(q) + log(頭数) のロジスティックで写す。
 *    係数 {@link MARKET_SHRINK_COEF} は #642(`cloud/src/market-edge-calc.ts` の `fitMarketBase`。2024-11〜2026-11 の中央 7,717 レースへの当てはめ)と
 *    #649 の分析で使ったものの固定値。**cloud の当てはめ結果が毎晩動いても、ここは動かさない**(配分の挙動が日ごとに変わらないようにする)。
 *    ユーザーの決定(2026-11-08): 固定のまま。#642 が毎晩当て直す `market_edge_meta` の値は読まない。試算(545 レース)と同じ係数で動かし、あとで回収率を比べる条件を揃えるため。
 *    #642 の当てはめの値がこの係数から大きくずれたら、ここを当て直す(自動では追従しない)。
 *    cloud 側との定数の一本化は未着手(Issue #656 の【記録】)。
 *  - 混ぜる: logit(p') = w·logit(p) + (1−w)·logit(m)。w = 1 は寄せない、0 は市場のみ。
 *  - 合計を合わせる: レース内の p' の合計が min(3, 頭数) になるよう、全馬に共通のロジットのずらしを二分法で求めて足す(本番の prior の正規化と同じ考え方)。
 *
 * ## 寄せない場合(入力をそのまま返す)
 *  - w = 1。
 *  - 単勝オッズのある馬が {@link MARKET_SHRINK_MIN_ODDS_HORSES}(5)頭未満(#642 の当てはめの範囲に合わせる)。
 *  - 頭数が 3 以下(合計 = 頭数は 0〜1 の確率では作れない)。
 * 一部の馬だけ単勝オッズが無いときは、その馬は混ぜず(m = p)、ほかの馬だけ混ぜてから、全馬に共通のずらしで合計を合わせる。
 *
 * 試算(Issue #656 段階 1、`docs/investigations/allocation-shrink-656/report.md`)の `mix.ts` と同じ式。差は最小頭数と 3 頭以下の扱い(試算では全馬にオッズがある 545 行で効かない)。
 */

/** 市場の 3着内率の写し方の係数 [切片, logit(q) の係数, log(頭数) の係数]。 */
export const MARKET_SHRINK_COEF = [2.857, 0.9216, -0.5561] as const;

/** 寄せるのに必要な、単勝オッズのある馬の最小頭数。 */
export const MARKET_SHRINK_MIN_ODDS_HORSES = 5;

export interface ShrinkHorse {
  readonly umaban: number;
  /** 補正後の 3着内率。 */
  readonly p: number;
  /** 単勝オッズ(無い・0 以下は null か 0 以下)。 */
  readonly winOdds: number | null;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(Math.min(z, 35), -35)));
const logit = (p: number): number => {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
};

const hasOdds = (h: ShrinkHorse): boolean => h.winOdds !== null && Number.isFinite(h.winOdds) && h.winOdds > 0;

/** 馬ごとの市場の 3着内率 m(馬番 → m)。単勝オッズの無い馬は含めず、頭数にも数えない。 */
export function marketPlaceProbs(horses: readonly ShrinkHorse[]): Map<number, number> {
  const used = horses.filter(hasOdds);
  const out = new Map<number, number>();
  if (used.length === 0) return out;
  const inv = used.map((h) => 1 / (h.winOdds as number));
  const total = inv.reduce((a, b) => a + b, 0);
  const lf = Math.log(used.length);
  used.forEach((h, i) => out.set(h.umaban, sigmoid(MARKET_SHRINK_COEF[0] + MARKET_SHRINK_COEF[1] * logit(inv[i]! / total) + MARKET_SHRINK_COEF[2] * lf)));
  return out;
}

/** 市場に寄せた 3着内率(馬番 → p')。寄せない場合はファイル先頭の説明。w は 0〜1 の有限値(外は例外)。入力は書き換えない。 */
export function shrinkTowardMarket(horses: readonly ShrinkHorse[], w: number): Map<number, number> {
  if (!Number.isFinite(w) || w < 0 || w > 1) throw new RangeError(`w は 0〜1 の有限値です: ${String(w)}`);
  const unchanged = (): Map<number, number> => new Map(horses.map((h) => [h.umaban, h.p] as const));
  if (w === 1 || horses.length <= 3 || horses.filter(hasOdds).length < MARKET_SHRINK_MIN_ODDS_HORSES) return unchanged();
  const m = marketPlaceProbs(horses);
  const z = horses.map((h) => {
    const mm = m.get(h.umaban);
    return mm === undefined ? logit(h.p) : w * logit(h.p) + (1 - w) * logit(mm);
  });
  const target = Math.min(3, horses.length);
  let lo = -20;
  let hi = 20;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (z.reduce((a, v) => a + sigmoid(v + mid), 0) < target) lo = mid;
    else hi = mid;
  }
  const d = (lo + hi) / 2;
  return new Map(horses.map((h, i) => [h.umaban, sigmoid(z[i]! + d)] as const));
}
