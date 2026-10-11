import { describe, expect, it } from "vitest";

import { AnalysisStore } from "../../src/ev/analysis-store.js";
import {
  MIGRATION_TABLES,
  MIGRATION_TABLE_NAMES,
  MigrationFormatError,
  MigrationTally,
  buildAnalysisLine,
  buildHeaderLine,
  buildResultLine,
  parseMigrationLine,
  serializeMigrationLine,
  validateMigrationLine,
  type MigrationAnalysisLine,
  type MigrationFooterLine,
  type MigrationHeaderLine,
  type MigrationResultLine,
  type MigrationRow,
  type MigrationTableName,
} from "../../src/ev/cloud-migration-format.js";

/**
 * Issue #215(#167-A)AC1: 移行ファイルの形式(列定義表・1 行の検証・件数の集計)。
 * ブラウザ/Worker で動く純関数(better-sqlite3・node: に依存しない)。
 */

const HEADER: MigrationHeaderLine = buildHeaderLine({ exportedAt: "2026-10-09T00:00:00.000Z", appVersion: "1.27.0" });

function row(table: MigrationTableName, values: Record<string, string | number | null>): MigrationRow {
  const out: Record<string, string | number | null> = {};
  for (const c of MIGRATION_TABLES[table].columns) {
    out[c.name] = c.name in values ? values[c.name]! : c.notNull ? (c.type === "text" ? "x" : 1) : null;
  }
  return out;
}

const ANALYSIS = row("analyses", { id: 12, race_id: "202603020211", analyzed_at: "2026-03-02T01:00:00.000Z" });
const HORSE = row("analysis_horses", { analysis_id: 12, umaban: 3, prior: 0.25, adjusted_prob: 0.25 });
const BET = row("analysis_bets", { analysis_id: 12, bet_type: "wide", combo_key: "0103", stake: 100 });
const META = row("analysis_allocation_meta", { analysis_id: 12, route: "mixed", odds_status: "ok" });
const ANALYSIS_LINE: MigrationAnalysisLine = buildAnalysisLine({ analysis: ANALYSIS, horses: [HORSE], bets: [BET], allocationMeta: META });

const RESULT = row("race_results", { race_id: "202603020211", umaban: 1 });
const RESULT_META = row("race_result_meta", { race_id: "202603020211", course_type: "芝" });
const PAYOUT = row("race_combo_payouts", { race_id: "202603020211", bet_type: "wide", combo_key: "0102", payout: 560 });
const IMPORT = row("race_combo_payout_imports", { race_id: "202603020211", bet_type: "wide" });
const RESULT_LINE: MigrationResultLine = buildResultLine({
  raceId: "202603020211",
  results: [RESULT],
  meta: RESULT_META,
  comboPayouts: [PAYOUT],
  comboPayoutImports: [IMPORT],
});

/** 上の 2 行を順に読んだときのフッタ。 */
function footerFor(counts: Partial<Record<MigrationTableName, number>> = {}, extra: Partial<MigrationFooterLine> = {}): MigrationFooterLine {
  return {
    type: "footer",
    counts: {
      analyses: 1, analysis_horses: 1, analysis_bets: 1, analysis_allocation_meta: 1,
      race_results: 1, race_result_meta: 1, race_combo_payouts: 1, race_combo_payout_imports: 1,
      ...counts,
    },
    analysisLines: 1,
    resultLines: 1,
    ...extra,
  };
}

describe("列定義表は exe の実スキーマ(AnalysisStore の PRAGMA table_info)と一致する", () => {
  const store = new AnalysisStore();
  const toType = (t: string) => (t === "INTEGER" ? "integer" : t === "REAL" ? "real" : "text");

  it("表の数は 8 で、表名の一覧と定義表のキーが一致する", () => {
    expect(MIGRATION_TABLE_NAMES).toHaveLength(8);
    expect([...MIGRATION_TABLE_NAMES].sort()).toEqual(Object.keys(MIGRATION_TABLES).sort());
  });

  it.each(MIGRATION_TABLE_NAMES.map((t) => [t] as const))("%s: 列名・型・NOT NULL(主キーを含む)が一致する", (table) => {
    const pragma = store.rawDatabase.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string; type: string; notnull: number; pk: number;
    }>;
    expect(pragma.length).toBeGreaterThan(0);
    const actual = pragma.map((c) => `${c.name}:${toType(c.type)}:${c.notnull === 1 || c.pk > 0}`).sort();
    const spec = MIGRATION_TABLES[table].columns.map((c) => `${c.name}:${c.type}:${c.notNull}`).sort();
    expect(spec).toEqual(actual);
    // 主キー列の宣言とも一致する(エラーメッセージで行を特定する列)
    const pkCols = pragma.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect([...MIGRATION_TABLES[table].keyColumns]).toEqual(pkCols);
  });
});

