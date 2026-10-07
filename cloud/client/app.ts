/**
 * 一覧の画面の制御(Issue #184)。取得・メモリキャッシュ・遷移。DOM・fetch・時計は注入する(Node でテストできる)。
 *
 * **netkeiba への取得と DO の起動を、画面の操作で増やさない**:
 *  - 一覧(`GET /api/races`)は (開催日, 区分) ごとに 1 回。画面の往復(一覧 → レース → 一覧、中央 → 地方 → 中央)で取り直さない
 *  - 板(`GET /api/analyses/status`。race_id なし)は開催日ごとに 1 回。区分を切り替えても取り直さない
 *  - 失敗は自動で再試行しない(「更新」だけが、現在の一覧と板を取り直す)。同じものを同時に 2 本取らない(取得中の再要求は束ねる)
 *  - `POST`・ポーリングは、この段階には無い(#186)
 * Issue #185: レース画面(`#…&race=`)は、状態(`status?race_id=`)と過去の分析の一覧(`GET /api/analyses`)を (開催日, race_id) ごとに 1 回ずつ取る。
 * 結果画面(`#analysis=`)は `GET /api/analyses/{id}` を id ごとに 1 回(⚠️ サーバは R2 の操作回数を使う)。いずれも画面の往復で取り直さず、失敗も自動で再試行しない
 * (「更新」だけが、そのレースの 2 本、または失敗した分析の 1 本を取り直す。成功した分析に「更新」は無い)。
 * **レース画面・結果画面は、一覧(netkeiba に出る)と板(race_id なし)を取らない**。`race` と `analysis` が両方あれば結果画面(analysis)。
 * 表示は「現在のハッシュ + キャッシュ」から毎回導く(遅れて届いた結果は、キャッシュに入るだけで、今の画面を壊さない)。
 */
import { failureMessage, fetchBoard, fetchRaces, fetchRaceStatus, type BoardRow, type FetchLike, type MorningPriorView, type RaceRow } from "./api";
import { fetchAnalysis, fetchPastAnalyses, type AnalysisDetail, type PastAnalysis } from "./api-analysis";
import { inputToYmd, todayJst } from "./date";
import { buildListModel, type BoardSource, type ListSource } from "./list";
import { buildRaceModel, type PastSource, type RaceStatusSource } from "./race";
import { buildResultModel, type ResultSource } from "./result";
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
const raceKey = (date: string, raceId: string): string => `${date}:${raceId}`;

interface RaceStatusEntry {
  readonly rows: readonly BoardRow[];
  readonly prior: MorningPriorView | null;
}

