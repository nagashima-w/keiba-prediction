import { describe, expect, it } from "vitest";
import { allocationMetaParams, INSERT_ALLOCATION_META_SQL } from "../../packages/core/src/ev/analysis-store-codec.js";
import { MIGRATION_TABLES, MigrationFormatError, type MigrationAnalysisLine, type MigrationResultLine, type MigrationRow } from "../../packages/core/src/ev/cloud-migration-format";
import { toAnalysisImport, toResultImport } from "../src/migration-convert";
import { GOLDEN_ANALYSES, GOLDEN_RESULTS } from "./migration-fixture";

/**
 * Issue #216(#167-B1): exe の書き出しの行 → 既存の保存経路(AnalysisRecord)への変換。
 * 守ること: (1) 分析日時・開催日・版・モデル・追加指示・遮断の印などの元の値を保つ (2) 配分メタの列を落とさない
 * (NULL の設定列〈include_*〉を 0 に潰さない・codec の復元経路が読まない 6 列を落とさない) (3) 書き込みの前に壊れた行を弾く。
 */

const analysisAt = (i: number): MigrationAnalysisLine => GOLDEN_ANALYSES[i]!;

describe("前提(空振り防止): 実物の書き出しの中身", () => {
  it("分析5件・結果5レース。分析3は設定列が NULL の旧分析、分析2は LLM あり", () => {
    expect(GOLDEN_ANALYSES).toHaveLength(5);
    expect(GOLDEN_RESULTS).toHaveLength(5);
    expect(analysisAt(2).allocationMeta!["include_quinella"]).toBeNull();
    expect(analysisAt(1).analysis["model"]).toBe("claude-sonnet-4-5");
  });
});