describe("基準となる行は有効(以降の拒否テストが空振りでないことの前提)", () => {
  it.each([
    ["ヘッダ", HEADER],
    ["分析", ANALYSIS_LINE],
    ["結果", RESULT_LINE],
    ["フッタ", footerFor()],
    ["配分メタなし・メタなしの行", { ...ANALYSIS_LINE, allocationMeta: null, horses: [], bets: [] }],
    ["結果のメタなし", { ...RESULT_LINE, meta: null }],
  ])("%s の行を検証が受理し、直列化→パースで同じ値に戻る", (_name, line) => {
    expect(validateMigrationLine(line)).toEqual(line);
    expect(parseMigrationLine(serializeMigrationLine(line as never))).toEqual(line);
  });
});

describe("行の検証(違反は、どの表・どの id/race_id・どの列かを含む MigrationFormatError)", () => {
  const withAnalysis = (patch: Record<string, string | number | null | undefined>, drop?: string): unknown => {
    const a: Record<string, unknown> = { ...ANALYSIS, ...patch };
    if (drop !== undefined) delete a[drop];
    return { ...ANALYSIS_LINE, analysis: a };
  };
  const withHorse = (patch: Record<string, unknown>, drop?: string): unknown => {
    const h: Record<string, unknown> = { ...HORSE, ...patch };
    if (drop !== undefined) delete h[drop];
    return { ...ANALYSIS_LINE, horses: [h] };
  };

  it.each<[string, unknown, string[]]>([
    ["分析の行に未知の列", withAnalysis({ legacy_note: "x" }), ["analyses (id=12)", "未知の列 legacy_note"]],
    ["分析の行で列が不足", withAnalysis({}, "model"), ["analyses (id=12)", "列 model がない"]],
    ["NOT NULL の列が null", withAnalysis({ analyzed_at: null }), ["analyses (id=12)", "analyzed_at", "null は許されない"]],
    ["整数の列に小数", withAnalysis({ ev_estimated: 0.5 }), ["analyses (id=12)", "ev_estimated", "整数"]],
    ["整数の列に文字列", withHorse({ umaban: "3" }), ["analysis_horses (analysis_id=12, umaban=3)", "umaban", "整数", "文字列"]],
    ["実数の列に文字列(SQLite の型の揺れ)", withHorse({ prior: "0.25" }), ["analysis_horses (analysis_id=12, umaban=3)", "prior", "有限の数値"]],
    ["実数の列に Infinity", withHorse({ prior: Number.POSITIVE_INFINITY }), ["analysis_horses (analysis_id=12, umaban=3)", "prior", "Infinity"]],
    ["実数の列に NaN", withHorse({ ev: Number.NaN }), ["analysis_horses", "ev", "NaN"]],
    ["文字列の列に数値", withAnalysis({ race_id: 202603020211 }), ["analyses", "race_id", "文字列"]],
    ["馬の analysis_id が親と違う", withHorse({ analysis_id: 13 }), ["analysis_horses (analysis_id=13, umaban=3)", "親(12)"]],
    ["買い目の analysis_id が親と違う", { ...ANALYSIS_LINE, bets: [{ ...BET, analysis_id: 99 }] }, ["analysis_bets", "親(12)"]],
    ["配分メタの analysis_id が親と違う", { ...ANALYSIS_LINE, allocationMeta: { ...META, analysis_id: 99 } }, ["analysis_allocation_meta", "親(12)"]],
    ["馬の並びが配列でない", { ...ANALYSIS_LINE, horses: {} }, ["analysis_horses", "配列"]],
    ["馬の行がオブジェクトでない", { ...ANALYSIS_LINE, horses: [null] }, ["analysis_horses", "オブジェクトでない"]],
    ["分析の行に未知の項目", { ...ANALYSIS_LINE, extra: 1 }, ["未知の項目 extra"]],
    ["分析の行で項目が不足", { type: "analysis", analysis: ANALYSIS, horses: [], bets: [] }, ["項目 allocationMeta がない"]],
    ["結果の子の race_id が親と違う", { ...RESULT_LINE, results: [{ ...RESULT, race_id: "OTHER" }] }, ["race_results (race_id=OTHER, umaban=1)", "親(202603020211)"]],
    ["組合せ払戻の払戻が小数", { ...RESULT_LINE, comboPayouts: [{ ...PAYOUT, payout: 1.5 }] }, ["race_combo_payouts (race_id=202603020211, bet_type=wide, combo_key=0102)", "payout"]],
    ["結果の raceId が空", { ...RESULT_LINE, raceId: "" }, ["raceId"]],
    ["結果のメタの race_id が親と違う", { ...RESULT_LINE, meta: { ...RESULT_META, race_id: "OTHER" } }, ["race_result_meta", "親(202603020211)"]],
    ["ヘッダの形式名が違う", { ...HEADER, format: "other" }, ["形式名"]],
    ["ヘッダの版が未対応", { ...HEADER, version: 2 }, ["未対応の版", "実際: 数値 2"]],
    ["ヘッダの exportedAt が空", { ...HEADER, exportedAt: "" }, ["exportedAt"]],
    ["フッタの counts に表が不足", { ...footerFor(), counts: { analyses: 1 } }, ["counts", "項目"]],
    ["フッタの件数が負", footerFor({ analyses: -1 }), ["counts.analyses"]],
    ["フッタの analysisLines が小数", footerFor({}, { analysisLines: 1.5 }), ["analysisLines"]],
    ["未知の行の種類", { type: "trailer" }, ["未知の行の種類"]],
    ["行が配列", [], ["オブジェクトでない"]],
    ["行が null", null, ["オブジェクトでない"]],
  ])("%s → 拒否する", (_name, value, fragments) => {
    let error: unknown;
    try {
      validateMigrationLine(value);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationFormatError);
    for (const f of fragments) {
      expect((error as Error).message).toContain(f);
    }
  });

  it("parseMigrationLine は、JSON として壊れた行を MigrationFormatError にする", () => {
    for (const bad of ['{"type":"header"', "", "not json", "[1,"]) {
      expect(() => parseMigrationLine(bad)).toThrow(MigrationFormatError);
    }
  });

  it("serializeMigrationLine は、Infinity を黙って null にせず throw する(情報を落とさない)", () => {
    const bad = { ...ANALYSIS_LINE, horses: [{ ...HORSE, prior: Number.POSITIVE_INFINITY }] };
    // 対照: 生の JSON.stringify は Infinity を null にして成功してしまう(これがこの検査の存在理由)
    expect(JSON.stringify(bad)).toContain('"prior":null');
    expect(() => serializeMigrationLine(bad)).toThrow(/analysis_horses.*prior/);
  });

  it("NULL・日本語・改行・U+2028 を含む値は、1 行の JSON に収まり、そのまま戻る", () => {
    const tricky = "改行\nと\r\nと と🐎と\"引用\"";
    const line = { ...ANALYSIS_LINE, analysis: { ...ANALYSIS, raw_response: tricky, model: null } };
    const text = serializeMigrationLine(line);
    expect(text).not.toContain("\n");
    expect(text).not.toContain("\r");
    const back = parseMigrationLine(text) as MigrationAnalysisLine;
    expect(back.analysis["raw_response"]).toBe(tricky);
    expect(back.analysis["model"]).toBeNull();
  });
});

