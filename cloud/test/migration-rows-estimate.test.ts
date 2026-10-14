import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { D1_FREE_DAILY_WRITE_ROWS, estimateRowsWritten, MIGRATION_DAILY_ROW_LIMIT } from "../src/migration-core";
import { toAnalysisImport, toResultImport } from "../src/migration-convert";
import { D1ResultStore } from "../src/result-repository";
import { MIGRATION_MAX_CHILD_ROWS, type MigrationAnalysisLine, type MigrationResultLine } from "../../packages/core/src/ev/cloud-migration-format";
import { GOLDEN_ANALYSES, GOLDEN_RESULTS } from "./migration-fixture";
import { openLocalBindings, spyBucket, type LocalBindings } from "./local-bindings";

/**
 * Issue #309(#302-C): 移行の 1 行が書く D1 の行数(`meta.rows_written`)の見積もり `estimateRowsWritten` を、ローカルの workerd の D1 の実測で照合する。
 * `rows-written.test.ts` と同じ方法(本物の保存経路が返す `meta.rows_written`)。再現: `cd cloud && pnpm exec vitest run test/migration-rows-estimate.test.ts`。
 * 限界: ローカルの D1 の値で、本番の D1 が数える行数と同じとは限らない(最初の本番の実保存で確かめる)。
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

const WITH_META = GOLDEN_ANALYSES.find((a) => a.allocationMeta !== null && a.bets.length > 0)!;
const NO_META = GOLDEN_ANALYSES.find((a) => a.allocationMeta === null)!;
const RESULT_BASE = GOLDEN_RESULTS.find((r) => r.results.length > 0 && r.comboPayouts.length > 0)!;

/** 実物の行を水増しした分析の行(馬 H 頭・買い目 B 件)。配分メタ無しなら買い目は 0 件。 */
function analysisLine(id: number, horses: number, bets: number, meta: boolean): MigrationAnalysisLine {
  const base = meta ? WITH_META : NO_META;
  return {
    ...base,
    analysis: { ...base.analysis, id, analyzed_at: `2026-10-0${(id % 9) + 1}T00:00:00.000Z` },
    horses: Array.from({ length: horses }, (_, k) => ({ ...base.horses[0]!, analysis_id: id, umaban: k + 1 })),
    bets: meta ? Array.from({ length: bets }, (_, k) => ({ ...WITH_META.bets[0]!, analysis_id: id, bet_type: "wide", combo_key: String(k).padStart(5, "0") })) : [],
    allocationMeta: meta ? { ...base.allocationMeta!, analysis_id: id } : null,
  };
}

const BET_TYPES = ["wide", "trio", "exacta", "quinella", "trifecta", "bracket_quinella"];

/** 実物の行を水増しした結果の行(結果 R 頭・面の有無・払戻 C 行・取込マーカー M 行)。 */
function resultLine(n: number, results: number, meta: boolean, payouts: number, markers: number): MigrationResultLine {
  const raceId = `2026030202${String(10 + n).padStart(2, "0")}`;
  return {
    ...RESULT_BASE,
    raceId,
    results: Array.from({ length: results }, (_, k) => ({ ...RESULT_BASE.results[0]!, race_id: raceId, umaban: k + 1 })),
    meta: meta ? { race_id: raceId, course_type: "芝" } : null,
    comboPayouts: Array.from({ length: payouts }, (_, k) => ({ race_id: raceId, bet_type: "wide", combo_key: String(k).padStart(5, "0"), payout: 100 })),
    comboPayoutImports: Array.from({ length: markers }, (_, k) => ({ race_id: raceId, bet_type: BET_TYPES[k]! })),
  };
}

function analysisStore(): D1AnalysisStore {
  return new D1AnalysisStore({ db: local.db, bucket: spyBucket(local.r2).bucket, now: () => new Date(Date.UTC(2026, 9, 9)) });
}

