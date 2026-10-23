/**
 * recompute-allocation — 確率(補正後の3着内率)を固定して、オッズだけから EV と配分提案を作り直す純関数(Issue #338〈#335-A1〉)。
 *
 * `runAnalysis`(`analysis-pipeline.ts`)の手順 (4) EV 計算と (6) 配分提案を、ここへ抽出した。`runAnalysis` 自身もこれらの関数を呼ぶ
 * (抽出の前後で出力が変わらないことは、`pipeline-golden.json` がバイト同一であることと、`recompute-allocation.test.ts` の
 * 「同じ確率・同じオッズなら保存済みの配分に一致する」で固定している)。クラウド版は、発走の直前にオッズだけを取り直し、
 * 分析時に DO へ控えた確率でこの関数を呼んで、買い目の変化を調べる(LLM は呼ばない)。
 *
 * - {@link computeEvForProbs}: 手順 (4)。発売前(yoso)は単勝からの推定 EV、それ以外は複勝下限の確定 EV。
 * - {@link buildAllocationForRows}: 手順 (6)。配分の計算自体が例外を投げても、無効の記録に変えて返す(分析の保存を失わせないため)。
 * - {@link recomputeAllocationFromProbs}: 上の 2 つに、最小の行(`AnalysisRow`)の組み立てを足した、再計算の入口。
 *
 * 決定的(乱数・時刻を使わない)。入力の配列は書き換えない。
 */
import {
  computeEstimatedRaceEv,
  computeRaceEv,
  DEFAULT_ESTIMATED_PLACE_CONFIG,
  DEFAULT_EV_CONFIG,
  type AnalysisAllocationRecord,
  type EstimatedPlaceConfig,
  type EvConfig,
  type HorsePrior,
  type RaceData,
} from "../pipeline.js";
import type { HorseEv } from "../ev/expected-value.js";
import type { AnalysisRow } from "./analysis-types.js";
import type { MixedCandidateBuildInput } from "./mixed-candidates.js";
import { buildMixedRaceAllocationWithOutcome } from "./mixed-race-allocation.js";
import {
  buildAllocationRecord,
  buildInvalidAllocationRecordForException,
  toMixedAllocationSettings,
  type AnalysisAllocationSettings,
} from "./allocation-record.js";
import { buildComboStats, type ComboStats } from "./combo-stats.js";

/** 手順 (4) の結果。 */
export interface EvForProbsResult {
  /** 発売前(yoso)の推定 EV か。 */
  readonly evEstimated: boolean;
  /** 入力の並びのまま、馬ごとの EV。 */
  readonly evResults: readonly HorseEv[];
}

/**
 * 手順 (4) EV 計算(補正後確率 × 複勝オッズ下限)。発売前(yoso)は複勝オッズが常に空のため、単勝オッズからの推定 EV に切り替える。
 * それ以外(result/middle)は従来どおり確定 EV。
 */
export function computeEvForProbs(
  priors: readonly HorsePrior[],
  odds: RaceData["odds"],
  evConfig?: EvConfig,
  estimatedPlaceConfig?: EstimatedPlaceConfig,
): EvForProbsResult {
  const evEstimated = odds.oddsStatus === "yoso";
  const evResults = evEstimated
    ? computeEstimatedRaceEv(
        priors,
        odds,
        evConfig ?? DEFAULT_EV_CONFIG,
        estimatedPlaceConfig ?? DEFAULT_ESTIMATED_PLACE_CONFIG,
      )
    : computeRaceEv(priors, odds, evConfig ?? DEFAULT_EV_CONFIG);
  return { evEstimated, evResults };
}

/** 手順 (6) の入力。 */
export interface AllocationForRowsInput {
  readonly rows: readonly AnalysisRow[];
  readonly raceId: string;
  readonly odds: RaceData["odds"];
  readonly comboOdds?: RaceData["meta"]["comboOdds"];
  readonly allocationSettings: AnalysisAllocationSettings;
  readonly evConfig?: EvConfig;
  /**
   * 的中確率の下限(Issue #470)で外れた買い目について、外さなかった場合の賭け金を記録するか(既定 false)。分析時の保存だけが true にする。
   * 締切の直前の再計算は false(下限は適用するが、記録のための2回目の配分は呼ばない)。
   */
  readonly recordMissed?: boolean;
}

/** 手順 (6) の結果。 */
export interface AllocationForRowsResult {
  readonly allocation: AnalysisAllocationRecord;
  /** 組合せの券種ごとの EV プラスの点数(Issue #296)。配分の候補を作った経路だけ非 null。例外で無効の記録になったときは null。 */
  readonly comboStats: ComboStats | null;
}

/**
 * 手順 (6) 配分提案。EV 閾値は evConfig から導出する単一ソース(allocationSettings には持たせない)。
 * `buildMixedRaceAllocationWithOutcome` 自体の例外(呼び出し元の前提が崩れている場合の防御。極めて稀)は、無効の記録(route="invalid")に変えて返す。
 */
