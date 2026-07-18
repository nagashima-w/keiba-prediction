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
  PromptVersionVerifyReportView,
  RaceBreakdownHorseView,
  RaceLedgerView,
  VerifyBetView,
  VerifyVenueFilter,
} from "../shared/analysis-types.js";

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
 * 取込ボタンを出す(再取込が必要)か。
 * 結果が未取込、または着順は取れているが複勝払戻が未取込(確定直前など)なら true。
 * 後者は実配当への更新導線を残すため、取込済み表示でもボタンを出し続ける。
 *
 * 引数は hasResult・hasPayout のみの構造的部分型(検証画面UI統合。RaceLedgerViewが
 * この2フィールドを持つためそのまま渡せる。特定の型に依存させず判定ロジックを1箇所に保つ)。
 */
export function needsImport(item: {
  readonly hasResult: boolean;
  readonly hasPayout: boolean;
}): boolean {
  return !item.hasResult || !item.hasPayout;
}

/**
 * 取込ボタンの文言。未取込は「結果を取り込む」、着順のみ取込(払戻待ち)は「再取込(払戻待ち)」。
 * 引数は hasResult のみの構造的部分型(needsImport と同じ理由)。
 */
export function importButtonLabel(item: {
  readonly hasResult: boolean;
}): string {
  return item.hasResult ? "再取込(払戻待ち)" : "結果を取り込む";
}

/**
 * レース一覧の行単位「取込」ボタンを無効化するか(Task#31 code-reviewer提案対応)。
 * その行自体が取込中の場合に加え、一括取込が実行中の場合も無効化する
 * (一括取込と同じレースへの行単位取込が競合して二重に保存されるのを防ぐため)。
 */
