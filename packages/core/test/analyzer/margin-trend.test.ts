/**
 * 過去走の着差(margin)傾向要約(タスク#9・未使用パラメータ活用④)の純関数テスト。
 *
 * HorseRaceResult.margin(過去走の着差)はパース済みだが scorer/prompt では未活用だった。
 * 着差の大小(僅差/大差)を、勝敗(finishPosition)で分類したうえで中立な事実材料として要約する
 * (評価語は一切出さない)。着差の符号では勝敗を判定しない点(margin==0の勝ち/敗け双方が実在)を
 * 重点的に検証する。境界(CLAUDE.md「2走未満は傾向断定なし」準拠)をテーブル駆動で網羅する。
 */

import { describe, expect, it } from "vitest";
import { summarizeMarginTrend } from "../../src/analyzer/margin-trend.js";
import type { FinishPosition } from "../../src/scraper/types.js";

/** 順位のFinishPositionを作る。 */
function pos(value: number): FinishPosition {
  return { kind: "順位", value };
}

/** 非数値(中止・除外・取消)のFinishPositionを作る。 */
function nonNumeric(text = "中止"): FinishPosition {
  return { kind: "非数値", text };
}

describe("summarizeMarginTrend(過去走の着差傾向要約・純関数)", () => {
  describe("境界: 有効過去走0件", () => {
    it("過去走が空配列のとき、null(材料なし)を返すこと", () => {
      expect(summarizeMarginTrend([])).toBeNull();
    });

    it("過去走が全てnullのとき、null(材料なし)を返すこと", () => {
      expect(summarizeMarginTrend([null, null, null])).toBeNull();
    });

    it("有効走が0件(全走が欠損・非数値等でスキップ)のとき、nullを返すこと", () => {
      const result = summarizeMarginTrend([
        { finishPosition: null, margin: 0.5 },
        { finishPosition: nonNumeric(), margin: 0.5 },
        { finishPosition: pos(3), margin: null },
      ]);
      expect(result).toBeNull();
    });
  });

  describe("重要: 勝敗は着差の符号ではなくfinishPositionで判定すること(margin==0の勝ち/敗け両ケース)", () => {
    it("finishPosition.value===1・margin===0のとき、勝ちと判定すること(符号非依存)", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(1), margin: 0 }]);
      expect(result?.過去走[0]).toEqual({ 結果: "勝ち", 着差: 0, 区分: "僅差" });
    });

    it("finishPosition.value===2(2着)・margin===0のとき、敗けと判定すること(符号非依存)", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(2), margin: 0 }]);
      expect(result?.過去走[0]).toEqual({ 結果: "敗け", 着差: 0, 区分: "僅差" });
    });

    it("finishPosition.value===1・margin===-3.5(負値=勝ち幅)のとき、勝ち+着差3.5(絶対値)と判定すること", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(1), margin: -3.5 }]);
      expect(result?.過去走[0]).toEqual({ 結果: "勝ち", 着差: 3.5, 区分: "大差" });
    });

    it("finishPosition.value===2・margin===1.2(正値=前馬との差)のとき、敗け+着差1.2と判定すること", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(2), margin: 1.2 }]);
      expect(result?.過去走[0]).toEqual({ 結果: "敗け", 着差: 1.2, 区分: "ふつう" });
    });
  });

  describe("境界: 僅差/大差の閾値(僅差<=0.5、大差>=3)", () => {
    it("着差ちょうど0.5(境界値)のとき、僅差区分になること", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(2), margin: 0.5 }]);
      expect(result?.過去走[0]?.区分).toBe("僅差");
    });

    it("着差0.6(境界超え)のとき、ふつう区分になること", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(2), margin: 0.6 }]);
      expect(result?.過去走[0]?.区分).toBe("ふつう");
    });

    it("着差ちょうど3(境界値)のとき、大差区分になること", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(2), margin: 3 }]);
      expect(result?.過去走[0]?.区分).toBe("大差");
    });

    it("着差2.9(境界未満)のとき、ふつう区分になること", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(2), margin: 2.9 }]);
      expect(result?.過去走[0]?.区分).toBe("ふつう");
    });
  });

  describe("境界: 有効過去走1件(傾向ラベルなし・事実のみ)", () => {
    it("勝ち走1件のとき、傾向はnullで当該走の事実のみのnoteを返すこと", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(1), margin: -1.2 }]);
      expect(result).toEqual({
        過去走: [{ 結果: "勝ち", 着差: 1.2, 区分: "ふつう" }],
        傾向: null,
        note: "直近1走: 後続に1.2差で勝利",
      });
    });

    it("敗け走1件・僅差のとき、傾向はnullで区分を併記したnoteを返すこと", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(3), margin: 0.3 }]);
      expect(result).toEqual({
        過去走: [{ 結果: "敗け", 着差: 0.3, 区分: "僅差" }],
        傾向: null,
        note: "直近1走: 前の馬と0.3差の敗戦(僅差)",
      });
    });

    it("敗け走1件・大差のとき、区分を併記したnoteを返すこと", () => {
      const result = summarizeMarginTrend([{ finishPosition: pos(5), margin: 4.5 }]);
      expect(result).toEqual({
        過去走: [{ 結果: "敗け", 着差: 4.5, 区分: "大差" }],
        傾向: null,
        note: "直近1走: 前の馬と4.5差の敗戦(大差)",
      });
    });
  });

  describe("境界: 有効過去走2件以上(傾向ラベル算出)", () => {
    it("2件とも僅差の敗けのとき、傾向「僅差の敗戦が多い」を返すこと", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(2), margin: 0.1 },
        { finishPosition: pos(3), margin: 0.4 },
      ]);
      expect(result?.傾向).toBe("僅差の敗戦が多い");
      expect(result?.note).toBe("近2走で僅差の敗け2回(僅差の敗戦が多い)");
    });

    it("2件とも大差の敗けのとき、傾向「大差負けが多い」を返すこと", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(5), margin: 4 },
        { finishPosition: pos(6), margin: 3.2 },
      ]);
      expect(result?.傾向).toBe("大差負けが多い");
    });

    it("2件とも大差の勝ちのとき、傾向「大差の勝ちが多い」を返すこと", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(1), margin: -3 },
        { finishPosition: pos(1), margin: -5 },
      ]);
      expect(result?.傾向).toBe("大差の勝ちが多い");
    });

    it("僅差の敗け1件・大差の敗け1件(異なる分類が同数=タイ)のとき、傾向「傾向一定せず」を返すこと", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(2), margin: 0.2 },
        { finishPosition: pos(6), margin: 3.5 },
      ]);
      expect(result?.傾向).toBe("傾向一定せず");
    });

    it("3件で分類が全て異なる(3すくみタイ)のとき、傾向「傾向一定せず」を返すこと", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(2), margin: 0.2 }, // 僅差の敗け
        { finishPosition: pos(1), margin: -3.5 }, // 大差の勝ち
        { finishPosition: pos(4), margin: 1.5 }, // ふつうの敗け
      ]);
      expect(result?.傾向).toBe("傾向一定せず");
    });

    it("3件で同じ分類が2件・別分類が1件のとき、多数派の傾向を返すこと", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(2), margin: 0.2 }, // 僅差の敗け
        { finishPosition: pos(3), margin: 0.1 }, // 僅差の敗け
        { finishPosition: pos(1), margin: -3.5 }, // 大差の勝ち
      ]);
      expect(result?.傾向).toBe("僅差の敗戦が多い");
      expect(result?.note).toBe(
        "近3走で僅差の敗け2回・大差の勝ち1回(僅差の敗戦が多い)",
      );
    });

    it("3件・過去走配列と各走の結果・区分が正しく構造化されること", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(1), margin: 0 },
        { finishPosition: pos(2), margin: 1.5 },
        { finishPosition: pos(8), margin: 3.2 },
      ]);
      expect(result?.過去走).toEqual([
        { 結果: "勝ち", 着差: 0, 区分: "僅差" },
        { 結果: "敗け", 着差: 1.5, 区分: "ふつう" },
        { 結果: "敗け", 着差: 3.2, 区分: "大差" },
      ]);
    });
  });

  describe("境界: 欠損走のスキップと遡り(既存のrecentRuns既定3と揃える)", () => {
    it("margin欠損(null)の走はスキップして遡り、有効な直近3走を収集すること", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(1), margin: null },
        { finishPosition: pos(2), margin: 0.5 },
        { finishPosition: pos(3), margin: 1.0 },
        { finishPosition: pos(4), margin: 1.5 },
        { finishPosition: pos(5), margin: 2.0 },
      ]);
      expect(result?.過去走.map((r) => r.着差)).toEqual([0.5, 1.0, 1.5]);
    });

    it("finishPosition欠損(null)の走はスキップすること", () => {
      const result = summarizeMarginTrend([
        { finishPosition: null, margin: 0.5 },
        { finishPosition: pos(3), margin: 1.0 },
      ]);
      expect(result?.過去走).toEqual([{ 結果: "敗け", 着差: 1.0, 区分: "ふつう" }]);
    });

    it("finishPosition.kindが非数値(中止・除外・取消)の走はスキップすること", () => {
      const result = summarizeMarginTrend([
        { finishPosition: nonNumeric("除外"), margin: 0.5 },
        { finishPosition: pos(3), margin: 1.0 },
      ]);
      expect(result?.過去走).toEqual([{ 結果: "敗け", 着差: 1.0, 区分: "ふつう" }]);
    });

    it("有効走が4件超あっても直近3走までしか使わないこと(既定recentRuns=3)", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(2), margin: 0.5 },
        { finishPosition: pos(3), margin: 1.0 },
        { finishPosition: pos(4), margin: 1.5 },
        { finishPosition: pos(5), margin: 2.0 },
        { finishPosition: pos(6), margin: 2.5 },
      ]);
      expect(result?.過去走.map((r) => r.着差)).toEqual([0.5, 1.0, 1.5]);
    });

    it("recentRunsをoptionsで2に指定したとき、直近2走までしか使わないこと", () => {
      const result = summarizeMarginTrend(
        [
          { finishPosition: pos(2), margin: 0.5 },
          { finishPosition: pos(3), margin: 1.0 },
          { finishPosition: pos(4), margin: 1.5 },
        ],
        { recentRuns: 2 },
      );
      expect(result?.過去走.map((r) => r.着差)).toEqual([0.5, 1.0]);
    });
  });

  describe("境界: 異常値(NaN・Infinity)のガード除外", () => {
    it("marginがNaNの走はスキップすること", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(2), margin: NaN },
        { finishPosition: pos(3), margin: 1.0 },
      ]);
      expect(result?.過去走).toHaveLength(1);
      expect(result?.過去走[0]?.着差).toBe(1.0);
    });

    it("marginがInfinityの走はスキップすること", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(2), margin: Infinity },
        { finishPosition: pos(3), margin: 1.0 },
      ]);
      expect(result?.過去走).toHaveLength(1);
    });

    it("finishPosition.valueがNaNの走はスキップすること", () => {
      const result = summarizeMarginTrend([
        { finishPosition: { kind: "順位", value: NaN }, margin: 1.0 },
        { finishPosition: pos(3), margin: 1.5 },
      ]);
      expect(result?.過去走).toHaveLength(1);
      expect(result?.過去走[0]?.着差).toBe(1.5);
    });
  });

  describe("禁止語彙: 評価語を出力に含めないこと", () => {
    it("noteに評価語(惜敗/展開待ち/妙味/期待/有利/不利等)を含めないこと", () => {
      const result = summarizeMarginTrend([
        { finishPosition: pos(2), margin: 0.2 },
        { finishPosition: pos(3), margin: 0.3 },
      ]);
      const forbidden = ["惜敗", "展開待ち", "妙味", "期待", "有利", "不利", "べき", "推奨"];
      for (const word of forbidden) {
        expect(result?.note).not.toContain(word);
      }
    });
  });

  describe("決定論: 同一入力なら同一出力を返すこと", () => {
    it("同じ引数で2回呼んでも同じ結果になること", () => {
      const args: Parameters<typeof summarizeMarginTrend> = [
        [
          { finishPosition: pos(2), margin: 0.2 },
          { finishPosition: pos(1), margin: -1.5 },
        ],
      ];
      expect(summarizeMarginTrend(...args)).toEqual(summarizeMarginTrend(...args));
    });
  });
});
