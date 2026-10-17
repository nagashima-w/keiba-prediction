/**
 * 今日の狙い目(`GET /api/targets`。Issue #336)の API 呼び出しと応答のパーサ。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**(`api.ts` と同じ): 型違い・欠損は「想定外の応答」(`unexpected`)にし、一部の行だけを黙って落として返さない。
 * 文言(要約・場と R・◎・2 行目)はサーバが組み立てた文字列をそのまま出す(クライアントの束を太らせない)。残り時間だけがクライアントで変わる。
 * サーバ側のキー名・形のドリフトは `test/targets-api.test.ts`(実際の `handle()` の応答を通す)が検出する。
 */
import { classify, getJson, isNum, isRecord, isStr, strOrNull, type ApiFailure, type FetchLike } from "./api";

export interface TargetRace {
  readonly raceId: string;
  readonly analysisId: number;
  /** 発走の瞬間(UTC のエポックミリ秒)。時刻が分からないとき null。 */
  readonly startMs: number | null;
  /** 発走予定時刻(JST の `HH:MM`)。分からないとき null。 */
  readonly startTime: string | null;
  /** 「東京11R」。 */
  readonly place: string;
  /** 「◎7」。◎が無ければ null。 */
  readonly pick: string | null;
  /** 分析時には買い目があったのに、採った再計算の回が 0 点(見送り)。 */
  readonly skipped: boolean;
  /** 2 行目の文言。 */
  readonly detail: string;
}

export interface TargetsData {
  readonly date: string;
  /** サーバの現在時刻(UTC のエポックミリ秒。端末の時計のずれの補正用)。 */
  readonly nowMs: number;
  readonly summary: string;
  /** サーバの並び(発走時刻の昇順・時刻なしは末尾)。 */
  readonly races: readonly TargetRace[];
}

export type TargetsResult = { readonly ok: true; readonly data: TargetsData } | { readonly ok: false; readonly error: ApiFailure };

function parseRace(row: unknown): TargetRace | null {
  if (!isRecord(row)) return null;
  const { race_id, analysis_id, start_ms, start_time, place, pick, skipped, detail } = row;
  if (!isStr(race_id) || !isNum(analysis_id) || !Number.isInteger(analysis_id) || analysis_id < 1) return null;
  if (!(start_ms === null || isNum(start_ms)) || !strOrNull(start_time) || !isStr(place) || !strOrNull(pick) || typeof skipped !== "boolean" || !isStr(detail)) return null;
  return { raceId: race_id, analysisId: analysis_id, startMs: start_ms, startTime: start_time, place, pick, skipped, detail };
}

export function parseTargetsResponse(status: number, body: unknown): TargetsResult {
  if (status !== 200) return { ok: false, error: classify(status, body) };
  if (isRecord(body) && body["ok"] === true && isStr(body["kaisai_date"]) && isNum(body["now_ms"]) && isStr(body["summary"]) && Array.isArray(body["races"])) {
    const races = (body["races"] as unknown[]).map(parseRace);
    if (!races.includes(null)) return { ok: true, data: { date: body["kaisai_date"], nowMs: body["now_ms"], summary: body["summary"], races: races as TargetRace[] } };
  }
  return { ok: false, error: { kind: "unexpected", httpStatus: status } };
}

/** `GET /api/targets?kaisai_date=YYYYMMDD`。D1 の読み取りだけ(R2・netkeiba には出ない)。 */
export async function fetchTargets(fetchLike: FetchLike, date: string): Promise<TargetsResult> {
  const got = await getJson(fetchLike, `/api/targets?kaisai_date=${date}`);
  return got === null ? { ok: false, error: { kind: "network" } } : parseTargetsResponse(got.status, got.body);
}
