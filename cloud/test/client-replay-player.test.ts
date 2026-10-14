import { describe, expect, it } from "vitest";
import { CANVAS_H, CANVAS_W, type Ctx2D } from "../client/replay-draw";
import { BASE_DURATION_MS, createReplayPlayer, MAX_FRAME_MS, type PlayerCanvas, type PlayerDeps } from "../client/replay-player";
import type { ReplayInit } from "../client/replay-model";

/**
 * Issue #311(レース再生): プレーヤ(アニメーションの状態機械)。rAF・可視状態・乱数・キャンバスの取得はすべて注入し、偽物で時間を手で進める。
 * 守ること: 画面遷移(キャンバスが消える・別の分析のキャンバスになる)・タブ非表示で止まり、裏で回り続けない。reduced-motion ではアニメなしで最終状態。
 */

class FakeCtx implements Ctx2D {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 0;
  font = "";
  textAlign = "";
  textBaseline = "";
  arcs = 0;
  frames = 0; // fillRect(背景)の回数 = 1コマ
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  arc(): void { this.arcs += 1; }
  fill(): void {}
  stroke(): void {}
  fillRect(): void { this.frames += 1; }
  fillText(): void {}
}

class FakeCanvas implements PlayerCanvas {
  width = 300;
  height = 150;
  readonly ctx = new FakeCtx();
  constructor(private readonly id: string | null) {}
  getAttribute(name: string): string | null {
    return name === "data-replay-id" ? this.id : null;
  }
  getContext(): Ctx2D {
    return this.ctx;
  }
}

const INIT: ReplayInit = {
  analysisId: 7,
  distance: 1600,
  turn: "left",
  horses: [
    { umaban: 1, name: "一", strength: 0.5, fallback: 0.5, early: 0.1 },
    { umaban: 2, name: "二", strength: 0.3, fallback: 0.3, early: 0.5 },
    { umaban: 3, name: "三", strength: 0.2, fallback: 0.2, early: 0.9 },
  ],
};

/** 手動で進める環境。 */
function setup(over: Partial<PlayerDeps> = {}) {
  const env = {
    canvas: new FakeCanvas("7") as FakeCanvas | null,
    visible: true,
    reduced: false,
    pending: new Map<number, (t: number) => void>(),
    nextHandle: 1,
    cancelled: [] as number[],
    finished: [] as { id: number; order: readonly number[] }[],
    rafCalls: 0,
    randoms: [] as number[],
  };
  const deps: PlayerDeps = {
    getCanvas: () => env.canvas,
    raf: (cb) => {
      const h = env.nextHandle++;
      env.rafCalls += 1;
      env.pending.set(h, cb);
      return h;
    },
    cancelRaf: (h) => {
      env.cancelled.push(h);
      env.pending.delete(h);
    },
    isVisible: () => env.visible,
    random: () => {
      const v = env.randoms.length > 0 ? env.randoms.shift()! : 0;
      return v;
    },
    reducedMotion: () => env.reduced,
    colors: () => ({ fg: "#111", bg: "#fff", muted: "#666", line: "#ccc", card: "#eee", accent: "#06c" }),
    onFinish: (id, order) => env.finished.push({ id, order }),
    ...over,
  };
  const player = createReplayPlayer(deps);
  /** 溜まっている rAF のコールバックを、時刻 t で 1 回ずつ呼ぶ(呼んだ中で再要求されたものは次回)。 */
  const frame = (t: number): void => {
    const cbs = [...env.pending.values()];
    env.pending.clear();
    for (const cb of cbs) cb(t);
  };
  return { env, player, frame };
}

