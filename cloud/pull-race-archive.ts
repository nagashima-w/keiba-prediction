/**
 * 過去の結果(#554 が毎晩 R2 に保存したもの)を、手元の NDJSON(1 行 1 レース)に並べる開発用の道具(Issue #586。親は #549)。
 * 分析(#548・#526・#539・#542・#421)の入口。**本番の D1・R2 は読むだけ**(SELECT と GET だけ。守りは `cf-readonly-client.ts`)。本番の Worker には入らない。
 *
 * 使い方(cloud/ で。鍵は環境変数 `CLOUDFLARE_API_TOKEN`、アカウントは `CLOUDFLARE_ACCOUNT_ID`):
 *   NODE_USE_ENV_PROXY=1 pnpm exec tsx pull-race-archive.ts --out ../tmp/hist.ndjson.gz [--from 2021-11-01] [--to 2026-10-31] [--kind central|nar] [--dry-run]
 *
 * ## 出力
 * `--out` は gzip した NDJSON(`.ndjson.gz`)。`docs/investigations/handover-2026-11-01/{526/build_full.py,548/explore.py}` が `gzip.open(path, "rt")` で読む形(生の NDJSON では読めない)。
 * 1 行は `RaceRecord`(`packages/core/src/scraper/race-record.ts`)をそのまま JSON にし、**キー `_archive` を 1 つだけ足す**: `{ fetchedAt, rawBytes, parserVersion }`(D1 の目録の値)。
 * 元の HTML は捨てる。並びは (date, raceId) の昇順。出力は一時ファイルに書いてから置き換える(途中で止まっても古いファイルが壊れない)。
 *
 * ## 取り直し
 * `--out` のファイルが既にあれば読み、目録の `fetchedAt`・`rawBytes`・`parserVersion` が**すべて同じ**行は GET しない。違う行・`_archive` の無い行・手元に無い行だけ GET する。
 * 目録に無い手元の行(`--from/--to` の外など)は捨てずに残す。`--from/--to/--kind` は「取りに行く範囲」を絞るだけで、手元の行は消さない。
 * GET が例外になったら、そこまでの行を書いてから終了コード 1 で終わる(取れた分は失わない。もう一度流せば続きから)。
 *
 * ## R2 の Class B
 * この道具の GET は D1 の `r2_ops` に数えられない(書き込まないため)。代わりに、始める前に今月の `class_b` を読み、`class_b + 予定の GET 数` が柵(`R2_FENCE_LIMITS.classB`)に届くなら、
 * 1 件も取らずに止める。文言に今月の使用量と予定の件数を出す。この道具の GET は計数に載らないので、柵の判定は実際より少なめに見える(R2 の無料枠は月 1,000 万回で、全期間でも約 2 万回)。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { ReadonlyCloudflare } from "./cf-readonly-client";
import { decodeRaceArchive } from "./src/race-archive-format";
import { monthKey, R2_FENCE_LIMITS } from "./src/r2-fence";

/** 道具が使う窓口(`ReadonlyCloudflare` がこれを満たす。テストでは偽物)。 */
export interface PullClient {
  query(sql: string, params: readonly unknown[]): Promise<{ results: unknown[]; meta: { rows_read?: number } }>;
  getObject(key: string): Promise<Uint8Array | null>;
}

/** 目録(`race_archive`)の 1 行。 */
export interface CatalogRow {
  readonly raceId: string;
  readonly kind: "central" | "nar";
  readonly raceDate: string;
  readonly parserVersion: number;
  readonly r2Key: string;
  readonly rawBytes: number;
  readonly fetchedAt: string;
}

export interface PullFilter {
  readonly kind?: "central" | "nar";
  /** YYYY-MM-DD(この日を含む)。 */
  readonly from?: string;
  /** YYYY-MM-DD(この日を含む)。 */
  readonly to?: string;
}

/** 行に足すキー。目録の値で、取り直しの判定に使う。 */
export interface ArchiveMark {
  readonly fetchedAt: string;
  readonly rawBytes: number;
  readonly parserVersion: number;
}

