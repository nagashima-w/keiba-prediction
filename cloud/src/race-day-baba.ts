/**
 * 日単位の DO(`RaceDayCore`)の、馬場の取得の段階(Issue #294〈#293-A〉。Issue #478〈#477-B〉で、取得先を外部の API から JRA のページに替えた。Issue #480〈#477-D〉で、当日の値がそろうまで取り直す形にした)。
 * **純ロジック**: `cloudflare:workers`・`fetch`・D1 を import しない(取得口・保存先・計画の事実は注入。ストレージは DO の `race_day_meta` だけ)。URL もここには来ない(取得口の中だけにある。`jra-baba-fetch.ts`)。
 *
 * ## 何をするか
 * JRA の開催日(中央の計画の行がある日)の朝に、JRA のページ(クッション値・含水率・開催情報・コースの情報)を取得し、計測日が当日の競馬場の値を D1 に保存する。
 * **当日の値がそろうまで、15 分おきに取り直す**(枠。{@link BABA_FETCH_START_JST} から {@link BABA_FETCH_INTERVAL_MIN} 分おき、{@link BABA_FETCH_LAST_JST} の枠まで。置き値で、10/31 の実測の後に見直す)。
 * 保存した値は #295 が LLM と画面に使う。新しい cron は足さない(日単位の DO のアラームの 1 候補)。
 * 1 回の取得は、当日の値が無ければクッション値と含水率の 2 本で止まり、あれば最大 6 本(1.5 秒以上あけて順に。各本のタイムアウトは 10 秒。最悪でも 6 × 10 秒 + 待ち 5 × 1.5 秒 = 67.5 秒)。
 *
 * ## いつ動くか({@link BabaStage.dueAtMs})
 * 取得口と保存先があり、開催日が固定されて計画が確定し、中央の一覧が 1 件以上あり、まだ「そろって」いない日。期限は**次の枠の時刻**:
 *  - 枠 k は 開始時刻 + 間隔 × k(k = 0〜{@link BABA_FETCH_SLOTS} − 1。既定は 09:00・09:15・…・12:00 の 13 枠)。最初の発走前の分析の期限には左右されない。
 *  - 7:00 ごろに計測された値がページに載るまでには遅れがある。外部の API の時代に、08:00 では載っておらず全競馬場の値を「今日ではない」として捨て(#360)、09:00・09:30 でも載らない日があった(#475)。
 *    JRA のページに当日の値が載る時刻は #477 が実測する(10/31 の予定)。それまでは、載るまで取り直すことで間に合わせる。
 *  - 起床が遅れたときは、**いまの時刻の枠を 1 回だけ**取る(飛ばした枠は埋めない)。最後の枠の窓(12:00 以上 12:15 未満)を過ぎたら、未実行の枠があっても動かず、候補にもしない。
 *  - 今日(JST)が開催日と同じでなければ動かない(ページは「最新の値」しか持たない。前夜の計画の段階・過去の日には使えない)。期限は前夜のうちから候補になり、アラームが朝に起こす。
 * `runNextStep` での順序は、通知の後・タスクの前。期限が来ていれば 1 起床を使い、失敗しても次の起床でタスクがそのまま進む。
 *
 * ## 「そろった」({@link BabaStage.run})
 * 場ごとに、**クッション値と含水率のどちらにも当日の値がある**とき({@link isVenueComplete})そろった。その日の全部の場がそろったら、以後の枠は動かない({@link BABA_META_DONE})。
 *  - 全部の場 = 計画の中央の行の場コード({@link BabaFacts.venueCodes})。計画から取れないときだけ、クッション値・含水率のページに載っている場({@link BabaFetchOutcome.listedVenueCodes})。
 *    計画に場があるのにページに出ない間は、最後の枠まで取り直しが続く。
 *  - 片方だけの値の場も、先に保存する(分析に間に合わせる)。後の回で欠けが埋まれば、その行を補う(`baba-repository.ts`)。既に入っている値は消さない・上書きしない。
 *  - そろった場は DO が覚える({@link BABA_META_COMPLETE}。回をまたいで合算)。D1 への保存に失敗した回の場は覚えない。
 *
 * ## 1 枠 1 回({@link BabaStage.run})
 * 利用の条件は「JRA の開催日に、利用者全体で 1 枠 1 回」。JRA に出る**前に**、2 つの印を書く:
 *  1. D1 の `baba_fetch_attempts` に (開催日, 枠) の行を INSERT する(`claim`。主キーの衝突 = その枠は既に試みた)。DO のストレージが消えても、別のインスタンスでも守られる。
 *     claim は、その日に「そろった」回が D1 にあれば `done` を返す(DO のストレージが消えても、そろった日に取り直さない)。
 *  2. claim に成功したら、DO の `race_day_meta` の {@link BABA_META_SLOT}(最後に試みた枠)を**同期で**書いてから取得する(DO は書き込みの確定まで外向きの通信を出さない)。以後の起床は同じ枠で D1 を引かない。
 * 取得の後は、結果が何であっても**同じ枠では再試行しない**(HTTP エラー・タイムアウト・形の不一致・保存の失敗も)。次の枠が取り直しになる。
 * DO の再起動・アラームの重複・同じ日の再計画(救済)でも、印があれば同じ枠は動けない。
 * claim 自体の失敗(D1 が応答しない等)は、JRA にまだ何も送っていないので、枠ごとに {@link BabaStageDeps.maxClaimAttempts} 回まで {@link BabaStageDeps.retryDelayMs} 後に再試行し、尽きたらその枠は諦める(日は諦めない。次の枠がある)。
 *
 * ## 旧版(1 日 1 回)からの移行
 * 枠の印({@link BABA_META_SLOT})が無く、試みた時刻({@link BABA_META_ATTEMPTED})だけがある日は、その時刻が属する枠を最後の枠として続ける。
 *
 * ## 失敗しても分析を止めない・秘匿
 * {@link BabaStage.run} は例外を投げない(DO のアラームは例外で再実行される)。警告は固定の文と分類だけ(例外の文面・URL・応答の本文は出さない・保存しない)。
 */
