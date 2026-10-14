import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  allocationBetParams,
  allocationMetaParams,
  analysisParams,
  comboPayoutParams,
  horseParams,
  raceResultParams,
  type SqlParams,
} from "../../src/ev/analysis-store-codec.js";
import { ALLOCATION_BET_TYPE_UMABAN_COUNT, buildAllocationBetComboKey, type AllocationBetType } from "../../src/ev/combo-bet-allocation.js";
import {
  MIGRATION_ANALYSIS_BET_TYPES,
  MIGRATION_ANALYZED_AT_MAX_LENGTH,
  MIGRATION_CATEGORY_MAX_LENGTH,
  MIGRATION_COMBO_BET_TYPES,
  MIGRATION_COMBO_KEY_MAX_LENGTH,
  MIGRATION_MARK_MAX_LENGTH,
  MIGRATION_MAX_CHILD_ROWS,
  MIGRATION_MAX_UMABAN,
  MIGRATION_TABLES,
  MigrationFormatError,
  MigrationTally,
  buildAnalysisLine,
  buildHeaderLine,
  buildResultLine,
  parseMigrationLine,
  serializeMigrationLine,
  validateMigrationLine,
  type MigrationAnalysisLine,
  type MigrationResultLine,
  type MigrationRow,
  type MigrationTableName,
  type ValidateMigrationOptions,
} from "../../src/ev/cloud-migration-format.js";
import { COMBO_SIZE, parseComboOddsKey, type ComboBetType } from "../../src/scraper/combo-odds-key.js";

/**
 * Issue #308(#302-B): 移行ファイルの行の「値の形・範囲・件数」の検証。
 * 型・NOT NULL・親子の一致(cloud-migration-format.test.ts)に加えて、race_id・kaisai_date・analyzed_at・umaban・bet_type・combo_key・
 * 文字列の長さ・1 行あたりの子の行数を見る。**最重要は、exe が実際に書き出した正しいファイルを拒否しないこと**(正例の回帰を先に固定する)。
 */

type Cell = string | number | null;

/** 表の行を作る(NOT NULL の列の既定値は、本ファイルの規則に適う値)。 */
function row(table: MigrationTableName, values: Record<string, Cell>): MigrationRow {
  const out: Record<string, Cell> = {};
  for (const c of MIGRATION_TABLES[table].columns) {
    out[c.name] = c.name in values ? values[c.name]! : c.notNull ? (c.type === "text" ? "x" : 1) : null;
  }
  return out;
}

const RACE = "202603020211";
const ANALYSIS = row("analyses", { id: 12, race_id: RACE, analyzed_at: "2026-03-02T01:00:00.000Z" });
const HORSE = row("analysis_horses", { analysis_id: 12, umaban: 3, prior: 0.25, adjusted_prob: 0.25 });
const BET = row("analysis_bets", { analysis_id: 12, bet_type: "wide", combo_key: "0103", stake: 100 });
const META = row("analysis_allocation_meta", { analysis_id: 12, route: "mixed", odds_status: "result" });
const ANALYSIS_LINE: MigrationAnalysisLine = buildAnalysisLine({ analysis: ANALYSIS, horses: [HORSE], bets: [BET], allocationMeta: META });
const RESULT = row("race_results", { race_id: RACE, umaban: 1 });
const PAYOUT = row("race_combo_payouts", { race_id: RACE, bet_type: "wide", combo_key: "0102", payout: 560 });
const IMPORT = row("race_combo_payout_imports", { race_id: RACE, bet_type: "wide" });
const RESULT_LINE: MigrationResultLine = buildResultLine({
  raceId: RACE,
  results: [RESULT],
  meta: row("race_result_meta", { race_id: RACE, course_type: "芝" }),
  comboPayouts: [PAYOUT],
  comboPayoutImports: [IMPORT],
});

function rejection(value: unknown, options?: ValidateMigrationOptions): Error {
  let error: unknown;
  try {
    validateMigrationLine(value, options);
  } catch (e) {
    error = e;
  }
  expect(error, "MigrationFormatError で拒否される").toBeInstanceOf(MigrationFormatError);
  return error as Error;
}

