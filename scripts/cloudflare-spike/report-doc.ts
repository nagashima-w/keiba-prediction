/**
 * report.md への、生成した節の差し込み(Issue #159〈#21-A〉)。
 *
 * report.md の数値は、結果 JSON から `renderMarkdown` で生成し、**手で書き写さない**(書き写しの誤りを
 * 構造的に防ぐ)。生成した節は、下の印の間に置く。印の外(結論・含意・再現手順)は手で書く。
 */

export const GENERATED_BEGIN = "<!-- GENERATED:BEGIN(render-report.ts が生成。手で編集しない) -->";
export const GENERATED_END = "<!-- GENERATED:END -->";

function locate(doc: string): { start: number; contentStart: number; end: number; afterEnd: number } {
  const start = doc.indexOf(GENERATED_BEGIN);
  const end = doc.indexOf(GENERATED_END);
  if (start < 0 || end < 0) {
    throw new Error("report の生成節の開始印または終了印が見つかりません");
  }
  if (doc.indexOf(GENERATED_BEGIN, start + 1) >= 0 || doc.indexOf(GENERATED_END, end + 1) >= 0) {
    throw new Error("report の生成節の印が複数あります");
  }
  if (end < start) {
    throw new Error("report の生成節の終了印が開始印より前にあります");
  }
  return {
    start,
    contentStart: start + GENERATED_BEGIN.length,
    end,
    afterEnd: end + GENERATED_END.length,
  };
}

/** 印の間を `generated` に差し替える。前後の文章は変えない。印が不正なら例外。 */
export function replaceGeneratedBlock(doc: string, generated: string): string {
  const { contentStart, end } = locate(doc);
  return `${doc.slice(0, contentStart)}\n${generated.trim()}\n${doc.slice(end)}`;
}

/** 印の間の内容(前後の改行を除く)を返す。 */
export function extractGeneratedBlock(doc: string): string {
  const { contentStart, end } = locate(doc);
  return doc.slice(contentStart, end).trim();
}

/** Markdown の見出し(行頭の # が1〜6個 + 空白)の # を `by` 個増やす(6個で止める)。 */
export function demoteHeadings(markdown: string, by: number): string {
  return markdown
    .split("\n")
    .map((line) => {
      const m = /^(#{1,6})( .*)$/.exec(line);
      if (m === null) {
        return line;
      }
      return `${"#".repeat(Math.min(6, m[1]!.length + by))}${m[2]}`;
    })
    .join("\n");
}
