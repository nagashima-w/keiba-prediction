/**
 * 一覧の画面の表示用データ(Issue #184。純関数)。場ごとのまとまり・R の並び・板の (race_id, mode) ごとのバッジ・各状態の表示。
 * `view.ts` がこれを VNode にする。
 */
import type { BoardRow, RaceRow, TaskMode } from "./api";
import { buildBulkModel, type BulkModel, type BulkUi } from "./bulk";
import { ymdToInput } from "./date";
import { gradeLabelForDisplay } from "./grade";
import { buildHash, REPORT_HASH, SETTINGS_HASH, VERIFY_HASH, type Route, type Venue } from "./route";

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

/**
 * 場のまとまりの識別キー(Issue #187。開閉の状態を覚えるため)。「場名 + 同名の何組目か」。
 * 名前だけだと、`groupRaces` が離れた同名の行を別の組に分けたとき(同じ会場名が race_id の順で離れる)、2 組の開閉が連動してしまう。
 * 更新(取り直し)で内容が変わっても、同じ場は同じキーになる(race_id は使わない=先頭のレースが消えても変わらない)。
 */
function keysOf(groups: readonly RaceGroup[]): string[] {
  const seen = new Map<string, number>();
  return groups.map((g) => {
    const n = seen.get(g.name) ?? 0;
    seen.set(g.name, n + 1);
    return `${g.name}#${n}`;
  });
}

export function groupKeys(rows: readonly RaceRow[]): string[] {
  return keysOf(groupRaces(rows));
}

/** 見出しの要約(レース単位の数え方)。 */
export interface GroupSummary {
  /** 朝・発走前のどちらかが待ち(queued)・取得済み(fetched)のレースの数。 */
  readonly running: number;
  /** 朝・発走前のどちらかが失敗(failed)のレースの数。 */
  readonly failed: number;
}

/**
 * 板から、この場のレースのうち実行中・失敗のものの数を数える(Issue #187。閉じていても状態が分かるように)。
 * **行ではなくレースで数える**(同じレースの 2 モードがどちらも実行中でも 1)。朝が失敗・発走前が待ちのレースは、両方に 1 つずつ入る。
 * 板が取れていなければ null(要約を出さない=見出しは場名だけ)。
 */
export function summarizeGroup(races: readonly RaceRow[], board: BoardSource): GroupSummary | null {
  if (board.kind !== "ready") return null;
  let running = 0;
  let failed = 0;
  for (const race of races) {
    const statuses = (["morning", "pre_race"] as const).map((mode) => pick(board.rows, race.raceId, mode)?.status);
    if (statuses.some((s) => s === "queued" || s === "fetched")) running += 1;
    if (statuses.some((s) => s === "failed")) failed += 1;
  }
  return { running, failed };
}

export type ListSource = { readonly kind: "loading" } | { readonly kind: "error"; readonly message: string } | { readonly kind: "ready"; readonly races: readonly RaceRow[] };
export type BoardSource = { readonly kind: "none" } | { readonly kind: "error"; readonly message: string } | { readonly kind: "ready"; readonly rows: readonly BoardRow[] };

export interface ListModelInput {
  readonly route: Route;
  readonly list: ListSource;
  readonly board: BoardSource;
  /** 板(`status`)を取得中か(Issue #186 段階1)。一覧が取得済みでも、板の取得中は「更新」を押せない。省略は false。 */
  readonly boardLoading?: boolean;
  /** 追跡の停止の注記(止まっているときだけ。省略・null は出さない。Issue #186)。 */
  readonly tracking?: string | null;
  /** 利用者が押した場の開閉(キーは `groupKeys`)。無い場は既定(場が 2 つ以上なら閉・1 つなら開)。省略は「何も押していない」。 */
  readonly choices?: ReadonlyMap<string, boolean>;
  /** 閲覧者(Issue #238)。設定・検証への入口を出さない。省略は false(管理者)。 */
  readonly readOnly?: boolean;
  /**
   * 場ごとの一括実行(Issue #251)の入力。`now` は発走済みの判定に使う現在時刻、`states` は場のまとまりのキー(`groupKeys`)→ 操作の状態。
   * **省略、または閲覧者(`readOnly`)のときは、どの場も `bulk` を作らない(null)**。
   */
  readonly bulk?: { readonly now: Date; readonly states: ReadonlyMap<string, BulkUi> };
}

