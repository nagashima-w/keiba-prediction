import { describe, expect, it } from "vitest";
import { CANVAS_H, CANVAS_W, drawReplay, GOAL_LAP, HORSE_RADIUS, lapPositionOf, LATERAL_RANGE, overlapGeometry, pointAt, PERIMETER_M, TRACK_HEIGHT, type DrawColors } from "../client/replay-draw";
import type { ReplayInit } from "../client/replay-model";

/**
 * Issue #311(レース再生): コース図の幾何(簡略化した楕円=角丸の長方形)と、キャンバスへの描画。
 * 競馬場ごとの正確な図は対象外。距離・回り(右/左)から描く。描画は偽の 2D コンテキストの呼び出しで検査する。
 */

const R = 0.25; // 半円の半径(= TRACK_HEIGHT / 2)
const STRAIGHT = 1 - 2 * R; // 直線の長さ
const PERIMETER_U = 2 * STRAIGHT + 2 * Math.PI * R; // 1周の長さ(単位座標)

describe("pointAt(コース上の位置。周回の割合 q → 単位座標)", () => {
  it("前提: 高さは 0.5・半円の半径は高さの半分", () => {
    expect(TRACK_HEIGHT).toBe(0.5);
    expect(PERIMETER_M).toBe(2000);
  });

  it("左回り: q=0 は下の直線の西端 (0.25, 0.5)。ゴールは下の直線の 80% の位置 (0.65, 0.5)", () => {
    const p0 = pointAt("left", 0);
    expect(p0.x).toBeCloseTo(0.25, 10);
    expect(p0.y).toBeCloseTo(0.5, 10);
    const g = pointAt("left", GOAL_LAP);
    expect(g.x).toBeCloseTo(0.25 + 0.8 * STRAIGHT, 10);
    expect(g.y).toBeCloseTo(0.5, 10);
  });

  it("右回りは左回りの x を鏡映したもの(y は同じ)。全周で", () => {
    for (let k = 0; k < 200; k++) {
      const q = k / 200;
      const l = pointAt("left", q);
      const r = pointAt("right", q);
      expect(r.x).toBeCloseTo(1 - l.x, 10);
      expect(r.y).toBeCloseTo(l.y, 10);
    }
  });

  it("進行方向: 左回りはゴールへ東向き(ゴールの手前は西側)、右回りは西向き(手前は東側)", () => {
    expect(pointAt("left", GOAL_LAP - 0.01).x).toBeLessThan(pointAt("left", GOAL_LAP).x);
    expect(pointAt("right", GOAL_LAP - 0.01).x).toBeGreaterThan(pointAt("right", GOAL_LAP).x);
    // 左回り(反時計回り): 下の直線の次は東端の半円を上へ回る(y が減る)
    expect(pointAt("left", (STRAIGHT + 0.1) / PERIMETER_U).y).toBeLessThan(0.5);
  });

  it("周回して閉じる(q と q+1 は同じ点)。負の q も周回に畳む", () => {
    for (const turn of ["left", "right"] as const) {
      for (const q of [0, 0.13, 0.5, 0.77]) {
        const a = pointAt(turn, q);
        const b = pointAt(turn, q + 1);
        const c = pointAt(turn, q - 1);
        expect(b.x).toBeCloseTo(a.x, 9);
        expect(b.y).toBeCloseTo(a.y, 9);
        expect(c.x).toBeCloseTo(a.x, 9);
        expect(c.y).toBeCloseTo(a.y, 9);
      }
    }
  });

  it("中心線は枠 [0,1]×[0,0.5] の中に収まり、4辺(上・下・左・右)に接する", () => {
    let minX = 9, maxX = -9, minY = 9, maxY = -9;
    for (let k = 0; k < 2000; k++) {
      const p = pointAt("left", k / 2000);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    expect(minX).toBeGreaterThanOrEqual(-1e-9);
    expect(maxX).toBeLessThanOrEqual(1 + 1e-9);
    expect(minY).toBeGreaterThanOrEqual(-1e-9);
    expect(maxY).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(minX).toBeLessThan(0.001);
    expect(maxX).toBeGreaterThan(0.999);
    expect(minY).toBeLessThan(0.001);
    expect(maxY).toBeGreaterThan(0.499);
  });

  it("q に対して速さが一定(弧長で割り付ける): 等間隔の q の隣り合う点の距離が、周の長さ × 間隔にほぼ等しい", () => {
    const n = 4000;
    for (let k = 0; k < n; k++) {
      const a = pointAt("left", k / n);
      const b = pointAt("left", (k + 1) / n);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(PERIMETER_U / n, 5);
    }
  });

  it("横ずれ(lateral。外側が正): 下の直線では下へ、上の直線では上へ、半円では中心からの距離が半径 + lateral", () => {
    expect(pointAt("left", GOAL_LAP, 0.05).y).toBeCloseTo(0.5 + 0.05, 10);
    // 上の直線の中ほど: 周の (STRAIGHT + π R + STRAIGHT/2) / 周
    const qTop = (STRAIGHT + Math.PI * R + STRAIGHT / 2) / PERIMETER_U;
    expect(pointAt("left", qTop).y).toBeCloseTo(0, 10);
    expect(pointAt("left", qTop, 0.05).y).toBeCloseTo(-0.05, 10);
    // 東端の半円の頂点(中心 (0.75, 0.25) の真東): 周の (STRAIGHT + πR/2) / 周
    const qEast = (STRAIGHT + (Math.PI * R) / 2) / PERIMETER_U;
    const e = pointAt("left", qEast, 0.05);
    expect(Math.hypot(e.x - 0.75, e.y - 0.25)).toBeCloseTo(R + 0.05, 9);
    expect(e.x).toBeGreaterThan(pointAt("left", qEast).x);
    // 右回りも外側が正
    expect(pointAt("right", GOAL_LAP, 0.05).y).toBeCloseTo(0.55, 10);
  });
});

describe("lapPositionOf(レース全体の位置 x → 周回の割合 q)", () => {
  const wrap = (v: number): number => ((v % 1) + 1) % 1;
  it("ゴール(x=1)は GOAL_LAP。スタート(x=0)は距離 ÷ 周の長さだけ手前(周回に畳む)", () => {
    expect(lapPositionOf(1, 1600)).toBeCloseTo(GOAL_LAP, 12);
    expect(lapPositionOf(0, 1600)).toBeCloseTo(wrap(GOAL_LAP - 1600 / PERIMETER_M), 12);
  });

  it("距離が周より長いレース(3200m = 1.6周)は、手前へ 1.6 周", () => {
    expect(lapPositionOf(0, 3200)).toBeCloseTo(wrap(GOAL_LAP - 1.6), 12);
    // 走る途中は q が単調に進む(周回の割合に畳む前の値の差が x の差 × D/周)
    const a = lapPositionOf(0.5, 3200);
    const b = lapPositionOf(0.6, 3200);
    expect(wrap(b - a)).toBeCloseTo(wrap(0.1 * 1.6), 12);
  });

  it("距離が分からない(null)・0 以下・非有限は 1600m として扱う", () => {
    const base = lapPositionOf(0, 1600);
    expect(lapPositionOf(0, null)).toBeCloseTo(base, 12);
    expect(lapPositionOf(0, 0)).toBeCloseTo(base, 12);
    expect(lapPositionOf(0, -5)).toBeCloseTo(base, 12);
    expect(lapPositionOf(0, Number.NaN)).toBeCloseTo(base, 12);
  });

  it("前提: 距離で結果が変わる(1200m と 2400m のスタート位置は違う)", () => {
    expect(Math.abs(lapPositionOf(0, 1200) - lapPositionOf(0, 2400))).toBeGreaterThan(0.1);
  });
});

// ---- 描画 ----

interface Op {
  readonly op: string;
  readonly args: readonly unknown[];
  readonly fillStyle: string;
  readonly strokeStyle: string;
}

class FakeCtx {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 0;
  font = "";
  textAlign = "";
  textBaseline = "";
  readonly ops: Op[] = [];
  private rec(op: string, args: unknown[]): void {
    this.ops.push({ op, args, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle });
  }
  beginPath(): void { this.rec("beginPath", []); }
  moveTo(x: number, y: number): void { this.rec("moveTo", [x, y]); }
  lineTo(x: number, y: number): void { this.rec("lineTo", [x, y]); }
  closePath(): void { this.rec("closePath", []); }
  arc(x: number, y: number, r: number, a: number, b: number): void { this.rec("arc", [x, y, r, a, b]); }
  fill(): void { this.rec("fill", []); }
  stroke(): void { this.rec("stroke", []); }
  fillRect(x: number, y: number, w: number, h: number): void { this.rec("fillRect", [x, y, w, h]); }
  fillText(t: string, x: number, y: number): void { this.rec("fillText", [t, x, y]); }
}

const COLORS: DrawColors = { fg: "#111111", bg: "#fefefe", muted: "#666666", line: "#cccccc", card: "#eeeeee", accent: "#0a58ca" };

function init(n: number, turn: "right" | "left" = "left", distance: number | null = 1600): ReplayInit {
  return { analysisId: 1, distance, turn, pace: "平均", horses: Array.from({ length: n }, (_, i) => ({ umaban: i + 1, name: null, strength: 0.1, fallback: 0.1, early: null, style: "差し" as const })) };
}

/** 前方位置の配列から frame を作る(横位置は既定で中央)。 */
function frameOf(x: number[], lat: number[] = x.map(() => 0.5)): { x: number[]; lat: number[] } {
  return { x, lat };
}

describe("overlapGeometry(丸 1 個分の大きさ。前計算の押し離しの単位。Issue #314)", () => {
  it("レース方向は『丸の直径 ÷ (1 レース分の画面上の長さ)』: 距離が長いほど小さい(1600m で約 0.0235)。横方向は直径 ÷ 横位置が動ける幅", () => {
    const a = overlapGeometry(1600);
    expect(a.along).toBeCloseTo((2 * HORSE_RADIUS) / ((1600 / PERIMETER_M) * (2 * (1 - 0.5) + Math.PI * 0.5) * 580), 12);
    expect(a.along).toBeGreaterThan(0.0234);
    expect(a.along).toBeLessThan(0.0236);
    expect(overlapGeometry(3200).along).toBeCloseTo(a.along / 2, 12);
    expect(overlapGeometry(1200).along).toBeGreaterThan(a.along);
    expect(a.across).toBeCloseTo((2 * HORSE_RADIUS) / 580 / LATERAL_RANGE, 12);
    expect(a.across, "丸が 1 つ横に並べる余地が複数ある(across < 1/3)").toBeLessThan(1 / 3);
  });

  it("距離が分からない(null)・0 以下・非有限は 1600m として扱う", () => {
    const base = overlapGeometry(1600);
    expect(overlapGeometry(null)).toEqual(base);
    expect(overlapGeometry(0)).toEqual(base);
    expect(overlapGeometry(Number.NaN)).toEqual(base);
  });
});

describe("drawReplay(キャンバスへの描画)", () => {
  it("横位置は frame の lat から決める(順位ではない): lat=0 は内ラチ側・lat=1 は外側で、同じ前方位置の 2 頭の距離は横の幅 LATERAL_RANGE ちょうど。順位が入れ替わっても、馬ごとの lat が同じならその馬の丸は同じ車線", () => {
    const byNumber = (ctx: FakeCtx): Map<string, [number, number]> =>
      new Map(ctx.ops.filter((o) => o.op === "fillText" && /^\d+$/.test(o.args[0] as string)).map((o) => [o.args[0] as string, [o.args[1] as number, o.args[2] as number]] as const));
    const a = new FakeCtx();
    drawReplay(a, init(2), frameOf([0.5, 0.5], [0.0, 1.0]), COLORS);
    const pa = byNumber(a);
    expect(Math.hypot(pa.get("1")![0] - pa.get("2")![0], pa.get("1")![1] - pa.get("2")![1])).toBeCloseTo(LATERAL_RANGE * 580, 6);
    // lat を入れ替えると、丸の位置も入れ替わる(馬番 1 の丸が、さっきの馬番 2 の丸の位置に来る)
    const b = new FakeCtx();
    drawReplay(b, init(2), frameOf([0.5, 0.5], [1.0, 0.0]), COLORS);
    const pb = byNumber(b);
    expect(pb.get("1")![0]).toBeCloseTo(pa.get("2")![0], 6);
    expect(pb.get("1")![1]).toBeCloseTo(pa.get("2")![1], 6);
    // 前方位置の順位が逆転しても(x を入れ替えても)、同じ lat の馬は同じ車線: 下の直線(x=1 のゴール付近)で y が lat だけで決まる
    const c = new FakeCtx();
    const d = new FakeCtx();
    drawReplay(c, init(2), frameOf([0.99, 0.97], [0.0, 1.0]), COLORS);
    drawReplay(d, init(2), frameOf([0.97, 0.99], [0.0, 1.0]), COLORS);
    expect(byNumber(c).get("1")![1]).toBeCloseTo(byNumber(d).get("1")![1], 6);
    expect(byNumber(c).get("2")![1]).toBeCloseTo(byNumber(d).get("2")![1], 6);
    expect(byNumber(c).get("1")![1], "前提: lat が違えば y が違う").not.toBeCloseTo(byNumber(c).get("2")![1], 1);
  });

  it("背景を塗り、馬の数だけ丸(arc)と馬番(fillText)を描く。馬番はすべて現れる", () => {
    const ctx = new FakeCtx();
    const positions = [0.5, 0.45, 0.4, 0.35, 0.3, 0.25];
    drawReplay(ctx, init(6), frameOf(positions), COLORS);
    expect(ctx.ops[0]).toMatchObject({ op: "fillRect", args: [0, 0, CANVAS_W, CANVAS_H], fillStyle: COLORS.bg });
    expect(ctx.ops.filter((o) => o.op === "arc").length).toBe(6);
    const numbers = ctx.ops.filter((o) => o.op === "fillText" && /^\d+$/.test(o.args[0] as string)).map((o) => o.args[0]);
    expect(numbers.sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("先頭の馬(位置が最大)だけ accent で塗る。その丸の直後の馬番が先頭の馬のもの", () => {
    const ctx = new FakeCtx();
    // 馬番 4(添字 3)が先頭
    drawReplay(ctx, init(6), frameOf([0.3, 0.2, 0.25, 0.9, 0.1, 0.15]), COLORS);
    const arcs = ctx.ops.map((o, i) => ({ o, i })).filter((e) => e.o.op === "arc");
    const accentArcs = arcs.filter((e) => e.o.fillStyle === COLORS.accent);
    expect(accentArcs.length).toBe(1);
    expect(arcs.filter((e) => e.o.fillStyle === COLORS.card).length).toBe(5);
    const next = ctx.ops.slice(accentArcs[0]!.i + 1).find((o) => o.op === "fillText");
    expect(next?.args[0]).toBe("4");
    // 重なりでは先頭が一番上(最後に描く)
    expect(arcs[arcs.length - 1]!.o.fillStyle).toBe(COLORS.accent);
  });

  it("馬の丸の中心は、その馬の位置のコース上の点(lateral 込み)。位置の違う2頭は違う場所に描かれる", () => {
    const ctx = new FakeCtx();
    drawReplay(ctx, init(2), frameOf([0.9, 0.3], [0.2, 0.8]), COLORS);
    const centers = ctx.ops.filter((o) => o.op === "arc").map((o) => [o.args[0] as number, o.args[1] as number]);
    expect(centers.length).toBe(2);
    expect(centers[0]).not.toEqual(centers[1]);
    // すべて枠(余白込み)の中
    for (const [x, y] of centers) {
      expect(x!).toBeGreaterThan(0);
      expect(x!).toBeLessThan(CANVAS_W);
      expect(y!).toBeGreaterThan(0);
      expect(y!).toBeLessThan(CANVAS_H);
    }
  });

  it("コース(折れ線)・S・G の文字を描く。回りで S/G の位置が左右に入れ替わる", () => {
    const left = new FakeCtx();
    const right = new FakeCtx();
    drawReplay(left, init(3, "left"), frameOf([0.3, 0.2, 0.1]), COLORS);
    drawReplay(right, init(3, "right"), frameOf([0.3, 0.2, 0.1]), COLORS);
    const gx = (c: FakeCtx): number => c.ops.find((o) => o.op === "fillText" && o.args[0] === "G")!.args[1] as number;
    expect(gx(left) + gx(right)).toBeCloseTo(CANVAS_W, 6); // 鏡映
    expect(gx(left)).not.toBeCloseTo(gx(right), 1);
    expect(left.ops.filter((o) => o.op === "lineTo").length).toBeGreaterThan(50);
    // S・G の文字はコースの内側(下の直線の中心線 y = 84 + 0.5 × 580 = 374 より上)に描く(外側はキャンバスの縁で切れる)
    for (const t of ["S", "G"]) {
      const o = left.ops.find((op) => op.op === "fillText" && op.args[0] === t)!;
      expect(o.args[2] as number, t).toBeLessThan(374);
    }
  });

  it("退化: 位置の配列が空・1頭でも投げない。馬番が 2 桁でも描く", () => {
    const ctx = new FakeCtx();
    drawReplay(ctx, init(0), frameOf([]), COLORS);
    drawReplay(ctx, init(1), frameOf([0.4]), COLORS);
    const c2 = new FakeCtx();
    drawReplay(c2, init(18), frameOf(Array.from({ length: 18 }, (_, i) => 0.05 * i)), COLORS);
    expect(c2.ops.filter((o) => o.op === "arc").length).toBe(18);
    expect(c2.ops.some((o) => o.op === "fillText" && o.args[0] === "18")).toBe(true);
  });
});
