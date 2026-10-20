/**
 * 単体の起動(`POST /api/analyses/run`。Issue #186)の制御。`app.ts` から切り出した(Issue #400 R-11)。DOM・fetch・時計は注入する(Node でテストできる)。
 *
 *  - 起動(`onRun`): 同期の印(`runStates`)を `await` の前に立てて二重押しを防ぐ。202・409 は板にオーバーレイ(待ち等)を重ねて追跡を始める。失敗は固定の文言(`runFailureMessage`)。
 *  - 板のオーバーレイ(`setOverlay`)と追跡の開始(`forceTrack`)は、`app.ts` が持つ板・追跡の道具を関数で受ける(ここは板・追跡の状態を持たない)。
 *  - **閲覧者(Issue #238)には起動のボタンが無い**。万一呼ばれても POST しない(サーバも 403)。
 */
import type { FetchLike, TaskMode } from "./api";
import { postRun, runFailureMessage, type RunOutcome } from "./api-run";
import type { BoardStore } from "./board-state";
import type { RunUi } from "./race";

export interface RunControlDeps {
  readonly fetch: FetchLike;
  readonly now: () => Date;
  /** 管理者か(`admin` の完全一致だけ)。閲覧者は何も起こさない。 */
  readonly admin: boolean;
  /** 画面の再描画の要求。 */
  readonly onChange: () => void;
  /** 板にオーバーレイを重ねる(`BoardStore.setOverlay`)。 */
  readonly setOverlay: BoardStore["setOverlay"];
  /** 追跡の対象にその開催日を足し(実行中の行が無くても取る)、追跡を始める。 */
  readonly forceTrack: (date: string) => void;
}

export interface RunControl {
  /** 起動の押下。送信中の二重押しは無視する。 */
  onRun(date: string, raceId: string, mode: TaskMode): void;
  /** そのレースの起動の操作の表示(モードごと)。 */
  runsFor(date: string, raceId: string): Map<TaskMode, RunUi>;
  /** 取得中のもの(テスト用の待ち)。 */
  pending(): Promise<unknown>[];
}

const runKey = (date: string, raceId: string, mode: TaskMode): string => `${date}:${raceId}:${mode}`;

export function createRunControl(deps: RunControlDeps): RunControl {
  /** 起動の操作の表示((開催日, レース, モード)ごと)。送信中の印は `await` の前に同期で立てる(二重押しを防ぐ)。 */
  const runStates = new Map<string, RunUi>();
  const runInflight = new Set<Promise<unknown>>();

  function runsFor(date: string, raceId: string): Map<TaskMode, RunUi> {
    const runs = new Map<TaskMode, RunUi>();
    for (const mode of ["morning", "pre_race"] as const) {
      const state = runStates.get(runKey(date, raceId, mode));
      if (state !== undefined) runs.set(mode, state);
    }
    return runs;
  }

  function onRun(date: string, raceId: string, mode: TaskMode): void {
    if (!deps.admin) return; // 閲覧者(Issue #238)には起動のボタンが無い。万一呼ばれても POST しない(サーバも 403)
    const key = runKey(date, raceId, mode);
    if (runStates.get(key)?.kind === "sending") return; // 同期の印(await の前)。二重押しを防ぐ
    runStates.set(key, { kind: "sending" });
    deps.onChange();
    const promise = postRun(deps.fetch, { raceId, date, mode }).then((outcome) => {
      finishRun(key, date, raceId, mode, outcome);
      deps.onChange();
    });
    runInflight.add(promise);
    void promise.finally(() => runInflight.delete(promise));
  }

  function finishRun(key: string, date: string, raceId: string, mode: TaskMode, outcome: RunOutcome): void {
    const nowMs = deps.now().getTime();
    switch (outcome.kind) {
      case "accepted":
        runStates.delete(key);
        deps.setOverlay(date, raceId, mode, "queued", nowMs);
        deps.forceTrack(date);
        return;
      case "already-running":
        runStates.set(key, { kind: "already" });
        deps.setOverlay(date, raceId, mode, outcome.status, nowMs);
        deps.forceTrack(date);
        return;
      case "accepted-malformed":
        // サーバは受け付けている(202)が、本文が想定外。失敗の文言を出し、追跡は始める(板が真実を教える)。
        runStates.set(key, { kind: "error", message: runFailureMessage({ kind: "unexpected", httpStatus: 202 }) });
        deps.forceTrack(date);
        return;
      case "failed":
        runStates.set(key, { kind: "error", message: runFailureMessage(outcome.failure) });
        return;
    }
  }

  return { onRun, runsFor, pending: () => [...runInflight] };
}