const withAnalysis = (patch: Record<string, Cell>): MigrationAnalysisLine => ({ ...ANALYSIS_LINE, analysis: { ...ANALYSIS, ...patch } });
const withHorse = (patch: Record<string, Cell>): MigrationAnalysisLine => ({ ...ANALYSIS_LINE, horses: [{ ...HORSE, ...patch }] });
const withBet = (patch: Record<string, Cell>): MigrationAnalysisLine => ({ ...ANALYSIS_LINE, bets: [{ ...BET, ...patch }] });
const withMeta = (patch: Record<string, Cell>): MigrationAnalysisLine => ({ ...ANALYSIS_LINE, allocationMeta: { ...META, ...patch } });
const withResultRow = (patch: Record<string, Cell>): MigrationResultLine => ({ ...RESULT_LINE, results: [{ ...RESULT, ...patch }] });
const withPayout = (patch: Record<string, Cell>): MigrationResultLine => ({ ...RESULT_LINE, comboPayouts: [{ ...PAYOUT, ...patch }] });
const withImport = (patch: Record<string, Cell>): MigrationResultLine => ({ ...RESULT_LINE, comboPayoutImports: [{ ...IMPORT, ...patch }] });

// ---------------------------------------------------------------------------
// 正例の回帰(exe が実際に書き出した形を拒否しない)
// ---------------------------------------------------------------------------

/** codec の束縛値の並び(INSERT の `?` の順)を、表の列定義の順で列名に対応させて行にする(`cloud/src/migration-convert.ts` が前提にしている並びの一致)。 */
function rowFromParams(table: MigrationTableName, params: SqlParams, ownerFirst?: { readonly value: Cell }): MigrationRow {
  const names = MIGRATION_TABLES[table].columns.map((c) => c.name);
  const out: Record<string, Cell> = {};
  // analyses の INSERT は id を除く 11 列。他は列定義と同じ並び。
  const offset = table === "analyses" ? 1 : 0;
  expect(params.length, `${table}: 束縛値の数 + 先頭の補完`).toBe(names.length - offset);
  names.forEach((name, i) => {
    if (i < offset) out[name] = ownerFirst?.value ?? null;
    else out[name] = params[i - offset]!;
  });
  return out;
}

