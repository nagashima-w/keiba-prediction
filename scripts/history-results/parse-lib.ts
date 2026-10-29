/**
 * 取得済みの raw(結果ページ)を読んで、NDJSON(gzip)を書く(parse の本体)。Issue #532 段階 1。開発用。ネットワークには出ない。
 *
 * - 入力: `<dir>/raw/result/*.html.gz`(中央)と `<dir>/raw/nar/result/*.html.gz`(地方。交流重賞のみ)。
 * - 出力: 1 行 1 レース(`build-record.ts` の `RaceRecord`。`kind` で中央/地方を区別)。日付・race_id の順に並べる。
 * - 読めなかったページは出力に入れず、理由の分類つきで数え、`<out>.rejects.ndjson` に 1 件ずつ残す。最後に件数を出す。
 * - 読めたレースのうち注意が要るものは件数で報告する(頭数の食い違い・地方で Jpn でない格・ヘッダに無かった列・位置がずれた行・
 *   数値にできなかった増減/タイム)。これらは出力から落とさない(生の文字列も行に残している)。
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { isJpnGrade } from "../../packages/core/src/scraper/jpn-grade.js";
import { buildRaceRecord, type RaceRecord, type RejectCategory } from "./build-record.js";
import { rawFilePath, rawResultDir, type Kind } from "./layout.js";

export interface ParseOptions {
  readonly dir: string;
  readonly outFile: string;
  readonly log: (message: string) => void;
}

export interface ParseSummary {
  total: number;
  ok: number;
  rejected: number;
  rejectedByCategory: Record<string, number>;
  byKind: Record<Kind, number>;
  notes: {
    /** 宣言された頭数と結果の行数が違うレース。 */
    fieldSizeMismatch: number;
    /** 地方で格が Jpn1〜3 でないレース(取得は Jpn に絞っているので 0 のはず)。 */
    narNotJpn: number;
    /** ヘッダに無かった列があるレース(地方は通過順の列が無いので全件が該当)。 */
    missingColumnRaces: number;
    /** セル数がヘッダと合わず、位置で読む項目が null になった行を含むレース。 */
    misalignedRaces: number;
    /** 馬体重の増減が空でないのに数値にできなかった馬の数。 */
    bodyWeightDiffNonNumeric: number;
    /** タイムが空でないのに秒にできなかった馬の数。 */
    timeNonNumeric: number;
    /** 馬 ID・騎手 ID・調教師 ID が読めなかった馬の数(それぞれ)。 */
    horseIdMissing: number;
    jockeyIdMissing: number;
    trainerIdMissing: number;
  };
}

interface Reject {
  readonly kind: Kind;
  readonly raceId: string;
  readonly category: RejectCategory;
  readonly detail: string;
}

function atomicWrite(file: string, data: Buffer | string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 一時ファイルが無いなら何もしない
    }
    throw e;
  }
}

function listRaw(dir: string, kind: Kind): string[] {
  try {
    return readdirSync(rawResultDir(dir, kind))
      .filter((f) => f.endsWith(".html.gz"))
      .map((f) => f.slice(0, -".html.gz".length))
      .sort();
  } catch {
    return [];
  }
}

