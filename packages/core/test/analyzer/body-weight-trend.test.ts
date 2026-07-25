/**
 * 馬体重トレンド要約(タスク#6・未使用パラメータ活用①)の純関数テスト。
 *
 * bodyWeight.diff(増減)はscorerが既に使用済みのため、本関数は絶対値weightの推移を
 * LLMプロンプト用の中立な材料として要約する(scorer/prior.ts・base-score.ts等の
 * 既存バイアス計算には一切影響しない)。境界(CLAUDE.md「2走未満は傾向断定なし」準拠)を
 * テーブル駆動で網羅する。
 */

import { describe, expect, it } from "vitest";
import { summarizeBodyWeightTrend } from "../../src/analyzer/body-weight-trend.js";
import type { BodyWeight } from "../../src/scraper/types.js";

/** テスト用の BodyWeight を簡潔に作る(diffは本関数では使わないため0固定でよい)。 */
function bw(weight: number): BodyWeight {
  return { weight, diff: 0 };
}

describe("summarizeBodyWeightTrend(馬体重トレンド要約・純関数)", () => {
  describe("境界: 有効過去走0件", () => {
    it("過去走0件・当日もnullのとき、null(材料なし)を返すこと", () => {
      expect(summarizeBodyWeightTrend([], null)).toBeNull();
    });

    it("過去走が全てnull・当日もnullのとき、null(材料なし)を返すこと", () => {
      expect(summarizeBodyWeightTrend([null, null, null], null)).toBeNull();
    });

    it("過去走0件だが当日実測はあるとき、当日情報のみを持つオブジェクトを返すこと(過去トレンドは独立)", () => {
      const result = summarizeBodyWeightTrend([], { weight: 480, diff: 2 });
      expect(result).toEqual({
        過去実測: [],
        傾向: null,
        当日: { 体重: 480, 前走比: 2 },
        note: "当日480kg・前走比+2kg",
      });
    });
  });

  describe("境界: 有効過去走1件(傾向ラベルなし・実値のみ)", () => {
    it("過去走1件・当日nullのとき、傾向はnullで実値のみのオブジェクトを返すこと", () => {
      const result = summarizeBodyWeightTrend([bw(450)], null);
      expect(result).toEqual({
        過去実測: [450],
        傾向: null,
        当日: null,
        note: "450kg",
      });
    });

    it("過去走1件+null混在・当日実測ありのとき、傾向なしのまま当日情報を併記すること", () => {
      const result = summarizeBodyWeightTrend([bw(450), null], { weight: 452, diff: 2 });
      expect(result).toEqual({
        過去実測: [450],
        傾向: null,
        当日: { 体重: 452, 前走比: 2 },
        note: "450kg、当日452kg・前走比+2kg",
      });
    });
  });

  describe("境界: 有効過去走2件以上(傾向ラベル算出)", () => {
    it("2件・一貫して増加(新しい順[452,448])のとき、増加傾向を返すこと", () => {
      const result = summarizeBodyWeightTrend([bw(452), bw(448)], null);
      expect(result).toEqual({
        過去実測: [452, 448],
        傾向: "増加傾向",
        当日: null,
        note: "448→452kg(増加傾向)",
      });
    });

    it("2件・一貫して減少(新しい順[448,452])のとき、減少傾向を返すこと", () => {
      const result = summarizeBodyWeightTrend([bw(448), bw(452)], null);
      expect(result?.傾向).toBe("減少傾向");
      expect(result?.note).toBe("452→448kg(減少傾向)");
    });

    it("2件・差が安定バンド(±2kg)以内のとき、おおむね安定を返すこと", () => {
      const result = summarizeBodyWeightTrend([bw(451), bw(450)], null);
      expect(result?.傾向).toBe("おおむね安定");
      expect(result?.note).toBe("450→451kg(おおむね安定)");
    });

    it("2件・差がちょうど+2kg(境界値、安定バンド境界)のとき、おおむね安定を返すこと", () => {
      const result = summarizeBodyWeightTrend([bw(452), bw(450)], null);
      expect(result?.傾向).toBe("おおむね安定");
    });

    it("2件・差がちょうど+3kg(境界値、安定バンド超え)のとき、増加傾向を返すこと", () => {
      const result = summarizeBodyWeightTrend([bw(453), bw(450)], null);
      expect(result?.傾向).toBe("増加傾向");
    });

    // 安定バンドの符号判定は対称(±STABLE_BAND_KG)であるべきなので、正側(+2kg/+3kg)と
    // 対をなす負側の境界も同じ考え方でテーブル駆動に検証する(code-reviewer提案1)。
    it.each([
      [-2, "おおむね安定"],
      [-3, "減少傾向"],
    ] as const)(
      "2件・差がちょうど%dkg(境界値)のとき、%sを返すこと",
      (delta, expectedTrend) => {
        const result = summarizeBodyWeightTrend([bw(450 + delta), bw(450)], null);
        expect(result?.傾向).toBe(expectedTrend);
      },
    );

    it("3件・一貫して増加のとき、増加傾向を返すこと", () => {
      const result = summarizeBodyWeightTrend([bw(456), bw(452), bw(448)], null);
      expect(result).toEqual({
        過去実測: [456, 452, 448],
        傾向: "増加傾向",
        当日: null,
        note: "448→452→456kg(増加傾向)",
      });
    });

    it("3件・一貫して減少のとき、減少傾向を返すこと", () => {
      const result = summarizeBodyWeightTrend([bw(444), bw(448), bw(452)], null);
      expect(result?.傾向).toBe("減少傾向");
      expect(result?.note).toBe("452→448→444kg(減少傾向)");
    });

    it("3件・増減が入り混じる(増加→減少)のとき、変動大を返すこと", () => {
      const result = summarizeBodyWeightTrend([bw(448), bw(456), bw(448)], null);
      expect(result?.傾向).toBe("変動大");
      expect(result?.note).toBe("448→456→448kg(変動大)");
    });

    it("3件・全て安定バンド以内のとき、おおむね安定を返すこと", () => {
      const result = summarizeBodyWeightTrend([bw(451), bw(450), bw(449)], null);
      expect(result?.傾向).toBe("おおむね安定");
    });

    it("3件・一方は安定バンド内、他方は増加(符号混在なし)のとき、増加傾向を返すこと(平坦+増加は増加扱い)", () => {
      const result = summarizeBodyWeightTrend([bw(456), bw(455), bw(450)], null);
      // 450→455(+5, 増加) → 455→456(+1, 安定バンド内) : 符号混在なしなので増加傾向。
      expect(result?.傾向).toBe("増加傾向");
    });

    it("3件+当日実測ありのとき、傾向・実値・当日情報をすべて含むこと", () => {
      const result = summarizeBodyWeightTrend(
        [bw(456), bw(452), bw(448)],
        { weight: 458, diff: 2 },
      );
      expect(result).toEqual({
        過去実測: [456, 452, 448],
        傾向: "増加傾向",
        当日: { 体重: 458, 前走比: 2 },
        note: "448→452→456kg(増加傾向)、当日458kg・前走比+2kg",
      });
    });
  });

  describe("境界: null走のスキップと遡り(既存の脚質判定recentRuns既定3と揃える)", () => {
    it("先頭がnullでもスキップして遡り、有効な直近3走を収集すること", () => {
      const result = summarizeBodyWeightTrend(
        [null, bw(456), bw(452), bw(448), bw(440)],
        null,
      );
      // 先頭null分は消費されず、有効値を新しい順に最大3件(456,452,448)集める。
      expect(result?.過去実測).toEqual([456, 452, 448]);
    });

    it("有効走が4件超あっても直近3走までしか使わないこと(既定recentRuns=3)", () => {
      const result = summarizeBodyWeightTrend(
        [bw(456), bw(452), bw(448), bw(440), bw(430)],
        null,
      );
      expect(result?.過去実測).toEqual([456, 452, 448]);
    });

    it("recentRunsをoptionsで2に指定したとき、直近2走までしか使わないこと", () => {
      const result = summarizeBodyWeightTrend(
        [bw(456), bw(452), bw(448)],
        null,
        { recentRuns: 2 },
      );
      expect(result?.過去実測).toEqual([456, 452]);
      expect(result?.傾向).toBe("増加傾向");
    });
  });

  describe("境界: 異常値(NaN・Infinity)のガード除外", () => {
    it("過去走のweightがNaNのとき、その走は無効(スキップ)として扱うこと", () => {
      const result = summarizeBodyWeightTrend(
        [{ weight: NaN, diff: 0 }, bw(450)],
        null,
      );
      expect(result?.過去実測).toEqual([450]);
      expect(result?.傾向).toBeNull();
    });

    it("過去走のweightがInfinityのとき、その走は無効(スキップ)として扱うこと", () => {
      const result = summarizeBodyWeightTrend(
        [{ weight: Infinity, diff: 0 }, bw(450), bw(448)],
        null,
      );
      expect(result?.過去実測).toEqual([450, 448]);
    });

    it("当日weightがNaNのとき、当日情報は材料なし(null)として扱うこと", () => {
      const result = summarizeBodyWeightTrend([bw(450)], { weight: NaN, diff: 0 });
      expect(result?.当日).toBeNull();
      expect(result?.note).toBe("450kg");
    });

    it("当日diffがInfinityのとき、当日情報は材料なし(null)として扱うこと", () => {
      const result = summarizeBodyWeightTrend([bw(450)], { weight: 452, diff: Infinity });
      expect(result?.当日).toBeNull();
    });
  });

  describe("前走比の符号表記(当日diffをそのまま使用、再計算しない)", () => {
    it("diffが負のとき、そのまま符号付きで表記すること", () => {
      const result = summarizeBodyWeightTrend([], { weight: 476, diff: -4 });
      expect(result?.note).toBe("当日476kg・前走比-4kg");
    });

    it("diffが0のとき、±0kgと表記すること", () => {
      const result = summarizeBodyWeightTrend([], { weight: 480, diff: 0 });
      expect(result?.note).toBe("当日480kg・前走比±0kg");
    });
  });

  describe("禁止語彙: 評価語・評価指示を出力に含めないこと", () => {
    it("noteに評価語(太め/絞れた/良化/悪化等)や評価指示の文言を含めないこと", () => {
      const result = summarizeBodyWeightTrend([bw(456), bw(452), bw(448)], {
        weight: 458,
        diff: 2,
      });
      const forbidden = ["太め", "絞れた", "良化", "悪化", "べき", "推奨", "有利", "不利"];
      for (const word of forbidden) {
        expect(result?.note).not.toContain(word);
      }
    });
  });

  describe("決定論: 同一入力なら同一出力を返すこと", () => {
    it("同じ引数で2回呼んでも同じ結果になること", () => {
      const args: [readonly (BodyWeight | null)[], BodyWeight | null] = [
        [bw(456), bw(452), bw(448)],
        { weight: 458, diff: 2 },
      ];
      expect(summarizeBodyWeightTrend(...args)).toEqual(summarizeBodyWeightTrend(...args));
    });
  });
});