import { BabaFetchError, isVenueComplete, type BabaDroppedDetail, type BabaFetcher, type BabaResultClass, type BabaVenueRecord } from "./baba-conditions";
import { startTimeEpochMs } from "./pre-race-time";
import { jstKaisaiDate } from "./auto-run-plan";
import type { SqlLike } from "./sql-like";
import type { DayBaba } from "../../packages/core/src/analyzer/day-baba";

export type { BabaFetcher };

/**
 * 取得の枠(Issue #480。置き値で、10/31 の実測の後に見直す。**ここの 3 つの定数だけで変えられる**)。
 * 最初の取得は {@link BABA_FETCH_START_JST}、以後 {@link BABA_FETCH_INTERVAL_MIN} 分おき、{@link BABA_FETCH_LAST_JST} の枠まで(9:00・9:15・…・12:00 の 13 枠)。
 * 当日の値が載る前の枠は、クッション値と含水率の 2 本で止まる空振りに終わるだけ。値が載ったら、その枠で保存する。
 * 経緯: 08:00 では外部の API に当日 7:00 の計測値が載っておらず(#360)、09:00・09:30 でも載らない日があった(#475。当日の値が載るのは遅くとも 12:57 まで、と分かっている)。
 * 値が載る前に取りに行く空振りは 2 本で済むので、載るまで取り直す形に改めた(Issue #480)。
 */
export const BABA_FETCH_START_JST = "09:00";
export const BABA_FETCH_INTERVAL_MIN = 15;
export const BABA_FETCH_LAST_JST = "12:00";

const hhmmToMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** 枠の数(開始から最後の枠まで)。既定は 13。 */
export const BABA_FETCH_SLOTS = Math.floor((hhmmToMinutes(BABA_FETCH_LAST_JST) - hhmmToMinutes(BABA_FETCH_START_JST)) / BABA_FETCH_INTERVAL_MIN) + 1;

