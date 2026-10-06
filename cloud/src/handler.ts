/**
 * Worker のリクエスト処理の本体(Issue #161〈#21-C〉)。ランタイムに依存しないよう、鍵の取得・時刻・ログは注入できる。
 *
 * **すべてのルートの前に認証を掛ける**(`/api/health` も含む)。認証できなければ、設定の有無・失敗の理由・ルートの
 * 存在を一切含まない 403 を返す。理由コードはログにだけ出す(トークン・メール・チーム名・AUD は出さない)。
 */
import type { AccessEnv } from "./access-jwt";
import { D1AnalysisStore, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, type AnalysisBucket, type AnalysisDb } from "./analysis-repository";
import { checkD1 } from "./d1-health";
import { remoteKeys } from "./access-jwt";
import { authenticate, type AccessContextLike } from "./authenticate";
import type { GateResult, GateStatus } from "./gate-core";
import { runShutubaCheck, validateRaceId } from "./netkeiba-check";
import { renderPage } from "./page";
import { checkKaisaiDate, checkRaceDate } from "./race-date";
import type { Board, MorningPrior, ScheduleInput, ScheduleResult } from "./race-day-core";
import type { JWTVerifyGetKey } from "jose";

/** Durable Object(NetkeibaGate)のスタブの、使う部分だけの型(RPC なので、同期のメソッドも Promise になる)。 */
export interface GateStubLike {
  ping(): Promise<{ sqlite: boolean }>;
  fetchRaw(url: string): Promise<GateResult>;
  status(): Promise<GateStatus>;
}

/** Durable Object(NetkeibaGate)の名前空間の、使う部分だけの型。 */
export interface GateNamespaceLike {
  idFromName(name: string): any;
  get(id: any): GateStubLike;
}

/** netkeiba への取得の出口の DO の固定名(全取得をこの1つのインスタンスに通す)。 */
const GATE_NAME = "gate";

/** 日単位の DO(RaceDay)のスタブの、使う部分だけの型(RPC なので、同期のメソッドも Promise になる)。 */
export interface RaceDayStubLike {
  schedule(input: ScheduleInput): Promise<ScheduleResult>;
  getBoard(): Promise<Board>;
  getMorningPrior(raceId: string): Promise<MorningPrior | null>;
}

/** 日単位の DO(RaceDay)の名前空間の、使う部分だけの型。名前は開催日(YYYYMMDD)。 */
export interface RaceDayNamespaceLike {
  idFromName(name: string): any;
  get(id: any): RaceDayStubLike;
}

export interface Env extends AccessEnv {
  NETKEIBA_GATE: GateNamespaceLike;
  /** 日単位の DO(RaceDay。wrangler.toml の binding)。Issue #177・#180。 */
  RACE_DAY: RaceDayNamespaceLike;
  /** D1(分析履歴。wrangler.toml の `[[d1_databases]]` の binding)。Issue #171。 */
  DB: AnalysisDb;
  /** R2(分析の詳細オブジェクト。wrangler.toml の `[[r2_buckets]]` の binding)。Issue #174・#175。get と put だけを使う。 */
  ANALYSIS_DETAIL: AnalysisBucket;
}

