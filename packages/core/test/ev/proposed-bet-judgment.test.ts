import { describe, expect, it } from "vitest";
import {
  createRaceBetJudge,
  isProposedBetType,
  judgmentPayout,
  payoutForStake,
  PROPOSED_BET_TYPES,
  raceHasPlacePayout,
  raceHasWinPayout,
  type BetJudgment,
  type ComboPayoutLookup,
  type JudgedHorse,
} from "../../src/ev/proposed-bet-judgment.js";

/**
 * Issue #398(R-7): 配分ベースの買い目 1 件の的中判定の規則(返還・払戻表の取込ゲート・組合せキーの完全一致)の単体テスト。
 * 検証画面の集計(`computeProposedBetReport`)と日報(cloud の `judgeBets`)の両方がこの関数を呼ぶ。両者の出力の一致は
 * `cloud/test/daily-report-bets.test.ts`・`daily-report-bets-refund.test.ts`・`daily-report-bets-bracket-refund.test.ts` が固定している
 * (共通化の前後で出力が変わらないことを守っていた特性テスト `bet-judgment-characterization.test.ts` は、Issue #446〈H-6〉で削除した)。
 */

/** テストで組み立てを書き換えるための可変版。 */
type MutableHorse = { -readonly [K in keyof JudgedHorse]: JudgedHorse[K] };

const horses = (): MutableHorse[] => [
  { umaban: 1, winPayout: 450, placePayout: 150, scratched: false, wakuban: 1 },
  { umaban: 2, winPayout: null, placePayout: 210, scratched: false, wakuban: 2 },
  { umaban: 3, winPayout: null, placePayout: null, scratched: false, wakuban: 3 },
];

/** 呼ばれた券種を記録する組合せ払戻の引き。 */
function lookupOf(table: Record<string, ReturnType<ComboPayoutLookup>>): { lookup: ComboPayoutLookup; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    lookup: (betType) => {
      calls.push(betType);
      return table[betType] ?? { state: "not_imported" };
    },
  };
}

const imported = (...rows: [string, number][]): ReturnType<ComboPayoutLookup> => ({ state: "imported", payouts: rows.map(([comboKey, payout]) => ({ comboKey, payout })) });

describe("createRaceBetJudge: 単勝・複勝", () => {
  it("払戻のある馬は hit(100 円あたりの払戻を unitPayout に持つ)、無い馬は miss", () => {
    const { lookup } = lookupOf({});
    const judge = createRaceBetJudge(horses(), lookup);
    expect(judge("win", "01")).toEqual({ outcome: "hit", unitPayout: 450 });
    expect(judge("win", "02")).toEqual({ outcome: "miss" });
    expect(judge("place", "02")).toEqual({ outcome: "hit", unitPayout: 210 });
    expect(judge("place", "03")).toEqual({ outcome: "miss" });
    expect(judge("win", "99")).toEqual({ outcome: "miss" });
  });

  it("取込ゲート: 払戻が 1 頭にも無い券種は unjudged。undefined と null は同じ(無い)扱い。もう一方の券種の判定には影響しない", () => {
    const { lookup } = lookupOf({});
    const noWin = createRaceBetJudge([{ umaban: 1, winPayout: undefined, placePayout: 150 }, { umaban: 2, winPayout: null, placePayout: null }], lookup);
    expect(noWin("win", "01").outcome).toBe("unjudged");
    expect(noWin("place", "01")).toEqual({ outcome: "hit", unitPayout: 150 });
    const noPlace = createRaceBetJudge([{ umaban: 1, winPayout: 450 }, { umaban: 2 }], lookup);
    expect(noPlace("place", "01").outcome).toBe("unjudged");
    expect(noPlace("win", "01")).toEqual({ outcome: "hit", unitPayout: 450 });
  });

  it("払戻 0 円は『ある』扱いで、hit(unitPayout 0)。ゲートも通る", () => {
    const judge = createRaceBetJudge([{ umaban: 1, winPayout: 0 }], lookupOf({}).lookup);
    expect(judge("win", "01")).toEqual({ outcome: "hit", unitPayout: 0 });
    expect(judge("win", "02")).toEqual({ outcome: "miss" });
  });
});

