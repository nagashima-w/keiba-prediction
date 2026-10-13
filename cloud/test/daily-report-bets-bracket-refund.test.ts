import { describe, expect, it } from "vitest";
import { judgeBets, type DayBet, type RaceResultData } from "../src/daily-report-bets";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import type { RaceComboPayoutsReadResult, RaceResultEntry, StoredAnalysis, VerifyDataSource } from "../../packages/core/src/ev/analysis-store-types.js";

/**
 * Issue #269: 日報の買い目の判定で、枠連の買い目の返還(取消・除外で枠の出走馬が尽きる等)を扱う。
 * 規則は検証画面(core の `computeProposedBetReport`)と同じ関数 `isBracketQuinellaRefund`(規則の表は core の bracket-quinella-refund.test.ts)を共有する。
 * ここは `judgeBets` への配線と、**買い目 1 件ずつ**を core の `computeVerifyReport` に通した突き合わせ(合計の一致では隠れる、誤判定どうしの相殺を検出する)。
 * D1 の行から2つの経路が同じ数になることは bracket-refund-parity.test.ts が固定している。
 */

/** 16頭立て(各枠2頭。枠 = ceil(馬番/2))。5番(枠3)、13番・14番(枠7)が取消・除外。 */
function sixteen(overrides: (umaban: number) => Partial<RaceResultData["horses"][number]> = () => ({})): RaceResultData["horses"] {
  const scratched = new Set([5, 13, 14]);
  return Array.from({ length: 16 }, (_, i) => {
    const umaban = i + 1;
    return {
      umaban,
      finishPosition: scratched.has(umaban) ? null : umaban,
      winPayout: null,
      placePayout: null,
      scratched: scratched.has(umaban),
      wakuban: Math.ceil(umaban / 2),
      ...overrides(umaban),
    };
  });
}

const combos: RaceResultData["combos"] = { bracketQuinella: { imported: true, payouts: [{ comboKey: "0102", payout: 600 }] } };
const RESULT: RaceResultData = { horses: sixteen(), combos };

const bet = (comboKey: string, stake = 300): DayBet => ({ betType: "bracketQuinella", comboKey, stake, odds: null });

type Expected = "hit" | "miss" | "refund" | "unjudged";

/** [名前, 結果, 買い目, 期待する状態] */
const CASES: ReadonlyArray<readonly [string, RaceResultData, DayBet, Expected]> = [
  ["枠3(5番だけ取消、6番が残る)のゾロ目は返還", RESULT, bet("0303"), "refund"],
  ["枠3を含む別の組は、6番が残るので返還しない(はずれ)", RESULT, bet("0304"), "miss"],
  ["枠7(13・14番が2頭とも取消 = 出走馬が尽きた)を含む組は返還", RESULT, bet("0507"), "refund"],
  ["枠7のゾロ目も返還", RESULT, bet("0707"), "refund"],
  ["枠7を含む組は、順序が逆のキーでも返還", RESULT, bet("0705"), "refund"],
  ["馬番5を枠5と取り違えない: 枠5-6(馬番9〜12)は返還しない", RESULT, bet("0506"), "miss"],
  ["取消の枠と無関係な組(枠6-8)は返還しない", RESULT, bet("0608"), "miss"],
  ["対照: 的中(枠1-2)は的中のまま", RESULT, bet("0102"), "hit"],
  ["枠番が未記録の行(旧い行)が1頭でもあるレースは判定しない(返還にならず、はずれ)", { horses: sixteen((u) => (u === 1 ? { wakuban: undefined } : {})), combos }, bet("0507"), "miss"],
  ["scratched が未記録の行が1頭でもあるレースは判定しない", { horses: sixteen((u) => (u === 1 ? { scratched: undefined } : {})), combos }, bet("0507"), "miss"],
  ["枠番が範囲外(9)の行があるレースは判定しない", { horses: sixteen((u) => (u === 1 ? { wakuban: 9 } : {})), combos }, bet("0507"), "miss"],
  ["取消馬を含む枠連で、払戻が未取込(取込印なし)でも、返還は判定不能にしない", { horses: sixteen(), combos: {} }, bet("0507"), "refund"],
  ["対照: 取込印が無ければ、取消と無関係な枠連は従来どおり判定不能", { horses: sixteen(), combos: {} }, bet("0608"), "unjudged"],
  ["壊れたキー(要素が1つ)は返還にせず、従来の判定へ進む(はずれ)", RESULT, bet("07"), "miss"],
];

