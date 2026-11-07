import { describe, expect, it, vi } from "vitest";
import { parseRaceId, type AnalysisRecord } from "../../src/index.js";
import { runAnalysis, type AnalysisPipelineDeps } from "../../src/analysis/analysis-pipeline.js";
import { buildPrompt } from "../../src/analyzer/build-prompt.js";
import { SHADOW_MODEL_NODDS, SHADOW_MODEL_ODDS } from "../../src/ev/stat-shadow.js";
import { ALL_BETS_SETTINGS, FIXED_NOW, KAISAI_DATE, RACE_ID, scrapeFixtureRace, stubAnalyze } from "../golden/pipeline-golden-scenarios.js";

vi.setConfig({ testTimeout: 60_000 }); // 重いフィクスチャの分析を何度も走らせる。負荷の高い環境でも 5 秒の既定で落ちないようにする

/**
 * Issue #649 段階 2・3: 統計モデルの並走(影の計算)の配線。
 * 最重要の不変条件: **影の計算は、買い目・配分・EV・LLM のプロンプトと入力・戻り値のどれも変えない**(記録の `shadow` に載るだけ)。
 * フィクスチャのレースは 202603020211(中央・芝)、開催日は 20260628。
 */

type PromptIn = Parameters<NonNullable<AnalysisPipelineDeps["analyze"]>>[0];

async function run(overrides: Partial<AnalysisPipelineDeps>, oddsStatus?: "result" | "middle" | "yoso", raceId = RACE_ID) {
  const base = await scrapeFixtureRace();
  const race = oddsStatus === undefined ? base : { ...base, odds: { ...base.odds, oddsStatus } };
  const captured: PromptIn[] = [];
  const saved: AnalysisRecord[] = [];
  const result = await runAnalysis(raceId, KAISAI_DATE, {
    scrape: async () => race,
    analyze: stubAnalyze(captured),
    saveAnalysis: (r) => void saved.push(r),
    allocationSettings: ALL_BETS_SETTINGS,
    now: FIXED_NOW,
    ...overrides,
  });
  expect(captured).toHaveLength(1);
  expect(saved).toHaveLength(1);
  return { input: captured[0]!, record: saved[0]!, result, race };
}

const withoutShadow = (r: AnalysisRecord): unknown => {
  const { shadow: _s, ...rest } = r;
  return rest;
};

describe("影の計算が既存の出力を変えない(プロンプト・入力・戻り値・配分・EV・確率)", () => {
  it("shadow を付けても付けなくても、LLM の入力・プロンプトの全文・戻り値・shadow 以外の保存レコードは完全に同じ", async () => {
    const off = await run({});
    const on = await run({ shadow: true });
    // 前提(空振り防止): 影が実際に作られていて、配分と買い目がある。
    expect(on.record.shadow).toBeDefined();
    expect(on.record.allocation?.bets.length ?? 0).toBeGreaterThan(0);
    expect(on.input).toEqual(off.input);
    expect(buildPrompt(on.input)).toBe(buildPrompt(off.input));
    expect(on.result).toEqual(off.result);
    expect(withoutShadow(on.record)).toEqual(withoutShadow(off.record));
  });
  it("shadow を付けない既定では、記録に shadow のキー自体が無い(従来の記録と同じ形)", async () => {
    const off = await run({});
    expect("shadow" in off.record).toBe(false);
    const explicitFalse = await run({ shadow: false });
    expect("shadow" in explicitFalse.record).toBe(false);
  });
  it("プロンプトの全文に、影の計算の確率・モデル名は現れない", async () => {
    const on = await run({ shadow: true });
    const prompt = buildPrompt(on.input);
    expect(prompt).not.toContain("lr649");
    expect(prompt).not.toContain(SHADOW_MODEL_ODDS);
    for (const p of on.record.shadow!.probs.slice(0, 5)) {
      expect(prompt).not.toContain(String(p.winProb));
    }
  });
});

