/**
 * 期間バッチのUI入力検証ゲート(純関数、タスクC2)。
 *
 * core の validatePeriodInput(from>to・包含181日超・不正フォーマットの検証)をそのまま再利用し、
 * 二重実装しない(単一の真実源。enumerate-dates.ts / validate-period-input.ts 冒頭コメントの方針と同じ)。
 * この関数は「collectPeriodBatch(phase1)を呼んでよいか」の1点だけを表す薄いラッパーで、
 * App側はこれを収集ボタンのdisabled条件・ハンドラの早期returnの両方に使う。
 */

import { validatePeriodInput } from "@keiba/core";

/**
 * from/to入力が期間バッチの収集(collectPeriodBatch)を呼び出せる状態か判定する。
 * @param from 開始日文字列(YYYYMMDD想定。未検証の生入力)
 * @param to 終了日文字列(YYYYMMDD想定。未検証の生入力)
 * @returns 呼び出し可能なら true
 */
export function canCollectPeriodBatch(from: string, to: string): boolean {
  return validatePeriodInput(from, to).ok;
}
