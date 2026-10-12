import { describe, expect, it } from "vitest";
import { AnalysisStore, type AnalysisAllocationMetaRecord, type AnalysisHorseRecord } from "../../src/ev/analysis-store.js";
import type { RaceResultEntry, VerifyDataSource } from "../../src/ev/analysis-store-types.js";
import { buildAllocationBetComboKey } from "../../src/ev/combo-bet-allocation.js";
import { computeVerifyReport, FLAT_COMPARISON_STAKE, type ProposedBetReport, type ProposedBetTypeSummary } from "../../src/ev/verify.js";

/**
 * Issue #16: 配分ベースの回収率(proposedBet 系)に、「同じ買い目に一律 100 円を賭けた場合」の回収率を並べる。
 *
 * 集合は `betCount` に数える買い目と全く同じ(的中・不的中・返還〈#72〉)。判定不能と未知券種は、
 * 配分ベースと同じく数えない。各買い目の賭け金だけを 100 円に置き換えるので、
 * `flatStake === betCount * 100`、`flatReturn` は「100 円あたりの払戻」そのもの(的中)・0(不的中)・100(返還)。
 *
 * 払戻は「100 円あたりの払戻 × 賭け金 / 100」の同じ式で、賭け金に stake と 100 を与えて出す
 * (1 点なら stake に依らず recoveryRate === flatRecoveryRate になる)。
 */

function horse(umaban: number): AnalysisHorseRecord {
  return { umaban, prior: 0.5, adjustedProb: 0.5, placeOddsMin: 2, ev: 1, isPositive: true, contributions: null, mark: null };
}

function meta(): AnalysisAllocationMetaRecord {
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
  };
}

const RACE = "R16";

/** 8頭立て。馬番5が取消・除外。複勝: 1=140円・2=310円・3=180円。単勝: 1=300円。 */
function results(): RaceResultEntry[] {
  return [
    { umaban: 1, finishPosition: 1, placePayout: 140, winPayout: 300 },
    { umaban: 2, finishPosition: 2, placePayout: 310, winPayout: null },
    { umaban: 3, finishPosition: 3, placePayout: 180, winPayout: null },
    { umaban: 4, finishPosition: 4, placePayout: null, winPayout: null },
    { umaban: 5, finishPosition: null, placePayout: null, winPayout: null, scratched: true },
    { umaban: 6, finishPosition: 5, placePayout: null, winPayout: null },
    { umaban: 7, finishPosition: 6, placePayout: null, winPayout: null },
    { umaban: 8, finishPosition: 7, placePayout: null, winPayout: null },
  ];
}

type BetType = "place" | "win" | "wide" | "trio" | "quinella" | "exacta" | "trifecta" | "bracketQuinella";

interface Bet {
  readonly betType: BetType;
  readonly umabans: readonly number[];
  readonly stake: number;
}

/** 組合せ券の確定払戻(100円あたり)。 */
const COMBO_PAYOUTS = {
  wide: { umabans: [1, 2], payout: 500 },
  trio: { umabans: [1, 2, 3], payout: 2000 },
  quinella: { umabans: [1, 2], payout: 800 },
  exacta: { umabans: [1, 2], payout: 1500 },
  trifecta: { umabans: [1, 2, 3], payout: 9000 },
  bracketQuinella: { umabans: [1, 2], payout: 600 },
} as const;

/** 結果の読み出しだけを差し替えた入口(`scratched` を返すため。他は AnalysisStore のまま)。 */
function sourceWith(store: AnalysisStore, res: RaceResultEntry[]): VerifyDataSource {
  return {
    listAnalyses: (filter) => store.listAnalyses(filter),
    getResult: () => res,
    getComboPayouts: (raceId, betType) => store.getComboPayouts(raceId, betType),
    getAllocationForVerify: (id) => store.getAllocationForVerify(id),
  };
}

