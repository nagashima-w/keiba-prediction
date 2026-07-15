/**
 * 結果テーブルの表示整形(純関数)。
 *
 * 確率のパーセント表示・オッズ/EVの桁揃え・欠損のダッシュ化・EVプラス行の判定を
 * 見た目(JSX)から切り離して純関数化する。表示規則をここに集約し、単体テストで固定する。
 */

import type {
  AnalysisRow,
  OddsStatus,
  PredictionMark,
} from "../shared/analysis-types.js";

/**
 * 事前推定値(scorer の prior)の表示ラベル。
 * ユーザー要望により、画面では出力がパッとわかるよう「3着内率」と表記する
 * (内部のコード識別子 prior は変更しない)。
 */
export const LABEL_PRIOR = "3着内率";

/**
 * LLM補正後確率の表示ラベル。「AI補正後」と表記して、AIが補正した値であることを明示する。
 */
export const LABEL_ADJUSTED_PROB = "AI補正後";

/** 妙味スコアを小数第2位まで表示する。対象外(null)は "-"。 */
export function formatOpportunityScore(score: number | null): string {
  return score === null ? "-" : score.toFixed(2);
}

/** 0〜1の確率を小数第1位までのパーセント文字列にする(例: 0.423 → "42.3%")。 */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** 複勝オッズ下限を小数第1位まで表示する。欠損(null)は "-"。 */
export function formatOdds(oddsMin: number | null): string {
  return oddsMin === null ? "-" : oddsMin.toFixed(1);
}

/** 期待値を小数第2位まで表示する。欠損(null)は "-"。 */
export function formatEv(ev: number | null): string {
  return ev === null ? "-" : ev.toFixed(2);
}

/** LLM根拠を表示する。無い(null)場合は "-"。 */
export function formatReason(reason: string | null): string {
  return reason === null ? "-" : reason;
}

/**
 * 予想印(Task#23)を表示する。印があればそのまま、無い(null)場合は空欄。
 * 「-」ではなく空欄にするのは、印は「無いのが普通」の列であり、他列の「値が取れなかった」
 * ダッシュ表示と混同させないため。
 */
export function formatMark(mark: PredictionMark | null): string {
  return mark ?? "";
}

/**
 * 予想印の凡例(結果テーブルの列見出し title 属性に使う短文)。
 * ◎本命/〇対抗/▲単穴/△連下/☆穴(勝ち目)/注 穴(3着)の意味を簡潔に示す。
 */
export const MARK_LEGEND =
  "◎本命/〇対抗/▲単穴/△連下/☆穴(勝ち目)/注 穴(3着)";

/** EVプラス行(ハイライト対象)かどうか。 */
export function isHighlightRow(row: AnalysisRow): boolean {
  return row.isPositive;
}

/**
 * オッズ発売状態の注記文言。確定(result)は注記不要のため null。
 * - "middle": 発売中の暫定オッズである旨。
 * - "yoso":   発売前のため単勝オッズからの推定EVである旨(Task#25)。
 *   複勝オッズ発売後に再分析すれば確定EVで上書きされる(既存の「レースごと最新分析」挙動)。
 */
export function oddsStatusNote(status: OddsStatus): string | null {
  switch (status) {
    case "middle":
      return "オッズは発売中(暫定)";
    case "yoso":
      return "発売前のため予想単勝オッズからの推定EV(発売後に再分析推奨)";
    default:
      return null;
  }
}

/**
 * 推定EVの表記接尾辞(Task#25)。evEstimated=true のときだけ「(推定)」を返し、
 * 確定EVとの区別をEV列に明示する。false のときは空文字(通常表示に何も付け足さない)。
 */
export function formatEstimatedEvSuffix(evEstimated: boolean): string {
  return evEstimated ? "(推定)" : "";
}

/**
 * レース見出し(Task#29)。「会場名 + レース番号R + (レース名があれば付す)」の形式で組み立てる。
 *
 * raceName はスクレイピング元(netkeiba)で発売前の地方レース等に空文字になり得るため、
 * raceName に依存せず「会場名+レース番号」だけでも必ずレースを識別できるようにする
 * (raceName が空なら末尾を付けず、会場名+レース番号のみを返す)。
 * 一括分析画面の各セクション(妙味レースランキング/レース別ハイライト/レースごとの詳細)と
 * Discordサマリで共有し、レース見出しの表記が個別実装ごとにばらつかないようにする。
 */
export function raceHeading(input: {
  readonly venueName: string;
  readonly raceNumber: number;
  readonly raceName: string;
}): string {
  const base = `${input.venueName} ${input.raceNumber}R`;
  // 空白のみのレース名も「実質空」として扱う(暗黙の前提=スクレイピング側でtrim済み、に
  // 依存しないための防御的な trim)。
  const raceName = input.raceName.trim();
  return raceName === "" ? base : `${base} ${raceName}`;
}
