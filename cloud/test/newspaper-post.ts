/**
 * 日単位の DO の取得ステップは、前走の条件(Issue #421 段階 1-b)の新聞形式 API を POST する。`postRaw` を持たない偽ゲートだと、その POST が
 * 「このゲートは POST に対応していません」で失敗し、取得ステップの警告に前走条件の行が残る(警告の一覧・ゲートへの呼び出しの列を固定している既存のテストが変わってしまう)。
 * そのため、POST を使わない既存のテストの偽ゲートには、この `postRaw` を足す: 新聞形式 API の実フィクスチャを 200 で返し、**警告を出さない**。
 * 受けた POST は `posts` に積む(GET の `urls` の列には入れない=既存のテストが固定する GET の列は変わらない)。
 * AplNewsPaper 以外の POST は 404(重賞の傾向の POST を扱うテストは、自分の `postRaw` で AplNewsPaper も返すこと)。
 */
import type { GatePostRequest, GateResult } from "../src/gate-core";
import { loadFixture } from "./pipeline-fixtures";

const encoder = new TextEncoder();

function bytesOf(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

/** 新聞形式 API の POST か。 */
export function isNewspaperPost(request: GatePostRequest): boolean {
  return request.body.includes("class=AplNewsPaper&");
}

/** 新聞形式 API の応答(実フィクスチャ。200)。 */
export function newspaperPostResult(): GateResult {
  return { kind: "response", status: 200, contentType: "application/json", body: bytesOf(loadFixture("newspaper_api_202608040711.json")), queuedMs: 0, elapsedMs: 1 };
}

/** 偽ゲートに足す `postRaw`: 新聞形式 API は実フィクスチャを返し、それ以外は 404。 */
export async function newspaperOnlyPostRaw(request: GatePostRequest): Promise<GateResult> {
  await Promise.resolve();
  if (isNewspaperPost(request)) {
    return newspaperPostResult();
  }
  return { kind: "response", status: 404, contentType: "text/plain", body: bytesOf("not found"), queuedMs: 0, elapsedMs: 1 };
}
