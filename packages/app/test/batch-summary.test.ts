/**
 * 一括分析の横断サマリ(純関数)のテスト。
 *
 * - collectEvPlusSummary: 成功レースのEVプラス馬だけを1つに集約し、EV降順で並べる。
 * - summarizeBatch: 成功/失敗/スキップの件数とEVプラス総数を数える(部分失敗の集計)。
 */

import { describe, expect, it } from "vitest";

import {
  collectEvPlusSummary,
  rankRaceOpportunities,
  raceOpportunityRemark,
  summarizeBatch,
  type RaceOpportunityRankRow,
} from "../src/renderer/batch-summary.js";
import type {
  AnalysisResult,
  AnalysisRow,
  BatchRaceOutcome,
} from "../src/shared/analysis-types.js";

/** 最小の結果行を作る(既定はEVプラスでない)。 */
const row = (over: Partial<AnalysisRow>): AnalysisRow => ({
  umaban: 1,
  wakuban: 1,
  horseName: "馬",
  prior: 0.3,
  adjustedProb: 0.3,
  placeOddsMin: 2.0,
  ev: 0.6,
  isPositive: false,
  reason: null,
  careerRunCount: 10,
  mark: null,
  evEstimated: false,
  ...over,
});

/** レース結果を作る。 */
const result = (
  raceId: string,
  raceName: string,
  rows: readonly AnalysisRow[],
): AnalysisResult => ({
  raceId,
  venueName: "東京",
  raceName,
  courseType: "芝",
  distance: 1600,
  date: "2026/07/12",
  dateApproximate: false,
  llmUsed: true,
  llmSkippedReason: null,
  fallback: false,
  oddsStatus: "result",
  rows,
  warnings: [],
  analyzedAt: "2026-07-12T00:00:00.000Z",
});

/** 成功アウトカムを作る。 */
const success = (
  raceId: string,
  raceName: string,
  rows: readonly AnalysisRow[],
): BatchRaceOutcome => ({
  raceId,
  raceName,
  status: "success",
  result: result(raceId, raceName, rows),
  error: null,
});

const failure = (raceId: string, message: string): BatchRaceOutcome => ({
  raceId,
  raceName: null,
  status: "failure",
  result: null,
  error: message,
});

const skipped = (raceId: string): BatchRaceOutcome => ({
  raceId,
  raceName: null,
  status: "skipped",
  result: null,
  error: null,
});

describe("collectEvPlusSummary(横断EVプラス馬の集約)", () => {
  it("成功レースのEVプラス馬だけを集め、EV降順に並べる", () => {
    const outcomes: BatchRaceOutcome[] = [
      success("111111111111", "1R", [
        row({ umaban: 1, horseName: "アルファ", ev: 1.2, isPositive: true }),
        row({ umaban: 2, horseName: "ベータ", ev: 0.9, isPositive: false }),
      ]),
      success("222222222222", "2R", [
        row({
          umaban: 3,
          horseName: "ガンマ",
          ev: 1.5,
          isPositive: true,
          placeOddsMin: 3.1,
          adjustedProb: 0.48,
        }),
      ]),
    ];

    const rows = collectEvPlusSummary(outcomes);
    expect(rows.map((r) => r.horseName)).toEqual(["ガンマ", "アルファ"]);
    expect(rows[0]).toMatchObject({
      raceId: "222222222222",
      raceName: "2R",
      umaban: 3,
      horseName: "ガンマ",
      adjustedProb: 0.48,
      placeOddsMin: 3.1,
      ev: 1.5,
    });
  });

  it("EVプラスが1頭も無ければ空配列を返す", () => {
    const outcomes = [
      success("111111111111", "1R", [row({ ev: 0.5, isPositive: false })]),
    ];
    expect(collectEvPlusSummary(outcomes)).toEqual([]);
  });

  it("各馬の予想印(mark)をサマリへ伝播すること(Task#23)", () => {
    const outcomes: BatchRaceOutcome[] = [
      success("111111111111", "1R", [
        row({ umaban: 1, horseName: "アルファ", ev: 1.2, isPositive: true, mark: "◎" }),
        row({ umaban: 2, horseName: "ベータ", ev: 1.1, isPositive: true, mark: null }),
      ]),
    ];
    const rows = collectEvPlusSummary(outcomes);
    expect(rows.find((r) => r.horseName === "アルファ")!.mark).toBe("◎");
    expect(rows.find((r) => r.horseName === "ベータ")!.mark).toBeNull();
  });

  it("失敗・スキップのレースは集約対象に含めない", () => {
    const outcomes: BatchRaceOutcome[] = [
      failure("111111111111", "取得失敗"),
      skipped("222222222222"),
      success("333333333333", "3R", [
        row({ umaban: 5, horseName: "デルタ", ev: 1.1, isPositive: true }),
      ]),
    ];
    const rows = collectEvPlusSummary(outcomes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.horseName).toBe("デルタ");
  });

  it("EVが同値のときはレースID昇順→馬番昇順で安定に並べる", () => {
    const outcomes: BatchRaceOutcome[] = [
      success("222222222222", "2R", [
        row({ umaban: 4, horseName: "後", ev: 1.0, isPositive: true }),
      ]),
      success("111111111111", "1R", [
        row({ umaban: 7, horseName: "前B", ev: 1.0, isPositive: true }),
        row({ umaban: 2, horseName: "前A", ev: 1.0, isPositive: true }),
      ]),
    ];
    const rows = collectEvPlusSummary(outcomes);
    expect(rows.map((r) => r.horseName)).toEqual(["前A", "前B", "後"]);
  });

  it("isPositive でも EV が null の馬は集約しない(安全側)", () => {
    const outcomes = [
      success("111111111111", "1R", [
        row({ umaban: 1, ev: null, isPositive: true }),
      ]),
    ];
    expect(collectEvPlusSummary(outcomes)).toEqual([]);
  });
});

