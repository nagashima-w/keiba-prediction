import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import {
  excludeNonStartResults,
  isNonStartResult,
  parseHorseResults,
} from "../../src/scraper/parse-horse-results.js";
import { scrapeRace, type RaceFetcher } from "../../src/scraper/scrape-race.js";
import type { FinishPosition, HorseRaceResult } from "../../src/scraper/types.js";

/**
 * Issue #261 — 出走しなかった行(除外・取消)を戦績から外す。
 *
 * 背景: 東京5R(2026-10-11・2歳新馬)の 3 番 マイネルユンフェンは、10/04 の東京5R(4回東京2日目・2歳新馬)で出走除外に
 * なっていた。netkeiba の戦績には着順セル「除」の行が残り、ペース欄にはそのレース全体の前後半3Fが入る。
 * 旧実装はこの行を1走として扱い、「過去ペース傾向=後傾(先行有利)1回」「レース間隔=連闘〜中3週」
 * 「前走から継続」をプロンプトに出し、3着内率(ローテーション適性)まで動かしうる状態だった。
 * 実物の応答は `fixtures/horse_results_2024103584.json`(2026-10-11 に取得。1行のみ)。
 *
 * 観測したのは「除」だけで、「取」は未観測。そのため先頭一致(除・除外・取・取消)で受ける。
 */

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

const NON_START_FIXTURE = loadFixture("horse_results_2024103584.json");
/** 実走が23行ある実フィクスチャ(除外の行を足す土台)。 */
const RUNS_FIXTURE_NAME = "horse_results_2021105857.json";

/** 実フィクスチャの1行を土台に、着順だけ差し替えた行を作る。 */
function rowWith(finishPosition: FinishPosition | null): HorseRaceResult {
  const base = parseHorseResults(loadFixture(RUNS_FIXTURE_NAME))[0]!;
  return { ...base, finishPosition };
}

describe("実物の応答(マイネルユンフェン・10/04 東京5R で除外)", () => {
  it("パーサは「除」の行を1行返し、着順は非数値の「除」・ペースにはレース全体の値が入っていること(除去の前提)", () => {
    const rows = parseHorseResults(NON_START_FIXTURE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.finishPosition).toEqual({ kind: "非数値", text: "除" });
    expect(rows[0]!.pace).toBe("37.9-34.1");
    expect(rows[0]!.passing).toEqual([]);
    expect(rows[0]!.last3f).toBeNull();
    expect(rows[0]!.ninki).toBeNull();
  });

  it("excludeNonStartResults で 0 行になること(新馬と同じ扱い)", () => {
    const rows = parseHorseResults(NON_START_FIXTURE);
    expect(excludeNonStartResults(rows)).toEqual([]);
  });
});

describe("isNonStartResult(出走しなかった行の判定)", () => {
  const nonStarts: Array<[string, FinishPosition | null, boolean]> = [
    ["除", { kind: "非数値", text: "除" }, true],
    ["除外", { kind: "非数値", text: "除外" }, true],
    ["取", { kind: "非数値", text: "取" }, true],
    ["取消", { kind: "非数値", text: "取消" }, true],
    // 走った上で完走しなかった・失格は「出走」なので残す。
    ["中", { kind: "非数値", text: "中" }, false],
    ["中止", { kind: "非数値", text: "中止" }, false],
    ["失", { kind: "非数値", text: "失" }, false],
    ["失格", { kind: "非数値", text: "失格" }, false],
    ["数値順位(1着)", { kind: "順位", value: 1 }, false],
    ["降着(5着降着)", { kind: "順位", value: 5, demoted: true }, false],
    // 着順セルが空: 判定材料が無いので残す(保守側。除外と決めつけない)。
    ["着順欠損(null)", null, false],
  ];

  it.each(nonStarts)("着順「%s」→ 出走しなかった行か: %s", (_label, finishPosition, expected) => {
    expect(isNonStartResult(rowWith(finishPosition))).toBe(expected);
  });

  it("表は、除く側と残す側の両方を含むこと(全部 false/全部 true の空振りを許さない)", () => {
    expect(nonStarts.filter(([, , e]) => e).length).toBe(4);
    expect(nonStarts.filter(([, , e]) => !e).length).toBe(7);
  });
});

