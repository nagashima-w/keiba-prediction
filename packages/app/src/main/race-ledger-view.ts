/**
 * 検証画面: レース単位の統合リスト(core RaceLedgerEntry)を表示用(RaceLedgerView)へ変換する
 * 純関数(検証画面UI統合)。
 *
 * 会場名(場コード由来)は raceId から導出する。既存の会場名解決ロジック(venue-codes.ts の
 * venueNameFromRaceId。analysis-pipeline.ts が会場名の一次情報として使っているのと同じ関数)を
 * そのまま再利用し、中央/地方で別ロジックを持たない。
 * レース番号は「YYYY+場コード2桁+□□2桁+□□2桁+レース番号2桁」というレースID体系
 * (packages/core/src/scraper/ids.ts)に基づき、末尾2桁を単純に数値化するだけの一次変換であり、
 * batch-summary.ts の raceNumberFromRaceId(renderer)と同じ式を main 層でも用いる。
 *
 * 開催日(kaisaiDate)・プロンプト版番号・馬ごとの予実(horses)・レース単位の賭け金/払戻/回収は
 * core RaceLedgerEntry の値をそのまま引き継ぐ(この層では加工しない。表示整形はrenderer側の
 * verify-format.ts に委ねる)。
 *
 * 並び順: 開催日降順(null は最後)→レースID昇順の決定的な順序。
 *
 * 開催日不明の補完(ユーザーフィードバック対応。旧データはkaisaiDateがnullですべて
 * 「日付不明」になっていた):
 * kaisaiDateがnullかつ地方(NAR)レースの場合、raceIdの YYYY+MMDD から開催日を導出して補う
 * (core kaisaiDateFromNarRaceId を再利用。地方は開催日がraceIdに直接埋め込まれているため復元可能。
 * 中央は回次・日次のみで日付を復元できないため、中央かつnullは従来どおり「日付不明」のまま)。
 * kaisaiDateが記録済み(非null)の場合は補完せず記録値を優先する。DBは書き換えず表示時のみの
 * 導出とすることで、冪等・可逆(いつでも表示ロジックを変更・撤回できる)にしている。
 *
 * (旧 buildRaceBreakdownView は検証画面UI統合により廃止し、この buildRaceLedgerView に統合した。
 * 会場名・レース番号の導出、開催日不明の補完、並び順の各ロジックは旧関数と完全に同じ規則で、
 * 廃止時にそのままこのファイルの private ヘルパーとして残している。)
 */

import { kaisaiDateFromNarRaceId, type RaceLedgerEntry } from "@keiba/core";

import type { RaceLedgerView } from "../shared/analysis-types.js";
import { venueNameFromRaceId } from "./venue-codes.js";

/**
 * kaisaiDateがnullかつ地方(NAR)レースの場合、raceIdから開催日を補完する。
 * 記録済み(非null)ならそのまま優先し、中央または導出不可(暦不正等)ならnull(日付不明)のまま返す。
 */
function resolveKaisaiDate(
  raceId: string,
  kaisaiDate: string | null,
): string | null {
  if (kaisaiDate !== null) {
    return kaisaiDate;
  }
  return kaisaiDateFromNarRaceId(raceId);
}

/**
 * レースID末尾2桁からレース番号(1〜12)を取り出す。
 * core の parseRaceId のような形式検証は行わない(呼び出し元は検証済みの raceId を渡す前提)。
 */
function raceNumberFromRaceId(raceId: string): number {
  return Number(raceId.slice(10, 12));
}

/**
 * 開催日降順(null は最後)→レースID昇順で比較する(Array.prototype.sort 用)。
 * raceId・kaisaiDate を持つ型であれば何でも比較できるよう総称化してある。
 */
function compareByKaisaiDateDescThenRaceIdAsc<
  T extends { readonly raceId: string; readonly kaisaiDate: string | null },
>(a: T, b: T): number {
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
 * core RaceLedgerEntry の一覧を検証画面表示用(RaceLedgerView)へ変換し、
 * 開催日降順(null は最後)→レースID昇順に並べ替える。
 * @param entries core computeRaceLedger の結果(latest統合済み。結果取込の有無を問わない)
 */
export function buildRaceLedgerView(
  entries: readonly RaceLedgerEntry[],
): RaceLedgerView[] {
  return entries
    .map(
      (e): RaceLedgerView => ({
        raceId: e.raceId,
        venueName: venueNameFromRaceId(e.raceId),
        raceNumber: raceNumberFromRaceId(e.raceId),
        kaisaiDate: resolveKaisaiDate(e.raceId, e.kaisaiDate),
        analysisId: e.analysisId,
        analyzedAt: e.analyzedAt,
        promptVersion: e.promptVersion,
        hasResult: e.hasResult,
        hasPayout: e.hasPayout,
        horses: e.horses,
        totalStake: e.totalStake,
        totalReturn: e.totalReturn,
        recoveryRate: e.recoveryRate,
        betCount: e.betCount,
      }),
    )
    .sort(compareByKaisaiDateDescThenRaceIdAsc);
}
