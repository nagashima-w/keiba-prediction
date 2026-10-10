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
import { resolveAppBaseUrl } from "./notify-link";
import { remoteKeys } from "./access-jwt";
import { authenticate, type AccessContextLike } from "./authenticate";
import type { GatePostRequest, GateResult, GateStatus } from "./gate-core";
import { runGradeWinnerCheck, runShutubaCheck, validateRaceId, type CheckTarget } from "./netkeiba-check";
import { buildAnalysisView } from "./analysis-view";
import { CLIENT_JS } from "./client-bundle.generated";
import { APP_CSP, CHECK_CSP, renderCheckPage, renderPage } from "./page";
import { checkKaisaiDate, checkRaceDate } from "./race-date";
import { loadSettings, saveSettings, validateCloudSettingsForSave } from "./settings";
import type { AutoRunResults, Board, MorningPrior, NotificationRecord, PlanProgress, RaceListResult, RaceListVenue, RequestPlanResult, RequestResultImportResult, ResultImportProgress, ScheduleInput, ScheduleResult } from "./race-day-core";
import { jstKaisaiDate } from "./auto-run-plan";
import { addDaysToKaisaiDate, dispatchResultImports, MANUAL_RESULT_MAX_DAYS } from "./result-dispatch";
import { D1ResultStore } from "./result-repository";
import type { MigrationStatus, StartResult } from "./migration-core";
import { RESULT_BACKFILL_NAME, type BackfillStatus } from "./result-backfill-core";
import type { GetReportOptions, VerifyResponse } from "./verify-core";
import { toRaceListRows } from "./race-list";
import type { JWTVerifyGetKey } from "jose";

/** Durable Object(NetkeibaGate)のスタブの、使う部分だけの型(RPC なので、同期のメソッドも Promise になる)。 */
export interface GateStubLike {
  ping(): Promise<{ sqlite: boolean }>;
  fetchRaw(url: string): Promise<GateResult>;
  /** POST を1本送る(Issue #181。確認ページの `type=grade-winner` が使う)。 */
  postRaw(request: GatePostRequest): Promise<GateResult>;
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
  /** 朝の計画の依頼(Issue #203・#206)。**呼ぶのは cron の `scheduled`(scheduled.ts)だけ**。手動の入口〈handler.ts〉は呼ばない(ガードテストが固定)。 */
  requestPlan(input: { readonly kaisaiDate: string }): Promise<RequestPlanResult>;
  /** 朝の計画の読み取り(Issue #206 `GET /api/plan`。状態は変えない)。 */
  getPlanProgress(): Promise<PlanProgress>;
  /** 自動実行の各レースの結果の読み取り(Issue #204・#206。状態は変えない)。 */
  getAutoRunResults(): Promise<AutoRunResults>;
  /** 通知の一覧の読み取り(Issue #205・#206。URL・例外の文面を含まない。状態は変えない)。 */
  getNotifications(): Promise<NotificationRecord[]>;
  /** 結果の取り込みの依頼(Issue #208)。**呼ぶのは `dispatchResultImports`(result-dispatch.ts。cron の `scheduled` と手動の `POST /api/results/import`)だけ**。handler.ts は直接は呼ばない(ガードテストが固定)。 */
  requestResultImport(input: { readonly kaisaiDate: string; readonly raceIds: readonly string[] }): Promise<RequestResultImportResult>;
  /** 結果の取り込みの観測（Issue #208 `GET /api/plan`。状態は変えない）。 */
  getResultImportProgress(): Promise<ResultImportProgress>;
}

/** 日単位の DO(RaceDay)の名前空間の、使う部分だけの型。名前は開催日(YYYYMMDD)。 */
export interface RaceDayNamespaceLike {
  idFromName(name: string): any;
  get(id: any): RaceDayStubLike;
}

