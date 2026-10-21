/**
 * 場ごとの一括実行(Issue #251。管理者だけ)の制御。`app.ts` から切り出した(Issue #400 R-11)。DOM・fetch・時計は注入する(Node でテストできる)。
 * 表示用データ・対象の選択・文言は `bulk.ts`(純関数)、ここは操作の状態と POST の流れだけ。
 *
 *  - 状態: (開催日, 区分) → 場のまとまりのキー(`groupKeys`)→ 状態(`BulkUi`)。メモリだけ(「更新」では消さない)。送信中の印は `await` の前に同期で立てる。
 *  - ボタン(`onOpen`): 確認画面を開く(この時点では POST しない)。過去の開催日・板が取れていない・対象が 0 件・送信中は何もしない(ボタンも無効)。
 *  - 確認画面の「実行する」(`onGo`): **実行の直前に対象を取り直し、確認した対象との共通部分だけを送る**(確認のあとで実行中・完了・発走済みになったものは外れる。増えることはない)。
 *    共通部分が空なら POST しない。
 *  - 板のオーバーレイ(`setOverlay`)と追跡の開始(`forceTrack`)は、`race-data.ts` が持つ板・追跡の道具(`app.ts` が関数で渡す)を受ける。一覧・板の読み取りも関数で受ける(ここは取得の状態を持たない)。
 *  - **閲覧者(Issue #238)にはボタンが無い**。万一呼ばれても何もしない(サーバも 403)。
 */
import type { BoardRow, FetchLike, RaceRow, TaskMode } from "./api";
import { bulkFailureMessage, postBulk, type BulkOutcome } from "./api-bulk";
import { runFailureMessage } from "./api-run";
import { bulkAcceptedText, bulkDayCapText, selectBulkTargets, type BulkUi } from "./bulk";
import type { BoardStore } from "./board-state";
import { todayJst } from "./date";
import { listKey } from "./keys";
import { groupKeys, groupRaces, type ListSource } from "./list";
import type { Route } from "./route";

export interface BulkControlDeps {
  readonly fetch: FetchLike;
  readonly now: () => Date;
  /** 管理者か(`admin` の完全一致だけ)。閲覧者は何も起こさない。 */
  readonly admin: boolean;
  /** 画面の再描画の要求。 */
  readonly onChange: () => void;
  /** 今の route(開催日と区分を引く)。 */
  readonly route: () => Route;
  /** 今の画面が一覧か。 */
  readonly isListScreen: () => boolean;
  /** いま表示中の一覧(取得の状態)。 */
  readonly listSource: () => ListSource;
  /** いま表示中の開催日の板の行。取れていないときは null。 */
  readonly boardRows: () => readonly BoardRow[] | null;
  /** 板にオーバーレイを重ねる(`BoardStore.setOverlay`)。 */
  readonly setOverlay: BoardStore["setOverlay"];
  /** 追跡の対象にその開催日を足し(実行中の行が無くても取る)、追跡を始める。 */
  readonly forceTrack: (date: string) => void;
}

export interface BulkControl {
  /** ボタン: 確認画面を開く。 */
  onOpen(groupKey: string, mode: TaskMode): void;
  /** 確認画面の「実行する」。 */
  onGo(groupKey: string): void;
  /** 確認画面の「やめる」・結果の「閉じる」。送信中は消せない。 */
  onDismiss(groupKey: string): void;
  /** 描画用: (開催日, 区分) の鍵の状態を読む(無ければ空。読むだけで作らない)。 */
  statesOf(key: string): ReadonlyMap<string, BulkUi>;
  /** 取得中のもの(テスト用の待ち)。 */
  pending(): Promise<unknown>[];
}

