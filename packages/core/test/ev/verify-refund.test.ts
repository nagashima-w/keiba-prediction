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

type BetType = "place" | "win" | "wide" | "trio" | "quinella" | "exacta" | "trifecta";

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

describe("枠連は返還を判定しない(Issue #72。別 Issue で扱う)", () => {
  it("枠連の買い目は、構成の枠に取消馬がいても従来どおり(不的中)で、返還の件数に入らない", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: RACE,
      analyzedAt: "t",
      horses: [horse(1)],
      allocation: {
        meta: meta(),
        bets: [
          // 枠番 5-8 の組。8頭立てなので馬番5が取消なら枠5の全馬が取消(JRA の規定では返還になるが、今回は判定しない)。
          { betType: "bracketQuinella", comboKey: buildAllocationBetComboKey("bracketQuinella", [5, 8]), stake: 400, odds: 1, ev: 1 },
        ],
      },
    });
    store.saveResult(RACE, [{ umaban: 1, finishPosition: 1 }], null, { bracketQuinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 600 }] } });
    const p = computeVerifyReport(sourceWith(store, { [RACE]: results({ 5: { scratched: true } }) })).proposedBet;
    store.close();
    expect(p.bracketQuinella).toEqual({
      betCount: 1,
      totalStake: 400,
      totalReturn: 0,
      recoveryRate: 0,
      unjudgedCount: 0,
      refundedCount: 0,
      refundedStake: 0,
    });
  });

  it("枠連の comboKey は馬番ではなく枠番: 枠番5を含む買い目を、馬番5の取消と取り違えて返還にしない(馬番側の判定の対象外であることの確認)", () => {
    // 馬番5が取消、買い目は枠 [5,6]。枠番として5を含むが、馬番5の取消とは無関係なので、返還の判定に使ってはならない。
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: RACE,
      analyzedAt: "t",
      horses: [horse(1)],
      allocation: {
        meta: meta(),
        bets: [{ betType: "bracketQuinella", comboKey: buildAllocationBetComboKey("bracketQuinella", [5, 6]), stake: 400, odds: 1, ev: 1 }],
      },
    });
    store.saveResult(RACE, [{ umaban: 1, finishPosition: 1 }], null, { bracketQuinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 600 }] } });
    const p = computeVerifyReport(sourceWith(store, { [RACE]: results({ 5: { scratched: true } }) })).proposedBet;
    store.close();
    expect(p.bracketQuinella.refundedCount).toBe(0);
    expect(p.bracketQuinella.totalReturn).toBe(0);
  });
});
