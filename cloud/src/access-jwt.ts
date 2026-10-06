/**
 * Cloudflare Access の JWT の検証(Issue #161〈#21-C〉)。純ロジック(Workers のランタイムに依存しない)。
 *
 * Worker は Access の外側の守りに頼らず、自分でも JWT を検証する(多層防御)。検証するのは
 * 署名(RS256 に固定)・iss・aud・exp・nbf と、**許可したメールアドレス1件との一致**。
 * 設定の欠落・形式の不正・検証の失敗・鍵の取得の失敗は、すべて「通さない」側に倒す(フェイルクローズ)。
 *
 * 失敗の理由コードはログにだけ使う。**クライアントへの応答には出さない**(handler.ts)。
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Worker の secret として渡る設定。値は公開リポジトリに置かないため、ユーザーがダッシュボードで登録する。 */
export interface AccessEnv {
  /** Zero Trust のチーム名(`<チーム名>.cloudflareaccess.com` の左側)。 */
  ACCESS_TEAM_NAME?: string;
  /** Access アプリケーションの AUD タグ。 */
  ACCESS_AUD?: string;
  /** 許可するメールアドレス(1件)。 */
  ACCESS_ALLOWED_EMAIL?: string;
}

export interface AccessConfig {
  readonly teamName: string;
  readonly aud: string;
  /** 小文字化・前後の空白除去済み。 */
  readonly allowedEmail: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: AccessConfig }
  | { readonly ok: false; readonly reason: "config-missing" | "config-invalid" };

/** チーム名の形式。URL や別ホストを混ぜられないよう、英小文字・数字・ハイフンだけを許す。 */
const TEAM_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** メールを照合用に正規化する(小文字化・前後の空白除去)。文字列でない・空なら null。 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 設定は3項目がそろって正しいときだけ有効。欠落は config-missing、形式の不正は config-invalid。 */
export function parseAccessConfig(env: AccessEnv): ConfigResult {
  const { ACCESS_TEAM_NAME: team, ACCESS_AUD: aud, ACCESS_ALLOWED_EMAIL: email } = env;
  if (team === undefined || aud === undefined || email === undefined) {
    return { ok: false, reason: "config-missing" };
  }
  if (typeof team === "string" && team.trim() === "") {
    return { ok: false, reason: "config-missing" };
  }
  if (typeof aud === "string" && aud.trim() === "") {
    return { ok: false, reason: "config-missing" };
  }
  if (typeof email === "string" && email.trim() === "") {
    return { ok: false, reason: "config-missing" };
  }
  if (!present(team) || !present(aud) || !present(email)) {
    return { ok: false, reason: "config-invalid" };
  }
  const teamName = team.trim();
  const allowedEmail = normalizeEmail(email);
  if (!TEAM_NAME_PATTERN.test(teamName) || allowedEmail === null || !allowedEmail.includes("@")) {
    return { ok: false, reason: "config-invalid" };
  }
  return { ok: true, config: { teamName, aud: aud.trim(), allowedEmail } };
}

export function issuerOf(teamName: string): string {
  return `https://${teamName}.cloudflareaccess.com`;
}

export function certsUrlOf(teamName: string): string {
  return `${issuerOf(teamName)}/cdn-cgi/access/certs`;
}

export type TokenSource = "header" | "cookie";

/**
 * JWT の取得元を、試す順に返す: ヘッダ `Cf-Access-Jwt-Assertion`(推奨)→ クッキー `CF_Authorization`。
 * 公式ドキュメントはクッキーを「渡されるとは限らない」としているが、ヘッダが無いときの補助にする。
 */
export function extractTokens(request: Request): Array<{ source: TokenSource; token: string }> {
  const found: Array<{ source: TokenSource; token: string }> = [];
  const header = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (header !== undefined && header !== "") {
    found.push({ source: "header", token: header });
  }
  const cookies = request.headers.get("cookie");
  if (cookies !== null) {
    for (const part of cookies.split(";")) {
      const index = part.indexOf("=");
      if (index < 0) {
        continue;
      }
      if (part.slice(0, index).trim() === "CF_Authorization") {
        const value = part.slice(index + 1).trim();
        if (value !== "") {
          found.push({ source: "cookie", token: value });
        }
        break;
      }
    }
  }
  return found;
}

export type VerifyDenyReason =
  | "malformed"
  | "alg-not-allowed"
  | "unknown-key"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "aud-mismatch"
  | "iss-mismatch"
  | "claim-missing"
  | "email-missing"
  | "email-mismatch"
  | "keys-unavailable";

export type VerifyResult =
  | { readonly ok: true; readonly email: string }
  | { readonly ok: false; readonly reason: VerifyDenyReason };

function reasonOf(error: unknown): VerifyDenyReason {
  if (error instanceof errors.JWTExpired) {
    return "expired";
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case "aud":
        return "aud-mismatch";
      case "iss":
        return "iss-mismatch";
      case "nbf":
        return "not-yet-valid";
      case "exp":
        return error.reason === "check_failed" ? "expired" : "claim-missing";
      default:
        return "claim-missing";
    }
  }
  if (error instanceof errors.JOSEAlgNotAllowed) {
    return "alg-not-allowed";
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return "bad-signature";
  }
  if (error instanceof errors.JWKSNoMatchingKey) {
    return "unknown-key";
  }
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) {
    return "malformed";
  }
  // 上記以外(鍵の取得の失敗・タイムアウト・想定外の例外)は、鍵が使えなかったものとして拒否する。
  return "keys-unavailable";
}

/**
 * Access の JWT を検証する。通るのは、署名・iss・aud・exp・nbf がすべて正しく、かつ email が許可した1件と
 * 一致するときだけ。`now` は現在時刻(テストで固定する)。
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  keys: JWTVerifyGetKey,
  now: Date = new Date(),
): Promise<VerifyResult> {
  // コンパクト形式(ヘッダ.本体.署名。3部ともに空でない)の形だけ先に見る。署名が空の alg=none もここで落ちる。
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts.some((part) => part === "")) {
    return { ok: false, reason: "malformed" };
  }
  let email: unknown;
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: issuerOf(config.teamName),
      audience: config.aud,
      currentDate: now,
      requiredClaims: ["exp"],
    });
    email = payload["email"];
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
  const normalized = normalizeEmail(email);
  if (normalized === null) {
    return { ok: false, reason: "email-missing" };
  }
  if (normalized !== config.allowedEmail) {
    return { ok: false, reason: "email-mismatch" };
  }
  return { ok: true, email: normalized };
}

const keyCache = new Map<string, JWTVerifyGetKey>();

/**
 * チームの鍵(`<team>.cloudflareaccess.com/cdn-cgi/access/certs`)の取得関数。チームごとにキャッシュする。
 * 鍵は6週間ごとに回り旧鍵は7日間有効なので、固定の鍵を持たず、JWT の kid で引く(jose の既定の動作:
 * 未知の kid のときは再取得する)。
 */
export function remoteKeys(teamName: string): JWTVerifyGetKey {
  const cached = keyCache.get(teamName);
  if (cached !== undefined) {
    return cached;
  }
  const created = createRemoteJWKSet(new URL(certsUrlOf(teamName)), { timeoutDuration: 5000 });
  keyCache.set(teamName, created);
  return created;
}
