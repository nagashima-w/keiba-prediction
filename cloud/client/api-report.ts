/**
 * 日報の API 呼び出しと応答の分類(Issue #235)。`GET /api/reports`(一覧)・`GET /api/reports/{YYYYMMDD}`(本文 + 進行状況)・`POST /api/reports/run`(手動の作成)。
 * DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**: 読む項目の型・範囲(件数は 0 以上の整数、金額は有限の数、率は null もある)を満たすときだけ成功。一部だけを採用しない。余計なキーは無視する。
 * **サーバの文面は読まない**(失敗は、ステータスと `error.type`〈サーバが決めた固定の識別子〉だけで分類し、固定の文言にする)。
 * キー名・形のドリフトは `test/client-api-report-contract.test.ts`(実際の `handle()` の応答と、日報の組み立て〈`DailyReportCore`〉の出力を通す)が検出する。
 */
import { classify, isNum, isRecord, isStr, strOrNull, type ApiFailure, type FetchLike } from "./api";

/** 一覧の 1 行(本文を含まない)。 */
export interface ReportListItem {
  readonly date: string;
  readonly createdAt: string;
  readonly model: string | null;
  readonly raceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly summary: string | null;
}

export interface ReportBetTypeStat {
  readonly betCount: number;
  readonly hitCount: number;
  readonly stake: number;
  readonly payout: number;
}

export interface ReportMarkStat {
  readonly mark: string;
  readonly count: number;
  readonly win: number;
  readonly top3: number;
}

/** 1 日の統計(サーバの `DayStats`)。 */
export interface ReportStats {
  readonly raceCount: number;
  readonly resultRaceCount: number;
  readonly noResultRaceCount: number;
  readonly betRaceCount: number;
  readonly llmUsedRaceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly recoveryRate: number | null;
  readonly judgedBetCount: number;
  readonly hitBetCount: number;
  readonly unjudgedBetCount: number;
  readonly unjudgedStake: number;
  readonly byBetType: Readonly<Record<string, ReportBetTypeStat>>;
  readonly byMark: readonly ReportMarkStat[];
}

export interface ReportTopHorse {
  readonly umaban: number;
  readonly name: string | null;
  readonly finishPosition: number;
}

export interface ReportMarkedHorse {
  readonly mark: string;
  readonly umaban: number;
  readonly name: string | null;
  readonly finishPosition: number | null;
}

/** レースごとの行(サーバの `ReportRaceRow`)。 */
export interface ReportRace {
  readonly raceId: string;
  readonly analysisId: number;
  readonly title: string;
  readonly llmUsed: boolean;
  readonly hasResult: boolean;
  readonly top3: readonly ReportTopHorse[];
  readonly marks: readonly ReportMarkedHorse[];
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly judgedBetCount: number;
  readonly hitCount: number;
  readonly unjudgedBetCount: number;
  readonly allocationNote: string | null;
  readonly comment: string | null;
}

export interface ReportNarrative {
  readonly summary: string;
  readonly good: readonly string[];
  readonly improve: readonly string[];
}

/** 1 日の日報(本文つき)。 */
export interface ReportDetail {
  readonly date: string;
  readonly createdAt: string;
  readonly model: string | null;
  readonly raceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly summary: string | null;
  readonly stats: ReportStats;
  readonly races: readonly ReportRace[];
  readonly narrative: ReportNarrative | null;
  /** 応答が構造として読めなかったときの生の文章。 */
  readonly narrativeRaw: string | null;
  /** 文章が無い・生の文章のときの理由(サーバの固定文言)。 */
  readonly note: string | null;
}

/** 日報の作成の進行状況(日報が無い日だけ付く)。 */
export interface ReportJob {
  readonly phase: "list" | "gather" | "generate" | "save" | "notify";
  readonly status: "running" | "failed";
  readonly attempts: number;
}

