/**
 * ベスト体重(好走時の馬体重)の要約(Issue #212・#210-A)。
 *
 * LLM分析の懸念事項に「馬体重-9kg」が一律にマイナス材料として出ていた。前走で増えすぎた体重を
 * 戻した結果の大幅減もあるため、その馬が好走(3着以内)したときの体重を中立な材料として渡し、
 * 今回の体重(と前走の体重)がその範囲に対してどこにあるかを示す。評価は LLM に任せる。
 *
 * ## 確定事項(ユーザー決定 2026-10-09)
 * - 好走は3着以内。
 * - 直近の好走5走の中央値と範囲(最小〜最大)を出す。全走の最小〜最大にしないのは、古い走が混ざると
 *   幅が広がる(成長・年齢の影響)ため。実戦績の fixture で、好走時の体重の幅が50kg超の馬があった。
 * - 着順の扱いは scorer の `isPlaced` と揃える: 降着(demoted)は確定着順(value)で数え、非数値の着順
 *   (中止・除外・取消・失格)・着順欠損は好走に数えない。
 *
 * ## 対象の選び方
 * 好走で、かつ馬体重が有限の走を新しい順に最大5走集める。体重が無い好走は直近5走の消費に数えず、
 * さらに過去へ遡る(body-weight-trend.ts の skip-and-continue と同じ)。
 *
 * ## サンプル不足
 * 好走が2走未満(scorer の minSampleForBias と同じ2)なら `サンプル不足=true`。このときは範囲との
 * 位置関係を出さず(1走や0走では基準にならない)、note に「サンプル不足」と書く。プロンプトの指示は
 * この語を「中立に扱う」合図にする。
 *
 * ## 出す条件
 * 今回の馬体重が発表済み(有限)のときだけ要約を返す。未発表なら null(この項目を出さない)。
 *
 * 前走の体重は、今回の体重から前走比(`diff`)を引いて復元する(出馬表の値。再計算ではなく
 * スクレイパーが取った増減をそのまま使う)。前走比が有限でなければ前走は出さない。
 *
 * 決定論・ネットワーク/DB非依存の純関数。例外を投げない。評価語は出さない(中立な事実のみ)。
 */

import type { BodyWeight, FinishPosition } from "../scraper/types.js";

/** 好走の上限順位(scorer の isPlaced と同じ3着以内)。 */
const GOOD_RUN_MAX_RANK = 3;

/** 対象とする好走の最大走数(直近5走)。 */
const MAX_GOOD_RUNS = 5;

/** 範囲を基準として使える最小の好走数。scorer の minSampleForBias と同じ2。 */
const MIN_SAMPLE = 2;

/** summarizeBestWeight に渡す過去走1件(新しい順)。 */
export interface BestWeightPastRun {
  readonly bodyWeight?: BodyWeight | null;
  readonly finishPosition?: FinishPosition | null;
}

/** 体重の範囲に対する位置。 */
export type BestWeightPosition = "範囲内" | "重い" | "軽い";

/** ある体重の、好走時の範囲に対する位置。 */
export interface BestWeightPlacement {
  readonly 体重: number;
  /** サンプル不足(範囲を基準にできない)ときは null。 */
  readonly 位置: BestWeightPosition | null;
  /** 範囲の端からの差(kg、正)。範囲内は 0。位置が null のときは null。 */
  readonly 範囲外差: number | null;
}

