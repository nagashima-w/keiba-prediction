import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildPrompt,
  parseHorseResults,
  parseKaisaiDate,
  parseRaceId,
  scrapeRace,
  type AnalysisRecord,
  type BuildPromptInput,
  type RaceFetcher,
} from "../../src/index.js";
import { describe, expect, it } from "vitest";

import { runAnalysis, type AnalysisPipelineDeps } from "../../src/analysis/analysis-pipeline.js";

/**
 * analysis-pipeline-nonstart.test.ts — Issue #261。
 * 前週に出走除外になった新馬(戦績が「除」の1行だけ)が、`scrapeRace`→`runAnalysis`→プロンプトで
 * 「実戦経験のある馬」にならないこと。実例は東京5R(2026-10-11)の 3 番 マイネルユンフェンで、
 * 旧実装のプロンプトの行は「過去ペース傾向=後傾(先行有利)1回」「レース間隔=連闘〜中3週」
 * 「騎手=…(前走から継続)」だった(除外の行のペース欄にはそのレース全体の値が入っている)。
 * 実物の応答は `fixtures/horse_results_2024103584.json`。出馬表は福島 202603020211 の実物(16頭)を使い、
 * 分析日だけを 2026-10-11 に置く(除外の行は 2026/10/04 なので、分析日が 6/28 のままだと #39 の
 * 日付絞りで消えて空振りになる)。
 */

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

const NON_START_FIXTURE = loadFixture("horse_results_2024103584.json");
const PLAIN_RUNS_FIXTURE = loadFixture("horse_results_2021105857.json");
const RACE_ID = "202603020211";
const KAISAI = "20261011";
const FIXED_NOW = new Date("2026-10-11T01:00:00.000Z");
/** 出馬表(福島・16頭)の馬番1・2の馬ID。 */
const HORSE_1 = "2023103386";
const HORSE_2 = "2023105684";

/** 実走の戦績の先頭に、実物の「除」の行を足した戦績JSON。 */
function runsPlusNonStart(): string {
  const row = (JSON.parse(NON_START_FIXTURE).data as string).match(/<tbody>([\s\S]*?)<\/tbody>/)![1]!;
  const runs = JSON.parse(PLAIN_RUNS_FIXTURE) as { status: string; data: string };
  return JSON.stringify({ ...runs, data: runs.data.replace("<tbody>", `<tbody>${row}`) });
}

/** 戦績の応答の代わりに、取得の失敗(例外)を表す値。 */
const FETCH_FAILS = Symbol("fetch-fails");

function fetcherFor(resultsByHorse: Record<string, string | typeof FETCH_FAILS>): RaceFetcher {
  return {
    async fetchText(url: string): Promise<string> {
      if (url.includes("shutuba.html")) return loadFixture("shutuba_202603020211.html");
      if (url.includes("ajax_horse_results")) {
        const id = /[?&]id=([^&]+)/.exec(url)![1]!;
        const assigned = resultsByHorse[id];
        if (assigned === FETCH_FAILS) throw new Error("戦績の取得に失敗(テスト用)");
        return assigned ?? PLAIN_RUNS_FIXTURE;
      }
      if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
      if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
      throw new Error(`未知のURL: ${url}`);
    },
  };
}

/** 分析を実行し、LLM に渡った入力・プロンプト全文・結果の行を返す(LLM は呼ばず、キャプチャ用の偽の analyze)。 */
async function analyze(resultsByHorse: Record<string, string | typeof FETCH_FAILS>) {
  let captured: BuildPromptInput | null = null;
  const saved: AnalysisRecord[] = [];
  const deps: AnalysisPipelineDeps = {
    scrape: (raceId) =>
      scrapeRace(raceId, { fetcher: fetcherFor(resultsByHorse), now: () => FIXED_NOW }),
    analyze: async (input) => {
      captured = input;
      return { horses: [], fallback: false, retryCount: 0, fallbackReason: null, rawResponse: "{}" };
    },
    saveAnalysis: (rec) => {
      saved.push(rec);
      return 1;
    },
    allocationSettings: null,
    now: () => FIXED_NOW,
  };
  const result = await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
  const input = captured as BuildPromptInput | null;
  expect(input).not.toBeNull(); // 前提固定。
  return { result, input: input!, prompt: buildPrompt(input!) };
}

