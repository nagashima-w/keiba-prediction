/**
 * 月報の API 呼び出しと応答の分類(Issue #265・#279)。`GET /api/monthly-reports`(一覧)・`GET /api/monthly-reports/{YYYYMM}`(本文)。読み取りだけ(段階 A。作成の依頼は cron が行う)。
 * DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**(日報の `api-report.ts` と同じ): 読む項目の型・範囲(件数は 0 以上の整数、金額は有限の数、率は null もある)を満たすときだけ成功。一部だけを採用しない。余計なキーは無視する。
 * **サーバの文面は読まない**(失敗は、ステータスと `error.type` だけで分類し、固定の文言にする)。統計の読み方は日報と共有する(`parsePeriod`)。
 * キー名・形のドリフトは `test/client-api-monthly-contract.test.ts`(実際の `handle()` の応答と、月報の組み立て〈`MonthlyReportCore`〉の出力を通す)が検出する。
 */
import { classify, isNum, isRecord, isStr, numOrNull, strOrNull, type ApiFailure, type FetchLike } from "./api";
import { isCount, isYmd, parseJobOf, parsePeriod, postRun, readBody, reportFetchFailureMessage, type JobOf, type ReportPeriod, type ReportRunOutcome } from "./api-report";
import { isRealMonth } from "./date";

/** 一覧の 1 行(本文を含まない)。 */
export interface MonthlyListItem {
  readonly month: string;
  readonly createdAt: string;
  readonly model: string | null;
  readonly raceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly summary: string | null;
}

/** 開催日 1 日分の行(サーバの `MonthDayRow`)。 */
export interface MonthlyDayRow {
  readonly date: string;
  readonly raceCount: number;
  readonly resultRaceCount: number;
  readonly noResultRaceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly recoveryRate: number | null;
  readonly judgedBetCount: number;
  readonly hitBetCount: number;
  readonly refundedBetCount: number;
}

/** プロンプトの版 1 つ分の行(サーバの `MonthVersionRow`)。版が分からない分析は null。 */
export interface MonthlyVersionRow {
  readonly promptVersion: string | null;
  readonly raceCount: number;
  readonly resultRaceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly recoveryRate: number | null;
  readonly judgedBetCount: number;
  readonly hitBetCount: number;
}

/** 月の統計(サーバの `MonthStats`): 期間の統計に、日ごとの行と版ごとの行を足したもの。 */
export interface MonthlyStats extends ReportPeriod {
  readonly days: readonly MonthlyDayRow[];
  readonly byVersion: readonly MonthlyVersionRow[];
}

/** LLM の文章(サーバの `MonthlyNarrative`。Issue #280)。 */
export interface MonthlyNarrative {
  readonly summary: string;
  readonly good: readonly string[];
  readonly improve: readonly string[];
  /** 来月に向けて。 */
  readonly outlook: readonly string[];
}

/** 月報の作成の進行状況(`phase` は月報の DO の段階)。作り直し(Issue #280)のジョブにだけ `regenerate: true` が付く。 */
export type MonthlyJob = JobOf<"read" | "generate" | "save" | "notify">;
/** サーバの `job_status`: `ok` は取得できた(job が null なら「ジョブなし」)、`unavailable` は取得に失敗した(ジョブがあるか分からない)。 */
export type MonthlyJobStatus = "ok" | "unavailable";

/** 1 か月の月報(本文つき)。 */
export interface MonthlyDetail {
  readonly month: string;
  readonly createdAt: string;
  readonly model: string | null;
  readonly raceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly summary: string | null;
  readonly stats: MonthlyStats;
  /** 最終日の結果・日報がそろうのを待ちきれずに作った(最終日の分が一部未反映かもしれない)。 */
  readonly lastDayPending: boolean;
  /** LLM の文章。使えなかった・読めなかった・文章の項目を持たない本文(段階 A の形)は null。 */
  readonly narrative: MonthlyNarrative | null;
  /** 応答が構造として読めなかったときの生の文章。 */
  readonly narrativeRaw: string | null;
  /** 文章が無い・生の文章のときの理由(サーバの固定文言)。画面は自分の固定文言を出し、これは使わない。 */
  readonly note: string | null;
  /** 月報を書いたプロンプトの版。持たない本文は null。 */
  readonly promptVersion: string | null;
}