describe("createReplayPlayer", () => {
  it("前提: 基準の長さは 12 秒、1コマの時間の上限は 100ms", () => {
    expect(BASE_DURATION_MS).toBe(12000);
    expect(MAX_FRAME_MS).toBe(100);
  });

  it("start: すぐ 1 コマ描き(馬の数だけ丸)、キャンバスの大きさを設定し、rAF を 1 つだけ要求する。進み具合 0・再生中", () => {
    const { env, player } = setup();
    player.start(INIT, 1);
    expect(env.canvas!.ctx.frames).toBe(1);
    expect(env.canvas!.ctx.arcs).toBe(3);
    expect([env.canvas!.width, env.canvas!.height]).toEqual([CANVAS_W, CANVAS_H]);
    expect(env.pending.size).toBe(1);
    expect(player.status()).toBe("playing");
    expect(player.progress()).toBe(0);
  });

  it("等速で進む: 速度 ×1 は 12 秒で終わる。6 秒で進み具合 0.5。終わったら onFinish を 1 回(分析 id と着順の馬番)呼び、rAF を要求しない", () => {
    const { env, player, frame } = setup();
    env.randoms = [0.0, 0.0]; // 1着=添字0(馬番1)、残りから 2着=添字1(馬番2)、最後=馬番3
    player.start(INIT, 1);
    frame(1000); // 最初のコマ(dt=0)
    for (let t = 1000 + 100; t <= 1000 + 6000; t += 100) frame(t);
    expect(player.progress()).toBeCloseTo(0.5, 6);
    expect(env.finished).toEqual([]);
    for (let t = 1000 + 6100; t <= 1000 + 12000; t += 100) frame(t);
    expect(player.progress()).toBe(1);
    expect(player.status()).toBe("finished");
    expect(env.finished).toEqual([{ id: 7, order: [1, 2, 3] }]);
    expect(env.pending.size).toBe(0);
    // 終わったあとにコマは来ない(念のため呼んでも何も起きない)
    frame(99999);
    expect(env.finished.length).toBe(1);
  });

  it("速度: ×2 は 6 秒で、×4 は 3 秒で終わる(進み具合は速度に比例)", () => {
    for (const [speed, ms] of [[2, 6000], [4, 3000]] as const) {
      const { env, player, frame } = setup();
      player.start(INIT, speed);
      frame(0);
      for (let t = 100; t <= ms; t += 100) frame(t);
      expect(player.status(), `×${speed}`).toBe("finished");
      expect(env.finished.length).toBe(1);
    }
    const { player, frame } = setup();
    player.start(INIT, 2);
    frame(0);
    frame(100);
    expect(player.progress()).toBeCloseTo((100 * 2) / BASE_DURATION_MS, 10);
  });

  it("setSpeed: 再生中に速度を変えると、以降のコマから新しい速度で進む", () => {
    const { player, frame } = setup();
    player.start(INIT, 1);
    frame(0);
    frame(100);
    const p1 = player.progress();
    player.setSpeed(4);
    frame(200);
    expect(player.progress() - p1).toBeCloseTo((100 * 4) / BASE_DURATION_MS, 10);
  });

  it("1コマの時間は 100ms で頭打ち(長い空白の後に飛ばない)", () => {
    const { player, frame } = setup();
    player.start(INIT, 1);
    frame(0);
    frame(60_000);
    expect(player.progress()).toBeCloseTo(MAX_FRAME_MS / BASE_DURATION_MS, 10);
    expect(player.status()).toBe("playing");
  });

  it("時刻が戻ったコマ(負の差)は進めない", () => {
    const { player, frame } = setup();
    player.start(INIT, 1);
    frame(1000);
    frame(900);
    expect(player.progress()).toBe(0);
  });

  it("タブが非表示になったら rAF を取り消して一時停止し、コマが来ても進まない。表示に戻ったら再開する(復帰直後のコマは差 0)", () => {
    const { env, player, frame } = setup();
    player.start(INIT, 1);
    frame(0);
    frame(100);
    const p = player.progress();
    const handle = [...env.pending.keys()][0]!;
    env.visible = false;
    player.onVisibilityChange();
    expect(player.status()).toBe("paused");
    expect(env.cancelled).toContain(handle);
    expect(env.pending.size).toBe(0);
    frame(10_000); // 取り消し済みなので何も起きない
    expect(player.progress()).toBe(p);
    env.visible = true;
    player.onVisibilityChange();
    expect(player.status()).toBe("playing");
    expect(env.pending.size).toBe(1);
    frame(20_000); // 復帰後の最初のコマ: 差 0
    expect(player.progress()).toBe(p);
    frame(20_100);
    expect(player.progress()).toBeCloseTo(p + 100 / BASE_DURATION_MS, 10);
  });

  it("非表示のまま rAF のコールバックが来た場合も(取り消しが間に合わなかった)、進めずに一時停止する", () => {
    const { env, player, frame } = setup();
    player.start(INIT, 1);
    frame(0);
    env.visible = false;
    frame(100);
    expect(player.progress()).toBe(0);
    expect(player.status()).toBe("paused");
    expect(env.pending.size).toBe(0);
  });

  it("一時停止でないとき(再生していない・終了後)の可視状態の変化では何もしない。状態がなくても投げない", () => {
    const { env, player } = setup();
    env.visible = false;
    player.onVisibilityChange();
    env.visible = true;
    player.onVisibilityChange();
    expect(env.rafCalls).toBe(0);
    expect(player.status()).toBe("idle");
  });

  it("画面遷移: キャンバスが DOM から消えたら止まる(次のコマで検知して、描かず・rAF を要求せず・終了通知も出さない)", () => {
    const { env, player, frame } = setup();
    player.start(INIT, 1);
    frame(0);
    const before = env.canvas!.ctx.frames;
    env.canvas = null;
    frame(100);
    expect(player.status()).toBe("idle");
    expect(env.pending.size).toBe(0);
    expect(env.finished).toEqual([]);
    expect(before).toBeGreaterThan(0);
  });

  it("別の分析のキャンバス(data-replay-id が違う)に変わったら止まる。新しいキャンバスには描かない", () => {
    const { env, player, frame } = setup();
    player.start(INIT, 1);
    frame(0);
    const other = new FakeCanvas("8");
    env.canvas = other;
    frame(100);
    expect(player.status()).toBe("idle");
    expect(other.ctx.frames).toBe(0);
    expect(env.pending.size).toBe(0);
  });

  it("stop: rAF を取り消し、状態を捨てる。取り消し済みのコールバックが後で呼ばれても何も描かない", () => {
    const { env, player } = setup();
    player.start(INIT, 1);
    const cb = [...env.pending.values()][0]!;
    player.stop();
    expect(player.status()).toBe("idle");
    expect(env.pending.size).toBe(0);
    const frames = env.canvas!.ctx.frames;
    cb(500);
    expect(env.canvas!.ctx.frames).toBe(frames);
    expect(env.pending.size).toBe(0);
    player.stop(); // 二重でも投げない
  });

  it("再生中の start(別の展開で再生): 前の rAF を取り消し、進み具合 0・新しい抽選で最初から。二重に回らない", () => {
    const { env, player, frame } = setup();
    env.randoms = [0.0, 0.0];
    player.start(INIT, 1);
    frame(0);
    frame(100);
    expect(player.progress()).toBeGreaterThan(0);
    env.randoms = [0.999, 0.999]; // 次の抽選は逆順(馬番 3, 2, 1)
    player.start(INIT, 1);
    expect(player.progress()).toBe(0);
    expect(env.pending.size).toBe(1); // 前のは取り消された
    frame(200);
    for (let t = 300; t <= 200 + 12000; t += 100) frame(t);
    expect(env.finished).toEqual([{ id: 7, order: [3, 2, 1] }]);
  });

  it("reduced-motion: アニメなしで最終状態を 1 コマ描き、すぐ終了を通知する。rAF は要求しない", () => {
    const { env, player } = setup();
    env.reduced = true;
    env.randoms = [0.0, 0.0];
    player.start(INIT, 1);
    expect(env.rafCalls).toBe(0);
    expect(player.status()).toBe("finished");
    expect(player.progress()).toBe(1);
    expect(env.canvas!.ctx.frames).toBe(1);
    expect(env.finished).toEqual([{ id: 7, order: [1, 2, 3] }]);
  });

  it("redraw: 状態があるとき、いまのキャンバス(再描画で置き換わった新しい要素)に現在のコマを描く。状態がなければ何もしない", () => {
    const { env, player, frame } = setup();
    player.redraw();
    expect(env.canvas!.ctx.frames).toBe(0);
    player.start(INIT, 1);
    frame(0);
    frame(100);
    const replaced = new FakeCanvas("7");
    env.canvas = replaced;
    player.redraw();
    expect(replaced.ctx.frames).toBe(1);
    expect(replaced.ctx.arcs).toBe(3);
    expect([replaced.width, replaced.height]).toEqual([CANVAS_W, CANVAS_H]);
    // 別の分析のキャンバスには描かない
    const other = new FakeCanvas("8");
    env.canvas = other;
    player.redraw();
    expect(other.ctx.frames).toBe(0);
    // キャンバスが無くても投げない
    env.canvas = null;
    player.redraw();
  });

  it("終了後の redraw でも、最終状態を描く(置き換わったキャンバスに結果が残る)", () => {
    const { env, player } = setup();
    env.reduced = true;
    player.start(INIT, 1);
    const replaced = new FakeCanvas("7");
    env.canvas = replaced;
    player.redraw();
    expect(replaced.ctx.frames).toBe(1);
  });

  it("コンテキストが取れなくても投げない(描かないだけ)", () => {
    const { env, player } = setup();
    env.canvas = Object.assign(new FakeCanvas("7"), { getContext: () => null });
    player.start(INIT, 1);
    expect(player.status()).toBe("playing");
  });
});
