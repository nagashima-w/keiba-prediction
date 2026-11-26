import { describe, expect, it } from "vitest";
import type { HorseId } from "../../packages/core/src/scraper/ids";
import type { ScratchedHorse, ShutubaHorse } from "../../packages/core/src/scraper/types";
import { toRaceEntriesRecord, type RaceEntriesSource } from "../src/race-entries";

/**
 * Issue #799: 出馬表(`RaceData`)から、D1 の `race_entry_races`・`race_entry_horses` に書く記録を作る純関数 `toRaceEntriesRecord`。
 * 前日の事前分析(morning)の計算ステップが読んだ出馬表を、保存するだけの表に写す。
 */

const RACE_ID = "202603020211"; // 中央(場コード 03)
const KAISAI = "20260628";

function horse(umaban: number, overrides: Partial<ShutubaHorse> = {}): { shutuba: ShutubaHorse } {
  return {
    shutuba: {
      wakuban: Math.ceil(umaban / 2),
      umaban,
      name: `馬${umaban}`,
      horseId: `20230${String(umaban).padStart(5, "0")}` as HorseId,
      sex: "牡",
      age: 4,
      kinryo: 56,
      jockeyName: `騎手${umaban}`,
      jockeyId: `0${umaban}000`,
      stableLocation: "栗東",
      trainerName: `調教師${umaban}`,
      trainerId: `0${umaban}100`,
      bodyWeight: null,
      ...overrides,
    },
  };
}

function source(overrides: Partial<RaceEntriesSource> = {}): RaceEntriesSource {
  return {
    race: { raceName: "テスト特別", courseType: "芝", distance: 2000, startTime: "15:45", raceClass: "3勝クラス", grade: "G3" },
    horses: [horse(1), horse(2)],
    meta: {},
    ...overrides,
  };
}

const scratchedHorse = (umaban: number, status: ScratchedHorse["status"]): ScratchedHorse => ({
  umaban,
  wakuban: 3,
  name: `取消馬${umaban}`,
  horseId: `20230999${String(umaban).padStart(2, "0")}` as HorseId,
  status,
  text: status,
});

describe("toRaceEntriesRecord: レースの行", () => {
  it("競馬場コード(race_id の 5〜6 桁目)・開催日・コース・距離・クラス・グレード・発走時刻・保存時刻を写す", () => {
    const rec = toRaceEntriesRecord(RACE_ID, KAISAI, source(), 1234)!;
    expect(rec.race).toEqual({
      raceId: RACE_ID,
      kaisaiDate: KAISAI,
      venueCode: "03",
      courseType: "芝",
      distance: 2000,
      raceClass: "3勝クラス",
      grade: "G3",
      startTime: "15:45",
      savedAt: 1234,
    });
  });

  it("発走時刻の 1 桁の時間はゼロ詰めする(9:50 → 09:50)", () => {
    const rec = toRaceEntriesRecord(RACE_ID, KAISAI, source({ race: { ...source().race, startTime: "9:50" } }), 1)!;
    expect(rec.race.startTime).toBe("09:50");
  });

  it("発走時刻・クラス・グレードが読めていない(キーが無い)レースは、それぞれ null になる", () => {
    const { startTime: _s, raceClass: _c, grade: _g, ...bare } = source().race;
    const rec = toRaceEntriesRecord(RACE_ID, KAISAI, source({ race: bare }), 1)!;
    expect(rec.race).toMatchObject({ startTime: null, raceClass: null, grade: null });
  });

  it("地方のレース(場コードが 10 超)も同じ形で、クラスは生のトークンのまま", () => {
    const rec = toRaceEntriesRecord("202644062907", KAISAI, source({ race: { ...source().race, courseType: "ダ", raceClass: "C1" } }), 1)!;
    expect(rec.race).toMatchObject({ venueCode: "44", courseType: "ダ", raceClass: "C1" });
  });
});

describe("toRaceEntriesRecord: 馬の行", () => {
  it("枠・馬番・馬 ID・騎手 ID・調教師 ID・斤量・性・齢を、取り違えずに写す(騎手 ID と調教師 ID は別の値)", () => {
    const rec = toRaceEntriesRecord(RACE_ID, KAISAI, source({ horses: [horse(3, { sex: "牝", age: 5, kinryo: 54.5 })] }), 1)!;
    expect(rec.horses).toEqual([
      { umaban: 3, waku: 2, horseId: "2023000003", jockeyId: "03000", trainerId: "03100", kinryo: 54.5, sex: "牝", age: 5, scratch: null },
    ]);
    expect(rec.horses[0]!.jockeyId).not.toBe(rec.horses[0]!.trainerId); // 前提: 取り違えを検出できる
  });

  it("騎手 ID・調教師 ID が取れていない馬は null で書く", () => {
    const rec = toRaceEntriesRecord(RACE_ID, KAISAI, source({ horses: [horse(1, { jockeyId: null, trainerId: null })] }), 1)!;
    expect(rec.horses[0]).toMatchObject({ jockeyId: null, trainerId: null });
  });

  it("取消・除外・不明の馬も、scratch つきの行として残す(騎手・調教師・斤量・性齢は null)。馬番の昇順に並ぶ", () => {
    const rec = toRaceEntriesRecord(
      RACE_ID,
      KAISAI,
      source({ horses: [horse(1), horse(4)], meta: { scratched: [scratchedHorse(3, "取消"), scratchedHorse(2, "除外"), scratchedHorse(5, "不明")] } }),
      1,
    )!;
    expect(rec.horses.map((h) => [h.umaban, h.scratch])).toEqual([
      [1, null],
      [2, "除外"],
      [3, "取消"],
      [4, null],
      [5, "不明"],
    ]);
    expect(rec.horses[2]).toEqual({ umaban: 3, waku: 3, horseId: "2023099903", jockeyId: null, trainerId: null, kinryo: null, sex: null, age: null, scratch: "取消" });
  });

  it("出走馬も取消馬も無い(馬の行が 0)レースは null(古い行を全部消す書き込みを作らない)", () => {
    expect(toRaceEntriesRecord(RACE_ID, KAISAI, source({ horses: [], meta: {} }), 1)).toBeNull();
  });
});
