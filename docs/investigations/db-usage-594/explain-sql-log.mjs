// Issue #612: 記録した SQL(1 行 1 件の JSON 文字列)に EXPLAIN QUERY PLAN をかける。
// 使い方: node --no-warnings explain-sql-log.mjs <記録ファイル> > explain-plans.txt
// 空の SQLite に cloud/migrations を順に当てて使う(本番の D1 に sqlite_stat1 は無いので、統計なしの空の DB と計画の条件が同じ)。
// 記録ファイルは、cloud/test/local-bindings.ts の `db.prepare` を一時的に包んで SQL を追記し、cloud のテストの一部を流して作る(手順は db-usage-594.md の付録)。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const db = new DatabaseSync(":memory:");
const migrations = path.join(root, "cloud/migrations");
for (const f of fs.readdirSync(migrations).sort()) db.exec(fs.readFileSync(path.join(migrations, f), "utf8"));

// 本番のコードに由来する SQL だけに絞る: 先頭 45 文字が cloud/src または core の codec に現れるもの(テスト専用の SQL を除く。先頭の一致だけなので、末尾が違うテスト専用の SQL が混ざることはある)
const src = execSync(`cat ${root}/cloud/src/*.ts ${root}/packages/core/src/ev/analysis-store-codec.ts`, { maxBuffer: 1 << 28 }).toString().replace(/\s+/g, " ");
const norm = (q) => q.replace(/\s+/g, " ").trim();
const shape = (q) =>
  norm(q)
    .replace(/IN \((?:'[^']*'|\d+|\?)(?:, ?(?:'[^']*'|\d+|\?))*\)/g, "IN (…)")
    .replace(/(VALUES )(\([?, ]+\)(?:, ?\([?, ]+\))*)/g, "$1(…)")
    .replace(/'[0-9]{8,12}'/g, "'<id>'")
    .replace(/\b\d{4,}\b/g, "<n>");
const seen = new Map();
for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean)) {
  let q;
  try { q = JSON.parse(line); } catch { continue; }
  if (!src.includes(norm(q).slice(0, 45))) continue;
  const s = shape(q);
  if (!seen.has(s)) seen.set(s, { q, n: 0 });
  seen.get(s).n += 1;
}
let count = 0;
for (const [s, { q, n }] of seen) {
  if (!/^(SELECT|WITH|UPDATE|INSERT|DELETE|REPLACE)/i.test(q.replace(/--[^\n]*/g, "").trim())) continue;
  if (/^\s*DELETE FROM \w+\s*$/i.test(q)) continue; // テストの後始末(全行削除)
  let plan;
  try { plan = db.prepare("EXPLAIN QUERY PLAN " + q).all().map((r) => r.detail); } catch (e) { plan = ["ERR " + e.message.slice(0, 80)]; continue; }
  const flags = plan.filter((p) => (p.startsWith("SCAN") && !/json_each|VALUES CLAUSE|CONSTANT ROW/.test(p)) || p.includes("TEMP B-TREE") || p.includes("AUTOMATIC"));
  // UPDATE … FROM (SELECT … FROM json_each(?)) で、表の SEARCH が外側・json_each の SCAN が内側のループになる形(行数の 2 乗で読む)
  for (let i = 1; i < plan.length; i += 1) {
    if (/^UPDATE/i.test(q.trim()) && plan[i].startsWith("SCAN json_each") && plan[i - 1].startsWith("SEARCH")) flags.push("json_each が内側のループ(行数の 2 乗で読む): " + plan[i - 1]);
  }
  count += 1;
  console.log(`## ${s.slice(0, 220)}\n   記録した回数(テスト内): ${n}${flags.length ? "\n   注意: " + flags.join(" / ") : ""}`);
  for (const p of plan) console.log("   " + p);
}
console.error(`SQL の型 ${seen.size} 件のうち、EXPLAIN した ${count} 件`);
