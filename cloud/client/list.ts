/**
 * 一覧の画面の表示用データ(Issue #184。純関数)。場ごとのまとまり・R の並び・板の (race_id, mode) ごとのバッジ・各状態の表示。
 * `view.ts` がこれを VNode にする。
 */
import type { BoardRow, RaceRow, TaskMode } from "./api";
import { ymdToInput } from "./date";
import { buildHash, type Route, type Venue } from "./route";

export interface Badge {
  readonly label: string;
  readonly tone: "none" | "wait" | "ok" | "fail";
}

/** 板の行 → バッジ。行が無ければ「未実行」。 */
export function badgeOf(row: BoardRow | undefined): Badge {
  if (row === undefined) return { label: "未実行", tone: "none" };
  switch (row.status) {
    case "queued":
      return { label: "待ち", tone: "wait" };
    case "fetched":
      return { label: "取得済み", tone: "wait" };
    case "done":
      return { label: "完了", tone: "ok" };
    case "failed":
      return { label: "失敗", tone: "fail" };
  }
}

/** 板から (race_id, mode) の行を探す(race_id だけで引くと、同じレースの 2 つのモードを取り違える)。 */
export function pick(board: readonly BoardRow[], raceId: string, mode: TaskMode): BoardRow | undefined {
  return board.find((r) => r.raceId === raceId && r.mode === mode);
}

export interface RaceGroup {
  readonly name: string;
  readonly races: readonly RaceRow[];
}

const UNKNOWN_VENUE = "会場不明";

/** race_id の昇順(場 → R)に並べ、同じ会場名が続く行を 1 組にまとめる(名前だけで離れた行を合流させない)。 */
export function groupRaces(rows: readonly RaceRow[]): RaceGroup[] {
  const sorted = [...rows].sort((a, b) => (a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : 0));
  const groups: { name: string; races: RaceRow[] }[] = [];
  for (const row of sorted) {
    const name = row.venueName ?? UNKNOWN_VENUE;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.name === name) {
      last.races.push(row);
    } else {
      groups.push({ name, races: [row] });
    }
  }
  return groups;
}

export type ListSource = { readonly kind: "loading" } | { readonly kind: "error"; readonly message: string } | { readonly kind: "ready"; readonly races: readonly RaceRow[] };
export type BoardSource = { readonly kind: "none" } | { readonly kind: "error"; readonly message: string } | { readonly kind: "ready"; readonly rows: readonly BoardRow[] };

export interface ListModelInput {
  readonly route: Route;
  readonly list: ListSource;
  readonly board: BoardSource;
}

export interface RaceItem {
  readonly raceId: string;
  /** 「11R」。 */
  readonly label: string;
  readonly name: string;
  /** 「芝 1800m・16頭」。 */
  readonly detail: string;
  readonly grade: string | null;
  readonly href: string;
  /** 板が取れていないときは null(バッジを出さない)。 */
  readonly badges: { readonly morning: Badge; readonly preRace: Badge } | null;
}

export interface ListModel {
  readonly kind: "list";
  readonly date: string;
  readonly dateInput: string;
  readonly venue: Venue;
  readonly venueTabs: readonly { readonly venue: Venue; readonly label: string; readonly href: string; readonly current: boolean }[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly boardNotice: string | null;
  /** 成功で、開催が 0 件。 */
  readonly empty: boolean;
  readonly groups: readonly { readonly name: string; readonly races: readonly RaceItem[] }[];
}

export function buildListModel(input: ListModelInput): ListModel {
  const { route, list, board } = input;
  const races = list.kind === "ready" ? list.races : [];
  return {
    kind: "list",
    date: route.date,
    dateInput: ymdToInput(route.date),
    venue: route.venue,
    venueTabs: (["central", "nar"] as const).map((venue) => ({
      venue,
      label: venue === "central" ? "中央" : "地方",
      href: buildHash({ date: route.date, venue }),
      current: venue === route.venue,
    })),
    loading: list.kind === "loading",
    error: list.kind === "error" ? list.message : null,
    boardNotice: board.kind === "error" ? board.message : null,
    empty: list.kind === "ready" && list.races.length === 0,
    groups: groupRaces(races).map((g) => ({
      name: g.name,
      races: g.races.map(
        (r): RaceItem => ({
          raceId: r.raceId,
          label: `${r.raceNumber}R`,
          name: r.raceName,
          detail: `${r.courseType} ${r.distance}m・${r.entryCount}頭`,
          grade: r.grade,
          href: buildHash({ date: route.date, venue: route.venue, race: r.raceId }),
          badges:
            board.kind === "ready"
              ? { morning: badgeOf(pick(board.rows, r.raceId, "morning")), preRace: badgeOf(pick(board.rows, r.raceId, "pre_race")) }
              : null,
        }),
      ),
    })),
  };
}