/** 目録の SELECT 文。絞り込みは WHERE に入れる(束縛の順は {@link catalogParams})。 */
export function CATALOG_SQL(filter: PullFilter): string {
  const where = [
    ...(filter.kind === undefined ? [] : ["kind = ?"]),
    ...(filter.from === undefined ? [] : ["race_date >= ?"]),
    ...(filter.to === undefined ? [] : ["race_date <= ?"]),
  ];
  return `SELECT race_id AS raceId, kind, race_date AS raceDate, parser_version AS parserVersion, r2_key AS r2Key, raw_bytes AS rawBytes, fetched_at AS fetchedAt FROM race_archive${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`} ORDER BY race_date, race_id`;
}

function catalogParams(filter: PullFilter): unknown[] {
  return [...(filter.kind === undefined ? [] : [filter.kind]), ...(filter.from === undefined ? [] : [filter.from]), ...(filter.to === undefined ? [] : [filter.to])];
}

export interface ExistingLine {
  readonly raceId: string;
  readonly date: string;
  readonly line: string;
  readonly mark: ArchiveMark | null;
}

/** 手元のファイルの中身(展開済みの NDJSON)を読む。JSON でない行・raceId の無い行は数えて捨てる。 */
export function parseExistingLines(text: string): { rows: Map<string, ExistingLine>; broken: number } {
  const rows = new Map<string, ExistingLine>();
  let broken = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      broken += 1;
      continue;
    }
    const o = obj as { raceId?: unknown; date?: unknown; _archive?: Partial<Record<keyof ArchiveMark, unknown>> };
    if (typeof o !== "object" || o === null || typeof o.raceId !== "string") {
      broken += 1;
      continue;
    }
    const a = o._archive;
    const mark: ArchiveMark | null =
      a !== undefined && a !== null && typeof a.fetchedAt === "string" && typeof a.rawBytes === "number" && typeof a.parserVersion === "number"
        ? { fetchedAt: a.fetchedAt, rawBytes: a.rawBytes, parserVersion: a.parserVersion }
        : null;
    rows.set(o.raceId, { raceId: o.raceId, date: typeof o.date === "string" ? o.date : "", line, mark });
  }
  return { rows, broken };
}

export interface PullStats {
  readonly catalog: number;
  readonly skipped: number;
  readonly fetched: number;
  readonly missing: number;
  /** 取りに行く予定だった件数(dryRun でも出る)。 */
  readonly planned: number;
  /** 手元のファイルで読めなかった行の数。 */
  readonly brokenExisting: number;
}

export interface PullResult {
  readonly lines: string[];
  readonly stats: PullStats;
  /** R2 に無い・壊れていた race_id。 */
  readonly missingIds: string[];
  /** GET の例外で途中で止まったとき。そこまでの `lines` は有効。 */
  readonly error?: Error;
}

export interface PullOptions {
  readonly client: PullClient;
  readonly filter: PullFilter;
  /** 手元のファイルの展開済みの中身。無ければ空文字列。 */
  readonly existingText: string;
  readonly now?: () => Date;
  readonly dryRun?: boolean;
  readonly onProgress?: (done: number, total: number) => void;
}

const sameMark = (m: ArchiveMark | null, c: CatalogRow): boolean => m !== null && m.fetchedAt === c.fetchedAt && m.rawBytes === c.rawBytes && m.parserVersion === c.parserVersion;

/** 手順はファイル先頭の説明。柵に届くときは GET の前に例外。 */
export async function pullRaceArchive(options: PullOptions): Promise<PullResult> {
  const { client, filter } = options;
  const now = (options.now ?? (() => new Date()))();
  const existing = parseExistingLines(options.existingText);
  const catalog = (await client.query(CATALOG_SQL(filter), catalogParams(filter))).results as CatalogRow[];

  const toFetch = catalog.filter((c) => !sameMark(existing.rows.get(c.raceId)?.mark ?? null, c));
  const skipped = catalog.length - toFetch.length;

  const usage = (await client.query("SELECT class_b AS classB FROM r2_ops WHERE ym = ?", [monthKey(now)])).results[0] as { classB?: number } | undefined;
  const classB = usage?.classB ?? 0;
  if (!options.dryRun && toFetch.length > 0 && classB + toFetch.length >= R2_FENCE_LIMITS.classB) {
    throw new Error(`R2 の Class B の柵に届くので始めません: 今月の使用量 ${classB} 回 + 予定の GET ${toFetch.length} 件 >= 柵 ${R2_FENCE_LIMITS.classB} 回`);
  }

  const out = new Map<string, { date: string; line: string }>();
  for (const e of existing.rows.values()) out.set(e.raceId, { date: e.date, line: e.line });
  const missingIds: string[] = [];
  let fetched = 0;
  let error: Error | undefined;

  if (!options.dryRun) {
    for (const [i, c] of toFetch.entries()) {
      let bytes: Uint8Array | null;
      try {
        bytes = await client.getObject(c.r2Key);
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
        break;
      }
      const archive = bytes === null ? null : decodeRaceArchive(bytes);
      if (archive === null || archive.record.raceId !== c.raceId) {
        missingIds.push(c.raceId);
      } else {
        const mark: ArchiveMark = { fetchedAt: c.fetchedAt, rawBytes: c.rawBytes, parserVersion: c.parserVersion };
        out.set(c.raceId, { date: archive.record.date, line: JSON.stringify({ ...archive.record, _archive: mark }) });
        fetched += 1;
      }
      options.onProgress?.(i + 1, toFetch.length);
    }
  }

  const lines = [...out.entries()]
    .sort(([ia, a], [ib, b]) => (a.date < b.date ? -1 : a.date > b.date ? 1 : ia < ib ? -1 : ia > ib ? 1 : 0))
    .map(([, v]) => v.line);
  const stats: PullStats = { catalog: catalog.length, skipped, fetched, missing: missingIds.length, planned: toFetch.length, brokenExisting: existing.broken };
  return error === undefined ? { lines, stats, missingIds } : { lines, stats, missingIds, error };
}

/** 行を gzip した NDJSON(末尾改行つき)にする。 */
export function encodeNdjsonGz(lines: readonly string[]): Uint8Array {
  return gzipSync(new TextEncoder().encode(lines.map((l) => `${l}\n`).join("")));
}

function parseArgs(argv: readonly string[]): { out: string; filter: PullFilter; dryRun: boolean } {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const out = get("--out");
  if (out === undefined) throw new Error("--out <出力の .ndjson.gz> が要ります");
  const kind = get("--kind");
  if (kind !== undefined && kind !== "central" && kind !== "nar") throw new Error("--kind は central か nar");
  const dateOk = (v: string | undefined): boolean => v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = get("--from");
  const to = get("--to");
  if (!dateOk(from) || !dateOk(to)) throw new Error("--from / --to は YYYY-MM-DD");
  return { out, filter: { ...(kind === undefined ? {} : { kind }), ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }, dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { out, filter, dryRun } = parseArgs(process.argv.slice(2));
  const client = ReadonlyCloudflare.fromEnv();
  const existingText = existsSync(out) ? new TextDecoder().decode(gunzipSync(readFileSync(out))) : "";
  const result = await pullRaceArchive({
    client, filter, existingText, dryRun,
    onProgress: (done, total) => {
      if (done % 200 === 0 || done === total) console.log(`${done}/${total}(要求 ${client.requests})`);
    },
  });
  console.log(`目録 ${result.stats.catalog}・飛ばした ${result.stats.skipped}・取った ${result.stats.fetched}・取れなかった ${result.stats.missing}・予定 ${result.stats.planned}・手元の壊れた行 ${result.stats.brokenExisting}`);
  if (result.missingIds.length > 0) console.log(`取れなかった race_id(先頭 20 件): ${result.missingIds.slice(0, 20).join(" ")}`);
  if (!dryRun) {
    const tmp = path.join(path.dirname(path.resolve(out)), `.${path.basename(out)}.tmp`);
    writeFileSync(tmp, encodeNdjsonGz(result.lines));
    renameSync(tmp, out);
    console.log(`書いた: ${out}(${result.lines.length} 行)`);
  }
  if (result.error !== undefined) {
    console.error(`途中で止まりました: ${result.error.message}(取れた分は書きました。もう一度流すと続きから取ります)`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
