/**
 * Worker のリクエスト処理の本体(Issue #161〈#21-C〉)。ランタイムに依存しないよう、鍵の取得・時刻・ログは注入できる。
 *
 * **すべてのルートの前に認証を掛ける**(`/api/health` も含む)。認証できなければ、設定の有無・失敗の理由・ルートの
 * 存在を一切含まない 403 を返す。理由コードはログにだけ出す(トークン・メール・チーム名・AUD は出さない)。
 *
 * **Issue #238**: 認証に通ったアカウントはすべて受け入れ、役割(admin / viewer)を付ける(authenticate.ts)。認証の直後・どのハンドラよりも前に、
 * ルート × 役割の表(route-policy.ts)で 1 回だけ判定し、閲覧者が管理者専用に当たったら 403 `admin-only` で止める(表に無い組み合わせは管理者専用)。
 */
import type { AccessEnv } from "./access-jwt";
import { D1AnalysisStore, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, type AnalysisBucket, type AnalysisDb } from "./analysis-repository";
import { checkD1 } from "./d1-health";
import { readHorseRunsStatus, STATUS_DAYS_DEFAULT, STATUS_DAYS_MAX } from "./horse-runs-repository";
import { webhookStatus } from "./notify-send";
import { resolveAppBaseUrl } from "./notify-link";
import { remoteKeys } from "./access-jwt";
import { authenticate, type AccessContextLike } from "./authenticate";
import { ANALYSIS_DETAIL_PATTERN, MONTHLY_REPORTS_PREFIX, REPORTS_PREFIX, requiredRole } from "./route-policy";
import type { GatePostRequest, GateResult, GateStatus } from "./gate-core";
import { runGradeWinnerCheck, runShutubaCheck, validateRaceId, type CheckTarget } from "./netkeiba-check";
import { buildAnalysisView } from "./analysis-view";
import { CLIENT_JS } from "./client-bundle.generated";
import { ICON_CACHE_CONTROL, iconAsset } from "./icons";
import { APP_CSP, CHECK_CSP, renderCheckPage, renderPage } from "./page";
import { checkKaisaiDate, checkRaceDate } from "./race-date";
import { buildPreviewText } from "./prompt-preview";
import { hasSettingsKeysMismatch, loadSettings, saveSettings, validateCloudSettingsForSave } from "./settings";
import { redactSecrets } from "./llm-run";
import type { AutoRunResults, Board, MorningPrior, NotificationRecord, PlanProgress, RaceListResult, RaceListVenue, RequestPlanResult, RequestResultImportResult, ResultImportProgress, ScheduleInput, ScheduleManyInput, ScheduleManyResult, ScheduleResult } from "./race-day-core";
import { BULK_BODY_MAX_BYTES, MAX_BULK_RACES } from "./bulk-limits";
import { jstKaisaiDate } from "./auto-run-plan";
import { addDaysToKaisaiDate, dispatchResultImports, MANUAL_RESULT_MAX_DAYS } from "./result-dispatch";
import { D1ResultStore } from "./result-repository";
import { D1ReportStore } from "./daily-report-repository";
import { D1MonthlyStore } from "./monthly-report-repository";
import { MONTHLY_REPORT_NAME, type MonthlyMode, type MonthlyStatus, type RequestMonthlyResult } from "./monthly-report-core";
import { isValidMonth, monthRange } from "./monthly-month";
import { DAILY_REPORT_NAME, type ReportMode, type ReportStatus, type RequestReportResult } from "./daily-report-core";
import { RESULT_BACKFILL_NAME, type BackfillStatus } from "./result-backfill-core";
import type { GetReportOptions, VerifyResponse, ViewerVerifyResponse } from "./verify-core";
import type { ExportMode, ExportResponse } from "./prior-export-core";
import { exportFilename, PRIOR_EXPORT_KEY } from "./prior-export-format";
import { toRaceListRows } from "./race-list";
import { D1TargetsStore } from "./targets-repository";
import { D1BabaStore, FETCH_LIST_LIMIT_DEFAULT } from "./baba-repository";
import { ledgerFromWire, type TargetsLedger, type TargetsLedgerWire } from "./targets-ledger";
import { buildTargetsView, type TargetsPlanRow } from "./targets-view";
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
  /** 一括の予約(Issue #251。`POST /api/analyses/run/bulk`。同じ開催日の複数のレースに、同じ種類のタスクを積む。1 日の上限は全か無か)。呼ぶのは `handleRunBulk` だけ(ガードテストが固定)。 */
  scheduleMany(input: ScheduleManyInput): Promise<ScheduleManyResult>;
  getBoard(): Promise<Board>;
  getMorningPrior(raceId: string): Promise<MorningPrior | null>;
  /** 開催日のレース一覧(Issue #183)。 */
  getRaceList(kaisaiDate: string, venue: RaceListVenue): Promise<RaceListResult>;
  /** 事前分析の計画の依頼(Issue #203・#206)。**呼ぶのは cron の `scheduled`(scheduled.ts)だけ**。手動の入口〈handler.ts〉は呼ばない(ガードテストが固定)。 */
  requestPlan(input: { readonly kaisaiDate: string; readonly rescue?: boolean }): Promise<RequestPlanResult>;
  /** 事前分析の計画の読み取り(Issue #206 `GET /api/plan`。状態は変えない)。 */
  getPlanProgress(): Promise<PlanProgress>;
  /** 自動実行の各レースの結果の読み取り(Issue #204・#206。状態は変えない)。 */
  getAutoRunResults(): Promise<AutoRunResults>;
  /** 通知の一覧の読み取り(Issue #205・#206。URL・例外の文面を含まない。状態は変えない)。 */
  getNotifications(): Promise<NotificationRecord[]>;
  /** 結果の取り込みの依頼(Issue #208)。**呼ぶのは `dispatchResultImports`(result-dispatch.ts。cron の `scheduled` と手動の `POST /api/results/import`)だけ**。handler.ts は直接は呼ばない(ガードテストが固定)。 */
  requestResultImport(input: { readonly kaisaiDate: string; readonly raceIds: readonly string[]; readonly winOddsOnly?: boolean }): Promise<RequestResultImportResult>;
  /** 結果の取り込みの観測（Issue #208 `GET /api/plan`。状態は変えない）。 */
  getResultImportProgress(): Promise<ResultImportProgress>;
  /**
   * 収支の途中経過の計算(Issue #361 `GET /api/targets`。**読み取りだけ**。状態を変えない・netkeiba・R2・LLM に出ない)。計算は Worker Free の CPU 10ms に収まらないので DO で行う。
   * 計画のどのレースも発走していなければ null。D1 の読み取りの失敗は例外(Worker が収支なしにする)。呼ぶのは `handleTargets` だけ(ガードテストが固定)。
   */
  getTargetsLedger(input: { readonly kaisaiDate: string; readonly nowMs: number }): Promise<TargetsLedgerWire | null>;
}

/** 日単位の DO(RaceDay)の名前空間の、使う部分だけの型。名前は開催日(YYYYMMDD)。 */
export interface RaceDayNamespaceLike {
  idFromName(name: string): any;
  get(id: any): RaceDayStubLike;
}

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
  /** 閲覧者向けの集計(Issue #263)。キャッシュを読むだけ(集計のやり直し・D1・R2 を起こさない)。管理者向けの情報は落としてある。 */
  getViewerReport(venue: "all" | "central" | "nar"): Promise<ViewerVerifyResponse>;
}

/** 検証の DO の名前空間の、使う部分だけの型。単一インスタンス(固定名 {@link VERIFY_NAME})。 */
export interface VerifyNamespaceLike {
  idFromName(name: string): any;
  get(id: any): VerifyStubLike;
}

/** 検証の DO の固定名(単一インスタンス)。 */
const VERIFY_NAME = "main";

/** 統計モデル用の書き出しの DO(PriorExportDO)のスタブの、使う部分だけの型(RPC なので Promise)。Issue #266。 */
export interface PriorExportStubLike {
  /** 要求(`download`・`refresh`・`status`)。作成中は古いファイルを返さず building を返す。 */
  request(mode: ExportMode): Promise<ExportResponse>;
}

/** 統計モデル用の書き出しの DO の名前空間の、使う部分だけの型。単一インスタンス(固定名 {@link PRIOR_EXPORT_NAME})。 */
export interface PriorExportNamespaceLike {
  idFromName(name: string): any;
  get(id: any): PriorExportStubLike;
}

/** 統計モデル用の書き出しの DO の固定名(単一インスタンス)。 */
const PRIOR_EXPORT_NAME = "main";

/** 日報の DO(DailyReportDO)のスタブの、使う部分だけの型(RPC なので Promise)。Issue #235。 */
export interface DailyReportStubLike {
  /** 日報の作成の依頼(冪等。進行中・作成済みは断る)。`mode: "regenerate"`(Issue #268)は逆に、日報が無い日を断り、1 日の回数の上限がある。 */
  requestReport(input: { readonly kaisaiDate: string; readonly mode: ReportMode }): Promise<RequestReportResult>;
  /** 進行状況(無ければ null)。 */
  getStatus(kaisaiDate: string): Promise<ReportStatus | null>;
}

/** 日報の DO の名前空間の、使う部分だけの型。単一インスタンス(固定名 {@link DAILY_REPORT_NAME})。 */
export interface DailyReportNamespaceLike {
  idFromName(name: string): any;
  get(id: any): DailyReportStubLike;
}


