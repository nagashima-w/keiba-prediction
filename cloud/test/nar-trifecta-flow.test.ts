import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { comboPayoutParams } from "../../packages/core/src/ev/analysis-store-codec";
import { buildAllocationBetComboKey } from "../../packages/core/src/ev/combo-bet-allocation";
import { toResultEntries } from "../../packages/core/src/ev/result-import";
import { parseNarComboOdds } from "../../packages/core/src/scraper/parse-nar-combo-odds";
import { parseRaceResult } from "../../packages/core/src/scraper/parse-race-result";
import { judgeBets, type DayBet, type RaceResultData } from "../src/daily-report-bets";

/**
 * Issue #283: 地方の三連単の日報の的中判定(`judgeBets`)が、地方の実フィクスチャで正しく動くことの通しテスト。
 * 入力は同じ地方レース 202654071210(高知10R・12頭)の実フィクスチャ: オッズ `nar_odds_b8_jiku5_…`(5→7→1 = 2600.9 倍)と、
 * 結果 `nar_result_202654071210.html`(確定払戻 三連単 5→7→1 = 260,090 円 / 100 円)。
 * D1 に保存される払戻のキーは、core の `comboPayoutParams`(取り込みの保存と同じ関数)で作る。買い目のキーは `buildAllocationBetComboKey`(配分の保存と同じ関数)。
 * core 側(`computeVerifyReport`)の同じ入力の通しは `packages/core/test/ev/verify-nar-trifecta.test.ts`。
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf-8");

const RACE = "202654071210";

function narResult(): RaceResultData {
  const parsed = parseRaceResult(fixture("nar_result_202654071210.html"));
  const trifecta = parsed.trifectaPayouts;
  if (trifecta === undefined || trifecta.state !== "parsed") throw new Error("地方の三連単の払戻が取れていない");
  return {
    horses: toResultEntries(parsed).map((r) => ({ umaban: r.umaban, finishPosition: r.finishPosition, winPayout: r.winPayout ?? null, placePayout: r.placePayout ?? null })),
    combos: {
      trifecta: {
        imported: true,
        payouts: trifecta.payouts.map((p) => {
          const [, , comboKey, payout] = comboPayoutParams(RACE, "trifecta", p);
          return { comboKey: String(comboKey), payout: Number(payout) };
        }),
      },
    },
  };
}

const bet = (umabans: readonly number[], stake: number, odds: number): DayBet => ({
  betType: "trifecta",
  comboKey: buildAllocationBetComboKey("trifecta", umabans),
  stake,
  odds,
});

describe("日報: 地方の三連単の的中判定(Issue #283。地方の実フィクスチャ 202654071210)", () => {
  const odds = (() => {
    const parsed = parseNarComboOdds(fixture("nar_odds_b8_jiku5_202654071210.html"), "trifecta");
    if (parsed.state !== "available") throw new Error("オッズのフィクスチャが available でない");
    return parsed.odds;
  })();

  it("前提: 払戻のキーは着順どおりの 6 桁\"050701\"・払戻は 260,090 円で、オッズのフィクスチャの同じキーが 2600.9 倍(=260090÷100)", () => {
    const result = narResult();
    expect(result.combos["trifecta"]!.payouts).toEqual([{ comboKey: "050701", payout: 260090 }]);
    expect(odds.get("050701")?.oddsMin).toBe(2600.9);
  });

  it("的中(5→7→1・500 円)は払戻 1,300,450 円(=260090×500/100)、逆順(5→1→7)は外れ、判定不能は無い", () => {
    const outcomes = judgeBets([bet([5, 7, 1], 500, 2600.9), bet([5, 1, 7], 500, 3212.9)], narResult());
    expect(outcomes.map((o) => [o.comboKey, o.status, o.payout])).toEqual([
      ["050701", "hit", 1_300_450],
      ["050107", "miss", 0],
    ]);
    expect(outcomes.filter((o) => o.status === "unjudged")).toEqual([]);
  });

  it("結果が取り込まれていないレース(結果なし)は判定不能(賭け金を捨てない)", () => {
    const outcomes = judgeBets([bet([5, 7, 1], 500, 2600.9)], undefined);
    expect(outcomes[0]!.status).toBe("unjudged");
  });
});
