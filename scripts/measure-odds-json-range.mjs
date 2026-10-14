#!/usr/bin/env node
/**
 * measure-odds-json-range — 中央競馬オッズフィクスチャ(JSON)の実測レンジ検査(Issue #74)。
 *
 * `docs/versioning.md` の「次の正式版が 1.6.3 である根拠」セクションが主張する
 * 「コミット済み全フィクスチャで 1.0 未満のオッズは1件も無い」を、誰が実行しても同じ数を
 * 再現できる形で固定するためのスクリプト(NAR側は `measure-nar-odds-range.mjs` を参照)。
 *
 * ## 抽出規則
 *
 * `fixtures/odds_*.json`(`data` が空文字列の発売前フィクスチャ2件は対象外)の
 * `data.odds[betType][id]` が持つ配列(例: `["9.0","0.0","5"]`)の**全要素**
 * (index 0=オッズ本体、index 1=複勝・ワイドは上限/単勝・三連複は埋め草、index 2=人気/組番)を
 * 数値化して走査する。id(馬番または組合せキー)ごとに1エントリ、要素ごとに1数値として数える
 * (「馬番/組数」は id の個数、「数値」は要素の個数)。桁区切りカンマは除去してから数値化する。
 *
 * 使い方: `node scripts/measure-odds-json-range.mjs`
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = new URL("../fixtures", import.meta.url).pathname;

const BET_TYPE_LABELS = {
  "1": "単勝",
  "2": "複勝下限",
  "5": "ワイド下限",
  "7": "三連複",
};

function main() {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => /^odds_.*\.json$/.test(f))
    .sort();

  const byType = {};
  let skipped = [];

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
    const odds = raw?.data?.odds;
    if (!odds || typeof odds !== "object") {
      skipped.push(file);
      continue;
    }
    for (const betType of Object.keys(odds)) {
      const table = odds[betType];
      let ids = 0;
      let values = 0;
      let min0 = Infinity;
      let below1 = 0;
      for (const id of Object.keys(table)) {
        const arr = table[id];
        if (!Array.isArray(arr)) continue;
        ids++;
        arr.forEach((v, idx) => {
          const n = Number(String(v).replace(/,/g, ""));
          if (!Number.isFinite(n)) return;
          values++;
          if (idx === 0 && n < min0) min0 = n;
          if (n > 0 && n < 1) below1++;
        });
      }
      byType[betType] = byType[betType] || [];
      byType[betType].push({ file, ids, values, min0, below1 });
    }
  }

  console.log("=== 券種ごとの内訳(ファイルごと) ===");
  for (const betType of Object.keys(byType)) {
    console.log(`betType=${betType}(${BET_TYPE_LABELS[betType] ?? "不明"})`);
    for (const row of byType[betType]) {
      console.log(
        `  ${row.file}: 馬番/組数=${row.ids} 数値=${row.values} index0最小値=${row.min0} (0,1)内=${row.below1}`,
      );
    }
  }
  console.log("=== 対象外(dataが空文字列等) ===");
  console.log(skipped.length > 0 ? skipped.join(", ") : "なし");

  let totalBelow1 = 0;
  for (const betType of Object.keys(byType)) {
    for (const row of byType[betType]) totalBelow1 += row.below1;
  }
  console.log("=== 合計 ===");
  console.log(`(0,1)に入る値(全券種・全index)=${totalBelow1}`);
}

main();
