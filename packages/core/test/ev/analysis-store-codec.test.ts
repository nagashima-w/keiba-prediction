import { describe, expect, it } from "vitest";

import {
  INSERT_ALLOCATION_BET_SQL,
  INSERT_ALLOCATION_META_SQL,
  INSERT_ANALYSIS_HORSE_SQL,
  INSERT_ANALYSIS_SQL,
  allocationBetParams,
  allocationMetaParams,
  analysisParams,
  buildChildParams,
  horseParams,
  toStoredAllocation,
  toStoredAnalysis,
  toStoredHorse,
  toStoredRaceSnapshot,
  type AllocationMetaRow,
  type AnalysisRow,
  type HorseRow,
  type SqlParams,
} from "../../src/ev/analysis-store-codec.js";
import type {
  AnalysisAllocationMetaRecord,
  AnalysisBetRecord,
  AnalysisHorseRecord,
  AnalysisRecord,
} from "../../src/ev/analysis-store-types.js";

/**
 * Issue #168(#163-a)AC-a5: 保存・取得の変換(codec。better-sqlite3 に依存しない純関数)の単体テスト。
 *
 * codec は exe の AnalysisStore と、後続 #169 の D1 実装(cloud)が共有する。2実装で変換が食い違うと、
 * 同じ分析が実装によって違う値で保存・復元される(NULL を false に潰す等。#31・#152 の原則)ため、
 * 変換の規則(NULL / 0 / 1 の3値、undefined → null、JSON 化、配分なしでは meta 行を出さない)をここで表にして固定する。
 *
 * 「SQL の列」と「束縛値の位置」の対応は、SQL 文の列リストを読んで列名→値の対応表を作って比べる
 * (位置の入れ替え・列の追加漏れを落とすため。値の並びだけを比べない)。
 */

/** INSERT 文の列名リスト(`(a, b, c) VALUES` の括弧の中)を取り出す。 */
function columnsOf(sql: string): string[] {
  const m = /\(([^)]*)\)\s*VALUES/s.exec(sql);
  if (m === null) {
    throw new Error(`列リストを読めない SQL: ${sql}`);
  }
  return m[1]!.split(",").map((c) => c.trim());
}

/** VALUES の `?` の個数。 */
function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

/** 列名 → 束縛値の対応表にする(列数と値の数が合わなければ落とす)。 */
function byColumn(sql: string, params: SqlParams): Record<string, unknown> {
  const columns = columnsOf(sql);
  expect(params, `${columns.join(",")} の列数と束縛値の数`).toHaveLength(columns.length);
  expect(placeholderCount(sql), "VALUES の ? の個数").toBe(columns.length);
  return Object.fromEntries(columns.map((c, i) => [c, params[i]]));
}

const BASE_HORSE: AnalysisHorseRecord = {
  umaban: 7,
  prior: 0.25,
  adjustedProb: 0.3,
  placeOddsMin: 1.8,
  ev: 1.2,
  isPositive: true,
  contributions: { a: 1 },
  mark: "◎",
  reason: "根拠",
  highlights: ["追い切り好時計", "内枠有利"],
  concerns: ["距離延長"],
};

const BASE_META: AnalysisAllocationMetaRecord = {
  route: "mixed",
  unavailableReason: "u",
  fallbackReason: "f",
  skipReasonCode: "s",
  comboOddsWide: "w",
  comboOddsTrio: "t",
  bankroll: 10000,
  perRaceCap: 3000,
  kellyFraction: 0.25,
  evThreshold: 1.05,
  includeComboOdds: true,
  includeWide: true,
  includeTrio: true,
  includeQuinella: true,
  includeExacta: true,
  includeTrifecta: true,
  includeBracketQuinella: true,
  betUnit: 100,
  greedySteps: 5,
  candidateCap: 50,
  modelId: "pl",
  modelApproximate: true,
  oddsStatus: "kakutei",
};

const BASE_RECORD: AnalysisRecord = {
  raceId: "202603020211",
  analyzedAt: "2026-10-06T09:00:00.000Z",
  horses: [BASE_HORSE],
};

