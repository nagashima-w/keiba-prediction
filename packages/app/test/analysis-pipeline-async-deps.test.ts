import { describe, expect, it } from "vitest";
import type { AnalysisRecord, RaceResultDetail } from "@keiba/core";

import {
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../src/main/analysis-pipeline.js";
import {
  ALL_BETS_SETTINGS,
  FIXED_NOW,
  KAISAI_DATE,
  RACE_ID,
  sameDayDetailOf,
  scrapeFixtureRace,
  stubAnalyze,
} from "./golden/pipeline-golden-scenarios.js";

/**
 * Issue #176(#164-a)AC-a3・AC-a4: runAnalysis の deps を非同期でも受け取れること(クラウド版は D1 が非同期のため)、
 * 当日傾向を「前のレース分だけ・1回のバッチ」で読めること。exe 側(同期の束縛)の挙動は変わらない(golden が別に固定)。
 */

const PRECEDING_IDS = Array.from({ length: 10 }, (_, i) => `2026030202${String(i + 1).padStart(2, "0")}`);

async function baseDeps(overrides: Partial<AnalysisPipelineDeps>): Promise<AnalysisPipelineDeps> {
  const race = await scrapeFixtureRace();
  return {
    scrape: async () => race,
    analyze: null,
    saveAnalysis: () => 1,
    allocationSettings: null,
    now: FIXED_NOW,
    ...overrides,
  };
}

/** 次のマイクロタスク・タイマーを何度か回す(非同期の完了を待たずに戻る実装を検出するため、解決を遅らせる側で使う)。 */
const later = <T>(value: T, ms = 20): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe("saveAnalysis の非同期(Issue #176 AC-a3)", () => {
  it("遅れて resolve する saveAnalysis を await する: runAnalysis が戻った時点で、保存は完了している", async () => {
    const log: string[] = [];
    let savedRecord: AnalysisRecord | null = null;
    const deps = await baseDeps({
      saveAnalysis: async (record) => {
        log.push("保存開始");
        await later(null);
        savedRecord = record;
        log.push("保存完了");
        return { id: 7, detail: "stored" };
      },
    });
    await runAnalysis(RACE_ID, KAISAI_DATE, deps);
    log.push("runAnalysis 戻り");
    expect(log).toEqual(["保存開始", "保存完了", "runAnalysis 戻り"]);
    expect(savedRecord).not.toBeNull();
  });

  it("saveAnalysis が reject したら、runAnalysis も同じエラーで reject する(握りつぶさない)", async () => {
    const deps = await baseDeps({
      saveAnalysis: async () => {
        await later(null, 5);
        throw new Error("D1 への保存に失敗");
      },
    });
    await expect(runAnalysis(RACE_ID, KAISAI_DATE, deps)).rejects.toThrow("D1 への保存に失敗");
  });

  it("同期の saveAnalysis が throw した場合も、従来どおり runAnalysis が reject する(exe の挙動)", async () => {
    const deps = await baseDeps({
      saveAnalysis: () => {
        throw new Error("同期の保存失敗");
      },
    });
    await expect(runAnalysis(RACE_ID, KAISAI_DATE, deps)).rejects.toThrow("同期の保存失敗");
  });
});

describe("当日傾向の読み出し(Issue #176 AC-a3・AC-a4)", () => {
  it("同期の getRaceResultDetail(exe の束縛)は従来どおり、01〜10R を ID ごとに1回ずつ・昇順で読み、当日傾向がプロンプトに入る", async () => {
    const lookups: string[] = [];
    const captured: Parameters<NonNullable<AnalysisPipelineDeps["analyze"]>>[0][] = [];
    await runAnalysis(
      RACE_ID,
      KAISAI_DATE,
      await baseDeps({
        analyze: stubAnalyze(captured),
        getRaceResultDetail: (id) => {
          lookups.push(id);
          return sameDayDetailOf(id);
        },
      }),
    );
    expect(lookups).toEqual(PRECEDING_IDS);
    expect(captured[0]!.race.sameDayTrend).not.toBeNull();
  });

  it("非同期のバッチ(遅れて resolve)でも、同期の単発と同じ当日傾向がプロンプトに入る(await している)", async () => {
    const syncCaptured: Parameters<NonNullable<AnalysisPipelineDeps["analyze"]>>[0][] = [];
    const asyncCaptured: Parameters<NonNullable<AnalysisPipelineDeps["analyze"]>>[0][] = [];
    await runAnalysis(
      RACE_ID,
      KAISAI_DATE,
      await baseDeps({ analyze: stubAnalyze(syncCaptured), getRaceResultDetail: (id) => sameDayDetailOf(id) }),
    );
    await runAnalysis(
      RACE_ID,
      KAISAI_DATE,
      await baseDeps({
        analyze: stubAnalyze(asyncCaptured),
        getRaceResultDetails: (ids) => later(new Map(ids.map((id) => [id, sameDayDetailOf(id)])), 5),
      }),
    );
    expect(syncCaptured[0]!.race.sameDayTrend).not.toBeNull(); // 前提: 当日傾向が実際に入っている(空振りでない)
    expect(asyncCaptured[0]!.race.sameDayTrend).toEqual(syncCaptured[0]!.race.sameDayTrend);
  });

  it("バッチの getRaceResultDetails: 1回だけ呼ばれ、渡る ID は自レース(11R)より前の 01〜10R だけ(自レース・後続の 12R を含まない)", async () => {
    const calls: (readonly string[])[] = [];
    const captured: Parameters<NonNullable<AnalysisPipelineDeps["analyze"]>>[0][] = [];
    await runAnalysis(
      RACE_ID,
      KAISAI_DATE,
      await baseDeps({
        analyze: stubAnalyze(captured),
        getRaceResultDetails: async (ids) => {
          calls.push([...ids]);
          return new Map<string, RaceResultDetail | undefined>(ids.map((id) => [id, sameDayDetailOf(id)]));
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(PRECEDING_IDS);
    expect(calls[0]).not.toContain(RACE_ID);
    expect(calls[0]).not.toContain("202603020212");
    expect(captured[0]!.race.sameDayTrend).not.toBeNull();
  });

  it("バッチの結果が、1件ずつの束縛と同じ当日傾向になる(Map の引き方で値が変わらない)", async () => {
    const single: Parameters<NonNullable<AnalysisPipelineDeps["analyze"]>>[0][] = [];
    const batch: Parameters<NonNullable<AnalysisPipelineDeps["analyze"]>>[0][] = [];
    await runAnalysis(RACE_ID, KAISAI_DATE, await baseDeps({ analyze: stubAnalyze(single), getRaceResultDetail: (id) => sameDayDetailOf(id) }));
    await runAnalysis(
      RACE_ID,
      KAISAI_DATE,
      await baseDeps({
        analyze: stubAnalyze(batch),
        getRaceResultDetails: (ids) => new Map(ids.map((id) => [id, sameDayDetailOf(id)])),
      }),
    );
    expect(batch[0]!.race.sameDayTrend).toEqual(single[0]!.race.sameDayTrend);
  });

  it("バッチと単発の両方が渡されたら、バッチを使い、単発は呼ばれない", async () => {
    let singleCalls = 0;
    let batchCalls = 0;
    await runAnalysis(
      RACE_ID,
      KAISAI_DATE,
      await baseDeps({
        analyze: stubAnalyze([]),
        getRaceResultDetail: () => {
          singleCalls += 1;
          return undefined;
        },
        getRaceResultDetails: (ids) => {
          batchCalls += 1;
          return new Map(ids.map((id) => [id, sameDayDetailOf(id)]));
        },
      }),
    );
    expect(batchCalls).toBe(1);
    expect(singleCalls).toBe(0);
  });

  it("バッチが返さなかった(Map に無い)レースは、結果なし(undefined)として扱う: 1件も返さなければ当日傾向は null", async () => {
    const captured: Parameters<NonNullable<AnalysisPipelineDeps["analyze"]>>[0][] = [];
    let batchCalls = 0;
    await runAnalysis(
      RACE_ID,
      KAISAI_DATE,
      await baseDeps({
        analyze: stubAnalyze(captured),
        getRaceResultDetails: () => {
          batchCalls += 1;
          return new Map();
        },
      }),
    );
    expect(batchCalls).toBe(1); // 前提: バッチが実際に使われている(使われなくても null になるので、これを先に固定する)
    expect(captured).toHaveLength(1);
    expect(captured[0]!.race.sameDayTrend).toBeNull();
  });

  it("LLM をスキップする経路(analyze=null)では、バッチも単発も呼ばない(無駄な読み出しを増やさない)", async () => {
    let calls = 0;
    await runAnalysis(
      RACE_ID,
      KAISAI_DATE,
      await baseDeps({
        analyze: null,
        allocationSettings: ALL_BETS_SETTINGS,
        getRaceResultDetail: () => {
          calls += 1;
          return undefined;
        },
        getRaceResultDetails: () => {
          calls += 1;
          return new Map();
        },
      }),
    );
    expect(calls).toBe(0);
  });
});
