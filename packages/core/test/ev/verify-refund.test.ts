import { describe, expect, it } from "vitest";
import { AnalysisStore, type AnalysisAllocationMetaRecord, type AnalysisHorseRecord } from "../../src/ev/analysis-store.js";
import type { RaceResultEntry, VerifyDataSource } from "../../src/ev/analysis-store-types.js";
import { buildAllocationBetComboKey } from "../../src/ev/combo-bet-allocation.js";
import { computeVerifyReport, type ProposedBetTypeSummary } from "../../src/ev/verify.js";

/**
 * Issue #72: 配分ベースの回収率(proposedBet 系)で、取消・除外の馬への買い目を「返還」として扱う。
 *
 * 取消・除外(`RaceResultEntry.scratched === true`)の馬を構成に含む買い目は、馬券が全額返還される。
 * `totalStake` と `totalReturn` の両方に stake を足す(賭け金は分母に残り、払戻にも含める)。
 * 中止・失格・降着は返還されない。`scratched` が未記録(undefined。旧い行)の `finishPosition=null` は
 * 取消か中止か判別できないので、従来どおり不的中として数える。
 *
 * `AnalysisStore`(exe)は `scratched` を保存しないので、結果の読み出しだけを差し替えた入口で検証する
 * (クラウド版は D1 の `race_results.scratched` から同じ形の `RaceResultEntry` を作る)。
 */

function horse(umaban: number): AnalysisHorseRecord {
  return { umaban, prior: 0.5, adjustedProb: 0.5, placeOddsMin: 2, ev: 1, isPositive: true, contributions: null, mark: null };
}

function meta(overrides: Partial<AnalysisAllocationMetaRecord> = {}): AnalysisAllocationMetaRecord {
  return {
    route: "mixed",
    unavailableReason: null,
    fallbackReason: null,
    skipReasonCode: null,
    comboOddsWide: null,
    comboOddsTrio: null,
    bankroll: 100000,
    perRaceCap: 10000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWide: true,
    includeTrio: true,
    includeQuinella: true,
    includeExacta: true,
    includeTrifecta: true,
    includeBracketQuinella: true,
    betUnit: 100,
    greedySteps: 1000,
    candidateCap: 2000,
    modelId: "conditional-bernoulli",
    modelApproximate: false,
    oddsStatus: "result",
    ...overrides,
  };
}

/** 結果の読み出しだけを差し替えた入口(他は AnalysisStore のまま)。 */
function sourceWith(store: AnalysisStore, resultsByRace: Record<string, RaceResultEntry[]>): VerifyDataSource {
  return {
    listAnalyses: (filter) => store.listAnalyses(filter),
    getResult: (raceId) => resultsByRace[raceId],
    getComboPayouts: (raceId, betType) => store.getComboPayouts(raceId, betType),
    getAllocationForVerify: (id) => store.getAllocationForVerify(id),
  };
}

const RACE = "R72";

/** 8頭立て。馬番5が取消・除外(finishPosition=null)、他は1〜7着。複勝は1〜3着の馬に払戻。 */
function results(overrides: Partial<Record<number, Partial<RaceResultEntry>>> = {}): RaceResultEntry[] {
  const base: RaceResultEntry[] = [
    { umaban: 1, finishPosition: 1, placePayout: 140, winPayout: 300 },
    { umaban: 2, finishPosition: 2, placePayout: 310, winPayout: null },
    { umaban: 3, finishPosition: 3, placePayout: 180, winPayout: null },
    { umaban: 4, finishPosition: 4, placePayout: null, winPayout: null },
    { umaban: 5, finishPosition: null, placePayout: null, winPayout: null },
    { umaban: 6, finishPosition: 5, placePayout: null, winPayout: null },
    { umaban: 7, finishPosition: 6, placePayout: null, winPayout: null },
    { umaban: 8, finishPosition: 7, placePayout: null, winPayout: null },
  ];
  return base.map((r) => ({ ...r, ...(overrides[r.umaban] ?? {}) }));
}

type BetType = "place" | "win" | "wide" | "trio" | "quinella" | "exacta" | "trifecta" | "bracketQuinella";

interface Bet {
  readonly betType: BetType;
  readonly umabans: readonly number[];
  readonly stake: number;
}

