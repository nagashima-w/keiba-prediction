import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JointModelHorse } from "../../src/ev/place-joint-model.js";
import {
  buildProbabilityQualityReport,
  type ProbabilityQualityReportInput,
} from "../../src/ev/probability-quality.js";
// 低レベル関数は公開エントリポイント(probability-quality.ts)からは意図的に到達不能にした
// (受け入れ条件5'。code-reviewer指摘)。core自身のテストはパッケージ境界の内側なので、
// 内部ファイルへの直接パスでimportする。
import {
  computeMarketImpliedPlaceProbabilities,
  computeTrioAllPointEvOverPayoutRate,
  computeVarianceRatioMetrics,
  normalizedKlDivergenceFromUniform,
  normalizedTrioJointKlDivergence,
  spearmanRankCorrelation,
} from "../../src/ev/probability-quality-metrics.js";
import type { SnapshotFilterDiagnostics } from "../../src/scorer/snapshot-filter.js";

/**
 * probability-quality — 確率の質を測る計測基盤(#40「#35-1a」)。
 * 本モジュールは prior/同時分布モデル/EVの挙動には一切手を入れない「測るだけ」の純関数群。
 * ここでは合成データによる境界値テストのみを行う(実フィクスチャを使った回帰テスト・
 * runAnalysisを駆動するリーク遮断の前後比較は scripts/test 側の担当)。
 */

/**
 * `findInvalidProbabilityReason`(明示的なNaN/Infinity/負値検証)が返す理由文字列に
 * 必ず含まれる固定の目印。NaN・Infinity・負値の注入テストで「狙った明示的な検証ガードで
 * 落ちたか」を精密に確認するために使う。
 *
 * **なぜ必要か(code-reviewer指摘・boss確認)**: `computeMaxMinRatio` は明示検証の他に
 * `min > 0` という既存の偶発的なガードも持つ。NaN・負値はいずれも `Math.min(...)` を
 * NaN または非正の値にするため、明示検証を無効化するミューテーションを入れても
 * `min > 0` ガードにすり替わって `value: null` のまま通ってしまう(reasonの中身を見ない限り
 * 区別できない)。一方 Infinity は min 側を汚さない(max 側だけを汚す)ため、
 * `min > 0` ガードでは捕まらず明示検証だけが頼りになる。この非対称があるため、
 * 「NaN・Infinity・負値のいずれを注入しても reason はこの目印を含む」ことまで固定しないと、
 * 狙ったガードの検証になっていない(#40で繰り返し指摘された「テストが何かを守っていると
 * 言えるか」の教訓)。
 */
const INVALID_PROBABILITY_MARKER = "値が不正(NaN・Infinity・負値";

// ---------------------------------------------------------------------------
// spearmanRankCorrelation
// ---------------------------------------------------------------------------

