/**
 * 検証画面の表示整形(純関数)。
 *
 * 回収率・複勝率のパーセント表示、金額の桁区切り、キャリブレーション帯グラフの幅、
 * 実配当/近似の内訳注記を JSX から切り離してここに集約し、単体テストで固定する。
 */

import type {
  AdjustmentDirection,
  CalibrationBinView,
  PredictionMark,
  ProposedBetUnknownBetTypeView,
  VerifyBetView,
  VerifyReportView,
  VerifyVenueFilter,
} from "../analysis/analysis-types.js";

/** 0〜1の割合を小数第1位までのパーセント文字列にする。null は "-"。 */
export function formatRate(rate: number | null): string {
  return rate === null ? "-" : `${(rate * 100).toFixed(1)}%`;
}

/** 金額を3桁区切りの円表記にする(例: 1060 → "1,060円")。 */
export function formatYen(amount: number): string {
  return `${amount.toLocaleString("en-US")}円`;
}

/**
 * キャリブレーション帯グラフの幅(%)。複勝率(0〜1)を 0〜100 に写す。
 * 予測0件(actualPlaceRate=null)は幅0。
 */
export function calibrationBarWidthPercent(rate: number | null): number {
  return rate === null ? 0 : rate * 100;
}

/** 確率帯ラベル(例: 下限0.4/上限0.5 → "40〜50%")。 */
export function formatBinRange(bin: CalibrationBinView): string {
  const lower = Math.round(bin.lowerBound * 100);
  const upper = Math.round(bin.upperBound * 100);
  return `${lower}〜${upper}%`;
}

/** 実配当/近似の内訳注記(例: "実配当 3件 / 近似 1件")。 */
export function formatPayoutBreakdown(bet: VerifyBetView): string {
  return `実配当 ${bet.actualPayoutCount}件 / 近似 ${bet.approximatePayoutCount}件`;
}

/**
 * 未知の券種コードの注記(Issue #76)。`count===0`(未知券種行が1件も無い通常時)は`null`
 * (呼び出し側は戻り値を1回だけ受け取り、`!== null`を条件に描画するだけにできる。
 * exe の`VerifyView.tsx`(#287 で削除。3c1664e まで)の呼び出し箇所参照。`formatUnjudgedNote`〈exe の mixed-allocation-view.ts〉と
 * 同じ「0件なら注記を出さない」流儀)。
 * 点数だけでなくstake合計・実際に現れた券種コードも示す(点数だけでは「投資額がどれだけ
 * 静かに過小計上されているか」の規模が分からず、原因〈単勝なのか壊れた行なのか〉も判別できない)。
 */
export function formatUnknownBetTypeNotice(unknownBetType: ProposedBetUnknownBetTypeView): string | null {
  if (unknownBetType.count === 0) {
    return null;
  }
  return (
    `未対応の券種コード(${unknownBetType.betTypes.join("、")})の買い目が${unknownBetType.count}点 ` +
    `(賭け金合計${formatYen(unknownBetType.totalStake)})あり、回収率の集計から除外しています。`
  );
}

/**
 * 検証画面の集計の内訳(集計件数と、除外した件数の理由別内訳)の1行表示(Issue #152 B)。
 * 除外が0件の項目も出す(フィルタが有効であることが画面から分かるように)。
 * 「判定不能」という語は使わない(配分ベースの回収率の「判定不能」と混同させないため)。
 */
export function formatExclusionSummary(report: VerifyReportView): string {
  return (
    `集計${report.includedAnalysisCount}件 / 結果未取込で除外${report.excludedAnalysisCount}件 / ` +
    `旧分析除外${report.supersededAnalysisCount}件 / 発売前推定のため除外${report.excludedEstimatedCount}件 / ` +
    `リーク疑い(発走後に分析・先読み未遮断)のため除外${report.excludedLookaheadSuspectCount}件 / ` +
    `発走前後を判定できず除外${report.excludedLookaheadUnknownCount}件`
  );
}

/** 補正方向(raised/lowered/unchanged)を日本語ラベルにする(Task#26)。 */
export function directionLabel(direction: AdjustmentDirection): string {
  switch (direction) {
    case "raised":
      return "上げ";
    case "lowered":
      return "下げ";
    case "unchanged":
      return "据え置き";
  }
}