/** 分析を1件保存し、集計した proposedBet を返す。組合せ払戻は何も取り込まない(取込済み・空)ことはしない。 */
function run(bets: readonly Bet[], res: RaceResultEntry[], opts: { importCombo?: boolean } = {}) {
  const store = new AnalysisStore();
  store.saveAnalysis({
    raceId: RACE,
    analyzedAt: "t",
    horses: [horse(1)],
    allocation: {
      meta: meta(),
      bets: bets.map((b) => ({
        betType: b.betType,
        comboKey: buildAllocationBetComboKey(b.betType, b.umabans),
        stake: b.stake,
        odds: 1,
        ev: 1,
      })),
    },
  });
  // 組合せ券の払戻は「取込済みだが該当なし」にする(払戻表が空だと判定不能になり、返還との優先順位が見えなくなる)。
  const resultsForStore: RaceResultEntry[] = res.map((r) => ({ umaban: r.umaban, finishPosition: r.finishPosition, placePayout: r.placePayout ?? null, winPayout: r.winPayout ?? null }));
  store.saveResult(
    RACE,
    resultsForStore,
    null,
    opts.importCombo === false
      ? undefined
      : {
          wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 500 }] },
          trio: { state: "parsed", payouts: [{ umabans: [1, 2, 3], payout: 2000 }] },
          quinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 800 }] },
          exacta: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 1500 }] },
          trifecta: { state: "parsed", payouts: [{ umabans: [1, 2, 3], payout: 9000 }] },
          // 枠連(Issue #269)。umabans は馬番ではなく枠番。
          bracketQuinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 600 }] },
        },
  );
  const report = computeVerifyReport(sourceWith(store, { [RACE]: res }));
  store.close();
  return report.proposedBet;
}

function summaryOf(p: ReturnType<typeof run>, betType: BetType): ProposedBetTypeSummary {
  return p[betType];
}

