/**
 * #653: その日の馬場の傾向(`scripts/market-blindspots-653/trend.ts`)のテスト。
 * 先読みの遮断(発走の遅れ、同じ日・翌日の結果を使わない)と、対象外の条件を固定する。
 */
import { describe, expect, it } from "vitest";
import { computeTrends, distanceBand, type TrendRace } from "../market-blindspots-653/trend.js";

/** 8 頭立て。pos4 が前 1/3(≤3)の馬は front。placedFront は front のうち 3着内にする頭数(1〜3 着の枠に入る)。 */
function race(id: string, date: string, start: string, o: { frontPlaced: number; going?: string; venue?: string; waku?: number[] } ): TrendRace {
  const horses = [];
  // 8 頭: pos4 = 1..8、着順 1..8 を、frontPlaced 頭の front(pos4 1〜3)が 3着内に入るように割り当てる。
  const finishOfPos: Record<number, number> = {};
  const frontPlacedN = o.frontPlaced;
  // front(1〜3)のうち frontPlaced 頭に 1,2,3 着を、残りの 3着内の枠は pos4 の後ろの馬に。
  const placedSlots = [1, 2, 3];
  for (let i = 1; i <= 3; i++) finishOfPos[i] = i <= frontPlacedN ? placedSlots.shift()! : 0;
  let nextFinish = 4;
  for (let i = 4; i <= 8; i++) finishOfPos[i] = placedSlots.length > 0 ? placedSlots.shift()! : nextFinish++;
  for (let i = 1; i <= 3; i++) if (finishOfPos[i] === 0) finishOfPos[i] = nextFinish++;
  for (let i = 1; i <= 8; i++) {
    horses.push({ pos4: i, finish: finishOfPos[i]!, wakuban: o.waku?.[i - 1] ?? i });
  }
  const [h, m] = start.split(":").map(Number);
  return { raceId: id, date, venueCode: o.venue ?? "05", courseType: "芝", distance: 1600, startMinutes: h! * 60 + m!, going: o.going ?? "良", horses };
}

const OPT = { minRefFront: 6, minRefSide: 6, minDayFront: 4, minDaySide: 4, minRaces: 2 };

describe("distanceBand", () => {
  it.each([[1000, 0], [1200, 0], [1201, 1], [1600, 1], [1800, 2], [2000, 2], [2200, 3], [3600, 3]])("%i m は %i", (d, b) => {
    expect(distanceBand(d)).toBe(b);
  });
});

