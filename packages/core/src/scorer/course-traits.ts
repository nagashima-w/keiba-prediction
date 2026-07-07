/**
 * 中央10場のコース特性定数テーブルと類似度計算。
 *
 * 仕様「競馬場適性」の代替評価(当該場に出走歴がないとき、回り方向・直線長・坂・芝質の
 * 類似性で評価する)に使う。値はいずれも芝コースを基本とした「一般に知られた概算値」で、
 * チューニング対象(verifyの結果を見て調整する)。正確な公式値への依存は避ける。
 */

/** 回り方向。 */
export type TurnDirection = "右" | "左";

/** 芝質。 */
export type TurfKind = "洋芝" | "野芝";

/** 1場分のコース特性。 */
export interface CourseTraits {
  /** 回り方向(右/左)。 */
  readonly turn: TurnDirection;
  /**
   * ゴール前直線の長さ(m)。芝コースの概算値。チューニング対象。
   * 複数コース(内回り/外回り)がある場は代表的な値を用いる。
   */
  readonly straightMeters: number;
  /** 急坂の有無(仕様: 中山・阪神・中京が急坂)。 */
  readonly steepSlope: boolean;
  /** 芝質(仕様: 札幌・函館が洋芝、それ以外は野芝)。 */
  readonly turfKind: TurfKind;
}

/**
 * 中央10場のコース特性(概算値・チューニング対象)。
 *
 * 直線長は芝を基本とした代表値の概算。回り方向・急坂・芝質は一般に知られた区分に従う:
 *  - 左回り: 東京・中京・新潟。それ以外は右回り。
 *  - 急坂: 中山・阪神・中京。
 *  - 洋芝: 札幌・函館。それ以外は野芝。
 */
export const COURSE_TRAITS: Record<string, CourseTraits> = {
  札幌: { turn: "右", straightMeters: 266, steepSlope: false, turfKind: "洋芝" },
  函館: { turn: "右", straightMeters: 262, steepSlope: false, turfKind: "洋芝" },
  福島: { turn: "右", straightMeters: 292, steepSlope: false, turfKind: "野芝" },
  新潟: { turn: "左", straightMeters: 659, steepSlope: false, turfKind: "野芝" },
  東京: { turn: "左", straightMeters: 525, steepSlope: false, turfKind: "野芝" },
  中山: { turn: "右", straightMeters: 310, steepSlope: true, turfKind: "野芝" },
  中京: { turn: "左", straightMeters: 412, steepSlope: true, turfKind: "野芝" },
  京都: { turn: "右", straightMeters: 404, steepSlope: false, turfKind: "野芝" },
  阪神: { turn: "右", straightMeters: 356, steepSlope: true, turfKind: "野芝" },
  小倉: { turn: "右", straightMeters: 293, steepSlope: false, turfKind: "野芝" },
};

/** 会場名が中央10場かどうか。 */
export function isCentralVenue(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(COURSE_TRAITS, name);
}

// 類似度の内訳重み(合計1.0)。回り方向を最重視し、直線長・坂・芝質を続ける。
// これらは類似度計算内部のチューニング対象で、config とは別に定数として保持する。
const SIM_WEIGHT_TURN = 0.4;
const SIM_WEIGHT_STRAIGHT = 0.3;
const SIM_WEIGHT_SLOPE = 0.2;
const SIM_WEIGHT_TURF = 0.1;
/** 直線長の差を0〜1に正規化するスケール(m)。この差以上は完全に非類似とみなす。 */
const STRAIGHT_RANGE_M = 400;

/**
 * 2場のコース類似度を0〜1で返す。同一特性なら1.0に近づく。
 * どちらかが中央10場でない場合は評価不能として null。
 *
 * 類似度 = 0.4×(回り一致) + 0.3×(直線長の近さ) + 0.2×(坂一致) + 0.1×(芝質一致)。
 * 直線長の近さ = 1 − min(1, |Δ直線長| / 400m)。対称関数。
 */
export function courseSimilarity(a: string, b: string): number | null {
  const ta = COURSE_TRAITS[a];
  const tb = COURSE_TRAITS[b];
  if (ta === undefined || tb === undefined) {
    return null;
  }
  const turnSim = ta.turn === tb.turn ? 1 : 0;
  const straightSim =
    1 - Math.min(1, Math.abs(ta.straightMeters - tb.straightMeters) / STRAIGHT_RANGE_M);
  const slopeSim = ta.steepSlope === tb.steepSlope ? 1 : 0;
  const turfSim = ta.turfKind === tb.turfKind ? 1 : 0;
  return (
    SIM_WEIGHT_TURN * turnSim +
    SIM_WEIGHT_STRAIGHT * straightSim +
    SIM_WEIGHT_SLOPE * slopeSim +
    SIM_WEIGHT_TURF * turfSim
  );
}
