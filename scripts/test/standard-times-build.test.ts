/**
 * 基準タイム表の生成(Issue #353〈#274-B〉)。`scripts/standard-times-build.ts` の純ロジックを、合成入力で固定する。
 * 元データ(netkeiba の全戦績)はリポジトリに入れないので、規則(重複除去・走数の下限・中央値・馬場の補正)はここが唯一の検査になる。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildStandardTimeTable,
  renderStandardTimesModule,
  type StandardTimeRun,
} from "../standard-times-build.js";
import { STANDARD_TIME_META, STANDARD_TIME_TABLE } from "../../packages/core/src/scorer/standard-times.js";
import type { HorseRaceResult } from "../../packages/core/src/scraper/types.js";

/** 合成戦績 1 走(中山の芝 1600・良・1 着が既定)。 */
function result(overrides: Partial<HorseRaceResult> = {}): HorseRaceResult {
  return {
    date: "2026/01/01",
    venue: { round: null, name: "中山", day: null, raw: "中山" },
    weather: null,
    raceNumber: 11,
    raceName: null,
    raceId: null,
    raceIdRaw: null,
    venueKind: "中央",
    entryCount: null,
    wakuban: null,
    umaban: null,
    odds: null,
    ninki: null,
    finishPosition: { kind: "順位", value: 1 },
    jockeyName: null,
    jockeyId: null,
    kinryo: null,
    courseType: "芝",
    distance: 1600,
    trackCondition: "良",
    time: "1:36.0",
    margin: null,
    passing: [],
    pace: null,
    last3f: null,
    bodyWeight: null,
    winnerName: null,
    ...overrides,
  };
}

/** 1:35.0 + i×0.1 秒(i = 0..)のタイム文字列。 */
const timeOf = (i: number): string => `1:${(35 + i / 10).toFixed(1).padStart(4, "0")}`;

/** 良の 20 走(1:35.0〜1:36.9。別々の馬)。 */
function twentyGood(): StandardTimeRun[] {
  return Array.from({ length: 20 }, (_, i) => ({ horseId: `h${i}`, result: result({ time: timeOf(i) }) }));
}

