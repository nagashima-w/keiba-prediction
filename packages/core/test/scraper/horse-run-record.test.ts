import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HORSE_RUN_FIELD_SLOTS,
  HORSE_RUN_PARSER_VERSION,
  HORSE_RUN_SLOT_COUNT,
  decodeHorseRun,
  encodeHorseRun,
  horseRunKey,
} from "../../src/scraper/horse-run-record.js";
import { excludeNonStartResults, parseHorseResults } from "../../src/scraper/parse-horse-results.js";
import type { HorseRaceResult } from "../../src/scraper/types.js";

/**
 * Issue #256 段階A: 戦績の1走を D1 に貯める形(位置タプル)の符号化。
 * 保存は事実の記録なので、HorseRaceResult の全フィールドが欠けずに往復すること(段階 C・D・E、#274 が読む)を固定する。
 */

const FIXTURE_DIR = new URL("../../../../fixtures/", import.meta.url);

/** 戦績フィクスチャ(horse_results_<10桁>.json)を全部パースした1走ずつ。取得時と同じく除外・取消の行は除く。 */
function fixtureRuns(): HorseRaceResult[] {
  const names = readdirSync(fileURLToPath(FIXTURE_DIR)).filter((f) => /^horse_results_\d{10}\.json$/.test(f) && !f.includes("2099999999"));
  const runs: HorseRaceResult[] = [];
  for (const name of names) {
    const json = readFileSync(fileURLToPath(new URL(name, FIXTURE_DIR)), "utf-8");
    runs.push(...excludeNonStartResults(parseHorseResults(json)));
  }
  return runs;
}

/** 全項目を埋めた1走(降着・馬体重・通過順あり)。 */
const FULL: HorseRaceResult = {
  date: "2026/06/28",
  venue: { round: 2, name: "福島", day: 2, raw: "2福島2" },
  weather: "晴",
  raceNumber: 11,
  raceName: "テストステークス",
  raceId: "202603020211" as HorseRaceResult["raceId"],
  raceIdRaw: "202603020211",
  venueKind: "中央",
  entryCount: 16,
  wakuban: 3,
  umaban: 5,
  odds: 12.3,
  ninki: 6,
  finishPosition: { kind: "順位", value: 5, demoted: true },
  jockeyName: "テスト騎手",
  jockeyId: "01170",
  kinryo: 56,
  courseType: "芝",
  distance: 1800,
  trackCondition: "良",
  time: "1:45.9",
  margin: 0.4,
  passing: [5, 4, 8, 6],
  pace: "29.9-37.6",
  last3f: 35.0,
  bodyWeight: { weight: 496, diff: -2 },
  winnerName: "ウィナー",
};

/** 全項目が null/空の1走(海外・リンク欠損の変則行を想定)。 */
const EMPTY: HorseRaceResult = {
  date: null,
  venue: null,
  weather: null,
  raceNumber: null,
  raceName: null,
  raceId: null,
  raceIdRaw: null,
  venueKind: "海外",
  entryCount: null,
  wakuban: null,
  umaban: null,
  odds: null,
  ninki: null,
  finishPosition: null,
  jockeyName: null,
  jockeyId: null,
  kinryo: null,
  courseType: null,
  distance: null,
  trackCondition: null,
  time: null,
  margin: null,
  passing: [],
  pace: null,
  last3f: null,
  bodyWeight: null,
  winnerName: null,
};

/** JSON 文字列を経由した往復(D1 には JSON 文字列で入るので、実際の経路と同じ)。 */
function roundTrip(run: HorseRaceResult): HorseRaceResult | null {
  return decodeHorseRun(JSON.parse(JSON.stringify(encodeHorseRun(run))));
}

