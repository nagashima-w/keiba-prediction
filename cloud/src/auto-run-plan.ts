/**
 * 定時の自動実行(Issue #166)の純関数(Issue #202〈#166-A〉)。**`cloudflare:workers` も DO・gate・D1 も import しない**ので、Node の vitest でそのままテストできる。
 * ここにあるのは「何を・いつ実行するか」の判断だけ。実際の予約・アラーム・取得は #203〜#206(DO の計画・発走前の予約・通知・cron)。
 *
 *  - {@link jstKaisaiDate}: cron の `scheduledTime`(UTC のエポックミリ秒)から、**JST の開催日**(YYYYMMDD)を求める。cron は UTC で動く(JST 9:00 = UTC 0:00)ので、
 *    UTC の日付をそのまま使うと、UTC 15:00〜23:59(= JST の翌日 0:00〜8:59)で1日ずれる。`Date.now()` ではなく `scheduledTime` を使うのは、cron の重複配信(at-least-once)でも同じ日になるため。
 *  - {@link selectAutoRunTargets}: 自動実行の対象。**中央は全件、地方は交流重賞(Jpn1/2/3)だけ**(`filterJpnOnlyEntries`。地方の重賞・OP・L は対象外)。
 *  - {@link planPreRaceDue}: 発走前の分析の期限(発走 − offset 分)と、期限を過ぎていたときの判定(すぐ実行 / スキップ)。
 */
import { filterJpnOnlyEntries } from "../../packages/core/src/scraper/jpn-grade";
import type { RaceListEntry } from "../../packages/core/src/scraper/types";
import { preRaceAlarmAt, startTimeEpochMs } from "./pre-race-time";

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

/** 自動実行の対象の会場の区分(中央 = race.netkeiba.com・地方 = nar.netkeiba.com の一覧の由来)。 */
export type AutoRunVenue = "central" | "nar";

export interface AutoRunTarget {
  /** 一覧の行そのもの(`startTime`・レース名・会場名を落とさずに運ぶ)。 */
  readonly entry: RaceListEntry;
  readonly venue: AutoRunVenue;
}

/**
 * 自動実行の対象を選ぶ。**中央は全件**(中央の一覧は grade が常に空なので、絞り込まない)、**地方は交流重賞(Jpn1/2/3)だけ**(地方の重賞・OP・L・グレードなしは除く)。
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
 * @throws RangeError offset・開催日が不正(呼び出し側のバグ。黙って通さない)
 */
export function planPreRaceDue(input: PlanPreRaceDueInput): DuePlan {
  const { kaisaiDate, startTime, offsetMinutes, nowMs } = input;
  // 契約違反(offset・開催日)は、発走時刻の欠損より先に投げる。
  preRaceAlarmAt(kaisaiDate, "00:00", offsetMinutes);
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
