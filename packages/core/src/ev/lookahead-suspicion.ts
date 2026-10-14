/**
 * 先読みリーク疑いの分類(Issue #152 A)。
 *
 * 背景: 過去レースを分析すると、結果が出たあとの情報(同日の後続レースの結果・当該レース自身の走・
 * 重賞の当該回以降の結果)が戦績やプロンプトに混ざり、予想が結果に引っ張られて検証の回収率・
 * キャリブレーションが過大になる。#39 が戦績側(`analyses.history_cutoff_date`)、#153 がプロンプト側
 * (`analyses.prompt_lookahead_guarded`)の遮断を入れた。どちらも NULL 許容で、遮断より前に保存された
 * 行は NULL のままである。検証画面(B)は、これらの行を集計から除外できるようにする。
 *
 * この関数は1つの保存済み分析を3つに分類する純関数で、副作用も DB アクセスも無い。
 * - `clean`: リークの疑いが無い。
 * - `suspect`: 遮断の記録が無く、発走以降(または発走後と断定できる日)に分析された。リーク疑い。
 * - `unknown`: 遮断の記録が無く、発走の前後を判定できない。「疑い」とは別に数える(ユーザー判断)。
 *
 * 判定は2段:
 * 1. **遮断済みか**: `historyCutoffDate !== null` かつ(LLM 未使用〈`promptVersion === null`〉または
 *    `promptLookaheadGuarded === true`)なら、発走の前後にかかわらず clean。`=== true` で見る
 *    (`false`〈明示的に未遮断〉と `null`〈記録なし〉は、どちらも遮断済みとは扱わない)。
 *    LLM 未使用の分析はプロンプト側の遮断の対象外(プロンプトを使っていない)なので、戦績側の印だけを見る。
 * 2. **発走の前後**(1で clean にならなかった行): 開催日 = `kaisaiDate ?? kaisaiDateFromNarRaceId(raceId)`。
 *    発走時刻 = スナップショットの `race.startTime`(`HH:MM`。JST)。
 *    - 時刻がある: `analyzedAt < 発走` なら clean、`>=` なら suspect(発走ちょうども suspect)。
 *    - 時刻が無い: 開催日の 00:00 JST より前 → clean、開催日の翌日 00:00 JST 以降 → suspect、
 *      同日 → unknown。
 *    - 開催日が決まらない(中央で `kaisaiDate` が無い等)・`analyzedAt` が読めない → unknown。
 *
 * 比較は JST の発走時刻を UTC に直した ms の数値で行い、文字列では比べない。地方のナイター
 * (例: 20:50 JST = 11:50Z)や深夜の発走で、UTC と JST の日付がずれて前後を取り違えるのを避けるため。
 *
 * 限界(【記録】): 遅延発走は反映されない(スナップショットの予定時刻を使う)。LLM が失敗して prior を
 * 採用した行は `promptVersion` が非 NULL のまま保存されうるため、遮断マーカーが無ければ suspect 側に倒れる。
 */

import { kaisaiDateFromNarRaceId, parseKaisaiDate } from "../scraper/ids.js";
import type { StoredAnalysis } from "./analysis-store-types.js";

/** 分類の結果。 */
export type LookaheadSuspicion = "clean" | "suspect" | "unknown";

/** 分類に必要な `StoredAnalysis` のフィールド(テストで全フィールドを組み立てずに済ませるため絞る)。 */
export type LookaheadSuspicionInput = Pick<
  StoredAnalysis,
  | "raceId"
  | "analyzedAt"
  | "kaisaiDate"
  | "promptVersion"
  | "historyCutoffDate"
  | "promptLookaheadGuarded"
  | "raceSnapshot"
>;

/** JST は UTC+9。JST の時刻から UTC の時刻へは 9 を引く。 */
const JST_OFFSET_HOURS = 9;

/** 発走時刻 `HH:MM`(24時間表記、時は1〜2桁)。 */
const START_TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** タイムゾーン指定(`Z` または `±hh:mm`)で終わる日時だけを読める日時とする。 */
const TIMEZONE_SUFFIX_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 遮断済みか(分類の第1段)。`historyCutoffDate !== null` かつ(LLM 未使用〈`promptVersion === null`〉または
 * `promptLookaheadGuarded === true`)。true なら発走の前後・分析時刻・スナップショットを一切見ずに clean になる。
 *
 * Issue #219: クラウド版は、発走時刻の写しを確認できなかった行のうち**判定に影響しうるもの**(= この関数が false の行)を数えるために使う。
 * 定義を分類と1か所で共有する(別々に書くと、数える対象と判定が食い違う)。
 */
export function isLookaheadGuarded(
  analysis: Pick<LookaheadSuspicionInput, "historyCutoffDate" | "promptVersion" | "promptLookaheadGuarded">,
): boolean {
  const historyGuarded = analysis.historyCutoffDate !== null;
  const promptGuarded = analysis.promptVersion === null || analysis.promptLookaheadGuarded === true;
  return historyGuarded && promptGuarded;
}