const SLOT_MS = BABA_FETCH_INTERVAL_MIN * 60_000;

/** 枠 `slot` の時刻(エポックミリ秒)。 */
function slotStartMs(kaisaiDate: string, slot: number): number {
  return startTimeEpochMs(kaisaiDate, BABA_FETCH_START_JST) + slot * SLOT_MS;
}

/** DO の meta のキー: 最後に試みた枠(整数)。**同じ枠は二度取得しない**(JRA に出る前に書く)。 */
export const BABA_META_SLOT = "baba_slot";
/** DO の meta のキー: 最後に試みた時刻(エポックミリ秒。観測用。旧版〈1 日 1 回〉は、あれば二度と取得しない印だった)。旧版の移行にも使う。 */
export const BABA_META_ATTEMPTED = "baba_attempted_at";
/** DO の meta のキー: その日の全部の場がそろった印。あれば以後の枠は動かない。 */
export const BABA_META_DONE = "baba_done";
/** DO の meta のキー: そろった場の場コード(JSON の配列。回をまたいで合算)。 */
export const BABA_META_COMPLETE = "baba_complete_codes";
/** DO の meta のキー: claim の失敗の回数(いま失敗している枠の。枠が変われば数え直す)。 */
export const BABA_META_CLAIM_TRIES = "baba_claim_tries";
/** DO の meta のキー: claim の失敗を数えている枠。 */
export const BABA_META_CLAIM_SLOT = "baba_claim_slot";
/** DO の meta のキー: claim の再試行の時刻(エポックミリ秒)。 */
export const BABA_META_RETRY_AT = "baba_retry_at";
/** DO の meta のキー: 結果の分類(観測用)。 */
export const BABA_META_RESULT = "baba_result";

/** 結果の記録(D1 の `baba_fetch_attempts` と `baba_fetches` の更新と `baba_conditions` の行)。 */
export interface BabaFinish {
  /** 試みた枠。 */
  readonly slot: number;
  /** この回で、その日の全部の場がそろったか(D1 の `baba_fetch_attempts.complete`)。 */
  readonly complete: boolean;
  readonly finishedAt: number;
  readonly result: BabaResultClass;
  readonly apiFetchedAt: string | null;
  readonly venues: readonly BabaVenueRecord[];
  /** 捨てた競馬場の件数。 */
  readonly dropped: number;
  /** 捨てた競馬場の理由と計測日時の文字列(診断用。`baba_fetch_attempts.dropped_json`)。失敗の分類のときは空。 */
  readonly droppedDetails: readonly BabaDroppedDetail[];
}

/**
 * 保存先(本番は D1。`baba-repository.ts`)。
 *  - `claim`: 枠の試みを先に記録する。行を作れたら `claimed`、その枠が既にあれば `exists`、その日に「そろった」回が既にあれば `done`(取得しない)。失敗は投げる(まだ JRA に出ていない)。
 *  - `finish`: 結果の分類と競馬場の行を書く(既に入っている行は、欠けを埋めるときだけ補う)。失敗は投げる(呼び出し側は警告にして、同じ枠では再試行しない)。
 */
export interface BabaStore {
  claim(kaisaiDate: string, slot: number, attemptedAt: number): Promise<"claimed" | "exists" | "done">;
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
  /** 計画の中央の行にある場コード(その日の全部の場。「そろった」の分母)。取れなければ空(取得口の結果の `listedVenueCodes` を分母にする)。 */
  readonly venueCodes: readonly string[];
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
  /** 1 枠あたりの claim の試行回数の上限。 */
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

  private metaDelete(key: string): void {
    this.deps.sql.exec("DELETE FROM race_day_meta WHERE key = ?", key);
  }

