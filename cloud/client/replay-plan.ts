/**
 * レース再生の「展開」の前計算(Issue #314)。DOM・時刻・乱数源に触れない(乱数は引数で注入)。
 *
 * 再生の開始時に 1 回、全馬の前方位置と横位置の時系列を {@link PLAN_STEPS} 刻みで計算しておき、1 コマごとに {@link frameAt} が線形補間で返す。
 * **演出であって物理的なシミュレーションではない**。着順(Plackett-Luce の抽選)は引数で受け取るだけで、変えない。
 *
 * 前方位置(隊列・動き出し)は**馬の脚質と想定ペースで決まり、乱数に依らない**:
 *  - 基準線 `L(t) = t·(1+S)`(S = {@link REPLAY_SPREAD})から、馬ごとの「先頭との差」`g_i(t)` を引く。`x_i = L(t) − g_i(t)`。
 *  - 道中は脚質ごとの集団(逃げ→先行→差し→追込)が、集団の中は詰まり(開始順の並び)・集団の間は空く隊列になる。想定ペースが速いほど隊列は長い(スローは詰まる)。
 *    集団の中は小さな揺らぎ(馬ごとに位相の違う決定的な波)で入れ替わる。集団の間の順序は揺らぎでは変わらない。
 *  - 勝負どころは脚質ごとの動き出し({@link MOVE_START})から、道中の位置 → 抽選した着順の位置へ動く。逃げ・先行は前で粘ったあと着順の悪い馬が下がり、差しは 3〜4 コーナーから、追込は最後の直線で進出する。
 *    ペースが速いほど動き出しが早く(前は早く止まり、後ろは早く進出する)、遅いほど遅い。
 *  - `LOCK`(= 0.97/(1+S))以降は着順どおりの隊列で固定する。最初の馬がゴールに届く進み具合は 1/(1+S) で LOCK より後なので、**ゴールの通過順 = 抽選した着順**が構成上保証される。
 * 横位置(0 = 内ラチ側 〜 1)は馬ごとに連続で、目標の車線へ寄りつつ、前方の距離が近い 2 頭を**その時点の横の相対位置の向きに**互いに押し離す(抜く側を内・外に固定しない)。乱数は横の目標にだけ使う(2 × 頭数回)。
 */
import type { LegStyle, PaceEstimate } from "./api-analysis";
import { REPLAY_SPREAD } from "./replay-model";

/** 前計算の刻み数(×1 で 12 秒 → 約 33ms 刻み)。 */
export const PLAN_STEPS = 360;
/** 横位置の 1 刻みあたりの変化の上限(丸の横方向の直径に対する割合)。 */
export const LAT_STEP_RATIO = 0.08;

/** 脚質ごとの動き出し(進み具合 0〜1)。前の脚質は後退の開始、後方の脚質は進出の開始。「不明」は平均。実際の開始は、窓がゴール前に収まるよう前倒しされることがある(`RacePlan.moveStart`)。 */
export const MOVE_START: Record<PaceEstimate, Record<LegStyle, number>> = {
  ハイ: { 逃げ: 0.5, 先行: 0.52, 差し: 0.44, 追込: 0.58 },
  平均: { 逃げ: 0.6, 先行: 0.6, 差し: 0.5, 追込: 0.64 },
  スロー: { 逃げ: 0.68, 先行: 0.68, 差し: 0.56, 追込: 0.7 },
  不明: { 逃げ: 0.6, 先行: 0.6, 差し: 0.5, 追込: 0.64 },
};

