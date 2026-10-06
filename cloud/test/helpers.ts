/**
 * テスト用の鍵と JWT の生成。値はすべて文書用のダミー(example.com 等)。実在のメール・チーム名・AUD は使わない。
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from "jose";

export const TEAM = "example-team";
export const AUD = "aud-tag-for-tests-0001";
export const EMAIL = "owner@example.com";
export const ISSUER = `https://${TEAM}.cloudflareaccess.com`;

/** 固定の「現在時刻」(2026-10-06T00:00:00Z)。 */
export const NOW = new Date("2026-10-06T00:00:00Z");
export const NOW_SEC = Math.floor(NOW.getTime() / 1000);

export interface TestKey {
  readonly kid: string;
  readonly alg: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

/** 既定は RS256(Access の署名アルゴリズム)。RS256 以外の拒否のテストでは別の alg を指定する。 */
export async function makeKey(kid: string, alg = "RS256"): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { kid, alg, privateKey, jwk };
}

export function localKeys(...keys: TestKey[]): JWTVerifyGetKey {
  return createLocalJWKSet({ keys: keys.map((k) => k.jwk) });
}

export interface TokenOptions {
  readonly iss?: string;
  readonly aud?: string | string[];
  readonly email?: string | null;
  readonly exp?: number | null;
  readonly nbf?: number;
  readonly kid?: string;
}

/** 既定は「正常な JWT」(iss・aud・email が正しく、1時間有効)。 */
export async function signToken(key: TestKey, options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {};
  const email = options.email === undefined ? EMAIL : options.email;
  if (email !== null) {
    claims["email"] = email;
  }
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: key.alg, kid: options.kid ?? key.kid })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? [AUD])
    .setIssuedAt(NOW_SEC - 60);
  if (options.exp !== null) {
    jwt = jwt.setExpirationTime(options.exp ?? NOW_SEC + 3600);
  }
  if (options.nbf !== undefined) {
    jwt = jwt.setNotBefore(options.nbf);
  }
  return jwt.sign(key.privateKey);
}

export const GOOD_ENV = {
  ACCESS_TEAM_NAME: TEAM,
  ACCESS_AUD: AUD,
  ACCESS_ALLOWED_EMAIL: EMAIL,
} as const;
