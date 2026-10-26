/**
 * 検証画面(`#verify`)の表示用データ(Issue #219。純関数)。`view.ts` がこれを VNode にする。状態(取得の状態・区分・通信中)を受け取り、文言・数値の整形・注記を導く
 * (DOM・fetch・時計に触れない)。数値の整形は core の `view/verify-format.ts` を直接使う(Issue #397 R-3)。
 *
 * **スマホ幅(360px 前後)で横に伸びない形**にする: exe が「/」区切りの 1 行で出していた内訳は、項目ごとの行に分ける(数値の 4 つ組は 2×2 のタイル)。横スクロールは使わない。
 * **サーバ由来の文は読まない**: 出す文言はすべてクライアントの固定の文言(サーバが返す日時・件数・券種コードは、整形して埋め込むだけ)。
 */
import { judgeCalibration, MIN_COUNT_FOR_JUDGMENT, type CalibrationVerdict, type ProportionInterval } from "@keiba/core/ev/binomial-interval";
import { formatRecoveryPercent } from "../src/recovery-format";
import { formatJstDateTime } from "./date";
import type { BreakdownSectionView, CalibrationBinView, CloseComparisonView, CloseRoundView, ProposedSummaryView, PromptVersionView, VerifyOutcome, VerifyReportView, VerifyVenue } from "./api-verify";
import {
  additionalInstructionsFullText,
  additionalInstructionsSummary,
  calibrationBarWidthPercent,
  directionLabel,
  exclusionRows,
  formatAdjustment,
  formatBinRange,
  formatPayoutBreakdown,
  formatRate,
  formatUnknownBetTypeNotice,
  formatYen,
  markLabel,
  overconfidenceLabel,
  promptVersionCalibrationHeading,
  promptVersionLabel,
  venueFilterLabel,
} from "../../packages/core/src/view/verify-format";
import { PROPOSED_BET_LABELS } from "./verify-format";
import { VERIFY_HASH, VERIFY_VERSIONS_HASH } from "./route";

/** 取得の状態。 */
export type VerifyLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly outcome: VerifyOutcome };

/** 対応表(キャリブレーション)の対象。`adjusted`: 補正後〈AI〉の確率で分けた表。`prior`: 補正前〈統計モデル〉の確率で分けた表(Issue #254)。 */
export type CalibrationTarget = "adjusted" | "prior";

/** 検証画面のページ(Issue #481)。`current`: 検証画面の本体(版別比較はいまの版だけ)。`past`: 過去の版のページ(`#verify-versions`。版別比較の過去の版だけ)。 */
export type VerifyPage = "current" | "past";

export interface VerifyModelInput {
  readonly load: VerifyLoadState;
  /** どちらのページか(Issue #481)。取得・状態は 2 つのページで共有する。 */
  readonly page: VerifyPage;
  readonly venue: VerifyVenue;
  /** 通信中(取得・更新)。 */
  readonly busy: boolean;
  /** 自動更新を止めている(通信の失敗が続いた・回数の上限)。 */
  readonly pollStopped: boolean;
  /** キャリブレーションを開いている版のキー(`versionKey`)。 */
  readonly expandedVersions: readonly string[];
  /** 対応表の対象(補正後・補正前の切替。Issue #254)。 */
  readonly calibrationTarget: CalibrationTarget;
  /**
   * 管理者か(Issue #263)。**false(閲覧者)のとき**: 更新ボタンを出さない(`canRefresh` が false)・集計が「管理者が更新したときの内容」であることを注記する・
   * 追加指示の全文を出さない(版別は『あり/なし』だけ。サーバも全文を落とすが、画面でも出さない)。必須(省略で管理者の画面になる向きには倒さない)。
   */
  readonly admin: boolean;
}

export type Tone = "info" | "ok" | "error" | "wait";

export interface Tile {
  readonly label: string;
  readonly value: string;
  /** 回収率のタイル(強調)。 */
  readonly strong: boolean;
}

export interface RowView {
  readonly label: string;
  readonly value: string;
}

export interface TypeRowView {
  readonly label: string;
  readonly count: string;
  readonly rate: string;
}

export interface BetSection {
  readonly heading: string;
  readonly description: string;
  /** 集計対象が 0 件のとき、タイルの代わりに出す文。 */
  readonly empty: string | null;
  readonly tiles: readonly Tile[];
  readonly payoutLine: string | null;
  readonly exclusionHeading: string;
  readonly exclusions: readonly RowView[];
  readonly exclusionNote: string | null;
}

