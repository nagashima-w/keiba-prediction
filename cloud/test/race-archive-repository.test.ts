import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildRaceRecord, type RaceRecord } from "../../packages/core/src/scraper/race-record.js";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import { decodeRaceArchive, encodeRaceArchive, raceArchiveKeyOf } from "../src/race-archive-format";
import { D1RaceArchiveStore, DB_SIZE_LIMIT_BYTES, type RaceArchiveDb } from "../src/race-archive-repository";
import { openLocalBindings, spyBucket, type LocalBindings } from "./local-bindings";

/**
 * Issue #551(#549-A2): 過去の結果ページの保存(R2 → D1)と読み出し。ローカル(workerd)の本物の D1・R2 で確かめる。
 * 固定するもの: R2 の操作回数(put・get)・D1 の書き込み行数(`meta.rows_written`)・目録の行・柵と大きさの守り・冪等・失敗からのやり直し。
 * ★限界: ローカルの D1 の `size_after` はページ単位の小さな値で、400MB には届かない。上限の前後は、`size_after` を差し替える窓口(`meterDb`)で固定する。
 *   本番の D1 の `size_after` の意味・R2 の挙動は、本番の最初の保存で確かめる(この Issue では本番の Worker はこの部品を呼ばない)。
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const load = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf-8");
function mustRecord(html: string, raceId: string, kind: "central" | "nar"): RaceRecord {
  const r = buildRaceRecord(html, raceId, kind);
  if (!r.ok) {
    throw new Error(`読めるはずのレースが読めなかった: ${r.category} ${r.detail}`);
  }
  return r.record;
}

const CENTRAL_HTML = load("history_central_result_202105040811.html");
const NAR_HTML = load("history_nar_result_202146110310.html");
const CENTRAL = mustRecord(CENTRAL_HTML, "202105040811", "central");
const NAR = mustRecord(NAR_HTML, "202146110310", "nar");
const CENTRAL_KEY = raceArchiveKeyOf("202105040811");

const T1 = "2026-11-01T01:02:03.456Z";
const T2 = "2026-11-02T04:05:06.789Z";
const YM = 202611;

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
  // reset() は R2 を消さない。このファイルは R2 のオブジェクトの有無を検査するので、毎回空にする(テスト側だけが list・delete を使う)。
  const keys = (await local.r2.list()).objects.map((o) => o.key);
  if (keys.length > 0) {
    await local.r2.delete(keys);
  }
});

interface BatchLog {
  readonly size: number;
  readonly metas: ReadonlyArray<{ readonly changes: number; readonly rowsWritten: number; readonly rowsRead: number }>;
}
interface MeterOptions {
  /** すべての結果の `meta.size_after` を、この値(undefined も可)に差し替える。 */
  readonly sizeAfter?: unknown;
  /** n 番目(0 始まり)の batch を例外にする(実行しない)。 */
  readonly failBatch?: (index: number) => boolean;
  /** この SQL の部分文字列を含む prepare(...).run() を例外にする。 */
  readonly failRunWhen?: string;
}

/** D1 の窓口の記録つき転送: batch ごとに文の数と各文の changes・rows_written・rows_read を記録する。 */
function meterDb(real: D1Database, options: MeterOptions = {}): { db: RaceArchiveDb; batches: BatchLog[]; prepared: string[] } {
  const batches: BatchLog[] = [];
  const prepared: string[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      const statement = real.prepare(sql);
      if (options.failRunWhen !== undefined && sql.includes(options.failRunWhen)) {
        return new Proxy(statement, {
          get(target, prop) {
            if (prop === "bind") return (...args: unknown[]) => new Proxy(target.bind(...args), { get: (t, p) => (p === "run" ? () => Promise.reject(new Error("D1_ERROR: injected run failure")) : Reflect.get(t, p)) });
            return Reflect.get(target, prop);
          },
        });
      }
      return statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const index = batches.length;
      if (options.failBatch?.(index) === true) {
        batches.push({ size: statements.length, metas: [] });
        throw new Error("D1_ERROR: injected batch failure");
      }
      const results = await real.batch(statements);
      batches.push({ size: statements.length, metas: results.map((r) => ({ changes: r.meta.changes, rowsWritten: r.meta.rows_written, rowsRead: r.meta.rows_read })) });
      if ("sizeAfter" in options) {
        return results.map((r) => ({ ...r, meta: { ...r.meta, size_after: options.sizeAfter } })) as typeof results;
      }
      return results;
    },
  } as unknown as RaceArchiveDb;
  return { db, batches, prepared };
}

