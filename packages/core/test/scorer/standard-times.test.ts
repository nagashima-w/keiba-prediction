/**
 * 基準タイム表(Issue #353〈#274-B〉)の定数表の検査。
 *
 * 表の値は、中央の戦績(netkeiba)から `scripts/build-standard-times.ts` で作ったもの。元データはリポジトリに入れていないので、
 * ここでは**表の形**(区分の書式・走数の下限・障害を含まないこと)と、**元の JSON から転記した代表値**(書き換えの検出)を固定する。
 * 生成の規則そのものは scripts/test/standard-times-build.test.ts が合成入力で固定する。
 */

import { describe, expect, it } from "vitest";
import {
  STANDARD_TIME_META,
  STANDARD_TIME_TABLE,
} from "../../src/scorer/standard-times.js";

const VENUES = ["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"];

describe("STANDARD_TIME_TABLE(基準タイム表)", () => {
  const keys = Object.keys(STANDARD_TIME_TABLE.standards);

  it("区分は 競馬場|芝ダ|距離 の書式で、競馬場は中央の10場、芝ダは芝・ダのみ(障害の区分を含まない)", () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const [venue, course, dist] = k.split("|");
      expect(VENUES, k).toContain(venue);
      expect(["芝", "ダ"], k).toContain(course);
      expect(Number.isInteger(Number(dist)) && Number(dist) > 0, k).toBe(true);
    }
    expect(keys.some((k) => k.includes("障"))).toBe(false);
  });

  it("区分の数は 86(芝 56・ダ 30)。メタ情報の区分数と表の実数が一致する", () => {
    const turf = keys.filter((k) => k.split("|")[1] === "芝").length;
    const dirt = keys.filter((k) => k.split("|")[1] === "ダ").length;
    expect(turf).toBe(56);
    expect(dirt).toBe(30);
    expect(keys).toHaveLength(86);
  });

  it("どの区分も走数が下限(20)以上で、基準タイムは正の有限値", () => {
    expect(STANDARD_TIME_META.minRuns).toBe(20);
    for (const [k, e] of Object.entries(STANDARD_TIME_TABLE.standards)) {
      expect(e.n, k).toBeGreaterThanOrEqual(STANDARD_TIME_META.minRuns);
      expect(Number.isFinite(e.median) && e.median > 0, k).toBe(true);
    }
  });

  it("元の JSON から転記した代表値(書き換えの検出)", () => {
    const s = STANDARD_TIME_TABLE.standards;
    expect(s["東京|芝|1600"]).toEqual({ median: 94.5, n: 733 });
    expect(s["中山|芝|1600"]).toEqual({ median: 95, n: 806 });
    expect(s["東京|ダ|1600"]).toEqual({ median: 98.7, n: 902 });
    expect(s["阪神|芝|2000"]).toEqual({ median: 121.4, n: 365 });
    expect(s["中京|ダ|1800"]).toEqual({ median: 115.1, n: 663 });
  });

  it("馬場の補正は 芝・ダ × 良・稍重・重・不良 の 6 つだけ(障害なし)。元の JSON の値", () => {
    const o = STANDARD_TIME_TABLE.offsets;
    expect(Object.keys(o).sort()).toEqual(
      ["ダ|稍重", "ダ|良", "ダ|重・不良", "芝|稍重", "芝|良", "芝|重・不良"].sort(),
    );
    expect(o["芝|重・不良"]!.median).toBeCloseTo(1.25, 12);
    expect(o["芝|稍重"]!.median).toBeCloseTo(0.5, 12);
    expect(o["芝|良"]!.median).toBeCloseTo(-0.15, 12);
    expect(o["ダ|重・不良"]!.median).toBeCloseTo(-0.7692307692307692, 12);
    expect(o["ダ|稍重"]!.median).toBeCloseTo(0, 12);
    expect(o["ダ|良"]!.median).toBeCloseTo(0.1428571428571449, 12);
    for (const [k, e] of Object.entries(o)) {
      expect(e.n, k).toBeGreaterThanOrEqual(STANDARD_TIME_META.minRuns);
    }
  });

  it("メタ情報: 出典・走数・期間・生成日が入っている", () => {
    expect(STANDARD_TIME_META.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(STANDARD_TIME_META.source.length).toBeGreaterThan(0);
    expect(STANDARD_TIME_META.runs).toBeGreaterThan(20000);
    expect(STANDARD_TIME_META.dateRange[0] <= STANDARD_TIME_META.dateRange[1]).toBe(true);
  });
});
