import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GENERATED_BEGIN,
  GENERATED_END,
  generatedMarkers,
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

describe("名前つきの生成節(第3ラウンド以降。1つの report.md に複数の結果 JSON から作った節を置く)", () => {
  const named = generatedMarkers("round3");
  const doc = `前\n${GENERATED_BEGIN}\n第2の古い\n${GENERATED_END}\n中\n${named.begin}\n第3の古い\n${named.end}\n後\n`;

  it("名前つきの印は、名前なしの印と文字列として区別できる(互いの印に一致しない)", () => {
    expect(named.begin).not.toBe(GENERATED_BEGIN);
    expect(named.end).not.toBe(GENERATED_END);
    expect(named.begin).toContain("round3");
    expect(named.end).toContain("round3");
    expect(doc.split(GENERATED_BEGIN).length - 1).toBe(1);
    expect(doc.split(GENERATED_END).length - 1).toBe(1);
  });

  it("名前を指定した差し替えは、その節だけを変え、名前なしの節と前後の文章は変えない", () => {
    expect(replaceGeneratedBlock(doc, "第3の新しい", "round3")).toBe(
      `前\n${GENERATED_BEGIN}\n第2の古い\n${GENERATED_END}\n中\n${named.begin}\n第3の新しい\n${named.end}\n後\n`,
    );
  });

  it("名前なしの差し替えは、名前つきの節を変えない(従来の動作のまま)", () => {
    expect(replaceGeneratedBlock(doc, "第2の新しい")).toBe(
      `前\n${GENERATED_BEGIN}\n第2の新しい\n${GENERATED_END}\n中\n${named.begin}\n第3の古い\n${named.end}\n後\n`,
    );
  });

  it("名前を指定した取り出しは、その節の内容だけを返す", () => {
    expect(extractGeneratedBlock(doc, "round3")).toBe("第3の古い");
    expect(extractGeneratedBlock(doc)).toBe("第2の古い");
  });

  it("2回差し替えても結果は同じ(冪等)", () => {
    const once = replaceGeneratedBlock(doc, "X", "round3");
    expect(replaceGeneratedBlock(once, "X", "round3")).toBe(once);
  });

  it.each([
    { label: "指定した名前の印が無い", text: `前\n${GENERATED_BEGIN}\nx\n${GENERATED_END}\n`, name: "round3" },
    { label: "開始印だけ", text: `前\n${named.begin}\n後`, name: "round3" },
    { label: "終了印が開始印より前", text: `${named.end}\n${named.begin}\n`, name: "round3" },
    { label: "同じ名前の開始印が2つ", text: `${named.begin}\n${named.begin}\n${named.end}\n`, name: "round3" },
  ])("印が不正($label)なら例外(黙って差し替えない)", ({ text, name }) => {
    expect(() => replaceGeneratedBlock(text, "x", name)).toThrow();
  });

  it("名前に印を壊す文字(改行・コメントの終端)が入っていたら拒否する", () => {
    expect(() => generatedMarkers("a-->b")).toThrow();
    expect(() => generatedMarkers("a\nb")).toThrow();
    expect(() => generatedMarkers("")).toThrow();
  });
});