describe("INSERT 文と束縛値の対応(列数・? の個数が一致する)", () => {
  it("analyses は11列、analysis_horses は12列、allocation_meta は24列、analysis_bets は6列", () => {
    expect(columnsOf(INSERT_ANALYSIS_SQL)).toHaveLength(11);
    expect(columnsOf(INSERT_ANALYSIS_HORSE_SQL)).toHaveLength(12);
    expect(columnsOf(INSERT_ALLOCATION_META_SQL)).toHaveLength(24);
    expect(columnsOf(INSERT_ALLOCATION_BET_SQL)).toHaveLength(6);
  });

  it("全項目を持つ入力の束縛値が、列名どおりの値になる(位置の入れ替えを落とす)", () => {
    const record: AnalysisRecord = {
      ...BASE_RECORD,
      evEstimated: true,
      promptVersion: "pv",
      additionalInstruction: "ai",
      kaisaiDate: "2026/10/06",
      model: "m",
      rawResponse: "raw",
      raceSnapshot: { x: 1 },
      historyCutoffDate: "2026/10/05",
      promptLookaheadGuarded: true,
    };
    expect(byColumn(INSERT_ANALYSIS_SQL, analysisParams(record))).toEqual({
      race_id: "202603020211",
      analyzed_at: "2026-10-06T09:00:00.000Z",
      ev_estimated: 1,
      prompt_version: "pv",
      additional_instruction: "ai",
      kaisai_date: "2026/10/06",
      model: "m",
      raw_response: "raw",
      race_snapshot_json: '{"x":1}',
      history_cutoff_date: "2026/10/05",
      prompt_lookahead_guarded: 1,
    });
    expect(byColumn(INSERT_ANALYSIS_HORSE_SQL, horseParams(42, BASE_HORSE))).toEqual({
      analysis_id: 42,
      umaban: 7,
      prior: 0.25,
      adjusted_prob: 0.3,
      place_odds_min: 1.8,
      ev: 1.2,
      is_positive: 1,
      contributions_json: '{"a":1}',
      mark: "◎",
      reason: "根拠",
      highlights_json: '["追い切り好時計","内枠有利"]',
      concerns_json: '["距離延長"]',
    });
    expect(byColumn(INSERT_ALLOCATION_META_SQL, allocationMetaParams(42, BASE_META))).toEqual({
      analysis_id: 42,
      route: "mixed",
      unavailable_reason: "u",
      fallback_reason: "f",
      skip_reason_code: "s",
      combo_odds_wide: "w",
      combo_odds_trio: "t",
      bankroll: 10000,
      per_race_cap: 3000,
      kelly_fraction: 0.25,
      ev_threshold: 1.05,
      include_combo_odds: 1,
      include_wide: 1,
      include_trio: 1,
      include_quinella: 1,
      include_exacta: 1,
      include_trifecta: 1,
      include_bracket_quinella: 1,
      bet_unit: 100,
      greedy_steps: 5,
      candidate_cap: 50,
      model_id: "pl",
      model_approximate: 1,
      odds_status: "kakutei",
    });
    const bet: AnalysisBetRecord = { betType: "wide", comboKey: "0102", stake: 100, odds: 12.3, ev: 1.4 };
    expect(byColumn(INSERT_ALLOCATION_BET_SQL, allocationBetParams(42, bet))).toEqual({
      analysis_id: 42,
      bet_type: "wide",
      combo_key: "0102",
      stake: 100,
      odds: 12.3,
      ev: 1.4,
    });
  });
});