/** 月報の DO(MonthlyReportDO)のスタブの、使う部分だけの型(RPC なので Promise)。Issue #265・#279・#280。依頼するのは cron(`scheduled.ts`。auto・catchup)と、管理者の手動の入口(`POST /api/monthly-reports/run`。manual・regenerate)。 */
export interface MonthlyReportStubLike {
  /** 月報の作成の依頼(冪等。進行中・作成済みは断る)。`startAt`(エポックミリ秒)は、その時刻まで始めない(今から 24 時間以内のときだけ有効)。 */
  requestMonthlyReport(input: { readonly month: string; readonly mode: MonthlyMode; readonly startAt?: number }): Promise<RequestMonthlyResult>;
  /** 進行状況(無ければ null)。 */
  getStatus(month: string): Promise<MonthlyStatus | null>;
}

/** 月報の DO の名前空間の、使う部分だけの型。単一インスタンス(固定名 `MONTHLY_REPORT_NAME`)。 */
export interface MonthlyReportNamespaceLike {
  idFromName(name: string): any;
  get(id: any): MonthlyReportStubLike;
}

export interface Env extends AccessEnv {
  NETKEIBA_GATE: GateNamespaceLike;
  /** 日単位の DO(RaceDay。wrangler.toml の binding)。Issue #177・#180。 */
  RACE_DAY: RaceDayNamespaceLike;
  /** 結果の補完の DO(ResultBackfill。wrangler.toml の binding)。Issue #217。本番では常にある。無い構成では `GET /api/results/backfill` が 503 になり、cron は kick を呼ばない。 */
  RESULT_BACKFILL?: BackfillNamespaceLike;
  /** 検証の集計の DO(VerifyReportDO。wrangler.toml の binding)。Issue #219。本番では常にある。無い構成では `GET /api/verify` が 503 になる。 */
  VERIFY_REPORT?: VerifyNamespaceLike;
  /** 統計モデル用の書き出しの DO(PriorExportDO。wrangler.toml の binding)。Issue #266。本番では常にある。無い構成では `GET /api/export/prior-dataset` が 503 になる。 */
  PRIOR_EXPORT?: PriorExportNamespaceLike;
  /** 日報の DO(DailyReportDO。wrangler.toml の binding)。Issue #235。本番では常にある。無い構成では `POST /api/reports/run` が 503 になり、cron は日報の取り残しの補完をしない(一覧・本文の GET は D1 を読むだけなので動く)。 */
  DAILY_REPORT?: DailyReportNamespaceLike;
  /** 月報の DO(MonthlyReportDO。wrangler.toml の binding)。Issue #265・#279。本番では常にある。無い構成では cron は月報を依頼しない(一覧・本文の GET は D1 を読むだけなので動く)。 */
  MONTHLY_REPORT?: MonthlyReportNamespaceLike;
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

/**
 * 管理者専用への閲覧者のアクセスの拒否(Issue #238)。認証には通った利用者への応答なので、理由は固定の種類名 `admin-only` だけを返す
 * (入力・メール・設定は写さない)。認証の拒否({@link forbidden})とは本文で区別する。
 */
function adminOnly(): Response {
  return json({ ok: false, error: { type: "admin-only" } }, 403);
}

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

/**
 * 別サイトからの要求の拒否の応答(403 `origin-mismatch`。本文は固定)。{@link crossSiteRejection}(GET の `Sec-Fetch-Site`)と、{@link readJsonObjectBody}(POST の Origin)が共有する。
 */
function originMismatch(): Response {
  return json({ ok: false, error: { type: "origin-mismatch" } }, 403);
}

/**
 * GET の入口の `Sec-Fetch-Site` の検査(Issue #183・#256・#266・#267・#336・#360 ほか。8 ルートが共有する)。別サイトのページから(ログイン中の利用者のブラウザで)呼ばれて、
 * D1 の全件走査・DO・netkeiba への取得を起こされるのを拒否する。ブラウザは `Sec-Fetch-Site` を付ける(アドレスバー・ブックマークは `none`、同じオリジンの fetch は `same-origin`)。
 * 付かない非ブラウザのクライアントは通す。拒否するなら 403 の応答、通すなら null。**D1・DO・gate に触れる前に呼ぶ**(順序は各ハンドラの JSDoc と cloud-config-guard.test.ts が固定する)。
 * POST の入口の確認({@link originAllowed}。Origin の完全一致を見て、`none` も通さない)とは別物。
 */
function crossSiteRejection(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none" ? originMismatch() : null;
}

/**
 * クエリのキーが許可リストの外にあるか、同じキーが重複しているか(どちらも不正。値は見ない)。文言は呼び出し側が持つ。
 * 許可リストが空({@link NO_PARAMS})なら「クエリが 1 つでもあれば不正」になる(クエリを受け付けないパス用)。
 */
function hasInvalidQueryKeys(url: URL, allowed: ReadonlySet<string>): boolean {
  const keys = [...url.searchParams.keys()];
  return keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length;
}

/** クエリを受け付けないパスの許可リスト(空)。 */
const NO_PARAMS: ReadonlySet<string> = new Set();
/** `kaisai_date` だけを受けるルート(`/api/baba-fetch`・`/api/plan`・`/api/targets`)の許可リスト。 */
const KAISAI_DATE_PARAMS: ReadonlySet<string> = new Set(["kaisai_date"]);
/** `/api/analyses/status` の許可リスト(kaisai_date は必須・race_id は任意。必須の検査は呼び出し側)。 */
const STATUS_PARAMS: ReadonlySet<string> = new Set(["kaisai_date", "race_id"]);
/** `/api/netkeiba/check` の許可リスト(race_id は必須・type は省略可。必須の検査は呼び出し側)。 */
const CHECK_PARAMS: ReadonlySet<string> = new Set(["race_id", "type"]);

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
  log(`access: ok via=${auth.via} role=${auth.role} admins=${auth.admins}`);

