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

export interface Env extends AccessEnv {
  NETKEIBA_GATE: GateNamespaceLike;
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