describe("summarizeBatch(部分失敗の集計)", () => {
  it("成功・失敗・スキップの件数とEVプラス総数を数える", () => {
    const outcomes: BatchRaceOutcome[] = [
      success("111111111111", "1R", [
        row({ umaban: 1, ev: 1.2, isPositive: true }),
        row({ umaban: 2, ev: 1.1, isPositive: true }),
      ]),
      failure("222222222222", "エラー"),
      skipped("333333333333"),
      success("444444444444", "4R", [row({ ev: 0.5, isPositive: false })]),
    ];
    expect(summarizeBatch(outcomes)).toEqual({
      total: 4,
      success: 2,
      failure: 1,
      skipped: 1,
      evPlusCount: 2,
    });
  });

  it("空配列ではすべて0を返す", () => {
    expect(summarizeBatch([])).toEqual({
      total: 0,
      success: 0,
      failure: 0,
      skipped: 0,
      evPlusCount: 0,
    });
  });
});

describe("rankRaceOpportunities(妙味レースランキング)", () => {
  /** EVプラス1頭を持つ成功レースを作る。 */
  const opp = (
    raceId: string,
    raceName: string,
    ev: number,
    prob: number,
    careerRunCount = 10,
  ): BatchRaceOutcome =>
    success(raceId, raceName, [
      row({ umaban: 1, ev, adjustedProb: prob, isPositive: true, careerRunCount }),
    ]);

  it("スコアが算出できたレースを降順に並べ、算出できないレースを末尾に置く", () => {
    const outcomes: BatchRaceOutcome[] = [
      // B: raw=(1.5−1)×0.6=0.30
      opp("202601010102", "B特別", 1.5, 0.6),
      // A: raw=(2.0−1)×0.5=0.50
      opp("202601010101", "A特別", 2.0, 0.5),
      // C: EVプラス0頭 → スコアnull
      success("202601010103", "C特別", [
        row({ umaban: 1, ev: 0.8, isPositive: false }),
      ]),
    ];
    const ranked = rankRaceOpportunities(outcomes);
    expect(ranked.map((r) => r.raceName)).toEqual(["A特別", "B特別", "C特別"]);
    expect(ranked[0]!.opportunity.score).toBeCloseTo(0.5, 10);
    expect(ranked[0]!.opportunity.bestPick?.umaban).toBe(1);
    expect(ranked[1]!.opportunity.score).toBeCloseTo(0.3, 10);
    // 末尾のスコアnullレースは理由付き。
    expect(ranked[2]!.opportunity.score).toBeNull();
    expect(ranked[2]!.opportunity.excludedReason).toContain("EVプラス");
  });

  it("失敗・スキップのレースはランキングに含めない", () => {
    const outcomes: BatchRaceOutcome[] = [
      opp("202601010101", "A特別", 2.0, 0.5),
      failure("202601010102", "取得失敗"),
      skipped("202601010103"),
    ];
    const ranked = rankRaceOpportunities(outcomes);
    expect(ranked.map((r) => r.raceName)).toEqual(["A特別"]);
  });

  it("同スコアのレースは raceId 昇順で決定的に並ぶ", () => {
    const outcomes: BatchRaceOutcome[] = [
      opp("202601010109", "遅ID", 2.0, 0.5),
      opp("202601010101", "早ID", 2.0, 0.5),
    ];
    const ranked = rankRaceOpportunities(outcomes);
    expect(ranked.map((r) => r.raceId)).toEqual([
      "202601010101",
      "202601010109",
    ]);
  });

  it("発売前(yoso・推定EV)のレースもスコアが算出でき、evEstimated=trueで返ること(Task#25)", () => {
    const outcomes: BatchRaceOutcome[] = [
      success("202601010101", "推定EVレース", [
        row({
          umaban: 1,
          ev: 2.0,
          adjustedProb: 0.5,
          isPositive: true,
          evEstimated: true,
        }),
      ]),
    ];
    const result = outcomes[0]!.result!;
    const yosoOutcome: BatchRaceOutcome = {
      ...outcomes[0]!,
      result: { ...result, oddsStatus: "yoso" },
    };
    const ranked = rankRaceOpportunities([yosoOutcome]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.opportunity.score).toBeCloseTo((2.0 - 1) * 0.5, 10);
    expect(ranked[0]!.evEstimated).toBe(true);
  });

  it("確定EV(result/middle)のレースはevEstimated=falseで返ること(回帰確認)", () => {
    const outcomes: BatchRaceOutcome[] = [opp("202601010101", "確定EVレース", 2.0, 0.5)];
    const ranked = rankRaceOpportunities(outcomes);
    expect(ranked[0]!.evEstimated).toBe(false);
  });
});