describe("spearmanRankCorrelation", () => {
  it("完全に順位が一致する場合はρ=1", () => {
    expect(spearmanRankCorrelation([1, 2, 3, 4], [10, 20, 30, 40]).value).toBeCloseTo(1, 10);
  });

  it("完全に順位が逆転する場合はρ=-1", () => {
    expect(spearmanRankCorrelation([1, 2, 3, 4], [40, 30, 20, 10]).value).toBeCloseTo(-1, 10);
  });

  it("同順位(タイ)を平均順位法で補正した非自明な値を検算する", () => {
    // x=[1,2,2,3] → 順位[1, 2.5, 2.5, 4]。y=[1,2,3,3] → 順位[1, 2, 3.5, 3.5]。
    // 手計算: mean=2.5/2.5, Σdxdy=3.75, Σdx²=4.5, Σdy²=4.5 → ρ=3.75/4.5=5/6。
    const result = spearmanRankCorrelation([1, 2, 2, 3], [1, 2, 3, 3]);
    expect(result.value).toBeCloseTo(5 / 6, 10);
    expect(result.reason).toBeNull();
  });

  it("頭数が2未満なら定義できずnull", () => {
    const result = spearmanRankCorrelation([1], [1]);
    expect(result.value).toBeNull();
    expect(result.reason).not.toBeNull();
  });

  it("全馬同一priorのときはρを定義できずnull(0を返さない)", () => {
    const result = spearmanRankCorrelation([0.2, 0.2, 0.2], [0.1, 0.5, 0.9]);
    expect(result.value).toBeNull();
    expect(result.reason).toContain("同順位");
  });

  it("入力2系列の長さが一致しなければnull", () => {
    const result = spearmanRankCorrelation([1, 2], [1, 2, 3]);
    expect(result.value).toBeNull();
  });

  // --- NaN/Infinity/負値の防御(code-reviewer指摘・boss実測で再現) ---------------------

  it("NaNが1つ混入しても符号反転した「もっともらしい値」を返さずnull+理由になる", () => {
    // 正常系(boss実測の再現条件): [0.3,0.26,0.2,0.25] vs [0.28,0.31,0.19,0.22] → ρ=0.8。
    const normal = spearmanRankCorrelation([0.3, 0.26, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]);
    expect(normal.value).toBeCloseTo(0.8, 10);
    expect(normal.reason).toBeNull();

    // NaNを1つ混入: 修正前は value=-0.6 (符号反転) が reason:null で返っていた(実測済みバグ)。
    const withNaN = spearmanRankCorrelation([0.3, NaN, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]);
    expect(withNaN.value).toBeNull();
    // 明示的な検証(findInvalidProbabilityReason)で弾かれたことを目印で確認する
    // (他のnullガード〈長さ不一致・タイ〉と混同していないことの担保)。
    expect(withNaN.reason).toContain(INVALID_PROBABILITY_MARKER);
    expect(withNaN.reason).toContain("系列a");
  });

  it("Infinityが混入した場合もnull+理由になる", () => {
    const result = spearmanRankCorrelation([0.3, Infinity, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]);
    expect(result.value).toBeNull();
    expect(result.reason).toContain(INVALID_PROBABILITY_MARKER);
  });

  it("負値が混入した場合もnull+理由になる", () => {
    const result = spearmanRankCorrelation([0.3, -0.1, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]);
    expect(result.value).toBeNull();
    expect(result.reason).toContain(INVALID_PROBABILITY_MARKER);
  });

  it("市場側(第2引数)のNaN混入も検出する(片側だけの防御にしない)", () => {
    const result = spearmanRankCorrelation([0.3, 0.26, 0.2, 0.25], [0.28, NaN, 0.19, 0.22]);
    expect(result.value).toBeNull();
    expect(result.reason).toContain(INVALID_PROBABILITY_MARKER);
    expect(result.reason).toContain("系列b");
  });

  it("0は不正値ではない(有限かつ非負のため素通りする)", () => {
    const result = spearmanRankCorrelation([0, 0.26, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]);
    expect(result.value).not.toBeNull();
    expect(result.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeVarianceRatioMetrics
// ---------------------------------------------------------------------------

describe("computeVarianceRatioMetrics", () => {
  it("市場側の標準偏差が0ならsdRatioはゼロ除算でnull(max/min比は別途計算される)", () => {
    const result = computeVarianceRatioMetrics([0.1, 0.2, 0.3], [5, 5, 5]);
    expect(result.sdRatio.value).toBeNull();
    expect(result.sdRatio.reason).not.toBeNull();
    // maxMinRatioMarketはsd=0でも0除算にはならない(min=max=5>0のため計算できる)。
    expect(result.maxMinRatioMarket.value).toBeCloseTo(1, 10);
  });

  it("通常ケースのsd比・max/min比を検算する", () => {
    const result = computeVarianceRatioMetrics([0.2, 0.4], [0.1, 0.5]);
    // model sd=0.1, market sd=0.2 → sdRatio=0.5。
    expect(result.sdRatio.value).toBeCloseTo(0.5, 10);
    expect(result.maxMinRatioModel.value).toBeCloseTo(2, 10);
    expect(result.maxMinRatioMarket.value).toBeCloseTo(5, 10);
  });

  it("最小値が0以下のときmax/min比はゼロ除算でnull(明示検証ではなくmin>0ガードで止まったことを区別する)", () => {
    // 0は有限かつ非負なのでfindInvalidProbabilityReasonは通過する。ここでnullになるのは
    // min>0ガードだけであり、明示検証のガードとは別物であることを理由文字列で区別する。
    const result = computeVarianceRatioMetrics([0, 0.5], [0.1, 0.2]);
    expect(result.maxMinRatioModel.value).toBeNull();
    expect(result.maxMinRatioModel.reason).toContain("最小値が0以下");
    expect(result.maxMinRatioModel.reason).not.toContain(INVALID_PROBABILITY_MARKER);
  });

  // --- NaN/Infinity/負値の防御(code-reviewer指摘・boss実測で再現) ---------------------
  //
  // computeMaxMinRatioは明示検証(findInvalidProbabilityReason)の他に「min>0」という
  // 既存の偶発的なガードも持つ。NaN・負値はMath.min(...)をNaNまたは非正の値にするため、
  // 明示検証を無効化しても「min>0」ガードにすり替わってvalue:nullのまま通ってしまう
  // (reasonの中身を見ないと区別できない)。Infinityはmin側を汚さないため「min>0」では
  // 捕まらず明示検証だけが頼りになる。この非対称があるため、NaN・Infinity・負値の
  // いずれについても reason が INVALID_PROBABILITY_MARKER を含むことまで固定する
  // (code-reviewer指摘: yoso分岐のテストがこの区別をしておらず検出力を持たなかった)。

  it("modelにNaNが混入すると、sdMarket===0判定をすり抜けた「もっともらしい値」を返さずnull+明示検証由来の理由になる", () => {
    // 修正前はNaN/0.05(有限)→NaNとなり、JSON.stringifyでNaNがnullに化けるため
    // 「value:null, reason:null」というreason無しの結果として観測された(boss実測)。
    const result = computeVarianceRatioMetrics([0.3, NaN, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]);
    expect(result.sdRatio.value).toBeNull();
    expect(result.sdRatio.reason).toContain(INVALID_PROBABILITY_MARKER);
    expect(result.maxMinRatioModel.value).toBeNull();
    expect(result.maxMinRatioModel.reason).toContain(INVALID_PROBABILITY_MARKER);
    // 市場側は無傷なので、市場側だけで完結するmaxMinRatioMarketは正常に計算できる。
    expect(result.maxMinRatioMarket.value).not.toBeNull();
    expect(result.maxMinRatioMarket.reason).toBeNull();
  });

  it("modelにInfinityが混入した場合もnull+明示検証由来の理由になる(min>0ガードでは捕まらないため明示検証が唯一の頼り)", () => {
    const result = computeVarianceRatioMetrics([0.3, Infinity, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]);
    expect(result.sdRatio.value).toBeNull();
    expect(result.sdRatio.reason).toContain(INVALID_PROBABILITY_MARKER);
    expect(result.maxMinRatioModel.value).toBeNull();
    expect(result.maxMinRatioModel.reason).toContain(INVALID_PROBABILITY_MARKER);
  });

  it("modelに負値が混入した場合もnull+明示検証由来の理由になる", () => {
    const result = computeVarianceRatioMetrics([0.3, -0.1, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]);
    expect(result.sdRatio.value).toBeNull();
    expect(result.sdRatio.reason).toContain(INVALID_PROBABILITY_MARKER);
    expect(result.maxMinRatioModel.value).toBeNull();
    expect(result.maxMinRatioModel.reason).toContain(INVALID_PROBABILITY_MARKER);
  });

  it("市場側にNaNが混入した場合もnull+明示検証由来の理由になる(片側だけの防御にしない)", () => {
    const result = computeVarianceRatioMetrics([0.3, 0.26, 0.2, 0.25], [0.28, NaN, 0.19, 0.22]);
    expect(result.sdRatio.value).toBeNull();
    expect(result.sdRatio.reason).toContain(INVALID_PROBABILITY_MARKER);
    expect(result.maxMinRatioMarket.value).toBeNull();
    expect(result.maxMinRatioMarket.reason).toContain(INVALID_PROBABILITY_MARKER);
    // モデル側は無傷なのでmaxMinRatioModelは正常に計算できる(粒度: 片側の異常がもう片側を巻き込まない)。
    expect(result.maxMinRatioModel.value).not.toBeNull();
  });

  it("value:null のとき reason は必ず非nullである(不変条件。全パターンを横断確認)", () => {
    const cases: readonly [readonly number[], readonly number[]][] = [
      [[0.3, NaN, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]],
      [[0.3, Infinity, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]],
      [[0.3, -Infinity, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]],
      [[0.3, -0.1, 0.2, 0.25], [0.28, 0.31, 0.19, 0.22]],
      [[5, 5, 5], [0.1, 0.2, 0.3]], // sdMarket正常だがsdModel=0(分散比自体は算出できるケース、対照)
      [[0.1, 0.2, 0.3], [5, 5, 5]], // sdMarket=0
    ];
    for (const [model, market] of cases) {
      const result = computeVarianceRatioMetrics(model, market);
      for (const m of [result.sdRatio, result.maxMinRatioModel, result.maxMinRatioMarket]) {
        if (m.value === null) {
          expect(m.reason).not.toBeNull();
          expect(typeof m.reason).toBe("string");
        } else {
          expect(Number.isFinite(m.value)).toBe(true);
          expect(m.reason).toBeNull();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// normalizedKlDivergenceFromUniform / normalizedTrioJointKlDivergence
// ---------------------------------------------------------------------------

describe("normalizedKlDivergenceFromUniform", () => {
  it("組合せ数が1以下ならnull(log(組数)<=0)", () => {
    expect(normalizedKlDivergenceFromUniform([1]).value).toBeNull();
    expect(normalizedKlDivergenceFromUniform([]).value).toBeNull();
  });

  it("一様分布ならKL=0", () => {
    const result = normalizedKlDivergenceFromUniform([0.25, 0.25, 0.25, 0.25]);
    expect(result.value).toBeCloseTo(0, 10);
  });

  it("1点に確率が集中する分布は正規化KL=1(最大乖離)", () => {
    const result = normalizedKlDivergenceFromUniform([1, 0, 0, 0]);
    expect(result.value).toBeCloseTo(1, 10);
  });

  it("確率0の要素は0・log0=0の慣例でNaNにならず正しく計算される", () => {
    // 0.5,0.5,0,0(m=4) → KL = log(2) → 正規化 = log(2)/log(4) = 0.5。
    const result = normalizedKlDivergenceFromUniform([0.5, 0.5, 0, 0]);
    expect(Number.isNaN(result.value)).toBe(false);
    expect(result.value).toBeCloseTo(0.5, 10);
  });

  it("NaN・Infinity・負値が混入した場合はnull+明示検証由来の理由になる(もっともらしい値を返さない)", () => {
    // この関数は明示検証を通過した後は無条件にmetricOkを返す(検証後にvalueをnull化する
    // 別ガードが存在しない)ため、value===nullの一致だけでも実は明示検証の効果を検出できるが、
    // 「どのガードで止まったか」を他関数と揃えて明示しておく(code-reviewer指摘3の横断点検)。
    const withNaN = normalizedKlDivergenceFromUniform([0.5, NaN, 0.25, 0.25]);
    expect(withNaN.value).toBeNull();
    expect(withNaN.reason).toContain(INVALID_PROBABILITY_MARKER);

    const withInf = normalizedKlDivergenceFromUniform([0.5, Infinity, 0.25, 0.25]);
    expect(withInf.value).toBeNull();
    expect(withInf.reason).toContain(INVALID_PROBABILITY_MARKER);

    const withNegative = normalizedKlDivergenceFromUniform([0.5, -0.1, 0.25, 0.25]);
    expect(withNegative.value).toBeNull();
    expect(withNegative.reason).toContain(INVALID_PROBABILITY_MARKER);
  });
});

describe("normalizedTrioJointKlDivergence", () => {
  function evenHorses(n: number, placeProb: number): JointModelHorse[] {
    return Array.from({ length: n }, (_, i) => ({ umaban: i + 1, placeProb }));
  }

  it("頭数が3未満ならnull(組合せを構成できない)", () => {
    expect(normalizedTrioJointKlDivergence(evenHorses(2, 0.5)).value).toBeNull();
    expect(normalizedTrioJointKlDivergence([]).value).toBeNull();
  });

  it("3頭ちょうどは組が1通り(m=1)でnull。頭数<3とは異なる理由になる", () => {
    const result = normalizedTrioJointKlDivergence(evenHorses(3, 0.9));
    expect(result.value).toBeNull();
    expect(result.reason).toContain("組合せ数");
  });

  it("4頭・全馬同一確率なら同時分布は一様になりKL=0", () => {
    // 全馬の重みが等しいため、条件付きベルヌーイモデルはC(4,3)=4通りを均等に割り振る。
    const result = normalizedTrioJointKlDivergence(evenHorses(4, 0.75));
    expect(result.value).toBeCloseTo(0, 8);
  });

  it("4頭・確率が偏っている場合は一様分布からの乖離が生じる(>0)", () => {
    const skewed: JointModelHorse[] = [
      { umaban: 1, placeProb: 0.9 },
      { umaban: 2, placeProb: 0.9 },
      { umaban: 3, placeProb: 0.9 },
      { umaban: 4, placeProb: 0.3 },
    ];
    const result = normalizedTrioJointKlDivergence(skewed);
    expect(result.value).not.toBeNull();
    expect(result.value!).toBeGreaterThan(0.01);
  });

  it("中央16頭・地方12頭のいずれの頭数でも同一関数が適用できる(スケール不変性の前提)", () => {
    const central = normalizedTrioJointKlDivergence(evenHorses(16, 3 / 16));
    const nar = normalizedTrioJointKlDivergence(evenHorses(12, 3 / 12));
    expect(central.value).toBeCloseTo(0, 6);
    expect(nar.value).toBeCloseTo(0, 6);
  });

  it("placeProbにNaNが混入すると、CONDITIONAL_BERNOULLI_MODELの一様分布フォールバックにより「KL=0(正常な均等分布)」という尤もらしい値へ化けさせず、事前にnull+明示検証由来の理由で弾く", () => {
    // 検証: 明示検証を無効化した場合、buildDistributionのNaNフォールバック(均等分布)により
    // value=0(reason:null)という「尤もらしい」実数が漏れる(toBeNull()が正しく落ちるため
    // value側だけでも検出できるが、狙ったガードを明示するためreasonの中身も固定する)。
    const horses: JointModelHorse[] = [
      { umaban: 1, placeProb: NaN },
      { umaban: 2, placeProb: 0.75 },
      { umaban: 3, placeProb: 0.75 },
      { umaban: 4, placeProb: 0.75 },
    ];
    const result = normalizedTrioJointKlDivergence(horses);
    expect(result.value).toBeNull();
    expect(result.reason).toContain(INVALID_PROBABILITY_MARKER);
  });

  it("placeProbにInfinity・負値が混入した場合もnull+明示検証由来の理由になる", () => {
    // 検証: 明示検証を無効化した場合、place-joint-model.tsのclamp(EPS,1-EPS)により
    // Infinity/負値は正常な有限値に丸められてしまい、KLは尤もらしい実数になる
    // (value側でも検出できるが、reasonで狙ったガードを明示する)。
    const withInf = normalizedTrioJointKlDivergence([
      { umaban: 1, placeProb: Infinity },
      { umaban: 2, placeProb: 0.75 },
      { umaban: 3, placeProb: 0.75 },
      { umaban: 4, placeProb: 0.75 },
    ]);
    expect(withInf.value).toBeNull();
    expect(withInf.reason).toContain(INVALID_PROBABILITY_MARKER);

    const withNegative = normalizedTrioJointKlDivergence([
      { umaban: 1, placeProb: -0.1 },
      { umaban: 2, placeProb: 0.75 },
      { umaban: 3, placeProb: 0.75 },
      { umaban: 4, placeProb: 0.75 },
    ]);
    expect(withNegative.value).toBeNull();
    expect(withNegative.reason).toContain(INVALID_PROBABILITY_MARKER);
  });
});

// ---------------------------------------------------------------------------
// computeMarketImpliedPlaceProbabilities
// ---------------------------------------------------------------------------

describe("computeMarketImpliedPlaceProbabilities", () => {
  it("oddsStatus=yoso相当(複勝オッズが全馬null)は算出不能(受け入れ条件・必須テスト観点)", () => {
    const result = computeMarketImpliedPlaceProbabilities([
      { umaban: 1, placeOddsMin: null },
      { umaban: 2, placeOddsMin: null },
      { umaban: 3, placeOddsMin: null },
    ]);
    expect(result.values).toBeNull();
    expect(result.reason).toContain("yoso");
  });

  it("1頭でも複勝オッズ下限が欠損・不正ならレース全体を算出不能にする", () => {
    const result = computeMarketImpliedPlaceProbabilities([
      { umaban: 1, placeOddsMin: 2 },
      { umaban: 2, placeOddsMin: 0 }, // 不正(0以下)
      { umaban: 3, placeOddsMin: 4 },
    ]);
    expect(result.values).toBeNull();
    expect(result.reason).toContain("馬番2");
  });

  it(
    "1頭でも複勝オッズ下限が値域外(1.0未満だが0より大きい)ならレース全体を算出不能にする" +
      "(Issue #74: isUsableOddsへ委譲する前は`odds<=0`のみを見ており(0,1)を素通りさせていた)",
    () => {
      const result = computeMarketImpliedPlaceProbabilities([
        { umaban: 1, placeOddsMin: 2 },
        { umaban: 2, placeOddsMin: 0.5 }, // #74: 値域外(1.0未満)。0より大きいが不正。
        { umaban: 3, placeOddsMin: 4 },
      ]);
      expect(result.values).toBeNull();
      expect(result.reason).toContain("馬番2");
    },
  );

  it("通常ケース(3頭)はΣ=3に正規化される", () => {
    const result = computeMarketImpliedPlaceProbabilities([
      { umaban: 1, placeOddsMin: 2 },
      { umaban: 2, placeOddsMin: 4 },
      { umaban: 3, placeOddsMin: 4 },
    ]);
    expect(result.values).not.toBeNull();
    const values = result.values!;
    expect(values.get(1)).toBeCloseTo(1.5, 10);
    expect(values.get(2)).toBeCloseTo(0.75, 10);
    expect(values.get(3)).toBeCloseTo(0.75, 10);
    const sum = [...values.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(3, 10);
  });

  it("頭数が3未満のレースはΣ=頭数に正規化される", () => {
    const result = computeMarketImpliedPlaceProbabilities([
      { umaban: 1, placeOddsMin: 2 },
      { umaban: 2, placeOddsMin: 4 },
    ]);
    const sum = [...result.values!.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(2, 10);
  });

  it("出走馬が0頭ならnull", () => {
    expect(computeMarketImpliedPlaceProbabilities([]).values).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeTrioAllPointEvOverPayoutRate(三連複専用。ワイドに適用しない)
// ---------------------------------------------------------------------------

describe("computeTrioAllPointEvOverPayoutRate", () => {
  it("頭数が3未満ならnull", () => {
    const result = computeTrioAllPointEvOverPayoutRate(
      [{ umaban: 1, placeProb: 0.5 }],
      new Map(),
    );
    expect(result.ratio).toBeNull();
    expect(result.diagnostics.enumeratedCount).toBe(0);
  });

  it("4頭・全組present・均等確率均等オッズなら平均EV=払戻率推定値でratio=1", () => {
    const horses: JointModelHorse[] = [
      { umaban: 1, placeProb: 0.75 },
      { umaban: 2, placeProb: 0.75 },
      { umaban: 3, placeProb: 0.75 },
      { umaban: 4, placeProb: 0.75 },
    ];
    const odds = new Map<string, number | null>([
      ["010203", 4],
      ["010204", 4],
      ["010304", 4],
      ["020304", 4],
    ]);
    const result = computeTrioAllPointEvOverPayoutRate(horses, odds);
    expect(result.diagnostics.presentCount).toBe(4);
    expect(result.diagnostics.enumeratedCount).toBe(4);
    expect(result.ratio).toBeCloseTo(1, 8);
    expect(result.averageEv).toBeCloseTo(1, 8);
    expect(result.estimatedPayoutRate).toBeCloseTo(1, 8);
  });

  it("unfetched/missing/malformedの組は分母(平均EV・払戻率推定の両方)に混ぜない(受け入れ条件7)", () => {
    // 4頭・均等確率(各組の的中確率は厳密に0.25)。010203のみオッズ取得済み(present)、
    // 010204はmissing(null)、010304はMapにキー自体が無くunfetched、020304はmalformed(0以下)。
    const horses: JointModelHorse[] = [
      { umaban: 1, placeProb: 0.75 },
      { umaban: 2, placeProb: 0.75 },
      { umaban: 3, placeProb: 0.75 },
      { umaban: 4, placeProb: 0.75 },
    ];
    const odds = new Map<string, number | null>([
      ["010203", 4],
      ["010204", null], // missing
      ["020304", -1], // malformed
      // "010304" はキー自体が無い → unfetched
    ]);
    const result = computeTrioAllPointEvOverPayoutRate(horses, odds);
    expect(result.diagnostics.enumeratedCount).toBe(4);
    expect(result.diagnostics.presentCount).toBe(1);
    expect(result.diagnostics.missingCount).toBe(1);
    expect(result.diagnostics.unfetchedCount).toBe(1);
    expect(result.diagnostics.malformedCount).toBe(1);
    // present=010203のみ: 確率0.25・オッズ4 → 平均EV=1、Σ(1/odds)=0.25→payoutRate=4、ratio=0.25。
    expect(result.averageEv).toBeCloseTo(1, 10);
    expect(result.estimatedPayoutRate).toBeCloseTo(4, 10);
    expect(result.ratio).toBeCloseTo(0.25, 10);
  });

  it("present な組が0件ならnull(全組が未取得・欠損・不正)", () => {
    const horses: JointModelHorse[] = [
      { umaban: 1, placeProb: 0.75 },
      { umaban: 2, placeProb: 0.75 },
      { umaban: 3, placeProb: 0.75 },
      { umaban: 4, placeProb: 0.75 },
    ];
    const result = computeTrioAllPointEvOverPayoutRate(horses, new Map());
    expect(result.ratio).toBeNull();
    expect(result.diagnostics.presentCount).toBe(0);
    expect(result.diagnostics.unfetchedCount).toBe(4);
  });

  it("placeProbにNaN・Infinity・負値が混入した場合はnull+明示検証由来の理由になる(オッズが正常でも計算しない)", () => {
    // 検証: 明示検証を無効化した場合、buildDistributionのフォールバック/clampにより
    // 尤もらしい実数のratioが漏れる(オッズは全組present)。value側でも検出できるが、
    // reasonで狙ったガードを明示する。
    const odds = new Map<string, number | null>([
      ["010203", 4],
      ["010204", 4],
      ["010304", 4],
      ["020304", 4],
    ]);
    for (const bad of [NaN, Infinity, -0.1]) {
      const horses: JointModelHorse[] = [
        { umaban: 1, placeProb: bad },
        { umaban: 2, placeProb: 0.75 },
        { umaban: 3, placeProb: 0.75 },
        { umaban: 4, placeProb: 0.75 },
      ];
      const result = computeTrioAllPointEvOverPayoutRate(horses, odds);
      expect(result.ratio).toBeNull();
      expect(result.averageEv).toBeNull();
      expect(result.estimatedPayoutRate).toBeNull();
      expect(result.reason).toContain(INVALID_PROBABILITY_MARKER);
    }
  });
});

// ---------------------------------------------------------------------------
// ワイドへの誤用防止(受け入れ条件6)。実測フィクスチャで「紛らわしい一致」を固定する。
// ---------------------------------------------------------------------------

describe("ワイドへの誤用防止", () => {
  function loadFixtureOdds(): { wideCombo: Record<string, number | null>; trioCombo: Record<string, number | null> } {
    const url = new URL(
      "../../../../docs/investigations/combo-odds-real-fetch/central-on.json",
      import.meta.url,
    );
    const raw = JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as {
      odds: { wideCombo?: Record<string, number | null>; trioCombo?: Record<string, number | null> };
    };
    return { wideCombo: raw.odds.wideCombo ?? {}, trioCombo: raw.odds.trioCombo ?? {} };
  }

  it("Σ(1/wideOddsMin)を三連複の恒等式のように読むと、trioの実測控除率と紛らわしく近い値になる", () => {
    // 実測(このテスト自身が算出する。自分で走らせて得た値):
    // Σ(1/wideOddsMin) ≈ 3.9579 → 誤って「1/払戻率」と読むと還元率 ≈ 25.27%。
    // 三連複側の実際の控除率(1 - 1/Σ(1/trioOdds)) ≈ 25.02%。
    // 両者は近いが**同じ量ではない**(ワイドは1レース3組同時的中のため恒等式が成立しない。
    // ワイドの「還元率25.27%」という値自体はワイドの払戻率の推定値ではなく、無意味な数値)。
    const { wideCombo, trioCombo } = loadFixtureOdds();

    const wideValues = Object.values(wideCombo).filter((v): v is number => v !== null);
    const trioValues = Object.values(trioCombo).filter((v): v is number => v !== null);
    // 前提: 実フィクスチャが空でないこと(空だと以降のΣが0になり無条件に成立してしまう)。
    expect(wideValues.length).toBeGreaterThan(0);
    expect(trioValues.length).toBeGreaterThan(0);

    const sumInverseWide = wideValues.reduce((s, v) => s + 1 / v, 0);
    const sumInverseTrio = trioValues.reduce((s, v) => s + 1 / v, 0);

    const wideWrongPayoutReading = 1 / sumInverseWide; // 誤用: ワイドに三連複の恒等式を当てはめた場合の読み
    const trioActualDeductionRate = 1 - 1 / sumInverseTrio; // 三連複の実際の控除率

    // 自分で実行して得た値の固定(回帰)。
    expect(sumInverseWide).toBeCloseTo(3.957911758522152, 6);
    expect(wideWrongPayoutReading).toBeCloseTo(0.252658487862, 6);
    expect(trioActualDeductionRate).toBeCloseTo(0.250224339821, 6);

    // 「紛らわしい一致」: 0.5ポイント以内に近接する。
    expect(Math.abs(wideWrongPayoutReading - trioActualDeductionRate)).toBeLessThan(0.005);
    // しかし同一の値ではない(=読み替えて良い根拠にはならない)。
    expect(wideWrongPayoutReading).not.toBeCloseTo(trioActualDeductionRate, 4);
  });

  it("computeTrioAllPointEvOverPayoutRateにワイドのオッズMapを渡しても、キー長不一致で全組unfetchedとなり暴走しない", () => {
    const { wideCombo } = loadFixtureOdds();
    const wideOddsMap = new Map<string, number | null>(Object.entries(wideCombo));
    // 16頭・複勝圏内確率は適当な一様値(モデル側の値自体はこのテストの主眼ではない)。
    const horses: JointModelHorse[] = Array.from({ length: 16 }, (_, i) => ({
      umaban: i + 1,
      placeProb: 3 / 16,
    }));
    const result = computeTrioAllPointEvOverPayoutRate(horses, wideOddsMap);
    // ワイドのキーは4桁("0102")、三連複が要求するキーは6桁("010203")のため一切一致せず、
    // 全組がunfetchedになり、誤った数値を静かに返すのではなくnullで安全に倒れる。
    expect(result.ratio).toBeNull();
    expect(result.diagnostics.unfetchedCount).toBe(result.diagnostics.enumeratedCount);
    expect(result.diagnostics.presentCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildProbabilityQualityReport(唯一のエントリポイント。conditions同梱を担保)
// ---------------------------------------------------------------------------

describe("buildProbabilityQualityReport", () => {
  function baseInput(overrides: Partial<ProbabilityQualityReportInput> = {}): ProbabilityQualityReportInput {
    return {
      horses: [
        { umaban: 1, modelProb: 0.6, placeOddsMin: 1.5 },
        { umaban: 2, modelProb: 0.5, placeOddsMin: 2.0 },
        { umaban: 3, modelProb: 0.4, placeOddsMin: 3.0 },
        { umaban: 4, modelProb: 0.2, placeOddsMin: 8.0 },
      ],
      oddsStatus: "result",
      trioComboOdds: new Map([
        ["010203", 4],
        ["010204", 10],
        ["010304", 12],
        ["020304", 20],
      ]),
      priorSource: "prior-only",
      leakFilter: null,
      ...overrides,
    };
  }

  it("oddsStatus=yosoでは市場系指標がすべて算出不能になり、モデル側の指標は影響を受けない(必須テスト観点)", () => {
    const input = baseInput({
      oddsStatus: "yoso",
      horses: [
        { umaban: 1, modelProb: 0.6, placeOddsMin: null },
        { umaban: 2, modelProb: 0.5, placeOddsMin: null },
        { umaban: 3, modelProb: 0.4, placeOddsMin: null },
        { umaban: 4, modelProb: 0.2, placeOddsMin: null },
      ],
    });
    const report = buildProbabilityQualityReport(input);

    expect(report.conditions.oddsStatus).toBe("yoso");
    expect(report.marketImpliedPlaceProbabilities.values).toBeNull();
    expect(report.spearmanRho.value).toBeNull();
    expect(report.spearmanRho.reason).not.toBeNull();
    expect(report.sdRatio.value).toBeNull();
    expect(report.maxMinRatioMarket.value).toBeNull();
    expect(report.normalizedJointKlMarket.value).toBeNull();

    // モデル側(市場データに依存しない指標)は算出できる。
    expect(report.maxMinRatioModel.value).not.toBeNull();
    expect(report.normalizedJointKlModel.value).not.toBeNull();
    expect(report.trioAllPointEvOverPayoutRate.ratio).not.toBeNull();
  });

  it("conditionsは入力から自動導出され、priorSourceだけが申告どおりに反映される", () => {
    const report = buildProbabilityQualityReport(baseInput({ priorSource: "llm-adjusted" }));
    expect(report.conditions.priorSource).toBe("llm-adjusted");
    expect(report.conditions.oddsStatus).toBe("result");
    expect(report.conditions.fieldSize).toBe(4);
    expect(report.conditions.leakFilterApplied).toBe(false);
    expect(report.conditions.cutoffDate).toBeNull();
    expect(report.conditions.removedResultCount).toBeNull();
    expect(report.conditions.placeOddsKind).toBe("placeOddsMinLowerBound");
    expect(report.conditions.trioComboOddsKind).toBe("trioComboSingleValue");
  });

  it("leakFilterに実際の診断値を渡すと、conditionsのリーク遮断情報が自動導出される", () => {
    const diagnostics: SnapshotFilterDiagnostics = {
      cutoffDate: "2026/06/28",
      totalResultCount: 60,
      removedCount: 16,
      removedByCutoffCount: 16,
      removedByInvalidDateCount: 0,
      perHorse: [],
    };
    const report = buildProbabilityQualityReport(baseInput({ leakFilter: diagnostics }));
    expect(report.conditions.leakFilterApplied).toBe(true);
    expect(report.conditions.cutoffDate).toBe("2026/06/28");
    expect(report.conditions.removedResultCount).toBe(16);
  });

  // --- NaN/Infinity/負値の防御を集約関数経由でも確認する(code-reviewer指摘3) -------------
  // 「低レベル関数だけ直しても、集約側で別経路があれば意味がない」への対応。
  // buildProbabilityQualityReportはmaxMinRatioModelを yoso 分岐で maxMinRatio へ**直接**
  // 渡す経路を持ち(computeVarianceRatioMetricsを経由しない)、この経路の防御漏れが
  // 実際に過去に起きていたため、oddsStatus=yosoの場合も明示的に確認する。

  describe("NaN・Infinity・負値混入時の防御(集約関数経由)", () => {
    it("modelProbにNaNが混入すると、市場データが正常でも該当するモデル系指標すべてがnull+明示検証由来の理由になる", () => {
      const report = buildProbabilityQualityReport(
        baseInput({
          horses: [
            { umaban: 1, modelProb: NaN, placeOddsMin: 1.5 },
            { umaban: 2, modelProb: 0.5, placeOddsMin: 2.0 },
            { umaban: 3, modelProb: 0.4, placeOddsMin: 3.0 },
            { umaban: 4, modelProb: 0.2, placeOddsMin: 8.0 },
          ],
        }),
      );
      expect(report.spearmanRho.value).toBeNull();
      expect(report.spearmanRho.reason).toContain(INVALID_PROBABILITY_MARKER);
      expect(report.sdRatio.value).toBeNull();
      expect(report.sdRatio.reason).toContain(INVALID_PROBABILITY_MARKER);
      expect(report.maxMinRatioModel.value).toBeNull();
      expect(report.maxMinRatioModel.reason).toContain(INVALID_PROBABILITY_MARKER);
      expect(report.normalizedJointKlModel.value).toBeNull();
      expect(report.normalizedJointKlModel.reason).toContain(INVALID_PROBABILITY_MARKER);
      expect(report.trioAllPointEvOverPayoutRate.ratio).toBeNull();
      expect(report.trioAllPointEvOverPayoutRate.reason).toContain(INVALID_PROBABILITY_MARKER);

      // 市場側(placeOddsMinは全馬正常)は影響を受けない。
      expect(report.maxMinRatioMarket.value).not.toBeNull();
      expect(report.normalizedJointKlMarket.value).not.toBeNull();
    });

    it("oddsStatus=yoso分岐(maxMinRatioを直接呼ぶ別経路)でNaN・Infinity・負値のいずれもが漏れない(code-reviewer指摘への是正)", () => {
      // yoso分岐はcomputeVarianceRatioMetricsを経由せずcomputeMaxMinRatio(modelProbs)を
      // 直接呼ぶため、この経路だけ検証漏れが起きうる(過去に実際に発生した欠陥の形)。
      //
      // 【code-reviewer指摘への是正】NaNだけを注入するテストは、computeMaxMinRatio内部の
      // 「min>0」という別ガード(NaNはMath.min(...)をNaNにし、!(NaN>0)がtrueになるため
      // 偶発的にnullを返す)と結果が見分けられず、明示検証(findInvalidProbabilityReason)を
      // 無効化しても本テストは通ってしまっていた(実測: code-reviewerが再現)。
      // そこで(1)Infinity(min側を汚さずmax側だけを汚すため、min>0ガードでは捕まらず
      // 明示検証だけが頼りになる)を追加し、(2)すべてのケースでreasonが
      // INVALID_PROBABILITY_MARKERを含むことまで固定して、狙ったガードで止まったことを
      // 明示検証の理由文字列で確認する(min>0ガードの理由文字列「最小値が0以下…」とは
      // 別物であることが、この文字列一致で担保される)。
      for (const bad of [NaN, Infinity, -0.1]) {
        const report = buildProbabilityQualityReport(
          baseInput({
            oddsStatus: "yoso",
            horses: [
              { umaban: 1, modelProb: bad, placeOddsMin: null },
              { umaban: 2, modelProb: 0.5, placeOddsMin: null },
              { umaban: 3, modelProb: 0.4, placeOddsMin: null },
              { umaban: 4, modelProb: 0.2, placeOddsMin: null },
            ],
          }),
        );
        expect(report.maxMinRatioModel.value).toBeNull();
        expect(report.maxMinRatioModel.reason).toContain(INVALID_PROBABILITY_MARKER);
      }
    });

    it("value:null のとき reason は必ず非nullである(不変条件。レポート全体を横断確認)", () => {
      const reportNormal = buildProbabilityQualityReport(baseInput());
      const reportWithNaN = buildProbabilityQualityReport(
        baseInput({
          horses: [
            { umaban: 1, modelProb: NaN, placeOddsMin: 1.5 },
            { umaban: 2, modelProb: 0.5, placeOddsMin: 2.0 },
            { umaban: 3, modelProb: 0.4, placeOddsMin: 3.0 },
            { umaban: 4, modelProb: 0.2, placeOddsMin: 8.0 },
          ],
        }),
      );
      for (const report of [reportNormal, reportWithNaN]) {
        const metrics = [
          report.spearmanRho,
          report.sdRatio,
          report.maxMinRatioModel,
          report.maxMinRatioMarket,
          report.normalizedJointKlModel,
          report.normalizedJointKlMarket,
        ];
        for (const m of metrics) {
          if (m.value === null) {
            expect(m.reason).not.toBeNull();
            expect(typeof m.reason).toBe("string");
          } else {
            expect(Number.isFinite(m.value)).toBe(true);
            expect(m.reason).toBeNull();
          }
        }
        const trio = report.trioAllPointEvOverPayoutRate;
        if (trio.ratio === null) {
          expect(trio.reason).not.toBeNull();
          expect(trio.averageEv).toBeNull();
          expect(trio.estimatedPayoutRate).toBeNull();
        } else {
          expect(trio.reason).toBeNull();
          expect(Number.isFinite(trio.averageEv)).toBe(true);
          expect(Number.isFinite(trio.estimatedPayoutRate)).toBe(true);
        }
      }
    });
  });
});
