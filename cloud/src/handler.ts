/**
 * Worker のリクエスト処理の本体(Issue #161〈#21-C〉)。ランタイムに依存しないよう、鍵の取得・時刻・ログは注入できる。
 *
 * **すべてのルートの前に認証を掛ける**(`/api/health` も含む)。認証できなければ、設定の有無・失敗の理由・ルートの
 * 存在を一切含まない 403 を返す。理由コードはログにだけ出す(トークン・メール・チーム名・AUD は出さない)。
 */
import type { AccessEnv } from "./access-jwt";
import { D1AnalysisStore, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, type AnalysisBucket, type AnalysisDb } from "./analysis-repository";
import { checkD1 } from "./d1-health";
import { webhookStatus } from "./notify-send";
import { remoteKeys } from "./access-jwt";
import { authenticate, type AccessContextLike } from "./authenticate";
import type { GateResult, GateStatus } from "./gate-core";
import { runShutubaCheck, validateRaceId } from "./netkeiba-check";
import { buildAnalysisView } from "./analysis-view";
import { CLIENT_JS } from "./client-bundle.generated";
import { APP_CSP, CHECK_CSP, renderCheckPage, renderPage } from "./page";
import { checkKaisaiDate, checkRaceDate } from "./race-date";
import { loadSettings, saveSettings, validateCloudSettingsForSave } from "./settings";
import type { Board, MorningPrior, RaceListResult, RaceListVenue, ScheduleInput, ScheduleResult } from "./race-day-core";
import { toRaceListRows } from "./race-list";
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
  /** 開催日のレース一覧(Issue #183)。 */
  getRaceList(kaisaiDate: string, venue: RaceListVenue): Promise<RaceListResult>;
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
  /** 発走前の分析の LLM の API キー(Worker の secret。ユーザーが登録する。Issue #194)。ここでは「登録されているか」だけを `/api/health` に返す(値は読まない・返さない)。 */
  ANTHROPIC_API_KEY?: string;
  /** 通知(Discord。Issue #205)の Webhook URL(Worker の secret。ユーザーが登録する)。ここでは「通知に使える形で登録されているか」だけを `/api/health` に返す(値は返さない)。 */
  DISCORD_WEBHOOK_URL?: string;
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
  // 設定の入口(Issue #189)。GET(読む)と POST(全項目の置き換え)だけ。他のメソッドは 405(Allow: GET, POST)。D1 を引かない。
  if (new URL(request.url).pathname === "/api/settings") {
    if (method === "GET") {
      return handleSettingsGet(env);
    }
    if (method === "POST") {
      return handleSettingsSave(request, env, deps.now ?? (() => new Date()));
    }
    return new Response("method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, allow: "GET, POST", "content-type": "text/plain; charset=utf-8" },
    });
  }
  // 手動起動の入口(Issue #180)。**POST を受けるのはここと `/api/settings` だけ**。認証(上)の後で、Origin の確認・入力の検証を行う。
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
    // スマホ画面(Issue #184)。スクリプトは /app.js の 1 本だけ(インラインなし)。
    return new Response(method === "HEAD" ? null : renderPage(auth.email), {
      status: 200,
      headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": APP_CSP },
    });
  }

  if (pathname === "/check") {
    // 旧 `/` の確認フォーム(#162 の本番実機確認用。Issue #184 で移した)。
    return new Response(method === "HEAD" ? null : renderCheckPage(auth.email), {
      status: 200,
      headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": CHECK_CSP },
    });
  }

  if (pathname === "/app.js") {
    // クライアントのバンドル(cloud/client/ を esbuild で 1 ファイルにした生成物。Issue #184)。認証の関門(上)の後ろで、Worker の中から配る
    // (静的アセット機能は使わない。run_worker_first の付け忘れで認証を素通りする経路を作らない)。
    return new Response(method === "HEAD" ? null : CLIENT_JS, {
      status: 200,
      headers: { ...SECURITY_HEADERS, "content-type": "text/javascript; charset=utf-8" },
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
    // Issue #194: API キー(Worker の secret ANTHROPIC_API_KEY)が**登録されているか**だけを返す(値・長さ・一部は返さない)。ok には含めない(キーが無くても、分析は LLM なしで動く)。
    const anthropic = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "";
    // Issue #205: Webhook(Worker の secret DISCORD_WEBHOOK_URL)が**通知に使える形で登録されているか**だけを返す(値・長さ・一部は返さない)。形式が Discord の Webhook でないものは false
    // (通知が送られないものを true にしない。false は「未登録」か「形式が不正」)。ok には含めない(通知が無くても、分析は動く)。
    const discord = webhookStatus(env.DISCORD_WEBHOOK_URL) === "valid";
    return json({ ok, durableObject: { sqlite }, d1: { ok: d1.ok }, secrets: { anthropic, discord } }, ok ? 200 : 503);
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

  if (pathname === "/api/races") {
    // netkeiba へ出る経路は GET だけ(HEAD で取得を起こさない)。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleRaces(request, env);
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

  // `/api/analyses/{id}`(Issue #183)。`status`・`run` は上で完全一致で処理済み(ここに来るのは、それ以外の1階層下だけ)。末尾スラッシュ・さらに下位は 404。
  const detailMatch = /^\/api\/analyses\/([^/]+)$/.exec(pathname);
  if (detailMatch !== null) {
    // 読み取り専用(D1 + R2 の GET)。GET だけ(HEAD で D1・R2 を引かない)。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleAnalysisDetail(new URL(request.url), detailMatch[1]!, env);
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

/** 分析 id の上限(D1 の INTEGER は 64 ビットだが、数値の bind で正確に扱える範囲に収める。実際の id は連番で、この値には届かない)。 */
const ANALYSIS_ID_MAX = 2_147_483_647;

/**
 * `GET /api/analyses/{id}`(Issue #183〈#165-a〉): 分析1件を、馬名つき・配分つきで返す(整形は `analysis-view.ts`。`rawResponse`・`contributions`・raceSnapshot の全体は返さない)。
 * id は正の整数(先頭の 0 なし・{@link ANALYSIS_ID_MAX} 以下)で、クエリは受け付けない(不正は 400。D1・R2 に触れない)。無ければ 404、D1 の失敗は 503(文面なし)。
 * **R2 の詳細は、操作回数の柵の内側で読む**(`getAnalysisDetail`。柵に達した・R2 に無い・壊れているときは `detail: "missing"` で馬名なし。`detail_key` が無ければ `none`)。
 * ⚠️ 詳細が present のときは、R2 の GET に加えて D1 の `r2_ops` を +1 する(書き込み1行)。**無害な読み取りではない**ので、画面から自動で繰り返し呼ばないこと。
 * 配分(D1)の読み出しが失敗したら、配分だけ欠けた 200 にせず、全体を 503 にする(「買い目なし」と誤読されないため)。
 */
async function handleAnalysisDetail(url: URL, idText: string, env: Env): Promise<Response> {
  if ([...url.searchParams.keys()].length > 0) {
    return badRequest("このパスにクエリは指定できません");
  }
  const id = /^[1-9][0-9]{0,9}$/.test(idText) ? Number(idText) : Number.NaN;
  if (!Number.isInteger(id) || id > ANALYSIS_ID_MAX) {
    return badRequest(`分析 id は 1〜${ANALYSIS_ID_MAX} の整数(先頭に 0 を付けない)で指定してください`);
  }
  try {
    const store = new D1AnalysisStore({ db: env.DB, bucket: env.ANALYSIS_DETAIL });
    const result = await store.getAnalysisDetail(id);
    if (result === undefined) {
      return json({ ok: false, error: { type: "not-found" } }, 404);
    }
    const allocation = await store.getStoredAllocation(id);
    return json({ ok: true, analysis: buildAnalysisView(result, allocation) });
  } catch {
    // 例外の文面・SQL は返さない。
    return json({ ok: false, error: { type: "d1-error" } }, 503);
  }
}

const RACES_PARAMS = new Set(["kaisai_date", "venue"]);

/**
 * `GET /api/races?kaisai_date=YYYYMMDD&venue=central|nar`(Issue #183〈#165-a〉): 開催日のレース一覧(場 → R の順。整形は `race-list.ts`)。
 * 開催日の DO(RaceDay)の `getRaceList` が、gate 経由のキャッシュ(TTL 6 時間)で取る。**この GET は netkeiba に出うる**(キャッシュが無ければ1本取る)ので、
 * 順序は: `Sec-Fetch-Site`(別サイトからなら 403)→ 入力の検証(400。ここまでで DO は呼ばない)→ DO。
 * 取得の失敗は 503 `netkeiba-unavailable`(`reason`: blocked・busy・failed。gate の文面は載せない。リトライ・Retry-After は無い)、DO の失敗は 503 `race-day-error`。
 * 開催なしの日は 200 で `races: []`。
 */
async function handleRaces(request: Request, env: Env): Promise<Response> {
  // 別サイトのページから(ログイン中の利用者のブラウザで)呼ばれて、日付を変えて netkeiba への取得を起こされるのを拒否する。
  // ブラウザは Sec-Fetch-Site を付ける(アドレスバー・ブックマークは none、同じオリジンの fetch は same-origin)。付かない非ブラウザのクライアントは通す。
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return json({ ok: false, error: { type: "origin-mismatch" } }, 403);
  }
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.some((k) => !RACES_PARAMS.has(k)) || new Set(keys).size !== keys.length) {
    return badRequest("クエリは kaisai_date(必須)と venue(必須)だけを、それぞれ1つまで指定できます");
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
  const venue = url.searchParams.get("venue");
  if (venue !== "central" && venue !== "nar") {
    return badRequest("venue は central(中央)か nar(地方)で指定してください");
  }
  try {
    const result = await raceDayStub(env, kaisaiDate).getRaceList(kaisaiDate, venue);
    if (!result.ok) {
      // reason は固定の3値だけを写す(DO から別の値・文面が来ても、そのまま返さない)。
      const reason = result.reason === "blocked" || result.reason === "busy" ? result.reason : "failed";
      return json({ ok: false, error: { type: "netkeiba-unavailable", reason } }, 503);
    }
    return json({ ok: true, kaisai_date: kaisaiDate, venue, races: toRaceListRows(result.races) });
  } catch {
    return raceDayError();
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
 * JSON のオブジェクトを受ける POST の守り(Issue #189。run と settings で共有する。`handleRun` から抜き出した)。
 * 順序: Origin(403)→ Content-Type(415)→ 本文の大きさ(413。`maxBytes` はルートごと)→ JSON として読める(400)→ JSON のオブジェクト(400)。
 * 失敗は、そのまま返せる `response`(本文は固定の文言。入力を写さない)。**裏側(DO・D1)に触れる前に呼ぶ**。
 */
type JsonObjectBody = { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly response: Response };

async function readJsonObjectBody(request: Request, maxBytes: number): Promise<JsonObjectBody> {
  if (!originAllowed(request)) {
    return { ok: false, response: json({ ok: false, error: { type: "origin-mismatch" } }, 403) };
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, response: json({ ok: false, error: { type: "unsupported-media-type", message: "Content-Type は application/json にしてください" } }, 415) };
  }
  const text = await readLimitedText(request, maxBytes);
  if (text === null) {
    return { ok: false, response: json({ ok: false, error: { type: "payload-too-large", message: `本文は ${maxBytes} バイトまでです` } }, 413) };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, response: badRequest("本文が JSON として読めません") };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, response: badRequest("本文は JSON のオブジェクトにしてください") };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * `POST /api/analyses/run`(Issue #180〈#164-e〉): レースの朝の取得と prior(`morning`。省略時)または発走前の分析(`pre_race`。LLM を使う〈Issue #194。キー未登録なら LLM なしで保存〉。D1・R2 に保存。Issue #178)を予約する。本文は JSON `{ race_id, kaisai_date, mode? }`。
 * 日単位の DO(RaceDay。名前は開催日)の `schedule` に予約を入れて **202** を返す(取得はアラームの中で始まる)。実行中の同じレースなら **409**(already-running)。
 * 順序: 守り(`readJsonObjectBody`。Origin 403 → Content-Type 415 → 本文の大きさ 413 → JSON のオブジェクト 400)→ 入力の検証(400。ここまでで DO は呼ばない)→ DO(失敗は 503。文面は返さない)。
 * **netkeiba への取得の起点は、認証の後ろの手動の操作だけ**(この POST の予約・`GET /api/races` の一覧・`GET /api/netkeiba/check`。Cron・scheduled は無い。定時は #166。呼び出し箇所の数は `cloud-config-guard.test.ts` が固定)。
 */
async function handleRun(request: Request, env: Env): Promise<Response> {
  const guarded = await readJsonObjectBody(request, RUN_BODY_MAX_BYTES);
  if (!guarded.ok) {
    return guarded.response;
  }
  const record = guarded.body;
  if (Object.keys(record).some((k) => !RUN_KEYS.has(k))) {
    return badRequest("本文のキーは race_id・kaisai_date・mode だけです");
  }
  const raceId = record["race_id"];
  const kaisaiDate = record["kaisai_date"];
  if (typeof raceId !== "string" || typeof kaisaiDate !== "string") {
    return badRequest("race_id と kaisai_date は文字列で指定してください");
  }
  const mode = record["mode"] ?? "morning";
  if (mode !== "morning" && mode !== "pre_race") {
    return badRequest('mode は "morning"(朝の取得と prior)か "pre_race"(発走前の分析。LLM を使う)です');
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
    const result = await raceDayStub(env, kaisaiDate).schedule({ raceId: checkedRace.raceId, kaisaiDate, mode });
    if (!result.accepted) {
      return json({ ok: false, error: { type: "already-running", status: result.status } }, 409);
    }
    return json({ ok: true, accepted: true, race_id: result.raceId, kaisai_date: kaisaiDate, mode: result.mode, status: result.status }, 202);
  } catch {
    return raceDayError();
  }
}

/** 設定の POST の本文の上限(バイト)。追加指示 2,000 文字が JSON のエスケープ(最大で1文字 6 バイト = 12,000 バイト)になっても、他の 13 項目と合わせて収まる大きさ。run の上限とは別。 */
const SETTINGS_BODY_MAX_BYTES = 16 * 1024;

/**
 * `GET /api/settings`(Issue #189): 現在の設定を返す(D1 の `cloud_settings` の1行。`loadSettings`)。
 * 応答は `{ ok, settings, source }`。`source` は `default`(行が無い)・`d1`(行を読んだ)・`invalid`(行はあるが JSON として読めない、またはオブジェクトでない。既定値で続けている)。
 * 読む側の範囲(`coerceCloudSettings`)なので、手で入れた不正な項目は既定値になって返る。D1 の失敗は 503(文面なし)。GET だけ(HEAD で D1 を引かない)。
 */
async function handleSettingsGet(env: Env): Promise<Response> {
  try {
    const loaded = await loadSettings(env.DB);
    return json({ ok: true, settings: loaded.settings, source: loaded.source });
  } catch {
    // 例外の文面・SQL は返さない。
    return json({ ok: false, error: { type: "d1-error" } }, 503);
  }
}

/**
 * `POST /api/settings`(Issue #189): 設定を D1 に保存する。**全項目の置き換え**(キーが欠けている・未知のキーがある・範囲外は 400。黙って既定値に戻さない)。
 * 順序: 守り(`readJsonObjectBody`。上限は 16 KiB)→ 検証(書く側の範囲。400。ここまでで D1 に書かない)→ UPSERT(失敗は 503。文面なし)。
 * 成功は 200 で、保存した設定を返す(`{ ok: true, settings }`)。400 の本文は固定の message と、欠けた・範囲外の**既知の項目名**(`fields`。入力の値・未知のキー名は写さない)。
 */
async function handleSettingsSave(request: Request, env: Env, now: () => Date): Promise<Response> {
  const guarded = await readJsonObjectBody(request, SETTINGS_BODY_MAX_BYTES);
  if (!guarded.ok) {
    return guarded.response;
  }
  const checked = validateCloudSettingsForSave(guarded.body);
  if (!checked.ok) {
    return json({ ok: false, error: { type: "bad-request", message: "設定の項目が足りない・未知の項目がある・範囲外の値があります", fields: checked.fields } }, 400);
  }
  try {
    await saveSettings(env.DB, checked.settings, now().toISOString());
    return json({ ok: true, settings: checked.settings });
  } catch {
    // 例外の文面・SQL は返さない。
    return json({ ok: false, error: { type: "d1-error" } }, 503);
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
      mode: r.mode,
      status: r.status,
      attempts: r.attempts,
      error: r.error === null ? null : r.error.slice(0, STATUS_ERROR_MAX),
      queued_at: r.queuedAt,
      updated_at: r.updatedAt,
      prior: r.computedAt !== null,
      analysis_id: r.analysisId,
      detail: r.detail,
      children_ok: r.childrenOk,
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
