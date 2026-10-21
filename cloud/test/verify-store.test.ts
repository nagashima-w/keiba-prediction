import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeDetail } from "../src/analysis-detail";
import { D1AnalysisStore } from "../src/analysis-repository";
import { D1ResultStore } from "../src/result-repository";
import { D1VerifyStore, type VerifyBucket } from "../src/verify-store";
import { VerifyCore, VERIFY_TICK_QUERY_LIMIT, type VerifyKv } from "../src/verify-core";
import { buildVerifySource } from "../src/verify-read";
import { VERIFY_CLOSE_READ_SQL } from "../src/verify-close";
import type { CloseSavePayload } from "../src/analysis-close";
import { contractCases } from "./fixtures-contract";
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

const analyses = (now: Date = NOW) => new D1AnalysisStore({ db: local.db, bucket: local.r2, now: () => now });
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
    await local.db.prepare("UPDATE analyses SET start_time = '09:00', cond_read = 1 WHERE id = 2").run();
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
    expect(out.missing).toEqual([]);
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

  it("R2 に詳細が無い行は、分析日時に依らず `missing`(最終判定をしない)。移行した分析のように分析日時が古くても '?' にしない(D1 に detail_key を書いてから R2 に put するので、「D1 にあり R2 にまだ無い」瞬間がある。レビュー指摘)", async () => {
    await analyses().saveAnalysis(mkRecord(1)); // 分析日時は 9 日前(移行した分析のように古い)
    await analyses().saveAnalysis(mkRecord(2, { analyzedAt: new Date(NOW.getTime() - 1000).toISOString() })); // 直前
    // 詳細を消せない(delete は型で禁止)ので、キーを別の存在しないものに付け替える。
    await local.db.prepare("UPDATE analyses SET detail_key = 'analyses/none-' || id WHERE id IN (1, 2)").run();
    const s = verifyStore();
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    expect(out.resolved).toEqual([]);
    expect(out.missing).toEqual([1, 2]);
    expect(out.failed).toEqual([]);
    expect(out.gets).toBe(2);
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
    expect(out.missing).toEqual([]);
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
  it("D1 に 7 文を 1 回の batch で発行し、続けて再計算の 2 文を別の batch で発行する(Issue #352)。行数・読み取り行数を返す。読んだ行から exe と同じ型の読み取り口ができる", async () => {
    await analyses().saveAnalysis(mkRecord(1, { startTime: "15:45" }));
    await analyses().saveAnalysis(mkRecord(2));
    await new D1ResultStore({ db: local.db }).saveResult("202606030811", [{ umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 300 }]);
    await local.db.prepare("UPDATE analyses SET start_time = '15:45' WHERE id = 1").run();
    const spy = spyDb(local.db);
    const s = new D1VerifyStore({ db: spy.db, bucket: local.r2, now: () => NOW });
    const out = await s.readAll();
    expect(spy.batches).toEqual([7, 2]);
    expect(out.counts).toEqual({ analyses: 2, horses: 2, allocationMeta: 0, bets: 0, results: 1, comboPayouts: 0, comboImports: 0, closeMeta: 0, closeBets: 0 });
    expect(out.close).toEqual({ meta: [], bets: [] });
    expect(out.rowsRead).toBeGreaterThanOrEqual(5);
    const source = buildVerifySource(out.rows);
    expect(source.listAnalyses()).toHaveLength(2);
    // saveResult で書いた行は scratched=0(記録済み・取消でない)で、読み取り口では false(Issue #72)。
    expect(source.getResult("202606030811")).toEqual([{ umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 300, scratched: false }]);
  });
});

