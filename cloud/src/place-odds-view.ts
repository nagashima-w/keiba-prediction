/**
 * 想定複勝オッズの計算の入口(Issue #253)。`GET /api/analyses/{id}`(`analysis-view.ts`)と Discord の通知(`notify-embeds.ts`)が共有する。
 *
 * 出走頭数から想定の基準を決める。**判定は配分の複勝の対象判定(`resolvePlaceBetTarget`)をそのまま使う**(頭数のしきい値を2か所に持たない):
 *  - 8頭以上(複勝は3着まで): `"top3"`。想定 = 0.8 ÷ 補正後の3着内率
 *  - 5〜7頭(複勝は2着まで): `"top2"`。想定 = 0.8 ÷ 2着内率(Plackett-Luce の上位3着の分布から)
 *  - 4頭以下(複勝が発売されない)・頭数が判定できない: `null`。想定は出さない
 * 出走頭数は、分析した馬の数(取消・除外は `scrapeRace` が出走馬から除いているので数えない)。
 *
 * **サーバ側(Worker)だけが import する。** クライアントの束に Plackett-Luce を入れない(`test/client-bundle.test.ts` が固定する)。
 */
import { resolvePlaceBetTarget } from "../../packages/app/src/shared/race-allocation";
import { estimateFairPlaceOdds, type PlaceOddsBasis } from "../../packages/core/src/ev/place-odds-estimate";

/** 出走頭数 → 想定複勝オッズの基準。 */
export function placeOddsBasisOf(runnerCount: number): PlaceOddsBasis | null {
  const target = resolvePlaceBetTarget(runnerCount);
  if (target.available) {
    return "top3";
  }
  return target.reason === "two-place-only" ? "top2" : null;
}

export interface RacePlaceOdds {
  /** 想定の基準(出さないレースは null)。 */
  readonly basis: PlaceOddsBasis | null;
  /** 馬番 → 想定複勝オッズ(判定不能・的中率 0 は null)。**全馬のキーを持つ**。 */
  readonly byUmaban: ReadonlyMap<number, number | null>;
}

/** 出走全頭の補正後の3着内率から、馬ごとの想定複勝オッズを求める。**throw しない**(判定不能・θ推定の失敗は null)。 */
export function estimatePlaceOddsForRace(horses: readonly { readonly umaban: number; readonly adjustedProb: number }[]): RacePlaceOdds {
  const basis = placeOddsBasisOf(horses.length);
  if (basis === null) {
    return { basis, byUmaban: new Map(horses.map((h) => [h.umaban, null])) };
  }
  const estimates = estimateFairPlaceOdds(
    horses.map((h) => ({ umaban: h.umaban, placeProb: h.adjustedProb })),
    basis,
  );
  return { basis, byUmaban: new Map(estimates.map((e) => [e.umaban, e.fairPlaceOdds])) };
}
