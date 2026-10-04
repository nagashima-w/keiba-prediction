import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GENERATED_BEGIN,
  GENERATED_END,
  demoteHeadings,
  extractGeneratedBlock,
  replaceGeneratedBlock,
} from "../cloudflare-spike/report-doc.js";
import { extractResultBlock, formatResultBlock, renderMarkdown, type SpikeResult } from "../cloudflare-spike/result.js";

/**
 * #159 report.md の数値は、結果 JSON から renderMarkdown で生成し、手で書き写さない。
 * 生成した節を report.md の印の間へ差し込む純関数と、「report.md の生成節が、コミット済みの結果 JSON から
 * 今の生成器で作った内容と一致する」ことの検査(JSON か生成器だけを直して report を直し忘れる/手で
 * 書き換えると落ちる)。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...segments: string[]): string => readFileSync(path.join(ROOT, ...segments), "utf-8").replace(/\r\n/g, "\n");

describe("replaceGeneratedBlock", () => {
  const doc = `前文\n${GENERATED_BEGIN}\n古い内容\n${GENERATED_END}\n後文\n`;

  it("印の間だけを差し替え、前後の文章は変えない", () => {
    expect(replaceGeneratedBlock(doc, "新しい内容")).toBe(`前文\n${GENERATED_BEGIN}\n新しい内容\n${GENERATED_END}\n後文\n`);
  });

  it("同じ内容で2回差し替えても結果は同じ(冪等)", () => {
    const once = replaceGeneratedBlock(doc, "新しい内容");
    expect(replaceGeneratedBlock(once, "新しい内容")).toBe(once);
  });

  it("生成内容の前後の空行・末尾の改行は正規化される(余計な空行が増えない)", () => {
    expect(replaceGeneratedBlock(doc, "\n\n新しい内容\n\n")).toBe(replaceGeneratedBlock(doc, "新しい内容"));
  });

  it.each([
    { label: "開始印が無い", text: `前\n${GENERATED_END}\n後` },
    { label: "終了印が無い", text: `前\n${GENERATED_BEGIN}\n後` },
    { label: "終了印が開始印より前", text: `${GENERATED_END}\n${GENERATED_BEGIN}\n` },
    { label: "開始印が2つ", text: `${GENERATED_BEGIN}\n${GENERATED_BEGIN}\n${GENERATED_END}\n` },
  ])("印が不正($label)なら例外(黙って差し替えない)", ({ text }) => {
    expect(() => replaceGeneratedBlock(text, "x")).toThrow();
  });
});

describe("extractGeneratedBlock", () => {
  it("印の間の内容を、前後の改行を除いて返す", () => {
    expect(extractGeneratedBlock(`a\n${GENERATED_BEGIN}\nX\nY\n${GENERATED_END}\nb`)).toBe("X\nY");
  });
});

describe("demoteHeadings", () => {
  it("見出しの # を指定の数だけ増やす。見出し以外の行(# で始まらない行・行中の #)は変えない", () => {
    expect(demoteHeadings("# A\n## B\n本文 # not heading\n### C\n", 2)).toBe("### A\n#### B\n本文 # not heading\n##### C\n");
  });

  it("6段を超える分は6段で止める", () => {
    expect(demoteHeadings("##### A\n", 3)).toBe("###### A\n");
  });
});

describe("コミット済みの結果 JSON と report.md の一致", () => {
  const json = read("docs", "investigations", "cloudflare-spike", "round2-result.json");
  const result = JSON.parse(json) as SpikeResult;

  it("round2-result.json は結果ブロックの往復で壊れずに読める(ジョブログから切り出した形のまま)", () => {
    expect(extractResultBlock(formatResultBlock(result))).toEqual(result);
    expect(result.schemaVersion).toBe(1);
    expect(result.netkeiba.records.length).toBeGreaterThan(0);
  });

  it("report.md の生成節は、round2-result.json から今の renderMarkdown で作った内容と完全に一致する", () => {
    const report = read("docs", "investigations", "cloudflare-spike", "report.md");
    const expected = demoteHeadings(renderMarkdown(result), 2).trim();
    expect(extractGeneratedBlock(report)).toBe(expected);
    // 空の比較にならないこと
    expect(expected.length).toBeGreaterThan(500);
  });
});
