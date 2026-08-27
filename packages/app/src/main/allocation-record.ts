/**
 * allocation-record — 配分提案の永続化(Issue #59・#56-3)。
 *
 * `shared/mixed-race-allocation.ts` の `buildMixedRaceAllocationWithOutcome` が返す
 * `MixedRaceAllocationOutcome`(view + コード付き到達状態)を、core `AnalysisStore.saveAnalysis`
 * が受け取る `AnalysisAllocationRecord`(analysis_allocation_meta / analysis_bets の2テーブル分)へ
 * 変換する純関数を持つ。呼び出し側(main/analysis-pipeline.ts)の変更を最小に保つため、
 * 経路網羅のロジックはすべてこのファイルに集約する(boss着手前ゲート2026-08-27・#59)。
 *
 * ## 列の由来(#59スキーマ固定。増減は停止条件)
 *
 * - 設定エコー7列(bankroll/per_race_cap/kelly_fraction/ev_threshold/include_combo_odds/
 *   include_wide/include_trio): 呼び出し時に渡した `MixedAllocationSettings`(7項目)をそのまま写す。
 *   route に関わらず常に非null(実行時に確定している値のため)。
 * - コード5列(route/unavailable_reason/fallback_reason/skip_reason_code/combo_odds_wide/
 *   combo_odds_trio): `AllocationOutcomeCodes` をそのまま6列へ分解する(comboOddsはwide/trioの2列)。
 * - 実効値4列(bet_unit/greedy_steps/candidate_cap/model_id・model_approximate):
 *   経路ごとに参照するconfigオブジェクトを一致させる(2026-08-27追加指定)。
 *   `betUnit`/`greedySteps`は「これらの値が実際に使われた」経路の既定値定数を直接参照する
 *   (`allocateGeneralBets`/`allocatePlaceBets`のconfig引数と同じ定数。値が偶然一致していても
 *   参照先を経路と一致させておくことで、将来どちらかが分岐したときに保存済みの列が
 *   静かに嘘になる事故を防ぐ):
 *     - place-only(`view.kind==="computed"`) → `DEFAULT_BET_ALLOCATION_CONFIG`
 *     - mixed(`view.kind==="mixed"`)・invalid(`view.kind==="invalid"`、または本ファイル外〈
 *       analysis-pipeline.ts〉が呼び出し自体の例外を捕捉したケース) → `DEFAULT_GENERAL_BET_ALLOCATION_CONFIG`
 *     - unset/yoso/unavailable(coreの配分計算に未到達) → null(実効値が存在しない)
 *   `candidateCap`はplace-only経路のconfig(`BetAllocationConfig`)に存在しないフィールドのため
 *   place-onlyは常にnull。model_id/model_approximateは配分結果オブジェクト(`BetAllocationResult`/
 *   `GeneralBetAllocationResult`)由来のため、結果を実際に得た経路(place-only/mixed)のみ非null。
 */

import {
  DEFAULT_BET_ALLOCATION_CONFIG,
  type BetAllocation,
} from "@keiba/core/ev/bet-allocation";
import {
  buildComboOddsKey,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type GeneralBetAllocation,
} from "@keiba/core/ev/combo-bet-allocation";
import type {
  AnalysisAllocationMetaRecord,
  AnalysisAllocationRecord,
  AnalysisBetRecord,
} from "@keiba/core";

import type { OddsStatus } from "../shared/analysis-types.js";
import type {
  AllocationOutcomeCodes,
  MixedAllocationSettings,
  MixedRaceAllocationOutcome,
} from "../shared/mixed-race-allocation.js";

/**
 * `AnalysisPipelineDeps.allocationSettings` が持つ6項目(`evThreshold` を含まない)。
 * `evThreshold` は `deps.evConfig ?? DEFAULT_EV_CONFIG` から別途導出し、二重ソースを
 * 作らない(analysis-pipeline.ts 側の責務。#59 3節)。
 */
export interface AnalysisAllocationSettings {
  readonly bankroll: number;
  readonly perRaceCap: number;
  readonly kellyFraction: number;
  readonly includeComboOdds: boolean;
  readonly includeWideInAllocation: boolean;
  readonly includeTrioInAllocation: boolean;
}

/**
 * 6項目の `AnalysisAllocationSettings` に、別途解決した `evThreshold` を合成して
 * `buildMixedRaceAllocationWithOutcome` が要求する7項目の `MixedAllocationSettings` を作る。
 */
