/**
 * 騎手・調教師の指標の一覧(`GET /api/market-edges`。Issue #644)の API 呼び出しと応答のパーサ。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**(`api-targets.ts` と同じ): 型違い・欠損は「想定外の応答」(`unexpected`)にし、一部の行だけを黙って落として返さない。
 * 並び(指標の大きい順)と注記の文はサーバが決めたものをそのまま使う(クライアントで並べ替えない)。
 */
import { classify, getJson, isNum, isRecord, isStr, type ApiFailure, type FetchLike } from "./api";

export type EdgeKind = "jockey" | "trainer";

export interface MarketEdgeRow {
  readonly name: string;
  /** 指標(0.03 = 3.0 ポイント)。 */
  readonly edge: number;
  readonly n: number;
  readonly hitRate: number;
  readonly predMean: number;
}

export interface MarketEdgesData {
  readonly kind: EdgeKind;
  readonly note: string;
  readonly rows: readonly MarketEdgeRow[];
}

export type MarketEdgesResult = { readonly ok: true; readonly data: MarketEdgesData } | { readonly ok: false; readonly error: ApiFailure };

function parseRow(row: unknown): MarketEdgeRow | null {
  if (!isRecord(row)) return null;
  const { name, edge, n, hit_rate, pred_mean } = row;
  if (!isStr(name) || !isNum(edge) || !isNum(n) || !Number.isInteger(n) || n < 0 || !isNum(hit_rate) || !isNum(pred_mean)) return null;
  return { name, edge, n, hitRate: hit_rate, predMean: pred_mean };
}

export function parseMarketEdgesResponse(status: number, body: unknown): MarketEdgesResult {
  if (status !== 200) return { ok: false, error: classify(status, body) };
  if (isRecord(body) && body["ok"] === true && (body["kind"] === "jockey" || body["kind"] === "trainer") && isStr(body["note"]) && Array.isArray(body["rows"])) {
    const rows = (body["rows"] as unknown[]).map(parseRow);
    if (!rows.includes(null)) return { ok: true, data: { kind: body["kind"], note: body["note"], rows: rows as MarketEdgeRow[] } };
  }
  return { ok: false, error: { kind: "unexpected", httpStatus: status } };
}

/** `GET /api/market-edges?kind=…`。D1 の読み取りだけ(R2・netkeiba には出ない)。 */
export async function fetchMarketEdges(fetchLike: FetchLike, kind: EdgeKind): Promise<MarketEdgesResult> {
  const got = await getJson(fetchLike, `/api/market-edges?kind=${kind}`);
  return got === null ? { ok: false, error: { kind: "network" } } : parseMarketEdgesResponse(got.status, got.body);
}
