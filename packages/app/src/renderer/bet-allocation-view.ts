/**
 * 馬券配分(機能C-2)の renderer 側純関数。
 *
 * BatchAnalysisView から利用する。core の bet-allocation.ts をサブパスで呼び出し、
 * レース単位の「どの状態を表示すべきか」を判別共用体(RaceAllocationView)として返す。
 * IPC 追加はゼロ(既に取得済みの AnalysisResult と設定値だけから計算する)。
 *
 * 頭数→複勝対象人数の判定(resolvePlaceBetTarget)は boss着手前ゲート(2026-07-30)で
 * 確定した設計: 判別共用体で返し、可用性判定と不可のreason(理由コード)を1つの関数に
 * 閉じる(頭数の閾値が2箇所に分かれると片方だけ直して乖離する典型的なバグ経路になるため)。
 * reasonコード→文言のマップはこのファイルに1箇所だけ置く(頭数の意味論はcoreが知り得ない
 * 領域のため、skipReason/advisoryのような「core側が文言を持つ」原則の例外として、
 * ここではrendererが文言の定義元になる)。
 */

import {
  allocateBets,
  DEFAULT_BET_ALLOCATION_CONFIG,
  type AllocationHorse,
  type BetAllocationDiagnostics,
  type BetAllocationResult,
} from "@keiba/core/ev/bet-allocation";

import type { AnalysisResult, AnalysisRow, OddsStatus } from "../shared/analysis-types.js";
import { formatYen } from "./verify-format.js";

/** 馬券配分の設定3項目(SettingsView由来。core BetAllocationConfigのUI公開部分)。 */
export interface BetAllocationSettings {
  readonly bankroll: number;
  readonly perRaceCap: number;
  readonly kellyFraction: number;
}

/**
 * 複勝配分が対象外の理由コード。
 * - "two-place-only": 5〜7頭(複勝が2着までとなり本ツールの3着内率推定と整合しない)
 * - "not-sold": 1〜4頭(複勝が発売されない)
 * - "unknown": 0・負・非整数・非有限(頭数を判定できない。取得失敗を「発売されない」等の
 *   判定結果として報告しない。C-1 excludedReasonの重大バグ「判定不能を判定結果と誤ラベル」
 *   と同じ欠陥クラスの再発防止)
 */
export type PlaceBetUnavailableReason = "not-sold" | "two-place-only" | "unknown";

/**
 * 複勝の対象人数の解決結果(判別共用体)。
 * 機能Dへの備え: placeCountの型は number(リテラル3に固定しない)。券種拡張時に
 * 発売条件が異なりうるため、現状「8頭以上=3」のみをハードコードで判定している
 * (実測次第で見直す。JSDoc本体参照)。
 */
export type PlaceBetTarget =
  | { readonly available: true; readonly placeCount: number }
  | { readonly available: false; readonly reason: PlaceBetUnavailableReason };

/**
 * 出走頭数から複勝の対象人数を判定する(boss着手前ゲート2026-07-30で確定した4分類)。
 *
 * | 頭数 | 結果 |
 * |---|---|
 * | 8以上の整数 | available:true, placeCount:3 |
 * | 5〜7 | available:false, reason:"two-place-only" |
 * | 1〜4 | available:false, reason:"not-sold" |
 * | 0・負・非整数・非有限 | available:false, reason:"unknown" |
 *
 * 現状は「8頭以上=3」のみをハードコードしているが、機能D(券種拡張)で券種ごとの発売条件を
 * 実測したうえで見直す前提のため、placeCountの型は number のまま(リテラル3にしない)。
 */
export function resolvePlaceBetTarget(runnerCount: number): PlaceBetTarget {
  if (!Number.isFinite(runnerCount) || !Number.isInteger(runnerCount) || runnerCount <= 0) {
    return { available: false, reason: "unknown" };
  }
  if (runnerCount <= 4) {
    return { available: false, reason: "not-sold" };
  }
  if (runnerCount <= 7) {
    return { available: false, reason: "two-place-only" };
  }
  return { available: true, placeCount: 3 };
}

/** reasonコード→文言のマップ(1箇所に集約。JSXに文言を直書きしない)。 */
const PLACE_BET_UNAVAILABLE_MESSAGES: Record<PlaceBetUnavailableReason, string> = {
  "two-place-only":
    "複勝が2着までとなり本ツールの3着内率推定と整合しないため配分提案を行いません",
  "not-sold": "複勝が発売されないため対象外です",
  unknown: "出走頭数を判定できないため配分提案を行いません",
};

/** PlaceBetTarget.reason(不可の理由コード)を表示文言にする。 */
export function placeBetUnavailableMessage(reason: PlaceBetUnavailableReason): string {
  return PLACE_BET_UNAVAILABLE_MESSAGES[reason];
}