describe("analysisParams: 省略(undefined)・null・値の写し(NULL / 0 / 1 の3値を潰さない)", () => {
  it.each([
    ["evEstimated 省略 → 0(確定EV扱い)", { evEstimated: undefined }, "ev_estimated", 0],
    ["evEstimated false → 0", { evEstimated: false }, "ev_estimated", 0],
    ["evEstimated true → 1", { evEstimated: true }, "ev_estimated", 1],
    ["promptLookaheadGuarded 省略 → NULL(記録なし)", { promptLookaheadGuarded: undefined }, "prompt_lookahead_guarded", null],
    ["promptLookaheadGuarded null → NULL", { promptLookaheadGuarded: null }, "prompt_lookahead_guarded", null],
    ["promptLookaheadGuarded false → 0(明示的に未遮断。NULL と区別する)", { promptLookaheadGuarded: false }, "prompt_lookahead_guarded", 0],
    ["promptLookaheadGuarded true → 1", { promptLookaheadGuarded: true }, "prompt_lookahead_guarded", 1],
    ["raceSnapshot 省略 → NULL", { raceSnapshot: undefined }, "race_snapshot_json", null],
    ["raceSnapshot null → NULL(文字列 'null' にしない)", { raceSnapshot: null }, "race_snapshot_json", null],
    ["raceSnapshot 0 → '0'(falsy でも JSON 化する)", { raceSnapshot: 0 }, "race_snapshot_json", "0"],
    ["raceSnapshot オブジェクト → JSON 文字列", { raceSnapshot: { a: [1, null] } }, "race_snapshot_json", '{"a":[1,null]}'],
  ] as const)("%s", (_name, override, column, expected) => {
    const named = byColumn(INSERT_ANALYSIS_SQL, analysisParams({ ...BASE_RECORD, ...override }));
    expect(named[column]).toStrictEqual(expected);
  });

  it.each([
    ["promptVersion", "prompt_version"],
    ["additionalInstruction", "additional_instruction"],
    ["kaisaiDate", "kaisai_date"],
    ["model", "model"],
    ["rawResponse", "raw_response"],
    ["historyCutoffDate", "history_cutoff_date"],
  ] as const)("%s: 省略・null は NULL、空文字は空文字のまま(NULL に潰さない)", (field, column) => {
    const at = (value: string | null | undefined): unknown =>
      byColumn(INSERT_ANALYSIS_SQL, analysisParams({ ...BASE_RECORD, [field]: value }))[column];
    expect(at(undefined)).toBeNull();
    expect(at(null)).toBeNull();
    expect(at("")).toBe("");
    expect(at("x")).toBe("x");
  });
});

describe("horseParams: 省略・null・falsy の写し", () => {
  it.each([
    ["contributions 省略 → NULL", { contributions: undefined }, "contributions_json", null],
    ["contributions null → NULL", { contributions: null }, "contributions_json", null],
    ["contributions {} → '{}'", { contributions: {} }, "contributions_json", "{}"],
    ["contributions 配列 → JSON 文字列", { contributions: [1, 2] }, "contributions_json", "[1,2]"],
    ["contributions 0 → '0'", { contributions: 0 }, "contributions_json", "0"],
    ["reason 省略 → NULL", { reason: undefined }, "reason", null],
    ["reason null → NULL", { reason: null }, "reason", null],
    ["reason 空文字 → 空文字", { reason: "" }, "reason", ""],
    // 強調材料・懸念事項(Issue #197): 空配列・省略・null は NULL(「項目なし」を NULL で表す)。
    ["highlights 省略 → NULL", { highlights: undefined }, "highlights_json", null],
    ["highlights 空配列 → NULL", { highlights: [] }, "highlights_json", null],
    ["highlights 1項目 → JSON 配列", { highlights: ["a"] }, "highlights_json", '["a"]'],
    ["highlights 引用符・改行・日本語 → JSON としてエスケープ", { highlights: ['"q"\nあ'] }, "highlights_json", '["\\"q\\"\\nあ"]'],
    ["concerns 省略 → NULL", { concerns: undefined }, "concerns_json", null],
    ["concerns 空配列 → NULL", { concerns: [] }, "concerns_json", null],
    ["concerns 3項目 → JSON 配列", { concerns: ["a", "b", "c"] }, "concerns_json", '["a","b","c"]'],
    ["isPositive false → 0", { isPositive: false }, "is_positive", 0],
    ["isPositive true → 1", { isPositive: true }, "is_positive", 1],
    ["mark null → NULL", { mark: null }, "mark", null],
    ["placeOddsMin null → NULL(0 にしない)", { placeOddsMin: null }, "place_odds_min", null],
    ["placeOddsMin 0 → 0(NULL にしない)", { placeOddsMin: 0 }, "place_odds_min", 0],
    ["ev null → NULL", { ev: null }, "ev", null],
    ["ev 0 → 0", { ev: 0 }, "ev", 0],
    ["prior 0 → 0", { prior: 0 }, "prior", 0],
  ] as const)("%s", (_name, override, column, expected) => {
    const named = byColumn(INSERT_ANALYSIS_HORSE_SQL, horseParams(1, { ...BASE_HORSE, ...override }));
    expect(named[column]).toStrictEqual(expected);
  });
});

