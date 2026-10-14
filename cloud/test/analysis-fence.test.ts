import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSaveStatements, D1AnalysisStore, type AnalysisDb } from "../src/analysis-repository";
import { R2_FENCE_LIMITS } from "../src/r2-fence";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, spyBucket, type LocalBindings } from "./local-bindings";

/**
 * Issue #173(#169-c): R2 の操作回数の安全柵(月ごとのカウンタ `r2_ops`。D1)を、ローカル(workerd)の D1・R2 で確かめる。
 *  - 保存(Class A = PUT): 保存の batch の中でカウンタを +1 する。柵(無料枠の 10% = 10 万回)に達したら R2 に書かず、D1 に要約だけを保存する(`detail: "skipped"`)
 *  - 詳細の読み出し(Class B = GET): 柵(100 万回)に達したら、R2 を引かず `missing` を返す(要約は出す)。カウントは best-effort
 *  - 月の区切りは UTC の yyyymm。判定は純関数(`src/r2-fence.ts`。test/r2-fence.test.ts)
 *
 * 限界: 回数の確認(柵の判定)と +1 は別の呼び出しなので、同時に保存が走ると柵を少し超えうる(柵は無料枠の 10% で、100 倍の余裕がある)。
 * PUT の再試行(最大 2 回)は数えない(1 回の保存を 1 回と数える。最大 3 倍の過少申告でも、柵は無料枠の 30% までに収まる)。
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
});

const OCT = 202610;
const NOV = 202611;
const A = R2_FENCE_LIMITS.classA;
const B = R2_FENCE_LIMITS.classB;

/** 可変の時計(月の境界のテストで進める)。 */
function clock(iso: string): { now: () => Date; set: (next: string) => void } {
  let current = new Date(iso);
  return { now: () => current, set: (next: string) => void (current = new Date(next)) };
}

function storeAt(iso: string, bucket: D1AnalysisStoreBucket = local.r2, db: AnalysisDb = local.db): { store: D1AnalysisStore; clock: ReturnType<typeof clock> } {
  const c = clock(iso);
  return { store: new D1AnalysisStore({ db, bucket, now: c.now }), clock: c };
}
type D1AnalysisStoreBucket = ConstructorParameters<typeof D1AnalysisStore>[0]["bucket"];

async function seed(ym: number, classA: number, classB: number): Promise<void> {
  await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, ?)").bind(ym, classA, classB).run();
}

async function usage(ym: number): Promise<{ class_a: number; class_b: number } | null> {
  return local.db.prepare("SELECT class_a, class_b FROM r2_ops WHERE ym = ?").bind(ym).first<{ class_a: number; class_b: number }>();
}

function mkRecord(i: number, extra: Partial<AnalysisRecord> = {}): AnalysisRecord {
  const meta = contractCases[0]!.record.allocation!.meta;
  return {
    raceId: `R${String(i).padStart(4, "0")}`,
    analyzedAt: "2026-10-06T00:00:00.000Z",
    kaisaiDate: "20261006",
    promptVersion: "v-test",
    rawResponse: `応答 ${i}`,
    horses: [1, 2, 3].map((umaban) => ({ umaban, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 1.5, ev: 1.1, isPositive: false, contributions: { umaban, i }, mark: null, reason: `根拠 ${i}` })),
    allocation: { meta, bets: [{ betType: "wide", comboKey: `${i}-0`, stake: 100, odds: 5, ev: 1.2 }] },
    ...extra,
  };
}

