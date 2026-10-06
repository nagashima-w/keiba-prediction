/**
 * リクエストの認証(Issue #161〈#21-C〉)。JWT の取得元は、ヘッダ → クッキーの順に試し、どちらかが通れば通る。
 * **`ctx.access` を使うのは、ヘッダにもクッキーにも JWT が無いときだけ**(ゲートの確定)。JWT が付いていて不正なら、
 * 改ざんの疑いがあるので `ctx.access` では救わず、拒否する(`ctx.access` は参照もしない)。
 * どの経路でも、許可した1件のメールとの一致(`ctx.access` は aud の一致も)を確かめる。
 * 設定(secret)が欠けていれば、どの取得元が有効でも通さない。
 */
import type { JWTVerifyGetKey } from "jose";
import { extractTokens, normalizeEmail, parseAccessConfig, verifyAccessJwt, type AccessConfig, type AccessEnv } from "./access-jwt";

/** `ctx.access`(Access が認証した呼び出しでだけ存在する)の、使う部分だけの型。 */
export interface AccessContextLike {
  readonly aud: string;
  getIdentity(): Promise<Record<string, unknown> | undefined>;
}

export type AuthVia = "header" | "cookie" | "ctx-access";

export type AuthResult =
  | { readonly ok: true; readonly email: string; readonly via: AuthVia }
  | { readonly ok: false; readonly reason: string };

export interface AuthDeps {
  /** チーム名から鍵の取得関数を作る(本番は access-jwt の remoteKeys。テストでは固定の鍵)。 */
  readonly keys: (teamName: string) => JWTVerifyGetKey;
  readonly now?: Date;
}

async function viaCtxAccess(
  access: AccessContextLike,
  config: AccessConfig,
): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
  if (access.aud !== config.aud) {
    return { ok: false, reason: "aud-mismatch" };
  }
  let identity: Record<string, unknown> | undefined;
  try {
    identity = await access.getIdentity();
  } catch {
    return { ok: false, reason: "identity-error" };
  }
  const email = normalizeEmail(identity?.["email"]);
  if (email === null) {
    return { ok: false, reason: "email-missing" };
  }
  if (email !== config.allowedEmail) {
    return { ok: false, reason: "email-mismatch" };
  }
  return { ok: true, email };
}

export async function authenticate(
  request: Request,
  env: AccessEnv,
  ctx: { readonly access?: AccessContextLike },
  deps: AuthDeps,
): Promise<AuthResult> {
  const parsed = parseAccessConfig(env);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const { config } = parsed;
  const failures: string[] = [];

  const tokens = extractTokens(request);
  for (const { source, token } of tokens) {
    let result;
    try {
      result = await verifyAccessJwt(token, config, deps.keys(config.teamName), deps.now);
    } catch {
      result = { ok: false as const, reason: "keys-unavailable" as const };
    }
    if (result.ok) {
      return { ok: true, email: result.email, via: source };
    }
    failures.push(`${source}:${result.reason}`);
  }

  // JWT が1つでも付いていたら、ここへは進まない(上の失敗で拒否する)。
  const ctxAccess = tokens.length === 0 ? ctx.access : undefined;
  if (ctxAccess !== undefined) {
    const result = await viaCtxAccess(ctxAccess, config);
    if (result.ok) {
      return { ok: true, email: result.email, via: "ctx-access" };
    }
    failures.push(`ctx-access:${result.reason}`);
  }

  return { ok: false, reason: failures.length === 0 ? "no-credentials" : failures.join(",") };
}
