import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRaceList, type RaceListEntry } from "../../packages/core/src/index.js";
import {
  NoRacesFoundError,
  resolveCentralDay,
  resolveNarDay,
  selectCentralVenueRaces,
  selectNarRaces,
  shiftDate,
  venueCodeOf,
} from "../probability-quality-41/selection.js";

/**
 * #41 の選定ルール(`docs/investigations/probability-quality-41/measurement-plan.md` §2)の実装テスト。
 * ネットワークには出ない(合成の一覧と、リポジトリ内の保存済み一覧フィクスチャだけを使う)。
 */

/** 合成の一覧エントリ。raceId は 年4桁+場コード2桁+回次・日次4桁+レース番号2桁。 */
function entry(venueCode: string, raceNumber: number, kind: "c" | "n" = "c"): RaceListEntry {
  const year = "2026";
  const mid = kind === "c" ? "0305" : "0712";
  const raceId = `${year}${venueCode}${mid}${String(raceNumber).padStart(2, "0")}`;
  return {
    raceId: raceId as RaceListEntry["raceId"],
    name: `R${raceNumber}`,
    courseType: "ダ",
    distance: 1200,
    entryCount: 10,
    raceNumber,
  };
}

function venue(code: string, count: number): RaceListEntry[] {
  return Array.from({ length: count }, (_, i) => entry(code, i + 1));
}

describe("venueCodeOf", () => {
  it("race_id の5〜6桁目(場コード)を返す", () => {
    expect(venueCodeOf("202606050811")).toBe("06");
    expect(venueCodeOf("202654071210")).toBe("54");
  });
});

