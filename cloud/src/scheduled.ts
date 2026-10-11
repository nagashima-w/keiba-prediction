/**
 * cron の `scheduled`(Issue #206〈#166-E〉・#208〈#182-B〉・#249)。**薄い作り**。cron は 2 本: **21:00 JST(UTC 12:00)と 23:00 JST(UTC 14:00)**(朝 9 時の定時実行は無い)。
 * 実行の種類は `scheduledTime` の JST の時刻で決める({@link scheduledRunKind}。22 時以降 = retry、それ以外 = first)。`Date.now()` も `event.cron` の文字列も使わない
 * (遅延配信・重複配信でも同じ結果になる。toml の cron との整合は `scripts/test/cloud-config-guard.test.ts` が固定する)。
 *
 *  - **21 時(first)**: 翌日(JST の今日 + 1。{@link planTargetDate})の日単位の DO(`RaceDay`)の `requestPlan` だけ。計画の確定の中で、各レースの事前分析(`morning`: 出馬表・戦績・調教の取得と統計の順位)が積まれる。
 *  - **23 時(retry)**: 同じ翌日に `requestPlan({ rescue: true })`(21 時に失敗した分の救済。DO 側が 1 回だけ行う)を呼び、**そのあとに**、(a)過去 7 日(今日の前日まで。今日は含めない)の分析済み・結果未取込のレースを、
 *    日ごとにその日の DO へ依頼し(`dispatchResultImports`。`result-dispatch.ts`)、(b)結果の補完の DO(`ResultBackfill`。Issue #217〈#167-C〉)の `kick()` を 1 回呼び(アラームが無ければ張るだけ。補完は JST 1:00〜6:00 に、移行の完了後だけ動く)、
 *    (c)日報の取り残しの補完(前日以前の最大 3 日)を日報の DO へ依頼する。21 時にこれらを行わないのは、21 時は翌日分の事前分析の取得が gate を占めるため。
 *    ★結果の窓・日報の補完の基準は cron の JST の今日(翌日ではない)。DO が「今日以降の開催日の結果の取り込みは拒否」するため、窓は今日の前日まで。当日の結果は日単位の DO が当日中に取り込む(7 日の窓は保険)。
 *    当日に諦めたレースの取り直しと日報の補完は、翌日の 21 時・23 時の実行で拾う(従来は翌朝 9 時。約 12〜14 時間遅くなる)。
 *  - **netkeiba にも LLM にも直接は出ない**(取得・予約・分析・結果の取り込みは、依頼を受けた DO がアラームの中で行う)。D1 は結果の未取込の**列挙(読み取り 1 クエリ)**だけ。
 *    `cloudflare:workers` を import しない(型だけ import する)ので、Node の vitest でそのままテストできる。worker.ts は、これに 1 行で委譲する。
 *  - **開催日**: {@link planTargetDate}(`scheduledTime` から。21 時と 23 時は JST で同じ日なので同じ翌日になる。月末・年末・うるう日は暦日の足し算で繰り上がる)。
 *  - **重複配信**: `requestPlan` が冪等(2 回目は `already-planned`。状態は変えず、アラームだけ状態から張り直す〈G-E2〉。救済も 1 回だけ)なので、吸収される。結果の依頼も DO 側が冪等(同じ日の再依頼は積み直さない)。
 *  - **失敗**: 有界の再試行({@link SCHEDULED_RETRY_DELAYS_MS}。即時・10 秒後・30 秒後の計 3 回)。`requestPlan` が冪等なので再試行は安全。
 *    cron は失敗しても再配信されるとは限らない(未確認)ため、ここで再試行する。3 回とも失敗したら**固定文言のエラー**を投げる(ダッシュボードで失敗が見える)。
 *    **結果の依頼は、`requestPlan` の成否によらず走らせ(事前分析の計画の失敗が結果を止めない)、その失敗は計画を失敗させない**(分類だけをログに出す。投げるのは `requestPlan` の失敗だけ)。
 *  - **★23 時の失敗通知(Issue #249。利用者の決定)**: retry の `requestPlan` が 3 回とも失敗したとき(日単位の DO に届かない。DO の状態からは通知を作れない)に限り、**ここから Discord に固定文を 1 通送る**
 *    ({@link buildPlanRequestFailedEmbed})。first(21 時)の失敗では送らない(23 時に救済されるため)。送信の部品は DO が使うものと同じ(`createDiscordNotifier`: URL の検証・タイムアウト・429 の扱い)。
 *    Webhook が未登録・形式不正なら送らない。送信の失敗は握る(分類だけをログに出し、**URL・応答の本文は出さない**)。cron の重複配信で 2 通になりうる(状態で防ぐ手段がない。許容)。
 *    これで拾えない失敗は、Worker 自体が動かない場合だけ。送るのは、結果の取り込み・kick・日報の補完のあと(送信の待ちが他の仕事を遅らせない)。
 *  - **ログ**: 固定の分類名・開催日・試行番号・エラーの `name`(文字種を絞る)だけ。メッセージ本文・値・秘密は出さない。
 *
 * 呼び出す DO の RPC は `requestPlan` の 1 つ(ここに直接)と、`dispatchResultImports` 経由の `requestResultImport`、補完の `kick` の 1 つ(`scripts/test/cloud-config-guard.test.ts` が、呼び出し箇所の数と、取得に出る呼び出しが無いことを固定する)。
 * **`kick` の失敗は握る**(分類 `backfill-kick-failed` だけをログに出す)。計画・既存の結果の依頼を失敗させない。
 */
