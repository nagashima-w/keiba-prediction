import { describe, expect, it } from "vitest";
import { judgeBets, type DayBet, type RaceResultData } from "../src/daily-report-bets";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import type { RaceComboPayoutsReadResult, RaceResultEntry, StoredAnalysis, VerifyDataSource } from "../../packages/core/src/ev/analysis-store-types.js";

/**
 * Issue #235: 日報の買い目の的中判定(`judgeBets`)。判定の中身は core の `computeProposedBetReport`(private)と同じで、
 * 複製が食い違わないことを、同じ入力を core の `computeVerifyReport` の `proposedBet` に通して突き合わせるテストで固定する(最後の describe)。
 */

const horses = (rows: ReadonlyArray<[number, number | null, number | null, number | null]>): RaceResultData["horses"] =>
  rows.map(([umaban, finishPosition, winPayout, placePayout]) => ({ umaban, finishPosition, winPayout, placePayout }));

const RESULT: RaceResultData = {
  horses: horses([
    [1, 1, 450, 150],
    [2, 2, null, 210],
    [3, 3, null, 320],
    [4, 4, null, null],
  ]),
  combos: {
    wide: { imported: true, payouts: [{ comboKey: "0102", payout: 800 }, { comboKey: "0103", payout: 1500 }] },
    exacta: { imported: true, payouts: [{ comboKey: "0102", payout: 3200 }] },
    trio: { imported: false, payouts: [] },
    quinella: { imported: true, payouts: [] },
  },
};

const bet = (betType: string, comboKey: string, stake: number, odds: number | null = null): DayBet => ({ betType, comboKey, stake, odds });

describe("judgeBets: 単勝・複勝(1 頭 = 1 買い目)", () => {
  it.each([
    ["単勝の的中(払戻 450 円/100 円 × 賭け金 300 円 = 1,350 円)", bet("win", "01", 300), { status: "hit", payout: 1350 }],
    ["単勝のはずれ(馬番 2 は単勝の払戻が無い)", bet("win", "02", 200), { status: "miss", payout: 0 }],
    ["複勝の的中(払戻 210 円/100 円 × 賭け金 500 円 = 1,050 円)", bet("place", "02", 500), { status: "hit", payout: 1050 }],
    ["複勝のはずれ(4 着)", bet("place", "04", 100), { status: "miss", payout: 0 }],
  ] as const)("%s", (_name, b, expected) => {
    const [outcome] = judgeBets([b], RESULT);
    expect(outcome).toMatchObject(expected);
  });

  it("単勝の払戻が 1 頭にも無いレース(取込状態ゲート)は、単勝の買い目を判定不能にする。複勝の払戻はあるので複勝は判定できる", () => {
    const noWin: RaceResultData = { ...RESULT, horses: horses([[1, 1, null, 150], [2, 2, null, 210]]) };
    const outcomes = judgeBets([bet("win", "01", 100), bet("place", "01", 100)], noWin);
    expect(outcomes.map((o) => o.status)).toEqual(["unjudged", "hit"]);
  });

  it("複勝の払戻が 1 頭にも無いレースは、複勝の買い目を判定不能にする", () => {
    const noPlace: RaceResultData = { ...RESULT, horses: horses([[1, 1, 450, null], [2, 2, null, null]]) };
    expect(judgeBets([bet("place", "01", 100)], noPlace)[0]!.status).toBe("unjudged");
  });
});

describe("judgeBets: 組合せ券種(キーの完全一致)", () => {
  it("ワイドの的中は払戻 × 賭け金/100。的中しない買い目は miss", () => {
    const outcomes = judgeBets([bet("wide", "0103", 200), bet("wide", "0203", 100)], RESULT);
    expect(outcomes[0]).toMatchObject({ status: "hit", payout: 3000 });
    expect(outcomes[1]).toMatchObject({ status: "miss", payout: 0 });
  });

  it("馬単は順序つきのキーの完全一致(逆順は別の買い目で、的中にしない)", () => {
    const outcomes = judgeBets([bet("exacta", "0102", 100), bet("exacta", "0201", 100)], RESULT);
    expect(outcomes.map((o) => o.status)).toEqual(["hit", "miss"]);
  });

  it("取込印が無い券種(3 連複)・払戻が 0 件の券種(馬連)は判定不能", () => {
    const outcomes = judgeBets([bet("trio", "010203", 100), bet("quinella", "0102", 100)], RESULT);
    expect(outcomes.map((o) => o.status)).toEqual(["unjudged", "unjudged"]);
  });

  it("結果の券種の行が無い(combos に載っていない券種)は判定不能", () => {
    expect(judgeBets([bet("trifecta", "010203", 100)], RESULT)[0]!.status).toBe("unjudged");
  });

  it("結果そのものが無い(undefined)なら全部判定不能。賭け金と元の値は保たれる", () => {
    const outcomes = judgeBets([bet("win", "01", 300, 4.5)], undefined);
    expect(outcomes).toStrictEqual([{ betType: "win", comboKey: "01", stake: 300, odds: 4.5, status: "unjudged", payout: 0 }]);
  });

  it("未知の券種は判定不能(静かに捨てない: 賭け金は返す)", () => {
    const [outcome] = judgeBets([bet("mystery", "01", 700)], RESULT);
    expect(outcome).toMatchObject({ betType: "mystery", stake: 700, status: "unjudged", payout: 0 });
  });
});

