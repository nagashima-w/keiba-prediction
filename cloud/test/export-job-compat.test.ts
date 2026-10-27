import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { AllocationExportCore } from "../src/allocation-export-core";
import { PriorExportCore } from "../src/prior-export-core";
import { assembleFile } from "../src/prior-export-format";
import { AllocationFakeStore, FakeKv, PriorFakeStore, T0, cand, driver, raceIdOf } from "./export-fixtures";

/**
 * Issue #495: 共通化しても、本番の DO の kv に残っている状態(古いコードが書いた `job`・`file`・`runs`、計画・塊のキー)をそのまま読める。
 * 公開の瞬間に作成中のジョブが残っていても、新しいコードで仕上げまで進む。
 *
 * 古い統計モデル用の `job` には、塊ごとのバイト数の記録(`chunkBytes`)が無い。この記録は配分用の `job` にだけあった。
 * 「古い形」は、ここに**文字どおりのキーの一覧**として書く(新しい実装から導かない)。
 */

/** 古いコード(共通化の前)の統計モデル用の `job` のキー。 */
const OLD_PRIOR_JOB_KEYS = ["attempts", "batches", "done", "excluded", "gets", "missingDetail", "phase", "races", "rows", "rowsRead", "startedAt", "state"];
/** 古いコードの配分用の `job` のキー(`chunkBytes` を持つ)。 */
const OLD_ALLOCATION_JOB_KEYS = ["attempts", "batches", "chunkBytes", "done", "excluded", "gets", "missingOdds", "noAllocation", "phase", "races", "rows", "rowsRead", "startedAt", "state"];

function priorWorld(races: number) {
  const kv = new FakeKv();
  const store = new PriorFakeStore();
  store.candidates = Array.from({ length: races }, (_, i) => cand(100 + i, raceIdOf(i + 1)));
  const d = driver();
  const core = (k: FakeKv = kv) => new PriorExportCore({ kv: k, store, ...d.deps }, { batchSize: 2 });
  return { kv, store, d, core };
}

/** ファイルの伸長後の行(メタ行を除く)。 */
function bodyLines(gz: Uint8Array): string[] {
  return new TextDecoder().decode(gunzipSync(gz)).split("\n").filter((l) => l !== "").slice(1);
}

/** kv の中身を、別の kv に写す(古い形に書き換えるための土台)。 */
function copyKv(from: FakeKv): FakeKv {
  const to = new FakeKv();
  for (const [k, v] of from.map) to.put(k, v);
  return to;
}