describe("createRaceBetJudge: 馬が 0 頭の結果", () => {
  // Issue #446(H-6): 削除した特性テスト(bet-judgment-characterization)の「馬が 0 頭の結果」から移した。
  it("単勝・複勝は払戻が 1 頭にも無いので unjudged。組合せは払戻表で判定する(hit・miss)。返還にはしない", () => {
    const { lookup } = lookupOf({ wide: imported(["0102", 800]) });
    const judge = createRaceBetJudge([], lookup);
    expect(judge("win", "01")).toEqual({ outcome: "unjudged" });
    expect(judge("place", "01")).toEqual({ outcome: "unjudged" });
    expect(judge("wide", "0102")).toEqual({ outcome: "hit", unitPayout: 800 });
    expect(judge("wide", "0103")).toEqual({ outcome: "miss" });
  });
});

describe("createRaceBetJudge: 組合せ券種", () => {
  // Issue #446(H-6・レビュー指摘): 削除した特性テストの「払戻 0 円の的中は hit(払戻 0)で、miss にしない」の組合せ券種側。単勝・複勝は上の describe が確かめる。
  it("払戻 0 円の行は『ある』扱いで、hit(unitPayout 0)。miss にしない(行が無いキーだけが miss)", () => {
    for (const [betType, key] of [["wide", "0102"], ["trio", "010203"], ["quinella", "0102"], ["exacta", "0102"], ["trifecta", "010203"], ["bracketQuinella", "0102"]] as const) {
      const judge = createRaceBetJudge(horses(), lookupOf({ [betType]: imported([key, 0], ["9999", 500]) }).lookup);
      expect(judge(betType, key)).toEqual({ outcome: "hit", unitPayout: 0 });
      expect(judge(betType, "0000")).toEqual({ outcome: "miss" });
    }
  });

  it("キーの文字列の完全一致で hit。一致しなければ miss(馬単の逆順も別の買い目)。重複キーは最初の行", () => {
    const { lookup } = lookupOf({ exacta: imported(["0102", 3200], ["0102", 1]), wide: imported(["0103", 1500]) });
    const judge = createRaceBetJudge(horses(), lookup);
    expect(judge("exacta", "0102")).toEqual({ outcome: "hit", unitPayout: 3200 });
    expect(judge("exacta", "0201")).toEqual({ outcome: "miss" });
    expect(judge("wide", "0103")).toEqual({ outcome: "hit", unitPayout: 1500 });
    expect(judge("wide", "103")).toEqual({ outcome: "miss" });
  });

  it("取込ゲート: not_imported・払戻 0 件は unjudged", () => {
    const { lookup } = lookupOf({ trio: { state: "not_imported" }, quinella: imported() });
    const judge = createRaceBetJudge(horses(), lookup);
    expect(judge("trio", "010203").outcome).toBe("unjudged");
    expect(judge("quinella", "0102").outcome).toBe("unjudged");
    expect(judge("trifecta", "010203").outcome).toBe("unjudged");
  });

  it("組合せの払戻の引きは、組合せ券種で返還でないときだけ、その券種で呼ぶ(単勝・複勝・返還・未知の券種では呼ばない)", () => {
    const hs = horses();
    hs[2]!.scratched = true;
    const { lookup, calls } = lookupOf({ wide: imported(["0102", 800]) });
    const judge = createRaceBetJudge(hs, lookup);
    judge("win", "01");
    judge("place", "01");
    judge("wide", "0103"); // 3 番は取消 → 返還
    judge("mystery", "01");
    expect(calls).toEqual([]);
    judge("wide", "0102");
    expect(calls).toEqual(["wide"]);
  });
});

