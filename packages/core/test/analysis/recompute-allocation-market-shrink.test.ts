import { describe, expect, it } from "vitest";

import type { AnalysisRecord, RaceData } from "../../src/index.js";
import { runAnalysis } from "../../src/analysis/analysis-pipeline.js";
import { recomputeAllocationFromProbs, type RecomputeHorseInput } from "../../src/analysis/recompute-allocation.js";
import { shrinkTowardMarket } from "../../src/ev/market-shrink.js";
import { ALL_BETS_SETTINGS, FIXED_NOW, KAISAI_DATE, RACE_ID, scrapeFixtureRace, viaJson } from "../golden/pipeline-golden-scenarios.js";

/**
 * Issue #656: 配分の前に、補正後の 3着内率を市場(単勝オッズ)に寄せる(設定 `marketShrinkWeight`)。
 * 固定する性質:
 *  1. 省略・1 は従来と完全に同じ(配分・馬の行)。
 *  2. 1 未満では配分が変わる(差が 0 でない)が、馬の行(補正後の確率・EV・isPositive)は変わらない。
 *  3. 寄せた配分は「確率を先に寄せて w なしで配分した」結果と完全に一致する(寄せ方の独立な突き合わせ)。
 *  4. 保存する買い目の ev ÷ odds は、寄せた確率から導いた的中確率(複勝は寄せた確率そのもの)になる。
 *  5. 分析時(runAnalysis)と締切の再計算(recomputeAllocationFromProbs)は同じ配分になる。保存する馬の行は寄せない。
 *  6. 単勝オッズが全馬に無ければ寄せない。
 */

interface Baseline {
  readonly race: RaceData;
  readonly horses: readonly RecomputeHorseInput[];
}
let baselineOnce: Promise<Baseline> | undefined;
function baseline(): Promise<Baseline> {
  baselineOnce ??= (async () => {
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
    const horses = saved!.horses.map((h) => ({ umaban: h.umaban, wakuban: wakuban.get(h.umaban)!, horseName: name.get(h.umaban)!, prior: h.prior, adjustedProb: h.adjustedProb }));
    return { race, horses };
  })();
  return baselineOnce;
}

const recompute = (b: Baseline, horses: readonly RecomputeHorseInput[], marketShrinkWeight?: number, odds: RaceData["odds"] = b.race.odds) =>
  recomputeAllocationFromProbs({
    raceId: RACE_ID,
    horses,
    odds,
    comboOdds: b.race.meta.comboOdds,
    allocationSettings: { ...ALL_BETS_SETTINGS, ...(marketShrinkWeight === undefined ? {} : { marketShrinkWeight }) },
  });

/**
 * 比較用: メタ行の marketShrinkWeight(Issue #658。配分に使った重みの記録)だけを除いた JSON。
 * 重みを渡した呼び出しと渡さない呼び出しは、この記録の有無だけが違う。買い目・メタの他の列・馬の行の比較は弱めない(記録そのものは recompute-allocation-market-shrink-record.test.ts が固定する)。
 */
function withoutWeight<T>(x: T): unknown {
  const c = viaJson(x) as { allocation?: { meta?: Record<string, unknown> }; meta?: Record<string, unknown> };
  delete c.allocation?.meta?.["marketShrinkWeight"];
  delete c.meta?.["marketShrinkWeight"];
  return c;
}

/** 配分の比較用: 買い目(種別・キー・賭け金・オッズ・ev)。 */
const betsOf = (r: ReturnType<typeof recomputeAllocationFromProbs>) => r.allocation.bets.map((x) => `${x.betType}:${x.comboKey}:${x.stake}:${x.odds}:${x.ev}`);

