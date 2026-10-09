/**
 * 検証の API 呼び出しと応答の分類(Issue #219〈web の検証画面(1)〉)。`GET /api/verify?venue=all|central|nar[&refresh=1]`。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**: 読む項目の型・範囲(件数は 0 以上の整数、金額・率は有限の数、率は null もある)を満たすときだけ成功。一部だけを採用しない。余計なキー
 * (サーバの集計の補正傾向・キャリブレーション・診断の細目など、この画面が読まないもの)は無視する。読む項目のキー名のドリフトは `test/client-api-verify-contract.test.ts` が検出する。
 * **サーバの文面は読まない**(失敗は、ステータスと `error.type`〈サーバが決めた固定の識別子〉だけで分類し、固定の文言にする)。
 * 応答の `status`: `ready`(集計。`stale` なら古い)・`preparing`(発走時刻の補完中)・`throttled`(1 日の再計算の上限に達していて、出せる集計が無い)。
 */
import { classify, isNum, isRecord, isStr, strOrNull, type ApiFailure, type FetchLike } from "./api";

export type VerifyVenue = "all" | "central" | "nar";

/** 券種別(または合算)の配分ベースの回収率の 1 行。 */
export interface ProposedSummaryView {
  readonly betCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly recoveryRate: number | null;
  readonly unjudgedCount: number;
}

/** 配分ベースの 8 券種の名前(サーバの `ProposedBetReport` のキー)。 */
export const PROPOSED_BET_TYPES = ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;
export type ProposedBetType = (typeof PROPOSED_BET_TYPES)[number];

/** 画面が読む検証の集計(サーバの `VerifyReport` のうち、累積回収率と配分ベースの回収率に要る項目)。 */
export interface VerifyReportView {
  readonly includedAnalysisCount: number;
  readonly excludedAnalysisCount: number;
  readonly supersededAnalysisCount: number;
  readonly excludedEstimatedCount: number;
  readonly excludedLookaheadSuspectCount: number;
  readonly excludedLookaheadUnknownCount: number;
  readonly bet: {
    readonly betCount: number;
    readonly totalStake: number;
    readonly totalReturn: number;
    readonly recoveryRate: number | null;
    readonly actualPayoutCount: number;
    readonly approximatePayoutCount: number;
  };
  readonly proposedBet: {
    readonly population: { readonly allocated: number; readonly skipped: number; readonly unreached: number; readonly noRecord: number };
    readonly overall: ProposedSummaryView;
    readonly byType: Readonly<Record<ProposedBetType, ProposedSummaryView>>;
    readonly unknownBetType: { readonly count: number; readonly totalStake: number; readonly betTypes: readonly string[] };
  };
}

export type StaleReason = "backfilling" | "min-interval" | "daily-limit";

export type VerifyOutcome =
  | {
      readonly kind: "ready";
      readonly venue: VerifyVenue;
      readonly report: VerifyReportView;
      /** 集計した時刻(ISO)。 */
      readonly computedAt: string;
      readonly stale: boolean;
      readonly staleReason: StaleReason | null;
      readonly nextRecomputeAt: string | null;
      /** 発走時刻を確認できなかった分析(`affecting`: そのうち先読み判定が時刻に依るもの)。 */
      readonly startTimeGaps: { readonly lost: number; readonly affecting: number };
    }
  | { readonly kind: "preparing"; readonly remaining: number; readonly blocked: "r2-fence" | "error" | null; readonly resumeAt: string | null }
  | { readonly kind: "throttled"; readonly nextAt: string };

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isMoney = (v: unknown): v is number => isNum(v) && v >= 0;
const rateOrNull = (v: unknown): v is number | null => v === null || (isNum(v) && v >= 0);

function parseSummary(v: unknown): ProposedSummaryView | null {
  if (!isRecord(v) || !isCount(v["betCount"]) || !isMoney(v["totalStake"]) || !isMoney(v["totalReturn"]) || !rateOrNull(v["recoveryRate"]) || !isCount(v["unjudgedCount"])) return null;
  return { betCount: v["betCount"], totalStake: v["totalStake"], totalReturn: v["totalReturn"], recoveryRate: v["recoveryRate"], unjudgedCount: v["unjudgedCount"] };
}