describe("件数の集計と並びの約束(MigrationTally)", () => {
  function feed(lines: Array<ReturnType<typeof validateMigrationLine>>): MigrationTally {
    const t = new MigrationTally();
    for (const l of lines) t.accept(l);
    return t;
  }
  const other = (id: number): MigrationAnalysisLine => ({ ...ANALYSIS_LINE, analysis: { ...ANALYSIS, id }, horses: [], bets: [], allocationMeta: null });

  it("正しい並びなら読み終えられ、buildFooter は各表の行数を数える", () => {
    const t = feed([HEADER, ANALYSIS_LINE, RESULT_LINE]);
    expect(t.buildFooter()).toEqual(footerFor());
    expect(t.complete).toBe(false);
    t.accept(footerFor());
    expect(t.complete).toBe(true);
    expect(() => t.assertComplete()).not.toThrow();
  });

  it("フッタが来ないまま終わったファイル(途中で切れた)は assertComplete で検出する", () => {
    const t = feed([HEADER, ANALYSIS_LINE, RESULT_LINE]);
    expect(() => t.assertComplete()).toThrow(/フッタが無いまま終わっている/);
    expect(() => feed([]).assertComplete()).toThrow(MigrationFormatError);
  });

  it.each<[string, Array<ReturnType<typeof validateMigrationLine>>, string]>([
    ["最初がヘッダでない", [ANALYSIS_LINE], "1 行目: 最初の行がヘッダでない"],
    ["ヘッダが 2 回", [HEADER, HEADER], "2 行目: ヘッダが 2 回ある"],
    ["結果のあとに分析", [HEADER, RESULT_LINE, ANALYSIS_LINE], "3 行目: 結果の行のあとに分析の行がある"],
    ["分析の id が重複", [HEADER, ANALYSIS_LINE, ANALYSIS_LINE], "3 行目: 分析の行が id の昇順"],
    ["分析の id が降順", [HEADER, other(5), other(4)], "analysis.id=4、直前は 5"],
    ["結果の raceId が重複", [HEADER, RESULT_LINE, RESULT_LINE], "3 行目: 結果の行が raceId の昇順"],
    ["フッタのあとに行", [HEADER, footerFor({ analyses: 0, analysis_horses: 0, analysis_bets: 0, analysis_allocation_meta: 0, race_results: 0, race_result_meta: 0, race_combo_payouts: 0, race_combo_payout_imports: 0 }, { analysisLines: 0, resultLines: 0 }), HEADER], "3 行目: フッタのあとに行がある"],
    ["フッタの馬の件数が違う", [HEADER, ANALYSIS_LINE, RESULT_LINE, footerFor({ analysis_horses: 2 })], "analysis_horses: フッタ 2、実際 1"],
    ["フッタの買い目の件数が違う", [HEADER, ANALYSIS_LINE, RESULT_LINE, footerFor({ analysis_bets: 0 })], "analysis_bets: フッタ 0、実際 1"],
    ["フッタの組合せ払戻の件数が違う", [HEADER, ANALYSIS_LINE, RESULT_LINE, footerFor({ race_combo_payouts: 5 })], "race_combo_payouts"],
    ["フッタの分析の行数が違う", [HEADER, ANALYSIS_LINE, RESULT_LINE, footerFor({}, { analysisLines: 2 })], "分析の行数が一致しない"],
    ["フッタの結果の行数が違う", [HEADER, ANALYSIS_LINE, RESULT_LINE, footerFor({}, { resultLines: 0 })], "結果の行数が一致しない"],
  ])("%s → 拒否する", (_name, lines, fragment) => {
    let error: unknown;
    try {
      feed(lines);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationFormatError);
    expect((error as Error).message).toContain(fragment);
  });

  it("配分メタなし・メタなしの行は、その表の件数に数えない", () => {
    const t = feed([HEADER, { ...ANALYSIS_LINE, allocationMeta: null }, { ...RESULT_LINE, meta: null, comboPayouts: [], comboPayoutImports: [] }]);
    const f = t.buildFooter();
    expect([f.counts.analysis_allocation_meta, f.counts.race_result_meta, f.counts.race_combo_payouts, f.counts.race_combo_payout_imports]).toEqual([0, 0, 0, 0]);
    expect([f.counts.analyses, f.counts.race_results]).toEqual([1, 1]);
  });
});
