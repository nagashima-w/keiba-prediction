import { describe, expect, it } from "vitest";
import { judgeBets, type DayBet, type RaceResultData } from "../src/daily-report-bets";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import type { RaceComboPayoutsReadResult, RaceResultEntry, StoredAnalysis, VerifyDataSource } from "../../packages/core/src/ev/analysis-store-types.js";

/**
 * Issue #278: 日報の買い目の判定で、取消・除外の馬を構成に含む買い目を「返還」(賭け金がそのまま払戻になる第3の状態)として扱う。
 * 判定の規則は #72 の検証画面(core の `computeProposedBetReport`)と同じ。**買い目 1 件ずつ**を core の `computeVerifyReport` に通して突き合わせ、
 * 合計の一致では隠れる「誤判定どうしの相殺」を検出する。
 */

/** 馬の行: [馬番, 着順, 単勝払戻, 複勝払戻, scratched]。scratched を省略した行は「未記録」(旧い行。NULL)。 */
const horses = (rows: ReadonlyArray<[number, number | null, number | null, number | null, boolean?]>): RaceResultData["horses"] =>
  rows.map(([umaban, finishPosition, winPayout, placePayout, scratched]) => ({ umaban, finishPosition, winPayout, placePayout, ...(scratched === undefined ? {} : { scratched }) }));

const RESULT: RaceResultData = {
  horses: horses([
    [1, 1, 450, 150, false],
    [2, 2, null, 210, false],
    [3, 3, null, 320, false],
    [4, 4, null, null, false],
    [5, null, null, null, true], // 取消・除外
    [6, null, null, null], // 着順なし・scratched 未記録(旧い行。取消か中止か分からない)
    [7, null, null, null, false], // 着順なし・記録済みで取消でない(中止など)
  ]),
  combos: {
    wide: { imported: true, payouts: [{ comboKey: "0102", payout: 800 }] },
    exacta: { imported: true, payouts: [{ comboKey: "0102", payout: 3200 }] },
    trio: { imported: false, payouts: [] }, // 取込印なし → 取消を含まなければ判定不能
    quinella: { imported: true, payouts: [] }, // 払戻 0 件 → 取消を含まなければ判定不能
    bracketQuinella: { imported: true, payouts: [{ comboKey: "0102", payout: 1100 }] },
    // trifecta は載っていない
  },
};

const bet = (betType: string, comboKey: string, stake: number): DayBet => ({ betType, comboKey, stake, odds: null });

type Expected = "hit" | "miss" | "refund" | "unjudged";

/** [名前, 買い目, 期待する状態] */
const CASES: ReadonlyArray<readonly [string, DayBet, Expected]> = [
  ["単勝: 取消の馬(5番)は返還", bet("win", "05", 300), "refund"],
  ["複勝: 取消の馬(5番)は返還", bet("place", "05", 300), "refund"],
  ["ワイド: 組の片方が取消(1-5)は返還", bet("wide", "0105", 300), "refund"],
  ["馬連: 払戻が 0 件でも、取消を含めば返還(判定不能にしない)", bet("quinella", "0205", 300), "refund"],
  ["3 連複: 取込印が無くても、取消を含めば返還(判定不能にしない)", bet("trio", "010205", 300), "refund"],
  ["三連単: 券種の行が結果に無くても、取消を含めば返還(判定不能にしない)", bet("trifecta", "050102", 300), "refund"],
  ["馬単: 1 着側が取消(5→1)は返還(順序に依らず構成馬の集合で見る)", bet("exacta", "0501", 300), "refund"],
  ["馬単: 2 着側が取消(1→5)は返還", bet("exacta", "0105", 300), "refund"],
  ["枠連: 枠番の組なので、5 を取消の馬番として読まない(3-5 は返還にならずはずれ)", bet("bracketQuinella", "0305", 300), "miss"],
  ["単勝: 着順なしで scratched 未記録(旧い行。6番)は従来どおりはずれ", bet("win", "06", 300), "miss"],
  ["ワイド: 着順なしで scratched 未記録(1-6)は従来どおりはずれ", bet("wide", "0106", 300), "miss"],
  ["単勝: 着順なしで scratched=false(中止など。7番)は返還にならずはずれ", bet("win", "07", 300), "miss"],
  ["対照: 単勝の的中(1番)は的中のまま", bet("win", "01", 300), "hit"],
  ["対照: ワイドの的中(1-2)は的中のまま", bet("wide", "0102", 300), "hit"],
  ["対照: 取消を含まない 3 連複は、取込印が無ければ従来どおり判定不能", bet("trio", "010203", 300), "unjudged"],
  ["対照: 取消を含まない馬連は、払戻 0 件なら従来どおり判定不能", bet("quinella", "0102", 300), "unjudged"],
];

