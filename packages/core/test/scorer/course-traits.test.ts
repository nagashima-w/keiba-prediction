import { describe, expect, it } from "vitest";
import {
  COURSE_TRAITS,
  courseSimilarity,
  isCentralVenue,
} from "../../src/scorer/course-traits.js";

/** 中央10場の会場名。 */
const CENTRAL10 = [
  "札幌",
  "函館",
  "福島",
  "新潟",
  "東京",
  "中山",
  "中京",
  "京都",
  "阪神",
  "小倉",
];

describe("COURSE_TRAITS(中央10場コース特性定数)", () => {
  it("中央10場すべての特性を持つこと", () => {
    for (const name of CENTRAL10) {
      expect(COURSE_TRAITS[name]).toBeDefined();
    }
    expect(Object.keys(COURSE_TRAITS)).toHaveLength(10);
  });

  it("左回りは東京・中京・新潟、それ以外は右回りであること", () => {
    const left = ["東京", "中京", "新潟"];
    for (const name of CENTRAL10) {
      const expected = left.includes(name) ? "左" : "右";
      expect(COURSE_TRAITS[name]!.turn).toBe(expected);
    }
  });

  it("急坂は中山・阪神・中京のみ true であること", () => {
    const steep = ["中山", "阪神", "中京"];
    for (const name of CENTRAL10) {
      expect(COURSE_TRAITS[name]!.steepSlope).toBe(steep.includes(name));
    }
  });

  it("洋芝は札幌・函館のみ、それ以外は野芝であること", () => {
    const yoshiba = ["札幌", "函館"];
    for (const name of CENTRAL10) {
      const expected = yoshiba.includes(name) ? "洋芝" : "野芝";
      expect(COURSE_TRAITS[name]!.turfKind).toBe(expected);
    }
  });

  it("直線長は正の数(メートル)であること", () => {
    for (const name of CENTRAL10) {
      expect(COURSE_TRAITS[name]!.straightMeters).toBeGreaterThan(0);
    }
  });
});

describe("isCentralVenue(中央場判定)", () => {
  it.each(CENTRAL10)("「%s」は中央場と判定されること", (name) => {
    expect(isCentralVenue(name)).toBe(true);
  });

  it.each([["大井"], ["園田"], ["門別"], ["ロンシャン"], ["不明"]])(
    "中央10場でない「%s」は false になること",
    (name) => {
      expect(isCentralVenue(name)).toBe(false);
    },
  );
});

describe("courseSimilarity(コース類似度)", () => {
  it("東京×新潟の類似度が手計算の厳密値(0.8995)と一致すること(回帰防止アンカー)", () => {
    // 類似度式の重み(回り0.4/直線長0.3/坂0.2/芝質0.1)・直線長正規化(÷400m)の
    // 取り違えを検知するため、実装非依存の手計算値でアンカーする。
    //  東京: 左・直線525m・平坦・野芝 / 新潟: 左・直線659m・平坦・野芝
    //  回り一致=1(×0.4=0.4)
    //  直線長の近さ=1−|525−659|/400=1−134/400=0.665(×0.3=0.1995)
    //  坂一致=1(×0.2=0.2)
    //  芝質一致=1(×0.1=0.1)
    //  合計 = 0.4+0.1995+0.2+0.1 = 0.8995
    expect(courseSimilarity("東京", "新潟")).toBeCloseTo(0.8995, 10);
  });

  it("同一場どうしの類似度は最大(1.0)になること", () => {
    for (const name of CENTRAL10) {
      expect(courseSimilarity(name, name)).toBeCloseTo(1, 10);
    }
  });

  it("類似度は0〜1の範囲に収まること", () => {
    for (const a of CENTRAL10) {
      for (const b of CENTRAL10) {
        const s = courseSimilarity(a, b);
        expect(s).not.toBeNull();
        expect(s!).toBeGreaterThanOrEqual(0);
        expect(s!).toBeLessThanOrEqual(1);
      }
    }
  });

  it("特性が近い場(右回り・急坂・野芝の中山と阪神)は、特性が異なる場より高い類似度になること", () => {
    // 中山(右・急坂・野芝)と阪神(右・急坂・野芝)は特性が近い。
    const nearer = courseSimilarity("中山", "阪神")!;
    // 中山(右・急坂・野芝)と新潟(左・平坦・野芝・直線長)は特性が離れている。
    const farther = courseSimilarity("中山", "新潟")!;
    expect(nearer).toBeGreaterThan(farther);
  });

  it("回り方向が同じ場は、他条件が同じなら異なる場より類似すること(対称性)", () => {
    // 対称関数であること。
    expect(courseSimilarity("東京", "中京")).toBeCloseTo(
      courseSimilarity("中京", "東京")!,
      10,
    );
  });

  it("未知の場が含まれる場合は null を返すこと", () => {
    expect(courseSimilarity("大井", "東京")).toBeNull();
    expect(courseSimilarity("東京", "大井")).toBeNull();
  });
});
