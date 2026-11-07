/**
 * 並走(影の計算。Issue #649)の記録に残す、馬ごとの「市場が買いすぎる条件」の印(Issue #653)。
 * 定義は #653 の探索(`docs/investigations/market-blindspots-653-fable/report.md` と `scripts/market-blindspots-653-fable/features.py` の `horse_features`)に合わせる。
 * 買い目・配分・画面・LLM には使わない(分析の時点のオッズでも、市場の見込みより来ないかを後から確かめるための記録)。
 *
 * 印は 1(当てはまる)・0(当てはまらない)・null(判定できない)。**前走が分からない馬(戦績が空)は 4 つとも null。**
 *  - longRest        休み明け: 前走から 181 日以上(今回の日付 − 前走の日付 > 180 日)
 *  - surfaceChange   芝とダートの替わり: 前走のコース種別が今回と違う(前走のコース種別が無ければ null)
 *  - frontRunner     前走で逃げた馬: 前走の最初のコーナーの通過順 ÷ 前走の頭数 ≤ 0.125(通過順か頭数が無ければ null)
 *  - longshotSlump   人気薄で近走が大敗続き: q < 0.05 かつ直近 3 走の平均着順 ≥ 11.5(q が無い・直近 3 走に数値の着順が 1 つも無ければ null)
 *                    直近 3 走は、前走から数えて 3 走(その中の非数値の着順は平均から除く。`features.py` の `last3 = prior[-3:]` のあとに着順の無い走を除く)
 *
 * 戦績は、今回の日付より前の走だけを使う(日付が無い・今回以降の走は無視する。呼び出し側がすでに絞っていても二重に守る)。
 */

import { daysBetweenDates } from "../scorer/derive-features.js";
import type { HorseRaceResult } from "../scraper/types.js";

export type ShadowFlag = 0 | 1 | null;

export interface ShadowFlags {
  readonly longRest: ShadowFlag;
  readonly surfaceChange: ShadowFlag;
  readonly frontRunner: ShadowFlag;
  readonly longshotSlump: ShadowFlag;
}

/** 前走が分からないときの印。 */
export const NO_FLAGS: ShadowFlags = { longRest: null, surfaceChange: null, frontRunner: null, longshotSlump: null };

/** 休み明けの閾値(日)。今回の日付 − 前走の日付がこれを超える(= 181 日以上)。 */
export const LONG_REST_DAYS = 180;
/** 前走で逃げた馬の閾値(最初のコーナーの通過順 ÷ 頭数)。 */
export const FRONT_RUNNER_MAX_POS = 0.125;
/** 人気薄の閾値(q)と、近走の大敗の閾値(直近 3 走の平均着順)。 */
export const LONGSHOT_MAX_Q = 0.05;
export const SLUMP_MIN_AVG_FINISH = 11.5;

const finishOf = (r: HorseRaceResult): number | null => (r.finishPosition !== null && r.finishPosition.kind === "順位" ? r.finishPosition.value : null);

/**
 * @param results その馬の戦績(順序は問わない)。
 * @param today 今回のレースの日付(YYYY/MM/DD)とコース種別。
 * @param q 市場の確率(1/オッズをレース内で合計 1 にした値)。オッズが取れていなければ null。
 */
export function computeShadowFlags(
  results: readonly HorseRaceResult[],
  today: { readonly date: string; readonly courseType: string | null },
  q: number | null,
): ShadowFlags {
  // 今回の日付より前の走だけを、古い順に並べる(日付の差が正 = 今回より前)。
  const prior = results
    .map((r) => ({ r, days: daysBetweenDates(r.date, today.date) }))
    .filter((x): x is { r: HorseRaceResult; days: number } => x.days !== null && x.days > 0)
    .sort((a, b) => b.days - a.days)
    .map((x) => x.r);
  const last = prior[prior.length - 1];
  if (last === undefined) {
    return NO_FLAGS;
  }
  const days = daysBetweenDates(last.date, today.date)!;
  const longRest: ShadowFlag = days > LONG_REST_DAYS ? 1 : 0;
  const surfaceChange: ShadowFlag = last.courseType === null ? null : last.courseType !== today.courseType ? 1 : 0;
  const first = last.passing[0];
  const frontRunner: ShadowFlag =
    first === undefined || last.entryCount === null || last.entryCount <= 0 ? null : first / last.entryCount <= FRONT_RUNNER_MAX_POS ? 1 : 0;
  const finishes = prior
    .slice(-3)
    .map(finishOf)
    .filter((f): f is number => f !== null);
  const avg = finishes.length === 0 ? null : finishes.reduce((s, v) => s + v, 0) / finishes.length;
  const longshotSlump: ShadowFlag = q === null || avg === null ? null : q < LONGSHOT_MAX_Q && avg >= SLUMP_MIN_AVG_FINISH ? 1 : 0;
  return { longRest, surfaceChange, frontRunner, longshotSlump };
}