let clock = new Date(T1);
function makeStore(options: MeterOptions & { readonly maxDbBytes?: number; readonly bucket?: Parameters<typeof spyBucket>[1] } = {}) {
  const meter = meterDb(local.db, options);
  const spy = spyBucket(local.r2, options.bucket);
  const store = new D1RaceArchiveStore({ db: meter.db, bucket: spy.bucket, now: () => clock, ...(options.maxDbBytes === undefined ? {} : { maxDbBytes: options.maxDbBytes }) });
  return { store, ...meter, calls: spy.calls };
}
beforeEach(() => {
  clock = new Date(T1);
});

async function catalog(): Promise<Array<Record<string, unknown>>> {
  return (await local.db.prepare("SELECT * FROM race_archive ORDER BY race_id").all()).results as Array<Record<string, unknown>>;
}
async function ops(): Promise<{ classA: number; classB: number } | null> {
  return local.db.prepare("SELECT class_a AS classA, class_b AS classB FROM r2_ops WHERE ym = ?").bind(YM).first();
}
async function seedOps(classA: number, classB: number, ym = YM): Promise<void> {
  await local.db.prepare("INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, ?)").bind(ym, classA, classB).run();
}
async function r2Keys(): Promise<string[]> {
  return (await local.r2.list()).objects.map((o) => o.key).sort();
}

