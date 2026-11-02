/**
 * レース画面・結果画面の「前後のレース」とパンくず(Issue #571。純関数)。
 *
 * 前後のレース: 同じ日・同じ競馬場のレースは、race_id の**先頭 10 桁が同じ**(中央 `YYYY+場+回次+日次+R`、地方 `YYYY+場+月日+R`)。R の数は競馬場ごとにまちまち(地方は 10〜12)なので、
 * R の算術ではなく、先頭 10 桁で絞った一覧の race_id の昇順の隣を採る。`venueName` は null がありうるので同一判定に使わない。
 * 一覧(`GET /api/races` のキャッシュ)が無い・取得に失敗したときは前後を出さない(パンくずは出す)。
 */
import type { RaceRow } from "./api";
import { shortDateLabel } from "./date";
import { buildHash, type Venue } from "./route";

/** 同じ日・同じ競馬場を表す race_id の先頭の桁数。 */
const GROUP_LENGTH = 10;

/** race_id が 12 桁の数字か。 */
const isRaceId = (raceId: string): boolean => /^[0-9]{12}$/.test(raceId);

/** 同じ日・同じ競馬場の中で、`raceId` の前と次の行。`raceId` が rows に無い(別の日・取得前)ときは両方 null。返すのは rows の要素そのもの。 */
export function neighborRaces<T extends { readonly raceId: string }>(rows: readonly T[], raceId: string): { readonly prev: T | null; readonly next: T | null } {
  const group = raceId.slice(0, GROUP_LENGTH);
  const sorted = rows.filter((r) => r.raceId.slice(0, GROUP_LENGTH) === group).sort((a, b) => (a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : 0));
  const at = sorted.findIndex((r) => r.raceId === raceId);
  return at < 0 ? { prev: null, next: null } : { prev: sorted[at - 1] ?? null, next: sorted[at + 1] ?? null };
}

/** パンくずの 1 節。`href` があればリンク、`current` は現在地(リンクなし。`aria-current="page"`)。 */
export interface Crumb {
  readonly label: string;
  readonly href: string | null;
  readonly current: boolean;
}

/**
 * 「一覧 › 11/3(火) › 東京 › 11R」。一覧は `#`、日付はその日(その区分)の一覧、競馬場はリンクなし(名前が無ければ省く)、R は現在地(race_id の末尾 2 桁。12 桁でなければ省く)。
 * 競馬場名は外から来た文字列(テキストノードで描く)。
 */
export function breadcrumbOf(input: { readonly date: string; readonly venue: Venue; readonly venueName: string | null; readonly raceId: string }): readonly Crumb[] {
  return [
    { label: "一覧", href: "#", current: false },
    { label: shortDateLabel(input.date), href: buildHash({ date: input.date, venue: input.venue }), current: false },
    ...(input.venueName === null ? [] : [{ label: input.venueName, href: null, current: false }]),
    ...(isRaceId(input.raceId) ? [{ label: `${Number(input.raceId.slice(GROUP_LENGTH))}R`, href: null, current: true }] : []),
  ];
}

export interface NeighborLink {
  readonly label: string;
  readonly href: string;
}

export interface RaceNeighbors {
  readonly prev: NeighborLink | null;
  readonly next: NeighborLink | null;
}

/** 前後のレースへのリンク(行き先はレース画面)。一覧が無い・両側とも無いときは null(nav ごと出さない)。 */
export function neighborsOf(rows: readonly RaceRow[] | undefined, date: string, venue: Venue, raceId: string): RaceNeighbors | null {
  if (rows === undefined) return null;
  const { prev, next } = neighborRaces(rows, raceId);
  if (prev === null && next === null) return null;
  const link = (word: string, r: RaceRow | null): NeighborLink | null => (r === null ? null : { label: `${word}のレース ${r.raceNumber}R`, href: buildHash({ date, venue, race: r.raceId }) });
  return { prev: link("前", prev), next: link("次", next) };
}
