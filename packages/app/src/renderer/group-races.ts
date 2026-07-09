/**
 * レース一覧を会場ごとにグループ化する純関数(表示用)。
 *
 * 仕様「レース選択画面: 開催・レース一覧を会場ごとにグループ化」。
 * 会場の並びは一覧の初出順を保ち、各会場内はレース番号昇順に整列する。
 * 会場名が取得できない(null)レースは「不明」グループにまとめる。
 */

import type { RaceListItem } from "../shared/analysis-types.js";

/** 会場ごとのレースグループ。 */
export interface RaceGroup {
  /** 会場名(取得不能時は「不明」)。 */
  readonly venue: string;
  /** その会場のレース(レース番号昇順)。 */
  readonly races: RaceListItem[];
}

/** レース一覧を会場ごとにまとめる。 */
export function groupRacesByVenue(races: readonly RaceListItem[]): RaceGroup[] {
  const order: string[] = [];
  const byVenue = new Map<string, RaceListItem[]>();

  for (const race of races) {
    const venue = race.venue ?? "不明";
    let bucket = byVenue.get(venue);
    if (bucket === undefined) {
      bucket = [];
      byVenue.set(venue, bucket);
      order.push(venue);
    }
    bucket.push(race);
  }

  return order.map((venue) => ({
    venue,
    races: [...byVenue.get(venue)!].sort((a, b) => a.raceNumber - b.raceNumber),
  }));
}