/** 分析を1件保存して集計する。`importCombo:false` なら組合せ払戻は未取込。 */
function run(bets: readonly Bet[], opts: { importCombo?: boolean; res?: RaceResultEntry[] } = {}): ProposedBetReport {
  const store = new AnalysisStore();
  store.saveAnalysis({
    raceId: RACE,
    analyzedAt: "t",
    horses: [horse(1)],
    allocation: {
      meta: meta(),
      bets: bets.map((b) => ({ betType: b.betType, comboKey: buildAllocationBetComboKey(b.betType, b.umabans), stake: b.stake, odds: 1, ev: 1 })),
    },
  });
  const res = opts.res ?? results();
  store.saveResult(
    RACE,
    res.map((r) => ({ umaban: r.umaban, finishPosition: r.finishPosition, placePayout: r.placePayout ?? null, winPayout: r.winPayout ?? null })),
    null,
    opts.importCombo === false
      ? undefined
      : Object.fromEntries(Object.entries(COMBO_PAYOUTS).map(([t, p]) => [t, { state: "parsed" as const, payouts: [{ umabans: [...p.umabans], payout: p.payout }] }])),
  );
  const report = computeVerifyReport(sourceWith(store, res));
  store.close();
  return report.proposedBet;
}

const TYPES: readonly BetType[] = ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"];

function allSummaries(p: ProposedBetReport): ProposedBetTypeSummary[] {
  return TYPES.map((t) => p[t]);
}

describe("同じ買い目に一律100円を賭けた場合(Issue #16): 的中・不的中・返還", () => {
  type Outcome = "hit" | "miss" | "refund";
  // [券種, 買い目の馬番, 結果, 100円あたりの払戻(的中のとき)]
  const cases: ReadonlyArray<readonly [BetType, readonly number[], Outcome, number]> = [
    ["place", [1], "hit", 140],
    ["place", [4], "miss", 0],
    ["place", [5], "refund", 0],
    ["win", [1], "hit", 300],
    ["win", [2], "miss", 0],
    ["win", [5], "refund", 0],
    ["wide", [1, 2], "hit", 500],
    ["wide", [1, 3], "miss", 0],
    ["wide", [1, 5], "refund", 0],
    ["trio", [1, 2, 3], "hit", 2000],
    ["trio", [1, 2, 4], "miss", 0],
    ["trio", [1, 2, 5], "refund", 0],
    ["quinella", [1, 2], "hit", 800],
    ["quinella", [1, 3], "miss", 0],
    ["quinella", [2, 5], "refund", 0],
    ["exacta", [1, 2], "hit", 1500],
    ["exacta", [2, 1], "miss", 0], // 逆順は別の買い目
    ["exacta", [5, 1], "refund", 0],
    ["trifecta", [1, 2, 3], "hit", 9000],
    ["trifecta", [1, 3, 2], "miss", 0],
    ["trifecta", [1, 5, 2], "refund", 0],
    ["bracketQuinella", [1, 2], "hit", 600],
    ["bracketQuinella", [3, 4], "miss", 0],
  ];

  it("全8券種の的中・不的中を含み、返還は枠連を除く7券種を含む(券種の取りこぼしを許さない)", () => {
    expect(new Set(cases.map(([t]) => t)).size).toBe(8);
    expect(new Set(cases.filter(([, , o]) => o === "hit").map(([t]) => t)).size).toBe(8);
    expect(new Set(cases.filter(([, , o]) => o === "miss").map(([t]) => t)).size).toBe(8);
    expect(new Set(cases.filter(([, , o]) => o === "refund").map(([t]) => t)).size).toBe(7);
  });

  it.each(cases)("%s %j(%s): 賭け金 500 円の配分に対し、一律 100 円の賭け金・払戻は 100 円あたりの値になる", (betType, umabans, outcome, unitPayout) => {
    const s = run([{ betType, umabans, stake: 500 }])[betType];
    const flatReturn = outcome === "hit" ? unitPayout : outcome === "refund" ? 100 : 0;
    // 前提(無条件): 判定できた1点で、配分側の賭け金は 500 円(一律 100 円と違う)。返還の件数は結果と一致する
    expect(s.betCount).toBe(1);
    expect(s.totalStake).toBe(500);
    expect(s.refundedCount).toBe(outcome === "refund" ? 1 : 0);
    expect(s.flatStake).toBe(100);
    expect(s.flatReturn).toBe(flatReturn);
    expect(s.flatRecoveryRate).toBe(flatReturn / 100);
    // 配分側は同じ式で 5 倍(1 点のとき、回収率は賭け金に依らず一致する)
    expect(s.totalReturn).toBe(flatReturn * 5);
    expect(s.recoveryRate).toBe(s.flatRecoveryRate);
  });
});

