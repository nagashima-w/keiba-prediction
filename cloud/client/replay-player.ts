/**
 * レース再生のプレーヤ(Issue #311)。アニメーションの状態機械で、**描画は VNode の外**(キャンバスに直接描く)。
 *
 * 画面の木(`view.ts`)は静的な `<canvas data-replay-id="分析id">` とボタンだけで、1コマごとの更新では木が変わらない(`createMounter` は同じ木なら DOM を触らない)。
 * キャンバスはフレームごとに `getCanvas()` で引き直す: 再描画で要素が置き換わっても、次のコマ(または `redraw()`)で新しい要素に描く。
 * rAF・可視状態・乱数・色・キャンバスの取得はすべて注入(`main.ts` が本物を渡し、テストが偽物を渡す)。
 *
 * **止まる条件**(裏で回り続けない):
 *  - 次のコマでキャンバスが無い・`data-replay-id` が違う(画面遷移) → 止まって状態を捨てる。
 *  - タブが非表示になったら rAF を取り消して一時停止し、表示に戻ったら再開する(復帰直後のコマは経過 0)。
 *  - 1コマの経過は 100ms で頭打ち。
 *  - `prefers-reduced-motion` ではアニメなしで、最終状態を 1 コマ描いて終了を通知する。
 *
 * 展開(着順の抽選と、全馬の位置の前計算 `RacePlan`)は `start()` で 1 回だけ作り、`replay()`(Issue #314「もう一度再生」)は同じ展開を最初から再生し直す(乱数を引かない)。
 * 展開は状態(`State`)に入っていて、止めたとき(`stop()`)・画面遷移で止まったときに状態ごと捨てる。別の分析の展開を流用しない。
 */
import { CANVAS_H, CANVAS_W, drawReplay, overlapGeometry, type Ctx2D, type DrawColors } from "./replay-draw";
import { drawFinishOrder, finalRanksOf, startRanksOf, type ReplayInit } from "./replay-model";
import { frameAt, planRace, type RacePlan } from "./replay-plan";

/** 速度 ×1 で走り切るまでの時間(ms)。 */
export const BASE_DURATION_MS = 12000;
/** 1コマの経過の上限(ms)。長い空白(重い処理・復帰)の後に位置が飛ばないように。 */
export const MAX_FRAME_MS = 100;
/** 進み具合が 1 に届いたとみなす許容(浮動小数点の積み上げ誤差)。 */
const DONE_EPS = 1e-9;

/** プレーヤが使うキャンバスの部分(`HTMLCanvasElement` が満たす)。 */
export interface PlayerCanvas {
  width: number;
  height: number;
  getAttribute(name: string): string | null;
  getContext(kind: "2d"): Ctx2D | null;
}

export interface PlayerDeps {
  /** いまの画面のキャンバス(`canvas[data-replay-id]`)。無ければ null。 */
  readonly getCanvas: () => PlayerCanvas | null;
  readonly raf: (callback: (timestamp: number) => void) => number;
  readonly cancelRaf: (handle: number) => void;
  readonly isVisible: () => boolean;
  /** [0, 1) の乱数(着順の抽選)。 */
  readonly random: () => number;
  readonly reducedMotion: () => boolean;
  readonly colors: (canvas: PlayerCanvas) => DrawColors;
  /** 走り終えたとき(reduced-motion の即時の終了を含む)。分析 id と、着順(馬番を 1 着から並べたもの)。止められたときは呼ばない。 */
  readonly onFinish: (analysisId: number, order: readonly number[]) => void;
}

export type PlayerStatus = "idle" | "playing" | "paused" | "finished";

export interface ReplayPlayer {
  /** 新しく着順を抽選して、最初から再生する(再生中なら中断して抽選し直す)。`speed` は ×1・×2・×4。 */
  start(init: ReplayInit, speed: number): void;
  /**
   * 直前と同じ展開(同じ着順・同じ動き)を最初から再生し直す(Issue #314)。再生中でも走り終えたあとでも押せる。抽選も前計算もやり直さない(乱数を引かない)。
   * 展開が無い(始める前・止めたあと)・分析 id が違うときは何もせず false。
   */
  replay(analysisId: number): boolean;
  /** 速度を変える(以降のコマから)。 */
  setSpeed(speed: number): void;
  /** 止めて状態を捨てる。 */
  stop(): void;
  /** いまのコマを、いまのキャンバスに描き直す(画面の再描画でキャンバスが置き換わった直後に呼ぶ)。状態が無ければ何もしない。 */
  redraw(): void;
  /** `visibilitychange` のとき。 */
  onVisibilityChange(): void;
  status(): PlayerStatus;
  progress(): number;
}

interface State {
  readonly init: ReplayInit;
  /** 前計算した展開(`start()` で 1 回だけ作る。`replay()` が共有する)。 */
  readonly plan: RacePlan;
  readonly order: number[];
  progress: number;
  speed: number;
  status: Exclude<PlayerStatus, "idle">;
  lastT: number | null;
  handle: number | null;
}