describe("computeTrends", () => {
  const history = [
    // 前日までの「ふだん」: front 3 頭のうち 1 頭が 3着内(率 1/3)を 4 レース。front 12 頭・placed 4。
    race("h1", "2025-01-01", "10:00", { frontPlaced: 1 }),
    race("h2", "2025-01-01", "11:00", { frontPlaced: 1 }),
    race("h3", "2025-01-02", "10:00", { frontPlaced: 1 }),
    race("h4", "2025-01-02", "11:00", { frontPlaced: 1 }),
  ];

  it("ふだんより前に行った馬が 3着内に入る日は Δf が正(前の 2 レースが 3 頭とも 3着内なら +2/3)", () => {
    const rs = [...history, race("d1", "2025-01-10", "10:00", { frontPlaced: 3 }), race("d2", "2025-01-10", "11:00", { frontPlaced: 3 }), race("d3", "2025-01-10", "12:30", { frontPlaced: 0 })];
    const t = computeTrends(rs, 60, OPT);
    // d3 の 60 分以上前に発走: d1(10:00)・d2(11:00)。front 6 頭すべて 3着内 → 1.0。ふだん 1/3。
    expect(t.get("d3")!.df).toBeCloseTo(1 - 1 / 3, 10);
  });

  it("60 分以内に発走したレースは使わない(11:30 発走の d2 は、12:00 発走の d3 の 30 分前なので使えない)", () => {
    const rs = [...history, race("d1", "2025-01-10", "10:00", { frontPlaced: 3 }), race("d2", "2025-01-10", "11:30", { frontPlaced: 0 }), race("d3", "2025-01-10", "12:00", { frontPlaced: 0 })];
    // 60 分版: d1 のみ → 1 レースなので対象外
    expect(computeTrends(rs, 60, OPT).get("d3")!.df).toBeNull();
    // すべて版: d1・d2 → front 6 頭のうち 3着内 3 頭 = 0.5。ふだん 1/3
    expect(computeTrends(rs, null, OPT).get("d3")!.df).toBeCloseTo(0.5 - 1 / 3, 10);
    // 40 分版: d2 は 30 分前なので使えない
    expect(computeTrends(rs, 40, OPT).get("d3")!.df).toBeNull();
  });

  it("同じ発走時刻のレース・あとのレースの結果は使わない", () => {
    const rs = [...history, race("d1", "2025-01-10", "10:00", { frontPlaced: 3 }), race("d2", "2025-01-10", "10:00", { frontPlaced: 3 }), race("d3", "2025-01-10", "10:00", { frontPlaced: 0 })];
    expect(computeTrends(rs, null, OPT).get("d3")!.df).toBeNull();
  });

  it("別の競馬場・翌日のレースは使わない", () => {
    const rs = [...history, race("o1", "2025-01-10", "10:00", { frontPlaced: 3, venue: "06" }), race("o2", "2025-01-10", "11:00", { frontPlaced: 3, venue: "06" }), race("d3", "2025-01-10", "13:00", { frontPlaced: 0 })];
    expect(computeTrends(rs, 60, OPT).get("d3")!.df).toBeNull();
  });

  it("ふだんの材料(前日までの front の頭数)が足りなければ対象外", () => {
    const rs = [race("h1", "2025-01-01", "10:00", { frontPlaced: 1 }), race("d1", "2025-01-10", "10:00", { frontPlaced: 3 }), race("d2", "2025-01-10", "11:00", { frontPlaced: 3 }), race("d3", "2025-01-10", "13:00", { frontPlaced: 0 })];
    expect(computeTrends(rs, 60, OPT).get("d3")!.df).toBeNull();
  });

  it("同じ日の結果はふだんに入れない(前日までだけ)", () => {
    const base = [...history, race("d1", "2025-01-10", "10:00", { frontPlaced: 3 }), race("d2", "2025-01-10", "11:00", { frontPlaced: 3 }), race("d3", "2025-01-10", "13:00", { frontPlaced: 0 })];
    const withLater = [...base, race("x", "2025-01-10", "15:00", { frontPlaced: 3 }), race("y", "2025-01-10", "16:00", { frontPlaced: 3 })];
    expect(computeTrends(withLater, 60, OPT).get("d3")!.df).toBeCloseTo(computeTrends(base, 60, OPT).get("d3")!.df!, 12);
  });

  it("内有利度 Δi: 内枠(1〜3)の 3着内率 − 外枠(6〜8)の率 の、その日 − ふだん", () => {
    // history: 枠 = 馬番(pos と同じ)。front(pos 1..3)が 3着内なら内枠が 3着内。
    const rs = [...history, race("d1", "2025-01-10", "10:00", { frontPlaced: 3 }), race("d2", "2025-01-10", "11:00", { frontPlaced: 3 }), race("d3", "2025-01-10", "13:00", { frontPlaced: 0 })];
    const t = computeTrends(rs, 60, OPT).get("d3")!;
    // その日: 内枠 6 頭中 6 頭 = 1.0、外枠(6〜8 枠)は 3着内 0 → 0。差 1.0。ふだん: 内 4/12、外 0 → 差 1/3。
    expect(t.di).toBeCloseTo(1 - 1 / 3, 10);
  });

  it("馬場状態の変わり目: 直近の先行レースと比べる", () => {
    const rs = [...history, race("d1", "2025-01-10", "10:00", { frontPlaced: 1, going: "良" }), race("d2", "2025-01-10", "11:00", { frontPlaced: 1, going: "稍重" }), race("d3", "2025-01-10", "13:00", { frontPlaced: 1, going: "重" }), race("d4", "2025-01-10", "14:00", { frontPlaced: 1, going: "稍重" }), race("d5", "2025-01-10", "15:00", { frontPlaced: 1, going: "稍重" })];
    const t = computeTrends(rs, 60, OPT);
    expect(t.get("d1")!.shift).toBeNull();
    expect(t.get("d2")!.shift).toBe("heavier"); // 11:00−10:00 = 60 分なので d1(良)が使える。良→稍重
    expect(t.get("d3")!.shift).toBe("heavier"); // 13:00 の 60 分前は 12:00。直近は d2(稍重)→ 重
    expect(t.get("d4")!.shift).toBe("lighter"); // 直近は d3(重)→ 稍重
    expect(t.get("d5")!.shift).toBe("same"); // 直近は d4(稍重)→ 稍重
  });
});
