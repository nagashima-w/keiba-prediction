import { describe, expect, it } from "vitest";
import {
  MARKET_EDGE_SHRINK,
  MARKET_MIN_FIELD,
  buildMarketRow,
  computeMarketEdges,
  decodeMarketHorses,
  encodeMarketHorses,
  fitMarketBase,
  marketWindowCutoff,
  type MarketHorse,
  type MarketRow,
  type MarketSourceRecord,
} from "../src/market-edge-calc";

/**
 * Issue #642: 騎手・調教師の「市場の予測との差」の指標の純関数。
 * 期待値は、リポジトリの外の参照実装(#548 の explore.py と同じ式の Python。標準ライブラリだけ)で出した値。
 * 合成データの作り方(線形合同法 x = x*1103515245+12345 mod 2^31)は Python 側と同じ。
 */

/** 線形合同法(Python の参照実装と同じ列を出す)。 */
function lcg(seed: number): () => number {
  let x = seed;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) % 2147483648;
    if (x < 0) x += 2147483648;
    return x / 2147483648;
  };
}
const sig = (z: number): number => 1 / (1 + Math.exp(-Math.max(Math.min(z, 35), -35)));
const logit = (p: number): number => {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
};

interface SyntheticHorse {
  winOdds: number;
  y: 0 | 1;
  jockey: number;
  trainer: number;
}

/** 参照実装の gen() と同じ合成データ(200 レース、頭数 8〜12)。 */
function synthetic(seed = 12345, races = 200): SyntheticHorse[][] {
  const r = lcg(seed);
  const out: SyntheticHorse[][] = [];
  for (let ri = 0; ri < races; ri++) {
    const n = 8 + (ri % 5);
    const u = Array.from({ length: n }, () => r());
    const w = u.map((x) => 0.2 + x);
    const tot = w.reduce((a, b) => a + b, 0);
    const q = w.map((x) => x / tot);
    out.push(
      q.map((qi) => {
        const p = sig(0.5 + 1.0 * logit(qi) - 0.4 * Math.log(n));
        const y: 0 | 1 = r() < p ? 1 : 0;
        const jockey = Math.floor(r() * 12);
        const trainer = Math.floor(r() * 8);
        return { winOdds: 0.8 / qi, y, jockey, trainer };
      }),
    );
  }
  return out;
}

function toRecord(raceId: string, date: string, horses: SyntheticHorse[]): MarketSourceRecord {
  return {
    raceId,
    date,
    kind: "central",
    horses: horses.map((h) => ({
      finish: h.y === 1 ? 2 : 9,
      winOdds: h.winOdds,
      jockeyId: `J${h.jockey}`,
      jockeyName: `騎手${h.jockey}`,
      trainerId: `T${h.trainer}`,
      trainerName: `厩舎${h.trainer}`,
    })),
  };
}

function syntheticRows(): MarketRow[] {
  return synthetic().map((hs, i) => {
    const row = buildMarketRow(toRecord(String(202401010000 + i), "2025-01-01", hs));
    if (row === null) throw new Error("合成データが行にならない");
    return row;
  });
}

