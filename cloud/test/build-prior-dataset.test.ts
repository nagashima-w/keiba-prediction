import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { asReadonlyBucket, asReadonlyD1, ReadonlyCloudflare } from "../cf-readonly-client";
import { D1PriorExportStore } from "../src/prior-export-store";
import { buildPriorDataset, diffAgainstProduction } from "../build-prior-dataset";
import { PriorExportCore, type PriorExportStorePort } from "../src/prior-export-core";
import { assembleFile, PRIOR_ROW_KEYS, PRIOR_ROW_KEYS_V6_ADDED, type PriorDatasetRow } from "../src/prior-export-format";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import { cand, driver, FakeKv, PriorFakeStore, raceIdOf, T0 } from "./export-fixtures";

/**
 * Issue #587: 統計モデル用の書き出しを、手元で、D1 と R2 を読むだけで組み立てる道具。
 * 組み立ては本番と同じ `PriorExportCore`(状態機械・選別・チャンク・メタ行)を通す。ここでは偽の窓口で、
 * (1) 本番のコードを直接動かした結果とバイト列が一致すること (2) 書き込みの窓口を一切呼ばないこと (3) 本番の書き出し(format 5)との突き合わせの集計、を確かめる。
 */

function fakeSource(races: number): PriorFakeStore {
  const s = new PriorFakeStore();
  s.candidates = Array.from({ length: races }, (_, i) => cand(100 + i, raceIdOf(i + 1)));
  return s;
}

/** 本番と同じ配線(`PriorExportDO` が組むのと同じ `PriorExportCore`)を、偽の窓口で直接動かして得たバイト列。 */
async function directBytes(store: PriorFakeStore): Promise<Uint8Array> {
  const d = driver();
  const core = new PriorExportCore({ kv: new FakeKv(), store: store as unknown as PriorExportStorePort, ...d.deps });
  await core.request("refresh");
  await d.drain(core);
  expect(store.puts).toHaveLength(1);
  return store.puts[0]!.bytes;
}

describe("buildPriorDataset", () => {
  it("本番の PriorExportCore を直接動かした結果と、バイト列まで一致する(複数 batch・詳細が無いレースを含む)", async () => {
    const a = fakeSource(65); // 既定の batch は 30 件なので 3 batch
    a.noDetail.add(105);
    const b = fakeSource(65);
    b.noDetail.add(105);
    const expected = await directBytes(a);
    const got = await buildPriorDataset({ source: b as unknown as PriorExportStorePort, now: () => T0 });
    expect(Buffer.from(got.bytes).equals(Buffer.from(expected))).toBe(true);
    // 空振り防止: 比べたものが実際に中身のあるファイルであること。
    expect(got.file.races).toBe(65);
    expect(got.file.rows).toBe(65 * 3);
    expect(got.file.missingDetail).toBe(1);
    expect(expected.length).toBeGreaterThan(1000);
  });

  it("書き込みの窓口(countReads・putFileStream)を、元の窓口に対して一度も呼ばない", async () => {
    const s = fakeSource(4);
    const called: string[] = [];
    s.countReads = async () => { called.push("countReads"); };
    (s as unknown as { putFileStream: unknown }).putFileStream = async () => { called.push("putFileStream"); };
    const got = await buildPriorDataset({ source: s as unknown as PriorExportStorePort, now: () => T0 });
    expect(got.bytes.length).toBeGreaterThan(0);
    expect(called).toEqual([]);
    expect(s.puts).toHaveLength(0);
  });

  it("列は format 6(horse_id を含む)。メタ行の format と列の並びが本番の定義と一致する", async () => {
    const got = await buildPriorDataset({ source: fakeSource(2) as unknown as PriorExportStorePort, now: () => T0 });
    const lines = new TextDecoder().decode(gunzipSync(got.bytes)).split("\n").filter((l) => l !== "");
    const meta = (JSON.parse(lines[0]!) as { _meta: { format: number; columns: string[] } })._meta;
    expect(meta.format).toBe(6);
    expect(meta.columns).toEqual([...PRIOR_ROW_KEYS]);
    expect(meta.columns).toContain("horse_id");
    expect(Object.keys(JSON.parse(lines[1]!))).toEqual([...PRIOR_ROW_KEYS]);
  });

  it("R2 の柵に届いていれば、始まらずに例外(理由を文言に出す)", async () => {
    const s = fakeSource(3);
    s.usage = { classA: 0, classB: R2_FENCE_LIMITS.classB };
    await expect(buildPriorDataset({ source: s as unknown as PriorExportStorePort, now: () => T0 })).rejects.toThrow(/r2-fence/);
  });

  it("読みが失敗し続けるときは、上限で止まって例外(無限に回らない)", async () => {
    const s = fakeSource(3);
    s.readCandidates = async () => { throw new Error("D1 の失敗"); };
    await expect(buildPriorDataset({ source: s as unknown as PriorExportStorePort, now: () => T0 })).rejects.toThrow(/完成しませんでした.*tick-failed/);
  });
});

