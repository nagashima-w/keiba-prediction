import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { toResultEntries } from "../../src/ev/result-import.js";
import { parseRaceResult } from "../../src/scraper/parse-race-result.js";

/**
 * Issue #72: 取消・除外の記録(`RaceResultEntry.scratched`)。
 *
 * 結果ページの着順欄が「取消」「除外」の馬は、馬券が返還される。`toResultEntries` は非数値の着順をすべて
 * `finishPosition: null` に潰すので、そこだけからは取消・除外と中止・失格を区別できない。その区別を
 * `scratched` として残す。語彙の定義は戦績側の `isNonStartResult`(#261)と同じものを使う。
 */

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)), "utf-8");
}

// 実物: 中山1R(2026-09-27)。16頭中 6番ニシノドリーマーが出走取消。結果ページの着順欄は「取消」(tr.Torikeshi)。
// 取消馬の行も結果表に残り、パーサは { kind: "非数値", text: "取消" } を返す。
const SCRATCH_HTML = loadFixture("result_202606040901.html");

describe("toResultEntries: 取消・除外の記録(Issue #72)", () => {
  it("前提(空振り防止): 実フィクスチャは16行で、6番だけが非数値の「取消」、他の15頭は数値順位である", () => {
    const result = parseRaceResult(SCRATCH_HTML);
    expect(result.horses).toHaveLength(16);
    const nonNumeric = result.horses.filter((h) => h.finishPosition === null || h.finishPosition.kind !== "順位");
    expect(nonNumeric.map((h) => [h.umaban, h.finishPosition])).toEqual([[6, { kind: "非数値", text: "取消" }]]);
  });

  it("実フィクスチャ: 取消の6番だけ scratched=true で、finishPosition は従来どおり null。他の15頭は scratched を持たない", () => {
    const entries = toResultEntries(parseRaceResult(SCRATCH_HTML));
    const scratched = entries.filter((e) => e.scratched === true);
    expect(scratched).toEqual([expect.objectContaining({ umaban: 6, finishPosition: null })]);
    expect(entries.filter((e) => "scratched" in e)).toHaveLength(1);
  });

  // 取消・除外は返還、中止・失格は返還されない(走った/失格は馬券が成立する)。
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ["取消", true],
    ["取", true],
    ["除外", true],
    ["除", true],
    ["中止", false],
    ["中", false],
    ["失格", false],
    ["失", false],
  ];

  it.each(cases)("非数値の着順「%s」→ scratched=%s", (text, expected) => {
    const result = parseRaceResult(SCRATCH_HTML);
    const patched = {
      ...result,
      horses: result.horses.map((h) => (h.umaban === 6 ? { ...h, finishPosition: { kind: "非数値", text } as const } : h)),
    };
    const e = toResultEntries(patched).find((x) => x.umaban === 6)!;
    expect(e.finishPosition).toBeNull();
    expect(e.scratched === true).toBe(expected);
  });

  it("表は、返還する側と返還しない側の両方を含む(全部同じ値の空振りを許さない)", () => {
    expect(cases.filter(([, e]) => e)).toHaveLength(4);
    expect(cases.filter(([, e]) => !e)).toHaveLength(4);
  });

  it("着順欄が空(null)・降着(5着降着)は scratched にならない", () => {
    const result = parseRaceResult(SCRATCH_HTML);
    const withFinish = (finishPosition: (typeof result.horses)[number]["finishPosition"]) =>
      toResultEntries({ ...result, horses: result.horses.map((h) => (h.umaban === 6 ? { ...h, finishPosition } : h)) }).find(
        (x) => x.umaban === 6,
      )!;
    expect(withFinish(null).finishPosition).toBeNull();
    expect(withFinish(null).scratched).toBeUndefined();
    expect(withFinish({ kind: "順位", value: 5, demoted: true }).finishPosition).toBe(5);
    expect(withFinish({ kind: "順位", value: 5, demoted: true }).scratched).toBeUndefined();
  });
});
