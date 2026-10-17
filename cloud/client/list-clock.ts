/**
 * 一覧の「時間の経過で並べ替える」ための再描画のタイマー(Issue #346)。取得はしない(描画だけ。`createMounter` は木が同じなら DOM を触らない)。
 * `setInterval` は使わず、`setTimeout` の連鎖。**`sync(要るか)` は冪等**で、`app.ts` の `render()` の末尾から毎回呼ぶ
 * (画面遷移・一覧の読み込み完了・表示の復帰を個別に配線しない)。発火すると `onChange`(= 再描画)を呼び、再描画の末尾の `sync` が次を張る。
 */
export const LIST_CLOCK_MS = 30_000;

export interface ListClockDeps {
  readonly timers: { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };
  readonly isVisible: () => boolean;
  readonly onChange: () => void;
}

export function createListClock(deps: ListClockDeps): { readonly sync: (needed: boolean) => void } {
  let timer: unknown = null;
  const stop = (): void => {
    if (timer !== null) {
      deps.timers.clear(timer);
      timer = null;
    }
  };
  return {
    /** 要り、画面が見えているときだけ 1 本張る(張ってあれば何もしない)。それ以外は止める。 */
    sync(needed) {
      if (!needed || !deps.isVisible()) return stop();
      if (timer !== null) return;
      timer = deps.timers.set(() => {
        timer = null;
        deps.onChange();
      }, LIST_CLOCK_MS);
    },
  };
}