describe("shiftDate", () => {
  it("日数を加減する(月・年またぎ、うるう日を含む)", () => {
    expect(shiftDate("20260927", -7)).toBe("20260920");
    expect(shiftDate("20260301", -1)).toBe("20260228");
    expect(shiftDate("20240301", -1)).toBe("20240229");
    expect(shiftDate("20260101", -1)).toBe("20251231");
    expect(shiftDate("20260930", 1)).toBe("20261001");
  });

  it("同じ曜日へ遡る(7日単位)と曜日は変わらない", () => {
    const dow = (d: string) =>
      new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`).getUTCDay();
    expect(dow("20260926")).toBe(6); // 前提: 土曜
    expect(dow("20260927")).toBe(0); // 前提: 日曜
    expect(dow(shiftDate("20260926", -14))).toBe(6);
    expect(dow(shiftDate("20260927", -21))).toBe(0);
  });
});

describe("selectCentralVenueRaces: 場コードが最小の会場の全レース", () => {
  it("一覧の並びに依らず最小の場コードを選び、レース番号順で返す", () => {
    const entries = [...venue("09", 12), ...venue("06", 12).reverse(), ...venue("07", 12)];
    const selected = selectCentralVenueRaces(entries);
    expect(selected).toHaveLength(12);
    expect(selected.every((e) => venueCodeOf(e.raceId) === "06")).toBe(true);
    expect(selected.map((e) => e.raceNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("レース数が12未満の会場でも、その会場の全レースを返す(件数で他会場を足さない)", () => {
    const selected = selectCentralVenueRaces([...venue("02", 9), ...venue("05", 12)]);
    expect(selected).toHaveLength(9);
  });

  it("一覧が空なら空配列", () => {
    expect(selectCentralVenueRaces([])).toEqual([]);
  });

  it("保存済みの中央一覧(2026-09-26・09-27)では 場06 の12レースが選ばれる(実フィクスチャ)", () => {
    for (const date of ["20260926", "20260927"]) {
      const html = readFileSync(
        fileURLToPath(new URL(`../../fixtures/race_list_sub_${date}.html`, import.meta.url)),
        "utf-8",
      );
      const all = parseRaceList(html);
      const codes = new Set(all.map((e) => venueCodeOf(e.raceId)));
      expect(codes.size).toBeGreaterThanOrEqual(2); // 前提: 複数会場の一覧
      const selected = selectCentralVenueRaces(all);
      expect(selected.every((e) => venueCodeOf(e.raceId) === "06")).toBe(true);
      expect(selected).toHaveLength(12);
    }
  });
});

describe("selectNarRaces: 最小の場コードの会場から、合計10レース以上になるまで足す", () => {
  const table: ReadonlyArray<{
    readonly name: string;
    readonly venues: ReadonlyArray<readonly [string, number]>;
    readonly expectedCodes: readonly string[];
    readonly expectedCount: number;
  }> = [
    { name: "最小会場が12レースならその会場だけ", venues: [["35", 12], ["30", 12], ["42", 12]], expectedCodes: ["30"], expectedCount: 12 },
    { name: "ちょうど10レースならその会場だけ(境界。10は「10未満」ではない)", venues: [["30", 10], ["35", 12]], expectedCodes: ["30"], expectedCount: 10 },
    { name: "9レースなら次に小さい場コードを足す(境界)", venues: [["30", 9], ["35", 12], ["42", 12]], expectedCodes: ["30", "35"], expectedCount: 21 },
    { name: "足してもまだ10未満なら合計10以上になるまで続ける", venues: [["30", 4], ["35", 3], ["42", 3], ["50", 12]], expectedCodes: ["30", "35", "42"], expectedCount: 10 },
    { name: "足した結果ちょうど10でも止まる", venues: [["30", 6], ["35", 4], ["42", 12]], expectedCodes: ["30", "35"], expectedCount: 10 },
  ];
  it.each(table)("$name", ({ venues, expectedCodes, expectedCount }) => {
    const entries = venues.flatMap(([code, n]) => venue(code, n));
    const selected = selectNarRaces(entries);
    expect([...new Set(selected.map((e) => venueCodeOf(e.raceId)))]).toEqual(expectedCodes);
    expect(selected).toHaveLength(expectedCount);
  });

  it("全会場を足しても10に届かなければ、あるだけ返す(足りない分は埋めない)", () => {
    expect(selectNarRaces([...venue("30", 4), ...venue("35", 3)])).toHaveLength(7);
  });

  it("一覧が空なら空配列", () => {
    expect(selectNarRaces([])).toEqual([]);
  });

  it("保存済みの地方一覧(2026-09-27)では 場36 の12レースが選ばれる(実フィクスチャ。場コードは数値順)", () => {
    const html = readFileSync(
      fileURLToPath(new URL("../../fixtures/nar_race_list_sub_20260927.html", import.meta.url)),
      "utf-8",
    );
    const selected = selectNarRaces(parseRaceList(html));
    expect(selected.every((e) => venueCodeOf(e.raceId) === "36")).toBe(true);
    expect(selected).toHaveLength(12);
  });
});

describe("resolveCentralDay: 開催が無ければ1週前の同じ曜日へ遡る(最大4週)", () => {
  it("開催のある日はそのまま使い、遡らない(取得は1回)", async () => {
    const calls: string[] = [];
    const resolved = await resolveCentralDay("20260926", async (d) => {
      calls.push(d);
      return venue("06", 12);
    });
    expect(calls).toEqual(["20260926"]);
    expect(resolved.usedDate).toBe("20260926");
    expect(resolved.requestedDate).toBe("20260926");
    expect(resolved.races).toHaveLength(12);
  });

  it("開催が無ければ7日ずつ遡り、使った日と試した日を残す", async () => {
    const calls: string[] = [];
    const resolved = await resolveCentralDay("20260926", async (d) => {
      calls.push(d);
      return d === "20260912" ? venue("05", 12) : [];
    });
    expect(calls).toEqual(["20260926", "20260919", "20260912"]);
    expect(resolved.usedDate).toBe("20260912");
    expect(resolved.attemptedDates).toEqual(["20260926", "20260919", "20260912"]);
  });

  it("4週遡っても無ければ NoRacesFoundError(試したのは要求日+4週の5日)", async () => {
    const calls: string[] = [];
    await expect(
      resolveCentralDay("20260926", async (d) => {
        calls.push(d);
        return [];
      }),
    ).rejects.toBeInstanceOf(NoRacesFoundError);
    expect(calls).toHaveLength(5);
    expect(calls[4]).toBe("20260829");
  });
});

describe("resolveNarDay: 開催が無ければ前日へ遡る(最大7日)", () => {
  it("開催のある日は最小の場コードの会場を選ぶ", async () => {
    const resolved = await resolveNarDay("20260930", async () => [...venue("35", 12), ...venue("30", 11)]);
    expect(resolved.usedDate).toBe("20260930");
    expect(resolved.races).toHaveLength(11);
  });

  it("開催が無ければ1日ずつ遡る", async () => {
    const calls: string[] = [];
    const resolved = await resolveNarDay("20260930", async (d) => {
      calls.push(d);
      return d === "20260928" ? venue("30", 12) : [];
    });
    expect(calls).toEqual(["20260930", "20260929", "20260928"]);
    expect(resolved.usedDate).toBe("20260928");
  });

  it("7日遡っても無ければ NoRacesFoundError(試したのは要求日+7日の8日)", async () => {
    const calls: string[] = [];
    await expect(
      resolveNarDay("20260930", async (d) => {
        calls.push(d);
        return [];
      }),
    ).rejects.toBeInstanceOf(NoRacesFoundError);
    expect(calls).toHaveLength(8);
    expect(calls[7]).toBe("20260923");
  });
});
