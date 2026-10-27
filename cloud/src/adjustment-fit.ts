/**
 * 月報の「補正の当たり具合」(Issue #509。#337-B1)の計算。**純関数**: D1・R2・Worker の型に触れない(読み出しは `adjustment-fit-read.ts`、文面は `adjustment-fit-format.ts`)。
 *
 * ## 目的
 * LLM が統計モデルの 3 着内率(prior)を補正した値(adjusted_prob)が、実際の 3 着内率に近づいたかを、月ごとに決まった計算で出す。
 * 月報を書く LLM はこれを読んで気づきを書く。ユーザーとメインはそれを見て、分析のプロンプトを直すかを月に 1 回まで決める(#337)。
 *
 * ## 母集団(検証画面と同じ規則)
 * 検証画面の `computeVerifyReport`(`PRODUCTION_VERIFY_CONFIG`)と同じ選び方は、配分用の書き出しの {@link selectAllocationExportAnalyses} が
 * 表駆動のテストで固定している。ここはそれをそのまま呼ぶ(規則を二重に書かない)。順序は、先読みの分類(clean だけ残す)→ clean と補完待ちの中でレースごとに最新の 1 件
 * → 最新が補完待ち・推定 EV のレースは丸ごと除く。結果の無いレースは、読み出しの SQL が候補の段階で除く。
 * そのうえで次を足す:
 *  - **LLM を使った分析だけ**: `model` と `prompt_version` がどちらも非 NULL。LLM が効かなかった分析(キー無し・フォールバック)は、保存のとき `model` が NULL になる
 *    (`race-day-core.ts`)。LLM 未使用は `prompt_version` も NULL。最新の分析が LLM 不使用なら、古い LLM の分析に代えずレースごと除く(推定 EV と同じ扱い)。
 *  - **馬**は、結果に着順があり(null でない)、取消・除外(`scratched = 1`)でないものだけ。検証画面の「着順が確定していない馬は対象外」と同じ。
 *  - 「最新の 1 件」は**版をまたいで**選ぶ(月の成績の集計と同じ。版ごとの行を足すと月全体になる)。検証画面の版別は版の中で最新を選ぶので、
 *    同じレースを 2 つの版が分析した月だけ食い違いうる。
 *
 * ## 区分
 * d = 補正後 − 統計モデル。**境目は、1e-9 で丸めてから比べる**(`0.31 − 0.30` は浮動小数で 0.010000000000000009 になり、素の比較だと「ちょうど +1pt」が「上げた」に入るため)。
 *  - 補正の向き別 5 区分: 大きく上げた(d > +0.05)・上げた(+0.01 < d ≤ +0.05)・ほぼそのまま(−0.01 ≤ d ≤ +0.01)・下げた(−0.05 ≤ d < −0.01)・大きく下げた(d < −0.05)。
 *  - 人気の帯別 4 区分: 1 / 2〜3 / 4〜6 / 7 以下。確定の単勝人気(`race_results.ninki`)が無い(null・1 未満・整数でない)馬は、人気別の表だけから除く。
 *
 * ## 数字
 *  - 区分ごと: 頭数・3 着内の頭数・統計モデルの平均・補正後の平均。実際の 3 着内率は `placedCount / count`(頭数 0 のときは無い)。
 *  - 3 着内の Brier(統計モデル・補正後)。計算は core の `computeBrierScore`(検証画面の `quality` と同じ関数)。
 *  - 最適な倍率 k: `prior + k × d` の二乗誤差を最小にする k = Σd(y − prior) / Σd²(y は 3 着内なら 1)。分母が 0(補正が 1 頭も無い)なら null。
 *    k > 1 なら補正の幅が小さすぎた、k < 1 なら大きすぎた。1 か月分の標本では動きやすく、区間は付けていない(読み手が頭数で判断する)。
 *  - **30 レース未満の版は版別に出さない**(`hiddenVersionCount` に数える。検証画面の版別比較の線と同じ)。月全体にはどの版も入る。
 */
import { computeBrierScore } from "../../packages/core/src/ev/probability-quality-metrics.js";
import { selectAllocationExportAnalyses, type ChosenAllocationAnalysis } from "./allocation-export-format";
import type { CandidateRow } from "./prior-export-format";

/** 版別の表を出す、評価したレース数の下限(未満なら出さない)。検証画面の `VERSION_CARD_MIN_COUNT` と同じ 30 だが別の定数で、連動しない。 */
export const FIT_MIN_VERSION_RACES = 30;
/** 区分の頭数がこれ未満なら『数が少ない』として、文面で断定しないよう印を付ける。 */
export const FIT_FEW_COUNT = 30;

/** 向きの境目(ポイントではなく確率の差)。 */
const SAME_LIMIT = 0.01;
const BIG_LIMIT = 0.05;
/** 浮動小数の境目の誤差を吸収する丸め(1e-9 単位)。 */
const ROUND = 1e9;

export type DirectionKey = "bigUp" | "up" | "same" | "down" | "bigDown";
export type PopularityKey = "1" | "2-3" | "4-6" | "7+";

