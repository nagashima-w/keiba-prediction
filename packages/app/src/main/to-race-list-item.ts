/**
 * core の RaceListEntry を、IPC でそのまま送れる RaceListItem(shared 型)へ変換する純関数。
 *
 * 変換の要点:
 * - raceId はブランド型だが実行時は文字列。RaceListItem では素の string にする。
 * - venue は core では optional(undefined あり)。IPC 越しに undefined を送るとキーごと
 *   欠落してしまうため、null に正規化して「取得できなかった」ことを明示的に伝える。
 */

import type { RaceListEntry } from "@keiba/core";

import type { RaceListItem } from "../shared/analysis-types.js";

/** RaceListEntry を RaceListItem に変換する。 */
export function toRaceListItem(entry: RaceListEntry): RaceListItem {
  return {
    raceId: entry.raceId,
    name: entry.name,
    courseType: entry.courseType,
    distance: entry.distance,
    entryCount: entry.entryCount,
    venue: entry.venue ?? null,
    raceNumber: entry.raceNumber,
  };
}