describe("horse-run-record: 網羅ガード(HorseRaceResult にフィールドが足されたら赤になる)", () => {
  it("スロット表のキーは、パーサが返す1走のキー(27 項目)と過不足なく一致する", () => {
    const parsed = fixtureRuns();
    expect(parsed.length).toBeGreaterThan(0); // 前提: フィクスチャを実際に読めている
    expect(Object.keys(HORSE_RUN_FIELD_SLOTS).sort()).toEqual(Object.keys(parsed[0]!).sort());
    expect(Object.keys(HORSE_RUN_FIELD_SLOTS)).toHaveLength(27);
  });

  it("スロットの番号は 0 から連番で重複せず、raceId だけが導出(null)。符号化したタプルの長さはスロット数と一致する", () => {
    const slots = Object.entries(HORSE_RUN_FIELD_SLOTS).filter(([, v]) => v !== null).map(([, v]) => v as number).sort((a, b) => a - b);
    expect(slots).toEqual(Array.from({ length: HORSE_RUN_SLOT_COUNT }, (_, i) => i));
    expect(Object.entries(HORSE_RUN_FIELD_SLOTS).filter(([, v]) => v === null).map(([k]) => k)).toEqual(["raceId"]);
    expect(encodeHorseRun(FULL)).toHaveLength(HORSE_RUN_SLOT_COUNT);
    expect(HORSE_RUN_SLOT_COUNT).toBe(26);
  });

  it("全項目を埋めた1走の各フィールドが、対応するスロットに入っている(raceId を除く 26 項目すべて)", () => {
    const tuple = encodeHorseRun(FULL);
    for (const [field, slot] of Object.entries(HORSE_RUN_FIELD_SLOTS)) {
      if (slot === null) continue;
      expect(tuple[slot], `${field} のスロット ${slot}`).not.toBeNull(); // 空振りでない: 埋めた値が null に落ちていない
    }
    // 後の #274(走破タイムの基準)が読む項目: 走破タイム・馬場・距離・コース
    expect(tuple[HORSE_RUN_FIELD_SLOTS.time]).toBe("1:45.9");
    expect(tuple[HORSE_RUN_FIELD_SLOTS.trackCondition]).toBe("良");
    expect(tuple[HORSE_RUN_FIELD_SLOTS.distance]).toBe(1800);
    expect(tuple[HORSE_RUN_FIELD_SLOTS.courseType]).toBe("芝");
  });
});