describe("runAnalysis: 戦績の走数をプロンプトに渡す(Issue #261。初出走の明示の入力)", () => {
  it("除外の1行だけの馬は careerRunCount=0 でプロンプトの行に「戦績=初出走(出走経験なし)」が出ること", async () => {
    const { input, prompt } = await analyze({ [HORSE_1]: NON_START_FIXTURE });
    expect(input.horses.find((h) => h.umaban === 1)!.careerRunCount).toBe(0);
    expect(prompt.split("\n").find((l) => l.startsWith("馬番1 "))).toContain("3着内率=");
    expect(prompt.split("\n").find((l) => l.startsWith("馬番1 "))).toContain("戦績=初出走(出走経験なし), 脚質=");
  });

  it("実走のある馬は careerRunCount が実走の件数で、行に初出走は出ないこと", async () => {
    const { input, prompt } = await analyze({});
    const expected = parseHorseResults(PLAIN_RUNS_FIXTURE).length;
    expect(expected).toBeGreaterThan(0); // 前提固定。
    // #39 の日付絞りは分析日 2026-10-11 より前の走を全部残す(フィクスチャの最終走は 2026/06/28)。
    expect(input.horses.find((h) => h.umaban === 2)!.careerRunCount).toBe(expected);
    expect(prompt.split("\n").find((l) => l.startsWith("馬番2 "))).not.toContain("初出走");
  });

  it("戦績の取得に失敗した馬は careerRunCount=null で、初出走とは書かないこと(0走と取得失敗を区別する)", async () => {
    const { input, prompt, result } = await analyze({ [HORSE_1]: FETCH_FAILS });
    expect(input.horses.find((h) => h.umaban === 1)!.careerRunCount).toBeNull();
    expect(result.rows.find((r) => r.umaban === 1)!.careerRunCount).toBeNull();
    expect(prompt.split("\n").find((l) => l.startsWith("馬番1 "))).not.toContain("初出走");
  });
});

describe("runAnalysis: 前週に除外になった新馬は、実戦経験のある馬にならない(Issue #261)", () => {
  it("除外の1行だけの馬は、実戦経験を示す項目(ペース傾向・間隔・前走騎手・馬体重の前走値)が出ず、戦績0走になること", async () => {
    const { result, input, prompt } = await analyze({ [HORSE_1]: NON_START_FIXTURE });
    const horse = input.horses.find((h) => h.umaban === 1)!;
    expect(horse.runs).toEqual([]);
    expect(horse.runConditions).toEqual([]);
    expect(horse.restInterval).toBeNull();
    expect(horse.jockeyChange).toBeNull();
    expect(horse.bodyWeightTrend?.note ?? "").not.toContain("474");
    expect(result.rows.find((r) => r.umaban === 1)!.careerRunCount).toBe(0);

    const line = prompt.split("\n").find((l) => l.startsWith("馬番1 "))!;
    expect(line).toContain("過去ペース傾向=データ不足");
    expect(line).toContain("レース間隔=不明");
    expect(line).not.toContain("後傾");
    expect(line).not.toContain("前走から継続");
    expect(line).not.toContain("連闘");
  });

  it("除外の行が混ざった馬は、除外の行が無い場合と、LLM に渡る入力・3着内率が完全に一致すること", async () => {
    const baseline = await analyze({});
    // 前提: 土台の馬2は実走の戦績があり、最終走(2026/06/28)から分析日まで106日=休み明け。
    // 除外の行(2026/10/04)を数えてしまうと間隔は「連闘〜中3週」になり、この前提とは食い違う。
    const baseHorse2 = baseline.input.horses.find((h) => h.umaban === 2)!;
    expect(baseHorse2.restInterval).toBe("休み明け");
    expect(parseHorseResults(runsPlusNonStart())).toHaveLength(parseHorseResults(PLAIN_RUNS_FIXTURE).length + 1);

    const mixed = await analyze({ [HORSE_2]: runsPlusNonStart() });
    const mixedHorse2 = mixed.input.horses.find((h) => h.umaban === 2)!;
    expect(mixedHorse2).toEqual(baseHorse2);
    expect(mixed.result.rows.find((r) => r.umaban === 2)!.prior).toBe(
      baseline.result.rows.find((r) => r.umaban === 2)!.prior,
    );
    expect(mixed.result.rows.find((r) => r.umaban === 2)!.careerRunCount).toBe(
      baseline.result.rows.find((r) => r.umaban === 2)!.careerRunCount,
    );
  });
});
