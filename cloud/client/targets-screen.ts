/**
 * 今日の狙い目の画面(`#targets`。Issue #336)の制御。取得・時計の更新・取り直し。DOM・fetch・タイマー・時計は注入する(Node でテストできる)。
 * 画面ごとの状態を closure に持ち、画面を離れたら破棄する(`app.ts` が `enter`・`leave` を呼ぶ)。`verify-screen.ts` と同じ流儀。
 *
 *  - 開く(`enter`): `GET /api/targets` を 1 回(D1 の読み取りだけ。R2・netkeiba には出ない)。同じ日で重ねて呼んでも取得は増えない。「更新」(`onRefresh`)は取り直し(取得中は無視)。
 *  - **残り時間は取得なしで更新する**: {@link TARGETS_TICK_MS}(30 秒)ごとに再描画だけ行う(`setInterval` は使わない。`setTimeout` の連鎖)。「今」は端末の時計を、取得時のサーバの時刻(`now_ms`)で補正した値。
 *  - **取り直し(自動)は {@link TARGETS_POLL_MS}(3 分)ごと**。次のすべてを満たすときだけ: 画面が見えている・開催日が今日(JST)・前回の取得に成功している・
 *    発走前のレースが残っている(または、まだ 1 件も分析されていない=これから増える)・自動の取り直しが {@link TARGETS_MAX_POLLS} 回未満・通信の失敗が {@link MAX_FAILURES} 回続いていない。
 *    止まった状態は、「更新」(回数と失敗を数え直す)と、画面が見えるようになったとき(最後の取得から {@link RETURN_STALE_MS} 以上なら取り直す)で動き出す。
 *    1 回の取得は D1 を数千行読む(`targets-repository.ts`)ので、Free の 1 日の読み取り行数のために、間隔・回数・止める条件を持つ。
 *  - 取り直しの失敗は前の表示を残す(注記だけ出す)。最初の取得の失敗はエラー表示(固定の文言)で、自動では再試行しない。
 *  - 世代(`gen`)と取得の通し番号(`seq`): 離れる・開き直すたびに `gen` を、取得を始めるたびに `seq` を進め、古い応答は反映しない。
 */
import { failureMessage } from "./api";
import { fetchTargets, type TargetsData } from "./api-targets";
import { buildTargetsModel, type TargetsModel } from "./targets-model";

/** 残り時間の再描画の間隔(取得はしない)。 */
export const TARGETS_TICK_MS = 30_000;
/** 自動の取り直しの間隔。 */
export const TARGETS_POLL_MS = 180_000;
/** 自動の取り直しの上限回数(画面を開いてから、または「更新」から数える)。3 分 × 120 回 = 6 時間。 */
export const TARGETS_MAX_POLLS = 120;
/** 自動の取り直しの失敗がこの回数続いたら止める。 */
export const MAX_FAILURES = 3;
/** 画面が見えるようになったとき、最後の取得からこれ以上たっていれば取り直す。 */
export const RETURN_STALE_MS = 60_000;

export interface TargetsScreenDeps {
  readonly fetch: Parameters<typeof fetchTargets>[0];
  /** 端末の現在時刻(UTC のエポックミリ秒)。 */
  readonly now: () => number;
  readonly timers: { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };
  readonly isVisible: () => boolean;
  /** JST の今日(YYYYMMDD)。今日でない日は自動で取り直さない。 */
  readonly today: () => string;
  /** 画面の再描画の要求。 */
  readonly onChange: () => void;
}

export interface TargetsScreen {
  /** 画面に入った。同じ日で既に開いていれば何もしない。 */
  enter(date: string): void;
  /** 画面を離れた。タイマー・状態を捨てる。 */
  leave(): void;
  /** 「更新」。取得中・画面に居ないときは無視。 */
  onRefresh(): void;
  onVisibilityChange(): void;
  /** 画面に居ないとき null。 */
  model(): TargetsModel | null;
  /** 取得中のもの(テスト用の待ち)。 */
  pending(): Promise<unknown>[];
}

export function createTargetsScreen(deps: TargetsScreenDeps): TargetsScreen {
  let date: string | null = null;
  let data: TargetsData | null = null;
  let error: string | null = null;
  /** 端末の時計に足すと、サーバの時刻になる値。 */
  let offset = 0;
  let busy = false;
  let polls = 0;
  let failures = 0;
  let fetchedAt = 0;
  let timer: unknown = null;
  let gen = 0;
  let seq = 0;
  const inflight = new Set<Promise<unknown>>();

  const nowMs = (): number => deps.now() + offset;

  function clearTimer(): void {
    if (timer !== null) {
      deps.timers.clear(timer);
      timer = null;
    }
  }

  /** 次の再描画のタイマーを張る(画面に居て、見えているときだけ)。 */
  function schedule(): void {
    clearTimer();
    if (date === null || !deps.isVisible()) return;
    timer = deps.timers.set(tick, TARGETS_TICK_MS);
  }

  function shouldPoll(): boolean {
    if (date === null || data === null || busy || !deps.isVisible() || date !== deps.today()) return false;
    if (polls >= TARGETS_MAX_POLLS || failures >= MAX_FAILURES || deps.now() - fetchedAt < TARGETS_POLL_MS) return false;
    const now = nowMs();
    return data.races.length === 0 || data.races.some((r) => r.startMs !== null && r.startMs > now);
  }

  function tick(): void {
    timer = null;
    if (date === null) return;
    deps.onChange();
    if (shouldPoll()) fetchOnce(true);
    else schedule();
  }

  /** 1 回取る。`auto`: 自動の取り直し(回数と連続の失敗を数える)。手動(開いたとき・「更新」)は数え直す。 */
  function fetchOnce(auto: boolean): void {
    if (date === null) return;
    const target = date;
    const g = gen;
    seq += 1;
    const mySeq = seq;
    busy = true;
    clearTimer();
    if (auto) polls += 1;
    else {
      polls = 0;
      failures = 0;
    }
    deps.onChange();
    const p: Promise<unknown> = fetchTargets(deps.fetch, target).then((result) => {
      inflight.delete(p);
      if (g !== gen || mySeq !== seq) return; // 離れた・開き直した(古い応答)
      busy = false;
      fetchedAt = deps.now();
      if (result.ok) {
        data = result.data;
        offset = result.data.nowMs - fetchedAt;
        error = null;
        failures = 0;
      } else {
        error = failureMessage(result.error);
        if (auto) failures += 1;
      }
      deps.onChange();
      schedule();
    });
    inflight.add(p);
  }

  return {
    enter(next) {
      if (date === next) return;
      date = next;
      gen += 1;
      data = null;
      error = null;
      offset = 0;
      busy = false;
      fetchOnce(false);
    },
    leave() {
      clearTimer();
      date = null;
      data = null;
      error = null;
      busy = false;
      gen += 1;
    },
    onRefresh() {
      if (date !== null && !busy) fetchOnce(false);
    },
    onVisibilityChange() {
      if (date === null) return;
      if (!deps.isVisible()) {
        clearTimer();
        return;
      }
      deps.onChange(); // 隠れている間に進んだ残り時間を、すぐ描き直す
      if (!busy && data !== null && date === deps.today() && deps.now() - fetchedAt >= RETURN_STALE_MS) fetchOnce(true);
      else schedule();
    },
    model() {
      return date === null ? null : buildTargetsModel({ date, data, error, loading: busy, nowMs: nowMs() });
    },
    pending() {
      return [...inflight];
    },
  };
}
