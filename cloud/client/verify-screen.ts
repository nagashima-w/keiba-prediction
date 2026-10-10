/**
 * 検証画面(`#verify`)の制御(Issue #219〈web の検証画面(1)〉)。取得・区分の切替・更新・ポーリング。DOM・fetch・タイマーは注入する(Node でテストできる)。
 * 画面ごとの状態を closure に持ち、画面を離れたら破棄する(`app.ts` が `enter`・`leave` を呼ぶ)。
 *
 *  - 開く(`enter`): `GET /api/verify?venue=all` を 1 回。他の API には出ない。区分の切替(`onVenue`)は、その区分で取り直す(サーバは 3 区分を同時にキャッシュしているので、D1 は読まない)。
 *    「更新」(`onRefresh`)は `refresh=1`(サーバの最短間隔・1 日の上限は守られる)。取得中の「更新」は無視する。
 *  - **ポーリング(画面を開いている間だけ)**: 発走時刻の補完中だけ自動で取り直す。`preparing`(集計がまだ無い。{@link VERIFY_PREPARING_POLL_MS}=3 秒)と、集計が出ていて
 *    `staleReason` が `backfilling`({@link VERIFY_BACKFILL_POLL_MS}=5 秒)。通常の集計・柵(R2・最短間隔・1 日の上限)・エラーで止まっている準備中では張らない。`setInterval` は使わない
 *    (取得が長引いても重ならない)。{@link VERIFY_MAX_POLLS} 回で止める。**非表示の間は止め**、表示に戻ったら(補完中なら)即時に 1 回取って再開する。
 *    ポーリング中の通信の失敗は前の表示を残し、{@link MAX_FAILURES} 回続いたら止める。
 *  - 世代(`gen`)と取得の通し番号(`seq`): 離れる・開き直すたびに `gen` を、取得を始めるたびに `seq` を進め、**古い応答(離れる前・区分を替える前に出したもの)は反映しない**。
 */
import { fetchVerify, verifyFetchFailureMessage, type VerifyOutcome, type VerifyVenue } from "./api-verify";
import type { FetchLike } from "./api";
import { buildVerifyModel, type VerifyLoadState, type VerifyModel } from "./verify-model";

/** 準備中(集計がまだ無い)の更新間隔。 */
export const VERIFY_PREPARING_POLL_MS = 3_000;
/** 集計はあるが補完中(backfilling)の更新間隔。 */
export const VERIFY_BACKFILL_POLL_MS = 5_000;
/** 自動更新の上限回数(最初の取得は数えない)。 */
export const VERIFY_MAX_POLLS = 200;
/** ポーリング中の通信の失敗がこの回数続いたら止める。 */
export const MAX_FAILURES = 3;

export interface VerifyScreenDeps {
  readonly fetch: FetchLike;
  readonly timers: { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };
  readonly isVisible: () => boolean;
  /** 画面の再描画の要求。 */
  readonly onChange: () => void;
}

export interface VerifyScreen {
  /** 画面に入った。まだ取っていなければ取る(重ねて呼んでも取得は増えない)。 */
  enter(): void;
  /** 画面を離れた。タイマー・状態を捨てる。 */
  leave(): void;
  /** 区分の切替。同じ区分・画面に居ないときは何もしない。 */
  onVenue(venue: VerifyVenue): void;
  /** 「更新」。取得中は無視。 */
  onRefresh(): void;
  /** 版別のキャリブレーションの開閉(Issue #220)。`open` は押したあとの状態。画面に居ないときは何もしない。取得は増えない。 */
  onVersionToggle(key: string, open: boolean): void;
  onVisibilityChange(): void;
  model(): VerifyModel;
  /** 取得中のもの(テスト用の待ち)。 */
  pending(): Promise<unknown>[];
}

/** 結果から、次の自動更新までの間隔(要らなければ null)。 */
function pollIntervalOf(outcome: VerifyOutcome): number | null {
  if (outcome.kind === "preparing") return outcome.blocked === null ? VERIFY_PREPARING_POLL_MS : null;
  if (outcome.kind === "ready" && outcome.staleReason === "backfilling") return VERIFY_BACKFILL_POLL_MS;
  return null;
}

