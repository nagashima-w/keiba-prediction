/**
 * JRA の取得の失敗の詳細(Issue #804)。D1 の `odds_snapshots.fail_detail`・`baba_fetch_attempts.fail_detail`(migration 0051)に入れる短い JSON の部品。
 * 純関数だけ(Worker・DO・D1 を import しない)。
 *
 * ## 守ること
 * - 残すのは**固定の語と数字だけ**。例外の message・URL・応答の本文・ヘッダの値は残さない。判定に**だけ**読む(読んだ結果は語・真偽値・4 桁の数字に写す)。
 * - 語彙({@link JraFailKind}): `dns`・`reset`・`timeout`・`blocked`・`cf-NNNN`・`http`・`redirect`・`too-large`・`unknown`。語彙に無いものは `unknown`。
 * - JSON は決まった鍵(`p` 頁・`k` 種類・`h` HTTP の状態〈あれば〉・`c` 拠点〈あれば〉)と、検査を通した値だけで組む(外の文字列を入れない)。
 *
 * ## 例外の分類の根拠(workerd 1.20261110.1 のローカル実行で実測。本番のエッジは未確認)
 * 名前の解決の失敗は `Error: internal error; reference = …`(`cause` 無し)、接続の拒否は `Error: Network connection lost.`(`retryable` 付き)だった。
 * 拒否・切断・TLS の失敗は区別できなかった(実際の TLS の失敗は作れていない)ので、分けずに `reset` とする(推測で語を増やさない)。
 * 名前では区別できない(どちらも `name` は `Error`)ので、message の文字列で見分ける。本番で別の形なら `unknown` に落ちる(公開後の記録で確かめる)。
 */

/** 失敗の種類(固定の語彙)。`cf-NNNN` は Cloudflare 自身のエラー応答(本文が `error code: NNNN`)の NNNN(4 桁)。 */
export type JraFailKind = "dns" | "reset" | "timeout" | "blocked" | `cf-${number}` | "http" | "redirect" | "too-large" | "unknown";

/** 失敗した頁の語(オッズの式別の頁・開催選択/レース選択・馬場の 4 つの取得)。 */
export const FAIL_DETAIL_PAGES = ["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan", "discover", "cushion", "moist", "access", "course"] as const;
export type JraFailPage = (typeof FAIL_DETAIL_PAGES)[number];

/** 取得の失敗の詳細(JSON にする前)。 */
export interface JraFailInfo {
  readonly kind: JraFailKind;
  /** HTTP の状態(応答が来たとき。来る前の失敗は null)。 */
  readonly http: number | null;
}

const FIXED_KINDS: readonly string[] = ["dns", "reset", "timeout", "blocked", "http", "redirect", "too-large", "unknown"];
const CF_KIND = /^cf-\d{4}$/;
const COLO = /^[A-Z]{3}$/;
/** 配信の防御の目印を探す本文の先頭の長さ(バイト)。 */
const EDGE_BLOCK_SCAN_BYTES = 2048;
/** `error code: NNNN` の本文を探す長さの上限(バイト。Cloudflare のエラー応答は十数バイト)。 */
const CF_ERROR_MAX_BYTES = 64;

/** fetch が投げた例外の種類。**message は判定にだけ読み、残さない**。 */
export function classifyThrownKind(error: unknown): JraFailKind {
  if (typeof error !== "object" || error === null) {
    return "unknown";
  }
  const name = "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return "timeout";
  }
  const message = "message" in error ? (error as { message: unknown }).message : undefined;
  if (typeof message !== "string") {
    return "unknown";
  }
  if (message.startsWith("internal error")) {
    return "dns";
  }
  if (message.startsWith("Network connection lost")) {
    return "reset";
  }
  return "unknown";
}

/** 本文が Cloudflare 自身のエラー応答(ちょうど `error code: NNNN`。NNNN は 4 桁)なら NNNN。違えば null。 */
export function detectCfErrorCode(body: Uint8Array | null): number | null {
  if (body === null || body.byteLength === 0 || body.byteLength > CF_ERROR_MAX_BYTES) {
    return null;
  }
  const match = /^error code: (\d{4})$/.exec(new TextDecoder().decode(body).trim());
  return match === null ? null : Number(match[1]);
}

/** 403 が JRA の手前の配信の防御(Akamai)による拒否の形か。`server` ヘッダが Akamai、または本文の先頭 2KB に `Access Denied` と `edgesuite` の両方。真偽値だけ返す。 */
export function isEdgeBlock(serverHeader: string | null, body: Uint8Array | null): boolean {
  if (serverHeader !== null && /akamai/i.test(serverHeader)) {
    return true;
  }
  if (body === null) {
    return false;
  }
  const head = new TextDecoder().decode(body.subarray(0, EDGE_BLOCK_SCAN_BYTES));
  return head.includes("Access Denied") && head.includes("edgesuite");
}

/** HTTP の失敗(2xx 以外で、リダイレクトでない応答)の種類。403 は配信の防御の形なら `blocked`、Cloudflare のエラー応答は `cf-NNNN`、ほかは `http`。 */
export function classifyHttpFailure(httpStatus: number, serverHeader: string | null, body: Uint8Array | null): JraFailKind {
  const cf = detectCfErrorCode(body);
  if (cf !== null) {
    return `cf-${cf}`;
  }
  return httpStatus === 403 && isEdgeBlock(serverHeader, body) ? "blocked" : "http";
}

/** `cdn-cgi/trace` の本文から拠点(3 文字の大文字)。無い・形違いは null。 */
export function parseTraceColo(text: string): string | null {
  const match = /^colo=(.*)$/m.exec(text);
  const colo = match?.[1]?.trim() ?? "";
  return COLO.test(colo) ? colo : null;
}

/** `fail_detail` の JSON。鍵は p・k・(h)・(c) の順。検査を通らない値は、語彙外なら `unknown`、h・c なら出さない。 */
export function buildFailDetail(input: { readonly page: string; readonly kind: string; readonly http: number | null; readonly colo: string | null }): string {
  const page = (FAIL_DETAIL_PAGES as readonly string[]).includes(input.page) ? input.page : "unknown";
  const kind = FIXED_KINDS.includes(input.kind) || CF_KIND.test(input.kind) ? input.kind : "unknown";
  const parts = [`"p":"${page}"`, `"k":"${kind}"`];
  if (input.http !== null && Number.isInteger(input.http) && input.http >= 100 && input.http <= 599) {
    parts.push(`"h":${input.http}`);
  }
  if (input.colo !== null && COLO.test(input.colo)) {
    parts.push(`"c":"${input.colo}"`);
  }
  return `{${parts.join(",")}}`;
}
