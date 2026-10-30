/**
 * 取得済みの raw(血統ページ)を読んで、NDJSON(gzip)を書く(parse の本体)。Issue #542 手順 2。開発用。ネットワークには出ない。
 *
 * - 入力: `<dir>/raw/ped/*.html.gz`(ファイル名が馬 ID)。
 * - 出力: 1 行 1 頭(`PedigreeRecord`)。馬 ID の昇順。リンクが欠けた祖先は id が null で、理由が `issues` に載る(行は落とさない)。
 * - 読めなかったページ(表なし・木の構造不正・馬ID不一致・gzip失敗)は出力に入れず、理由の分類つきで数え、`<out>.rejects.ndjson` に 1 件ずつ残す。
 * - 最後に、国名の種類ごとの件数を出す(想定外の値に気づけるように)。
 */

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { atomicWrite } from "../history-results/fetch-lib.js";
import { rawPedDir, rawPedPath } from "./layout.js";
import { parsePedigreeHtml, type PedigreeRecord, type PedRejectCategory } from "./pedigree-html.js";

export interface PedParseOptions {
  readonly dir: string;
  readonly outFile: string;
  readonly log: (message: string) => void;
}

export interface PedParseSummary {
  total: number;
  ok: number;
  rejected: number;
  rejectedByCategory: Record<string, number>;
  /** issues が空でない行の数。 */
  rowsWithIssues: number;
  /** 6 人の祖先に付いていた国名ごとの件数。 */
  countryCounts: Record<string, number>;
}

interface Reject {
  readonly horseId: string;
  readonly category: PedRejectCategory;
  readonly detail: string;
}

const ROLES = ["sire", "dam", "sireSire", "sireDam", "damSire", "damDam"] as const;

function listRaw(dir: string): string[] {
  try {
    return readdirSync(rawPedDir(dir))
      .filter((f) => f.endsWith(".html.gz"))
      .map((f) => f.slice(0, -".html.gz".length))
      .sort();
  } catch {
    return [];
  }
}

export function runPedParse(opts: PedParseOptions): PedParseSummary {
  const records: PedigreeRecord[] = [];
  const rejects: Reject[] = [];
  const summary: PedParseSummary = { total: 0, ok: 0, rejected: 0, rejectedByCategory: {}, rowsWithIssues: 0, countryCounts: {} };

  const todo = listRaw(opts.dir);
  opts.log(`raw の血統ページ ${todo.length} 件を読みます`);
  for (const horseId of todo) {
    summary.total += 1;
    let html: string;
    try {
      html = gunzipSync(readFileSync(rawPedPath(opts.dir, horseId))).toString("utf8");
    } catch (e) {
      rejects.push({ horseId, category: "gzip失敗", detail: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const r = parsePedigreeHtml(html, horseId);
    if (!r.ok) {
      rejects.push({ horseId, category: r.category, detail: r.detail });
      continue;
    }
    records.push(r.record);
    if (r.record.issues.length > 0) summary.rowsWithIssues += 1;
    for (const role of ROLES) {
      const c = r.record[role].country;
      if (c !== null) summary.countryCounts[c] = (summary.countryCounts[c] ?? 0) + 1;
    }
  }

  records.sort((a, b) => (a.horseId < b.horseId ? -1 : a.horseId > b.horseId ? 1 : 0));
  const lines = records.map((r) => JSON.stringify(r));
  mkdirSync(path.dirname(opts.outFile), { recursive: true });
  atomicWrite(opts.outFile, gzipSync(Buffer.from(lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8")));
  atomicWrite(`${opts.outFile}.rejects.ndjson`, Buffer.from(rejects.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8"));

  summary.ok = records.length;
  summary.rejected = rejects.length;
  for (const r of rejects) summary.rejectedByCategory[r.category] = (summary.rejectedByCategory[r.category] ?? 0) + 1;

  opts.log(`読めた ${summary.ok}・読めない ${summary.rejected}(全 ${summary.total} 件)`);
  for (const [category, n] of Object.entries(summary.rejectedByCategory)) {
    const sample = rejects.filter((r) => r.category === category).slice(0, 5).map((r) => r.horseId);
    opts.log(`  読めない理由 ${category}: ${n} 件(例: ${sample.join(", ")})`);
  }
  opts.log(`注意(出力には入れた): issues のある行 ${summary.rowsWithIssues}`);
  opts.log(`国名の件数(6 人の祖先): ${Object.entries(summary.countryCounts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([c, n]) => `${c} ${n}`).join("・") || "なし"}`);
  opts.log(`出力: ${opts.outFile}(読めなかったものの一覧: ${opts.outFile}.rejects.ndjson)`);
  return summary;
}

export const PED_PARSE_USAGE = "使い方: pnpm tsx scripts/pedigree/parse.ts <fetch の出力ディレクトリ> --out <file.ndjson.gz>";

export type ParsedPedParseArgs =
  | { readonly ok: true; readonly value: { dir: string; outFile: string } }
  | { readonly ok: false; readonly message: string };

export function parsePedParseArgs(argv: readonly string[]): ParsedPedParseArgs {
  let outFile: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") outFile = argv[++i];
    else if (a.startsWith("--")) return { ok: false, message: `知らない引数です: ${a}` };
    else positional.push(a);
  }
  if (positional.length !== 1) return { ok: false, message: "ディレクトリをちょうど 1 つ指定してください" };
  if (outFile === undefined || outFile === "") return { ok: false, message: "--out は必須です" };
  return { ok: true, value: { dir: positional[0]!, outFile } };
}
