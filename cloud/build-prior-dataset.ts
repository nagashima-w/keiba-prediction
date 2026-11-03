/**
 * 統計モデル用の書き出し(R2 の `exports/prior-dataset.ndjson.gz`。画面の「書き出し直し」で作るもの)を、手元で、本番の D1・R2 を**読むだけ**で組み立てる開発用の道具(Issue #587。親は #549)。
 * #340・#526・#388・#421 の計算し直しが、最新の書き出しを使えるようにする。本番の Worker には入らない。
 *
 * ## 作り方
 * 本番と同じ `PriorExportCore`(`src/prior-export-core.ts`。状態機械・選別・チャンク・メタ行)を、メモリ上の kv と仮想の時計で動かす。D1・R2 の読みは本番と同じ `D1PriorExportStore`
 * (`src/prior-export-store.ts`)に、読み取り専用の窓口(`cf-readonly-client.ts`)を差し込んで行う。**書き込みの窓口は呼ばない**:
 * `countReads`(R2 の使用量の加算)は何もせず、`putFileStream`(R2 への put)は流された塊をメモリに集めるだけ。D1 へは SELECT しか送れない。
 * 列は本番のコードの版(`PRIOR_EXPORT_FORMAT`)に従う。`horse_id` は format 6(#540)から本番の組み立てが含めているので、この道具は何も足さない。
 *
 * ## 本番の書き出しとの突き合わせ(バイト一致ではない)
 * 本番の R2 にある書き出しとは、バイト列は一致しない(メタ行の `generatedAt`・format・列が違う。D1 の中身も、書き出したあとに分析・対応表が増えている)。代わりに `--compare-prod` が、
 * 本番のファイルの列(format 5 なら 35 列)だけを `(analysis_id, umaban)` ごとに突き合わせ、一致した行・列ごとの違う行数・片方にだけある行を数えて出す({@link diffAgainstProduction})。
 * 差が出てよいのは、騎手・調教師の ID を名前から埋める列(対応表が増えた)と、本番の書き出しのあとに増えた分析・新たに `superseded` になった分析だけ。
 *
 * ## 負荷
 * D1 の読み取りは約 5.3 万行・R2 の GET は分析の数(約 1,000 回)の見込み(`src/prior-export-core.ts` の「柵の根拠」。本番の実数は未確認)。要求は 300ms あけて順に出す。
 * R2 の使用量は、本番と同じく `r2_ops` の Class B の柵で止める(この道具の GET は計数に載らない)。
 *
 * 使い方(cloud/ で。鍵は `CLOUDFLARE_API_TOKEN`、アカウントは `CLOUDFLARE_ACCOUNT_ID`):
 *   NODE_USE_ENV_PROXY=1 pnpm exec tsx build-prior-dataset.ts --out ../tmp/prior-dataset.ndjson.gz [--compare-prod]
 */
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { asReadonlyBucket, asReadonlyD1, ReadonlyCloudflare } from "./cf-readonly-client";
import { PriorExportCore, type ExportFileInfo, type ExportKv, type PriorExportStorePort } from "./src/prior-export-core";
import { D1PriorExportStore } from "./src/prior-export-store";
import { PRIOR_EXPORT_KEY } from "./src/prior-export-format";

class MemoryKv implements ExportKv {
  private readonly map = new Map<string, unknown>();
  get<T = unknown>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  put(key: string, value: unknown): void {
    this.map.set(key, structuredClone(value));
  }
  delete(key: string): boolean {
    return this.map.delete(key);
  }
}

export interface BuildPriorDatasetOptions {
  /** 読みの窓口。書き込み(`countReads`・`putFileStream`)は呼ばない。 */
  readonly source: PriorExportStorePort;
  /** 開始の時刻(ms)。メタ行の `generatedAt` になる。既定は現在時刻。 */
  readonly now?: () => number;
  /** 1 tick ごとの進み具合(`racesDone / races`)。 */
  readonly onProgress?: (racesDone: number, races: number | null, phase: string) => void;
  /** tick の上限(暴走の防止)。既定 10,000。 */
  readonly maxTicks?: number;
}

export interface BuiltPriorDataset {
  /** ファイルのバイト列(gzip のメンバーの連結。本番の R2 に置かれるものと同じ形)。 */
  readonly bytes: Uint8Array;
  readonly file: ExportFileInfo;
  readonly ticks: number;
}

/** 手順はファイル先頭の説明。始められない(柵・回数)・失敗が上限に達した・上限の tick を超えたときは例外。 */
export async function buildPriorDataset(options: BuildPriorDatasetOptions): Promise<BuiltPriorDataset> {
  const { source } = options;
  const collected: Uint8Array[] = [];
  let totalBytes = 0;
  const store: PriorExportStorePort = {
    readUsage: () => source.readUsage(),
    readCandidates: () => source.readCandidates(),
    readLookups: () => source.readLookups(),
    readRaceData: (analysisIds, raceIds) => source.readRaceData(analysisIds, raceIds),
    fetchDetails: (items) => source.fetchDetails(items),
    // 書き込みは元の窓口に渡さない。使用量の加算は捨て、ファイルはメモリに集める。
    countReads: async () => {},
    putFileStream: async (_key, parts, total) => {
      collected.length = 0;
      for (const part of parts()) collected.push(part);
      totalBytes = collected.reduce((n, p) => n + p.length, 0);
      if (totalBytes !== total) throw new Error(`流された長さ ${totalBytes} が宣言 ${total} と違う`);
    },
  };

  let clock = (options.now ?? Date.now)();
  let alarm: number | null = null;
  const core = new PriorExportCore({
    kv: new MemoryKv(),
    now: () => clock,
    setAlarm: (at) => { alarm = at; },
    getAlarm: async () => alarm,
    store,
    onWarn: () => {},
  });

  const started = await core.request("refresh");
  if (started.status !== "building") {
    throw new Error(`書き出しを始められません: ${started.status}${"reason" in started ? ` (${String(started.reason)})` : ""}`);
  }
  const maxTicks = options.maxTicks ?? 10_000;
  let ticks = 0;
  while (alarm !== null) {
    if (ticks >= maxTicks) throw new Error(`tick が上限 ${maxTicks} を超えました`);
    // アラームの時刻まで時計を進める(退避の待ちは実際には待たない)。
    clock = Math.max(clock, alarm);
    alarm = null;
    await core.runTick();
    ticks += 1;
    if (options.onProgress !== undefined) {
      const s = await core.request("status");
      if (s.status === "building") options.onProgress(s.racesDone, s.races, s.phase);
    }
  }
  const done = await core.request("status");
  if (done.status !== "ready") {
    throw new Error(`書き出しが完成しませんでした: ${done.status}${"reason" in done ? ` (${String(done.reason)})` : ""}`);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of collected) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, file: done.file, ticks };
}