export type ReportListResult = { readonly ok: true; readonly reports: readonly ReportListItem[] } | { readonly ok: false; readonly error: ApiFailure };
export type ReportDetailResult =
  | { readonly ok: true; readonly report: ReportDetail | null; readonly job: ReportJob | null }
  | { readonly ok: false; readonly error: ApiFailure };

const isCount = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

function parseListItem(row: unknown): ReportListItem | null {
  if (!isRecord(row)) return null;
  const { date, created_at, model, race_count, total_stake, total_return, summary } = row;
  if (!isStr(date) || !/^[0-9]{8}$/.test(date) || !isStr(created_at) || !strOrNull(model) || !isCount(race_count) || !isNum(total_stake) || !isNum(total_return) || !strOrNull(summary)) {
    return null;
  }
  return { date, createdAt: created_at, model, raceCount: race_count, totalStake: total_stake, totalReturn: total_return, summary };
}

function parseStats(value: unknown): ReportStats | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (
    !isCount(v["raceCount"]) || !isCount(v["resultRaceCount"]) || !isCount(v["noResultRaceCount"]) || !isCount(v["betRaceCount"]) || !isCount(v["llmUsedRaceCount"]) ||
    !isNum(v["totalStake"]) || !isNum(v["totalReturn"]) || !numOrNull(v["recoveryRate"]) || !isCount(v["judgedBetCount"]) || !isCount(v["hitBetCount"]) ||
    !isCount(v["unjudgedBetCount"]) || !isNum(v["unjudgedStake"]) || !isRecord(v["byBetType"]) || !isArr(v["byMark"])
  ) {
    return null;
  }
  const byBetType: Record<string, ReportBetTypeStat> = {};
  for (const [type, stat] of Object.entries(v["byBetType"])) {
    if (!isRecord(stat) || !isCount(stat["betCount"]) || !isCount(stat["hitCount"]) || !isNum(stat["stake"]) || !isNum(stat["payout"])) return null;
    byBetType[type] = { betCount: stat["betCount"], hitCount: stat["hitCount"], stake: stat["stake"], payout: stat["payout"] };
  }
  const byMark: ReportMarkStat[] = [];
  for (const m of v["byMark"]) {
    if (!isRecord(m) || !isStr(m["mark"]) || !isCount(m["count"]) || !isCount(m["win"]) || !isCount(m["top3"])) return null;
    byMark.push({ mark: m["mark"], count: m["count"], win: m["win"], top3: m["top3"] });
  }
  return {
    raceCount: v["raceCount"], resultRaceCount: v["resultRaceCount"], noResultRaceCount: v["noResultRaceCount"], betRaceCount: v["betRaceCount"], llmUsedRaceCount: v["llmUsedRaceCount"],
    totalStake: v["totalStake"], totalReturn: v["totalReturn"], recoveryRate: v["recoveryRate"], judgedBetCount: v["judgedBetCount"], hitBetCount: v["hitBetCount"],
    unjudgedBetCount: v["unjudgedBetCount"], unjudgedStake: v["unjudgedStake"], byBetType, byMark,
  };
}

function parseRace(value: unknown): ReportRace | null {
  if (!isRecord(value)) return null;
  const r = value;
  if (
    !isStr(r["raceId"]) || !isCount(r["analysisId"]) || !isStr(r["title"]) || typeof r["llmUsed"] !== "boolean" || typeof r["hasResult"] !== "boolean" ||
    !isArr(r["top3"]) || !isArr(r["marks"]) || !isNum(r["totalStake"]) || !isNum(r["totalReturn"]) || !isCount(r["judgedBetCount"]) || !isCount(r["hitCount"]) ||
    !isCount(r["unjudgedBetCount"]) || !strOrNull(r["allocationNote"]) || !strOrNull(r["comment"])
  ) {
    return null;
  }
  const top3: ReportTopHorse[] = [];
  for (const t of r["top3"]) {
    if (!isRecord(t) || !isCount(t["umaban"]) || !strOrNull(t["name"]) || !isCount(t["finishPosition"])) return null;
    top3.push({ umaban: t["umaban"], name: t["name"], finishPosition: t["finishPosition"] });
  }
  const marks: ReportMarkedHorse[] = [];
  for (const m of r["marks"]) {
    if (!isRecord(m) || !isStr(m["mark"]) || !isCount(m["umaban"]) || !strOrNull(m["name"]) || !(m["finishPosition"] === null || isCount(m["finishPosition"]))) return null;
    marks.push({ mark: m["mark"], umaban: m["umaban"], name: m["name"], finishPosition: m["finishPosition"] });
  }
  return {
    raceId: r["raceId"], analysisId: r["analysisId"], title: r["title"], llmUsed: r["llmUsed"], hasResult: r["hasResult"], top3, marks, totalStake: r["totalStake"], totalReturn: r["totalReturn"],
    judgedBetCount: r["judgedBetCount"], hitCount: r["hitCount"], unjudgedBetCount: r["unjudgedBetCount"], allocationNote: r["allocationNote"], comment: r["comment"],
  };
}

