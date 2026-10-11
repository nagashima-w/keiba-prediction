/**
 * report.md への、生成した節の差し込み(Issue #159〈#21-A〉)。
 *
 * report.md の数値は、結果 JSON から `renderMarkdown` で生成し、**手で書き写さない**(書き写しの誤りを
 * 構造的に防ぐ)。生成した節は、下の印の間に置く。印の外(結論・含意・再現手順)は手で書く。
 */

export const GENERATED_BEGIN = "<!-- GENERATED:BEGIN(render-report.ts が生成。手で編集しない) -->";
export const GENERATED_END = "<!-- GENERATED:END -->";

/**
 * 生成節の印。名前なしは第2ラウンド(#159)の節の印(従来のまま)。**名前つき**(Issue #160 の第3ラウンドは `round3`)は、
 * 1つの report.md に、別の結果 JSON から作った節を並べるための印で、名前なしの印とは文字列として一致しない
 * (`BEGIN(` の直前に ` <名前>` が入る)。
 */
export function generatedMarkers(name?: string): { begin: string; end: string } {
  if (name === undefined) {
    return { begin: GENERATED_BEGIN, end: GENERATED_END };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`生成節の名前が不正です(英数字・ハイフン・アンダースコアのみ): ${JSON.stringify(name)}`);
  }
  return {
    begin: `<!-- GENERATED:BEGIN ${name}(render-report.ts が生成。手で編集しない) -->`,
    end: `<!-- GENERATED:END ${name} -->`,
  };
}

function locate(doc: string, name?: string): { start: number; contentStart: number; end: number; afterEnd: number } {
  const markers = generatedMarkers(name);
  const start = doc.indexOf(markers.begin);
  const end = doc.indexOf(markers.end);
  if (start < 0 || end < 0) {
    throw new Error("report の生成節の開始印または終了印が見つかりません");
  }
  if (doc.indexOf(markers.begin, start + 1) >= 0 || doc.indexOf(markers.end, end + 1) >= 0) {
    throw new Error("report の生成節の印が複数あります");
  }
  if (end < start) {
    throw new Error("report の生成節の終了印が開始印より前にあります");
  }
  return {
    start,
    contentStart: start + markers.begin.length,
    end,
    afterEnd: end + markers.end.length,
  };
}

/** 印の間を `generated` に差し替える(name を指定すれば、その名前の節)。前後の文章は変えない。印が不正なら例外。 */
export function replaceGeneratedBlock(doc: string, generated: string, name?: string): string {
  const { contentStart, end } = locate(doc, name);
  return `${doc.slice(0, contentStart)}\n${generated.trim()}\n${doc.slice(end)}`;
}

/** 印の間の内容(前後の改行を除く)を返す。 */
export function extractGeneratedBlock(doc: string, name?: string): string {
  const { contentStart, end } = locate(doc, name);
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