/** 移行の DO(CloudMigration)のスタブの、使う部分だけの型(RPC なので、同期のメソッドも Promise になる)。Issue #216。 */
export interface MigrationStubLike {
  /** アップロードされたファイル(R2 のキー)の取り込みを頼む。取り込み中なら `busy`。 */
  start(input: { readonly key: string; readonly size: number }): Promise<StartResult>;
  /** 進捗の読み取り(状態は変えない)。 */
  getStatus(): Promise<MigrationStatus>;
}

/** 移行の DO の名前空間の、使う部分だけの型。単一インスタンス(固定名)。 */
export interface MigrationNamespaceLike {
  idFromName(name: string): any;
  get(id: any): MigrationStubLike;
}

/** 移行の DO の固定名(単一インスタンス)。 */
const MIGRATION_NAME = "main";

/** 結果の補完の DO(ResultBackfill)のスタブの、使う部分だけの型(RPC なので Promise)。Issue #217。 */
export interface BackfillStubLike {
  /** アラームが無ければ張る(cron の `scheduled` から毎日 1 回)。 */
  kick(): Promise<void>;
  /** 進捗の読み取り(状態は変えない。アラームが無ければ張り直す)。 */
  getStatus(): Promise<BackfillStatus>;
}

/** 結果の補完の DO の名前空間の、使う部分だけの型。単一インスタンス(固定名 {@link RESULT_BACKFILL_NAME})。 */
export interface BackfillNamespaceLike {
  idFromName(name: string): any;
  get(id: any): BackfillStubLike;
}

/** 検証の DO(VerifyReportDO)のスタブの、使う部分だけの型(RPC なので Promise)。Issue #219。 */
export interface VerifyStubLike {
  /** 検証の集計(キャッシュ・補完の確認を含む)。区分は `all`・`central`・`nar`。 */
  getReport(venue: "all" | "central" | "nar", options?: GetReportOptions): Promise<VerifyResponse>;
}

/** 検証の DO の名前空間の、使う部分だけの型。単一インスタンス(固定名 {@link VERIFY_NAME})。 */
export interface VerifyNamespaceLike {
  idFromName(name: string): any;
  get(id: any): VerifyStubLike;
}

/** 検証の DO の固定名(単一インスタンス)。 */
const VERIFY_NAME = "main";

