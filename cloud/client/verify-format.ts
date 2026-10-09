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