export function isRowImportDisabled(
  importing: boolean,
  bulkImportRunning: boolean,
): boolean {
  return importing || bulkImportRunning;
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

/**
 * プロンプト版別比較(state.reportsByPromptVersion)に版不明(promptVersion=null)グループが
 * 含まれるか(Task#33)。computeVerifyReportByPromptVersion(core)は分析が1件以上存在する版のみを
 * グループとして返す(空グループは作られない)ため、この判定はそのまま「削除対象の分析が存在するか」
 * の判定を兼ねる。削除ボタンの表示/有効化条件として使う。
 */
export function hasUnknownPromptVersionGroup(
  reports: readonly PromptVersionVerifyReportView[],
): boolean {
  return reports.some((r) => r.promptVersion === null);
}

/**
 * 版不明(promptVersion=null)グループに属する分析の総件数(Task#33)。
 * 削除確認ダイアログに表示する「版不明の分析N件」の N を、追加のIPC往復無しで
 * 既に読み込み済みの版別レポートから求める。
 *
 * VerifyReportView の4つの内訳(集計対象・結果未取込で除外・旧分析除外・推定EVのため除外)は
 * その版グループの分析集合を余さず分割する(selectIncludedAnalyses、core/ev/verify.ts)ため、
 * 4つの合計がその版(=prompt_version IS NULL)の analyses 総数と一致する
 * (AnalysisStore.deleteAnalysesWithUnknownPromptVersion が実際に削除する件数と同じ母集団)。
 * 版不明グループが無ければ0(削除対象なし)。
 */
export function unknownPromptVersionAnalysisCount(
  reports: readonly PromptVersionVerifyReportView[],
): number {
  const unknownGroup = reports.find((r) => r.promptVersion === null);
  if (unknownGroup === undefined) {
    return 0;
  }
  const { report } = unknownGroup;
  return (
    report.includedAnalysisCount +
    report.excludedAnalysisCount +
    report.supersededAnalysisCount +
    report.excludedEstimatedCount
  );
}

/**
 * 「版不明」の削除対象の説明(Task#33 code-reviewer指摘対応)。
 * prompt_version IS NULL は「版記録導入前(Task#27より前)の旧データ」と「APIキー未設定でLLMを
 * 使わずpriorをそのまま採用した現行分析」の両方を含み、DB上は区別できない(AnalysisStore.
 * deleteAnalysesWithUnknownPromptVersion のJSDoc参照)。確認・完了メッセージの両方で同じ説明を使い、
 * 削除対象の範囲をユーザーに明確に伝える。
 */
const UNKNOWN_PROMPT_VERSION_DESCRIPTION =
  "版不明(版記録導入前の旧データ、およびAPIキー未設定で実行したLLM未使用の分析)";

/**
 * 版不明分析の削除確認ダイアログのメッセージ(Task#33 code-reviewer指摘対応)。
 * 「取り消せません」という不可逆性の明示、削除対象の説明(旧データ+LLM未使用分析)、
 * 削除件数(分析N件+関連馬データ)を必ず含める。件数は呼び出し元が既に読み込み済みの版別レポート
 * から算出するため、押下時点のDB最新状態とズレうる(実削除は常にDB最新に対して行われる。
 * unknownPromptVersionAnalysisCount のコメント参照)。そのため「画面表示時点」の概算である旨を明記する。
 */
export function deleteUnknownPromptVersionConfirmMessage(count: number): string {
  return `取り消せません。${UNKNOWN_PROMPT_VERSION_DESCRIPTION}${count}件(画面表示時点)と関連馬データを削除します。よろしいですか?`;
}

/**
 * 版不明分析の削除完了フィードバックメッセージ(Task#33 code-reviewer指摘対応)。
 * 実際に削除された件数(IPC戻り値。DB最新に対する正確な件数)を、削除対象の説明とともに表示する。
 */
export function deleteUnknownPromptVersionResultMessage(deletedCount: number): string {
  return `${UNKNOWN_PROMPT_VERSION_DESCRIPTION}${deletedCount}件を削除しました。`;
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

/** YYYYMMDD形式かどうか(8桁数字)。 */
function isYyyymmdd(value: string): boolean {
  return /^[0-9]{8}$/.test(value);
}

/**
 * 開催日(YYYYMMDD)をYYYY/MM/DDに整形する(Task#34)。
 * null(日付不明。旧データ・選択済み開催日が渡らなかった分析)は「日付不明」。
 * YYYYMMDD形式でない値は防御的に素通しで表示する(DB異常値でも画面が壊れないように)。
 */
export function formatKaisaiDate(kaisaiDate: string | null): string {
  if (kaisaiDate === null) {
    return "日付不明";
  }
  if (!isYyyymmdd(kaisaiDate)) {
    return kaisaiDate;
  }
  return `${kaisaiDate.slice(0, 4)}/${kaisaiDate.slice(4, 6)}/${kaisaiDate.slice(6, 8)}`;
}

/**
 * レース一覧統合の見出し(会場名・R番号・開催日の3点)。
 * 例: "東京 11R (2026/07/08)"。開催日不明は formatKaisaiDate の「日付不明」を含める。
 */
export function raceBreakdownHeading(
  input: Pick<RaceLedgerView, "venueName" | "raceNumber" | "kaisaiDate">,
): string {
  return `${input.venueName} ${input.raceNumber}R (${formatKaisaiDate(input.kaisaiDate)})`;
}

/**
 * 検証画面: レース一覧統合(旧「分析履歴」「レース別予実」を統合したレースID単位の折りたたみリスト)の
 * 結果ステータス表示。
 * - hasResult=false(結果未取込) → 「未取込」
 * - hasResult=true かつ hasPayout=false(着順のみ取込・複勝払戻は未確定) → 「未確定」
 * - hasResult=true かつ hasPayout=true(着順・払戻とも取込済み) → 「取込済」
 * 判定は needsImport と同じ hasResult/hasPayout の2値に基づく
 * (「着順のみ(払戻待ち)」の既存概念を「未確定」という短いラベルで表す)。
 */
export function raceLedgerStatusLabel(entry: {
  readonly hasResult: boolean;
  readonly hasPayout: boolean;
}): string {
  if (!entry.hasResult) {
    return "未取込";
  }
  return entry.hasPayout ? "取込済" : "未確定";
}

/**
 * 検証画面: レース一覧統合の見出しに出すEVプラス数(印付け・EV判定が効いた頭数)。
 * horses配列から都度数える(旧AnalysisHistoryItemのpositiveCountのような事前集計フィールドを
 * RaceLedgerViewには持たせず、常にhorsesを単一の情報源とする)。
 */
export function raceLedgerPositiveCount(
  horses: readonly RaceBreakdownHorseView[],
): number {
  return horses.filter((h) => h.isPositive).length;
}

/** 実着順の表示整形(Task#34)。null(着順不明。中止・除外・結果に馬番が無い)は「不明」。 */
export function formatFinishPosition(finishPosition: number | null): string {
  return finishPosition === null ? "不明" : `${finishPosition}着`;
}

/**
 * 複勝的中の有無の表示整形(Task#34)。
 * null(finishPositionが着順不明で判定不能)は「-」。true/falseはそれぞれ「的中」「不的中」。
 */
export function placedLabel(isPlaced: boolean | null): string {
  if (isPlaced === null) {
    return "-";
  }
  return isPlaced ? "的中" : "不的中";
}

/**
 * 払戻算出根拠(実配当/近似)の表示整形(Task#34)。
 * null(賭けていない・不的中で払戻が発生していない)は「-」。
 */
export function payoutSourceLabel(
  source: "actual" | "approximate" | null,
): string {
  if (source === null) {
    return "-";
  }
  return source === "actual" ? "実配当" : "近似";
}

/**
 * レース一覧の絞り込み結果件数表示(検索/絞り込み機能)。
 * 絞り込みなし(全件表示)・該当0件のいずれも同じ「全N件中M件表示」の形式にし、
 * 該当0件時の穏やかな案内文はUI側(VerifyView)で別途出す(この関数は件数表示のみを担う)。
 */
export function raceLedgerFilterSummary(
  totalCount: number,
  shownCount: number,
): string {
  return `全${totalCount}件中${shownCount}件表示`;
}