describe("影の記録の中身", () => {
  it("中央・単勝オッズが予想でない: 全頭の馬ごとの記録と、2 モデルの確率が載る。入力に使ったオッズは取得したオッズそのもの", async () => {
    const { record, race } = await run({ shadow: true }, "middle");
    const s = record.shadow!;
    const umabans = race.horses.map((h) => h.shutuba.umaban).sort((a, b) => a - b);
    expect(s.horses.map((h) => h.umaban)).toEqual(umabans);
    expect(umabans.length).toBeGreaterThanOrEqual(5);
    expect(s.probs.length).toBe(umabans.length * 2);
    expect(new Set(s.probs.map((p) => p.model))).toEqual(new Set([SHADOW_MODEL_ODDS, SHADOW_MODEL_NODDS]));
    for (const h of s.horses) {
      expect(h.inputWinOdds).toBe(race.odds.win[h.umaban]!.odds);
    }
    // 市場の確率は合計 1。
    expect(s.horses.reduce((t, h) => t + (h.marketQ ?? 0), 0)).toBeCloseTo(1, 9);
    // 勝率の合計は 1、3着内率の合計は 3(モデルごと)。
    for (const m of [SHADOW_MODEL_ODDS, SHADOW_MODEL_NODDS]) {
      const mine = s.probs.filter((p) => p.model === m);
      expect(mine.reduce((t, p) => t + p.winProb, 0)).toBeCloseTo(1, 6);
      expect(mine.reduce((t, p) => t + p.top3Prob, 0)).toBeCloseTo(3, 6);
    }
  });
  it("印は、取得した戦績から作られる(戦績の無い馬は 4 つとも null、ある馬は null でない印を持つ)", async () => {
    const { record, race } = await run({ shadow: true }, "result");
    const hasRuns = new Map(race.horses.map((h) => [h.shutuba.umaban, (h.results ?? []).length > 0]));
    expect([...hasRuns.values()].some((v) => v)).toBe(true);
    for (const h of record.shadow!.horses) {
      const flags = [h.flagLongRest, h.flagSurfaceChange, h.flagFrontRunner, h.flagLongshotSlump];
      if (hasRuns.get(h.umaban)) {
        expect(h.flagLongRest).not.toBeNull();
      } else {
        expect(flags).toEqual([null, null, null, null]);
      }
    }
  });
  it("単勝オッズが予想(yoso)の分析では作らない", async () => {
    const { record } = await run({ shadow: true }, "yoso");
    expect("shadow" in record).toBe(false);
  });
  it("地方のレースでは作らない(学習が中央だけ)", async () => {
    const { record } = await run({ shadow: true }, "result", parseRaceId("202654041208"));
    expect("shadow" in record).toBe(false);
  });
  it("1 頭でもオッズが欠けたら、オッズなしの版だけ。q と入力のオッズは全馬 null(欠けた馬だけ null にしない)", async () => {
    const base = await scrapeFixtureRace();
    const first = base.horses[0]!.shutuba.umaban;
    const race = { ...base, odds: { ...base.odds, oddsStatus: "result" as const, win: { ...base.odds.win, [first]: { odds: null, ninki: null } } } };
    const saved: AnalysisRecord[] = [];
    await runAnalysis(RACE_ID, KAISAI_DATE, { scrape: async () => race, analyze: null, saveAnalysis: (r) => void saved.push(r), allocationSettings: null, now: FIXED_NOW, shadow: true });
    const s = saved[0]!.shadow!;
    expect(new Set(s.probs.map((p) => p.model))).toEqual(new Set([SHADOW_MODEL_NODDS]));
    expect(s.horses.every((h) => h.marketQ === null)).toBe(true);
    expect(s.horses.find((h) => h.umaban === first)!.inputWinOdds).toBeNull();
    expect(s.horses.filter((h) => h.inputWinOdds !== null).length).toBe(s.horses.length - 1);
  });
});
