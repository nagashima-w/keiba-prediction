/**
 * Cloudflare API を呼ぶ最小のヘルパ(Issue #159〈#21-A〉)。プリフライトと後片付けが使う。
 * トークンはログに出さない(URL と本文の先頭だけを返す)。
 */

/** 既定は本物の API。CF_API_BASE は、偽の API サーバに向けて配線を確かめるための差し替え口(本番では使わない)。 */
const API = process.env["CF_API_BASE"] ?? "https://api.cloudflare.com/client/v4";

export interface ApiResult {
  /** HTTP ステータス。通信が失敗したら null。 */
  readonly status: number | null;
  readonly text: string;
}

export async function cfApi(
  token: string,
  path: string,
  init: { method?: string; body?: FormData | string } = {},
): Promise<ApiResult> {
  try {
    const response = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}` },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return { status: null, text: error instanceof Error ? error.message : String(error) };
  }
}

/** 本文の先頭(診断表示用)。 */
export function head(text: string, max = 300): string {
  return text.slice(0, max);
}

/** 必須の環境変数を読む(無ければ例外)。 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}