describe("readAll: 締切直前の再計算の行(Issue #352。analysis_close・analysis_close_bets)", () => {
  const DUE = Date.parse("2026-10-17T06:40:00Z");
  const baseMeta = contractCases[0]!.record.allocation!.meta;
  function okPayload(round: 1 | 2, stakes: readonly number[]): CloseSavePayload {
    return {
      round, status: "ok", reason: null, dueAtMs: DUE, firedAtMs: DUE + 1500, lateMs: 1500, oddsOfficialDatetime: "2026-10-17 15:41:30",
      allocation: {
        meta: { ...baseMeta, route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, bankroll: 100000, perRaceCap: 30000, oddsStatus: "middle" },
        bets: stakes.map((stake, i) => ({ betType: "place", comboKey: `0${i + 1}`, stake, odds: 2.5, ev: 1.1 })),
      },
    };
  }

  async function seed(): Promise<number> {
    const saved = await new D1AnalysisStore({ db: local.db, bucket: local.r2 }).saveAnalysis(contractCases[0]!.record);
    const store = new D1AnalysisStore({ db: local.db, bucket: local.r2 });
    await store.saveClose(saved.id, okPayload(1, [300, 200]));
    await store.saveClose(saved.id, { round: 2, status: "skipped", reason: "too-late", dueAtMs: DUE, firedAtMs: DUE + 1, lateMs: 1, oddsOfficialDatetime: null, allocation: null });
    return saved.id;
  }

  it("回のメタ(状態・経路・見送りの理由)と ok の回の買い目(券種・キー・賭け金)を読む。診断の行数に closeMeta・closeBets が出て、読み取り行数に加わる", async () => {
    const id = await seed();
    const out = await verifyStore().readAll();
    expect(out.close).toEqual({
      meta: [
        { analysisId: id, round: 1, status: "ok", route: "mixed", skipReasonCode: null, reason: null }, // reason は Issue #379 で足した列(旧い nar-unsupported の行を比較から除くため)
        { analysisId: id, round: 2, status: "skipped", route: null, skipReasonCode: null, reason: "too-late" },
      ],
      bets: [
        { analysisId: id, round: 1, betType: "place", comboKey: "01", stake: 300 },
        { analysisId: id, round: 1, betType: "place", comboKey: "02", stake: 200 },
      ],
    });
    expect(out.counts["closeMeta"]).toBe(2);
    expect(out.counts["closeBets"]).toBe(2);
    // 読み取り行数は、主の 7 文の分(再計算の行を足す前の値)より、再計算の行の数(2 + 2)以上に増える
    const mainOnly = out.rowsRead;
    const withoutClose = await new D1VerifyStore({ db: failingCloseDb(), bucket: local.r2, now: () => NOW }).readAll();
    expect(mainOnly - withoutClose.rowsRead).toBeGreaterThanOrEqual(4);
  });

  it("2 つの SQL は主キーの順で、並べ替えの一時領域(TEMP B-TREE)を使わない", async () => {
    await seed();
    for (const sql of Object.values(VERIFY_CLOSE_READ_SQL)) {
      const plan = await local.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
      expect(plan.results.length).toBeGreaterThan(0);
      expect(plan.results.map((r) => r.detail).join("\n")).not.toMatch(/TEMP B-TREE/);
    }
  });

  /** 再計算の表が無い(migration 前)ときの D1 の失敗を再現する: 再計算の文だけ、存在しない表を読む文に差し替える。 */
  function failingCloseDb() {
    const real = local.db;
    return {
      prepare: (sql: string) => real.prepare(Object.values(VERIFY_CLOSE_READ_SQL).includes(sql as never) ? "SELECT 1 FROM no_such_table_for_close" : sql),
      batch: (statements: D1PreparedStatement[]) => real.batch(statements),
    } as unknown as ConstructorParameters<typeof D1VerifyStore>[0]["db"];
  }

  it("★再計算の表が読めない(表が無い)ときは close が null になり、主の 7 表の行・件数は読める(既存の検証を壊さない)。診断の行数に closeMeta・closeBets は出ない", async () => {
    await seed();
    const out = await new D1VerifyStore({ db: failingCloseDb(), bucket: local.r2, now: () => NOW }).readAll();
    expect(out.close).toBeNull();
    expect(out.rows.analyses).toHaveLength(1); // 前提: 主の行が読めている
    expect(out.counts).toEqual({ analyses: 1, horses: out.rows.horses.length, allocationMeta: 1, bets: out.rows.bets.length, results: 0, comboPayouts: 0, comboImports: 0 });
    expect(out.rowsRead).toBeGreaterThan(0);
  });
});


// ---------------------------------------------------------------------------
// Issue #389(#385-B の a): レースの条件(芝ダ・距離・馬場・グレード・レース名)の補完。発走時刻の補完と同じ get に相乗りする
// ---------------------------------------------------------------------------