export function buildAllocationForRows(input: AllocationForRowsInput): AllocationForRowsResult {
  const { odds } = input;
  const evThreshold = (input.evConfig ?? DEFAULT_EV_CONFIG).threshold;
  const mixedSettings = toMixedAllocationSettings(input.allocationSettings, evThreshold, input.recordMissed === true);
  // MixedCandidateBuildInput は条件付き spread で組む(組合せオッズが無い券種はキー自体を持たせない)。
  const raceForAllocation: MixedCandidateBuildInput = {
    oddsStatus: odds.oddsStatus,
    rows: input.rows,
    raceId: input.raceId,
    ...(odds.wideCombo !== undefined ? { wideCombo: odds.wideCombo } : {}),
    ...(odds.trioCombo !== undefined ? { trioCombo: odds.trioCombo } : {}),
    ...(odds.quinellaCombo !== undefined ? { quinellaCombo: odds.quinellaCombo } : {}),
    ...(odds.exactaCombo !== undefined ? { exactaCombo: odds.exactaCombo } : {}),
    ...(odds.trifectaCombo !== undefined ? { trifectaCombo: odds.trifectaCombo } : {}),
    ...(odds.bracketQuinellaCombo !== undefined ? { bracketQuinellaCombo: odds.bracketQuinellaCombo } : {}),
    ...(input.comboOdds !== undefined ? { comboOdds: input.comboOdds } : {}),
  };
  try {
    const outcome = buildMixedRaceAllocationWithOutcome(raceForAllocation, mixedSettings);
    return {
      allocation: buildAllocationRecord(outcome, mixedSettings, odds.oddsStatus),
      comboStats: buildComboStats(outcome),
    };
  } catch {
    // 診断ログは持たない(メタ行の route="invalid" で十分)。
    return { allocation: buildInvalidAllocationRecordForException(mixedSettings, odds.oddsStatus), comboStats: null };
  }
}

/** 再計算に要る、馬ごとの最小の入力(分析時に DO の表へ控える)。 */
export interface RecomputeHorseInput {
  readonly umaban: number;
  readonly wakuban: number;
  readonly horseName: string;
  /** 統計モデルの事前確率。 */
  readonly prior: number;
  /** 分析時の補正後の3着内率(LLM なし・失敗時は prior と同値)。再計算では変えない。 */
  readonly adjustedProb: number;
}

export interface RecomputeAllocationInput {
  readonly raceId: string;
  readonly horses: readonly RecomputeHorseInput[];
  /** 取り直した単勝・複勝・組合せのオッズ。 */
  readonly odds: RaceData["odds"];
  /** 組合せオッズの取得結果の診断(`race.meta.comboOdds`)。組合せを取り直さなかったときは省略。 */
  readonly comboOdds?: RaceData["meta"]["comboOdds"];
  readonly allocationSettings: AnalysisAllocationSettings;
  readonly evConfig?: EvConfig;
  readonly estimatedPlaceConfig?: EstimatedPlaceConfig;
}

export interface RecomputeAllocationResult {
  readonly oddsStatus: RaceData["odds"]["oddsStatus"];
  readonly evEstimated: boolean;
  /** 馬番昇順。配分に使わない項目(根拠・印・戦績の走数など)は空の値。 */
  readonly rows: readonly AnalysisRow[];
  readonly allocation: AnalysisAllocationRecord;
  readonly comboStats: ComboStats | null;
}

/**
 * 確率を固定して、新しいオッズから EV と配分提案を作り直す。馬番の重複・確率の非有限などの検査は呼び出し側の責務(分析時に控えた値をそのまま渡す)。
 */
export function recomputeAllocationFromProbs(input: RecomputeAllocationInput): RecomputeAllocationResult {
  const horses = [...input.horses].sort((a, b) => a.umaban - b.umaban);
  const { evEstimated, evResults } = computeEvForProbs(
    horses.map((h) => ({ umaban: h.umaban, placeProb: h.adjustedProb })),
    input.odds,
    input.evConfig,
    input.estimatedPlaceConfig,
  );
  const evByUmaban = new Map(evResults.map((e) => [e.umaban, e]));
  const rows: AnalysisRow[] = horses.map((h) => {
    const ev = evByUmaban.get(h.umaban)!;
    return {
      umaban: h.umaban,
      wakuban: h.wakuban,
      horseName: h.horseName,
      prior: h.prior,
      adjustedProb: h.adjustedProb,
      placeOddsMin: ev.placeOddsMin,
      winOdds: input.odds.win[h.umaban]?.odds ?? null,
      ev: ev.ev,
      isPositive: ev.isPositive,
      reason: null,
      highlights: [],
      concerns: [],
      careerRunCount: null,
      mark: null,
      evEstimated,
      conditionChangeTags: [],
    };
  });
  const { allocation, comboStats } = buildAllocationForRows({
    rows,
    raceId: input.raceId,
    odds: input.odds,
    comboOdds: input.comboOdds,
    allocationSettings: input.allocationSettings,
    evConfig: input.evConfig,
  });
  return { oddsStatus: input.odds.oddsStatus, evEstimated, rows, allocation, comboStats };
}
