/**
 * 検証の API 呼び出しと応答の分類(Issue #219〈web の検証画面(1)〉)。`GET /api/verify?venue=all|central|nar[&refresh=1]`。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**: 読む項目の型・範囲(件数は 0 以上の整数、金額・率は有限の数、率は null もある)を満たすときだけ成功。一部だけを採用しない。余計なキー
 * (診断の細目・帯ごとの代表予測値など、この画面が読まないもの)は無視する。Issue #220 で、補正方向×結果・キャリブレーション・印別的中率を読む項目に加えた(群の数・重複・順序は core の契約どおりに検査する)。読む項目のキー名のドリフトは `test/client-api-verify-contract.test.ts` が検出する。
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

/** キャリブレーションの 1 帯(サーバの `CalibrationBin`)。 */
export interface CalibrationBinView {
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly predictedCount: number;
  readonly placedCount: number;
  readonly actualPlaceRate: number | null;
}

/** 補正方向の 3 値。 */
export const ADJUSTMENT_DIRECTIONS = ["raised", "lowered", "unchanged"] as const;
export type AdjustmentDirectionView = (typeof ADJUSTMENT_DIRECTIONS)[number];

/** 補正方向×結果の 1 群(サーバの `DirectionGroupStat`)。 */
export interface DirectionGroupView {
  readonly direction: AdjustmentDirectionView;
  readonly count: number;
  readonly actualPlaceRate: number | null;
  readonly averageAdjustment: number | null;
}

/** 予想印(core の `PREDICTION_MARKS` と同じ。一致は契約テストが固定する)。 */
export const MARKS = ["◎", "〇", "▲", "△", "☆", "注"] as const;
export type MarkView = (typeof MARKS)[number];

/** 印別的中率の 1 群(サーバの `MarkStat`)。`mark` が null は印なし。 */
export interface MarkStatView {
  readonly mark: MarkView | null;
  readonly count: number;
  readonly placeRate: number | null;
  readonly winRate: number | null;
}

/** 画面が読む検証の集計(サーバの `VerifyReport` のうち、画面に出す項目)。 */
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
  /** 推定確率帯ごとのキャリブレーション(core の帯と同じ順)。 */
  readonly calibration: readonly CalibrationBinView[];
  readonly trend: {
    /** 上げ・下げ・据え置きの 3 群(この順)。 */
    readonly directionGroups: readonly DirectionGroupView[];
    /** 帯ごとの過信バイアス(`calibration` と同じ添字。exe は添字で対応づけ、無ければ null)。 */
    readonly calibrationBias: readonly { readonly overconfidenceGap: number | null }[];
    /** 印別 6 群+印なし(null)の 7 群。 */
    readonly markStats: readonly MarkStatView[];
  };
  readonly proposedBet: {
    readonly population: { readonly allocated: number; readonly skipped: number; readonly unreached: number; readonly noRecord: number };
    readonly overall: ProposedSummaryView;
    readonly byType: Readonly<Record<ProposedBetType, ProposedSummaryView>>;
    readonly unknownBetType: { readonly count: number; readonly totalStake: number; readonly betTypes: readonly string[] };
  };
}

/** プロンプト版別の比較の 1 版(サーバの `PromptVersionSummary`。画面が使う項目だけ)。 */
export interface PromptVersionView {
  /** 版。版不明は null。 */
  readonly promptVersion: string | null;
  /** その版で使われた追加指示(全文。なしは null)。 */
  readonly additionalInstructions: readonly (string | null)[];
  readonly includedAnalysisCount: number;
  readonly bet: { readonly betCount: number; readonly totalStake: number; readonly totalReturn: number; readonly recoveryRate: number | null };
  readonly calibration: readonly CalibrationBinView[];
  /** 帯ごとの過信バイアス(`calibration` と同じ長さ・同じ添字)。 */
  readonly overconfidenceGaps: readonly (number | null)[];
}

export type StaleReason = "backfilling" | "min-interval" | "daily-limit";

