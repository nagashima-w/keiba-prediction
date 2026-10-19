/**
 * 設定画面のプロンプトのプレビューの取得 `POST /api/settings/prompt-preview` の呼び出しと応答の検査(Issue #396)。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * プレビューの文面は**サーバが組み立てる**(`cloud/src/prompt-preview.ts`)。クライアントの束に core の `build-prompt` とその依存(約 39 KB)を入れないため。
 * **応答を信用しない**: 成功は、`ok: true`・`text`(文字列)・`clamped`(真偽)・`promptVersion`(文字列)がそろったときだけ。それ以外(型違い・欠損)は失敗にする。
 * サーバの文面(`error.message` など)は読まない・出さない。失敗は固定の文言(`PREVIEW_FAILURE_TEXT`)にする。
 * Origin(サーバは完全一致で CSRF を拒否する): `postSettings` と同じく `referrerPolicy: "same-origin"` を付け、fetch の `mode` は指定しない(`api-run.ts` と同じ。理由はそちらの説明)。
 * 追加指示は**先頭の 2,001 UTF-16 単位だけ**を送る(上限 2,000 を超えたことが分かれば足りる。D1 に直接入れた長い値でも本文の上限に収まる。
 * サーバの `clampAdditionalInstruction` は 2,001 単位でも元の長文と同じ位置で切り、同じ `clamped` を返す。`test/handler-prompt-preview.test.ts` が固定)。
 * サーバ側のキー名・形のドリフトは `test/client-api-prompt-preview-contract.test.ts`(実際の `handle()` の応答を通す)が検出する。
 */
import { ADDITIONAL_INSTRUCTION_MAX_LENGTH } from "../src/settings";
import { isRecord, type FetchLike } from "./api";

/** プレビューの 1 件(サーバが返した文面と、追加指示を切ったか、解決した版のプロンプト版)。 */
export interface PromptPreview {
  readonly text: string;
  readonly clamped: boolean;
  readonly promptVersion: string;
}

export interface PreviewRequest {
  /** 下書きの追加指示(入力した文字のまま。送るときに先頭の 2,001 単位に縮める)。 */
  readonly additionalInstruction: string;
  /** 下書きのクリップ幅の版 ID。 */
  readonly clipVariant: string;
}

export type PromptPreviewResult = { readonly ok: true; readonly preview: PromptPreview } | { readonly ok: false };

/** 取得に失敗したとき、文面の場所に出す固定の文言(サーバの文面は含めない)。 */
export const PREVIEW_FAILURE_TEXT = "プレビューを取得できませんでした。通信かログインの期限切れかもしれません。少し待ってから「入力中の内容を反映」を押してください。";

/** 送る追加指示(先頭の 2,001 単位)。 */
function sentInstruction(text: string): string {
  return text.slice(0, ADDITIONAL_INSTRUCTION_MAX_LENGTH + 1);
}

/** 同じ文面になる入力かの鍵(送る形で比べる。2,001 単位より後ろの違いは文面に出ない)。 */
export function previewRequestKey(input: PreviewRequest): string {
  return JSON.stringify([sentInstruction(input.additionalInstruction), input.clipVariant]);
}

/** `POST /api/settings/prompt-preview`。例外(同期・非同期とも)・200 以外・想定外の形は、すべて `{ ok: false }`(例外の文面は持ち込まない)。 */
export async function fetchPromptPreview(fetchLike: FetchLike, input: PreviewRequest): Promise<PromptPreviewResult> {
  try {
    const response = await fetchLike("/api/settings/prompt-preview", {
      method: "POST",
      credentials: "same-origin",
      referrerPolicy: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ additionalInstruction: sentInstruction(input.additionalInstruction), clipVariant: input.clipVariant }),
    });
    if (response.status !== 200) return { ok: false };
    const body: unknown = await response.json();
    if (!isRecord(body) || body["ok"] !== true) return { ok: false };
    const { text, clamped, promptVersion } = body;
    if (typeof text !== "string" || typeof clamped !== "boolean" || typeof promptVersion !== "string") return { ok: false };
    return { ok: true, preview: { text, clamped, promptVersion } };
  } catch {
    return { ok: false };
  }
}