describe("buildMarketRow(1 レース → 市場の行)", () => {
  const base = (over: Partial<MarketSourceRecord["horses"][number]>, i: number): MarketSourceRecord["horses"][number] => ({
    finish: i + 1,
    winOdds: 2 + i,
    jockeyId: `J${i}`,
    jockeyName: `騎${i}`,
    trainerId: `T${i}`,
    trainerName: `厩${i}`,
    ...over,
  });
  const rec = (horses: MarketSourceRecord["horses"], kind: "central" | "nar" = "central"): MarketSourceRecord => ({ raceId: "202401010101", date: "2024-08-10", kind, horses });

  it("q は 1/単勝オッズをレースの中で合計 1 に割り戻した値で、3 着内なら y = 1", () => {
    const row = buildMarketRow(rec([0, 1, 2, 3, 4, 5].map((i) => base({}, i))))!;
    expect(row.horses).toHaveLength(6);
    const inv = [2, 3, 4, 5, 6, 7].map((o) => 1 / o);
    const tot = inv.reduce((a, b) => a + b, 0);
    row.horses.forEach((h, i) => expect(h[4]).toBeCloseTo(inv[i]! / tot, 12));
    expect(row.horses.reduce((a, h) => a + h[4], 0)).toBeCloseTo(1, 12);
    expect(row.horses.map((h) => h[5])).toEqual([1, 1, 1, 0, 0, 0]); // 着順 1〜6 → 3 着内は先頭 3 頭
    expect(row.raceId).toBe("202401010101");
    expect(row.raceDate).toBe("2024-08-10");
  });

  it("オッズか着順が無い馬(取消・除外・中止)・オッズ 0 以下は除き、頭数と q の合計は残りの馬で決まる", () => {
    const horses = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => base({}, i));
    horses[1] = base({ winOdds: null }, 1);
    horses[2] = base({ finish: null }, 2);
    horses[3] = base({ winOdds: 0 }, 3);
    const row = buildMarketRow(rec(horses))!;
    expect(row.horses.map((h) => h[0])).toEqual(["J0", "J4", "J5", "J6", "J7"]); // 除いた 3 頭ぶん減る
    expect(row.horses.length).toBe(MARKET_MIN_FIELD); // 境界: ちょうど最小頭数は残る
    expect(row.horses.reduce((a, h) => a + h[4], 0)).toBeCloseTo(1, 12);
  });

  it("計算に入る馬が最小頭数(5)に満たないレースは null(参照実装と同じ。4 頭では行にしない)", () => {
    expect(MARKET_MIN_FIELD).toBe(5);
    expect(buildMarketRow(rec([0, 1, 2, 3].map((i) => base({}, i))))).toBeNull();
    expect(buildMarketRow(rec([0, 1, 2, 3, 4].map((i) => base({}, i))))).not.toBeNull();
  });

  it("地方のレースは null(中央だけ)", () => {
    expect(buildMarketRow(rec([0, 1, 2, 3, 4, 5].map((i) => base({}, i)), "nar"))).toBeNull();
  });

  it("騎手・調教師の ID や名前が無い馬も行に残し(当てはめには使う)、無い項目は null のまま", () => {
    const horses = [0, 1, 2, 3, 4].map((i) => base({}, i));
    horses[0] = base({ jockeyId: null, jockeyName: null, trainerId: null, trainerName: null }, 0);
    const row = buildMarketRow(rec(horses))!;
    expect(row.horses[0]!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(row.horses).toHaveLength(5);
  });

  it("同着で着順が重なっても 3 着以内は y = 1(finish ≤ 3)", () => {
    const horses = [1, 1, 3, 3, 5, 6].map((f, i) => base({ finish: f }, i));
    expect(buildMarketRow(rec(horses))!.horses.map((h) => h[5])).toEqual([1, 1, 1, 1, 0, 0]);
  });
});

describe("encodeMarketHorses / decodeMarketHorses(D1 に入れる JSON)", () => {
  const horses: MarketHorse[] = [
    ["01157", "鮫島駿", "01112", "田島", 0.21234567890123, 1],
    [null, null, null, null, 0.05, 0],
  ];
  it("往復で同じ値に戻る(q は倍精度のまま)", () => {
    expect(decodeMarketHorses(encodeMarketHorses(horses))).toEqual(horses);
  });
  it("壊れた JSON・形の違う配列・q が範囲外・y が 0/1 でないものは null", () => {
    expect(decodeMarketHorses("{")).toBeNull();
    expect(decodeMarketHorses("{}")).toBeNull();
    expect(decodeMarketHorses('[["a","b","c","d",0.1]]')).toBeNull();
    expect(decodeMarketHorses('[["a","b","c","d",1.5,1]]')).toBeNull();
    expect(decodeMarketHorses('[["a","b","c","d",0.1,2]]')).toBeNull();
    expect(decodeMarketHorses('[[1,"b","c","d",0.1,1]]')).toBeNull();
  });
});