interface CondRow {
  readonly start_time: string | null;
  readonly course_type: string | null;
  readonly distance: number | null;
  readonly track_condition: string | null;
  readonly grade: string | null;
  readonly race_name: string | null;
  readonly cond_read: number | null;
}
async function condRowOf(id: number): Promise<CondRow> {
  return (await local.db.prepare("SELECT start_time, course_type, distance, track_condition, grade, race_name, cond_read FROM analyses WHERE id = ?").bind(id).first<CondRow>())!;
}
const SNAP = { raceName: "3歳以上1勝クラス", courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3", startTime: "15:45" };
const SNAP_FACTS = { courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3", raceName: "3歳以上1勝クラス" };
const record = (i: number, race: Record<string, unknown> = SNAP): AnalysisRecord => mkRecord(i, { raceSnapshot: { race } });

describe("listPending(Issue #389): 発走時刻が済みでも、条件(cond_read)が NULL の行は候補", () => {
  it("start_time NULL または cond_read NULL の行を候補にし、両方済みの行は除く。総数も同じ条件で数える", async () => {
    for (let i = 1; i <= 4; i += 1) await analyses().saveAnalysis(mkRecord(i));
    await local.db.prepare("UPDATE analyses SET start_time = '09:00', cond_read = 1 WHERE id = 1").run(); // 両方済み
    await local.db.prepare("UPDATE analyses SET start_time = '09:00' WHERE id = 2").run(); // 発走時刻だけ済み(既存分の一度だけの補完の対象)
    await local.db.prepare("UPDATE analyses SET cond_read = 0 WHERE id = 3").run(); // 条件だけ済み(読めなかった印も「済み」)
    const page = await verifyStore().listPending(0, 10);
    expect(page.rows.map((r) => r.id)).toEqual([2, 3, 4]);
    expect(page.total).toBe(3);
  });
});

describe("resolveStartTimes(Issue #389): 同じ get から条件も取り出す", () => {
  it("1 行につき get は 1 回(発走時刻だけのときと同じ)。resolved は従来の形のまま、conditions に同じ id の事実が入る", async () => {
    await analyses().saveAnalysis(record(1));
    await analyses().saveAnalysis(record(2, { raceName: "", courseType: "ダ", distance: 1200 }));
    const spy = spyBucket(local.r2);
    const s = verifyStore(spy.bucket as unknown as VerifyBucket);
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    expect(out.resolved).toEqual([{ id: 1, value: "15:45" }, { id: 2, value: "" }]);
    expect(out.gets).toBe(2);
    expect(spy.calls.filter((c) => c.op === "get")).toHaveLength(2);
    expect(out.conditions).toEqual([
      { id: 1, facts: SNAP_FACTS },
      { id: 2, facts: { courseType: "ダ", distance: 1200, trackCondition: null, grade: null, raceName: null } },
    ]);
  });

  it("detail_key が無い行・壊れた詳細・別のレースの詳細は、条件も読めなかった(facts: null)。detail_key が無い行は get しない", async () => {
    const recent = new Date(NOW.getTime() - 1000).toISOString();
    await analyses().saveAnalysis(mkRecord(1, { analyzedAt: recent }));
    await analyses().saveAnalysis(mkRecord(2, { analyzedAt: recent }));
    await analyses().saveAnalysis(mkRecord(3, { analyzedAt: recent }));
    await local.db.prepare("UPDATE analyses SET detail_key = NULL WHERE id = 1").run();
    await local.r2.put("analyses/2.json.gz", new Uint8Array([1, 2, 3]));
    await local.r2.put("analyses/3.json.gz", encodeDetail(mkRecord(9, { raceSnapshot: { race: SNAP } })));
    const spy = spyBucket(local.r2);
    const s = verifyStore(spy.bucket as unknown as VerifyBucket);
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    expect(out.resolved.map((r) => r.value)).toEqual(["?", "?", "?"]);
    expect(out.conditions).toEqual([{ id: 1, facts: null }, { id: 2, facts: null }, { id: 3, facts: null }]);
    expect(out.gets).toBe(2);
    expect(spy.calls.filter((c) => c.op === "get")).toHaveLength(2);
  });

  it("R2 に詳細が無い行(missing)・get が例外の行(failed)には、条件の結果を出さない(NULL のまま再試行できる)", async () => {
    await analyses().saveAnalysis(record(1));
    await analyses().saveAnalysis(record(2));
    await analyses().saveAnalysis(record(3));
    await local.db.prepare("UPDATE analyses SET detail_key = 'analyses/none-' || id WHERE id = 1").run();
    const flaky = { get: async (key: string) => { if (key.endsWith("/2.json.gz")) throw new Error("R2_ERROR"); return local.r2.get(key); } } as unknown as VerifyBucket;
    const s = verifyStore(flaky);
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    expect(out.missing).toEqual([1]);
    expect(out.failed).toEqual([2]);
    expect(out.resolved.map((r) => r.id)).toEqual([3]);
    expect(out.conditions).toEqual([{ id: 3, facts: SNAP_FACTS }]);
  });

  it("スナップショットに条件が何も無い詳細は、読めた(facts は全項目 null)。読めなかった(facts: null)とは別", async () => {
    await analyses().saveAnalysis(mkRecord(1, { raceSnapshot: { race: {} } }));
    const s = verifyStore();
    const out = await s.resolveStartTimes((await s.listPending(0, 10)).rows);
    expect(out.conditions).toEqual([{ id: 1, facts: { courseType: null, distance: null, trackCondition: null, grade: null, raceName: null } }]);
  });
});

describe("commitStartTimes(Issue #389): 発走時刻と条件を 1 文で書く", () => {
  it("新しい分析(両方 NULL): 発走時刻と条件を書き、cond_read=1。D1 は 1 回の batch(2 文)のまま", async () => {
    await analyses().saveAnalysis(record(1));
    const spy = spyDb(local.db);
    const s = new D1VerifyStore({ db: spy.db, bucket: local.r2, now: () => NOW });
    await s.commitStartTimes([{ id: 1, value: "15:45" }], 1, [{ id: 1, facts: SNAP_FACTS }]);
    expect(spy.batches).toEqual([2]);
    expect(await condRowOf(1)).toEqual({ start_time: "15:45", course_type: "芝", distance: 1600, track_condition: "稍", grade: "G3", race_name: "3歳以上1勝クラス", cond_read: 1 });
  });

  it("読めなかった(facts: null)は cond_read=0 で、条件の列は NULL のまま", async () => {
    await analyses().saveAnalysis(record(1));
    await verifyStore().commitStartTimes([{ id: 1, value: "?" }], 0, [{ id: 1, facts: null }]);
    expect(await condRowOf(1)).toEqual({ start_time: "?", course_type: null, distance: null, track_condition: null, grade: null, race_name: null, cond_read: 0 });
  });

  it("既存分(発走時刻は済み・cond_read NULL): 条件だけ書き、確認済みの発走時刻は上書きしない", async () => {
    await analyses().saveAnalysis(record(1));
    await local.db.prepare("UPDATE analyses SET start_time = '10:00' WHERE id = 1").run();
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 1, [{ id: 1, facts: SNAP_FACTS }]);
    const row = await condRowOf(1);
    expect(row.start_time).toBe("10:00");
    expect(row).toMatchObject({ course_type: "芝", distance: 1600, cond_read: 1 });
  });

  it("★確認済みの条件(cond_read が NULL でない)は上書きしない。発走時刻が NULL の行でも、条件の列と cond_read は元のまま", async () => {
    await analyses().saveAnalysis(record(1));
    await local.db.prepare("UPDATE analyses SET cond_read = 1, course_type = 'ダ', distance = 1200 WHERE id = 1").run();
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 1, [{ id: 1, facts: SNAP_FACTS }]);
    expect(await condRowOf(1)).toEqual({ start_time: "15:45", course_type: "ダ", distance: 1200, track_condition: null, grade: null, race_name: null, cond_read: 1 });
  });

  it("★確認の印も上書きしない: 「読めなかった」(cond_read=0)と確認済みの行は、あとから読めた事実(1)で書き換えない(発走時刻が NULL の行でも)", async () => {
    await analyses().saveAnalysis(record(1));
    await local.db.prepare("UPDATE analyses SET cond_read = 0 WHERE id = 1").run();
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 1, [{ id: 1, facts: SNAP_FACTS }]);
    expect(await condRowOf(1)).toEqual({ start_time: "15:45", course_type: null, distance: null, track_condition: null, grade: null, race_name: null, cond_read: 0 });
  });

  it("両方済みの行は何も変えない", async () => {
    await analyses().saveAnalysis(record(1));
    await local.db.prepare("UPDATE analyses SET start_time = '10:00', cond_read = 0 WHERE id = 1").run();
    const written = await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 0, [{ id: 1, facts: SNAP_FACTS }]);
    expect(await condRowOf(1)).toEqual({ start_time: "10:00", course_type: null, distance: null, track_condition: null, grade: null, race_name: null, cond_read: 0 });
    expect(written).toBe(0);
  });

  it("条件の引数を渡さない呼び出し(従来の呼び方)は、条件の列に触れない(cond_read は NULL のまま)", async () => {
    await analyses().saveAnalysis(record(1));
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 1);
    expect(await condRowOf(1)).toEqual({ start_time: "15:45", course_type: null, distance: null, track_condition: null, grade: null, race_name: null, cond_read: null });
  });

  it("複数行を 1 文で書き分ける(行ごとに別の事実)", async () => {
    await analyses().saveAnalysis(record(1));
    await analyses().saveAnalysis(record(2, { courseType: "ダ", distance: 1800 }));
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }, { id: 2, value: "" }], 2, [{ id: 1, facts: SNAP_FACTS }, { id: 2, facts: { courseType: "ダ", distance: 1800, trackCondition: null, grade: null, raceName: null } }]);
    expect((await condRowOf(1)).distance).toBe(1600);
    expect((await condRowOf(2)).distance).toBe(1800);
    expect((await condRowOf(2)).course_type).toBe("ダ");
  });
});