function strings(value: unknown): string[] | null {
  return isArr(value) && value.every(isStr) ? [...value] : null;
}

function parseNarrative(value: unknown): ReportNarrative | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isStr(value["summary"])) return undefined;
  const good = strings(value["good"]);
  const improve = strings(value["improve"]);
  return good === null || improve === null ? undefined : { summary: value["summary"], good, improve };
}

function parseDetail(value: unknown): ReportDetail | null {
  if (!isRecord(value)) return null;
  const { date, created_at, model, race_count, total_stake, total_return, summary, body } = value;
  if (!isStr(date) || !/^[0-9]{8}$/.test(date) || !isStr(created_at) || !strOrNull(model) || !isCount(race_count) || !isNum(total_stake) || !isNum(total_return) || !strOrNull(summary) || !isRecord(body)) {
    return null;
  }
  const stats = parseStats(body["stats"]);
  const narrative = parseNarrative(body["narrative"]);
  if (stats === null || narrative === undefined || !isArr(body["races"]) || !strOrNull(body["narrativeRaw"]) || !strOrNull(body["note"])) {
    return null;
  }
  const races: ReportRace[] = [];
  for (const r of body["races"]) {
    const parsed = parseRace(r);
    if (parsed === null) return null;
    races.push(parsed);
  }
  return {
    date, createdAt: created_at, model, raceCount: race_count, totalStake: total_stake, totalReturn: total_return, summary, stats, races, narrative,
    narrativeRaw: body["narrativeRaw"], note: body["note"],
  };
}

function parseJob(value: unknown): ReportJob | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { phase, status, attempts } = value;
  if ((phase !== "list" && phase !== "gather" && phase !== "generate" && phase !== "save" && phase !== "notify") || (status !== "running" && status !== "failed") || !isCount(attempts)) {
    return undefined;
  }
  return { phase, status, attempts };
}

async function readBody(response: Awaited<ReturnType<FetchLike>>): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** `GET /api/reports`。例外(同期・非同期とも)は network にする。 */
export async function fetchReportList(fetchLike: FetchLike): Promise<ReportListResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/reports", { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  const body = await readBody(response);
  if (response.status !== 200 || !isRecord(body) || body["ok"] !== true) {
    return { ok: false, error: classify(response.status, body) };
  }
  if (!isArr(body["reports"])) return { ok: false, error: { kind: "unexpected", httpStatus: response.status } };
  const reports: ReportListItem[] = [];
  for (const row of body["reports"]) {
    const parsed = parseListItem(row);
    if (parsed === null) return { ok: false, error: { kind: "unexpected", httpStatus: response.status } };
    reports.push(parsed);
  }
  return { ok: true, reports };
}