export interface ProposedSection {
  readonly heading: string;
  readonly description: string;
  readonly empty: string | null;
  readonly tiles: readonly Tile[];
  readonly typeHeading: string;
  readonly types: readonly TypeRowView[];
  /** 返還として数えた点数と賭け金の 1 行(Issue #72。合算の値)。返還が 0 点なら null。タイルの賭け数・投資額・回収額に含まれている内訳。 */
  readonly refund: string | null;
  /** 同じ買い目に一律 100 円を賭けた場合の 1 行(Issue #16。合算の値)。一律の賭け金が 0 なら null。 */
  readonly flat: string | null;
  /** 判定不能(集計対象外)の券種別の点数。0 点なら null。 */
  readonly unjudged: { readonly heading: string; readonly rows: readonly RowView[] } | null;
  readonly unknownNotice: string | null;
  readonly populationHeading: string;
  readonly population: readonly RowView[];
}

/** 1 つの項目の値(名前つき)。名前と値を並べて折り返せるように、「/」区切りの 1 行にはしない。 */
export interface StatCell {
  readonly name: string;
  readonly value: string;
}

/** 帯グラフ(`progress`。`value`/`max` は整数。実複勝率を ×1000 で丸めた値)。 */
export interface BarView {
  readonly value: number;
  readonly max: number;
  readonly label: string;
}

/** 補正方向・キャリブレーションの帯・印・(版別の)帯の 1 行。 */
export interface StatRow {
  readonly label: string;
  readonly cells: readonly StatCell[];
  readonly bar: BarView | null;
}

/** 補正方向×結果・印別的中率の節。 */
export interface StatSection {
  readonly heading: string;
  readonly description: string;
  readonly rows: readonly StatRow[];
}

/** 対応表の対象の切替の 1 つ(Issue #254)。 */
export interface CalibrationTargetTab {
  readonly target: CalibrationTarget;
  readonly label: string;
  readonly current: boolean;
}

/** キャリブレーションの節。帯が 0 本のときは `empty` に文を入れる。 */
export interface CalibrationSection extends StatSection {
  readonly empty: string | null;
  /** 補正後(AI)・補正前(統計)の切替(Issue #254)。 */
  readonly targets: readonly CalibrationTargetTab[];
}

/** 版別比較の 1 版のカード。キャリブレーションは開いたときだけ行を持つ。 */
export interface VersionCard {
  /** 開閉の識別子(`versionKey`)。 */
  readonly key: string;
  readonly title: string;
  /** 「追加指示: 要約」。 */
  readonly instructions: string;
  readonly included: string;
  readonly tiles: readonly Tile[];
  readonly expanded: boolean;
  readonly toggleLabel: string;
  /** 開いたときだけ: 見出し(版+追加指示の要約)・追加指示の全文・帯の行(帯が 0 本なら `calibrationEmpty`)。 */
  readonly calibrationHeading: string | null;
  readonly fullInstructions: string | null;
  readonly calibrationEmpty: string | null;
  readonly calibrationRows: readonly StatRow[];
  /** 常に出す Brier の 1 行(Issue #271)。レース数が足りない版は値を出さず、その旨を言う。 */
  readonly quality: string;
  /** 開いたときだけ(帯が 0 本なら null): 補正後の表・補正前の表のそれぞれの見出しと行(Issue #271)。 */
  readonly calibrationLabel: string | null;
  readonly priorCalibrationLabel: string | null;
  readonly priorCalibrationRows: readonly StatRow[];
}

/** いまの版が 30 件未満で、カードの代わりに出す枠(Issue #481)。 */
export interface CollectingVersion {
  readonly title: string;
  readonly text: string;
}

export interface VersionsSection {
  readonly heading: string;
  readonly description: string;
  /** 版不明の行があるときの、その内訳の注記。 */
  readonly unknownNote: string | null;
  /** 版別が 0 件のときの文。 */
  readonly empty: string | null;
  readonly cards: readonly VersionCard[];
  /** いまの版のページ: 集計件数が足りない(30 件未満の)いまの版の枠(Issue #481)。 */
  readonly collecting: readonly CollectingVersion[];
  /** 過去の版のページ: 30 件未満で出さなかった版の数の 1 行(0 版なら null。Issue #481)。 */
  readonly omitted: string | null;
  /** いまの版のページ: 過去の版のページへのリンク(Issue #481)。過去の版のページは null。 */
  readonly link: { readonly label: string; readonly href: string } | null;
}

/**
 * 締切直前の再計算との比較の節(Issue #352)。行は回(5 分前・直前)× 取り直しの基準(Issue #379。組合せは分析時のオッズの行は見出しに語が付く)。**区分のタブに従う**(区分ごとの値をサーバが渡す)。
 * `description` はサーバが組み立てた説明文(クライアントの束に日本語を置かない)。`note` は日付に依らない固定の文(件数が少ないうちは回収率の差に意味がない旨)。
 */
