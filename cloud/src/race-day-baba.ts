/**
 * 日単位の DO(`RaceDayCore`)の、馬場の取得の段階(Issue #294〈#293-A〉。Issue #478〈#477-B〉で、取得先を外部の API から JRA のページに替えた)。**純ロジック**: `cloudflare:workers`・`fetch`・D1 を import しない
 * (取得口・保存先・計画の事実は注入。ストレージは DO の `race_day_meta` だけ)。URL もここには来ない(取得口の中だけにある。`jra-baba-fetch.ts`)。
 *
 * ## 何をするか
 * JRA の開催日(中央の計画の行がある日)の朝に、JRA のページ(クッション値・含水率・開催情報・コースの情報)を **1 日 1 回の試みで**取得し、計測日が当日の競馬場の値を D1 に保存する。
 * 保存した値は #295 が LLM と画面に使う。新しい cron は足さない(日単位の DO のアラームの 1 候補)。取得は最大 6 本を 1.5 秒以上あけて順に取るので、1 回の起床は通常 10 秒強かかる(各本のタイムアウトは 10 秒)。
 *
 * ## いつ動くか({@link BabaStage.dueAtMs})
 * 取得口と保存先があり、開催日が固定されて計画が確定し、中央の一覧が 1 件以上あり、まだ試みていない日。
 * 期限は **09:30 JST で固定**({@link BABA_FETCH_JST}。Issue #360 で 09:00、Issue #475 で 09:30):
 *  - 7:00 ごろに計測された値がページに載るまでには遅れがある。外部の API の時代に、08:00 では載っておらず全競馬場の値を「今日ではない」として捨て(#360)、09:00 でも載っておらず前日(金曜)の値だけが返った(2026-10-24。#475)。値が載る前に取りに行かないことを優先する。
 *    JRA のページに当日の値が載る時刻は #477 が実測する。取り直しは #480。
 *  - 最初の発走前の分析の期限(発走 − 45 分で 9:05〜9:20 ごろ)が 09:30 より前の日は、その分析は値なしで進む(取得を待たない。分岐は無い)。`runNextStep` では馬場の取得がタスクより先に動くので、期限が 09:30 ちょうどの分析は値を受け取れる。
 *  - 今日(JST)が開催日と同じでなければ動かない(ページは「最新の値」しか持たない。前夜の計画の段階・過去の日には使えない)。期限は前夜のうちから候補になり、アラームが朝に起こす。
 * `runNextStep` での順序は、通知の後・タスクの前。期限が来ていれば 1 起床を使い、失敗しても次の起床でタスクがそのまま進む。
 *
 * ## 1 日 1 回({@link BabaStage.run})
 * 利用の条件は「JRA の開催日に、利用者全体で 1 日 1 回」。JRA に出る**前に**、2 つの印を書く:
 *  1. D1 の `baba_fetches` に開催日の行を INSERT する(`claim`。主キーの衝突 = 既に試みた)。DO のストレージが消えても、別のインスタンスでも守られる。
 *  2. claim に成功したら、DO の `race_day_meta` の {@link BABA_META_ATTEMPTED} を**同期で**書いてから取得する(DO は書き込みの確定まで外向きの通信を出さない)。以後の起床は D1 を引かない。
 * 取得の後は、結果が何であっても**再試行しない**(HTTP エラー・タイムアウト・形の不一致・保存の失敗も)。DO の再起動・アラームの重複・同じ日の再計画(救済)でも、印があれば動けない。
 * claim 自体の失敗(D1 が応答しない等)は、JRA にまだ何も送っていないので、{@link BabaStageDeps.maxClaimAttempts} 回まで {@link BabaStageDeps.retryDelayMs} 後に再試行し、尽きたら当日は諦める。
 *
 * ## 失敗しても分析を止めない・秘匿
 * {@link BabaStage.run} は例外を投げない(DO のアラームは例外で再実行される)。警告は固定の文と分類だけ(例外の文面・URL・応答の本文は出さない・保存しない)。
 */
import { BabaFetchError, type BabaDroppedDetail, type BabaFetcher, type BabaResultClass, type BabaVenueRecord } from "./baba-conditions";
import { startTimeEpochMs } from "./pre-race-time";
import { jstKaisaiDate } from "./auto-run-plan";
import type { SqlLike } from "./sql-like";
import type { DayBaba } from "../../packages/core/src/analyzer/day-baba";

export type { BabaFetcher };