  /** 最後に試みた枠。まだ無ければ -1。枠の印が無く試みた時刻だけがある日(旧版)は、その時刻が属する枠。 */
  private lastSlot(kaisaiDate: string): number {
    const slot = this.metaGet(BABA_META_SLOT);
    if (slot !== null) {
      return Number(slot);
    }
    const attempted = this.metaGet(BABA_META_ATTEMPTED);
    if (attempted === null) {
      return -1;
    }
    const index = Math.floor((Number(attempted) - slotStartMs(kaisaiDate, 0)) / SLOT_MS);
    return Math.min(BABA_FETCH_SLOTS - 1, Math.max(0, index));
  }

  /** 最後の枠の窓の終わり(これ以降は、未実行の枠があっても動かない)。 */
  private windowEndMs(kaisaiDate: string): number {
    return slotStartMs(kaisaiDate, BABA_FETCH_SLOTS - 1) + SLOT_MS;
  }

  /**
   * 次の取得の期限(アラームの候補。エポックミリ秒): 最後に試みた枠の次の枠の時刻。動けない構成・状態なら null(候補にしない)。
   * 前夜のうちから(翌朝の最初の枠で)候補になる。今日が開催日より後・その日の値がそろった・最後の枠を試みた・最後の枠の窓を過ぎた、なら null
   * (取得の後に候補が残って、即時のアラームが続かない)。起床が遅れて過ぎた枠の時刻は、そのまま返す(アラームは即時になり、{@link BabaStage.run} がいまの時刻の枠を 1 回だけ取る)。
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
    if (this.metaGet(BABA_META_DONE) !== null) {
      return null;
    }
    const now = this.deps.now();
    if (jstKaisaiDate(now) > facts.kaisaiDate) {
      return null;
    }
    const next = this.lastSlot(facts.kaisaiDate) + 1;
    if (next >= BABA_FETCH_SLOTS || now >= this.windowEndMs(facts.kaisaiDate)) {
      return null;
    }
    let due = slotStartMs(facts.kaisaiDate, next);
    const retryAt = this.metaGet(BABA_META_RETRY_AT);
    if (retryAt !== null) {
      due = Math.max(due, Number(retryAt));
    }
    return due;
  }

  /** いま動けるか: 実行中でなく、次の枠の時刻が来ていて、今日(JST)が開催日。 */
  runnable(): boolean {
    if (this.inFlight) {
      return false;
    }
    const due = this.dueAtMs();
    const facts = this.deps.facts();
    return due !== null && this.deps.now() >= due && jstKaisaiDate(this.deps.now()) === facts.kaisaiDate;
  }

