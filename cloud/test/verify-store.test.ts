import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeDetail } from "../src/analysis-detail";
import { D1AnalysisStore } from "../src/analysis-repository";
import { D1ResultStore } from "../src/result-repository";
import { D1VerifyStore, VERIFY_DEFER_MS, type VerifyBucket } from "../src/verify-store";
import { buildVerifySource } from "../src/verify-read";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { openLocalBindings, spyBucket, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #219: 検証の D1・R2 の読み書き(`D1VerifyStore`)を、ローカル(workerd)の D1・R2 で確かめる。
 * ★限界(本番との差): ローカルの D1 は「1回の呼び出しで 50 クエリ」を強制しない。文の数は記録した値で直接 assert する。
 */
let local: LocalBindings;

beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
  // 分析 id を 1 から振り直す(AUTOINCREMENT の採番を戻す)。R2 の同じキーの古い詳細は、各テストの保存が上書きする。
  await local.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'analyses'").run();
});

const NOW = new Date("2026-10-10T12:00:00.000Z");
const OLD = "2026-10-01T00:00:00.000Z";

function mkRecord(i: number, over: Partial<AnalysisRecord> & { startTime?: string | null | undefined } = {}): AnalysisRecord {
  const { startTime, ...rest } = over;
  return {
    raceId: `2026060308${String(10 + i).padStart(2, "0")}`,
    analyzedAt: OLD,
    kaisaiDate: "20261001",
    promptVersion: "v-test",
    raceSnapshot: startTime === undefined ? { race: { raceName: "x" } } : { race: { raceName: "x", startTime } },
    horses: [{ umaban: 1, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 2, ev: 1, isPositive: true, contributions: null, mark: null }],
    ...rest,
  };
}

const analyses = (bucket: VerifyBucket = local.r2, now: Date = NOW) => new D1AnalysisStore({ db: local.db, bucket: local.r2, now: () => now });
const verifyStore = (bucket: VerifyBucket = local.r2, now: Date = NOW) => new D1VerifyStore({ db: local.db, bucket, now: () => now });
async function startTimeOf(id: number): Promise<string | null> {
  return (await local.db.prepare("SELECT start_time AS t FROM analyses WHERE id = ?").bind(id).first<{ t: string | null }>())!.t;
}

describe("readWatermark(再計算の要否の透かし)", () => {
  it("空の D1 は全部 null。分析・結果・組合せ払戻・取込印の保存でそれぞれ動く", async () => {
    const s = verifyStore();
    expect(await s.readWatermark()).toEqual({ analyses: null, results: null, comboPayouts: null, comboImports: null });
    const w0 = await s.readWatermark();
    await analyses().saveAnalysis(mkRecord(1));
    const w1 = await s.readWatermark();
    expect(w1.analyses).toBe(1);
    expect(w1).not.toEqual(w0);
    await new D1ResultStore({ db: local.db }).saveResult("202606030811", [{ umaban: 1, finishPosition: 1, placePayout: 150 }]);
    const w2 = await s.readWatermark();
    expect(w2.results).not.toBeNull();
    expect(w2.results).not.toBe(w1.results);
    await new D1ResultStore({ db: local.db }).saveResult("202606030811", [], null, { wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 300 }] } });
    const w3 = await s.readWatermark();
    expect(w3.comboPayouts).not.toBeNull();
    expect(w3.comboImports).not.toBeNull();
    // 変化が無ければ同じ
    expect(await s.readWatermark()).toEqual(w3);
  });

  it("読み取りは D1 に 1 クエリだけ発行し、読む行数は表の大きさに依らない(各 MAX は 1 行)", async () => {
    for (let i = 1; i <= 5; i += 1) await analyses().saveAnalysis(mkRecord(i));
    const spy = spyDb(local.db);
    const meta = await new D1VerifyStore({ db: spy.db, bucket: local.r2, now: () => NOW }).readWatermark();
    expect(meta.analyses).toBe(5);
    expect(spy.prepared).toHaveLength(1);
    expect(spy.batches).toEqual([]);
  });
});

