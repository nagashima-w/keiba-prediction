import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CloseSavePayload } from "../src/analysis-close";
import { D1AnalysisStore } from "../src/analysis-repository";
import { D1TargetsStore, TARGETS_ROWS_READ_BUDGET } from "../src/targets-repository";
import type { AnalysisAllocationRecord, AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #336 段階 A: 「今日の狙い目」の D1 の読み取り(`D1TargetsStore.readDay`)。ローカル(workerd)の D1 に、CI と同じ実コマンドの migration を適用して確かめる。
 * 確かめること: レースごとに最新の分析だけを採る・別の開催日が混ざらない・買い目の集計(`stake > 0` の点数・合計・最大 EV)・◎の馬番・再計算の回の集計・
 * close の表が無くても分析の側は読める・**1 日ぶんの読み取り行数(`meta.rows_read`)が予算内**。
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

const DATE = "20261017";
const BASE_META = contractCases[0]!.record.allocation!.meta;
const store = (): D1AnalysisStore => new D1AnalysisStore({ db: local.db, bucket: local.r2 });
const targets = (): D1TargetsStore => new D1TargetsStore({ db: local.db });

function allocation(bets: readonly { stake: number; ev: number | null }[]): AnalysisAllocationRecord {
  return {
    meta: { ...BASE_META, route: "mixed", skipReasonCode: null, unavailableReason: null, fallbackReason: null, bankroll: 100000, perRaceCap: 30000, oddsStatus: "middle" },
    bets: bets.map((b, i) => ({ betType: "wide", comboKey: `01${String(i + 2).padStart(2, "0")}`, stake: b.stake, odds: 5 + i, ev: b.ev })),
  };
}

interface SeedOptions {
  readonly kaisaiDate?: string;
  readonly bets?: readonly { stake: number; ev: number | null }[];
  /** ◎を付ける馬番(null = 付けない)。既定 7。 */
  readonly mark?: number | null;
  readonly horses?: number;
}

function record(raceId: string, analyzedAt: string, options: SeedOptions = {}): AnalysisRecord {
  const n = options.horses ?? 16;
  const mark = options.mark === undefined ? 7 : options.mark;
  return {
    raceId,
    analyzedAt,
    kaisaiDate: options.kaisaiDate ?? DATE,
    promptVersion: "v-test",
    horses: Array.from({ length: n }, (_, i) => ({ umaban: i + 1, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 2, ev: 1, isPositive: false, contributions: null, mark: mark === i + 1 ? "◎" : null, reason: "r" })),
    allocation: allocation(options.bets ?? [{ stake: 300, ev: 1.2 }, { stake: 200, ev: 1.5 }, { stake: 100, ev: 1.1 }]),
  };
}

const DUE = Date.parse("2026-10-17T06:40:00Z");
function closeOk(round: 1 | 2, bets: readonly { stake: number; ev: number | null }[]): CloseSavePayload {
  return { round, status: "ok", reason: null, dueAtMs: DUE, firedAtMs: DUE + 1000, lateMs: 1000, oddsOfficialDatetime: "2026-10-17 15:41:30", allocation: allocation(bets) };
}

const R1 = "202605050801";
const R2 = "202605050802";

describe("D1TargetsStore.readDay: 分析の側", () => {
  it("レースごとに最新の分析(分析日時の降順・同時刻は id の降順)だけを採る。id の順と分析日時の順が逆でも", async () => {
    const newer = await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z", { bets: [{ stake: 100, ev: 1.1 }] }));
    const older = await store().saveAnalysis(record(R1, "2026-10-17T01:00:00.000Z", { bets: [{ stake: 100, ev: 1.1 }, { stake: 100, ev: 1.1 }] }));
    // 前提: id は保存順(older の方が大きい)で、分析日時の順と逆。
    expect(older.id).toBeGreaterThan(newer.id);
    const { analyses } = await targets().readDay(DATE);
    expect(analyses).toHaveLength(1);
    expect(analyses[0]).toMatchObject({ analysisId: newer.id, raceId: R1, betCount: 1 });
  });

  it("分析日時が同じなら id の大きい方", async () => {
    const a = await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z"));
    const b = await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z"));
    expect(b.id).toBeGreaterThan(a.id);
    expect((await targets().readDay(DATE)).analyses.map((r) => r.analysisId)).toEqual([b.id]);
  });

  it("別の開催日の分析は混ざらない。開催日の分析が無ければ空", async () => {
    await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z", { kaisaiDate: "20261018" }));
    await store().saveAnalysis(record(R2, "2026-10-17T02:00:00.000Z"));
    const { analyses } = await targets().readDay(DATE);
    expect(analyses.map((r) => r.raceId)).toEqual([R2]);
    expect((await targets().readDay("20300101")).analyses).toEqual([]);
  });

  it("買い目の集計: stake > 0 の点数・合計・最大 EV。EV が null の買い目は最大に影響しない", async () => {
    const bets = [{ stake: 300, ev: 1.2 }, { stake: 200, ev: 1.5 }, { stake: 100, ev: null }, { stake: 0, ev: 9.9 }];
    await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z", { bets }));
    const [row] = (await targets().readDay(DATE)).analyses;
    // 前提: 買い目の行は 4 つ保存されている(stake 0 の行が実際にある)。
    expect((await local.db.prepare("SELECT count(*) AS c FROM analysis_bets").first<{ c: number }>())!.c).toBe(4);
    expect(row).toMatchObject({ betCount: 3, totalStake: 600, maxEv: 1.5 });
  });

  it("買い目が無い分析: 点数 0・合計 0・最大 EV は null(行は残る=分析済みの件数に数える)", async () => {
    await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z", { bets: [] }));
    const [row] = (await targets().readDay(DATE)).analyses;
    expect(row).toMatchObject({ raceId: R1, betCount: 0, totalStake: 0, maxEv: null });
  });

  it("◎の馬番: ◎のある馬の番号。無ければ null。別の分析の◎は混ざらない", async () => {
    await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z", { mark: 3 }));
    await store().saveAnalysis(record(R2, "2026-10-17T02:00:00.000Z", { mark: null }));
    const rows = (await targets().readDay(DATE)).analyses;
    expect(rows.find((r) => r.raceId === R1)!.markUmaban).toBe(3);
    expect(rows.find((r) => r.raceId === R2)!.markUmaban).toBeNull();
  });

  it("◎は表示対象(買い目のある分析)だけ読む: 買い目も再計算の買い目も無い分析は、◎があっても markUmaban は null(読み取りを減らすため)", async () => {
    await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z", { mark: 3, bets: [] }));
    await store().saveAnalysis(record(R2, "2026-10-17T02:00:00.000Z", { mark: 4 }));
    const rows = (await targets().readDay(DATE)).analyses;
    expect(rows.find((r) => r.raceId === R1)!.markUmaban).toBeNull();
    // 対照: 買い目のある分析の◎は読まれる(上の null が、◎を読まないことによるものだと確かめる)
    expect(rows.find((r) => r.raceId === R2)!.markUmaban).toBe(4);
  });

  it("分析時は 0 点でも、再計算の ok の回に買い目があれば(狙い目になりうる)◎を読む。再計算が 0 点だけなら読まない", async () => {
    const a = await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z", { mark: 3, bets: [] }));
    await store().saveClose(a.id, closeOk(1, [{ stake: 100, ev: 1.2 }]));
    const b = await store().saveAnalysis(record(R2, "2026-10-17T02:00:00.000Z", { mark: 4, bets: [] }));
    await store().saveClose(b.id, closeOk(1, []));
    const rows = (await targets().readDay(DATE)).analyses;
    expect(rows.find((r) => r.raceId === R1)!.markUmaban).toBe(3);
    expect(rows.find((r) => r.raceId === R2)!.markUmaban).toBeNull();
  });

  it("レースの並びは race_id の昇順", async () => {
    await store().saveAnalysis(record(R2, "2026-10-17T02:00:00.000Z"));
    await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z"));
    expect((await targets().readDay(DATE)).analyses.map((r) => r.raceId)).toEqual([R1, R2]);
  });
});

describe("D1TargetsStore.readDay: 再計算の回", () => {
  it("回ごとの状態と買い目の集計が、最新の分析のものだけ付く(古い分析の回は出ない)", async () => {
    const old = await store().saveAnalysis(record(R1, "2026-10-17T01:00:00.000Z"));
    const latest = await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z"));
    await store().saveClose(old.id, closeOk(1, [{ stake: 100, ev: 1.1 }]));
    await store().saveClose(latest.id, closeOk(1, [{ stake: 500, ev: 1.3 }, { stake: 300, ev: 1.6 }]));
    await store().saveClose(latest.id, { round: 2, status: "failed", reason: "blocked", dueAtMs: DUE, firedAtMs: DUE + 1, lateMs: 1, oddsOfficialDatetime: null, allocation: null });
    const { closeRounds } = await targets().readDay(DATE);
    expect(closeRounds).not.toBeNull();
    expect(closeRounds!.map((r) => [r.analysisId, r.round, r.status, r.betCount, r.totalStake, r.maxEv])).toEqual([
      [latest.id, 1, "ok", 2, 800, 1.6],
      [latest.id, 2, "failed", 0, 0, null],
    ]);
  });

  it("ok で買い目が 0 点の回は、点数 0 で出る(見送りの判定に使う)", async () => {
    const a = await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z"));
    await store().saveClose(a.id, closeOk(2, []));
    const { closeRounds } = await targets().readDay(DATE);
    expect(closeRounds!.map((r) => [r.round, r.status, r.betCount, r.totalStake, r.maxEv])).toEqual([[2, "ok", 0, 0, null]]);
  });

  it("再計算の結果が 1 つも無い日は、空の配列(null ではない=取れなかったのではない)", async () => {
    await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z"));
    expect((await targets().readDay(DATE)).closeRounds).toEqual([]);
  });
});

/** migration 0019 の表を作り直す(D1 の exec は 1 行 1 文なので、コメントを除いて 1 文ずつ流す)。 */
async function recreateCloseTables(): Promise<void> {
  const sql = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0019_close.sql"), "utf-8");
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "");
  expect(statements).toHaveLength(2); // 前提: analysis_close と analysis_close_bets の 2 文
  for (const s of statements) await local.db.prepare(s).run();
}

