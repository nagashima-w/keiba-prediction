/**
 * スマホ画面の API 呼び出しと応答のパーサ(Issue #184。races と status〈race_id なし〉。Issue #185 で status〈race_id つき〉を追加。分析の一覧・詳細は `api-analysis.ts`)。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **応答を信用しない**: 型違い・欠損は「想定外の応答」(`unexpected`)にし、一部の行だけを黙って落として返さない。
 * サーバの文面(`error.message`・例外の文面)は画面に出さず、種類ごとの固定の文言(`failureMessage`)にする。
 * サーバ側のキー名・形のドリフトは `test/client-api-contract.test.ts`(実際の `handle()` の応答を通す)が検出する。
 */
import { isFiniteNumber, isRecord as isRecordCore } from "../../packages/core/src/common/guards";
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
  /** 発走予定時刻(JST の `HH:MM`。Issue #236)。サーバが取れなかった行・古いサーバの応答(キー無し)は null。 */
  readonly startTime: string | null;
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
  /** 403 で、本文の `error.type` が `origin-mismatch`(サーバの Origin の完全一致の検査に落ちた。Access の拒否〈本文が平文〉とは区別する。Issue #186)。 */
  | { readonly kind: "origin-mismatch" }
  /** 400 など。`staleScreen: true` は設定の保存だけ(サーバの `reason: "keys-mismatch"`。項目の過不足=画面が古い可能性。Issue #375)。 */
  | { readonly kind: "bad-request"; readonly staleScreen?: true }
  | { readonly kind: "netkeiba-unavailable"; readonly reason: "blocked" | "busy" | "failed" }
  | { readonly kind: "server-error" }
  /** 404(分析 id が無い。`api-analysis.ts` だけが返す)。 */
  | { readonly kind: "not-found" }
  | { readonly kind: "unexpected"; readonly httpStatus: number }
  | { readonly kind: "network" };

/** 朝の prior の 1 行(`status?race_id=` の `prior.rows`。サーバが prior の高い順に並べ、`rank` を付ける)。 */
export interface PriorRow {
  readonly rank: number;
  readonly umaban: number;
  readonly horseName: string | null;
  /** 3着内率(0〜1)。 */
  readonly prior: number;
}

/** 朝の prior(事前分析の結果)。DO に保存された JSON なので、レース名・場名・日付は null もありうる。 */
export interface MorningPriorView {
  readonly raceName: string | null;
  readonly venueName: string | null;
  readonly date: string | null;
  readonly computedAt: number;
  readonly rows: readonly PriorRow[];
}

export type RacesResult = { readonly ok: true; readonly races: RaceRow[] } | { readonly ok: false; readonly error: ApiFailure };
export type RaceStatusResult =
  | { readonly ok: true; readonly rows: BoardRow[]; readonly prior: MorningPriorView | null }
  | { readonly ok: false; readonly error: ApiFailure };
export type BoardResult = { readonly ok: true; readonly rows: BoardRow[] } | { readonly ok: false; readonly error: ApiFailure };

/** 使う部分だけの fetch(`window.fetch` が満たす。Node のテストでは偽物を渡せる)。 */
export type FetchLike = (
  url: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; credentials?: "same-origin"; referrerPolicy?: "same-origin"; body?: string | Blob },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export const isRecord = isRecordCore;
