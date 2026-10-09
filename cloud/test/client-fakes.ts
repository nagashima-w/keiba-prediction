/**
 * Issue #186 段階2: クライアントのテスト用の道具(偽のタイマー・保留できる応答)。
 * 実時間の待ちを使わない(`setTimeout` の実時間待ちは CI で不安定になるため)。待ちはすべて上限つきの有限回の繰り返し。
 */
import type { ViewActions } from "../client/view";

/**
 * 何もしない `ViewActions`(Issue #191。#188 の申し送り)。`ViewActions` に項目を足すたびに、各テストの noop を書き換えずに済む
 * (型を付けてあるので、項目を足して漏れると、ここで型エラーになる)。個別の処理を見たいテストは `{ ...noopActions, onRefresh: … }` で上書きする。
 */
export const noopActions: ViewActions = { onDateChange: () => {}, onRefresh: () => {}, onToggleGroup: () => {}, onToggleResult: () => {}, onRun: () => {}, onRetrack: () => {}, onSettingsInput: () => {}, onSettingsSave: () => {}, onSettingsPreviewToggle: () => {}, onSettingsPreviewRefresh: () => {}, onMigrationFile: () => {}, onMigrationStart: () => {}, onMigrationCancelCheck: () => {} };

/** 手で時間を進める偽のタイマー。`advance` は、期限の来たタイマーを時刻順に実行し、そのたびに非同期の後始末(マイクロタスク・I/O の 1 巡)を流す。 */
export function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  async function flush(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return {
    /** 偽の現在時刻(ミリ秒。0 から始まる)。 */
    now: (): number => now,
    set: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    /** 張られているタイマーの数。 */
    pending: (): number => timers.size,
    /** 次のタイマーまでの残り時間(無ければ null)。 */
    nextIn: (): number | null => (timers.size === 0 ? null : Math.min(...[...timers.values()].map((t) => t.at)) - now),
    /** 時間を ms 進める(途中で期限の来たタイマーを時刻順に実行する)。 */
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (let guard = 0; guard < 10_000; guard += 1) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
    /** 時間を進めずに、非同期の後始末だけを流す。 */
    flush,
  };
}

/** 好きなタイミングで解決・拒否できる Promise。 */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
