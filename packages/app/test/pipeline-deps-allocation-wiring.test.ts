import { parseRaceId } from "@keiba/core";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { createPipelineDeps } from "../src/main/pipeline-deps.js";

/**
 * pipeline-deps.ts の deps.allocationSettings への配線を検証する(Issue #59・#56-3・AC1)。
 *
 * `pipeline-deps-combo-odds-wiring.test.ts` と同じ流儀(scrapeRace自体をスパイに差し替え、
 * 実HTTP・実DBは使わない)。本ファイルはさらに、`config.includeComboOdds` が
 * `deps.scrape`(scrapeRaceの第3引数)と`deps.allocationSettings.includeComboOdds`の**両方**へ
 * 同じ値として届くこと(1箇所解決の実証。#59 4節「二重定義を作らない」)を確認する。
 */
const { scrapeRaceMock } = vi.hoisted(() => ({
  scrapeRaceMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
}));

vi.mock("@keiba/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keiba/core")>();
  return { ...actual, scrapeRace: scrapeRaceMock };
});

describe("createPipelineDeps: deps.allocationSettings の配線(Issue #59・AC1)", () => {
  beforeEach(() => {
    scrapeRaceMock.mockClear();
  });

  it("config.allocationSettings未指定なら deps.allocationSettings は null(この呼び出しでは配分計算を行わない)", () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    try {
      expect(r.deps.allocationSettings).toBeNull();
    } finally {
      r.close();
    }
  });

  it("config.allocationSettings(5項目)を渡すと、includeComboOddsを合成した6項目がdeps.allocationSettingsへ届くこと(includeComboOdds=true)", async () => {
    const r = createPipelineDeps({
      dbPath: ":memory:",
      includeComboOdds: true,
      allocationSettings: {
        bankroll: 300000,
        perRaceCap: 20000,
        kellyFraction: 0.5,
        includeWideInAllocation: true,
        includeTrioInAllocation: false,
      },
    });
    try {
      expect(r.deps.allocationSettings).toEqual({
        bankroll: 300000,
        perRaceCap: 20000,
        kellyFraction: 0.5,
        includeComboOdds: true,
        includeWideInAllocation: true,
        includeTrioInAllocation: false,
      });
      // 同じincludeComboOdds(true)がscrapeRaceの第3引数にも届いていること(単一解決の実証)。
      await r.deps.scrape(parseRaceId("202605020811"));
      const [, , optionsArg] = scrapeRaceMock.mock.calls[0]!;
      expect(optionsArg).toEqual({ includeComboOdds: true });
    } finally {
      r.close();
    }
  });

  it("config.includeComboOdds未指定(既定false)でも、config.allocationSettingsのincludeComboOddsはscrapeと同じfalseになること", async () => {
    const r = createPipelineDeps({
      dbPath: ":memory:",
      allocationSettings: {
        bankroll: 300000,
        perRaceCap: 20000,
        kellyFraction: 0.5,
        includeWideInAllocation: true,
        includeTrioInAllocation: true,
      },
    });
    try {
      expect(r.deps.allocationSettings).toMatchObject({ includeComboOdds: false });
      await r.deps.scrape(parseRaceId("202605020811"));
      const [, , optionsArg] = scrapeRaceMock.mock.calls[0]!;
      expect(optionsArg).toEqual({ includeComboOdds: false });
    } finally {
      r.close();
    }
  });
});
