/**
 * スマホ画面の API 呼び出しと応答のパーサ(Issue #184。races と status〈race_id なし〉)。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**: 型違い・欠損は「想定外の応答」(`unexpected`)にし、一部の行だけを黙って落として返さない。
 * サーバの文面(`error.message`・例外の文面)は画面に出さず、種類ごとの固定の文言(`failureMessage`)にする。
 * サーバ側のキー名・形のドリフトは `test/client-api-contract.test.ts`(実際の `handle()` の応答を通す)が検出する。
 */
import type { Venue } from "./route";

export interface RaceRow {
  readonly raceId: string;
  readonly venueName: string | null;
  readonly raceNumber: number;
  readonly raceName: string;
  readonly courseType: string;
  readonly distance: number;
  readonly entryCount: number;
  readonly grade: string | null;
}

export type TaskMode = "morning" | "pre_race";
export type TaskStatus = "queued" | "fetched" | "done" | "failed";

/** 板(`GET /api/analyses/status`)の 1 行。1 レースにつき morning と pre_race の最大 2 行。 */
export interface BoardRow {
  readonly raceId: string;
  readonly mode: TaskMode;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly error: string | null;
  readonly queuedAt: number;
  readonly updatedAt: number;
  /** 朝の prior があるか(morning の行だけ true になりうる)。 */
  readonly prior: boolean;
  readonly analysisId: number | null;
}

export type ApiFailure =
  | { readonly kind: "forbidden" }
  | { readonly kind: "bad-request" }
  | { readonly kind: "netkeiba-unavailable"; readonly reason: "blocked" | "busy" | "failed" }
  | { readonly kind: "server-error" }
  | { readonly kind: "unexpected"; readonly httpStatus: number }
  | { readonly kind: "network" };

export type RacesResult = { readonly ok: true; readonly races: RaceRow[] } | { readonly ok: false; readonly error: ApiFailure };
export type BoardResult = { readonly ok: true; readonly rows: BoardRow[] } | { readonly ok: false; readonly error: ApiFailure };

/** 使う部分だけの fetch(`window.fetch` が満たす。Node のテストでは偽物を渡せる)。 */
export type FetchLike = (
  url: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; credentials?: "same-origin"; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** エラー応答(200 以外、または ok が true でない)を分類する。成功の形の検査は呼び出し側。 */
function classify(status: number, body: unknown): ApiFailure {
  if (status === 403) {
    return { kind: "forbidden" };
  }
  if (status === 400) {
    return { kind: "bad-request" };
  }
  if (status === 503) {
    const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
    if (error !== undefined && error["type"] === "netkeiba-unavailable") {
      const reason = error["reason"];
      return { kind: "netkeiba-unavailable", reason: reason === "blocked" || reason === "busy" ? reason : "failed" };
    }
    return { kind: "server-error" };
  }
  return { kind: "unexpected", httpStatus: status };
}

function parseRace(row: unknown): RaceRow | null {
  if (!isRecord(row)) return null;
  const { race_id, venue_name, race_number, race_name, course_type, distance, entry_count, grade } = row;
  if (!isStr(race_id) || !strOrNull(venue_name) || !isNum(race_number) || !isStr(race_name) || !isStr(course_type) || !isNum(distance) || !isNum(entry_count) || !strOrNull(grade)) {
    return null;
  }
  return { raceId: race_id, venueName: venue_name, raceNumber: race_number, raceName: race_name, courseType: course_type, distance, entryCount: entry_count, grade };
}

function parseBoardRow(row: unknown): BoardRow | null {
  if (!isRecord(row)) return null;
  const { race_id, mode, status, attempts, error, queued_at, updated_at, prior, analysis_id } = row;
  if (
    !isStr(race_id) ||
    (mode !== "morning" && mode !== "pre_race") ||
    (status !== "queued" && status !== "fetched" && status !== "done" && status !== "failed") ||
    !isNum(attempts) ||
    !strOrNull(error) ||
    !isNum(queued_at) ||
    !isNum(updated_at) ||
    typeof prior !== "boolean" ||
    !(analysis_id === null || isNum(analysis_id))
  ) {
    return null;
  }
  return { raceId: race_id, mode, status, attempts, error, queuedAt: queued_at, updatedAt: updated_at, prior, analysisId: analysis_id };
}

function parseRows<T>(status: number, body: unknown, parseRow: (row: unknown) => T | null): { ok: true; rows: T[] } | { ok: false; error: ApiFailure } {
  if (status !== 200) {
    return { ok: false, error: classify(status, body) };
  }
  if (!isRecord(body) || body["ok"] !== true || !Array.isArray(body["races"])) {
    return { ok: false, error: { kind: "unexpected", httpStatus: status } };
  }
  const rows: T[] = [];
  for (const raw of body["races"] as unknown[]) {
    const parsed = parseRow(raw);
    if (parsed === null) {
      return { ok: false, error: { kind: "unexpected", httpStatus: status } };
    }
    rows.push(parsed);
  }
  return { ok: true, rows };
}

export function parseRacesResponse(status: number, body: unknown): RacesResult {
  const result = parseRows(status, body, parseRace);
  return result.ok ? { ok: true, races: result.rows } : result;
}

export function parseStatusResponse(status: number, body: unknown): BoardResult {
  return parseRows(status, body, parseBoardRow);
}

/** 失敗の固定の文言(サーバの文面・例外の文面は含めない)。 */
export function failureMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case "forbidden":
      return "アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてください。";
    case "network":
      return "通信に失敗しました。ログインの期限切れかもしれません。ページを再読み込みしてください。";
    case "bad-request":
      return "リクエストが正しくありません(日付または区分を確認してください)。";
    case "netkeiba-unavailable":
      if (failure.reason === "blocked") return "netkeiba への接続が一時的に止められています。しばらく待ってから「更新」してください。";
      if (failure.reason === "busy") return "netkeiba への取得が混み合っています。少し待ってから「更新」してください。";
      return "netkeiba からレース一覧を取得できませんでした。「更新」で再試行できます。";
    case "server-error":
      return "サーバでエラーが起きました。少し待ってから「更新」してください。";
    case "unexpected":
      return `想定外の応答でした(HTTP ${failure.httpStatus})。`;
  }
}

async function getJson(fetchLike: FetchLike, url: string): Promise<{ status: number; body: unknown } | null> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike(url, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return null; // 通信失敗(Access のリダイレクトによる CORS 失敗を含む)。例外の文面は持ち込まない
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/** `GET /api/races?kaisai_date=&venue=`。netkeiba に出うるので、呼び出し側(app.ts)がキャッシュする。 */
export async function fetchRaces(fetchLike: FetchLike, date: string, venue: Venue): Promise<RacesResult> {
  const got = await getJson(fetchLike, `/api/races?kaisai_date=${date}&venue=${venue}`);
  return got === null ? { ok: false, error: { kind: "network" } } : parseRacesResponse(got.status, got.body);
}

/** `GET /api/analyses/status?kaisai_date=`(race_id なし。DO の読み取りだけ)。 */
export async function fetchBoard(fetchLike: FetchLike, date: string): Promise<BoardResult> {
  const got = await getJson(fetchLike, `/api/analyses/status?kaisai_date=${date}`);
  return got === null ? { ok: false, error: { kind: "network" } } : parseStatusResponse(got.status, got.body);
}
