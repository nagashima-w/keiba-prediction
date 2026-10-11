/**
 * 検証画面の表示整形(Issue #219。純関数)。**exe の検証画面(`packages/app/src/renderer/verify-format.ts`)と同じ出力**にする
 * (率は小数第 1 位のパーセント、金額は 3 桁区切りの円)。exe の renderer は app の閉包(React ほか)で cloud から引けないため、同じ関数をここに持ち、
 * ルートの `scripts/test/cloud-verify-format.test.ts` が exe 版との出力の一致を固定する。
 */
/**
 * 型は api-verify.ts から引かず、ここで構造的に宣言する(ルートの `scripts/test/` が exe の整形と比べるためにこのファイルを import する。api-verify.ts を引くと、
 * ルートの型検査〈moduleResolution: nodenext〉が cloud/client の拡張子なしの import を解決できず落ちる)。`api-verify.ts` の型はこれを満たす。
 */
export type ProposedBetType = "place" | "win" | "wide" | "trio" | "quinella" | "exacta" | "trifecta" | "bracketQuinella";

/** 集計の内訳に要る 6 つの件数。 */
export interface ExclusionCounts {
  readonly includedAnalysisCount: number;
  readonly excludedAnalysisCount: number;
  readonly supersededAnalysisCount: number;
  readonly excludedEstimatedCount: number;
  readonly excludedLookaheadSuspectCount: number;
  readonly excludedLookaheadUnknownCount: number;
}

/** 0〜1 の割合を小数第 1 位のパーセント文字列にする。null は "-"。 */
export function formatRate(rate: number | null): string {
  return rate === null ? "-" : `${(rate * 100).toFixed(1)}%`;
}

/** 金額を 3 桁区切りの円表記にする(例: 1060 → "1,060円")。`toLocaleString("en-US")` はロケールに依らず同じ(桁区切りの `,`)。 */
export function formatYen(amount: number): string {
  return `${amount.toLocaleString("en-US")}円`;
}

/** 実配当/近似の内訳(例: "実配当 3件 / 近似 1件")。 */
export function formatPayoutBreakdown(bet: { readonly actualPayoutCount: number; readonly approximatePayoutCount: number }): string {
  return `実配当 ${bet.actualPayoutCount}件 / 近似 ${bet.approximatePayoutCount}件`;
}

/** 集計の内訳(集計件数と、除外した件数の理由別)の行。exe の `formatExclusionSummary` を ` / ` で区切る前の項目に分けたもの(順序・文言は同じ)。 */
export function exclusionRows(report: ExclusionCounts): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  return [
    { label: "集計", value: `${report.includedAnalysisCount}件` },
    { label: "結果未取込で除外", value: `${report.excludedAnalysisCount}件` },
    { label: "旧分析除外", value: `${report.supersededAnalysisCount}件` },
    { label: "発売前推定のため除外", value: `${report.excludedEstimatedCount}件` },
    { label: "リーク疑い(発走後に分析・先読み未遮断)のため除外", value: `${report.excludedLookaheadSuspectCount}件` },
    { label: "発走前後を判定できず除外", value: `${report.excludedLookaheadUnknownCount}件` },
  ];
}

/** 配分ベースの券種の表示順と名前(exe の検証画面の「内訳」の並び)。 */
export const PROPOSED_BET_LABELS: ReadonlyArray<{ readonly type: ProposedBetType; readonly label: string }> = [
  { type: "place", label: "複勝" },
  { type: "win", label: "単勝" },
  { type: "wide", label: "ワイド" },
  { type: "quinella", label: "馬連" },
  { type: "bracketQuinella", label: "枠連" },
  { type: "exacta", label: "馬単" },
  { type: "trio", label: "3連複" },
  { type: "trifecta", label: "三連単" },
];

/**
 * 未知の券種コードの注記。`count===0` は null。exe の `formatUnknownBetTypeNotice` と同じ文言(点数だけでなく賭け金合計・券種コードも示す)。
 */
