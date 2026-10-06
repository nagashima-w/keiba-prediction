/**
 * レースIDと開催日(YYYYMMDD)の整合の検査(Issue #180〈#164-e〉・#177 の申し送り)。手動起動の入口(`handler.ts`)と日単位の DO(`RaceDayCore.schedule`)の両方が使う
 * (入口の検証をすり抜けた RPC でも、整合しない予約で netkeiba に撃たないため)。
 *
 *  - **年**: どのレースIDでも、1〜4桁目が開催日の年と一致すること。
 *  - **月日**: 地方(場コード30〜64)のレースIDは7〜10桁目に開催日の月日が入っているので、開催日の月日とも一致すること。
 *    中央(場コード01〜10)の7〜10桁目は回次・日次であって日付ではないので、月日は見ない(中央のレースIDから開催日は導出できない)。
 * 例外を投げない(理由つきで返す)。
 */
import { InvalidIdError, kaisaiDateFromNarRaceId, parseKaisaiDate, parseRaceId } from "../../packages/core/src/scraper/ids";

export type RaceDateCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export function checkRaceDate(raceIdInput: string, kaisaiDateInput: string): RaceDateCheck {
  let raceId: string;
  let kaisaiDate: string;
  try {
    raceId = parseRaceId(raceIdInput);
    kaisaiDate = parseKaisaiDate(kaisaiDateInput);
  } catch (error) {
    return { ok: false, message: error instanceof InvalidIdError ? error.message : "レースIDまたは開催日を検証できませんでした" };
  }
  if (raceId.slice(0, 4) !== kaisaiDate.slice(0, 4)) {
    return { ok: false, message: `レースID(${raceId})の年と開催日(${kaisaiDate})の年が一致しません` };
  }
  const narDate = kaisaiDateFromNarRaceId(raceId);
  if (narDate !== null && narDate !== kaisaiDate) {
    return { ok: false, message: `地方のレースID(${raceId})の月日は開催日 ${narDate} を指していますが、開催日が ${kaisaiDate} です(月日が一致しません)` };
  }
  return { ok: true };
}

/** 開催日(YYYYMMDD)の形と実在だけを検査する(レースIDとの整合は見ない)。例外を投げない。 */
export function checkKaisaiDate(kaisaiDateInput: string): RaceDateCheck {
  try {
    parseKaisaiDate(kaisaiDateInput);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof InvalidIdError ? error.message : "開催日を検証できませんでした" };
  }
}