export const DIRECTION_KEYS: readonly DirectionKey[] = ["bigUp", "up", "same", "down", "bigDown"];
export const POPULARITY_KEYS: readonly PopularityKey[] = ["1", "2-3", "4-6", "7+"];

/** 補正の向きの区分。 */
export function classifyDirection(prior: number, adjusted: number): DirectionKey {
  const d = Math.round((adjusted - prior) * ROUND) / ROUND;
  if (d > BIG_LIMIT) return "bigUp";
  if (d > SAME_LIMIT) return "up";
  if (d >= -SAME_LIMIT) return "same";
  if (d >= -BIG_LIMIT) return "down";
  return "bigDown";
}

/** 人気の帯。人気が無い(null・undefined・1 未満・整数でない)なら null。 */
export function popularityBand(ninki: number | null | undefined): PopularityKey | null {
  if (ninki === null || ninki === undefined || !Number.isInteger(ninki) || ninki < 1) return null;
  if (ninki === 1) return "1";
  if (ninki <= 3) return "2-3";
  if (ninki <= 6) return "4-6";
  return "7+";
}

/** 区分 1 つ分。頭数 0 のとき平均は null。 */
export interface FitBucket<K extends string> {
  readonly key: K;
  readonly count: number;
  /** 3 着以内だった頭数。 */
  readonly placedCount: number;
  readonly meanPrior: number | null;
  readonly meanAdjusted: number | null;
}

/** 集計の 1 グループ(月全体、または 1 つの版)。 */
export interface FitGroup {
  /** 評価した馬が 1 頭以上いたレース(分析)の数。 */
  readonly raceCount: number;
  /** 評価した馬の数。 */
  readonly horseCount: number;
  /** 補正の向き別(`DIRECTION_KEYS` の順)。 */
  readonly byDirection: readonly FitBucket<DirectionKey>[];
  /** 人気の帯別(`POPULARITY_KEYS` の順)。人気の無い馬は入らない。 */
  readonly byPopularity: readonly FitBucket<PopularityKey>[];
  /** 3 着内の Brier。評価した馬が無ければ null。 */
  readonly brier: { readonly prior: number | null; readonly adjusted: number | null };
  /** 最適な倍率 k。分母が 0 または馬が無ければ null。 */
  readonly optimalK: number | null;
}

export interface FitVersion extends FitGroup {
  readonly promptVersion: string;
}

/** 母集団から除いた件数の内訳。単位に注意: `suspect`・`unknown` は**分析**の数、ほかは**レース**の数。 */
export interface FitExcluded {
  /** 遮断済みでなく、分析が発走より後(先読みの疑い)。 */
  readonly suspect: number;
  /** 遮断済みでなく、発走の前後を判定できない。 */
  readonly unknown: number;
  /** 最新の分析が発走時刻の補完待ち(`start_time` が NULL)のため、レースごと除いた数。 */
  readonly uncheckedRaces: number;
  /** 最新の clean な分析が推定 EV のため、レースごと除いた数。 */
  readonly estimated: number;
  /** 最新の分析が、LLM が効いたものでない(キー無し・フォールバックで `model` が無い、または `prompt_version` が無い古い分析)ため、レースごと除いた数。画面・プロンプトでは『LLM 不使用など』と書く。 */
  readonly notLlm: number;
}

export interface AdjustmentFit {
  readonly all: FitGroup;
  /** 評価したレースが {@link FIT_MIN_VERSION_RACES} 以上の版だけ(版の昇順)。 */
  readonly byVersion: readonly FitVersion[];
  /** 評価したレースが足りず、版別に出さなかった版の数。 */
  readonly hiddenVersionCount: number;
  readonly excluded: FitExcluded;
}

/** 読めなかった・計算できなかった月報の印(昔の月報〈項目なし〉と区別する)。理由は固定の語で、例外の本文は入れない。 */
export interface AdjustmentFitUnavailable {
  readonly unavailable: "read-failed" | "too-many" | "compute-failed";
}

export function isFitUnavailable(fit: AdjustmentFit | AdjustmentFitUnavailable): fit is AdjustmentFitUnavailable {
  return "unavailable" in fit;
}

/** 候補の分析の行。{@link CandidateRow} に `model`(LLM が効いたときだけ非 NULL)を足したもの。 */
export interface FitCandidate extends CandidateRow {
  readonly model: string | null;
}

export interface FitHorseRow {
  readonly analysisId: number;
  readonly umaban: number;
  readonly prior: number;
  readonly adjustedProb: number;
}

export interface FitResultRow {
  readonly raceId: string;
  readonly umaban: number;
  readonly finishPosition: number | null;
  /** 取消・除外か(1 = そう、0 = 記録済みでそうでない、NULL・省略 = 記録なし)。 */
  readonly scratched?: number | null;
  readonly ninki?: number | null;
}

export interface FitSelection {
  /** 採用した分析(レースごとに 1 件。レース ID の昇順)。 */
  readonly chosen: readonly ChosenAllocationAnalysis[];
  readonly excluded: FitExcluded;
}

