import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { AllocationExportCore } from "../src/allocation-export-core";
import { ALLOCATION_EXPORT_KEY } from "../src/allocation-export-format";
import { PriorExportCore } from "../src/prior-export-core";
import { PRIOR_EXPORT_KEY, assembleFile } from "../src/prior-export-format";
import { AllocationFakeStore, FakeKv, PriorFakeStore, cand, driver, raceIdOf } from "./export-fixtures";

/**
 * Issue #495: 仕上げを流す方式にそろえても、書き出すファイルは 1 バイトも変わらない。
 *
 * 正解を 2 つ持つ。
 *  (1) 実行時に作る正解: 統計モデル用は、kv に置かれた塊(`chunk:i`)から `assembleFile`(全体を 1 本につなげる従来の組み立て)で作り直したバイト列と、
 *      圧縮後まで完全に一致すること。
 *  (2) 固定した正解: **実装前の起点(3762f72)のコードで測った**、伸長後の NDJSON 全体の sha256(base64。64 桁の 16 進は、`cloud-config-guard.test.ts` が Access の AUD の混入として拒むため)。時刻(clock)・入力はすべて決定的。
 *      gzip の圧縮後のバイト列は zlib の版で変わりうるので、固定値は伸長後でとる。測定の手順は `cloud/test/export-fixtures.ts` の入力を
 *      起点のコードで走らせて、伸長した全体の sha256 を取る(統計モデル用は `putFile`、配分用は `putFileStream` で受ける)。
 *      **統計モデル用の固定値は、書き出しの形式を上げたとき〈Issue #526 の format 4〉に、列とメタ行の notes が変わるので測り直した**
 *      (測り直した値は、ファイルの組み立てを変える前後の一致を見る回帰の固定であって、列の中身の正解ではない。検算: 行ごとの増分は 1 行 44 バイト〈`,"jockey_name":"騎手1","jockey_id":"01001"`〉、詳細なしの行は 36 バイト〈両列 null〉、メタ行の増分は 944 バイトで、4 つの場面とも和が合う)。
 *      **format 5〈Issue #526 段階 1b〉でもう一度測り直した**(`jockey_id_source` の 1 列と注記が増えた)。検算: 行ごとの増分は、ID のある行が 30 バイト〈`,"jockey_id_source":"snapshot"`〉、詳細なしの行が 24 バイト〈`,"jockey_id_source":null`〉、
 *      メタ行の増分は 1,466 バイト〈format 4 のコードのメタ行 4,638 → 6,104。`git show HEAD:cloud/src/prior-export-format.ts` の旧版と現行版の `buildPriorHead` を同じ引数で伸長した長さの差〉。
 *      場面ごとの伸長後の長さ: 5 レース 16,529 → 18,445(= 16,529 + 15 行 × 30 + 1,466)、詳細なし 16,109 → 18,007(= 16,109 + 12 行 × 30 + 3 行 × 24 + 1,466)、候補 0 件 4,638 → 6,104(= 4,638 + 1,466)、
 *      7 レース・5 頭 32,527 → 35,043(= 32,527 + 35 行 × 30 + 1,466)で、4 つの場面とも和が合う。この場面は対応が空(`PriorFakeStore.lookups`)なので、名前から埋めた行は無い。**配分用の 3 場面の固定値は、format 5 でも一切変えていない**(共有の組み立てに引き当て用の表のフックを足しても、配分用のバイト列は不変)。
 *      **配分用の固定値は、Issue #533 で設定の列〈`max_win_bets`・`max_place_bets`〉とメタ行の注記が増えたときに測り直した**(同じ意味の回帰の固定)。検算: 行ごとの増分は、配分のメタのある行が 36 バイト
 *      〈`,"max_win_bets":0,"max_place_bets":0`〉、メタ行の増分は 174 バイト〈注記 1 つの 287 → 461。`git show HEAD:cloud/src/allocation-export-format.ts` の旧版と現行版の注記を UTF-8 で数えた〉。
 *      場面ごとの伸長後の長さ: 5 レース 12,884 → 13,238(= 12,884 + 5 行 × 36 + 174)、詳細なし・配分のメタなし 12,206 → 12,524(= 12,206 + 4 行 × 36 + 174。メタのない 1 行は設定を持たない)、候補 0 件 3,124 → 3,298(= 3,124 + 174)。
 */

