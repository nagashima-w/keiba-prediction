/**
 * #652: 騎手の市場比の指標の先読み防止(`scripts/stat-model-649/edge-features.ts`)のテスト。
 * 合成した結果の記録で、「そのレースの日以降の騎乗・結果が、そのレースの指標を動かさない」ことを確かめる。
 */

import { describe, expect, it } from "vitest";
import type { MarketSourceRecord } from "../../cloud/src/market-edge-calc.js";
import { buildEdgeIndex, edgeAt } from "../stat-model-649/edge-features.js";

/** 6 頭立て。騎手 J1 が 1 番人気に乗り、`j1Finish` で入る。ほかの馬の着順は 2〜6。 */
function race(raceId: string, date: string, j1Finish: number): MarketSourceRecord {
  const odds = [2, 4, 6, 8, 10, 12];
  const others = [2, 3, 4, 5, 6].filter((f) => f !== j1Finish);
  const finishes = [j1Finish, ...others];
  return {
    raceId,
    date,
    kind: "central",
    horses: odds.map((o, i) => ({
      finish: finishes[i]!,
      winOdds: o,
      jockeyId: i === 0 ? "J1" : `X${i}`,
      jockeyName: i === 0 ? "騎手1" : `騎手X${i}`,
      trainerId: `T${i}`,
      trainerName: `調教師${i}`,
    })),
  };
}

describe("buildEdgeIndex・edgeAt: 先読みの防止", () => {
  const base = [race("r1", "2025-01-10", 1), race("r2", "2025-02-10", 6), race("r3", "2025-03-10", 1)];

  it("同じ日の騎乗は含めない: 2025-03-10 の指標に、同日の r3 の結果は入らない(翌日には入る)", () => {
    const idx = buildEdgeIndex(base);
    const sameDay = edgeAt(idx.jockeys, "J1", "2025-03-10");
    const nextDay = edgeAt(idx.jockeys, "J1", "2025-03-11");
    expect(sameDay.n).toBe(2);
    expect(nextDay.n).toBe(3);
    // 翌日には 3 着内の結果(r3 は 1 着)が加わるので、値が変わる(差が 0 でないことを先に固定する)。
    expect(nextDay.edge).not.toBe(sameDay.edge);
  });

  it("後の月の結果を書き換えても、前のレースの指標は変わらない(係数も後の月で当てはめていない)", () => {
    const a = buildEdgeIndex([...base, race("r4", "2025-06-10", 1)]);
    const b = buildEdgeIndex([...base, race("r4", "2025-06-10", 6)]);
    for (const date of ["2025-02-01", "2025-03-10", "2025-05-31", "2025-06-10"]) {
      expect(edgeAt(a.jockeys, "J1", date)).toEqual(edgeAt(b.jockeys, "J1", date));
    }
    // 書き換えが効いていること(翌日以降では指標が変わる)。
    expect(edgeAt(a.jockeys, "J1", "2025-06-11").edge).not.toBe(edgeAt(b.jockeys, "J1", "2025-06-11").edge);
  });

  it("月の係数は、その月の初日より前の行だけで決まる(同じ月の結果を書き換えても係数は同じ)", () => {
    const a = buildEdgeIndex([...base, race("r4", "2025-06-10", 1)]);
    const b = buildEdgeIndex([...base, race("r4", "2025-06-10", 6)]);
    expect(a.coefByMonth.get("2025-06")).toEqual(b.coefByMonth.get("2025-06"));
    // 最初の月は行が無いので、市場の確率そのまま。
    expect(a.coefByMonth.get("2025-01")).toEqual([0, 1, 0]);
  });

  it("窓は 2 年: 2 年と 1 日前の騎乗は含めない", () => {
    const idx = buildEdgeIndex([race("old", "2025-01-09", 1), race("in", "2025-01-10", 1)]);
    // 2027-01-10 の窓は 2025-01-10 以降。
    expect(edgeAt(idx.jockeys, "J1", "2027-01-10").n).toBe(1);
    expect(edgeAt(idx.jockeys, "J1", "2027-01-09").n).toBe(2);
  });

  it("ID が無い・知らない騎手は指標 0・件数 0", () => {
    const idx = buildEdgeIndex(base);
    expect(edgeAt(idx.jockeys, null, "2025-03-10")).toEqual({ edge: 0, n: 0 });
    expect(edgeAt(idx.jockeys, "ZZZ", "2025-03-10")).toEqual({ edge: 0, n: 0 });
  });
});
