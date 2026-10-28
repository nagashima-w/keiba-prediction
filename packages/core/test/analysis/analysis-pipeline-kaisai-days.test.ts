import { describe, expect, it } from "vitest";
import { parseRaceId, type AnalysisRecord, type KaisaiDayRow } from "../../src/index.js";

import { runAnalysis, type AnalysisPipelineDeps } from "../../src/analysis/analysis-pipeline.js";
import { loadKaisaiDays } from "../../src/analysis/analysis-llm-materials.js";
import { buildPrompt } from "../../src/analyzer/build-prompt.js";
import { FIXED_NOW, KAISAI_DATE, RACE_ID, scrapeFixtureRace, stubAnalyze } from "../golden/pipeline-golden-scenarios.js";

/**
 * Issue #519: 芝の開催進行に、連続開催の通算の日数と、いまの柵の日数を足す配線。
 * フィクスチャのレースは 202603020211(中央・場コード 03・2026 年 2 回 2 日目・芝・柵 A)、開催日は 20260628。値は合成(実 API・実ネットワークには触れない)。
 * 規則そのものの境界は `test/analyzer/turf-wear-continuity.test.ts` が固定する。ここでは「読む・渡す・握る・読まない」を固定する。
 */

const TRACK = "03";

/** 1 つの回の行(日次 1..dates.length。柵は全日同じ)。 */
const meeting = (kai: number, dates: readonly string[], fence: string | null): KaisaiDayRow[] =>
  dates.map((kaisaiDate, i) => ({ trackCode: TRACK, year: 2026, kai, nichi: i + 1, kaisaiDate, fence }));

/** 1回(8 日。最終日 6/21)+ 2回の 1 日目(6/27)。1回の最終日から 2回の初日は 6 日で、連続している。 */
const CONTINUING = (fence1: string | null): KaisaiDayRow[] => [
  ...meeting(1, ["20260606", "20260607", "20260613", "20260614", "20260615", "20260619", "20260620", "20260621"], fence1),
  ...meeting(2, ["20260627"], "A"),
];
/** 1回(8 日。最終日 5/17)+ 2回の 1 日目(6/27)。間隔は 41 日で、連続していない。 */
const BROKEN: KaisaiDayRow[] = [
  ...meeting(1, ["20260502", "20260503", "20260509", "20260510", "20260516", "20260517", "20260523", "20260524"], "A"),
  ...meeting(2, ["20260627"], "A"),
];

type PromptIn = Parameters<NonNullable<AnalysisPipelineDeps["analyze"]>>[0];

async function baseDeps(overrides: Partial<AnalysisPipelineDeps>): Promise<AnalysisPipelineDeps> {
  const race = await scrapeFixtureRace();
  return { scrape: async () => race, analyze: null, saveAnalysis: () => 1, allocationSettings: null, now: FIXED_NOW, ...overrides };
}

async function runWithLlm(overrides: Partial<AnalysisPipelineDeps>, raceId = RACE_ID) {
  const captured: PromptIn[] = [];
  const saved: AnalysisRecord[] = [];
  await runAnalysis(raceId, KAISAI_DATE, await baseDeps({ analyze: stubAnalyze(captured), saveAnalysis: (r) => void saved.push(r), ...overrides }));
  expect(captured).toHaveLength(1);
  expect(saved).toHaveLength(1);
  return { input: captured[0]!, record: saved[0]! };
}