export interface ProductionDiff {
  readonly prodRows: number;
  readonly localRows: number;
  /** 比べた列の数(本番のメタ行の `columns`)。 */
  readonly comparedColumns: number;
  /** 比べた列がすべて同じ行。 */
  readonly identical: number;
  /** 比べた列のどれかが違う行。 */
  readonly differingRows: number;
  /** 列ごとの、値が違う行数。 */
  readonly differingColumns: Readonly<Record<string, number>>;
  readonly onlyInProd: number;
  readonly onlyInLocal: number;
  /** 手元にだけある行のうち、分析の時刻が本番の `generatedAt` より後のもの(書き出しのあとに増えた分析)。 */
  readonly onlyInLocalAfterProd: number;
}

function readFile(bytes: Uint8Array): { meta: { generatedAt?: string; columns?: string[] }; rows: Array<Record<string, unknown>> } {
  const lines = new TextDecoder().decode(gunzipSync(bytes)).split("\n").filter((l) => l !== "");
  const head = JSON.parse(lines[0] ?? "{}") as { _meta?: { generatedAt?: string; columns?: string[] } };
  return { meta: head._meta ?? {}, rows: lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

/** 手元で組み立てたファイルと、本番のファイル(古い format でもよい)を、本番のメタ行の `columns` だけで `(analysis_id, umaban)` ごとに突き合わせる。 */
export function diffAgainstProduction(localBytes: Uint8Array, prodBytes: Uint8Array): ProductionDiff {
  const local = readFile(localBytes);
  const prod = readFile(prodBytes);
  const columns = prod.meta.columns ?? [];
  const keyOf = (r: Record<string, unknown>): string => `${String(r["analysis_id"])}:${String(r["umaban"])}`;
  const localByKey = new Map(local.rows.map((r) => [keyOf(r), r] as const));
  const prodKeys = new Set<string>();
  const differingColumns: Record<string, number> = {};
  let identical = 0;
  let differingRows = 0;
  let onlyInProd = 0;
  for (const p of prod.rows) {
    const key = keyOf(p);
    prodKeys.add(key);
    const l = localByKey.get(key);
    if (l === undefined) {
      onlyInProd += 1;
      continue;
    }
    const diff = columns.filter((c) => JSON.stringify(p[c] ?? null) !== JSON.stringify(l[c] ?? null));
    if (diff.length === 0) {
      identical += 1;
    } else {
      differingRows += 1;
      for (const c of diff) differingColumns[c] = (differingColumns[c] ?? 0) + 1;
    }
  }
  const prodAt = Date.parse(prod.meta.generatedAt ?? "");
  const localOnly = local.rows.filter((r) => !prodKeys.has(keyOf(r)));
  const after = localOnly.filter((r) => Date.parse(String(r["analyzed_at"])) > prodAt).length;
  return { prodRows: prod.rows.length, localRows: local.rows.length, comparedColumns: columns.length, identical, differingRows, differingColumns, onlyInProd, onlyInLocal: localOnly.length, onlyInLocalAfterProd: after };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? undefined : argv[outIndex + 1];
  if (out === undefined) throw new Error("--out <出力の .ndjson.gz> が要ります");
  const client = ReadonlyCloudflare.fromEnv();
  const source = new D1PriorExportStore({ db: asReadonlyD1(client) as never, bucket: asReadonlyBucket(client) as never });
  const built = await buildPriorDataset({
    source,
    onProgress: (done, total, phase) => console.log(`${phase} ${done}/${total ?? "?"}(要求 ${client.requests})`),
  });
  const tmp = path.join(path.dirname(path.resolve(out)), `.${path.basename(out)}.tmp`);
  writeFileSync(tmp, built.bytes);
  renameSync(tmp, out);
  console.log(`書いた: ${out}(${built.bytes.length} バイト・行 ${built.file.rows}・レース ${built.file.races}・詳細なし ${built.file.missingDetail}・除外 ${JSON.stringify(built.file.excluded)}・D1 の読み取り ${built.file.diag.rowsRead} 行・R2 の GET ${built.file.diag.gets} 回・要求 ${client.requests})`);
  if (argv.includes("--compare-prod")) {
    const prod = await client.getObject(PRIOR_EXPORT_KEY);
    if (prod === null) throw new Error(`本番の ${PRIOR_EXPORT_KEY} がありません`);
    console.log(JSON.stringify(diffAgainstProduction(built.bytes, prod), null, 2));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
