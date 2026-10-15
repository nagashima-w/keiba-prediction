/**
 * レース再生のコース図の幾何と、キャンバスへの描画(Issue #311)。DOM に触れない(2D コンテキストは注入)。
 *
 * コース図は**簡略化した角丸の長方形**(幅 1 × 高さ 0.5 の枠に、直線 2 本と半円 2 つ)。距離・回り(右/左)だけから描き、競馬場ごとの正確な図ではない。
 * 左回りは反時計回り(下の直線を東へ走る)、右回りはその鏡映(x を反転)。ゴールは下の直線の 80% の位置で、スタートはそこから距離だけ手前(周を超える距離は何周か手前)。
 * 1周の長さは見た目の都合で 2000m 相当に固定する(競馬場の実際の周長ではない)。
 */
import type { Frame, PlanGeometry } from "./replay-plan";
import type { ReplayInit } from "./replay-model";
import { rankingAt } from "./replay-model";

export const TRACK_HEIGHT = 0.5;
/** 見た目の1周(m)。距離 ÷ これ が走る周回数。 */
export const PERIMETER_M = 2000;
/** 距離が分からないときに使う距離(m)。 */
const DEFAULT_DISTANCE_M = 1600;

const RADIUS = TRACK_HEIGHT / 2;
const STRAIGHT = 1 - 2 * RADIUS;
const ARC = Math.PI * RADIUS;
const PERIMETER_U = 2 * STRAIGHT + 2 * ARC;
/** ゴールの位置: 下の直線の 80%(周回の割合)。 */
export const GOAL_LAP = (0.8 * STRAIGHT) / PERIMETER_U;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * コース上の位置(周回の割合 q → 単位座標)。q=0 は下の直線の西端(左回りの場合)。弧長で割り付けるので、q の増分に対して速さが一定。
 * `lateral` は外側を正とする横ずれ(単位座標)。周回に畳むので負の q も可。
 */
export function pointAt(turn: "right" | "left", q: number, lateral = 0): Point {
  const s = (((q % 1) + 1) % 1) * PERIMETER_U;
  let x: number;
  let y: number;
  if (s < STRAIGHT) {
    // 下の直線(東向き)。外側は下。
    x = RADIUS + s;
    y = TRACK_HEIGHT + lateral;
  } else if (s < STRAIGHT + ARC) {
    // 東端の半円(下から上へ)。
    const theta = Math.PI / 2 - (s - STRAIGHT) / RADIUS;
    x = 1 - RADIUS + (RADIUS + lateral) * Math.cos(theta);
    y = RADIUS + (RADIUS + lateral) * Math.sin(theta);
  } else if (s < 2 * STRAIGHT + ARC) {
    // 上の直線(西向き)。外側は上。
    x = 1 - RADIUS - (s - STRAIGHT - ARC);
    y = -lateral;
  } else {
    // 西端の半円(上から下へ)。
    const theta = -Math.PI / 2 - (s - 2 * STRAIGHT - ARC) / RADIUS;
    x = RADIUS + (RADIUS + lateral) * Math.cos(theta);
    y = RADIUS + (RADIUS + lateral) * Math.sin(theta);
  }
  return { x: turn === "right" ? 1 - x : x, y };
}

/** レース全体の位置 x(ゴールが 1、スタートのラインが 0)→ 周回の割合 q(0〜1 に畳む)。距離が分からない・不正なときは 1600m。 */
export function lapPositionOf(x: number, distance: number | null): number {
  const d = distance !== null && Number.isFinite(distance) && distance > 0 ? distance : DEFAULT_DISTANCE_M;
  const q = GOAL_LAP + (x - 1) * (d / PERIMETER_M);
  return ((q % 1) + 1) % 1;
}

// ---- 描画 ----

/** キャンバスの内部の大きさ(CSS で幅いっぱいに縮める。縦横比はここで決まる)。 */
const PAD = 84;
const SCALE = 580;
export const CANVAS_W = 2 * PAD + SCALE;
export const CANVAS_H = Math.round(2 * PAD + TRACK_HEIGHT * SCALE);