import { jstKaisaiDate, planTargetDate, scheduledRunKind, type ScheduledRunKind } from "./auto-run-plan";
import type { BackfillNamespaceLike, DailyReportNamespaceLike, RaceDayNamespaceLike } from "./handler";
import { DAILY_REPORT_NAME } from "./daily-report-core";
import { D1ReportStore } from "./daily-report-repository";
import { buildPlanRequestFailedEmbed } from "./notify-embeds";
import { classifyNotifyError, createDiscordNotifier, webhookStatus } from "./notify-send";
import type { DiscordFetchLike } from "../../packages/core/src/notify/discord";
import { RESULT_BACKFILL_NAME } from "./result-backfill-core";
import { addDaysToKaisaiDate, CRON_RESULT_MAX_DAYS, dispatchResultImports, errorKind, resultWindowFor, type DispatchStore } from "./result-dispatch";
import { D1ResultStore, type ResultDb } from "./result-repository";

/** 失敗したときの再試行の前の待ち(ミリ秒)。試行は最初の即時と合わせて `長さ + 1` 回。 */
export const SCHEDULED_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000];

/** 最終的に失敗したときに投げるエラーの文言(固定。メッセージ本文・値は含まない)。 */
export const SCHEDULED_FAILURE_MESSAGE = "scheduled: 事前分析の計画の依頼に失敗しました(詳細はログの分類を参照)";

export interface ScheduledEnv {
  readonly RACE_DAY: RaceDayNamespaceLike;
  /** D1（結果の未取込の列挙だけに使う。読み取り）。 */
  readonly DB: ResultDb;
  /** 結果の補完の DO(Issue #217)。無い構成では kick を呼ばない。 */
  readonly RESULT_BACKFILL?: BackfillNamespaceLike;
  /** 日報の DO(Issue #235)。無い構成では日報の取り残しの補完をしない。 */
  readonly DAILY_REPORT?: DailyReportNamespaceLike;
  /** Discord の Webhook(Worker の secret。Issue #249)。**23 時の再実行で計画の依頼が 3 回とも失敗したときの通知にだけ使う**。未登録・形式不正なら送らない。 */
  readonly DISCORD_WEBHOOK_URL?: string;
}