describe("統計モデル用: 古いコードが書いた作成中の job(chunkBytes なし)を、新しいコードで仕上げまで進める", () => {
  it("仕上げの段(finalizing)で残っていた job: 塊を読んで長さを数え、ファイルを完成させる。バイト列は、途中で止めずに最後まで回したものと完全に一致する", async () => {
    // 基準: 止めずに最後まで回したファイル
    const base = priorWorld(5);
    await base.core().request("download");
    await base.d.drain(base.core());
    expect(base.store.puts).toHaveLength(1);

    // 仕上げの手前まで回して、job を古い形に書き換える
    const w = priorWorld(5);
    await w.core().request("download");
    await w.d.drain(w.core(), 1 + 3);
    const job = w.kv.get<Record<string, unknown>>("job")!;
    expect(job["phase"]).toBe("finalizing");
    expect(Array.isArray(job["chunkBytes"])).toBe(true); // 新しい実装は記録を持つ(足したフィールド)
    const { chunkBytes: _dropped, ...legacy } = job;
    expect(Object.keys(legacy).sort()).toEqual(OLD_PRIOR_JOB_KEYS); // 古い形のキーに一致する
    const kv = copyKv(w.kv);
    kv.put("job", legacy);
    expect(Object.keys(kv.get<object>("job")!)).not.toContain("chunkBytes");

    const store2 = new PriorFakeStore();
    store2.candidates = w.store.candidates;
    const d = driver();
    const core = new PriorExportCore({ kv, store: store2, ...d.deps }, { batchSize: 2 });
    expect((await core.request("download")).status).toBe("building"); // 再起動後の要求。アラームを張り直す
    await d.drain(core);

    expect(store2.puts).toHaveLength(1);
    const put = store2.puts[0]!;
    expect(put.parts).toHaveLength(1 + 3);
    expect(put.totalBytes).toBe(put.bytes.length);
    const file = kv.get<{ generatedAt: string; bytes: number }>("file")!;
    expect(file.bytes).toBe(put.bytes.length);
    // 基準(止めずに回したもの)と、メタ行を除いた中身が同じ
    const rows = bodyLines(put.bytes);
    expect(rows).toHaveLength(15);
    expect(rows).toEqual(bodyLines(base.store.puts[0]!.bytes));
    // 古い形の job の値と塊から、従来の組み立て(assembleFile)で作り直したバイト列とも、圧縮後まで完全に一致する
    const legacyChunks = [0, 1, 2].map((i) => w.kv.get<Uint8Array>(`chunk:${i}`)!);
    const expected = assembleFile(
      { generatedAt: file.generatedAt, rows: (job["rows"] as number), races: (job["races"] as number), missingDetail: (job["missingDetail"] as number), excluded: job["excluded"] as never },
      legacyChunks,
    );
    expect(Buffer.from(put.bytes).equals(Buffer.from(expected))).toBe(true);
    // kv の後始末(計画・塊・job が残らない)
    expect([...kv.map.keys()].sort()).toEqual(["file", "runs"]);
  });

  it("処理の段(building)の途中で残っていた job(done=1 の時点。chunkBytes なし): 残りを処理して仕上げまで進む。処理のたびに、既に済んだ塊の長さも含めて記録する", async () => {
    const base = priorWorld(5);
    await base.core().request("download");
    await base.d.drain(base.core());

    const w = priorWorld(5);
    await w.core().request("download");
    await w.d.drain(w.core(), 2); // 計画 + 処理 1 batch(done=1)
    const job = w.kv.get<Record<string, unknown>>("job")!;
    expect(job).toMatchObject({ phase: "building", done: 1, batches: 3 });
    const { chunkBytes: _dropped, ...legacy } = job;
    expect(Object.keys(legacy).sort()).toEqual(OLD_PRIOR_JOB_KEYS);
    const chunk0 = w.kv.get<Uint8Array>("chunk:0")!;
    const kv = copyKv(w.kv);
    kv.put("job", legacy);

    const store2 = new PriorFakeStore();
    store2.candidates = w.store.candidates;
    const d = driver();
    const core = new PriorExportCore({ kv, store: store2, ...d.deps }, { batchSize: 2 });
    await core.request("download");
    await d.drain(core, 1); // 処理 1 batch(done=2)
    const after = kv.get<{ done: number; chunkBytes: number[] }>("job")!;
    expect(after.done).toBe(2);
    const chunk1 = kv.get<Uint8Array>("chunk:1")!;
    // 添字がずれない: 0 番目は済んだ塊の長さ、1 番目は今の塊の長さ
    expect(after.chunkBytes).toEqual([chunk0.length, chunk1.length]);
    await d.drain(core);

    expect(store2.puts).toHaveLength(1);
    expect(store2.puts[0]!.parts).toHaveLength(1 + 3);
    // 基準(止めずに回したもの)と、メタ行を除いた中身が同じ
    const rows = bodyLines(store2.puts[0]!.bytes);
    expect(rows).toHaveLength(15);
    expect(rows).toEqual(bodyLines(base.store.puts[0]!.bytes));
    expect(store2.puts[0]!.totalBytes).toBe(store2.puts[0]!.bytes.length);
    expect(kv.get("job")).toBeUndefined();
  });

  it("古い形の job の仕上げで、塊が失われていたら失敗として扱い(完成したファイルは作らない)、job は仕上げの段のまま再試行を待つ", async () => {
    const w = priorWorld(5);
    await w.core().request("download");
    await w.d.drain(w.core(), 1 + 3);
    const job = w.kv.get<Record<string, unknown>>("job")!;
    const { chunkBytes: _dropped, ...legacy } = job;
    const kv = copyKv(w.kv);
    kv.put("job", legacy);
    kv.delete("chunk:1");
    const store2 = new PriorFakeStore();
    store2.candidates = w.store.candidates;
    const d = driver();
    const core = new PriorExportCore({ kv, store: store2, ...d.deps }, { batchSize: 2 });
    await core.request("download");
    await d.drain(core, 1);
    expect(store2.puts).toEqual([]);
    expect(kv.get("job")).toMatchObject({ state: "running", phase: "finalizing", attempts: 1 });
  });
});

describe("配分用: 古いコードが書いた作成中の job(chunkBytes あり)を、新しいコードで仕上げまで進める", () => {
  it("処理の途中(done=1)で残っていた job を、新しいインスタンスが続きから仕上げる。job のキーは古い形のまま", async () => {
    const mk = () => {
      const kv = new FakeKv();
      const store = new AllocationFakeStore();
      store.candidates = Array.from({ length: 5 }, (_, i) => cand(100 + i, raceIdOf(i + 1)));
      return { kv, store, d: driver() };
    };
    const base = mk();
    const baseCore = new AllocationExportCore({ kv: base.kv, store: base.store, ...base.d.deps }, { batchSize: 2 });
    await baseCore.request("download");
    await base.d.drain(baseCore);

    const w = mk();
    const core1 = new AllocationExportCore({ kv: w.kv, store: w.store, ...w.d.deps }, { batchSize: 2 });
    await core1.request("download");
    await w.d.drain(core1, 2);
    const job = w.kv.get<Record<string, unknown>>("job")!;
    expect(job).toMatchObject({ phase: "building", done: 1, batches: 3 });
    expect(Object.keys(job).sort()).toEqual(OLD_ALLOCATION_JOB_KEYS);
    expect((job["chunkBytes"] as number[]).length).toBe(1);

    const kv = copyKv(w.kv);
    const store2 = new AllocationFakeStore();
    store2.candidates = w.store.candidates;
    const d = driver();
    const core2 = new AllocationExportCore({ kv, store: store2, ...d.deps }, { batchSize: 2 });
    await core2.request("download");
    await d.drain(core2);
    expect(store2.puts).toHaveLength(1);
    expect(store2.puts[0]!.parts).toHaveLength(1 + 3);
    expect(store2.puts[0]!.totalBytes).toBe(store2.puts[0]!.bytes.length);
    expect(bodyLines(store2.puts[0]!.bytes)).toHaveLength(5);
    expect(bodyLines(store2.puts[0]!.bytes)).toEqual(bodyLines(base.store.puts[0]!.bytes));
  });
});