export type MonthlyListResult = { readonly ok: true; readonly reports: readonly MonthlyListItem[] } | { readonly ok: false; readonly error: ApiFailure };
export type MonthlyDetailResult =
  | { readonly ok: true; readonly report: MonthlyDetail | null; readonly job: MonthlyJob | null; readonly jobStatus: MonthlyJobStatus }
  | { readonly ok: false; readonly error: ApiFailure };

const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isMonth = (v: unknown): v is string => isStr(v) && isRealMonth(v);

function parseListItem(row: unknown): MonthlyListItem | null {
  if (!isRecord(row)) return null;
  const { month, created_at, model, race_count, total_stake, total_return, summary } = row;
  if (!isMonth(month) || !isStr(created_at) || !strOrNull(model) || !isCount(race_count) || !isNum(total_stake) || !isNum(total_return) || !strOrNull(summary)) {
    return null;
  }
  return { month, createdAt: created_at, model, raceCount: race_count, totalStake: total_stake, totalReturn: total_return, summary };
}

function parseDay(value: unknown): MonthlyDayRow | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (
    !isYmd(v["date"]) || !isCount(v["raceCount"]) || !isCount(v["resultRaceCount"]) || !isCount(v["noResultRaceCount"]) || !isNum(v["totalStake"]) || !isNum(v["totalReturn"]) ||
    !numOrNull(v["recoveryRate"]) || !isCount(v["judgedBetCount"]) || !isCount(v["hitBetCount"]) || !isCount(v["refundedBetCount"])
  ) {
    return null;
  }
  return {
    date: v["date"], raceCount: v["raceCount"], resultRaceCount: v["resultRaceCount"], noResultRaceCount: v["noResultRaceCount"], totalStake: v["totalStake"], totalReturn: v["totalReturn"],
    recoveryRate: v["recoveryRate"], judgedBetCount: v["judgedBetCount"], hitBetCount: v["hitBetCount"], refundedBetCount: v["refundedBetCount"],
  };
}

function parseVersion(value: unknown): MonthlyVersionRow | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (
    !strOrNull(v["promptVersion"]) || !isCount(v["raceCount"]) || !isCount(v["resultRaceCount"]) || !isNum(v["totalStake"]) || !isNum(v["totalReturn"]) ||
    !numOrNull(v["recoveryRate"]) || !isCount(v["judgedBetCount"]) || !isCount(v["hitBetCount"])
  ) {
    return null;
  }
  return {
    promptVersion: v["promptVersion"], raceCount: v["raceCount"], resultRaceCount: v["resultRaceCount"], totalStake: v["totalStake"], totalReturn: v["totalReturn"],
    recoveryRate: v["recoveryRate"], judgedBetCount: v["judgedBetCount"], hitBetCount: v["hitBetCount"],
  };
}

function parseStats(value: unknown): MonthlyStats | null {
  const period = parsePeriod(value);
  if (period === null || !isRecord(value) || !isArr(value["days"]) || !isArr(value["byVersion"])) return null;
  const days: MonthlyDayRow[] = [];
  for (const d of value["days"]) {
    const parsed = parseDay(d);
    if (parsed === null) return null;
    days.push(parsed);
  }
  const byVersion: MonthlyVersionRow[] = [];
  for (const v of value["byVersion"]) {
    const parsed = parseVersion(v);
    if (parsed === null) return null;
    byVersion.push(parsed);
  }
  return { ...period, days, byVersion };
}

const isStrArr = (v: unknown): v is string[] => isArr(v) && v.every(isStr);

/** 文章を読む。無い(undefined)・null は文章なし(null)。形が壊れていれば undefined(一部だけを採用しない)。 */
function parseNarrative(value: unknown): MonthlyNarrative | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !isStr(value["summary"]) || !isStrArr(value["good"]) || !isStrArr(value["improve"]) || !isStrArr(value["outlook"])) return undefined;
  return { summary: value["summary"], good: value["good"], improve: value["improve"], outlook: value["outlook"] };
}

/** 無い(undefined)・null は null、文字列はそのまま、他は壊れた応答(undefined)。 */
function strOrAbsent(v: unknown): string | null | undefined {
  return v === undefined || v === null ? null : isStr(v) ? v : undefined;
}