describe("配分の前に確率を市場に寄せる(Issue #656)", { timeout: 60_000 }, () => {
  it("省略と w=1 は従来と完全に同じ(配分・馬の行)。前提: 配分が多点", async () => {
    const b = await baseline();
    const plain = recompute(b, b.horses);
    expect(plain.allocation.bets.length).toBeGreaterThan(5);
    expect(withoutWeight(recompute(b, b.horses, 1))).toEqual(withoutWeight(plain));
  });

  it("w=0.5: 配分は変わる(差が 0 でない)が、馬の行(補正後の確率・EV・isPositive・複勝下限)は変わらない", async () => {
    const b = await baseline();
    const plain = recompute(b, b.horses);
    const shrunk = recompute(b, b.horses, 0.5);
    expect(viaJson(shrunk.rows)).toEqual(viaJson(plain.rows));
    expect(betsOf(shrunk)).not.toEqual(betsOf(plain));
    const total = (r: typeof plain) => r.allocation.bets.reduce((s, x) => s + x.stake, 0);
    expect(total(shrunk)).toBeGreaterThan(0);
  });

  it("寄せた配分は、確率を先に寄せて(w なしで)配分した結果と完全に一致する(買い目・メタ・comboStats)", async () => {
    const b = await baseline();
    const mixed = shrinkTowardMarket(
      b.horses.map((h) => ({ umaban: h.umaban, p: h.adjustedProb, winOdds: b.race.odds.win[h.umaban]?.odds ?? null })),
      0.5,
    );
    // 前提: 寄せた確率は元の確率と実際に違う馬がいる(自明に一致する退化ではない)
    expect(b.horses.some((h) => Math.abs(mixed.get(h.umaban)! - h.adjustedProb) > 0.01)).toBe(true);
    const viaSetting = recompute(b, b.horses, 0.5);
    const viaPreMixed = recompute(b, b.horses.map((h) => ({ ...h, adjustedProb: mixed.get(h.umaban)! })));
    expect(withoutWeight(viaSetting.allocation)).toEqual(withoutWeight(viaPreMixed.allocation));
    expect(viaJson(viaSetting.comboStats)).toEqual(viaJson(viaPreMixed.comboStats));
  });

  it("保存する買い目の ev ÷ odds は寄せた確率になる(複勝は寄せた確率そのもの)", async () => {
    const b = await baseline();
    const mixed = shrinkTowardMarket(
      b.horses.map((h) => ({ umaban: h.umaban, p: h.adjustedProb, winOdds: b.race.odds.win[h.umaban]?.odds ?? null })),
      0.5,
    );
    // 複勝だけの経路(組合せオッズを取得しない設定)。そこでは買い目の ev ÷ odds(複勝下限)が補正後の 3着内率そのもの。
    const shrunk = recomputeAllocationFromProbs({
      raceId: RACE_ID,
      horses: b.horses,
      odds: b.race.odds,
      allocationSettings: { ...ALL_BETS_SETTINGS, includeComboOdds: false, marketShrinkWeight: 0.5 },
    });
    const places = shrunk.allocation.bets.filter((x) => x.betType === "place");
    expect(places.length).toBeGreaterThan(0);
    for (const x of places) {
      expect(x.ev! / x.odds!).toBeCloseTo(mixed.get(Number(x.comboKey))!, 9);
    }
  });

  it("分析時(runAnalysis)の配分と、締切の再計算の配分が一致する。保存する馬の行の確率は寄せない", async () => {
    const b = await baseline();
    let saved: AnalysisRecord | undefined;
    let savedPlain: AnalysisRecord | undefined;
    const run = async (w: number | undefined, sink: (r: AnalysisRecord) => void) =>
      runAnalysis(RACE_ID, KAISAI_DATE, {
        scrape: async () => b.race,
        analyze: null,
        saveAnalysis: (record) => {
          sink(record);
          return 1;
        },
        allocationSettings: { ...ALL_BETS_SETTINGS, ...(w === undefined ? {} : { marketShrinkWeight: w }) },
        now: FIXED_NOW,
        llmSkipReason: "テスト: LLM なし",
      });
    await run(0.5, (r) => (saved = r));
    await run(undefined, (r) => (savedPlain = r));
    expect(viaJson(saved!.allocation)).toEqual(viaJson(recompute(b, b.horses, 0.5).allocation));
    expect(JSON.stringify(saved!.allocation!.bets)).not.toBe(JSON.stringify(savedPlain!.allocation!.bets));
    expect(viaJson(saved!.horses)).toEqual(viaJson(savedPlain!.horses));
  });

  it("単勝オッズが全馬に無ければ寄せない(従来と同じ配分)", async () => {
    const b = await baseline();
    const noWin: RaceData["odds"] = { ...b.race.odds, win: Object.fromEntries(Object.entries(b.race.odds.win).map(([k, v]) => [k, { ...v, odds: null }])) } as RaceData["odds"];
    expect(withoutWeight(recompute(b, b.horses, 0.5, noWin).allocation)).toEqual(withoutWeight(recompute(b, b.horses, undefined, noWin).allocation));
  });
});
