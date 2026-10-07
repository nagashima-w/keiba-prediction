/**
 * 分析の一覧・詳細の API 呼び出しと応答のパーサ(Issue #185)。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**(`api.ts` と同じ): 型違い・キーの欠落は「想定外の応答」(`unexpected`)にし、一部だけを黙って落として返さない。
 * 配分は exe の表示関数(`buildAllocationProposalView`)の入力型 `StoredAllocationView` に写す。**キーが 1 つでも欠けたら想定外**にする
 * (欠けたまま `undefined` を渡すと、フォールバックの注記が消える・「単位額が記録されていません」と誤って表示される、など利用者に見える誤りになる)。
 * 未知の `route` 文字列は通す(表示関数が「判定不能」の注記にする)。
 * サーバ側のキー名・形のドリフトは `test/client-api-analysis-contract.test.ts`(実際の `handle()` の応答を通す)が検出する。
 */
import type { StoredAllocationBetView, StoredAllocationView } from "../../packages/app/src/shared/analysis-types";
import { classify, getJson, isNum, isRecord, isStr, strOrNull, type ApiFailure, type FetchLike } from "./api";

/** 過去の分析の一覧の 1 件(`GET /api/analyses` の要約から、画面に使う項目だけ)。 */
export interface PastAnalysis {
  readonly id: number;
  readonly analyzedAt: string;
  readonly evEstimated: boolean;
  readonly model: string | null;
}

export interface AnalysisHorse {
  readonly umaban: number;
  readonly name: string | null;
  /** 3着内率(0〜1。統計の prior)。 */
  readonly prior: number;
  readonly adjustedProb: number;
  readonly placeOddsMin: number | null;
  readonly ev: number | null;
  readonly isPositive: boolean;
  readonly mark: string | null;
  readonly reason: string | null;
}

export type DetailState = "present" | "missing" | "none";

export interface AnalysisDetail {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly kaisaiDate: string | null;
  readonly evEstimated: boolean;
  readonly model: string | null;
  readonly race: { readonly venueName: string | null; readonly raceNumber: number | null; readonly raceName: string | null };
  readonly horses: readonly AnalysisHorse[];
  readonly allocation: StoredAllocationView | null;
  readonly detail: DetailState;
}

export type PastAnalysesResult = { readonly ok: true; readonly analyses: PastAnalysis[] } | { readonly ok: false; readonly error: ApiFailure };
export type AnalysisResult = { readonly ok: true; readonly analysis: AnalysisDetail } | { readonly ok: false; readonly error: ApiFailure };

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const boolOrNull = (v: unknown): v is boolean | null => v === null || typeof v === "boolean";
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);

const unexpected = (status: number): { ok: false; error: ApiFailure } => ({ ok: false, error: { kind: "unexpected", httpStatus: status } });

function parsePast(row: unknown): PastAnalysis | null {
  if (!isRecord(row)) return null;
  const { id, analyzedAt, evEstimated, model } = row;
  if (!isNum(id) || !Number.isInteger(id) || id < 1 || !isStr(analyzedAt) || !isBool(evEstimated) || !strOrNull(model)) return null;
  return { id, analyzedAt, evEstimated, model };
}

export function parsePastAnalysesResponse(status: number, body: unknown): PastAnalysesResult {
  if (status !== 200) {
    return { ok: false, error: classify(status, body) };
  }
  if (!isRecord(body) || body["ok"] !== true || !Array.isArray(body["analyses"])) {
    return unexpected(status);
  }
  const analyses: PastAnalysis[] = [];
  for (const raw of body["analyses"] as unknown[]) {
    const parsed = parsePast(raw);
    if (parsed === null) return unexpected(status);
    analyses.push(parsed);
  }
  return { ok: true, analyses };
}

function parseHorse(row: unknown): AnalysisHorse | null {
  if (!isRecord(row)) return null;
  const { umaban, name, prior, adjustedProb, placeOddsMin, ev, isPositive, mark, reason } = row;
  if (!isNum(umaban) || !strOrNull(name) || !isNum(prior) || !isNum(adjustedProb) || !numOrNull(placeOddsMin) || !numOrNull(ev) || !isBool(isPositive) || !strOrNull(mark) || !strOrNull(reason)) {
    return null;
  }
  return { umaban, name, prior, adjustedProb, placeOddsMin, ev, isPositive, mark, reason };
}

function parseBet(row: unknown): StoredAllocationBetView | null {
  if (!isRecord(row)) return null;
  const { betType, comboKey, stake, odds, ev } = row;
  if (!isStr(betType) || !isStr(comboKey) || !isNum(stake) || !numOrNull(odds) || !numOrNull(ev)) return null;
  return { betType, comboKey, stake, odds, ev };
}

