/**
 * E1(ヘッダの観測。Issue #160〈#21-B〉)で使うエコーサービスの固定表。
 *
 * Worker の `/echo` はこの表の URL にしか出ない(共有秘密を持っていても、任意の URL へのプロキシにはしない)。
 * Worker にバンドルされるので、依存を持たない小さなファイルに分けてある。
 *
 * **Cloudflare 上にないサービスだけを置く**(Cloudflare 上の宛先だと、Workers の fetch の振る舞いが
 * CloudFront 宛てと変わりうる)。2026-10-04 の実測で、tls.peet.ws(`server: TrackMe.peet.ws`、cf-ray なし)と
 * httpbin.org(`server: gunicorn`、AWS)が該当した。postman-echo.com は `server: cloudflare`・cf-ray ありのため除外した。
 * 再現: `curl -sS -D - -o /dev/null https://postman-echo.com/headers` の応答ヘッダに server / cf-ray が出る
 * (ほかの2つ宛ても同様に確かめられる)。実行時にも、エコーの応答に cf-ray / server: cloudflare が出たら警告を残す。
 */

export type EchoService = "peet" | "httpbin";

/**
 * - peet: 受信ヘッダを順序・大文字小文字つきで返し、HTTP バージョン・TLS の指紋(JA3/JA4)も返す(第一候補)
 * - httpbin: ヘッダの名前と値だけ(フォールバック)
 */
export const ECHO_URLS: Readonly<Record<EchoService, string>> = {
  peet: "https://tls.peet.ws/api/all",
  httpbin: "https://httpbin.org/headers",
};

/** 試す順(第一候補が先)。 */
export const ECHO_SERVICES: readonly EchoService[] = ["peet", "httpbin"];

export function isEchoService(value: unknown): value is EchoService {
  return typeof value === "string" && (ECHO_SERVICES as readonly string[]).includes(value);
}