/** 隊列の長さの倍率(想定ペース別)。 */
const FIELD_SCALE: Record<PaceEstimate, number> = { ハイ: 1.25, 平均: 1, スロー: 0.75, 不明: 1 };
const STYLE_ORDER: readonly LegStyle[] = ["逃げ", "先行", "差し", "追込"];
/** 集団の中の間隔(丸 1 個分の長さに対する倍率)。逃げはハナを争って詰める。 */
const INTRA: readonly number[] = [0.25, 0.45, 0.45, 0.45];
/** 集団の間の間隔(同上)。 */
const INTER = 1.6;
/** 道中の隊列の全長の上限(レース全体の距離に対する割合。倍率を掛ける前)。 */
const FIELD_MAX = 0.2;
/** スタート時点の隊列の幅(道中の何割か)と、道中の幅へ広がり切る進み具合。 */
const START_FRAC = 0.35;
const EXPAND_END = 0.3;
/** 集団の中の揺らぎ: 振幅(丸 1 個分の長さに対する倍率)・周期(進み具合)・消える区間。 */
const RIPPLE_AMP = 0.22;
const RIPPLE_PERIOD = 0.3;
const RIPPLE_FADE_START = 0.45;
const RIPPLE_FADE_LEN = 0.15;
/** ゴール前で順位を確定させる(最初の通過 1/(1+S) より前)。 */
const LOCK = 0.97 / (1 + REPLAY_SPREAD);
/** 最終の隊列の幅(着順の位置)。LOCK で S の 0.9 倍、ゴールで 0.95 倍まで伸びる。 */
const FIN_AT_LOCK = 0.9;
const FIN_AT_END = 0.95;
/** 動き出しの窓の最小(進出する馬 / 後退する馬)。後退は基準線の速さ未満に抑えるため、大きいほど長くする。 */
const GAIN_WINDOW = 0.14;
const FADE_WINDOW = 0.16;
/** 横位置の目標の追従と押し離しの強さ。 */
const FOLLOW = 0.3;
const PUSH = 0.3;

export interface PlanInput {
  /** 馬ごとの脚質(添字 = 馬)。 */
  readonly styles: readonly LegStyle[];
  /** スタート直後の順位(0 が先頭。集団の中の並び)。 */
  readonly startRanks: readonly number[];
  /** 抽選した着順の順位(0 が 1 着)。 */
  readonly finalRanks: readonly number[];
  /** 枠順(馬番の昇順位。0 が最内)。スタートの横位置。 */
  readonly gates: readonly number[];
  readonly pace: PaceEstimate;
}

/** 丸 1 個分の大きさ: `along` = レース方向(レース全体の距離を 1 とした長さ)、`across` = 横方向(コース幅を 1 とした長さ)。 */
export interface PlanGeometry {
  readonly along: number;
  readonly across: number;
}

export interface RacePlan {
  readonly steps: number;
  /** 馬ごとの前方位置(ゴールが 1)の時系列。各 steps + 1 個。 */
  readonly x: readonly (readonly number[])[];
  /** 馬ごとの横位置(0 = 内ラチ側 〜 1)の時系列。 */
  readonly lat: readonly (readonly number[])[];
  /** 馬ごとの実効の動き出し(進み具合)。 */
  readonly moveStart: readonly number[];
}

export interface Frame {
  readonly x: number[];
  readonly lat: number[];
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (t: number): number => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};