describe("分析 1 件の見積もり: 新規の行は実測(meta.rows_written の合計)と一致し、取り込み済みの行は 0 を超えない", () => {
  // [馬, 買い目, 配分メタ]。0 頭・0 件、配分メタ無し、買い目の多い行(18 頭・6396 件=上限)を含む。
  const CASES: readonly (readonly [number, number, boolean])[] = [
    [0, 0, false],
    [1, 0, false],
    [18, 0, false],
    [0, 0, true],
    [1, 0, true],
    [1, 1, true],
    [5, 10, true],
    [18, 100, true],
    [18, MIGRATION_MAX_CHILD_ROWS.bets, true],
  ];

  it.each(CASES)("馬 %i 頭・買い目 %i 件・配分メタ %s", async (horses, bets, meta) => {
    const line = analysisLine(1001, horses, bets, meta);
    const estimate = estimateRowsWritten(line);
    const saved = await analysisStore().saveMigratedAnalysis(toAnalysisImport(line));
    if (saved.kind !== "saved") throw new Error("前提: 柵に達していない");
    expect(saved.rowsWritten).toBeGreaterThan(0);
    // 見積もりは実測と一致(新しい索引を足す migration で外れたら、ここで気づく)
    expect(estimate).toBe(saved.rowsWritten);
    // 式そのもの: 12 + 2H + (配分メタあり ? 1 + 2B : 0)
    expect(estimate).toBe(12 + 2 * horses + (meta ? 1 + 2 * bets : 0));
  }, 120_000);

  it("取り込み済みの分析(同じ id・同じ内容)の見積もりは 0(未完了の詳細があれば 1)。実測の 0 を下回らない", async () => {
    const line = analysisLine(1002, 5, 10, true);
    const store = analysisStore();
    const first = await store.saveMigratedAnalysis(toAnalysisImport(line));
    if (first.kind !== "saved") throw new Error("前提: 柵に達していない");
    expect(first.rowsWritten).toBeGreaterThan(1);
    expect(estimateRowsWritten(line, { alreadyImported: true })).toBe(0);
    expect(estimateRowsWritten(line, { alreadyImported: true, detailPending: true })).toBe(1);
    // 未完了の詳細の作り直し(repairDetail)が書く行はカウンタの 1 行
    const repair = await store.repairDetail(first.id, toAnalysisImport(line).record);
    expect(repair.kind).toBe("stored");
    const counter = await local.db.prepare("SELECT class_a AS a FROM r2_ops").first<{ a: number }>();
    expect(counter!.a).toBe(2); // 保存で 1、作り直しで +1(= 作り直しが書く行は 1)
  }, 120_000);
});

describe("結果 1 レースの見積もり: 新規の行は実測と一致し、既存の行がある 2 回目の実測 0 を下回らない", () => {
  // [結果の馬, 面, 払戻の行, 取込マーカー]
  const CASES: readonly (readonly [number, boolean, number, number])[] = [
    [1, false, 0, 0],
    [18, false, 0, 0],
    [0, true, 0, 0],
    [0, false, 1, 0],
    [0, false, 100, 0],
    [0, false, MIGRATION_MAX_CHILD_ROWS.comboPayouts, 0],
    [0, false, 0, MIGRATION_MAX_CHILD_ROWS.comboPayoutImports],
    [18, true, MIGRATION_MAX_CHILD_ROWS.comboPayouts, MIGRATION_MAX_CHILD_ROWS.comboPayoutImports],
  ];

  it.each(CASES)("結果 %i 頭・面 %s・払戻 %i 行・マーカー %i 行", async (results, meta, payouts, markers) => {
    const line = resultLine(1, results, meta, payouts, markers);
    const estimate = estimateRowsWritten(line);
    const store = new D1ResultStore({ db: local.db });
    const first = await store.saveMigratedResult(toResultImport(line));
    expect(first.rowsWritten).toBeGreaterThan(0);
    expect(estimate).toBe(first.rowsWritten);
    expect(estimate).toBe(2 * results + (meta ? 2 : 0) + 2 * payouts + 2 * markers);
    const again = await store.saveMigratedResult(toResultImport(line));
    expect(again.rowsWritten).toBe(0);
    expect(estimate).toBeGreaterThanOrEqual(again.rowsWritten);
  }, 120_000);
});

describe("見積もりの最大は日次の上限より小さい(#308 の子の行数の上限に依存する)", () => {
  it("分析・結果の最大(上限いっぱいの子の行)が、移行の 1 日の上限と D1 Free の 1 日の上限のどちらよりも小さい", () => {
    const maxAnalysis = estimateRowsWritten(analysisLine(1003, MIGRATION_MAX_CHILD_ROWS.horses, MIGRATION_MAX_CHILD_ROWS.bets, true));
    const maxResult = estimateRowsWritten(
      resultLine(2, MIGRATION_MAX_CHILD_ROWS.results, true, MIGRATION_MAX_CHILD_ROWS.comboPayouts, MIGRATION_MAX_CHILD_ROWS.comboPayoutImports),
    );
    // 前提: 最大は実際に大きい(自明な 0 ではない)
    expect(maxAnalysis).toBe(12 + 2 * 18 + 1 + 2 * 6396);
    expect(maxResult).toBe(2 * 18 + 2 + 2 * 6360 + 2 * 6);
    expect(Math.max(maxAnalysis, maxResult)).toBeLessThan(MIGRATION_DAILY_ROW_LIMIT);
    expect(Math.max(maxAnalysis, maxResult)).toBeLessThan(D1_FREE_DAILY_WRITE_ROWS);
  });

  it("ヘッダ・フッタは 0 行", () => {
    expect(estimateRowsWritten({ type: "header" } as never)).toBe(0);
    expect(estimateRowsWritten({ type: "footer" } as never)).toBe(0);
  });
});
