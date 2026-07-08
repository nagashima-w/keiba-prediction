/**
 * 脚質分類(通過順位 → 逃げ/先行/差し/追込)の決定論的純関数テスト。
 *
 * 仕様「3. analyzer」: 各馬の直近走の通過順位から脚質を粗く分類し、逃げ馬の数を明示する。
 * 分類は境界(先頭=逃げ、相対位置の閾値、母数不明時のフォールバック)を含むテーブル駆動で検証する。
 */

import { describe, expect, it } from "vitest";
import {
  classifyHorseLegStyle,
  classifyRunLegStyle,
  countFrontRunners,
  estimatePace,
  type HorseRunPassing,
  type LegStyle,
} from "../../src/analyzer/leg-style.js";

describe("classifyRunLegStyle(1走分の脚質分類)", () => {
  it("通過順が空なら null(不明)になること", () => {
    expect(classifyRunLegStyle([], 18)).toBeNull();
  });

  // 母数(頭数)ありのテーブル駆動。相対位置 r = 第1コーナー通過順 / 頭数。
  //   先頭(1番手) → 逃げ / r<=1/3 → 先行 / r<=2/3 → 差し / それ以外 → 追込
  const withField: ReadonlyArray<{
    label: string;
    passing: number[];
    field: number;
    expected: LegStyle;
  }> = [
    { label: "1番手は逃げ", passing: [1, 1, 2], field: 18, expected: "逃げ" },
    { label: "1番手は小頭数でも逃げ", passing: [1], field: 5, expected: "逃げ" },
    { label: "r=1/3ちょうどは先行", passing: [6, 6], field: 18, expected: "先行" },
    { label: "r=1/3超は差し", passing: [7], field: 18, expected: "差し" },
    { label: "r=2/3ちょうどは差し", passing: [12], field: 18, expected: "差し" },
    { label: "r=2/3超は追込", passing: [13], field: 18, expected: "追込" },
    { label: "最後方は追込", passing: [18, 17], field: 18, expected: "追込" },
  ];
  it.each(withField)("頭数あり: $label", ({ passing, field, expected }) => {
    expect(classifyRunLegStyle(passing, field)).toBe(expected);
  });

  // 頭数不明(null / 0)は絶対位置でフォールバック分類する。
  //   1→逃げ / <=4→先行 / <=8→差し / それ以外→追込
  const noField: ReadonlyArray<{
    label: string;
    passing: number[];
    expected: LegStyle;
  }> = [
    { label: "1番手は逃げ", passing: [1, 2], expected: "逃げ" },
    { label: "4番手は先行", passing: [4], expected: "先行" },
    { label: "8番手は差し", passing: [8], expected: "差し" },
    { label: "9番手は追込", passing: [9], expected: "追込" },
  ];
  it.each(noField)("頭数不明: $label", ({ passing, expected }) => {
    expect(classifyRunLegStyle(passing, null)).toBe(expected);
  });

  // 頭数0(異常値)は null と同様に絶対位置フォールバックに落ちること(ゼロ除算を避ける)。
  const zeroField: ReadonlyArray<{
    label: string;
    passing: number[];
    expected: LegStyle;
  }> = [
    { label: "1番手は逃げ", passing: [1], expected: "逃げ" },
    { label: "4番手は先行", passing: [4], expected: "先行" },
    { label: "9番手は追込", passing: [9], expected: "追込" },
  ];
  it.each(zeroField)("頭数0: $label(絶対位置で分類)", ({ passing, expected }) => {
    expect(classifyRunLegStyle(passing, 0)).toBe(expected);
  });
});

describe("classifyHorseLegStyle(直近複数走からの脚質)", () => {
  it("通過順を持つ走が1つも無ければ null になること", () => {
    const runs: HorseRunPassing[] = [
      { passing: [], fieldSize: 18 },
      { passing: [], fieldSize: null },
    ];
    expect(classifyHorseLegStyle(runs)).toBeNull();
  });

  it("直近3走の最頻脚質を返すこと", () => {
    // 新しい順: 先行, 差し, 差し → 最頻は差し。
    const runs: HorseRunPassing[] = [
      { passing: [5], fieldSize: 18 }, // 先行
      { passing: [10], fieldSize: 18 }, // 差し
      { passing: [11], fieldSize: 18 }, // 差し
    ];
    expect(classifyHorseLegStyle(runs)).toBe("差し");
  });

  it("同数のときは直近走の脚質を優先すること", () => {
    // 新しい順: 逃げ, 先行 → 1対1 → 直近(逃げ)を採用。
    const runs: HorseRunPassing[] = [
      { passing: [1], fieldSize: 18 }, // 逃げ
      { passing: [5], fieldSize: 18 }, // 先行
    ];
    expect(classifyHorseLegStyle(runs)).toBe("逃げ");
  });

  it("recentRuns で参照する直近走数を絞れること", () => {
    // 直近1走のみ見れば逃げ。
    const runs: HorseRunPassing[] = [
      { passing: [1], fieldSize: 18 }, // 逃げ(直近)
      { passing: [13], fieldSize: 18 }, // 追込
      { passing: [13], fieldSize: 18 }, // 追込
    ];
    expect(classifyHorseLegStyle(runs, { recentRuns: 1 })).toBe("逃げ");
  });
});

describe("countFrontRunners(逃げ馬の数)", () => {
  it("脚質配列から逃げの数を数えること(null は無視)", () => {
    const styles: (LegStyle | null)[] = ["逃げ", "先行", "逃げ", null, "追込"];
    expect(countFrontRunners(styles)).toBe(2);
  });
});

describe("estimatePace(逃げ馬数からのペース想定)", () => {
  it("逃げ馬0はスロー想定の文言を含むこと", () => {
    expect(estimatePace(0)).toContain("スロー");
  });
  it("逃げ馬1は平均ペース想定の文言を含むこと", () => {
    expect(estimatePace(1)).toContain("平均");
  });
  it("逃げ馬2以上はハイペース想定の文言を含むこと", () => {
    expect(estimatePace(2)).toContain("ハイ");
  });
});