describe("judgeBets: core の computeVerifyReport(proposedBet)との一致", () => {
  const raceId = "202606030811";
  const mixedBets: DayBet[] = [
    bet("win", "01", 300),
    bet("win", "02", 200),
    bet("place", "02", 500),
    bet("place", "04", 100),
    bet("wide", "0103", 200),
    bet("wide", "0203", 100),
    bet("exacta", "0102", 100),
    bet("exacta", "0201", 100),
    bet("trio", "010203", 100), // 未取込 → 判定不能
    bet("quinella", "0102", 100), // 払戻 0 件 → 判定不能
  ];

  function coreSource(): VerifyDataSource {
    const results: RaceResultEntry[] = RESULT.horses.map((h) => ({ umaban: h.umaban, finishPosition: h.finishPosition, placePayout: h.placePayout, winPayout: h.winPayout }));
    const analysis: StoredAnalysis = {
      id: 1, raceId, analyzedAt: "2026-06-07T05:00:00.000Z", evEstimated: false, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260607",
      model: null, rawResponse: null, raceSnapshot: null, historyCutoffDate: "20260607", promptLookaheadGuarded: true,
      horses: RESULT.horses.map((h) => ({ umaban: h.umaban, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 2, ev: 1.2, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] })),
    } as unknown as StoredAnalysis;
    return {
      listAnalyses: () => [analysis],
      getResult: (id: string) => (id === raceId ? results : undefined),
      getComboPayouts: (id: string, betType: string): RaceComboPayoutsReadResult => {
        const c = id === raceId ? (RESULT.combos as Record<string, { imported: boolean; payouts: { comboKey: string; payout: number }[] }>)[betType] : undefined;
        return c === undefined || !c.imported ? { state: "not_imported" } : { state: "imported", payouts: c.payouts };
      },
      getAllocationForVerify: () => ({ route: "mixed", skipReasonCode: null, bets: mixedBets.map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake })) }),
    } as unknown as VerifyDataSource;
  }

  it("前提(空振り防止): 判定できた買い目も判定不能の買い目も、的中も外れも含む入力である", () => {
    const outcomes = judgeBets(mixedBets, RESULT);
    expect(outcomes.filter((o) => o.status === "hit").length).toBeGreaterThanOrEqual(4);
    expect(outcomes.filter((o) => o.status === "miss").length).toBeGreaterThanOrEqual(3);
    expect(outcomes.filter((o) => o.status === "unjudged").length).toBe(2);
  });

  it("判定できた買い目の賭け金・払戻の合計が、core の proposedBet.overall の totalStake・totalReturn と一致し、判定不能の数も unjudgedCount と一致する", () => {
    const report = computeVerifyReport(coreSource(), { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false });
    const overall = report.proposedBet.overall;
    const outcomes = judgeBets(mixedBets, RESULT);
    const judged = outcomes.filter((o) => o.status !== "unjudged");
    expect(overall.totalStake).toBeGreaterThan(0);
    expect(overall.totalReturn).toBeGreaterThan(0);
    expect(judged.reduce((s, o) => s + o.stake, 0)).toBe(overall.totalStake);
    expect(judged.reduce((s, o) => s + o.payout, 0)).toBeCloseTo(overall.totalReturn, 6);
    expect(outcomes.filter((o) => o.status === "unjudged").length).toBe(overall.unjudgedCount);
    expect(judged.length).toBe(overall.betCount);
  });
});

/**
 * Issue #246 B4・B10: core との突き合わせを、枠連・三連単と「払戻はあるが取込印なし」にも広げる。
 * 上の describe の入力(`RESULT`・`mixedBets`)は変えず、別の入力で同じ突き合わせをする(既存の固定を弱めない)。
 */