/** `GET /api/reports/{date}`。日報が無い日は `report: null`(進行状況が `job`)。 */
export async function fetchReport(fetchLike: FetchLike, date: string): Promise<ReportDetailResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike(`/api/reports/${date}`, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  const body = await readBody(response);
  if (response.status === 404) return { ok: false, error: { kind: "not-found" } };
  if (response.status !== 200 || !isRecord(body) || body["ok"] !== true) {
    return { ok: false, error: classify(response.status, body) };
  }
  const job = parseJob(body["job"]);
  const raw = body["report"];
  const report = raw === null ? null : parseDetail(raw);
  if (job === undefined || (raw !== null && report === null) || raw === undefined) {
    return { ok: false, error: { kind: "unexpected", httpStatus: response.status } };
  }
  return { ok: true, report, job };
}

export type ReportRunOutcome =
  | { readonly kind: "accepted" }
  /** 202 だが本文が想定外(契約のずれ)。サーバは依頼を受け付けている。 */
  | { readonly kind: "accepted-malformed" }
  | { readonly kind: "already-exists" }
  | { readonly kind: "in-progress" }
  | { readonly kind: "failed"; readonly failure: ApiFailure };

/** `POST /api/reports/run`。Origin の扱いは `api-run.ts` の説明と同じ(`referrerPolicy` を付け、`mode` は指定しない)。 */
export async function postReportRun(fetchLike: FetchLike, date: string): Promise<ReportRunOutcome> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/reports/run", {
      method: "POST",
      credentials: "same-origin",
      referrerPolicy: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ date }),
    });
  } catch {
    return { kind: "failed", failure: { kind: "network" } };
  }
  const body = await readBody(response);
  if (response.status === 202) {
    return isRecord(body) && body["ok"] === true && body["accepted"] === true && body["date"] === date ? { kind: "accepted" } : { kind: "accepted-malformed" };
  }
  if (response.status === 409) {
    const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
    if (error?.["type"] === "already-exists") return { kind: "already-exists" };
    if (error?.["type"] === "in-progress") return { kind: "in-progress" };
    return { kind: "failed", failure: { kind: "unexpected", httpStatus: 409 } };
  }
  if (response.status === 400 || response.status === 413 || response.status === 415) return { kind: "failed", failure: { kind: "bad-request" } };
  const failure = classify(response.status, body);
  return { kind: "failed", failure: failure.kind === "netkeiba-unavailable" ? { kind: "server-error" } : failure };
}

/** 一覧・本文の取得の失敗の固定の文言(サーバの文面は含めない)。 */
export function reportFetchFailureMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case "forbidden":
      return "日報を読み込めませんでした。アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてください。";
    case "origin-mismatch":
      return "日報を読み込めませんでした(送信元の確認に失敗)。ページを再読み込みしてください。";
    case "network":
      return "日報の通信に失敗しました。ログインの期限切れかもしれません。ページを再読み込みしてください。";
    case "bad-request":
      return "日報のリクエストが正しくありません。";
    case "not-found":
      return "その日の日報の画面を開けませんでした(日付が正しくありません)。";
    case "server-error":
    case "netkeiba-unavailable":
      return "日報を読み込めませんでした。サーバでエラーが起きました。少し待ってから、もう一度開いてください。";
    case "unexpected":
      return `日報の応答が想定外でした(HTTP ${failure.httpStatus})。少し待ってから、もう一度開いてください。`;
  }
}

/** 手動の作成の失敗の固定の文言。 */
export function reportRunFailureMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case "origin-mismatch":
      return "日報の作成の依頼の送信元の確認に失敗しました(Origin の不一致)。ページを再読み込みしてください。";
    case "forbidden":
      return "日報を作れませんでした。アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてください。";
    case "network":
      return "日報の作成の通信に失敗しました。ページを再読み込みしてください。もう一度押して再試行することもできます。";
    case "bad-request":
      return "日報の作成のリクエストが正しくありません(日付を確認してください)。";
    case "server-error":
    case "netkeiba-unavailable":
    case "not-found":
      return "日報を作れませんでした。サーバでエラーが起きました。少し待ってから、もう一度押してください。";
    case "unexpected":
      return `日報の作成の応答が想定外でした(HTTP ${failure.httpStatus})。少し待ってから、もう一度押してください。`;
  }
}
