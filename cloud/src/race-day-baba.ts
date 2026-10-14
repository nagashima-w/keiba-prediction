/**
 * 日単位の DO(`RaceDayCore`)の、馬場の API の取得の段階(Issue #294〈#293-A〉)。**純ロジック**: `cloudflare:workers`・`fetch`・D1 を import しない
 * (取得口・保存先・計画の事実は注入。ストレージは DO の `race_day_meta` だけ)。URL もここには来ない(取得口のクロージャの中にだけある。`baba-fetch.ts`)。
 *
 * ## 何をするか
 * JRA の開催日(中央の計画の行がある日)の朝に、外部の馬場の API(JRA の競馬場の最新の馬場状態)を **1 回だけ**取得し、計測日が当日の競馬場の値を D1 に保存する。
 * 保存した値は #295 が LLM と画面に使う。新しい cron は足さない(日単位の DO のアラームの 1 候補)。
 *
 * ## いつ動くか({@link BabaStage.dueAtMs})
 * 取得口と保存先があり(secret が有効)、開催日が固定されて計画が確定し、中央の一覧が 1 件以上あり、まだ試みていない日。
 * 期限は `max(07:30, min(08:00, 最初の中央の発走前の分析の期限))`(JST):
 *  - 7:00 ごろに計測された値が API に載るまでの遅れが分からないので、通常は 08:00(最初の発走前の分析の期限〈発走 − 45 分〉は 9:15 前後で、それより前)。
 *  - offset が大きい日は、最初の発走前の分析の期限より後ろにならないよう、その期限に合わせる。ただし 07:30 を下限にする(計測の前に取りに行かない)。
 *  - 今日(JST)が開催日と同じでなければ動かない(API は「最新の値」しか返さない。前夜の計画の段階・過去の日には使えない)。期限は前夜のうちから候補になり、アラームが朝に起こす。
 * `runNextStep` での順序は、通知の後・タスクの前。期限が来ていれば 1 起床(上限はタイムアウトの 10 秒)を使い、失敗しても次の起床でタスクがそのまま進む。
 *
 * ## 1 日 1 回({@link BabaStage.run})
 * 利用の条件は「JRA の開催日に、利用者全体で 1 日 1 回」。API に出る**前に**、2 つの印を書く:
 *  1. D1 の `baba_fetches` に開催日の行を INSERT する(`claim`。主キーの衝突 = 既に試みた)。DO のストレージが消えても、別のインスタンスでも守られる。
 *  2. claim に成功したら、DO の `race_day_meta` の {@link BABA_META_ATTEMPTED} を**同期で**書いてから取得する(DO は書き込みの確定まで外向きの通信を出さない)。以後の起床は D1 を引かない。
 * 取得の後は、結果が何であっても**再試行しない**(HTTP エラー・タイムアウト・形の不一致・保存の失敗も)。DO の再起動・アラームの重複・同じ日の再計画(救済)でも、印があれば動けない。
 * claim 自体の失敗(D1 が応答しない等)は、API にまだ何も送っていないので、{@link BabaStageDeps.maxClaimAttempts} 回まで {@link BabaStageDeps.retryDelayMs} 後に再試行し、尽きたら当日は諦める。
 *
 * ## 失敗しても分析を止めない・秘匿
 * {@link BabaStage.run} は例外を投げない(DO のアラームは例外で再実行される)。警告は固定の文と分類だけ(例外の文面・URL・応答の本文は出さない・保存しない)。
 */
import { BabaFetchError, parseBabaResponse, type BabaFetcher, type BabaResultClass, type BabaVenueRecord } from "./baba-conditions";
import { startTimeEpochMs } from "./pre-race-time";
import { jstKaisaiDate } from "./auto-run-plan";
import type { SqlLike } from "./sql-like";
import type { DayBaba } from "../../packages/core/src/analyzer/day-baba";

export type { BabaFetcher };

/** 取得の期限の下限(JST の時刻)。7:00 ごろの計測の前に取りに行かない。 */
export const BABA_EARLIEST_JST = "07:30";
/** 取得の期限の既定(JST の時刻)。最初の発走前の分析の期限が遅いときの期限。 */
export const BABA_DEFAULT_JST = "08:00";

/** DO の meta のキー: 試みた時刻(エポックミリ秒)。**あれば二度と取得しない**(API に出る前に書く)。 */
export const BABA_META_ATTEMPTED = "baba_attempted_at";
/** DO の meta のキー: claim の失敗の回数。 */
export const BABA_META_CLAIM_TRIES = "baba_claim_tries";
/** DO の meta のキー: claim の再試行の時刻(エポックミリ秒)。 */
export const BABA_META_RETRY_AT = "baba_retry_at";
/** DO の meta のキー: 結果の分類(観測用)。 */
export const BABA_META_RESULT = "baba_result";