  const method = request.method;
  const { pathname } = new URL(request.url);
  // 役割の関門(Issue #238)。**どのハンドラ・描画・バインディングの利用よりも前に、ここで 1 回だけ**判定する(route-policy.ts の表。表に無い組み合わせは管理者専用)。
  // 閲覧者が管理者専用に当たったら、リクエスト本文を読まずに 403。管理者でない/判定できない場合は閲覧者として扱われている(authenticate.ts)。
  if (requiredRole(method, pathname) === "admin" && auth.role !== "admin") {
    return adminOnly();
  }
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
  // 設定画面のプロンプトのプレビュー(Issue #396)。設定の入口(上)の隣の別の path。純関数の組み立てだけ(D1・DO・R2・netkeiba・LLM に触れない)。管理者専用(route-policy.ts の表)。
  if (method === "POST" && new URL(request.url).pathname === "/api/settings/prompt-preview") {
    return handlePromptPreview(request);
  }
  // 手動起動の入口(Issue #180)。**POST を受けるのは、`/api/settings`・`/api/settings/prompt-preview`(Issue #396)・`/api/analyses/run`・`/api/analyses/run/bulk`・`/api/results/import`・`/api/reports/run`・`/api/monthly-reports/run` の 7 本だけ**(`run/bulk` は Issue #251、下の 3 本は Issue #208・#235・#280。`/api/migration/upload` は Issue #394 で廃止)。認証(上)の後で、Origin の確認・入力の検証を行う。
  if (method === "POST" && new URL(request.url).pathname === "/api/analyses/run") {
    return handleRun(request, env);
  }
  // 一括の手動起動(Issue #251)。競馬場ごとに、事前分析か発走前の分析をまとめて予約する。管理者専用(route-policy.ts の表。LLM を呼ぶ)。単独の run と同じ守り(Origin → 415 → 413 → 400)を通る。
  if (method === "POST" && new URL(request.url).pathname === "/api/analyses/run/bulk") {
    return handleRunBulk(request, env);
  }
  // 手動の結果の取り込み(Issue #208)。窓（cron の過去 7 日）より古いぶんの取り込み用。POST の入口は全部で 7 本(上の 4 つ〈`/api/settings`・`/api/settings/prompt-preview`・`/api/analyses/run`・`/api/analyses/run/bulk`〉・ここ・下の `/api/reports/run`〈Issue #235〉・`/api/monthly-reports/run`〈Issue #280〉)。
  if (method === "POST" && new URL(request.url).pathname === "/api/results/import") {
    return handleResultsImport(request, env, deps.now ?? (() => new Date()), log);
  }
  // 日報の手動の作成(Issue #235)。**POST を受けるのは、ここを含めて 7 つだけ**(`/api/settings`・`/api/settings/prompt-preview`・`/api/analyses/run`・`/api/analyses/run/bulk`・`/api/results/import`・`/api/reports/run`・`/api/monthly-reports/run`)。
  if (method === "POST" && new URL(request.url).pathname === "/api/reports/run") {
    return handleReportRun(request, env, deps.now ?? (() => new Date()));
  }
  // 月報の手動の作成と作り直し(Issue #280)。管理者専用(route-policy.ts の表)。
  if (method === "POST" && new URL(request.url).pathname === "/api/monthly-reports/run") {
    return handleMonthlyRun(request, env, deps.now ?? (() => new Date()));
  }
  if (method !== "GET" && method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (pathname === "/") {
    // スマホ画面(Issue #184)。スクリプトは /app.js の 1 本だけ(インラインなし)。
    return new Response(method === "HEAD" ? null : renderPage(auth.email, auth.role), {
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

  // アイコン(Issue #244。タブの favicon・見出しの画像・apple-touch-icon)。認証の関門・役割の関門(閲覧者にも GET・HEAD を開く。route-policy.ts)の後ろで、Worker の中から配る。
  // 変わらない画像なので `no-store` ではなく private・1 日のキャッシュ(ほかの応答の SECURITY_HEADERS は引き継ぎ、cache-control だけ上書きする)。
  const icon = iconAsset(pathname);
  if (icon !== undefined) {
    return new Response(method === "HEAD" ? null : icon.bytes, {
      status: 200,
      headers: { ...SECURITY_HEADERS, "cache-control": ICON_CACHE_CONTROL, "content-type": icon.contentType },
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
    return handleCheck(request, env);
  }

  if (pathname === "/api/reports/run") {
    // POST だけ(上で処理済み)。GET・HEAD などは 405。
    return new Response("method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (pathname === "/api/reports" || pathname.startsWith(REPORTS_PREFIX)) {
    // 読み取り専用(D1 の daily_reports を読むだけ。netkeiba にも LLM にも出ない)。GET だけ(HEAD で D1 を引かない)。Issue #235。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return pathname === "/api/reports" ? handleReportList(new URL(request.url), env) : handleReportDetail(new URL(request.url), pathname.slice(REPORTS_PREFIX.length), env, auth.role);
  }

  if (pathname === "/api/monthly-reports/run") {
    // POST だけ(上で処理済み)。GET・HEAD などは 405(月の本文 `/api/monthly-reports/{YYYYMM}` として扱わない)。
    return new Response("method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (pathname === "/api/monthly-reports" || pathname.startsWith(MONTHLY_REPORTS_PREFIX)) {
    // 読み取り専用(D1 の monthly_reports を読むだけ。管理者の詳細だけ、月報の DO の進行状況〈getStatus〉も読む。netkeiba にも LLM にも出ない)。GET だけ(HEAD で D1 を引かない)。Issue #279・#280。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return pathname === "/api/monthly-reports" ? handleMonthlyList(new URL(request.url), env) : handleMonthlyDetail(new URL(request.url), pathname.slice(MONTHLY_REPORTS_PREFIX.length), env, auth.role);
  }

  if (pathname === "/api/verify") {
    // 読み取り専用(検証の DO の集計を読むだけ。netkeiba にも LLM にも出ない。Worker は D1・R2 に触れない)。GET だけ(HEAD で DO を開かない)。Issue #219。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleVerify(request, env, auth.role);
  }

  if (pathname === "/api/export/prior-dataset") {
    // 管理者専用(route-policy.ts)。DO の状態を読むか作成を始め、完成していれば R2 のファイルを返すだけ(Worker は D1 に触れない)。GET だけ(HEAD で DO を開かない)。Issue #266。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handlePriorExport(request, env);
  }

  if (pathname === "/api/horse-runs") {
    // 管理者専用(route-policy.ts)。D1 の horse_runs・horse_run_saves を読むだけ(netkeiba にも LLM にも出ない)。GET だけ。Issue #256 段階A。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleHorseRuns(request, env, deps.now ?? (() => new Date()));
  }

  if (pathname === "/api/baba-fetch") {
    // 管理者専用(route-policy.ts)。D1 の baba_fetches・baba_conditions を読むだけ(外部の API にも netkeiba にも LLM にも出ない)。GET だけ。Issue #360。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleBabaFetch(request, env);
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

  if (pathname === "/api/targets") {
    // 読み取り専用(D1 の集計と DO の計画の読み取りだけ。R2・netkeiba・LLM・Webhook には触れない)。GET だけ(HEAD で D1・DO を引かない)。Issue #336。
    if (method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...SECURITY_HEADERS, allow: "GET", "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handleTargets(request, env, (deps.now ?? (() => new Date()))());
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

  if (pathname === "/api/analyses/run" || pathname === "/api/analyses/run/bulk") {
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
  const detailMatch = ANALYSIS_DETAIL_PATTERN.exec(pathname);
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

const HORSE_RUNS_PARAMS = new Set(["days", "cells"]);

/**
 * `GET /api/horse-runs[?days=N][&cells=1]`(Issue #256 段階A。管理者専用): 各馬の戦績の蓄積(D1 の `horse_runs`・`horse_run_saves`)の状態。
 * 2〜4 週後に、取得を減らす段階 D・騎手 × コースの集計の段階 E に進むかを判断する材料(表の行数・馬の数・開催区分別・保存の集計〈新規/重複/不一致/初見の馬/新規行の取り込み済み割合〉)。
 *  - `days`(1〜{@link STATUS_DAYS_MAX}。既定 {@link STATUS_DAYS_DEFAULT}): 保存の集計を読む期間。
 *  - `cells=1`: 中央の走を 騎手 × 競馬場 × 芝ダ × 距離帯のセルに分けた走数の分布(段階 E の判断材料。horse_runs の全件走査なので、付けたときだけ)。
 * 読み取り専用。順序は: `Sec-Fetch-Site`(別サイトからなら 403。全件走査を外から起こされないため)→ 入力の検証(400。ここまでで D1 に触れない)→ D1(失敗は 503 の固定の種類名だけ)。
 */
async function handleHorseRuns(request: Request, env: Env, now: () => Date): Promise<Response> {
  const crossSite = crossSiteRejection(request);
  if (crossSite !== null) {
    return crossSite;
  }
  const url = new URL(request.url);
  if (hasInvalidQueryKeys(url, HORSE_RUNS_PARAMS)) {
    return badRequest("クエリは days(1〜60 の整数)と cells(1 または 0)だけを、それぞれ1つまで指定できます");
  }
  const daysText = url.searchParams.get("days");
  const days = daysText === null ? STATUS_DAYS_DEFAULT : /^[0-9]{1,3}$/.test(daysText) ? Number(daysText) : Number.NaN;
  if (!(days >= 1 && days <= STATUS_DAYS_MAX)) {
    return badRequest(`days は 1 から ${STATUS_DAYS_MAX} の整数で指定してください`);
  }
  const cellsText = url.searchParams.get("cells");
  if (cellsText !== null && cellsText !== "0" && cellsText !== "1") {
    return badRequest("cells は 1 または 0 で指定してください");
  }
  try {
    const status = await readHorseRunsStatus(env.DB, { sinceMs: now().getTime() - days * 86_400_000, days, cells: cellsText === "1" });
    return json({ ok: true, ...status });
  } catch {
    return json({ ok: false, error: { type: "horse-runs-error" } }, 503);
  }
}

/**
 * `GET /api/baba-fetch[?kaisai_date=YYYYMMDD]`(Issue #360。管理者専用): 外部の馬場の API の取得の結果(D1 の `baba_fetches`・`baba_conditions`)。
 * 開催日ごとに、結果の分類・取得の時刻・保存した競馬場の数と中身・捨てた競馬場の理由と計測日時の文字列(`dropped`。旧版の記録は null)を返す。
 * 「当日の値がまだ載っていなかった」のか「計測日時が読めなかった」のかを、D1 のコンソールを開かずに確かめるための入口。
 * `kaisai_date` を省くと直近 {@link FETCH_LIST_LIMIT_DEFAULT} 日ぶん(新しい順)、指定するとその日だけ。
 * **外部の API の URL・応答の本文・元の JSON は、保存もしておらず、応答にも出ない**(応答は明示の許可リストで作る)。
 * 閲覧者には開かない(route-policy.ts の表に管理者専用として載せる): 外部の API の利用の記録(利用の条件は 1 日 1 回)は運用の情報で、`/api/health` などと同じ扱い。
 * 読み取り専用。順序は: `Sec-Fetch-Site`(別サイトからなら 403)→ 入力の検証(400。ここまでで D1 に触れない)→ D1(失敗は 503 の固定の種類名だけ)。
 */
async function handleBabaFetch(request: Request, env: Env): Promise<Response> {
  const crossSite = crossSiteRejection(request);
  if (crossSite !== null) {
    return crossSite;
  }
  const url = new URL(request.url);
  if (hasInvalidQueryKeys(url, KAISAI_DATE_PARAMS)) {
    return badRequest("クエリは kaisai_date だけを1つ指定できます");
  }
  const kaisaiDate = url.searchParams.get("kaisai_date");
  if (kaisaiDate !== null) {
    // 検証のメッセージに入力を写すので、長い入力は先頭だけにする(切っても、無効なままであることは変わらない)。
    const dateCheck = checkKaisaiDate(kaisaiDate.slice(0, 32));
    if (!dateCheck.ok) {
      return badRequest(dateCheck.message);
    }
  }
  try {
    const fetches = await new D1BabaStore({ db: env.DB }).loadFetches({ ...(kaisaiDate === null ? {} : { kaisaiDate }), limit: FETCH_LIST_LIMIT_DEFAULT });
    return json({
      ok: true,
      kaisai_date: kaisaiDate,
      limit: FETCH_LIST_LIMIT_DEFAULT,
      fetches: fetches.map((f) => ({
        kaisai_date: f.kaisaiDate,
        attempted_at: f.attemptedAt,
        finished_at: f.finishedAt,
        result: f.result,
        api_fetched_at: f.apiFetchedAt,
        venues_saved: f.venuesSaved,
        venues_dropped: f.venuesDropped,
        dropped: f.dropped === null ? null : f.dropped.map((d) => ({ venue: d.venue, reason: d.reason, measured: d.measured })),
        saved: f.saved.map((v) => ({ venue_code: v.venueCode, venue_name: v.venueName, measured_at: v.measuredAt })),
      })),
    });
  } catch {
    // 例外の文面・SQL は返さない。
    return json({ ok: false, error: { type: "baba-fetch-error" } }, 503);
  }
}

/** 統計モデル用の書き出しの URL(route-policy.ts と同じ値)。 */
const PRIOR_EXPORT_PATH = "/api/export/prior-dataset";

const VERIFY_PARAMS = new Set(["venue", "refresh"]);
const VERIFY_VENUES = new Set(["all", "central", "nar"]);

/**
 * **閲覧者にも開く(Issue #263。route-policy.ts)が、閲覧者の要求は集計のやり直しを起こさない**: 管理者(`role === "admin"`)だけが DO の `getReport`(キャッシュ・費用の柵つきで再計算しうる。`refresh` を受け付ける)に届き、
 * それ以外は `getViewerReport`(キャッシュを読むだけ。D1・R2・柵の記録に触れず、管理者向けの診断・追加指示の全文を落とす)に届く。閲覧者の `refresh` は(値の検証は通したうえで)**無視する**(400 にも 403 にもしない。画面が壊れない)。
 * 役割は認証の結果(`auth.role`。管理者でない・判定できないときは閲覧者に倒れる)だけで決める。クエリでは名乗れない。
 *
 * `GET /api/verify?venue=all|central|nar[&refresh=1]`(Issue #219〈#219 web の検証画面(1)〉): 検証の集計(累積回収率・配分ベースの回収率ほか。core の `computeVerifyReport`)。
 * 集計は DO(`VerifyReportDO`)がキャッシュ付きで行い、Worker は呼ぶだけ(Workers Free の CPU は 10ms。D1・R2 に触れない)。応答の `status`: `ready`(集計。`stale` なら古い)・
 * `preparing`(発走時刻の補完中)・`throttled`(再計算の柵〈最短間隔・1 日の上限〉に当たっていて、出せる集計が無い。`reason` で区別する〈Issue #254〉)。`refresh=1` は再計算の要求(DO の最短間隔・1 日の上限は守られる)。
 * **別サイトからの要求は 403**(`Sec-Fetch-Site`。D1 を数万行読む再計算を外から起こされないため)。入力の検証が先(400。DO は呼ばない)。DO の失敗・binding なしは 503(固定の種類名)。
 */
async function handleVerify(request: Request, env: Env, role: "admin" | "viewer"): Promise<Response> {
  const crossSite = crossSiteRejection(request);
  if (crossSite !== null) {
    return crossSite;
  }
  const url = new URL(request.url);
  if (hasInvalidQueryKeys(url, VERIFY_PARAMS)) {
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
    const stub = namespace.get(namespace.idFromName(VERIFY_NAME));
    const response =
      role === "admin"
        ? await stub.getReport(venue as "all" | "central" | "nar", { refresh: refreshValue === "1" })
        : await stub.getViewerReport(venue as "all" | "central" | "nar"); // 閲覧者: refresh は渡さない(渡せない)
    return json({ ok: true, ...response });
  } catch {
    return json({ ok: false, error: { type: "verify-error" } }, 503);
  }
}

const PRIOR_EXPORT_PARAMS = new Set(["refresh", "status"]);
/** 作成中の応答の Refresh ヘッダ(秒)。遷移先は**クエリなし**の URL(`?refresh=1` を自動で再読み込みさせて、作成を何度も始めない)。 */
const PRIOR_EXPORT_REFRESH_SECONDS = 5;

/**
 * `GET /api/export/prior-dataset[?refresh=1|?status=1]`(Issue #266。管理者専用): 統計モデルの見直し用に、本番の分析と結果を馬ごとに書き出したファイル(NDJSON を gzip)を返す。
 * 作成は DO(`PriorExportDO`)がアラームで少しずつ行い(Worker Free の CPU 10ms と、R2 の詳細 1,300 件超の読みのため)、Worker はその状態を読むか作成を頼むだけ。
 *  - 通常の GET: 完成したファイルがあれば本体をそのまま返す(200・attachment)。無ければ作成を始めて 202。**作成中は古いファイルを返さず 202**。
 *  - `?refresh=1`: 作り直しを始める(作成中なら二重に始めず 202。1 日 3 回まで〈超えると 429〉)。ファイルは返さない。
 *  - `?status=1`: 状態の JSON だけ(副作用なし)。
 * 202 の `Refresh` ヘッダは、`?refresh=1` を含まない URL へ 5 秒後に遷移させる(完成するとダウンロードになる)。
 * 別サイトからの要求は 403(`Sec-Fetch-Site`。アドレスバーからは `none`)。入力の検証が先(400。DO は呼ばない)。失敗は固定の種類名だけ(例外の文面は返さない)。
 */
async function handlePriorExport(request: Request, env: Env): Promise<Response> {
  const crossSite = crossSiteRejection(request);
  if (crossSite !== null) {
    return crossSite;
  }
  const url = new URL(request.url);
  if (hasInvalidQueryKeys(url, PRIOR_EXPORT_PARAMS)) {
    return badRequest("クエリは refresh(1 または 0)と status(1 または 0)だけを、それぞれ1つまで指定できます");
  }
  const refreshValue = url.searchParams.get("refresh");
  const statusValue = url.searchParams.get("status");
  if ((refreshValue !== null && refreshValue !== "0" && refreshValue !== "1") || (statusValue !== null && statusValue !== "0" && statusValue !== "1")) {
    return badRequest("refresh・status は 1 または 0 で指定してください");
  }
  if (refreshValue === "1" && statusValue === "1") {
    return badRequest("refresh と status は同時に指定できません");
  }
  const mode: ExportMode = statusValue === "1" ? "status" : refreshValue === "1" ? "refresh" : "download";
  let response: ExportResponse;
  try {
    const namespace = env.PRIOR_EXPORT;
    if (namespace === undefined) {
      throw new Error("PRIOR_EXPORT binding がありません");
    }
    response = await namespace.get(namespace.idFromName(PRIOR_EXPORT_NAME)).request(mode);
  } catch {
    return json({ ok: false, error: { type: "export-error" } }, 503);
  }
  if (mode === "status") {
    return json({ ok: true, ...response });
  }
  switch (response.status) {
    case "ready": {
      if (mode !== "download") {
        return json({ ok: true, ...response });
      }
      const object = await env.ANALYSIS_DETAIL.get(PRIOR_EXPORT_KEY).catch(() => null);
      if (object === null) {
        return json({ ok: false, error: { type: "export-missing" } }, 503);
      }
      return new Response(object.body, {
        status: 200,
        headers: {
          ...SECURITY_HEADERS,
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${exportFilename(response.file.generatedAt)}"`,
          "content-length": String(object.size),
        },
      });
    }
    case "building":
      return new Response(JSON.stringify({ ok: true, ...response }), {
        status: 202,
        headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", refresh: `${PRIOR_EXPORT_REFRESH_SECONDS}; url=${PRIOR_EXPORT_PATH}` },
      });
    case "throttled":
      return json({ ok: false, error: { type: "export-throttled" }, nextAt: response.nextAt, file: response.file }, 429);
    case "blocked":
      return json({ ok: false, error: { type: "export-blocked", reason: response.reason }, file: response.file }, 503);
    case "failed":
      return json({ ok: false, error: { type: "export-failed", reason: response.reason }, file: response.file }, 503);
    case "empty":
      return json({ ok: true, ...response });
  }
}

const ANALYSES_PARAMS = new Set(["race_id", "kaisai_date", "limit"]);

/**
 * `GET /api/analyses?race_id=&kaisai_date=&limit=`: 分析の要約の一覧(新しい順。Issue #175)。パラメータはすべて任意で、
 * 未知のパラメータ・重複・不正な値は 400(D1 に触れない)。limit は 1〜{@link LIST_MAX_LIMIT} の整数(既定 {@link LIST_DEFAULT_LIMIT})。
 */
async function handleAnalyses(url: URL, env: Env): Promise<Response> {
  if (hasInvalidQueryKeys(url, ANALYSES_PARAMS)) {
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
 * 締切の直前の再計算の結果(`close`。Issue #338)の読み出しは別: 失敗(表が無い間を含む)は close だけ null の 200。
 */
async function handleAnalysisDetail(url: URL, idText: string, env: Env): Promise<Response> {
  if (hasInvalidQueryKeys(url, NO_PARAMS)) {
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
    // 締切の直前の再計算の結果(Issue #338)。表が無い間(migration の適用前に Worker が先に出た場合)や読み出しの失敗は、close だけ null にする
    // (配分と違い、無くても「買い目なし」と誤読されない。分析時の提案と詳細の応答は壊さない)。例外の文面は出さない。
    let close: Awaited<ReturnType<typeof store.getStoredClose>> | undefined;
    try {
      close = await store.getStoredClose(id);
    } catch {
      close = undefined;
    }
    return json({ ok: true, analysis: buildAnalysisView(result, allocation, close) });
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
  const crossSite = crossSiteRejection(request);
  if (crossSite !== null) {
    return crossSite;
  }
  const url = new URL(request.url);
  if (hasInvalidQueryKeys(url, RACES_PARAMS)) {
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

/**
 * 閲覧者にも見える自由文(DO が保存したタスクの失敗の文面・会場の失敗の理由)を返すときの唯一の窓口(Issue #245)。
 * **`sk-ant-` で始まる鍵の形を伏せてから**、{@link STATUS_ERROR_MAX} 文字に切る。順序は安全性を分けない(鍵は `sk-ant-` が先頭にあるので、200 文字目で鍵が途中で切れても、残った前半が伏せ字の対象になり、鍵の本体は出ない。
 * 切ってから伏せる順でも結果は安全で、末尾の見た目が少し違うだけ。Issue #255 で、順序を理由にした以前の説明を訂正した)。
 * 保存の時点でも伏せているが、保存済みの過去の値も守るため、**応答の時点で必ず通す**。自由文を返す口を足すときはここを通す。
 */
function safeText(text: string): string {
  return redactSecrets(text).slice(0, STATUS_ERROR_MAX);
}

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
    return { ok: false, response: originMismatch() };
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
 * **netkeiba への取得の起点は、認証の後ろの手動の操作だけ**(この POST の予約・一括の予約〈`POST /api/analyses/run/bulk`。Issue #251。`handleRunBulk` の `scheduleMany` 1 箇所〉・`GET /api/races` の一覧・`GET /api/netkeiba/check`。ほかに、定時の起点が cron の `scheduled`〈scheduled.ts の `requestPlan` 1 つ。Issue #206〉。手動 4 + 定時 1 の計 5 つ。さらに結果の取り込みの依頼〈Issue #208。`dispatchResultImports`〈result-dispatch.ts〉の `requestResultImport` 1 箇所。cron と `POST /api/results/import` が共有〉で、呼び出し箇所は計 6 つ。呼び出し箇所の数は `cloud-config-guard.test.ts` が固定)。
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

/** 一括の手動起動の本文のキー(Issue #251)。単独の run のキー(race_id・mode の省略)とは混ぜない。 */
const BULK_KEYS = new Set(["kaisai_date", "mode", "race_ids"]);

/**
 * 一括の入力の検証(DO を呼ぶ前)。成功なら、検証して正規化した開催日・mode・レース ID(入力の順)。失敗は 400 の応答。
 * 件数は 1〜{@link MAX_BULK_RACES}、重複なし、各 ID は単独の run と同じ検証(`validateRaceId`・`checkRaceDate`)。`mode` は必須(課金を伴うので、既定の種類を持たない)。
 */
function parseBulkBody(record: Record<string, unknown>): { readonly ok: true; readonly kaisaiDate: string; readonly mode: "morning" | "pre_race"; readonly raceIds: string[] } | { readonly ok: false; readonly response: Response } {
  const fail = (message: string): { readonly ok: false; readonly response: Response } => ({ ok: false, response: badRequest(message) });
  if (Object.keys(record).some((k) => !BULK_KEYS.has(k))) {
    return fail("本文のキーは kaisai_date・mode・race_ids だけです");
  }
  const kaisaiDate = record["kaisai_date"];
  const mode = record["mode"];
  const rawIds = record["race_ids"];
  if (typeof kaisaiDate !== "string") {
    return fail("kaisai_date は文字列で指定してください");
  }
  if (mode !== "morning" && mode !== "pre_race") {
    return fail('mode は "morning"(事前分析)か "pre_race"(発走前の分析。LLM を使う)で指定してください');
  }
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > MAX_BULK_RACES || rawIds.some((id) => typeof id !== "string")) {
    return fail(`race_ids は文字列の配列で、1〜${MAX_BULK_RACES} 件にしてください`);
  }
  const raceIds: string[] = [];
  for (const raw of rawIds as string[]) {
    // 検証のメッセージに入力を写すので、長い入力は先頭だけにする(切っても、無効なままであることは変わらない)。
    const checkedRace = validateRaceId(raw.slice(0, 32));
    if (!checkedRace.ok) {
      return fail(checkedRace.message);
    }
    const consistent = checkRaceDate(checkedRace.raceId, kaisaiDate.slice(0, 32));
    if (!consistent.ok) {
      return fail(consistent.message);
    }
    raceIds.push(checkedRace.raceId);
  }
  if (new Set(raceIds).size !== raceIds.length) {
    return fail("race_ids に重複があります");
  }
  return { ok: true, kaisaiDate, mode, raceIds };
}

/**
 * `POST /api/analyses/run/bulk`(Issue #251): 同じ開催日の複数のレース(画面では 1 つの競馬場のレース)に、事前分析(`morning`)または発走前の分析(`pre_race`。LLM を使う)をまとめて予約する。**管理者専用**。
 * 本文は JSON `{ kaisai_date, mode, race_ids }`(3 つとも必須)。日単位の DO の `scheduleMany` を **1 回** 呼ぶ(予約だけをして戻る。取得はアラームの中で 1 レースずつ直列。gate には触れない)。
 * 応答: **202** `{ ok, accepted, kaisai_date, mode, results: [{ race_id, result: "accepted" } | { race_id, result: "already-running", status }] }`(実行中のレースは積まない。レースごとの結果を返す)。
 * **409 `day-cap`**: 1 日の上限(新しい行の数)を超えるので、**何も積んでいない**(全か無か。`limit`・`used`・`needed` を返す)。DO の失敗・想定外の形は 503(文面は返さない)。
 * 順序: 守り(`readJsonObjectBody`。Origin 403 → Content-Type 415 → 本文の大きさ 413〈{@link BULK_BODY_MAX_BYTES}〉→ JSON のオブジェクト 400)→ 入力の検証(400。ここまでで DO は呼ばない)→ DO。
 * netkeiba への取得の起点は増えない(予約が取得を起こすのは、単独の run と同じ DO のアラームの中)。呼び出し箇所の数は `cloud-config-guard.test.ts` が固定。
 */
async function handleRunBulk(request: Request, env: Env): Promise<Response> {
  const guarded = await readJsonObjectBody(request, BULK_BODY_MAX_BYTES);
  if (!guarded.ok) {
    return guarded.response;
  }
  const parsed = parseBulkBody(guarded.body);
  if (!parsed.ok) {
    return parsed.response;
  }
  const { kaisaiDate, mode, raceIds } = parsed;
  try {
    const result = await raceDayStub(env, kaisaiDate).scheduleMany({ kaisaiDate, mode, raceIds });
    if (!result.accepted) {
      if (result.reason === "day-cap" && Number.isInteger(result.limit) && Number.isInteger(result.used) && Number.isInteger(result.needed)) {
        return json({ ok: false, error: { type: "day-cap", limit: result.limit, used: result.used, needed: result.needed } }, 409);
      }
      return raceDayError();
    }
    // 応答の形を信用しない: 入力と同じ件数・同じ順序で、固定の語だけを写す。
    const entries = Array.isArray(result.results) ? result.results : [];
    if (entries.length !== raceIds.length) {
      return raceDayError();
    }
    const results: { race_id: string; result: "accepted" | "already-running"; status?: "queued" | "fetched" }[] = [];
    for (let i = 0; i < raceIds.length; i++) {
      const entry = entries[i];
      if (entry === undefined || entry.raceId !== raceIds[i]) {
        return raceDayError();
      }
      if (entry.result === "accepted") {
        results.push({ race_id: entry.raceId, result: "accepted" });
      } else if (entry.result === "already-running" && (entry.status === "queued" || entry.status === "fetched")) {
        results.push({ race_id: entry.raceId, result: "already-running", status: entry.status });
      } else {
        return raceDayError();
      }
    }
    return json({ ok: true, accepted: true, kaisai_date: kaisaiDate, mode, results }, 202);
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
 * 成功は 200 で、保存した設定を返す(`{ ok: true, settings }`)。400 の本文は固定の message と、欠けた・範囲外の**既知の項目名**(`fields`。入力の値・未知のキー名は写さない)。項目の過不足(欠け・未知)があるときは `reason: "keys-mismatch"` も付く(Issue #375。古い画面の案内用)。
 */
async function handleSettingsSave(request: Request, env: Env, now: () => Date): Promise<Response> {
  const guarded = await readJsonObjectBody(request, SETTINGS_BODY_MAX_BYTES);
  if (!guarded.ok) {
    return guarded.response;
  }
  const checked = validateCloudSettingsForSave(guarded.body);
  if (!checked.ok) {
    // `reason: "keys-mismatch"`(Issue #375): 項目の過不足(欠け・未知)があるとき。画面を開いたままデプロイをまたいだ古い画面が送る形で、クライアントは再読み込みを案内する。範囲外の値だけなら付けない。
    const reason = hasSettingsKeysMismatch(guarded.body) ? { reason: "keys-mismatch" } : {};
    return json({ ok: false, error: { type: "bad-request", message: "設定の項目が足りない・未知の項目がある・範囲外の値があります", fields: checked.fields, ...reason } }, 400);
  }
  try {
    await saveSettings(env.DB, checked.settings, now().toISOString());
    return json({ ok: true, settings: checked.settings });
  } catch {
    // 例外の文面・SQL は返さない。
    return json({ ok: false, error: { type: "d1-error" } }, 503);
  }
}

/** プロンプトのプレビューの POST の本文の上限(バイト)。設定の保存と同じ(追加指示 2,000 単位が JSON のエスケープで最大 12,000 バイトになっても収まる)。 */
const PROMPT_PREVIEW_BODY_MAX_BYTES = 16 * 1024;

/**
 * `POST /api/settings/prompt-preview`(Issue #396): 設定画面の「LLM へ送るプロンプトのプレビュー」の文面を組み立てて返す(管理者専用。route-policy.ts の表)。
 * 本文は JSON `{ additionalInstruction: string, clipVariant: string }` の 2 キーだけ(欠け・型違い・余計なキーは 400)。未知の `clipVariant` は 400 にせず、送信と同じく対照(default)に解決する。
 * 成功は 200 で `{ ok: true, text, clamped, promptVersion }`(`buildPreviewText`。追加指示は 2,000 UTF-16 単位に切る)。
 * 順序: 守り(`readJsonObjectBody`。Origin 403 → Content-Type 415 → 本文の大きさ 413〈16 KiB〉→ JSON のオブジェクト 400)→ 入力の検証(400)→ 組み立て。
 * **D1・DO・R2・env のどれにも触れない**(引数に env を取らない)。入力の値・文面を 400 の本文に写さない。
 */
async function handlePromptPreview(request: Request): Promise<Response> {
  const guarded = await readJsonObjectBody(request, PROMPT_PREVIEW_BODY_MAX_BYTES);
  if (!guarded.ok) {
    return guarded.response;
  }
  const keys = Object.keys(guarded.body);
  const { additionalInstruction, clipVariant } = guarded.body;
  if (keys.length !== 2 || typeof additionalInstruction !== "string" || typeof clipVariant !== "string") {
    return badRequest("本文は additionalInstruction(文字列)と clipVariant(文字列)の 2 項目だけにしてください");
  }
  const preview = buildPreviewText({ additionalInstruction, clipVariant });
  return json({ ok: true, text: preview.text, clamped: preview.clamped, promptVersion: preview.promptVersion });
}

/**
 * `GET /api/analyses/status?kaisai_date=YYYYMMDD[&race_id=...]`(Issue #180): 日単位の DO の状態。各レースの状態・試行回数・エラー(200 文字まで)・朝の prior の有無。
 * `race_id` を指定すると、そのレースの朝の prior の最小限(レース名・場名・日付・馬番・馬名・prior を高い順に)を `prior` で返す(無ければ null)。
 * パラメータは kaisai_date(必須)と race_id(任意)を、それぞれ1つまで。不正なら 400(DO を呼ばない)。
 */
async function handleStatus(url: URL, env: Env): Promise<Response> {
  if (hasInvalidQueryKeys(url, STATUS_PARAMS)) {
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
      error: r.error === null ? null : safeText(r.error),
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

/** 自由文(会場の失敗の理由・自動実行の失敗の文面)を返すとき。`/api/analyses/status` の `error` と同じ窓口 {@link safeText}(鍵の形を伏せてから 200 文字に切る)を通す。 */
const clipText = (text: string | null): string | null => (text === null ? null : safeText(text));

/**
 * `GET /api/plan?kaisai_date=YYYYMMDD`(Issue #206〈#166-E〉G-E3): 定時の自動実行を外から観測する、読み取り専用の入口。
 * 日単位の DO(RaceDay)の `getPlanProgress`(事前分析の計画)・`getAutoRunResults`(各レースの結果)・`getNotifications`(通知の一覧)・`getResultImportProgress`(結果の取り込みの状態。Issue #208)を読んで返す。
 * **netkeiba にも LLM にも D1・R2 にも出ない。状態も変えない**(この関数は `.schedule(`・`.requestPlan(`・`.getRaceList(`・gate を呼ばない。`cloud-config-guard.test.ts` が固定)。
 * 理由: 対象が 0 件の日は通知が何も出ないので、自動実行が動いたのか壊れているのかを、外から確かめる手段が要る。
 * 順序: `Sec-Fetch-Site`(別サイトなら 403。開催日を変えて DO を作らせる cross-site の GET を拒否)→ クエリの検証(400。ここまでで DO は呼ばない)→ DO(失敗は 503・文面なし)。
 * 応答は**明示のホワイトリスト**で作る(DO の返り値を展開しない)。通知の Webhook の URL は DO の通知の仕組みの中にだけあり、この応答にもこの関数にも現れない
 * (この関数は `env.DISCORD_WEBHOOK_URL` を読まない)。自由文は鍵の形を伏せてから 200 文字に切る({@link safeText}。Issue #245)。
 */
async function handlePlan(request: Request, env: Env): Promise<Response> {
  const crossSite = crossSiteRejection(request);
  if (crossSite !== null) {
    return crossSite;
  }
  const url = new URL(request.url);
  if (hasInvalidQueryKeys(url, KAISAI_DATE_PARAMS)) {
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

/**
 * `GET /api/targets?kaisai_date=YYYYMMDD`(Issue #336): 「今日の狙い目」。その日の各レースの**最新の分析**から、配分の提案(買い目の点数・合計・最大 EV)と◎の馬番を、
 * 発走時刻・場・R つきで返す(整形は `targets-view.ts`。**文言はサーバで組み立てる**)。締切の直前の再計算(Issue #338)の回があれば、ok の回のうち番号が最大のものを優先する。
 *
 * **読み取り専用。D1(集計)と、日単位の DO の読み取り専用の RPC 2 つ(`getPlanProgress`=発走時刻、`getTargetsLedger`=収支。Issue #361)だけを読む**。R2 の詳細は読まない(馬名は出さない。◎は馬番だけ)ので、操作回数の柵を使わない。
 * netkeiba・LLM・Webhook・gate にも触れない(`cloud-config-guard.test.ts` が固定)。閲覧者にも開く(route-policy.ts。`GET /api/analyses/{id}` で配分はすでに見える)。
 * 順序: `Sec-Fetch-Site`(別サイトなら 403。DO の名前は開催日なので、日付を変えて DO を作らせる cross-site の GET を拒否する。`handlePlan` と同じ)→ クエリの検証(400。ここまでで D1・DO は呼ばない)→ D1(失敗は 503・文面なし)→ DO(計画と収支。どちらの失敗も一覧を巻き込まない)。
 * **DO は分析が 1 件でもあるときだけ呼ぶ**(分析の無い日付で DO を作らない)。DO の失敗(計画が無い・読めない)は 503 にせず、発走時刻なしで 200 を返す(場・R は race_id から導ける)。
 * 再計算の表が無い間(migration の適用前に Worker が先に出た場合)は、再計算なし(分析時の提案)で 200(`D1TargetsStore.readDay`)。
 *
 * **収支の途中経過(Issue #361)**: 計算は**日単位の DO の読み取り専用の RPC `getTargetsLedger`** が行い(分析・配分・結果の読み取りと、core の検証と同じ関数での計算。Worker Free の CPU 10ms に収まらないため。検証の集計を DO で行うのと同じ理由)、
 * Worker は返された素のデータを応答の `ledger`・各行の `result` に載せるだけ(Worker は収支のために D1 を読まない)。計画のどのレースも発走していない間、DO は null を返す(読み取りを増やさない)。
 * **失敗は一覧を巻き込まない**: DO の失敗は収支なし(`ledger`・各行の `result` が null)。閲覧者にも同じ内容を返す(ユーザーの決定)。
 */
async function handleTargets(request: Request, env: Env, now: Date): Promise<Response> {
  const crossSite = crossSiteRejection(request);
  if (crossSite !== null) {
    return crossSite;
  }
  const url = new URL(request.url);
  if (hasInvalidQueryKeys(url, KAISAI_DATE_PARAMS)) {
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
  let day;
  try {
    day = await new D1TargetsStore({ db: env.DB }).readDay(kaisaiDate);
  } catch {
    // 例外の文面・SQL は返さない。
    return json({ ok: false, error: { type: "d1-error" } }, 503);
  }
  let plan: TargetsPlanRow[] | null = null;
  let ledger: TargetsLedger | null = null;
  if (day.analyses.length > 0) {
    const stub = raceDayStub(env, kaisaiDate);
    // 計画(発走時刻)と収支の途中経過(Issue #361。計算は DO の RPC)を並べて読む。どちらの失敗も一覧を巻き込まない:
    // 計画の失敗は発走時刻なし、収支の失敗は収支なし(null)。例外の文面は返さない。DO の呼び出しが同期に投げても握る。
    const [planRows, wire] = await Promise.all([
      (async () => (await stub.getPlanProgress()).rows)().then(
        (rows) => rows,
        () => null,
      ),
      (async () => stub.getTargetsLedger({ kaisaiDate, nowMs: now.getTime() }))().then(
        (w) => w,
        () => null,
      ),
    ]);
    plan = planRows === null ? null : planRows.map((r) => ({ raceId: r.raceId, venueName: r.venueName, raceNumber: r.raceNumber, startTime: r.startTime }));
    ledger = wire === null ? null : ledgerFromWire(wire);
  }
  const view = buildTargetsView({ kaisaiDate, nowMs: now.getTime(), analyses: day.analyses, closeRounds: day.closeRounds, plan, ledger });
  return json({ ok: true, ...view });
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

/** 日報・月報の API の失敗(D1・DO の失敗、DO と食い違う理由)の応答。固定の種類名だけ(例外の文面は返さない)。 */
function reportError(): Response {
  return json({ ok: false, error: { type: "report-error" } }, 503);
}

/** {@link readReportJob} の `read` が返す「日報・月報の DO の binding が無い構成」の符号(`undefined` は DO の不正な応答と区別するため使わない)。 */
const NO_REPORT_BINDING: unique symbol = Symbol("no-report-binding");

/**
 * 日報・月報の詳細の進行状況(DO の `getStatus`)の読み取り。固定の形だけを写す(DO から別の値が来ても、そのまま返さない)。`regenerate` は `true` のときだけ付ける(Issue #268・#280)。
 * `read` は DO の取得を行う関数: {@link NO_REPORT_BINDING} を返すと「binding が無い構成」(ジョブが存在しえないので `ok`)、`null` は「ジョブなし」(`ok`)、例外は `unavailable`(ジョブがあるか分からない)。
 * **DO が(型に反して)`undefined` などの読めない値を返したときも `unavailable`**(`status.phase` の読み取りで例外になり、下の catch に入る。binding なしとは符号で区別する)。
 * **誰に読ませるか(役割の扱い)は呼び出し側が決める**(日報と月報で意図的に違う)。
 */
async function readReportJob<S extends ReportStatus | MonthlyStatus>(
  read: () => Promise<S | null | typeof NO_REPORT_BINDING>,
): Promise<{ job: { phase: S["phase"]; status: S["status"]; attempts: number; regenerate?: true } | null; jobStatus: "ok" | "unavailable" }> {
  try {
    const status = await read();
    if (status === NO_REPORT_BINDING || status === null) {
      return { job: null, jobStatus: "ok" };
    }
    return { job: { phase: status.phase, status: status.status, attempts: status.attempts, ...(status.regenerate === true ? { regenerate: true as const } : {}) }, jobStatus: "ok" };
  } catch {
    return { job: null, jobStatus: "unavailable" };
  }
}

/** 手動の作成・作り直しの本文の `regenerate`(boolean だけ。無い・`false` は通常の作成)。型違いは 400。日報の run と月報の run が共有する。 */
function parseRegenerateFlag(record: Record<string, unknown>): { readonly ok: true; readonly regenerate: boolean } | { readonly ok: false; readonly response: Response } {
  const flag = record["regenerate"];
  if (flag !== undefined && typeof flag !== "boolean") {
    return { ok: false, response: badRequest("regenerate は true または false で指定してください") };
  }
  return { ok: true, regenerate: flag === true };
}

/**
 * 日報・月報の DO が依頼を断ったときの応答(固定の型だけ): 作成済み(通常の作成)409 `already-exists`・作成中 409 `in-progress`・無い(作り直し)409 `not-exists`・1 日の回数の上限(作り直し)429 `daily-limit`。
 * 作り直しだけが返す理由が通常の作成に返ってきたとき、検証で弾いたはずの理由(不正・未来・終わっていない)や、あり得ない理由が来たときは、食い違いなので 503。
 */
function reportRunRefusal(reason: string, regenerate: boolean): Response {
  if (reason === "exists" && !regenerate) {
    return json({ ok: false, error: { type: "already-exists" } }, 409);
  }
  if (reason === "in-progress") {
    return json({ ok: false, error: { type: "in-progress" } }, 409);
  }
  if (regenerate && reason === "not-exists") {
    return json({ ok: false, error: { type: "not-exists" } }, 409);
  }
  if (regenerate && reason === "daily-limit") {
    return json({ ok: false, error: { type: "daily-limit" } }, 429);
  }
  return reportError();
}

/** 日報の一覧の件数(画面が最近の日付を並べる数。D1 の本文は読まない)。 */
const REPORT_LIST_LIMIT = 60;

/**
 * `GET /api/reports`(Issue #235): 日報の一覧(開催日の新しい順。本文を含まない)。クエリは受け付けない(400)。D1 の失敗は 503(固定の型だけ。例外の文面は返さない)。
 */
async function handleReportList(url: URL, env: Env): Promise<Response> {
  if (hasInvalidQueryKeys(url, NO_PARAMS)) {
    return badRequest("このパスにクエリは指定できません");
  }
  try {
    const rows = await new D1ReportStore({ db: env.DB }).listReports(REPORT_LIST_LIMIT);
    return json({
      ok: true,
      reports: rows.map((r) => ({ date: r.kaisaiDate, created_at: r.createdAt, model: r.model, race_count: r.raceCount, total_stake: r.totalStake, total_return: r.totalReturn, summary: r.summary })),
    });
  } catch {
    return reportError();
  }
}

/**
 * `GET /api/reports/{YYYYMMDD}`(Issue #235): 1 日の日報(本文つき)。無い日は `report: null` で、日報の DO の進行状況(作成中・失敗)を `job` に付ける
 * (DO が失敗・binding なしでも 200 で `job: null`。画面を壊さない)。開催日の形が違えば 404(D1 を引かない)。クエリは受け付けない(400)。
 *
 * **日報があるとき**(Issue #268): **閲覧者**は DO を呼ばない(`job: null`・`ok`。従来どおり)。**管理者**は日報があっても DO の進行状況を付ける
 * (作り直しの進行・失敗を画面が見るため。`regenerate: true` のジョブだけが意味を持つ)。DO の取得が失敗しても日報は 200 で返し、`job_status` を `unavailable` にする。
 * 役割は認証の結果(`auth.role`)だけで決める(クエリでは名乗れない)。
 *
 * **`job_status`(Issue #245)**: `job: null` の意味を区別する。`"ok"`: 取得できた(日報があるとき・DO が「ジョブなし」と答えたとき・binding が無い構成〈ジョブが存在しえない〉)。
 * `"unavailable"`: 日報が無い日に、日報の DO の取得(RPC)が**失敗した**(ジョブがあるかどうか分からない)。画面は、依頼の直後に `job: null` かつ `ok` のときだけ
 * 「日報は作られずに終わった」と判断し、`unavailable` のときは確認を続ける(従来は失敗も `job: null` で、実行中でも「作られなかった」と出て確認が止まった)。
 */
async function handleReportDetail(url: URL, dateText: string, env: Env, role: "admin" | "viewer"): Promise<Response> {
  if (!/^[0-9]{8}$/.test(dateText) || !checkKaisaiDate(dateText).ok) {
    return json({ ok: false, error: { type: "not-found" } }, 404);
  }
  if (hasInvalidQueryKeys(url, NO_PARAMS)) {
    return badRequest("このパスにクエリは指定できません");
  }
  let report;
  try {
    report = await new D1ReportStore({ db: env.DB }).getReport(dateText);
  } catch {
    return reportError();
  }
  // 進行状況(DO の getStatus。形の写しと失敗の扱いは {@link readReportJob})。
  const readJob = () =>
    readReportJob(async () => {
      const namespace = env.DAILY_REPORT;
      return namespace === undefined ? NO_REPORT_BINDING : namespace.get(namespace.idFromName(DAILY_REPORT_NAME)).getStatus(dateText);
    });
  if (report !== null) {
    const { job, jobStatus } = role === "admin" ? await readJob() : { job: null, jobStatus: "ok" as const };
    return json({
      ok: true,
      report: {
        date: report.kaisaiDate,
        created_at: report.createdAt,
        model: report.model,
        race_count: report.raceCount,
        total_stake: report.totalStake,
        total_return: report.totalReturn,
        summary: report.summary,
        body: report.body,
      },
      job,
      job_status: jobStatus,
    });
  }
  const { job, jobStatus } = await readJob();
  return json({ ok: true, report: null, job, job_status: jobStatus });
}

/** 月報の一覧の件数(画面が並べる数。D1 の本文は読まない)。 */
const MONTHLY_LIST_LIMIT = 36;

/**
 * `GET /api/monthly-reports`(Issue #279): 月報の一覧(月の新しい順。本文を含まない)。クエリは受け付けない(400)。D1 の失敗は 503(固定の型だけ。例外の文面は返さない)。
 */
async function handleMonthlyList(url: URL, env: Env): Promise<Response> {
  if (hasInvalidQueryKeys(url, NO_PARAMS)) {
    return badRequest("このパスにクエリは指定できません");
  }
  try {
    const rows = await new D1MonthlyStore({ db: env.DB }).listReports(MONTHLY_LIST_LIMIT);
    return json({
      ok: true,
      reports: rows.map((r) => ({ month: r.month, created_at: r.createdAt, model: r.model, race_count: r.raceCount, total_stake: r.totalStake, total_return: r.totalReturn, summary: r.summary })),
    });
  } catch {
    return reportError();
  }
}

/**
 * `GET /api/monthly-reports/{YYYYMM}`(Issue #279・#280): 1 か月の月報(本文つき)。無い月は `report: null`(200)。月の形が 6 桁の実在の月でなければ 404(D1 を引かない)。
 * クエリは受け付けない(400)。D1 の失敗は 503。閲覧者にも月報は返す。
 *
 * **進行状況(`job`・`job_status`。Issue #280。日報の #268 と同じ形)**: **管理者だけ**月報の DO の `getStatus` を読む(作り直し・手動の作成の進行・失敗を画面が見るため。`regenerate: true` のジョブだけが
 * 「作り直し」を意味する)。**閲覧者は DO に一切触れない**(`job: null`・`job_status: "ok"`)。役割は認証の結果(`auth.role`)だけで決める(クエリでは名乗れない)。
 * DO の取得が失敗しても月報は 200 で返し、`job_status` を `unavailable` にする(ジョブがあるかどうか分からない。画面は確認を続ける)。binding が無い構成は、ジョブが存在しえないので `ok`。
 */
async function handleMonthlyDetail(url: URL, monthText: string, env: Env, role: "admin" | "viewer"): Promise<Response> {
  if (!isValidMonth(monthText)) {
    return json({ ok: false, error: { type: "not-found" } }, 404);
  }
  if (hasInvalidQueryKeys(url, NO_PARAMS)) {
    return badRequest("このパスにクエリは指定できません");
  }
  let report;
  try {
    report = await new D1MonthlyStore({ db: env.DB }).getReport(monthText);
  } catch {
    return reportError();
  }
  // 進行状況(DO の getStatus。形の写しと失敗の扱いは {@link readReportJob})。
  const readJob = () =>
    readReportJob(async () => {
      const namespace = env.MONTHLY_REPORT;
      return namespace === undefined ? NO_REPORT_BINDING : namespace.get(namespace.idFromName(MONTHLY_REPORT_NAME)).getStatus(monthText);
    });
  const { job, jobStatus } = role === "admin" ? await readJob() : { job: null, jobStatus: "ok" as const };
  return json({
    ok: true,
    report:
      report === null
        ? null
        : {
            month: report.month,
            created_at: report.createdAt,
            model: report.model,
            race_count: report.raceCount,
            total_stake: report.totalStake,
            total_return: report.totalReturn,
            summary: report.summary,
            body: report.body,
          },
    job,
    job_status: jobStatus,
  });
}

const REPORT_RUN_BODY_MAX_BYTES = 1024;
const REPORT_RUN_KEYS = new Set(["date", "regenerate"]);

/**
 * `POST /api/reports/run`(Issue #235): 指定した開催日の日報を、日報の DO に依頼する(202)。本文は JSON `{ date }`(JST の開催日 8 桁。今日以前)。
 * **`regenerate: true` を付けると、日報がある日の作り直し**(Issue #268。DO には `mode: "regenerate"`)。`regenerate` は boolean だけ(型違いは 400)で、無い・`false` は通常の作成(`mode: "manual"`)。
 * 作り直しの断りは固定の型で返す: 作成中 409 `in-progress`・日報が無い 409 `not-exists`・**1 日の回数の上限 429 `daily-limit`**。管理者専用(route-policy.ts の `/api/reports/run`)。
 * 順序: 守り(`readJsonObjectBody`。Origin 403 → Content-Type 415 → 本文の大きさ 413 → JSON のオブジェクト 400)→ 入力の検証(400。ここまでで DO は呼ばない)→ DO。
 * 作成済み・作成中は 409(`already-exists`・`in-progress`)。DO の失敗・binding なしは 503 `report-error`(文面を返さない)。Worker は LLM も netkeiba も呼ばない(作るのは DO のアラーム)。
 */
async function handleReportRun(request: Request, env: Env, now: () => Date): Promise<Response> {
  const guarded = await readJsonObjectBody(request, REPORT_RUN_BODY_MAX_BYTES);
  if (!guarded.ok) {
    return guarded.response;
  }
  const record = guarded.body;
  if (Object.keys(record).some((k) => !REPORT_RUN_KEYS.has(k))) {
    return badRequest("本文のキーは date だけです");
  }
  const date = record["date"];
  if (typeof date !== "string") {
    return badRequest("date は YYYYMMDD の 8 桁の文字列で指定してください");
  }
  const checked = checkKaisaiDate(date.slice(0, 32));
  if (!checked.ok) {
    return badRequest(checked.message);
  }
  const flag = parseRegenerateFlag(record);
  if (!flag.ok) {
    return flag.response;
  }
  const { regenerate } = flag;
  const today = jstKaisaiDate(now().getTime());
  if (date > today) {
    return badRequest(`date は今日(${today})以前にしてください`);
  }
  try {
    const namespace = env.DAILY_REPORT;
    if (namespace === undefined) {
      throw new Error("DAILY_REPORT binding がありません");
    }
    const result = await namespace.get(namespace.idFromName(DAILY_REPORT_NAME)).requestReport({ kaisaiDate: date, mode: regenerate ? "regenerate" : "manual" });
    if (!result.accepted) {
      // 断りの写し(作り直しだけが返す理由、検証で弾いたはずの理由が来たら食い違いで 503)は {@link reportRunRefusal}。
      return reportRunRefusal(result.reason, regenerate);
    }
    return json({ ok: true, accepted: true, date }, 202);
  } catch {
    return reportError();
  }
}

const MONTHLY_RUN_KEYS = new Set(["month", "regenerate"]);

/**
 * `POST /api/monthly-reports/run`(Issue #280): 指定した月の月報を、月報の DO に依頼する(202)。本文は JSON `{ month, regenerate? }`(月は YYYYMM の 6 桁。**終わった月だけ**: 今月・先の月は 400)。
 * **`regenerate: true` を付けると、月報がある月の作り直し**(DO には `mode: "regenerate"`)。`regenerate` は boolean だけ(型違いは 400)で、無い・`false` は通常の作成(`mode: "manual"`)。日報の `POST /api/reports/run` と同じ形。
 * 断りは固定の型で返す: 作成済み(通常の作成)409 `already-exists`・作成中 409 `in-progress`・月報が無い(作り直し)409 `not-exists`・**1 日の回数の上限(作り直し)429 `daily-limit`**。
 * 管理者専用(route-policy.ts の `/api/monthly-reports/run`)。**Discord には送らない**(手動の作成・作り直しの通知は無い。DO の `mode` が決める)。
 * 順序: 守り(`readJsonObjectBody`。Origin 403 → Content-Type 415 → 本文の大きさ 413 → JSON のオブジェクト 400)→ 入力の検証(400。ここまでで DO は呼ばない)→ DO。
 * DO の失敗・binding なし・食い違う理由は 503 `report-error`(文面を返さない)。Worker は LLM も netkeiba も呼ばない(作るのは DO のアラーム)。
 */
async function handleMonthlyRun(request: Request, env: Env, now: () => Date): Promise<Response> {
  const guarded = await readJsonObjectBody(request, REPORT_RUN_BODY_MAX_BYTES);
  if (!guarded.ok) {
    return guarded.response;
  }
  const record = guarded.body;
  if (Object.keys(record).some((k) => !MONTHLY_RUN_KEYS.has(k))) {
    return badRequest("本文のキーは month と regenerate だけです");
  }
  const month = record["month"];
  if (typeof month !== "string" || !isValidMonth(month)) {
    return badRequest("month は YYYYMM の 6 桁の文字列(実在の月)で指定してください");
  }
  const flag = parseRegenerateFlag(record);
  if (!flag.ok) {
    return flag.response;
  }
  const { regenerate } = flag;
  const today = jstKaisaiDate(now().getTime());
  if (monthRange(month).toDate >= today) {
    return badRequest("month は終わった月(今月より前)にしてください。今月の月報は、月の最終日の夜に自動で作られます");
  }
  try {
    const namespace = env.MONTHLY_REPORT;
    if (namespace === undefined) {
      throw new Error("MONTHLY_REPORT binding がありません");
    }
    const result = await namespace.get(namespace.idFromName(MONTHLY_REPORT_NAME)).requestMonthlyReport({ month, mode: regenerate ? "regenerate" : "manual" });
    if (!result.accepted) {
      // 断りの写し(作り直しだけが返す理由、検証で弾いたはずの理由やあり得ない理由が来たら食い違いで 503)は {@link reportRunRefusal}。
      return reportRunRefusal(result.reason, regenerate);
    }
    return json({ ok: true, accepted: true, month }, 202);
  } catch {
    return reportError();
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
 * **別サイトからの要求は 403**(`Sec-Fetch-Site`。Issue #267)。順序は: `Sec-Fetch-Site`(403)→ 入力の検証(400)→ ゲート。ここまでゲート(DO)にも netkeiba にも触れない。
 * 理由: この GET は netkeiba に出る。別サイトのページから(管理者のブラウザで)読み込ませて実在しない race_id を取らせて netkeiba の拒否(400/403/429)が2回連続すると(実測はしていない)ゲートのブレーカーが開き、
 * 30 分間すべての取得が止まる(その間の発走前の取得は失敗で確定する)。メソッドの 405 はこの前(呼び出し側)で済んでいる。
 */
async function handleCheck(request: Request, env: Env): Promise<Response> {
  // ブラウザは Sec-Fetch-Site を付ける(確認フォームの送信は same-origin、アドレスバー・ブックマークは none)。付かない非ブラウザのクライアントは通す。
  const crossSite = crossSiteRejection(request);
  if (crossSite !== null) {
    return crossSite;
  }
  const url = new URL(request.url);
  if (hasInvalidQueryKeys(url, CHECK_PARAMS) || !url.searchParams.has("race_id")) {
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