export interface ScheduledDeps {
  readonly log?: (line: string, level: "info" | "error") => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 結果の未取込の列挙（省略時は `env.DB` から `D1ResultStore` を作る）。テストで差し替える。 */
  readonly store?: DispatchStore;
  /** Discord への送信に使う fetch(省略時はグローバルの `fetch`)。テストで差し替える。 */
  readonly fetch?: DiscordFetchLike;
}

/** 日報の取り残しをさかのぼる日数(今日の前日まで。Issue #235)。 */
export const REPORT_CATCHUP_DAYS = 3;

const defaultLog = (line: string, level: "info" | "error"): void => {
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runScheduled(controller: { readonly scheduledTime: number }, env: ScheduledEnv, deps: ScheduledDeps = {}): Promise<void> {
  const log = deps.log ?? defaultLog;
  const sleep = deps.sleep ?? defaultSleep;

  // today = cron の JST の今日(結果の窓・日報の補完の基準)/ kaisaiDate = 計画する翌日 / kind = 21 時(first)か 23 時(retry)か。
  let today: string;
  let kaisaiDate: string;
  let kind: ScheduledRunKind;
  try {
    today = jstKaisaiDate(controller.scheduledTime);
    kaisaiDate = planTargetDate(controller.scheduledTime);
    kind = scheduledRunKind(controller.scheduledTime);
  } catch (error) {
    // 時刻が不正なのは、再試行しても直らない(DO を呼ばない。first か retry かも決められないので、通知も送らない)。
    log(`scheduled: failed class=bad-scheduled-time error=${errorKind(error)}`, "error");
    throw new Error(SCHEDULED_FAILURE_MESSAGE);
  }
  const isRetry = kind === "retry";

  // 開催日の DO のスタブを引く(requestPlan も結果の依頼も、ここ 1 行)。
  const stubFor = (date: string) => env.RACE_DAY.get(env.RACE_DAY.idFromName(date));

  // retry(23 時)だけ rescue を渡す(21 時に失敗した分の救済。DO が 1 回だけ行う冪等な動作)。first では rescue のキー自体を渡さない。
  const planInput = isRetry ? { kaisaiDate, rescue: true } : { kaisaiDate };
  const attempts = SCHEDULED_RETRY_DELAYS_MS.length + 1;
  let planned = false;
  for (let attempt = 1; attempt <= attempts && !planned; attempt += 1) {
    try {
      const result = await stubFor(kaisaiDate).requestPlan(planInput);
      log(`scheduled: request-plan ok kind=${kind} date=${kaisaiDate} attempt=${attempt} accepted=${String(result.accepted)}${result.accepted ? "" : ` reason=${result.reason}`}`, "info");
      planned = true;
    } catch (error) {
      log(`scheduled: request-plan failed kind=${kind} date=${kaisaiDate} attempt=${attempt}/${attempts} error=${errorKind(error)}`, "error");
      const delay = SCHEDULED_RETRY_DELAYS_MS[attempt - 1];
      if (delay !== undefined) {
        await sleep(delay);
      }
    }
  }

  // 23 時の再実行だけ: 結果の取り込み・補完の起動・日報の補完(21 時は翌日分の事前分析の取得が gate を占めるので行わない。Issue #249)。
  // いずれも requestPlan の成否によらず走らせ、失敗しても投げない(計画の失敗が結果を止めない・結果の失敗が計画を失敗させない)。基準は cron の JST の今日(`today`。翌日ではない)。
  if (isRetry) {
    // 結果の依頼（Issue #208）。
    try {
      const store = deps.store ?? new D1ResultStore({ db: env.DB });
      await dispatchResultImports({ ...resultWindowFor(today), maxDays: CRON_RESULT_MAX_DAYS, store, stubFor, log });
    } catch (error) {
      log(`scheduled: failed class=result-dispatch-failed error=${errorKind(error)}`, "error");
    }

    // 結果の補完の起動(Issue #217)。アラームが無ければ張るだけ(補完は JST 1:00〜6:00 に、移行の完了後だけ動く。ここでは何も取得しない)。
    if (env.RESULT_BACKFILL !== undefined) {
      try {
        await env.RESULT_BACKFILL.get(env.RESULT_BACKFILL.idFromName(RESULT_BACKFILL_NAME)).kick();
      } catch (error) {
        log(`scheduled: failed class=backfill-kick-failed error=${errorKind(error)}`, "error");
      }
    }

    // 日報の取り残しの補完(Issue #235)。前日以前の最大 REPORT_CATCHUP_DAYS 日で、分析があるのに日報が無い日を、日報の DO へ依頼する(今日は依頼しない: 今日は日単位の DO が、
    // その日が静かになったときに依頼する。cron の時刻・曜日には依存しない)。
    if (env.DAILY_REPORT !== undefined) {
      await requestReportCatchup(env.DAILY_REPORT, env.DB, today, log);
    }
  }

  if (!planned) {
    log(`scheduled: failed class=request-plan-failed kind=${kind} date=${kaisaiDate}`, "error");
    // 23 時の再実行でも依頼できなかった: 利用者の決定(Issue #249)で、ここから固定文を 1 通送る。first では送らない(23 時に救済される)。
    if (isRetry) {
      await notifyPlanRequestFailed(env.DISCORD_WEBHOOK_URL, kaisaiDate, deps.fetch, log);
    }
    throw new Error(SCHEDULED_FAILURE_MESSAGE);
  }
}

/**
 * 23 時の再実行で計画を依頼できなかったときの Discord 通知(固定文 1 通)。**投げない**: Webhook が未登録・形式不正なら送らず(分類だけをログに出す)、送信の失敗も握る
 * (分類 {@link classifyNotifyError} だけをログに出す。**URL・応答の本文・例外の文面は出さない**)。送信の部品は DO と同じ `createDiscordNotifier`。
 */
async function notifyPlanRequestFailed(
  rawWebhookUrl: string | undefined,
  kaisaiDate: string,
  fetchFn: DiscordFetchLike | undefined,
  log: (line: string, level: "info" | "error") => void,
): Promise<void> {
  const status = webhookStatus(rawWebhookUrl);
  const notifier = createDiscordNotifier(rawWebhookUrl, fetchFn === undefined ? {} : { fetch: fetchFn });
  if (notifier === undefined) {
    log(`scheduled: plan-failure-notice skipped reason=webhook-${status}`, "info");
    return;
  }
  try {
    await notifier.send({ embeds: [buildPlanRequestFailedEmbed(kaisaiDate)] });
    log(`scheduled: plan-failure-notice sent date=${kaisaiDate}`, "info");
  } catch (error) {
    log(`scheduled: plan-failure-notice failed date=${kaisaiDate} class=${classifyNotifyError(error)}`, "error");
  }
}

/** 日報の取り残しを列挙して、1 日ずつ日報の DO へ依頼する。投げない(失敗は分類だけをログに出し、残りの日を続ける)。 */
async function requestReportCatchup(
  namespace: DailyReportNamespaceLike,
  db: ScheduledEnv["DB"],
  today: string,
  log: (line: string, level: "info" | "error") => void,
): Promise<void> {
  let dates: string[];
  try {
    dates = await new D1ReportStore({ db }).listDatesNeedingReport(addDaysToKaisaiDate(today, -REPORT_CATCHUP_DAYS), addDaysToKaisaiDate(today, -1));
  } catch (error) {
    log(`scheduled: failed class=report-catchup-failed error=${errorKind(error)}`, "error");
    return;
  }
  for (const kaisaiDate of dates) {
    try {
      const result = await namespace.get(namespace.idFromName(DAILY_REPORT_NAME)).requestReport({ kaisaiDate, mode: "catchup" });
      log(`scheduled: report-catchup date=${kaisaiDate} accepted=${String(result.accepted)}${result.accepted ? "" : ` reason=${result.reason}`}`, "info");
    } catch (error) {
      log(`scheduled: failed class=report-catchup-failed date=${kaisaiDate} error=${errorKind(error)}`, "error");
    }
  }
}