/** 結果の記録(D1 の `baba_fetches` の更新と `baba_conditions` の行)。 */
export interface BabaFinish {
  readonly finishedAt: number;
  readonly result: BabaResultClass;
  readonly apiFetchedAt: string | null;
  readonly venues: readonly BabaVenueRecord[];
  /** 捨てた競馬場の件数。 */
  readonly dropped: number;
}

/**
 * 保存先(本番は D1。`baba-repository.ts`)。
 *  - `claim`: 試みを先に記録する。行を作れたら `claimed`、既にあれば `exists`。失敗は投げる(まだ API に出ていない)。
 *  - `finish`: 結果の分類と競馬場の行を書く。失敗は投げる(呼び出し側は警告にして、再試行しない)。
 */
export interface BabaStore {
  claim(kaisaiDate: string, attemptedAt: number): Promise<"claimed" | "exists">;
  finish(kaisaiDate: string, finish: BabaFinish): Promise<void>;
}

/**
 * 貯めた当日の馬場の値の読み出し口(Issue #295。本番は `D1BabaStore.load`)。発走前の分析が、そのレースの開催日 × 場コードの値を読む。
 * 行が無ければ null。失敗は投げる(呼び出し側が握って値なしで続ける)。取得の段階(`BabaStore`)とは独立。
 */
export interface BabaReader {
  load(kaisaiDate: string, venueCode: string): Promise<DayBaba | null>;
}

/** 計画の事実(`RaceDayCore` が計画の表から作る)。 */
export interface BabaFacts {
  /** DO が固定された開催日(YYYYMMDD)。未確定は null。 */
  readonly kaisaiDate: string | null;
  readonly planFinalized: boolean;
  /** 中央の一覧が取得できて 1 件以上ある(= JRA の開催日)。 */
  readonly centralListed: boolean;
  /** 中央の計画の行のうち、最も早い発走前の分析の期限(エポックミリ秒)。無ければ null。 */
  readonly firstCentralDueMs: number | null;
}

export interface BabaStageDeps {
  readonly sql: SqlLike;
  readonly now: () => number;
  /** 取得口。無ければ(secret が未登録・形式不正)、機能全体が止まる(印も書かない)。 */
  readonly fetcher: BabaFetcher | undefined;
  readonly store: BabaStore | undefined;
  readonly onWarn: (message: string) => void;
  readonly facts: () => BabaFacts;
  /** claim の失敗の再試行の間隔(ミリ秒)。 */
  readonly retryDelayMs: number;
  /** claim の試行回数の上限。 */
  readonly maxClaimAttempts: number;
}

/** 取得ステップの結果(`StepOutcome` の 1 種)。`raceId` は開催日。 */
export interface BabaStepOutcome {
  readonly kind: "ran";
  readonly raceId: string;
  readonly mode: "baba";
  readonly step: "fetch";
  readonly result: "ok" | "retry" | "failed";
}

export class BabaStage {
  private inFlight = false;

  constructor(private readonly deps: BabaStageDeps) {}

  private metaGet(key: string): string | null {
    const rows = this.deps.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
    return rows[0]?.value ?? null;
  }