describe("芝の開催進行の過去の行の読み出し(中央の芝・LLM あり)", () => {
  it("場コード(raceId の 5〜6 桁目)と開催日(YYYYMMDD)で 1 回だけ読む", async () => {
    const calls: [string, string][] = [];
    await runWithLlm({ getKaisaiDays: (trackCode, date) => (calls.push([trackCode, date]), []) });
    expect(calls).toEqual([[TRACK, KAISAI_DATE]]);
  });

  it("続いているとき: 通算・続き始めた回・柵の日数が LLM の入力のヒントと、プロンプトの行に載る", async () => {
    const { input } = await runWithLlm({ getKaisaiDays: () => CONTINUING("B") });
    const hint = input.race.turfWearHint!;
    expect(hint.通算日次).toBe(10);
    expect(hint.連続開始回).toBe(1);
    expect(hint.連続開始年).toBe(2026);
    expect(hint.柵日数).toBe(2); // 1回が柵 B なので、2回の 1 日目 + 今日 = 2 日で止まる
    expect(buildPrompt(input)).toContain("芝コースの開催進行: 中央2回2日目(1回から連続開催で通算10日目。柵Aは2日目)。");
  });

  it("連続していないとき: 通算は足さず、柵の日数だけを足す", async () => {
    const { input } = await runWithLlm({ getKaisaiDays: () => BROKEN });
    expect(input.race.turfWearHint!.通算日次).toBeNull();
    expect(buildPrompt(input)).toContain("芝コースの開催進行: 中央2回2日目(柵Aは2日目)。");
  });

  it("依存を渡さない(機能オフ)ときは、従来の文とバイト同一", async () => {
    const { input } = await runWithLlm({});
    expect(input.race.turfWearHint!.note.startsWith("中央2回2日目(柵A)。")).toBe(true);
    expect(input.race.turfWearHint!.柵日数).toBeNull();
  });

  it("地方のレースでは、依存を呼ばない", async () => {
    let called = 0;
    await runWithLlm({ getKaisaiDays: () => (called += 1, CONTINUING("B")) }, parseRaceId("202644010211"));
    expect(called).toBe(0);
  });

  it("LLM を使わない分析(analyze=null)では、依存を呼ばない", async () => {
    let called = 0;
    await runAnalysis(RACE_ID, KAISAI_DATE, await baseDeps({ analyze: null, getKaisaiDays: () => (called += 1, CONTINUING("B")) }));
    expect(called).toBe(0);
  });

  it("芝以外(ダ・障)では、依存を呼ばない(loadKaisaiDays)", async () => {
    let called = 0;
    const deps = { getKaisaiDays: () => (called += 1, CONTINUING("B")) };
    for (const courseType of ["ダ", "障"] as const) {
      expect(await loadKaisaiDays(RACE_ID, courseType, KAISAI_DATE, deps)).toBeNull();
    }
    expect(called).toBe(0);
    expect(await loadKaisaiDays(RACE_ID, "芝", KAISAI_DATE, deps)).toHaveLength(9); // 前提: 芝なら読む
    expect(called).toBe(1);
  });
});

describe("芝の開催進行の過去の行の読み出しの失敗・壊れた値", () => {
  it("同期の throw・reject のどちらでも、分析は止まらず保存まで完了し、従来の文で続ける。onKaisaiDaysError に raceId とメッセージが渡る", async () => {
    for (const make of [
      (): never => {
        throw new Error("D1 の失敗(同期)");
      },
      async (): Promise<never> => {
        await Promise.resolve();
        throw new Error("D1 の失敗(非同期)");
      },
    ]) {
      const errors: { raceId: string; message: string }[] = [];
      const plain = await runWithLlm({});
      const { input, record } = await runWithLlm({ getKaisaiDays: make, onKaisaiDaysError: (info) => void errors.push({ raceId: info.raceId, message: info.message }) });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.raceId).toBe(RACE_ID);
      expect(errors[0]!.message).toContain("D1 の失敗");
      expect(input.race.turfWearHint).toEqual(plain.input.race.turfWearHint);
      expect(record).toEqual(plain.record);
    }
  });

  it("onKaisaiDaysError が無くても握る", async () => {
    const { input } = await runWithLlm({
      getKaisaiDays: () => {
        throw new Error("x");
      },
    });
    expect(input.race.turfWearHint!.通算日次).toBeNull();
  });

  it("配列でない値は null、壊れた行(形が違う・小数・0・柵が数値)は捨てて、使える行だけを残す", async () => {
    const good = meeting(2, ["20260627"], "A")[0]!;
    const garbage: unknown[] = [
      null,
      "x",
      { ...good, year: 2026.5 },
      { ...good, kai: 0 },
      { ...good, nichi: "1" },
      { ...good, fence: 3 },
      { ...good, trackCode: 3 },
      { ...good, kaisaiDate: 20260627 },
      good,
    ];
    expect(await loadKaisaiDays(RACE_ID, "芝", KAISAI_DATE, { getKaisaiDays: () => garbage as KaisaiDayRow[] })).toEqual([good]);
    expect(await loadKaisaiDays(RACE_ID, "芝", KAISAI_DATE, { getKaisaiDays: () => null as unknown as KaisaiDayRow[] })).toBeNull();
  });
});