/** 展開を前計算する。乱数は横位置の目標にだけ使う(馬ごとに 2 回。隊列・動き出しは乱数に依らない)。 */
export function planRace(input: PlanInput, rng: () => number, geo: PlanGeometry): RacePlan {
  const n = input.styles.length;
  const S = REPLAY_SPREAD;
  const styleIdx = input.styles.map((s) => STYLE_ORDER.indexOf(s));
  const mult = FIELD_SCALE[input.pace];

  // 道中の隊列: 脚質の集団ごとに、開始順で間隔を積む(空の集団は詰める)。長すぎれば一律に縮める。
  const layout: number[] = Array(n).fill(0);
  let acc = 0;
  let first = true;
  for (let c = 0; c < STYLE_ORDER.length; c++) {
    const members = styleIdx
      .map((s, i) => (s === c ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => input.startRanks[a]! - input.startRanks[b]! || a - b);
    if (members.length === 0) continue;
    if (!first) acc += INTER * geo.along;
    first = false;
    members.forEach((h, k) => {
      if (k > 0) acc += INTRA[c]! * geo.along;
      layout[h] = acc;
    });
  }
  const unit = (acc > FIELD_MAX ? FIELD_MAX / acc : 1) * mult;
  const mid = layout.map((v) => v * unit);
  const ripple = RIPPLE_AMP * geo.along * unit;

  // 着順の位置(先頭との差)と、馬ごとの動き出し・窓。
  const fin = input.finalRanks.map((r) => (n > 1 ? FIN_AT_LOCK * S * Math.pow(r / (n - 1), 1.2) : 0));
  const win: number[] = [];
  const start: number[] = [];
  for (let i = 0; i < n; i++) {
    const delta = fin[i]! - mid[i]!;
    const w = delta > 0 ? Math.max(FADE_WINDOW, (1.5 * delta) / (0.95 * (1 + S))) : GAIN_WINDOW;
    win.push(w);
    start.push(Math.min(MOVE_START[input.pace][input.styles[i]!], LOCK - w));
  }

  const gapAt = (i: number, t: number): number => {
    if (t >= LOCK) return fin[i]! * (1 + (FIN_AT_END / FIN_AT_LOCK - 1) * ((t - LOCK) / (1 - LOCK)));
    const env = smoothstep(t / 0.1) * (1 - smoothstep((t - RIPPLE_FADE_START) / RIPPLE_FADE_LEN));
    const wave = ripple * env * Math.sin((2 * Math.PI * t) / RIPPLE_PERIOD + i * 2.399963);
    const m = mid[i]! * (START_FRAC + (1 - START_FRAC) * smoothstep(t / EXPAND_END));
    return m + (fin[i]! - m) * smoothstep((t - start[i]!) / win[i]!) + wave;
  };

  const x: number[][] = Array.from({ length: n }, () => []);
  for (let s = 0; s <= PLAN_STEPS; s++) {
    const t = s / PLAN_STEPS;
    for (let i = 0; i < n; i++) x[i]!.push(t * (1 + S) - gapAt(i, t));
  }
  // 後退の防御: 窓の設計で後退しないようにしているが、差し・ハイの後退と揺らぎの微分が重なると、ごく小さな逆行(画面で 1px 未満)が出うる。
  // 前のコマより戻らないようにそろえる。LOCK 以降は x が単調に増える(逆行がない)ので変わらず、ゴールの通過順 = 着順(AC1)に影響しない。
  for (const xs of x) {
    for (let s = 1; s < xs.length; s++) {
      if (xs[s]! < xs[s - 1]!) xs[s] = xs[s - 1]!;
    }
  }

  // 横位置: 目標の車線(逃げ・先行は内寄り、差し・追込は広め。終盤は無作為)を乱数で決め、押し離しで避ける。
  const mids = styleIdx.map((c) => (c <= 1 ? 0.7 : 0.9) * rng());
  const ends = Array.from({ length: n }, () => rng());
  const gate = input.gates.map((g) => (g + 0.5) / Math.max(n, 1));
  const lat: number[][] = gate.map((g) => [g]);
  const maxStep = geo.across * LAT_STEP_RATIO;
  for (let s = 1; s <= PLAN_STEPS; s++) {
    const t = s / PLAN_STEPS;
    const cur = lat.map((l) => l[s - 1]!);
    for (let i = 0; i < n; i++) {
      const target =
        t < 0.12
          ? gate[i]!
          : t < 0.45
            ? gate[i]! + (mids[i]! - gate[i]!) * smoothstep((t - 0.12) / 0.33)
            : t < 0.65
              ? mids[i]!
              : t < 0.9
                ? mids[i]! + (ends[i]! - mids[i]!) * smoothstep((t - 0.65) / 0.25)
                : ends[i]!;
      let push = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = (x[i]![s - 1]! - x[j]![s - 1]!) / geo.along;
        if (Math.abs(dx) >= 1) continue;
        const need = geo.across * Math.sqrt(1 - dx * dx);
        const dl = cur[i]! - cur[j]!;
        if (Math.abs(dl) >= need) continue;
        // 押す向きは、いまの横の相対位置の向き(同値は添字で決定的に割る)。
        push += (dl > 1e-9 ? 1 : dl < -1e-9 ? -1 : i > j ? 1 : -1) * (need - Math.abs(dl)) * 0.5;
      }
      const move = clamp(clamp((target - cur[i]!) * FOLLOW, -maxStep, maxStep) + push * PUSH, -maxStep, maxStep);
      lat[i]!.push(clamp(cur[i]! + move, 0, 1));
    }
  }
  return { steps: PLAN_STEPS, x, lat, moveStart: start };
}

/** 進み具合 p(0〜1。範囲外・NaN は端)のコマを、前計算の時系列の線形補間で返す。 */
export function frameAt(plan: RacePlan, progress: number): Frame {
  const p = Number.isNaN(progress) ? 0 : clamp(progress, 0, 1);
  const pos = p * plan.steps;
  const s = Math.min(Math.floor(pos), plan.steps - 1);
  const f = pos - s;
  const lerp = (series: readonly number[]): number => series[s]! + (series[s + 1]! - series[s]!) * f;
  return { x: plan.x.map(lerp), lat: plan.lat.map(lerp) };
}