export function formatUnknownBetTypeNotice(unknown: { readonly count: number; readonly totalStake: number; readonly betTypes: readonly string[] }): string | null {
  if (unknown.count === 0) return null;
  return `未対応の券種コード(${unknown.betTypes.join("、")})の買い目が${unknown.count}点 (賭け金合計${formatYen(unknown.totalStake)})あり、回収率の集計から除外しています。`;
}

/** 区分の表示名(exe の `venueFilterLabel` と同じ)。 */
export function venueLabel(venue: "all" | "central" | "nar"): string {
  switch (venue) {
    case "all":
      return "全体";
    case "central":
      return "中央のみ";
    case "nar":
      return "地方のみ";
  }
}

// ---------------------------------------------------------------------------
// Issue #220: 補正方向×結果・キャリブレーション・印別的中率・プロンプト版別比較の整形(exe の同名の関数と同じ出力。一致は scripts/test/cloud-verify-format.test.ts)
// ---------------------------------------------------------------------------

/** 補正方向。 */
export type AdjustmentDirectionName = "raised" | "lowered" | "unchanged";

/** 補正方向を日本語ラベルにする。 */
export function directionLabel(direction: AdjustmentDirectionName): string {
  switch (direction) {
    case "raised":
      return "上げ";
    case "lowered":
      return "下げ";
    case "unchanged":
      return "据え置き";
  }
}

/** 補正幅・過信バイアス(0〜1 スケールの確率差)を符号付きポイント表示にする(例: 0.052 → "+5.2pt"、-0.031 → "-3.1pt")。null は "-"。 */
export function formatAdjustment(value: number | null): string {
  if (value === null) {
    return "-";
  }
  const pt = value * 100;
  const sign = pt >= 0 ? "+" : "";
  return `${sign}${pt.toFixed(1)}pt`;
}

/** 過信バイアス(代表予測値−実複勝率)の符号のラベル。正は「過信」、負は「過小評価」、0 ちょうどは「一致」、null は "-"。 */
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

/** 印別的中率の印表示。印なし(null)は「印なし」。 */
export function markLabel(mark: string | null): string {
  return mark === null ? "印なし" : mark;
}

/** 確率帯ラベル(例: 下限 0.4・上限 0.5 → "40〜50%")。 */
export function formatBinRange(bin: { readonly lowerBound: number; readonly upperBound: number }): string {
  const lower = Math.round(bin.lowerBound * 100);
  const upper = Math.round(bin.upperBound * 100);
  return `${lower}〜${upper}%`;
}

/** 帯グラフの幅(%)。複勝率(0〜1)を 0〜100 に写す。null は 0。 */
export function calibrationBarWidthPercent(rate: number | null): number {
  return rate === null ? 0 : rate * 100;
}

/** プロンプト版番号の表示。版不明(null)は「版不明」。 */
export function promptVersionLabel(promptVersion: string | null): string {
  return promptVersion === null ? "版不明" : promptVersion;
}

/** 追加指示の 1 件を 30 文字までに切り詰める(超過分は「…」)。 */
function truncateInstruction(instruction: string): string {
  const LIMIT = 30;
  return instruction.length > LIMIT ? `${instruction.slice(0, LIMIT)}…` : instruction;
}

/** 版内で使われた追加指示の要約。空配列・[null] は「なし」、各要素は 30 文字で切り、複数は「 / 」で連ねる(null は「なし」)。 */
export function additionalInstructionsSummary(instructions: readonly (string | null)[]): string {
  if (instructions.length === 0) {
    return "なし";
  }
  return instructions.map((instruction) => (instruction === null ? "なし" : truncateInstruction(instruction))).join(" / ");
}

/** 版内で使われた追加指示の全文(切り詰めなし。null は「なし」)。 */
export function additionalInstructionsFullText(instructions: readonly (string | null)[]): string {
  if (instructions.length === 0) {
    return "なし";
  }
  return instructions.map((instruction) => (instruction === null ? "なし" : instruction)).join(" / ");
}

/** 版別キャリブレーションの見出し(版番号+追加指示の要約)。 */
export function promptVersionCalibrationHeading(promptVersion: string | null, additionalInstructions: readonly (string | null)[]): string {
  return `${promptVersionLabel(promptVersion)} (追加指示: ${additionalInstructionsSummary(additionalInstructions)})`;
}
