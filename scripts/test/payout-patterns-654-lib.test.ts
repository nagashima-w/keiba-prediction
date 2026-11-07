// #654 組合せの馬券の配当のずれの探索: 純粋関数(確率・形・集計)のテスト。
// 計画は docs/investigations/payout-patterns-654/plan.md。

import { describe, expect, it } from "vitest";

import {
  allCombos,
  benjaminiHochberg,
  conditionId,
  bigHitExpectation,
  evaluateForm,
  formCombos,
  harvilleOrdered,
  holm,
  marketProbs,
  normalizedEntropy,
  popularityRanks,
  qBand,
  quinellaProb,
  raceConditions,
  rankBand,
  roiWithoutTop,
  splitConditionId,
  takeoutOf,
  toAnalysisRace,
  trioProb,
  wideProb,
  type AnalysisRace,
  type Form,
} from "../payout-patterns-654/lib.js";

describe("市場の勝率と人気順", () => {
  it("1/オッズをレース内で割り戻して合計 1 にする", () => {
    const q = marketProbs([2, 4, 4]);
    expect(q.length).toBe(3);
    expect(q[0]).toBeCloseTo(0.5, 12);
    expect(q[1]).toBeCloseTo(0.25, 12);
    expect(q.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it("人気順は q の降順で、同じ q は添字の小さい方を上位にする", () => {
    expect(popularityRanks([0.2, 0.5, 0.2, 0.1])).toEqual([2, 1, 3, 4]);
  });
});

describe("Harville(Plackett–Luce の逐次抜き取り)の確率", () => {
  const q3 = [0.5, 0.3, 0.2];
  const q4 = [0.4, 0.3, 0.2, 0.1];

  it("馬単 i→j は q_i·q_j/(1−q_i)", () => {
    expect(harvilleOrdered(q3, [0, 1])).toBeCloseTo(0.3, 12);
  });

  it("三連単 i→j→k は 3 段の逐次抜き取り", () => {
    expect(harvilleOrdered(q3, [0, 1, 2])).toBeCloseTo(0.3, 12);
    expect(harvilleOrdered(q4, [0, 1, 2])).toBeCloseTo(0.4 * 0.5 * (0.2 / 0.3), 12);
  });

  it("馬連は両順序の和", () => {
    expect(quinellaProb(q3, [0, 1])).toBeCloseTo(0.3 + 0.3 * (0.5 / 0.7), 12);
  });

  it("三連複は 6 順序の和(手計算の値と一致する)", () => {
    expect(trioProb(q4, [0, 1, 2])).toBeCloseTo(0.551190476, 6);
    expect(trioProb(q4, [0, 1, 3])).toBeCloseTo(0.241269841, 6);
  });

  it("ワイドは両方を含む三連複の和", () => {
    expect(wideProb(q4, [0, 1])).toBeCloseTo(0.551190476 + 0.241269841, 6);
    // 3 頭立てなら 3 着内に 2 頭が入る確率は 1
    expect(wideProb(q3, [1, 2])).toBeCloseTo(1, 12);
  });

  it("全組合せの確率の和は 1(馬単・三連単・馬連・三連複)", () => {
    const sum = (bet: "exacta" | "trifecta" | "quinella" | "trio", f: (c: number[]) => number): number =>
      allCombos(bet, q4.length).reduce((a, c) => a + f(c), 0);
    expect(allCombos("exacta", 4).length).toBe(12);
    expect(allCombos("trifecta", 4).length).toBe(24);
    expect(allCombos("quinella", 4).length).toBe(6);
    expect(allCombos("trio", 4).length).toBe(4);
    expect(sum("exacta", (c) => harvilleOrdered(q4, c))).toBeCloseTo(1, 12);
    expect(sum("trifecta", (c) => harvilleOrdered(q4, c))).toBeCloseTo(1, 12);
    expect(sum("quinella", (c) => quinellaProb(q4, c))).toBeCloseTo(1, 12);
    expect(sum("trio", (c) => trioProb(q4, c))).toBeCloseTo(1, 12);
  });

  it("割引 λ=0 なら 2 着は残りの馬の一様分布、λ=1 は Harville と同じ", () => {
    expect(harvilleOrdered(q3, [0, 1], { lambda: 0, mu: 1 })).toBeCloseTo(0.25, 12);
    expect(harvilleOrdered(q3, [0, 1], { lambda: 1, mu: 1 })).toBeCloseTo(0.3, 12);
    // μ=0 なら 3 着は残り 2 頭の一様
    expect(harvilleOrdered(q4, [0, 1, 2], { lambda: 1, mu: 0 })).toBeCloseTo(0.4 * 0.5 * 0.5, 12);
  });
});

describe("人気帯", () => {
  it("順位帯 R1〜R5 の境", () => {
    expect([1, 2, 3, 4, 6, 7, 10, 11, 18].map(rankBand)).toEqual([
      "R1",
      "R2",
      "R2",
      "R3",
      "R3",
      "R4",
      "R4",
      "R5",
      "R5",
    ]);
  });

  it("勝率帯 Q1〜Q5 の境(下限を含む)", () => {
    expect([0.3, 0.299, 0.15, 0.149, 0.07, 0.0699, 0.03, 0.029].map(qBand)).toEqual([
      "Q1",
      "Q2",
      "Q2",
      "Q3",
      "Q3",
      "Q4",
      "Q4",
      "Q5",
    ]);
  });
});

describe("形(form)が買う組合せ", () => {
  // 4 頭、順位 1..4 → 順位帯 [R1, R2, R2, R3]
  const ranks = [1, 2, 3, 4];
  const q = [0.4, 0.3, 0.2, 0.1];
  const sortedCombos = (form: Form): string[] =>
    formCombos(form, { q, ranks })
      .map((c) => c.join("-"))
      .sort();

  it("馬連の帯の対 {R1,R2} は 1 番人気と 2〜3 番人気の 2 組", () => {
    expect(sortedCombos({ kind: "pair", bet: "quinella", family: "R", bands: ["R1", "R2"] })).toEqual([
      "0-1",
      "0-2",
    ]);
  });

  it("馬単 R2→R1 は順序付きで 2 組", () => {
    expect(sortedCombos({ kind: "exacta", family: "R", bands: ["R2", "R1"] })).toEqual(["1-0", "2-0"]);
  });

  it("三連複 {R1,R2,R2} は 1 組", () => {
    expect(sortedCombos({ kind: "trio", family: "R", bands: ["R1", "R2", "R2"] })).toEqual(["0-1-2"]);
  });

  it("三連単 1 着 R1 × {R2,R3} は 4 組", () => {
    expect(sortedCombos({ kind: "trifecta", family: "R", first: "R1", rest: ["R2", "R3"] })).toEqual([
      "0-1-3",
      "0-2-3",
      "0-3-1",
      "0-3-2",
    ]);
  });

  it("勝率帯の族は q で分類する(q=0.4・0.3 が Q1、0.2 が Q2 なので {Q1,Q2} は 2 組)", () => {
    expect(q.map(qBand)).toEqual(["Q1", "Q1", "Q2", "Q3"]);
    expect(sortedCombos({ kind: "pair", bet: "wide", family: "Q", bands: ["Q1", "Q2"] })).toEqual([
      "0-2",
      "1-2",
    ]);
  });

  it("ボックス・1 着固定・軸流し・全組合せ", () => {
    expect(sortedCombos({ kind: "box", bet: "quinella", k: 3 }).length).toBe(3);
    expect(sortedCombos({ kind: "box", bet: "trifecta", k: 3 }).length).toBe(6);
    expect(sortedCombos({ kind: "fav-first", bet: "exacta" })).toEqual(["0-1", "0-2", "0-3"]);
    expect(sortedCombos({ kind: "fav-first", bet: "trifecta" }).length).toBe(6);
    expect(sortedCombos({ kind: "fav-axis", bet: "quinella" })).toEqual(["0-1", "0-2", "0-3"]);
    expect(sortedCombos({ kind: "fav-axis", bet: "trio" }).length).toBe(3);
    expect(sortedCombos({ kind: "all", bet: "wide" }).length).toBe(6);
    expect(sortedCombos({ kind: "all", bet: "trifecta" }).length).toBe(24);
  });

  it("ボックスの k が頭数を超えるレースでは買わない(組合せ 0)", () => {
    expect(formCombos({ kind: "box", bet: "trio", k: 5 }, { q, ranks })).toEqual([]);
  });
});

describe("控除率", () => {
  it("券種ごとの JRA の控除率", () => {
    expect(takeoutOf("quinella")).toBe(0.225);
    expect(takeoutOf("wide")).toBe(0.225);
    expect(takeoutOf("exacta")).toBe(0.25);
    expect(takeoutOf("trio")).toBe(0.25);
    expect(takeoutOf("trifecta")).toBe(0.275);
  });
});

/** テスト用の最小のレース。q は与えた配列、的中は bet ごとに与える。 */
function race(id: string, q: number[], hits: AnalysisRace["hits"]): AnalysisRace {
  return {
    raceId: id,
    date: "2025-01-05",
    q,
    ranks: popularityRanks(q),
    umaban: q.map((_, i) => i + 1),
    hits,
    meta: {
      fieldSize: q.length,
      raceClass: "未勝利",
      weightType: "馬齢",
      courseType: "芝",
      distance: 1600,
      going: "良",
      month: 1,
      venue: "中山",
      filliesOnly: false,
      graded: false,
      ageCond: "3歳",
      topQ: Math.max(...q),
      entropy: normalizedEntropy(q),
    },
  };
}

describe("形の集計(回収率・的中数・公平配当)", () => {
  const q = [0.4, 0.3, 0.2, 0.1];
  const r1 = race("a", q, { quinella: [{ combo: [0, 1], payout: 540 }] });
  const r2 = race("b", q, { quinella: [{ combo: [2, 3], payout: 5000 }] });
  const r3 = race("c", q, { quinella: [{ combo: [0, 3], payout: 900 }] });
  const form: Form = { kind: "pair", bet: "quinella", family: "R", bands: ["R1", "R2"] };

  it("{R1,R2} の馬連を 3 レース買うと 6 点・540 円の払戻", () => {
    const res = evaluateForm([r1, r2, r3], form);
    expect(res.races).toBe(3);
    expect(res.tickets).toBe(6);
    expect(res.returnYen).toBe(540);
    expect(res.roi).toBeCloseTo(540 / 600, 12);
    expect(res.hits).toBe(1);
    // 見込み E = 3 レース × (p{0,1} + p{0,2})
    const p01 = quinellaProb(q, [0, 1]);
    const p02 = quinellaProb(q, [0, 2]);
    expect(res.expectedHits).toBeCloseTo(3 * (p01 + p02), 12);
    // 的中した組合せの公平配当(控除 22.5%)の合計
    expect(res.fairYen).toBeCloseTo((100 * 0.775) / p01, 9);
    expect(res.perRace.map((x) => x.ret)).toEqual([540, 0, 0]);
    expect(res.perRace.map((x) => x.cost)).toEqual([200, 200, 200]);
  });

  it("形に属する組合せが無いレースは対象外(races に数えない)", () => {
    const q5 = [0.5, 0.2, 0.15, 0.1, 0.05];
    const rr = race("d", q5, { trio: [{ combo: [0, 1, 2], payout: 300 }] });
    // 5 頭では R4(7〜10 番人気)が無い
    const res = evaluateForm([rr], { kind: "trio", family: "R", bands: ["R1", "R2", "R4"] });
    expect(res.races).toBe(0);
    expect(res.tickets).toBe(0);
    expect(res.roi).toBeNaN();
  });

  it("同着の 2 本はどちらも的中として数える", () => {
    const rr = race("e", q, {
      quinella: [
        { combo: [0, 1], payout: 300 },
        { combo: [0, 2], payout: 700 },
      ],
    });
    const res = evaluateForm([rr], form);
    expect(res.hits).toBe(2);
    expect(res.returnYen).toBe(1000);
  });

  it("上位 k 件を除いた回収率(感度)", () => {
    const res = evaluateForm([r1, r2, r3], { kind: "all", bet: "quinella" });
    expect(res.tickets).toBe(18);
    expect(res.returnYen).toBe(6440);
    expect(res.hitPayouts.slice().sort((a, b) => b - a)).toEqual([5000, 900, 540]);
    expect(roiWithoutTop(res, 0)).toBeCloseTo(6440 / 1800, 12);
    expect(roiWithoutTop(res, 1)).toBeCloseTo(1440 / 1800, 12);
    expect(roiWithoutTop(res, 3)).toBeCloseTo(0, 12);
  });
});

describe("万馬券の見込み", () => {
  it("公平配当が閾値以上(p ≤ (1−t)/閾値×100)の組合せの p の和", () => {
    // q=[0.9, 0.05, 0.03, 0.02] の馬連で、閾値 1,000 円。公平配当 = 77.5/p ≥ 1000 ⇔ p ≤ 0.0775
    const q = [0.9, 0.05, 0.03, 0.02];
    const combos = allCombos("quinella", 4);
    const ps = combos.map((c) => quinellaProb(q, c));
    const expected = ps.filter((p) => p <= 0.0775).reduce((a, b) => a + b, 0);
    expect(ps.filter((p) => p <= 0.0775).length).toBeGreaterThan(0);
    expect(ps.filter((p) => p > 0.0775).length).toBeGreaterThan(0);
    expect(bigHitExpectation(q, "quinella", 1000)).toBeCloseTo(expected, 12);
  });
});

describe("多重比較の補正", () => {
  it("Benjamini–Hochberg の q 値", () => {
    const qv = benjaminiHochberg([0.01, 0.04, 0.03, 0.2]);
    expect(qv[0]).toBeCloseTo(0.04, 12);
    expect(qv[1]).toBeCloseTo(0.04 * 4 / 3, 12);
    expect(qv[2]).toBeCloseTo(0.04 * 4 / 3, 12);
    expect(qv[3]).toBeCloseTo(0.2, 12);
  });

  it("Holm の調整 p 値", () => {
    const adj = holm([0.01, 0.04, 0.03, 0.2]);
    expect(adj[0]).toBeCloseTo(0.04, 12);
    expect(adj[1]).toBeCloseTo(0.09, 12);
    expect(adj[2]).toBeCloseTo(0.09, 12);
    expect(adj[3]).toBeCloseTo(0.2, 12);
  });

  it("空の入力は空を返す", () => {
    expect(benjaminiHochberg([])).toEqual([]);
    expect(holm([])).toEqual([]);
  });
});

describe("レースの条件", () => {
  it("頭数帯・距離帯・季節・1 番人気の q の帯を付ける", () => {
    const q = [0.45, 0.3, 0.15, 0.1];
    const r = race("f", q, {});
    r.meta.fieldSize = 16;
    r.meta.distance = 1800;
    r.meta.month = 12;
    const c = raceConditions(r, { entropyCuts: [0.5, 0.7] });
    expect(c.fieldSize).toBe("16");
    expect(c.distance).toBe("1401-1800");
    expect(c.season).toBe("12-2");
    expect(c.topQ).toBe(">=0.40");
    expect(c.raceClass).toBe("未勝利");
    expect(c.weightType).toBe("馬齢");
    expect(c.courseType).toBe("芝");
    expect(c.going).toBe("良");
    expect(c.venue).toBe("中山");
    expect(c.ageCond).toBe("3歳");
    expect(c.filliesOnly).toBe("no");
    expect(c.graded).toBe("no");
  });

  it("エントロピーの区分は与えた境で 3 つに分ける", () => {
    const low = race("g", [0.9, 0.05, 0.03, 0.02], {});
    const high = race("h", [0.25, 0.25, 0.25, 0.25], {});
    expect(normalizedEntropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(1, 12);
    expect(normalizedEntropy([0.9, 0.05, 0.03, 0.02])).toBeLessThan(0.5);
    expect(raceConditions(low, { entropyCuts: [0.5, 0.7] }).entropy).toBe("low");
    expect(raceConditions(high, { entropyCuts: [0.5, 0.7] }).entropy).toBe("high");
  });

  it("頭数帯の境(≤8 / 9-12 / 13-15 / 16 / 17-18)", () => {
    const bands = [8, 9, 12, 13, 15, 16, 17, 18].map((n) => {
      const r = race("i", [0.4, 0.3, 0.2, 0.1], {});
      r.meta.fieldSize = n;
      return raceConditions(r, { entropyCuts: [0.5, 0.7] }).fieldSize;
    });
    expect(bands).toEqual(["<=8", "9-12", "9-12", "13-15", "13-15", "16", "17-18", "17-18"]);
  });
});

describe("hist の 1 行から分析用のレースを作る", () => {
  const raw = {
    raceId: "202506010101",
    date: "2025-01-05",
    raceClass: "1勝クラス",
    weightType: "定量",
    courseType: "ダ",
    distance: 1200,
    going: "稍",
    venueName: "中山",
    filliesOnly: false,
    grade: null,
    raceData02Spans: ["1回", "中山", "1日目", "サラ系３歳以上", "1勝クラス", "定量", "6頭"],
    horses: [
      { umaban: 1, finish: 1, finishStatus: null, winOdds: 2.0 },
      { umaban: 2, finish: 2, finishStatus: null, winOdds: 4.0 },
      { umaban: 3, finish: 3, finishStatus: null, winOdds: 8.0 },
      { umaban: 4, finish: 4, finishStatus: null, winOdds: 8.0 },
      { umaban: 5, finish: null, finishStatus: "中止", winOdds: 16.0 },
      { umaban: 6, finish: null, finishStatus: "取消", winOdds: null },
    ],
    payouts: {
      win: [{ umaban: 1, payout: 200 }],
      quinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 500 }] },
      exacta: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 700 }] },
      wide: {
        state: "parsed",
        payouts: [
          { umabans: [1, 2], payout: 200 },
          { umabans: [1, 3], payout: 300 },
          { umabans: [2, 3], payout: 400 },
        ],
      },
      trio: { state: "parsed", payouts: [{ umabans: [1, 2, 3], payout: 1000 }] },
      trifecta: { state: "parsed", payouts: [{ umabans: [1, 2, 3], payout: 2000 }] },
      bracketQuinella: { state: "parsed", payouts: [] },
    },
  };

  it("取消は外し、中止は走った馬として残す。的中は添字に直す", () => {
    const r = toAnalysisRace(raw);
    expect(r).not.toBeNull();
    const a = r as AnalysisRace;
    expect(a.umaban).toEqual([1, 2, 3, 4, 5]);
    expect(a.q.length).toBe(5);
    expect(a.q[0]).toBeCloseTo(0.5 / (0.5 + 0.25 + 0.125 + 0.125 + 0.0625), 12);
    expect(a.ranks).toEqual([1, 2, 3, 4, 5]);
    expect(a.hits.quinella).toEqual([{ combo: [0, 1], payout: 500 }]);
    expect(a.hits.exacta).toEqual([{ combo: [0, 1], payout: 700 }]);
    expect(a.hits.wide?.length).toBe(3);
    expect(a.hits.trio).toEqual([{ combo: [0, 1, 2], payout: 1000 }]);
    expect(a.hits.trifecta).toEqual([{ combo: [0, 1, 2], payout: 2000 }]);
    expect(a.meta.fieldSize).toBe(5);
    expect(a.meta.ageCond).toBe("3歳以上");
    expect(a.meta.venue).toBe("中山");
    expect(a.meta.going).toBe("稍");
  });

  it("馬単の的中は順序を保ち、馬連は添字の昇順にそろえる", () => {
    const swapped = {
      ...raw,
      payouts: {
        ...raw.payouts,
        quinella: { state: "parsed", payouts: [{ umabans: [2, 1], payout: 500 }] },
        exacta: { state: "parsed", payouts: [{ umabans: [2, 1], payout: 700 }] },
      },
    };
    const a = toAnalysisRace(swapped) as AnalysisRace;
    expect(a.hits.quinella).toEqual([{ combo: [0, 1], payout: 500 }]);
    expect(a.hits.exacta).toEqual([{ combo: [1, 0], payout: 700 }]);
  });

  it("走った馬が 5 頭未満、または走った馬にオッズが無いレースは null", () => {
    const few = { ...raw, horses: raw.horses.slice(0, 4) };
    expect(toAnalysisRace(few)).toBeNull();
    const missing = {
      ...raw,
      horses: raw.horses.map((h, i) => (i === 0 ? { ...h, winOdds: null } : h)),
    };
    expect(toAnalysisRace(missing)).toBeNull();
  });

  it("state が parsed でない券種は的中なし(undefined)として扱う", () => {
    const np = { ...raw, payouts: { ...raw.payouts, trio: { state: "not-sold", payouts: [] } } };
    const a = toAnalysisRace(np) as AnalysisRace;
    expect(a.hits.trio).toBeUndefined();
  });
});

describe("条件の識別子", () => {
  it("値に「=」を含む条件(<=8 など)でも、最初の「=」だけで鍵と値に分ける", () => {
    expect(splitConditionId("fieldSize=<=8")).toEqual({ key: "fieldSize", value: "<=8" });
    expect(splitConditionId("distance=>=2201")).toEqual({ key: "distance", value: ">=2201" });
    expect(splitConditionId("venue=中山")).toEqual({ key: "venue", value: "中山" });
    expect(conditionId("fieldSize", "<=8")).toBe("fieldSize=<=8");
  });
});
