/**
 * 期間内の開催日(KaisaiDate)を列挙する純関数(タスクB2a)。
 *
 * 閏年判定・実在日検証は `ids.ts` の `parseKaisaiDate` に委譲し、本関数では二重実装しない
 * (このファイルは「日付を1日ずつ進めて列挙する」責務のみを持つ)。
 */

import { InvalidIdError, type KaisaiDate, parseKaisaiDate } from "./ids.js";

/**
 * 期間バッチの一度の実行で許容する最大日数(包含・両端を含む)。
 * 181日ちょうどはOK、182日はエラーとする(boss着手前ゲート合意)。
 */
const MAX_INCLUSIVE_DAYS = 181;

/** KaisaiDate(YYYYMMDD)をUTC日付として Date に変換する。 */
function toUtcDate(date: KaisaiDate): Date {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  // UTC固定でタイムゾーン依存の日付ずれを避ける(ローカルTZの影響を受けない)。
  return new Date(Date.UTC(year, month - 1, day));
}

/** Date を KaisaiDate(YYYYMMDD)に変換する。 */
function toKaisaiDate(d: Date): KaisaiDate {
  const year = String(d.getUTCFullYear()).padStart(4, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return parseKaisaiDate(`${year}${month}${day}`);
}

/**
 * from から to まで(両端を含む)の開催日を1日刻みで列挙する。
 *
 * @param from 期間の開始日(検証済みKaisaiDate)
 * @param to 期間の終了日(検証済みKaisaiDate)
 * @returns 列挙した開催日の配列(from→toの昇順)
 * @throws InvalidIdError from > to、または包含日数が181日を超える場合
 */
export function enumerateDates(
  from: KaisaiDate,
  to: KaisaiDate,
): KaisaiDate[] {
  const fromDate = toUtcDate(from);
  const toDate = toUtcDate(to);

  if (fromDate.getTime() > toDate.getTime()) {
    throw new InvalidIdError(
      `開始日は終了日より前(または同日)である必要があります(from: "${from}", to: "${to}")`,
    );
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  // 包含日数 = 差分日数 + 1(両端を含むため)。
  const inclusiveDays =
    Math.round((toDate.getTime() - fromDate.getTime()) / MS_PER_DAY) + 1;

  if (inclusiveDays > MAX_INCLUSIVE_DAYS) {
    throw new InvalidIdError(
      `期間は包含${MAX_INCLUSIVE_DAYS}日までです(from: "${from}", to: "${to}", 包含日数: ${inclusiveDays})`,
    );
  }

  const result: KaisaiDate[] = [];
  const cursor = new Date(fromDate.getTime());
  for (let i = 0; i < inclusiveDays; i += 1) {
    result.push(toKaisaiDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}
