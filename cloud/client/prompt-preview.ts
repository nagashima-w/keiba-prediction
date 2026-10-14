/**
 * 設定画面の「LLM へ送るプロンプトのプレビュー」の文面(Issue #201。純関数)。
 *
 * **送信と同じ手順**(`race-day-core.ts` の発走前の分析):
 *  1. 追加指示を `clampAdditionalInstruction`(2,000 UTF-16 単位。サロゲートペアを割らない)で切る
 *  2. クリップ幅の版を `resolveClipVariant` で解決する(未知の ID は対照〈default〉)。プロンプトには解決した版の `id` を渡す
 *  3. exe の設定画面と同じ `buildPromptPreview`(固定のサンプルレースを `buildPrompt` に通す)に通す
 * 送信側の文面との一致は、`test/race-day-llm.test.ts` の e10(実際に LLM へ渡った prompt との突き合わせ)が固定している。
 *
 * クライアントのバンドルが core から取り込むのは `@keiba/core/analyzer/build-prompt` だけ(許可リスト。`test/client-bundle.test.ts`)。
 */
import { buildPromptPreview, resolveClipVariant } from "@keiba/core/analyzer/build-prompt";
import { clampAdditionalInstruction } from "../src/settings";

export interface PreviewInput {
  /** 下書きの追加指示(入力した文字のまま)。 */
  readonly additionalInstruction: string;
  /** 下書きのクリップ幅の版 ID。 */
  readonly clipVariant: string;
}

export interface PreviewText {
  /** プレビューの文面(サンプルレースで作った、LLM へ送る文面の例)。 */
  readonly text: string;
  /** 追加指示を 2,000 単位に切ったか(送信でも同じ切り方をする)。 */
  readonly clamped: boolean;
  /** 解決した版のプロンプト版(`PROMPT_VERSION` 由来)。 */
  readonly promptVersion: string;
}

export function buildPreviewText(input: PreviewInput): PreviewText {
  const instruction = clampAdditionalInstruction(input.additionalInstruction);
  const variant = resolveClipVariant(input.clipVariant);
  return {
    text: buildPromptPreview(instruction.text, variant.id),
    clamped: instruction.clamped,
    promptVersion: variant.promptVersion,
  };
}
