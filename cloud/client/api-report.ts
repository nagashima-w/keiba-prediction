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
  /** 返還(取消・除外の馬への買い目。Issue #278)の点数。`betCount` に含まれる内訳。この項目を持つ前の日報には無い。 */
  readonly refundCount?: number;
  /** 見込みの的中数(Issue #264)。この項目を持つ前の日報には無い。 */
  readonly expectedBetCount?: number;
  readonly expectedHits?: number;
  readonly expectedBaseHits?: number;
}

export interface ReportMarkStat {
  readonly mark: string;
  readonly count: number;
  readonly win: number;
  readonly top3: number;
}

/** 印の定型の買い方の型 1 つぶんの成績(サーバの `TemplateStat`。Issue #272)。 */
export interface ReportTemplateStat {
  readonly betCount: number;
  readonly hitCount: number;
  readonly stake: number;
  readonly payout: number;
  readonly unjudgedCount: number;
  readonly inapplicableCount: number;
  /** 判定できた点数のうち返還(Issue #278)のレース数。`betCount` に含まれる内訳。この項目を持つ前の日報には無い。 */
  readonly refundCount?: number;
}

/** 惜しかったレース(サーバの `NearMissSummary`。Issue #272)。 */
export interface ReportNearMisses {
  readonly total: number;
  readonly shown: readonly { readonly raceId: string; readonly templateId: string; readonly payout: number }[];
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
  /** 返還(取消・除外の馬への買い目。Issue #278)の点数と賭け金。`judgedBetCount`・`totalStake` に含まれる内訳。この項目を持つ前の日報には無い(無いものを 0 点とみなさない)。 */
  readonly refundedBetCount?: number;
  readonly refundedStake?: number;
  /** 見込みの的中数(確率のある買い目の点数・的中確率の合計・同じ買い目の実際の的中数)と、最大払戻の 1 点(Issue #264)。この項目を持つ前の日報には無い。 */
  readonly expectedBetCount?: number;
  readonly expectedHits?: number;
  readonly expectedBaseHits?: number;
  readonly maxPayout?: number;
  readonly maxPayoutStake?: number;
  readonly byBetType: Readonly<Record<string, ReportBetTypeStat>>;
  readonly byMark: readonly ReportMarkStat[];
  /** 印の定型の買い方の型ごとの成績(Issue #272)。この項目を持つ前の日報には無い。null は、旧形のジョブで作った日報(成績を作れなかった)。 */
  readonly whatIf?: Readonly<Record<string, ReportTemplateStat>> | null;
}

/** 期間の統計(サーバの `PeriodStats`。Issue #264)。 */
export interface ReportPeriod extends ReportStats {
  readonly fromDate: string;
  readonly toDate: string;
  /** 期間のうち、分析のあった開催日の数。 */
  readonly dayCount: number;
}

/** 直前 27 日と直近 28 日の累計(サーバの `RollingSummary`。Issue #264)。この項目を持つ前の日報には無い。 */
export interface ReportRolling {
  readonly windowDays: number;
  readonly prior: ReportPeriod;
  readonly total: ReportPeriod;
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
  /** 返還(Issue #278)の点数。`judgedBetCount` に含まれる内訳。この項目を持つ前の日報には無い。 */
  readonly refundedBetCount?: number;
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
  /** 直前 27 日と直近 28 日の累計(Issue #264)。この項目を持つ前の日報には無い。 */
  readonly rolling?: ReportRolling;
  /** 惜しかったレース(Issue #272)。この項目を持つ前の日報、旧形のジョブで作った日報には無い。 */
  readonly nearMisses?: ReportNearMisses;
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
  /** 作り直し(Issue #268)のジョブにだけ付く(`true`)。通常の作成のジョブにはキーそのものが無い。 */
  readonly regenerate?: true;
}

export type ReportListResult = { readonly ok: true; readonly reports: readonly ReportListItem[] } | { readonly ok: false; readonly error: ApiFailure };
/**
 * 進行状況の取得の結果(Issue #245。サーバの `job_status`)。`ok`: 取得できた(`job` が null なら「ジョブが無い」)。
 * `unavailable`: 日報の DO の取得に失敗した(`job` は null だが、ジョブが無いのではなく**分からない**)。
 */
export type ReportJobStatus = "ok" | "unavailable";

export type ReportDetailResult =
  | { readonly ok: true; readonly report: ReportDetail | null; readonly job: ReportJob | null; readonly jobStatus: ReportJobStatus }
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

/**
 * 見込みの項目(Issue #264)を読む。**全部あるか、全部無いか**(一部だけは壊れた応答として null)。全部無ければ空のオブジェクト(キーを足さない)。
 * `counts` は 0 以上の整数、`nums` は有限の数。
 */