describe("第3ラウンド(Issue #160)の結果 JSON と report.md の一致", () => {
  const json = read("docs", "investigations", "cloudflare-spike", "round3-result.json");
  const result = JSON.parse(json) as SpikeResult;

  it("round3-result.json は結果ブロックの往復で壊れずに読める。origin の結果を持つ", () => {
    expect(extractResultBlock(formatResultBlock(result))).toEqual(result);
    expect(result.schemaVersion).toBe(1);
    expect(result.experiments).toEqual(["origin"]);
    expect(result.origin).toBeDefined();
    expect(result.origin!.records).toHaveLength(6);
    expect(result.cleanup?.ok).toBe(true);
  });

  it("結果 JSON に、マスク前の値(IPv4・workers.dev のサブドメイン・Worker 名)が入っていない(公開される JSON)", () => {
    expect(json).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(json).not.toMatch(/[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.workers\.dev/);
    expect(json).not.toMatch(/keiba-cf-spike-\d+-\d+/);
    expect(json).toContain("<subdomain>.workers.dev");
  });

  it("report.md の第3ラウンドの生成節は、round3-result.json から今の renderMarkdown で作った内容と完全に一致する", () => {
    const report = read("docs", "investigations", "cloudflare-spike", "report.md");
    const expected = demoteHeadings(renderMarkdown(result), 3).trim();
    expect(extractGeneratedBlock(report, "round3")).toBe(expected);
    expect(expected.length).toBeGreaterThan(500);
    // 読みの本文が、結果 JSON の結論と一致している(生成節の中に結論が出ている)
    expect(expected).toContain("ヘッダが原因の疑いが強い");
  });

  it("第2ラウンドの生成節は、第3ラウンドの節を足しても、従来どおり round2-result.json と一致する", () => {
    const report = read("docs", "investigations", "cloudflare-spike", "report.md");
    const r2 = JSON.parse(read("docs", "investigations", "cloudflare-spike", "round2-result.json")) as SpikeResult;
    expect(extractGeneratedBlock(report)).toBe(demoteHeadings(renderMarkdown(r2), 2).trim());
  });
});

describe("report.md の手書き本文(第3ラウンド)が、結果 JSON と食い違っていない", () => {
  const report = read("docs", "investigations", "cloudflare-spike", "report.md");
  const result = JSON.parse(read("docs", "investigations", "cloudflare-spike", "round3-result.json")) as SpikeResult;
  /** 手書きの節(§7)の、生成節の外の本文。 */
  const handwritten = (): string => {
    const marker = generatedMarkers("round3");
    const start = report.indexOf("## 7. 第3ラウンド");
    expect(start).toBeGreaterThanOrEqual(0);
    const section = report.slice(start);
    const a = section.indexOf(marker.begin);
    const b = section.indexOf(marker.end) + marker.end.length;
    return section.slice(0, a) + section.slice(b);
  };

  it("E2 で付けたヘッダの名前は、すべて手書きの本文(§7.3)に書かれている(名前の書き漏らし・書き間違いを防ぐ)", () => {
    const names = result.origin!.e2.sent.map((h) => h.name);
    expect(names.length).toBeGreaterThan(0);
    const text = handwritten();
    for (const name of names) {
      expect(text, `ヘッダ ${name}`).toContain(`\`${name}\``);
    }
  });

  it("手書きの『ランナーにだけ現れたヘッダ』『値だけ違うヘッダ』の名前が、結果 JSON の差分と一致している", () => {
    const diff = result.origin!.echo.diff!;
    const text = handwritten();
    for (const name of diff.runnerOnly) {
      expect(text, `ランナーのみ ${name}`).toContain(`\`${name}\``);
    }
    for (const v of diff.valueDiffers) {
      expect(text, `値の差 ${v.name}`).toContain(`\`${v.name}\``);
    }
  });

  it("結論の節に、事実・推測・分離できないもの・限界が分けて書かれ、結論が『ヘッダが原因の疑いが強い』である", () => {
    const text = handwritten();
    for (const heading of ["### 7.3 事実", "### 7.4 推測・未確認", "### 7.5 分離できないもの", "### 7.6 この結果の限界", "### 7.7 #21 への含意"]) {
      expect(text, heading).toContain(heading);
    }
    expect(result.origin!.conclusion).toBe("header-suspected");
    expect(text).toContain("header-suspected");
    expect(text).toContain("分離できない");
  });

  it("#159 の時点の『400 の原因は未切り分け』という断定が、現在の結論として残っていない(第3ラウンドの更新を反映している)", () => {
    expect(report).not.toMatch(/\*\*400 の原因は未切り分け。\*\*/);
    expect(report).toContain("第3ラウンド(§7)で切り分けを行い");
  });

  it("『ワークフローの起動』の節が、今の既定(origin)と実験の選び方を説明している", () => {
    const start = report.indexOf("### ワークフローの起動");
    const end = report.indexOf("### 結果の取り出しと report の生成");
    const section = report.slice(start, end);
    for (const word of ["SPIKE_EXPERIMENTS", "experiments", "origin", "reachability", "cpu", "同時に選べない"]) {
      expect(section, word).toContain(word);
    }
    // 起動条件(件名の先頭の印)は #159 のまま
    expect(section).toContain("[CF-SPIKE]");
  });
});
