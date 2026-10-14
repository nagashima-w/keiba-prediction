#!/usr/bin/env node
/**
 * measure-nar-odds-range — 地方競馬(NAR)オッズフィクスチャの実測レンジ検査(Issue #74)。
 *
 * `docs/versioning.md` の「次の正式版が 1.6.3 である根拠」セクションが主張する
 * 「コミット済み全フィクスチャで 1.0 未満のオッズは1件も無い」を、誰が実行しても同じ数を
 * 再現できる形で固定するためのスクリプト。
 *
 * ## 抽出規則(このスクリプトが「セル値」として何を数えるか)
 *
 * `fixtures/nar_odds_*.html` の各ファイルについて、開始タグの `class` 属性が単語境界で
 * "Odds" を含む要素(`<td class="Odds">`・`<span class="Odds ">` のいずれも該当する。
 * `Graph_Odds`・`IconOdds` のような「Odds を含むが独立した単語ではない」class は
 * 正規表現の単語境界 `\bOdds\b` により除外される)を走査し、その**開始タグ直後から
 * 次の `<` までのテキスト**(子要素を挟まず直接のテキストノードのみ)を1セル値として拾う。
 *
 * この規則がネスト構造(`<td class="Odds"><span class="Odds ">24.8</span></td>` のような
 * b1形式)でも二重計上にならない理由: 外側の `<td class="Odds">` の「開始タグ直後から次の
 * `<` まで」は空文字列(次の文字が `<span`)になり、数値として採用されない。内側の
 * `<span class="Odds ">` の同区間が実際の値("24.8")を持つ。b5(ワイド)・b7(三連複)は
 * `<td class="Odds" ...>` 直下にテキストが直接あり(ネストされた span を持たない)、
 * そのテキストがそのまま採用される。
 *
 * レンジ表現(例 "41.9 - 42.8")は `-` で分割し、両端をそれぞれ1個の数値として数える
 * (下限・上限の両方を検査対象に含めるため)。桁区切りカンマ(例 "1,014.5")は除去してから
 * 数値化する。
 *
 * 使い方: `node scripts/measure-nar-odds-range.mjs`
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = new URL("../fixtures", import.meta.url).pathname;

function extractCellValues(html) {
  // 開始タグ(class属性がOddsを単語境界で含む)を見つけ、その直後から次の "<" までを
  // テキストとして拾う。s フラグ(dotAll)で改行を跨いだテキストノードにも対応する。
  const tagPattern = /<[a-zA-Z]+\b[^>]*\bclass="[^"]*\bOdds\b[^"]*"[^>]*>([^<]*)/gs;
  const values = [];
  let m;
  while ((m = tagPattern.exec(html)) !== null) {
    const text = m[1].trim();
    if (text === "") continue;
    values.push(text);
  }
  return values;
}

function numbersFromCellText(text) {
  // レンジ表現("41.9 - 42.8")は両端を、単一値("209.3")はそのまま1個を返す。
  // ハイフンの前後に空白があるものだけをレンジ区切りとみなす(桁区切りカンマは別処理)。
  return text
    .split(/\s*-\s*/)
    .map((part) => part.replace(/,/g, "").trim())
    .filter((part) => part !== "")
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n));
}

function main() {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => /^nar_odds_.*\.html$/.test(f))
    .sort();

  let totalCount = 0;
  let globalMin = Infinity;
  let below1Count = 0;
  const perFile = [];

  for (const file of files) {
    const html = readFileSync(join(FIXTURES_DIR, file), "utf8");
    const cellTexts = extractCellValues(html);
    let fileCount = 0;
    let fileMin = Infinity;
    let fileBelow1 = 0;
    for (const text of cellTexts) {
      for (const n of numbersFromCellText(text)) {
        fileCount++;
        totalCount++;
        if (n < fileMin) fileMin = n;
        if (n < globalMin) globalMin = n;
        if (n > 0 && n < 1) {
          fileBelow1++;
          below1Count++;
        }
      }
    }
    perFile.push({ file, cells: cellTexts.length, values: fileCount, min: fileMin, below1: fileBelow1 });
  }

  console.log("=== ファイルごとの内訳 ===");
  for (const row of perFile) {
    console.log(
      `${row.file}: セル数=${row.cells} 数値=${row.values} 最小値=${row.min} (0,1)内=${row.below1}`,
    );
  }
  console.log("=== 合計 ===");
  console.log(`ファイル数=${files.length}`);
  console.log(`総数値=${totalCount}`);
  console.log(`最小値=${globalMin}`);
  console.log(`(0,1)に入る値=${below1Count}`);
}

main();