describe("保存: 新規(R2 → D1)", () => {
  it("中央の 1 レース: R2 の put 1 回・get 0 回、D1 は読み取りの batch(2 文)と書き込みの batch(2 文)。書き込み行数は目録 1 + 計数 1 = 2。目録の行・r2_ops が期待どおり", async () => {
    const { store, calls, batches } = makeStore();
    const result = await store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") throw new Error("unreachable");
    expect(result.key).toBe(CENTRAL_KEY);

    // R2: put がちょうど 1 回。get・その他は無い
    expect(calls.map((c) => [c.op, c.key])).toEqual([["put", CENTRAL_KEY]]);
    // D1: 2 回の batch(読み取り: r2_ops と SELECT 1 / 書き込み: 計数と目録)
    expect(batches.map((b) => b.size)).toEqual([2, 2]);
    expect(batches[0]!.metas.map((m) => m.rowsWritten)).toEqual([0, 0]); // 読み取りの batch は書かない
    expect(batches[1]!.metas.map((m) => m.rowsWritten)).toEqual([1, 1]); // 計数 1 行・目録 1 行
    expect(batches[1]!.metas.map((m) => m.changes)).toEqual([1, 1]);

    // 目録の行
    const rows = await catalog();
    const encoded = encodeRaceArchive({ record: CENTRAL, html: CENTRAL_HTML, fetchedAt: T1 });
    expect(rows).toEqual([{ race_id: "202105040811", kind: "central", race_date: "2021-10-31", parser_version: CENTRAL.parserVersion, r2_key: CENTRAL_KEY, raw_bytes: encoded.rawBytes, fetched_at: T1 }]);
    // r2_ops: 今月(UTC 2026-11)の Class A が 1、Class B は 0
    expect(await ops()).toEqual({ classA: 1, classB: 0 });
    // 戻り値の大きさは、ローカルの D1 が返した実際の値(ページ単位の正の数)
    expect(result.dbSizeBytes).toBeGreaterThan(0);
    expect(result.dbSizeBytes! % 4096).toBe(0);
  });

  it("R2 に置かれた中身は gzip で、レコード・HTML・読み取りの版・取得時刻が戻る", async () => {
    const { store } = makeStore();
    await store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    const object = await local.r2.get(CENTRAL_KEY);
    expect(object).not.toBeNull();
    const bytes = new Uint8Array(await object!.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    const payload = decodeRaceArchive(bytes);
    expect(payload).not.toBeNull();
    expect(payload!.html).toBe(CENTRAL_HTML);
    expect(payload!.record).toStrictEqual(CENTRAL);
    expect(payload!.fetchedAt).toBe(T1);
    expect(payload!.parserVersion).toBe(CENTRAL.parserVersion);
  });

  it("地方: kind は nar、race_date は record.date", async () => {
    const { store } = makeStore();
    expect((await store.saveRaceArchive({ record: NAR, html: NAR_HTML })).status).toBe("saved");
    const [row] = await catalog();
    expect(row).toMatchObject({ race_id: "202146110310", kind: "nar", race_date: NAR.date, r2_key: raceArchiveKeyOf("202146110310") });
    expect(NAR.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("R2 が先、D1 が後: put の時点では、目録の行も計数もまだ無い", async () => {
    let seen: { catalog: number; ops: unknown } | null = null;
    const { store } = makeStore({
      bucket: {
        beforePut: async () => {
          seen = { catalog: (await catalog()).length, ops: await ops() };
        },
      },
    });
    await store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    expect(seen).toEqual({ catalog: 0, ops: null });
    expect(await catalog()).toHaveLength(1); // 前提: 保存後には行がある(上の「まだ無い」が空振りでない)
  });
});

describe("保存: 冪等(同じレースを何度保存しても目録は 1 行)", () => {
  it("同じ中身を取得時刻だけ変えて再保存: unchanged。目録の行(fetched_at を含む)は据え置き、書き込み行数は目録 0 + 計数 1。R2 は put 1 回(上書き)、Class A は 2", async () => {
    const first = makeStore();
    await first.store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    const before = await catalog();
    clock = new Date(T2);
    const second = makeStore();
    const result = await second.store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    expect(result.status).toBe("unchanged");
    expect(second.calls.map((c) => [c.op, c.key])).toEqual([["put", CENTRAL_KEY]]);
    expect(second.batches[1]!.metas.map((m) => m.rowsWritten)).toEqual([1, 0]); // 計数 1 行・目録 0 行
    expect(second.batches[1]!.metas.map((m) => m.changes)).toEqual([1, 0]);
    const after = await catalog();
    expect(after).toEqual(before); // 前提の確認を兼ねる: 1 行のまま・fetched_at は T1 のまま
    expect(after[0]!["fetched_at"]).toBe(T1);
    expect(await ops()).toEqual({ classA: 2, classB: 0 });
    // R2 の中身の取得時刻は新しくなる(目録とは別。R2 が本体)
    const payload = decodeRaceArchive(new Uint8Array(await (await local.r2.get(CENTRAL_KEY))!.arrayBuffer()));
    expect(payload!.fetchedAt).toBe(T2);
  });

  it("3 回保存しても目録は 1 行、R2 のオブジェクトは 1 つ", async () => {
    for (const t of [T1, T2, "2026-11-03T00:00:00.000Z"]) {
      clock = new Date(t);
      await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    }
    expect(await catalog()).toHaveLength(1);
    expect(await r2Keys()).toEqual([CENTRAL_KEY]);
    expect(await ops()).toEqual({ classA: 3, classB: 0 });
  });

  it("HTML が変わった(長さが違う)再保存: saved。raw_bytes と fetched_at が新しくなる。書き込み行数は目録 1 + 計数 1", async () => {
    await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    clock = new Date(T2);
    const changed = `${CENTRAL_HTML}<!-- 追記 -->`;
    const second = makeStore();
    expect((await second.store.saveRaceArchive({ record: CENTRAL, html: changed })).status).toBe("saved");
    expect(second.batches[1]!.metas.map((m) => [m.changes, m.rowsWritten])).toEqual([[1, 1], [1, 1]]);
    const [row] = await catalog();
    expect(row!["fetched_at"]).toBe(T2);
    expect(row!["raw_bytes"]).toBe(encodeRaceArchive({ record: CENTRAL, html: changed, fetchedAt: T2 }).rawBytes);
  });

  it("読み取りの版が上がった再保存: saved。parser_version が新しくなる", async () => {
    await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    clock = new Date(T2);
    const v3 = { ...CENTRAL, parserVersion: CENTRAL.parserVersion + 1 };
    expect((await makeStore().store.saveRaceArchive({ record: v3, html: CENTRAL_HTML })).status).toBe("saved");
    const [row] = await catalog();
    expect(row!["parser_version"]).toBe(CENTRAL.parserVersion + 1);
    expect(row!["fetched_at"]).toBe(T2);
  });
});

describe("保存: R2 の操作回数の柵(Class A)", () => {
  it("今月の Class A が柵に達していれば、保存しない: skipped(r2-fence)・put 0 回・書き込みの batch なし・目録も計数も増えない", async () => {
    await seedOps(R2_FENCE_LIMITS.classA, 0);
    const { store, calls, batches } = makeStore();
    const result = await store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    expect(result).toMatchObject({ status: "skipped", reason: "r2-fence" });
    expect(calls).toEqual([]);
    expect(batches.map((b) => b.size)).toEqual([2]); // 読み取りの batch だけ
    expect(await catalog()).toEqual([]);
    expect(await ops()).toEqual({ classA: R2_FENCE_LIMITS.classA, classB: 0 });
  });

  it("境界: 柵の 1 つ手前(上限 − 1)なら保存でき、計数が上限に達する。次の保存は止まる", async () => {
    await seedOps(R2_FENCE_LIMITS.classA - 1, 0);
    expect((await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML })).status).toBe("saved");
    expect(await ops()).toEqual({ classA: R2_FENCE_LIMITS.classA, classB: 0 });
    const next = makeStore();
    expect(await next.store.saveRaceArchive({ record: NAR, html: NAR_HTML })).toMatchObject({ status: "skipped", reason: "r2-fence" });
    expect(next.calls).toEqual([]);
  });

  it("Class B(読み出し)が柵に達していても、保存は止まらない(書き込みの柵は Class A だけを見る)", async () => {
    await seedOps(0, R2_FENCE_LIMITS.classB);
    expect((await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML })).status).toBe("saved");
  });

  it("月が変われば数え直す(UTC の yyyymm)。先月が柵に達していても、今月は保存できる", async () => {
    await seedOps(R2_FENCE_LIMITS.classA, 0, 202610);
    expect((await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML })).status).toBe("saved");
    expect(await ops()).toEqual({ classA: 1, classB: 0 });
  });
});