describe("toAnalysisImport: 元の値を保つ", () => {
  it("分析2(LLM あり): 分析日時・開催日・版・モデル・追加指示・遮断の印・EV 推定・応答・スナップショットがそのまま入る", () => {
    const line = analysisAt(1);
    const imp = toAnalysisImport(line);
    expect(imp.exeId).toBe(line.analysis["id"]);
    const r = imp.record;
    expect(r.raceId).toBe("202603020211");
    expect(r.analyzedAt).toBe("2026-03-02T02:00:00.000Z");
    expect(r.kaisaiDate).toBe("20260302");
    expect(r.promptVersion).toBe("v8");
    expect(r.model).toBe("claude-sonnet-4-5");
    expect(r.additionalInstruction).toBe("芝の重馬場を重視\n二行目");
    expect(r.historyCutoffDate).toBe("20260301");
    expect(r.promptLookaheadGuarded).toBe(true);
    expect(r.evEstimated).toBe(true);
    expect(r.rawResponse).toBe(line.analysis["raw_response"]);
    expect(r.raceSnapshot).toEqual({ raceName: "福島民報杯", horses: [{ umaban: 1, name: "ディープ🐎" }], startTime: "15:25" });
    // 馬
    expect(r.horses.map((h) => h.umaban)).toEqual([1, 2, 3]);
    expect(r.horses[0]).toMatchObject({ mark: "◎", reason: "内枠で先行できる\n二行目", highlights: ["近走好調"], concerns: ["斤量増", "間隔が短い"], contributions: { bias: [{ name: "枠", delta: -0.01 }] } });
    expect(r.horses[1]).toMatchObject({ mark: "△", reason: "", contributions: null });
    // 買い目
    expect(r.allocation!.bets).toEqual([
      { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
      { betType: "wide", comboKey: "0102", stake: 200, odds: null, ev: null },
    ]);
  });

  it("分析1(LLM なし・配分なし): NULL の列は NULL のまま(遮断の印は null〈未記録〉で false にならない)。配分は付かない", () => {
    const imp = toAnalysisImport(analysisAt(0));
    expect(imp.record.promptVersion).toBeNull();
    expect(imp.record.model).toBeNull();
    expect(imp.record.rawResponse).toBeNull();
    expect(imp.record.raceSnapshot).toBeNull();
    expect(imp.record.promptLookaheadGuarded).toBeNull();
    expect(imp.record.historyCutoffDate).toBeNull();
    expect(imp.record.evEstimated).toBe(false);
    expect(imp.record.allocation).toBeUndefined();
    expect(imp.metaParams).toBeNull();
  });

  it("promptLookaheadGuarded の三値: 1 → true・0 → false(明示的に未遮断)・NULL → null", () => {
    for (const [raw, expected] of [[1, true], [0, false], [null, null]] as const) {
      const line = { ...analysisAt(0), analysis: { ...analysisAt(0).analysis, prompt_lookahead_guarded: raw } };
      expect(toAnalysisImport(line).record.promptLookaheadGuarded).toBe(expected);
    }
  });
});

describe("配分メタ: 行から直接 24 値を作る(codec の復元経路を通さない)", () => {
  const metaColumns = MIGRATION_TABLES.analysis_allocation_meta.columns.map((c) => c.name);

  it("列の並びが codec の INSERT 文の列の並びと一致する(ドリフト防止)", () => {
    const m = /\(([^)]*)\)\s*VALUES/.exec(INSERT_ALLOCATION_META_SQL);
    const sqlColumns = m![1]!.split(",").map((c) => c.trim());
    expect(sqlColumns).toHaveLength(24);
    expect(metaColumns).toEqual(sqlColumns);
  });

  it("分析2: 24 列のうち analysis_id を除く 23 値が、行の値そのまま(6 列〈combo_odds_wide・combo_odds_trio・greedy_steps・candidate_cap・model_id・model_approximate〉を含む)", () => {
    const row = analysisAt(1).allocationMeta as MigrationRow;
    const imp = toAnalysisImport(analysisAt(1));
    expect(imp.metaParams).toEqual(metaColumns.slice(1).map((c) => row[c]));
    expect(imp.metaParams).toHaveLength(23);
    // 前提: 落ちやすい 6 列の値が実際に非 null で入っている(全部 null だと「落ちない」ことを確かめられない)。
    expect(row["combo_odds_wide"]).toBe("available");
    expect(row["combo_odds_trio"]).toBe("未発売");
    expect(row["greedy_steps"]).toBe(1000);
    expect(row["model_id"]).toBe("conditional-bernoulli");
    expect(row["model_approximate"]).toBe(0);
    expect(imp.metaParams).toContain("conditional-bernoulli");
    // codec の経路(record の meta → allocationMetaParams)と、既存の列では一致する(型の違い以外に差がない)。
    expect(imp.metaParams).toEqual(allocationMetaParams(0, imp.record.allocation!.meta).slice(1));
  });

  it("分析3(旧分析): include_quinella・exacta・trifecta・bracket_quinella の NULL は NULL のまま。codec の経路では 0 に潰れる(対照)", () => {
    const imp = toAnalysisImport(analysisAt(2));
    const idx = (name: string): number => metaColumns.indexOf(name) - 1;
    for (const name of ["include_quinella", "include_exacta", "include_trifecta", "include_bracket_quinella"]) {
      expect(imp.metaParams![idx(name)], name).toBeNull();
    }
    // 対照: record の meta を codec に通すと 0 になる(だから行から直接作る)。この差がなければ、上の検査は何も守っていない。
    const viaCodec = allocationMetaParams(0, imp.record.allocation!.meta).slice(1);
    for (const name of ["include_quinella", "include_exacta", "include_trifecta", "include_bracket_quinella"]) {
      expect(viaCodec[idx(name)], name).toBe(0);
    }
    // 買い目 0 件の配分メタでも、メタは付く
    expect(imp.record.allocation!.bets).toEqual([]);
  });
});