function parseReport(v: unknown): VerifyReportView | null {
  if (!isRecord(v)) return null;
  const counts = ["includedAnalysisCount", "excludedAnalysisCount", "supersededAnalysisCount", "excludedEstimatedCount", "excludedLookaheadSuspectCount", "excludedLookaheadUnknownCount"] as const;
  if (!counts.every((k) => isCount(v[k]))) return null;
  const bet = v["bet"];
  if (!isRecord(bet) || !isCount(bet["betCount"]) || !isMoney(bet["totalStake"]) || !isMoney(bet["totalReturn"]) || !rateOrNull(bet["recoveryRate"]) || !isCount(bet["actualPayoutCount"]) || !isCount(bet["approximatePayoutCount"])) return null;
  const proposed = v["proposedBet"];
  if (!isRecord(proposed)) return null;
  const population = proposed["population"];
  if (!isRecord(population) || !isCount(population["allocated"]) || !isCount(population["skipped"]) || !isCount(population["unreached"]) || !isCount(population["noRecord"])) return null;
  const overall = parseSummary(proposed["overall"]);
  if (overall === null) return null;
  const byType: Partial<Record<ProposedBetType, ProposedSummaryView>> = {};
  for (const type of PROPOSED_BET_TYPES) {
    const summary = parseSummary(proposed[type]);
    if (summary === null) return null;
    byType[type] = summary;
  }
  const unknown = proposed["unknownBetType"];
  if (!isRecord(unknown) || !isCount(unknown["count"]) || !isMoney(unknown["totalStake"]) || !Array.isArray(unknown["betTypes"]) || !unknown["betTypes"].every(isStr)) return null;
  return {
    includedAnalysisCount: v["includedAnalysisCount"] as number,
    excludedAnalysisCount: v["excludedAnalysisCount"] as number,
    supersededAnalysisCount: v["supersededAnalysisCount"] as number,
    excludedEstimatedCount: v["excludedEstimatedCount"] as number,
    excludedLookaheadSuspectCount: v["excludedLookaheadSuspectCount"] as number,
    excludedLookaheadUnknownCount: v["excludedLookaheadUnknownCount"] as number,
    bet: { betCount: bet["betCount"], totalStake: bet["totalStake"], totalReturn: bet["totalReturn"], recoveryRate: bet["recoveryRate"], actualPayoutCount: bet["actualPayoutCount"], approximatePayoutCount: bet["approximatePayoutCount"] },
    proposedBet: {
      population: { allocated: population["allocated"], skipped: population["skipped"], unreached: population["unreached"], noRecord: population["noRecord"] },
      overall,
      byType: byType as Record<ProposedBetType, ProposedSummaryView>,
      unknownBetType: { count: unknown["count"], totalStake: unknown["totalStake"], betTypes: unknown["betTypes"] as string[] },
    },
  };
}

const VENUES: ReadonlySet<string> = new Set<VerifyVenue>(["all", "central", "nar"]);
const STALE_REASONS: ReadonlySet<string> = new Set<StaleReason>(["backfilling", "min-interval", "daily-limit"]);

/** 応答の本文を検査して結果を作る。満たさなければ null。 */
export function parseVerifyResponse(body: unknown): VerifyOutcome | null {
  if (!isRecord(body) || body["ok"] !== true) return null;
  const status = body["status"];
  if (status === "throttled") {
    return isStr(body["nextAt"]) ? { kind: "throttled", nextAt: body["nextAt"] } : null;
  }
  if (status === "preparing") {
    const blocked = body["blocked"];
    if (!isCount(body["remaining"]) || (blocked !== null && blocked !== "r2-fence" && blocked !== "error") || !strOrNull(body["resumeAt"])) return null;
    return { kind: "preparing", remaining: body["remaining"], blocked, resumeAt: body["resumeAt"] };
  }
  if (status !== "ready") return null;
  const venue = body["venue"];
  const reason = body["staleReason"];
  const diag = body["diag"];
  if (!isStr(venue) || !VENUES.has(venue) || !isStr(body["computedAt"]) || typeof body["stale"] !== "boolean" || !strOrNull(body["nextRecomputeAt"])) return null;
  if (reason !== null && (!isStr(reason) || !STALE_REASONS.has(reason))) return null;
  if (!isRecord(diag) || !isRecord(diag["startTimeGaps"]) || !isCount(diag["startTimeGaps"]["lost"]) || !isCount(diag["startTimeGaps"]["affecting"])) return null;
  const report = parseReport(body["report"]);
  if (report === null) return null;
  return {
    kind: "ready",
    venue: venue as VerifyVenue,
    report,
    computedAt: body["computedAt"],
    stale: body["stale"],
    staleReason: reason as StaleReason | null,
    nextRecomputeAt: body["nextRecomputeAt"],
    startTimeGaps: { lost: diag["startTimeGaps"]["lost"], affecting: diag["startTimeGaps"]["affecting"] },
  };
}

export type VerifyFetchResult = { readonly ok: true; readonly outcome: VerifyOutcome } | { readonly ok: false; readonly error: ApiFailure };

/** `GET /api/verify`。例外(同期・非同期とも)は network にする(例外の文面は持ち込まない)。`refresh` は再計算の要求(サーバの最短間隔・1 日の上限は守られる)。 */
export async function fetchVerify(fetchLike: FetchLike, venue: VerifyVenue, refresh: boolean): Promise<VerifyFetchResult> {
  const query = `venue=${venue}${refresh ? "&refresh=1" : ""}`;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike(`/api/verify?${query}`, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.status !== 200) {
    const failure = classify(response.status, body);
    return { ok: false, error: failure.kind === "netkeiba-unavailable" ? { kind: "server-error" } : failure };
  }
  const outcome = parseVerifyResponse(body);
  return outcome === null ? { ok: false, error: { kind: "unexpected", httpStatus: 200 } } : { ok: true, outcome };
}

/** 取得の失敗の固定の文言(サーバの文面は含めない)。 */
export function verifyFetchFailureMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case "forbidden":
    case "origin-mismatch":
      return "検証を取得できませんでした。アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてください。";
    case "network":
      return "検証の取得の通信に失敗しました。ログインの期限切れかもしれません。ページを再読み込みするか、「更新」でもう一度取得してください。";
    case "server-error":
    case "netkeiba-unavailable":
      return "検証を取得できませんでした。サーバでエラーが起きました。少し待ってから「更新」を押してください。";
    case "bad-request":
    case "not-found":
    case "unexpected":
      return `検証の応答が想定外でした${failure.kind === "unexpected" ? `(HTTP ${failure.httpStatus})` : ""}。少し待ってから「更新」を押してください。`;
  }
}