describe("judgeBets: 取消・除外の馬への買い目を返還にする(Issue #278)", () => {
  it.each(CASES)("%s", (_name, b, expected) => {
    const [outcome] = judgeBets([b], RESULT);
    expect(outcome!.status).toBe(expected);
    if (expected === "refund") {
      expect(outcome!.payout).toBe(b.stake); // 払戻 = 賭け金(賭け金込み)
    }
  });

  it("前提(空振り防止): 返還・的中・はずれ・判定不能の 4 状態がすべて表に含まれる", () => {
    const states = new Set(CASES.map(([, , e]) => e));
    expect([...states].sort()).toEqual(["hit", "miss", "refund", "unjudged"]);
    expect(CASES.filter(([, , e]) => e === "refund").length).toBeGreaterThanOrEqual(7);
  });

  it("結果そのものが無い(undefined)なら、取消かどうか分からないので判定不能のまま", () => {
    expect(judgeBets([bet("win", "05", 300)], undefined)[0]!.status).toBe("unjudged");
  });

  it("返還の賭け金・元の値は保たれる", () => {
    const [o] = judgeBets([{ betType: "win", comboKey: "05", stake: 700, odds: 12.3, ev: 1.1 }], RESULT);
    expect(o).toStrictEqual({ betType: "win", comboKey: "05", stake: 700, odds: 12.3, ev: 1.1, status: "refund", payout: 700 });
  });

  it("復元できないキー(奇数桁・範囲外)は返還にせず、従来の判定に進む", () => {
    const [odd] = judgeBets([bet("wide", "010", 100)], RESULT);
    expect(odd!.status).toBe("miss");
    const [outOfRange] = judgeBets([bet("wide", "9905", 100)], RESULT); // 99 は馬番として範囲外 → null
    expect(outOfRange!.status).toBe("miss");
  });
});

describe("judgeBets: core の computeVerifyReport(proposedBet)との買い目 1 件ずつの一致(Issue #278)", () => {
  const raceId = "202606030813";

  function coreFor(b: DayBet): VerifyDataSource {
    const results: RaceResultEntry[] = RESULT.horses.map((h) => ({
      umaban: h.umaban,
      finishPosition: h.finishPosition,
      placePayout: h.placePayout,
      winPayout: h.winPayout,
      ...(h.scratched === undefined ? {} : { scratched: h.scratched }),
    }));
    const analysis = {
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
      getAllocationForVerify: () => ({ route: "mixed", skipReasonCode: null, bets: [{ betType: b.betType, comboKey: b.comboKey, stake: b.stake }] }),
    } as unknown as VerifyDataSource;
  }

  it.each(CASES)("%s", (_name, b) => {
    const [o] = judgeBets([b], RESULT);
    const overall = computeVerifyReport(coreFor(b), { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false }).proposedBet.overall;
    const judged = o!.status !== "unjudged";
    expect(overall.betCount).toBe(judged ? 1 : 0);
    expect(overall.unjudgedCount).toBe(judged ? 0 : 1);
    expect(overall.totalStake).toBe(judged ? b.stake : 0);
    expect(overall.totalReturn).toBeCloseTo(o!.payout, 6);
    expect(overall.refundedCount).toBe(o!.status === "refund" ? 1 : 0);
    expect(overall.refundedStake).toBe(o!.status === "refund" ? b.stake : 0);
  });

  it("前提(空振り防止): core 側でも返還が実際に数えられる入力である(refundedCount が 0 のままではない)", () => {
    const b = bet("win", "05", 300);
    const overall = computeVerifyReport(coreFor(b), { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false }).proposedBet.overall;
    expect(overall.refundedCount).toBe(1);
    expect(overall.totalReturn).toBe(300);
  });
});