describe("取消・除外の馬への買い目は返還として数える(Issue #72)", () => {
  // 取消の馬番5を構成に含む買い目。stake は 500円。
  const cases: ReadonlyArray<readonly [BetType, readonly number[]]> = [
    ["place", [5]],
    ["win", [5]],
    ["wide", [1, 5]],
    ["trio", [1, 2, 5]],
    ["quinella", [2, 5]],
    ["exacta", [5, 1]], // 1着5(取消)
    ["exacta", [1, 5]], // 2着5(取消)。順序付きキーでも構成馬の集合で判定する
    ["trifecta", [1, 5, 2]], // 順序付き・3頭
  ];

  it.each(cases)("%s %j: 賭け金は払戻に含まれ(回収率1.0)、返還の件数と金額に出る", (betType, umabans) => {
    const p = run([{ betType, umabans, stake: 500 }], results({ 5: { scratched: true } }));
    expect(summaryOf(p, betType)).toEqual({
      betCount: 1,
      totalStake: 500,
      totalReturn: 500,
      recoveryRate: 1,
      unjudgedCount: 0,
      refundedCount: 1,
      refundedStake: 500,
      flatStake: 100,
      flatReturn: 100,
      flatRecoveryRate: 1,
    });
  });

  it("表は、全7券種を含む(券種の取りこぼしを許さない)", () => {
    expect(new Set(cases.map(([t]) => t)).size).toBe(7);
  });

  it.each(cases)("%s %j: 同じ買い目でも scratched が未記録(旧い行)なら従来どおり不的中(返還にしない)", (betType, umabans) => {
    const p = run([{ betType, umabans, stake: 500 }], results());
    expect(summaryOf(p, betType)).toEqual({
      betCount: 1,
      totalStake: 500,
      totalReturn: 0,
      recoveryRate: 0,
      unjudgedCount: 0,
      refundedCount: 0,
      refundedStake: 0,
      flatStake: 100,
      flatReturn: 0,
      flatRecoveryRate: 0,
    });
  });

  it.each(cases)("%s %j: scratched=false(中止・失格など、着順は null)なら返還にしない", (betType, umabans) => {
    const p = run([{ betType, umabans, stake: 500 }], results({ 5: { scratched: false } }));
    const s = summaryOf(p, betType);
    expect(s.totalReturn).toBe(0);
    expect(s.refundedCount).toBe(0);
    expect(s.betCount).toBe(1);
  });

  it("取消馬を含まない買い目は返還にならず、的中すれば通常の払戻(按分)になる", () => {
    const p = run(
      [
        { betType: "place", umabans: [1], stake: 300 }, // 複勝140円 → 420円
        { betType: "wide", umabans: [1, 2], stake: 200 }, // 500円 → 1000円
      ],
      results({ 5: { scratched: true } }),
    );
    expect(p.place).toMatchObject({ betCount: 1, totalStake: 300, totalReturn: 420, refundedCount: 0, refundedStake: 0 });
    expect(p.wide).toMatchObject({ betCount: 1, totalStake: 200, totalReturn: 1000, refundedCount: 0, refundedStake: 0 });
  });

  it("返還と的中と不的中が混在する: 回収額 = 返還分(賭け金) + 的中の払戻、賭け金は全部が分母に残る", () => {
    const p = run(
      [
        { betType: "place", umabans: [5], stake: 500 }, // 返還
        { betType: "place", umabans: [1], stake: 300 }, // 的中 420
        { betType: "place", umabans: [4], stake: 200 }, // 不的中
      ],
      results({ 5: { scratched: true } }),
    );
    expect(p.place).toEqual({
      betCount: 3,
      totalStake: 1000,
      totalReturn: 500 + 420,
      recoveryRate: 0.92,
      unjudgedCount: 0,
      refundedCount: 1,
      refundedStake: 500,
      flatStake: 300,
      flatReturn: 240,
      flatRecoveryRate: 0.8,
    });
  });

  it("返還の判定は払戻表の取込状態に依らない: 組合せ払戻が未取込でも、取消馬を含む買い目は返還(判定不能にしない)", () => {
    const p = run(
      [
        { betType: "wide", umabans: [1, 5], stake: 300 },
        { betType: "wide", umabans: [1, 2], stake: 100 }, // 取消を含まない買い目は従来どおり判定不能
      ],
      results({ 5: { scratched: true } }),
      { importCombo: false },
    );
    expect(p.wide).toEqual({
      betCount: 1,
      totalStake: 300,
      totalReturn: 300,
      recoveryRate: 1,
      unjudgedCount: 1,
      refundedCount: 1,
      refundedStake: 300,
      flatStake: 100,
      flatReturn: 100,
      flatRecoveryRate: 1,
    });
  });

  it("複勝・単勝も、その券種の払戻が未取込(placePayout が1件も無い)でも返還になる", () => {
    const res = results({ 5: { scratched: true } }).map((r) => ({ ...r, placePayout: null, winPayout: null }));
    const p = run(
      [
        { betType: "place", umabans: [5], stake: 400 },
        { betType: "win", umabans: [5], stake: 100 },
        { betType: "place", umabans: [1], stake: 100 }, // 取消を含まない: 従来どおり判定不能
      ],
      res,
    );
    expect(p.place).toMatchObject({ betCount: 1, totalStake: 400, totalReturn: 400, unjudgedCount: 1, refundedCount: 1 });
    expect(p.win).toMatchObject({ betCount: 1, totalStake: 100, totalReturn: 100, unjudgedCount: 0, refundedCount: 1 });
  });

  it("overall は8券種の返還の件数・金額を合算する(同じ賭け金の仮定の中の合算)", () => {
    const p = run(
      [
        { betType: "place", umabans: [5], stake: 500 },
        { betType: "wide", umabans: [1, 5], stake: 300 },
        { betType: "trio", umabans: [1, 2, 3], stake: 100 }, // 取消なし。的中 2000円×1 = 2000
      ],
      results({ 5: { scratched: true } }),
    );
    expect(p.overall).toMatchObject({
      betCount: 3,
      totalStake: 900,
      totalReturn: 500 + 300 + 2000,
      refundedCount: 2,
      refundedStake: 800,
      flatStake: 300,
      flatReturn: 2200,
      flatRecoveryRate: 2200 / 300,
    });
    // 券種別の内訳の和が overall に一致する
    const types = [p.place, p.win, p.wide, p.trio, p.quinella, p.exacta, p.trifecta, p.bracketQuinella];
    expect(types.reduce((a, s) => a + s.refundedCount, 0)).toBe(p.overall.refundedCount);
    expect(types.reduce((a, s) => a + s.refundedStake, 0)).toBe(p.overall.refundedStake);
  });

  it("壊れた combo_key(偶数長でない)は返還にせず、従来の判定へ進む(落ちない)", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: RACE,
      analyzedAt: "t",
      horses: [horse(1)],
      allocation: { meta: meta(), bets: [{ betType: "wide", comboKey: "015", stake: 300, odds: 1, ev: 1 }] },
    });
    store.saveResult(RACE, [{ umaban: 1, finishPosition: 1 }], null, { wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 500 }] } });
    const p = computeVerifyReport(sourceWith(store, { [RACE]: results({ 5: { scratched: true } }) })).proposedBet;
    store.close();
    expect(p.wide).toMatchObject({ betCount: 1, totalStake: 300, totalReturn: 0, refundedCount: 0 });
  });
});