describe("D1TargetsStore.readDay: 再計算の表が無い間(migration の適用前に Worker が先に出た場合)", () => {
  it("表が無くても分析の側は読める。再計算は null(取れなかった)", async () => {
    await store().saveAnalysis(record(R1, "2026-10-17T02:00:00.000Z"));
    await local.db.prepare("DROP TABLE analysis_close_bets").run();
    await local.db.prepare("DROP TABLE analysis_close").run();
    try {
      const result = await targets().readDay(DATE);
      expect(result.analyses).toHaveLength(1);
      expect(result.closeRounds).toBeNull();
    } finally {
      await recreateCloseTables();
    }
    // 対照: 復旧後は null でなく空の配列に戻る(上の null が、表が無いことによるものだと確かめる)
    expect((await targets().readDay(DATE)).closeRounds).toEqual([]);
  });

  it("分析の側の読み取りが失敗したら、握らず投げる(呼び出し側が 503 にする)", async () => {
    const failing = {
      prepare: (sql: string) => local.db.prepare(sql),
      batch: async () => {
        throw new Error("D1_ERROR: injected");
      },
    } as unknown as ConstructorParameters<typeof D1TargetsStore>[0]["db"];
    await expect(new D1TargetsStore({ db: failing }).readDay(DATE)).rejects.toThrow("injected");
  });
});