describe("allocationMetaParams: 真偽値は 0/1、modelApproximate は NULL / 0 / 1 の3値", () => {
  const FLAGS = [
    ["includeComboOdds", "include_combo_odds"],
    ["includeWide", "include_wide"],
    ["includeTrio", "include_trio"],
    ["includeQuinella", "include_quinella"],
    ["includeExacta", "include_exacta"],
    ["includeTrifecta", "include_trifecta"],
    ["includeBracketQuinella", "include_bracket_quinella"],
  ] as const;

  it.each(FLAGS)("%s: true → 1、false → 0(7つのフラグを1つずつ独立に検査する)", (field, column) => {
    const asOne = byColumn(INSERT_ALLOCATION_META_SQL, allocationMetaParams(1, { ...BASE_META, [field]: true }));
    const asZero = byColumn(INSERT_ALLOCATION_META_SQL, allocationMetaParams(1, { ...BASE_META, [field]: false }));
    expect(asOne[column]).toBe(1);
    expect(asZero[column]).toBe(0);
    // 他のフラグは動かない(別の列へ写していない)。
    for (const [, other] of FLAGS) {
      if (other !== column) {
        expect(asZero[other]).toBe(1);
      }
    }
  });

  it.each([
    [null, null],
    [true, 1],
    [false, 0],
  ] as const)("modelApproximate %s → %s", (input, expected) => {
    const named = byColumn(
      INSERT_ALLOCATION_META_SQL,
      allocationMetaParams(1, { ...BASE_META, modelApproximate: input }),
    );
    expect(named["model_approximate"]).toStrictEqual(expected);
  });

  it("null を許す列(betUnit・greedySteps・candidateCap・modelId など)は null のまま渡す(0 や空文字にしない)", () => {
    const named = byColumn(
      INSERT_ALLOCATION_META_SQL,
      allocationMetaParams(1, {
        ...BASE_META,
        unavailableReason: null,
        fallbackReason: null,
        skipReasonCode: null,
        comboOddsWide: null,
        comboOddsTrio: null,
        betUnit: null,
        greedySteps: null,
        candidateCap: null,
        modelId: null,
      }),
    );
    for (const column of [
      "unavailable_reason",
      "fallback_reason",
      "skip_reason_code",
      "combo_odds_wide",
      "combo_odds_trio",
      "bet_unit",
      "greedy_steps",
      "candidate_cap",
      "model_id",
    ]) {
      expect(named[column], column).toBeNull();
    }
  });
});

describe("buildChildParams: 子の行(馬・配分meta・買い目)の組み立てと『配分なしでは meta 行を出さない』", () => {
  const meta = BASE_META;
  const bets: AnalysisBetRecord[] = [
    { betType: "place", comboKey: "01", stake: 300, odds: 1.5, ev: 1.1 },
    { betType: "wide", comboKey: "0102", stake: 100, odds: null, ev: null },
  ];
  const twoHorses: AnalysisHorseRecord[] = [BASE_HORSE, { ...BASE_HORSE, umaban: 8 }];

  it("配分なし(allocation 省略): meta は null、買い目は空。馬は入力の順に分析IDつきで返る", () => {
    const child = buildChildParams({ ...BASE_RECORD, horses: twoHorses }, 5);
    expect(child.allocationMeta).toBeNull();
    expect(child.allocationBets).toEqual([]);
    expect(child.horses).toHaveLength(2);
    expect(child.horses.map((p) => [p[0], p[1]])).toEqual([
      [5, 7],
      [5, 8],
    ]);
  });

  it("配分あり・買い目なし: meta 行は必ず出る(全経路で1行書く契約)。買い目は空", () => {
    const child = buildChildParams({ ...BASE_RECORD, allocation: { meta, bets: [] } }, 5);
    expect(child.allocationMeta).not.toBeNull();
    expect(child.allocationMeta![0]).toBe(5);
    expect(child.allocationBets).toEqual([]);
  });

  it("配分あり・買い目2件: meta 1行 + 買い目2行が、入力の順に分析IDつきで返る", () => {
    const child = buildChildParams({ ...BASE_RECORD, allocation: { meta, bets } }, 9);
    expect(child.allocationMeta![0]).toBe(9);
    expect(child.allocationBets).toHaveLength(2);
    expect(child.allocationBets.map((p) => [p[0], p[1], p[2]])).toEqual([
      [9, "place", "01"],
      [9, "wide", "0102"],
    ]);
  });

  it("馬が0頭の入力でも例外にならず、馬の行は0件", () => {
    const child = buildChildParams({ ...BASE_RECORD, horses: [] }, 1);
    expect(child.horses).toEqual([]);
  });
});