describe("horse-run-record: 往復で欠けない", () => {
  it("全項目を埋めた1走(降着・馬体重・通過順あり)が JSON を経由しても完全に戻る", () => {
    expect(roundTrip(FULL)).toStrictEqual(FULL);
  });

  it("全項目が null/空の1走(海外の変則行)も戻る", () => {
    expect(roundTrip(EMPTY)).toStrictEqual(EMPTY);
  });

  it("着順の3種(通常の順位・降着つきの順位・非数値)を区別して戻す", () => {
    const normal = { ...FULL, finishPosition: { kind: "順位", value: 1 } as const };
    const demoted = { ...FULL, finishPosition: { kind: "順位", value: 5, demoted: true } as const };
    const text = { ...FULL, finishPosition: { kind: "非数値", text: "中" } as const };
    expect(roundTrip(normal)).toStrictEqual(normal);
    expect(roundTrip(demoted)).toStrictEqual(demoted);
    expect(roundTrip(text)).toStrictEqual(text);
    // 3種のタプル表現が互いに違う(区別できる)
    const slot = HORSE_RUN_FIELD_SLOTS.finishPosition;
    const reps = [normal, demoted, text].map((r) => JSON.stringify(encodeHorseRun(r)[slot]));
    expect(new Set(reps).size).toBe(3);
  });

  it("実フィクスチャの全走(戦績フィクスチャ 8 本・72 行)が、JSON を経由して1項目も欠けずに戻る", () => {
    const runs = fixtureRuns();
    expect(runs.length).toBe(72); // 前提: 空振りでない(フィクスチャ追加で変わったら件数と内訳を確かめて直す)
    expect(new Set(runs.map((r) => r.venueKind))).toEqual(new Set(["中央", "地方", "海外"])); // 3区分すべてを含む
    for (const run of runs) {
      expect(roundTrip(run)).toStrictEqual(run);
    }
  });

  it("中央の走は raceId を raceIdRaw から導いて戻す。地方・海外は null のまま", () => {
    const back = roundTrip(FULL)!;
    expect(back.raceId).toBe("202603020211");
    expect(roundTrip({ ...FULL, venueKind: "地方", raceId: null, raceIdRaw: "202644031511" })!.raceId).toBeNull();
    expect(roundTrip(EMPTY)!.raceId).toBeNull();
  });

  it("形が違うタプル(配列でない・長さが違う)は null を返す(例外にしない)", () => {
    expect(decodeHorseRun(null)).toBeNull();
    expect(decodeHorseRun("x")).toBeNull();
    expect(decodeHorseRun([])).toBeNull();
    expect(decodeHorseRun(encodeHorseRun(FULL).slice(0, 25))).toBeNull();
    expect(decodeHorseRun([...encodeHorseRun(FULL), 1])).toBeNull();
  });

  it("符号化は決定的(同じ入力は同じ JSON 文字列)。重複・不一致の判定は文字列の比較で行うため", () => {
    expect(JSON.stringify(encodeHorseRun(FULL))).toBe(JSON.stringify(encodeHorseRun({ ...FULL })));
    // 値を1つ変えると文字列が変わる(比較が空振りでない)
    expect(JSON.stringify(encodeHorseRun({ ...FULL, time: "1:45.8" }))).not.toBe(JSON.stringify(encodeHorseRun(FULL)));
  });

  it("容量の見積もりの根拠: 戦績フィクスチャ 72 行のタプルの JSON は平均 231 バイト前後(200〜260 の範囲。migration 0014 と docs の見積もりが引く値。8頭だけの標本で、母集団の平均ではない)", () => {
    const runs = fixtureRuns();
    const total = runs.reduce((n, r) => n + new TextEncoder().encode(JSON.stringify(encodeHorseRun(r))).length, 0);
    const mean = total / runs.length;
    expect(runs).toHaveLength(72);
    expect(mean).toBeGreaterThan(200);
    expect(mean).toBeLessThan(260);
  });

  it("パーサの版数は 1(出力の意味を変えたら上げる)", () => {
    expect(HORSE_RUN_PARSER_VERSION).toBe(1);
  });
});

describe("horse-run-record: 行の鍵(horseRunKey)", () => {
  const cases: ReadonlyArray<readonly [string, Partial<HorseRaceResult>, string | null]> = [
    ["中央: raceIdRaw(12桁)", { raceIdRaw: "202603020211", venueKind: "中央" }, "202603020211"],
    ["地方: raceIdRaw(12桁)", { raceIdRaw: "202644031511", venueKind: "地方" }, "202644031511"],
    ["海外(IDなし): 'X' + 日付(区切りを除く)", { raceIdRaw: null, venueKind: "海外", date: "2025/03/29" }, "X20250329"],
    ["リンク欠損の中央相当(IDなし・日付あり)も同じく 'X' + 日付", { raceIdRaw: null, venueKind: "海外", date: "2024/12/01" }, "X20241201"],
    ["IDも日付も無い: null(保存しない)", { raceIdRaw: null, date: null }, null],
    ["IDが無く日付の形が違う: null", { raceIdRaw: null, date: "2025-03-29" }, null],
  ];
  it.each(cases)("%s", (_name, patch, expected) => {
    expect(horseRunKey({ ...EMPTY, ...patch })).toBe(expected);
  });

  it("実フィクスチャの全走に鍵が付き、海外の走も鍵を持つ(捨てない)", () => {
    const runs = fixtureRuns();
    const keys = runs.map((r) => horseRunKey(r));
    expect(keys.every((k) => k !== null)).toBe(true);
    const overseas = runs.filter((r) => r.venueKind === "海外");
    expect(overseas.length).toBeGreaterThan(0); // 前提: 海外の走が含まれる
    for (const r of overseas) {
      expect(horseRunKey(r)).toMatch(/^X\d{8}$/);
    }
  });
});