describe("marketWindowCutoff(計算する日から遡って 2 年)", () => {
  it.each([
    ["2026-11-07", "2024-11-07"],
    ["2026-01-01", "2024-01-01"],
    ["2028-02-29", "2026-02-28"], // 2 年前に 2/29 が無い日は 2/28
    ["2026-03-01", "2024-03-01"], // 遡り先がうるう年でも 3/1 は 3/1
  ])("%s → %s", (today, expected) => {
    expect(marketWindowCutoff(today)).toBe(expected);
  });
  it("YYYY-MM-DD でなければ RangeError", () => {
    expect(() => marketWindowCutoff("2026/11/07")).toThrow(RangeError);
  });
});

describe("fitMarketBase(切片 + logit(q) + log(頭数) のロジスティック回帰)", () => {
  it("参照実装(Python)と同じ合成データで、同じ係数に収束する(7 回の反復)", () => {
    const fit = fitMarketBase(syntheticRows());
    expect(fit.converged).toBe(true);
    expect(fit.iterations).toBe(7);
    expect(fit.coef[0]).toBeCloseTo(0.8162367517950202, 6);
    expect(fit.coef[1]).toBeCloseTo(1.1203592980247878, 6);
    expect(fit.coef[2]).toBeCloseTo(-0.4204216582681477, 6);
  });

  it("真の係数 [0.5, 1.0, -0.4] から作った大きなデータでは、真の値の近くに戻る", () => {
    const rows: MarketRow[] = synthetic(777, 4000).map((hs, i) => buildMarketRow(toRecord(String(300000000000 + i), "2025-01-01", hs))!);
    const fit = fitMarketBase(rows);
    expect(fit.converged).toBe(true);
    expect(Math.abs(fit.coef[0] - 0.5)).toBeLessThan(0.15);
    expect(Math.abs(fit.coef[1] - 1.0)).toBeLessThan(0.08);
    expect(Math.abs(fit.coef[2] + 0.4)).toBeLessThan(0.08);
  });

  it("全員が 3 着内(完全分離)など収束しないデータは converged = false で、係数は有限のまま", () => {
    const rows = synthetic(1, 20).map((hs, i) => buildMarketRow(toRecord(String(400000000000 + i), "2025-01-01", hs.map((h) => ({ ...h, y: 1 as const }))))!);
    const fit = fitMarketBase(rows);
    expect(fit.converged).toBe(false);
    expect(fit.coef.every((c) => Number.isFinite(c))).toBe(true);
  });

  it("行が 0 件のときは converged = false(係数は 0)", () => {
    const fit = fitMarketBase([]);
    expect(fit.converged).toBe(false);
    expect(fit.coef).toEqual([0, 0, 0]);
  });
});