const sha256 = (gz: Uint8Array): string => createHash("sha256").update(gunzipSync(gz)).digest("base64");
const excluded = [cand(1, raceIdOf(1), { historyCutoffDate: null, startTime: null }), cand(2, raceIdOf(2), { historyCutoffDate: null, startTime: "10:05", analyzedAt: "2026-10-10T03:00:00.000Z" })];

interface Scenario {
  readonly name: string;
  readonly races: number;
  readonly batchSize: number;
  readonly noDetail?: number[];
  readonly noMeta?: number[];
  readonly horses?: number;
  readonly candidates?: typeof excluded;
  /** 起点のコードで測った、伸長後の sha256。 */
  readonly sha256: string;
  readonly plainBytes: number;
}

const PRIOR: Scenario[] = [
  { name: "5 レース・batch 2", races: 5, batchSize: 2, sha256: "BR1WHG//lqZIZDABJSC0kGUDRLZ9GaUY0jVfKzjGm3c=", plainBytes: 18445 },
  { name: "5 レース・batch 2・詳細なし(101)", races: 5, batchSize: 2, noDetail: [101], sha256: "PrLoHv79TWZm0RSsIA7ewJlwvWhov/PmeZZ7P5DzdG4=", plainBytes: 18007 },
  { name: "候補 0 件(除外だけ。メタ行だけのファイル)", races: 0, batchSize: 2, candidates: excluded, sha256: "2MB7Zjc0Jw4HMhF4g0K91OA7e+tw2M88IPo6CEUFlQY=", plainBytes: 6104 },
  { name: "7 レース・batch 3・5 頭", races: 7, batchSize: 3, horses: 5, sha256: "ePfBUobf9Oz0hOdMLExKAZQfTSHDVdFia96V1/JXRN4=", plainBytes: 35043 },
];
const ALLOCATION: Scenario[] = [
  { name: "5 レース・batch 2", races: 5, batchSize: 2, sha256: "jK9gg3shwuHhxzlM5//LIGCTPzE5s6KCQyhEcr9ciaU=", plainBytes: 13238 },
  { name: "5 レース・batch 2・詳細なし(101)・配分のメタなし(102)", races: 5, batchSize: 2, noDetail: [101], noMeta: [102], sha256: "dp75SO9NsKgJpUSGHeMVUol+gyR9Y4trjIi/tDYqIQc=", plainBytes: 12524 },
  { name: "候補 0 件(除外だけ。メタ行だけのファイル)", races: 0, batchSize: 2, candidates: excluded, sha256: "Cb8nmBXQbsviPhRnre7qTrSNaWV5cJ8Q/8sJ+bHkTio=", plainBytes: 3298 },
];

function candidatesOf(s: Scenario) {
  return s.candidates ?? Array.from({ length: s.races }, (_, i) => cand(100 + i, raceIdOf(i + 1)));
}

describe("統計モデル用: 仕上げを流す方式にしても、ファイルのバイト列は従来の組み立て(assembleFile)と一致する", () => {
  for (const s of PRIOR) {
    it(`${s.name}: 圧縮後のバイト列が assembleFile と完全一致し、伸長後の sha256 が起点の値と一致する。塊はメタ行 + batch の数だけ、総バイト数は実際の長さに等しい`, async () => {
      const kv = new FakeKv();
      const store = new PriorFakeStore();
      store.candidates = candidatesOf(s);
      store.noDetail = new Set(s.noDetail ?? []);
      if (s.horses !== undefined) store.horsesPerRace = s.horses;
      const d = driver();
      const core = new PriorExportCore({ kv, store, ...d.deps }, { batchSize: s.batchSize });
      await core.request("download");
      const batches = Math.ceil(s.races / s.batchSize);
      await d.drain(core, 1 + batches); // 計画 + 処理(仕上げの手前まで)
      expect(kv.get("job")).toMatchObject({ state: "running", phase: "finalizing", batches });
      const chunks = Array.from({ length: batches }, (_, i) => kv.get<Uint8Array>(`chunk:${i}`)!);
      expect(chunks).toHaveLength(batches);
      expect(chunks.every((c) => c !== undefined && c.length > 0)).toBe(true); // 前提: 塊を実際に読めている
      await d.drain(core);

      expect(store.puts).toHaveLength(1);
      const put = store.puts[0]!;
      const file = kv.get<{ generatedAt: string; rows: number; races: number; missingDetail: number; excluded: Record<string, number>; bytes: number }>("file")!;
      // 従来の組み立て(メタの引数のキーの並びは、従来の仕上げと同じ)
      const expected = assembleFile({ generatedAt: file.generatedAt, rows: file.rows, races: file.races, missingDetail: file.missingDetail, excluded: file.excluded as never }, chunks);
      expect(expected.length).toBeGreaterThan(0);
      expect(Buffer.from(put.bytes).equals(Buffer.from(expected))).toBe(true);
      expect(put.key).toBe(PRIOR_EXPORT_KEY);
      expect(put.parts).toHaveLength(1 + batches);
      expect(put.totalBytes).toBe(expected.length);
      expect(file.bytes).toBe(expected.length);
      expect(put.info).toEqual({ generatedAt: file.generatedAt, rows: file.rows, races: file.races });
      // 起点で測った固定値
      expect(gunzipSync(put.bytes).length).toBe(s.plainBytes);
      expect(sha256(put.bytes)).toBe(s.sha256);
    });
  }
});