describe("raceOpportunityRemark(妙味レースランキングの備考文言・Task#25)", () => {
  /** テスト用のランキング行を最小構成で組み立てる。 */
  const rankRow = (
    over: Partial<Omit<RaceOpportunityRankRow, "opportunity">> & {
      opportunity?: Partial<RaceOpportunityRankRow["opportunity"]>;
    },
  ): RaceOpportunityRankRow => ({
    raceId: "111111111111",
    raceName: "1R",
    evEstimated: false,
    ...over,
    opportunity: {
      score: null,
      bestPick: null,
      evPlusCount: 0,
      lowDataRatio: 0,
      excludedReason: null,
      ...over.opportunity,
    },
  });

  it("発売前推定(evEstimated=true)のときは「発売前推定」を含めること", () => {
    const row = rankRow({ evEstimated: true });
    expect(raceOpportunityRemark(row)).toContain("発売前推定");
  });

  it("確定EV(evEstimated=false)・除外なし・低データなしのときは空文字であること", () => {
    const row = rankRow({ evEstimated: false });
    expect(raceOpportunityRemark(row)).toBe("");
  });

  it("除外理由(excludedReason)があるときはそれを含めること", () => {
    const row = rankRow({
      opportunity: { excludedReason: "EVプラスの馬がいないため妙味なし" },
    });
    expect(raceOpportunityRemark(row)).toContain("EVプラスの馬がいないため妙味なし");
  });

  it("低データ割合が0.5以上のときは低データ注記を含めること", () => {
    const row = rankRow({ opportunity: { lowDataRatio: 0.6 } });
    expect(raceOpportunityRemark(row)).toContain("低データ馬60%");
  });

  it("発売前推定と低データ注記は両方含め、区切り文字で結合すること", () => {
    const row = rankRow({ evEstimated: true, opportunity: { lowDataRatio: 0.6 } });
    const remark = raceOpportunityRemark(row);
    expect(remark).toContain("発売前推定");
    expect(remark).toContain("低データ馬60%");
  });

  it("除外理由がある場合は低データ注記より除外理由を優先すること(既存挙動の維持)", () => {
    const row = rankRow({
      opportunity: {
        excludedReason: "EVプラスの馬がいないため妙味なし",
        lowDataRatio: 0.9,
      },
    });
    const remark = raceOpportunityRemark(row);
    expect(remark).toContain("EVプラスの馬がいないため妙味なし");
    expect(remark).not.toContain("低データ馬");
  });
});
