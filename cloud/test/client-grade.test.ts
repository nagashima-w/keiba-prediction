/**
 * グレードの表示ラベル(Issue #250)。一覧の行・レース画面・結果画面・Discord のタイトルが同じ判定を使う。
 *
 * 出すのは重賞だけ(ユーザー指定): 中央の G1〜G3・J・G1〜J・G3、地方の Jpn1〜Jpn3 と「重賞」。
 * L(リステッド)・OP・条件クラスなど、重賞ではないものは出さない。
 */
import { describe, expect, it } from "vitest";
import { gradeLabelForDisplay, nameWithGrade } from "../client/grade";

describe("gradeLabelForDisplay(表示するグレードだけを通す)", () => {
  const shown = ["G1", "G2", "G3", "J・G1", "J・G2", "J・G3", "Jpn1", "Jpn2", "Jpn3", "重賞"];
  it.each(shown)("%s はそのまま表示すること", (grade) => {
    expect(gradeLabelForDisplay(grade)).toBe(grade);
  });

  it("表示する種類は 10 種で、重複が無いこと(上の表が空振りでないことの自己検証)", () => {
    expect(shown).toHaveLength(10);
    expect(new Set(shown).size).toBe(10);
  });

  // L・OP は重賞ではない(ユーザー指定)。ほかは想定外の文字列で、推測して出さない。
  it.each(["L", "OP", "Jpn4", "Jpn0", "G4", "J・G4", "JG1", "GI", "g1", "jpn1", "Jpn１", "JpnⅠ", "", "  ", "重賞扱い", "3勝クラス"])(
    "表示しない: %j",
    (grade) => {
      expect(gradeLabelForDisplay(grade)).toBeNull();
    },
  );

  it("前後の空白は除いて判定すること(生テキストの余白で表示を落とさない)", () => {
    expect(gradeLabelForDisplay(" G1 ")).toBe("G1");
    expect(gradeLabelForDisplay("Jpn1\n")).toBe("Jpn1");
  });

  it("null・undefined は null", () => {
    expect(gradeLabelForDisplay(null)).toBeNull();
    expect(gradeLabelForDisplay(undefined)).toBeNull();
  });
});

describe("nameWithGrade(レース名の後ろに「(グレード)」を付ける)", () => {
  it("表示するグレードは括弧つきで、レース名の直後(空白なし)に付く", () => {
    expect(nameWithGrade("アイルランドT", "G3")).toBe("アイルランドT(G3)");
    expect(nameWithGrade("中山GJ", "J・G1")).toBe("中山GJ(J・G1)");
    expect(nameWithGrade("帝王賞", "Jpn1")).toBe("帝王賞(Jpn1)");
    expect(nameWithGrade("サンライズカップ", "重賞")).toBe("サンライズカップ(重賞)");
  });

  it("表示しないグレード(OP・L・null・undefined)は、レース名のまま", () => {
    for (const grade of ["OP", "L", null, undefined]) {
      expect(nameWithGrade("藤森S", grade)).toBe("藤森S");
    }
  });

  it("レース名が空・null のときは、グレードだけを後ろに付けない(空のまま)", () => {
    expect(nameWithGrade("", "G3")).toBe("");
    expect(nameWithGrade(null, "G3")).toBe("");
    expect(nameWithGrade(null, null)).toBe("");
  });
});