describe("computeMarketEdges(騎手・調教師ごとの指標)", () => {
  it("MARKET_EDGE_SHRINK は 30", () => {
    expect(MARKET_EDGE_SHRINK).toBe(30);
  });

  it("合成データ(200 レース)で、参照実装と同じ指標・件数・3 着内率・予測の平均になる", () => {
    const rows = syntheticRows();
    const fit = fitMarketBase(rows);
    const { jockeys, trainers } = computeMarketEdges(rows, fit.coef);
    const j = (id: string) => jockeys.find((e) => e.id === id)!;
    const t = (id: string) => trainers.find((e) => e.id === id)!;
    expect(jockeys).toHaveLength(12);
    expect(trainers).toHaveLength(8);
    expect(j("J0").n).toBe(166);
    expect(j("J0").edge).toBeCloseTo(0.01775100589033976, 6);
    expect(j("J0").hitRate).toBeCloseTo(0.0963855421686747, 9);
    expect(j("J0").predMean).toBeCloseTo(0.0754265231656229, 6);
    expect(j("J2").edge).toBeCloseTo(-0.016637651998135317, 6);
    expect(t("T3").n).toBe(231);
    expect(t("T3").edge).toBeCloseTo(0.018416976934021032, 6);
    expect(t("T1").edge).toBeCloseTo(-0.02073379359327007, 6);
    // 件数の合計 = 馬の数(全員が騎手と調教師を持つ)
    const horses = rows.reduce((a, r) => a + r.horses.length, 0);
    expect(jockeys.reduce((a, e) => a + e.n, 0)).toBe(horses);
    expect(trainers.reduce((a, e) => a + e.n, 0)).toBe(horses);
  });

  it("固定の係数 [1.0, 0.9, -0.5] で小さな 2 レースを手計算(Python)と突き合わせる。件数が少ないほど 0 に寄る(m = 30)", () => {
    const horse = (winOdds: number, y: 0 | 1, j: string, t: string) => ({ finish: y === 1 ? 1 : 9, winOdds, jockeyId: j, jockeyName: `名${j}`, trainerId: t, trainerName: `厩${t}` });
    const r1 = buildMarketRow({ raceId: "202401010101", date: "2024-08-10", kind: "central", horses: [horse(2, 1, "a", "x"), horse(3, 1, "b", "y"), horse(5, 0, "a", "y"), horse(8, 1, "c", "x"), horse(12, 0, "b", "x")] })!;
    const r2 = buildMarketRow({ raceId: "202401010102", date: "2024-08-10", kind: "central", horses: [horse(1.8, 1, "a", "y"), horse(4, 0, "c", "x"), horse(6, 0, "b", "x"), horse(9, 0, "a", "y"), horse(15, 1, "c", "y"), horse(20, 0, "b", "x")] })!;
    const { jockeys } = computeMarketEdges([r1, r2], [1.0, 0.9, -0.5]);
    const a = jockeys.find((e) => e.id === "a")!;
    const b = jockeys.find((e) => e.id === "b")!;
    const c = jockeys.find((e) => e.id === "c")!;
    expect([a.n, b.n, c.n]).toEqual([4, 4, 3]);
    expect(a.edge).toBeCloseTo(0.020787156046709325, 9);
    expect(a.hitRate).toBeCloseTo(0.5, 12);
    expect(a.predMean).toBeCloseTo(0.32330917360297073, 9);
    expect(b.edge).toBeCloseTo(0.009670649169642357, 9);
    expect(b.predMean).toBeCloseTo(0.16779948205803996, 9);
    expect(c.edge).toBeCloseTo(0.04621711165424769, 9);
    expect(c.hitRate).toBeCloseTo(2 / 3, 12);
    // 指標は「読み残しの合計 ÷ (件数 + 30)」: 差(3 着内率 − 予測の平均)× n ÷ (n + 30) と一致する。
    for (const e of [a, b, c]) expect(e.edge).toBeCloseTo(((e.hitRate - e.predMean) * e.n) / (e.n + MARKET_EDGE_SHRINK), 12);
    // 縮みが効いている(差そのものより絶対値が小さい)ことを無条件に固定する
    expect(Math.abs(a.hitRate - a.predMean)).toBeGreaterThan(0.1);
    expect(Math.abs(a.edge)).toBeLessThan(Math.abs(a.hitRate - a.predMean) / 5);
  });

  it("名前は、窓の中で最後に出たレース(開催日 → race_id の順)の名前を使う", () => {
    const mk = (raceId: string, date: string, jn: string): MarketRow => ({
      raceId,
      raceDate: date,
      horses: [0, 1, 2, 3, 4].map((i): MarketHorse => [i === 0 ? "J1" : `X${i}`, i === 0 ? jn : `名${i}`, "T1", "厩", 0.2, i === 0 ? 1 : 0]),
    });
    // 入力の並びは日付順でなくてよい
    const rows = [mk("202401010201", "2024-08-11", "新名"), mk("202401010101", "2024-08-10", "旧名"), mk("202401010202", "2024-08-11", "最新")];
    const { jockeys } = computeMarketEdges(rows, [0, 1, 0]);
    expect(jockeys.find((e) => e.id === "J1")!.name).toBe("最新");
  });

  it("ID が無い馬は集計に入れない。行が 0 件なら空", () => {
    const row: MarketRow = { raceId: "202401010101", raceDate: "2024-08-10", horses: [0, 1, 2, 3, 4].map((i): MarketHorse => [null, null, i === 0 ? null : "T1", i === 0 ? null : "厩", 0.2, 0]) };
    const r = computeMarketEdges([row], [0, 1, 0]);
    expect(r.jockeys).toEqual([]);
    expect(r.trainers[0]!.n).toBe(4);
    expect(computeMarketEdges([], [0, 0, 0])).toEqual({ jockeys: [], trainers: [] });
  });
});
