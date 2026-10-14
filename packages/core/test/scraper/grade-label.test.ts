/**
 * 中央のグレードアイコンの番号(`Icon_GradeType{N}`)→グレードラベルの対応表のテスト(Issue #250)。
 *
 * 表に載る値は、すべて netkeiba 自身の出馬表 `<title>`(例: 「毎日王冠(G2) 出馬表」)と、同じページの
 * `h1.RaceName` 内のクラス番号を突き合わせて実測したものだけ(2026-10-10。出所はテストの
 * `parse-shutuba.test.ts` の「title 照合」と、フィクスチャの `shutuba_*.html`)。
 * 実測していない番号は推測で埋めず、すべて undefined(表示しない)にする。
 */

import { describe, expect, it } from "vitest";
import { centralGradeLabel } from "../../src/scraper/grade-label.js";

describe("centralGradeLabel(中央のグレードアイコン番号→ラベル。実測した番号だけ)", () => {
  // [番号, ラベル, 実測した出所]
  const measured: ReadonlyArray<readonly [number, string, string]> = [
    [1, "G1", "スプリンターズS(G1) 202606040911"],
    [2, "G2", "毎日王冠(G2) 202605040211"],
    [3, "G3", "ラジオＮＩＫＫＥＩ賞(G3) 202603020211"],
    [10, "J・G1", "中山グランドジャンプ(JG1) 202606030711"],
    [11, "J・G2", "阪神スプリングＪ(JG2) 202609010708"],
    [12, "J・G3", "小倉ジャンプＳ(JG3) 202610010708"],
  ];

  it.each(measured)("番号 %i は %s になること(出所: %s)", (n, label) => {
    expect(centralGradeLabel(n)).toBe(label);
  });

  it("実測した対応は 6 件で、重複したラベルが無いこと", () => {
    expect(measured).toHaveLength(6);
    expect(new Set(measured.map(([, label]) => label)).size).toBe(6);
  });

  // 実測済みの「重賞ではない」番号。title の括弧内は OP・L・3勝クラス・2勝クラス・1勝クラス。
  // 13 は G1・G2・OP・3勝・1勝・L のレースの RaceName 内にグレードの隣に並ぶ別のアイコン(グレードではない)。
  const measuredNonGrade: ReadonlyArray<readonly [number, string]> = [
    [5, "藤森Ｓ(OP) 202608040210"],
    [13, "毎日王冠(G2) の 2 つ目のアイコン"],
    [15, "ポートアイランドS(L) 202609040911"],
    [16, "赤富士Ｓ(3勝クラス) 202605040210"],
    [17, "勝浦特別(2勝クラス) 202606040810"],
    [18, "サフラン賞(1勝クラス) 202606040909"],
  ];

  it.each(measuredNonGrade)("実測済みの重賞ではない番号 %i(%s)は undefined になること", (n) => {
    expect(centralGradeLabel(n)).toBeUndefined();
  });

  // 実測していない番号(4・6〜9・14)と範囲外・不正値。推測で埋めない=undefined。
  it.each([0, 4, 6, 7, 8, 9, 14, 19, 20, 99, -1, 1.5, Number.NaN])("未測定・範囲外の番号 %s は undefined になること", (n) => {
    expect(centralGradeLabel(n)).toBeUndefined();
  });
});