describe("buildStandardTimeTable(基準タイム表の生成規則)", () => {
  it("走数 20 の区分は入る(境界)。19 では入らない", () => {
    const t20 = buildStandardTimeTable(twentyGood());
    expect(t20.table.standards["中山|芝|1600"]?.n).toBe(20);
    const t19 = buildStandardTimeTable(twentyGood().slice(0, 19));
    expect(t19.table.standards["中山|芝|1600"]).toBeUndefined();
  });

  it("基準 = タイムの中央値(昇順の floor(n/2) 番目 = 偶数なら大きいほう)。20 走 1:35.0〜1:36.9 → index 10 の 1:36.0 = 96.0", () => {
    const t = buildStandardTimeTable(twentyGood());
    expect(t.table.standards["中山|芝|1600"]!.median).toBeCloseTo(96, 10);
  });

  it("入力の順序によらない(逆順にしても同じ表)", () => {
    const a = buildStandardTimeTable(twentyGood());
    const b = buildStandardTimeTable(twentyGood().reverse());
    expect(b.table).toEqual(a.table);
  });

  it("馬場の補正 = 区分ごとの (タイム − 基準) ÷ 距離km の中央値。良 20 走 + 稍重 3 走 → 基準 96.1、良 −0.0625、稍重 0.9375", () => {
    // 23 走を昇順にすると 20 走(95.0〜96.9)+ 97.6 が 3 つ。index floor(23/2)=11 → 96.1。
    const heavy = [0, 1, 2].map((i) => ({ horseId: `s${i}`, result: result({ trackCondition: "稍重", time: "1:37.6" }) }));
    const t = buildStandardTimeTable([...twentyGood(), ...heavy]);
    expect(t.table.standards["中山|芝|1600"]!.median).toBeCloseTo(96.1, 10);
    expect(t.table.standards["中山|芝|1600"]!.n).toBe(23);
    // 良: 昇順 index 10 は 96.0 → (96.0 − 96.1) ÷ 1.6。
    expect(t.table.offsets["芝|良"]!.median).toBeCloseTo(-0.0625, 10);
    expect(t.table.offsets["芝|良"]!.n).toBe(20);
    expect(t.table.offsets["芝|稍重"]!.median).toBeCloseTo(0.9375, 10);
    expect(t.table.offsets["芝|稍重"]!.n).toBe(3);
    expect(t.table.offsets["芝|重・不良"]).toBeUndefined(); // 走が無い区分は作らない。
  });

  it("基準の無い区分(走数不足)の走は、馬場の補正の集計に入らない", () => {
    const rare = Array.from({ length: 5 }, (_, i) => ({
      horseId: `r${i}`,
      result: result({ distance: 1800, time: "1:50.0", trackCondition: "重" }),
    }));
    const t = buildStandardTimeTable([...twentyGood(), ...rare]);
    expect(t.table.standards["中山|芝|1800"]).toBeUndefined();
    expect(t.table.offsets["芝|重・不良"]).toBeUndefined();
  });

  it("重複除去: 同じ馬の 同じ日付・レース番号・会場 は 1 走。別の馬の同じレースは別の走", () => {
    const dup = [{ horseId: "h0", result: result({ time: timeOf(0) }) }]; // h0 の既存走と同じ鍵
    const t = buildStandardTimeTable([...twentyGood(), ...dup]);
    expect(t.table.standards["中山|芝|1600"]!.n).toBe(20);
    // 同じレースでも馬が違えば別の走(h100 は新しい馬)。
    const other = [{ horseId: "h100", result: result({ time: timeOf(0) }) }];
    expect(buildStandardTimeTable([...twentyGood(), ...other]).table.standards["中山|芝|1600"]!.n).toBe(21);
  });

  it.each<[string, Partial<HorseRaceResult>]>([
    ["地方", { venueKind: "地方" }],
    ["障害", { courseType: "障" }],
    ["着順が非数値", { finishPosition: { kind: "非数値", text: "中" } }],
    ["タイムなし", { time: null }],
    ["馬場なし", { trackCondition: null }],
    ["日付なし", { date: null }],
  ])("対象外の走は数えない: %s(20 走ぶん足しても n は 20 のまま)", (_n, overrides) => {
    const extra = [{ horseId: "x1", result: result({ date: "2026/02/02", ...overrides }) }];
    const t = buildStandardTimeTable([...twentyGood(), ...extra]);
    expect(t.table.standards["中山|芝|1600"]!.n).toBe(20);
    expect(t.runs).toBe(20);
  });

  it("障害の区分は作らない(障害の走が 20 以上あっても)", () => {
    const shou = Array.from({ length: 25 }, (_, i) => ({
      horseId: `j${i}`,
      result: result({ courseType: "障", distance: 2880, time: "3:10.0" }),
    }));
    const t = buildStandardTimeTable(shou);
    expect(Object.keys(t.table.standards)).toEqual([]);
  });

  it("使った走の数と期間(日付の最小・最大)を返す", () => {
    const runs = twentyGood();
    runs[0] = { horseId: "h0", result: result({ time: timeOf(0), date: "2018/08/05" }) };
    runs[1] = { horseId: "h1", result: result({ time: timeOf(1), date: "2026/10/12" }) };
    const t = buildStandardTimeTable(runs);
    expect(t.runs).toBe(20);
    expect(t.dateRange).toEqual(["2018/08/05", "2026/10/12"]);
  });

  it("区分は鍵の昇順で並ぶ(出力が決定的)", () => {
    const mk = (venueName: string, dist: number): StandardTimeRun[] =>
      Array.from({ length: 20 }, (_, i) => ({
        horseId: `${venueName}${dist}-${i}`,
        result: result({ venue: { round: null, name: venueName, day: null, raw: venueName }, distance: dist }),
      }));
    const t = buildStandardTimeTable([...mk("東京", 2000), ...mk("中山", 1600), ...mk("東京", 1600)]);
    const keys = Object.keys(t.table.standards);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toHaveLength(3);
  });
});

describe("renderStandardTimesModule(定数表のソース)", () => {
  it("コミット済みの packages/core/src/scorer/standard-times.ts は、この生成関数の出力と一致する(手で書き換えていない)", () => {
    const committed = readFileSync(
      fileURLToPath(new URL("../../packages/core/src/scorer/standard-times.ts", import.meta.url)),
      "utf-8",
    );
    expect(renderStandardTimesModule(STANDARD_TIME_TABLE, STANDARD_TIME_META)).toBe(committed);
  });

  it("出力は表のキーと値をすべて含む(合成入力で往復)", () => {
    const t = buildStandardTimeTable(twentyGood());
    const text = renderStandardTimesModule(t.table, {
      generatedAt: "2026-10-17",
      source: "テスト",
      runs: t.runs,
      dateRange: t.dateRange,
      minRuns: 20,
    });
    expect(text).toContain('"中山|芝|1600"');
    expect(text).toContain("median: 96");
    expect(text).toContain("n: 20");
    expect(text).toContain('generatedAt: "2026-10-17"');
  });
});
