/**
 * 脚質分類(通過順位 → 逃げ/先行/差し/追込)の決定論的純関数テスト。
 *
 * 仕様「3. analyzer」: 各馬の直近走の通過順位から脚質を粗く分類し、逃げ馬の数を明示する。
 * 分類は境界(先頭=逃げ、相対位置の閾値、母数不明時のフォールバック)を含むテーブル駆動で検証する。
 */

import { describe, expect, it } from "vitest";
import {
  analyzeHorseLegStyle,
  buildRaceDevelopment,
  classifyHorseLegStyle,
  classifyHorseLegStyleFull,
  classifyRunLegStyle,
  classifyRunLegStyleFull,
  computeFrontRunningScore,
  computeLegStyleStability,
  countFrontRunners,
  estimatePace,
  summarizePastPaceTendency,
  type HorseRunPassing,
  type LegStyle,
  type LegStyleStability,
  type RaceDevelopmentHorseInput,
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

describe("classifyRunLegStyleFull(全コーナーを使った1走分の脚質分類)", () => {
  it("通過順が空なら style/averagePosition/positionChange すべて null になること", () => {
    const d = classifyRunLegStyleFull([], 16);
    expect(d.style).toBeNull();
    expect(d.averagePosition).toBeNull();
    expect(d.positionChange).toBeNull();
  });

  it("通し逃げ(終始先頭)は逃げ、位置変化は0になること", () => {
    const d = classifyRunLegStyleFull([1, 1, 1, 1], 16);
    expect(d.style).toBe("逃げ");
    expect(d.positionChange).toBe(0);
  });

  it("第1コーナーで先頭でも道中失速すれば逃げに分類しないこと(第1コーナーのみ判定との違い)", () => {
    // 第1コーナーは1番手だが、道中の平均位置は中団寄り(差し相当)まで下がる。
    // 旧ロジック(classifyRunLegStyle)なら pos===1 のみで「逃げ」だが、
    // 全コーナー平均を見る新ロジックでは「逃げ」に分類しない(失速を反映する)。
    const old = classifyRunLegStyle([1, 5, 10, 14], 16);
    const full = classifyRunLegStyleFull([1, 5, 10, 14], 16);
    expect(old).toBe("逃げ");
    expect(full.style).toBe("差し");
    expect(full.positionChange).toBe(13); // 1→14 で13番手後退。
  });

  it("終いに差を詰める(終盤の進出)は positionChange が負になること", () => {
    const d = classifyRunLegStyleFull([10, 9, 6, 3], 16);
    expect(d.style).toBe("差し");
    expect(d.positionChange).toBe(-7); // 10→3 で7番手進出。
  });

  it("頭数不明でも全コーナー平均(絶対位置)で判定すること", () => {
    // 第1コーナーは1番手だが道中平均は追込相当まで下がる(頭数不明の絶対位置フォールバック)。
    const d = classifyRunLegStyleFull([1, 10, 12, 14], null);
    expect(d.style).toBe("追込");
    expect(d.positionChange).toBe(13);
  });

  it("頭数不明・道中安定して先行なら先行に分類すること", () => {
    const d = classifyRunLegStyleFull([2, 3, 3, 2], null);
    expect(d.style).toBe("先行");
    expect(d.positionChange).toBe(0);
  });

  it("コーナー情報が1つだけなら positionChange は null になること", () => {
    const d = classifyRunLegStyleFull([5], 16);
    expect(d.positionChange).toBeNull();
  });

  // 頭数0(異常値)は頭数不明(null)と同様に絶対位置でフォールバック分類すること(0除算を避ける)。
  // classifyRunLegStyle の zeroField テーブル(基本版)に相当する全コーナー版のケース。
  const zeroFieldFull: ReadonlyArray<{
    label: string;
    passing: number[];
    expected: LegStyle;
  }> = [
    { label: "通し1番手は逃げ", passing: [1, 1], expected: "逃げ" },
    { label: "絶対位置4番手は先行", passing: [4, 4], expected: "先行" },
    { label: "絶対位置8番手は差し", passing: [8, 8], expected: "差し" },
    { label: "絶対位置9番手は追込", passing: [9, 9], expected: "追込" },
  ];
  it.each(zeroFieldFull)("頭数0: $label(絶対位置で分類)", ({ passing, expected }) => {
    const d = classifyRunLegStyleFull(passing, 0);
    expect(d.style).toBe(expected);
  });
});

describe("classifyHorseLegStyleFull(全コーナー判定を使った直近複数走からの脚質)", () => {
  it("第1コーナー先頭が続いても道中失速が続けば逃げにならないこと", () => {
    // 旧ロジック(classifyHorseLegStyle)なら両走とも第1コーナー1番手のため「逃げ」判定になるが、
    // 全コーナーを見る新ロジックでは道中の失速を反映し「逃げ」以外になる。
    const runs: HorseRunPassing[] = [
      { passing: [1, 8, 12, 15], fieldSize: 16 },
      { passing: [1, 7, 11, 14], fieldSize: 16 },
    ];
    expect(classifyHorseLegStyle(runs)).toBe("逃げ");
    expect(classifyHorseLegStyleFull(runs)).toBe("差し");
  });

  it("通過順を持つ走が1つも無ければ null になること", () => {
    const runs: HorseRunPassing[] = [{ passing: [], fieldSize: 16 }];
    expect(classifyHorseLegStyleFull(runs)).toBeNull();
  });

  it("頭数0(異常値)の走は絶対位置でフォールバック分類されること(0除算を避ける)", () => {
    const runs: HorseRunPassing[] = [{ passing: [1, 1], fieldSize: 0 }];
    expect(classifyHorseLegStyleFull(runs)).toBe("逃げ");
  });
});

describe("computeLegStyleStability(脚質の安定度)", () => {
  it("分類できた走が0走なら不明になること", () => {
    const runs: HorseRunPassing[] = [{ passing: [], fieldSize: 16 }];
    expect(computeLegStyleStability(runs)).toBe("不明");
  });

  it("分類できた走が1走のみ(サンプル2走未満)なら不明になること", () => {
    const runs: HorseRunPassing[] = [{ passing: [1, 1], fieldSize: 16 }];
    expect(computeLegStyleStability(runs)).toBe("不明");
  });

  const cases: ReadonlyArray<{
    label: string;
    runs: HorseRunPassing[];
    expected: LegStyleStability;
  }> = [
    {
      label: "直近3走すべて同じ脚質なら安定",
      runs: [
        { passing: [1, 1], fieldSize: 16 },
        { passing: [1, 1], fieldSize: 16 },
        { passing: [1, 1], fieldSize: 16 },
      ],
      expected: "安定",
    },
    {
      label: "2走中2走が同じ脚質(比率1.0)なら安定",
      runs: [
        { passing: [1, 1], fieldSize: 16 },
        { passing: [1, 1], fieldSize: 16 },
      ],
      expected: "安定",
    },
    {
      label: "2走で脚質が異なる(比率0.5・境界値)なら概ね安定",
      runs: [
        { passing: [1, 1], fieldSize: 16 }, // 逃げ
        { passing: [10], fieldSize: 16 }, // 差し
      ],
      expected: "概ね安定",
    },
    {
      label: "3走中2走が同じ脚質(比率2/3)なら概ね安定",
      runs: [
        { passing: [10], fieldSize: 16 }, // 差し
        { passing: [10], fieldSize: 16 }, // 差し
        { passing: [1, 1], fieldSize: 16 }, // 逃げ
      ],
      expected: "概ね安定",
    },
    {
      label: "3走すべて脚質が異なる(比率1/3)なら不安定",
      runs: [
        { passing: [1, 1], fieldSize: 16 }, // 逃げ
        { passing: [10], fieldSize: 16 }, // 差し
        { passing: [15], fieldSize: 16 }, // 追込
      ],
      expected: "不安定",
    },
  ];
  it.each(cases)("$label", ({ runs, expected }) => {
    expect(computeLegStyleStability(runs)).toBe(expected);
  });

  it("頭数0(異常値)の走と頭数が正常な走が混在しても0除算せず正しく安定度を判定できること", () => {
    // 頭数0の走(絶対位置フォールバックで「逃げ」: 1<=LEAD_POS)と、頭数16の走
    // (相対位置でも「逃げ」: 1/16<=LEAD_RATIO)を混在させる。
    // ガード(useRatio = fieldSize !== null && fieldSize > 0)が壊れて頭数0の走にまで
    // 相対位置(1/0 = Infinity)を使ってしまうと、その走だけ「追込」に誤分類され
    // (Infinity は LEAD_RATIO・MID_RATIO のどちらの閾値も超える)、脚質が「逃げ」「追込」で
    // 割れて安定度が「安定」(比率1.0)から「概ね安定」(比率0.5)にずれる。
    // 粗い集約値(安定度)自体が変化するため、頭数0の走だけを揃えた旧テストと異なり
    // ガードの破壊を確実に検知できる。
    const runs: HorseRunPassing[] = [
      { passing: [1, 1], fieldSize: 0 }, // 絶対位置フォールバックで逃げ
      { passing: [1, 1], fieldSize: 16 }, // 相対位置でも逃げ
    ];
    expect(computeLegStyleStability(runs)).toBe("安定");
  });
});

describe("computeFrontRunningScore(先行力スコア: 道中平均位置の直近走平均)", () => {
  it("頭数が分かる走のみで平均相対位置を算出すること", () => {
    const runs: HorseRunPassing[] = [
      { passing: [2, 2], fieldSize: 16 }, // 平均比率 0.125
      { passing: [4, 4], fieldSize: 16 }, // 平均比率 0.25
    ];
    expect(computeFrontRunningScore(runs)).toBeCloseTo(0.1875, 8);
  });

  it("頭数不明の走は無視して頭数既知の走だけで算出すること", () => {
    const runs: HorseRunPassing[] = [
      { passing: [2, 2], fieldSize: 16 }, // 平均比率 0.125
      { passing: [1], fieldSize: null }, // 頭数不明のため対象外
    ];
    expect(computeFrontRunningScore(runs)).toBeCloseTo(0.125, 8);
  });

  it("頭数既知の走が1つも無ければ null を返すこと", () => {
    const runs: HorseRunPassing[] = [{ passing: [1], fieldSize: null }];
    expect(computeFrontRunningScore(runs)).toBeNull();
  });

  it("頭数0(異常値)の走は頭数不明と同様に対象外となり0除算しないこと", () => {
    const runs: HorseRunPassing[] = [{ passing: [1, 1], fieldSize: 0 }];
    expect(computeFrontRunningScore(runs)).toBeNull();
  });
});

describe("analyzeHorseLegStyle(脚質・安定度・先行力スコアの統合分析)", () => {
  it("脚質(全コーナー版)・安定度・先行力スコアをまとめて返すこと", () => {
    const runs: HorseRunPassing[] = [
      { passing: [1, 1], fieldSize: 16 },
      { passing: [1, 1], fieldSize: 16 },
      { passing: [1, 1], fieldSize: 16 },
    ];
    const a = analyzeHorseLegStyle(runs);
    expect(a.style).toBe("逃げ");
    expect(a.stability).toBe("安定");
    expect(a.frontRunningScore).toBeCloseTo(1 / 16, 8);
  });

  it("通過順情報が無い馬は style=null・stability=不明・frontRunningScore=null になること", () => {
    const runs: HorseRunPassing[] = [{ passing: [], fieldSize: 16 }];
    const a = analyzeHorseLegStyle(runs);
    expect(a.style).toBeNull();
    expect(a.stability).toBe("不明");
    expect(a.frontRunningScore).toBeNull();
  });
});

describe("summarizePastPaceTendency(過去走のペース傾向)", () => {
  it("ペース情報が無ければ「データ不足」になること", () => {
    const runs: HorseRunPassing[] = [{ passing: [1], fieldSize: 16, pace: null }];
    expect(summarizePastPaceTendency(runs)).toBe("データ不足");
  });

  it("前半が速い(前傾)ペースを1回経験した場合の表記になること", () => {
    // 前半3F 29.9 < 後半3F 37.6 → 前半が速い(前傾ラップ)→ 差し追込有利だった展開。
    const runs: HorseRunPassing[] = [{ passing: [1], fieldSize: 16, pace: "29.9-37.6" }];
    expect(summarizePastPaceTendency(runs)).toContain("前傾(差し追込有利)1回");
  });

  it("後半が速い(後傾)ペースを1回経験した場合の表記になること", () => {
    // 前半3F 37.6 > 後半3F 29.9 → 前半が遅い(後傾ラップ)→ 先行有利だった展開。
    const runs: HorseRunPassing[] = [{ passing: [1], fieldSize: 16, pace: "37.6-29.9" }];
    expect(summarizePastPaceTendency(runs)).toContain("後傾(先行有利)1回");
  });

  it("前後半の差が小さければ平均的と表記すること", () => {
    const runs: HorseRunPassing[] = [{ passing: [1], fieldSize: 16, pace: "33.0-33.3" }];
    expect(summarizePastPaceTendency(runs)).toContain("平均的1回");
  });

  it("複数走の傾向を回数付きで集計すること", () => {
    const runs: HorseRunPassing[] = [
      { passing: [1], fieldSize: 16, pace: "29.9-37.6" }, // 前傾
      { passing: [1], fieldSize: 16, pace: "29.0-37.0" }, // 前傾
      { passing: [1], fieldSize: 16, pace: "33.0-33.3" }, // 平均的
    ];
    const s = summarizePastPaceTendency(runs);
    expect(s).toContain("前傾(差し追込有利)2回");
    expect(s).toContain("平均的1回");
  });

  it("上がり3Fの平均値があれば括弧書きで付記すること", () => {
    const runs: HorseRunPassing[] = [
      { passing: [1], fieldSize: 16, pace: "29.9-37.6", last3f: 35.0 },
      { passing: [1], fieldSize: 16, pace: "29.0-37.0", last3f: 36.0 },
    ];
    const s = summarizePastPaceTendency(runs);
    expect(s).toContain("上がり3F平均35.5秒");
  });

  it("不正な形式のペース文字列は集計から除外すること", () => {
    const runs: HorseRunPassing[] = [{ passing: [1], fieldSize: 16, pace: "不明" }];
    expect(summarizePastPaceTendency(runs)).toBe("データ不足");
  });

  it("pace が無効な走の last3f は上がり3F平均から除外されること", () => {
    // 1走目: pace有効(前傾)・last3f=35.0 → 上がり3F平均の対象。
    // 2走目: pace無効(不正な形式)だが last3f=30.0 は単体で取得できているケース
    //         (netkeiba上ではpaceとlast3fの取得可否が独立にずれることがある)。
    // 「上がり3F平均は pace 判定対象と同じ走からのみ集計する」仕様のため、2走目の last3f は
    // 除外されなければならない。もし誤って含めてしまうと平均は (35.0+30.0)/2=32.5 になるが、
    // 正しくは1走目のみの35.0になるはずである。
    const runs: HorseRunPassing[] = [
      { passing: [1], fieldSize: 16, pace: "29.9-37.6", last3f: 35.0 }, // 前傾・last3f対象
      { passing: [1], fieldSize: 16, pace: "不明", last3f: 30.0 }, // pace無効・last3fは対象外
    ];
    const s = summarizePastPaceTendency(runs);
    expect(s).toContain("上がり3F平均35.0秒");
    expect(s).not.toContain("32.5");
  });

  it("通過順が空でもペースが有効な走はペース傾向集計に含まれること(海外遠征・障害戦等でpassing欄が無いケース)", () => {
    // passing は空(通過順欄なし)だが pace(前半3F-後半3F)は取得できているケース。
    // ペース傾向は pace から判定するものであり、passing の有無で除外されてはならない。
    const runs: HorseRunPassing[] = [{ passing: [], fieldSize: null, pace: "29.9-37.6" }];
    expect(summarizePastPaceTendency(runs)).toContain("前傾(差し追込有利)1回");
  });

  it("passingが空の走が連続してもrecentRunsの範囲解釈が破綻しない(過去へ無制限に遡らない)こと", () => {
    // 新しい順: passing空(前傾)・passing空(後傾)・passingあり(平均的)。
    // recentRuns=2 なので「pace判定可能な直近2走」= 前傾・後傾のみが対象。
    // passing空を理由に seen が進まず3走目(平均的)まで遡ってしまうと不正(現バグ)。
    const runs: HorseRunPassing[] = [
      { passing: [], fieldSize: null, pace: "29.9-37.6" }, // 前傾(1走前、passing空)
      { passing: [], fieldSize: null, pace: "37.6-29.9" }, // 後傾(2走前、passing空)
      { passing: [1], fieldSize: 16, pace: "33.0-33.3" }, // 平均的(3走前、passingあり)→対象外
    ];
    const s = summarizePastPaceTendency(runs, { recentRuns: 2 });
    expect(s).toContain("前傾(差し追込有利)1回");
    expect(s).toContain("後傾(先行有利)1回");
    expect(s).not.toContain("平均的");
  });

  // PACE_TENDENCY_THRESHOLD_SEC(0.5秒)の境界値。diff = 前半3F - 後半3F。
  //   diff<=-0.5 → 前傾 / diff>=0.5 → 後傾 / それ以外(-0.5<diff<0.5) → 平均的
  const thresholdCases: ReadonlyArray<{
    label: string;
    pace: string;
    expectedContains: string;
  }> = [
    { label: "diff=-0.5(前傾境界ちょうど)は前傾", pace: "30.0-30.5", expectedContains: "前傾(差し追込有利)1回" },
    { label: "diff=+0.5(後傾境界ちょうど)は後傾", pace: "30.5-30.0", expectedContains: "後傾(先行有利)1回" },
    { label: "diff=-0.49(前傾境界未満)は平均的", pace: "30.0-30.49", expectedContains: "平均的1回" },
    { label: "diff=+0.49(後傾境界未満)は平均的", pace: "30.49-30.0", expectedContains: "平均的1回" },
  ];
  it.each(thresholdCases)("$label", ({ pace, expectedContains }) => {
    const runs: HorseRunPassing[] = [{ passing: [1], fieldSize: 16, pace }];
    expect(summarizePastPaceTendency(runs)).toContain(expectedContains);
  });
});

describe("buildRaceDevelopment(展開想定の構造化)", () => {
  it("脚質分布・主導権候補・想定ペース・恵まれる/損する脚質を返すこと(逃げ複数=ハイペース想定)", () => {
    const horses: RaceDevelopmentHorseInput[] = [
      { umaban: 1, style: "逃げ", stability: "安定", frontRunningScore: 0.05 },
      { umaban: 2, style: "逃げ", stability: "不安定", frontRunningScore: 0.1 },
      { umaban: 3, style: "差し", stability: "安定", frontRunningScore: 0.5 },
      { umaban: 4, style: null, stability: "不明", frontRunningScore: null },
    ];
    const d = buildRaceDevelopment(horses);
    expect(d.styleCounts).toEqual({ 逃げ: 2, 先行: 0, 差し: 1, 追込: 0 });
    expect(d.unknownCount).toBe(1);
    // 逃げ馬2頭のうち frontRunningScore が最も低い(=より前目)馬番1が主導権候補。
    expect(d.paceSetterUmaban).toBe(1);
    expect(d.pace).toBe("ハイ");
    expect(d.favoredStyles).toEqual(["差し", "追込"]);
    expect(d.disfavoredStyles).toEqual(["逃げ"]);
  });

  it("逃げ馬不在ならスロー想定になり、先行/差しが恵まれ追込が損すること", () => {
    const horses: RaceDevelopmentHorseInput[] = [
      { umaban: 1, style: "先行", stability: "安定", frontRunningScore: 0.2 },
      { umaban: 2, style: "追込", stability: "安定", frontRunningScore: 0.8 },
    ];
    const d = buildRaceDevelopment(horses);
    expect(d.pace).toBe("スロー");
    expect(d.paceSetterUmaban).toBe(1); // 逃げがいないため先行馬が主導権候補。
    expect(d.favoredStyles).toEqual(["逃げ", "先行"]);
    expect(d.disfavoredStyles).toEqual(["追込"]);
  });

  it("逃げ・先行がいずれもいなければ主導権候補は該当なし(null)になること", () => {
    const horses: RaceDevelopmentHorseInput[] = [
      { umaban: 1, style: "差し", stability: "安定", frontRunningScore: 0.4 },
      { umaban: 2, style: "追込", stability: "安定", frontRunningScore: 0.8 },
    ];
    const d = buildRaceDevelopment(horses);
    expect(d.paceSetterUmaban).toBeNull();
  });

  it("先行力スコアが同点なら安定度の高い馬を主導権候補として優先すること", () => {
    const horses: RaceDevelopmentHorseInput[] = [
      { umaban: 5, style: "逃げ", stability: "不安定", frontRunningScore: 0.1 },
      { umaban: 2, style: "逃げ", stability: "安定", frontRunningScore: 0.1 },
    ];
    const d = buildRaceDevelopment(horses);
    expect(d.paceSetterUmaban).toBe(2);
  });

  it("先行力スコア・安定度がいずれも同点なら馬番が若い馬を優先すること", () => {
    const horses: RaceDevelopmentHorseInput[] = [
      { umaban: 5, style: "逃げ", stability: "安定", frontRunningScore: 0.1 },
      { umaban: 2, style: "逃げ", stability: "安定", frontRunningScore: 0.1 },
    ];
    const d = buildRaceDevelopment(horses);
    expect(d.paceSetterUmaban).toBe(2);
  });

  it("出走馬0頭でも落ちずにスロー想定・主導権候補なしを返すこと", () => {
    const d = buildRaceDevelopment([]);
    expect(d.styleCounts).toEqual({ 逃げ: 0, 先行: 0, 差し: 0, 追込: 0 });
    expect(d.paceSetterUmaban).toBeNull();
    expect(d.pace).toBe("スロー");
  });

  it("想定ペースの根拠(paceReason)に逃げ馬の頭数を含むこと", () => {
    const horses: RaceDevelopmentHorseInput[] = [
      { umaban: 1, style: "逃げ", stability: "安定", frontRunningScore: 0.05 },
    ];
    const d = buildRaceDevelopment(horses);
    expect(d.paceReason).toContain("1");
  });
});

describe("buildRaceDevelopment(地方/コース形態の有利脚質補正)", () => {
  // pace(想定ペース)は styleCounts.逃げ の頭数のみで決まる(paceEstimateFromFrontRunnerCount)。
  // スロー=逃げ0頭・平均=逃げ1頭・ハイ=逃げ2頭以上、となる最小構成を用意する。
  const slowHorses: RaceDevelopmentHorseInput[] = [
    { umaban: 1, style: "先行", stability: "安定", frontRunningScore: 0.2 },
  ];
  const mediumHorses: RaceDevelopmentHorseInput[] = [
    { umaban: 1, style: "逃げ", stability: "安定", frontRunningScore: 0.1 },
  ];
  const highHorses: RaceDevelopmentHorseInput[] = [
    { umaban: 1, style: "逃げ", stability: "安定", frontRunningScore: 0.05 },
    { umaban: 2, style: "逃げ", stability: "安定", frontRunningScore: 0.1 },
  ];

  it("venueKind省略(第3引数なし)は従来表のまま(後方互換)", () => {
    const d = buildRaceDevelopment(highHorses);
    expect(d.favoredStyles).toEqual(["差し", "追込"]);
    expect(d.disfavoredStyles).toEqual(["逃げ"]);
  });

  it("venueKind=undefinedを明示しても従来表のまま(trackConditionを渡しても中央には不良ルール非適用)", () => {
    const d = buildRaceDevelopment(highHorses, undefined, "不良");
    expect(d.favoredStyles).toEqual(["差し", "追込"]);
    expect(d.disfavoredStyles).toEqual(["逃げ"]);
  });

  it("中央(central)は馬場不良でも従来表のまま(不良ルールは地方専用で中央には非適用)", () => {
    const d = buildRaceDevelopment(highHorses, "central", "不良");
    expect(d.favoredStyles).toEqual(["差し", "追込"]);
    expect(d.disfavoredStyles).toEqual(["逃げ"]);
  });

  it.each([
    { label: "スロー", horses: slowHorses, favored: ["逃げ", "先行"], disfavored: ["追込"] },
    { label: "平均", horses: mediumHorses, favored: ["逃げ", "先行"], disfavored: ["追込"] },
    {
      label: "ハイ",
      horses: highHorses,
      favored: ["逃げ", "先行", "差し"],
      disfavored: ["追込"],
    },
  ])(
    "地方(nar)・通常馬場(良)の$labelペースは有利=$favored/不利=$disfavored になること(ハイでも逃げは不利に入らない)",
    ({ horses, favored, disfavored }) => {
      const d = buildRaceDevelopment(horses, "nar", "良");
      expect(d.favoredStyles).toEqual(favored);
      expect(d.disfavoredStyles).toEqual(disfavored);
    },
  );

  it.each([
    { label: "スロー", horses: slowHorses },
    { label: "平均", horses: mediumHorses },
    { label: "ハイ", horses: highHorses },
  ])(
    "地方(nar)・馬場不良の$labelペースは全ペースで有利=逃げ・先行/不利=差し・追込になること(ハイでも差しが不利)",
    ({ horses }) => {
      const d = buildRaceDevelopment(horses, "nar", "不良");
      expect(d.favoredStyles).toEqual(["逃げ", "先行"]);
      expect(d.disfavoredStyles).toEqual(["差し", "追込"]);
    },
  );

  it.each(["不良", "不"])(
    "地方(nar)・馬場状態の表記ゆれ(%s)でも不良として同一挙動になること",
    (trackCondition) => {
      const d = buildRaceDevelopment(mediumHorses, "nar", trackCondition);
      expect(d.favoredStyles).toEqual(["逃げ", "先行"]);
      expect(d.disfavoredStyles).toEqual(["差し", "追込"]);
    },
  );

  it("地方(nar)でtrackCondition=nullは通常馬場表になること(不良ルール非適用)", () => {
    const d = buildRaceDevelopment(mediumHorses, "nar", null);
    expect(d.favoredStyles).toEqual(["逃げ", "先行"]);
    expect(d.disfavoredStyles).toEqual(["追込"]);
  });

  it("地方(nar)でtrackCondition省略(第3引数なし)も通常馬場表になること", () => {
    const d = buildRaceDevelopment(mediumHorses, "nar");
    expect(d.favoredStyles).toEqual(["逃げ", "先行"]);
    expect(d.disfavoredStyles).toEqual(["追込"]);
  });

  it.each(["稍重", "重", "良"])(
    "地方(nar)・馬場状態=%sは不良ではないため通常馬場表になること",
    (trackCondition) => {
      const d = buildRaceDevelopment(mediumHorses, "nar", trackCondition);
      expect(d.favoredStyles).toEqual(["逃げ", "先行"]);
      expect(d.disfavoredStyles).toEqual(["追込"]);
    },
  );
});