export const isStr = (v: unknown): v is string => typeof v === "string";
export const isNum = isFiniteNumber;
export const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
/** 有限の数か null(日報・月報・分析・検証の応答の検査が共有する。以前は 3 ファイルに同じ式があった)。 */
export const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);
/** 配列(中身は見ない)。日報・月報の応答の検査が共有する(以前は `api-report.ts` と `api-monthly.ts` に同じ式があった)。 */
export const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
/** 全要素が文字列の配列(空配列も通る)。月報の文章と分析の応答の検査が共有する(以前は `api-monthly.ts` の `isStrArr` と `api-analysis.ts` の `isStrArray` が同じ式だった)。 */
export const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** エラー応答(200 以外、または ok が true でない)を分類する。成功の形の検査は呼び出し側。 */
export function classify(status: number, body: unknown): ApiFailure {
  if (status === 403) {
    // `error.type` はサーバが決めた固定の識別子(`message` ではない)。原因の切り分け(Origin の不一致か、ログインの期限切れか)にだけ使う。
    const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
    return error !== undefined && error["type"] === "origin-mismatch" ? { kind: "origin-mismatch" } : { kind: "forbidden" };
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
  // 発走時刻(Issue #236): キー無しは null(古いサーバの応答)。文字列・null 以外の型は、ほかの項目と同じく行ごと不正にする。
  const start_time = row["start_time"] === undefined ? null : row["start_time"];
  if (!isStr(race_id) || !strOrNull(venue_name) || !isNum(race_number) || !isStr(race_name) || !isStr(course_type) || !isNum(distance) || !isNum(entry_count) || !strOrNull(grade) || !strOrNull(start_time)) {
    return null;
  }
  return { raceId: race_id, venueName: venue_name, raceNumber: race_number, raceName: race_name, courseType: course_type, distance, entryCount: entry_count, grade, startTime: start_time };
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

function parsePriorRow(row: unknown): PriorRow | null {
  if (!isRecord(row)) return null;
  const { rank, umaban, horse_name, prior } = row;
  if (!isNum(rank) || !isNum(umaban) || !strOrNull(horse_name) || !isNum(prior)) return null;
  return { rank, umaban, horseName: horse_name, prior };
}

function parsePrior(value: unknown): MorningPriorView | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { race_name, venue_name, date, computed_at, rows } = value;
  if (!strOrNull(race_name) || !strOrNull(venue_name) || !strOrNull(date) || !isNum(computed_at) || !Array.isArray(rows)) return undefined;
  const parsed: PriorRow[] = [];
  for (const raw of rows as unknown[]) {
    const row = parsePriorRow(raw);
    if (row === null) return undefined;
    parsed.push(row);
  }
  return { raceName: race_name, venueName: venue_name, date, computedAt: computed_at, rows: parsed };
}

export function parseRacesResponse(status: number, body: unknown): RacesResult {
  const result = parseRows(status, body, parseRace);
  return result.ok ? { ok: true, races: result.rows } : result;
}

export function parseStatusResponse(status: number, body: unknown): BoardResult {
  return parseRows(status, body, parseBoardRow);
}

/**
 * `status?kaisai_date=&race_id=` の応答: 板の行(その日の全レース)と、そのレースの朝の prior。
 * `prior` のキーが無い(race_id 付きの応答は必ず持つ)・形が違う場合は、板だけを返さず想定外の応答にする。
 */
export function parseRaceStatusResponse(status: number, body: unknown): RaceStatusResult {
  const board = parseRows(status, body, parseBoardRow);
  if (!board.ok) return board;
  const prior = isRecord(body) && "prior" in body ? parsePrior(body["prior"]) : undefined;
  if (prior === undefined) {
    return { ok: false, error: { kind: "unexpected", httpStatus: status } };
  }
  return { ok: true, rows: board.rows, prior };
}

/** 失敗の固定の文言(サーバの文面・例外の文面は含めない)。 */
export function failureMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case "forbidden":
      return "アクセスできません。ログインの期限切れかもしれません。ページを再読み込みしてください。";
    case "origin-mismatch":
      return "リクエストの送信元の確認に失敗しました(Origin の不一致)。ページを再読み込みしてください。直らないときは、別のブラウザで開いてください。";
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
    case "not-found":
      return "指定された分析が見つかりません。";
    case "unexpected":
      return `想定外の応答でした(HTTP ${failure.httpStatus})。`;
  }
}

/**
 * 失敗(200 以外)の分類のうち、`classify` に「netkeiba の 503 も server-error にする」を足したもの。
 * 書き込み(起動・設定・日報の作成)と検証の取得が使う: これらの 503 は netkeiba の取得に失敗したのではなく、サーバ側のエラーとして扱う。
 * `classify` そのまま(netkeiba の 503 を保つ)なのは、レース一覧と日報・月報の一覧/詳細の取得。
 */