function parseOptionalGroup(v: Record<string, unknown>, counts: readonly string[], nums: readonly string[]): Record<string, number> | null {
  const keys = [...counts, ...nums];
  const present = keys.filter((k) => k in v);
  if (present.length === 0) return {};
  if (present.length !== keys.length) return null;
  const out: Record<string, number> = {};
  for (const k of counts) {
    const x = v[k];
    if (!isCount(x)) return null;
    out[k] = x;
  }
  for (const k of nums) {
    const x = v[k];
    if (!isNum(x)) return null;
    out[k] = x;
  }
  return out;
}

/** 1 つだけの任意の件数(Issue #278 の返還の項目)。無ければ空のオブジェクト(キーを足さない)、あって 0 以上の整数でなければ null(壊れた応答)。 */
function optionalCount(v: Record<string, unknown>, key: string): Record<string, number> | null {
  if (!(key in v)) return {};
  const x = v[key];
  return isCount(x) ? { [key]: x } : null;
}

/** 印の定型の成績(Issue #272)を読む。null はそのまま null。壊れていれば undefined(呼び出し側が応答全体を捨てる)。 */
function parseWhatIf(value: unknown): Record<string, ReportTemplateStat> | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const out: Record<string, ReportTemplateStat> = {};
  for (const [id, t] of Object.entries(value)) {
    if (!isRecord(t) || !isCount(t["betCount"]) || !isCount(t["hitCount"]) || !isNum(t["stake"]) || !isNum(t["payout"]) || !isCount(t["unjudgedCount"]) || !isCount(t["inapplicableCount"])) return undefined;
    const refund = optionalCount(t, "refundCount");
    if (refund === null) return undefined;
    out[id] = { betCount: t["betCount"], hitCount: t["hitCount"], stake: t["stake"], payout: t["payout"], unjudgedCount: t["unjudgedCount"], inapplicableCount: t["inapplicableCount"], ...refund };
  }
  return out;
}

function parseNearMisses(value: unknown): ReportNearMisses | null {
  if (!isRecord(value) || !isCount(value["total"]) || !isArr(value["shown"])) return null;
  const shown: ReportNearMisses["shown"][number][] = [];
  for (const n of value["shown"]) {
    if (!isRecord(n) || !isStr(n["raceId"]) || !isStr(n["templateId"]) || !isNum(n["payout"])) return null;
    shown.push({ raceId: n["raceId"], templateId: n["templateId"], payout: n["payout"] });
  }
  return { total: value["total"], shown };
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
    const typeExpected = parseOptionalGroup(stat, ["expectedBetCount", "expectedBaseHits"], ["expectedHits"]);
    if (typeExpected === null) return null;
    const typeRefund = optionalCount(stat, "refundCount");
    if (typeRefund === null) return null;
    byBetType[type] = { betCount: stat["betCount"], hitCount: stat["hitCount"], stake: stat["stake"], payout: stat["payout"], ...typeRefund, ...typeExpected };
  }
  const byMark: ReportMarkStat[] = [];
  for (const m of v["byMark"]) {
    if (!isRecord(m) || !isStr(m["mark"]) || !isCount(m["count"]) || !isCount(m["win"]) || !isCount(m["top3"])) return null;
    byMark.push({ mark: m["mark"], count: m["count"], win: m["win"], top3: m["top3"] });
  }
  const expected = parseOptionalGroup(v, ["expectedBetCount", "expectedBaseHits"], ["expectedHits", "maxPayout", "maxPayoutStake"]);
  if (expected === null) return null;
  const refund = parseOptionalGroup(v, ["refundedBetCount"], ["refundedStake"]);
  if (refund === null) return null;
  const whatIf = "whatIf" in v ? parseWhatIf(v["whatIf"]) : undefined;
  if ("whatIf" in v && whatIf === undefined) return null;
  return {
    raceCount: v["raceCount"], resultRaceCount: v["resultRaceCount"], noResultRaceCount: v["noResultRaceCount"], betRaceCount: v["betRaceCount"], llmUsedRaceCount: v["llmUsedRaceCount"],
    totalStake: v["totalStake"], totalReturn: v["totalReturn"], recoveryRate: v["recoveryRate"], judgedBetCount: v["judgedBetCount"], hitBetCount: v["hitBetCount"],
    unjudgedBetCount: v["unjudgedBetCount"], unjudgedStake: v["unjudgedStake"], ...refund, ...expected, byBetType, byMark, ...(whatIf === undefined ? {} : { whatIf }),
  };
}

const isYmd = (v: unknown): v is string => isStr(v) && /^[0-9]{8}$/.test(v);

