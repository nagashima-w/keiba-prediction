/**
 * Worker のリクエスト処理の本体(Issue #161〈#21-C〉)。ランタイムに依存しないよう、鍵の取得・時刻・ログは注入できる。
 *
 * **すべてのルートの前に認証を掛ける**(`/api/health` も含む)。認証できなければ、設定の有無・失敗の理由・ルートの
 * 存在を一切含まない 403 を返す。理由コードはログにだけ出す(トークン・メール・チーム名・AUD は出さない)。
 */
import type { AccessEnv } from "./access-jwt";
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
    try {
      const gate = env.NETKEIBA_GATE.get(env.NETKEIBA_GATE.idFromName(GATE_NAME));
      const { sqlite } = await gate.ping();
      return json({ ok: sqlite, durableObject: { sqlite } }, sqlite ? 200 : 503);
    } catch {
      return json({ ok: false, durableObject: { sqlite: false } }, 503);
    }
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

  return json({ ok: false, error: "not found" }, 404);
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
