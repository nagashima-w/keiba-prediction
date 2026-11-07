/**
 * #653: その日の馬場の傾向(前残り度 Δf・内有利度 Δi・馬場状態の変わり目)。docs/investigations/market-blindspots-653/plan.md の T の節。
 *
 * そのレースの結果を使わないために、同じ日・同じ競馬場・同じ芝/ダートで、発走時刻が `t − lag` 分以下のレースだけを使う
 * (`lag` が null のときは、発走時刻が t より前のレースすべて)。「ふだん」は前日までのレースだけで作る(同じ日の結果を入れない)。
 */
import type { DayTrend, GoingShift } from "./conditions.js";
import { goingRank } from "./conditions.js";

export interface TrendHorse {
  pos4: number | null;
  finish: number | null;
  wakuban: number | null;
}
export interface TrendRace {
  raceId: string;
  date: string;
  venueCode: string;
  courseType: string;
  distance: number;
  /** 発走時刻(0 時からの分)。 */
  startMinutes: number;
  going: string | null;
  /** 走った馬(取消・除外を除く)。 */
  horses: TrendHorse[];
}
export interface TrendOptions {
  minRefFront: number;
  minRefSide: number;
  minDayFront: number;
  minDaySide: number;
  minRaces: number;
}
export const PLAN_TREND_OPTIONS: TrendOptions = { minRefFront: 300, minRefSide: 300, minDayFront: 10, minDaySide: 10, minRaces: 2 };

/** 距離帯: ≤1200 → 0、≤1600 → 1、≤2000 → 2、それ以上 → 3。 */
export function distanceBand(d: number): number {
  return d <= 1200 ? 0 : d <= 1600 ? 1 : d <= 2000 ? 2 : 3;
}

interface Tally {
  front: number;
  frontPlaced: number;
  inner: number;
  innerPlaced: number;
  outer: number;
  outerPlaced: number;
}
const zero = (): Tally => ({ front: 0, frontPlaced: 0, inner: 0, innerPlaced: 0, outer: 0, outerPlaced: 0 });
function add(a: Tally, b: Tally): void {
  a.front += b.front;
  a.frontPlaced += b.frontPlaced;
  a.inner += b.inner;
  a.innerPlaced += b.innerPlaced;
  a.outer += b.outer;
  a.outerPlaced += b.outerPlaced;
}

function tallyRace(r: TrendRace): Tally {
  const t = zero();
  const n = r.horses.length;
  const cut = Math.ceil(n / 3);
  for (const h of r.horses) {
    const placed = h.finish !== null && h.finish <= 3 ? 1 : 0;
    if (h.pos4 !== null && h.pos4 <= cut) {
      t.front += 1;
      t.frontPlaced += placed;
    }
    if (h.wakuban !== null && h.wakuban <= 3) {
      t.inner += 1;
      t.innerPlaced += placed;
    } else if (h.wakuban !== null && h.wakuban >= 6) {
      t.outer += 1;
      t.outerPlaced += placed;
    }
  }
  return t;
}

const groupKey = (r: TrendRace): string => `${r.date}|${r.venueCode}|${r.courseType}`;
const refKey = (r: TrendRace): string => `${r.venueCode}|${r.courseType}|${distanceBand(r.distance)}`;

/**
 * 全レースの傾向を返す(キーは raceId)。`races` の順序は問わない。
 * 対象外の項目は null。馬場状態の変わり目は、使えるレース(発走が lag 分以上前)のうち最も遅く発走したレースとの比較。
 */
export function computeTrends(races: readonly TrendRace[], lagMinutes: number | null, opt: TrendOptions = PLAN_TREND_OPTIONS): Map<string, DayTrend> {
  const result = new Map<string, DayTrend>();
  const byDate = new Map<string, TrendRace[]>();
  for (const r of races) {
    const l = byDate.get(r.date) ?? [];
    l.push(r);
    byDate.set(r.date, l);
  }
  const ref = new Map<string, Tally>();
  for (const date of [...byDate.keys()].sort()) {
    const dayRaces = byDate.get(date)!;
    const groups = new Map<string, TrendRace[]>();
    for (const r of dayRaces) {
      const l = groups.get(groupKey(r)) ?? [];
      l.push(r);
      groups.set(groupKey(r), l);
    }
    for (const group of groups.values()) {
      for (const r of group) {
        const usable = group.filter((e) => e.raceId !== r.raceId && (lagMinutes === null ? e.startMinutes < r.startMinutes : e.startMinutes <= r.startMinutes - lagMinutes));
        let shift: GoingShift | null = null;
        if (usable.length > 0) {
          const latest = usable.reduce((a, b) => (b.startMinutes > a.startMinutes ? b : a));
          const g0 = goingRank(latest.going);
          const g1 = goingRank(r.going);
          if (g0 !== null && g1 !== null) shift = g1 > g0 ? "heavier" : g1 < g0 ? "lighter" : "same";
        }
        // その日(使えるレース)の集計と、同じレースの距離帯のふだんから期待される値(レースごとのふだんの率 × 頭数 の合計)。
        const day = zero();
        let expFront = 0;
        let expInner = 0;
        let expOuter = 0;
        let used = 0;
        for (const e of usable) {
          const rf = ref.get(refKey(e));
          if (rf === undefined || rf.front < opt.minRefFront || rf.inner < opt.minRefSide || rf.outer < opt.minRefSide) continue;
          const t = tallyRace(e);
          add(day, t);
          expFront += t.front * (rf.frontPlaced / rf.front);
          expInner += t.inner * (rf.innerPlaced / rf.inner);
          expOuter += t.outer * (rf.outerPlaced / rf.outer);
          used += 1;
        }
        let df: number | null = null;
        let di: number | null = null;
        if (used >= opt.minRaces) {
          if (day.front >= opt.minDayFront) df = day.frontPlaced / day.front - expFront / day.front;
          if (day.inner >= opt.minDaySide && day.outer >= opt.minDaySide) {
            di = day.innerPlaced / day.inner - day.outerPlaced / day.outer - (expInner / day.inner - expOuter / day.outer);
          }
        }
        result.set(r.raceId, { df, di, shift });
      }
    }
    // 前日までのふだんに、この日の結果を足す(翌日以降の傾向のため)。
    for (const r of dayRaces) {
      const k = refKey(r);
      const cur = ref.get(k) ?? zero();
      add(cur, tallyRace(r));
      ref.set(k, cur);
    }
  }
  return result;
}
