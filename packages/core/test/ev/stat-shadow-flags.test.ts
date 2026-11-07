/**
 * 並走の記録の「市場が買いすぎる条件」の印(Issue #653。`src/ev/stat-shadow-flags.ts`)のテスト。
 * 突き合わせ: `stat-shadow-golden.json` の印は、#653 の探索のスクリプト(`features.py` の `horse_features`)で計算した値。
 * 境界は表で固定する(181 日・0.125・q 0.05・平均着順 11.5)。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeShadowFlags, type ShadowFlags } from "../../src/ev/stat-shadow-flags.js";
import type { HorseRaceResult } from "../../src/scraper/types.js";

interface GoldenRun {
  date: string;
  courseType: string | null;
  finish: { kind: "順位"; value: number } | { kind: "非数値"; text: string };
  passing: number[];
  entryCount: number | null;
}
interface GoldenHorse {
  umaban: number;
  q: number;
  courseTypeToday: string;
  dateToday: string;
  runs: GoldenRun[];
  flags: Record<keyof ShadowFlags, 0 | 1 | null>;
}
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./stat-shadow-golden.json", import.meta.url)), "utf8")) as { races: Array<{ horses: GoldenHorse[] }> };

/** 必要な項目だけ持つ戦績(残りは使われない)。 */
function run(over: Partial<GoldenRun> & { date: string }): HorseRaceResult {
  return {
    date: over.date,
    courseType: over.courseType === undefined ? "芝" : over.courseType,
    finishPosition: over.finish ?? { kind: "順位", value: 5 },
    passing: over.passing ?? [8, 8, 8, 8],
    entryCount: over.entryCount === undefined ? 16 : over.entryCount,
  } as unknown as HorseRaceResult;
}

const TODAY = { date: "2026/10/10", courseType: "芝" };

describe("computeShadowFlags: #653 の探索のスクリプトとの突き合わせ", () => {
  const all = golden.races.flatMap((r) => r.horses);
  it("突き合わせの馬が 100 頭以上いて、印ごとに 0・1・null がすべて含まれる(片側だけで通る空振りではない)", () => {
    expect(all.length).toBeGreaterThanOrEqual(100);
    for (const k of ["longRest", "surfaceChange", "frontRunner", "longshotSlump"] as const) {
      const vals = new Set(all.map((h) => h.flags[k]));
      expect(vals.has(0) && vals.has(1) && vals.has(null)).toBe(true);
    }
  });
  it("全馬の 4 つの印が一致する", () => {
    for (const h of all) {
      const mine = computeShadowFlags(
        h.runs.map((r) => ({ date: r.date, courseType: r.courseType, finishPosition: r.finish, passing: r.passing, entryCount: r.entryCount }) as unknown as HorseRaceResult),
        { date: h.dateToday, courseType: h.courseTypeToday },
        h.q,
      );
      expect(mine).toEqual(h.flags);
    }
  });
});