/**
 * 総資金または1レース上限が未設定か(いずれかが0以下)。
 * 未設定時はレースごとの配分ブロックを一切出さず、画面全体で注記を1点だけ表示する
 * (BET_ALLOCATION_UNSET_NOTE)ための判定。レース数に比例して注記が増えないようにする。
 */
export function isBetAllocationUnset(settings: BetAllocationSettings): boolean {
  return settings.bankroll <= 0 || settings.perRaceCap <= 0;
}

/** レース単位の配分ビュー状態(判別共用体)。 */
export type RaceAllocationView =
  | { readonly kind: "unset" }
  | { readonly kind: "yoso" }
  | { readonly kind: "unavailable"; readonly reason: PlaceBetUnavailableReason }
  | { readonly kind: "computed"; readonly result: BetAllocationResult };

/** buildRaceAllocation が受け取るレース情報の最小構造(AnalysisResultから直接渡せる)。 */
export interface RaceAllocationInput {
  readonly oddsStatus: OddsStatus;
  readonly rows: readonly AnalysisRow[];
}

/**
 * 1レース分の馬券配分ビュー状態を組み立てる。判定順序(優先順位):
 *   1. 総資金/1レース上限が未設定 → "unset"(画面全体で1点だけ注記するため、他の判定より先に返す)
 *   2. oddsStatus==="yoso"(複勝未発売) → "yoso"
 *   3. 頭数が配分対象外(7頭以下等) → "unavailable"
 *   4. それ以外 → core allocateBets を呼び "computed"
 *
 * AnalysisRow → AllocationHorse のマッピング: adjustedProb(AI補正後複勝率)→placeProb、
 * placeOddsMin/ev/isPositive/umabanはそのまま。core側の見送り判定(候補0頭・妙味なし等)は
 * "computed" の中で BetAllocationResult.isSkip/skipReason として表現される
 * (buildRaceAllocation自体はここまでの4分類だけを判定し、以降はcoreに委ねる)。
 */
export function buildRaceAllocation(
  race: RaceAllocationInput,
  settings: BetAllocationSettings,
): RaceAllocationView {
  if (isBetAllocationUnset(settings)) {
    return { kind: "unset" };
  }
  if (race.oddsStatus === "yoso") {
    return { kind: "yoso" };
  }
  const target = resolvePlaceBetTarget(race.rows.length);
  if (!target.available) {
    return { kind: "unavailable", reason: target.reason };
  }
  const horses: AllocationHorse[] = race.rows.map((r) => ({
    umaban: r.umaban,
    placeProb: r.adjustedProb,
    placeOddsMin: r.placeOddsMin,
    ev: r.ev,
    isPositive: r.isPositive,
  }));
  const result = allocateBets(horses, target.placeCount, {
    bankroll: settings.bankroll,
    perRaceCap: settings.perRaceCap,
    kellyFraction: settings.kellyFraction,
    betUnit: DEFAULT_BET_ALLOCATION_CONFIG.betUnit,
    greedySteps: DEFAULT_BET_ALLOCATION_CONFIG.greedySteps,
  });
  return { kind: "computed", result };
}

/**
 * 買い目ラベルの純関数生成(受け入れ条件27)。umabanをJSXへ直接埋め込まず、
 * ラベル文字列をここで一元的に組み立てる。機能Dで "4-7"(ワイド) / "3-4-7"(3連複)等の
 * 複数馬の組ラベルに差し替える際、この関数の実装だけを変えれば済むようにする
 * (最も効果が大きい機能Dへの備え。boss着手前ゲート2026-07-30)。
 */
export function formatBetLabel(umaban: number): string {
  return `${umaban}番`;
}

/**
 * 合計行の文言。capApplied(1レース上限で頭打ちになったか)で表現を切り替える
 * (仕様「UI 表示要件」の2例文に準拠)。
 */
export function formatAllocationSummary(result: BetAllocationResult): string {
  const total = formatYen(result.totalStake);
  const kellyTarget = formatYen(Math.round(result.kellyTargetStake));
  const cap = formatYen(result.effectivePerRaceCap);
  if (result.capApplied) {
    return `配分 合計 ${total} — ケリー適正額 ${kellyTarget} を1レース上限 ${cap}で打ち止め`;
  }
  const percent =
    result.resolvedBankroll > 0 ? (result.totalStake / result.resolvedBankroll) * 100 : 0;
  return `配分 合計 ${total}(総資金の${percent.toFixed(1)}%) — ケリー適正額 ${kellyTarget} / 1レース上限 ${cap}(上限に未達)`;
}

