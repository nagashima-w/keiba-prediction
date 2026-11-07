import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalysisRecord, RaceData } from "../../src/index.js";
import { runAnalysis } from "../../src/analysis/analysis-pipeline.js";
import { recomputeAllocationFromProbs, type RecomputeHorseInput } from "../../src/analysis/recompute-allocation.js";
import * as shrink from "../../src/ev/market-shrink.js";
import { ALL_BETS_SETTINGS, FIXED_NOW, KAISAI_DATE, RACE_ID, scrapeFixtureRace, viaJson } from "../golden/pipeline-golden-scenarios.js";

/**
 * Issue #658: 配分に使った重みの記録と、予想オッズ(yoso)・未設定(unset)での寄せの計算の省略。
 * 固定する性質:
 *  1. 寄せの計算は、配分を作る分析(result/middle で、設定あり)でだけ呼ぶ。yoso・unset では呼ばず、出力(配分・馬の行)は w を変えても同じ。
 *  2. メタ行の marketShrinkWeight は、配分を作った経路(place-only・mixed)では**配分に使った w**(定数でなく設定のまま)。
 *     配分を作らない経路(yoso・unset)と、w を渡さない呼び出しでは記録しない(キー自体を持たない = D1 の NULL)。
 */

vi.mock("../../src/ev/market-shrink.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/ev/market-shrink.js")>();
  return { ...orig, shrinkTowardMarket: vi.fn((horses: Parameters<typeof orig.shrinkTowardMarket>[0], w: number) => orig.shrinkTowardMarket(horses, w)) };
});

const spy = vi.mocked(shrink.shrinkTowardMarket);

interface Baseline {
  readonly race: RaceData;
  readonly horses: readonly RecomputeHorseInput[];
}
let base: Baseline;
beforeAll(async () => {
  const race = await scrapeFixtureRace();
  let saved: AnalysisRecord | undefined;
  await runAnalysis(RACE_ID, KAISAI_DATE, {
    scrape: async () => race,
    analyze: null,
    saveAnalysis: (record) => {
      saved = record;
      return 1;
    },
    allocationSettings: ALL_BETS_SETTINGS,
    now: FIXED_NOW,
    llmSkipReason: "テスト: LLM なし",
  });
  const wakuban = new Map(race.horses.map((h) => [h.shutuba.umaban, h.shutuba.wakuban]));
  const name = new Map(race.horses.map((h) => [h.shutuba.umaban, h.shutuba.name]));
  base = { race, horses: saved!.horses.map((h) => ({ umaban: h.umaban, wakuban: wakuban.get(h.umaban)!, horseName: name.get(h.umaban)!, prior: h.prior, adjustedProb: h.adjustedProb })) };
}, 60_000);
beforeEach(() => {
  spy.mockClear();
});

const recompute = (settings: Record<string, unknown>, odds: RaceData["odds"] = base.race.odds) =>
  recomputeAllocationFromProbs({
    raceId: RACE_ID,
    horses: base.horses,
    odds,
    comboOdds: base.race.meta.comboOdds,
    allocationSettings: { ...ALL_BETS_SETTINGS, ...settings } as never,
  });

describe("配分に使った重みの記録と、寄せの計算の省略(Issue #658)", { timeout: 60_000 }, () => {
  it("配分を作る分析では寄せを呼び、メタ行に配分に使った w(混在・複勝のみの両方)を記録する。w は定数でなく設定のまま", () => {
    for (const w of [0.3, 0.5, 0.8]) {
      spy.mockClear();
      const mixed = recompute({ marketShrinkWeight: w });
      expect(mixed.allocation.meta.route).toBe("mixed");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(mixed.allocation.meta.marketShrinkWeight).toBe(w);
      const placeOnly = recompute({ marketShrinkWeight: w, includeComboOdds: false });
      expect(placeOnly.allocation.meta.route).toBe("place-only");
      expect(placeOnly.allocation.meta.marketShrinkWeight).toBe(w);
    }
  });

  it("w=1 も『配分に使った重み 1』として記録する(寄せない設定と、記録なしを区別する)", () => {
    const r = recompute({ marketShrinkWeight: 1 });
    expect(r.allocation.meta.marketShrinkWeight).toBe(1);
  });

  it("w を渡さない呼び出しは記録しない(キー自体を持たない = 旧い呼び出しと同じ形)", () => {
    const r = recompute({});
    expect(r.allocation.bets.length).toBeGreaterThan(0);
    expect("marketShrinkWeight" in r.allocation.meta).toBe(false);
  });

  it("予想オッズ(yoso)では寄せを呼ばず、w=0.5 と省略で出力が完全に同じ。重みは記録しない", () => {
    const yoso = { ...base.race.odds, oddsStatus: "yoso" } as RaceData["odds"];
    spy.mockClear();
    const shrunk = recompute({ marketShrinkWeight: 0.5 }, yoso);
    expect(shrunk.allocation.meta.route).toBe("yoso");
    expect(spy).not.toHaveBeenCalled();
    expect("marketShrinkWeight" in shrunk.allocation.meta).toBe(false);
    const plain = recompute({}, yoso);
    expect(viaJson(shrunk)).toEqual(viaJson(plain));
    // 前提: yoso の行は EV が推定(evEstimated)で、馬の行が実際に作られている(空の比較ではない)
    expect(shrunk.evEstimated).toBe(true);
    expect(shrunk.rows.length).toBeGreaterThan(5);
  });

  it("未設定(bankroll・perRaceCap が 0)では寄せを呼ばず、w=0.5 と省略で出力が完全に同じ。重みは記録しない", () => {
    const unset = { bankroll: 0, perRaceCap: 0 };
    spy.mockClear();
    const shrunk = recompute({ ...unset, marketShrinkWeight: 0.5 });
    expect(shrunk.allocation.meta.route).toBe("unset");
    expect(spy).not.toHaveBeenCalled();
    expect("marketShrinkWeight" in shrunk.allocation.meta).toBe(false);
    expect(viaJson(shrunk)).toEqual(viaJson(recompute(unset)));
    expect(shrunk.rows.length).toBeGreaterThan(5);
  });

  it("分析時(runAnalysis)の保存の記録にも、配分に使った w が載る", async () => {
    let saved: AnalysisRecord | undefined;
    await runAnalysis(RACE_ID, KAISAI_DATE, {
      scrape: async () => base.race,
      analyze: null,
      saveAnalysis: (record) => {
        saved = record;
        return 1;
      },
      allocationSettings: { ...ALL_BETS_SETTINGS, marketShrinkWeight: 0.3 },
      now: FIXED_NOW,
      llmSkipReason: "テスト: LLM なし",
    });
    expect(saved!.allocation!.meta.marketShrinkWeight).toBe(0.3);
  });
});
