/**
 * 日単位の DO(`RaceDayCore`)の、**結果の取り込みの段階**(Issue #208〈#182-B〉・#209。Issue #399〈#390 R-9d〉で `race-day-core.ts` から切り出した)。
 * **純ロジック**: `cloudflare:workers` を import しない。DO の SQLite の表(`race_day_result`・`race_day_win_odds_only`)は `ResultImportStore`(`race-day-result.ts`)が持ち、この段階は
 * **1 レースの取得 → パース → 保存 → 状態の更新**の手順だけを持つ。時計・保存先・取得口・警告の出口・開催日の読み取りは注入({@link ResultStageDeps})。
 * `BabaStage`・`CloseStage`・`ReportHoldStage`・`NotifyStage` と同じ形で、`setAlarm`・`rearm`・`armAlarm` には触れない(状態を必ず変えるので、張り直しは本体の `armAlarm`)。
 *
 * ## 本体との境界
 *  - 本体の `runNextStep` が、タスクが無く(`RaceDayCore` の `resultsRunnable`: タスク無し・計画の段階が終わっている)、時刻が来ている行があるとき、その行を {@link ResultStage.runStep} に渡す。
 *    戻り値のあとの日報の依頼(`maybeRequestReport`)と `armAlarm` は本体。
 *  - 本体に残るもの: 動けるかの判定(`resultsRunnable`。アラームの候補を入れるか〈`rearm`〉と動くか〈`runNextStep`〉の両方が使う)、依頼の受付(`requestResultImport`)と観測(`getResultImportProgress`)、
 *    結果の行を積む処理(`enqueueSameDayResults`・`enqueueResultForAnalyzedRace`。計画の確定・取得ステップの同期区間から呼ぶ)、日報の依頼。
 *
 * 手順の仕様(試行回数は取得の前に永続化・払戻が出てから保存・失敗の扱い)は {@link ResultStage.runStep} の JSDoc を参照。メソッドの本体は切り出し前から変えていない。
 */