describe("toAnalysisImport: 書き込みの前に壊れた行を弾く(MigrationFormatError。分析 id を含む)", () => {
  const base = analysisAt(1);
  const withAnalysis = (patch: Record<string, string | number | null>): MigrationAnalysisLine => ({ ...base, analysis: { ...base.analysis, ...patch } });
  const cases: ReadonlyArray<readonly [string, MigrationAnalysisLine, RegExp]> = [
    ["race_snapshot_json が JSON でない", withAnalysis({ race_snapshot_json: "{壊れた" }), /race_snapshot_json/],
    ["contributions_json が JSON でない", { ...base, horses: [{ ...base.horses[0]!, contributions_json: "{x" }, ...base.horses.slice(1)] }, /contributions_json/],
    ["馬番が重複する", { ...base, horses: [base.horses[0]!, base.horses[0]!] }, /馬番|umaban/],
    ["買い目のキーが重複する", { ...base, bets: [base.bets[0]!, base.bets[0]!] }, /買い目|analysis_bets/],
    ["配分メタが無いのに買い目がある", { ...base, allocationMeta: null }, /配分メタ/],
  ];
  it.each(cases)("%s", (_name, line, pattern) => {
    expect(() => toAnalysisImport(line)).toThrow(MigrationFormatError);
    expect(() => toAnalysisImport(line)).toThrow(pattern);
    expect(() => toAnalysisImport(line)).toThrow(String(base.analysis["id"]));
  });
});

describe("toResultImport: 結果の行 → 保存の入力", () => {
  const at = (raceId: string): MigrationResultLine => GOLDEN_RESULTS.find((l) => l.raceId === raceId)!;

  it("結果+メタ+組合せ払戻+取込記録のレース: 行の配列は race_id を除いた列の並び(MIGRATION_TABLES の順)の JSON", () => {
    const line = at("202603020211");
    const imp = toResultImport(line);
    expect(imp.raceId).toBe("202603020211");
    expect(imp.courseType).toBe("芝");
    const results = JSON.parse(imp.resultsJson!) as unknown[][];
    expect(results).toHaveLength(3);
    const cols = MIGRATION_TABLES.race_results.columns.map((c) => c.name).slice(1);
    expect(results[0]).toEqual(cols.map((c) => line.results[0]![c]));
    // passing_json は文字列のまま(再解釈しない)
    expect(typeof results[0]![cols.indexOf("passing_json")]).toBe("string");
    expect(imp.comboRowsJson).not.toBeNull();
    expect((JSON.parse(imp.comboRowsJson!) as unknown[][]).length).toBe(line.comboPayouts.length);
    expect(JSON.parse(imp.markerRowsJson!)).toEqual(line.comboPayoutImports.map((r) => [r["bet_type"]]));
    expect(line.comboPayoutImports.length).toBeGreaterThan(0);
  });

  it("取込記録だけのレース(結果なし)・メタだけのレース: 無い表は null", () => {
    const markersOnly = toResultImport(at("202603020213"));
    expect(markersOnly.resultsJson).toBeNull();
    expect(markersOnly.courseType).toBeNull();
    expect(markersOnly.comboRowsJson).toBeNull();
    expect(JSON.parse(markersOnly.markerRowsJson!)).toEqual([["wide"]]);
    const metaOnly = toResultImport(at("202603020214"));
    expect(metaOnly.courseType).toBe("ダ");
    expect(metaOnly.resultsJson).toBeNull();
    expect(metaOnly.markerRowsJson).toBeNull();
  });

  it("払戻の行だけがあるレース(取込記録なし): 払戻は入力に載る(マーカーは無い)", () => {
    const imp = toResultImport(at("202603020215"));
    expect(imp.comboRowsJson).not.toBeNull();
    expect(imp.markerRowsJson).toBeNull();
  });

  it("結果の馬番・払戻のキー・取込記録の券種が重複する行は弾く", () => {
    const line = at("202603020211");
    expect(() => toResultImport({ ...line, results: [line.results[0]!, line.results[0]!] })).toThrow(MigrationFormatError);
    expect(() => toResultImport({ ...line, comboPayouts: [line.comboPayouts[0]!, line.comboPayouts[0]!] })).toThrow(MigrationFormatError);
    expect(() => toResultImport({ ...line, comboPayoutImports: [line.comboPayoutImports[0]!, line.comboPayoutImports[0]!] })).toThrow(MigrationFormatError);
    expect(() => toResultImport({ ...line, results: [line.results[0]!, line.results[0]!] })).toThrow("202603020211");
  });
});