describe("listPending(start_time が NULL の分析)", () => {
  it("カーソルより後で NULL の行を id 昇順に limit 件と、該当の総数を返す", async () => {
    for (let i = 1; i <= 5; i += 1) await analyses().saveAnalysis(mkRecord(i));
    await local.db.prepare("UPDATE analyses SET start_time = '09:00' WHERE id = 2").run();
    const s = verifyStore();
    const page = await s.listPending(0, 2);
    expect(page.rows.map((r) => r.id)).toEqual([1, 3]);
    expect(page.total).toBe(4);
    expect(page.rows[0]).toMatchObject({ raceId: "202606030811", analyzedAt: OLD, detailKey: "analyses/1.json.gz" });
    const after = await s.listPending(3, 10);
    expect(after.rows.map((r) => r.id)).toEqual([4, 5]);
    expect(after.total).toBe(2);
    expect(await s.listPending(5, 10)).toEqual({ rows: [], total: 0 });
  });
});

describe("resolveStartTimes(R2 の詳細から発走時刻を取り出す)", () => {
  it("時刻あり → 'HH:MM'、スナップショットに時刻なし → ''、読める形でない → ''。R2 の get はちょうど行数(LIST・HEAD は使わない)", async () => {
    await analyses().saveAnalysis(mkRecord(1, { startTime: "15:45" }));
    await analyses().saveAnalysis(mkRecord(2));
    await analyses().saveAnalysis(mkRecord(3, { startTime: "午後" }));
    await analyses().saveAnalysis(mkRecord(4, { startTime: null }));
    const spy = spyBucket(local.r2);
    const s = verifyStore(spy.bucket as unknown as VerifyBucket);
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    expect(out.resolved).toEqual([{ id: 1, value: "15:45" }, { id: 2, value: "" }, { id: 3, value: "" }, { id: 4, value: "" }]);
    expect(out.deferred).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(out.gets).toBe(4);
    expect(spy.calls.filter((c) => c.op === "get")).toHaveLength(4);
  });

  it("detail_key が無い行('保存に R2 を使わなかった')は R2 を読まず '?'(確認できなかった)", async () => {
    await analyses().saveAnalysis(mkRecord(1, { startTime: "15:45" }));
    await local.db.prepare("UPDATE analyses SET detail_key = NULL WHERE id = 1").run();
    const spy = spyBucket(local.r2);
    const s = verifyStore(spy.bucket as unknown as VerifyBucket);
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    expect(out.resolved).toEqual([{ id: 1, value: "?" }]);
    expect(out.gets).toBe(0);
    expect(spy.calls).toEqual([]);
  });

  it("R2 に詳細が無い: 分析から 10 分以上経っていれば '?'、10 分未満なら保留(保存直後の D1 先・R2 後の窓で、誤って '?' にしない)", async () => {
    const recent = new Date(NOW.getTime() - (VERIFY_DEFER_MS - 1000)).toISOString();
    const border = new Date(NOW.getTime() - VERIFY_DEFER_MS).toISOString();
    await analyses().saveAnalysis(mkRecord(1)); // 古い
    await analyses().saveAnalysis(mkRecord(2, { analyzedAt: recent }));
    await analyses().saveAnalysis(mkRecord(3, { analyzedAt: border }));
    // 詳細を消せない(delete は型で禁止)ので、キーを別の存在しないものに付け替える。
    await local.db.prepare("UPDATE analyses SET detail_key = 'analyses/none-' || id WHERE id IN (1, 2, 3)").run();
    const s = verifyStore();
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    expect(out.resolved).toEqual([{ id: 1, value: "?" }, { id: 3, value: "?" }]);
    expect(out.deferred).toEqual([2]);
    expect(out.failed).toEqual([]);
  });

  it("壊れた詳細・別のレースの詳細は '?'(新しくても保留しない。R2 の put は原子的で、壊れたものは待っても直らない)", async () => {
    const recent = new Date(NOW.getTime() - 1000).toISOString();
    await analyses().saveAnalysis(mkRecord(1, { analyzedAt: recent }));
    await analyses().saveAnalysis(mkRecord(2, { analyzedAt: recent }));
    await local.r2.put("analyses/1.json.gz", new Uint8Array([1, 2, 3]));
    await local.r2.put("analyses/2.json.gz", encodeDetail(mkRecord(9, { startTime: "15:45" }))); // raceId が違う詳細
    const s = verifyStore();
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    expect(out.resolved).toEqual([{ id: 1, value: "?" }, { id: 2, value: "?" }]);
    expect(out.deferred).toEqual([]);
  });

  it("get が例外: その行は failed(NULL のまま。'?' にしない)で、成功した行の結果は返す", async () => {
    await analyses().saveAnalysis(mkRecord(1, { startTime: "15:45" }));
    await analyses().saveAnalysis(mkRecord(2, { startTime: "16:00" }));
    let n = 0;
    const flaky = { get: async (key: string) => { n += 1; if (key.endsWith("/2.json.gz")) throw new Error("R2_ERROR"); return local.r2.get(key); } } as unknown as VerifyBucket;
    const s = verifyStore(flaky);
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    expect(out.resolved).toEqual([{ id: 1, value: "15:45" }]);
    expect(out.failed).toEqual([2]);
    expect(n).toBe(2);
    expect(out.gets).toBe(2); // 例外になった試行も R2 への要求(Class B)として数える
  });
});