describe("judgeBets: 枠連の返還(Issue #269)", () => {
  it.each(CASES)("%s", (_name, result, b, expected) => {
    const [outcome] = judgeBets([b], result);
    expect(outcome!.status).toBe(expected);
    if (expected === "refund") {
      expect(outcome!.payout).toBe(b.stake); // 払戻 = 賭け金(賭け金込み)
    }
  });

  it("前提(空振り防止): 返還・的中・はずれ・判定不能の 4 状態がすべて表に含まれ、返還の例は 4 つ以上ある", () => {
    expect([...new Set(CASES.map(([, , , e]) => e))].sort()).toEqual(["hit", "miss", "refund", "unjudged"]);
    expect(CASES.filter(([, , , e]) => e === "refund").length).toBeGreaterThanOrEqual(4);
  });

  it("前提: 表の結果は、5番・13番・14番だけが取消で、枠3は6番が残り、枠7は尽きている", () => {
    expect(RESULT.horses.filter((h) => h.scratched === true).map((h) => h.umaban)).toEqual([5, 13, 14]);
    expect(RESULT.horses.filter((h) => h.wakuban === 3 && h.scratched !== true).map((h) => h.umaban)).toEqual([6]);
    expect(RESULT.horses.filter((h) => h.wakuban === 7 && h.scratched !== true)).toEqual([]);
  });

  it("取消・除外の馬が1頭もいないレースの枠連は、返還にならない", () => {
    const none: RaceResultData = { horses: sixteen(() => ({ finishPosition: 1, scratched: false })), combos };
    expect(judgeBets([bet("0303"), bet("0707")], none).map((o) => o.status)).toEqual(["miss", "miss"]);
  });

  it("結果そのものが無い(undefined)なら判定不能のまま", () => {
    expect(judgeBets([bet("0507")], undefined)[0]!.status).toBe("unjudged");
  });
});

describe("judgeBets: 枠連の返還を core の computeVerifyReport(proposedBet)と買い目 1 件ずつ突き合わせる(Issue #269)", () => {
  const raceId = "202606030813";

  function coreFor(result: RaceResultData, b: DayBet): VerifyDataSource {
    const results: RaceResultEntry[] = result.horses.map((h) => ({
      umaban: h.umaban,
      finishPosition: h.finishPosition,
      placePayout: h.placePayout,
      winPayout: h.winPayout,
      ...(h.scratched === undefined ? {} : { scratched: h.scratched }),
      ...(h.wakuban === undefined ? {} : { wakuban: h.wakuban }),
    }));
    const analysis = {
      id: 1, raceId, analyzedAt: "2026-06-07T05:00:00.000Z", evEstimated: false, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260607",
      model: null, rawResponse: null, raceSnapshot: null, historyCutoffDate: "20260607", promptLookaheadGuarded: true,
      horses: result.horses.map((h) => ({ umaban: h.umaban, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 2, ev: 1.2, isPositive: true, contributions: null, mark: null, reason: null, highlights: [], concerns: [] })),
    } as unknown as StoredAnalysis;
    return {
      listAnalyses: () => [analysis],
      getResult: (id: string) => (id === raceId ? results : undefined),
      getComboPayouts: (id: string, betType: string): RaceComboPayoutsReadResult => {
        const c = id === raceId ? (result.combos as Record<string, { imported: boolean; payouts: { comboKey: string; payout: number }[] }>)[betType] : undefined;
        return c === undefined || !c.imported ? { state: "not_imported" } : { state: "imported", payouts: c.payouts };
      },
      getAllocationForVerify: () => ({ route: "mixed", skipReasonCode: null, bets: [{ betType: b.betType, comboKey: b.comboKey, stake: b.stake }] }),
    } as unknown as VerifyDataSource;
  }

  it.each(CASES)("%s", (_name, result, b) => {
    const [o] = judgeBets([b], result);
    const overall = computeVerifyReport(coreFor(result, b), { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false }).proposedBet.overall;
    const judged = o!.status !== "unjudged";
    expect(overall.betCount).toBe(judged ? 1 : 0);
    expect(overall.unjudgedCount).toBe(judged ? 0 : 1);
    expect(overall.totalStake).toBe(judged ? b.stake : 0);
    expect(overall.totalReturn).toBeCloseTo(o!.payout, 6);
    expect(overall.refundedCount).toBe(o!.status === "refund" ? 1 : 0);
    expect(overall.refundedStake).toBe(o!.status === "refund" ? b.stake : 0);
  });

  it("前提(空振り防止): core 側でも枠連の返還が実際に数えられる入力である(refundedCount が 0 のままではない)", () => {
    const b = bet("0507");
    const overall = computeVerifyReport(coreFor(RESULT, b), { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false }).proposedBet.overall;
    expect(overall.refundedCount).toBe(1);
    expect(overall.totalReturn).toBe(300);
  });
});
