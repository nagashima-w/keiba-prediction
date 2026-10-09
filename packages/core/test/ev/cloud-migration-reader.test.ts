import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AnalysisStore } from "../../src/ev/analysis-store.js";
import { createCloudMigrationSource } from "../../src/ev/cloud-migration-reader.js";
import { MIGRATION_TABLES } from "../../src/ev/cloud-migration-format.js";
import {
  FIXTURE_ANALYSIS_COUNT,
  FIXTURE_RESULT_RACE_IDS,
  populateMigrationFixture,
} from "./cloud-migration-fixture.js";

/**
 * Issue #215(#167-A)AC3: 書き出しの読み出し側(キーセット・ページング)。
 * 実 DB(AnalysisStore の保存 API で埋めたインメモリ DB)に対して、ページ境界・和集合・列の明示・
 * 『await をまたいで接続を握らない』を固定する。
 */

function setup(): { store: AnalysisStore; source: ReturnType<typeof createCloudMigrationSource> } {
  const store = new AnalysisStore();
  populateMigrationFixture(store);
  return { store, source: createCloudMigrationSource(store.rawDatabase) };
}

const analysisIds = (page: ReturnType<ReturnType<typeof createCloudMigrationSource>["readAnalysisPage"]>) =>
  page.map((p) => p.analysis["id"]);

describe("フィクスチャの前提(空振りを防ぐ)", () => {
  it("分析は 5 件で、ページサイズ 2 の倍数でない", () => {
    const { store } = setup();
    const n = (store.rawDatabase.prepare("SELECT COUNT(*) AS n FROM analyses").get() as { n: number }).n;
    expect(n).toBe(FIXTURE_ANALYSIS_COUNT);
    expect(FIXTURE_ANALYSIS_COUNT % 2).toBe(1);
  });
});

describe("分析のページング(WHERE id > ? ORDER BY id LIMIT n)", () => {
  it("ページサイズ 2 で [1,2] → [3,4] → [5] → [] と進み、境界の重複も欠落もない", () => {
    const { source } = setup();
    expect(analysisIds(source.readAnalysisPage(0, 2))).toEqual([1, 2]);
    expect(analysisIds(source.readAnalysisPage(2, 2))).toEqual([3, 4]);
    expect(analysisIds(source.readAnalysisPage(4, 2))).toEqual([5]);
    expect(analysisIds(source.readAnalysisPage(5, 2))).toEqual([]);
  });

  it("ページサイズ 5(ちょうど件数)でも、次のページは空になる", () => {
    const { source } = setup();
    expect(analysisIds(source.readAnalysisPage(0, 5))).toEqual([1, 2, 3, 4, 5]);
    expect(analysisIds(source.readAnalysisPage(5, 5))).toEqual([]);
  });

  it("子の行(馬・買い目・配分メタ)はその分析のものだけが、キー順に付く", () => {
    const { source } = setup();
    const page = source.readAnalysisPage(0, 5);
    expect(page.map((p) => p.horses.map((h) => h["umaban"]))).toEqual([[1, 2], [1, 2, 3], [1], [7], [7, 8]]);
    expect(page.map((p) => p.bets.map((b) => b["combo_key"]))).toEqual([[], ["01", "0102"], [], [], []]);
    expect(page.map((p) => p.allocationMeta === null)).toEqual([true, false, false, true, true]);
    for (const p of page) {
      for (const h of p.horses) expect(h["analysis_id"]).toBe(p.analysis["id"]);
    }
  });

  it("行は定義表の列だけ・定義表の列すべてを持つ(列を明示した SELECT)", () => {
    const { source } = setup();
    const p = source.readAnalysisPage(0, 5)[1]!;
    const names = (t: keyof typeof MIGRATION_TABLES) => MIGRATION_TABLES[t].columns.map((c) => c.name).sort();
    expect(Object.keys(p.analysis).sort()).toEqual(names("analyses"));
    expect(Object.keys(p.horses[0]!).sort()).toEqual(names("analysis_horses"));
    expect(Object.keys(p.bets[0]!).sort()).toEqual(names("analysis_bets"));
    expect(Object.keys(p.allocationMeta!).sort()).toEqual(names("analysis_allocation_meta"));
  });

  it("定義表に無い古い列が DB に残っていても、書き出す行には含まれない", () => {
    const { store, source } = setup();
    store.rawDatabase.exec("ALTER TABLE analyses ADD COLUMN legacy_note TEXT");
    store.rawDatabase.exec("ALTER TABLE race_results ADD COLUMN legacy_note TEXT");
    store.rawDatabase.exec("UPDATE analyses SET legacy_note = '古い列'");
    const p = source.readAnalysisPage(0, 1)[0]!;
    expect(Object.keys(p.analysis)).not.toContain("legacy_note");
    expect(Object.keys(p.analysis).sort()).toEqual(MIGRATION_TABLES.analyses.columns.map((c) => c.name).sort());
    const r = source.readResultPage("", 1)[0]!;
    expect(Object.keys(r.results[0]!)).not.toContain("legacy_note");
  });

  it("NULL は null のまま、JSON 列は文字列のまま、日本語・改行はそのまま返る", () => {
    const { source } = setup();
    const [a1, a2] = source.readAnalysisPage(0, 2);
    expect(a1!.analysis["model"]).toBeNull();
    expect(a1!.analysis["raw_response"]).toBeNull();
    expect(a2!.analysis["prompt_version"]).toBe("v8");
    expect(typeof a2!.analysis["race_snapshot_json"]).toBe("string");
    expect(a2!.analysis["additional_instruction"]).toBe("芝の重馬場を重視\n二行目");
  });
});