  /**
   * 取得を 1 枠につき 1 回だけ行う。動けないときは何もしない(`retry`)。**例外を投げない。** 手順は冒頭の「1 枠 1 回」。
   * どの経路でも状態(試みた枠の印・再試行の時刻)が変わる(アラームの候補が残って即時に起き続けない)。
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
    const facts = this.deps.facts();
    const date = facts.kaisaiDate as string;
    const fetcher = this.deps.fetcher as BabaFetcher;
    const store = this.deps.store as BabaStore;
    const startedAt = this.deps.now();
    // いまの時刻の枠(遅れて起きたときは飛ばした枠を埋めず、いまの枠だけ)。次の枠の時刻が来ているので、最後に試みた枠より大きい。
    const slot = Math.min(BABA_FETCH_SLOTS - 1, Math.floor((startedAt - slotStartMs(date, 0)) / SLOT_MS));
    const isLastSlot = slot === BABA_FETCH_SLOTS - 1;

    // 1. 枠の試みを先に記録する(D1)。ここまでは JRA に何も送っていないので、失敗は再試行してよい。
    let claim: "claimed" | "exists" | "done";
    try {
      claim = await store.claim(date, slot, startedAt);
    } catch {
      const sameSlot = this.metaGet(BABA_META_CLAIM_SLOT) === String(slot);
      const tries = (sameSlot ? Number(this.metaGet(BABA_META_CLAIM_TRIES) ?? 0) : 0) + 1;
      if (tries >= this.deps.maxClaimAttempts) {
        this.markSlot(slot, startedAt);
        this.metaSet(BABA_META_RESULT, "claim-failed");
        this.deps.onWarn(`馬場の取得: 試みの記録(D1)に失敗し続けたため、この枠(${slot})は取得しません(試行 ${tries} 回。JRA には送っていません。${isLastSlot ? "最後の枠です" : "次の枠で取り直します"})`);
        return outcome("failed", date);
      }
      this.metaSet(BABA_META_CLAIM_SLOT, String(slot));
      this.metaSet(BABA_META_CLAIM_TRIES, String(tries));
      this.metaSet(BABA_META_RETRY_AT, String(startedAt + this.deps.retryDelayMs));
      this.deps.onWarn(`馬場の取得: 試みの記録(D1)に失敗しました(試行 ${tries} 回。JRA には送っていません。再試行します)`);
      return outcome("retry", date);
    }

    // 2. DO の印を、同期で、JRA に出る前に書く。既に試みた枠(exists)・既にそろった日(done)も印を書いて終わる。
    this.markSlot(slot, startedAt);
    if (claim === "done") {
      this.metaSet(BABA_META_DONE, "1");
      this.metaSet(BABA_META_RESULT, "done");
      return outcome("ok", date);
    }
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
    let listed: readonly string[] = [];
    try {
      const fetched = await fetcher(this.deps.now());
      result = fetched.result;
      venues = fetched.venues;
      dropped = fetched.dropped;
      droppedDetails = fetched.droppedDetails;
      apiFetchedAt = fetched.apiFetchedAt;
      listed = fetched.listedVenueCodes;
    } catch (error) {
      result = error instanceof BabaFetchError ? error.result : "other";
    }
    this.metaSet(BABA_META_RESULT, result);

    // 4. この回でそろったか(保存に成功すれば、そろった場に数える)。分母は計画の場、無ければページに載っている場。
    const completeCodes = new Set<string>(this.completeCodes());
    for (const v of venues) {
      if (isVenueComplete(v)) {
        completeCodes.add(v.venueCode);
      }
    }
    const expected = facts.venueCodes.length > 0 ? facts.venueCodes : listed;
    const complete = expected.length > 0 && expected.every((code) => completeCodes.has(code));

    // 5. 結果の記録。失敗しても同じ枠では再試行しない(JRA への取得は既に使った)。
    let saved = true;
    try {
      await store.finish(date, { slot, complete, finishedAt: this.deps.now(), result, apiFetchedAt, venues, dropped, droppedDetails });
    } catch {
      saved = false;
      this.deps.onWarn(`馬場の取得: 結果(${result})を D1 に保存できませんでした(この枠(${slot})は再取得しません。${isLastSlot ? "最後の枠です" : "次の枠で取り直します"})`);
    }
    if (saved) {
      this.metaSet(BABA_META_COMPLETE, JSON.stringify([...completeCodes]));
      if (complete) {
        this.metaSet(BABA_META_DONE, "1");
      }
    }
    if (result !== "ok") {
      this.deps.onWarn(`馬場の取得: 値を取得できませんでした(分類: ${result}。${isLastSlot ? "最後の枠なので、この日はこれ以上取り直しません" : "次の枠で取り直します"})`);
    }
    return outcome(result === "ok" && saved ? "ok" : "failed", date);
  }

  /** 枠の試みの印を書き、claim の失敗の数え直しを片づける(JRA に出る前、または枠を諦めたとき)。 */
  private markSlot(slot: number, at: number): void {
    this.metaSet(BABA_META_SLOT, String(slot));
    this.metaSet(BABA_META_ATTEMPTED, String(at));
    this.metaDelete(BABA_META_CLAIM_TRIES);
    this.metaDelete(BABA_META_CLAIM_SLOT);
    this.metaDelete(BABA_META_RETRY_AT);
  }

  /** これまでの回でそろった場の場コード。 */
  private completeCodes(): string[] {
    const text = this.metaGet(BABA_META_COMPLETE);
    if (text === null) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
    } catch {
      return [];
    }
  }
}
