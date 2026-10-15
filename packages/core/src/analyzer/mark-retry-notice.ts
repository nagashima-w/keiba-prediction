/**
 * 聞き直しの追記文(Issue #317)。予想印の規則違反で LLM に聞き直すとき、前回の違反の種類から作った**固定の文**を、プロンプトの末尾に添える
 * (成功率を上げるため。何が違反だったかを知らずに同じ応答を繰り返す場合を減らす)。
 *
 * - 材料は**違反の種類(固定の語彙。`MARK_VIOLATION_KINDS`)だけ**。前回の応答の文字列(LLM の生の出力。印・根拠など)は一切含めない
 *   (プロンプトに LLM の出力を戻すと、そこから注入・肥大が起きうるため)。語彙の外の値は捨てる。
 * - 1回目のプロンプト(`buildPrompt` の出力)・`PROMPT_VERSION` は変えない。追記は analyze-race の聞き直し(2回目)だけ。
 *   印と無関係な失敗の後の聞き直しは、従来どおり同一のプロンプト。
 */

import { MARK_VIOLATION_KINDS, type MarkViolationKind } from "./parse-response.js";

/** 違反の種類ごとの固定文。 */
const SENTENCES: Readonly<Record<MarkViolationKind, string>> = {
  "unknown-char": "markに、◎〇▲△☆注以外の文字を使いました。印を付けない馬は null にしてください。",
  "missing-◎": "◎が1頭もありませんでした。◎は必ずちょうど1頭です。",
  "over-◎": "◎が2頭以上ありました。◎は必ずちょうど1頭です。",
  "over-〇": "〇が2頭以上ありました。〇は0〜1頭です。",
  "over-▲": "▲が2頭以上ありました。▲は0〜1頭です。",
  "over-△": "△が4頭以上ありました。△は0〜3頭です。",
  "over-☆": "☆が2頭以上ありました。☆は0〜1頭です。",
  "over-注": "注が2頭以上ありました。注は0〜1頭です。",
  "gap-〇": "▲を付けたのに〇がありませんでした。本線の印(◎〇▲△)は上から途切れなく付けてください(▲を付けるなら〇が必要です)。",
  "gap-▲": "△を付けたのに▲がありませんでした。本線の印(◎〇▲△)は上から途切れなく付けてください(△を付けるなら▲が必要です)。",
};

/**
 * 聞き直しのプロンプトの末尾に足す文。違反の種類が空(語彙の外だけの場合を含む)なら空文字。
 * @param kinds 前回の応答の違反の種類
 */
export function buildMarkRetryNotice(kinds: readonly MarkViolationKind[]): string {
  const wanted = new Set<string>(kinds);
  const lines = MARK_VIOLATION_KINDS.filter((k) => wanted.has(k)).map((k) => `- ${SENTENCES[k]}`);
  if (lines.length === 0) {
    return "";
  }
  return [
    "",
    "",
    "【前回の応答の訂正】",
    "前回の応答は、予想印の規則に違反していました。次の点を守って、全馬分の JSON をもう一度出力してください。",
    ...lines,
  ].join("\n");
}