/** 馬番の昇順位(0 が最内。スタートの横位置)。馬番が同じ・飛びがあっても 0〜n−1 の並べ替えになる。 */
function gatesOf(umabans: readonly number[]): number[] {
  const order = umabans.map((_, i) => i).sort((a, b) => umabans[a]! - umabans[b]! || a - b);
  const gates: number[] = Array(umabans.length).fill(0);
  order.forEach((horseIndex, k) => {
    gates[horseIndex] = k;
  });
  return gates;
}

export function createReplayPlayer(deps: PlayerDeps): ReplayPlayer {
  let state: State | null = null;

  /** いまのキャンバスがこの再生のものか(分析 id が一致するか)を確かめて返す。違えば null。 */
  function canvasOf(s: State): PlayerCanvas | null {
    const canvas = deps.getCanvas();
    return canvas !== null && canvas.getAttribute("data-replay-id") === String(s.init.analysisId) ? canvas : null;
  }

  function draw(s: State, canvas: PlayerCanvas): void {
    if (canvas.width !== CANVAS_W) canvas.width = CANVAS_W;
    if (canvas.height !== CANVAS_H) canvas.height = CANVAS_H;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    drawReplay(ctx, s.init, frameAt(s.plan, s.progress), deps.colors(canvas));
  }

  function cancel(s: State): void {
    if (s.handle !== null) {
      deps.cancelRaf(s.handle);
      s.handle = null;
    }
  }

  function request(s: State): void {
    s.handle = deps.raf((t) => tick(s, t));
  }

  /** 走り終えた: 最終状態を描いてから通知する(通知で画面が再描画されキャンバスが置き換わっても、`redraw()` が最終状態を描く)。 */
  function finish(s: State, canvas: PlayerCanvas | null): void {
    s.progress = 1;
    s.status = "finished";
    if (canvas !== null) draw(s, canvas);
    deps.onFinish(
      s.init.analysisId,
      s.order.map((i) => s.init.horses[i]!.umaban),
    );
  }

  function tick(s: State, t: number): void {
    if (state !== s) return; // 古い再生のコールバック(中断・停止済み)
    s.handle = null;
    if (s.status !== "playing") return;
    const canvas = canvasOf(s);
    if (canvas === null) {
      state = null; // 画面遷移(キャンバスが消えた・別の分析になった)。描かず、通知せず、止める
      return;
    }
    if (!deps.isVisible()) {
      s.status = "paused"; // rAF の取り消しが間に合わなかった。進めずに止める
      return;
    }
    const dt = s.lastT === null ? 0 : Math.min(Math.max(t - s.lastT, 0), MAX_FRAME_MS);
    s.lastT = t;
    s.progress = Math.min(1, s.progress + (dt * s.speed) / BASE_DURATION_MS);
    if (s.progress >= 1 - DONE_EPS) {
      finish(s, canvas);
      return;
    }
    draw(s, canvas);
    request(s);
  }

  return {
    start(init, speed) {
      if (state !== null) cancel(state);
      const order = drawFinishOrder(init.horses, deps.random);
      const plan = planRace(
        {
          styles: init.horses.map((h) => h.style),
          startRanks: startRanksOf(init.horses.map((h) => h.early)),
          finalRanks: finalRanksOf(order),
          gates: gatesOf(init.horses.map((h) => h.umaban)),
          pace: init.pace,
        },
        deps.random,
        overlapGeometry(init.distance),
      );
      const s: State = {
        init,
        plan,
        order,
        progress: 0,
        speed,
        status: "playing",
        lastT: null,
        handle: null,
      };
      state = s;
      if (deps.reducedMotion()) {
        finish(s, canvasOf(s));
        return;
      }
      const canvas = canvasOf(s);
      if (canvas !== null) draw(s, canvas);
      request(s);
    },
    replay(analysisId) {
      const s = state;
      if (s === null || s.init.analysisId !== analysisId) return false;
      cancel(s);
      s.progress = 0;
      s.status = "playing";
      s.lastT = null;
      if (deps.reducedMotion()) {
        finish(s, canvasOf(s));
        return true;
      }
      const canvas = canvasOf(s);
      if (canvas !== null) draw(s, canvas);
      request(s);
      return true;
    },
    setSpeed(speed) {
      if (state !== null) state.speed = speed;
    },
    stop() {
      if (state !== null) cancel(state);
      state = null;
    },
    redraw() {
      if (state === null) return;
      const canvas = canvasOf(state);
      if (canvas !== null) draw(state, canvas);
    },
    onVisibilityChange() {
      const s = state;
      if (s === null) return;
      if (s.status === "playing" && !deps.isVisible()) {
        cancel(s);
        s.status = "paused";
      } else if (s.status === "paused" && deps.isVisible()) {
        s.status = "playing";
        s.lastT = null; // 復帰直後のコマは経過 0
        request(s);
      }
    },
    status: () => state?.status ?? "idle",
    progress: () => state?.progress ?? 0,
  };
}
