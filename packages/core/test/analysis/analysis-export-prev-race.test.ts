/**
 * レース情報スナップショットの馬ごとの前走の条件 `horses[].prevRace`(Issue #421 段階 1-b)。
 *
 * 結合は、馬の戦績の先頭(`results[0]`)の `raceIdRaw` で `RaceData.prevRaceConditions`(race_id → 条件)を引く。
 *  - 表が無いレース(オプション OFF・取得失敗)は、馬にキー自体を付けない。
 *  - 表があるレースで前走が引けない馬(新馬・戦績の取得失敗・海外・表に無い)は `prevRace: null`(「取れなかった」と区別できる)。
 *  - `buildRaceSnapshot` が受け取るのは、分析パイプラインが自レース・基準日以降の走を除いた後の `RaceData` なので、`results[0]` が前走になる。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildRaceSnapshot } from "../../src/analysis/analysis-export.js";
import type { RaceData } from "../../src/pipeline.js";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import type { PrevRaceCondition } from "../../src/scraper/parse-newspaper.js";
import { scrapeRace } from "../../src/scraper/scrape-race.js";
import { excludeOwnRaceResults } from "../../src/scorer/snapshot-filter.js";

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)), "utf-8");
}

const TABLE: Readonly<Record<string, PrevRaceCondition>> = {
  "202607020506": { weightType: "定量", condition: "(混)[指]", filliesOnly: false },
  "202609040411": { weightType: "馬齢", condition: "(国際)牝(指)", filliesOnly: true },
  "202655090311": { weightType: "見込", condition: null, filliesOnly: null },
};

type ResultLike = { raceId: string | null; raceIdRaw: string | null };

/** 位置取りの計算(earlyPos など)が読む項目を最小限に足した、戦績 1 走の合成。 */
function runOf(r: ResultLike): unknown {
  return { ...r, passing: [], entryCount: null };
}

function horse(umaban: number, results: ResultLike[] | null): unknown {
  return {
    shutuba: { umaban, wakuban: 1, name: `馬${umaban}`, sex: "牡", age: 3, kinryo: 55, jockeyName: null, trainerName: null, bodyWeight: null },
    results: results === null ? null : results.map(runOf),
    oikiri: null,
  };
}

function raceDataWith(horses: unknown[], prevRaceConditions?: Readonly<Record<string, PrevRaceCondition>>): RaceData {
  return {
    raceId: "202603020211",
    race: { raceName: "テスト", courseType: "芝", distance: 1800 },
    horses,
    odds: { officialDatetime: null, oddsStatus: "result", win: {}, place: {} },
    meta: { fetchedAt: "2026-06-28T00:00:00.000Z", oddsFetchedAt: "2026-06-28T00:00:00.000Z", warnings: [] },
    ...(prevRaceConditions !== undefined ? { prevRaceConditions } : {}),
  } as unknown as RaceData;
}

