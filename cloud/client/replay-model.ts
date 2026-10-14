/**
 * レース再生の純関数(Issue #311)。DOM・乱数源・時刻に触れない(乱数は引数で注入)。
 *
 * **演出であって物理的なシミュレーションではない**: 分析の勝率の推定(`winProb`)を強さにして着順を 1 回分抽選し(Plackett-Luce の逐次抽選。
 * 分析の勝率はこのモデルの 1 着確率なので、強さは勝率に比例する)、馬の丸が S → G に走る位置を、スタート直後の位置(`earlyPos`)から抽選した着順へ入れ替える形で計算する。
 * 確率・配分・保存される分析の値は読むだけで、一切変えない。
 */
import type { AnalysisDetail } from "./api-analysis";

/** 先頭と最後尾の差(ゴール時。レース全体の距離に対する割合)。演出のための誇張で、実際の着差ではない。 */
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
  /** スタート直後の位置(0〜1、小さいほど前)。無ければ null。 */
  readonly early: number | null;
}

export interface ReplayInit {
  readonly analysisId: number;
  readonly horses: readonly ReplayHorse[];
  /** 距離(m)。分からなければ null。 */
  readonly distance: number | null;
  readonly turn: "right" | "left";
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
    horses: a.horses.map((h) => ({ umaban: h.umaban, name: h.name, strength: h.winProb!, fallback: h.adjustedProb, early: h.earlyPos ?? null })),
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

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

/** スタート時点で、すでに広がっている隊列の割合(丸が重なりすぎないように。開始順に縦に並ぶ)。 */
const START_SPREAD = 0.3;
/** 序盤の隊列が広がり切る進み具合。 */
const SPREAD_OUT_END = 0.3;
/** 直線で開始順から最終順へ入れ替わる区間。ゴールを最初の馬が通る前(`1/(1+S)` ≒ 0.86)に終える。 */
const SWAP_START = 0.35;
const SWAP_END = 0.8;

/**
 * 進み具合 p(0〜1)に対する、馬ごとの前方位置(レース全体の距離を 1 としたときの位置。ゴールが 1。スタートのラインが 0)。
 * `x_i = p·(1 + S) − S·e(p)·r_i(p)/(n − 1)`(S = {@link REPLAY_SPREAD})。`e` は序盤に隊列が広がる係数(スタート時点で {@link START_SPREAD} → 1)、
 * `r_i(p)` はその馬の順位(0 が先頭)で、開始順 → 最終順へ入れ替わる(`SWAP_START`〜`SWAP_END`。滑らかな補間)。
 * p=0 は先頭の馬がライン上(0)で、他は開始順に後ろへ並ぶ。p=1 の並びは最終順どおり(先頭と最後尾の差は S)。全馬が単調に前へ進む(S ≤ 0.16 のとき 1 コマの速さは常に正)。p は 0〜1 に丸める。
 */
export function positionsAt(progress: number, startRanks: readonly number[], finalRanks: readonly number[]): number[] {
  const p = clamp01(progress);
  const n = startRanks.length;
  const spreadOut = START_SPREAD + (1 - START_SPREAD) * smoothstep(p / SPREAD_OUT_END);
  const swap = smoothstep((p - SWAP_START) / (SWAP_END - SWAP_START));
  return startRanks.map((s, i) => {
    const rank = s + (finalRanks[i]! - s) * swap;
    const off = n <= 1 ? 0 : (REPLAY_SPREAD * spreadOut * rank) / (n - 1);
    return p * (1 + REPLAY_SPREAD) - off;
  });
}

/** 前方位置の降順の馬の添字(今の順位。同位置は添字の若い順)。 */
export function rankingAt(positions: readonly number[]): number[] {
  return positions.map((_, i) => i).sort((a, b) => positions[b]! - positions[a]! || a - b);
}

// ---- 画面の表示用データ ----

export const REPLAY_HEADING = "レース再生";
export const REPLAY_NOTE = "確率モデルから1回分の着順を抽選して見せる演出です。物理的なシミュレーションではなく、確率・配分は変わりません。";
export const REPLAY_PLAY_LABEL = "レースを再生";
export const REPLAY_AGAIN_LABEL = "別の展開で再生";
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
    speeds: REPLAY_SPEEDS.map((v) => ({ value: v, label: `×${v}`, pressed: v === speed })),
    finishHeading: finishOrder === null ? null : REPLAY_FINISH_HEADING,
    finish: finishOrder === null ? null : finishOrder.map((umaban, i) => `${i + 1}着 ${umaban}${nameOf.get(umaban) ? ` ${nameOf.get(umaban)}` : ""}`),
  };
}