export interface CloseSection extends StatSection {
  readonly note: string;
}

/**
 * 人気帯ごとの期待値と回収率の節(Issue #384)。見出し・説明・注記・行の見出し・項目の名前と値は、すべてサーバが組み立てた文字列で、クライアントは整形も文言の追加もしない
 * (日本語を束に置かない。#379 と同じ流儀)。行は他の統計と同じ形(帯グラフなし)。
 */
export interface BreakdownSection extends StatSection {
  readonly note: string;
}

export interface VerifyNotice {
  readonly tone: Tone;
  readonly text: string;
}

export interface VerifyModel {
  readonly kind: "verify";
  /** 画面の見出し(Issue #481: 過去の版のページは「過去の版」)。 */
  readonly title: string;
  /** 戻るリンク(Issue #481: 過去の版のページは検証画面へ。それ以外は一覧へ)。 */
  readonly backHref: string;
  readonly backLabel: string;
  readonly venueTabs: readonly { readonly venue: VerifyVenue; readonly label: string; readonly current: boolean }[];
  readonly loading: boolean;
  /** 「更新」ボタンを出すか(管理者だけ。Issue #263)。 */
  readonly canRefresh: boolean;
  readonly refreshDisabled: boolean;
  readonly error: string | null;
  readonly pollNotice: string | null;
  /** 集計が出せない間の説明(補完中・柵・上限)。 */
  readonly unavailable: VerifyNotice | null;
  /** 集計時点(JST)。 */
  readonly computedAt: string | null;
  /** 古い集計・発走時刻の欠落などの注記。 */
  readonly notices: readonly VerifyNotice[];
  readonly bet: BetSection | null;
  readonly proposed: ProposedSection | null;
  /** プロンプト版別の比較(Issue #220。区分に依らず全体)。 */
  readonly versions: VersionsSection | null;
  /** 締切直前の再計算との比較(Issue #352。区分のタブに従う〈Issue #379〉)。比較できるものが無ければ null。 */
  readonly close: CloseSection | null;
  /** 人気帯ごとの期待値と回収率(Issue #384。区分のタブに従う)。内訳が無ければ空。 */
  readonly breakdown: readonly BreakdownSection[];
  /** 補正方向×結果(Issue #220)。 */
  readonly direction: StatSection | null;
  /** キャリブレーション(Issue #220)。 */
  readonly calibration: CalibrationSection | null;
  /** 印別的中率(Issue #220)。 */
  readonly marks: StatSection | null;
}

const POLL_STOPPED_NOTICE = "自動更新を止めました。「更新」で取り直せます。";
/** 閲覧者には「更新」ボタンが無い(Issue #263)。 */
const VIEWER_POLL_STOPPED_NOTICE = "自動更新を止めました。ページを再読み込みしてください。";
/** 閲覧者の集計の注記(Issue #263)。閲覧者の要求は集計のやり直しを起こさないので、表示は管理者が更新したときの内容。データの更新に追いついているかは確かめない。 */
const VIEWER_NOTICE = "閲覧用の画面です。この集計は管理者が更新したときの内容で、その後に増えた分析や結果は反映されていないことがあります(集計時点は上に表示しています)。";
/** 閲覧者に、使える集計がまだ無いとき(Issue #263)。 */
const NOT_COMPUTED_NOTICE = "まだ集計されていません。管理者が検証画面を開いて集計すると、ここに表示されます。";

/** 回収率の表示(Issue #254・#255 からの申し送り)。丸めると 100.0% になる値を 100.0% と出さない(`formatRecoveryPercent`〈#245〉。ちょうど 1 だけが 100.0%)。null は "-"。実複勝率などの `formatRate` とは別。 */
function recoveryText(rate: number | null): string {
  return rate === null ? "-" : formatRecoveryPercent(rate);
}

function tiles(betCount: number, totalStake: number, totalReturn: number, recoveryRate: number | null): readonly Tile[] {
  return [
    { label: "賭け数", value: `${betCount}点`, strong: false },
    { label: "投資額", value: formatYen(totalStake), strong: false },
    { label: "回収額", value: formatYen(totalReturn), strong: false },
    { label: "回収率", value: recoveryText(recoveryRate), strong: true },
  ];
}

function betSection(report: VerifyReportView): BetSection {
  const suspicious = report.excludedLookaheadSuspectCount + report.excludedLookaheadUnknownCount > 0;
  return {
    heading: "累積回収率",
    description: "EVプラスの馬の複勝を、一律 100 円ずつ買ったとした場合。取消・除外・中止など着順が出ていない馬は集計に入れません。",
    empty: report.includedAnalysisCount === 0 ? "集計対象がありません。" : null,
    tiles: tiles(report.bet.betCount, report.bet.totalStake, report.bet.totalReturn, report.bet.recoveryRate),
    payoutLine: `払戻内訳: ${formatPayoutBreakdown(report.bet)}(実配当が無い点は複勝下限で近似)`,
    exclusionHeading: "集計の内訳",
    exclusions: exclusionRows(report),
    exclusionNote: suspicious ? "該当レースを分析し直すと、集計に戻ります。" : null,
  };
}