describe("読み取り行数(D1 の `meta.rows_read`。Free は 1 日 500 万行)", () => {
  /**
   * 1 日ぶん: 中央 3 場・地方 3 場の各 12 レース = 72 レース。各レースを 2 回分析(再実行)し、16 頭を持たせる。
   * 先頭の `targetRaces` レースだけが、買い目 10 点と再計算 2 回(各 10 点)を持つ(狙い目)。残りは買い目 0 点(再計算の回は ok・0 点を 1 回)。
   */
  async function seedDay(targetRaces: number): Promise<void> {
    const raceIds: string[] = [];
    for (const place of ["05", "06", "09"]) for (let r = 1; r <= 12; r += 1) raceIds.push(`2026${place}0508${String(r).padStart(2, "0")}`);
    for (const place of ["42", "43", "44"]) for (let r = 1; r <= 12; r += 1) raceIds.push(`2026${place}1017${String(r).padStart(2, "0")}`);
    expect(raceIds).toHaveLength(72);
    const bets = Array.from({ length: 10 }, (_, i) => ({ stake: 100 * (i + 1), ev: 1.1 + i / 100 }));
    for (const [index, raceId] of raceIds.entries()) {
      const isTarget = index < targetRaces;
      await store().saveAnalysis(record(raceId, "2026-10-17T01:00:00.000Z", { bets: isTarget ? bets : [] }));
      const latest = await store().saveAnalysis(record(raceId, "2026-10-17T02:00:00.000Z", { bets: isTarget ? bets : [] }));
      if (isTarget) {
        await store().saveClose(latest.id, closeOk(1, bets));
        await store().saveClose(latest.id, closeOk(2, bets));
      } else {
        await store().saveClose(latest.id, closeOk(1, []));
      }
    }
  }

  it(`最悪の日(72 レース全部が分析済み・買い目 10 点・再計算 2 回)でも、${TARGETS_ROWS_READ_BUDGET} 行未満`, async () => {
    await seedDay(72);
    // 前提: 実際に大量の行がある(行数の上限が、空に近い DB で自明に成り立っていない)。
    const total = async (table: string) => (await local.db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c;
    expect(await total("analyses")).toBe(144);
    expect(await total("analysis_horses")).toBe(144 * 16);
    expect(await total("analysis_bets")).toBe(144 * 10);
    expect(await total("analysis_close_bets")).toBe(72 * 2 * 10);
    const result = await targets().readDay(DATE);
    expect(result.analyses).toHaveLength(72);
    expect(result.closeRounds).toHaveLength(144);
    // 集計が実際に動いている(退化した入力で行数だけが小さくなっていない)。
    expect(result.analyses.every((a) => a.betCount === 10 && a.totalStake === 5500 && a.markUmaban === 7)).toBe(true);
    console.log(`[targets] 最悪の日 rows_read = ${result.rowsRead}`);
    expect(result.rowsRead).toBeGreaterThan(1000);
    expect(result.rowsRead).toBeLessThan(TARGETS_ROWS_READ_BUDGET);
  }, 120_000);

  it("現実的な日(72 レースを分析し、3 分の 1 の 24 レースが狙い目)は、最悪の日より読み取りが少なく、◎は狙い目だけに付く", async () => {
    await seedDay(24);
    const result = await targets().readDay(DATE);
    expect(result.analyses).toHaveLength(72);
    // 前提: 狙い目とそうでないものが両方ある(割合の退化がない)。
    const withBets = result.analyses.filter((a) => a.betCount > 0);
    expect(withBets).toHaveLength(24);
    expect(withBets.every((a) => a.markUmaban === 7)).toBe(true);
    expect(result.analyses.filter((a) => a.betCount === 0).every((a) => a.markUmaban === null)).toBe(true);
    console.log(`[targets] 現実的な日 rows_read = ${result.rowsRead}`);
    expect(result.rowsRead).toBeGreaterThan(500);
    expect(result.rowsRead).toBeLessThan(TARGETS_ROWS_READ_BUDGET * 0.6);
  }, 120_000);
});