export function runParse(opts: ParseOptions): ParseSummary {
  const records: RaceRecord[] = [];
  const rejects: Reject[] = [];
  const summary: ParseSummary = {
    total: 0,
    ok: 0,
    rejected: 0,
    rejectedByCategory: {},
    byKind: { central: 0, nar: 0 },
    notes: { fieldSizeMismatch: 0, narNotJpn: 0, missingColumnRaces: 0, misalignedRaces: 0, bodyWeightDiffNonNumeric: 0, timeNonNumeric: 0, horseIdMissing: 0, jockeyIdMissing: 0, trainerIdMissing: 0 },
  };

  const kinds: Kind[] = ["central", "nar"];
  const todo = kinds.flatMap((kind) => listRaw(opts.dir, kind).map((raceId) => ({ kind, raceId })));
  opts.log(`raw の結果ページ ${todo.length} 件を読みます(中央 ${todo.filter((t) => t.kind === "central").length}・地方 ${todo.filter((t) => t.kind === "nar").length})`);

  for (const { kind, raceId } of todo) {
    summary.total += 1;
    let html: string;
    try {
      html = gunzipSync(readFileSync(rawFilePath(opts.dir, kind, "result", raceId))).toString("utf8");
    } catch (e) {
      rejects.push({ kind, raceId, category: "gzip失敗", detail: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const r = buildRaceRecord(html, raceId, kind);
    if (!r.ok) {
      rejects.push({ kind, raceId, category: r.category, detail: r.detail });
      continue;
    }
    const rec = r.record;
    records.push(rec);
    if (rec.fieldSizeDeclared !== null && rec.fieldSizeDeclared !== rec.horses.length) summary.notes.fieldSizeMismatch += 1;
    if (kind === "nar" && !isJpnGrade(rec.grade ?? undefined)) summary.notes.narNotJpn += 1;
    if (rec.missingColumns.length > 0) summary.notes.missingColumnRaces += 1;
    if (rec.horses.some((h) => !h.cellsAligned)) summary.notes.misalignedRaces += 1;
    for (const h of rec.horses) {
      if (h.bodyWeightDiffRaw !== null && h.bodyWeightDiffRaw !== "" && h.bodyWeightDiff === null) summary.notes.bodyWeightDiffNonNumeric += 1;
      if (h.timeRaw !== null && h.timeRaw !== "" && h.timeSec === null) summary.notes.timeNonNumeric += 1;
      if (h.horseId === null) summary.notes.horseIdMissing += 1;
      if (h.jockeyId === null) summary.notes.jockeyIdMissing += 1;
      if (h.trainerId === null) summary.notes.trainerIdMissing += 1;
    }
    if (summary.total % 1000 === 0) {
      opts.log(`  ${summary.total}/${todo.length} 件目(読めた ${records.length}・読めない ${rejects.length})`);
    }
  }

  records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.raceId < b.raceId ? -1 : a.raceId > b.raceId ? 1 : a.kind < b.kind ? -1 : 1));
  const lines = records.map((r) => JSON.stringify(r));
  atomicWrite(opts.outFile, gzipSync(Buffer.from(lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8")));
  atomicWrite(`${opts.outFile}.rejects.ndjson`, rejects.map((r) => `${JSON.stringify(r)}\n`).join(""));

  summary.ok = records.length;
  summary.rejected = rejects.length;
  for (const r of rejects) {
    summary.rejectedByCategory[r.category] = (summary.rejectedByCategory[r.category] ?? 0) + 1;
  }
  for (const r of records) {
    summary.byKind[r.kind] += 1;
  }

  opts.log(`読めた ${summary.ok}(中央 ${summary.byKind.central}・地方 ${summary.byKind.nar})・読めない ${summary.rejected}(全 ${summary.total} 件)`);
  for (const [category, n] of Object.entries(summary.rejectedByCategory)) {
    const sample = rejects.filter((r) => r.category === category).slice(0, 5).map((r) => r.raceId);
    opts.log(`  読めない理由 ${category}: ${n} 件(例: ${sample.join(", ")})`);
  }
  const n = summary.notes;
  opts.log(
    `注意(出力には入れた): 頭数の食い違い ${n.fieldSizeMismatch}・地方で Jpn でない ${n.narNotJpn}・列が欠けたレース ${n.missingColumnRaces}・` +
      `セル数がずれた行を含むレース ${n.misalignedRaces}・増減が数値でない馬 ${n.bodyWeightDiffNonNumeric}・タイムが数値でない馬 ${n.timeNonNumeric}・` +
      `ID が読めなかった馬(馬 ${n.horseIdMissing}・騎手 ${n.jockeyIdMissing}・調教師 ${n.trainerIdMissing})`,
  );
  opts.log(`出力: ${opts.outFile}(読めなかったものの一覧: ${opts.outFile}.rejects.ndjson)`);
  return summary;
}

export const PARSE_USAGE = "使い方: pnpm tsx scripts/history-results/parse.ts <fetch の出力ディレクトリ> --out <file.ndjson.gz>";

export type ParsedParseArgs =
  | { readonly ok: true; readonly value: { dir: string; outFile: string } }
  | { readonly ok: false; readonly message: string };

export function parseParseArgs(argv: readonly string[]): ParsedParseArgs {
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