/**
 * 枠連(Issue #269。#72 の残り)。comboKey は馬番ではなく枠番の組。返還かどうかは、結果の各馬の枠番(`wakuban`)と
 * 取消・除外の印(`scratched`)から、`bracket-quinella-refund.ts` の純関数が決める(規則は bracket-quinella-refund.test.ts が表で固定している)。
 * ここは `verify.ts` への配線(返還の件数・金額・払戻表の取込状態との順序・旧行の扱い)を固定する。
 */
describe("枠連の返還(Issue #269)", () => {
  /** 8頭立て(各枠1頭。馬番 = 枠番)。馬番5が取消・除外なら枠5の出走馬が尽きる。 */
  function eightByFrame(overrides: Partial<Record<number, Partial<RaceResultEntry>>> = {}): RaceResultEntry[] {
    return results(overrides).map((r) => ({ ...r, wakuban: r.umaban, scratched: false, ...(overrides[r.umaban] ?? {}) }));
  }

  /** 16頭立て(各枠2頭。枠 = ceil(馬番/2))。馬番5・6が枠3。 */
  function sixteen(overrides: Partial<Record<number, Partial<RaceResultEntry>>> = {}): RaceResultEntry[] {
    return Array.from({ length: 16 }, (_, i) => {
      const umaban = i + 1;
      return { umaban, finishPosition: umaban, placePayout: null, winPayout: null, wakuban: Math.ceil(umaban / 2), scratched: false, ...(overrides[umaban] ?? {}) };
    });
  }

  const REFUND_400 = {
    betCount: 1,
    totalStake: 400,
    totalReturn: 400,
    recoveryRate: 1,
    unjudgedCount: 0,
    refundedCount: 1,
    refundedStake: 400,
    flatStake: 100,
    flatReturn: 100,
    flatRecoveryRate: 1,
  };

  it("枠の出走馬が尽きる(8頭立てで馬番5が取消 = 枠5が空)と、枠5を含む組は返還: 賭け金が払戻に含まれ、返還の件数・金額に出る", () => {
    const res = eightByFrame({ 5: { scratched: true } });
    // 前提: 枠5の馬は馬番5の1頭だけで、その1頭が取消・除外
    expect(res.filter((r) => r.wakuban === 5).map((r) => [r.umaban, r.scratched])).toEqual([[5, true]]);
    const p = run([{ betType: "bracketQuinella", umabans: [5, 8], stake: 400 }], res);
    expect(p.bracketQuinella).toEqual(REFUND_400);
  });

  it("返還の判定は払戻表の取込状態に依らない(枠連の払戻が未取込でも返還。取消を含まない買い目は従来どおり判定不能)", () => {
    const p = run(
      [
        { betType: "bracketQuinella", umabans: [5, 8], stake: 400 },
        { betType: "bracketQuinella", umabans: [6, 7], stake: 100 },
      ],
      eightByFrame({ 5: { scratched: true } }),
      { importCombo: false },
    );
    expect(p.bracketQuinella).toEqual({ ...REFUND_400, unjudgedCount: 1 });
  });

  it("枠の出走馬が尽きていない組は返還しない(従来どおり不的中)。尽きた枠を含まない買い目も同じ", () => {
    const p = run([{ betType: "bracketQuinella", umabans: [6, 7], stake: 400 }], eightByFrame({ 5: { scratched: true } }));
    expect(p.bracketQuinella).toMatchObject({ betCount: 1, totalStake: 400, totalReturn: 0, refundedCount: 0, refundedStake: 0 });
  });

  it("取消のない枠の的中は通常の払戻(枠1-2、600円 × 4 = 2400円)、返還と並ぶ", () => {
    const p = run(
      [
        { betType: "bracketQuinella", umabans: [1, 2], stake: 400 }, // 的中
        { betType: "bracketQuinella", umabans: [5, 8], stake: 400 }, // 返還
        { betType: "bracketQuinella", umabans: [6, 7], stake: 200 }, // 不的中
      ],
      eightByFrame({ 5: { scratched: true } }),
    );
    expect(p.bracketQuinella).toMatchObject({ betCount: 3, totalStake: 1000, totalReturn: 2400 + 400, refundedCount: 1, refundedStake: 400 });
  });

  it("1枠2頭で1頭だけ取消(16頭立ての馬番5。枠3は6番が残る): ゾロ目の枠3-3だけ返還。枠3を含む別の組・馬番5を枠番と取り違えた組(枠5-6)は返還しない", () => {
    const res = sixteen({ 5: { scratched: true, finishPosition: null } });
    expect(res.filter((r) => r.wakuban === 3).map((r) => [r.umaban, r.scratched])).toEqual([
      [5, true],
      [6, false],
    ]);
    const p = run(
      [
        { betType: "bracketQuinella", umabans: [3, 3], stake: 400 }, // ゾロ目: 返還
        { betType: "bracketQuinella", umabans: [3, 4], stake: 100 }, // 枠3に6番が残る: 返還なし
        { betType: "bracketQuinella", umabans: [5, 6], stake: 100 }, // 枠5・6(馬番9〜12)。馬番5の取消とは無関係
      ],
      res,
    );
    expect(p.bracketQuinella).toMatchObject({ betCount: 3, totalStake: 600, totalReturn: 400, refundedCount: 1, refundedStake: 400 });
  });

  it("1枠2頭で2頭とも取消: 枠3を含む別の組も返還になる", () => {
    const res = sixteen({ 5: { scratched: true, finishPosition: null }, 6: { scratched: true, finishPosition: null } });
    const p = run([{ betType: "bracketQuinella", umabans: [3, 7], stake: 400 }], res);
    expect(p.bracketQuinella).toEqual(REFUND_400);
  });

  it("中止・失格(finishPosition=null、scratched=false)は返還にしない", () => {
    const res = eightByFrame({ 5: { scratched: false, finishPosition: null } });
    expect(res.find((r) => r.umaban === 5)).toMatchObject({ finishPosition: null, scratched: false });
    const p = run([{ betType: "bracketQuinella", umabans: [5, 8], stake: 400 }], res);
    expect(p.bracketQuinella).toMatchObject({ betCount: 1, totalReturn: 0, refundedCount: 0 });
  });

  describe("判定しない(従来どおり不的中。旧い行の保守的な扱い)", () => {
    const betsOn58 = [{ betType: "bracketQuinella" as const, umabans: [5, 8], stake: 400 }];
    const NOT_REFUNDED = { betCount: 1, totalStake: 400, totalReturn: 0, recoveryRate: 0, unjudgedCount: 0, refundedCount: 0, refundedStake: 0, flatStake: 100, flatReturn: 0, flatRecoveryRate: 0 };

    it("枠番を保存する前の旧い行(wakuban が無い。#72 当時と同じ入力): 取消馬がいても返還にしない", () => {
      const res = results({ 5: { scratched: true } });
      expect(res.every((r) => r.wakuban === undefined)).toBe(true);
      expect(run(betsOn58, res).bracketQuinella).toEqual(NOT_REFUNDED);
    });

    it("1頭でも wakuban が null / 範囲外ならレース全体を判定しない(返還になるはずの構成から1行だけ崩す)", () => {
      expect(run(betsOn58, eightByFrame({ 5: { scratched: true } })).bracketQuinella).toEqual(REFUND_400); // 崩す前は返還
      expect(run(betsOn58, eightByFrame({ 5: { scratched: true }, 1: { wakuban: null } })).bracketQuinella).toEqual(NOT_REFUNDED);
      expect(run(betsOn58, eightByFrame({ 5: { scratched: true }, 1: { wakuban: 9 } })).bracketQuinella).toEqual(NOT_REFUNDED);
    });

    it("1頭でも scratched が未記録ならレース全体を判定しない", () => {
      const res = eightByFrame({ 5: { scratched: true } }).map((r) => (r.umaban === 1 ? { umaban: r.umaban, finishPosition: r.finishPosition, placePayout: r.placePayout, winPayout: r.winPayout, wakuban: r.wakuban } : r));
      expect(res.find((r) => r.umaban === 1)!.scratched).toBeUndefined();
      expect(run(betsOn58, res).bracketQuinella).toEqual(NOT_REFUNDED);
    });
  });

  it("overall の返還は、枠連の返還の件数・金額を含む(8券種の内訳の和 = overall)", () => {
    const p = run(
      [
        { betType: "bracketQuinella", umabans: [5, 8], stake: 400 },
        { betType: "place", umabans: [5], stake: 500 },
      ],
      eightByFrame({ 5: { scratched: true } }),
    );
    expect(p.bracketQuinella.refundedCount).toBe(1);
    expect(p.overall).toMatchObject({ betCount: 2, totalStake: 900, totalReturn: 900, refundedCount: 2, refundedStake: 900 });
    const types = [p.place, p.win, p.wide, p.trio, p.quinella, p.exacta, p.trifecta, p.bracketQuinella];
    expect(types.reduce((a, s) => a + s.refundedCount, 0)).toBe(p.overall.refundedCount);
    expect(types.reduce((a, s) => a + s.refundedStake, 0)).toBe(p.overall.refundedStake);
  });
});
