/**
 * 調教師の成績の縮小の基準(`packages/core/src/scorer/trainer-stats.ts` の `TRAINER_PLACE_RATE_BASE`)を再現する、純ロジック(Issue #354)。
 * 取得済みの調教師の年度別成績(`parseJockeyResults` の出力)を調教師ごとに並べ、指定した年の窓で 3着内と出走を全員分合算する。
 * 入出力(ファイルの読み込み)は `scripts/trainer-base-rate.ts`。
 */

import type { JockeyYearRecord } from "../packages/core/src/scraper/parse-jockey-results.js";

export interface TrainerBaseRate {
  /** 窓の出走の合計。 */
  readonly starts: number;
  /** 窓の 3着内の合計。 */
  readonly placed: number;
  /** 合算の 3着内率 = placed ÷ starts。出走が 0 なら NaN。 */
  readonly rate: number;
  /** 窓の行を 1 つ以上持つ調教師の数。 */
  readonly trainers: number;
}

/**
 * @param trainers 調教師ごとの年度別成績。
 * @param years 合算する年(例 [2024, 2025])。
 */
export function trainerBaseRate(trainers: readonly (readonly JockeyYearRecord[])[], years: readonly number[]): TrainerBaseRate {
  let starts = 0;
  let placed = 0;
  let count = 0;
  for (const records of trainers) {
    let any = false;
    for (const r of records) {
      if (years.includes(r.year)) {
        starts += r.starts;
        placed += r.placed;
        any = true;
      }
    }
    if (any) {
      count += 1;
    }
  }
  return { starts, placed, rate: placed / starts, trainers: count };
}