describe("Issue #246: judgeBets と core の computeVerifyReport(proposedBet)の一致: 枠連・三連単・払戻はあるが取込印なし", () => {
  const raceId = "202606030812";
  const RESULT2: RaceResultData = {
    horses: RESULT.horses,
    combos: {
      trifecta: { imported: true, payouts: [{ comboKey: "010203", payout: 15000 }] },
      bracketQuinella: { imported: true, payouts: [{ comboKey: "0102", payout: 1100 }] },
      // 払戻の行はあるが、取込印が無い(imported:false)。キーが一致する買い目があっても的中にせず、判定不能にする
      trio: { imported: false, payouts: [{ comboKey: "010203", payout: 2400 }] },
      wide: { imported: true, payouts: [{ comboKey: "0102", payout: 800 }] },
    },
  };
  const bets2: DayBet[] = [
    bet("trifecta", "010203", 100), // 的中(順序つきのキーが一致)
    bet("trifecta", "020103", 100), // はずれ(着順が違う)
    bet("bracketQuinella", "0102", 200), // 的中
    bet("bracketQuinella", "0203", 100), // はずれ
    bet("trio", "010203", 100), // 払戻はあるが取込印なし → 判定不能
    bet("wide", "0102", 100), // 的中(対照: 取込印があれば同じ形のキーで判定できる)
  ];

  function coreSource2(): VerifyDataSource {
    const results: RaceResultEntry[] = RESULT2.horses.map((h) => ({ umaban: h.umaban, finishPosition: h.finishPosition, placePayout: h.placePayout, winPayout: h.winPayout }));
    const analysis = {
      id: 1, raceId, analyzedAt: "2026-06-07T05:00:00.000Z", evEstimated: false, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260607",
      model: null, rawResponse: null, raceSnapshot: null, historyCutoffDate: "20260607", promptLookaheadGuarded: true,
      horses: RESULT2.horses.map((h) => ({ umaban: h.umaban, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 2, ev: 1.2, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] })),
    } as unknown as StoredAnalysis;
    return {
      listAnalyses: () => [analysis],
      getResult: (id: string) => (id === raceId ? results : undefined),
      getComboPayouts: (id: string, betType: string): RaceComboPayoutsReadResult => {
        const c = id === raceId ? RESULT2.combos[betType] : undefined;
        return c === undefined || !c.imported ? { state: "not_imported" } : { state: "imported", payouts: c.payouts };
      },
      getAllocationForVerify: () => ({ route: "mixed", skipReasonCode: null, bets: bets2.map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake })) }),
    } as unknown as VerifyDataSource;
  }

  it("前提(空振り防止): 枠連・三連単の的中とはずれ、取込印なしの判定不能が、それぞれ含まれる", () => {
    const o = judgeBets(bets2, RESULT2);
    expect(o.map((x) => [x.betType, x.status])).toEqual([
      ["trifecta", "hit"], ["trifecta", "miss"], ["bracketQuinella", "hit"], ["bracketQuinella", "miss"], ["trio", "unjudged"], ["wide", "hit"],
    ]);
    expect(o[0]!.payout).toBe(15000);
    expect(o[2]!.payout).toBe(2200);
  });

  it("賭け金・払戻の合計・判定不能の数・判定できた点数が、core の proposedBet と一致する(全体と、枠連・三連単・3 連複の券種別)", () => {
    const report = computeVerifyReport(coreSource2(), { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false });
    const pb = report.proposedBet;
    const outcomes = judgeBets(bets2, RESULT2);
    const judged = outcomes.filter((o) => o.status !== "unjudged");
    expect(pb.overall.totalStake).toBeGreaterThan(0);
    expect(judged.reduce((s, o) => s + o.stake, 0)).toBe(pb.overall.totalStake);
    expect(judged.reduce((s, o) => s + o.payout, 0)).toBeCloseTo(pb.overall.totalReturn, 6);
    expect(outcomes.filter((o) => o.status === "unjudged").length).toBe(pb.overall.unjudgedCount);
    expect(judged.length).toBe(pb.overall.betCount);
    for (const type of ["trifecta", "bracketQuinella", "trio"] as const) {
      const mine = outcomes.filter((o) => o.betType === type);
      const j = mine.filter((o) => o.status !== "unjudged");
      expect(mine.length, `${type} の買い目が入力にある`).toBeGreaterThan(0);
      expect(j.length, `${type} の判定できた点数`).toBe(pb[type].betCount);
      expect(j.reduce((s, o) => s + o.payout, 0), `${type} の払戻`).toBeCloseTo(pb[type].totalReturn, 6);
      expect(mine.length - j.length, `${type} の判定不能`).toBe(pb[type].unjudgedCount);
    }
    // 前提: 券種別の比較が空振りでない(三連単・枠連に払戻があり、3 連複は判定不能が出ている)
    expect(pb.trifecta.totalReturn).toBeGreaterThan(0);
    expect(pb.bracketQuinella.totalReturn).toBeGreaterThan(0);
    expect(pb.trio.unjudgedCount).toBe(1);
  });
});
