import { parseRaceId } from "@keiba/core";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { createPipelineDeps } from "../src/main/pipeline-deps.js";

/**
 * pipeline-deps.ts の deps.scrape が core scrapeRace へ渡す options(第3引数)の配線を検証する
 * (機能D-2c第1段・Issue #28)。
 *
 * scrapeRace自体(URL生成ロジック)は既に @keiba/core 側でテスト済み(scrape-race.test.ts。
 * 「includeComboOdds:falseを明示しても、省略時と完全に同じURL列になること」の回帰テストを本タスクで
 * 追加済み)なので、ここでは「pipeline-depsが正しい引数(includeComboOdds:false)を渡しているか」
 * だけをピンポイントで確認する。実HTTP・実DBは使わない(scrapeRace自体をスパイに差し替える)。
 */
const { scrapeRaceMock } = vi.hoisted(() => ({
  scrapeRaceMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
}));

vi.mock("@keiba/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keiba/core")>();
  return { ...actual, scrapeRace: scrapeRaceMock };
});

describe("createPipelineDeps: deps.scrape の scrapeRace 配線(機能D-2c第1段・Issue #28)", () => {
  beforeEach(() => {
    scrapeRaceMock.mockClear();
  });

  it("scrapeRaceへ第3引数として { includeComboOdds: false } を明示的に渡すこと(既定は組合せオッズを取得しない)", async () => {
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
    // fetcher(CachedFetcher)は従来どおり渡っている(第2引数の形は変えていない)。
    expect(typeof scrapeDepsArg.fetcher?.fetchText).toBe("function");
    // 第3引数(ScrapeRaceOptions)にincludeComboOdds:falseだけが明示的に渡っていること
    // (bypassOddsCache等の他フィールドは追加していない)。
    expect(optionsArg).toEqual({ includeComboOdds: false });
  });
});
