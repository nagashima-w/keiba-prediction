/**
 * #156(#41-B)の集計(オフライン。ネットワークには出ない)。
 * #41 の観測 JSON(prior・結果・オッズ)と、段階3の出力(`llm-observations/<raceId>.json`。LLM 補正後)から、
 * **prior と LLM 補正後を同じレース集合の対で**、中央・地方を**別々に**集計する
 * (`docs/investigations/probability-quality-41-llm/measurement-plan.md` §指標)。
 *
 * 数値の算出は core の公開エントリポイント(`buildBrierQualityReport`・`buildPairedBrierComparison`)に委ねる。
 * このファイルが持つのは、観測と記録の結合・整合性の検証・レース集合の絞り込み・記述統計
 * (補正量・方向性)だけ。
 *
 * ## 実行
 *   pnpm tsx scripts/probability-quality-41-llm/aggregate.ts [--prompt-version <版>]
 * `--prompt-version` は、照合する記録のプロンプト版(省略なら現行の `PROMPT_VERSION`)。コミット済みの #156 の観測
 * (版 `2026-07-28.2`)を集計し直すときは `--prompt-version 2026-07-28.2` を付ける(Issue #200。結果は `aggregate.json` と一致する)。
 * 出力先は版にかかわらず下の `aggregate.json`(別の版の観測で実行すると上書きされる点に注意)。
 * 既定の入力は `docs/investigations/probability-quality-41/observations` と
 * `docs/investigations/probability-quality-41-llm/llm-observations`。出力は
 * `docs/investigations/probability-quality-41-llm/aggregate.json`。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildBrierQualityReport,
  buildPairedBrierComparison,
  MIN_FIELD_SIZE_FOR_PLACE_MARKET,
  type BrierQualityReport,
  type PairedBrierComparison,
  type PairedBrierInputHorse,
  type PriorSource,
} from "../../packages/core/src/ev/probability-quality.js";
import { CLIP_VARIANTS, PROMPT_VERSION } from "../../packages/core/src/index.js";
import { loadObservations } from "../probability-quality-41/aggregate.js";
import type { RaceObservation, RaceObservationOk } from "../probability-quality-41/observation.js";
import { LLM_OBSERVATION_SCHEMA_VERSION, type LlmRaceRecord } from "./records.js";

/** ブートストラップの反復回数とシード(#41 と同じ値。取得前の計画で固定)。 */
export const LLM_AGGREGATE_BOOTSTRAP = { iterations: 10000, seed: 20261001 } as const;
/** resolution の参照値(レース内ラベル並べ替え)の反復回数とシード(同上)。 */
export const LLM_AGGREGATE_PERMUTATION = { iterations: 1000, seed: 20261001 } as const;

/** 数値が(ほぼ)0かどうかの判定幅(符号一致の対象から外す)。 */
const ZERO_EPS = 1e-12;

/** 市場比較に使える確定オッズか(#41 の aggregate.ts と同じ。地方は `middle` のみ)。 */
function isFinalOdds(region: "central" | "nar", status: string): boolean {
  return region === "central" ? status === "result" : status === "middle";
}

/**
 * 複勝オッズ下限から作る市場含意確率(`1/placeOddsMin` を Σ=3 に正規化)。1頭でも欠損・非正・非有限なら null。
 * core の `computeMarketImpliedPlaceProbabilities`(内部)と同じ定義で、テストで一致を確かめている。
 */
export function marketImpliedLowerBound(
  horses: ReadonlyArray<{ readonly umaban: number; readonly placeOddsMin: number | null }>,
): Map<number, number> | null {
  if (horses.length === 0) return null;
  let sum = 0;
  for (const h of horses) {
    if (h.placeOddsMin === null || !Number.isFinite(h.placeOddsMin) || h.placeOddsMin <= 0) return null;
    sum += 1 / h.placeOddsMin;
  }
  return new Map(horses.map((h) => [h.umaban, ((1 / h.placeOddsMin!) / sum) * 3]));
}