export function createVerifyScreen(deps: VerifyScreenDeps): VerifyScreen {
  let load: VerifyLoadState | null = null; // null: 画面にいない
  let venue: VerifyVenue = "all";
  let busy = false;
  let pollStopped = false;
  let failures = 0;
  let polls = 0;
  let timer: unknown = null;
  /** キャリブレーションを開いている版のキー(Issue #220。区分の切替・更新をまたいで保つ。画面を離れたら捨てる)。 */
  const expandedVersions = new Set<string>();
  let gen = 0;
  let seq = 0;
  const inflight = new Set<Promise<unknown>>();

  function clearTimer(): void {
    if (timer !== null) {
      deps.timers.clear(timer);
      timer = null;
    }
  }

  function outcome(): VerifyOutcome | null {
    return load !== null && load.kind === "ready" ? load.outcome : null;
  }

  /** 取得の完了後に呼ぶ。補完中で、表示されていて、止めていなければ、次の取得のタイマーを張る。 */
  function schedule(): void {
    clearTimer();
    const o = outcome();
    if (load === null || o === null || pollStopped || !deps.isVisible()) return;
    const ms = pollIntervalOf(o);
    if (ms === null) return;
    if (polls >= VERIFY_MAX_POLLS) {
      pollStopped = true;
      return;
    }
    const g = gen;
    timer = deps.timers.set(() => {
      timer = null;
      if (g === gen) fetchOnce("poll", false);
    }, ms);
  }

  /** 1 回取る。`first`: 開いたとき・区分の切替・更新(失敗はエラー表示。表示は取得中の間 loading)。`poll`: 自動更新(失敗しても前の表示を残し、連続の失敗を数える)。 */
  function fetchOnce(mode: "first" | "poll", refresh: boolean): void {
    const g = gen;
    seq += 1;
    const mySeq = seq;
    busy = true;
    if (mode === "first") {
      load = { kind: "loading" };
      pollStopped = false;
      failures = 0;
      polls = 0;
      clearTimer();
      deps.onChange();
    } else {
      polls += 1;
    }
    const promise = fetchVerify(deps.fetch, venue, refresh).then((result) => {
      if (g !== gen || mySeq !== seq) return; // 離れた・開き直した・区分を替えた(古い応答)
      busy = false;
      if (result.ok) {
        load = { kind: "ready", outcome: result.outcome };
        failures = 0;
        pollStopped = false;
      } else if (mode === "first") {
        load = { kind: "error", message: verifyFetchFailureMessage(result.error) };
      } else {
        failures += 1;
        if (failures >= MAX_FAILURES) pollStopped = true;
      }
      schedule();
      deps.onChange();
    });
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise));
  }

  function enter(): void {
    if (load !== null) return;
    gen += 1;
    venue = "all";
    fetchOnce("first", false);
  }

  function leave(): void {
    gen += 1;
    seq += 1;
    clearTimer();
    load = null;
    venue = "all";
    expandedVersions.clear();
    busy = false;
    pollStopped = false;
    failures = 0;
    polls = 0;
  }

  function onVenue(next: VerifyVenue): void {
    if (load === null || next === venue) return;
    venue = next;
    fetchOnce("first", false);
  }

  function onRefresh(): void {
    if (load === null || busy || load.kind === "loading") return;
    fetchOnce("first", true);
  }

  function onVersionToggle(key: string, open: boolean): void {
    if (load === null) return;
    if (open) expandedVersions.add(key);
    else expandedVersions.delete(key);
    deps.onChange();
  }

  function onVisibilityChange(): void {
    if (load === null) return;
    if (!deps.isVisible()) {
      clearTimer();
      return;
    }
    const o = outcome();
    if (o !== null && pollIntervalOf(o) !== null && !pollStopped && !busy && timer === null) {
      fetchOnce("poll", false);
    }
  }

  return {
    enter,
    leave,
    onVenue,
    onRefresh,
    onVersionToggle,
    onVisibilityChange,
    model: () => buildVerifyModel({ load: load ?? { kind: "loading" }, venue, busy, pollStopped, expandedVersions: [...expandedVersions] }),
    pending: () => [...inflight],
  };
}