describe("保存: D1 の大きさの守り(400,000,000 バイトを超えたら保存しない)", () => {
  it("前提: 既定の上限は 400,000,000(10 進)", () => {
    expect(DB_SIZE_LIMIT_BYTES).toBe(400_000_000);
  });

  it("ちょうど上限なら保存する。1 バイトでも超えたら skipped(db-size)で、put 0 回・書き込みの batch なし・目録も計数も増えない", async () => {
    const atLimit = makeStore({ sizeAfter: DB_SIZE_LIMIT_BYTES });
    const saved = await atLimit.store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    expect(saved).toMatchObject({ status: "saved", dbSizeBytes: DB_SIZE_LIMIT_BYTES });
    expect(await catalog()).toHaveLength(1);

    await local.reset();
    const over = makeStore({ sizeAfter: DB_SIZE_LIMIT_BYTES + 1 });
    const result = await over.store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    expect(result).toEqual({ status: "skipped", reason: "db-size", dbSizeBytes: DB_SIZE_LIMIT_BYTES + 1 });
    expect(over.calls).toEqual([]);
    expect(over.batches.map((b) => b.size)).toEqual([2]);
    expect(await catalog()).toEqual([]);
    expect(await ops()).toBeNull();
  });

  it("size_after が取れなければ(undefined・数でない・NaN・負)保存しない: skipped(db-size-unknown)・dbSizeBytes は null・put 0 回", async () => {
    for (const bad of [undefined, null, "400", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const { store, calls } = makeStore({ sizeAfter: bad });
      const result = await store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
      expect(result, String(bad)).toEqual({ status: "skipped", reason: "db-size-unknown", dbSizeBytes: null });
      expect(calls, String(bad)).toEqual([]);
    }
    expect(await catalog()).toEqual([]);
  });

  it("上限は注入できる(maxDbBytes)。ローカルの実際の D1(数 KB)でも、上限 1 なら db-size", async () => {
    const { store, calls } = makeStore({ maxDbBytes: 1 });
    const result = await store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    expect(result.status).toBe("skipped");
    expect(result).toMatchObject({ reason: "db-size" });
    expect(result.dbSizeBytes).toBeGreaterThan(1);
    expect(calls).toEqual([]);
  });

  it("大きさと柵の両方に当たるときは、db-size を先に返す(D1 を守るほうを優先)", async () => {
    await seedOps(R2_FENCE_LIMITS.classA, 0);
    const result = await makeStore({ sizeAfter: DB_SIZE_LIMIT_BYTES + 1 }).store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    expect(result).toMatchObject({ status: "skipped", reason: "db-size" });
  });
});

describe("保存: 失敗からのやり直し", () => {
  it("R2 の put が失敗: 例外。目録も計数も増えない(D1 は読み取りだけ)。再試行しない(put 1 回)。もう一度保存すれば saved", async () => {
    const failing = makeStore({ bucket: { failPut: () => true } });
    await expect(failing.store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML })).rejects.toThrow(/injected put failure/);
    expect(failing.calls.filter((c) => c.op === "put")).toHaveLength(1);
    expect(failing.batches.map((b) => b.size)).toEqual([2]);
    expect(await catalog()).toEqual([]);
    expect(await ops()).toBeNull();
    expect(await r2Keys()).toEqual([]);

    expect((await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML })).status).toBe("saved");
    expect(await catalog()).toHaveLength(1);
  });

  it("R2 の put のあと D1 の書き込みが失敗: 例外。R2 には置かれたまま、目録は無い。もう一度保存すれば saved になり、目録が 1 行になる", async () => {
    const failing = makeStore({ failBatch: (i) => i === 1 });
    await expect(failing.store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML })).rejects.toThrow(/injected batch failure/);
    expect(await r2Keys()).toEqual([CENTRAL_KEY]); // R2 が先
    expect(await catalog()).toEqual([]);
    expect(await ops()).toBeNull(); // 計数も目録と同じ batch なので、一緒に落ちる

    const retry = makeStore();
    expect((await retry.store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML })).status).toBe("saved");
    expect(await catalog()).toHaveLength(1);
    expect(await r2Keys()).toEqual([CENTRAL_KEY]);
  });

  it("D1 の読み取りの batch が失敗: 例外。R2 に何も書かない", async () => {
    const { store, calls } = makeStore({ failBatch: (i) => i === 0 });
    await expect(store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML })).rejects.toThrow(/injected batch failure/);
    expect(calls).toEqual([]);
  });
});