export function createApp(deps: AppDeps): App {
  let route: Route = parseHash(deps.getHash(), todayJst(deps.now()));

  const races = new Map<string, readonly RaceRow[]>();
  const raceErrors = new Map<string, string>();
  const raceInflight = new Map<string, Promise<void>>();
  const boards = new Map<string, readonly BoardRow[]>();
  const boardErrors = new Map<string, string>();
  const boardInflight = new Map<string, Promise<void>>();

  const raceStatuses = new Map<string, RaceStatusEntry>();
  const raceStatusErrors = new Map<string, string>();
  const raceStatusInflight = new Map<string, Promise<void>>();
  const pasts = new Map<string, readonly PastAnalysis[]>();
  const pastErrors = new Map<string, string>();
  const pastInflight = new Map<string, Promise<void>>();
  const analyses = new Map<number, AnalysisDetail>();
  const analysisErrors = new Map<number, string>();
  const analysisInflight = new Map<number, Promise<void>>();

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

  function raceStatusSource(key: string): RaceStatusSource {
    const cached = raceStatuses.get(key);
    if (cached !== undefined) return { kind: "ready", rows: cached.rows, prior: cached.prior };
    const error = raceStatusErrors.get(key);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "loading" };
  }

  function pastSource(key: string): PastSource {
    const cached = pasts.get(key);
    if (cached !== undefined) return { kind: "ready", analyses: cached };
    const error = pastErrors.get(key);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "loading" };
  }

  function analysisSource(id: number): ResultSource {
    const cached = analyses.get(id);
    if (cached !== undefined) return { kind: "ready", analysis: cached };
    const error = analysisErrors.get(id);
    if (error !== undefined) return { kind: "error", message: error };
    return { kind: "loading" };
  }

  const actions = { onDateChange, onRefresh };

  function render(): void {
    if (route.analysis !== null) {
      deps.render(renderScreen(buildResultModel({ route, source: analysisSource(route.analysis) }), actions));
    } else if (route.race !== null) {
      const key = raceKey(route.date, route.race);
      const listRow = races.get(listKey(route.date, route.venue))?.find((r) => r.raceId === route.race);
      deps.render(renderScreen(buildRaceModel({ route, status: raceStatusSource(key), past: pastSource(key), listRow }), actions));
    } else {
      deps.render(renderScreen(buildListModel({ route, list: listSource(), board: boardSource() }), actions));
    }
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

  function loadRaceStatus(date: string, raceId: string): void {
    const key = raceKey(date, raceId);
    if (raceStatuses.has(key) || raceStatusErrors.has(key) || raceStatusInflight.has(key)) return;
    const promise = fetchRaceStatus(deps.fetch, date, raceId).then((result) => {
      raceStatusInflight.delete(key);
      if (result.ok) raceStatuses.set(key, { rows: result.rows, prior: result.prior });
      else raceStatusErrors.set(key, failureMessage(result.error));
      render();
    });
    raceStatusInflight.set(key, promise);
  }

  function loadPast(date: string, raceId: string): void {
    const key = raceKey(date, raceId);
    if (pasts.has(key) || pastErrors.has(key) || pastInflight.has(key)) return;
    const promise = fetchPastAnalyses(deps.fetch, date, raceId).then((result) => {
      pastInflight.delete(key);
      if (result.ok) pasts.set(key, result.analyses);
      else pastErrors.set(key, failureMessage(result.error));
      render();
    });
    pastInflight.set(key, promise);
  }

  function loadAnalysis(id: number): void {
    if (analyses.has(id) || analysisErrors.has(id) || analysisInflight.has(id)) return;
    const promise = fetchAnalysis(deps.fetch, id).then((result) => {
      analysisInflight.delete(id);
      if (result.ok) analyses.set(id, result.analysis);
      else analysisErrors.set(id, failureMessage(result.error));
      render();
    });
    analysisInflight.set(id, promise);
  }

  /** 今の画面に必要なものを、無ければ取りに行く。結果画面は分析 1 本だけ・レース画面は状態と過去の分析だけ(一覧・板は取らない)。 */
  function ensureLoaded(): void {
    if (route.analysis !== null) {
      loadAnalysis(route.analysis);
    } else if (route.race !== null) {
      loadRaceStatus(route.date, route.race);
      loadPast(route.date, route.race);
    } else {
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
    if (route.analysis !== null) {
      // 失敗した分析だけを取り直す(成功した分析は再取得しない=R2 の操作回数を使わない)。取得中は何もしない。
      const id = route.analysis;
      if (!analysisErrors.has(id) || analysisInflight.has(id)) return;
      analysisErrors.delete(id);
      ensureLoaded();
      render();
      return;
    }
    if (route.race !== null) {
      const key = raceKey(route.date, route.race);
      if (raceStatusInflight.has(key) || pastInflight.has(key)) return;
      raceStatuses.delete(key);
      raceStatusErrors.delete(key);
      pasts.delete(key);
      pastErrors.delete(key);
      ensureLoaded();
      render();
      return;
    }
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
      const pending = () => [...raceInflight.values(), ...boardInflight.values(), ...raceStatusInflight.values(), ...pastInflight.values(), ...analysisInflight.values()];
      for (let i = 0; i < 10 && pending().length > 0; i += 1) {
        await Promise.all(pending());
      }
    },
  };
}