function parseDetail(value: unknown): MonthlyDetail | null {
  if (!isRecord(value)) return null;
  const { month, created_at, model, race_count, total_stake, total_return, summary, body } = value;
  if (!isMonth(month) || !isStr(created_at) || !strOrNull(model) || !isCount(race_count) || !isNum(total_stake) || !isNum(total_return) || !strOrNull(summary) || !isRecord(body)) {
    return null;
  }
  const stats = parseStats(body["stats"]);
  const narrative = parseNarrative(body["narrative"]);
  const narrativeRaw = strOrAbsent(body["narrativeRaw"]);
  const note = strOrAbsent(body["note"]);
  const promptVersion = strOrAbsent(body["promptVersion"]);
  if (stats === null || typeof body["lastDayPending"] !== "boolean" || narrative === undefined || narrativeRaw === undefined || note === undefined || promptVersion === undefined) return null;
  return { month, createdAt: created_at, model, raceCount: race_count, totalStake: total_stake, totalReturn: total_return, summary, stats, lastDayPending: body["lastDayPending"], narrative, narrativeRaw, note, promptVersion };
}

const MONTHLY_PHASES = ["read", "generate", "save", "notify"] as const;

/** `GET /api/monthly-reports`。例外(同期・非同期とも)は network にする。 */
export async function fetchMonthlyList(fetchLike: FetchLike): Promise<MonthlyListResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/monthly-reports", { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  const body = await readBody(response);
  if (response.status !== 200 || !isRecord(body) || body["ok"] !== true) {
    return { ok: false, error: classify(response.status, body) };
  }
  if (!isArr(body["reports"])) return { ok: false, error: { kind: "unexpected", httpStatus: response.status } };
  const reports: MonthlyListItem[] = [];
  for (const row of body["reports"]) {
    const parsed = parseListItem(row);
    if (parsed === null) return { ok: false, error: { kind: "unexpected", httpStatus: response.status } };
    reports.push(parsed);
  }
  return { ok: true, reports };
}

/** `GET /api/monthly-reports/{month}`。月報が無い月は `report: null`。 */
export async function fetchMonthly(fetchLike: FetchLike, month: string): Promise<MonthlyDetailResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike(`/api/monthly-reports/${month}`, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  const body = await readBody(response);
  if (response.status === 404) return { ok: false, error: { kind: "not-found" } };
  if (response.status !== 200 || !isRecord(body) || body["ok"] !== true) {
    return { ok: false, error: classify(response.status, body) };
  }
  const raw = body["report"];
  // 進行状況(Issue #280)。キーが無い応答(古いサーバ)はジョブなし・ok。ある場合は形を確かめ、一部だけを採用しない。
  const job = body["job"] === undefined ? null : parseJobOf(body["job"], MONTHLY_PHASES);
  const jobStatus = body["job_status"] === undefined ? "ok" : body["job_status"];
  const unexpected = { ok: false, error: { kind: "unexpected", httpStatus: response.status } } as const;
  if (raw === undefined || job === undefined || (jobStatus !== "ok" && jobStatus !== "unavailable") || (jobStatus === "unavailable" && job !== null)) return unexpected;
  if (raw === null) return { ok: true, report: null, job, jobStatus };
  const report = parseDetail(raw);
  return report === null ? unexpected : { ok: true, report, job, jobStatus };
}

/** `POST /api/monthly-reports/run`(Issue #280。管理者だけ)。`regenerate` が true なら作り直し(月報がある月)、省略・false は手動の作成(月報が無い月)。応答の分類は日報の入口と共有する。 */
export function postMonthlyRun(fetchLike: FetchLike, month: string, regenerate: boolean = false): Promise<ReportRunOutcome> {
  return postRun(fetchLike, "/api/monthly-reports/run", "month", month, regenerate);
}

/**
 * 一覧・本文の取得の失敗の固定の文言(サーバの文面は含めない)。日報の文言(`reportFetchFailureMessage`)の「日報」を「月報」に読み替える(束の大きさを抑えるため文面を二重に持たない。
 * 日本語の文言は束の中で 1 字 6 バイトになる)。日付の画面を開けなかった旨の `not-found` だけは、月の言い方に替える。
 */
export function monthlyFetchFailureMessage(failure: ApiFailure): string {
  if (failure.kind === "not-found") return "その月の月報の画面を開けませんでした(月が正しくありません)。";
  return reportFetchFailureMessage(failure).replace(/日報/g, "月報");
}
