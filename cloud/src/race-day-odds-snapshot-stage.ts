/**
 * 発走 5 分前の単勝・複勝の全頭のオッズの記録の段(Issue #732)。`RaceDayCore.runNextStep` が、時刻が来た予定の行を 1 つずつ渡す。定数・型・DO の表は `race-day-odds-snapshot.ts`。
 * **純ロジック**: `cloudflare:workers` を import しない。時計・警告の出口・保存先・JRA の取得口・取得キャッシュは注入(`setAlarm` 系には触れない。状態を必ず変えるので、張り直しは本体の `armAlarm`)。
 *
 * ## 1 ステップ(1 レース・1 時点〈発走の 10 分前か 5 分前〉の 1 回ぶん)
 *  1. 最初に動いた時刻を永続化。
 *  2. DO に結果(`payload_json`)があれば取り直さずに 4 へ。無ければ 3 で決める。
 *  3. その時点の取得が意味を持つ最後の時刻(5 分前は発走、10 分前は 5 分前の時刻。`oddsSnapshotSupersedeMs`)以降なら JRA に出ず skipped(`too-late`)。そうでなければ JRA の単勝・複勝の頁を 1 本取る(`JraOddsStage` を、メモリ上の進み具合で使う。締切の再計算と同じ部品。
 *     場・レースのリンクは取得キャッシュから読み、無ければ開催選択 → レース選択をたどる)。取得キャッシュに置いた JSON(**この起床より前のものは使わない**)から全頭の値を作る。
 *     取れなかったら、試行が {@link ODDS_SNAPSHOT_FETCH_MAX_ATTEMPTS} 未満で、再試行の時刻がその最後の時刻より前のときだけ {@link ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS} 後に再試行。それ以外は failed(`fetch-failed`)。
 *     結果は**保存の前に** DO に書く。
 *  4. D1 に保存(先着の INSERT なので再保存は無害)。失敗したら {@link ODDS_SNAPSHOT_SAVE_MAX_ATTEMPTS} まで {@link ODDS_SNAPSHOT_SAVE_RETRY_DELAY_MS} 後に再試行し、尽きたら abandoned(警告だけ残す)。
 * 例外は投げない。警告は固定の語と race_id だけ(URL・cname・本文・例外の文面は出さない。例外の文面は鍵を伏せて 200 文字まで)。通知はしない。
 *
 * JRA への出方: 1 レースにつき頁 1 本(リンクが取得キャッシュに無い最初のレースだけ、開催選択とレース選択の 2 本が足される)。間隔は注入の取得口(DO では他の JRA の取得と共有の `createJraPacer`)が守る。
 */
import { redactSecrets } from "./llm-run";
import { createJraOddsOverride, jraOddsCacheKey } from "./jra-odds-cache";
import type { JraOddsFetcher } from "./jra-odds-fetch";
import type { OddsSnapshotSink } from "./odds-snapshot-repository";
import { MemoryJraOddsStageStore } from "./race-day-jra-odds";
import { JraOddsStage, type JraOddsStageCache } from "./race-day-jra-odds-stage";
import {
  horsesOfSnapshot,
  ODDS_SNAPSHOT_FETCH_MAX_ATTEMPTS,
  ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS,
  ODDS_SNAPSHOT_SAVE_MAX_ATTEMPTS,
  ODDS_SNAPSHOT_SAVE_RETRY_DELAY_MS,
  oddsSnapshotSupersedeMs,
  parseOddsSnapshotPayload,
  type OddsSnapshotPayload,
  type OddsSnapshotReason,
  type OddsSnapshotStore,
  type OddsSnapshotTaskRow,
} from "./race-day-odds-snapshot";
import { errorMessage } from "./race-day-support";

/** 1 ステップの結果(`StepOutcome` の 1 種)。`ok` = 取れて D1 に保存した / `retry` = 取得か保存の再試行待ち / `failed` = 取れなかった・取らなかった(D1 に failed・skipped の行を保存した。保存を諦めた場合も)。`reason` は D1 に書いた固定の理由(`ok`・`retry` は null)。 */
export interface OddsSnapshotStepOutcome {
  readonly kind: "ran";
  readonly raceId: string;
  /** 時点(発走の何分前の予定か)。 */
  readonly leadMin: 10 | 5;
  readonly mode: "odds-snapshot";
  readonly step: "record";
  readonly result: "ok" | "retry" | "failed";
  readonly reason: OddsSnapshotReason | null;
}

