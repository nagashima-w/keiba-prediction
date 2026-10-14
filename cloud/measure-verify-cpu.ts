/**
 * 移行ファイルの検証(`verifyMigrationFile`)のうち、深い入れ子の検出(`assertDetailSerializable`。Issue #309)が足す CPU 時間の測定。
 * **コミット済みのスクリプトから再現できる**形で残す(再現手段の無い数値を JSDoc・報告に書かないため)。実 API・netkeiba・本番には出ない(Node 上の純関数だけ)。
 *
 * 測るもの(1 回 = 分析 N 件のファイルの検証 1 回。CPU = `process.cpuUsage()` の user+system の差):
 *   verify     `verifyMigrationFile` 全体(gzip 展開・行の解釈と値の検証・取り込みの変換・再直列化の検出を含む)
 *   serialize  `assertDetailSerializable` だけ(同じ N 件の `toAnalysisImport` の結果に対して、検出の部分だけ)
 *   serialize / verify が、検出が足す割合(検証は `JSON.parse` を同じ列に対して既に 1 回やっているので、同じ桁になる)。
 *
 * 使い方(cloud/ で): `pnpm tsx measure-verify-cpu.ts [--analyses 2225] [--snapshot-bytes 10000] [--repeats 5]`
 *
 * 限界: Node の CPU の速度での値で、workerd(本番の DO)とは一致する保証がない。値は実行ごとにばらつく(最小・中央値・最大で報告する)ので、
 * 実行間の下位桁の差に意味を読まないこと。合成ファイルのスナップショットの大きさは引数で決めた値で、実データの大きさではない。
 */
import { gzipSync } from "node:zlib";
import { parseMigrationLine, type MigrationAnalysisLine } from "../packages/core/src/ev/cloud-migration-format";
import { assertDetailSerializable, toAnalysisImport } from "./src/migration-convert";
import { verifyMigrationFile } from "./src/migration-verify";
import { GOLDEN_ANALYSES } from "./test/migration-fixture";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isInteger(v) || v < 1) throw new Error(`--${name} は 1 以上の整数`);
  return v;
}

const ANALYSES = arg("analyses", 2225);
const SNAPSHOT_BYTES = arg("snapshot-bytes", 10_000);
const REPEATS = arg("repeats", 5);
const HORSES = 16;

/** 目標の大きさ(JSON.stringify 後のバイト数)に近い、浅い(深さ 3)スナップショットの JSON 文字列。 */
function snapshotJson(bytes: number): string {
  const entries: unknown[] = [];
  let size = 2;
  for (let i = 0; size < bytes; i += 1) {
    const entry = { umaban: (i % 18) + 1, name: `馬${i}`, jockey: `騎手${i}`, odds: 3.4, runs: [{ date: "2026-01-01", course: "芝", distance: 1600, finish: 1 }] };
    size += JSON.stringify(entry).length + 1;
    entries.push(entry);
  }
  return JSON.stringify({ horses: entries });
}

const base: MigrationAnalysisLine = GOLDEN_ANALYSES.find((a) => a.allocationMeta !== null && a.bets.length > 0)!;
const snapshot = snapshotJson(SNAPSHOT_BYTES);

function analysisLine(id: number): MigrationAnalysisLine {
  return {
    ...base,
    analysis: { ...base.analysis, id, race_snapshot_json: snapshot },
    horses: Array.from({ length: HORSES }, (_, k) => ({ ...base.horses[0]!, analysis_id: id, umaban: k + 1 })),
    bets: base.bets.map((b) => ({ ...b, analysis_id: id })),
    allocationMeta: { ...base.allocationMeta!, analysis_id: id },
  };
}

const lines = Array.from({ length: ANALYSES }, (_, k) => analysisLine(k + 1));
const header = JSON.stringify({ type: "header", format: "keiba-cloud-migration", version: 1, exportedAt: "2026-10-09T00:00:00.000Z", appVersion: "1.44.0" });
const footer = JSON.stringify({
  type: "footer",
  counts: {
    analyses: ANALYSES,
    analysis_horses: ANALYSES * HORSES,
    analysis_bets: ANALYSES * base.bets.length,
    analysis_allocation_meta: ANALYSES,
    race_results: 0,
    race_result_meta: 0,
    race_combo_payouts: 0,
    race_combo_payout_imports: 0,
  },
  analysisLines: ANALYSES,
  resultLines: 0,
});
const text = `${[header, ...lines.map((l) => JSON.stringify(l)), footer].join("\n")}\n`;
const gz = new Uint8Array(gzipSync(Buffer.from(text, "utf-8")));

function cpuMs(f: () => void | Promise<void>): Promise<number> {
  const before = process.cpuUsage();
  return Promise.resolve(f()).then(() => {
    const d = process.cpuUsage(before);
    return (d.user + d.system) / 1000;
  });
}

function stats(values: number[]): string {
  const s = [...values].sort((a, b) => a - b);
  return `最小 ${s[0]!.toFixed(0)}・中央値 ${s[Math.floor(s.length / 2)]!.toFixed(0)}・最大 ${s[s.length - 1]!.toFixed(0)}`;
}

const imports = lines.map((l) => toAnalysisImport(parseMigrationLine(JSON.stringify(l)) as MigrationAnalysisLine));
const verifyTimes: number[] = [];
const serializeTimes: number[] = [];
for (let r = 0; r < REPEATS + 1; r += 1) {
  const v = await cpuMs(async () => {
    await verifyMigrationFile(new Blob([gz]).stream(), { now: Date.parse("2026-10-09T03:00:00Z") });
  });
  const s = await cpuMs(() => {
    imports.forEach((imp) => assertDetailSerializable(imp, "測定"));
  });
  if (r > 0) {
    // 1 回目は JIT の暖機として捨てる
    verifyTimes.push(v);
    serializeTimes.push(s);
  }
}
console.log(`分析 ${ANALYSES} 件・スナップショット約 ${SNAPSHOT_BYTES} バイト・馬 ${HORSES} 頭・展開後 ${text.length} 文字(UTF-16 単位)・繰り返し ${REPEATS} 回(暖機 1 回を除く)`);
console.log(`verify    CPU(ms): ${stats(verifyTimes)}`);
console.log(`serialize CPU(ms): ${stats(serializeTimes)}`);
const ratios = verifyTimes.map((v, i) => (serializeTimes[i]! / v) * 100);
console.log(`serialize / verify(%): ${stats(ratios)}`);
