/**
 * Issue #315: 近似確認(サブエージェントを LLM の代わりにした出力)の応答テキストを、本番の解析にかけて観察項目を出す。
 * **実 API・ネットワークには出ない。**
 *
 * 使い方(リポジトリルートで):
 *   pnpm tsx scripts/check-llm-approx-response.ts --facts <print-analysis-prompt の出力先>/S1-facts.json --response <応答のファイル>
 *   (--response を複数回、または --dir <応答のディレクトリ> で `<S>.txt`(S0〜S6)を一括)
 * 終了コード: 解析できた(ok・mark-violation)なら 0、本番ではフォールバックになる応答(unusable)があれば 3。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkResponse, formatReport } from "./analysis-approx/check.js";
import type { ScenarioFacts } from "./analysis-approx/scenarios.js";

function main(): number {
  const argv = process.argv.slice(2);
  const pairs: Array<{ factsPath: string; responsePath: string }> = [];
  let facts: string | null = null;
  let factsDir: string | null = null;
  let dir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--facts") facts = argv[++i] ?? null;
    else if (argv[i] === "--facts-dir") factsDir = argv[++i] ?? null;
    else if (argv[i] === "--response" && facts !== null) pairs.push({ factsPath: facts, responsePath: argv[++i] ?? "" });
    else if (argv[i] === "--dir") dir = argv[++i] ?? null;
    else throw new Error(`知らない引数、または --facts より前の --response: ${argv[i]}`);
  }
  if (dir !== null) {
    if (factsDir === null) throw new Error("--dir には --facts-dir <facts.json のあるディレクトリ> が要る");
    for (const f of readdirSync(dir).filter((n) => /^S[0-6]\.txt$/.test(n)).sort()) {
      const id = f.replace(/\.txt$/, "");
      pairs.push({ factsPath: path.join(factsDir, `${id}-facts.json`), responsePath: path.join(dir, f) });
    }
  }
  if (pairs.length === 0) throw new Error("確認する応答が無い(--facts と --response、または --dir と --facts-dir)");
  let unusable = 0;
  for (const p of pairs) {
    const f = JSON.parse(readFileSync(p.factsPath, "utf-8")) as ScenarioFacts;
    const report = checkResponse(readFileSync(p.responsePath, "utf-8"), f);
    if (report.outcome === "unusable") unusable += 1;
    console.log(`${formatReport(report, f)}\n`);
  }
  console.log(`確認した応答 ${pairs.length} 件のうち、本番ではフォールバックになる応答: ${unusable} 件`);
  return unusable > 0 ? 3 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