async function count(table: string): Promise<number> {
  return (await local.db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c;
}

describe("AC-c1: カウンタは保存と同じトランザクションで増える", () => {
  it("保存 1 回につき Class A が +1(最初の保存で月の行ができ、Class B は 0)。2 回目で 2", async () => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    expect(await usage(OCT)).toBeNull();
    expect((await store.saveAnalysis(mkRecord(1))).detail).toBe("stored");
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: 0 });
    expect((await store.saveAnalysis(mkRecord(2))).detail).toBe("stored");
    expect(await usage(OCT)).toEqual({ class_a: 2, class_b: 0 });
    expect(await count("r2_ops")).toBe(1);
  });

  it("batch が失敗したら(買い目の主キー重複)、カウンタも増えない: 行が無いまま・既存の行も同じ値。save は throw し、R2 には書かない", async () => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    const bet = mkRecord(1).allocation!.bets[0]!;
    const broken = mkRecord(1, { allocation: { meta: mkRecord(1).allocation!.meta, bets: [bet, { ...bet }] } });
    await expect(store.saveAnalysis(broken)).rejects.toThrow(/UNIQUE|constraint/i);
    expect(await usage(OCT)).toBeNull();
    await seed(OCT, 5, 7);
    await expect(store.saveAnalysis(broken)).rejects.toThrow(/UNIQUE|constraint/i);
    expect(await usage(OCT)).toEqual({ class_a: 5, class_b: 7 });
    expect(await count("analyses")).toBe(0);
  });

  it("対照: 同じ文を batch を使わず 1 文ずつ実行すると、失敗しても先に実行したカウンタの +1 は残る(この検査は、batch でなければ失敗する)", async () => {
    const bet = mkRecord(1).allocation!.bets[0]!;
    const broken = mkRecord(1, { allocation: { meta: mkRecord(1).allocation!.meta, bets: [bet, { ...bet }] } });
    await seed(OCT, 5, 7);
    await expect(
      (async () => {
        for (const statement of buildSaveStatements(local.db, broken, OCT)) {
          await statement.run();
        }
      })(),
    ).rejects.toThrow(/UNIQUE|constraint/i);
    expect(await usage(OCT)).toEqual({ class_a: 6, class_b: 7 });
  });

  it("R2 への put が失敗しても(detail: failed)、カウンタは +1 のまま(D1 の batch と一緒にコミット済み。再試行は数えない)", async () => {
    const spy = spyBucket(local.r2, { failPut: () => true });
    const { store } = storeAt("2026-10-06T12:00:00Z", spy.bucket);
    const saved = await store.saveAnalysis(mkRecord(1));
    expect(saved.detail).toBe("failed");
    expect(spy.calls.filter((c) => c.op === "put")).toHaveLength(3);
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: 0 });
  });

  it("柵の判定のための読み取り(SELECT … FROM r2_ops WHERE ym = ?)を、保存の batch の前に 1 回だけ発行する。batch は 6 文", async () => {
    const events: Array<{ kind: "prepare"; sql: string } | { kind: "batch"; size: number }> = [];
    const db = {
      prepare(sql: string) {
        events.push({ kind: "prepare", sql });
        return local.db.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        events.push({ kind: "batch", size: statements.length });
        return local.db.batch(statements);
      },
    } as unknown as AnalysisDb;
    const { store } = storeAt("2026-10-06T12:00:00Z", local.r2, db);
    await store.saveAnalysis(mkRecord(1));
    const reads = events.filter((e) => e.kind === "prepare" && /FROM r2_ops WHERE ym = \?/.test(e.sql));
    expect(reads).toHaveLength(1);
    const readAt = events.indexOf(reads[0]!);
    const batchAt = events.findIndex((e) => e.kind === "batch");
    expect(batchAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeLessThan(batchAt);
    expect(events[batchAt]).toEqual({ kind: "batch", size: 6 });
    // 読み取りの文は SELECT(書き込みではない)。月(束縛値)が効いていることは、AC-c2 の月ごとの柵のテストが確かめる
    expect((reads[0] as { sql: string }).sql).toMatch(/^\s*SELECT\b/i);
  });
});

