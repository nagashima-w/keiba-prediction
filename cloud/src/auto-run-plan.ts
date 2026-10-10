/**
 * 定時の自動実行(Issue #166)の純関数(Issue #202〈#166-A〉)。**`cloudflare:workers` も DO・gate・D1 も import しない**ので、Node の vitest でそのままテストできる。
 * ここにあるのは「何を・いつ実行するか」の判断だけ。実際の予約・アラーム・取得は #203〜#206(DO の計画・発走前の予約・通知・cron。#206 で cron が有効になり、`scheduled.ts` が `jstKaisaiDate` を呼ぶ)。
 *
 *  - {@link jstKaisaiDate}: cron の `scheduledTime`(UTC のエポックミリ秒)から、**JST の開催日**(YYYYMMDD)を求める。cron は UTC で動く(JST 9:00 = UTC 0:00)ので、
 *    UTC の日付をそのまま使うと、UTC 15:00〜23:59(= JST の翌日 0:00〜8:59)で1日ずれる。`Date.now()` ではなく `scheduledTime` を使うのは、cron の重複配信(at-least-once)でも同じ日になるため。
 *  - {@link selectAutoRunTargets}: 自動実行の対象。**中央は全件、地方は交流重賞(Jpn1/2/3)だけ**(`filterJpnOnlyEntries`。地方の重賞・OP・L は対象外)。
 *  - {@link planPreRaceDue}: 発走前の分析の期限(発走 − offset 分)と、期限を過ぎていたときの判定(すぐ実行 / スキップ)。
 */
import { filterJpnOnlyEntries } from "../../packages/core/src/scraper/jpn-grade";
import type { RaceListEntry } from "../../packages/core/src/scraper/types";
import { preRaceAlarmAt, startTimeEpochMs } from "./pre-race-time";
import { addDaysToKaisaiDate } from "./result-dispatch";

/** JST は UTC+9(夏時間なし)。 */
const JST_OFFSET_MS = 9 * 3600_000;

/**
 * cron の `scheduledTime`(UTC のエポックミリ秒)の **JST の暦日**を YYYYMMDD で返す。
 * @throws RangeError 有限の数でない・4桁の年に収まらない
 */