describe("toStoredHorse / toStoredAnalysis / toStoredRaceSnapshot: NULL・0/1 の復元", () => {
  const horseRow = (override: Partial<HorseRow>): HorseRow => ({
    umaban: 1,
    prior: 0.2,
    adjusted_prob: 0.3,
    place_odds_min: 1.5,
    ev: 1.1,
    is_positive: 1,
    contributions_json: null,
    mark: null,
    reason: null,
    highlights_json: null,
    concerns_json: null,
    ...override,
  });

  it.each([
    [0, false],
    [1, true],
  ])("is_positive %s → %s", (raw, expected) => {
    expect(toStoredHorse(horseRow({ is_positive: raw })).isPositive).toBe(expected);
  });

  it("contributions_json は NULL → null、JSON 文字列 → 復元。列名はキャメルケースへ(adjusted_prob → adjustedProb ほか)", () => {
    expect(toStoredHorse(horseRow({ contributions_json: null })).contributions).toBeNull();
    const horse = toStoredHorse(horseRow({ contributions_json: '{"a":[1,2]}', mark: "◎", reason: "r" }));
    expect(horse).toStrictEqual({
      umaban: 1,
      prior: 0.2,
      adjustedProb: 0.3,
      placeOddsMin: 1.5,
      ev: 1.1,
      isPositive: true,
      contributions: { a: [1, 2] },
      mark: "◎",
      reason: "r",
      highlights: [],
      concerns: [],
    });
  });

  // 強調材料・懸念事項の復元(Issue #197): NULL・壊れた値・配列でない値は `[]`(例外にしない)。文字列でない要素は捨てる。
  it.each([
    ["NULL", null, []],
    ["空文字", "", []],
    ["壊れた JSON", "[壊れ", []],
    ["オブジェクト(配列でない)", '{"a":1}', []],
    ["文字列(配列でない)", '"x"', []],
    ["数値", "3", []],
    ["空配列", "[]", []],
    ["文字列の配列", '["a","b"]', ["a", "b"]],
    ["文字列でない要素は捨てる", '["a",1,null,"b",{"x":1}]', ["a", "b"]],
  ])("highlights_json / concerns_json が %s のとき", (_label, raw, expected) => {
    const horse = toStoredHorse(horseRow({ highlights_json: raw, concerns_json: raw }));
    expect(horse.highlights).toStrictEqual(expected);
    expect(horse.concerns).toStrictEqual(expected);
  });

  it("highlights_json と concerns_json は混ざらない(それぞれ自分の列を読む)", () => {
    const horse = toStoredHorse(horseRow({ highlights_json: '["強"]', concerns_json: '["弱"]' }));
    expect(horse.highlights).toStrictEqual(["強"]);
    expect(horse.concerns).toStrictEqual(["弱"]);
  });

  it.each([
    [null, null],
    ["{壊れたJSON", null],
    ["", null],
    ['{"a":1}', { a: 1 }],
    ["0", 0],
  ])("raceSnapshotJson %j → %j(NULL・破損は null。例外にしない)", (raw, expected) => {
    expect(toStoredRaceSnapshot(raw)).toStrictEqual(expected);
  });

  const analysisRow = (override: Partial<AnalysisRow>): AnalysisRow => ({
    id: 3,
    raceId: "202603020211",
    analyzedAt: "2026-10-06T09:00:00.000Z",
    evEstimated: 0,
    promptVersion: "pv",
    additionalInstruction: "ai",
    kaisaiDate: "2026/10/06",
    model: "m",
    rawResponse: "raw",
    raceSnapshotJson: null,
    historyCutoffDate: "2026/10/05",
    promptLookaheadGuarded: 0,
    ...override,
  });

  it.each([
    [null, false],
    [0, false],
    [1, true],
  ])("evEstimated %s → %s(旧レコードの NULL は確定EV扱い=false)", (raw, expected) => {
    expect(toStoredAnalysis(analysisRow({ evEstimated: raw }), []).evEstimated).toBe(expected);
  });

  it.each([
    [null, null],
    [0, false],
    [1, true],
  ])("promptLookaheadGuarded %s → %s(NULL を false に潰さない)", (raw, expected) => {
    expect(toStoredAnalysis(analysisRow({ promptLookaheadGuarded: raw }), []).promptLookaheadGuarded).toBe(
      expected,
    );
  });

  it("NULL を許す文字列の列は null のまま、そうでない列と馬は入力どおり(順序を保つ)", () => {
    const stored = toStoredAnalysis(
      analysisRow({
        promptVersion: null,
        additionalInstruction: null,
        kaisaiDate: null,
        model: null,
        rawResponse: null,
        historyCutoffDate: null,
        raceSnapshotJson: '{"s":1}',
      }),
      [horseRow({ umaban: 2 }), horseRow({ umaban: 9 })],
    );
    expect(stored.id).toBe(3);
    expect(stored.raceId).toBe("202603020211");
    expect(stored.analyzedAt).toBe("2026-10-06T09:00:00.000Z");
    expect(stored.promptVersion).toBeNull();
    expect(stored.additionalInstruction).toBeNull();
    expect(stored.kaisaiDate).toBeNull();
    expect(stored.model).toBeNull();
    expect(stored.rawResponse).toBeNull();
    expect(stored.historyCutoffDate).toBeNull();
    expect(stored.raceSnapshot).toEqual({ s: 1 });
    expect(stored.horses.map((h) => h.umaban)).toEqual([2, 9]);
  });
});