describe("commitStartTimes(D1 への書き込み)", () => {
  it("NULL の行だけを更新し(確認済みの値は上書きしない)、Class B を取得数ぶん数える。D1 は 1 回の batch(2 文)", async () => {
    for (let i = 1; i <= 3; i += 1) await analyses().saveAnalysis(mkRecord(i));
    await local.db.prepare("UPDATE analyses SET start_time = '10:00' WHERE id = 3").run();
    const spy = spyDb(local.db);
    const s = new D1VerifyStore({ db: spy.db, bucket: local.r2, now: () => NOW });
    const written = await s.commitStartTimes([{ id: 1, value: "15:45" }, { id: 2, value: "" }, { id: 3, value: "?" }], 3);
    expect(await startTimeOf(1)).toBe("15:45");
    expect(await startTimeOf(2)).toBe("");
    expect(await startTimeOf(3)).toBe("10:00");
    expect(spy.batches).toEqual([2]);
    expect(written).toBeGreaterThanOrEqual(2);
    const usage = await local.db.prepare("SELECT class_a AS a, class_b AS b FROM r2_ops WHERE ym = 202610").first<{ a: number; b: number }>();
    expect(usage!.b).toBeGreaterThanOrEqual(3);
  });

  it("書く行も取得も無ければ D1 に何も発行しない", async () => {
    const spy = spyDb(local.db);
    const s = new D1VerifyStore({ db: spy.db, bucket: local.r2, now: () => NOW });
    expect(await s.commitStartTimes([], 0)).toBe(0);
    expect(spy.prepared).toEqual([]);
    expect(spy.batches).toEqual([]);
  });

  it("書く行が無くても、取得があれば Class B だけ数える(保留・失敗の取得も R2 への要求)", async () => {
    await s0();
    async function s0() {
      await verifyStore().commitStartTimes([], 4);
    }
    const usage = await local.db.prepare("SELECT class_b AS b FROM r2_ops WHERE ym = 202610").first<{ b: number }>();
    expect(usage!.b).toBe(4);
  });
});

describe("readUsage(R2 の柵の判定の元)", () => {
  it("今月(UTC)の回数。行が無ければ 0", async () => {
    expect(await verifyStore().readUsage()).toEqual({ classA: 0, classB: 0 });
    await local.db.prepare("INSERT INTO r2_ops (ym, class_a, class_b) VALUES (202610, 3, 7)").run();
    expect(await verifyStore().readUsage()).toEqual({ classA: 3, classB: 7 });
  });
});

describe("readAll(集計に使う行を 1 回の batch で読む)", () => {
  it("D1 に 7 文を 1 回の batch で発行し、行数・読み取り行数を返す。読んだ行から exe と同じ型の読み取り口ができる", async () => {
    await analyses().saveAnalysis(mkRecord(1, { startTime: "15:45" }));
    await analyses().saveAnalysis(mkRecord(2));
    await new D1ResultStore({ db: local.db }).saveResult("202606030811", [{ umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 300 }]);
    await local.db.prepare("UPDATE analyses SET start_time = '15:45' WHERE id = 1").run();
    const spy = spyDb(local.db);
    const s = new D1VerifyStore({ db: spy.db, bucket: local.r2, now: () => NOW });
    const out = await s.readAll();
    expect(spy.batches).toEqual([7]);
    expect(out.counts).toEqual({ analyses: 2, horses: 2, allocationMeta: 0, bets: 0, results: 1, comboPayouts: 0, comboImports: 0 });
    expect(out.rowsRead).toBeGreaterThanOrEqual(5);
    const source = buildVerifySource(out.rows);
    expect(source.listAnalyses()).toHaveLength(2);
    expect(source.getResult("202606030811")).toEqual([{ umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 300 }]);
  });
});
