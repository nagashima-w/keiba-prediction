/**
 * レース再生の純関数(Issue #311)。DOM・乱数源・時刻に触れない(乱数は引数で注入)。
 *
 * **演出であって物理的なシミュレーションではない**: 分析の勝率の推定(`winProb`)を強さにして着順を 1 回分抽選する(Plackett-Luce の逐次抽選。
 * 分析の勝率はこのモデルの 1 着確率なので、強さは勝率に比例する。想定ペースでは重みを変えない: 勝率にはプロンプトの展開想定を通じてペースが織り込み済み)。
 * 馬の丸が S → G に走る位置は、脚質と想定ペースから `replay-plan.ts` が計算する(Issue #314)。
 * 確率・配分・保存される分析の値は読むだけで、一切変えない。
 */
import type { AnalysisDetail, LegStyle, PaceEstimate } from "./api-analysis";

/** 先頭と最後尾の差の基準(ゴール時。レース全体の距離に対する割合)。演出のための誇張で、実際の着差ではない。位置の計算は `replay-plan.ts`(Issue #314)。 */
export const REPLAY_SPREAD = 0.16;

/** 再生の材料(馬ごと)。 */
export interface ReplayHorse {
  readonly umaban: number;
  /** 馬名(詳細なしは null)。 */
  readonly name: string | null;
  /** 抽選の強さ(勝率の推定 `winProb`)。 */
  readonly strength: number;
  /** 強さが残りすべて 0 になったときの重み(補正後の3着内率 `adjustedProb`)。 */
  readonly fallback: number;
  /** スタート直後の位置(0〜1、小さいほど前)。無ければ null。集団の中の並びに使う。 */
  readonly early: number | null;
  /** 脚質(Issue #314)。分析の `legStyle`。無ければ `early` から粗く決める(≤1/3 先行・≤2/3 差し・他 追込。逃げは決めない)。`early` も無ければ差し。 */
  readonly style: LegStyle;
}

export interface ReplayInit {
  readonly analysisId: number;
  readonly horses: readonly ReplayHorse[];
  /** 距離(m)。分からなければ null。 */
  readonly distance: number | null;
  readonly turn: "right" | "left";
  /** 想定ペース(Issue #314。サーバがプロンプトの展開想定と同じ判定で求めた値。無ければ「不明」=平均として描く)。 */
  readonly pace: PaceEstimate;
}

/** 脚質が無い馬の脚質(Issue #314)。`earlyPos` があれば粗く決める(逃げは決めない)。無ければ差し(中団)。 */
function styleOf(legStyle: LegStyle | null | undefined, early: number | null): LegStyle {
  if (legStyle !== null && legStyle !== undefined) {
    return legStyle;
  }
  if (early === null || !Number.isFinite(early)) {
    return "差し";
  }
  return early <= 1 / 3 ? "先行" : early <= 2 / 3 ? "差し" : "追込";
}

const isWeight = (v: number): boolean => Number.isFinite(v) && v >= 0;

/**
 * 分析から再生の材料を作る。**再生できないとき(勝率が判定不能・2頭未満)は null**(ボタンを出さない)。
 * 判定不能 = どれか 1 頭でも `winProb` が null、非有限・負の値がある、または合計が 0 以下。詳細(R2)の有無は問わない(`winProb` は D1 の値だけで決まる)。
 */
export function buildReplayInit(a: AnalysisDetail): ReplayInit | null {
  if (a.horses.length < 2) {
    return null;
  }
  let total = 0;
  for (const h of a.horses) {
    if (h.winProb === null || !isWeight(h.winProb)) {
      return null;
    }
    total += h.winProb;
  }
  if (!(total > 0)) {
    return null;
  }
  return {
    analysisId: a.id,
    distance: a.race.distance ?? null,
    turn: a.race.turn ?? "right",
    pace: a.race.pace ?? "不明",
    horses: a.horses.map((h) => ({ umaban: h.umaban, name: h.name, strength: h.winProb!, fallback: h.adjustedProb, early: h.earlyPos ?? null, style: styleOf(h.legStyle, h.earlyPos ?? null) })),
  };
}

/**
 * Plackett-Luce の逐次抽選: 残りの馬から、強さに比例して 1 頭ずつ選んで着順にする。戻り値は馬の添字を 1 着から並べたもの。
 * `rng` は [0, 1) の乱数(注入)。最後の 1 頭は引かずに確定するので、引く回数は頭数 − 1。
 * 強さが 0・NaN・負の馬は重み 0 として扱い、強さのある馬がいる間は選ばれない。残りの強さがすべて 0 になったら `fallback` を重みにし、それも 0 なら一様に選ぶ。
 */
export function drawFinishOrder(items: readonly { readonly strength: number; readonly fallback: number }[], rng: () => number): number[] {
  const remaining = items.map((_, i) => i);
  const order: number[] = [];
  while (remaining.length > 1) {
    let weights = remaining.map((i) => (isWeight(items[i]!.strength) ? items[i]!.strength : 0));
    let total = weights.reduce((a, b) => a + b, 0);
    if (!(total > 0)) {
      weights = remaining.map((i) => (isWeight(items[i]!.fallback) ? items[i]!.fallback : 0));
      total = weights.reduce((a, b) => a + b, 0);
    }
    if (!(total > 0)) {
      weights = remaining.map(() => 1);
      total = remaining.length;
    }
    const target = rng() * total;
    let acc = 0;
    let pick = -1;
    for (let k = 0; k < remaining.length; k++) {
      if (weights[k]! <= 0) continue;
      acc += weights[k]!;
      pick = k;
      if (target < acc) break; // 丸めで target が合計に届いたときは、最後の正の重みの馬になる
    }
    order.push(remaining[pick]!);
    remaining.splice(pick, 1);
  }
  if (remaining.length === 1) {
    order.push(remaining[0]!);
  }
  return order;
}

