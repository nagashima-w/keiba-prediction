/**
 * 過去走の人気・オッズ乖離要約(タスク#7・未使用パラメータ活用②)の純関数テスト。
 *
 * HorseRaceResult.ninki(人気)/finishPosition(着順)/entryCount(頭数)はパース済みだが
 * scorer/prompt では未活用だった。市場評価(人気)と結果(着順)の乖離を、各有効走ごとに
 * 頭数で正規化して比較する中立な事実材料として要約する(評価語は一切出さない)。
 * 境界(CLAUDE.md「2走未満は傾向断定なし」準拠)をテーブル駆動で網羅する。
 */

import { describe, expect, it } from "vitest";
import { summarizeMarketGap } from "../../src/analyzer/market-gap.js";
import type { FinishPosition } from "../../src/scraper/types.js";

/** 順位のFinishPositionを作る(降着フラグを任意指定できる)。 */
function pos(value: number, demoted = false): FinishPosition {
  return demoted ? { kind: "順位", value, demoted: true } : { kind: "順位", value };
}

/** 非数値(中止・除外・取消)のFinishPositionを作る。 */
function nonNumeric(text = "中止"): FinishPosition {
  return { kind: "非数値", text };
}

describe("summarizeMarketGap(人気・着順の乖離要約・純関数)", () => {
  describe("境界: 有効過去走0件", () => {
    it("過去走が空配列のとき、null(材料なし)を返すこと", () => {
      expect(summarizeMarketGap([])).toBeNull();
    });

    it("過去走が全てnullのとき、null(材料なし)を返すこと", () => {
      expect(summarizeMarketGap([null, null, null])).toBeNull();
    });

    it("有効走が0件(全走が欠損・非数値等でスキップ)のとき、nullを返すこと", () => {
      const result = summarizeMarketGap([
        { ninki: null, finishPosition: pos(3), entryCount: 12 },
        { ninki: 3, finishPosition: nonNumeric(), entryCount: 12 },
        { ninki: 3, finishPosition: pos(3), entryCount: null },
      ]);
      expect(result).toBeNull();
    });
  });

  describe("境界: 有効過去走1件(傾向ラベルなし・事実のみ)", () => {
    it("1件のとき、傾向はnullで当該走の判定のみを持つオブジェクトを返すこと", () => {
      // entryCount=11 → 相対順位は0.1刻み。人気5番・着順3着 → 相対人気0.4, 相対着順0.2, 差0.2(>0.15)。
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(3), entryCount: 11 },
      ]);
      expect(result).toEqual({
        過去走: [{ 人気: 5, 着順: 3, 頭数: 11, 判定: "人気を上回る着順" }],
        傾向: null,
        note: "直近1走: 11頭中5番人気で3着(人気を上回る着順)",
      });
    });
  });

  describe("境界: 有効過去走2件以上(傾向ラベル算出)", () => {
    it("2件とも人気を上回る着順のとき、傾向「人気を上回る着順が多い」を返すこと", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(3), entryCount: 11 }, // 差0.2 → 上回る
        { ninki: 8, finishPosition: pos(2), entryCount: 11 }, // 相対人気0.7,相対着順0.1,差0.6 → 上回る
      ]);
      expect(result?.傾向).toBe("人気を上回る着順が多い");
      expect(result?.note).toBe(
        "近2走で人気を上回る着順2回・下回る着順0回・相応0回(人気を上回る着順が多い)",
      );
    });

    it("2件とも人気を下回る着順のとき、傾向「人気を下回る着順が多い」を返すこと", () => {
      const result = summarizeMarketGap([
        { ninki: 3, finishPosition: pos(5), entryCount: 11 }, // 相対人気0.2,相対着順0.4,差-0.2 → 下回る
        { ninki: 2, finishPosition: pos(8), entryCount: 11 }, // 相対人気0.1,相対着順0.7,差-0.6 → 下回る
      ]);
      expect(result?.傾向).toBe("人気を下回る着順が多い");
    });

    it("上回り・下回りが同数(1対1)のとき、傾向「人気相応(差なし)」を返すこと", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(3), entryCount: 11 }, // 上回る
        { ninki: 3, finishPosition: pos(5), entryCount: 11 }, // 下回る
      ]);
      expect(result?.傾向).toBe("人気相応(差なし)");
      expect(result?.note).toBe(
        "近2走で人気を上回る着順1回・下回る着順1回・相応0回(人気相応(差なし))",
      );
    });

    it("2件とも人気相応(差なし。両方妥当帯)のとき、傾向「人気相応(差なし)」を返すこと", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(5), entryCount: 11 }, // 差0
        { ninki: 4, finishPosition: pos(5), entryCount: 11 }, // 差0.1(<=0.15) → 妥当
      ]);
      expect(result?.傾向).toBe("人気相応(差なし)");
      expect(result?.note).toBe(
        "近2走で人気を上回る着順0回・下回る着順0回・相応2回(人気相応(差なし))",
      );
    });

    it("3件・過去走配列と各走の判定が正しく構造化されること", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(3), entryCount: 11 },
        { ninki: 3, finishPosition: pos(3), entryCount: 11 },
        { ninki: 2, finishPosition: pos(8), entryCount: 11 },
      ]);
      expect(result?.過去走).toEqual([
        { 人気: 5, 着順: 3, 頭数: 11, 判定: "人気を上回る着順" },
        { 人気: 3, 着順: 3, 頭数: 11, 判定: "人気相応の着順" },
        { 人気: 2, 着順: 8, 頭数: 11, 判定: "人気を下回る着順" },
      ]);
    });
  });

  describe("境界: 頭数正規化(妥当帯±0.15)", () => {
    it("entryCount=21・人気10番・着順7着(差ちょうど0.15、境界値)のとき、人気相応の着順を返すこと", () => {
      const result = summarizeMarketGap([
        { ninki: 10, finishPosition: pos(7), entryCount: 21 },
      ]);
      expect(result?.過去走[0]?.判定).toBe("人気相応の着順");
    });

    it("entryCount=21・人気10番・着順6着(差0.2、境界超え)のとき、人気を上回る着順を返すこと", () => {
      const result = summarizeMarketGap([
        { ninki: 10, finishPosition: pos(6), entryCount: 21 },
      ]);
      expect(result?.過去走[0]?.判定).toBe("人気を上回る着順");
    });

    it("entryCount=21・人気10番・着順13着(差ちょうど-0.15、境界値)のとき、人気相応の着順を返すこと", () => {
      const result = summarizeMarketGap([
        { ninki: 10, finishPosition: pos(13), entryCount: 21 },
      ]);
      expect(result?.過去走[0]?.判定).toBe("人気相応の着順");
    });

    it("entryCount=21・人気10番・着順14着(差-0.2、境界超え)のとき、人気を下回る着順を返すこと", () => {
      const result = summarizeMarketGap([
        { ninki: 10, finishPosition: pos(14), entryCount: 21 },
      ]);
      expect(result?.過去走[0]?.判定).toBe("人気を下回る着順");
    });

    it("同じ着順差(2)でも頭数が少ないと判定が変わること(小頭数entryCount=5)", () => {
      // 相対人気(3-1)/4=0.5, 相対着順(1-1)/4=0 → 差0.5(>0.15) → 上回る。
      const result = summarizeMarketGap([
        { ninki: 3, finishPosition: pos(1), entryCount: 5 },
      ]);
      expect(result?.過去走[0]?.判定).toBe("人気を上回る着順");
    });

    it("同じ着順差(2)でも頭数が多いと妥当帯に収まること(大頭数entryCount=21)", () => {
      // 相対人気(3-1)/20=0.1, 相対着順(1-1)/20=0 → 差0.1(<=0.15) → 妥当。
      const result = summarizeMarketGap([
        { ninki: 3, finishPosition: pos(1), entryCount: 21 },
      ]);
      expect(result?.過去走[0]?.判定).toBe("人気相応の着順");
    });

    it("1番人気(相対0)・着順最下位(相対1)の極端な組み合わせで人気を下回る着順になること", () => {
      const result = summarizeMarketGap([
        { ninki: 1, finishPosition: pos(10), entryCount: 10 },
      ]);
      expect(result?.過去走[0]?.判定).toBe("人気を下回る着順");
    });

    it("最下位人気(相対1)・1着(相対0)の極端な組み合わせで人気を上回る着順になること", () => {
      const result = summarizeMarketGap([
        { ninki: 10, finishPosition: pos(1), entryCount: 10 },
      ]);
      expect(result?.過去走[0]?.判定).toBe("人気を上回る着順");
    });
  });

  describe("境界: 欠損走のスキップと遡り(既存のrecentRuns既定3と揃える)", () => {
    it("ninki欠損(null)の走はスキップして遡り、有効な直近3走を収集すること", () => {
      const result = summarizeMarketGap([
        { ninki: null, finishPosition: pos(1), entryCount: 11 },
        { ninki: 5, finishPosition: pos(3), entryCount: 11 },
        { ninki: 3, finishPosition: pos(3), entryCount: 11 },
        { ninki: 2, finishPosition: pos(8), entryCount: 11 },
        { ninki: 4, finishPosition: pos(4), entryCount: 11 },
      ]);
      expect(result?.過去走.map((r) => r.人気)).toEqual([5, 3, 2]);
    });

    it("finishPosition欠損(null)の走はスキップすること", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: null, entryCount: 11 },
        { ninki: 3, finishPosition: pos(3), entryCount: 11 },
      ]);
      expect(result?.過去走).toEqual([
        { 人気: 3, 着順: 3, 頭数: 11, 判定: "人気相応の着順" },
      ]);
    });

    it("finishPosition.kindが非数値(中止・除外・取消)の走はスキップすること", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: nonNumeric("除外"), entryCount: 11 },
        { ninki: 3, finishPosition: pos(3), entryCount: 11 },
      ]);
      expect(result?.過去走).toEqual([
        { 人気: 3, 着順: 3, 頭数: 11, 判定: "人気相応の着順" },
      ]);
    });

    it("entryCount欠損(null)の走はスキップすること", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(3), entryCount: null },
        { ninki: 3, finishPosition: pos(3), entryCount: 11 },
      ]);
      expect(result?.過去走).toEqual([
        { 人気: 3, 着順: 3, 頭数: 11, 判定: "人気相応の着順" },
      ]);
    });

    it("有効走が4件超あっても直近3走までしか使わないこと(既定recentRuns=3)", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(3), entryCount: 11 },
        { ninki: 3, finishPosition: pos(3), entryCount: 11 },
        { ninki: 2, finishPosition: pos(8), entryCount: 11 },
        { ninki: 4, finishPosition: pos(4), entryCount: 11 },
        { ninki: 6, finishPosition: pos(6), entryCount: 11 },
      ]);
      expect(result?.過去走.map((r) => r.人気)).toEqual([5, 3, 2]);
    });

    it("recentRunsをoptionsで2に指定したとき、直近2走までしか使わないこと", () => {
      const result = summarizeMarketGap(
        [
          { ninki: 5, finishPosition: pos(3), entryCount: 11 },
          { ninki: 3, finishPosition: pos(3), entryCount: 11 },
          { ninki: 2, finishPosition: pos(8), entryCount: 11 },
        ],
        { recentRuns: 2 },
      );
      expect(result?.過去走.map((r) => r.人気)).toEqual([5, 3]);
    });
  });

  describe("境界: 降着(demoted)は value を有効着順として使用すること", () => {
    it("demoted:trueでもvalueをそのまま有効着順として使い、非降着と同じ判定になること", () => {
      const demotedResult = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(3, true), entryCount: 11 },
      ]);
      const plainResult = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(3, false), entryCount: 11 },
      ]);
      expect(demotedResult).toEqual(plainResult);
      expect(demotedResult?.過去走[0]).toEqual({
        人気: 5,
        着順: 3,
        頭数: 11,
        判定: "人気を上回る着順",
      });
    });
  });

  describe("境界: 異常値(NaN・Infinity)のガード除外", () => {
    it("ninkiがNaNの走はスキップすること", () => {
      const result = summarizeMarketGap([
        { ninki: NaN, finishPosition: pos(3), entryCount: 11 },
        { ninki: 3, finishPosition: pos(3), entryCount: 11 },
      ]);
      expect(result?.過去走).toHaveLength(1);
      expect(result?.過去走[0]?.人気).toBe(3);
    });

    it("finishPosition.valueがInfinityの走はスキップすること", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: { kind: "順位", value: Infinity }, entryCount: 11 },
        { ninki: 3, finishPosition: pos(3), entryCount: 11 },
      ]);
      expect(result?.過去走).toHaveLength(1);
    });

    it("entryCountがNaNの走はスキップすること", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(3), entryCount: NaN },
        { ninki: 3, finishPosition: pos(3), entryCount: 11 },
      ]);
      expect(result?.過去走).toHaveLength(1);
    });

    it("entryCountが1以下(正規化不能)の走はスキップすること", () => {
      const result = summarizeMarketGap([
        { ninki: 1, finishPosition: pos(1), entryCount: 1 },
        { ninki: 3, finishPosition: pos(3), entryCount: 11 },
      ]);
      expect(result?.過去走).toHaveLength(1);
      expect(result?.過去走[0]?.頭数).toBe(11);
    });
  });

  describe("禁止語彙: 評価語を出力に含めないこと", () => {
    it("noteに評価語(妙味/過小評価/買い/期待/有利/不利等)を含めないこと", () => {
      const result = summarizeMarketGap([
        { ninki: 5, finishPosition: pos(3), entryCount: 11 },
        { ninki: 3, finishPosition: pos(5), entryCount: 11 },
      ]);
      const forbidden = ["妙味", "過小評価", "買い", "期待", "有利", "不利", "べき", "推奨"];
      for (const word of forbidden) {
        expect(result?.note).not.toContain(word);
      }
    });
  });

  describe("決定論: 同一入力なら同一出力を返すこと", () => {
    it("同じ引数で2回呼んでも同じ結果になること", () => {
      const args: Parameters<typeof summarizeMarketGap> = [
        [
          { ninki: 5, finishPosition: pos(3), entryCount: 11 },
          { ninki: 3, finishPosition: pos(5), entryCount: 11 },
        ],
      ];
      expect(summarizeMarketGap(...args)).toEqual(summarizeMarketGap(...args));
    });
  });
});