export interface OddsSnapshotStageDeps {
  /** 予定の表(本体も同じものを持つ: アラームの候補)。 */
  readonly store: OddsSnapshotStore;
  readonly now: () => number;
  /** 警告の出口(本体の `onWarn`)。 */
  readonly onWarn: (message: string) => void;
  /** D1 への保存口。 */
  readonly sink: OddsSnapshotSink;
  /** JRA のオッズの取得口(DO では馬場の取得口と間隔の部品を共有)。 */
  readonly fetcher: JraOddsFetcher;
  /** 取得キャッシュ(`fetch_cache`)。リンクの読み書きと、頁の JSON の置き場(発走前の分析・締切の再計算と同じキー `jra-odds:<raceId>:tanpuku`)。 */
  readonly cache: JraOddsStageCache;
  /** 固定の語のログ(所要時間・本数)。 */
  readonly onInfo?: (message: string) => void;
}

/** 取得キャッシュの JSON から、馬番 → 馬の ID を読む(形が違えば空)。 */
function horseIdsOf(json: string): Record<number, string> {
  try {
    const ids = (JSON.parse(json) as { horseIds?: unknown }).horseIds;
    if (typeof ids !== "object" || ids === null) {
      return {};
    }
    return Object.fromEntries(Object.entries(ids).filter(([k, v]) => /^\d{1,2}$/.test(k) && typeof v === "string" && /^\d{10}$/.test(v))) as Record<number, string>;
  } catch {
    return {};
  }
}

export class OddsSnapshotStage {
  private readonly store: OddsSnapshotStore;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;
  private readonly sink: OddsSnapshotSink;
  private readonly fetcher: JraOddsFetcher;
  private readonly cache: JraOddsStageCache;
  private readonly onInfo: ((message: string) => void) | undefined;

  constructor(deps: OddsSnapshotStageDeps) {
    this.store = deps.store;
    this.now = deps.now;
    this.onWarn = deps.onWarn;
    this.sink = deps.sink;
    this.fetcher = deps.fetcher;
    this.cache = deps.cache;
    this.onInfo = deps.onInfo;
  }

  /**
   * 予定(10 分前・5 分前の 2 行)を積む(計画の確定の同期区間から呼ぶ。中央のレースごと)。発走を過ぎていれば積まない(false)。**失敗は握って警告にする**(計画の確定を止めない)。
   * 既にある行は変えない(確定の再実行・救済で巻き戻さない)。
   */
  register(raceId: string, kaisaiDate: string, startMs: number): boolean {
    try {
      return this.store.register({ raceId, kaisaiDate, startMs, now: this.now() });
    } catch (error) {
      this.onWarn(`発走前のオッズの記録の予定を積めませんでした(${raceId})。計画は続けます: ${redactSecrets(errorMessage(error)).slice(0, 200)}`);
      return false;
    }
  }

  /** 1 レースの 1 回ぶん。例外は投げない。 */
  async runStep(row: OddsSnapshotTaskRow): Promise<OddsSnapshotStepOutcome> {
    const raceId = row.race_id;
    const leadMin = row.lead_min;
    const now = this.now();
    this.store.markFired(raceId, leadMin, now);
    const outcome = (result: "ok" | "retry" | "failed", reason: OddsSnapshotReason | null): OddsSnapshotStepOutcome => ({ kind: "ran", raceId, leadMin, mode: "odds-snapshot", step: "record", result, reason });

    let payload = row.payload_json === null ? null : parseOddsSnapshotPayload(row.payload_json);
    if (payload === null) {
      const computed = await this.compute(row, now);
      if (computed.kind === "retry") {
        this.store.markFetchRetry(raceId, leadMin, computed.attempts, computed.nextTryAt);
        return outcome("retry", null);
      }
      payload = computed.payload;
      this.store.setAttempts(raceId, leadMin, payload.attempts);
      this.store.setPayload(raceId, leadMin, JSON.stringify(payload));
      if (payload.status !== "ok") {
        this.onWarn(`発走前のオッズを記録できませんでした(${raceId}。${leadMin} 分前): ${payload.status} ${payload.reason ?? ""}`);
      }
    }
    try {
      await this.sink.save(payload);
    } catch (error) {
      const saveAttempts = row.save_attempts + 1;
      if (saveAttempts >= ODDS_SNAPSHOT_SAVE_MAX_ATTEMPTS) {
        this.store.markAbandoned(raceId, leadMin, saveAttempts);
        this.onWarn(`発走前のオッズの保存を諦めました(${raceId}。${leadMin} 分前。試行 ${saveAttempts} 回): ${redactSecrets(errorMessage(error)).slice(0, 200)}`);
        return outcome("failed", payload.reason);
      }
      this.store.markSaveRetry(raceId, leadMin, saveAttempts, now + ODDS_SNAPSHOT_SAVE_RETRY_DELAY_MS);
      return outcome("retry", null);
    }
    this.store.markDone(raceId, leadMin);
    return payload.status === "ok" ? outcome("ok", null) : outcome("failed", payload.reason);
  }

