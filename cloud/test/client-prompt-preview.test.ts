import { describe, expect, it } from "vitest";
import { buildPromptPreview, resolveClipVariant } from "@keiba/core/analyzer/build-prompt";
import { buildPreviewText } from "../client/prompt-preview";
import { clampAdditionalInstruction } from "../src/llm-run";
import { clampAdditionalInstruction as clampFromSettings } from "../src/settings";

/**
 * Issue #201: 設定画面の「LLM へ送るプロンプトのプレビュー」の文面(純関数)。
 * 実際の送信(`race-day-core.ts`: 追加指示を 2,000 UTF-16 単位に切り、クリップ幅を `resolveClipVariant` で解決する)と同じ手順で、
 * exe と同じ `buildPromptPreview` に通した文面を返す。**送信側の文面との一致は `race-day-llm.test.ts` の e10(実際に LLM へ渡った prompt との突き合わせ)が固定する**。
 */

describe("clampAdditionalInstruction の置き場所(#201 で純モジュール settings.ts へ移した。llm-run.ts は再 export)", () => {
  it("settings.ts の関数と llm-run.ts の関数は同一の関数(定義は1か所)", () => {
    expect(clampAdditionalInstruction).toBe(clampFromSettings);
  });
});

describe("buildPreviewText: 追加指示(送信と同じ 2,000 UTF-16 単位の切り詰め)", () => {
  const SECTION = "【追加指示";
  const cases: { name: string; input: string; clamped: boolean; check: (text: string) => void }[] = [
    {
      name: "空文字: 追加指示のブロックが出ない・切り詰めなし",
      input: "",
      clamped: false,
      check: (t) => expect(t).not.toContain(SECTION),
    },
    {
      name: "空白のみ: 追加指示のブロックが出ない(buildPrompt の trim に委ねる)・切り詰めなし",
      input: "   \n  ",
      clamped: false,
      check: (t) => expect(t).not.toContain(SECTION),
    },
    {
      name: "短い指示: ブロックが出て、指示がそのまま入る・切り詰めなし",
      input: "逃げ馬を重視してください",
      clamped: false,
      check: (t) => {
        expect(t).toContain(SECTION);
        expect(t).toContain("逃げ馬を重視してください");
      },
    },
    {
      name: "ちょうど 2,000 単位: 切らない(全部入る)",
      input: "あ".repeat(2000),
      clamped: false,
      check: (t) => expect(t).toContain("あ".repeat(2000)),
    },
    {
      name: "2,001 単位: 2,000 単位に切る(2,001 個の連続は入らない)",
      input: "あ".repeat(2001),
      clamped: true,
      check: (t) => {
        expect(t).toContain("あ".repeat(2000));
        expect(t).not.toContain("あ".repeat(2001));
      },
    },
    {
      name: "2,000 単位目がサロゲートペアの途中: ペアごと落とす(孤立したサロゲートが残らない)",
      input: `${"あ".repeat(1999)}😀`,
      clamped: true,
      check: (t) => {
        expect(t).toContain("あ".repeat(1999));
        expect(t).not.toContain("😀");
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t)).toBe(false);
      },
    },
  ];

  it.each(cases)("$name", ({ input, clamped, check }) => {
    const result = buildPreviewText({ additionalInstruction: input, clipVariant: "default" });
    expect(result.clamped).toBe(clamped);
    check(result.text);
    // 送信と同じ手順(切る → exe と同じ関数)で作った文面と一致する
    expect(result.text).toBe(buildPromptPreview(clampFromSettings(input).text, "default"));
  });

  it("前提(空振り防止): 切り詰める入力では、切った後の文面と、切らなかったときの文面が実際に違う", () => {
    const input = "あ".repeat(2100);
    const uncut = buildPromptPreview(input, "default");
    const preview = buildPreviewText({ additionalInstruction: input, clipVariant: "default" });
    expect(clampFromSettings(input).text.length).toBe(2000);
    expect(preview.text).not.toBe(uncut);
    expect(uncut.length - preview.text.length).toBe(100);
  });
});

describe("buildPreviewText: クリップ幅(送信と同じ resolveClipVariant の解決)", () => {
  it("default は ±10%(絶対値0.10)、wide15 は ±15%(絶対値0.15)。2 つの文面は違う(前提)", () => {
    const d = buildPreviewText({ additionalInstruction: "x", clipVariant: "default" });
    const w = buildPreviewText({ additionalInstruction: "x", clipVariant: "wide15" });
    expect(d.text).not.toBe(w.text);
    expect(d.text).toContain("±10%(絶対値0.10)");
    expect(d.text).not.toContain("±15%(絶対値0.15)");
    expect(w.text).toContain("±15%(絶対値0.15)");
    expect(w.text).not.toContain("±10%(絶対値0.10)");
  });

  it("プロンプト版は、解決した版の promptVersion。default と wide15 で違う", () => {
    const d = buildPreviewText({ additionalInstruction: "", clipVariant: "default" });
    const w = buildPreviewText({ additionalInstruction: "", clipVariant: "wide15" });
    expect(d.promptVersion).toBe(resolveClipVariant("default").promptVersion);
    expect(w.promptVersion).toBe(resolveClipVariant("wide15").promptVersion);
    expect(d.promptVersion).not.toBe(w.promptVersion);
  });

  it("未知の版 ID は、送信と同じく default に解決する(文面も版も default と同じ)", () => {
    const bogus = buildPreviewText({ additionalInstruction: "x", clipVariant: "bogus" });
    const d = buildPreviewText({ additionalInstruction: "x", clipVariant: "default" });
    expect(bogus).toEqual(d);
  });
});