function parsePeriod(value: unknown): ReportPeriod | null {
  const stats = parseStats(value);
  if (stats === null || !isRecord(value) || !isYmd(value["fromDate"]) || !isYmd(value["toDate"]) || !isCount(value["dayCount"])) return null;
  return { ...stats, fromDate: value["fromDate"], toDate: value["toDate"], dayCount: value["dayCount"] };
}

function parseRolling(value: unknown): ReportRolling | null {
  if (!isRecord(value) || !isCount(value["windowDays"])) return null;
  const prior = parsePeriod(value["prior"]);
  const total = parsePeriod(value["total"]);
  return prior === null || total === null ? null : { windowDays: value["windowDays"], prior, total };
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
  const refund = optionalCount(r, "refundedBetCount");
  if (refund === null) return null;
  return {
    raceId: r["raceId"], analysisId: r["analysisId"], title: r["title"], llmUsed: r["llmUsed"], hasResult: r["hasResult"], top3, marks, totalStake: r["totalStake"], totalReturn: r["totalReturn"],
    judgedBetCount: r["judgedBetCount"], hitCount: r["hitCount"], ...refund, unjudgedBetCount: r["unjudgedBetCount"], allocationNote: r["allocationNote"], comment: r["comment"],
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
  const rolling = "rolling" in body ? parseRolling(body["rolling"]) : undefined;
  const nearMisses = "nearMisses" in body ? parseNearMisses(body["nearMisses"]) : undefined;
  if (rolling === null || nearMisses === null || stats === null || narrative === undefined || !isArr(body["races"]) || !strOrNull(body["narrativeRaw"]) || !strOrNull(body["note"])) {
    return null;
  }
  const races: ReportRace[] = [];
  for (const r of body["races"]) {
    const parsed = parseRace(r);
    if (parsed === null) return null;
    races.push(parsed);
  }
  return {
    date, createdAt: created_at, model, raceCount: race_count, totalStake: total_stake, totalReturn: total_return, summary, stats, ...(rolling === undefined ? {} : { rolling }), ...(nearMisses === undefined ? {} : { nearMisses }), races, narrative,
    narrativeRaw: body["narrativeRaw"], note: body["note"],
  };
}

function parseJob(value: unknown): ReportJob | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { phase, status, attempts, regenerate } = value;
  // regenerate は無いか true だけ(サーバが書くのは true のみ。それ以外は壊れた応答として、一部だけを採用しない)。
  if ((phase !== "list" && phase !== "gather" && phase !== "generate" && phase !== "save" && phase !== "notify") || (status !== "running" && status !== "failed") || !isCount(attempts) || (regenerate !== undefined && regenerate !== true)) {
    return undefined;
  }
  return regenerate === true ? { phase, status, attempts, regenerate } : { phase, status, attempts };
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

/** `GET /api/reports/{date}`。日報が無い日は `report: null`(進行状況が `job`。取れなかったときは `jobStatus: "unavailable"`。Issue #245)。 */
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
  const jobStatus = body["job_status"];
  const raw = body["report"];
  const report = raw === null ? null : parseDetail(raw);
  if (job === undefined || (jobStatus !== "ok" && jobStatus !== "unavailable") || (jobStatus === "unavailable" && job !== null) || (raw !== null && report === null) || raw === undefined) {
    return { ok: false, error: { kind: "unexpected", httpStatus: response.status } };
  }
  return { ok: true, report, job, jobStatus };
}

export type ReportRunOutcome =
  | { readonly kind: "accepted" }
  /** 202 だが本文が想定外(契約のずれ)。サーバは依頼を受け付けている。 */
  | { readonly kind: "accepted-malformed" }
  | { readonly kind: "already-exists" }
  | { readonly kind: "in-progress" }
  /** 作り直し(Issue #268)の 1 日の回数の上限(429 `daily-limit`)。 */
  | { readonly kind: "daily-limit" }
  | { readonly kind: "failed"; readonly failure: ApiFailure };

/**
 * `POST /api/reports/run`。Origin の扱いは `api-run.ts` の説明と同じ(`referrerPolicy` を付け、`mode` は指定しない)。
 * `regenerate` が true なら本文に `regenerate: true` を足す(Issue #268。日報がある日の作り直し。管理者だけ)。省略・false は従来の `{ date }` だけ。
 */
export async function postReportRun(fetchLike: FetchLike, date: string, regenerate: boolean = false): Promise<ReportRunOutcome> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike("/api/reports/run", {
      method: "POST",
      credentials: "same-origin",
      referrerPolicy: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(regenerate ? { date, regenerate: true } : { date }),
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
  if (response.status === 429 && isRecord(body) && isRecord(body["error"]) && body["error"]["type"] === "daily-limit") return { kind: "daily-limit" };
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