export type VerifyOutcome =
  | {
      readonly kind: "ready";
      readonly venue: VerifyVenue;
      readonly report: VerifyReportView;
      /** プロンプト版別の比較(区分に依らず全体。Issue #220)。 */
      readonly promptVersions: readonly PromptVersionView[];
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

const rate01OrNull = (v: unknown): v is number | null => v === null || (isNum(v) && v >= 0 && v <= 1);
const signedOrNull = (v: unknown): v is number | null => v === null || isNum(v);

function parseBin(v: unknown): CalibrationBinView | null {
  if (!isRecord(v) || !isNum(v["lowerBound"]) || !isNum(v["upperBound"]) || !isCount(v["predictedCount"]) || !isCount(v["placedCount"]) || !rate01OrNull(v["actualPlaceRate"])) return null;
  if (v["lowerBound"] < 0 || v["upperBound"] > 1 || v["upperBound"] <= v["lowerBound"] || v["placedCount"] > v["predictedCount"]) return null;
  return { lowerBound: v["lowerBound"], upperBound: v["upperBound"], predictedCount: v["predictedCount"], placedCount: v["placedCount"], actualPlaceRate: v["actualPlaceRate"] };
}

function parseDirectionGroup(v: unknown): DirectionGroupView | null {
  if (!isRecord(v) || !isStr(v["direction"]) || !(ADJUSTMENT_DIRECTIONS as readonly string[]).includes(v["direction"]) || !isCount(v["count"]) || !rate01OrNull(v["actualPlaceRate"]) || !signedOrNull(v["averageAdjustment"])) return null;
  return { direction: v["direction"] as AdjustmentDirectionView, count: v["count"], actualPlaceRate: v["actualPlaceRate"], averageAdjustment: v["averageAdjustment"] };
}

function parseMarkStat(v: unknown): MarkStatView | null {
  if (!isRecord(v) || !isCount(v["count"]) || !rate01OrNull(v["placeRate"]) || !rate01OrNull(v["winRate"])) return null;
  const mark = v["mark"];
  if (mark !== null && !(isStr(mark) && (MARKS as readonly string[]).includes(mark))) return null;
  return { mark: mark as MarkView | null, count: v["count"], placeRate: v["placeRate"], winRate: v["winRate"] };
}

/** 配列の各要素を `parse` に通す。1 つでも通らなければ null。 */
function parseList<T>(v: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const item of v) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** 補正傾向(群の数・重複・順序を core の契約どおりに検査する)。 */
function parseTrend(v: unknown): VerifyReportView["trend"] | null {
  if (!isRecord(v)) return null;
  const directionGroups = parseList(v["directionGroups"], parseDirectionGroup);
  const calibrationBias = parseList(v["calibrationBias"], (item) => (isRecord(item) && signedOrNull(item["overconfidenceGap"]) ? { overconfidenceGap: item["overconfidenceGap"] } : null));
  const markStats = parseList(v["markStats"], parseMarkStat);
  if (directionGroups === null || calibrationBias === null || markStats === null) return null;
  // 3 群が 1 つずつ(core は raised・lowered・unchanged の順で必ず 3 件)
  if (directionGroups.map((g) => g.direction).join() !== ADJUSTMENT_DIRECTIONS.join()) return null;
  // 7 群 = 6 つの印+印なし(各 1 つ)
  const marks = markStats.map((m) => m.mark);
  if (markStats.length !== MARKS.length + 1 || new Set(marks).size !== marks.length || !marks.includes(null)) return null;
  return { directionGroups, calibrationBias, markStats };
}

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
  const calibration = parseList(v["calibration"], parseBin);
  const trend = parseTrend(v["trend"]);
  if (calibration === null || trend === null) return null;
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
    calibration,
    trend,
    proposedBet: {
      population: { allocated: population["allocated"], skipped: population["skipped"], unreached: population["unreached"], noRecord: population["noRecord"] },
      overall,
      byType: byType as Record<ProposedBetType, ProposedSummaryView>,
      unknownBetType: { count: unknown["count"], totalStake: unknown["totalStake"], betTypes: unknown["betTypes"] as string[] },
    },
  };
}

function parsePromptVersion(v: unknown): PromptVersionView | null {
  if (!isRecord(v) || !strOrNull(v["promptVersion"]) || !isCount(v["includedAnalysisCount"])) return null;
  const instructions = v["additionalInstructions"];
  if (!Array.isArray(instructions) || !instructions.every(strOrNull)) return null;
  const bet = v["bet"];
  if (!isRecord(bet) || !isCount(bet["betCount"]) || !isMoney(bet["totalStake"]) || !isMoney(bet["totalReturn"]) || !rateOrNull(bet["recoveryRate"])) return null;
  const calibration = parseList(v["calibration"], parseBin);
  const gaps = parseList(v["overconfidenceGaps"], (g) => (signedOrNull(g) ? { gap: g } : null));
  if (calibration === null || gaps === null || gaps.length !== calibration.length) return null;
  return {
    promptVersion: v["promptVersion"],
    additionalInstructions: instructions as (string | null)[],
    includedAnalysisCount: v["includedAnalysisCount"],
    bet: { betCount: bet["betCount"], totalStake: bet["totalStake"], totalReturn: bet["totalReturn"], recoveryRate: bet["recoveryRate"] },
    calibration,
    overconfidenceGaps: gaps.map((g) => g.gap),
  };
}

/** 版別比較(版は重複しない。並びはサーバのまま)。 */
function parsePromptVersions(v: unknown): PromptVersionView[] | null {
  const list = parseList(v, parsePromptVersion);
  if (list === null || new Set(list.map((x) => x.promptVersion)).size !== list.length) return null;
  return list;
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
  const promptVersions = parsePromptVersions(body["promptVersions"]);
  if (report === null || promptVersions === null) return null;
  return {
    kind: "ready",
    venue: venue as VerifyVenue,
    report,
    promptVersions,
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
