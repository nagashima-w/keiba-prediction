/**
 * cron の `scheduled`(Issue #206〈#166-E〉)。**薄い作り**: `scheduledTime`(UTC のエポックミリ秒)から JST の開催日を決め、その日の日単位の DO(`RaceDay`)の
 * `requestPlan` を呼ぶだけ。**netkeiba にも LLM にも直接は出ない**(取得・予約・分析は、依頼を受けた DO がアラームの中で行う)。
 * `cloudflare:workers` を import しない(型だけ import する)ので、Node の vitest でそのままテストできる。worker.ts は、これに 1 行で委譲する。
 *
 *  - **開催日**: {@link jstKaisaiDate}(`scheduledTime` から。`Date.now()` は使わない。遅延配信・重複配信でも同じ日になる)。
 *  - **重複配信**: `requestPlan` が冪等(2 回目は `already-planned`。状態は変えず、アラームだけ状態から張り直す〈G-E2〉)なので、吸収される。
 *  - **失敗**: 有界の再試行({@link SCHEDULED_RETRY_DELAYS_MS}。即時・10 秒後・30 秒後の計 3 回)。`requestPlan` が冪等なので再試行は安全。
 *    cron は失敗しても再配信されるとは限らない(未確認)ため、ここで再試行する。3 回とも失敗したら**固定文言のエラー**を投げる(ダッシュボードで失敗が見える)。
 *  - **ログ**: 固定の分類名・開催日・試行番号・エラーの `name`(文字種を絞る)だけ。メッセージ本文・値・秘密は出さない。
 *
 * 呼び出す RPC は `requestPlan` の 1 つだけ(`scripts/test/cloud-config-guard.test.ts` が、呼び出し箇所の数と、取得に出る呼び出しが無いことを固定する)。
 */
import { jstKaisaiDate } from "./auto-run-plan";
import type { RaceDayNamespaceLike } from "./handler";

/** 失敗したときの再試行の前の待ち(ミリ秒)。試行は最初の即時と合わせて `長さ + 1` 回。 */
export const SCHEDULED_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000];

/** 最終的に失敗したときに投げるエラーの文言(固定。メッセージ本文・値は含まない)。 */
export const SCHEDULED_FAILURE_MESSAGE = "scheduled: 朝の計画の依頼に失敗しました(詳細はログの分類を参照)";

export interface ScheduledEnv {
  readonly RACE_DAY: RaceDayNamespaceLike;
}

export interface ScheduledDeps {
  readonly log?: (line: string, level: "info" | "error") => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultLog = (line: string, level: "info" | "error"): void => {
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** ログに出してよいエラーの種類名: 英数字と `_` の 1〜40 文字だけ(それ以外・Error でない値は固定の語)。 */
function errorKind(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(error.name)) {
    return error.name;
  }
  return error instanceof Error ? "UnknownError" : "non-error";
}

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

  const attempts = SCHEDULED_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const stub = env.RACE_DAY.get(env.RACE_DAY.idFromName(kaisaiDate));
      const result = await stub.requestPlan({ kaisaiDate });
      log(`scheduled: request-plan ok date=${kaisaiDate} attempt=${attempt} accepted=${String(result.accepted)}${result.accepted ? "" : ` reason=${result.reason}`}`, "info");
      return;
    } catch (error) {
      log(`scheduled: request-plan failed date=${kaisaiDate} attempt=${attempt}/${attempts} error=${errorKind(error)}`, "error");
      const delay = SCHEDULED_RETRY_DELAYS_MS[attempt - 1];
      if (delay !== undefined) {
        await sleep(delay);
      }
    }
  }
  log(`scheduled: failed class=request-plan-failed date=${kaisaiDate}`, "error");
  throw new Error(SCHEDULED_FAILURE_MESSAGE);
}
