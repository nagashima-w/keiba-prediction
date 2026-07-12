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

describe("parseRaceList(地方(NAR)フィクスチャの互換性)", () => {
  const html0712 = loadFixture("nar_race_list_sub_20260712.html");
  const entries0712 = parseRaceList(html0712);
  const html0713 = loadFixture("nar_race_list_sub_20260713.html");
  const entries0713 = parseRaceList(html0713);

  it("2026-07-12(4場44レース中、ばんえい12レースを除く32レース)を抽出すること", () => {
    expect(entries0712).toHaveLength(32);
  });

  it("2026-07-13(4場48レース中、ばんえい12レースを除く36レース)を抽出すること", () => {
    expect(entries0713).toHaveLength(36);
  });

  it("帯広(ばんえい・場コード65)のレースが1件も含まれないこと", () => {
    for (const e of [...entries0712, ...entries0713]) {
      const trackCode = Number(e.raceId.slice(4, 6));
      expect(trackCode).not.toBe(65);
    }
  });

  it("地方の頭数(NARはRaceList_Itemnumberのラップが無くdiv直下のテキスト)を正しく抽出すること", () => {
    // 盛岡1R(202635071201): 「ダ1000m」直後に「8頭」がプレーンテキストで入る。
    const e = entries0712.find((x) => x.raceId === "202635071201");
    expect(e).toBeDefined();
    expect(e!.entryCount).toBe(8);
    expect(e!.courseType).toBe("ダ");
    expect(e!.distance).toBe(1000);
  });

  it("全エントリで頭数が正しく取れていること(0落ちが無いこと)", () => {
    for (const e of [...entries0712, ...entries0713]) {
      expect(e.entryCount).toBeGreaterThan(0);
    }
  });

  it("高知(202654071210)を含み、場コードが地方範囲(30〜64)であること", () => {
    const e = entries0712.find((x) => x.raceId === "202654071210");
    expect(e).toBeDefined();
    expect(Number(e!.raceId.slice(4, 6))).toBe(54);
  });
});
