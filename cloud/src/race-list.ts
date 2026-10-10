/**
 * `GET /api/races` の応答の整形(Issue #183〈#165-a〉)。純関数だけで、DO・gate には触れない。
 *
 * core の `RaceListEntry` をそのまま返さず、画面が使う固定の形(snake_case。`/api/analyses/run` の入力・`/status` の `race_id` と揃える)にする:
 * `core` の型にフィールドが増えても、画面に漏れない。`undefined` は `null` にする(JSON で消えて、キーの有無が揺れないように)。
 * 並びは **`race_id` の昇順**を明示的に作る(netkeiba の HTML の並びに依存しない)。12 桁のレースIDは、場コード(5〜6桁目)→ … → 末尾2桁のレース番号の順なので、
 * 中央・地方とも「場 → R」の順になる(地方の7〜10桁目は同じ開催日の月日)。
 * 中央のグレードは、core の一覧が画像アイコン方式で取れないため、常に `null`(地方は `Jpn1`・`重賞` などの生テキスト)。
 */
import type { RaceListEntry } from "../../packages/core/src/scraper/types";

export interface RaceListRow {
  readonly race_id: string;
  /** 会場名。一覧の構造から取れなかったときは null(レースIDから補わない)。 */
  readonly venue_name: string | null;
  readonly race_number: number;
  readonly race_name: string;
  readonly course_type: string;
  readonly distance: number;
  readonly entry_count: number;
  readonly grade: string | null;
  /** 発走予定時刻(JST の `HH:MM`。Issue #236)。取れなかった行(発走後に取得した中央の一覧など)は null。 */
  readonly start_time: string | null;
}

export function toRaceListRows(entries: readonly RaceListEntry[]): RaceListRow[] {
  return entries
    .map(
      (e): RaceListRow => ({
        race_id: e.raceId,
        venue_name: e.venue ?? null,
        race_number: e.raceNumber,
        race_name: e.name,
        course_type: e.courseType,
        distance: e.distance,
        entry_count: e.entryCount,
        grade: e.grade ?? null,
        start_time: e.startTime ?? null,
      }),
    )
    .sort((a, b) => (a.race_id < b.race_id ? -1 : a.race_id > b.race_id ? 1 : 0));
}
