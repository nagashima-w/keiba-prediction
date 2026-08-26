/**
 * race-allocation — 複勝の馬券配分(機能C-2)の計算本体(純関数)。
 *
 * Issue #57 で `renderer/bet-allocation-view.ts` から計算部分(本ファイル)を分離した
 * (挙動不変・移動のみ)。renderer・main の両方から呼べるようにする(#54: 回収率の記録は
 * main〈分析保存時〉起点でなければならないため)。core の bet-allocation.ts をサブパスで
 * 呼び出し、レース単位の「どの状態を表示すべきか」を判別共用体(RaceAllocationView)として返す。
 * IPC 追加はゼロ(既に取得済みの AnalysisResult と設定値だけから計算する)。
 *
 * 表示専用の関数・定数(`formatBetLabel`・`formatAllocationSummary`・`probabilitySumWarning`・
 * `buildAllocationNotices`・各 NOTE 定数・`evThresholdFootnote`・
 * `placeBetUnavailableMessage`・reasonコード→文言のマップ)は
 * `renderer/bet-allocation-view.ts` に残る(表示/計算の分割線。Issue #57)。
 */

import {
  allocateBets,
  DEFAULT_BET_ALLOCATION_CONFIG,
  type AllocationHorse,
  type BetAllocationResult,
} from "@keiba/core/ev/bet-allocation";

import type { AnalysisRow, OddsStatus } from "./analysis-types.js";

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