export function createBulkControl(deps: BulkControlDeps): BulkControl {
  /** 場ごとの一括実行(Issue #251)の操作の状態。(開催日, 区分) → 場のまとまりのキー(`groupKeys`)→ 状態。 */
  const bulkStates = new Map<string, Map<string, BulkUi>>();
  const runInflight = new Set<Promise<unknown>>();

  function bulkStatesFor(key: string): Map<string, BulkUi> {
    const found = bulkStates.get(key);
    if (found !== undefined) return found;
    const created = new Map<string, BulkUi>();
    bulkStates.set(key, created);
    return created;
  }

  /** いま表示中の一覧の、場のまとまり(キー)のレース。一覧が取れていない・キーが無いときは null。 */
  function racesOfGroup(groupKey: string): readonly RaceRow[] | null {
    const source = deps.listSource();
    if (source.kind !== "ready") return null;
    const index = groupKeys(source.races).indexOf(groupKey);
    return index < 0 ? null : groupRaces(source.races)[index]!.races;
  }

  function onOpen(groupKey: string, mode: TaskMode): void {
    if (!deps.admin) return; // 閲覧者(Issue #238)にはボタンが無い。万一呼ばれても何もしない(サーバも 403)
    if (!deps.isListScreen()) return;
    const route = deps.route();
    const date = route.date;
    const now = deps.now();
    if (date < todayJst(now)) return;
    const board = deps.boardRows();
    const races = racesOfGroup(groupKey);
    if (board === null || races === null) return;
    const states = bulkStatesFor(listKey(date, route.venue));
    if (states.get(groupKey)?.kind === "sending") return;
    const selection = selectBulkTargets({ mode, races, board, date, now });
    if (selection.raceIds.length === 0) return;
    states.set(groupKey, { kind: "confirm", mode, raceIds: selection.raceIds, excluded: selection.excluded });
    deps.onChange();
  }

  /** 送信中の印は `await` の前に同期で立てる(二重押しを防ぐ。確認画面の状態でなければ何もしない)。 */
  function onGo(groupKey: string): void {
    if (!deps.admin) return;
    const route = deps.route();
    const date = route.date;
    const key = listKey(date, route.venue);
    const states = bulkStatesFor(key);
    const ui = states.get(groupKey);
    if (ui === undefined || ui.kind !== "confirm") return;
    const now = deps.now();
    const board = deps.boardRows();
    const races = racesOfGroup(groupKey);
    const current = board !== null && races !== null && date >= todayJst(now) ? new Set(selectBulkTargets({ mode: ui.mode, races, board, date, now }).raceIds) : new Set<string>();
    const raceIds = ui.raceIds.filter((id) => current.has(id));
    if (raceIds.length === 0) {
      states.set(groupKey, { kind: "result", tone: "error", text: "対象のレースがなくなったため、何も予約していません。" });
      deps.onChange();
      return;
    }
    states.set(groupKey, { kind: "sending", mode: ui.mode });
    deps.onChange();
    const mode = ui.mode;
    const promise = postBulk(deps.fetch, { date, mode, raceIds }).then((outcome) => {
      finishBulk(states, groupKey, date, mode, outcome);
      deps.onChange();
    });
    runInflight.add(promise);
    void promise.finally(() => runInflight.delete(promise));
  }

  function finishBulk(states: Map<string, BulkUi>, groupKey: string, date: string, mode: TaskMode, outcome: BulkOutcome): void {
    const nowMs = deps.now().getTime();
    switch (outcome.kind) {
      case "accepted":
        for (const entry of outcome.results) {
          deps.setOverlay(date, entry.raceId, mode, entry.result === "accepted" ? "queued" : entry.status, nowMs);
        }
        deps.forceTrack(date);
        states.set(groupKey, { kind: "result", tone: "ok", text: bulkAcceptedText(outcome.results) });
        return;
      case "accepted-malformed":
        // サーバは受け付けている(202)が、本文が想定外。失敗の文言を出し、追跡は始める(板が真実を教える)。
        deps.forceTrack(date);
        states.set(groupKey, { kind: "result", tone: "error", text: runFailureMessage({ kind: "unexpected", httpStatus: 202 }) });
        return;
      case "day-cap":
        states.set(groupKey, { kind: "result", tone: "error", text: bulkDayCapText(outcome) });
        return;
      case "failed":
        states.set(groupKey, { kind: "result", tone: "error", text: bulkFailureMessage(outcome.failure) });
        return;
    }
  }

  function onDismiss(groupKey: string): void {
    if (!deps.admin) return;
    const route = deps.route();
    const states = bulkStatesFor(listKey(route.date, route.venue));
    const ui = states.get(groupKey);
    if (ui === undefined || ui.kind === "sending") return;
    states.delete(groupKey);
    deps.onChange();
  }

  return { onOpen, onGo, onDismiss, statesOf: (key) => bulkStates.get(key) ?? new Map<string, BulkUi>(), pending: () => [...runInflight] };
}