describe("配分用: 仕上げのバイト列は起点のコードで測った値と一致する(共通化で塊の組み立てを動かしたため)", () => {
  for (const s of ALLOCATION) {
    it(`${s.name}: 伸長後の sha256 が起点の値と一致する。塊はメタ行 + batch の数だけ、総バイト数は実際の長さに等しい`, async () => {
      const kv = new FakeKv();
      const store = new AllocationFakeStore();
      store.candidates = candidatesOf(s);
      store.noDetail = new Set(s.noDetail ?? []);
      store.noMeta = new Set(s.noMeta ?? []);
      const d = driver();
      const core = new AllocationExportCore({ kv, store, ...d.deps }, { batchSize: s.batchSize });
      await core.request("download");
      await d.drain(core);
      expect(store.puts).toHaveLength(1);
      const put = store.puts[0]!;
      const file = kv.get<{ bytes: number }>("file")!;
      expect(put.key).toBe(ALLOCATION_EXPORT_KEY);
      expect(put.parts).toHaveLength(1 + Math.ceil(s.races / s.batchSize));
      expect(put.totalBytes).toBe(put.bytes.length);
      expect(file.bytes).toBe(put.bytes.length);
      expect(gunzipSync(put.bytes).length).toBe(s.plainBytes);
      expect(sha256(put.bytes)).toBe(s.sha256);
    });
  }
});

describe("配分用: メタ行の missingOdds と noAllocation は取り違えない(Issue #507。2 つが違う値のシナリオ)", () => {
  // 上の固定値のシナリオは、詳細なし 1 件・配分のメタなし 1 件で、2 つの数が同じ 1 になる。取り違えても気づけないので、別のテストで 2 つを違う数にする。
  // 固定値(sha256)は起点のコードで測ったものなので、上のシナリオ・フィクスチャは変えない。
  it("詳細なし 2 件(101・103)・配分のメタなし 1 件(102): メタ行・kv の file とも missingOdds=2・noAllocation=1", async () => {
    const kv = new FakeKv();
    const store = new AllocationFakeStore();
    store.candidates = Array.from({ length: 5 }, (_, i) => cand(100 + i, raceIdOf(i + 1)));
    store.noDetail = new Set([101, 103]);
    store.noMeta = new Set([102]);
    const d = driver();
    const core = new AllocationExportCore({ kv, store, ...d.deps }, { batchSize: 2 });
    await core.request("download");
    await d.drain(core);
    expect(store.puts).toHaveLength(1);
    const lines = new TextDecoder().decode(gunzipSync(store.puts[0]!.bytes)).split("\n").filter((l) => l !== "");
    const meta = (JSON.parse(lines[0]!) as { _meta: { missingOdds: number; noAllocation: number } })._meta;
    const file = kv.get<{ missingOdds: number; noAllocation: number }>("file")!;
    expect(meta.missingOdds).not.toBe(meta.noAllocation); // 前提: 2 つが違う値(同じだと取り違えを検出できない)
    expect({ missingOdds: meta.missingOdds, noAllocation: meta.noAllocation }).toEqual({ missingOdds: 2, noAllocation: 1 });
    expect({ missingOdds: file.missingOdds, noAllocation: file.noAllocation }).toEqual({ missingOdds: 2, noAllocation: 1 });
    // 行そのものから数えた値とも一致する(has_odds が false の行、allocation が null の行)
    const rows = lines.slice(1).map((l) => JSON.parse(l) as { has_odds: boolean; allocation: unknown });
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => !r.has_odds)).toHaveLength(2);
    expect(rows.filter((r) => r.allocation === null)).toHaveLength(1);
  });
});