describe("computeShadowFlags: 境界(表)", () => {
  const cases: Array<[string, HorseRaceResult[], number | null, Partial<ShadowFlags>]> = [
    ["前走が 180 日前 → 休み明けでない", [run({ date: "2026/04/13" })], 0.1, { longRest: 0 }],
    ["前走が 181 日前 → 休み明け", [run({ date: "2026/04/12" })], 0.1, { longRest: 1 }],
    ["前走も芝(今回が芝)→ 替わりでない", [run({ date: "2026/10/03", courseType: "芝" })], 0.1, { surfaceChange: 0 }],
    ["前走がダート → 替わり", [run({ date: "2026/10/03", courseType: "ダ" })], 0.1, { surfaceChange: 1 }],
    ["前走のコース種別が無い → 替わりは null", [run({ date: "2026/10/03", courseType: null })], 0.1, { surfaceChange: null }],
    ["最初のコーナーが 2/16 = 0.125 → 逃げた", [run({ date: "2026/10/03", passing: [2, 2, 3, 3], entryCount: 16 })], 0.1, { frontRunner: 1 }],
    ["最初のコーナーが 3/16 → 逃げていない", [run({ date: "2026/10/03", passing: [3, 3, 3, 3], entryCount: 16 })], 0.1, { frontRunner: 0 }],
    ["通過順が空 → null", [run({ date: "2026/10/03", passing: [] })], 0.1, { frontRunner: null }],
    ["頭数が無い → null", [run({ date: "2026/10/03", entryCount: null })], 0.1, { frontRunner: null }],
    ["q=0.0499・平均着順 11.5 → 人気薄の大敗続き", [run({ date: "2026/10/03", finish: { kind: "順位", value: 12 } }), run({ date: "2026/09/20", finish: { kind: "順位", value: 11 } })], 0.0499, { longshotSlump: 1 }],
    ["q=0.05 ちょうどは人気薄でない", [run({ date: "2026/10/03", finish: { kind: "順位", value: 12 } }), run({ date: "2026/09/20", finish: { kind: "順位", value: 11 } })], 0.05, { longshotSlump: 0 }],
    ["平均着順 11.4 は大敗続きでない", [run({ date: "2026/10/03", finish: { kind: "順位", value: 12 } }), run({ date: "2026/09/20", finish: { kind: "順位", value: 10 } }), run({ date: "2026/09/01", finish: { kind: "順位", value: 12 } }), run({ date: "2026/08/01", finish: { kind: "順位", value: 1 } })], 0.01, { longshotSlump: 0 }],
    ["直近 3 走だけを見る(4 走前の 1 着は入らない)", [run({ date: "2026/10/03", finish: { kind: "順位", value: 12 } }), run({ date: "2026/09/20", finish: { kind: "順位", value: 12 } }), run({ date: "2026/09/01", finish: { kind: "順位", value: 11 } }), run({ date: "2026/08/01", finish: { kind: "順位", value: 1 } })], 0.01, { longshotSlump: 1 }],
    ["非数値の着順は平均から除く(12 と中止 → 平均 12)", [run({ date: "2026/10/03", finish: { kind: "順位", value: 12 } }), run({ date: "2026/09/20", finish: { kind: "非数値", text: "中" } })], 0.01, { longshotSlump: 1 }],
    ["直近 3 走に数値の着順が 1 つも無い → null", [run({ date: "2026/10/03", finish: { kind: "非数値", text: "中" } })], 0.01, { longshotSlump: null }],
    ["q が無い → null", [run({ date: "2026/10/03", finish: { kind: "順位", value: 14 } })], null, { longshotSlump: null }],
  ];
  for (const [name, results, q, expected] of cases) {
    it(name, () => {
      const f = computeShadowFlags(results, TODAY, q);
      for (const [k, v] of Object.entries(expected)) expect(f[k as keyof ShadowFlags]).toBe(v);
    });
  }
  it("戦績が空 → 4 つとも null", () => {
    expect(computeShadowFlags([], TODAY, 0.01)).toEqual({ longRest: null, surfaceChange: null, frontRunner: null, longshotSlump: null });
  });
  it("今回の日付以降・日付の無い走は無視する(同日の走を前走にしない)。無視すると前走が変わる", () => {
    const prev = run({ date: "2026/04/12", courseType: "ダ" }); // 181 日前・ダート
    const sameDay = run({ date: "2026/10/10", courseType: "芝" });
    const future = run({ date: "2026/10/20", courseType: "芝" });
    const noDate = { ...run({ date: "2026/10/01" }), date: null } as unknown as HorseRaceResult;
    const f = computeShadowFlags([sameDay, future, noDate, prev], TODAY, 0.1);
    expect(f.longRest).toBe(1);
    expect(f.surfaceChange).toBe(1);
  });
  it("並びに依らない(新しい順でも古い順でも同じ)", () => {
    const a = run({ date: "2026/10/03", courseType: "ダ" });
    const b = run({ date: "2026/04/01", courseType: "芝" });
    expect(computeShadowFlags([a, b], TODAY, 0.1)).toEqual(computeShadowFlags([b, a], TODAY, 0.1));
    expect(computeShadowFlags([a, b], TODAY, 0.1).surfaceChange).toBe(1);
  });
});