/** 数の配列の中央値(偶数個は中央 2 つの平均)。空は呼ばない。 */
function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * スタート直後の順位(馬ごと。0 が先頭)。`earlyPos` の小さい順で、同値は並び順の若い方が前。
 * null は、値のある馬の中央値で補う(中団に置く)。全馬 null なら全員同値で、並び順どおり。
 */
export function startRanksOf(early: readonly (number | null)[]): number[] {
  const known = early.filter((v): v is number => v !== null && Number.isFinite(v));
  const fill = known.length === 0 ? 0.5 : median(known);
  const keys = early.map((v) => (v !== null && Number.isFinite(v) ? v : fill));
  const sorted = keys.map((_, i) => i).sort((a, b) => keys[a]! - keys[b]! || a - b);
  const ranks: number[] = Array(early.length).fill(0);
  sorted.forEach((horseIndex, rank) => {
    ranks[horseIndex] = rank;
  });
  return ranks;
}

/** 着順(馬の添字を 1 着から並べたもの)から、馬ごとの最終順位(0 が 1 着)。 */
export function finalRanksOf(order: readonly number[]): number[] {
  const ranks: number[] = Array(order.length).fill(0);
  order.forEach((horseIndex, rank) => {
    ranks[horseIndex] = rank;
  });
  return ranks;
}

/** 前方位置の降順の馬の添字(今の順位。同位置は添字の若い順)。 */
export function rankingAt(positions: readonly number[]): number[] {
  return positions.map((_, i) => i).sort((a, b) => positions[b]! - positions[a]! || a - b);
}

// ---- 画面の表示用データ ----

export const REPLAY_HEADING = "レース再生";
export const REPLAY_NOTE = "確率モデルから1回分の着順を抽選して見せる演出です。物理的なシミュレーションではなく、確率・配分は変わりません。隊列は馬の脚質と想定ペースから描きます。";
export const REPLAY_PLAY_LABEL = "レースを再生";
export const REPLAY_AGAIN_LABEL = "別の展開で再生";
/** 直前と同じ展開(同じ着順・同じ動き)を最初から再生し直すボタン(Issue #314)。最初の再生の前は出さない。 */
export const REPLAY_REPEAT_LABEL = "もう一度再生";
export const REPLAY_FINISH_HEADING = "今回の着順(抽選)";
export const REPLAY_CANVAS_LABEL = "馬番の丸がスタートからゴールへ走るアニメーション";
/** 速度の選択肢(×1 は約 12 秒で走り切る)。 */
export const REPLAY_SPEEDS = [1, 2, 4] as const;

/** 再生の画面の状態(`app.ts` が持つ)。`startedId` は再生を始めた分析(canvas を出す)、`finishOrder` は走り終えた再生の着順(馬番を 1 着から並べたもの)。 */
export interface ReplayUi {
  readonly startedId: number | null;
  readonly speed: number;
  readonly finishOrder: readonly number[] | null;
}

export interface ReplaySection {
  readonly heading: string;
  readonly note: string;
  /** ボタンのクリック処理に渡す値(`data-analysis-id` にも出す)。 */
  readonly analysisId: number;
  /** この分析の再生を始めたか(始めたら canvas を出す)。 */
  readonly started: boolean;
  readonly playLabel: string;
  /** 「もう一度再生」のボタンの文言(Issue #314)。この分析の再生を始めたあと(再生中・終了後)だけ。始める前は null(ボタンを出さない)。 */
  readonly repeatLabel: string | null;
  readonly speeds: readonly { readonly value: number; readonly label: string; readonly pressed: boolean }[];
  /** 走り終えたあとの着順の見出しと行。走り終えるまで null。 */
  readonly finishHeading: string | null;
  readonly finish: readonly string[] | null;
}

/** 「レース再生」の節の表示用データ。再生できない分析(`buildReplayInit` が null)は null(節ごと出さない)。 */
export function replaySectionOf(a: AnalysisDetail, ui: ReplayUi | undefined): ReplaySection | null {
  if (buildReplayInit(a) === null) {
    return null;
  }
  const started = ui !== undefined && ui.startedId === a.id;
  const speed = ui?.speed ?? REPLAY_SPEEDS[0];
  const finishOrder = started ? ui.finishOrder : null;
  const nameOf = new Map(a.horses.map((h) => [h.umaban, h.name] as const));
  return {
    heading: REPLAY_HEADING,
    note: REPLAY_NOTE,
    analysisId: a.id,
    started,
    playLabel: started ? REPLAY_AGAIN_LABEL : REPLAY_PLAY_LABEL,
    repeatLabel: started ? REPLAY_REPEAT_LABEL : null,
    speeds: REPLAY_SPEEDS.map((v) => ({ value: v, label: `×${v}`, pressed: v === speed })),
    finishHeading: finishOrder === null ? null : REPLAY_FINISH_HEADING,
    finish: finishOrder === null ? null : finishOrder.map((umaban, i) => `${i + 1}着 ${umaban}${nameOf.get(umaban) ? ` ${nameOf.get(umaban)}` : ""}`),
  };
}
