/**
 * 結果テーブルの表示整形(純関数)。
 *
 * 確率のパーセント表示・オッズ/EVの桁揃え・欠損のダッシュ化などを
 * 見た目(JSX)から切り離して純関数化する。表示規則をここに集約し、単体テストで固定する。
 */

import type { OddsStatus } from "../analysis/analysis-types.js";
import { PREDICTION_MARKS } from "../common/prediction-marks.js";

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

/**
 * 強調材料・懸念事項のラベル(Issue #199・#196-b)。クラウド版の画面(`cloud/client/result.ts` が再 export)と
 * 文言を揃えるための共有定数。色だけで区別しないため、箇条書きの見出しとして文字で出す。
 */
export const LABEL_HIGHLIGHTS = "強調材料";
export const LABEL_CONCERNS = "懸念事項";

/**
 * 印の補修(Issue #317)で印が変わった馬の目印。結果画面・通知で、印の横に小さく出す。
 */
export const MARK_REPAIRED_BADGE = "直";

/**
 * 補修前の印の語彙(固定): 既知の6種(◎〇▲△☆注。core の `PREDICTION_MARKS` そのもの)、「なし」(印が無かった馬に補修で印が付いた)、
 * 「不明」(未知の印文字だった馬。LLM の生の文字列は保存も表示もしない)。クライアントの束に parse-response を引き込まないため、
 * import のない共通部品 `common/prediction-marks.ts` から取る(Issue #397・R-5。`test/view/format.test.ts` と `packages/core/test/common/prediction-marks.test.ts` が並びを固定する)。
 */
export const MARK_ORIGIN_VALUES = [...PREDICTION_MARKS, "なし", "不明"] as const;

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