/** コースの幅(車線の数 × 1 車線の幅。単位座標)。Issue #314 で 5 → 7 車線に広げた(馬が横に並ぶ余地を増やし、丸の重なりを減らす)。 */
const LANES = 7;
const LANE_STEP = 0.034;
/** 馬の丸の半径(キャンバスの内部の画素)。 */
export const HORSE_RADIUS = 14;
const HORSE_R = HORSE_RADIUS;
/** 丸の中心が横に動ける幅(単位座標。コースの幅 − 丸の直径)。`lat` の 0〜1 がこの幅に対応する(0 が内ラチ側)。 */
export const LATERAL_RANGE = LANES * LANE_STEP - (2 * HORSE_R) / SCALE;

/**
 * 丸 1 個分の大きさ(前計算の押し離しの単位。Issue #314)。`along` はレース方向(レース全体の距離を 1 とした長さ)、`across` は横方向(`lat` の 0〜1 を 1 とした長さ)。
 * レース全体の画面上の長さは「距離 ÷ 1 周 × 周の長さ」なので、距離が長いほど `along` は小さい(丸が重なりにくい)。距離が分からない・不正なときは 1600m。
 */
export function overlapGeometry(distance: number | null): PlanGeometry {
  const d = distance !== null && Number.isFinite(distance) && distance > 0 ? distance : DEFAULT_DISTANCE_M;
  return { along: (2 * HORSE_R) / ((d / PERIMETER_M) * PERIMETER_U * SCALE), across: (2 * HORSE_R) / SCALE / LATERAL_RANGE };
}

export interface DrawColors {
  readonly fg: string;
  readonly bg: string;
  readonly muted: string;
  readonly line: string;
  readonly card: string;
  readonly accent: string;
}

/** 描画に使う 2D コンテキストの部分(`CanvasRenderingContext2D` が満たす。テストでは偽物を渡す)。 */
export interface Ctx2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
}

const px = (p: Point): [number, number] => [PAD + p.x * SCALE, PAD + p.y * SCALE];

/**
 * 1 コマを描く。`frame` は馬ごとの前方位置と横位置(`frameAt`。Issue #314)。コース・S・G・馬の丸と馬番を描く。先頭の馬だけ accent で塗る。
 * 横ずれは馬ごとの横位置(0 が内ラチ側〜1)から決める。順位から決めない(追い抜きで丸が車線を交換して、数字が入れ替わって見えるのを避ける)。
 */
export function drawReplay(ctx: Ctx2D, init: ReplayInit, frame: Frame, colors: DrawColors): void {
  const positions = frame.x;
  const turn = init.turn;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // コースの帯。
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = (LANES * LANE_STEP + 0.03) * SCALE;
  ctx.beginPath();
  const steps = 96;
  for (let k = 0; k <= steps; k++) {
    const [x, y] = px(pointAt(turn, k / steps));
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();

  // ゴールの線と S・G の文字(コースの内側。外側はキャンバスの縁で切れる)。
  const half = (LANES * LANE_STEP + 0.03) / 2;
  ctx.strokeStyle = colors.fg;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(...px(pointAt(turn, GOAL_LAP, -half)));
  ctx.lineTo(...px(pointAt(turn, GOAL_LAP, half)));
  ctx.stroke();
  ctx.fillStyle = colors.muted;
  ctx.font = "bold 22px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const label = -(half + 0.05);
  ctx.fillText("G", ...px(pointAt(turn, GOAL_LAP, label)));
  ctx.fillText("S", ...px(pointAt(turn, lapPositionOf(0, init.distance), label)));

  // 馬。後ろの順位から描き、先頭が一番上に重なる。
  const ranking = rankingAt(positions);
  ctx.font = "bold 16px sans-serif";
  for (let rank = ranking.length - 1; rank >= 0; rank--) {
    const i = ranking[rank]!;
    const lateral = (frame.lat[i]! - 0.5) * LATERAL_RANGE;
    const [x, y] = px(pointAt(turn, lapPositionOf(positions[i]!, init.distance), lateral));
    const leader = rank === 0;
    ctx.fillStyle = leader ? colors.accent : colors.card;
    ctx.strokeStyle = colors.fg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, HORSE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = leader ? colors.bg : colors.fg;
    ctx.fillText(String(init.horses[i]!.umaban), x, y);
  }
}