describe("結果のページング(4 表の race_id の和集合・昇順)", () => {
  it("ページサイズ 2 で [211,212] → [213,214] → [215] → [] と進む", () => {
    const { source } = setup();
    const ids = (after: string, n: number) => source.readResultPage(after, n).map((r) => r.raceId);
    expect(ids("", 2)).toEqual([FIXTURE_RESULT_RACE_IDS[0], FIXTURE_RESULT_RACE_IDS[1]]);
    expect(ids(FIXTURE_RESULT_RACE_IDS[1], 2)).toEqual([FIXTURE_RESULT_RACE_IDS[2], FIXTURE_RESULT_RACE_IDS[3]]);
    expect(ids(FIXTURE_RESULT_RACE_IDS[3], 2)).toEqual([FIXTURE_RESULT_RACE_IDS[4]]);
    expect(ids(FIXTURE_RESULT_RACE_IDS[4], 2)).toEqual([]);
  });

  it("race_id が 1 つの表にしか現れないレース(取込記録だけ・メタだけ・払戻だけ)も落ちない", () => {
    const { source } = setup();
    const all = source.readResultPage("", 10);
    expect(all.map((r) => r.raceId)).toEqual([...FIXTURE_RESULT_RACE_IDS]);
    const byId = new Map(all.map((r) => [r.raceId, r]));
    const only = byId.get(FIXTURE_RESULT_RACE_IDS[2])!; // 取込記録だけ
    expect([only.results.length, only.meta, only.comboPayouts.length, only.comboPayoutImports.length]).toEqual([0, null, 0, 1]);
    const metaOnly = byId.get(FIXTURE_RESULT_RACE_IDS[3])!;
    expect([metaOnly.results.length, metaOnly.meta === null, metaOnly.comboPayouts.length, metaOnly.comboPayoutImports.length]).toEqual([0, false, 0, 0]);
    const payoutOnly = byId.get(FIXTURE_RESULT_RACE_IDS[4])!;
    expect([payoutOnly.results.length, payoutOnly.meta, payoutOnly.comboPayouts.length, payoutOnly.comboPayoutImports.length]).toEqual([0, null, 1, 0]);
  });

  it("分析だけがあって結果の無いレースは結果の行にならない", () => {
    const { store, source } = setup();
    store.saveAnalysis({
      raceId: "999999999999",
      analyzedAt: "2026-03-02T09:00:00.000Z",
      horses: [{ umaban: 1, prior: 0.1, adjustedProb: 0.1, placeOddsMin: null, ev: null, isPositive: false, contributions: null, mark: null }],
    });
    expect(source.readResultPage("", 50).map((r) => r.raceId)).toEqual([...FIXTURE_RESULT_RACE_IDS]);
  });

  it("結果の行の子は、そのレースのものだけがキー順に付く", () => {
    const { source } = setup();
    const r = source.readResultPage("", 1)[0]!;
    expect(r.results.map((x) => x["umaban"])).toEqual([1, 2, 3]);
    expect(r.comboPayouts.map((x) => `${x["bet_type"]}:${x["combo_key"]}`)).toEqual(["exacta:0201", "wide:0102", "wide:0103"]);
    expect(r.comboPayoutImports.map((x) => x["bet_type"])).toEqual(["exacta", "trio", "wide"]);
    expect(r.meta!["course_type"]).toBe("芝");
  });
});

describe("接続を握り続けない", () => {
  it("読み出し側のソースに .iterate( が無い(await をまたいで接続を占有する書き方をしない)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/ev/cloud-migration-reader.ts", import.meta.url)),
      "utf-8",
    );
    expect(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "")).not.toMatch(/\.iterate\s*\(/);
  });

  it("ページを返したあと(await の合間に相当)に、同じ接続で保存しても『connection is busy』にならない", () => {
    const { store, source } = setup();
    const page = source.readAnalysisPage(0, 2);
    expect(page).toHaveLength(2);
    expect(() =>
      store.saveAnalysis({
        raceId: "202603020299",
        analyzedAt: "2026-03-02T09:00:00.000Z",
        horses: [{ umaban: 1, prior: 0.1, adjustedProb: 0.1, placeOddsMin: null, ev: null, isPositive: false, contributions: null, mark: null }],
      }),
    ).not.toThrow();
    // 追記された分析は、続きのページ(id > 2)に現れる。
    expect(analysisIds(source.readAnalysisPage(2, 10))).toEqual([3, 4, 5, 6]);
  });
});