function rateRow(label: string, s: ProposedSummaryView): TypeRowView {
  return { label, count: `${s.betCount}点`, rate: recoveryText(s.recoveryRate) };
}

function proposedSection(report: VerifyReportView): ProposedSection {
  const p = report.proposedBet;
  return {
    heading: "配分ベースの回収率",
    description: "分析時点の設定で実際に提案した配分額を、そのまま賭け金とした場合。上の累積回収率とは賭け金の仮定が違うので、合算しません。取消・除外の馬への買い目は返還として、賭け金を払戻に含めます。「同じ買い目に一律 100 円」は、この配分ベースと同じ買い目(返還を含み、判定不能を除く)の賭け金だけを 100 円に置き換えたもので、配分の効果だけを比べられます。上の累積回収率(EVプラスの複勝のみ)とは買い目の集合が違います。",
    empty: report.includedAnalysisCount === 0 ? "集計対象がありません。" : null,
    tiles: tiles(p.overall.betCount, p.overall.totalStake, p.overall.totalReturn, p.overall.recoveryRate),
    typeHeading: "券種別(点数・回収率)",
    types: PROPOSED_BET_LABELS.map(({ type, label }) => rateRow(label, p.byType[type])),
    refund: p.overall.refundedCount > 0 ? `うち返還 ${p.overall.refundedCount}点(${formatYen(p.overall.refundedStake)})` : null,
    flat: p.overall.flatStake > 0 ? `同じ買い目に一律 100 円なら 回収率 ${recoveryText(p.overall.flatRecoveryRate)}(投資額 ${formatYen(p.overall.flatStake)} / 回収額 ${formatYen(p.overall.flatReturn)})` : null,
    unjudged:
      p.overall.unjudgedCount > 0
        ? { heading: "判定不能(集計対象外)", rows: PROPOSED_BET_LABELS.map(({ type, label }) => ({ label, value: `${p.byType[type].unjudgedCount}点` })) }
        : null,
    unknownNotice: formatUnknownBetTypeNotice(p.unknownBetType),
    populationHeading: "母集団",
    population: [
      { label: "配分あり", value: `${p.population.allocated}件` },
      { label: "見送り", value: `${p.population.skipped}件` },
      { label: "未到達", value: `${p.population.unreached}件` },
      { label: "記録なし", value: `${p.population.noRecord}件` },
    ],
  };
}

/** 実複勝率の帯グラフ。`progress` の value/max は整数なので、実複勝率(0〜1)を ×1000 で丸める。 */
function rateBar(rate: number | null): BarView {
  const value = Math.min(1000, Math.max(0, Math.round(calibrationBarWidthPercent(rate) * 10)));
  return { value, max: 1000, label: `実複勝率 ${formatRate(rate)}` };
}

/** 判定の文言(色だけに頼らず文字で出す。語は `overconfidenceLabel` の「過信」「過小評価」とそろえる)。 */
function verdictLabel(verdict: CalibrationVerdict | null): string {
  switch (verdict) {
    case null:
      return "-";
    case "consistent":
      return "整合";
    case "overpredicted":
      return "予測が高い(過信)";
    case "underpredicted":
      return "予測が低い(過小評価)";
    case "insufficient":
      return `件数不足(${MIN_COUNT_FOR_JUDGMENT}件未満)`;
  }
}

/** 区間の表示(例: "21.9〜39.6%")。区間なし(件数 0)は "-"。 */
function intervalText(interval: ProportionInterval | null): string {
  return interval === null ? "-" : `${(interval.lower * 100).toFixed(1)}〜${(interval.upper * 100).toFixed(1)}%`;
}

/**
 * 帯の「予測−実績」= **帯内の平均予測 − 実複勝率**(Issue #254)。同じ行の「平均予測」「判定」と**同じ基準**で差を取る。
 * 従来は core の過信バイアス(帯の中央値 − 実複勝率)を使っていたが、判定は平均予測で比べるので、帯の中央と平均がずれる行で
 * 「予測−実績」は過信・判定は過小評価のように向きが逆になった(レビュー指摘)。core の `trend.calibrationBias`(帯の中央値。exe と共有)は変えず、クライアントは使わない。
 * 平均予測または実複勝率が無い(件数 0)帯は null。過信・過小評価の語は、この差の符号で付ける(`overconfidenceLabel`)。
 */