/**
 * 取得の期限(JST の時刻)。**固定**で、最初の発走前の分析の期限には左右されない。
 * 08:00 では、外部の API(Issue #478 までの取得先)に当日 7:00 の計測値がまだ載っておらず、前日以前の値が返った(Issue #360。2 開催日とも、全競馬場を「今日ではない」として捨てた)。
 * そこで 09:00 にしたが、2026-10-24(土)の 09:00 の取得でも前日(金曜)の値しか載っていなかった(3 場とも `not-today`)。そのため Issue #475 で 09:30 にした(当日の値が載るのは 09:00 より後、遅くとも 12:57 まで、と分かっている)。
 * 値が載る前に取りに行かないことを、最初の数レースの発走前の分析(9:05〜9:20 ごろ)に間に合うことより優先する。間に合わないレースは、値なしで分析する(従来どおり)。
 */
export const BABA_FETCH_JST = "09:30";

/** DO の meta のキー: 試みた時刻(エポックミリ秒)。**あれば二度と取得しない**(JRA に出る前に書く)。 */
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
  /** 捨てた競馬場の理由と計測日時の文字列(診断用。`baba_fetches.dropped_json`)。失敗の分類のときは空。 */
  readonly droppedDetails: readonly BabaDroppedDetail[];
}

/**
 * 保存先(本番は D1。`baba-repository.ts`)。
 *  - `claim`: 試みを先に記録する。行を作れたら `claimed`、既にあれば `exists`。失敗は投げる(まだ JRA に出ていない)。
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
}

export interface BabaStageDeps {
  readonly sql: SqlLike;
  readonly now: () => number;
  /** 取得口(本番は常にある。無ければ機能全体が止まる〈印も書かない〉のはテスト用)。 */
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
    let due = startTimeEpochMs(facts.kaisaiDate, BABA_FETCH_JST);
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

    // 1. 試みを先に記録する(D1)。ここまでは JRA に何も送っていないので、失敗は再試行してよい。
    let claim: "claimed" | "exists";
    try {
      claim = await store.claim(date, startedAt);
    } catch {
      const tries = Number(this.metaGet(BABA_META_CLAIM_TRIES) ?? 0) + 1;
      this.metaSet(BABA_META_CLAIM_TRIES, String(tries));
      if (tries >= this.deps.maxClaimAttempts) {
        this.metaSet(BABA_META_ATTEMPTED, String(startedAt));
        this.metaSet(BABA_META_RESULT, "claim-failed");
        this.deps.onWarn(`馬場の取得: 試みの記録(D1)に失敗し続けたため、この日(${date})は取得しません(試行 ${tries} 回。JRA には送っていません)`);
        return outcome("failed", date);
      }
      this.metaSet(BABA_META_RETRY_AT, String(startedAt + this.deps.retryDelayMs));
      this.deps.onWarn(`馬場の取得: 試みの記録(D1)に失敗しました(試行 ${tries} 回。JRA には送っていません。再試行します)`);
      return outcome("retry", date);
    }

    // 2. DO の印を、同期で、JRA に出る前に書く。既に試みた日(exists)も印を書いて終わる。
    this.metaSet(BABA_META_ATTEMPTED, String(startedAt));
    if (claim === "exists") {
      this.metaSet(BABA_META_RESULT, "exists");
      return outcome("failed", date);
    }

    // 3. 取得(JRA のページを読んだ結果が返る)。取得口は投げないが、どんな例外でも分類だけを残す(文面・URL・本文は読まない・残さない)。
    let result: BabaResultClass;
    let venues: readonly BabaVenueRecord[] = [];
    let dropped = 0;
    let droppedDetails: readonly BabaDroppedDetail[] = [];
    let apiFetchedAt: string | null = null;
    try {
      const fetched = await fetcher(this.deps.now());
      result = fetched.result;
      venues = fetched.venues;
      dropped = fetched.dropped;
      droppedDetails = fetched.droppedDetails;
      apiFetchedAt = fetched.apiFetchedAt;
    } catch (error) {
      result = error instanceof BabaFetchError ? error.result : "other";
    }
    this.metaSet(BABA_META_RESULT, result);

    // 4. 結果の記録。失敗しても再試行しない(JRA への取得は既に使った)。
    let saved = true;
    try {
      await store.finish(date, { finishedAt: this.deps.now(), result, apiFetchedAt, venues, dropped, droppedDetails });
    } catch {
      saved = false;
      this.deps.onWarn(`馬場の取得: 結果(${result})を D1 に保存できませんでした(この日(${date})は再取得しません)`);
    }
    if (result !== "ok") {
      this.deps.onWarn(`馬場の取得: 値を取得できませんでした(この日(${date})は再試行しません。分類: ${result})`);
    }
    return outcome(result === "ok" && saved ? "ok" : "failed", date);
  }
}