describe("AC-c2: UTC の月の境界で切り替わる", () => {
  it("10/31 23:59:59.999Z の保存は 202610、11/01 00:00:00.000Z の保存は 202611(月ごとに別の行。繰り越さない)", async () => {
    const { store, clock: c } = storeAt("2026-10-31T23:59:59.999Z");
    await store.saveAnalysis(mkRecord(1));
    await store.saveAnalysis(mkRecord(2));
    c.set("2026-11-01T00:00:00.000Z");
    await store.saveAnalysis(mkRecord(3));
    expect(await usage(OCT)).toEqual({ class_a: 2, class_b: 0 });
    expect(await usage(NOV)).toEqual({ class_a: 1, class_b: 0 });
    expect(await count("r2_ops")).toBe(2);
  });

  it("年の境界(12/31 → 1/1): 202612 から 202701 へ", async () => {
    const { store, clock: c } = storeAt("2026-12-31T23:59:59.999Z");
    await store.saveAnalysis(mkRecord(1));
    c.set("2027-01-01T00:00:00.000Z");
    await store.saveAnalysis(mkRecord(2));
    expect(await usage(202612)).toEqual({ class_a: 1, class_b: 0 });
    expect(await usage(202701)).toEqual({ class_a: 1, class_b: 0 });
  });

  it("柵も月ごと: 10 月に上限へ達していても、11 月になれば書ける(10 月の値を 11 月に持ち越さない)", async () => {
    await seed(OCT, A, 0);
    const { store, clock: c } = storeAt("2026-10-31T23:59:59.999Z");
    expect((await store.saveAnalysis(mkRecord(1))).detail).toBe("skipped");
    c.set("2026-11-01T00:00:00.000Z");
    expect((await store.saveAnalysis(mkRecord(2))).detail).toBe("stored");
    expect(await usage(NOV)).toEqual({ class_a: 1, class_b: 0 });
    expect(await usage(OCT)).toEqual({ class_a: A, class_b: 0 });
  });

  it("読み出しの柵・getR2Usage も、時計の月の行を見る(別の月の行は見ない)", async () => {
    await seed(OCT, 3, 4);
    await seed(NOV, 30, 40);
    const { store, clock: c } = storeAt("2026-10-15T00:00:00Z");
    expect(await store.getR2Usage()).toMatchObject({ ym: OCT, classA: 3, classB: 4 });
    c.set("2026-11-15T00:00:00Z");
    expect(await store.getR2Usage()).toMatchObject({ ym: NOV, classA: 30, classB: 40 });
    c.set("2026-12-15T00:00:00Z");
    expect(await store.getR2Usage()).toMatchObject({ ym: 202612, classA: 0, classB: 0 });
  });
});

describe("AC-c3: 閾値の境界(Class A = 書き込み)。上限 −1 はまだ書き、上限ちょうどで止める。スキップは PUT 0 回・カウンタは増えない", () => {
  it(`Class A = ${A - 1}(上限 −1): まだ R2 に書く(stored・PUT 1 回)。書いた結果 ${A} になる`, async () => {
    await seed(OCT, A - 1, 0);
    const spy = spyBucket(local.r2);
    const { store } = storeAt("2026-10-06T12:00:00Z", spy.bucket);
    const saved = await store.saveAnalysis(mkRecord(1));
    expect(saved.detail).toBe("stored");
    expect(spy.calls.filter((c) => c.op === "put")).toHaveLength(1);
    expect(await usage(OCT)).toEqual({ class_a: A, class_b: 0 });
  });

  it.each([A, A + 1, A * 3])("Class A = %i(上限ちょうど・超過): R2 に書かない(PUT 0 回)。D1 には要約だけを保存し(detail_key は NULL)、カウンタは増えない。detail: skipped", async (classA) => {
    await seed(OCT, classA, 12);
    const spy = spyBucket(local.r2);
    const { store } = storeAt("2026-10-06T12:00:00Z", spy.bucket);
    const rec = mkRecord(1);
    const saved = await store.saveAnalysis(rec);
    expect(saved.detail).toBe("skipped");
    expect(spy.calls).toEqual([]);
    expect(await usage(OCT)).toEqual({ class_a: classA, class_b: 12 });
    // 要約は残る(analyses・馬・配分メタ・買い目)。大きな列は D1 にも置かない
    const row = await local.db.prepare("SELECT detail_key AS k, raw_response AS r, race_snapshot_json AS s FROM analyses WHERE id = ?").bind(saved.id).first<{ k: unknown; r: unknown; s: unknown }>();
    expect(row).toEqual({ k: null, r: null, s: null });
    expect(await count("analysis_horses")).toBe(3);
    expect(await count("analysis_allocation_meta")).toBe(1);
    expect(await count("analysis_bets")).toBe(1);
    expect(await count("analysis_horses WHERE contributions_json IS NOT NULL")).toBe(0);
    // 読み出し: 詳細は none(R2 に触れない)、要約の一覧では hasDetail が false
    const reading = spyBucket(local.r2);
    const detail = await new D1AnalysisStore({ db: local.db, bucket: reading.bucket, now: () => new Date("2026-10-06T12:00:00Z") }).getAnalysisDetail(saved.id);
    expect(detail!.detail).toBe("none");
    expect(reading.calls).toEqual([]);
    expect((await store.listAnalysisSummaries({ raceId: rec.raceId }))[0]!.hasDetail).toBe(false);
  });

  it("スキップした保存の batch は、配分ありで 4 文・なしで 2 文(カウンタも detail_key の UPDATE も含まない)", async () => {
    await seed(OCT, A, 0);
    const sizes: number[] = [];
    const sqls: string[] = [];
    const db = {
      prepare(sql: string) {
        sqls.push(sql);
        return local.db.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        sizes.push(statements.length);
        return local.db.batch(statements);
      },
    } as unknown as AnalysisDb;
    const { store } = storeAt("2026-10-06T12:00:00Z", local.r2, db);
    await store.saveAnalysis(mkRecord(1));
    await store.saveAnalysis(mkRecord(2, { allocation: undefined }));
    expect(sizes).toEqual([4, 2]);
    expect(sqls.filter((sql) => /UPDATE r2_ops|INTO r2_ops|detail_key/.test(sql))).toEqual([]);
  });

  it("スキップが続いても、カウンタは増えない(3 回続けて保存しても、PUT 0 回・Class A は上限のまま)", async () => {
    await seed(OCT, A, 0);
    const spy = spyBucket(local.r2);
    const { store } = storeAt("2026-10-06T12:00:00Z", spy.bucket);
    for (let i = 1; i <= 3; i += 1) {
      expect((await store.saveAnalysis(mkRecord(i))).detail).toBe("skipped");
    }
    expect(spy.calls).toEqual([]);
    expect(await usage(OCT)).toEqual({ class_a: A, class_b: 0 });
    expect(await count("analyses")).toBe(3);
  });
});