function meanGap(bin: CalibrationBinView): number | null {
  return bin.meanPredictedProb === null || bin.actualPlaceRate === null ? null : bin.meanPredictedProb - bin.actualPlaceRate;
}

/**
 * キャリブレーションの行(主表の補正後・補正前、版別カードで共通)。
 *
 * Issue #254: 末尾に **平均予測**(帯内の予測の平均)・**95%区間**(その帯の件数から求めた実複勝率の Wilson 区間)・**判定**(平均予測が区間に入るか。30 件未満は件数不足)を足す。
 * 先頭の 4 つの cell の並びは変えない。「予測−実績」は平均予測 − 実複勝率(`meanGap`)。
 */
export function calibrationRows(bins: readonly CalibrationBinView[]): readonly StatRow[] {
  return bins.map((bin) => {
    const gap = meanGap(bin);
    const judged = judgeCalibration({ predicted: bin.predictedCount, placed: bin.placedCount, meanPredictedProb: bin.meanPredictedProb });
    return {
      label: formatBinRange(bin),
      bar: rateBar(bin.actualPlaceRate),
      cells: [
        { name: "予測件数", value: `${bin.predictedCount}件` },
        { name: "複勝件数", value: `${bin.placedCount}件` },
        { name: "実複勝率", value: formatRate(bin.actualPlaceRate) },
        { name: "予測−実績", value: gap === null ? "-" : `${formatAdjustment(gap)}(${overconfidenceLabel(gap)})` },
        { name: "平均予測", value: formatRate(bin.meanPredictedProb) },
        { name: "95%区間", value: intervalText(judged.interval) },
        { name: "判定", value: verdictLabel(judged.verdict) },
      ],
    };
  });
}

/** 版別の開閉のキー。版不明(null)と、文字列の版が衝突しない形にする。 */
export function versionKey(promptVersion: string | null): string {
  return promptVersion === null ? "unknown" : `v:${promptVersion}`;
}

const UNKNOWN_VERSION_NOTE = "「版不明」は版記録導入前の旧データと、APIキー未設定で実行したLLM未使用の分析の両方を含みます(区別できません)。";

/**
 * 閲覧者向けの追加指示の要約(Issue #263)。**全文は出さない**(設定の値。分析の詳細の API も閲覧者には返さない)。非 null は『あり』(複数の種類があれば『あり(N種類)』)、null は『なし』。
 * 並びは管理者の要約と同じ(あり → なし)。入力の中身(文字列)は見ない=サーバが全文を返してしまっても、ここで出さない。
 */
export function viewerInstructionsSummary(instructions: readonly (string | null)[]): string {
  const given = instructions.filter((i) => i !== null).length;
  const parts = [...(given === 0 ? [] : [given === 1 ? "あり" : `あり(${given}種類)`]), ...(instructions.some((i) => i === null) || given === 0 ? ["なし"] : [])];
  return parts.join(" / ");
}

const formatBrier = (value: number | null): string => (value === null ? "-" : value.toFixed(4));

/**
 * Brier の 1 行。レース数は版の集計件数(同じ版の中では 1 レース 1 分析)。
 * 少ないレース数で値が偶然に大きく動く問題(Issue #271)は、Issue #481 から**カードを出す条件**({@link VERSION_CARD_MIN_COUNT}=30 件以上)が受け持つ=ここへ来る版は常に 30 件以上。
 */
function qualityText(v: PromptVersionView): string {
  return `Brier 補正前 ${formatBrier(v.quality.priorBrier)} / 補正後 ${formatBrier(v.quality.adjustedBrier)}(${v.quality.evaluatedCount}頭・${v.includedAnalysisCount}レース)`;
}

function versionCard(v: PromptVersionView, expandedKeys: ReadonlySet<string>, admin: boolean): VersionCard {
  const key = versionKey(v.promptVersion);
  const expanded = expandedKeys.has(key);
  const summary = admin ? additionalInstructionsSummary(v.additionalInstructions) : viewerInstructionsSummary(v.additionalInstructions);
  const showTables = expanded && v.calibration.length > 0;
  return {
    key,
    title: promptVersionLabel(v.promptVersion),
    instructions: `追加指示: ${summary}`,
    included: `集計件数 ${v.includedAnalysisCount}件`,
    tiles: tiles(v.bet.betCount, v.bet.totalStake, v.bet.totalReturn, v.bet.recoveryRate),
    expanded,
    toggleLabel: expanded ? "キャリブレーションを閉じる" : "キャリブレーションを表示",
    calibrationHeading: expanded ? (admin ? promptVersionCalibrationHeading(v.promptVersion, v.additionalInstructions) : `${promptVersionLabel(v.promptVersion)} (追加指示: ${summary})`) : null,
    fullInstructions: expanded && admin ? `追加指示(全文): ${additionalInstructionsFullText(v.additionalInstructions)}` : null,
    calibrationEmpty: expanded && v.calibration.length === 0 ? "データがありません。" : null,
    calibrationRows: expanded ? calibrationRows(v.calibration) : [],
    quality: qualityText(v),
    calibrationLabel: showTables ? CALIBRATION_TARGET_LABELS.adjusted : null,
    priorCalibrationLabel: showTables ? CALIBRATION_TARGET_LABELS.prior : null,
    priorCalibrationRows: showTables ? calibrationRows(v.priorCalibration) : [],
  };
}

