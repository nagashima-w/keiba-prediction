import type { CalibrationBinView, PromptVersionView, VerifyReportView } from "../client/api-verify";

/**
 * Issue #220: 検証画面のテストが共有する、キャリブレーション(20 帯)と補正傾向の見本。
 * 帯の下限は i/20(0〜5%、…、95〜100%)。**値は『表示が値によって変わる』ように、件数 0 の帯・過信・過小評価・ちょうど一致の帯を混ぜてある**。
 * 過信バイアス = 代表予測値(帯の中央)− 実複勝率(core の `CalibrationBiasBin` と同じ定義)。
 */
export function calibrationFixture(): CalibrationBinView[] {
  const filled: Record<number, { predicted: number; placed: number }> = {
    2: { predicted: 4, placed: 0 }, // 10〜15%: 実 0%(過信)
    8: { predicted: 12, placed: 5 }, // 40〜45%: 実 41.7%
    10: { predicted: 10, placed: 7 }, // 50〜55%: 実 70%(過小評価)
    12: { predicted: 8, placed: 5 }, // 60〜65%: 実 62.5%(代表 62.5% と一致)
    19: { predicted: 1, placed: 1 }, // 95〜100%
  };
  return Array.from({ length: 20 }, (_, i) => {
    const f = filled[i];
    return { lowerBound: i / 20, upperBound: (i + 1) / 20, predictedCount: f?.predicted ?? 0, placedCount: f?.placed ?? 0, actualPlaceRate: f === undefined ? null : f.placed / f.predicted };
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
  const gaps = trendFixture().calibrationBias.map((b) => b.overconfidenceGap);
  const emptyBins = bins.map((b) => ({ ...b, predictedCount: 0, placedCount: 0, actualPlaceRate: null }));
  return [
    { promptVersion: "2026-10-09.2", additionalInstructions: [LONG_INSTRUCTION, null], includedAnalysisCount: 80, bet: { betCount: 52, totalStake: 5200, totalReturn: 4994, recoveryRate: 0.9603846 }, calibration: bins, overconfidenceGaps: gaps },
    { promptVersion: "2026-10-09.2-clip015", additionalInstructions: [null], includedAnalysisCount: 25, bet: { betCount: 10, totalStake: 1000, totalReturn: 1250, recoveryRate: 1.25 }, calibration: emptyBins, overconfidenceGaps: emptyBins.map(() => null) },
    { promptVersion: null, additionalInstructions: [null], includedAnalysisCount: 15, bet: { betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null }, calibration: bins, overconfidenceGaps: gaps },
  ];
}
