import type { BreakdownSectionView, CalibrationBinView, CloseComparisonView, PromptVersionView, VerifyReportView } from "../client/api-verify";

/**
 * Issue #220: 検証画面のテストが共有する、キャリブレーション(20 帯)と補正傾向の見本。
 * 帯の下限は i/20(0〜5%、…、95〜100%)。**値は『表示が値によって変わる』ように、件数 0 の帯・過信・過小評価・ちょうど一致の帯を混ぜてある**。
 * 過信バイアス = 代表予測値(帯の中央)− 実複勝率(core の `CalibrationBiasBin` と同じ定義)。
 */
export function calibrationFixture(): CalibrationBinView[] {
  // mean: 帯内の予測の平均(Issue #254)。件数 30 以上の帯(4・6・14)は、信頼区間と予測の平均の関係が 3 通りになるようにしてある(下のコメント)。
  const filled: Record<number, { predicted: number; placed: number; mean: number }> = {
    2: { predicted: 4, placed: 0, mean: 0.12 }, // 10〜15%: 実 0%(過信)。件数 4 なので判定は『件数不足』
    4: { predicted: 200, placed: 46, mean: 0.226 }, // 20〜25%: 実 23.0%、95%区間 17.7〜29.3% に平均予測 22.6% が入る(整合)
    6: { predicted: 120, placed: 24, mean: 0.331 }, // 30〜35%: 実 20.0%、95%区間 13.8〜28.0% の上に平均予測 33.1%(予測が高い)
    8: { predicted: 12, placed: 5, mean: 0.43 }, // 40〜45%: 実 41.7%
    10: { predicted: 10, placed: 7, mean: 0.53 }, // 50〜55%: 実 70%(過小評価)
    12: { predicted: 8, placed: 5, mean: 0.625 }, // 60〜65%: 実 62.5%(平均予測 62.5% と一致。予測−実績は +0.0pt の「一致」)
    14: { predicted: 40, placed: 36, mean: 0.72 }, // 70〜75%: 実 90.0%、95%区間 76.9〜96.0% の下に平均予測 72.0%(予測が低い)
    19: { predicted: 1, placed: 1, mean: 0.97 }, // 95〜100%
  };
  return Array.from({ length: 20 }, (_, i) => {
    const f = filled[i];
    return { lowerBound: i / 20, upperBound: (i + 1) / 20, predictedCount: f?.predicted ?? 0, placedCount: f?.placed ?? 0, actualPlaceRate: f === undefined ? null : f.placed / f.predicted, meanPredictedProb: f?.mean ?? null };
  });
}

/**
 * 補正前(prior)の対応表の見本(Issue #254)。補正後の `calibrationFixture` とは別の帯・別の件数にしてある(取り違えを検出できる)。
 * 件数 29 と 30 の境界(判定が『件数不足』になる最大と、判定が出る最小)を含む。
 */
export function priorCalibrationFixture(): CalibrationBinView[] {
  const filled: Record<number, { predicted: number; placed: number; mean: number }> = {
    3: { predicted: 300, placed: 48, mean: 0.172 }, // 15〜20%: 実 16.0%、95%区間 12.3〜20.6% に平均予測 17.2% が入る(整合)
    5: { predicted: 100, placed: 40, mean: 0.275 }, // 25〜30%: 実 40.0%、95%区間 30.9〜49.8% の下に平均予測 27.5%(予測が低い)
    9: { predicted: 29, placed: 10, mean: 0.47 }, // 45〜50%: 件数 29(30 未満なので判定は『件数不足』。区間は 19.9〜52.7%)
    10: { predicted: 30, placed: 5, mean: 0.52 }, // 50〜55%: 件数 30(判定が出る最小)。実 16.7%、95%区間 7.3〜33.6% の上に平均予測 52.0%(予測が高い)
  };
  return Array.from({ length: 20 }, (_, i) => {
    const f = filled[i];
    return { lowerBound: i / 20, upperBound: (i + 1) / 20, predictedCount: f?.predicted ?? 0, placedCount: f?.placed ?? 0, actualPlaceRate: f === undefined ? null : f.placed / f.predicted, meanPredictedProb: f?.mean ?? null };
  });
}

/** 補正傾向の見本(`calibrationFixture` と添字で対応する過信バイアスを含む)。 */
export function trendFixture(): VerifyReportView["trend"] {
  const bins = calibrationFixture();
  return {
    directionGroups: [
      { direction: "raised", count: 40, actualPlaceRate: 0.55, averageAdjustment: 0.052 },
      { direction: "lowered", count: 30, actualPlaceRate: 0.2, averageAdjustment: -0.031 },
      { direction: "unchanged", count: 0, actualPlaceRate: null, averageAdjustment: null },
    ],
    calibrationBias: bins.map((b) => ({ overconfidenceGap: b.actualPlaceRate === null ? null : (b.lowerBound + b.upperBound) / 2 - b.actualPlaceRate })),
    markStats: [
      { mark: "◎", count: 20, placeRate: 0.65, winRate: 0.3 },
      { mark: "〇", count: 18, placeRate: 0.5, winRate: 0.1666 },
      { mark: "▲", count: 0, placeRate: null, winRate: null },
      { mark: "△", count: 10, placeRate: 0.3, winRate: 0 },
      { mark: "☆", count: 2, placeRate: 1, winRate: 0.5 },
      { mark: "注", count: 1, placeRate: 0, winRate: 0 },
      { mark: null, count: 100, placeRate: 0.2, winRate: 0.05 },
    ],
  };
}