/**
 * 補正幅・過信バイアス(0〜1スケールの確率差)を符号付きポイント表示にする(Task#26)。
 * 例: 0.052 → "+5.2pt"、-0.031 → "-3.1pt"。null(件数0の群・予測0件の帯)は "-"。
 */
export function formatAdjustment(value: number | null): string {
  if (value === null) {
    return "-";
  }
  const pt = value * 100;
  const sign = pt >= 0 ? "+" : "";
  return `${sign}${pt.toFixed(1)}pt`;
}

/**
 * 過信バイアス(代表予測値−実複勝率)の符号をラベル化する(Task#26)。
 * 正なら「過信」(予測が実績を上回る)、負なら「過小評価」、0ちょうどなら「一致」。
 * null(予測0件の帯)は "-"。
 */
export function overconfidenceLabel(gap: number | null): string {
  if (gap === null) {
    return "-";
  }
  if (gap > 0) {
    return "過信";
  }
  if (gap < 0) {
    return "過小評価";
  }
  return "一致";
}

/** 印別的中率の印表示(Task#26)。印なし(null)は「印なし」。 */
export function markLabel(mark: PredictionMark | null): string {
  return mark === null ? "印なし" : mark;
}

/**
 * プロンプト版番号の表示(Task#27)。版不明(null。旧データ・LLM未使用の分析)は「版不明」。
 */
export function promptVersionLabel(promptVersion: string | null): string {
  return promptVersion === null ? "版不明" : promptVersion;
}

/** 検証画面の地域フィルタ(全体/中央のみ/地方のみ)の表示ラベル(Task#32)。 */
export function venueFilterLabel(venueFilter: VerifyVenueFilter): string {
  switch (venueFilter) {
    case "all":
      return "全体";
    case "central":
      return "中央のみ";
    case "nar":
      return "地方のみ";
  }
}

/** 追加指示の1件を30文字までに切り詰める(超過分は「…」に置き換える)。 */
function truncateInstruction(instruction: string): string {
  const LIMIT = 30;
  return instruction.length > LIMIT
    ? `${instruction.slice(0, LIMIT)}…`
    : instruction;
}

/**
 * 版内で使われた追加指示(core PromptVersionVerifyReport.additionalInstructions)を
 * 検証画面の版別比較テーブルに1セルで収まるよう整形する(Task#28)。
 * - データ無し(空配列)・追加指示なしのみ([null])は「なし」。
 * - 各要素は30文字を超えたら省略記号(…)で切り詰める。
 * - 複数件(追加指示なしの null を含む)は「 / 」区切りで並べ、null は「なし」として表示する。
 */
export function additionalInstructionsSummary(
  instructions: readonly (string | null)[],
): string {
  if (instructions.length === 0) {
    return "なし";
  }
  return instructions
    .map((instruction) =>
      instruction === null ? "なし" : truncateInstruction(instruction),
    )
    .join(" / ");
}

/**
 * 版内で使われた追加指示の省略なしフルテキスト(title属性・ツールチップ用、Task#28)。
 * additionalInstructionsSummary と違い30文字での切り詰めは行わない(全文表示が目的)。
 * null要素を単純に join(" / ") すると空文字として連結され、セル本文(additionalInstructionsSummary
 * は null を「なし」と表示する)と食い違う表示不整合が起きるため、こちらも null→「なし」変換してから
 * 連結する(code-reviewer提案対応)。
 */
export function additionalInstructionsFullText(
  instructions: readonly (string | null)[],
): string {
  if (instructions.length === 0) {
    return "なし";
  }
  return instructions
    .map((instruction) => (instruction === null ? "なし" : instruction))
    .join(" / ");
}

/**
 * プロンプト版別キャリブレーション表(D-1)の折りたたみ見出し。
 * 版番号(promptVersionLabel)にその版で使われた追加指示の要約(additionalInstructionsSummary)を
 * 併記し、「どの条件の較正か」を展開前から一目で分かるようにする。
 */
export function promptVersionCalibrationHeading(
  promptVersion: string | null,
  additionalInstructions: readonly (string | null)[],
): string {
  return `${promptVersionLabel(promptVersion)} (追加指示: ${additionalInstructionsSummary(additionalInstructions)})`;
}