describe("excludeNonStartResults(戦績配列の絞り込み)", () => {
  it("除外・取消の行だけを落とし、残りの順序と内容を保つこと", () => {
    const rows = [
      rowWith({ kind: "順位", value: 2 }),
      rowWith({ kind: "非数値", text: "除" }),
      rowWith({ kind: "非数値", text: "中" }),
      rowWith({ kind: "非数値", text: "取消" }),
      rowWith({ kind: "順位", value: 5, demoted: true }),
    ];
    const kept = excludeNonStartResults(rows);
    expect(kept.map((r) => r.finishPosition)).toEqual([
      { kind: "順位", value: 2 },
      { kind: "非数値", text: "中" },
      { kind: "順位", value: 5, demoted: true },
    ]);
  });

  it("入力配列を破壊しないこと", () => {
    const rows = [rowWith({ kind: "非数値", text: "除" }), rowWith({ kind: "順位", value: 1 })];
    const before = JSON.stringify(rows);
    excludeNonStartResults(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// scrapeRace を通した結果(production の入口)
// ---------------------------------------------------------------------------

const RACE_ID = parseRaceId("202603020211");
/** 出馬表(福島・16頭)の馬番1・2。 */
const HORSE_1 = "2023103386";
const HORSE_2 = "2023105684";

/** 実走フィクスチャの先頭に、実物の「除」の行を1行足した戦績JSONを作る(実走+除外の混在)。 */
function runsPlusNonStart(): { json: string; runCount: number; firstRunDate: string | null } {
  const nonStartRowHtml = (JSON.parse(NON_START_FIXTURE).data as string).match(/<tbody>([\s\S]*?)<\/tbody>/)![1]!;
  const runs = JSON.parse(loadFixture(RUNS_FIXTURE_NAME)) as { status: string; data: string };
  const parsed = parseHorseResults(JSON.stringify(runs));
  const patched = { ...runs, data: runs.data.replace("<tbody>", `<tbody>${nonStartRowHtml}`) };
  return { json: JSON.stringify(patched), runCount: parsed.length, firstRunDate: parsed[0]!.date };
}

class StubFetcher implements RaceFetcher {
  constructor(private readonly resultsByHorse: Record<string, string>) {}
  async fetchText(url: string, _options?: CachedFetchTextOptions): Promise<string> {
    if (url.includes("shutuba.html")) return loadFixture("shutuba_202603020211.html");
    if (url.includes("ajax_horse_results")) {
      const id = /[?&]id=([^&]+)/.exec(url)![1]!;
      return this.resultsByHorse[id] ?? loadFixture("horse_results_2021105857.json");
    }
    if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
    if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
    throw new Error(`未知のURL: ${url}`);
  }
}

describe("scrapeRace は出走しなかった行を戦績に載せないこと(Issue #261)", () => {
  it("新馬(戦績が除外の1行だけ)の馬は results が空配列([])になり、null(取得失敗)とは区別されること", async () => {
    const fetcher = new StubFetcher({ [HORSE_1]: NON_START_FIXTURE });
    const data = await scrapeRace(RACE_ID, { fetcher });
    const horse = data.horses.find((h) => h.shutuba.horseId === HORSE_1)!;
    expect(horse.results).toEqual([]);
    expect(data.meta.warnings.filter((w) => w.kind === "戦績")).toEqual([]);
  });

  it("実走のある馬に除外の行が混ざっても、実走の件数と先頭の日付が除外なしの場合と一致すること", async () => {
    const mixed = runsPlusNonStart();
    // 前提: 実走は 23 行で、足した除外の行(2026/10/04)は先頭の実走より新しい。
    expect(mixed.runCount).toBe(23);
    expect(mixed.firstRunDate).not.toBe("2026/10/04");
    const fetcher = new StubFetcher({ [HORSE_2]: mixed.json });
    const data = await scrapeRace(RACE_ID, { fetcher });
    const horse = data.horses.find((h) => h.shutuba.horseId === HORSE_2)!;
    expect(horse.results).toHaveLength(mixed.runCount);
    expect(horse.results![0]!.date).toBe(mixed.firstRunDate);
    expect(horse.results!.some((r) => r.finishPosition?.kind === "非数値" && r.finishPosition.text === "除")).toBe(false);
  });

  it("他の馬の戦績は影響を受けないこと(除外なしの馬の件数が変わらない)", async () => {
    const fetcher = new StubFetcher({ [HORSE_1]: NON_START_FIXTURE });
    const data = await scrapeRace(RACE_ID, { fetcher });
    const other = data.horses.find((h) => h.shutuba.horseId !== HORSE_1)!;
    expect(other.results).toHaveLength(parseHorseResults(loadFixture("horse_results_2021105857.json")).length);
  });
});
