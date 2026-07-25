/**
 * 芝の傷み目安(タスク#26-P3a)の純関数テスト。
 *
 * 段階分け(level)は設けず、「開催N日目」という事実のみを中立な材料文として渡す設計
 * (2026-07-22 boss着手前ゲート合意)。null に倒す3条件と、抽出ルール(回次/日次の
 * 取り違え防止・柵letterの素通し)をテーブル駆動+ミューテーション耐性を意識して固定する。
 */

import { describe, expect, it } from "vitest";
import { assessTurfWear } from "../../src/analyzer/turf-wear.js";
import type { CourseType } from "../../src/scraper/types.js";

/** 中立の材料文の共通末尾(断定しない旨)。 */
const NEUTRAL_SUFFIX =
  "開催が進むほど芝の状態(特に内側)は変化しうるが、内外・前後の有利は断定しない材料として扱うこと。";

describe("assessTurfWear(芝の傷み目安・純関数)", () => {
  describe("正常系: 中央芝のraceIdから開催回次・日次・柵を抽出すること", () => {
    it("回次・日次が2桁とも通常値、柵letterがあるとき、柵と回次入りnoteを返すこと", () => {
      // 202605020811 → 場コード05・回次02・日次08(ids.test.tsの既存ケースと同一raceId)。
      const result = assessTurfWear("202605020811", "芝", "A");
      expect(result).toEqual({
        開催日次: 8,
        開催回次: 2,
        柵: "A",
        note: `中央2回8日目(柵A)。${NEUTRAL_SUFFIX}`,
      });
    });

    it("柵がnull(芝だが柵不明)のとき、柵句を省いたnoteを返すこと(冗長な「柵情報なし」等は出さない)", () => {
      const result = assessTurfWear("202605020811", "芝", null);
      expect(result).toEqual({
        開催日次: 8,
        開催回次: 2,
        柵: null,
        note: `中央2回8日目。${NEUTRAL_SUFFIX}`,
      });
      expect(result?.note).not.toContain("柵情報");
      expect(result?.note).not.toContain("柵不明");
    });

    it("柵がundefined(非芝相当のはずだが型上渡された場合)でも柵句を省いたnoteを返すこと", () => {
      const result = assessTurfWear("202605020811", "芝", undefined);
      expect(result?.柵).toBeNull();
      expect(result?.note).toBe(`中央2回8日目。${NEUTRAL_SUFFIX}`);
    });

    it("回次と日次を取り違えないこと(round=02/day=08と round=03/day=05 で別々に正しく出ること)", () => {
      // 202605030512 → 場コード05・回次03・日次05。上のケース(回次02/日次08)と
      // 数値を入れ替えた組み合わせにして、取り違えバグ(round↔day入替)を検出する。
      const result = assessTurfWear("202605030512", "芝", null);
      expect(result?.開催回次).toBe(3);
      expect(result?.開催日次).toBe(5);
      expect(result?.note.startsWith("中央3回5日目")).toBe(true);
    });

    it("回次が「00」(0以下)のとき、開催回次はnullになり、noteから「N回」を落とすが全体はnullにならないこと", () => {
      // 202601000811 → 場コード01・回次00・日次08(ids.test.tsの既存ケースと同一raceId)。
      const result = assessTurfWear("202601000811", "芝", "B");
      expect(result).toEqual({
        開催日次: 8,
        開催回次: null,
        柵: "B",
        note: `中央8日目(柵B)。${NEUTRAL_SUFFIX}`,
      });
    });
  });

  describe("null条件1: centralVenueInfoFromRaceIdがnullを返す入力(地方・不正raceId)はnullを返すこと", () => {
    const cases: Array<[string, string]> = [
      ["202654071210", "地方(場コード30〜64、場コード54=高知)"],
      ["20260502081", "12桁でない(11桁)"],
      ["202611020811", "場コードが中央でも地方でもない範囲(11)"],
      ["202605020813", "レース番号が不正(13)"],
    ];
    it.each(cases)("raceId=%s(%s)はnullを返すこと", (raceId) => {
      expect(assessTurfWear(raceId, "芝", "A")).toBeNull();
    });
  });

  describe("null条件2: courseTypeが芝以外(ダ・障)はnullを返すこと", () => {
    const cases: Array<[CourseType, string]> = [
      ["ダ", "ダート"],
      ["障", "障害"],
    ];
    it.each(cases)("courseType=%s(%s)はnullを返すこと", (courseType) => {
      // raceId自体は中央・正常(202605020811)でもcourseTypeガードでnullになること。
      expect(assessTurfWear("202605020811", courseType, "A")).toBeNull();
    });
  });

  describe("null条件3: 開催日次(day)が0以下・非有限のときはnullを返すこと", () => {
    it("day=「00」(Number化すると0)のときnullを返すこと(文字列'00'決め打ちではなくNumber()化して判定する)", () => {
      // 202605020001 → 場コード05・回次02・日次00・11R=01。
      expect(assessTurfWear("202605020001", "芝", null)).toBeNull();
    });

    it("day=「01」(Number化すると1、下限)のときはnullにならないこと(境界値)", () => {
      // 202605020101 → 場コード05・回次02・日次01。
      const result = assessTurfWear("202605020101", "芝", null);
      expect(result).not.toBeNull();
      expect(result?.開催日次).toBe(1);
    });
  });

  describe("柵letterが素通しで柵フィールド・noteにそのまま出ること(ミューテーション耐性)", () => {
    it("柵='D'のとき、柵フィールドと note の両方に'D'がそのまま出ること", () => {
      const result = assessTurfWear("202605020811", "芝", "D");
      expect(result?.柵).toBe("D");
      expect(result?.note).toContain("(柵D)");
    });
  });
});