/** 版別のカードを出す、集計できた分析の最小件数(未満なら出さない。Issue #481)。`CLOSE_REFERENCE_MIN_COUNT` と同じ 30 だが別の定数で、連動しない。 */
export const VERSION_CARD_MIN_COUNT = 30;

/**
 * 版別比較の節(Issue #481)。サーバが渡すいまの版の一覧(`current`)で、版を「いまの版」(検証画面の本体)と「過去の版」(過去の版のページ)に分ける。
 * どちらも集計件数が {@link VERSION_CARD_MIN_COUNT} 未満の版はカードにしない: いまの版は『集計中』の枠にし、過去の版は数だけを 1 行で言う。
 */
function versionsSection(versions: readonly PromptVersionView[], current: readonly string[], page: VerifyPage, expandedVersions: readonly string[], admin: boolean): VersionsSection {
  const expandedKeys = new Set(expandedVersions);
  const isCurrent = (v: PromptVersionView): boolean => v.promptVersion !== null && current.includes(v.promptVersion);
  const past = page === "past";
  const shown = versions.filter((v) => isCurrent(v) !== past);
  const cards = shown.filter((v) => v.includedAnalysisCount >= VERSION_CARD_MIN_COUNT);
  const omittedCount = shown.length - cards.length;
  const collecting = past
    ? []
    : current.filter((c) => !cards.some((v) => v.promptVersion === c)).map((c) => ({
        title: promptVersionLabel(c),
        text: `集計中(${versions.find((v) => v.promptVersion === c)?.includedAnalysisCount ?? 0}件。${VERSION_CARD_MIN_COUNT}件で表示)`,
      }));
  return {
    heading: "プロンプト版別比較", // ページの見出し(h1)と重ねない: 過去の版のページの h1 は「過去の版」
    description: "プロンプトの版ごとの累積回収率・キャリブレーション・Brier。版別は、中央・地方の区分によらず全体の集計です。同じ版でも追加指示が違えば別条件です。Brier は予測と結果のずれの平均で、小さいほど良い。版ごとにレースが違うので、差は目安です。",
    unknownNote: cards.some((v) => v.promptVersion === null) ? UNKNOWN_VERSION_NOTE : null,
    empty: cards.length === 0 && collecting.length === 0 && omittedCount === 0 ? (past ? "過去の版はありません。" : "集計対象がありません。") : null,
    cards: cards.map((v) => versionCard(v, expandedKeys, admin)),
    collecting,
    omitted: past && omittedCount > 0 ? `分析が${VERSION_CARD_MIN_COUNT}件未満の版(${omittedCount}版)は出していません。` : null,
    link: past ? null : { label: "過去の版は別のページで見る", href: VERIFY_VERSIONS_HASH },
  };
}

/**
 * 「参考」の印を付ける、再計算できた件数の境界(未満なら付ける)。**根拠のない置き値**(着手前ゲートで置いた既定値〈2026-10-17〉の 30 件。ユーザーの決定ではない。統計的な検定の閾値ではない。
 * キャリブレーションの判定の最小件数 `MIN_COUNT_FOR_JUDGMENT` と同じ 30 だが、別の定数で、連動しない)。
 */
export const CLOSE_REFERENCE_MIN_COUNT = 30;

function closeRoundLabel(r: CloseRoundView): string {
  const lead = r.round === 1 ? `${r.leadMinutes}分前` : r.round === 2 ? `直前(発走${r.leadMinutes}分前・暫定)` : `回${r.round}(発走${r.leadMinutes}分前)`;
  return r.basisLabel === null ? lead : `${lead}・${r.basisLabel}`;
}

