import { describe, expect, it } from "vitest";
import { finiteOrNull, isFiniteNumber, isRecord } from "../../src/common/guards.js";

/**
 * Issue #397(R-5): 型ガードの共通部品。8 か所の `isRecord`(`isObject`・`isObj` を含む)、6 か所の `isFiniteNumber`/`isNum`、2 か所の `finiteOrNull` を 1 本にした。
 * 統合前の本体は、どれも同じ式だった(`typeof v === "object" && v !== null && !Array.isArray(v)` など)。ここは、その式の振る舞いを表で固定する。
 */

describe("isRecord", () => {
  const yes: ReadonlyArray<readonly [string, unknown]> = [
    ["空のオブジェクト", {}],
    ["値のあるオブジェクト", { a: 1 }],
    ["Object.create(null)", Object.create(null)],
    ["Date(配列でない object は通る。旧実装と同じ)", new Date(0)],
  ];
  const no: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["空の配列", []],
    ["値のある配列", [1, 2]],
    ["文字列", "x"],
    ["数値", 1],
    ["真偽値", true],
    ["関数", () => 1],
  ];
  for (const [name, v] of yes) it(`${name} → true`, () => expect(isRecord(v)).toBe(true));
  for (const [name, v] of no) it(`${name} → false`, () => expect(isRecord(v)).toBe(false));
});

describe("isFiniteNumber", () => {
  const yes: ReadonlyArray<number> = [0, -0, 1, -1.5, Number.MAX_VALUE, Number.MIN_VALUE];
  const no: ReadonlyArray<readonly [string, unknown]> = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["数値の文字列", "1"],
    ["null", null],
    ["undefined", undefined],
    ["bigint", 1n],
    ["Number オブジェクト", new Number(1)],
  ];
  for (const v of yes) it(`${String(v)} → true`, () => expect(isFiniteNumber(v)).toBe(true));
  for (const [name, v] of no) it(`${name} → false`, () => expect(isFiniteNumber(v)).toBe(false));
});

describe("finiteOrNull: 有限の数ならそのまま、そうでなければ null", () => {
  it("有限の数はそのまま(0・負・小数)", () => {
    expect(finiteOrNull(0)).toBe(0);
    expect(finiteOrNull(-3)).toBe(-3);
    expect(finiteOrNull(1.25)).toBe(1.25);
  });
  it("NaN・Infinity・null・undefined・数値でないものは null", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, "1", {}, []]) {
      expect(finiteOrNull(v)).toBeNull();
    }
  });
});