/** 配分。キーが 1 つでも欠けたら(型が違っても)null(呼び出し側が想定外の応答にする)。 */
function parseAllocation(value: unknown): StoredAllocationView | null {
  if (!isRecord(value) || !Array.isArray(value["bets"])) return null;
  const v = value;
  if (
    !isStr(v["route"]) ||
    !strOrNull(v["unavailableReason"]) ||
    !strOrNull(v["fallbackReason"]) ||
    !strOrNull(v["skipReasonCode"]) ||
    !isNum(v["bankroll"]) ||
    !isNum(v["perRaceCap"]) ||
    !isNum(v["kellyFraction"]) ||
    !isNum(v["evThreshold"]) ||
    !isBool(v["includeComboOdds"]) ||
    !isBool(v["includeWide"]) ||
    !isBool(v["includeTrio"]) ||
    !boolOrNull(v["includeQuinella"]) ||
    !boolOrNull(v["includeExacta"]) ||
    !boolOrNull(v["includeTrifecta"]) ||
    !boolOrNull(v["includeBracketQuinella"]) ||
    !numOrNull(v["betUnit"]) ||
    !isStr(v["oddsStatus"])
  ) {
    return null;
  }
  const bets: StoredAllocationBetView[] = [];
  for (const raw of v["bets"] as unknown[]) {
    const bet = parseBet(raw);
    if (bet === null) return null;
    bets.push(bet);
  }
  return {
    route: v["route"],
    unavailableReason: v["unavailableReason"],
    fallbackReason: v["fallbackReason"],
    skipReasonCode: v["skipReasonCode"],
    bankroll: v["bankroll"],
    perRaceCap: v["perRaceCap"],
    kellyFraction: v["kellyFraction"],
    evThreshold: v["evThreshold"],
    includeComboOdds: v["includeComboOdds"],
    includeWide: v["includeWide"],
    includeTrio: v["includeTrio"],
    includeQuinella: v["includeQuinella"],
    includeExacta: v["includeExacta"],
    includeTrifecta: v["includeTrifecta"],
    includeBracketQuinella: v["includeBracketQuinella"],
    betUnit: v["betUnit"],
    oddsStatus: v["oddsStatus"],
    bets,
  };
}

function parseDetail(value: unknown): AnalysisDetail | null {
  if (!isRecord(value)) return null;
  const { id, raceId, analyzedAt, kaisaiDate, evEstimated, model, race, horses, allocation, detail } = value;
  if (!isNum(id) || !isStr(raceId) || !isStr(analyzedAt) || !strOrNull(kaisaiDate) || !isBool(evEstimated) || !strOrNull(model)) return null;
  if (detail !== "present" && detail !== "missing" && detail !== "none") return null;
  if (!isRecord(race) || !strOrNull(race["venueName"]) || !numOrNull(race["raceNumber"]) || !strOrNull(race["raceName"])) return null;
  if (!Array.isArray(horses)) return null;
  const parsedHorses: AnalysisHorse[] = [];
  for (const raw of horses as unknown[]) {
    const horse = parseHorse(raw);
    if (horse === null) return null;
    parsedHorses.push(horse);
  }
  let parsedAllocation: StoredAllocationView | null = null;
  if (allocation !== null) {
    parsedAllocation = parseAllocation(allocation);
    if (parsedAllocation === null) return null;
  }
  return {
    id,
    raceId,
    analyzedAt,
    kaisaiDate,
    evEstimated,
    model,
    race: { venueName: race["venueName"], raceNumber: race["raceNumber"], raceName: race["raceName"] },
    horses: parsedHorses,
    allocation: parsedAllocation,
    detail,
  };
}

export function parseAnalysisResponse(status: number, body: unknown): AnalysisResult {
  if (status === 404) {
    return { ok: false, error: { kind: "not-found" } };
  }
  if (status !== 200) {
    return { ok: false, error: classify(status, body) };
  }
  if (!isRecord(body) || body["ok"] !== true) {
    return unexpected(status);
  }
  const analysis = parseDetail(body["analysis"]);
  return analysis === null ? unexpected(status) : { ok: true, analysis };
}

/** `GET /api/analyses?race_id=&kaisai_date=&limit=20`(新しい順)。D1 だけ。レース画面を開いたときに 1 回だけ呼ぶ。 */
export async function fetchPastAnalyses(fetchLike: FetchLike, date: string, raceId: string): Promise<PastAnalysesResult> {
  const got = await getJson(fetchLike, `/api/analyses?race_id=${raceId}&kaisai_date=${date}&limit=20`);
  return got === null ? { ok: false, error: { kind: "network" } } : parsePastAnalysesResponse(got.status, got.body);
}

/**
 * `GET /api/analyses/{id}`。⚠️ サーバは R2 の詳細を読み、操作回数(Class B)を +1 する(無害な読み取りではない)ので、**利用者が結果の画面を開いたときに 1 回だけ**呼び、
 * 呼び出し側(app.ts)がメモリにキャッシュする。ポーリングに含めない。
 */
export async function fetchAnalysis(fetchLike: FetchLike, id: number): Promise<AnalysisResult> {
  const got = await getJson(fetchLike, `/api/analyses/${id}`);
  return got === null ? { ok: false, error: { kind: "network" } } : parseAnalysisResponse(got.status, got.body);
}