/** 数値の要約(レース別の値の中央値とレンジ)。 */
export interface NumberSummary {
  readonly n: number;
  /** 算出不能だったレース数(値が null)。 */
  readonly nullCount: number;
  readonly median: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

function summarizeNumbers(values: ReadonlyArray<number | null>): NumberSummary {
  const nums = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const mid = nums.length >> 1;
  return {
    n: nums.length,
    nullCount: values.length - nums.length,
    median: nums.length === 0 ? null : nums.length % 2 === 1 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2,
    min: nums.length === 0 ? null : nums[0]!,
    max: nums.length === 0 ? null : nums[nums.length - 1]!,
  };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

/** Pearson 相関。どちらかの分散が0(または2点未満)なら null。 */
function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  if (sxx <= ZERO_EPS || syy <= ZERO_EPS) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** y を x に回帰した傾き(切片あり)。x の分散が0(または2点未満)なら null。 */
function slope(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  if (sxx <= ZERO_EPS) return null;
  return sxy / sxx;
}

/** 観測(prior・結果・オッズ)と LLM 記録を結合した1レース。 */
interface JoinedRace {
  readonly obs: RaceObservationOk;
  readonly rec: LlmRaceRecord;
  /** 馬番 → LLM 補正後確率。 */
  readonly llmByUmaban: ReadonlyMap<number, number>;
}

/** 補正量の記述統計(地域の全馬)。 */
export interface AdjustmentSummary {
  readonly horseCount: number;
  /** δ = 補正後 − prior の平均(符号つき)。 */
  readonly meanDelta: number | null;
  readonly meanAbsDelta: number | null;
  readonly maxAbsDelta: number | null;
  /** ±maxAdjust(または [0,1])でクリップされた馬の数。 */
  readonly clippedHorseCount: number;
  /** LLM の値が使えず prior を採用した馬の数(馬番欠け・不正値)。 */
  readonly usedPriorHorseCount: number;
  readonly placedHorseCount: number;
  readonly notPlacedHorseCount: number;
  /** 3着以内に入った馬の平均 δ(補正の向きが結果と合ったか)。 */
  readonly meanDeltaPlaced: number | null;
  readonly meanDeltaNotPlaced: number | null;
  /** レースごとの `Σ補正後確率 − min(3, 頭数)` の要約(production は再正規化しない)。 */
  readonly sumDeviation: NumberSummary;
}

/** 方向性(LLM の補正が市場に寄ったか。市場比較可能なレースだけ)。 */
export interface TowardMarketSummary {
  readonly raceCount: number;
  readonly horseCount: number;
  /** x = 市場含意確率 − prior、y = 補正後 − prior の馬単位の Pearson 相関(プール)。定義できなければ null。 */
  readonly pooledCorrelation: number | null;
  /** y を x に回帰した傾き(プール)。1 なら市場まで寄せた、0 なら動かさなかった、負なら反対側。 */
  readonly pooledSlope: number | null;
  /** レース別の相関の要約。 */
  readonly perRaceCorrelation: NumberSummary;
  /** 補正が 0 でなく、市場との差も 0 でない馬の、補正の符号が市場の方向と一致した数。 */
  readonly signAgreement: { readonly agree: number; readonly disagree: number; readonly total: number };
  /** 馬ごとの |prior − 市場| の平均。 */
  readonly meanAbsDistancePriorToMarket: number | null;
  /** 馬ごとの |補正後 − 市場| の平均(prior より小さければ市場に寄った)。 */
  readonly meanAbsDistanceLlmToMarket: number | null;
}

/** LLM の実行の要約(レースID)。 */
export interface LlmRunSummary {
  readonly fallbackRaceIds: readonly string[];
  readonly marksDroppedRaceIds: readonly string[];
  readonly retriedRaceIds: readonly string[];
  readonly truncatedRaceIds: readonly string[];
}

/** 感度: fallback したレースを除いた集計(prior と LLM を同じ集合の対で)。 */
export interface FallbackSensitivity {
  readonly excludedRaceIds: readonly string[];
  readonly prior: BrierQualityReport;
  readonly llm: BrierQualityReport;
  readonly paired: PairedBrierComparison;
}

/** 1地域分の集計。 */
export interface LlmRegionAggregate {
  readonly region: "central" | "nar";
  readonly raceCount: number;
  readonly observationCount: number;
  /** 市場比較可能なレース(出走8頭以上・確定オッズ・市場含意確率が正常)。 */
  readonly marketEligibleRaceIds: readonly string[];
  /** 主表: prior と LLM 補正後をそれぞれ `buildBrierQualityReport` に通したもの(対市場の比較を含む)。 */
  readonly series: { readonly prior: BrierQualityReport; readonly llm: BrierQualityReport };
  /** 主表: LLM − prior の対の比較(全レース・市場比較可能な集合)。 */
  readonly paired: {
    readonly allRaces: PairedBrierComparison;
    readonly marketEligible: PairedBrierComparison | null;
  };
  readonly sensitivityExcludingFallback: FallbackSensitivity;
  readonly llmRun: LlmRunSummary;
  /** 補正量の記述統計(全レース。**fallback したレースの馬〈補正 0・prior 採用〉を含む**)。 */
  readonly adjustment: AdjustmentSummary;
  /** 同上を fallback したレースを除いて出したもの(補正量・prior 採用の馬数を読むときはこちらも見る)。 */
  readonly adjustmentExcludingFallback: AdjustmentSummary;
  readonly towardMarket: TowardMarketSummary;
}

/** 集計結果一式。 */
export interface LlmAggregateResult {
  readonly conditions: {
    readonly promptVersion: string;
    readonly clipVariant: "default";
    readonly maxAdjust: number;
    readonly minFieldSizeForMarket: number;
    readonly bootstrap: typeof LLM_AGGREGATE_BOOTSTRAP;
    readonly permutation: typeof LLM_AGGREGATE_PERMUTATION;
    readonly note: string;
  };
  readonly central: LlmRegionAggregate;
  readonly nar: LlmRegionAggregate;
}

const NOTE =
  "LLM 補正後は、サブエージェントの応答を production の analyzeRace(パース・クリップ・リトライ・フォールバック)に通した値。" +
  "production の LLM(claude-sonnet-4-6・temperature 0)と同一ではない近似。区間はレース集合の再標本化だけで、" +
  "LLM のサンプリングのばらつきを含まない。市場は確定オッズの複勝下限を Σ=3 に正規化した近似。";

function brierReport(
  races: readonly JoinedRace[],
  source: PriorSource,
  probOf: (race: JoinedRace, umaban: number, prior: number) => number,
): BrierQualityReport {
  return buildBrierQualityReport({
    horses: races.flatMap((r) =>
      r.obs.horses.map((h) => ({
        raceId: r.obs.raceId,
        umaban: h.umaban,
        modelProb: probOf(r, h.umaban, h.prior),
        occurred: h.outcome === 1,
        placeOddsMin: h.placeOddsMin,
        placeOddsMax: h.placeOddsMax,
      })),
    ),
    priorSource: source,
    bootstrap: LLM_AGGREGATE_BOOTSTRAP,
    permutation: LLM_AGGREGATE_PERMUTATION,
    // 確定オッズでないレースは、複勝オッズの値を使わず「確定でない」として市場比較から外す(#41 と同じ)。
    oddsNotFinalRaceIds: races.filter((r) => !isFinalOdds(r.obs.region, r.obs.oddsStatus)).map((r) => r.obs.raceId),
  });
}

const priorProb = (_r: JoinedRace, _umaban: number, prior: number): number => prior;
const llmProb = (r: JoinedRace, umaban: number): number => r.llmByUmaban.get(umaban)!;

function pairedReport(races: readonly JoinedRace[]): PairedBrierComparison {
  const horses: PairedBrierInputHorse[] = races.flatMap((r) =>
    r.obs.horses.map((h) => ({
      raceId: r.obs.raceId,
      umaban: h.umaban,
      modelProb: llmProb(r, h.umaban),
      referenceProb: h.prior,
      occurred: h.outcome === 1,
    })),
  );
  return buildPairedBrierComparison({
    horses,
    modelSource: "llm-adjusted",
    referenceSource: "prior-only",
    bootstrap: LLM_AGGREGATE_BOOTSTRAP,
  });
}

function adjustmentSummary(races: readonly JoinedRace[]): AdjustmentSummary {
  const deltas: Array<{ delta: number; outcome: 0 | 1 }> = [];
  let clipped = 0;
  let usedPrior = 0;
  for (const r of races) {
    const recByUmaban = new Map(r.rec.horses.map((h) => [h.umaban, h]));
    for (const h of r.obs.horses) {
      deltas.push({ delta: llmProb(r, h.umaban) - h.prior, outcome: h.outcome });
      const rec = recByUmaban.get(h.umaban)!;
      if (rec.clipped) clipped += 1;
      if (rec.usedPrior) usedPrior += 1;
    }
  }
  const placed = deltas.filter((d) => d.outcome === 1).map((d) => d.delta);
  const notPlaced = deltas.filter((d) => d.outcome === 0).map((d) => d.delta);
  const abs = deltas.map((d) => Math.abs(d.delta));
  return {
    horseCount: deltas.length,
    meanDelta: mean(deltas.map((d) => d.delta)),
    meanAbsDelta: mean(abs),
    maxAbsDelta: abs.length === 0 ? null : Math.max(...abs),
    clippedHorseCount: clipped,
    usedPriorHorseCount: usedPrior,
    placedHorseCount: placed.length,
    notPlacedHorseCount: notPlaced.length,
    meanDeltaPlaced: mean(placed),
    meanDeltaNotPlaced: mean(notPlaced),
    sumDeviation: summarizeNumbers(
      races.map(
        (r) =>
          r.obs.horses.reduce((s, h) => s + llmProb(r, h.umaban), 0) - Math.min(3, r.obs.horses.length),
      ),
    ),
  };
}

function towardMarketSummary(races: readonly JoinedRace[]): TowardMarketSummary {
  const xs: number[] = [];
  const ys: number[] = [];
  const distPrior: number[] = [];
  const distLlm: number[] = [];
  const perRace: Array<number | null> = [];
  let agree = 0;
  let disagree = 0;
  for (const r of races) {
    const market = marketImpliedLowerBound(r.obs.horses.map((h) => ({ umaban: h.umaban, placeOddsMin: h.placeOddsMin })));
    if (market === null) {
      throw new Error(`${r.obs.raceId}: 市場比較可能なレースの市場含意確率が作れない(集合の絞り込みと食い違い)`);
    }
    const rx: number[] = [];
    const ry: number[] = [];
    for (const h of r.obs.horses) {
      const m = market.get(h.umaban)!;
      const llm = llmProb(r, h.umaban);
      const x = m - h.prior;
      const y = llm - h.prior;
      xs.push(x);
      ys.push(y);
      rx.push(x);
      ry.push(y);
      distPrior.push(Math.abs(h.prior - m));
      distLlm.push(Math.abs(llm - m));
      if (Math.abs(x) > ZERO_EPS && Math.abs(y) > ZERO_EPS) {
        if (Math.sign(x) === Math.sign(y)) agree += 1;
        else disagree += 1;
      }
    }
    perRace.push(pearson(rx, ry));
  }
  return {
    raceCount: races.length,
    horseCount: xs.length,
    pooledCorrelation: pearson(xs, ys),
    pooledSlope: slope(xs, ys),
    perRaceCorrelation: summarizeNumbers(perRace),
    signAgreement: { agree, disagree, total: agree + disagree },
    meanAbsDistancePriorToMarket: mean(distPrior),
    meanAbsDistanceLlmToMarket: mean(distLlm),
  };
}

function aggregateRegion(region: "central" | "nar", races: readonly JoinedRace[]): LlmRegionAggregate {
  const mine = races.filter((r) => r.obs.region === region).sort((a, b) => (a.obs.raceId < b.obs.raceId ? -1 : 1));
  const prior = brierReport(mine, "prior-only", priorProb);
  const llm = brierReport(mine, "llm-adjusted", llmProb);

  const ex = prior.marketComparison.lowerBound.excludedRaces;
  const excluded = new Set([...ex.smallField, ...ex.oddsNotFinal, ...ex.marketUnavailable, ...ex.marketOutOfRange]);
  const eligible = mine.filter((r) => !excluded.has(r.obs.raceId));

  const fallbackIds = mine.filter((r) => r.rec.fallback).map((r) => r.obs.raceId);
  const fallbackSet = new Set(fallbackIds);
  const kept = mine.filter((r) => !fallbackSet.has(r.obs.raceId));

  return {
    region,
    raceCount: mine.length,
    observationCount: mine.reduce((s, r) => s + r.obs.horses.length, 0),
    marketEligibleRaceIds: eligible.map((r) => r.obs.raceId),
    series: { prior, llm },
    paired: {
      allRaces: pairedReport(mine),
      marketEligible: eligible.length === 0 ? null : pairedReport(eligible),
    },
    sensitivityExcludingFallback: {
      excludedRaceIds: fallbackIds,
      prior: brierReport(kept, "prior-only", priorProb),
      llm: brierReport(kept, "llm-adjusted", llmProb),
      paired: pairedReport(kept),
    },
    llmRun: {
      fallbackRaceIds: fallbackIds,
      marksDroppedRaceIds: mine.filter((r) => r.rec.marksDropped).map((r) => r.obs.raceId),
      retriedRaceIds: mine.filter((r) => r.rec.retryCount > 0).map((r) => r.obs.raceId),
      truncatedRaceIds: mine.filter((r) => r.rec.truncated).map((r) => r.obs.raceId),
    },
    adjustment: adjustmentSummary(mine),
    adjustmentExcludingFallback: adjustmentSummary(kept),
    towardMarket: towardMarketSummary(eligible),
  };
}

/**
 * 観測と LLM 記録を結合する。食い違いはすべて例外(集合の違う対・版の違う記録を作らない)。
 * `expectedPromptVersion` は、全記録の promptVersion が一致すべき版(混在は通さない)。
 */
function join(
  observations: readonly RaceObservation[],
  records: readonly LlmRaceRecord[],
  expectedPromptVersion: string,
): JoinedRace[] {
  const ok = observations.filter((o): o is RaceObservationOk => o.status === "ok");
  const okIds = new Set(ok.map((o) => o.raceId));
  const byRace = new Map<string, LlmRaceRecord>();
  for (const rec of records) {
    if (rec.schemaVersion !== LLM_OBSERVATION_SCHEMA_VERSION) {
      throw new Error(
        `${rec.raceId}: LLM 記録の schemaVersion が ${String(rec.schemaVersion)}(期待: ${LLM_OBSERVATION_SCHEMA_VERSION})`,
      );
    }
    if (!okIds.has(rec.raceId)) {
      throw new Error(`${rec.raceId}: LLM 記録に対応する #41 の観測(status: ok)がない`);
    }
    if (rec.promptVersion !== expectedPromptVersion) {
      throw new Error(`${rec.raceId}: LLM 記録の promptVersion が ${rec.promptVersion}(期待: ${expectedPromptVersion})`);
    }
    if (rec.maxAdjust !== CLIP_VARIANTS.default.maxAdjust) {
      throw new Error(`${rec.raceId}: LLM 記録の maxAdjust が ${rec.maxAdjust}(期待: ${CLIP_VARIANTS.default.maxAdjust})`);
    }
    byRace.set(rec.raceId, rec);
  }
  return [...ok]
    .sort((a, b) => (a.raceId < b.raceId ? -1 : 1))
    .map((obs) => {
      const rec = byRace.get(obs.raceId);
      if (rec === undefined) {
        throw new Error(`${obs.raceId}: #41 の観測はあるが LLM の記録がない`);
      }
      const obsUmabans = obs.horses.map((h) => h.umaban).sort((a, b) => a - b);
      const recUmabans = rec.horses.map((h) => h.umaban).sort((a, b) => a - b);
      if (obsUmabans.join(",") !== recUmabans.join(",")) {
        throw new Error(
          `${obs.raceId}: 馬番の集合が観測と違う(観測: ${obsUmabans.join(",")} / LLM: ${recUmabans.join(",")})`,
        );
      }
      const llmByUmaban = new Map(rec.horses.map((h) => [h.umaban, h.adjustedProb]));
      for (const h of obs.horses) {
        const recPrior = rec.horses.find((x) => x.umaban === h.umaban)!.prior;
        if (Math.abs(recPrior - h.prior) > 1e-9) {
          throw new Error(`${obs.raceId}: 馬番${h.umaban}の prior が観測と食い違う(${recPrior} ≠ ${h.prior})`);
        }
      }
      return { obs, rec, llmByUmaban };
    });
}

/** 集計の引数(Issue #200)。 */
export interface AggregateLlmOptions {
  /**
   * 照合するプロンプト版(全記録の promptVersion がこれと一致しなければ throw)。`conditions.promptVersion` にも載る。
   * 既定は現行の `PROMPT_VERSION`。旧版で記録した観測(#156 の `2026-07-28.2`)を集計し直すときに指定する。
   * 指定しても、記録に別の版が混ざれば throw する。
   */
  readonly expectedPromptVersion?: string;
}

/**
 * 観測と LLM 記録から集計を作る。入力の並びに依らない。中央と地方は混ぜない。
 */
export function aggregateLlm(
  observations: readonly RaceObservation[],
  records: readonly LlmRaceRecord[],
  options: AggregateLlmOptions = {},
): LlmAggregateResult {
  const promptVersion = options.expectedPromptVersion ?? PROMPT_VERSION;
  const joined = join(observations, records, promptVersion);
  return {
    conditions: {
      promptVersion,
      clipVariant: "default",
      maxAdjust: CLIP_VARIANTS.default.maxAdjust,
      minFieldSizeForMarket: MIN_FIELD_SIZE_FOR_PLACE_MARKET,
      bootstrap: LLM_AGGREGATE_BOOTSTRAP,
      permutation: LLM_AGGREGATE_PERMUTATION,
      note: NOTE,
    },
    central: aggregateRegion("central", joined),
    nar: aggregateRegion("nar", joined),
  };
}

/** LLM 記録ディレクトリの `<raceId>.json`(12桁数字のファイル名)を読む。 */
export function loadLlmRecords(dir: string): LlmRaceRecord[] {
  return readdirSync(dir)
    .filter((f) => /^[0-9]{12}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as LlmRaceRecord);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LLM_OUT_ROOT = path.join(REPO_ROOT, "docs", "investigations", "probability-quality-41-llm");
const OBS_DIR = path.join(REPO_ROOT, "docs", "investigations", "probability-quality-41", "observations");

/**
 * CLI の引数を読む。`--prompt-version <版>` だけ(照合するプロンプト版。省略なら現行の `PROMPT_VERSION`)。
 * 値が無い・空文字・別のオプションが続く・未知のオプションは throw する。
 */
export function parseAggregateArgs(argv: readonly string[]): { readonly promptVersion: string | undefined } {
  let promptVersion: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--prompt-version") {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--")) {
        throw new Error("--prompt-version には版(例: 2026-07-28.2)が必要です");
      }
      promptVersion = v;
      i += 1;
    } else {
      throw new Error(`未知のオプション: ${a}(使えるのは --prompt-version <版> だけ)`);
    }
  }
  return { promptVersion };
}

function main(): void {
  const args = parseAggregateArgs(process.argv.slice(2));
  const llmDir = path.join(LLM_OUT_ROOT, "llm-observations");
  if (!existsSync(llmDir)) {
    throw new Error(`${llmDir} がありません(段階3 apply.ts を先に実行してください)`);
  }
  const result = aggregateLlm(loadObservations(OBS_DIR), loadLlmRecords(llmDir), {
    expectedPromptVersion: args.promptVersion,
  });
  const out = path.join(LLM_OUT_ROOT, "aggregate.json");
  writeFileSync(out, JSON.stringify(result, null, 2), "utf-8");
  for (const r of [result.central, result.nar]) {
    console.error(`[${r.region}] ${r.raceCount}レース(馬${r.observationCount}頭)・市場比較可能${r.marketEligibleRaceIds.length}レース`);
  }
  console.error(`集計しました: ${out}`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