describe("toStoredAllocation: 0/1 を真偽値へ、NULL を許す列は null のまま(NULL を false に潰さない)", () => {
  const metaRow = (override: Partial<AllocationMetaRow>): AllocationMetaRow => ({
    route: "mixed",
    unavailableReason: null,
    fallbackReason: null,
    skipReasonCode: null,
    bankroll: 10000,
    perRaceCap: 3000,
    kellyFraction: 0.25,
    evThreshold: 1,
    includeComboOdds: 1,
    includeWide: 0,
    includeTrio: 1,
    includeQuinella: 1,
    includeExacta: 0,
    includeTrifecta: 1,
    includeBracketQuinella: 0,
    betUnit: 100,
    oddsStatus: "kakutei",
    ...override,
  });

  it.each([
    ["includeComboOdds"],
    ["includeWide"],
    ["includeTrio"],
  ] as const)("%s(NOT NULL の列): 0 → false、1 → true", (field) => {
    expect(toStoredAllocation(metaRow({ [field]: 0 }), [])[field]).toBe(false);
    expect(toStoredAllocation(metaRow({ [field]: 1 }), [])[field]).toBe(true);
  });

  it.each([
    ["includeQuinella"],
    ["includeExacta"],
    ["includeTrifecta"],
    ["includeBracketQuinella"],
  ] as const)("%s(後付け列): NULL → null(記録なし)、0 → false、1 → true の3値", (field) => {
    expect(toStoredAllocation(metaRow({ [field]: null }), [])[field]).toBeNull();
    expect(toStoredAllocation(metaRow({ [field]: 0 }), [])[field]).toBe(false);
    expect(toStoredAllocation(metaRow({ [field]: 1 }), [])[field]).toBe(true);
  });

  it("買い目は入力の配列をそのまま持ち、メタの値は列名どおりに写る", () => {
    const bets = [{ betType: "place", comboKey: "01", stake: 300, odds: 1.5, ev: 1.1 }];
    const stored = toStoredAllocation(metaRow({ betUnit: null, unavailableReason: "u" }), bets);
    expect(stored.bets).toStrictEqual(bets);
    expect(stored.betUnit).toBeNull();
    expect(stored.unavailableReason).toBe("u");
    expect(stored.route).toBe("mixed");
    expect(stored.oddsStatus).toBe("kakutei");
    expect(stored.bankroll).toBe(10000);
    expect(stored.perRaceCap).toBe(3000);
    expect(stored.kellyFraction).toBe(0.25);
    expect(stored.evThreshold).toBe(1);
  });
});
