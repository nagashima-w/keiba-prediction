/**
 * 一覧の画面の制御(Issue #184)。取得・メモリキャッシュ・遷移。DOM・fetch・時計は注入する(Node でテストできる)。
 *
 * **netkeiba への取得と DO の起動を、画面の操作で増やさない**:
 *  - 一覧(`GET /api/races`)は (開催日, 区分) ごとに 1 回。画面の往復(一覧 → レース → 一覧、中央 → 地方 → 中央)で取り直さない
 *  - 板(`GET /api/analyses/status`。race_id なし)は開催日ごとに 1 回。区分を切り替えても取り直さない
 *  - 失敗は自動で再試行しない(「更新」だけが、現在の一覧と板を取り直す)。同じものを同時に 2 本取らない(取得中の再要求は束ねる)
 *  - `/api/analyses/{id}`・`POST` は、この画面からは呼ばない(#185)。ポーリングも無い(#185)
 * 表示は「現在のハッシュ + キャッシュ」から毎回導く(遅れて届いた結果は、キャッシュに入るだけで、今の画面を壊さない)。
 */
import { failureMessage, fetchBoard, fetchRaces, type BoardRow, type FetchLike, type RaceRow } from "./api";
import { inputToYmd, todayJst } from "./date";
import { buildListModel, buildPendingModel, type BoardSource, type ListSource } from "./list";
import { buildHash, parseHash, type Route, type Venue } from "./route";
import { renderScreen } from "./view";
import type { VNode } from "./vnode";

export interface AppDeps {
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly render: (tree: VNode) => void;
  readonly getHash: () => string;
  readonly setHash: (hash: string) => void;
}

export interface App {
  start(): void;
  onHashChange(): void;
  /** 取得中のものがすべて終わるまで待つ(テスト用。画面は使わない)。 */
  whenIdle(): Promise<void>;
}

const listKey = (date: string, venue: Venue): string => `${date}:${venue}`;

export function createApp(deps: AppDeps): App {
  let route: Route = parseHash(deps.getHash(), todayJst(deps.now()));

  const races = new Map<string, readonly RaceRow[]>();
  const raceErrors = new Map<string, string>();
  const raceInflight = new Map<string, Promise<void>>();
  const boards = new Map<string, readonly BoardRow[]>();
  const boardErrors = new Map<string, string>();
  const boardInflight = new Map<string, Promise<void>>();

  function listSource(): ListSource {
    const key = listKey(route.date, route.venue);
    const cached = races.get(key);
    if (cached !== undefined) return { kind: "ready", races: cached };
    const error = raceErrors.get(key);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "loading" };
  }

  function boardSource(): BoardSource {
    const rows = boards.get(route.date);
    if (rows !== undefined) return { kind: "ready", rows };
    const error = boardErrors.get(route.date);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "none" };
  }

  function render(): void {
    const isList = route.race === null && route.analysis === null;
    const model = isList ? buildListModel({ route, list: listSource(), board: boardSource() }) : buildPendingModel(route);
    deps.render(
      renderScreen(model, {
        onDateChange,
        onRefresh,
      }),
    );
  }

  function loadRaces(date: string, venue: Venue): void {
    const key = listKey(date, venue);
    if (races.has(key) || raceErrors.has(key) || raceInflight.has(key)) return;
    const promise = fetchRaces(deps.fetch, date, venue).then((result) => {
      raceInflight.delete(key);
      if (result.ok) races.set(key, result.races);
      else raceErrors.set(key, failureMessage(result.error));
      render();
    });
    raceInflight.set(key, promise);
  }

  function loadBoard(date: string): void {
    if (boards.has(date) || boardErrors.has(date) || boardInflight.has(date)) return;
    const promise = fetchBoard(deps.fetch, date).then((result) => {
      boardInflight.delete(date);
      if (result.ok) boards.set(date, result.rows);
      else boardErrors.set(date, failureMessage(result.error));
      render();
    });
    boardInflight.set(date, promise);
  }

  /** 一覧の画面に必要なものを、無ければ取りに行く(race・analysis の画面では、何も取らない)。 */
  function ensureLoaded(): void {
    if (route.race === null && route.analysis === null) {
      loadRaces(route.date, route.venue);
      loadBoard(route.date);
    }
  }

  function onHashChange(): void {
    route = parseHash(deps.getHash(), todayJst(deps.now()));
    ensureLoaded();
    render();
  }

  function onDateChange(value: string): void {
    const ymd = inputToYmd(value);
    if (ymd === null) return;
    deps.setHash(buildHash({ date: ymd, venue: route.venue }));
  }

  function onRefresh(): void {
    // 取得中は何もしない(同じものを同時に 2 本取らない。ボタンも disabled)。
    if (raceInflight.has(listKey(route.date, route.venue)) || boardInflight.has(route.date)) return;
    const key = listKey(route.date, route.venue);
    races.delete(key);
    raceErrors.delete(key);
    boards.delete(route.date);
    boardErrors.delete(route.date);
    ensureLoaded();
    render();
  }

  return {
    start() {
      ensureLoaded();
      render();
    },
    onHashChange,
    async whenIdle() {
      // 取得が終わるたびに新しい取得は始まらない(失敗の自動再試行なし)ので、数回の確認で必ず止まる。
      for (let i = 0; i < 10 && (raceInflight.size > 0 || boardInflight.size > 0); i += 1) {
        await Promise.all([...raceInflight.values(), ...boardInflight.values()]);
      }
    },
  };
}