import { importRaceResult } from "../../packages/core/src/ev/result-import";
import { parseRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids";
import { HttpError, type HttpClient } from "../../packages/core/src/scraper/http-client";
import { parseRaceFieldSize, parseRaceResult, RaceResultNotConfirmedError } from "../../packages/core/src/scraper/parse-race-result";
import { parseRaceClassFromHtml } from "../../packages/core/src/scraper/parse-race-class";
import { GateRefusedError } from "./gate-fetch";
import {
  MAX_RESULT_ATTEMPTS,
  MAX_RESULT_DEFERRALS,
  MAX_SAME_DAY_ATTEMPTS,
  MAX_SAME_DAY_UNKNOWN_SIZE_ATTEMPTS,
  RESULT_BUSY_DELAY_MS,
  RESULT_RETRY_DELAY_MS,
  SAME_DAY_RETRY_DELAY_MS,
  type ResultClass,
  type ResultImportStore,
  type ResultRow,
} from "./race-day-result";
import type { ResultStoreDeps } from "./race-day-core";

/** 結果の取り込みでブレーカーの解除を待つ時間の上限(ミリ秒)。ブレーカーは 30 分なので、それより長くは待たない(解除時刻が壊れていても、延々と先送りしない)。 */
const MAX_BLOCKED_WAIT_MS = 60 * 60_000;

/** 結果の取り込みの 1 ステップ(`StepOutcome` の 1 種。`mode: "result"`)。`raceId` は取り込んだレース。`ok` は D1 に保存した、`retry` は再試行(保留を含む)、`failed` はこの依頼としては諦めた。 */
export interface ResultStepOutcome {
  readonly kind: "ran";
  readonly raceId: string;
  readonly mode: "result";
  readonly step: "import";
  readonly result: "ok" | "retry" | "failed";
}

export interface ResultStageDeps {
  /** 結果の取り込みの表(本体が持つ `ResultImportStore`)。 */
  readonly results: ResultImportStore;
  /** 結果の保存先。無ければ結果の仕組み全体が無効(その場合、本体の `resultsRunnable` が先に弾くので、段階は呼ばれない)。 */
  readonly resultStore: ResultStoreDeps | undefined;
  /** gate 経由・キャッシュなしの取得(結果のページ用。本体の `httpClient`。キャッシュを通る取得口〈`networkFetcher`・`cacheOnly`〉を渡してはならない)。 */
  readonly httpClient: HttpClient;
  readonly now: () => number;
  /** 警告の出口(本体の `onWarn`。鍵の形を伏せる包みを通した後のもの)。 */
  readonly onWarn: (message: string) => void;
  /** `race_day_meta` の読み(本体の `metaGet`。呼ぶたびに読む)。 */
  readonly metaGet: (key: string) => string | null;
}

export class ResultStage {
  private readonly results: ResultImportStore;
  private readonly resultStore: ResultStoreDeps | undefined;
  private readonly httpClient: HttpClient;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;
  private readonly metaGet: (key: string) => string | null;

  constructor(deps: ResultStageDeps) {
    this.results = deps.results;
    this.resultStore = deps.resultStore;
    this.httpClient = deps.httpClient;
    this.now = deps.now;
    this.onWarn = deps.onWarn;
    this.metaGet = deps.metaGet;
  }

  /**
   * 結果の 1 レースを取り込む(取得 → パース → **単勝の払戻が出ていれば**保存)。**多くとも 1 レース・D1 への書き込みは 1 レースぶん(最大 6 文の 1 batch。単勝オッズ・人気が無ければ最大 5 文)に、クラスが読めたときだけ batch の外で UPDATE が 1 文増える(`saveRaceClass`。Issue #426。失敗は握る)**。補完モード(`winOddsOnly`)では batch の代わりに `saveWinOdds`・`saveScratched` の UPDATE 各 1 文(NULL の列だけを埋める)と、同じ `saveRaceClass` になる。
   * 取得は gate 経由・キャッシュなし。core の `importRaceResult` を、`parse` を包んで使う(単勝の払戻が 0 件なら `RaceResultNotConfirmedError` を投げる = 審議中の暫定の着順を保存しない)。
   * 試行回数は取得の前に永続化する(クラッシュしても無限に続かない)。失敗の扱い:
   *  - 未確定・払戻なし・構造の異常・取得の失敗・保存の失敗 → 試行を数えて、{@link RESULT_RETRY_DELAY_MS} 後に再試行。{@link MAX_RESULT_ATTEMPTS} 回で諦める
   *  - gate の `queue-full`・`blocked` → **試行を数えない保留**({@link RESULT_BUSY_DELAY_MS} 後。`blocked` は解除時刻の 1 秒後)。{@link MAX_RESULT_DEFERRALS} 回を超えたら諦める
   *  - 許可リスト外(`disallowed-url`) → 即座に諦める(再試行しても直らない)
   * どの経路でも状態(試行・保留・状態・次の時刻)が変わる(アラームの候補が過去のまま残って、即時に起き続けない)。警告は諦めたときだけ、分類と回数だけ(メッセージは出さない)。
   */
  async runStep(row: ResultRow): Promise<ResultStepOutcome> {
    const raceId = row.race_id;
    const outcomeOf_ = (result: "ok" | "retry" | "failed"): ResultStepOutcome => ({ kind: "ran", raceId, mode: "result", step: "import", result });
    const attempts = row.attempts + 1;
    this.results.markAttempt(raceId, attempts, this.now());
    // 当日の行(Issue #209): 計画の確定で積んだ行 = 依頼の日が開催日。全頭の着順がそろった確認と、5 分おき・10 回の再試行が加わる。過去日の行(後日の cron の依頼)は従来どおり。
    const sameDay = row.requested_on === this.metaGet("kaisai_date");
    // `raceClass`: 結果ページの `RaceData02` から読んだレースのクラス(Issue #426。読めなければ undefined)。パースの終わりに決まり、保存のあとに使う。
    const progress: { stage: "fetch" | "parse" | "save"; noPayout: boolean; incomplete: "short" | "unknown-size" | null; raceClass: string | undefined } = {
      stage: "fetch",
      noPayout: false,
      incomplete: null,
      raceClass: undefined,
    };
    // 確定の単勝オッズ・人気だけを保存する依頼か(Issue #259。印は積むときに付け直す)。
    const winOddsOnly = this.results.isWinOddsOnly(raceId);
    let imported = false;
    let failure: unknown = null;
    try {
      const outcome = await importRaceResult(parseRaceId(raceId), {
        // bypassCache は無視する: この取得はキャッシュを通らない(HttpClient を直接使う)。
        fetchText: (url) => this.httpClient.fetchText(url),
        parse: (html) => {
          progress.stage = "parse";
          const parsed = parseRaceResult(html);
          if (parsed.winPayouts.length === 0) {
            // 着順の行はあるが払戻のテーブルが出ていない(審議中の暫定の着順)。保存しない。
            progress.noPayout = true;
            throw new RaceResultNotConfirmedError("払戻のテーブルがまだありません(審議中の可能性があります)");
          }
          if (sameDay) {
            // 払戻が先に出て、全頭の着順が数分遅れて出るページ(地方で実測)を保存しない。**着順が確定している行**(`finishPosition !== null`。数値の着順と、取消・除外・中止などの非数値の着順を含む。
            // 着順のセルが空の行は数えない = 行は全頭分あっても着順が空のページも未完了)の数が、ページ自身の「N頭」に満たなければ未完了。「N頭」が取れないときは判定できないので保存しない。
            const fieldSize = parseRaceFieldSize(html);
            if (fieldSize === null || parsed.horses.filter((h) => h.finishPosition !== null).length < fieldSize) {
              progress.incomplete = fieldSize === null ? "unknown-size" : "short";
              throw new RaceResultNotConfirmedError("全頭の着順がまだそろっていません");
            }
          }
          progress.raceClass = parseRaceClassFromHtml(html, venueKindOfRaceId(parseRaceId(raceId)));
          return parsed;
        },
        saveResult: async (id, entries, courseType, comboPayouts) => {
          progress.stage = "save";
          if (winOddsOnly) {
            // 過去分の補完(Issue #259・#270): 確定の単勝オッズ・人気と、取消・除外の記録(scratched)だけを、NULL の列に埋める。保存済みの着順・払戻・組合せ払戻には触れない。
            // 同じ取得(同じ entries)で両方を埋める。どちらも冪等なので、片方が失敗して再試行になっても、埋まった分は書き直されない。
            await this.resultStore!.saveWinOdds(id, entries);
            await this.resultStore!.saveScratched(id, entries);
            await this.saveRaceClass(id, progress.raceClass);
            return;
          }
          await this.resultStore!.saveResult(id, entries, courseType, comboPayouts);
          await this.saveRaceClass(id, progress.raceClass);
        },
      });
      imported = outcome.status === "imported";
    } catch (error) {
      failure = error;
    }
    const now = this.now();
    if (imported) {
      this.results.markImported(raceId, now);
      return outcomeOf_("ok");
    }
    if (failure === null) {
      const lastClass: ResultClass = progress.noPayout ? "no-payout" : progress.incomplete !== null ? "incomplete" : "not-confirmed";
      return this.failResult(row, attempts, lastClass, outcomeOf_, sameDay, progress.incomplete === "unknown-size" ? MAX_SAME_DAY_UNKNOWN_SIZE_ATTEMPTS : undefined);
    }
    if (progress.stage === "parse") {
      return this.failResult(row, attempts, "parse-error", outcomeOf_, sameDay);
    }
    if (progress.stage === "save") {
      return this.failResult(row, attempts, "save-failed", outcomeOf_, sameDay);
    }
    // 取得の失敗: gate の拒否は保留または即座の諦め、それ以外は試行を数える再試行。
    if (failure instanceof HttpError && failure.cause instanceof GateRefusedError) {
      const reason = failure.cause.reason;
      if (reason === "disallowed-url") {
        this.results.markGaveUp(raceId, row.deferrals, "blocked", now);
        this.warnGaveUp(raceId, "blocked", attempts, row.deferrals);
        return outcomeOf_("failed");
      }
      if (reason === "queue-full" || reason === "blocked") {
        const deferrals = row.deferrals + 1;
        const lastClass: ResultClass = reason === "blocked" ? "blocked" : "busy";
        const until = failure.cause.blockedUntil;
        const nextTryAt = reason === "blocked" && until !== undefined && until > now ? Math.min(until + 1000, now + MAX_BLOCKED_WAIT_MS) : now + RESULT_BUSY_DELAY_MS;
        // 試行は数えない(取得の前に数えた分を戻す)。
        this.results.markDeferred(raceId, row.attempts, deferrals, nextTryAt, lastClass, now);
        if (deferrals > MAX_RESULT_DEFERRALS) {
          this.results.markGaveUp(raceId, deferrals, lastClass, now);
          this.warnGaveUp(raceId, lastClass, row.attempts, deferrals);
          return outcomeOf_("failed");
        }
        return outcomeOf_("retry");
      }
    }
    return this.failResult(row, attempts, "fetch-failed", outcomeOf_, sameDay);
  }

  /**
   * レースのクラス(Issue #426)を分析の行に書く。**結果の保存(補完モードではオッズ・scratched の保存)が成功したあとにだけ呼ぶ**。
   * クラスは結果の副産物なので、**ここの失敗は握って警告にし、取り込みは成功させる**: 結果は保存済みで、再試行(`save-failed`)にすると結果ページの取り直しが無駄になり、
   * 再試行が尽きると『諦めた』と記録されて保存済みの結果と食い違う。クラスは NULL のまま残り、後から補完できる。警告は固定の文言(例外の文面は出さない)。
   * クラスが読めなかった(undefined)・結果ストアが `saveRaceClass` を持たない構成では、何もしない。
   */
  private async saveRaceClass(raceId: string, raceClass: string | undefined): Promise<void> {
    if (raceClass === undefined || this.resultStore?.saveRaceClass === undefined) {
      return;
    }
    try {
      await this.resultStore.saveRaceClass(raceId, raceClass);
    } catch {
      this.onWarn(`結果の取り込み: レースのクラスの保存に失敗しました(${raceId}。結果は保存済み)`);
    }
  }

  /**
   * 試行を数える失敗: 上限までは再試行、上限で諦める。過去日の行は {@link RESULT_RETRY_DELAY_MS} 後に {@link MAX_RESULT_ATTEMPTS} 回まで。
   * 当日の行(Issue #209)は {@link SAME_DAY_RETRY_DELAY_MS} おきに {@link MAX_SAME_DAY_ATTEMPTS} 回まで(`maxAttempts` で、判定不能のときの上限〈{@link MAX_SAME_DAY_UNKNOWN_SIZE_ATTEMPTS}〉に絞れる)。
   */
  private failResult(
    row: ResultRow,
    attempts: number,
    lastClass: ResultClass,
    outcomeOf_: (r: "ok" | "retry" | "failed") => ResultStepOutcome,
    sameDay: boolean,
    maxAttempts?: number,
  ): ResultStepOutcome {
    const now = this.now();
    const limit = maxAttempts ?? (sameDay ? MAX_SAME_DAY_ATTEMPTS : MAX_RESULT_ATTEMPTS);
    if (attempts >= limit) {
      this.results.markGaveUp(row.race_id, row.deferrals, lastClass, now);
      this.warnGaveUp(row.race_id, lastClass, attempts, row.deferrals);
      return outcomeOf_("failed");
    }
    this.results.markRetry(row.race_id, now + (sameDay ? SAME_DAY_RETRY_DELAY_MS : RESULT_RETRY_DELAY_MS), lastClass, now);
    return outcomeOf_("retry");
  }

  private warnGaveUp(raceId: string, lastClass: ResultClass, attempts: number, deferrals: number): void {
    this.onWarn(`結果の取り込みを諦めました(${raceId}。分類 ${lastClass}。試行 ${attempts} 回・保留 ${deferrals} 回)`);
  }
}