export interface Env extends AccessEnv {
  NETKEIBA_GATE: GateNamespaceLike;
  /** 日単位の DO(RaceDay。wrangler.toml の binding)。Issue #177・#180。 */
  RACE_DAY: RaceDayNamespaceLike;
  /** exe から移したファイルの取り込みの DO(CloudMigration。wrangler.toml の binding)。Issue #216。本番では常にある。無い構成(binding の設定漏れ)では、移行の 2 つの API が 503 になる。 */
  CLOUD_MIGRATION?: MigrationNamespaceLike;
  /** 結果の補完の DO(ResultBackfill。wrangler.toml の binding)。Issue #217。本番では常にある。無い構成では `GET /api/results/backfill` が 503 になり、cron は kick を呼ばない。 */
  RESULT_BACKFILL?: BackfillNamespaceLike;
  /** 検証の集計の DO(VerifyReportDO。wrangler.toml の binding)。Issue #219。本番では常にある。無い構成では `GET /api/verify` が 503 になる。 */
  VERIFY_REPORT?: VerifyNamespaceLike;
  /** D1(分析履歴。wrangler.toml の `[[d1_databases]]` の binding)。Issue #171。 */
  DB: AnalysisDb;
  /** R2(分析の詳細オブジェクト。wrangler.toml の `[[r2_buckets]]` の binding)。Issue #174・#175。get と put だけを使う。 */
  ANALYSIS_DETAIL: AnalysisBucket;
  /** 発走前の分析の LLM の API キー(Worker の secret。ユーザーが登録する。Issue #194)。ここでは「登録されているか」だけを `/api/health` に返す(値は読まない・返さない)。 */
  ANTHROPIC_API_KEY?: string;
  /** 通知(Discord。Issue #205)の Webhook URL(Worker の secret。ユーザーが登録する)。ここでは「通知に使える形で登録されているか」だけを `/api/health` に返す(値は返さない)。 */
  DISCORD_WEBHOOK_URL?: string;
  /** 通知のタイトルのリンク(分析画面)の基点(Worker の secret。ユーザーが登録する。Issue #230)。https のオリジンだけ有効。ここでは「リンクに使える形で登録されているか」だけを `/api/health` に返す(値は返さない)。 */
  APP_BASE_URL?: string;
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
  // 手動起動の入口(Issue #180)。**POST を受けるのは、`/api/settings`・`/api/analyses/run`・`/api/results/import`・`/api/migration/upload` の 4 本だけ**(下の 2 本は Issue #208・#216)。認証(上)の後で、Origin の確認・入力の検証を行う。
  if (method === "POST" && new URL(request.url).pathname === "/api/analyses/run") {
    return handleRun(request, env);
  }
  // 手動の結果の取り込み(Issue #208)。窓（cron の過去 7 日）より古いぶんの取り込み用。POST の入口は全部で 4 本(上の 2 つ〈`/api/settings`・`/api/analyses/run`〉・ここ・下の `/api/migration/upload`)。
  if (method === "POST" && new URL(request.url).pathname === "/api/results/import") {
    return handleResultsImport(request, env, deps.now ?? (() => new Date()), log);
  }
  // 移行ファイルの受け取り(Issue #216)。**POST を受けるのは、ここを含めて 4 つだけ**(`/api/settings`・`/api/analyses/run`・`/api/results/import`・`/api/migration/upload`)。
  if (method === "POST" && new URL(request.url).pathname === "/api/migration/upload") {
    return handleMigrationUpload(request, env, log);
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
    // Issue #230: 通知のリンクの基点(Worker の secret APP_BASE_URL)が**リンクに使える形(https のオリジン)で登録されているか**だけを返す(値・長さ・一部は返さない)。形式が不正なものは false
    // (リンクに使われないものを true にしない。false は「未登録」か「形式が不正」)。ok には含めない(リンクが無くても、通知は送られる)。
    const appBaseUrl = resolveAppBaseUrl(env.APP_BASE_URL).status === "valid";
    return json({ ok, durableObject: { sqlite }, d1: { ok: d1.ok }, secrets: { anthropic, discord, appBaseUrl } }, ok ? 200 : 503);
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

  if (pathname === "/api/migration/upload") {
    // POST だけ(上で処理済み)。GET・HEAD などは 405。
    return new Response("method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (pathname === "/api/migration") {
    // 読み取り専用(移行の DO の状態を読むだけ。netkeiba にも LLM にも出ない)。GET だけ(HEAD で DO を開かない)。Issue #216。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleMigrationStatus(env);
  }

  if (pathname === "/api/verify") {
    // 読み取り専用(検証の DO の集計を読むだけ。netkeiba にも LLM にも出ない。Worker は D1・R2 に触れない)。GET だけ(HEAD で DO を開かない)。Issue #219。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleVerify(request, env);
  }

  if (pathname === "/api/results/backfill") {
    // 読み取り専用(補完の DO の状態を読むだけ。netkeiba にも LLM にも出ない)。GET だけ(HEAD で DO を開かない)。Issue #217。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleBackfillStatus(env);
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

  if (pathname === "/api/plan") {
    // 読み取り専用(DO の状態を読むだけ。netkeiba にも LLM にも D1・R2 にも出ない)。GET だけ(HEAD で DO を開かない)。Issue #206。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handlePlan(request, env);
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


/** 移行ファイルのアップロードの上限(バイト)。実データは gzip で約 15MB(分析 2,225 件・結果 1,301 レース)。 */
export const MIGRATION_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const UPLOAD_CONTENT_TYPES: ReadonlySet<string> = new Set(["application/gzip", "application/x-gzip", "application/octet-stream"]);

/** 移行の DO のスタブ(単一インスタンス)。 */
function migrationStub(env: Env): MigrationStubLike {
  const namespace = env.CLOUD_MIGRATION;
  if (namespace === undefined) {
    throw new Error("CLOUD_MIGRATION binding がありません");
  }
  return namespace.get(namespace.idFromName(MIGRATION_NAME));
}

/** `GET /api/migration`: 移行の進捗(状態・取り込んだ件数・全体の件数・予算・再開時刻・失敗の理由)。DO の失敗は 503(文面は返さない)。 */
async function handleMigrationStatus(env: Env): Promise<Response> {
  try {
    return json({ ok: true, ...(await migrationStub(env).getStatus()) });
  } catch {
    return json({ ok: false, error: { type: "migration-error" } }, 503);
  }
}

/** `GET /api/results/backfill`: 結果の補完の進捗(状態・残り・取得済み・取得できなかった数・開催日不明の数・今夜の依頼数・次の実行)。DO の失敗・binding なしは 503(文面は返さない)。Issue #217。 */
async function handleBackfillStatus(env: Env): Promise<Response> {
  try {
    const namespace = env.RESULT_BACKFILL;
    if (namespace === undefined) {
      throw new Error("RESULT_BACKFILL binding がありません");
    }
    return json({ ok: true, ...(await namespace.get(namespace.idFromName(RESULT_BACKFILL_NAME)).getStatus()) });
  } catch {
    return json({ ok: false, error: { type: "backfill-error" } }, 503);
  }
}

const VERIFY_PARAMS = new Set(["venue", "refresh"]);
const VERIFY_VENUES = new Set(["all", "central", "nar"]);

/**
 * `GET /api/verify?venue=all|central|nar[&refresh=1]`(Issue #219〈#219 web の検証画面(1)〉): 検証の集計(累積回収率・配分ベースの回収率ほか。core の `computeVerifyReport`)。
 * 集計は DO(`VerifyReportDO`)がキャッシュ付きで行い、Worker は呼ぶだけ(Workers Free の CPU は 10ms。D1・R2 に触れない)。応答の `status`: `ready`(集計。`stale` なら古い)・
 * `preparing`(発走時刻の補完中)・`throttled`(1 日の再計算の上限に達していて、出せる集計が無い)。`refresh=1` は再計算の要求(DO の最短間隔・1 日の上限は守られる)。
 * **別サイトからの要求は 403**(`Sec-Fetch-Site`。D1 を数万行読む再計算を外から起こされないため)。入力の検証が先(400。DO は呼ばない)。DO の失敗・binding なしは 503(固定の種類名)。
 */
async function handleVerify(request: Request, env: Env): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return json({ ok: false, error: { type: "origin-mismatch" } }, 403);
  }
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.some((k) => !VERIFY_PARAMS.has(k)) || new Set(keys).size !== keys.length) {
    return badRequest("クエリは venue(all・central・nar)と refresh(1 または 0)だけを、それぞれ1つまで指定できます");
  }
  const venue = url.searchParams.get("venue") ?? "all";
  if (!VERIFY_VENUES.has(venue)) {
    return badRequest("venue は all・central・nar のどれかで指定してください");
  }
  const refreshValue = url.searchParams.get("refresh");
  if (refreshValue !== null && refreshValue !== "0" && refreshValue !== "1") {
    return badRequest("refresh は 1 または 0 で指定してください");
  }
  try {
    const namespace = env.VERIFY_REPORT;
    if (namespace === undefined) {
      throw new Error("VERIFY_REPORT binding がありません");
    }
    const response = await namespace.get(namespace.idFromName(VERIFY_NAME)).getReport(venue as "all" | "central" | "nar", { refresh: refreshValue === "1" });
    return json({ ok: true, ...response });
  } catch {
    return json({ ok: false, error: { type: "verify-error" } }, 503);
  }
}

/** アップロードで R2 に置くファイルを消すときに使う窓口(本物のバケットは delete を持つ。型 `AnalysisBucket` は get/put だけ)。 */
type UploadBucket = AnalysisBucket & Pick<R2Bucket, "delete">;

/**
 * `POST /api/migration/upload`(Issue #216〈#167-B1〉): exe の「クラウド移行用に書き出す」で作った gzip を受け取る。**本文は解釈せず、R2 にそのまま置く**
 * (Workers Free の CPU は 10ms。検証・取り込みは移行の DO がアラームで少しずつ行う)。本文は gzip のバイト列(JSON ではない)。
 * 順序: Origin(403)→ Content-Type(415)→ Content-Length(411。無い・不正なとき。413。上限 {@link MIGRATION_UPLOAD_MAX_BYTES} を超えるとき)→
 * **取り込み中でないか**(409 `migration-busy`。**本文を読まずに断る**)→ R2 の書き込み(Class A)の柵(503 `r2-fence`)→ R2 に置く(キーは毎回別。取り込み中のファイルを上書きしない)→
 * Class A を 1 回数える → DO に取り込みを頼む(受け付けなければ置いたファイルを消して 409。例外なら消して 503)。202 で進捗を返す。
 * 失敗の応答に、例外の文面は含めない。
 */
async function handleMigrationUpload(request: Request, env: Env, log: (line: string) => void): Promise<Response> {
  if (!originAllowed(request)) {
    return json({ ok: false, error: { type: "origin-mismatch" } }, 403);
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!UPLOAD_CONTENT_TYPES.has(contentType)) {
    return json({ ok: false, error: { type: "unsupported-media-type", message: "Content-Type は application/gzip にしてください" } }, 415);
  }
  const declared = request.headers.get("content-length");
  if (declared === null || !/^[1-9][0-9]*$/.test(declared)) {
    return json({ ok: false, error: { type: "length-required", message: "Content-Length が必要です" } }, 411);
  }
  const size = Number(declared);
  if (size > MIGRATION_UPLOAD_MAX_BYTES) {
    return json({ ok: false, error: { type: "payload-too-large", message: `ファイルは ${MIGRATION_UPLOAD_MAX_BYTES} バイトまでです` } }, 413);
  }
  if (request.body === null) {
    return badRequest("本文がありません");
  }

  const bucket = env.ANALYSIS_DETAIL as UploadBucket;
  const store = new D1AnalysisStore({ db: env.DB, bucket });
  let key: string | null = null;
  try {
    const stub = migrationStub(env);
    const status = await stub.getStatus();
    if (status.state === "verifying" || status.state === "importing" || status.state === "waiting-budget" || status.state === "waiting-r2") {
      return json({ ok: false, error: { type: "migration-busy", message: "取り込み中です。完了(または失敗)してから、もう一度アップロードしてください" } }, 409);
    }
    if (!(await store.getR2Usage()).writeAllowed) {
      return json({ ok: false, error: { type: "r2-fence", message: "R2 の書き込み回数の上限に達しています。翌月に再開してください" } }, 503);
    }
    key = `migration/${crypto.randomUUID()}.ndjson.gz`;
    await bucket.put(key, request.body, { httpMetadata: { contentType: "application/gzip" } });
    await store.countR2Write().catch(() => undefined); // 数えられなくても、置いたファイルの取り込みは続ける(カウンタは best-effort)
    const started = await stub.start({ key, size });
    if (!started.accepted) {
      await bucket.delete(key).catch(() => undefined);
      return json({ ok: false, error: { type: "migration-busy", message: "取り込み中です。完了(または失敗)してから、もう一度アップロードしてください" } }, 409);
    }
    return json({ ok: true, ...(await stub.getStatus()) }, 202);
  } catch {
    log("migration: upload failed");
    if (key !== null) {
      await bucket.delete(key).catch(() => undefined);
    }
    return json({ ok: false, error: { type: "migration-error" } }, 503);
  }
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
 * **netkeiba への取得の起点は、認証の後ろの手動の操作だけ**(この POST の予約・`GET /api/races` の一覧・`GET /api/netkeiba/check`。ほかに、定時の起点が cron の `scheduled`〈scheduled.ts の `requestPlan` 1 つ。Issue #206〉。手動 3 + 定時 1 の計 4 つ。さらに結果の取り込みの依頼〈Issue #208。`dispatchResultImports`〈result-dispatch.ts〉の `requestResultImport` 1 箇所。cron と `POST /api/results/import` が共有〉で、呼び出し箇所は計 5 つ。呼び出し箇所の数は `cloud-config-guard.test.ts` が固定)。
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

/** 自由文(会場の失敗の理由・自動実行の失敗の文面)を返すときの長さの上限(文字)。`/api/analyses/status` の `error` と同じ。 */
const PLAN_TEXT_MAX = STATUS_ERROR_MAX;
const clipText = (text: string | null): string | null => (text === null ? null : text.slice(0, PLAN_TEXT_MAX));

/**
 * `GET /api/plan?kaisai_date=YYYYMMDD`(Issue #206〈#166-E〉G-E3): 定時の自動実行を外から観測する、読み取り専用の入口。
 * 日単位の DO(RaceDay)の `getPlanProgress`(朝の計画)・`getAutoRunResults`(各レースの結果)・`getNotifications`(通知の一覧)・`getResultImportProgress`(結果の取り込みの状態。Issue #208)を読んで返す。
 * **netkeiba にも LLM にも D1・R2 にも出ない。状態も変えない**(この関数は `.schedule(`・`.requestPlan(`・`.getRaceList(`・gate を呼ばない。`cloud-config-guard.test.ts` が固定)。
 * 理由: 対象が 0 件の日は通知が何も出ないので、自動実行が動いたのか壊れているのかを、外から確かめる手段が要る。
 * 順序: `Sec-Fetch-Site`(別サイトなら 403。開催日を変えて DO を作らせる cross-site の GET を拒否)→ クエリの検証(400。ここまでで DO は呼ばない)→ DO(失敗は 503・文面なし)。
 * 応答は**明示のホワイトリスト**で作る(DO の返り値を展開しない)。通知の Webhook の URL は DO の通知の仕組みの中にだけあり、この応答にもこの関数にも現れない
 * (この関数は `env.DISCORD_WEBHOOK_URL` を読まない)。自由文は 200 文字に切る。
 */
async function handlePlan(request: Request, env: Env): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return json({ ok: false, error: { type: "origin-mismatch" } }, 403);
  }
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.some((k) => k !== "kaisai_date") || new Set(keys).size !== keys.length) {
    return badRequest("クエリは kaisai_date だけを1つ指定できます");
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
  try {
    const stub = raceDayStub(env, kaisaiDate);
    const [progress, auto, notifications, resultImport] = await Promise.all([stub.getPlanProgress(), stub.getAutoRunResults(), stub.getNotifications(), stub.getResultImportProgress()]);
    return json({
      ok: true,
      kaisai_date: kaisaiDate,
      plan: {
        stage: progress.stage,
        requested_at: progress.requestedAt,
        finalized_at: progress.finalizedAt,
        offset_minutes: progress.offsetMinutes,
        offset_source: progress.offsetSource,
        morning_all_terminal: progress.morningAllTerminal,
        venues: progress.venues.map((v) => ({ venue: v.venue, state: v.state, attempts: v.attempts, reason: clipText(v.reason), listed: v.listed, targeted: v.targeted })),
        rows: progress.rows.map((r) => ({
          race_id: r.raceId,
          venue: r.venue,
          venue_name: r.venueName,
          race_number: r.raceNumber,
          race_name: r.raceName,
          grade: r.grade,
          start_time: r.startTime,
          due_ms: r.dueMs,
          disposition: r.disposition,
          skip_reason: r.skipReason,
          state: r.state,
          morning: r.morning,
        })),
      },
      results: auto.results.map((r) => ({
        race_id: r.raceId,
        venue: r.venue,
        venue_name: r.venueName,
        race_number: r.raceNumber,
        race_name: r.raceName,
        grade: r.grade,
        start_time: r.startTime,
        due_ms: r.dueMs,
        outcome: {
          kind: r.outcome.kind,
          reason: r.outcome.kind === "failed" || r.outcome.kind === "skipped" ? r.outcome.reason : null,
          analysis_id: r.outcome.kind === "completed" ? r.outcome.analysisId : null,
          detail: r.outcome.kind === "completed" ? r.outcome.detail : null,
          message: r.outcome.kind === "failed" ? clipText(r.outcome.message) : null,
        },
      })),
      notifications: notifications.map((n) => ({ key: n.key, kind: n.kind, state: n.state, analysis_id: n.analysisId, error_class: n.errorClass, updated_at: n.updatedAt })),
      // 結果の取り込み(Issue #208)。固定の語と数値だけ(メッセージ・例外の文面は DO が持たない)。
      result_import: {
        total: resultImport.total,
        queued: resultImport.queued,
        imported: resultImport.imported,
        gave_up: resultImport.gaveUp,
        races: resultImport.races.map((r) => ({
          race_id: r.raceId,
          state: r.state,
          attempts: r.attempts,
          deferrals: r.deferrals,
          requested_on: r.requestedOn,
          next_try_at: r.nextTryAt,
          last_class: r.lastClass,
          updated_at: r.updatedAt,
        })),
      },
    });
  } catch {
    // 例外の文面・SQL は返さない。
    return raceDayError();
  }
}

/** 手動の結果の取り込みの本文の上限(バイト)。入力は from・to だけ。 */
const RESULTS_IMPORT_BODY_MAX_BYTES = 1024;
const RESULTS_IMPORT_KEYS = new Set(["from", "to"]);
/** 手動の結果の取り込みの範囲の上限（両端を含めた日数）。 */
const RESULTS_IMPORT_MAX_SPAN_DAYS = 31;

/**
 * `POST /api/results/import`(Issue #208〈#182-B〉): 窓（cron の過去 7 日）より古いぶんの、結果の取り込みを依頼する。本文は JSON `{ from, to }`（JST の開催日 YYYYMMDD。両端を含む）。
 * 範囲は 31 日以内で、**今日を含めない**（`to` は JST の前日以前。当日中の取り込みは対象外）。
 * 中身は cron と同じ `dispatchResultImports`(窓の未取込を **1 クエリ**で列挙 → 新しい日から最大 {@link MANUAL_RESULT_MAX_DAYS} 日を、日ごとにその日の DO へ依頼)。**依頼だけをして戻る**（取得・保存は DO のアラームの中）。
 * 取り込み済み・進行中のレースは DO が積み直さないので、続きは同じ範囲でもう一度呼べばよい（溜まった分を消化していく）。
 * 順序: 守り(`readJsonObjectBody`。Origin 403 → Content-Type 415 → 本文の大きさ 413 → JSON のオブジェクト 400)→ 入力の検証(400。ここまでで D1 も DO も呼ばない)→ 列挙・依頼。
 * 応答は **202**: `{ ok, listed, days, accepted, failed_days }`（件数だけ）。列挙(D1)の失敗、または依頼した日のすべてで DO が失敗したときは **503**（文面は返さない）。一部の日だけ失敗なら 202（`failed_days`）。
 */
async function handleResultsImport(request: Request, env: Env, now: () => Date, log: (line: string) => void): Promise<Response> {
  const guarded = await readJsonObjectBody(request, RESULTS_IMPORT_BODY_MAX_BYTES);
  if (!guarded.ok) {
    return guarded.response;
  }
  const record = guarded.body;
  if (Object.keys(record).some((k) => !RESULTS_IMPORT_KEYS.has(k))) {
    return badRequest("本文のキーは from・to だけです");
  }
  const from = record["from"];
  const to = record["to"];
  if (typeof from !== "string" || typeof to !== "string") {
    return badRequest("from と to は YYYYMMDD の 8 桁の文字列で指定してください");
  }
  // 検証のメッセージに入力を写すので、長い入力は先頭だけにする(切っても、無効なままであることは変わらない)。
  for (const value of [from, to]) {
    const checked = checkKaisaiDate(value.slice(0, 32));
    if (!checked.ok) {
      return badRequest(checked.message);
    }
  }
  if (from > to) {
    return badRequest("from は to 以前にしてください");
  }
  const today = jstKaisaiDate(now().getTime());
  if (to >= today) {
    return badRequest(`to は今日(${today})より前にしてください(当日中の取り込みは対象外です)`);
  }
  if (addDaysToKaisaiDate(from, RESULTS_IMPORT_MAX_SPAN_DAYS - 1) < to) {
    return badRequest(`範囲は両端を含めて ${RESULTS_IMPORT_MAX_SPAN_DAYS} 日以内にしてください`);
  }
  try {
    const result = await dispatchResultImports({
      from,
      to,
      maxDays: MANUAL_RESULT_MAX_DAYS,
      store: new D1ResultStore({ db: env.DB }),
      stubFor: (date) => raceDayStub(env, date),
      log: (line) => log(line),
    });
    if (result.listFailed || (result.days > 0 && result.failedDays === result.days)) {
      return json({ ok: false, error: { type: "result-import-error" } }, 503);
    }
    return json({ ok: true, listed: result.listed, days: result.days, accepted: result.accepted, failed_days: result.failedDays }, 202);
  } catch {
    // dispatchResultImports は投げない設計だが、準備(ストアの生成など)の例外も文面を出さない。
    return json({ ok: false, error: { type: "result-import-error" } }, 503);
  }
}

function badRequest(message: string): Response {
  return json({ ok: false, error: { type: "bad-request", message } }, 400);
}

/**
 * `GET /api/netkeiba/check?race_id=...[&type=...]`: 1本、ゲート経由で取得して結果を返す(Issue #162 段階2b。`type` は Issue #181)。
 *  - `type` を省略または `shutuba`: 出馬表を GET で取得して頭数を返す。
 *  - `type=grade-winner`: 重賞の過去10年傾向の API へ POST を 1 本送り、過去回の数を返す(Cloudflare の出口から POST が通るかの確認。キャッシュを通さない)。
 * パラメータは `race_id`(必須)と `type`(省略可)だけで、それぞれ1つ(余計なパラメータ・重複・未知の `type` は 400)。race_id が無効なら、ゲートを呼ばない。
 */
async function handleCheck(url: URL, env: Env): Promise<Response> {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "race_id" && key !== "type") || new Set(keys).size !== keys.length || !keys.includes("race_id")) {
    return badRequest("クエリは race_id(必須)と type(省略可。shutuba または grade-winner)だけを、それぞれ1つ指定してください");
  }
  const typeParam = url.searchParams.get("type");
  if (typeParam !== null && typeParam !== "shutuba" && typeParam !== "grade-winner") {
    return badRequest("type は shutuba または grade-winner を指定してください");
  }
  const target: CheckTarget = typeParam ?? "shutuba";
  const checked = validateRaceId(url.searchParams.get("race_id"));
  if (!checked.ok) {
    return badRequest(checked.message);
  }

  const gate = env.NETKEIBA_GATE.get(env.NETKEIBA_GATE.idFromName(GATE_NAME));
  const result =
    target === "grade-winner"
      ? await runGradeWinnerCheck(checked.raceId, (request) => gate.postRaw(request))
      : await runShutubaCheck(checked.raceId, (fetchTarget) => gate.fetchRaw(fetchTarget));
  let gateStatus: GateStatus | undefined;
  try {
    gateStatus = await gate.status();
  } catch {
    // ゲートの状態を読めなくても、確認の結果は返す(例外の中身は返さない)。
  }
  return json(gateStatus === undefined ? result.body : { ...result.body, gate: gateStatus }, result.httpStatus);
}