describe("同じ買い目に一律100円(Issue #16): 判定不能・未知券種は数えない", () => {
  it("組合せ払戻が未取込のワイド・払戻が1件も無い複勝は、一律側にも数えない(配分側と同じ集合)", () => {
    const noPayout = results().map((r) => ({ ...r, placePayout: null, winPayout: null }));
    const p = run(
      [
        { betType: "wide", umabans: [1, 2], stake: 300 },
        { betType: "place", umabans: [1], stake: 200 },
      ],
      { importCombo: false, res: noPayout },
    );
    // 前提: 判定不能が実際に発生している
    expect(p.wide.unjudgedCount).toBe(1);
    expect(p.place.unjudgedCount).toBe(1);
    for (const s of [p.wide, p.place, p.overall]) {
      expect(s.betCount).toBe(0);
      expect(s.flatStake).toBe(0);
      expect(s.flatReturn).toBe(0);
      expect(s.flatRecoveryRate).toBeNull();
    }
  });

  it("判定不能と判定できた買い目が混在: 一律側は判定できた買い目だけ(ワイドだけ組合せ未取込)", () => {
    const p = run(
      [
        { betType: "place", umabans: [1], stake: 300 },
        { betType: "wide", umabans: [1, 2], stake: 200 },
      ],
      { importCombo: false },
    );
    expect(p.overall.betCount).toBe(1);
    expect(p.overall.unjudgedCount).toBe(1);
    expect(p.overall.flatStake).toBe(100);
    expect(p.overall.flatReturn).toBe(140);
  });

  it("未知の券種は、配分側と同じく一律側にも数えない(どの券種の flat にも入らない)", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({ raceId: RACE, analyzedAt: "t", horses: [horse(1)], allocation: { meta: meta(), bets: [{ betType: "place", comboKey: "01", stake: 300, odds: 1, ev: 1 }] } });
    store.saveResult(RACE, [{ umaban: 1, finishPosition: 1, placePayout: 140 }], null, undefined);
    const base = sourceWith(store, results());
    const source: VerifyDataSource = {
      ...base,
      getAllocationForVerify: (id) => {
        const a = base.getAllocationForVerify(id);
        return a === undefined ? undefined : { ...a, bets: [...a.bets, { betType: "futureBetType", comboKey: "0102", stake: 700 }] };
      },
    };
    const p = computeVerifyReport(source).proposedBet;
    store.close();
    expect(p.unknownBetType.count).toBe(1);
    expect(p.overall.betCount).toBe(1);
    expect(p.overall.flatStake).toBe(100);
    expect(p.overall.flatReturn).toBe(140);
  });
});

