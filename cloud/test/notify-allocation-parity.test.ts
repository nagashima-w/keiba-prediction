import { describe, expect, it } from "vitest";

import { PREDICTION_MARKS } from "../../packages/core/src/analyzer/parse-response";
import type { AnalysisAllocationRecord } from "../../packages/core/src/ev/analysis-store-types";
import { buildAllocationProposalView } from "../../packages/app/src/renderer/allocation-proposal-view";
import { BET_ALLOCATION_UNSET_NOTE } from "../../packages/app/src/renderer/bet-allocation-view";
import { UNSET_BANKROLL_ONLY_NOTE, UNSET_INDETERMINATE_NOTE, UNSET_PER_RACE_CAP_ONLY_NOTE } from "../../packages/app/src/renderer/allocation-proposal-view";
import type { StoredAllocationView } from "../../packages/app/src/shared/analysis-types";
import { KNOWN_MARK_ORDER } from "../client/result";
import { allocationBetRows, allocationKindOf, MARK_ORDER, unsetKindOf } from "../src/notify-embeds";
import { allocationRecord, betRecord } from "./allocation-fixtures";

/**
 * Issue #230: Discord の通知の「買い目」の整形は、exe の `buildAllocationProposalView`(web の結果画面が流用しているもの)を import せず、cloud/src に小さな自前の整形を持つ
 * (`cloud/src` が辿る app のファイルを増やさないため。`test/import-guard.test.ts` の完全一致リストを広げない)。二重持ちの食い違いはここで固定する:
 * 状態の分類(kind)・未設定の内訳・券種ラベル・組合せラベル・金額表記・印の並び順が、exe(と web の画面)と一致すること。
 */

/** 保存する配分の記録 → exe の表示の入力(`StoredAllocationView`)。読む列の対応は `analysis-view.ts`(web の API)と同じ。 */
function storedViewOf(allocation: AnalysisAllocationRecord): StoredAllocationView {
  const m = allocation.meta;
  return {
    route: m.route,
    unavailableReason: m.unavailableReason,
    fallbackReason: m.fallbackReason,
    skipReasonCode: m.skipReasonCode,
    bankroll: m.bankroll,
    perRaceCap: m.perRaceCap,
    kellyFraction: m.kellyFraction,
    evThreshold: m.evThreshold,
    includeComboOdds: m.includeComboOdds,
    includeWide: m.includeWide,
    includeTrio: m.includeTrio,
    includeQuinella: m.includeQuinella,
    includeExacta: m.includeExacta,
    includeTrifecta: m.includeTrifecta,
    includeBracketQuinella: m.includeBracketQuinella,
    betUnit: m.betUnit,
    oddsStatus: m.oddsStatus,
    bets: allocation.bets.map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev })),
  };
}

const ONE_BET = [betRecord("place", "05", 500)];

describe("状態の分類(kind)は exe の buildAllocationProposalView と同じ", () => {
  it.each([
    ["unset(両方未設定)", allocationRecord({ route: "unset", bankroll: 0, perRaceCap: 0 })],
    ["unset(総資金だけ)", allocationRecord({ route: "unset", bankroll: 0, perRaceCap: 2000 })],
    ["unset(上限だけ)", allocationRecord({ route: "unset", bankroll: 10000, perRaceCap: 0 })],
    ["unset(どちらも設定済み)", allocationRecord({ route: "unset" })],
    ["yoso", allocationRecord({ route: "yoso" })],
    ["unavailable", allocationRecord({ route: "unavailable", unavailableReason: "not-sold" })],
    ["unavailable(理由なし)", allocationRecord({ route: "unavailable" })],
    ["invalid", allocationRecord({ route: "invalid" })],
    ["place-only の見送り", allocationRecord({ route: "place-only", skipReasonCode: "no-edge" })],
    ["mixed の見送り(未知の理由コード)", allocationRecord({ route: "mixed", skipReasonCode: "something-new" })],
    ["place-only で買い目あり", allocationRecord({ route: "place-only" }, ONE_BET)],
    ["mixed で買い目あり", allocationRecord({ route: "mixed" }, ONE_BET)],
    ["mixed で見送りの印も買い目も無い(矛盾)", allocationRecord({ route: "mixed" })],
    ["見送りの印があるのに買い目もある(矛盾。見送りが先)", allocationRecord({ route: "mixed", skipReasonCode: "no-edge" }, ONE_BET)],
    ["未知の route", allocationRecord({ route: "future-route" }, ONE_BET)],
  ] as const)("%s", (_name, allocation) => {
    expect(allocationKindOf(allocation)).toBe(buildAllocationProposalView(storedViewOf(allocation)).kind);
  });

  it("記録なし(allocation が無い)は、exe の no-record と同じ", () => {
    expect(allocationKindOf(undefined)).toBe(buildAllocationProposalView(null).kind);
  });

  it("前提(空振り防止): 上の表は、exe の kind のうち no-record 以外の 7 種(unset・yoso・unavailable・invalid・skip・allocated・indeterminate)をすべて通っている", () => {
    const kinds = new Set(
      [
        allocationRecord({ route: "unset" }),
        allocationRecord({ route: "yoso" }),
        allocationRecord({ route: "unavailable" }),
        allocationRecord({ route: "invalid" }),
        allocationRecord({ route: "mixed", skipReasonCode: "no-edge" }),
        allocationRecord({ route: "mixed" }, ONE_BET),
        allocationRecord({ route: "future-route" }),
      ].map((a) => buildAllocationProposalView(storedViewOf(a)).kind),
    );
    expect([...kinds].sort()).toEqual(["allocated", "indeterminate", "invalid", "skip", "unavailable", "unset", "yoso"]);
  });
});