describe("AC-c4(【記録】): Class A と Class B を取り違えない", () => {
  it("Class B が読み出しの上限に達していても、書き込みは止まらない(stored・Class A が +1)", async () => {
    await seed(OCT, 0, B + 5);
    const { store } = storeAt("2026-10-06T12:00:00Z");
    expect((await store.saveAnalysis(mkRecord(1))).detail).toBe("stored");
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: B + 5 });
  });

  it("Class A が書き込みの上限に達していても、詳細の読み出しは止まらない(present)", async () => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    const saved = await store.saveAnalysis(mkRecord(1));
    await seed(OCT, A + 5, 0);
    expect((await store.getAnalysisDetail(saved.id))!.detail).toBe("present");
  });
});

describe("詳細の読み出し(Class B = GET): 柵と best-effort のカウント", () => {
  it("詳細を読むたびに Class B が +1。none(detail_key が NULL)・一覧・配分・版別は R2 に触れず、数えない", async () => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    const saved = await store.saveAnalysis(mkRecord(1));
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: 0 });
    expect((await store.getAnalysisDetail(saved.id))!.detail).toBe("present");
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: 1 });
    expect((await store.getAnalysisDetail(saved.id))!.detail).toBe("present");
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: 2 });
    await store.listAnalysisSummaries({});
    await store.getStoredAllocation(saved.id);
    await store.listAnalyzedRaceIdsByPromptVersion("v-test");
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: 2 });
    // detail_key が NULL の分析(柵でスキップ)の読み出しは、R2 に触れず数えない
    await seed(OCT, A, 2);
    const skipped = await store.saveAnalysis(mkRecord(2));
    expect(skipped.detail).toBe("skipped");
    expect((await store.getAnalysisDetail(skipped.id))!.detail).toBe("none");
    expect(await usage(OCT)).toEqual({ class_a: A, class_b: 2 });
    // 存在しない分析の読み出しも数えない
    expect(await store.getAnalysisDetail(987654)).toBeUndefined();
    expect(await usage(OCT)).toEqual({ class_a: A, class_b: 2 });
  });

  it(`Class B = ${B - 1}(上限 −1): まだ読む(present)。読んだ結果 ${B} になる`, async () => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    const saved = await store.saveAnalysis(mkRecord(1));
    await seed(OCT, 1, B - 1);
    const spy = spyBucket(local.r2);
    const reader = new D1AnalysisStore({ db: local.db, bucket: spy.bucket, now: () => new Date("2026-10-06T12:00:00Z") });
    expect((await reader.getAnalysisDetail(saved.id))!.detail).toBe("present");
    expect(spy.calls.filter((c) => c.op === "get")).toHaveLength(1);
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: B });
  });

  it.each([B, B + 1])("Class B = %i(上限ちょうど・超過): 詳細の表示だけを拒否する。R2 を引かず(GET 0 回)、missing を返し、要約(大きな列以外)は出す。カウンタは増えない", async (classB) => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    const rec = mkRecord(1);
    const saved = await store.saveAnalysis(rec);
    await seed(OCT, 1, classB);
    const spy = spyBucket(local.r2);
    const reader = new D1AnalysisStore({ db: local.db, bucket: spy.bucket, now: () => new Date("2026-10-06T12:00:00Z") });
    const detail = await reader.getAnalysisDetail(saved.id);
    expect(detail!.detail).toBe("missing");
    expect(spy.calls).toEqual([]);
    expect(detail!.analysis.rawResponse).toBeNull();
    expect(detail!.analysis.horses.every((h) => h.contributions === null)).toBe(true);
    // 要約の項目は出る
    expect(detail!.analysis.raceId).toBe(rec.raceId);
    expect(detail!.analysis.horses).toHaveLength(3);
    expect(detail!.analysis.horses[0]!.reason).toBe("根拠 1");
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: classB });
    // 配分は D1 だけなので、柵の影響を受けない
    expect((await reader.getStoredAllocation(saved.id))!.bets).toHaveLength(1);
  });

  it("AC-c5(【記録】)カウントは best-effort: Class B を +1 する文が失敗しても、読み出しは妨げられない(present を返し、throw しない)", async () => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    const saved = await store.saveAnalysis(mkRecord(1));
    const failingCounter = {
      prepare(sql: string) {
        if (/class_b = class_b \+ 1/.test(sql)) {
          return { bind: () => ({ run: async () => Promise.reject(new Error("D1_ERROR: injected counter failure")) }) };
        }
        return local.db.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => local.db.batch(statements),
    } as unknown as AnalysisDb;
    const reader = new D1AnalysisStore({ db: failingCounter, bucket: local.r2, now: () => new Date("2026-10-06T12:00:00Z") });
    const detail = await reader.getAnalysisDetail(saved.id);
    expect(detail!.detail).toBe("present");
    expect(detail!.analysis.rawResponse).toBe("応答 1");
    // カウントは増えていない(失敗した)
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: 0 });
  });

  it("R2 の get が失敗(例外)しても、読んだ試行は Class B に数える(R2 への要求は発生している)。missing を返す", async () => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    const saved = await store.saveAnalysis(mkRecord(1));
    const spy = spyBucket(local.r2, { failGet: true });
    const reader = new D1AnalysisStore({ db: local.db, bucket: spy.bucket, now: () => new Date("2026-10-06T12:00:00Z") });
    expect((await reader.getAnalysisDetail(saved.id))!.detail).toBe("missing");
    expect(await usage(OCT)).toEqual({ class_a: 1, class_b: 1 });
  });
});