export function jstKaisaiDate(scheduledTimeMs: number): string {
  const jst = new Date(scheduledTimeMs + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  if (!Number.isFinite(scheduledTimeMs) || Number.isNaN(jst.getTime()) || year < 1000 || year > 9999) {
    throw new RangeError(`時刻はエポックミリ秒(有限の数。年が4桁に収まる範囲)で指定してください(渡された値: ${String(scheduledTimeMs).slice(0, 32)})`);
  }
  const month = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/** 事前分析の定時実行の時刻(JST の時)。1 本目 = 21 時(UTC 12:00)・2 本目 = 23 時(UTC 14:00)。`wrangler.toml` の cron と一致する(`scripts/test/cloud-config-guard.test.ts` が固定する)。 */
export const FIRST_RUN_JST_HOUR = 21;
export const RETRY_RUN_JST_HOUR = 23;
/** この時(JST)以降の実行を再実行(retry)とみなす。21 時の実行が大きく遅れても、名目の時刻(`scheduledTime`)は変わらないので、判別は揺れない。 */
export const RETRY_RUN_FROM_JST_HOUR = 22;

/** 定時の実行の種類。`first` = 21 時(翌日の事前分析を始める)/ `retry` = 23 時(再実行。失敗の救済・結果の取り込み・日報の補完・失敗の通知)。 */
export type ScheduledRunKind = "first" | "retry";

/**
 * cron の `scheduledTime` の **JST の時刻**で、実行の種類を決める({@link RETRY_RUN_FROM_JST_HOUR} 以上 = retry。それ以外 = first)。
 * `event.cron` の文字列は使わない(開催日の決定と同じ入力だけで決まり、テスト・smoke・手動起動でも `scheduledTime` だけで動かせる)。
 * @throws RangeError 時刻が不正(`jstKaisaiDate` と同じ)
 */
export function scheduledRunKind(scheduledTimeMs: number): ScheduledRunKind {
  jstKaisaiDate(scheduledTimeMs); // 不正な時刻をここで弾く(同じ検査)
  const hour = new Date(scheduledTimeMs + JST_OFFSET_MS).getUTCHours();
  return hour >= RETRY_RUN_FROM_JST_HOUR ? "retry" : "first";
}

/**
 * 事前分析で**計画する開催日** = `scheduledTime` の JST の今日 + 1(暦日の足し算。月末・年末・うるう日を正しく繰り上げる)。21 時と 23 時は JST で同じ日なので、同じ開催日になる。
 * @throws RangeError 時刻が不正、または翌日が 4 桁の年に収まらない
 */
export function planTargetDate(scheduledTimeMs: number): string {
  const next = addDaysToKaisaiDate(jstKaisaiDate(scheduledTimeMs), 1);
  if (!/^\d{8}$/.test(next)) {
    throw new RangeError(`翌日の開催日が 4 桁の年に収まりません(渡された時刻: ${String(scheduledTimeMs).slice(0, 32)})`);
  }
  return next;
}

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 開催日(YYYYMMDD)の曜日(「日」〜「土」)。形が不正・実在しない日付なら null。 */
export function kaisaiDateWeekday(kaisaiDate: string): string | null {
  if (!/^\d{8}$/.test(kaisaiDate)) {
    return null;
  }
  const y = Number(kaisaiDate.slice(0, 4));
  const m = Number(kaisaiDate.slice(4, 6));
  const d = Number(kaisaiDate.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return WEEKDAYS_JA[date.getUTCDay()] ?? null;
}

/** 自動実行の対象の会場の区分(中央 = race.netkeiba.com・地方 = nar.netkeiba.com の一覧の由来)。 */
export type AutoRunVenue = "central" | "nar";

export interface AutoRunTarget {
  /** 一覧の行そのもの(`startTime`・レース名・会場名を落とさずに運ぶ)。 */
  readonly entry: RaceListEntry;
  readonly venue: AutoRunVenue;
}

/**
 * 自動実行の対象を選ぶ。**中央は全件**(中央の `grade` は G1〜G3 などの重賞だけに付くが〈Issue #250〉、中央は grade で絞らない)、**地方は交流重賞(Jpn1/2/3)だけ**(地方の重賞・OP・L・グレードなしは除く)。
 * 並びは、**中央(入力の順のまま)→ 地方(入力の順のまま)**。入力は書き換えない。
 * どちらの一覧も、取得できなかった側は空配列で渡す(片方の取得失敗の扱いは呼び出し側〈#203〉)。
 * 中央と地方の race_id は場コード(中央 01〜10・地方 30〜64)で分かれるので、同じ開催日の1つの DO に入れても衝突しない。
 */
export function selectAutoRunTargets(lists: { readonly central: readonly RaceListEntry[]; readonly nar: readonly RaceListEntry[] }): AutoRunTarget[] {
  const central = lists.central.map((entry): AutoRunTarget => ({ entry, venue: "central" }));
  const nar = filterJpnOnlyEntries([...lists.nar]).map((entry): AutoRunTarget => ({ entry, venue: "nar" }));
  return [...central, ...nar];
}

/**
 * 発走までの最低限の余裕(ミリ秒)。**期限をすでに過ぎている**とき、発走までこれ以上残っていれば「すぐ実行」、満たなければスキップする
 * (直前すぎる分析は、結果を見て買う時間が無く、LLM の費用だけがかかる)。設定の `preRaceOffsetMinutes` の下限(10 分)と同じ。
 */
export const MIN_AUTO_RUN_LEAD_MS = 10 * 60_000;

/** スキップの理由: `no-start-time` = 発走時刻が無い・読めない / `started` = すでに発走(`now ≥ start`)/ `too-late` = 発走まで {@link MIN_AUTO_RUN_LEAD_MS} 未満。 */
export type SkipReason = "no-start-time" | "started" | "too-late";

export type DuePlan =
  /** 期限(`dueMs`)が現在以降。その時刻に実行する。 */
  | { readonly kind: "scheduled"; readonly dueMs: number; readonly startMs: number }
  /** 期限(`dueMs`)は過ぎているが、発走まで最低限の余裕がある。すぐ実行する。 */
  | { readonly kind: "immediate"; readonly dueMs: number; readonly startMs: number }
  | { readonly kind: "skip"; readonly reason: SkipReason };

export interface PlanPreRaceDueInput {
  /** 開催日(YYYYMMDD。JST の暦日)。 */
  readonly kaisaiDate: string;
  /** 発走時刻(JST の `HH:MM`)。無い・読めないとき(一覧の時刻が空の行)は `no-start-time` でスキップする。 */
  readonly startTime: string | undefined;
  /** 発走の何分前に評価するか(0 以上の整数。設定の範囲は 10〜180)。 */
  readonly offsetMinutes: number;
  /** 現在(UTC のエポックミリ秒)。 */
  readonly nowMs: number;
}

/**
 * 発走前の分析の期限(発走 − offset 分。UTC のエポックミリ秒)と、期限を過ぎていたときの判定。判定の順:
 *  1. `now ≥ start` → skip(`started`)
 *  2. `due ≥ now`(期限ちょうどを含む)→ scheduled(期限に実行)
 *  3. 期限は過ぎている: 発走まで {@link MIN_AUTO_RUN_LEAD_MS} 以上 → immediate / 未満 → skip(`too-late`)
 * 発走時刻だけが壊れているときは例外にせず skip(`no-start-time`。1レースの欠損で計画全体を落とさない)。
 * @throws RangeError offset・開催日・現在時刻(有限でない)が不正(呼び出し側のバグ。黙って通さない)
 */
export function planPreRaceDue(input: PlanPreRaceDueInput): DuePlan {
  const { kaisaiDate, startTime, offsetMinutes, nowMs } = input;
  // 契約違反(offset・開催日・現在時刻)は、発走時刻の欠損より先に投げる。nowMs が NaN だと、比較がすべて false になって `too-late` を返してしまう(#202 レビューの記録 R3)。
  preRaceAlarmAt(kaisaiDate, "00:00", offsetMinutes);
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`現在時刻は有限のエポックミリ秒で指定してください(渡された値: ${String(nowMs).slice(0, 32)})`);
  }
  if (startTime === undefined) {
    return { kind: "skip", reason: "no-start-time" };
  }
  let startMs: number;
  try {
    startMs = startTimeEpochMs(kaisaiDate, startTime);
  } catch (error) {
    if (error instanceof RangeError) {
      return { kind: "skip", reason: "no-start-time" };
    }
    throw error;
  }
  const dueMs = preRaceAlarmAt(kaisaiDate, startTime, offsetMinutes);
  if (nowMs >= startMs) {
    return { kind: "skip", reason: "started" };
  }
  if (dueMs >= nowMs) {
    return { kind: "scheduled", dueMs, startMs };
  }
  if (startMs - nowMs >= MIN_AUTO_RUN_LEAD_MS) {
    return { kind: "immediate", dueMs, startMs };
  }
  return { kind: "skip", reason: "too-late" };
}
