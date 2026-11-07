/**
 * #653: 市場(単勝オッズ)が見落としやすい条件の定義。docs/investigations/market-blindspots-653/plan.md の 59 個と一致させる。
 *
 * 条件ごとに true(該当)・false(該当しない)・null(対象外。必要な材料が欠けている)を返す。
 * 対象外は、該当しない側にも混ぜない(材料の欠けた馬を黙って「該当しない」にすると、前半と後半で欠け方が違うとき比較が歪む)。
 * すべて、レースの日より前の情報と、そのレースの出走表(枠・馬体重の前走比・騎手・オッズ順位)だけから作る。
 * テストは `scripts/test/market-blindspots-653-conditions.test.ts`。
 */

export interface PrevRun {
  date: string;
  raceId: string;
  venueName: string;
  courseType: string;
  distance: number;
  going: string | null;
  /** 0(新馬・未勝利)〜4(オープン・重賞)。読めなければ null。 */
  raceClass: number | null;
  n: number;
  finish: number | null;
  /** 4 コーナーの通過順。 */
  pos4: number | null;
  /** そのレースでの上がり 3F の順位(1 が最速)。前走が hist に入っているときだけ。 */
  last3fRank: number | null;
  /** 勝ち馬とのタイム差(秒)。 */
  marginSec: number | null;
  jockeyId: string | null;
  jockeyMark: string | null;
  /** 騎手の減量の印が分かるか(hist に入っている走だけ)。 */
  markKnown: boolean;
  trainerId: string | null;
  trainerKnown: boolean;
  ninki: number | null;
  /** 前走のときの騎手の指標(jEdge)。前走が hist に入っているときだけ。 */
  jEdge: number | null;
}

export type GoingShift = "heavier" | "lighter" | "same";
export interface DayTrend {
  /** 前残り度 Δf。対象外なら null。 */
  df: number | null;
  /** 内有利度 Δi。対象外なら null。 */
  di: number | null;
  /** 先に発走したレースの馬場状態からの変化。先のレースが無ければ null。 */
  shift: GoingShift | null;
}
export interface HorseContext {
  date: string;
  courseType: string;
  distance: number;
  going: string | null;
  direction: string | null;
  venueName: string;
  raceClass: number | null;
  n: number;
  month: number;
  spans: readonly string[];
  sex: string | null;
  age: number | null;
  wakuban: number | null;
  jockeyId: string | null;
  jockeyMark: string | null;
  trainerId: string | null;
  jEdge: number | null;
  bodyWeightDiff: number | null;
  /** 単勝オッズの順位(1 が最も低いオッズ。同じ値は同順位)。 */
  oddsRank: number;
  /** 最も人気がない(オッズが最も高い)馬か。 */
  worstOddsRank: boolean;
  prev: PrevRun | null;
  daysSince: number | null;
  /** 見つかった過去の走の数。 */
  priorRunCount: number;
  ranAtVenue: boolean;
  /** 過去脚質(0 が先頭、1 が最後方)。 */
  style: number | null;
  trends: { m60?: DayTrend; m40?: DayTrend; any?: DayTrend };
}

const GOING_ORDER: Record<string, number> = { 良: 0, 稍重: 1, 重: 2, 不良: 3 };
export const goingRank = (g: string | null): number | null => (g !== null && g in GOING_ORDER ? GOING_ORDER[g]! : null);

/** 左回りの中央の競馬場。右回りは中央のそれ以外。地方は対象外(null)。 */
const LEFT_VENUES = new Set(["東京", "新潟", "中京"]);
const RIGHT_VENUES = new Set(["札幌", "函館", "福島", "中山", "京都", "阪神", "小倉"]);
export function venueDirection(venueName: string): "左" | "右" | null {
  if (LEFT_VENUES.has(venueName)) return "左";
  if (RIGHT_VENUES.has(venueName)) return "右";
  return null;
}