/**
 * 保存済み分析を clean / suspect / unknown に分類する。
 * @param analysis 分類対象(`StoredAnalysis` の一部でよい)
 */
export function classifyLookaheadSuspicion(analysis: LookaheadSuspicionInput): LookaheadSuspicion {
  // ステップ1: 遮断済みなら発走の前後を見ない。
  if (isLookaheadGuarded(analysis)) {
    return "clean";
  }

  // ステップ2: 発走の前後。analyzedAt が読めなければ以降の比較は意味を持たない(NaN は必ず弾く)。
  const analyzedAtMs = parseAnalyzedAt(analysis.analyzedAt);
  if (analyzedAtMs === null) {
    return "unknown";
  }

  const date = resolveKaisaiDate(analysis);
  if (date === null) {
    return "unknown";
  }

  const startTime = readStartTime(analysis.raceSnapshot);
  if (startTime !== null) {
    const startMs = jstToUtcMs(date, startTime.hour, startTime.minute);
    return analyzedAtMs < startMs ? "clean" : "suspect";
  }

  // 時刻が無い: 開催日の 00:00 JST と翌日 00:00 JST を境にする。
  const dayStartMs = jstToUtcMs(date, 0, 0);
  const nextDayStartMs = jstToUtcMs(date, 24, 0);
  if (analyzedAtMs < dayStartMs) {
    return "clean";
  }
  if (analyzedAtMs >= nextDayStartMs) {
    return "suspect";
  }
  return "unknown";
}

/** 開催日(年月日)。 */
interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * ISO 8601 の日時(タイムゾーン指定付き)を UTC の ms に直す。読めなければ null。
 * タイムゾーン指定が無い日時文字列は、`Date.parse` が実行環境のローカル時刻として解釈して
 * 結果が環境で変わるため、読めないものとして扱う。
 */
function parseAnalyzedAt(analyzedAt: string): number | null {
  if (!TIMEZONE_SUFFIX_PATTERN.test(analyzedAt)) {
    return null;
  }
  const ms = Date.parse(analyzedAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 開催日 = `kaisaiDate ?? kaisaiDateFromNarRaceId(raceId)`。決まらなければ null。
 * `kaisaiDate` があるのに実在日として読めない場合は、raceId から推測せず日付不明とする。
 */
function resolveKaisaiDate(analysis: LookaheadSuspicionInput): DateParts | null {
  const raw = analysis.kaisaiDate ?? kaisaiDateFromNarRaceId(analysis.raceId);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = parseKaisaiDate(raw);
    return {
      year: Number(parsed.slice(0, 4)),
      month: Number(parsed.slice(4, 6)),
      day: Number(parsed.slice(6, 8)),
    };
  } catch {
    return null;
  }
}

/**
 * スナップショット(JSON 復元済みの未検証値)から発走時刻の文字列を取り出す(読める形のときだけ)。
 * オブジェクトでない・`race.startTime` が文字列でない・時刻の形でない・範囲外は null(=時刻なし)。
 *
 * Issue #219: クラウド版は、スナップショットが R2 にしか無いため、この関数で取り出した文字列を
 * D1 の `analyses.start_time` に写して先読み判定に使う。**判定(`classifyLookaheadSuspicion`)と写しの補完が
 * 同じ受理条件を使う**ように、取り出しをここに一本化している(別々に正規表現を持つと、片方だけ受理する値で
 * exe とクラウド版の判定が食い違う)。
 */
export function extractStartTime(snapshot: unknown): string | null {
  return readStartTime(snapshot)?.text ?? null;
}

/**
 * スナップショット(JSON 復元済みの未検証値)から発走時刻 `HH:MM` を防御的に読む。
 * オブジェクトでない・`race.startTime` が文字列でない・時刻の形でない・範囲外は null(=時刻なし)。
 */
function readStartTime(snapshot: unknown): { hour: number; minute: number; text: string } | null {
  if (typeof snapshot !== "object" || snapshot === null) {
    return null;
  }
  const race = (snapshot as { race?: unknown }).race;
  if (typeof race !== "object" || race === null) {
    return null;
  }
  const startTime = (race as { startTime?: unknown }).startTime;
  if (typeof startTime !== "string") {
    return null;
  }
  const match = START_TIME_PATTERN.exec(startTime);
  if (match === null) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return { hour, minute, text: startTime };
}

/**
 * 開催日の JST の時刻を UTC の ms に直す。`hour=24` で翌日 00:00 JST になる(`Date.UTC` が桁上がりを処理する)。
 */
function jstToUtcMs(date: DateParts, hour: number, minute: number): number {
  return Date.UTC(date.year, date.month - 1, date.day, hour - JST_OFFSET_HOURS, minute);
}