describe("buildRaceSnapshot: horses[].prevRace", () => {
  it("表が無い(prevRaceConditions のキー自体が無い)とき、どの馬にも prevRace のキーが無い(JSON にも出ない)", () => {
    const snap = buildRaceSnapshot(raceDataWith([horse(1, [{ raceId: "202607020506", raceIdRaw: "202607020506" }])]));
    expect(snap.horses).toHaveLength(1);
    expect("prevRace" in snap.horses[0]!).toBe(false);
    expect(JSON.stringify(snap)).not.toContain("prevRace");
  });

  it("表があるとき、results[0] の raceIdRaw で引いた行が raceId つきで入る(JSON の往復を含む)", () => {
    const snap = buildRaceSnapshot(
      raceDataWith([horse(1, [{ raceId: "202607020506", raceIdRaw: "202607020506" }, { raceId: "202609040411", raceIdRaw: "202609040411" }])], TABLE),
    );
    expect(snap.horses[0]!.prevRace).toEqual({ raceId: "202607020506", weightType: "定量", condition: "(混)[指]", filliesOnly: false });
    const back = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(back.horses[0]!.prevRace).toEqual(snap.horses[0]!.prevRace);
  });

  it("前走は results[0] だけ(2 走目が表にあっても、先頭が表に無ければ null)", () => {
    const snap = buildRaceSnapshot(raceDataWith([horse(1, [{ raceId: "202600000000", raceIdRaw: "202600000000" }, { raceId: "202609040411", raceIdRaw: "202609040411" }])], TABLE));
    expect(snap.horses[0]!.prevRace).toBeNull();
  });

  it("引けない馬は null: 新馬(戦績 0 件)・戦績の取得失敗(results=null)・海外(raceIdRaw=null)・表に無いレース。いずれもキーは残る", () => {
    const snap = buildRaceSnapshot(
      raceDataWith([horse(1, []), horse(2, null), horse(3, [{ raceId: null, raceIdRaw: null }]), horse(4, [{ raceId: "202699999999", raceIdRaw: "202699999999" }])], TABLE),
    );
    expect(snap.horses).toHaveLength(4);
    for (const h of snap.horses) {
      expect("prevRace" in h).toBe(true);
      expect(h.prevRace).toBeNull();
    }
  });

  it("結合のキーは raceIdRaw(raceId ではない): 地方の走は raceId が null でも raceIdRaw で引ける。raceId だけが表にあっても引かない", () => {
    const snap = buildRaceSnapshot(
      raceDataWith([horse(1, [{ raceId: null, raceIdRaw: "202655090311" }]), horse(2, [{ raceId: "202609040411", raceIdRaw: "202600000000" }])], TABLE),
    );
    expect(snap.horses[0]!.prevRace).toEqual({ raceId: "202655090311", weightType: "見込", condition: null, filliesOnly: null });
    expect(snap.horses[1]!.prevRace).toBeNull();
  });

  it("空の表({})でも、表を取れたレースとして、馬には prevRace: null が付く", () => {
    const snap = buildRaceSnapshot(raceDataWith([horse(1, [{ raceId: "202607020506", raceIdRaw: "202607020506" }])], {}));
    expect(snap.horses[0]!.prevRace).toBeNull();
  });
});

describe("実データの結合(秋華賞 202608040711 の新聞形式 API × テイエムアイラン 2023100448 の戦績)", () => {
  const handler = (url: string, options?: CachedFetchTextOptions): string => {
    if (url.includes("shutuba.html")) return loadFixture("shutuba_202603020211.html");
    if (url.includes("ajax_horse_results")) return loadFixture("horse_results_newspaper_2023100448.json");
    if (url.includes("oikiri.html")) return loadFixture("oikiri_202603020211.html");
    if (url.includes("api_get_jra_odds")) return loadFixture("odds_202603020211.json");
    if (url.endsWith("/race_api/") && options?.method === "POST") return loadFixture("newspaper_api_202608040711.json");
    throw new Error(`未知のURL: ${url}`);
  };
  const scrape = () =>
    scrapeRace(parseRaceId("202603020211"), { fetcher: { fetchText: async (u, o) => handler(u, o) }, now: () => new Date("2026-10-20T00:00:00.000Z") }, { includePrevConditions: true });

  it("前提: 取得直後の戦績の先頭は、秋華賞自身(202608040711)。表には自レースの行が無い", async () => {
    const data = await scrape();
    expect(data.horses[0]!.results?.[0]?.raceIdRaw).toBe("202608040711");
    expect(data.prevRaceConditions?.["202608040711"]).toBeUndefined();
  });

  it("自レースを除いた後(パイプラインと同じ順序)の先頭は 202607020506(納屋橋特別。定量・牝馬限定でない)で、全馬の prevRace が表の行と一致する", async () => {
    const data = await scrape();
    const filtered = excludeOwnRaceResults(data, parseRaceId("202608040711")).raceData;
    const snap = buildRaceSnapshot(filtered);
    expect(snap.horses).toHaveLength(16);
    for (const h of snap.horses) {
      expect(h.prevRace).toEqual({ raceId: "202607020506", weightType: "定量", condition: "(混)[指]", filliesOnly: false });
    }
  });

  it("対照: 自レースを除く前の RaceData で組み立てると前走は引けず null になる(結合が自レース除外後の race を前提にしていることの確認)", async () => {
    const snap = buildRaceSnapshot(await scrape());
    for (const h of snap.horses) {
      expect(h.prevRace).toBeNull();
    }
  });
});