describe("getR2Usage(今月の回数と、柵の状態)", () => {
  it("行が無い月は 0 回で、柵の上限(Class A 10 万・Class B 100 万)と、書き込み・読み出しの許可を返す", async () => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    expect(await store.getR2Usage()).toEqual({
      ym: OCT,
      classA: 0,
      classB: 0,
      limits: { classA: 100_000, classB: 1_000_000 },
      writeAllowed: true,
      readAllowed: true,
    });
  });

  it("実際の回数を返し、上限ちょうどで許可が false になる(Class A と B は独立)", async () => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    await seed(OCT, A - 1, B - 1);
    expect(await store.getR2Usage()).toMatchObject({ classA: A - 1, classB: B - 1, writeAllowed: true, readAllowed: true });
    await seed(OCT, A, B - 1);
    expect(await store.getR2Usage()).toMatchObject({ classA: A, classB: B - 1, writeAllowed: false, readAllowed: true });
    await seed(OCT, A - 1, B);
    expect(await store.getR2Usage()).toMatchObject({ classA: A - 1, classB: B, writeAllowed: true, readAllowed: false });
    await seed(OCT, A, B);
    expect(await store.getR2Usage()).toMatchObject({ writeAllowed: false, readAllowed: false });
  });

  it("保存・詳細の読み出しの回数が反映される(保存 2 回・詳細 3 回 → Class A = 2・Class B = 3)", async () => {
    const { store } = storeAt("2026-10-06T12:00:00Z");
    const a = await store.saveAnalysis(mkRecord(1));
    await store.saveAnalysis(mkRecord(2));
    for (let i = 0; i < 3; i += 1) {
      await store.getAnalysisDetail(a.id);
    }
    expect(await store.getR2Usage()).toMatchObject({ classA: 2, classB: 3 });
  });
});