  /** 結果を決める(取得、または行わない・失敗の判断)。 */
  private async compute(
    row: OddsSnapshotTaskRow,
    now: number,
  ): Promise<{ readonly kind: "payload"; readonly payload: OddsSnapshotPayload } | { readonly kind: "retry"; readonly attempts: number; readonly nextTryAt: number }> {
    const base = { raceId: row.race_id, leadMin: row.lead_min, kaisaiDate: row.kaisai_date, startMs: row.start_ms, dueMs: row.due_ms };
    const empty = { takenAtMs: now, officialDatetime: null, oddsStatus: null, horses: null };
    // この時点の取得が意味を持つ最後の時刻(10 分前は 5 分前の時刻、5 分前は発走)以降に起きた(積んだあとの遅れ)。取りに行かない。
    const supersedeAt = oddsSnapshotSupersedeMs(row.start_ms, row.lead_min);
    if (now >= supersedeAt) {
      return { kind: "payload", payload: { ...base, ...empty, status: "skipped", reason: "too-late", attempts: row.attempts } };
    }
    const attempts = row.attempts + 1;
    const startedAt = now;
    const page = await this.fetchPage(row, startedAt, supersedeAt);
    if (page !== null) {
      return { kind: "payload", payload: { ...base, ...page, status: "ok", reason: null, attempts } };
    }
    const failedAt = this.now();
    const retryAt = failedAt + ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS;
    if (attempts < ODDS_SNAPSHOT_FETCH_MAX_ATTEMPTS && retryAt < supersedeAt) {
      return { kind: "retry", attempts, nextTryAt: retryAt };
    }
    return { kind: "payload", payload: { ...base, ...empty, takenAtMs: failedAt, status: "failed", reason: "fetch-failed", attempts } };
  }

  /** 頁を 1 本取って全頭の値を返す。取れなかった・読めなかったときは null(投げない)。 */
  private async fetchPage(
    row: OddsSnapshotTaskRow,
    startedAt: number,
    stopAt: number,
  ): Promise<{ readonly takenAtMs: number; readonly officialDatetime: string | null; readonly oddsStatus: string; readonly horses: NonNullable<OddsSnapshotPayload["horses"]> } | null> {
    try {
      const stage = new JraOddsStage({
        store: new MemoryJraOddsStageStore(["tanpuku"]),
        fetcher: this.fetcher,
        cache: this.cache,
        now: this.now,
        onWarn: this.onWarn,
        onInfo: this.onInfo,
      });
      await stage.run(row.race_id, 0, row.kaisai_date, { stopAt });
      const entry = this.cache.get(jraOddsCacheKey(row.race_id, "tanpuku"));
      if (entry === undefined || entry.fetchedAt < startedAt) {
        return null; // 取れていない(古い JSON は、取れなかった記録の代わりに使わない)
      }
      const snapshot = await createJraOddsOverride({ cache: this.cache, raceId: row.race_id, oddsSince: startedAt }).winPlace!();
      if (snapshot === null || Object.keys(snapshot.win).length === 0) {
        return null;
      }
      return { takenAtMs: entry.fetchedAt, officialDatetime: snapshot.officialDatetime, oddsStatus: snapshot.oddsStatus, horses: horsesOfSnapshot(snapshot, horseIdsOf(entry.value)) };
    } catch {
      return null; // 文面は残さない(URL・cname が入りうる)
    }
  }
}