  private metaSet(key: string, value: string): void {
    this.deps.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /**
   * 取得の期限(アラームの候補。エポックミリ秒)。動けない構成・状態なら null(候補にしない)。
   * 前夜のうちから(翌朝の期限で)候補になる。今日が開催日より後なら null。試みの印があれば null(取得の後に候補が残って、即時のアラームが続かない)。
   */
  dueAtMs(): number | null {
    const { fetcher, store } = this.deps;
    if (fetcher === undefined || store === undefined) {
      return null;
    }
    const facts = this.deps.facts();
    if (facts.kaisaiDate === null || !facts.planFinalized || !facts.centralListed) {
      return null;
    }
    if (this.metaGet(BABA_META_ATTEMPTED) !== null) {
      return null;
    }
    if (jstKaisaiDate(this.deps.now()) > facts.kaisaiDate) {
      return null;
    }
    const floor = startTimeEpochMs(facts.kaisaiDate, BABA_EARLIEST_JST);
    const fallback = startTimeEpochMs(facts.kaisaiDate, BABA_DEFAULT_JST);
    let due = Math.max(floor, Math.min(fallback, facts.firstCentralDueMs ?? fallback));
    const retryAt = this.metaGet(BABA_META_RETRY_AT);
    if (retryAt !== null) {
      due = Math.max(due, Number(retryAt));
    }
    return due;
  }

  /** いま動けるか: 実行中でなく、期限が来ていて、今日(JST)が開催日。 */
  runnable(): boolean {
    if (this.inFlight) {
      return false;
    }
    const due = this.dueAtMs();
    const facts = this.deps.facts();
    return due !== null && this.deps.now() >= due && jstKaisaiDate(this.deps.now()) === facts.kaisaiDate;
  }

  /**
   * 取得を 1 回だけ行う。動けないときは何もしない(`retry`)。**例外を投げない。** 手順は冒頭の「1 日 1 回」。
   * どの経路でも状態(試みの印・再試行の時刻)が変わる(アラームの候補が残って即時に起き続けない)。
   */
  async run(): Promise<BabaStepOutcome> {
    const outcome = (result: BabaStepOutcome["result"], date: string): BabaStepOutcome => ({ kind: "ran", raceId: date, mode: "baba", step: "fetch", result });
    if (!this.runnable()) {
      return outcome("retry", this.deps.facts().kaisaiDate ?? "");
    }
    this.inFlight = true;
    try {
      return await this.runOnce(outcome);
    } finally {
      this.inFlight = false;
    }
  }

  private async runOnce(outcome: (result: BabaStepOutcome["result"], date: string) => BabaStepOutcome): Promise<BabaStepOutcome> {
    const date = this.deps.facts().kaisaiDate as string;
    const fetcher = this.deps.fetcher as BabaFetcher;
    const store = this.deps.store as BabaStore;
    const startedAt = this.deps.now();

    // 1. 試みを先に記録する(D1)。ここまでは API に何も送っていないので、失敗は再試行してよい。
    let claim: "claimed" | "exists";
    try {
      claim = await store.claim(date, startedAt);
    } catch {
      const tries = Number(this.metaGet(BABA_META_CLAIM_TRIES) ?? 0) + 1;
      this.metaSet(BABA_META_CLAIM_TRIES, String(tries));
      if (tries >= this.deps.maxClaimAttempts) {
        this.metaSet(BABA_META_ATTEMPTED, String(startedAt));
        this.metaSet(BABA_META_RESULT, "claim-failed");
        this.deps.onWarn(`馬場の API: 試みの記録(D1)に失敗し続けたため、この日(${date})は取得しません(試行 ${tries} 回。API には送っていません)`);
        return outcome("failed", date);
      }
      this.metaSet(BABA_META_RETRY_AT, String(startedAt + this.deps.retryDelayMs));
      this.deps.onWarn(`馬場の API: 試みの記録(D1)に失敗しました(試行 ${tries} 回。API には送っていません。再試行します)`);
      return outcome("retry", date);
    }

    // 2. DO の印を、同期で、API に出る前に書く。既に試みた日(exists)も印を書いて終わる。
    this.metaSet(BABA_META_ATTEMPTED, String(startedAt));
    if (claim === "exists") {
      this.metaSet(BABA_META_RESULT, "exists");
      return outcome("failed", date);
    }

    // 3. 取得 → 解析。どんな例外でも分類だけを残す(文面・URL・本文は読まない・残さない)。
    let result: BabaResultClass;
    let venues: readonly BabaVenueRecord[] = [];
    let dropped = 0;
    let apiFetchedAt: string | null = null;
    try {
      const text = await fetcher();
      const parsed = parseBabaResponse(text, this.deps.now());
      result = parsed.result;
      venues = parsed.venues;
      dropped = parsed.dropped;
      apiFetchedAt = parsed.apiFetchedAt;
    } catch (error) {
      result = error instanceof BabaFetchError ? error.result : "other";
    }
    this.metaSet(BABA_META_RESULT, result);

    // 4. 結果の記録。失敗しても再試行しない(API は既に使った)。
    let saved = true;
    try {
      await store.finish(date, { finishedAt: this.deps.now(), result, apiFetchedAt, venues, dropped });
    } catch {
      saved = false;
      this.deps.onWarn(`馬場の API: 結果(${result})を D1 に保存できませんでした(この日(${date})は再取得しません)`);
    }
    if (result !== "ok") {
      this.deps.onWarn(`馬場の API: 値を取得できませんでした(この日(${date})は再試行しません。分類: ${result})`);
    }
    return outcome(result === "ok" && saved ? "ok" : "failed", date);
  }
}
