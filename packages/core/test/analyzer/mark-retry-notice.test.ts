/**
 * 聞き直しの追記文(buildMarkRetryNotice。Issue #317)のテスト。
 * 印の違反で聞き直すとき、前回の違反の種類(固定の語彙)から作った固定の文を、プロンプトの末尾に添える。
 * LLM の生の出力(前回の応答の文字列)は一切含めない。
 */

import { describe, expect, it } from "vitest";
import { buildMarkRetryNotice } from "../../src/analyzer/mark-retry-notice.js";
import { MARK_VIOLATION_KINDS, type MarkViolationKind } from "../../src/analyzer/parse-response.js";

const SENTENCES: Record<MarkViolationKind, string> = {
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

describe("buildMarkRetryNotice", () => {
  it.each(MARK_VIOLATION_KINDS)("違反の種類 %s は、固定の1文になる", (kind) => {
    const notice = buildMarkRetryNotice([kind]);
    expect(notice).toContain(`- ${SENTENCES[kind]}`);
  });

  it("表の前提: 10種すべてに固定文があり、互いに異なる", () => {
    expect(Object.keys(SENTENCES)).toHaveLength(10);
    expect([...MARK_VIOLATION_KINDS].sort()).toEqual(Object.keys(SENTENCES).sort());
    expect(new Set(Object.values(SENTENCES)).size).toBe(10);
  });

  it("複数の違反は、MARK_VIOLATION_KINDS の順に1行ずつ並ぶ。重複は1回にする", () => {
    const notice = buildMarkRetryNotice(["gap-〇", "over-◎", "over-◎"]);
    const lines = notice.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual([`- ${SENTENCES["over-◎"]}`, `- ${SENTENCES["gap-〇"]}`]);
  });

  it("見出しと、全馬分の JSON を出し直す指示を含む。プロンプト本体の末尾に足せるよう、空行で始まる", () => {
    const notice = buildMarkRetryNotice(["over-◎"]);
    expect(notice.startsWith("\n\n【前回の応答の訂正】\n")).toBe(true);
    expect(notice).toContain("全馬分の JSON");
  });

  it("違反の種類が空なら、何も足さない(空文字)", () => {
    expect(buildMarkRetryNotice([])).toBe("");
  });

  it("入力に固定の語彙の外の値が混ざっても(型を破った呼び出し)、その文字列を出力に含めない", () => {
    const notice = buildMarkRetryNotice(["over-◎", "SECRET-LLM-TEXT" as unknown as MarkViolationKind]);
    expect(notice).not.toContain("SECRET-LLM-TEXT");
    expect(notice).toContain(SENTENCES["over-◎"]);
  });
});