function closeSection(close: CloseComparisonView): CloseSection {
  return {
    heading: "締切直前の再計算との比較",
    description: close.description,
    note: `件数が少ないうちは、回収率の差に意味がありません。「参考」の行は、再計算できた件数が ${CLOSE_REFERENCE_MIN_COUNT} 件未満です。`,
    rows: close.rounds.map((r) => ({
      label: closeRoundLabel(r),
      bar: null,
      cells: [
        { name: "件数(再計算できた/対象)", value: `${r.okCount}/${r.targetCount}件` },
        { name: "回収率(分析時)", value: recoveryText(r.base.recoveryRate) },
        { name: "回収率(再計算)", value: recoveryText(r.recalc.recoveryRate) },
        { name: "投資額(分析時→再計算)", value: `${formatYen(r.base.totalStake)}→${formatYen(r.recalc.totalStake)}` },
        ...(r.okCount < CLOSE_REFERENCE_MIN_COUNT ? [{ name: "注意", value: "参考(件数が少ない)" }] : []),
      ],
    })),
  };
}

function breakdownSections(breakdown: readonly BreakdownSectionView[] | null): BreakdownSection[] {
  return (breakdown ?? []).map((s) => ({ heading: s.heading, description: s.description, note: s.note, rows: s.rows.map((r) => ({ label: r.label, bar: null, cells: r.cells })) }));
}

function directionSection(report: VerifyReportView): StatSection {
  return {
    heading: "補正方向×結果",
    description: "AI が確率を上げた馬・下げた馬・据え置いた馬が、実際に複勝圏に来たか。",
    rows: report.trend.directionGroups.map((g) => ({
      label: directionLabel(g.direction),
      bar: null,
      cells: [
        { name: "件数", value: `${g.count}件` },
        { name: "実複勝率", value: formatRate(g.actualPlaceRate) },
        { name: "平均補正幅", value: formatAdjustment(g.averageAdjustment) },
      ],
    })),
  };
}

const CALIBRATION_NOTE = `95%区間は、その帯の件数から求めた実際の複勝率の幅(Wilson 区間)で、狭いほど件数が十分です。判定は、帯内の予測の平均が区間に入るかを見ます(${MIN_COUNT_FOR_JUDGMENT}件未満は判定しません)。同じレースの馬は互いに独立でないので区間は目安で、20 帯のうち 1 帯程度は偶然に区間を外れます。`;

const CALIBRATION_TARGET_NOTES: Readonly<Record<CalibrationTarget, string>> = {
  adjusted: "補正後(AI が補正した確率)で分けています。",
  prior: "補正前(統計モデルの確率)で分けています。AI を使わなかった分析は補正後と同じです。",
};

const CALIBRATION_TARGET_LABELS: Readonly<Record<CalibrationTarget, string>> = {
  adjusted: "補正後(AI)",
  prior: "補正前(統計)",
};

function calibrationSection(report: VerifyReportView, target: CalibrationTarget): CalibrationSection {
  const bins = target === "prior" ? report.priorCalibration : report.calibration;
  return {
    heading: "キャリブレーション(推定確率帯ごとの実複勝率・過信バイアス)",
    description: `予測−実績(帯内の予測の平均 − 実複勝率)が正なら過信、負なら過小評価。${CALIBRATION_TARGET_NOTES[target]}${CALIBRATION_NOTE}`,
    empty: bins.length === 0 ? "データがありません。" : null,
    targets: (["adjusted", "prior"] as const).map((t) => ({ target: t, label: CALIBRATION_TARGET_LABELS[t], current: t === target })),
    rows: calibrationRows(bins),
  };
}

function marksSection(report: VerifyReportView): StatSection {
  return {
    heading: "印別的中率",
    description: "印付けが機能しているか(複勝率は 3 着以内、勝率は 1 着)。",
    rows: report.trend.markStats.map((m) => ({
      label: markLabel(m.mark),
      bar: null,
      cells: [
        { name: "件数", value: `${m.count}件` },
        { name: "複勝率", value: formatRate(m.placeRate) },
        { name: "勝率", value: formatRate(m.winRate) },
      ],
    })),
  };
}

function jst(iso: string): string {
  return `${formatJstDateTime(iso)}(JST)`;
}

function staleNotice(outcome: Extract<VerifyOutcome, { kind: "ready" }>): VerifyNotice | null {
  const at = jst(outcome.computedAt);
  switch (outcome.staleReason) {
    case null:
      return null;
    case "backfilling":
      return { tone: "wait", text: `古い分析の発走時刻を確認しています。終わると、最新の集計に自動で更新されます(いま表示しているのは ${at} 時点の集計です)。` };
    case "min-interval":
      return { tone: "wait", text: `データが更新されていますが、集計は 5 分に 1 回までです。いま表示しているのは ${at} 時点の集計で、${outcome.nextRecomputeAt === null ? "しばらくあと" : jst(outcome.nextRecomputeAt)}以降の「更新」で反映されます。` };
    case "daily-limit":
      return { tone: "wait", text: `1 日の集計の上限に達しているため、いま表示しているのは ${at} 時点の集計です。${outcome.nextRecomputeAt === null ? "翌日" : jst(outcome.nextRecomputeAt)}以降に更新できます。` };
  }
}

