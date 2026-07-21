/**
 * 期間バッチの入力(from/to)を検証する純関数(タスクB2b-1)。
 *
 * 日付フォーマット・実在日の検証は `parseKaisaiDate`、from>to・包含日数(181日まで)の検証は
 * `enumerateDates` にそれぞれ委譲し、この関数では二重実装しない(単一の真実源。
 * enumerate-dates.ts 冒頭コメントの方針と同じ)。
 */

import { enumerateDates } from "./enumerate-dates.js";
import { parseKaisaiDate } from "./ids.js";

/** 検証結果(discriminated union)。エラー時は表示用メッセージを含む。 */
export type PeriodInputValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** エラー値から表示用メッセージを取り出す。 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 期間バッチの from/to 入力を検証する。
 * @param from 開始日文字列(YYYYMMDD想定。未検証の生入力)
 * @param to 終了日文字列(YYYYMMDD想定。未検証の生入力)
 * @returns 検証結果(ok:true、またはok:false+エラーメッセージ)
 */
export function validatePeriodInput(
  from: string,
  to: string,
): PeriodInputValidationResult {
  try {
    const parsedFrom = parseKaisaiDate(from);
    const parsedTo = parseKaisaiDate(to);
    // from>to・包含182日以上のチェックは enumerateDates に委譲する(二重実装しない)。
    enumerateDates(parsedFrom, parsedTo);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}
