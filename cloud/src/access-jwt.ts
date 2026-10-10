/**
 * Cloudflare Access の JWT の検証(Issue #161〈#21-C〉)。純ロジック(Workers のランタイムに依存しない)。
 *
 * Worker は Access の外側の守りに頼らず、自分でも JWT を検証する(多層防御)。検証するのは
 * 署名(RS256 に固定)・iss・aud・exp・nbf と、email クレームがあること。
 * 設定の欠落・形式の不正・検証の失敗・鍵の取得の失敗は、すべて「通さない」側に倒す(フェイルクローズ)。
 *
 * **Issue #238(閲覧者の受け入れ)**: 誰がログインできるかは Cloudflare Access のポリシーだけで決める。検証に通ったアカウントはすべて
 * 閲覧者(viewer)として受け入れ、secret `ADMIN_USER` に載ったアドレスだけが管理者(admin)になる。メールの一致は「通す・通さない」ではなく
 * **役割を決める**ためだけに使う({@link roleOf})。管理者を判定できないときは、管理者にせず閲覧者に倒す。
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
  /**
   * 必須の設定(欠けていれば全拒否)。Issue #238 以降は**サイトの関門ではなく**、`ADMIN_USER` が未登録のあいだだけ管理者として扱う
   * アドレス(移行期間のフォールバック。デプロイ直後にオーナーが締め出されないように)。
   */
  ACCESS_ALLOWED_EMAIL?: string;
  /**
   * 管理者のメールアドレス(カンマ区切りで複数可。Issue #238)。**未登録・空・空白だけのときは `ACCESS_ALLOWED_EMAIL` を管理者とする**。
   * 登録済みで有効なアドレスが 1 件も無いときは、管理者なし(全員が閲覧者)。解釈は {@link parseAdminUsers}。
   */
  ADMIN_USER?: string;
}

/** 役割(Issue #238)。admin = 設定・検証・状態を変える操作・LLM を呼ぶ操作まで。viewer = 読み取りだけ。 */
export type Role = "admin" | "viewer";

/** 管理者の一覧の出どころ(ログ用の固定トークン。アドレスは含まない)。 */
export type AdminSource = "configured" | "fallback" | "none";

export interface AccessConfig {
  readonly teamName: string;
  readonly aud: string;
  /** 小文字化・前後の空白除去済み。`ADMIN_USER` が未登録のときだけ管理者になる(移行期間のフォールバック)。 */
  readonly allowedEmail: string;
  /** 管理者のメール(正規化済み・重複なし)。`ADMIN_USER` が登録済みならその有効な項目、未登録なら `[allowedEmail]`、登録済みで有効 0 件なら `[]`。 */
  readonly adminEmails: readonly string[];
  readonly adminSource: AdminSource;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: AccessConfig }
  | { readonly ok: false; readonly reason: "config-missing" | "config-invalid" };

/** チーム名の形式。URL や別ホストを混ぜられないよう、英小文字・数字・ハイフンだけを許す。 */
const TEAM_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * メールを照合用に正規化する(前後の空白除去と、**ASCII だけ**の小文字化)。文字列でない・空なら null。
 * `toLowerCase()` は Unicode も変える(U+212A KELVIN SIGN → k など)ため、別の文字が許可メールの文字に化けて
 * 一致してしまう余地を残さないよう、A-Z だけを小文字にする。
 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  return normalized === "" ? null : normalized;
}

/** 管理者の 1 項目の形。空白・`@` 以外の 1 個の `@`・区切り文字(`,` `;`)を含まない。実在のアドレスかどうかは見ない(照合に使うだけ)。 */
const ADMIN_ENTRY_PATTERN = /^[^\s@,;]+@[^\s@,;]+$/;

/**
 * `ADMIN_USER` を管理者の一覧にする(Issue #238)。
 *  - **未登録**(`undefined`、または `trim()` が空)のときだけ、`fallbackEmail`(`ACCESS_ALLOWED_EMAIL`)を管理者にする(`fallback`)。
 *  - 登録済みなら、カンマで分割して各項目を {@link normalizeEmail} で正規化し、形が正しい項目だけを管理者にする(空の項目・重複は捨てる)(`configured`)。
 *  - 登録済みで有効な項目が 0 件(区切りの誤り・文字列でない値など)なら、**管理者なし**(`none`)。フォールバックしない(fail-closed:
 *    誤設定が、意図しない人を管理者にする方向へ倒れない)。
 * 例外を投げない。
 */
export function parseAdminUsers(raw: unknown, fallbackEmail: string): { readonly emails: readonly string[]; readonly source: AdminSource } {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return { emails: [fallbackEmail], source: "fallback" };
  }
  if (typeof raw !== "string") {
    return { emails: [], source: "none" };
  }
  const emails: string[] = [];
  for (const part of raw.split(",")) {
    const email = normalizeEmail(part);
    if (email !== null && ADMIN_ENTRY_PATTERN.test(email) && !emails.includes(email)) {
      emails.push(email);
    }
  }
  return emails.length === 0 ? { emails: [], source: "none" } : { emails, source: "configured" };
}

/**
 * 検証済みのメールから役割を決める(Issue #238)。**管理者の一覧との完全一致**(正規化後)だけが admin。
 * JWT のメールは分割も部分一致もしない。メールが文字列でない・判定中に例外が起きたら viewer(管理者にしない)。
 */
export function roleOf(email: unknown, config: Pick<AccessConfig, "adminEmails">): Role {
  try {
    const normalized = normalizeEmail(email);
    return normalized !== null && config.adminEmails.includes(normalized) ? "admin" : "viewer";
  } catch {
    return "viewer";
  }
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
  // ADMIN_USER の不備は設定全体を無効にしない(閲覧者まで締め出さない)。管理者が決まらないだけ。
  const admins = parseAdminUsers(env.ADMIN_USER, allowedEmail);
  return { ok: true, config: { teamName, aud: aud.trim(), allowedEmail, adminEmails: admins.emails, adminSource: admins.source } };
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
 * Access の JWT を検証する。通るのは、署名・iss・aud・exp・nbf がすべて正しく、かつ email クレームがあるときだけ。
 * **メールが誰であるかでは拒否しない**(Issue #238。役割は {@link roleOf} が決める)。`now` は現在時刻(テストで固定する)。
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
  return { ok: true, email: normalized };
}

/**
 * チームの鍵(`<team>.cloudflareaccess.com/cdn-cgi/access/certs`)の取得関数。**リクエストごとに新しく作る**
 * (module スコープに保持しない)。Cloudflare 公式の Workers 向けの例もリクエストの中で作っている。
 *
 * 理由: jose の取得関数は、取得中の Promise(内部の pendingFetch)をクロージャに保持する。Workers では、
 * あるリクエストが作った I/O(Promise・ストリーム)を別のリクエストが待つと失敗しうる(jose は Workers を判定して
 * 保持中の Promise を捨てる実装だが、それに頼らない)。module スコープで共有して全リクエストが 403 になると、
 * 初回の実機確認を不安定にする。代償は、リクエストごとに鍵を1回取得すること(個人用途のため許容)。
 * キャッシュが要るようになったら、取得済みの鍵データ(JWK の JSON)だけを保持し、リクエストごとに
 * `createLocalJWKSet` で包む(I/O を共有しない)。
 *
 * 鍵は6週間ごとに回り旧鍵は7日間有効なので、固定の鍵を持たず、JWT の kid で引く。
 */
export function remoteKeys(teamName: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(certsUrlOf(teamName)), { timeoutDuration: 5000 });
}