export function classifyWithoutNetkeiba(status: number, body: unknown): ApiFailure {
  const failure = classify(status, body);
  return failure.kind === "netkeiba-unavailable" ? { kind: "server-error" } : failure;
}

/**
 * 書き込み(`POST`)の失敗(202・409 など、各関数が先に扱う応答を除く)の分類。400・413・415 は bad-request、503 は(netkeiba の形でも)server-error。
 * 分析の起動・一括の起動・設定の保存〈400 の `keys-mismatch` だけ先に扱う〉・日報と月報の作成が共有する。**検証の取得(GET)は 413・415 を bad-request にしない**ので `classifyWithoutNetkeiba` を使う。
 */
export function classifyWrite(status: number, body: unknown): ApiFailure {
  if (status === 400 || status === 413 || status === 415) return { kind: "bad-request" };
  return classifyWithoutNetkeiba(status, body);
}

/** 応答の本文を JSON として読む。読めなければ(JSON でない・例外)undefined(例外の文面は持ち込まない)。 */
export async function readBody(response: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function getJson(fetchLike: FetchLike, url: string): Promise<{ status: number; body: unknown } | null> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike(url, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
  } catch {
    return null; // 通信失敗(Access のリダイレクトによる CORS 失敗を含む)。例外の文面は持ち込まない
  }
  const body = await readBody(response);
  return { status: response.status, body };
}

/**
 * GET して、200 かつ本文が `{ ok: true, … }` のものだけを通す(日報・月報の一覧と詳細が共有する前半)。
 * 通信の失敗は network、`notFound` が true のときの 404 は not-found、それ以外の失敗は `classify`(netkeiba の 503 を保つ)。成功したときの status は 200。
 */
export async function getOkBody(fetchLike: FetchLike, url: string, notFound: boolean): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: ApiFailure }> {
  const got = await getJson(fetchLike, url);
  if (got === null) return { ok: false, error: { kind: "network" } };
  const { status, body } = got;
  if (notFound && status === 404) return { ok: false, error: { kind: "not-found" } };
  if (status !== 200 || !isRecord(body) || body["ok"] !== true) return { ok: false, error: classify(status, body) };
  return { ok: true, body };
}

/**
 * `POST`(JSON)の fetch の init。`payload` はここで `JSON.stringify` する(投げうるので、呼ぶ側は try の内側で呼ぶ)。呼び出しごとに headers は新しいオブジェクト。
 * Origin(サーバは完全一致で CSRF を拒否する)は `api-run.ts` の冒頭コメントのとおり: `referrerPolicy: "same-origin"` を付け、fetch の `mode` は指定しない。
 */
export function postInit(payload: unknown): Parameters<FetchLike>[1] {
  return {
    method: "POST",
    credentials: "same-origin",
    // 参照元ポリシー(no-referrer)があっても Origin が付くようにする保険。fetch の mode は指定しない(`api-run.ts` の説明)。
    referrerPolicy: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  };
}

/**
 * `POST`(JSON)。**stringify も try の内側**: 投げれば fetch を呼ばずに null。
 * 戻り値は `getJson` と同じ(通信失敗は null、本文が読めなければ `body: undefined`)。
 */
export async function postJson(fetchLike: FetchLike, url: string, payload: unknown): Promise<{ status: number; body: unknown } | null> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchLike(url, postInit(payload));
  } catch {
    return null;
  }
  const body = await readBody(response);
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

/**
 * `GET /api/analyses/status?kaisai_date=&race_id=`(Issue #185)。板(その日の全レースの行)と、そのレースの朝の prior を 1 回で返す。DO の読み取りだけ。
 * レース画面を開いたときに 1 回だけ呼ぶ(自動の再取得はしない)。
 */
export async function fetchRaceStatus(fetchLike: FetchLike, date: string, raceId: string): Promise<RaceStatusResult> {
  const got = await getJson(fetchLike, `/api/analyses/status?kaisai_date=${date}&race_id=${raceId}`);
  return got === null ? { ok: false, error: { kind: "network" } } : parseRaceStatusResponse(got.status, got.body);
}