describe("正例の回帰: exe が書き出した実物と、書き出しに使う codec の値は拒否されない", () => {
  const GOLDEN = fileURLToPath(new URL("../fixtures/cloud-migration-small.ndjson", import.meta.url));
  const golden = readFileSync(GOLDEN, "utf-8").replace(/\r\n/g, "\n").trimEnd().split("\n");
  const FAR_FUTURE = { maxAnalyzedAtMs: Date.parse("2100-01-01T00:00:00Z") } as const;

  it("golden(exe の書き出しの実物 12 行)は、時刻の上限あり・なしのどちらでも全行を通り、MigrationTally が完走する", () => {
    expect(golden).toHaveLength(12);
    for (const options of [undefined, FAR_FUTURE]) {
      const tally = new MigrationTally();
      for (const text of golden) tally.accept(parseMigrationLine(text, options));
      expect(tally.complete).toBe(true);
    }
  });

  it("golden の時刻は、サーバの上限(取り込み時刻 + 7 日)を超えない(取り込みの日がファイルの後であれば通る)", () => {
    const stamps = golden.flatMap((t) => {
      const line = parseMigrationLine(t);
      return line.type === "analysis" ? [String(line.analysis["analyzed_at"])] : [];
    });
    expect(stamps).toHaveLength(5);
    const newest = Math.max(...stamps.map((s) => Date.parse(s)));
    expect(() => golden.forEach((t) => parseMigrationLine(t, { maxAnalyzedAtMs: newest }))).not.toThrow();
    expect(() => golden.forEach((t) => parseMigrationLine(t, { maxAnalyzedAtMs: newest - 1 }))).toThrow(MigrationFormatError);
  });

  it("exe の書き出しに使う codec の束縛値(8 券種・18 頭・馬単の逆順・枠連の同枠・最大馬番)から作った行を通す", () => {
    const analysisId = 7;
    const raceIds = ["202601010101", "202610051212", "202644061105", "202664123112"]; // 中央の最小・最大、地方(大井相当・月日つき)の例
    for (const raceId of raceIds) {
      const record = {
        raceId,
        analyzedAt: new Date(Date.UTC(2026, 5, 1, 12, 34, 56, 789)).toISOString(),
        evEstimated: true,
        promptVersion: "v8",
        additionalInstruction: null,
        kaisaiDate: raceId.slice(0, 4) + "0601",
        model: "claude-sonnet-4-5",
        rawResponse: null,
        raceSnapshot: null,
        historyCutoffDate: "20260601",
        promptLookaheadGuarded: true,
      } as never;
      const analysis = rowFromParams("analyses", analysisParams(record), { value: analysisId });
      const horses = Array.from({ length: 18 }, (_, i) =>
        rowFromParams("analysis_horses", horseParams(analysisId, { umaban: i + 1, prior: 0.05, adjustedProb: 0.06, placeOddsMin: 2.4, ev: 1.1, isPositive: i % 2 === 0, contributions: null, mark: ["◎", "〇", "▲", "△", "☆", "注", null][i % 7] ?? null, reason: "内枠", highlights: ["a"], concerns: [] } as never)),
      );
      const keyed: Array<[AllocationBetType, number[]]> = [
        ["place", [18]], ["win", [1]], ["wide", [1, 18]], ["quinella", [17, 18]], ["trio", [16, 17, 18]],
        ["exacta", [13, 8]], ["exacta", [8, 13]], ["trifecta", [18, 17, 16]], ["bracketQuinella", [8, 8]], ["bracketQuinella", [1, 8]],
      ];
      expect(new Set(keyed.map(([t]) => t)).size, "全 8 券種を使っている(馬単と枠連は 2 つずつ)").toBe(8);
      const bets = keyed.map(([betType, umabans]) =>
        rowFromParams("analysis_bets", allocationBetParams(analysisId, { betType, comboKey: buildAllocationBetComboKey(betType, umabans), stake: 100, odds: 3.2, ev: 1.2 } as never)),
      );
      const meta = rowFromParams(
        "analysis_allocation_meta",
        allocationMetaParams(analysisId, {
          route: "place-only", unavailableReason: null, fallbackReason: "combo-odds-not-requested", skipReasonCode: "no-candidates", comboOddsWide: "not-requested", comboOddsTrio: "not-requested",
          bankroll: 10000, perRaceCap: 2000, kellyFraction: 0.25, evThreshold: 1.05, includeComboOdds: false, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true,
          includeTrifecta: true, includeBracketQuinella: true, betUnit: 100, greedySteps: 50, candidateCap: null, modelId: "claude-sonnet-4-5-20250929", modelApproximate: false, oddsStatus: "result",
        } as never),
      );
      const line = buildAnalysisLine({ analysis, horses, bets, allocationMeta: meta });
      expect(line.horses).toHaveLength(18);
      expect(line.bets).toHaveLength(keyed.length);
      expect(() => parseMigrationLine(serializeMigrationLine(line), FAR_FUTURE), `${raceId} の分析`).not.toThrow();

      const results = Array.from({ length: 18 }, (_, i) => rowFromParams("race_results", raceResultParams(raceId, { umaban: i + 1, finishPosition: i + 1, placePayout: 150, winPayout: null, passing: [3, 2], last3f: 34.5 } as never)));
      const payouts = (Object.keys(COMBO_SIZE) as ComboBetType[]).map((betType) => {
        const umabans = betType === "bracketQuinella" ? [8, 8] : COMBO_SIZE[betType] === 3 ? [18, 17, 16] : [18, 17];
        return rowFromParams("race_combo_payouts", comboPayoutParams(raceId, betType, { umabans, payout: 12345 } as never));
      });
      expect(payouts).toHaveLength(6);
      const resultLine = buildResultLine({
        raceId, results, meta: { race_id: raceId, course_type: "ダ" }, comboPayouts: payouts,
        comboPayoutImports: payouts.map((p) => ({ race_id: raceId, bet_type: p["bet_type"]! })),
      });
      expect(() => parseMigrationLine(serializeMigrationLine(resultLine)), `${raceId} の結果`).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 列ごとの規則(境界を含むテーブル駆動)
// ---------------------------------------------------------------------------

describe("race_id: parseRaceId を通る(分析の race_id・結果の raceId)", () => {
  it.each([
    ["中央の最小(場 01・R01)", "202601010101"],
    ["中央の最大(場 10・R12)", "202610051212"],
    ["地方(場 30〜64・月日が実在)", "202644061105"],
    ["地方の場コードの上限 64", "202664123112"],
  ])("%s は受理する", (_n, id) => {
    expect(() => validateMigrationLine(withAnalysis({ race_id: id }))).not.toThrow();
    expect(() => validateMigrationLine(buildResultLine({ raceId: id, results: [], meta: null, comboPayouts: [], comboPayoutImports: [] }))).not.toThrow();
  });

  it.each([
    ["11 桁", "20260302021"],
    ["13 桁", "2026030202111"],
    ["数字以外が混じる", "20260302021x"],
    ["場コード 00(測定スクリプトが作っていた形)", "202500000001"],
    ["場コード 11(中央の上限の外)", "202611010101"],
    ["場コード 29(中央と地方の間)", "202629010101"],
    ["帯広(65)", "202665010101"],
    ["地方の月日が実在しない(2 月 30 日)", "202644023011"],
    ["レース番号 00", "202601010100"],
    ["レース番号 13", "202601010113"],
    ["空白入り", "2026030202 1"],
    ["OTHER", "OTHER"],
  ])("%s → 拒否する(分析の race_id)", (_n, id) => {
    const e = rejection(withAnalysis({ race_id: id }));
    expect(e.message).toContain("analyses (id=12)");
    expect(e.message).toContain("race_id");
  });

  it.each([
    ["場コード 00", "202500000001"],
    ["11 桁", "20260302021"],
    ["OTHER", "OTHER"],
  ])("結果の行の raceId: %s → 拒否する。子の行を調べる前に raceId で拒否する", (_n, id) => {
    const line = { ...RESULT_LINE, raceId: id, results: [{ ...RESULT, race_id: id }] };
    const e = rejection(line);
    expect(e.message).toContain("raceId");
    expect(e.message).not.toContain("親(");
  });
});

describe("kaisai_date: null または parseKaisaiDate を通る", () => {
  it.each([["null", null], ["通常", "20260302"], ["閏日", "20240229"]])("%s は受理する", (_n, v) => {
    expect(() => validateMigrationLine(withAnalysis({ kaisai_date: v }))).not.toThrow();
  });
  it.each([
    ["末尾に文字(攻撃の例)", "20261001x"],
    ["7 桁", "2026030"],
    ["9 桁", "202603020"],
    ["13 月", "20261301"],
    ["2 月 30 日", "20260230"],
    ["閏年でない 2 月 29 日", "20260229"],
    ["空文字", ""],
    ["区切りつき", "2026-03-02"],
  ])("%s → 拒否する", (_n, v) => {
    const e = rejection(withAnalysis({ kaisai_date: v }));
    expect(e.message).toContain("analyses (id=12)");
    expect(e.message).toContain("kaisai_date");
  });
});

describe("analyzed_at: ISO 形式(タイムゾーン付き)・暦として実在・長さ上限。上限の時刻はオプションで渡されたときだけ見る", () => {
  it.each([
    ["toISOString の形(exe の実物)", "2026-03-02T01:00:00.000Z"],
    ["秒の小数なし", "2026-03-02T01:00:00Z"],
    ["オフセットつき", "2026-03-02T10:00:00+09:00"],
    ["小数 9 桁", "2026-03-02T01:00:00.123456789Z"],
    ["閏日", "2024-02-29T00:00:00.000Z"],
    ["古い日付(下限は置かない)", "1999-01-01T00:00:00.000Z"],
  ])("%s は受理する", (_n, v) => {
    expect(() => validateMigrationLine(withAnalysis({ analyzed_at: v }))).not.toThrow();
  });

  it.each([
    ["空白区切り(Date.parse は実行環境のローカル時刻として読む)", "2026-03-02 01:00:00"],
    ["タイムゾーンなし", "2026-03-02T01:00:00"],
    ["日付だけ", "2026-03-02"],
    ["2 月 30 日(Date.parse は 3 月 2 日に繰り上げて通す)", "2026-02-30T00:00:00.000Z"],
    ["閏年でない 2 月 29 日", "2026-02-29T00:00:00.000Z"],
    ["13 月", "2026-13-01T00:00:00.000Z"],
    ["25 時", "2026-03-02T25:00:00.000Z"],
    ["小数 10 桁", "2026-03-02T01:00:00.1234567890Z"],
    ["末尾に文字", "2026-03-02T01:00:00.000Zx"],
    ["空文字", ""],
    ["数字の羅列", "9999999999999"],
  ])("%s → 拒否する", (_n, v) => {
    const e = rejection(withAnalysis({ analyzed_at: v }));
    expect(e.message).toContain("analyses (id=12)");
    expect(e.message).toContain("analyzed_at");
  });

  it("長さ上限(固定値 40): ISO の形で最長のもの(小数 9 桁・オフセット)でも上限内で、巨大な文字列は拒否する", () => {
    expect(MIGRATION_ANALYZED_AT_MAX_LENGTH).toBe(40);
    const longest = "2026-03-02T01:00:00.123456789+09:00";
    expect(longest.length).toBeLessThanOrEqual(MIGRATION_ANALYZED_AT_MAX_LENGTH);
    expect(() => validateMigrationLine(withAnalysis({ analyzed_at: longest }))).not.toThrow();
    const e = rejection(withAnalysis({ analyzed_at: `2026-03-02T01:00:00.000Z${" ".repeat(100_000)}` }));
    expect(e.message).toContain("analyzed_at");
    expect(e.message.length).toBeLessThan(300);
  });

  it("maxAnalyzedAtMs: ちょうどは通り、1 ミリ秒超過は拒否する。オフセットつきも UTC に直して比べる", () => {
    const limit = Date.parse("2026-03-09T00:00:00.000Z");
    const atLimit = withAnalysis({ analyzed_at: "2026-03-09T00:00:00.000Z" });
    const over = withAnalysis({ analyzed_at: "2026-03-09T00:00:00.001Z" });
    expect(() => validateMigrationLine(atLimit, { maxAnalyzedAtMs: limit })).not.toThrow();
    const e = rejection(over, { maxAnalyzedAtMs: limit });
    expect(e.message).toContain("analyses (id=12)");
    expect(e.message).toContain("analyzed_at");
    expect(() => validateMigrationLine(withAnalysis({ analyzed_at: "2026-03-09T09:00:00.000+09:00" }), { maxAnalyzedAtMs: limit })).not.toThrow();
    rejection(withAnalysis({ analyzed_at: "2026-03-09T09:00:00.001+09:00" }), { maxAnalyzedAtMs: limit });
  });

  it("maxAnalyzedAtMs を渡さなければ、遠い未来(9999 年)も形が正しければ受理する(ブラウザ側は時刻を見ない)", () => {
    const far = withAnalysis({ analyzed_at: "9999-12-31T23:59:59.999Z" });
    expect(() => validateMigrationLine(far)).not.toThrow();
    expect(() => validateMigrationLine(far, {})).not.toThrow();
    rejection(far, { maxAnalyzedAtMs: Date.parse("2026-12-31T00:00:00Z") });
  });

  it("parseMigrationLine も maxAnalyzedAtMs を検証に渡す", () => {
    const text = serializeMigrationLine(withAnalysis({ analyzed_at: "2026-03-09T00:00:00.001Z" }));
    expect(() => parseMigrationLine(text)).not.toThrow();
    expect(() => parseMigrationLine(text, { maxAnalyzedAtMs: Date.parse("2026-03-09T00:00:00.000Z") })).toThrow(MigrationFormatError);
  });
});

describe("umaban: 整数 1〜18(分析の馬・結果の馬)", () => {
  it.each([[1], [9], [18]])("umaban=%i は受理する", (u) => {
    expect(() => validateMigrationLine(withHorse({ umaban: u }))).not.toThrow();
    expect(() => validateMigrationLine(withResultRow({ umaban: u }))).not.toThrow();
  });
  it.each([[0], [19], [-1], [100]])("umaban=%i → 拒否する", (u) => {
    const horse = rejection(withHorse({ umaban: u }));
    expect(horse.message).toContain("analysis_horses");
    expect(horse.message).toContain("umaban");
    const res = rejection(withResultRow({ umaban: u }));
    expect(res.message).toContain("race_results");
    expect(res.message).toContain("umaban");
  });
});

describe("bet_type: analysis_bets は 8 種、払戻系(race_combo_payouts・race_combo_payout_imports)は組合せの 6 種", () => {
  const EIGHT = ["place", "win", "wide", "quinella", "trio", "exacta", "bracketQuinella", "trifecta"];
  const SIX = ["wide", "quinella", "trio", "exacta", "bracketQuinella", "trifecta"];

  it("固定値: 8 種と 6 種の中身(定義から導いた集合が、意図した券種と一致する)", () => {
    expect([...MIGRATION_ANALYSIS_BET_TYPES].sort()).toEqual([...EIGHT].sort());
    expect([...MIGRATION_COMBO_BET_TYPES].sort()).toEqual([...SIX].sort());
  });

  it.each(EIGHT.map((t) => [t]))("analysis_bets: %s は受理する", (t) => {
    expect(() => validateMigrationLine(withBet({ bet_type: t, combo_key: "0102" }))).not.toThrow();
  });
  it.each(SIX.map((t) => [t]))("race_combo_payouts・race_combo_payout_imports: %s は受理する", (t) => {
    expect(() => validateMigrationLine(withPayout({ bet_type: t }))).not.toThrow();
    expect(() => validateMigrationLine(withImport({ bet_type: t }))).not.toThrow();
  });

  it.each([["空文字", ""], ["大文字始まり", "Wide"], ["未知", "foo"], ["区切りつき", "wide "], ["枠連の別名", "bracket"]])("%s → 拒否する(3 つの表のすべて)", (_n, t) => {
    expect(rejection(withBet({ bet_type: t })).message).toContain("bet_type");
    expect(rejection(withPayout({ bet_type: t })).message).toContain("bet_type");
    expect(rejection(withImport({ bet_type: t })).message).toContain("bet_type");
  });

  it.each([["place"], ["win"]])("払戻系で %s は拒否する(組合せ払戻には単頭の券種がない)", (t) => {
    expect(rejection(withPayout({ bet_type: t })).message).toContain("race_combo_payouts");
    expect(rejection(withImport({ bet_type: t })).message).toContain("race_combo_payout_imports");
  });
});

describe("combo_key: 偶数長の数字で各 2 桁が 01〜18、長さ 2〜6(analysis_bets・race_combo_payouts)", () => {
  it.each([["単頭", "01"], ["最大馬番", "18"], ["2 頭", "0118"], ["3 頭(上限長)", "181716"], ["馬単の逆順", "1308"], ["枠連の同枠", "0808"]])("%s (%s) は受理する", (_n, k) => {
    expect(() => validateMigrationLine(withBet({ combo_key: k }))).not.toThrow();
    expect(() => validateMigrationLine(withPayout({ combo_key: k }))).not.toThrow();
  });
  it.each([
    ["空文字", ""],
    ["奇数長", "010"],
    ["1 桁", "1"],
    ["00 を含む", "0001"],
    ["19 を含む", "0119"],
    ["数字以外", "01a2"],
    ["空白", "01 2"],
    ["4 頭ぶん(上限長を超える)", "01020304"],
    ["8 桁(測定スクリプトが作っていた形)", "00100037"],
  ])("%s → 拒否する", (_n, k) => {
    const bet = rejection(withBet({ combo_key: k }));
    expect(bet.message).toContain("analysis_bets");
    expect(bet.message).toContain("combo_key");
    const pay = rejection(withPayout({ combo_key: k }));
    expect(pay.message).toContain("race_combo_payouts");
    expect(pay.message).toContain("combo_key");
  });
  it("固定値: 上限長は 6", () => {
    expect(MIGRATION_COMBO_KEY_MAX_LENGTH).toBe(6);
  });
});

describe("文字列の長さ: カテゴリ列は 128、mark は 16(長文列には新しい上限を設けない)", () => {
  it("固定値", () => {
    expect([MIGRATION_CATEGORY_MAX_LENGTH, MIGRATION_MARK_MAX_LENGTH]).toEqual([128, 16]);
  });

  const categoryCases: Array<[string, (v: string) => unknown, string]> = [
    ["analyses.prompt_version", (v) => withAnalysis({ prompt_version: v }), "prompt_version"],
    ["analyses.model", (v) => withAnalysis({ model: v }), "model"],
    ["analyses.history_cutoff_date", (v) => withAnalysis({ history_cutoff_date: v }), "history_cutoff_date"],
    ["analysis_allocation_meta.route", (v) => withMeta({ route: v }), "route"],
    ["analysis_allocation_meta.unavailable_reason", (v) => withMeta({ unavailable_reason: v }), "unavailable_reason"],
    ["analysis_allocation_meta.fallback_reason", (v) => withMeta({ fallback_reason: v }), "fallback_reason"],
    ["analysis_allocation_meta.skip_reason_code", (v) => withMeta({ skip_reason_code: v }), "skip_reason_code"],
    ["analysis_allocation_meta.combo_odds_wide", (v) => withMeta({ combo_odds_wide: v }), "combo_odds_wide"],
    ["analysis_allocation_meta.combo_odds_trio", (v) => withMeta({ combo_odds_trio: v }), "combo_odds_trio"],
    ["analysis_allocation_meta.model_id", (v) => withMeta({ model_id: v }), "model_id"],
    ["analysis_allocation_meta.odds_status", (v) => withMeta({ odds_status: v }), "odds_status"],
    ["race_result_meta.course_type", (v) => ({ ...RESULT_LINE, meta: { ...(RESULT_LINE.meta as MigrationRow), course_type: v } }), "course_type"],
  ];
  it.each(categoryCases)("%s: 128 文字は受理し、129 文字は拒否する", (_n, make, column) => {
    expect(() => validateMigrationLine(make("あ".repeat(128)))).not.toThrow();
    const e = rejection(make("あ".repeat(129)));
    expect(e.message).toContain(column);
    expect(e.message).toContain("128");
  });

  it("analysis_horses.mark: 16 文字は受理し、17 文字は拒否する(集合は見ない: 想定外の印も長さが短ければ通す)", () => {
    expect(() => validateMigrationLine(withHorse({ mark: "◎" }))).not.toThrow();
    expect(() => validateMigrationLine(withHorse({ mark: "未知の印" }))).not.toThrow();
    expect(() => validateMigrationLine(withHorse({ mark: "x".repeat(16) }))).not.toThrow();
    const e = rejection(withHorse({ mark: "x".repeat(17) }));
    expect(e.message).toContain("mark");
    expect(e.message).toContain("16");
  });

  it("長文列(raw_response・race_snapshot_json・reason・additional_instruction・*_json)は、長くても拒否しない", () => {
    const big = "あ".repeat(200_000);
    expect(() =>
      validateMigrationLine({
        ...ANALYSIS_LINE,
        analysis: { ...ANALYSIS, raw_response: big, race_snapshot_json: big, additional_instruction: big },
        horses: [{ ...HORSE, reason: big, contributions_json: big, highlights_json: big, concerns_json: big }],
      }),
    ).not.toThrow();
    expect(() => validateMigrationLine({ ...RESULT_LINE, results: [{ ...RESULT, passing_json: big }] })).not.toThrow();
  });

  it("カテゴリ列の値が null なら長さの検査に入らない(NOT NULL でない列)", () => {
    expect(() => validateMigrationLine(withAnalysis({ model: null, prompt_version: null, history_cutoff_date: null }))).not.toThrow();
  });

  it("オッズの状態に、型 OddsStatus にない値(golden の \"ok\")が入っていても受理する(カテゴリ列は列挙で見ない)", () => {
    expect(() => validateMigrationLine(withMeta({ odds_status: "ok" }))).not.toThrow();
    expect(() => validateMigrationLine(withMeta({ route: "将来追加される到達状態" }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 子の行数
// ---------------------------------------------------------------------------

/** 総当たりで、1 レースに現れうる (bet_type, combo_key) をすべて列挙する(上限の導出式を使わず、独立に数える)。 */
function enumerateCombos(): Array<{ betType: string; key: string }> {
  const two = (n: number) => String(n).padStart(2, "0");
  const out: Array<{ betType: string; key: string }> = [];
  for (let a = 1; a <= 18; a += 1) {
    out.push({ betType: "place", key: two(a) }, { betType: "win", key: two(a) });
  }
  for (let a = 1; a <= 18; a += 1) {
    for (let b = 1; b <= 18; b += 1) {
      if (a < b) out.push({ betType: "wide", key: two(a) + two(b) }, { betType: "quinella", key: two(a) + two(b) });
      if (a !== b) out.push({ betType: "exacta", key: two(a) + two(b) });
      for (let c = 1; c <= 18; c += 1) {
        if (a < b && b < c) out.push({ betType: "trio", key: two(a) + two(b) + two(c) });
        if (a !== b && b !== c && a !== c) out.push({ betType: "trifecta", key: two(a) + two(b) + two(c) });
      }
    }
  }
  for (let a = 1; a <= 8; a += 1) {
    for (let b = a; b <= 8; b += 1) out.push({ betType: "bracketQuinella", key: two(a) + two(b) });
  }
  return out;
}

describe("1 行あたりの子の行数の上限(理論値から導く。実在しうる全部の組を載せた行は通り、1 行多いと拒否する)", () => {
  const all = enumerateCombos();
  const analysisBets = all.map((c) => ({ ...BET, bet_type: c.betType, combo_key: c.key }));
  const payouts = all.filter((c) => c.betType !== "place" && c.betType !== "win").map((c) => ({ ...PAYOUT, bet_type: c.betType, combo_key: c.key }));

  it("固定値: 総当たりの数と上限定数(馬 18・結果 18・買い目 6396・払戻 6360・取込マーカー 6)が一致する", () => {
    expect(all).toHaveLength(6396);
    expect(payouts).toHaveLength(6360);
    expect({ ...MIGRATION_MAX_CHILD_ROWS }).toEqual({ horses: 18, results: 18, bets: 6396, comboPayouts: 6360, comboPayoutImports: 6 });
  });

  it("買い目: 実在しうる全部の組(6396 行)の分析は受理され、フッタ・並びの集計も通る。1 行足すと拒否する", () => {
    const line = { ...ANALYSIS_LINE, bets: analysisBets };
    expect(line.bets).toHaveLength(6396);
    expect(() => validateMigrationLine(line)).not.toThrow();
    const over = { ...ANALYSIS_LINE, bets: [...analysisBets, analysisBets[0]!] };
    const e = rejection(over);
    expect(e.message).toContain("analysis_bets");
    expect(e.message).toContain("6396");
  });

  it("組合せ払戻: 実在しうる全部の組(6360 行)の結果は受理される。1 行足すと拒否する", () => {
    const line = { ...RESULT_LINE, comboPayouts: payouts };
    expect(line.comboPayouts).toHaveLength(6360);
    expect(() => validateMigrationLine(line)).not.toThrow();
    const e = rejection({ ...RESULT_LINE, comboPayouts: [...payouts, payouts[0]!] });
    expect(e.message).toContain("race_combo_payouts");
    expect(e.message).toContain("6360");
  });

  it("馬 18 行・結果 18 行は受理し、19 行は拒否する", () => {
    const horses = Array.from({ length: 18 }, (_, i) => ({ ...HORSE, umaban: i + 1 }));
    const results = Array.from({ length: 18 }, (_, i) => ({ ...RESULT, umaban: i + 1 }));
    expect(horses).toHaveLength(18);
    expect(() => validateMigrationLine({ ...ANALYSIS_LINE, horses })).not.toThrow();
    expect(() => validateMigrationLine({ ...RESULT_LINE, results })).not.toThrow();
    // 19 行目は有効な行にする(行の中身ではなく件数で拒否されることを確かめる)
    const e1 = rejection({ ...ANALYSIS_LINE, horses: [...horses, horses[0]!] });
    expect(e1.message).toContain("analysis_horses");
    expect(e1.message).toContain("18");
    const e2 = rejection({ ...RESULT_LINE, results: [...results, results[0]!] });
    expect(e2.message).toContain("race_results");
    expect(e2.message).toContain("18");
  });

  it("取込マーカー: 6 行は受理し、7 行は拒否する", () => {
    const six = MIGRATION_COMBO_BET_TYPES.map((t) => ({ ...IMPORT, bet_type: t }));
    expect(six).toHaveLength(6);
    expect(() => validateMigrationLine({ ...RESULT_LINE, comboPayoutImports: six })).not.toThrow();
    const e = rejection({ ...RESULT_LINE, comboPayoutImports: [...six, six[0]!] });
    expect(e.message).toContain("race_combo_payout_imports");
  });

  it("件数の検査は、行ごとの検証より先に行う(巨大な配列の個々の行を検証する前に拒否する)", () => {
    const invalidRow = { ...HORSE, umaban: 99 }; // 行の検証なら umaban で拒否される行
    const e = rejection({ ...ANALYSIS_LINE, horses: Array.from({ length: 50_000 }, () => invalidRow) });
    expect(e.message).toContain("行数");
    expect(e.message).not.toContain("umaban");
  });
});

describe("導出元の券種の定義とのドリフトを検知する", () => {
  it("8 種は配分の券種 AllocationBetType(ALLOCATION_BET_TYPE_UMABAN_COUNT のキー)と一致する", () => {
    expect([...MIGRATION_ANALYSIS_BET_TYPES].sort()).toEqual(Object.keys(ALLOCATION_BET_TYPE_UMABAN_COUNT).sort());
  });
  it("6 種は組合せの券種 ComboBetType(COMBO_SIZE のキー)と一致し、8 種はその 6 種 + place + win", () => {
    expect([...MIGRATION_COMBO_BET_TYPES].sort()).toEqual(Object.keys(COMBO_SIZE).sort());
    expect([...MIGRATION_ANALYSIS_BET_TYPES].filter((t) => !MIGRATION_COMBO_BET_TYPES.includes(t)).sort()).toEqual(["place", "win"]);
  });
  it("馬番の上限 18 は、combo_key の復号 parseComboOddsKey の上限と同じ(18 は通り、19 は通らない)", () => {
    expect(MIGRATION_MAX_UMABAN).toBe(18);
    expect(parseComboOddsKey("18")).not.toBeNull();
    expect(parseComboOddsKey("19")).toBeNull();
  });
  it("combo_key の上限長は、組合せの最大の要素数(COMBO_SIZE の最大)× 2", () => {
    expect(Math.max(...Object.values(COMBO_SIZE)) * 2).toBe(MIGRATION_COMBO_KEY_MAX_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// エラーメッセージの切り詰め
// ---------------------------------------------------------------------------

describe("エラーメッセージに入る主キー値・raceId は短く切る(長い値でも応答が膨らまない)", () => {
  const LONG = "R".repeat(5000);

  it("子の行の race_id が親と違う: 長い race_id は 40 文字で切られる", () => {
    const e = rejection({ ...RESULT_LINE, results: [{ ...RESULT, race_id: LONG }] });
    expect(e.message).toContain("race_results");
    expect(e.message).toContain("親(");
    expect(e.message).not.toContain("R".repeat(41));
    expect(e.message.length).toBeLessThan(300);
  });
  it("買い目の bet_type・combo_key が長い: 主キーを見せる部分でも 40 文字で切られる", () => {
    const e = rejection(withBet({ bet_type: LONG, combo_key: LONG }));
    expect(e.message).not.toContain("R".repeat(41));
    expect(e.message.length).toBeLessThan(400);
  });
  it("結果の raceId が長い: 拒否のメッセージに全文を入れない", () => {
    const e = rejection({ ...RESULT_LINE, raceId: LONG });
    expect(e.message).not.toContain("R".repeat(41));
    expect(e.message.length).toBeLessThan(300);
  });
  it("対照: 40 文字以内なら省略せずそのまま見せる", () => {
    const e = rejection({ ...RESULT_LINE, results: [{ ...RESULT, race_id: "OTHER" }] });
    expect(e.message).toContain("race_id=OTHER");
  });
});