/** summarizeBestWeight の出力。常に同じキー構成に固定する。 */
export interface BestWeightSummary {
  /** 対象にした好走の走数(0〜5)。 */
  readonly 好走数: number;
  /** 好走時の体重(新しい順、最大5件)。 */
  readonly 好走時体重: readonly number[];
  /** 中央値。好走が0走なら null。 */
  readonly 中央値: number | null;
  readonly 最小: number | null;
  readonly 最大: number | null;
  /** 好走が2走未満。true のとき範囲は基準にならない(中立に扱わせる合図)。 */
  readonly サンプル不足: boolean;
  /** 今回の体重と、範囲に対する位置。 */
  readonly 今回: BestWeightPlacement;
  /** 前走の体重(今回の体重−前走比)と位置。前走比が使えない場合は null。 */
  readonly 前走: BestWeightPlacement | null;
  /** プロンプトへそのまま載せる中立の材料文(評価語を含まない)。 */
  readonly note: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 昇順の中央値(偶数個は中央2値の平均)。呼び出し側が1個以上を保証する。 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 体重が [min, max] に対してどこにあるか。 */
function place(weight: number, min: number, max: number): BestWeightPlacement {
  if (weight > max) {
    return { 体重: weight, 位置: "重い", 範囲外差: weight - max };
  }
  if (weight < min) {
    return { 体重: weight, 位置: "軽い", 範囲外差: min - weight };
  }
  return { 体重: weight, 位置: "範囲内", 範囲外差: 0 };
}

/** 範囲を基準にできないときの位置(体重だけを持つ)。 */
function unplaced(weight: number): BestWeightPlacement {
  return { 体重: weight, 位置: null, 範囲外差: null };
}

/** 位置を note 用の文にする(例: 範囲内 / 範囲より7kg重い)。 */
function placementText(p: BestWeightPlacement): string {
  if (p.位置 === "範囲内") return "範囲内";
  return `範囲より${p.範囲外差}kg${p.位置}`;
}

/**
 * ベスト体重を要約する。
 * @param pastRuns 過去走(新しい順。RaceResultHorse/HorseRaceResult の bodyWeight・finishPosition をそのまま渡せる)
 * @param today 今回の馬体重(ShutubaHorse.bodyWeight)。未発表・欠損は null
 * @returns 今回の馬体重が発表されていなければ null
 */
export function summarizeBestWeight(
  pastRuns: readonly BestWeightPastRun[],
  today: BodyWeight | null | undefined,
): BestWeightSummary | null {
  if (!today || !isFiniteNumber(today.weight)) {
    return null;
  }

  const goodWeights: number[] = [];
  for (const r of pastRuns) {
    if (goodWeights.length >= MAX_GOOD_RUNS) break;
    const f = r.finishPosition;
    // 降着は確定着順 value。非数値・欠損は好走に数えない。
    if (!f || f.kind !== "順位" || f.value > GOOD_RUN_MAX_RANK) continue;
    const w = r.bodyWeight?.weight;
    if (!isFiniteNumber(w)) continue;
    goodWeights.push(w);
  }

  const 好走数 = goodWeights.length;
  const サンプル不足 = 好走数 < MIN_SAMPLE;
  const prevWeight = isFiniteNumber(today.diff) ? today.weight - today.diff : null;

  if (好走数 === 0) {
    return {
      好走数,
      好走時体重: [],
      中央値: null,
      最小: null,
      最大: null,
      サンプル不足,
      今回: unplaced(today.weight),
      前走: null,
      note: `好走時の体重データなし(サンプル不足)。今回${today.weight}kg`,
    };
  }

  const min = Math.min(...goodWeights);
  const max = Math.max(...goodWeights);
  const med = median(goodWeights);

  if (サンプル不足) {
    return {
      好走数,
      好走時体重: goodWeights,
      中央値: med,
      最小: min,
      最大: max,
      サンプル不足,
      今回: unplaced(today.weight),
      前走: null,
      note: `好走(3着以内)時の体重は${好走数}走のみ(${goodWeights.join("・")}kg)でサンプル不足。今回${today.weight}kg`,
    };
  }

  const 今回 = place(today.weight, min, max);
  const 前走 = prevWeight === null ? null : place(prevWeight, min, max);
  const prevText = 前走 === null ? "" : `、前走${前走.体重}kg(${placementText(前走)})`;

  return {
    好走数,
    好走時体重: goodWeights,
    中央値: med,
    最小: min,
    最大: max,
    サンプル不足,
    今回,
    前走,
    note:
      `好走(3着以内)時の直近${好走数}走の体重は中央値${med}kg・範囲${min}〜${max}kg。` +
      `今回${今回.体重}kg(${placementText(今回)})${prevText}`,
  };
}
