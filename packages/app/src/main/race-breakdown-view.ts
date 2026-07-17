/**
 * 検証画面: レース単体の予実ブレークダウン(core RaceBreakdown)を表示用(RaceBreakdownView)へ
 * 変換する純関数(Task#34)。
 *
 * 会場名(場コード由来)は raceId から導出する。既存の会場名解決ロジック(venue-codes.ts の
 * venueNameFromRaceId。analysis-pipeline.ts が会場名の一次情報として使っているのと同じ関数)を
 * そのまま再利用し、中央/地方で別ロジックを持たない。
 * レース番号は「YYYY+場コード2桁+□□2桁+□□2桁+レース番号2桁」というレースID体系
 * (packages/core/src/scraper/ids.ts)に基づき、末尾2桁を単純に数値化するだけの一次変換であり、
 * batch-summary.ts の raceNumberFromRaceId(renderer)と同じ式を main 層でも用いる。
 *
 * 開催日(kaisaiDate)・プロンプト版番号・馬ごとの予実(horses)・レース単位の賭け金/払戻/回収は
 * core RaceBreakdown の値をそのまま引き継ぐ(この層では加工しない。表示整形はrenderer側の
 * verify-format.ts に委ねる)。
 *
 * 並び順(docs/handover-next-session.md の「#34 レース単位の予実ブレークダウン」節):
 * 開催日降順(null は最後)→レースID昇順の決定的な順序。
 */

import type { RaceBreakdown } from "@keiba/core";

import type { RaceBreakdownView } from "../shared/analysis-types.js";
import { venueNameFromRaceId } from "./venue-codes.js";

/**
 * レースID末尾2桁からレース番号(1〜12)を取り出す。
 * core の parseRaceId のような形式検証は行わない(呼び出し元は検証済みの raceId を渡す前提)。
 */
function raceNumberFromRaceId(raceId: string): number {
  return Number(raceId.slice(10, 12));
}

/**
 * 開催日降順(null は最後)→レースID昇順で比較する(Array.prototype.sort 用)。
 */
function compareByKaisaiDateDescThenRaceIdAsc(
  a: RaceBreakdownView,
  b: RaceBreakdownView,
): number {
  if (a.kaisaiDate !== b.kaisaiDate) {
    if (a.kaisaiDate === null) {
      return 1;
    }
    if (b.kaisaiDate === null) {
      return -1;
    }
    return a.kaisaiDate < b.kaisaiDate ? 1 : -1;
  }
  return a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : 0;
}

/**
 * core RaceBreakdown の一覧を検証画面表示用(RaceBreakdownView)へ変換し、
 * 開催日降順(null は最後)→レースID昇順に並べ替える。
 * @param breakdowns core computeRaceBreakdown の結果(verifyと同じ母集団に絞り込み済み)
 */
export function buildRaceBreakdownView(
  breakdowns: readonly RaceBreakdown[],
): RaceBreakdownView[] {
  return breakdowns
    .map(
      (b): RaceBreakdownView => ({
        raceId: b.raceId,
        venueName: venueNameFromRaceId(b.raceId),
        raceNumber: raceNumberFromRaceId(b.raceId),
        kaisaiDate: b.kaisaiDate,
        analysisId: b.analysisId,
        analyzedAt: b.analyzedAt,
        promptVersion: b.promptVersion,
        horses: b.horses,
        totalStake: b.totalStake,
        totalReturn: b.totalReturn,
        recoveryRate: b.recoveryRate,
        betCount: b.betCount,
      }),
    )
    .sort(compareByKaisaiDateDescThenRaceIdAsc);
}