describe("kv のキーと値の形: 新しいコードが書くものは、古いコードの形に足すだけ", () => {
  it("統計モデル用: 回している間の kv のキーは job・file・runs・plan:i・chunk:i だけ。job は古いキーに chunkBytes を足したもの。完成後に残るのは file と runs だけ", async () => {
    const w = priorWorld(5);
    const core = w.core();
    await core.request("download");
    await w.d.drain(core, 1 + 3);
    const keys = [...w.kv.map.keys()].sort();
    expect(keys).toEqual(["chunk:0", "chunk:1", "chunk:2", "job", "plan:0", "plan:1", "plan:2", "runs"]);
    expect(Object.keys(w.kv.get<object>("job")!).sort()).toEqual([...OLD_PRIOR_JOB_KEYS, "chunkBytes"].sort());
    await w.d.drain(core);
    expect([...w.kv.map.keys()].sort()).toEqual(["file", "runs"]);
    // 完成したファイルの情報のキー(古い形のまま。順序も)
    expect(Object.keys(w.kv.get<object>("file")!)).toEqual(["generatedAt", "rows", "races", "missingDetail", "excluded", "bytes", "diag"]);
    expect(Object.keys(w.kv.get<object>("runs")!)).toEqual(["day", "count"]);
  });

  it("配分用: 同じく、job のキーは古い形のまま。完成したファイルの情報のキーは古い形のまま(順序も)", async () => {
    const kv = new FakeKv();
    const store = new AllocationFakeStore();
    store.candidates = Array.from({ length: 5 }, (_, i) => cand(100 + i, raceIdOf(i + 1)));
    const d = driver();
    const core = new AllocationExportCore({ kv, store, ...d.deps }, { batchSize: 2 });
    await core.request("download");
    await d.drain(core, 1 + 3);
    expect(Object.keys(kv.get<object>("job")!).sort()).toEqual(OLD_ALLOCATION_JOB_KEYS);
    await d.drain(core);
    expect([...kv.map.keys()].sort()).toEqual(["file", "runs"]);
    expect(Object.keys(kv.get<object>("file")!)).toEqual(["generatedAt", "rows", "races", "missingOdds", "noAllocation", "excluded", "bytes", "diag"]);
  });

  it("古い形の file・runs が残っていても読める: status / download は ready、1 日の回数が尽きていれば refresh は throttled", async () => {
    const day = "2026-10-10";
    const priorFile = { generatedAt: "2026-10-09T12:00:00.000Z", rows: 15, races: 5, missingDetail: 1, excluded: { suspect: 0, unknown: 0, unchecked: 0, superseded: 0 }, bytes: 999, diag: { rowsRead: 10, gets: 5 } };
    const allocationFile = { generatedAt: "2026-10-09T12:00:00.000Z", rows: 5, races: 5, missingOdds: 1, noAllocation: 2, excluded: { suspect: 0, unknown: 0, unchecked: 0, uncheckedRaces: 0, superseded: 0, estimated: 0 }, bytes: 888, diag: { rowsRead: 10, gets: 5 } };

    const kv1 = new FakeKv();
    kv1.put("file", priorFile);
    kv1.put("runs", { day, count: 3 });
    const d1 = driver();
    const prior = new PriorExportCore({ kv: kv1, store: new PriorFakeStore(), ...d1.deps });
    expect(await prior.request("status")).toEqual({ status: "ready", file: priorFile });
    expect(await prior.request("download")).toEqual({ status: "ready", file: priorFile });
    expect(await prior.request("refresh")).toEqual({ status: "throttled", nextAt: "2026-10-10T15:00:00.000Z", file: priorFile });
    expect(T0).toBeGreaterThan(Date.parse(`${day}T00:00:00.000Z`)); // 前提: 時計は同じ日(JST)の中

    const kv2 = new FakeKv();
    kv2.put("file", allocationFile);
    kv2.put("runs", { day, count: 3 });
    const d2 = driver();
    const allocation = new AllocationExportCore({ kv: kv2, store: new AllocationFakeStore(), ...d2.deps });
    expect(await allocation.request("status")).toEqual({ status: "ready", file: allocationFile });
    expect(await allocation.request("download")).toEqual({ status: "ready", file: allocationFile });
    expect(await allocation.request("refresh")).toEqual({ status: "throttled", nextAt: "2026-10-10T15:00:00.000Z", file: allocationFile });
  });
});