export function toMixedAllocationSettings(
  settings: AnalysisAllocationSettings,
  evThreshold: number,
): MixedAllocationSettings {
  return { ...settings, evThreshold };
}

/** `AllocationOutcomeCodes` を、メタ行のコード5列(comboOddsはwide/trioの2列)へ分解する。 */
function codesColumnsOf(
  codes: AllocationOutcomeCodes,
): Pick<
  AnalysisAllocationMetaRecord,
  "route" | "unavailableReason" | "fallbackReason" | "skipReasonCode" | "comboOddsWide" | "comboOddsTrio"
> {
  return {
    route: codes.route,
    unavailableReason: codes.unavailableReason,
    fallbackReason: codes.fallbackReason,
    skipReasonCode: codes.skipReasonCode,
    comboOddsWide: codes.comboOdds?.wide ?? null,
    comboOddsTrio: codes.comboOdds?.trio ?? null,
  };
}

/** `MixedAllocationSettings`(7項目)を、メタ行の設定エコー7列へ写す。 */
function settingsColumnsOf(
  settings: MixedAllocationSettings,
): Pick<
  AnalysisAllocationMetaRecord,
  "bankroll" | "perRaceCap" | "kellyFraction" | "evThreshold" | "includeComboOdds" | "includeWide" | "includeTrio"
> {
  return {
    bankroll: settings.bankroll,
    perRaceCap: settings.perRaceCap,
    kellyFraction: settings.kellyFraction,
    evThreshold: settings.evThreshold,
    includeComboOdds: settings.includeComboOdds,
    includeWide: settings.includeWideInAllocation,
    includeTrio: settings.includeTrioInAllocation,
  };
}

/** 買い目を構成する馬番の頭数から券種コードを決める(1→複勝・2→ワイド・3→3連複)。 */
function betTypeOfUmabans(umabans: readonly number[]): "place" | "wide" | "trio" {
  switch (umabans.length) {
    case 1:
      return "place";
    case 2:
      return "wide";
    case 3:
      return "trio";
    default:
      // allocateGeneralBets が返す候補は buildMixedCandidates が betTypes(place/wide/trio)
      // からしか作らないため、頭数はこの3値以外にならない(契約違反の防御)。
      throw new Error(
        `betTypeOfUmabans: 想定外の頭数(${umabans.length})の買い目(umabans=${JSON.stringify(umabans)})`,
      );
  }
}

/** 複勝配分結果(`BetAllocationResult.allocations`)から stake>0 の明細行だけを作る。 */
function placeBetsOf(allocations: readonly BetAllocation[]): AnalysisBetRecord[] {
  return allocations
    .filter((a) => a.stake > 0)
    .map((a) => ({
      betType: "place",
      comboKey: buildComboOddsKey([a.umaban]),
      stake: a.stake,
      odds: a.placeOddsMin,
      ev: a.ev,
    }));
}

/** 混在配分結果(`GeneralBetAllocationResult.allocations`)から stake>0 の明細行だけを作る。 */
function mixedBetsOf(allocations: readonly GeneralBetAllocation[]): AnalysisBetRecord[] {
  return allocations
    .filter((a) => a.stake > 0)
    .map((a) => ({
      betType: betTypeOfUmabans(a.umabans),
      comboKey: buildComboOddsKey(a.umabans),
      stake: a.stake,
      odds: a.odds,
      ev: a.ev,
    }));
}

/**
 * `buildMixedRaceAllocationWithOutcome` の戻り値を `AnalysisAllocationRecord` へ変換する。
 * 呼び出し側(analysis-pipeline.ts)はこの関数が返した値をそのまま `AnalysisRecord.allocation` に
 * 積んで `saveAnalysis` へ渡すだけでよい。
 *
 * 例外は投げない: `view.kind` の網羅switchで全6ルート(unset/yoso/unavailable/place-only〈
 * view.kind==="computed"〉/mixed/invalid)を処理する。`buildMixedRaceAllocationWithOutcome`
 * 自体が投げる可能性のある契約違反例外(呼び出し元の前提が崩れている場合の防御。
 * mixed-race-allocation.ts 参照)は、この関数の呼び出し側(analysis-pipeline.ts)の
 * try/catchが担当する(`buildInvalidAllocationRecordForException`参照)。
 */
