/**
 * cron の `scheduled`(Issue #206〈#166-E〉・Issue #208〈#182-B〉)。**薄い作り**: `scheduledTime`(UTC のエポックミリ秒)から JST の開催日を決め、(1)その日の日単位の DO(`RaceDay`)の
 * `requestPlan` を呼び、(2)**そのあとに**、過去 7 日(前日まで。今日は含めない)の分析済み・結果未取込のレースを、日ごとにその日の DO へ依頼し(`dispatchResultImports`。`result-dispatch.ts`)、
 * (3)**最後に**、結果の補完の DO(`ResultBackfill`。Issue #217〈#167-C〉)の `kick()` を 1 回呼ぶ(アラームが無ければ張るだけ。補完は JST 1:00〜6:00 に、移行の完了後だけ動く。取得は一切しない)。
 * **netkeiba にも LLM にも直接は出ない**(取得・予約・分析・結果の取り込みは、依頼を受けた DO がアラームの中で行う)。D1 は結果の未取込の**列挙(読み取り 1 クエリ)**だけ。
 * `cloudflare:workers` を import しない(型だけ import する)ので、Node の vitest でそのままテストできる。worker.ts は、これに 1 行で委譲する。
 *
 *  - **開催日**: {@link jstKaisaiDate}(`scheduledTime` から。`Date.now()` は使わない。遅延配信・重複配信でも同じ日になる)。
 *  - **重複配信**: `requestPlan` が冪等(2 回目は `already-planned`。状態は変えず、アラームだけ状態から張り直す〈G-E2〉)なので、吸収される。結果の依頼も DO 側が冪等(同じ日の再依頼は積み直さない)。
 *  - **失敗**: 有界の再試行({@link SCHEDULED_RETRY_DELAYS_MS}。即時・10 秒後・30 秒後の計 3 回)。`requestPlan` が冪等なので再試行は安全。
 *    cron は失敗しても再配信されるとは限らない(未確認)ため、ここで再試行する。3 回とも失敗したら**固定文言のエラー**を投げる(ダッシュボードで失敗が見える)。
 *    **結果の依頼は、`requestPlan` の成否によらず走らせ(朝の計画の失敗が結果を止めない)、その失敗は朝の計画を失敗させない**(分類だけをログに出す。投げるのは `requestPlan` の失敗だけ)。
 *  - **ログ**: 固定の分類名・開催日・試行番号・エラーの `name`(文字種を絞る)だけ。メッセージ本文・値・秘密は出さない。
 *
 * 呼び出す DO の RPC は `requestPlan` の 1 つ(ここに直接)と、`dispatchResultImports` 経由の `requestResultImport`、補完の `kick` の 1 つ(`scripts/test/cloud-config-guard.test.ts` が、呼び出し箇所の数と、取得に出る呼び出しが無いことを固定する)。
 * **`kick` の失敗は握る**(分類 `backfill-kick-failed` だけをログに出す)。朝の計画・既存の結果の依頼を失敗させない。
 */
import { jstKaisaiDate } from "./auto-run-plan";
import type { BackfillNamespaceLike, RaceDayNamespaceLike } from "./handler";
import { RESULT_BACKFILL_NAME } from "./result-backfill-core";
import { CRON_RESULT_MAX_DAYS, dispatchResultImports, errorKind, resultWindowFor, type DispatchStore } from "./result-dispatch";
import { D1ResultStore, type ResultDb } from "./result-repository";

/** 失敗したときの再試行の前の待ち(ミリ秒)。試行は最初の即時と合わせて `長さ + 1` 回。 */
export const SCHEDULED_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000];

/** 最終的に失敗したときに投げるエラーの文言(固定。メッセージ本文・値は含まない)。 */
export const SCHEDULED_FAILURE_MESSAGE = "scheduled: 朝の計画の依頼に失敗しました(詳細はログの分類を参照)";

export interface ScheduledEnv {
  readonly RACE_DAY: RaceDayNamespaceLike;
  /** D1（結果の未取込の列挙だけに使う。読み取り）。 */
  readonly DB: ResultDb;
  /** 結果の補完の DO(Issue #217)。無い構成では kick を呼ばない。 */
  readonly RESULT_BACKFILL?: BackfillNamespaceLike;
}

export interface ScheduledDeps {
  readonly log?: (line: string, level: "info" | "error") => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 結果の未取込の列挙（省略時は `env.DB` から `D1ResultStore` を作る）。テストで差し替える。 */
  readonly store?: DispatchStore;
}

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

  let kaisaiDate: string;
  try {
    kaisaiDate = jstKaisaiDate(controller.scheduledTime);
  } catch (error) {
    // 時刻が不正なのは、再試行しても直らない(DO を呼ばない)。
    log(`scheduled: failed class=bad-scheduled-time error=${errorKind(error)}`, "error");
    throw new Error(SCHEDULED_FAILURE_MESSAGE);
  }

  // 開催日の DO のスタブを引く(requestPlan も結果の依頼も、ここ 1 行)。
  const stubFor = (date: string) => env.RACE_DAY.get(env.RACE_DAY.idFromName(date));

  const attempts = SCHEDULED_RETRY_DELAYS_MS.length + 1;
  let planned = false;
  for (let attempt = 1; attempt <= attempts && !planned; attempt += 1) {
    try {
      const result = await stubFor(kaisaiDate).requestPlan({ kaisaiDate });
      log(`scheduled: request-plan ok date=${kaisaiDate} attempt=${attempt} accepted=${String(result.accepted)}${result.accepted ? "" : ` reason=${result.reason}`}`, "info");
      planned = true;
    } catch (error) {
      log(`scheduled: request-plan failed date=${kaisaiDate} attempt=${attempt}/${attempts} error=${errorKind(error)}`, "error");
      const delay = SCHEDULED_RETRY_DELAYS_MS[attempt - 1];
      if (delay !== undefined) {
        await sleep(delay);
      }
    }
  }

  // 結果の依頼（Issue #208）。requestPlan の成否によらず走らせ、失敗しても投げない（朝の計画を失敗させない）。
  try {
    const store = deps.store ?? new D1ResultStore({ db: env.DB });
    await dispatchResultImports({ ...resultWindowFor(kaisaiDate), maxDays: CRON_RESULT_MAX_DAYS, store, stubFor, log });
  } catch (error) {
    log(`scheduled: failed class=result-dispatch-failed error=${errorKind(error)}`, "error");
  }

  // 結果の補完の起動(Issue #217)。アラームが無ければ張るだけ(補完は JST 1:00〜6:00 に、移行の完了後だけ動く。ここでは何も取得しない)。
  // 計画・結果の依頼の成否によらず走らせ、失敗しても投げない(朝の計画・既存の結果の取り込みを失敗させない)。
  if (env.RESULT_BACKFILL !== undefined) {
    try {
      await env.RESULT_BACKFILL.get(env.RESULT_BACKFILL.idFromName(RESULT_BACKFILL_NAME)).kick();
    } catch (error) {
      log(`scheduled: failed class=backfill-kick-failed error=${errorKind(error)}`, "error");
    }
  }

  if (!planned) {
    log(`scheduled: failed class=request-plan-failed date=${kaisaiDate}`, "error");
    throw new Error(SCHEDULED_FAILURE_MESSAGE);
  }
}