describe("未設定(unset)の内訳は、exe が選ぶ注記と同じ分岐", () => {
  it.each([
    ["both", { bankroll: 0, perRaceCap: 0 }, BET_ALLOCATION_UNSET_NOTE],
    ["bankroll", { bankroll: 0, perRaceCap: 2000 }, UNSET_BANKROLL_ONLY_NOTE],
    ["cap", { bankroll: 10000, perRaceCap: 0 }, UNSET_PER_RACE_CAP_ONLY_NOTE],
    ["indeterminate", { bankroll: 10000, perRaceCap: 2000 }, UNSET_INDETERMINATE_NOTE],
    ["both(負の値も未設定)", { bankroll: -1, perRaceCap: -5 }, BET_ALLOCATION_UNSET_NOTE],
  ] as const)("%s", (_name, over, note) => {
    const allocation = allocationRecord({ route: "unset", ...over });
    const exe = buildAllocationProposalView(storedViewOf(allocation));
    expect(exe.notices).toEqual([note]); // 前提: exe がこの注記を選んでいる
    const kind = unsetKindOf(allocation.meta);
    expect(kind).toBe(_name.split("(")[0]);
  });
});

describe("買い目の行(券種・組合せ・金額)は、exe の買い目行と同じ表記", () => {
  const ALL_TYPES = [
    betRecord("place", "05", 800),
    betRecord("win", "12", 700),
    betRecord("wide", "0307", 600),
    betRecord("quinella", "0307", 500),
    betRecord("bracketQuinella", "0407", 400),
    betRecord("bracketQuinella", "0202", 390),
    betRecord("exacta", "1308", 300),
    betRecord("exacta", "0813", 290),
    betRecord("trio", "010305", 200),
    betRecord("trifecta", "130801", 100),
    betRecord("trifecta", "011318", 90),
    betRecord("place", "10", 1234567),
  ];

  it("全 8 券種(複勝・単勝・ワイド・馬連・枠連・馬単・三連複・三連単)の券種ラベル・組合せラベル・金額が、並びを問わず一致する(多重集合として)", () => {
    expect(new Set(ALL_TYPES.map((b) => b.betType)).size, "前提: 8 券種すべて入っている").toBe(8);
    const exe = buildAllocationProposalView(storedViewOf(allocationRecord({ route: "mixed" }, ALL_TYPES)));
    expect(exe.kind).toBe("allocated");
    const key = (r: { betTypeLabel: string; comboLabel: string }, stake: string): string => `${r.betTypeLabel}|${r.comboLabel}|${stake}`;
    const theirs = exe.bets.map((r) => key(r, r.stake)).sort();
    const mine = allocationBetRows(ALL_TYPES).map((r) => key(r, r.stakeText)).sort();
    expect(mine).toHaveLength(ALL_TYPES.length);
    expect(mine).toEqual(theirs);
  });

  it("未知の券種・読めない comboKey も、exe と同じく生の文字列のまま出す", () => {
    const odd = [betRecord("mystery", "0102", 100), betRecord("place", "xx", 200), betRecord("trio", "010", 300)];
    const exe = buildAllocationProposalView(storedViewOf(allocationRecord({ route: "mixed" }, odd)));
    const key = (b: string, c: string, s: string): string => `${b}|${c}|${s}`;
    expect(allocationBetRows(odd).map((r) => key(r.betTypeLabel, r.comboLabel, r.stakeText)).sort()).toEqual(exe.bets.map((r) => key(r.betTypeLabel, r.comboLabel, r.stake)).sort());
  });
});

describe("印の並び順は、core の PREDICTION_MARKS・web の画面(KNOWN_MARK_ORDER)と同じ", () => {
  it("MARK_ORDER = PREDICTION_MARKS = KNOWN_MARK_ORDER", () => {
    expect([...MARK_ORDER]).toEqual([...PREDICTION_MARKS]);
    expect([...MARK_ORDER]).toEqual([...KNOWN_MARK_ORDER]);
  });
});