describe("readAll(Issue #389): 分析の行に条件の列が付く", () => {
  it("courseType・distance・trackCondition・grade・raceName・condRead を読む(NULL の行は null)", async () => {
    await analyses().saveAnalysis(record(1));
    await analyses().saveAnalysis(record(2));
    await verifyStore().commitStartTimes([{ id: 1, value: "15:45" }], 1, [{ id: 1, facts: SNAP_FACTS }]);
    const out = await verifyStore().readAll();
    expect(out.rows.analyses[0]).toMatchObject({ id: 1, courseType: "芝", distance: 1600, trackCondition: "稍", grade: "G3", raceName: "3歳以上1勝クラス", condRead: 1 });
    expect(out.rows.analyses[1]).toMatchObject({ id: 2, courseType: null, distance: null, trackCondition: null, grade: null, raceName: null, condRead: null });
  });
});


describe("補完の通し(Issue #389。実 D1・実 R2 + VerifyCore): 既存分の一度だけの補完と、新しい分析の相乗り", () => {
  function core(bucket: VerifyBucket = local.r2) {
    const data = new Map<string, unknown>();
    const kv: VerifyKv = { get: <T>(k: string) => data.get(k) as T | undefined, put: (k: string, v: unknown) => void data.set(k, JSON.parse(JSON.stringify(v))) };
    const alarms: number[] = [];
    const c = new VerifyCore({ kv, now: () => NOW.getTime(), setAlarm: (at) => void alarms.push(at), getAlarm: async () => null, store: verifyStore(bucket) }, {});
    return { c, kv, alarms };
  }
  const classB = async () => (await local.db.prepare("SELECT class_b AS b FROM r2_ops WHERE ym = 202610").first<{ b: number }>())?.b ?? 0;

  it("発走時刻は済み・条件が未確認の既存分: 1 行につき R2 の get は 1 回で、発走時刻は変えずに条件だけが埋まる。Class B はその回数ぶん増える。全部済めば補完待ちは 0", async () => {
    for (let i = 1; i <= 5; i += 1) await analyses().saveAnalysis(record(i, { ...SNAP, distance: 1000 + i * 100 }));
    await local.db.prepare("UPDATE analyses SET start_time = '09:00'").run(); // 公開前に発走時刻だけ補完されていた状態
    expect((await verifyStore().listPending(0, 10)).total).toBe(5); // 前提: 条件が未確認なので全行が候補
    const spy = spyBucket(local.r2);
    const { c, kv } = core(spy.bucket as unknown as VerifyBucket);
    await c.runBackfillTick();
    expect(spy.calls.filter((x) => x.op === "get")).toHaveLength(5);
    expect(await classB()).toBe(5);
    for (let i = 1; i <= 5; i += 1) {
      expect(await condRowOf(i)).toEqual({ start_time: "09:00", course_type: "芝", distance: 1000 + i * 100, track_condition: "稍", grade: "G3", race_name: "3歳以上1勝クラス", cond_read: 1 });
    }
    expect((await verifyStore().listPending(0, 10)).total).toBe(0);
    expect(kv.get("cursor2")).toBe(5);
    await c.runBackfillTick(); // 済んだ後の tick は何もしない
    expect(spy.calls.filter((x) => x.op === "get")).toHaveLength(5);
  });

  it("新しい分析(両方 NULL): 1 回の get で発走時刻と条件の両方が埋まる(相乗り。追加の R2 読みは 0)", async () => {
    await analyses().saveAnalysis(record(1));
    const spy = spyBucket(local.r2);
    await core(spy.bucket as unknown as VerifyBucket).c.runBackfillTick();
    expect(spy.calls.filter((x) => x.op === "get")).toHaveLength(1);
    expect(await condRowOf(1)).toEqual({ start_time: "15:45", course_type: "芝", distance: 1600, track_condition: "稍", grade: "G3", race_name: "3歳以上1勝クラス", cond_read: 1 });
  });

  it("1 tick の R2 の get は 問い合わせ数の上限 − 4 まで。残りは次の tick が続ける(途中で止まっても再開できる)", async () => {
    const total = VERIFY_TICK_QUERY_LIMIT - 4 + 3;
    for (let i = 1; i <= total; i += 1) await analyses().saveAnalysis(record(i));
    await local.db.prepare("UPDATE analyses SET start_time = '09:00'").run();
    const spy = spyBucket(local.r2);
    const { c, alarms } = core(spy.bucket as unknown as VerifyBucket);
    await c.runBackfillTick();
    expect(spy.calls.filter((x) => x.op === "get")).toHaveLength(VERIFY_TICK_QUERY_LIMIT - 4);
    expect((await verifyStore().listPending(0, 100)).total).toBe(3);
    expect(alarms).toHaveLength(1); // 残りがあるので次のアラームを張る
    await c.runBackfillTick();
    expect((await verifyStore().listPending(0, 100)).total).toBe(0);
    expect(spy.calls.filter((x) => x.op === "get")).toHaveLength(total);
  });

  it("get が例外になった行は NULL のまま残り、次の tick が再試行して埋める(カーソルは手前で止まる)", async () => {
    for (let i = 1; i <= 3; i += 1) await analyses().saveAnalysis(record(i));
    await local.db.prepare("UPDATE analyses SET start_time = '09:00'").run();
    let broken = true;
    const flaky = { get: async (key: string) => { if (broken && key.endsWith("/2.json.gz")) throw new Error("R2_ERROR"); return local.r2.get(key); } } as unknown as VerifyBucket;
    const { c, kv } = core(flaky);
    await c.runBackfillTick();
    expect((await condRowOf(1)).cond_read).toBe(1);
    expect((await condRowOf(2)).cond_read).toBeNull();
    expect((await condRowOf(3)).cond_read).toBe(1);
    expect(kv.get("cursor2")).toBe(1);
    broken = false;
    await c.runBackfillTick();
    expect((await condRowOf(2)).cond_read).toBe(1);
    expect((await verifyStore().listPending(0, 10)).total).toBe(0);
  });

  it("詳細が無い既存分(detail_key が NULL)は get せず cond_read=0(読めなかった)。発走時刻は変えない", async () => {
    await analyses().saveAnalysis(record(1));
    await local.db.prepare("UPDATE analyses SET start_time = '09:00', detail_key = NULL").run();
    const spy = spyBucket(local.r2);
    await core(spy.bucket as unknown as VerifyBucket).c.runBackfillTick();
    expect(spy.calls).toEqual([]);
    expect(await condRowOf(1)).toEqual({ start_time: "09:00", course_type: null, distance: null, track_condition: null, grade: null, race_name: null, cond_read: 0 });
  });

  it("R2 に現れない既存分は、猶予(30 分)の間は未確認のまま保留し、猶予が過ぎたら cond_read=0 にする(発走時刻は変えない)", async () => {
    await analyses().saveAnalysis(record(1));
    await local.db.prepare("UPDATE analyses SET start_time = '09:00', detail_key = 'analyses/none-1' WHERE id = 1").run();
    const data = new Map<string, unknown>();
    const kv: VerifyKv = { get: <T>(k: string) => data.get(k) as T | undefined, put: (k: string, v: unknown) => void data.set(k, JSON.parse(JSON.stringify(v))) };
    let now = NOW.getTime();
    const c = new VerifyCore({ kv, now: () => now, setAlarm: () => undefined, getAlarm: async () => null, store: verifyStore() }, {});
    await c.runBackfillTick();
    expect((await condRowOf(1)).cond_read).toBeNull();
    now += 30 * 60_000;
    await c.runBackfillTick();
    expect(await condRowOf(1)).toEqual({ start_time: "09:00", course_type: null, distance: null, track_condition: null, grade: null, race_name: null, cond_read: 0 });
  });
});