describe("createRaceBetJudge: 返還", () => {
  const scratched3 = (): MutableHorse[] => {
    const hs = horses();
    hs[2]!.scratched = true;
    return hs;
  };

  it("取消・除外の馬を構成に含む買い目は refund(馬単・三連単の順序に依らない。単勝・複勝も)", () => {
    const judge = createRaceBetJudge(scratched3(), lookupOf({}).lookup);
    for (const [t, k] of [["win", "03"], ["place", "03"], ["wide", "0103"], ["trio", "010203"], ["exacta", "0301"], ["trifecta", "030102"], ["quinella", "0203"]] as const) {
      expect(judge(t, k), `${t} ${k}`).toEqual({ outcome: "refund" });
    }
  });

  it("返還は取込ゲートより前: 払戻が未取込でも refund", () => {
    const hs = scratched3().map((h) => ({ ...h, winPayout: null, placePayout: null }));
    const judge = createRaceBetJudge(hs, lookupOf({ wide: { state: "not_imported" } }).lookup);
    expect(judge("win", "03").outcome).toBe("refund");
    expect(judge("wide", "0103").outcome).toBe("refund");
    expect(judge("wide", "0102").outcome).toBe("unjudged");
  });

  it("復元できないキー・scratched が false か未記録の馬は返還にしない", () => {
    const hs = scratched3();
    delete hs[1]!.scratched; // 未記録
    const judge = createRaceBetJudge(hs, lookupOf({ wide: imported(["0102", 800]) }).lookup);
    expect(judge("wide", "abcd").outcome).toBe("miss");
    expect(judge("wide", "0102")).toEqual({ outcome: "hit", unitPayout: 800 });
  });

  it("枠連は構成馬ではなく枠で決める: 枠 3 の馬が尽きれば枠 3 を含む組が返還。枠番が未記録の行があるレースは返還にしない", () => {
    const judge = createRaceBetJudge(scratched3(), lookupOf({ bracketQuinella: imported(["0102", 1100]) }).lookup);
    expect(judge("bracketQuinella", "0203")).toEqual({ outcome: "refund" });
    expect(judge("bracketQuinella", "0102")).toEqual({ outcome: "hit", unitPayout: 1100 });
    const old = scratched3();
    delete old[0]!.wakuban;
    const judgeOld = createRaceBetJudge(old, lookupOf({ bracketQuinella: imported(["0102", 1100]) }).lookup);
    expect(judgeOld("bracketQuinella", "0203").outcome).toBe("miss");
  });
});

describe("createRaceBetJudge: 未知の券種", () => {
  it("unknownBetType を返す(賭け金は呼び出し側が数える。払戻表も見ない)", () => {
    const { lookup, calls } = lookupOf({});
    const judge = createRaceBetJudge(horses(), lookup);
    expect(judge("mystery", "01")).toEqual({ outcome: "unknownBetType" });
    expect(judge("", "01")).toEqual({ outcome: "unknownBetType" });
    expect(calls).toEqual([]);
  });
});

describe("払戻の式・券種の一覧・取込ゲート", () => {
  it("payoutForStake は 100 円あたりの払戻 × 賭け金 / 100(端数を丸めない)", () => {
    expect(payoutForStake(450, 300)).toBe(1350);
    expect(payoutForStake(210, 7)).toBe(210 * (7 / 100));
  });

  it("judgmentPayout: hit = 式、refund = 賭け金、その他 = 0", () => {
    const cases: [BetJudgment, number][] = [
      [{ outcome: "hit", unitPayout: 450 }, 1350],
      [{ outcome: "hit", unitPayout: 0 }, 0],
      [{ outcome: "refund" }, 300],
      [{ outcome: "miss" }, 0],
      [{ outcome: "unjudged" }, 0],
      [{ outcome: "unknownBetType" }, 0],
    ];
    for (const [j, want] of cases) {
      expect(judgmentPayout(j, 300), j.outcome).toBe(want);
    }
  });

  it("券種の一覧は 8 つで、isProposedBetType はその 8 つだけを受ける", () => {
    expect(PROPOSED_BET_TYPES).toHaveLength(8);
    expect(PROPOSED_BET_TYPES.every(isProposedBetType)).toBe(true);
    for (const bad of ["mystery", "", "Win", "bracket"]) {
      expect(isProposedBetType(bad), bad).toBe(false);
    }
  });

  it("raceHasPlacePayout・raceHasWinPayout: 1 件でも null でも undefined でもない払戻があれば true", () => {
    expect(raceHasPlacePayout([{ placePayout: null }, { placePayout: undefined }, {}])).toBe(false);
    expect(raceHasPlacePayout([{ placePayout: null }, { placePayout: 0 }])).toBe(true);
    expect(raceHasWinPayout([{ winPayout: null }, {}])).toBe(false);
    expect(raceHasWinPayout([{ winPayout: 100 }])).toBe(true);
    expect(raceHasWinPayout([])).toBe(false);
  });
});