/** 候補から、集計の対象にする分析を選ぶ(母集団の規則はファイル先頭の説明)。 */
export function selectFitAnalyses(candidates: readonly FitCandidate[]): FitSelection {
  const { chosen, excluded } = selectAllocationExportAnalyses(candidates);
  const modelById = new Map(candidates.map((c) => [c.id, c.model] as const));
  const llm = chosen.filter((c) => modelById.get(c.id) != null && c.promptVersion !== null);
  return {
    chosen: llm,
    excluded: { suspect: excluded.suspect, unknown: excluded.unknown, uncheckedRaces: excluded.uncheckedRaces, estimated: excluded.estimated, notLlm: chosen.length - llm.length },
  };
}

/** 評価した馬 1 頭。 */
interface Observation {
  readonly prior: number;
  readonly adjusted: number;
  readonly placed: boolean;
  readonly ninki: number | null;
}

function buckets<K extends string>(keys: readonly K[], obs: readonly Observation[], keyOf: (o: Observation) => K | null): FitBucket<K>[] {
  return keys.map((key) => {
    const members = obs.filter((o) => keyOf(o) === key);
    const count = members.length;
    return {
      key,
      count,
      placedCount: members.filter((o) => o.placed).length,
      meanPrior: count === 0 ? null : members.reduce((s, o) => s + o.prior, 0) / count,
      meanAdjusted: count === 0 ? null : members.reduce((s, o) => s + o.adjusted, 0) / count,
    };
  });
}

function groupOf(obs: readonly Observation[], raceCount: number): FitGroup {
  let sumDD = 0;
  let sumDE = 0;
  for (const o of obs) {
    const d = o.adjusted - o.prior;
    sumDD += d * d;
    sumDE += d * ((o.placed ? 1 : 0) - o.prior);
  }
  const k = obs.length === 0 || sumDD === 0 ? null : sumDE / sumDD;
  const brier = (pick: (o: Observation) => number): number | null =>
    obs.length === 0 ? null : computeBrierScore(obs.map((o) => ({ probability: pick(o), occurred: o.placed }))).value;
  return {
    raceCount,
    horseCount: obs.length,
    byDirection: buckets(DIRECTION_KEYS, obs, (o) => classifyDirection(o.prior, o.adjusted)),
    byPopularity: buckets(POPULARITY_KEYS, obs, (o) => popularityBand(o.ninki)),
    brier: { prior: brier((o) => o.prior), adjusted: brier((o) => o.adjusted) },
    optimalK: k !== null && Number.isFinite(k) ? k : null,
  };
}

/** 選んだ分析と、その馬・結果の行から、月全体と版ごとの集計を作る。 */
export function buildAdjustmentFit(selection: FitSelection, horses: readonly FitHorseRow[], results: readonly FitResultRow[]): AdjustmentFit {
  const horsesByAnalysis = new Map<number, FitHorseRow[]>();
  for (const h of horses) {
    const list = horsesByAnalysis.get(h.analysisId);
    if (list === undefined) horsesByAnalysis.set(h.analysisId, [h]);
    else list.push(h);
  }
  const resultsByRace = new Map<string, Map<number, FitResultRow>>();
  for (const r of results) {
    const byUmaban = resultsByRace.get(r.raceId) ?? new Map<number, FitResultRow>();
    byUmaban.set(r.umaban, r);
    resultsByRace.set(r.raceId, byUmaban);
  }

  const all: Observation[] = [];
  let allRaces = 0;
  const versions = new Map<string, { obs: Observation[]; races: number }>();
  for (const a of selection.chosen) {
    const raceResults = resultsByRace.get(a.raceId);
    const obs: Observation[] = [];
    for (const h of horsesByAnalysis.get(a.id) ?? []) {
      const r = raceResults?.get(h.umaban);
      if (r === undefined || r.finishPosition === null || r.scratched === 1) continue;
      obs.push({ prior: h.prior, adjusted: h.adjustedProb, placed: r.finishPosition <= 3, ninki: r.ninki ?? null });
    }
    if (obs.length === 0) continue;
    all.push(...obs);
    allRaces += 1;
    // 採用した分析は LLM を使ったもの(selectFitAnalyses)なので版は非 null。null なら版別に入れない。
    if (a.promptVersion !== null) {
      const v = versions.get(a.promptVersion) ?? { obs: [], races: 0 };
      v.obs.push(...obs);
      v.races += 1;
      versions.set(a.promptVersion, v);
    }
  }

  const ordered = [...versions.keys()].sort((x, y) => x.localeCompare(y));
  const shown = ordered.filter((v) => versions.get(v)!.races >= FIT_MIN_VERSION_RACES);
  return {
    all: groupOf(all, allRaces),
    byVersion: shown.map((promptVersion) => ({ promptVersion, ...groupOf(versions.get(promptVersion)!.obs, versions.get(promptVersion)!.races) })),
    hiddenVersionCount: ordered.length - shown.length,
    excluded: selection.excluded,
  };
}
