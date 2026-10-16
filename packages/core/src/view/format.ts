/**
 * 結果テーブルの表示整形(純関数)。
 *
 * 確率のパーセント表示・オッズ/EVの桁揃え・欠損のダッシュ化・EVプラス行の判定を
 * 見た目(JSX)から切り離して純関数化する。表示規則をここに集約し、単体テストで固定する。
 */

import type {
  AnalysisRow,
  ConditionChangeTagView,
  OddsStatus,
  PredictionMark,
} from "../analysis/analysis-types.js";

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
 * 強調材料・懸念事項のラベル(Issue #199・#196-b)。クラウド版の画面(`cloud/client/result.ts` が再 export)と
 * 文言を揃えるための共有定数。色だけで区別しないため、箇条書きの見出しとして文字で出す。
 */
export const LABEL_HIGHLIGHTS = "強調材料";
export const LABEL_CONCERNS = "懸念事項";

/** LLM根拠セルの箇条書き1塊(強調材料・懸念事項)。 */
export interface ReasonCellSection {
  readonly kind: "highlights" | "concerns";
  readonly label: string;
  readonly items: readonly string[];
}

/** LLM根拠セルの表示内容(Issue #199)。 */
export interface ReasonCellView {
  /** 総合の根拠(`formatReason` と同じ。null は「-」)。 */
  readonly reason: string;
  /** 項目が1つ以上ある塊だけ。順番は強調材料 → 懸念事項。2つとも空なら `[]`(= 従来どおり reason だけの表示)。 */
  readonly sections: readonly ReasonCellSection[];
}

/**
 * LLM根拠セル(結果表の「LLM根拠」列)の表示内容を組み立てる(Issue #199)。
 * 順番は reason → 強調材料 → 懸念事項。空文字・空白だけの項目は捨てる(残りの文字列は加工しない。
 * クラウド版の `pointsOf` と同じ)。項目がすべて捨てられた塊は出さない。
 * reason が null でも、項目があれば「-」のあとに続ける(LLM が効かなかった馬は配列も `[]` なので、通常この組合せは起きない)。
 */
export function buildReasonCellView(row: Pick<AnalysisRow, "reason" | "highlights" | "concerns">): ReasonCellView {
  const keep = (items: readonly string[]): readonly string[] => items.filter((item) => item.trim() !== "");
  const candidates: readonly ReasonCellSection[] = [
    { kind: "highlights", label: LABEL_HIGHLIGHTS, items: keep(row.highlights) },
    { kind: "concerns", label: LABEL_CONCERNS, items: keep(row.concerns) },
  ];
  return { reason: formatReason(row.reason), sections: candidates.filter((section) => section.items.length > 0) };
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
 * 印の補修(Issue #317)で印が変わった馬の目印。結果画面・通知で、印の横に小さく出す。
 */
export const MARK_REPAIRED_BADGE = "直";

/**
 * 補修前の印の語彙(固定): 既知の6種(◎〇▲△☆注。core の `PREDICTION_MARKS` と同じ順)、「なし」(印が無かった馬に補修で印が付いた)、
 * 「不明」(未知の印文字だった馬。LLM の生の文字列は保存も表示もしない)。クライアントの束に parse-response を引き込まないため、ここに持つ
 * (`test/view/format.test.ts` が `PREDICTION_MARKS` との一致を固定する)。
 */
export const MARK_ORIGIN_VALUES = ["◎", "〇", "▲", "△", "☆", "注", "なし", "不明"] as const;

/**
 * 印の補修の表示「元の印→今の印」(Issue #317)。例: 「◎→〇」「☆→印なし」「印なし→◎」「不明な印→印なし」。
 * @param from 補修前の印({@link MARK_ORIGIN_VALUES} のいずれか)
 * @param to 補修後の印(印なしは null)
 */
export function formatMarkRepair(from: string, to: string | null): string {
  const fromText = from === "なし" ? "印なし" : from === "不明" ? "不明な印" : from;
  return `${fromText}→${to ?? "印なし"}`;
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
 * 条件替わり(妙味材料)タグを表示用テキストに整形する(「・」区切り)。
 * タグが無い(空配列)場合は空文字を返す。UIはこれを利用して、タグが無いときは
 * バッジ等のノイズを一切出さず、既存の表示のままにする(タグの並び順は呼び出し側
 * 〈core computeConditionChangeTags〉がサーフェス→距離→開催の固定順で渡す前提)。
 */
export function formatConditionChangeTags(
  tags: readonly ConditionChangeTagView[],
): string {
  return tags.map((t) => t.label).join("・");
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
 * 分析結果の「分析モデル: …」行の文言(Issue #157)。LLM を実行し、モデルIDが分かるときだけ返す。
 * LLMスキップ時は(model が入っていても)null: スキップした分析にモデル名を出すと偽の表示になる。
 * モデル不明(null・未設定・空文字)も null(行自体を出さない)。
 */
export function analysisModelText(result: {
  readonly llmUsed: boolean;
  readonly model?: string | null;
}): string | null {
  if (!result.llmUsed) return null;
  if (typeof result.model !== "string" || result.model === "") return null;
  return `分析モデル: ${result.model}`;
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
