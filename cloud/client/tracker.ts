/**
 * 追跡(ポーリング)の状態機械(Issue #186)。タイマー・可視状態・取得(cycle)は注入する(Node のテストで時間を手で進められる)。DOM に触れない。
 *
 *  - 間隔: 取得の 1〜10 回目は 3 秒間隔、11 回目からは 5 秒間隔。**タイマーは取得の完了後に張る**(`setInterval` は使わない=取得が長引いても重ならない)。
 *  - 停止(stopped): 全部終わった(cycle の remaining が 0=idle に戻る・注記なし)・5 分たった・通信の失敗が 3 回続いた(後の2つは注記と「状態を更新」を出す)。
 *  - **非表示の間は一時停止**(タイマーを消す。取得中のものは処理するが次は張らない)。表示に戻ったら**即時に 1 回取って**再開する。非表示の時間は 5 分に数えない。
 *  - **世代**: 開始・再開・停止のたびに進める。非同期の継続(取得の完了・タイマー)は、自分の世代と一致するときだけ状態を動かす
 *    (再開より前に出した取得が後から届いても、失敗の連続・idle・タイマーに影響しない。板のデータの適用の順序は `board-state.ts` の通し番号が守る=別の目的)。
 *  - AbortController による取得のタイムアウトは持たない(取得が止まったままになる場合は【記録】)。「状態を更新」は世代を進めるので、止まった取得を置き去りにして再開できる。
 */

/** 取得の 1〜FAST_POLLS 回目の間隔。 */
export const FAST_INTERVAL_MS = 3000;
export const FAST_POLLS = 10;
/** FAST_POLLS 回のあとの間隔。 */
export const SLOW_INTERVAL_MS = 5000;
/** 追跡を続ける最大の時間(非表示の間を除く)。 */
export const BUDGET_MS = 300_000;
/** 通信の失敗がこの回数続いたら止める。 */
export const MAX_FAILURES = 3;

export type StopReason = "timeout" | "failures";
export type TrackerState = { readonly kind: "idle" } | { readonly kind: "running" } | { readonly kind: "stopped"; readonly reason: StopReason };

/** 1 周期の結果。ok: 追跡の対象のすべての取得が成功した。remaining: 取得を反映したあとも実行中の開催日の数(0 なら全部終わった)。 */
export interface CycleResult {
  readonly ok: boolean;
  readonly remaining: number;
}

export interface TrackerDeps {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly isVisible: () => boolean;
  readonly cycle: () => Promise<CycleResult>;
  /** 状態(idle・running・stopped)が変わったとき。 */
  readonly onChange: () => void;
}

export interface Tracker {
  state(): TrackerState;
  /** 開始(または再開)。予算(周期・失敗の連続・5 分)を新しくする。immediate なら即時に 1 回取る。そうでなければ最初の取得は 3 秒後。 */
  begin(options: { readonly immediate: boolean }): void;
  /** `visibilitychange` のとき。 */
  onVisibilityChange(): void;
}

export function createTracker(deps: TrackerDeps): Tracker {
  let state: TrackerState = { kind: "idle" };
  let generation = 0;
  let timer: unknown = null;
  let startedAt = 0;
  let polls = 0;
  let failures = 0;
  /** 非表示になった時刻(表示中は null)。 */
  let hiddenSince: number | null = null;

  function clear(): void {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  }

  function setState(next: TrackerState): void {
    const changed = state.kind !== next.kind || (state.kind === "stopped" && next.kind === "stopped" && state.reason !== next.reason);
    state = next;
    if (changed) deps.onChange();
  }

  function stop(next: TrackerState): void {
    generation += 1;
    clear();
    setState(next);
  }

  function schedule(g: number): void {
    const delay = polls < FAST_POLLS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
    timer = deps.setTimer(() => {
      timer = null;
      if (g !== generation || hiddenSince !== null) return;
      if (deps.now() - startedAt >= BUDGET_MS) {
        stop({ kind: "stopped", reason: "timeout" });
        return;
      }
      void run(g);
    }, delay);
  }

  async function run(g: number): Promise<void> {
    polls += 1;
    let result: CycleResult;
    try {
      result = await deps.cycle();
    } catch {
      result = { ok: false, remaining: 1 };
    }
    if (g !== generation) return;
    failures = result.ok ? 0 : failures + 1;
    if (failures >= MAX_FAILURES) {
      stop({ kind: "stopped", reason: "failures" });
      return;
    }
    if (result.remaining === 0) {
      stop({ kind: "idle" });
      return;
    }
    if (deps.now() - startedAt >= BUDGET_MS) {
      stop({ kind: "stopped", reason: "timeout" });
      return;
    }
    if (hiddenSince !== null) return; // 非表示の間は次を張らない(表示に戻ったとき即時に再開する)
    schedule(g);
  }

  return {
    state: () => state,
    begin({ immediate }) {
      generation += 1;
      clear();
      startedAt = deps.now();
      polls = 0;
      failures = 0;
      setState({ kind: "running" });
      if (!deps.isVisible()) {
        hiddenSince = deps.now();
        return;
      }
      hiddenSince = null;
      if (immediate) {
        void run(generation);
      } else {
        schedule(generation);
      }
    },
    onVisibilityChange() {
      if (state.kind !== "running") return;
      if (!deps.isVisible()) {
        if (hiddenSince === null) hiddenSince = deps.now();
        clear();
        return;
      }
      if (hiddenSince === null) return; // 非表示を経ていない通知
      startedAt += deps.now() - hiddenSince; // 非表示の時間は数えない
      hiddenSince = null;
      generation += 1;
      clear();
      void run(generation);
    },
  };
}

/** 停止の注記の文言(理由ごと。「状態を更新」で再開できることを示す)。 */
export function trackingMessage(reason: StopReason): string {
  return reason === "timeout"
    ? "状態の自動更新を止めました(5分たちました)。「状態を更新」で再開できます。"
    : "状態の自動更新を止めました(通信に失敗しました)。「状態を更新」で再開できます。";
}