export interface HandlerDeps {
  readonly keys?: (teamName: string) => JWTVerifyGetKey;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** 拒否の応答。本文もヘッダも、拒否の原因によらず固定。 */
function forbidden(): Response {
  return new Response("forbidden", {
    status: 403,
    headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

export async function handle(
  request: Request,
  env: Env,
  ctx: { readonly access?: AccessContextLike },
  deps: HandlerDeps = {},
): Promise<Response> {
  const log = deps.log ?? ((line: string) => console.log(line));

  let auth;
  try {
    auth = await authenticate(request, env, ctx, {
      keys: deps.keys ?? remoteKeys,
      now: (deps.now ?? (() => new Date()))(),
    });
  } catch {
    log("access: denied reason=error");
    return forbidden();
  }
  if (!auth.ok) {
    log(`access: denied reason=${auth.reason}`);
    return forbidden();
  }
  log(`access: ok via=${auth.via}`);

  const method = request.method;
  // 手動起動の入口(Issue #180)。**POST を受けるのはここだけ**。認証(上)の後で、Origin の確認・入力の検証を行う。
  if (method === "POST" && new URL(request.url).pathname === "/api/analyses/run") {
    return handleRun(request, env);
  }
  if (method !== "GET" && method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const { pathname } = new URL(request.url);

  if (pathname === "/") {
    return new Response(method === "HEAD" ? null : renderPage(auth.email), {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      },
    });
  }

  if (pathname === "/api/health") {
    // DO と D1 は独立に確認し、どちらかが駄目でももう一方の結果を報告する(原因の切り分けのため)。理由は返さない。
    let sqlite = false;
    try {
      const gate = env.NETKEIBA_GATE.get(env.NETKEIBA_GATE.idFromName(GATE_NAME));
      sqlite = (await gate.ping()).sqlite;
    } catch {
      sqlite = false;
    }
    const d1 = await checkD1(env.DB);
    const ok = sqlite && d1.ok;
    return json({ ok, durableObject: { sqlite }, d1: { ok: d1.ok } }, ok ? 200 : 503);
  }

  if (pathname === "/api/netkeiba/check") {
    // netkeiba へ出る経路は GET だけ(HEAD で取得を起こさない)。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleCheck(new URL(request.url), env);
  }

  if (pathname === "/api/analyses/status") {
    // 読み取り専用(DO の状態を読むだけ)。GET だけ。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleStatus(new URL(request.url), env);
  }

  if (pathname === "/api/analyses/run") {
    // POST だけ(上で処理済み)。GET・HEAD などは 405。
    return new Response("method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (pathname === "/api/analyses") {
    // 読み取り専用の一覧(D1 だけ。R2 には触れない)。GET だけ(HEAD で D1 を引かない)。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleAnalyses(new URL(request.url), env);
  }

  return json({ ok: false, error: "not found" }, 404);
}

const ANALYSES_PARAMS = new Set(["race_id", "kaisai_date", "limit"]);

/**
 * `GET /api/analyses?race_id=&kaisai_date=&limit=`: 分析の要約の一覧(新しい順。Issue #175)。パラメータはすべて任意で、
 * 未知のパラメータ・重複・不正な値は 400(D1 に触れない)。limit は 1〜{@link LIST_MAX_LIMIT} の整数(既定 {@link LIST_DEFAULT_LIMIT})。
 */
async function handleAnalyses(url: URL, env: Env): Promise<Response> {
  const keys = [...url.searchParams.keys()];
  if (keys.some((k) => !ANALYSES_PARAMS.has(k)) || new Set(keys).size !== keys.length) {
    return badRequest("クエリは race_id・kaisai_date・limit だけを、それぞれ1つまで指定できます");
  }
  const filter: { raceId?: string; kaisaiDate?: string; limit?: number } = {};
  const raceId = url.searchParams.get("race_id");
  if (raceId !== null) {
    const checked = validateRaceId(raceId);
    if (!checked.ok) {
      return badRequest(checked.message);
    }
    filter.raceId = checked.raceId;
  }
  const kaisaiDate = url.searchParams.get("kaisai_date");
  if (kaisaiDate !== null) {
    if (!/^[0-9]{8}$/.test(kaisaiDate)) {
      return badRequest("kaisai_date は YYYYMMDD の 8 桁で指定してください");
    }
    filter.kaisaiDate = kaisaiDate;
  }
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const n = /^[0-9]{1,3}$/.test(limit) ? Number(limit) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > LIST_MAX_LIMIT) {
      return badRequest(`limit は 1〜${LIST_MAX_LIMIT} の整数で指定してください(省略すると ${LIST_DEFAULT_LIMIT})`);
    }
    filter.limit = n;
  }
  try {
    const analyses = await new D1AnalysisStore({ db: env.DB, bucket: env.ANALYSIS_DETAIL }).listAnalysisSummaries(filter);
    return json({ ok: true, analyses });
  } catch {
    // 例外の文面・SQL は返さない。
    return json({ ok: false, error: { type: "d1-error" } }, 503);
  }
}

/** 手動起動の本文の上限(バイト)。入力は race_id・kaisai_date・mode だけ。 */
const RUN_BODY_MAX_BYTES = 1024;
const RUN_KEYS = new Set(["race_id", "kaisai_date", "mode"]);
/** エラーとして返す文面の最大長(状態の確認)。 */
const STATUS_ERROR_MAX = 200;

/** 日単位の DO を開催日で引く。 */
function raceDayStub(env: Env, kaisaiDate: string): RaceDayStubLike {
  return env.RACE_DAY.get(env.RACE_DAY.idFromName(kaisaiDate));
}

/** DO の失敗(例外)の応答。例外の文面・スタック・SQL は返さない。 */
function raceDayError(): Response {
  return json({ ok: false, error: { type: "race-day-error" } }, 503);
}

/**
 * Origin の確認(Issue #180 AC-e3)。Access のクッキーで認証される POST なので、他サイトのページから送られた POST(CSRF)を拒否する。
 * `Origin` ヘッダが**あって**、リクエストの URL の origin と**完全一致**すること(無い・`null`・スキーム/ポート/サブドメインが違うものは拒否)。
 * さらに `Sec-Fetch-Site` があれば `same-origin` であること(ブラウザが付けるヘッダ。付かない非ブラウザのクライアントは Origin だけで判定する)。
 */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin !== new URL(request.url).origin) {
    return false;
  }
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

/** 本文を上限つきで読む(上限を超えたら null。超えた分は読まない)。 */
async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    return null;
  }
  if (request.body === null) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * `POST /api/analyses/run`(Issue #180〈#164-e〉): レースの朝の取得と prior を予約する。本文は JSON `{ race_id, kaisai_date, mode? }`(mode は省略時と "morning" のみ。発走前は #178)。
 * 日単位の DO(RaceDay。名前は開催日)の `schedule` に予約を入れて **202** を返す(取得はアラームの中で始まる)。実行中の同じレースなら **409**(already-running)。
 * 順序: Origin(403)→ Content-Type(415)→ 本文の大きさ(413)→ JSON・入力の検証(400。ここまでで DO は呼ばない)→ DO(失敗は 503。文面は返さない)。
 * **netkeiba への取得の起点は、この手動の POST だけ**(Cron・scheduled は無い。定時は #166)。
 */
async function handleRun(request: Request, env: Env): Promise<Response> {
  if (!originAllowed(request)) {
    return json({ ok: false, error: { type: "origin-mismatch" } }, 403);
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    return json({ ok: false, error: { type: "unsupported-media-type", message: "Content-Type は application/json にしてください" } }, 415);
  }
  const text = await readLimitedText(request, RUN_BODY_MAX_BYTES);
  if (text === null) {
    return json({ ok: false, error: { type: "payload-too-large", message: `本文は ${RUN_BODY_MAX_BYTES} バイトまでです` } }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return badRequest("本文が JSON として読めません");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("本文は JSON のオブジェクトにしてください");
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((k) => !RUN_KEYS.has(k))) {
    return badRequest("本文のキーは race_id・kaisai_date・mode だけです");
  }
  const raceId = record["race_id"];
  const kaisaiDate = record["kaisai_date"];
  if (typeof raceId !== "string" || typeof kaisaiDate !== "string") {
    return badRequest("race_id と kaisai_date は文字列で指定してください");
  }
  const mode = record["mode"] ?? "morning";
  if (mode !== "morning") {
    return badRequest('mode は "morning"(朝の取得と prior)だけです(発走前の分析は未対応)');
  }
  // 検証のメッセージに入力を写すので、長い入力は先頭だけにする(切っても、無効なままであることは変わらない)。
  const checkedRace = validateRaceId(raceId.slice(0, 32));
  if (!checkedRace.ok) {
    return badRequest(checkedRace.message);
  }
  const consistent = checkRaceDate(checkedRace.raceId, kaisaiDate.slice(0, 32));
  if (!consistent.ok) {
    return badRequest(consistent.message);
  }
  try {
    const result = await raceDayStub(env, kaisaiDate).schedule({ raceId: checkedRace.raceId, kaisaiDate });
    if (!result.accepted) {
      return json({ ok: false, error: { type: "already-running", status: result.status } }, 409);
    }
    return json({ ok: true, accepted: true, race_id: result.raceId, kaisai_date: kaisaiDate, mode: "morning", status: result.status }, 202);
  } catch {
    return raceDayError();
  }
}

/**
 * `GET /api/analyses/status?kaisai_date=YYYYMMDD[&race_id=...]`(Issue #180): 日単位の DO の状態。各レースの状態・試行回数・エラー(200 文字まで)・朝の prior の有無。
 * `race_id` を指定すると、そのレースの朝の prior の最小限(レース名・場名・日付・馬番・馬名・prior を高い順に)を `prior` で返す(無ければ null)。
 * パラメータは kaisai_date(必須)と race_id(任意)を、それぞれ1つまで。不正なら 400(DO を呼ばない)。
 */
async function handleStatus(url: URL, env: Env): Promise<Response> {
  const keys = [...url.searchParams.keys()];
  if (keys.some((k) => k !== "kaisai_date" && k !== "race_id") || new Set(keys).size !== keys.length) {
    return badRequest("クエリは kaisai_date(必須)と race_id(任意)だけを、それぞれ1つまで指定できます");
  }
  const kaisaiDate = url.searchParams.get("kaisai_date");
  if (kaisaiDate === null) {
    return badRequest("kaisai_date を YYYYMMDD の 8 桁で指定してください");
  }
  // 検証のメッセージに入力を写すので、長い入力は先頭だけにする(切っても、無効なままであることは変わらない)。
  const dateCheck = checkKaisaiDate(kaisaiDate.slice(0, 32));
  if (!dateCheck.ok) {
    return badRequest(dateCheck.message);
  }
  const raceIdInput = url.searchParams.get("race_id");
  let raceId: string | null = null;
  if (raceIdInput !== null) {
    const checkedRace = validateRaceId(raceIdInput);
    if (!checkedRace.ok) {
      return badRequest(checkedRace.message);
    }
    const consistent = checkRaceDate(checkedRace.raceId, kaisaiDate);
    if (!consistent.ok) {
      return badRequest(consistent.message);
    }
    raceId = checkedRace.raceId;
  }
  try {
    const stub = raceDayStub(env, kaisaiDate);
    const board = await stub.getBoard();
    const races = board.races.map((r) => ({
      race_id: r.raceId,
      status: r.status,
      attempts: r.attempts,
      error: r.error === null ? null : r.error.slice(0, STATUS_ERROR_MAX),
      queued_at: r.queuedAt,
      updated_at: r.updatedAt,
      prior: r.computedAt !== null,
    }));
    if (raceId === null) {
      return json({ ok: true, kaisai_date: kaisaiDate, races });
    }
    const stored = await stub.getMorningPrior(raceId);
    const prior =
      stored === null
        ? null
        : {
            race_name: stored.result.raceName,
            venue_name: stored.result.venueName,
            date: stored.result.date,
            computed_at: stored.computedAt,
            rows: [...stored.result.rows]
              .sort((a, b) => b.prior - a.prior || a.umaban - b.umaban)
              .map((r, i) => ({ rank: i + 1, umaban: r.umaban, horse_name: r.horseName, prior: r.prior })),
          };
    return json({ ok: true, kaisai_date: kaisaiDate, races, prior });
  } catch {
    return raceDayError();
  }
}

function badRequest(message: string): Response {
  return json({ ok: false, error: { type: "bad-request", message } }, 400);
}

/**
 * `GET /api/netkeiba/check?race_id=...`: 出馬表を1本、ゲート経由のソケットで取得して頭数を返す(Issue #162 段階2b)。
 * パラメータは `race_id` ちょうど1つだけ(余計なパラメータ・重複は 400)。race_id が無効なら、ゲートを呼ばない。
 */
async function handleCheck(url: URL, env: Env): Promise<Response> {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "race_id") {
    return badRequest("クエリは race_id だけを1つ指定してください");
  }
  const checked = validateRaceId(url.searchParams.get("race_id"));
  if (!checked.ok) {
    return badRequest(checked.message);
  }

  const gate = env.NETKEIBA_GATE.get(env.NETKEIBA_GATE.idFromName(GATE_NAME));
  const result = await runShutubaCheck(checked.raceId, (target) => gate.fetchRaw(target));
  let gateStatus: GateStatus | undefined;
  try {
    gateStatus = await gate.status();
  } catch {
    // ゲートの状態を読めなくても、確認の結果は返す(例外の中身は返さない)。
  }
  return json(gateStatus === undefined ? result.body : { ...result.body, gate: gateStatus }, result.httpStatus);
}