export function buildAllocationRecord(
  outcome: MixedRaceAllocationOutcome,
  settings: MixedAllocationSettings,
  oddsStatus: OddsStatus,
): AnalysisAllocationRecord {
  const codesColumns = codesColumnsOf(outcome.outcome);
  const settingsColumns = settingsColumnsOf(settings);
  const { view } = outcome;

  switch (view.kind) {
    case "unset":
    case "yoso":
    case "unavailable":
      // coreの配分計算(allocatePlaceBets/allocateGeneralBets)に未到達。
      return {
        meta: {
          ...codesColumns,
          ...settingsColumns,
          betUnit: null,
          greedySteps: null,
          candidateCap: null,
          modelId: null,
          modelApproximate: null,
          oddsStatus,
        },
        bets: [],
      };
    case "computed": {
      // D-2フォールバックにより複勝のみ(place-only)へ潰れたケース。
      const result = view.result;
      return {
        meta: {
          ...codesColumns,
          ...settingsColumns,
          betUnit: DEFAULT_BET_ALLOCATION_CONFIG.betUnit,
          greedySteps: DEFAULT_BET_ALLOCATION_CONFIG.greedySteps,
          candidateCap: null, // BetAllocationConfigにcandidateCapは存在しない(暴走ガードは組合せ券種のみ)。
          modelId: result.modelId,
          modelApproximate: result.modelApproximate,
          oddsStatus,
        },
        bets: placeBetsOf(result.allocations),
      };
    }
    case "mixed": {
      const result = view.result;
      return {
        meta: {
          ...codesColumns,
          ...settingsColumns,
          betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
          greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
          candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
          modelId: result.modelId,
          modelApproximate: result.modelApproximate,
          oddsStatus,
        },
        bets: mixedBetsOf(result.allocations),
      };
    }
    case "invalid":
      // allocateGeneralBets自体の例外はmixed-race-allocation.ts内でAC17によりtry/catch済みで、
      // ここに正常な戻り値として到達する(呼び出し自体は例外を投げていない)。configはmixed経路と
      // 同じ既定値を使っていたことが確定しているため(mixed-race-allocation.ts:393-401参照)、
      // bet_unit/greedy_steps/candidate_capは非nullにする(2026-08-27追加指定)。
      return {
        meta: {
          ...codesColumns,
          ...settingsColumns,
          betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
          greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
          candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
          modelId: null,
          modelApproximate: null,
          oddsStatus,
        },
        bets: [],
      };
  }
}

/**
 * `buildMixedRaceAllocationWithOutcome`の呼び出し自体が例外を投げたとき
 * (呼び出し元の前提が崩れている契約違反の防御。極めて稀)のフォールバックメタ行を作る
 * (AC6)。この分析はLLM呼び出し(実課金)を済ませている可能性があるため、配分計算の
 * 例外で分析本体の保存を失わせない(呼び出し側 analysis-pipeline.ts の try/catch が使う)。
 *
 * `AllocationOutcomeCodes`由来の5列はすべてnullにする(呼び出しが例外で止まったため、
 * どの層まで到達したか〈outcome〉自体を得られていない。#31: 判定不能をnullで表す)。
 * bet_unit/greedy_steps/candidate_capは、この極めて稀な例外を`route="invalid"`の通常ケース
 * (`view.kind==="invalid"`。上の`buildAllocationRecord`参照)と同じ扱いにする
 * (2026-08-27追加指定: 呼び出し側〈本関数〉がどの内部分岐で例外を捕捉したかによらず一律
 * `DEFAULT_GENERAL_BET_ALLOCATION_CONFIG`を直接参照する。実際にこの設定でconfigが構築された
 * ことを検証してから記録するのではなく、`route="invalid"`は常にこの参照先だと決め打つことで、
 * 例外発生元の内部分岐(unset/yoso/unavailableのD-2フォールバック判定内・mixed経路の判定通過後
 * いずれも)を問わず一貫した値になる)。
 */
export function buildInvalidAllocationRecordForException(
  settings: MixedAllocationSettings,
  oddsStatus: OddsStatus,
): AnalysisAllocationRecord {
  return {
    meta: {
      route: "invalid",
      unavailableReason: null,
      fallbackReason: null,
      skipReasonCode: null,
      comboOddsWide: null,
      comboOddsTrio: null,
      ...settingsColumnsOf(settings),
      betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
      greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
      candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
      modelId: null,
      modelApproximate: null,
      oddsStatus,
    },
    bets: [],
  };
}
