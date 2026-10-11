/**
 * #41 の選定ルール(`docs/investigations/probability-quality-41/measurement-plan.md` §2)の実装。
 * 純関数と、一覧の取得関数を注入する解決関数だけを持つ(ネットワーク・ファイル I/O なし)。
 *
 * レース単位ではなく**開催日単位**で全レースを取り、事後の取捨選択(cherry-pick)を構造的に
 * 不可能にする。ここに書かれた規則は取得前に文書へ固定してコミットしたもの。
 */

import type { RaceListEntry } from "../../packages/core/src/index.js";

/** 地方で、最小の場コードの会場から足して揃える最小レース数。 */
export const NAR_MIN_RACES = 10;
/** 中央で、開催が無いとき1週ずつ遡る最大回数。 */
export const CENTRAL_MAX_WEEKS_BACK = 4;
/** 地方で、開催が無いとき1日ずつ遡る最大日数。 */
export const NAR_MAX_DAYS_BACK = 7;

/** 開催が見つからなかったことを表す例外(取得を止めて報告する)。 */
export class NoRacesFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoRacesFoundError";
  }
}

/** race_id の5〜6桁目(場コード)。 */
export function venueCodeOf(raceId: string): string {
  return raceId.slice(4, 6);
}

/** YYYYMMDD に日数を加減する(UTC の暦日で計算。曜日・月・年またぎに依存しない)。 */
export function shiftDate(yyyymmdd: string, days: number): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const yy = String(t.getUTCFullYear()).padStart(4, "0");
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** 場コードごとにまとめ、場コードの昇順に並べる(各会場内はレース番号順)。 */
function groupByVenueAscending(entries: readonly RaceListEntry[]): RaceListEntry[][] {
  const map = new Map<string, RaceListEntry[]>();
  for (const e of entries) {
    const code = venueCodeOf(e.raceId);
    const list = map.get(code);
    if (list === undefined) {
      map.set(code, [e]);
    } else {
      list.push(e);
    }
  }
  return Array.from(map.keys())
    .sort()
    .map((code) => map.get(code)!.slice().sort((a, b) => a.raceNumber - b.raceNumber));
}

/** 中央: その日の一覧で**場コードが最小の会場の全レース**(レース番号順)。一覧が空なら空配列。 */
export function selectCentralVenueRaces(entries: readonly RaceListEntry[]): RaceListEntry[] {
  return groupByVenueAscending(entries)[0] ?? [];
}

/**
 * 地方: **場コードが最小の会場の全レース**。`minRaces` 未満なら、次に小さい場コードの会場の
 * 全レースを加え、合計が `minRaces` 以上になるまで続ける。全会場を足しても届かなければ
 * あるだけ返す(足りない分は埋めない)。
 */
export function selectNarRaces(
  entries: readonly RaceListEntry[],
  minRaces: number = NAR_MIN_RACES,
): RaceListEntry[] {
  const selected: RaceListEntry[] = [];
  for (const venueRaces of groupByVenueAscending(entries)) {
    if (selected.length >= minRaces) {
      break;
    }
    selected.push(...venueRaces);
  }
  return selected;
}

/** 開催日の解決結果。 */
export interface ResolvedDay {
  /** 要求した開催日(YYYYMMDD)。 */
  readonly requestedDate: string;
  /** 実際に使った開催日(遡った場合は要求日と異なる)。 */
  readonly usedDate: string;
  /** 一覧を取得して調べた開催日(要求日から順に)。 */
  readonly attemptedDates: readonly string[];
  /** 選定されたレース。 */
  readonly races: readonly RaceListEntry[];
}

/** 中央: 開催が無ければ**1週前の同じ曜日**へ遡る(最大4週)。 */
export async function resolveCentralDay(
  requestedDate: string,
  fetchList: (date: string) => Promise<readonly RaceListEntry[]>,
): Promise<ResolvedDay> {
  const attemptedDates: string[] = [];
  for (let week = 0; week <= CENTRAL_MAX_WEEKS_BACK; week++) {
    const date = shiftDate(requestedDate, -7 * week);
    attemptedDates.push(date);
    const races = selectCentralVenueRaces(await fetchList(date));
    if (races.length > 0) {
      return { requestedDate, usedDate: date, attemptedDates, races };
    }
  }
  throw new NoRacesFoundError(
    `中央の開催が見つかりません(要求日 ${requestedDate}。調べた日: ${attemptedDates.join(", ")})`,
  );
}

/** 地方: 開催が無ければ**前日**へ遡る(最大7日)。 */
export async function resolveNarDay(
  requestedDate: string,
  fetchList: (date: string) => Promise<readonly RaceListEntry[]>,
): Promise<ResolvedDay> {
  const attemptedDates: string[] = [];
  for (let back = 0; back <= NAR_MAX_DAYS_BACK; back++) {
    const date = shiftDate(requestedDate, -back);
    attemptedDates.push(date);
    const races = selectNarRaces(await fetchList(date));
    if (races.length > 0) {
      return { requestedDate, usedDate: date, attemptedDates, races };
    }
  }
  throw new NoRacesFoundError(
    `地方の開催が見つかりません(要求日 ${requestedDate}。調べた日: ${attemptedDates.join(", ")})`,
  );
}