/** 確率合計の乖離がこの絶対値を超えたら警告する(名前付き定数)。 */
const PLACE_PROB_SUM_DEVIATION_THRESHOLD = 0.3;

/**
 * 複勝圏内確率の合計が目標(placeCount)から外れている旨の警告。
 * |placeProbSumDeviation| > 閾値 かつ 有限のときのみ文言を返す。非有限値は画面に出さない
 * (受け入れ条件24)。
 */
export function probabilitySumWarning(diagnostics: BetAllocationDiagnostics): string | null {
  const { placeProbSum, placeProbSumTarget, placeProbSumDeviation } = diagnostics;
  if (!Number.isFinite(placeProbSumDeviation)) {
    return null;
  }
  if (Math.abs(placeProbSumDeviation) <= PLACE_PROB_SUM_DEVIATION_THRESHOLD) {
    return null;
  }
  return (
    `複勝圏内確率の合計が目標 ${placeProbSumTarget.toFixed(2)} から外れています` +
    `(実測 ${placeProbSum.toFixed(2)})。配分額の信頼性が下がります。`
  );
}

/**
 * notDiversified(1点配分だが分散できる余地があった)の注記文言。
 *
 * 原因を名指ししない中立表現にする(boss実測による指摘・欠陥クラスの5回目の再発防止)。
 * 旧文言は「1レース上限の制約により」と原因を1レース上限に限定していたが、実際には
 * betCount===1になる経路は複数あり(1: 100円単位への丸めで他候補が0円に切り捨てられる
 * 純粋な丸め・2: 最低額ロジックが1頭だけに割り当てる)、1レース上限(capApplied)が
 * 効いていないケース(bankroll総資金1,200〜12,000円という最も一般的な設定帯を含む)の方が
 * 実測では多数派だった。判定していない(あるいは別の)原因を判定結果として報告しては
 * ならない欠陥クラス(C-1で3回・C-2着手前ゲートQ2で1回)の5回目。
 * core側 BetAllocation.tsのJSDocが notDiversified を「1点配分だが分散できる余地があった旨の
 * 注記」と意図的に原因中立で定義している設計に、renderer側の文言も揃える
 * (capApplied/minimumStakeAppliedによる原因分岐は行わない。原因を問わず常に真であることを
 * 優先する)。
 */
const NOT_DIVERSIFIED_NOTE =
  "妙味のある候補が複数いますが、1点のみの配分になっています(分散されていません)。";

/**
 * レース単位の条件付き注記を、表示順(advisory → 確率合計警告 → notDiversified)で並べる
 * (仕様「注記の表示順」)。該当する注記が無ければ空配列。
 */
export function buildAllocationNotices(result: BetAllocationResult): readonly string[] {
  const notices: string[] = [];
  if (result.advisory !== null) {
    notices.push(result.advisory);
  }
  const warning = probabilitySumWarning(result.diagnostics);
  if (warning !== null) {
    notices.push(warning);
  }
  if (result.notDiversified) {
    notices.push(NOT_DIVERSIFIED_NOTE);
  }
  return notices;
}

/**
 * 固定注記1: ケリー基準の説明(「上限は歯止め・通常は届かない」という誤解を防ぐ)。
 * 数値を含まない完全固定文のため定数として持つ(仕様「UI 表示要件」固定注記1)。
 */
export const KELLY_CAP_EXPLANATION_NOTE =
  "ケリー基準は妙味の大きさに比例した額だけを賭けます。上限は「これ以上は賭けない」という歯止めで、通常は上限に届きません。金額を増やすには総資金またはケリー係数を上げてください(いずれもリスクが増えます)。";

/** 固定注記2: レース横断オーバーベット警告(配分がレース単位で独立計算である旨の注意)。 */
export const CROSS_RACE_OVERBET_NOTE =
  "配分はレースごとに独立して計算しています。各レースの金額は総資金に対する比率で決まるため、複数レースを同時に購入すると合計はケリー最適を超えます。";

/**
 * 固定注記3: EV閾値の脚注(候補選定がisPositive依存であることの説明。数値込みのため関数化)。
 */
export function evThresholdFootnote(evThreshold: number): string {
  return `配分の対象はEV閾値(現在 ${evThreshold.toFixed(2)})を上回った馬のみです。`;
}

/**
 * 総資金・1レース上限が未設定のときの、画面全体で1点だけの注記(仕様「未設定時は…注記は
 * 画面全体で1点だけ」)。レース数に関わらずこの1文だけを表示し、レースごとには繰り返さない。
 */
export const BET_ALLOCATION_UNSET_NOTE =
  "馬券配分の提案には、設定画面で「馬券用の総資金」と「1レースの上限」を入力してください。";