/** レース名からクラスの順序(plan.md)。読めなければ null。 */
export function classFromName(name: string): number | null {
  if (/新馬|未勝利/.test(name)) return 0;
  if (/1勝クラス|500万/.test(name)) return 1;
  if (/2勝クラス|1000万/.test(name)) return 2;
  if (/3勝クラス|1600万/.test(name)) return 3;
  if (/オープン|\((G[123I]+|L|OP)\)|\(J\.?G/.test(name)) return 4;
  return null;
}

/** 直近 5 走(新しい順)の 4 コーナー通過順 ÷ 頭数 の平均。通過順が分かる走が 3 走未満なら null。 */
export function styleAverage(runsNewestFirst: ReadonlyArray<{ pos4: number | null; n: number }>): number | null {
  const vals: number[] = [];
  for (const r of runsNewestFirst.slice(0, 5)) {
    if (r.pos4 !== null && r.n > 0) vals.push(r.pos4 / r.n);
  }
  if (vals.length < 3) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

type Tri = boolean | null;

const FRONT_MAX = 0.33;
const CLOSER_MIN = 0.6;
const isRestBreak = (d: number | null): Tri => (d === null ? null : d >= 120);

function trendConditions(c: HorseContext, tr: DayTrend | undefined, suffix: string, out: Record<string, Tri>): void {
  const front: Tri = c.style === null ? null : c.style <= FRONT_MAX;
  const closer: Tri = c.style === null ? null : c.style >= CLOSER_MIN;
  const inner: Tri = c.wakuban === null ? null : c.wakuban <= 3;
  const outer: Tri = c.wakuban === null ? null : c.wakuban >= 6;
  const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
  const df = tr?.df ?? null;
  const di = tr?.di ?? null;
  const dfOver = (th: number, up: boolean): Tri => (df === null ? null : up ? df >= th : df <= th);
  const diOver = (th: number, up: boolean): Tri => (di === null ? null : up ? di >= th : di <= th);
  const shift = tr?.shift ?? null;
  const changed: Tri = shift === null ? null : shift !== "same";
  out[`T1${suffix}`] = and(dfOver(0.1, true), front);
  out[`T2${suffix}`] = and(dfOver(0.1, true), closer);
  out[`T3${suffix}`] = and(dfOver(-0.1, false), front);
  out[`T4${suffix}`] = and(dfOver(-0.1, false), closer);
  out[`T5${suffix}`] = and(diOver(0.12, true), inner);
  out[`T6${suffix}`] = and(diOver(0.12, true), outer);
  out[`T7${suffix}`] = and(diOver(-0.12, false), outer);
  out[`T8${suffix}`] = and(diOver(-0.12, false), inner);
  out[`T9${suffix}`] = shift === null ? null : shift === "heavier";
  out[`T10${suffix}`] = shift === null ? null : shift === "lighter";
  out[`T11${suffix}`] = and(changed, front);
}

/**
 * 59 個の条件(`withSensitivity` が true のときは T1〜T11 の 40 分版 `_m40`・すべて版 `_any` も)。
 */
export function evaluateConditions(c: HorseContext, withSensitivity = false): Record<string, Tri> {
  const out: Record<string, Tri> = {};
  const p = c.prev;
  const gNow = goingRank(c.going);

  // 前走(P)
  const posOk = p !== null && p.n >= 8 && p.pos4 !== null;
  const p1: Tri =
    p === null || p.n < 8 || p.pos4 === null || p.last3fRank === null || p.finish === null
      ? null
      : 3 * p.pos4 > 2 * p.n && p.last3fRank <= 3 && p.finish >= 4;
  out.P1 = p1;
  out.P2 = !posOk || p.finish === null ? null : 3 * p.pos4! <= p.n && p.finish >= 4;
  out.P3 = p === null || p.n < 8 || p.marginSec === null || p.finish === null ? null : p.marginSec <= 0.5 && 2 * p.finish > p.n;
  out.P4 = p === null || p.marginSec === null ? null : p.marginSec >= 2.0;
  out.P5 = p === null || p.last3fRank === null ? null : p.last3fRank === 1 && p.finish !== null && p.finish >= 4;
  const gPrev = p === null ? null : goingRank(p.going);
  out.P6 = gPrev === null || gNow === null ? null : gPrev >= 2 && gNow === 0;
  out.P7 = gPrev === null || gNow === null ? null : gPrev === 0 && gNow >= 1;
  out.P8 = p === null ? null : p.finish === 1;

  // 条件の替わり(K)
  const classKnown = p !== null && p.raceClass !== null && c.raceClass !== null;
  out.K1 = classKnown ? c.raceClass! > p.raceClass! : null;
  out.K2 = classKnown ? c.raceClass! < p.raceClass! : null;
  out.K3 = classKnown ? c.raceClass! > p.raceClass! && p.finish === 1 : null;
  out.K4 = p === null ? null : c.distance - p.distance >= 400;
  out.K5 = p === null ? null : c.distance - p.distance <= -400;
  out.K6 = p === null ? null : p.courseType === "芝" && c.courseType === "ダ";
  out.K7 = p === null ? null : p.courseType === "ダ" && c.courseType === "芝";
  out.K8 = c.priorRunCount < 3 ? null : !c.ranAtVenue;
  const prevDir = p === null ? null : venueDirection(p.venueName);
  out.K9 = prevDir === null ? null : prevDir === "右" && c.direction === "左";

  // 人(J)
  const changedJockey: Tri = p === null || p.jockeyId === null || c.jockeyId === null ? null : p.jockeyId !== c.jockeyId;
  const mark = c.jockeyMark !== null;
  out.J1 = changedJockey;
  out.J2 = changedJockey === null ? null : changedJockey && mark;
  out.J3 = changedJockey === null || p === null || !p.markKnown ? null : changedJockey && p.jockeyMark !== null && !mark;
  out.J4 = p === null || !p.trainerKnown || p.trainerId === null || c.trainerId === null ? null : p.trainerId !== c.trainerId;
  const edgeDiff = p !== null && p.jEdge !== null && c.jEdge !== null ? c.jEdge - p.jEdge : null;
  const edgeCond = (f: (d: number) => boolean): Tri =>
    changedJockey === null ? null : changedJockey === false ? false : edgeDiff === null ? null : f(edgeDiff);
  // 浮動小数の丸めで境界(ちょうど 0.02)が揺れないよう 1e-9 を許す。
  out.J5 = edgeCond((d) => d >= 0.02 - 1e-9);
  out.J6 = edgeCond((d) => d <= -0.02 + 1e-9);
  out.J7 = mark;

  // 体(W)
  const bw = c.bodyWeightDiff;
  const rest = isRestBreak(c.daysSince);
  const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
  out.W1 = bw === null ? null : bw >= 10;
  out.W2 = bw === null ? null : bw <= -10;
  out.W3 = and(out.W1, rest);
  out.W4 = and(out.W2, rest);

  // 間隔(I)
  const d = c.daysSince;
  out.I1 = rest;
  out.I2 = and(rest, c.raceClass === null ? null : c.raceClass === 0);
  out.I3 = and(rest, c.raceClass === null ? null : c.raceClass >= 3);
  out.I4 = and(rest, c.sex === null ? null : c.sex === "牝");
  out.I5 = and(rest, c.age === null ? null : c.age >= 5);
  out.I6 = d === null ? null : d <= 7;
  out.I7 = d === null ? null : d >= 8 && d <= 14;
  out.I9 = and(rest, p === null ? null : p.finish !== null && p.finish <= 3);

  // 季節・性・齢(S)
  out.S1 = c.sex === null ? null : c.month >= 7 && c.month <= 8 && c.sex === "牝";
  out.S2 = c.age === null ? null : c.age === 2;
  out.S3 = c.age === null || c.raceClass === null ? null : c.age === 3 && c.month >= 1 && c.month <= 5 && c.raceClass === 0;
  out.S4 = c.age === null ? null : c.age === 3 && c.month >= 6 && c.month <= 12 && c.spans.some((s) => s.includes("３歳以上"));
  out.S5 = c.sex === null ? null : c.sex === "セ";
  out.S6 = c.age === null ? null : c.age >= 7;

  // レースの形(F)
  out.F1 = c.oddsRank === 1;
  out.F2 = c.n >= 14 && c.worstOddsRank;
  out.F3 = c.wakuban === null ? null : c.n >= 16 && c.wakuban <= 2;
  out.F4 = c.wakuban === null ? null : c.n >= 16 && c.wakuban >= 7;
  out.F5 = c.style === null ? null : c.wakuban === null ? null : c.style <= FRONT_MAX && c.wakuban <= 3 && c.distance <= 1400;
  out.F6 = c.style === null ? null : c.style >= CLOSER_MIN && c.courseType === "ダ" && c.distance <= 1400;

  // その日の馬場の傾向(T)
  trendConditions(c, c.trends.m60, "", out);
  if (withSensitivity) {
    trendConditions(c, c.trends.m40, "_m40", out);
    trendConditions(c, c.trends.any, "_any", out);
  }
  return out;
}

export const CONDITION_IDS: readonly string[] = Object.keys(evaluateConditions({
  date: "2000-01-01", courseType: "芝", distance: 1600, going: "良", direction: "左", venueName: "東京", raceClass: 1, n: 16,
  month: 1, spans: [], sex: "牡", age: 4, wakuban: 1, jockeyId: null, jockeyMark: null, trainerId: null, jEdge: null,
  bodyWeightDiff: null, oddsRank: 1, worstOddsRank: false, prev: null, daysSince: null, priorRunCount: 0, ranAtVenue: false,
  style: null, trends: {},
}));