/**
 * プロンプト版別比較の見本(版は 3 つ: 追加指示が 2 種〈長い指示と「なし」〉の版・クリップ幅の別版・版不明)。
 * 2 つ目の版は帯の件数がすべて 0(過信バイアスも全部 null)、3 つ目は賭け 0 点(回収率 null)の退化した形。
 */
export const LONG_INSTRUCTION = "逃げ馬を重視して、前走で出遅れた馬は評価を下げること。(あ)(い)(う)(え)(お)";

export function versionsFixture(): PromptVersionView[] {
  const bins = calibrationFixture();
  const priorBins = priorCalibrationFixture();
  const gaps = trendFixture().calibrationBias.map((b) => b.overconfidenceGap);
  const emptyBins = bins.map((b) => ({ ...b, predictedCount: 0, placedCount: 0, actualPlaceRate: null, meanPredictedProb: null }));
  // Issue #271: 版ごとの補正前の対応表と Brier。集計件数(レース数)が 30 以上の版〈80〉は Brier を出し、30 未満の版〈25・15〉は値があっても出さない(版 3 は値を持たせて、隠していることを検出できるようにする)。
  return [
    { promptVersion: "2026-10-09.2", additionalInstructions: [LONG_INSTRUCTION, null], includedAnalysisCount: 80, bet: { betCount: 52, totalStake: 5200, totalReturn: 4994, recoveryRate: 0.9603846 }, calibration: bins, priorCalibration: priorBins, quality: { evaluatedCount: 395, priorBrier: 0.1661, adjustedBrier: 0.1655 }, overconfidenceGaps: gaps },
    { promptVersion: "2026-10-09.2-clip015", additionalInstructions: [null], includedAnalysisCount: 25, bet: { betCount: 10, totalStake: 1000, totalReturn: 1250, recoveryRate: 1.25 }, calibration: emptyBins, priorCalibration: emptyBins, quality: { evaluatedCount: 0, priorBrier: null, adjustedBrier: null }, overconfidenceGaps: emptyBins.map(() => null) },
    { promptVersion: null, additionalInstructions: [null], includedAnalysisCount: 15, bet: { betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null }, calibration: bins, priorCalibration: priorBins, quality: { evaluatedCount: 150, priorBrier: 0.1802, adjustedBrier: 0.1799 }, overconfidenceGaps: gaps },
  ];
}

/**
 * 締切直前の再計算との比較の見本(Issue #352)。回 1(5 分前): ok 12 件/対象 15 件(30 件未満=参考)・再計算のほうが回収率が高い。
 * 回 2(直前): ok 30 件/対象 31 件(ちょうど 30 件=参考の印が付かない境界)・再計算のほうが低い。**値は行ごとに違う**(取り違えを検出できる)。
 */
export function closeFixture(): CloseComparisonView {
  return {
    // 説明文と基準ごとの見出しの語は、Issue #379 からサーバが組み立てて渡す(クライアントは表示するだけ)。
    description: "サーバが組み立てた説明文です。区分のタブに合わせて集計します。",
    rounds: [
      { round: 1, basisLabel: null, leadMinutes: 5, okCount: 12, targetCount: 15, base: { betCount: 30, totalStake: 12000, totalReturn: 10800, recoveryRate: 0.9 }, recalc: { betCount: 28, totalStake: 11000, totalReturn: 12100, recoveryRate: 1.1 } },
      { round: 2, basisLabel: null, leadMinutes: 2, okCount: 30, targetCount: 31, base: { betCount: 70, totalStake: 30000, totalReturn: 33000, recoveryRate: 1.1 }, recalc: { betCount: 65, totalStake: 29000, totalReturn: 26100, recoveryRate: 0.9 } },
    ],
  };
}

/**
 * 人気帯ごとの期待値と回収率の見本(Issue #384)。サーバが組み立てた文字列をそのまま持つ(クライアントは整形しない)。
 * 2 つの節: 行が 2 本(うち 1 本は買い目なしで項目が 1 つ)の節と、行が 0 本の節(退化した形)。**値は節・行ごとに違う**(取り違えを検出できる)。
 */
export function breakdownFixture(): BreakdownSectionView[] {
  return [
    {
      heading: "人気帯ごとの期待値と回収率(複勝)",
      description: "サーバが組み立てた説明文(複勝)",
      note: "サーバが組み立てた注記(複勝)",
      rows: [
        { label: "1〜3番人気", cells: [{ name: "件数(レース)", value: "2点(1R)" }, { name: "予想した期待値", value: "115.0%" }, { name: "実際の回収率", value: "162.5%" }, { name: "注意", value: "参考(30レース未満)" }] },
        { label: "4〜6番人気", cells: [{ name: "件数(レース)", value: "0点(0R)" }] },
      ],
    },
    { heading: "単勝人気と複勝順位のずれ", description: "サーバが組み立てた説明文(ずれ)", note: "サーバが組み立てた注記(ずれ)", rows: [] },
  ];
}