export interface RaceItem {
  readonly raceId: string;
  /** 「11R」。 */
  readonly label: string;
  readonly name: string;
  /** 「芝 1800m・16頭」。発走予定時刻があれば先頭に「15:40 発走・」(Issue #236)。 */
  readonly detail: string;
  readonly grade: string | null;
  readonly href: string;
  /** 板が取れていないときは null(バッジを出さない)。 */
  readonly badges: { readonly morning: Badge; readonly preRace: Badge } | null;
}

export interface RaceGroupItem {
  /** 開閉の状態のキー(`groupKeys`)。 */
  readonly key: string;
  readonly name: string;
  readonly open: boolean;
  /** 板が取れていないときは null。 */
  readonly summary: GroupSummary | null;
  /** 閉じていても持つ(隠すのは描画の側)。 */
  readonly races: readonly RaceItem[];
  /** 場ごとの一括実行(Issue #251。管理者だけ。閲覧者・入力なしは null)。描画は場を開いているときだけ。 */
  readonly bulk: BulkModel | null;
}

export interface ListModel {
  readonly kind: "list";
  readonly date: string;
  readonly dateInput: string;
  readonly venue: Venue;
  /** 設定画面への入口のリンク先(Issue #189)。閲覧者(`readOnly`)は null(入口を出さない。Issue #238)。 */
  readonly settingsHref: string | null;
  /** 検証画面への入口のリンク先(Issue #219)。閲覧者(`readOnly`)は null(入口を出さない。Issue #238)。 */
  readonly verifyHref: string | null;
  /** 日報画面への入口のリンク先(Issue #235)。 */
  readonly reportHref: string;
  readonly venueTabs: readonly { readonly venue: Venue; readonly label: string; readonly href: string; readonly current: boolean }[];
  /** 一覧または板を取得中(「更新」を無効にする)。 */
  readonly loading: boolean;
  readonly error: string | null;
  /** 板だけが失敗したときの注記(何の失敗かを示す前置きつき)。 */
  readonly boardNotice: string | null;
  /** 追跡の停止の注記(「状態を更新」つき)。止まっていないとき null。 */
  readonly tracking: string | null;
  /** 成功で、開催が 0 件。 */
  readonly empty: boolean;
  readonly groups: readonly RaceGroupItem[];
}

/** 板の失敗の注記の前置き(バッジが出ない理由を示す。Issue #186 段階1)。 */
export const BOARD_NOTICE_PREFIX = "実行状態(バッジ)を取得できませんでした。";

export function buildListModel(input: ListModelInput): ListModel {
  const { route, list, board } = input;
  const races = list.kind === "ready" ? list.races : [];
  const rawGroups = groupRaces(races);
  const keys = keysOf(rawGroups);
  // 既定: 場が 2 つ以上なら全部閉じる(畳む意味がある)・1 つなら開く。利用者が押した値だけが上書きする。
  const defaultOpen = rawGroups.length < 2;
  return {
    kind: "list",
    date: route.date,
    dateInput: ymdToInput(route.date),
    venue: route.venue,
    settingsHref: input.readOnly === true ? null : SETTINGS_HASH,
    verifyHref: input.readOnly === true ? null : VERIFY_HASH,
    reportHref: REPORT_HASH,
    venueTabs: (["central", "nar"] as const).map((venue) => ({
      venue,
      label: venue === "central" ? "中央" : "地方",
      href: buildHash({ date: route.date, venue }),
      current: venue === route.venue,
    })),
    loading: list.kind === "loading" || input.boardLoading === true,
    error: list.kind === "error" ? list.message : null,
    boardNotice: board.kind === "error" ? `${BOARD_NOTICE_PREFIX}${board.message}` : null,
    tracking: input.tracking ?? null,
    empty: list.kind === "ready" && list.races.length === 0,
    groups: rawGroups.map((g, i) => ({
      key: keys[i]!,
      name: g.name,
      open: input.choices?.get(keys[i]!) ?? defaultOpen,
      summary: summarizeGroup(g.races, board),
      bulk:
        input.bulk === undefined || input.readOnly === true
          ? null
          : buildBulkModel({ date: route.date, groupName: g.name, races: g.races, board: board.kind === "ready" ? board.rows : null, now: input.bulk.now, ui: input.bulk.states.get(keys[i]!) }),
      races: g.races.map(
        (r): RaceItem => ({
          raceId: r.raceId,
          label: `${r.raceNumber}R`,
          name: r.raceName,
          detail: `${r.startTime === null ? "" : `${r.startTime} 発走・`}${r.courseType} ${r.distance}m・${r.entryCount}頭`,
          grade: gradeLabelForDisplay(r.grade), // 重賞だけ(Issue #250。OP・L などは出さない)
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