describe("保存: 入力の検査(R2・D1 に触れる前に落とす)", () => {
  it.each([["race_id が 12 桁でない", { ...CENTRAL, raceId: "2021050408" }], ["race_id に / を含む", { ...CENTRAL, raceId: "../2021050408" }], ["JSON にできない値(BigInt)", { ...CENTRAL, raceNumber: 1n as unknown as number }]])("%s: 例外。D1 も R2 も呼ばれない", async (_label, record) => {
    const { store, calls, batches, prepared } = makeStore();
    await expect(store.saveRaceArchive({ record: record as RaceRecord, html: "x" })).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(batches).toEqual([]);
    expect(prepared).toEqual([]);
  });

  it("kind が central・nar 以外、日付が YYYY-MM-DD でないレコードは例外(目録の CHECK に任せず、R2 に置く前に落とす)", async () => {
    for (const record of [{ ...CENTRAL, kind: "other" }, { ...CENTRAL, date: "2021/10/31" }, { ...CENTRAL, parserVersion: 1.5 }]) {
      const { store, calls } = makeStore();
      await expect(store.saveRaceArchive({ record: record as unknown as RaceRecord, html: "x" })).rejects.toThrow(RangeError);
      expect(calls).toEqual([]);
    }
  });
});

describe("読み出し", () => {
  it("保存したレースが戻る(レコード・HTML・取得時刻)。R2 の get 1 回、Class B が 1 増える。D1 は計数の更新が 1 文", async () => {
    await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    const { store, calls, prepared } = makeStore();
    const result = await store.readRaceArchive("202105040811");
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("unreachable");
    expect(result.archive.record).toStrictEqual(CENTRAL);
    expect(result.archive.html).toBe(CENTRAL_HTML);
    expect(result.archive.fetchedAt).toBe(T1);
    expect(calls.map((c) => [c.op, c.key])).toEqual([["get", CENTRAL_KEY]]);
    expect(prepared.filter((s) => s.includes("class_b"))).toHaveLength(2); // 柵の判定の読み取り(SELECT)と、計数(UPDATE)
    expect(await ops()).toEqual({ classA: 1, classB: 1 });
  });

  it("R2 に無いレース: missing。get は 1 回行ったので Class B は数える", async () => {
    const { store, calls } = makeStore();
    expect(await store.readRaceArchive("202105040811")).toEqual({ status: "missing" });
    expect(calls.map((c) => c.op)).toEqual(["get"]);
    expect(await ops()).toEqual({ classA: 0, classB: 1 });
  });

  it("壊れたオブジェクト・別のレースの保存物が置かれたキー・読み取りの版が食い違う保存物は missing(クラッシュしない)", async () => {
    const key = CENTRAL_KEY;
    await local.r2.put(key, new Uint8Array([1, 2, 3]));
    expect(await makeStore().store.readRaceArchive("202105040811")).toEqual({ status: "missing" });
    // 別のレース(地方)の保存物を、中央のキーに置く
    await local.r2.put(key, encodeRaceArchive({ record: NAR, html: NAR_HTML, fetchedAt: T1 }).body);
    expect(await makeStore().store.readRaceArchive("202105040811")).toEqual({ status: "missing" });
    // 対照: 正しい保存物なら found(上の missing が、読み出しが常に missing を返すせいではない)
    await local.r2.put(key, encodeRaceArchive({ record: CENTRAL, html: CENTRAL_HTML, fetchedAt: T1 }).body);
    expect((await makeStore().store.readRaceArchive("202105040811")).status).toBe("found");
  });

  it("Class B が柵に達していれば、R2 を引かず skipped(r2-fence)。計数もしない。Class A が柵に達していても読める", async () => {
    await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    await local.db.prepare("UPDATE r2_ops SET class_b = ?, class_a = ? WHERE ym = ?").bind(R2_FENCE_LIMITS.classB, R2_FENCE_LIMITS.classA, YM).run();
    const { store, calls } = makeStore();
    expect(await store.readRaceArchive("202105040811")).toEqual({ status: "skipped", reason: "r2-fence" });
    expect(calls).toEqual([]);
    expect(await ops()).toEqual({ classA: R2_FENCE_LIMITS.classA, classB: R2_FENCE_LIMITS.classB });
    // 境界: 1 つ手前なら読める
    await local.db.prepare("UPDATE r2_ops SET class_b = ? WHERE ym = ?").bind(R2_FENCE_LIMITS.classB - 1, YM).run();
    expect((await makeStore().store.readRaceArchive("202105040811")).status).toBe("found");
    expect((await ops())!.classB).toBe(R2_FENCE_LIMITS.classB);
  });

  it("R2 の get が失敗: 例外(「無い」と区別する。段階 B が、取れなかったレースを無いものとして進めないため)。要求は出たので Class B は数える", async () => {
    const { store } = makeStore({ bucket: { failGet: true } });
    await expect(store.readRaceArchive("202105040811")).rejects.toThrow(/injected get failure/);
    expect(await ops()).toEqual({ classA: 0, classB: 1 });
  });

  it("計数(Class B の +1)が失敗しても、読み出しは成功する(best-effort)", async () => {
    await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    const { store } = makeStore({ failRunWhen: "class_b = class_b + 1" });
    expect((await store.readRaceArchive("202105040811")).status).toBe("found");
    expect(await ops()).toEqual({ classA: 1, classB: 0 }); // 前提: 計数は実際に失敗している(上の成功が、計数を呼ばなかったせいではない)
  });

  it("race_id が 12 桁でなければ RangeError。R2 にも D1 にも触れない", async () => {
    const { store, calls, prepared } = makeStore();
    await expect(store.readRaceArchive("abc")).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
    expect(prepared).toEqual([]);
  });
});

describe("目録の 1 行の取得", () => {
  it("保存したレースの行が、読みやすい形で戻る。無いレースは null", async () => {
    await makeStore().store.saveRaceArchive({ record: CENTRAL, html: CENTRAL_HTML });
    const { store, calls } = makeStore();
    expect(await store.getCatalogEntry("202105040811")).toEqual({
      raceId: "202105040811",
      kind: "central",
      raceDate: "2021-10-31",
      parserVersion: CENTRAL.parserVersion,
      r2Key: CENTRAL_KEY,
      rawBytes: encodeRaceArchive({ record: CENTRAL, html: CENTRAL_HTML, fetchedAt: T1 }).rawBytes,
      fetchedAt: T1,
    });
    expect(await store.getCatalogEntry("202146110310")).toBeNull();
    expect(calls).toEqual([]); // R2 には触れない
    await expect(store.getCatalogEntry("x")).rejects.toThrow(RangeError);
  });
});
