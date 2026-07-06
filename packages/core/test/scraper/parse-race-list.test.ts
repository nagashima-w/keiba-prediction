import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRaceList } from "../../src/scraper/parse-race-list.js";
import type { RaceListEntry } from "../../src/scraper/types.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

const html = loadFixture("race_list_sub_20260628.html");
const entries = parseRaceList(html);

/** race_idで1件を取り出す小ヘルパ。 */
function byRaceId(id: string): RaceListEntry {
  const e = entries.find((x) => x.raceId === id);
  if (!e) {
    throw new Error(`race_id=${id} のエントリが見つかりません`);
  }
  return e;
}

describe("parseRaceList(レース一覧サブHTMLのパース)", () => {
  it("3場36レースをすべて抽出すること", () => {
    expect(entries).toHaveLength(36);
  });

  it("ラジオNIKKEI賞(202603020211)の条件を正しく抽出すること", () => {
    const e = byRaceId("202603020211");
    // 注: race_list_sub のレース名はサーバ側で切り詰められており、full名は出馬表から取る。
    expect(e.name).toBe("ラジオNIK");
    expect(e.courseType).toBe("芝");
    expect(e.distance).toBe(1800);
    expect(e.entryCount).toBe(16);
    expect(e.venue).toBe("福島");
    expect(e.raceNumber).toBe(11);
  });

  it("障害レース(202603020201)を種別「障」として抽出すること", () => {
    // 障害レースは距離spanのclassが付かないため、テキストからの抽出が必要になる境界ケース。
    const e = byRaceId("202603020201");
    expect(e.name).toBe("3歳以上障害未勝利");
    expect(e.courseType).toBe("障");
    expect(e.distance).toBe(2750);
    expect(e.entryCount).toBe(14);
    expect(e.venue).toBe("福島");
    expect(e.raceNumber).toBe(1);
  });

  it("3場それぞれ12レースずつ、会場名が付与されていること", () => {
    const venues = new Map<string, number>();
    for (const e of entries) {
      venues.set(e.venue ?? "", (venues.get(e.venue ?? "") ?? 0) + 1);
    }
    expect(venues.get("福島")).toBe(12);
    expect(venues.get("小倉")).toBe(12);
    expect(venues.get("函館")).toBe(12);
  });

  it("全エントリのrace_idが12桁で、距離・頭数が正の数であること", () => {
    for (const e of entries) {
      expect(e.raceId).toMatch(/^\d{12}$/);
      expect(e.distance).toBeGreaterThan(0);
      expect(e.entryCount).toBeGreaterThan(0);
      expect(e.raceNumber).toBeGreaterThanOrEqual(1);
      expect(e.raceNumber).toBeLessThanOrEqual(12);
    }
  });

  it("空HTMLでは空配列を返すこと", () => {
    expect(parseRaceList("")).toEqual([]);
  });

  it("無関係なHTMLでは空配列を返すこと", () => {
    expect(parseRaceList("<html><body><p>hello</p></body></html>")).toEqual([]);
  });
});
