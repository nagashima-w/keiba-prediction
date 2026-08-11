import { parseRaceId } from "@keiba/core";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { createPipelineDeps } from "../src/main/pipeline-deps.js";

/**
 * pipeline-deps.ts の deps.scrape が core scrapeRace へ渡す options(第3引数)の配線を検証する
 * (機能D-2c第1段・第3段・Issue #28)。
 *
 * scrapeRace自体(URL生成ロジック)は既に @keiba/core 側でテスト済み(scrape-race.test.ts。
 * 「includeComboOdds:falseを明示しても、省略時と完全に同じURL列になること」の回帰テストを第1段で
 * 追加済み)なので、ここでは「pipeline-depsが正しい引数(config.includeComboOdds ?? false)を
 * 渡しているか」だけをピンポイントで確認する。実HTTP・実DBは使わない(scrapeRace自体をスパイに
 * 差し替える)。
 */
const { scrapeRaceMock } = vi.hoisted(() => ({
  scrapeRaceMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
}));

vi.mock("@keiba/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keiba/core")>();
  return { ...actual, scrapeRace: scrapeRaceMock };
});

describe("createPipelineDeps: deps.scrape の scrapeRace 配線(機能D-2c第1段・第3段・Issue #28)", () => {
  beforeEach(() => {
    scrapeRaceMock.mockClear();
  });

  it("config.includeComboOdds未指定なら第3引数として { includeComboOdds: false } を渡すこと(対応表D2・受け入れ条件2: 既定OFF)", async () => {
    const r = createPipelineDeps({ dbPath: ":memory:" });
    try {
      await r.deps.scrape(parseRaceId("202605020811"));
    } finally {
      r.close();
    }

    expect(scrapeRaceMock).toHaveBeenCalledTimes(1);
    const call = scrapeRaceMock.mock.calls[0]!;
    expect(call).toHaveLength(3);
    const [raceIdArg, scrapeDepsArg, optionsArg] = call as [
      unknown,
      { fetcher?: { fetchText?: unknown } },
      unknown,
    ];
    expect(raceIdArg).toBe("202605020811");
    // fetcher(CachedFetcher)は従来どおり渡っている(対応表D1: 第2引数の形は変えていない。
    // now・ttlは渡さない)。
    expect(typeof scrapeDepsArg.fetcher?.fetchText).toBe("function");
    expect((scrapeDepsArg as Record<string, unknown>).now).toBeUndefined();
    expect((scrapeDepsArg as Record<string, unknown>).ttl).toBeUndefined();
    // 第3引数(ScrapeRaceOptions)にincludeComboOdds:falseだけが明示的に渡っていること
    // (bypassOddsCache等の他フィールドは追加していない。対応表D3・D4)。
    expect(optionsArg).toEqual({ includeComboOdds: false });
  });

  it("config.includeComboOdds:false を明示しても第3引数は { includeComboOdds: false }(??ではなく||等に緩めていないことの確認)", async () => {
    const r = createPipelineDeps({ dbPath: ":memory:", includeComboOdds: false });
    try {
      await r.deps.scrape(parseRaceId("202605020811"));
    } finally {
      r.close();
    }
    const [, , optionsArg] = scrapeRaceMock.mock.calls[0]!;
    expect(optionsArg).toEqual({ includeComboOdds: false });
  });

  it("config.includeComboOdds:true を渡すと第3引数は { includeComboOdds: true }(対応表D2・受け入れ条件4: ONのときだけtrue)", async () => {
    const r = createPipelineDeps({ dbPath: ":memory:", includeComboOdds: true });
    try {
      await r.deps.scrape(parseRaceId("202605020811"));
    } finally {
      r.close();
    }
    const [, , optionsArg] = scrapeRaceMock.mock.calls[0]!;
    expect(optionsArg).toEqual({ includeComboOdds: true });
  });
});