function gapNotice(gaps: { readonly lost: number; readonly affecting: number }): VerifyNotice | null {
  if (gaps.affecting > 0) {
    return {
      tone: "wait",
      text: `発走時刻を確認できなかった旧い分析が ${gaps.lost}件あります(分析の詳細を読めませんでした。詳細が無い・壊れている・まだ書き込み中などの理由があります)。うち ${gaps.affecting}件は、先読みの判定が発走時刻に依るため、exe とは判定が違う可能性があります。`,
    };
  }
  if (gaps.lost > 0) {
    return { tone: "info", text: `発走時刻を確認できなかった分析が ${gaps.lost}件ありますが、先読みの判定には影響しません。` };
  }
  return null;
}

function unavailableNotice(outcome: Exclude<VerifyOutcome, { kind: "ready" }>): VerifyNotice {
  if (outcome.kind === "not-computed") {
    return { tone: "info", text: NOT_COMPUTED_NOTICE };
  }
  if (outcome.kind === "throttled") {
    // 柵の種類で文言を変える(Issue #254。最短間隔のときに『1 日の上限』と出さない)。
    if (outcome.reason === "min-interval") {
      return { tone: "wait", text: `集計は 5 分に 1 回までで、いま表示できる集計がありません。${jst(outcome.nextAt)}以降にもう一度開いてください。` };
    }
    return { tone: "wait", text: `1 日の集計の上限に達していて、表示できる集計がありません。${jst(outcome.nextAt)}以降にもう一度開いてください。` };
  }
  if (outcome.blocked === "r2-fence") {
    return { tone: "wait", text: `保存先(R2)の読み出し回数の上限に達したため、発走時刻の確認を止めています。${outcome.resumeAt === null ? "翌月" : jst(outcome.resumeAt)}ごろに自動で再開します(残り ${outcome.remaining}件)。` };
  }
  if (outcome.blocked === "error") {
    return { tone: "error", text: `発走時刻の確認でエラーが続き、止まっています(残り ${outcome.remaining}件)。少し待ってから「更新」を押してください。` };
  }
  return { tone: "info", text: `古い分析の発走時刻を確認しています(残り ${outcome.remaining}件)。終わるまで数分かかることがあります。この画面は自動で更新されます。` };
}

export function buildVerifyModel(input: VerifyModelInput): VerifyModel {
  const { load } = input;
  const outcome = load.kind === "ready" ? load.outcome : null;
  const ready = outcome !== null && outcome.kind === "ready" ? outcome : null;
  const notices: VerifyNotice[] = [];
  if (ready !== null) {
    if (!input.admin) notices.push({ tone: "info", text: VIEWER_NOTICE });
    const stale = staleNotice(ready);
    if (stale !== null) notices.push(stale);
    const gap = gapNotice(ready.startTimeGaps);
    if (gap !== null) notices.push(gap);
  }
  const past = input.page === "past";
  return {
    kind: "verify",
    title: past ? "過去の版" : "検証",
    backHref: past ? VERIFY_HASH : "#",
    backLabel: past ? "検証へ戻る" : "一覧へ戻る",
    venueTabs: past ? [] : (["all", "central", "nar"] as const).map((venue) => ({ venue, label: venueFilterLabel(venue), current: venue === input.venue })),
    loading: load.kind === "loading" || input.busy,
    canRefresh: input.admin,
    refreshDisabled: load.kind === "loading" || input.busy,
    error: load.kind === "error" ? load.message : null,
    pollNotice: input.pollStopped ? (input.admin ? POLL_STOPPED_NOTICE : VIEWER_POLL_STOPPED_NOTICE) : null,
    unavailable: outcome !== null && outcome.kind !== "ready" ? unavailableNotice(outcome) : null,
    computedAt: ready === null ? null : jst(ready.computedAt),
    notices,
    // 過去の版のページ(Issue #481)は版別だけ。全体の節は検証画面の本体に残す(中身は変えない)。
    bet: ready === null || past ? null : betSection(ready.report),
    proposed: ready === null || past ? null : proposedSection(ready.report),
    versions: ready === null ? null : versionsSection(ready.promptVersions, ready.currentPromptVersions, input.page, input.expandedVersions, input.admin),
    close: ready === null || past || ready.closeComparison === null ? null : closeSection(ready.closeComparison),
    breakdown: ready === null || past ? [] : breakdownSections(ready.breakdown),
    direction: ready === null || past ? null : directionSection(ready.report),
    calibration: ready === null || past ? null : calibrationSection(ready.report, input.calibrationTarget),
    marks: ready === null || past ? null : marksSection(ready.report),
  };
}
