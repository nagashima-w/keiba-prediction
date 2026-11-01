// #543: 配分の書き出し(`/api/export/allocation-dataset`)と同じファイルを、本番の D1・R2 を**読むだけ**で手元に組み立てる。
// 本番の DO を動かす `?refresh=1` は読み取りの鍵では呼べないため(ユーザーの指示・11/1)。
// 行の中身は本番と同じ関数(`D1AllocationExportStore` の読み・`selectAllocationExportAnalyses`・`buildAllocationRaceRow`・`buildAllocationHead`)で作る。
// 書き込みに当たる `countReads`(R2 の使用量の加算)と `putFileStream`(R2 への put)は呼ばない。D1 へは SELECT だけを送る(送る前に検査する)。
// 鍵はプロキシが付ける(環境変数の CLOUDFLARE_API_TOKEN はダミー)。Cloudflare の API の上限(5 分で 1,200 回)の手前に収まるよう、要求の間隔をあける。
// 使い方: cd cloud && NODE_USE_ENV_PROXY=1 pnpm exec tsx ../docs/investigations/handover-2026-11-01/543/build-dataset.ts <出力の .ndjson.gz>
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { D1AllocationExportStore } from "../../../../cloud/src/allocation-export-store";
import { buildAllocationHead, buildAllocationRaceRow, selectAllocationExportAnalyses, ALLOCATION_EXPORT_KEY } from "../../../../cloud/src/allocation-export-format";

const out = process.argv[2];
if (out === undefined) throw new Error("出力のパスを渡す");
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!ACCOUNT) throw new Error("CLOUDFLARE_ACCOUNT_ID が無い");
const DB_ID = "c52e97fc-d495-4395-8141-80d20ef57a16"; // cloud/wrangler.toml の公開してよい値
const BUCKET = "keiba-cloud-r2";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const HEADERS = { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN ?? "dummy"}` };
const MIN_INTERVAL_MS = 300; // 1 秒に 3 回強。5 分で約 1,000 回
let last = 0;
let requests = 0;
async function throttled(url: string, init: RequestInit): Promise<Response> {
  const wait = last + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  requests += 1;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= 4) return res;
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
}

async function query(sql: string, params: unknown[]): Promise<{ results: unknown[]; meta: { rows_read?: number } }> {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`SELECT 以外は送らない: ${sql.slice(0, 40)}`);
  const res = await throttled(`${API}/d1/database/${DB_ID}/query`, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ sql, params }) });
  const body = (await res.json()) as { success: boolean; errors: unknown; result: { results: unknown[]; meta: { rows_read?: number } }[] };
  if (!body.success) throw new Error(`D1 の失敗: ${JSON.stringify(body.errors)}`);
  return body.result[0]!;
}

class Stmt {
  constructor(readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]): Stmt { return new Stmt(this.sql, params); }
  async all<T>(): Promise<{ results: T[]; meta: { rows_read?: number } }> { const r = await query(this.sql, this.params); return { results: r.results as T[], meta: r.meta }; }
  async first<T>(): Promise<T | null> { const r = await query(this.sql, this.params); return (r.results[0] as T) ?? null; }
  async run(): Promise<never> { throw new Error("書き込みは送らない"); }
}
const db = {
  prepare: (sql: string) => new Stmt(sql),
  batch: async (stmts: Stmt[]) => { const out = []; for (const s of stmts) out.push(await s.all()); return out; },
};
const bucket = {
  async get(key: string) {
    const res = await throttled(`${API}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`, { headers: HEADERS });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 の失敗 ${res.status}`);
    const buf = await res.arrayBuffer();
    return { arrayBuffer: async () => buf };
  },
  async put(): Promise<never> { throw new Error("書き込みは送らない"); },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store = new D1AllocationExportStore({ db: db as any, bucket: bucket as any });
const { rows: candidates } = await store.readCandidates();
const { chosen, excluded } = selectAllocationExportAnalyses(candidates);
console.log(`候補 ${candidates.length}・選んだ分析 ${chosen.length}・除外 ${JSON.stringify(excluded)}`);
const D1_BATCH = 100; // D1 の読みはまとめる(行の中身は塊の大きさに依らない)
const chunks: Uint8Array[] = [];
let rowsTotal = 0, missingOdds = 0, noAllocation = 0, failed = 0;
for (let start = 0; start < chosen.length; start += D1_BATCH) {
  const items = chosen.slice(start, start + D1_BATCH);
  const data = await store.readRaceData(items.map((a) => a.id), items.map((a) => a.raceId));
  const details = await store.fetchDetails(items.map((a) => ({ id: a.id, raceId: a.raceId, detailKey: a.detailKey })));
  const group = <T, K>(xs: readonly T[], k: (x: T) => K) => { const m = new Map<K, T[]>(); for (const x of xs) { const key = k(x); m.set(key, [...(m.get(key) ?? []), x]); } return m; };
  const horses = group(data.horses, (h) => h.analysisId), results = group(data.results, (r) => r.raceId), bets = group(data.bets, (b) => b.analysisId);
  const payouts = group(data.payouts, (p) => p.raceId), imports = group(data.imports, (i) => i.raceId);
  const metas = new Map(data.metas.map((m) => [m.analysisId, m] as const));
  const rows = items.map((analysis, i) => {
    const o = details.outcomes[i]!;
    if (o.kind === "failed") failed += 1;
    const row = buildAllocationRaceRow({
      analysis, horses: horses.get(analysis.id) ?? [], snapshot: o.kind === "ok" ? o.snapshot : null, meta: metas.get(analysis.id) ?? null,
      bets: bets.get(analysis.id) ?? [], results: results.get(analysis.raceId) ?? [], payouts: payouts.get(analysis.raceId) ?? [],
      imports: (imports.get(analysis.raceId) ?? []).map((x) => x.betType),
    });
    if (!row.has_odds) missingOdds += 1;
    if (row.allocation === null) noAllocation += 1;
    return row;
  });
  rowsTotal += rows.length;
  chunks.push(gzipSync(new TextEncoder().encode(rows.map((r) => `${JSON.stringify(r)}\n`).join("")), { level: 1 }));
  console.log(`${Math.min(start + D1_BATCH, chosen.length)}/${chosen.length} 要求 ${requests}`);
}
if (failed > 0) throw new Error(`R2 の取得の失敗が ${failed} 件あった(作り直す)`);
const head = buildAllocationHead({ generatedAt: new Date().toISOString(), rows: rowsTotal, races: chosen.length, missingOdds, noAllocation, excluded });
writeFileSync(out, Buffer.concat([head, ...chunks]));
console.log(`書いた: ${out}(行 ${rowsTotal}・オッズなし ${missingOdds}・配分なし ${noAllocation}・要求 ${requests}。本番のキーは ${ALLOCATION_EXPORT_KEY})`);