/** format 5 の本番ファイルの代わり: 手元の行から後ろの 4 列(v6 で足した列)を落とし、メタ行を format 5 にしたもの。 */
function prodLike(rows: readonly PriorDatasetRow[], generatedAt: string, edit: (r: Record<string, unknown>, i: number) => Record<string, unknown> | null = (r) => r): Uint8Array {
  const columns = PRIOR_ROW_KEYS.filter((k) => !(PRIOR_ROW_KEYS_V6_ADDED as readonly string[]).includes(k));
  const body = rows
    .map((r, i) => edit(Object.fromEntries(columns.map((k) => [k, (r as unknown as Record<string, unknown>)[k]])), i))
    .filter((r): r is Record<string, unknown> => r !== null)
    .map((r) => `${JSON.stringify(r)}\n`)
    .join("");
  return gzipSync(new TextEncoder().encode(`${JSON.stringify({ _meta: { format: 5, generatedAt, columns } })}\n${body}`));
}

async function localRows(races: number): Promise<{ bytes: Uint8Array; rows: PriorDatasetRow[] }> {
  const got = await buildPriorDataset({ source: fakeSource(races) as unknown as PriorExportStorePort, now: () => T0 });
  const lines = new TextDecoder().decode(gunzipSync(got.bytes)).split("\n").filter((l) => l !== "");
  return { bytes: got.bytes, rows: lines.slice(1).map((l) => JSON.parse(l) as PriorDatasetRow) };
}

describe("diffAgainstProduction: 本番の format 5 との突き合わせ", () => {
  it("v6 の 4 列を除いて全部同じなら、差は 0。比べた行数・列数を返す", async () => {
    const { bytes, rows } = await localRows(5);
    const d = diffAgainstProduction(bytes, prodLike(rows, "2026-10-30T08:29:35.790Z"));
    expect(rows).toHaveLength(15);
    expect(d).toMatchObject({ prodRows: 15, localRows: 15, identical: 15, differingRows: 0, onlyInProd: 0, onlyInLocal: 0, comparedColumns: PRIOR_ROW_KEYS.length - 4 });
    expect(d.differingColumns).toEqual({});
  });

  it("値の違う列を、列ごとに行数で数える(jockey_id の差 2 行・contributions の差 1 行)", async () => {
    const { bytes, rows } = await localRows(5);
    const prod = prodLike(rows, "2026-10-30T08:29:35.790Z", (r, i) => {
      if (i === 0 || i === 1) return { ...r, jockey_id: "OLD" };
      if (i === 7) return { ...r, prior: 0.999 };
      return r;
    });
    const d = diffAgainstProduction(bytes, prod);
    expect(d.differingColumns).toEqual({ jockey_id: 2, prior: 1 });
    expect(d.differingRows).toBe(3);
    expect(d.identical).toBe(12);
  });

  it("本番にだけある行・手元にだけある行を数え、手元にだけある行は本番の generatedAt より後の分析かで分ける", async () => {
    const { bytes, rows } = await localRows(5);
    // 本番から 2 行を落とす(手元にだけ ある)。本番にだけある行は、手元に無い分析 id を足して作る。
    const prod = prodLike(rows, "2026-10-10T03:00:00.000Z", (r, i) => (i < 2 ? null : r));
    const extra = prodLike([{ ...rows[0]!, analysis_id: 99999 }], "2026-10-10T03:00:00.000Z");
    const merged = gzipSync(Buffer.concat([gunzipSync(prod), gunzipSync(extra).subarray(gunzipSync(extra).indexOf(10) + 1)]));
    const d = diffAgainstProduction(bytes, merged);
    expect(d.onlyInProd).toBe(1);
    expect(d.onlyInLocal).toBe(2);
    // フィクスチャの analyzed_at は 2026-10-10T00:00:00Z で、本番の generatedAt(03:00)より前 → 「後の分析」ではない。
    expect(d.onlyInLocalAfterProd).toBe(0);
    const later = diffAgainstProduction(bytes, prodLike(rows, "2026-10-09T00:00:00.000Z", (r, i) => (i < 2 ? null : r)));
    expect(later.onlyInLocalAfterProd).toBe(2);
  });

  it("assembleFile の形(メタ行 + 行)を、本番のファイルと同じ読み方で読める", async () => {
    const { rows } = await localRows(1);
    const bytes = assembleFile({ generatedAt: "2026-10-30T00:00:00.000Z", rows: 0, races: 0, missingDetail: 0, excluded: { suspect: 0, unknown: 0, unchecked: 0, superseded: 0 } }, []);
    const d = diffAgainstProduction(bytes, prodLike(rows, "2026-10-30T00:00:00.000Z"));
    expect(d.localRows).toBe(0);
    expect(d.onlyInProd).toBe(3);
  });
});

describe("道具が本番のストアに送る SQL は、読み取り専用の検査(`[ ]`・制御文字・ASCII 以外の拒否を含む)をすべて通る", () => {
  it("D1PriorExportStore の readUsage・readCandidates・readLookups・readRaceData が送る SQL が、1 つも拒否されない", async () => {
    const sent: string[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      sent.push((JSON.parse(String(init?.body)) as { sql: string }).sql);
      return new Response(JSON.stringify({ success: true, errors: [], result: [{ results: [], meta: { rows_read: 0 } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ReadonlyCloudflare({ accountId: "A", token: "T", fetch: f, sleep: async () => {}, minIntervalMs: 0 });
    const store = new D1PriorExportStore({ db: asReadonlyD1(client) as never, bucket: asReadonlyBucket(client) as never });
    await store.readUsage();
    await store.readCandidates();
    await store.readLookups();
    await store.readRaceData([1], ["202601010101"]);
    // 空振り防止: 実際に送られた文の数(使用量 1 + 候補 1 + 対応 2 + 馬・結果・面 3)。
    expect(sent).toHaveLength(7);
    expect(sent.some((sql) => sql.includes("["))).toBe(false);
  });
});