describe("同じ買い目に一律100円(Issue #16): 配分の効果の切り出し・合算", () => {
  it("厚く賭けた買い目が当たると、配分ベースの回収率は一律より高くなる(手計算: 配分 1260/1000、一律 140/200)", () => {
    const p = run([
      { betType: "place", umabans: [1], stake: 900 }, // 的中 140円 → 1260円
      { betType: "place", umabans: [4], stake: 100 }, // 不的中
    ]);
    expect(p.place).toMatchObject({ betCount: 2, totalStake: 1000, totalReturn: 1260, flatStake: 200, flatReturn: 140 });
    expect(p.place.recoveryRate).toBeCloseTo(1.26, 10);
    expect(p.place.flatRecoveryRate).toBeCloseTo(0.7, 10);
    // 差が 0 でない(配分の効果が実際に切り出せている)
    expect(p.place.recoveryRate! - p.place.flatRecoveryRate!).toBeGreaterThan(0.5);
  });

  it("的中・不的中・返還が混在: 手計算 配分 920/1000、一律 240/300", () => {
    const p = run([
      { betType: "place", umabans: [1], stake: 300 }, // 的中 420
      { betType: "place", umabans: [5], stake: 500 }, // 返還 500
      { betType: "place", umabans: [4], stake: 200 }, // 不的中
    ]);
    expect(p.place).toEqual({
      betCount: 3,
      totalStake: 1000,
      totalReturn: 920,
      recoveryRate: 0.92,
      unjudgedCount: 0,
      refundedCount: 1,
      refundedStake: 500,
      flatStake: 300,
      flatReturn: 240, // 140 + 100 + 0
      flatRecoveryRate: 0.8,
    });
  });

  it("全ての賭け金が 100 円なら、配分ベースと一律で完全に一致する(同じ式を通すので誤差も出ない)", () => {
    const p = run([
      { betType: "place", umabans: [1], stake: 100 },
      { betType: "wide", umabans: [1, 2], stake: 100 },
      { betType: "trio", umabans: [1, 2, 4], stake: 100 },
      { betType: "quinella", umabans: [2, 5], stake: 100 },
    ]);
    // 前提: 的中・不的中・返還が混在して、0 同士の一致ではない
    expect(p.overall.betCount).toBe(4);
    expect(p.overall.totalReturn).toBe(140 + 500 + 0 + 100);
    expect(p.overall.flatStake).toBe(p.overall.totalStake);
    expect(p.overall.flatReturn).toBe(p.overall.totalReturn);
    expect(p.overall.flatRecoveryRate).toBe(p.overall.recoveryRate);
  });

  it("全8券種に買い目がある入力で、flatStake === betCount × 100、overall は8券種の合算(落とした項が無い)", () => {
    const p = run([
      { betType: "place", umabans: [1], stake: 300 },
      { betType: "win", umabans: [1], stake: 200 },
      { betType: "wide", umabans: [1, 2], stake: 400 },
      { betType: "trio", umabans: [1, 2, 3], stake: 100 },
      { betType: "quinella", umabans: [1, 2], stake: 600 },
      { betType: "exacta", umabans: [1, 2], stake: 700 },
      { betType: "trifecta", umabans: [1, 2, 3], stake: 800 },
      { betType: "bracketQuinella", umabans: [1, 2], stake: 900 },
    ]);
    const types = allSummaries(p);
    const flatReturnSum = 140 + 300 + 500 + 2000 + 800 + 1500 + 9000 + 600;
    // 前提(無条件): 8券種すべてに1点ずつあり、配分の賭け金の合計は一律の賭け金と異なる
    expect(types.map((s) => s.betCount)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(p.overall.totalStake).not.toBe(p.overall.flatStake);
    expect(FLAT_COMPARISON_STAKE).toBe(100);
    for (const s of types) {
      expect(s.flatStake).toBe(s.betCount * FLAT_COMPARISON_STAKE);
    }
    expect(p.overall.flatStake).toBe(800);
    expect(p.overall.flatReturn).toBe(flatReturnSum);
    expect(p.overall.flatRecoveryRate).toBe(flatReturnSum / 800);
    expect(types.reduce((a, s) => a + s.flatStake, 0)).toBe(p.overall.flatStake);
    expect(types.reduce((a, s) => a + s.flatReturn, 0)).toBe(p.overall.flatReturn);
  });

  it("返還は一律側でも返還として数える(100 円が賭け金にも払戻にも入る)。overall に7券種の返還の項を足し込む", () => {
    const p = run([
      { betType: "place", umabans: [5], stake: 500 },
      { betType: "win", umabans: [5], stake: 200 },
      { betType: "wide", umabans: [1, 5], stake: 300 },
      { betType: "trio", umabans: [1, 2, 5], stake: 400 },
      { betType: "quinella", umabans: [2, 5], stake: 600 },
      { betType: "exacta", umabans: [5, 1], stake: 700 },
      { betType: "trifecta", umabans: [1, 5, 2], stake: 800 },
    ]);
    expect(p.overall.refundedCount).toBe(7);
    expect(p.overall.flatStake).toBe(700);
    expect(p.overall.flatReturn).toBe(700);
    expect(p.overall.flatRecoveryRate).toBe(1);
    expect(p.overall.totalStake).toBe(3500);
    expect(p.overall.totalReturn).toBe(3500);
  });

  it("買い目の無い券種は flat も 0 で、一律の回収率は null(0 除算を避ける)", () => {
    const p = run([{ betType: "place", umabans: [1], stake: 300 }]);
    expect(p.place.betCount).toBe(1);
    expect(p.wide).toMatchObject({ betCount: 0, flatStake: 0, flatReturn: 0, flatRecoveryRate: null });
  });
});
