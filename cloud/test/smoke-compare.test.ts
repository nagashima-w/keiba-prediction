import { describe, expect, it } from "vitest";

import { compareWithFloatTolerance, FLOAT_RELATIVE_TOLERANCE } from "../smoke-compare";

/**
 * Issue #258(smoke E の赤への対応): workerd の runAnalysis の出力を exe 側の golden と比べる許容つき比較。
 *
 * 背景: `Math.log`・`Math.exp` は Node(V8 12.4)と workerd で、同じ引数に最後の 1 ビットだけ違う結果を返すことがある
 * (Issue #275 の本文に、当時の実測)。SHA-256 の完全一致は、この差で赤になる。
 * 浮動小数点の値は相対誤差 {@link FLOAT_RELATIVE_TOLERANCE} 以内、それ以外(項目の集合・文字列・整数・真偽・配列の長さ)は完全一致で比べる。
 */

/** 値 x の次の(1ulp 大きい)倍精度の値。最後の 1 ビットだけ違う値を作る。 */
function nextUp(x: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
}

describe("compareWithFloatTolerance: 許容の定数", () => {
  it("相対誤差の許容は 1e-12 である(実測の最大 2.4e-15 に対して約 400 倍の余裕)", () => {
    expect(FLOAT_RELATIVE_TOLERANCE).toBe(1e-12);
  });
});

describe("compareWithFloatTolerance: 一致する入力", () => {
  it("完全に同じ入れ子の値は ok で、最終ビットの差は 0 件・最大誤差は 0", () => {
    const value = { rows: [{ umaban: 1, prior: 0.1509112708916173, name: "A", flag: true, none: null }], bets: [1, 2, 3] };
    const result = compareWithFloatTolerance(value, structuredClone(value));
    expect(result).toEqual({ ok: true, mismatches: [], mismatchCount: 0, floatDiffCount: 0, maxRelativeError: 0 });
  });

  it("最後の 1 ビットだけ違う小数は ok(件数 1・最大誤差は 1e-15 未満で正)", () => {
    const expected = 0.1509112708916173;
    const actual = nextUp(expected);
    // 前提: 本当に違う値で、差は許容よりずっと小さい(自明に成立するテストにしない)。
    expect(actual).not.toBe(expected);
    expect(Math.abs(actual - expected) / expected).toBeLessThan(FLOAT_RELATIVE_TOLERANCE / 100);
    const result = compareWithFloatTolerance({ prior: actual }, { prior: expected });
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.floatDiffCount).toBe(1);
    expect(result.maxRelativeError).toBeGreaterThan(0);
    expect(result.maxRelativeError).toBeLessThan(1e-15);
  });

  it("複数の最終ビット差は件数に数えられ、最大誤差は最も大きい相対誤差になる", () => {
    const a1 = 0.1509112708916173;
    const a2 = 0.5;
    const result = compareWithFloatTolerance({ xs: [nextUp(a1), nextUp(nextUp(a2)), 7.5] }, { xs: [a1, a2, 7.5] });
    expect(result.ok).toBe(true);
    expect(result.floatDiffCount).toBe(2);
    const e1 = Math.abs(nextUp(a1) - a1) / nextUp(a1);
    const e2 = Math.abs(nextUp(nextUp(a2)) - a2) / nextUp(nextUp(a2));
    // 前提: 2 つの誤差が違う値で、最大が大きい方になることを区別できる。
    expect(e2).not.toBe(e1);
    expect(result.maxRelativeError).toBeCloseTo(Math.max(e1, e2), 25);
  });
});

describe("compareWithFloatTolerance: 浮動小数点の許容(相対誤差の境界。テーブル駆動)", () => {
  const base = 0.15;
  const cases: { name: string; relative: number; ok: boolean }[] = [
    { name: "相対誤差 1e-6(1 頭の prior がずれる規模)は不一致", relative: 1e-6, ok: false },
    { name: "相対誤差 1e-9 は不一致", relative: 1e-9, ok: false },
    { name: "相対誤差 1e-11 は不一致(許容 1e-12 の 10 倍)", relative: 1e-11, ok: false },
    { name: "相対誤差 5e-13(許容 1e-12 の半分)は一致", relative: 5e-13, ok: true },
    { name: "相対誤差 1e-15(最終ビット差の規模)は一致", relative: 1e-15, ok: true },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const actual = base * (1 + c.relative);
      // 前提: ずらした値が本当に違い、ずれの大きさが意図した規模(自明に成立させない)。
      expect(actual).not.toBe(base);
      expect(Math.abs(actual - base) / base).toBeGreaterThan(c.relative / 2);
      const result = compareWithFloatTolerance({ prior: actual }, { prior: base });
      expect(result.ok).toBe(c.ok);
      expect(result.mismatches.length).toBe(c.ok ? 0 : 1);
    });
  }

  it("不一致の報告には、項目の経路・期待値・実測値が入る(rows[14].prior が 1e-6 ずれた)", () => {
    const expected = { result: { rows: [{ prior: 0.1 }, { prior: 0.2 }] } };
    const actual = { result: { rows: [{ prior: 0.1 }, { prior: 0.2 * (1 + 1e-6) }] } };
    const result = compareWithFloatTolerance(actual, expected);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toContain("result.rows[1].prior");
    expect(result.mismatches[0]).toContain(String(0.2));
  });

  it("相対誤差は、符号が負でも大きさ(絶対値)で測る", () => {
    expect(compareWithFloatTolerance({ v: -0.15 * (1 + 1e-6) }, { v: -0.15 }).ok).toBe(false);
    expect(compareWithFloatTolerance({ v: nextUp(-0.15) }, { v: -0.15 }).ok).toBe(true);
  });

  it("0 と極小の値の食い違いは(絶対誤差の下駄を付けないので)不一致", () => {
    const result = compareWithFloatTolerance({ v: 2e-17 }, { v: 0 });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    // 逆向き(期待が極小・実測が 0)も同じ。
    expect(compareWithFloatTolerance({ v: 0 }, { v: 2e-17 }).ok).toBe(false);
  });
});

describe("compareWithFloatTolerance: 整数値は完全一致", () => {
  it("両方とも整数値なら、1 の違い(配分額 1000 と 1001)も不一致", () => {
    const result = compareWithFloatTolerance({ stake: 1001 }, { stake: 1000 });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(1);
  });

  it("両方とも整数値の巨大な値は、相対誤差が許容内でも(1e15 に対する 1)不一致", () => {
    // 前提: 相対誤差は 1e-15 で、小数なら一致するはずの規模。整数値だから落ちる。
    expect(Math.abs(1e15 + 1 - 1e15) / (1e15 + 1)).toBeLessThan(FLOAT_RELATIVE_TOLERANCE);
    expect(compareWithFloatTolerance({ v: 1e15 + 1 }, { v: 1e15 }).ok).toBe(false);
  });

  it("片方だけ整数値(2 と 2.0000000000000004)なら、相対誤差の側で比べて一致(件数 1)", () => {
    const actual = nextUp(2);
    // 前提: 片方は整数値で、片方は整数値ではない。
    expect(Number.isInteger(2)).toBe(true);
    expect(Number.isInteger(actual)).toBe(false);
    const result = compareWithFloatTolerance({ v: actual }, { v: 2 });
    expect(result.ok).toBe(true);
    expect(result.floatDiffCount).toBe(1);
    // 向きを入れ替えても同じ(期待が小数・実測が整数値)。
    const reverse = compareWithFloatTolerance({ v: 2 }, { v: actual });
    expect(reverse.ok).toBe(true);
    expect(reverse.floatDiffCount).toBe(1);
  });

  it("片方だけ整数値でも、相対誤差が許容を超えれば不一致(2 と 2.000001)", () => {
    expect(compareWithFloatTolerance({ v: 2.000001 }, { v: 2 }).ok).toBe(false);
  });

  it("整数値どうしが同じなら、件数に数えない", () => {
    const result = compareWithFloatTolerance({ v: 1000 }, { v: 1000 });
    expect(result.floatDiffCount).toBe(0);
  });
});

describe("compareWithFloatTolerance: 数値以外・構造は完全一致", () => {
  const baseline = { rows: [{ umaban: 1, name: "A", flag: true, none: null as null | number, tags: ["x", "y"] }], count: 3 };

  const table: { name: string; actual: unknown; pathPart: string }[] = [
    { name: "文字列の違い", actual: { ...baseline, rows: [{ ...baseline.rows[0]!, name: "B" }] }, pathPart: "rows[0].name" },
    { name: "真偽の反転", actual: { ...baseline, rows: [{ ...baseline.rows[0]!, flag: false }] }, pathPart: "rows[0].flag" },
    { name: "null が数値になる", actual: { ...baseline, rows: [{ ...baseline.rows[0]!, none: 0 }] }, pathPart: "rows[0].none" },
    { name: "数値が null になる", actual: { ...baseline, count: null }, pathPart: "count" },
    { name: "数値が文字列になる(型の違い)", actual: { ...baseline, count: "3" }, pathPart: "count" },
    { name: "配列の長さが短い", actual: { ...baseline, rows: [{ ...baseline.rows[0]!, tags: ["x"] }] }, pathPart: "rows[0].tags" },
    { name: "配列の長さが長い", actual: { ...baseline, rows: [{ ...baseline.rows[0]!, tags: ["x", "y", "z"] }] }, pathPart: "rows[0].tags" },
    { name: "配列の要素の入れ替え", actual: { ...baseline, rows: [{ ...baseline.rows[0]!, tags: ["y", "x"] }] }, pathPart: "rows[0].tags[0]" },
    { name: "項目が欠ける", actual: { rows: baseline.rows }, pathPart: "count" },
    { name: "項目が増える", actual: { ...baseline, extra: 1 }, pathPart: "extra" },
    { name: "配列とオブジェクトの取り違え", actual: { ...baseline, rows: { 0: baseline.rows[0] } }, pathPart: "rows" },
  ];
  for (const c of table) {
    it(`${c.name}は不一致で、経路 ${c.pathPart} を報告する`, () => {
      // 前提: 比較の基準は、元の値と一致する(基準そのものが壊れていない)。
      expect(compareWithFloatTolerance(structuredClone(baseline), baseline).ok).toBe(true);
      const result = compareWithFloatTolerance(c.actual, baseline);
      expect(result.ok).toBe(false);
      expect(result.mismatches.length).toBeGreaterThan(0);
      expect(result.mismatches.join("\n")).toContain(c.pathPart);
    });
  }

  it("項目の順序の違いは不一致(JSON の項目の順序も出力の一部)", () => {
    const result = compareWithFloatTolerance(JSON.parse('{"b":1,"a":2}'), JSON.parse('{"a":2,"b":1}'));
    expect(result.ok).toBe(false);
  });

  it("不一致の報告が大量でも、報告の行数は上限(20 行)で切る(件数は別に分かる)", () => {
    const expected = { xs: Array.from({ length: 100 }, (_, i) => i + 0.5) };
    const actual = { xs: expected.xs.map((x) => x + 1) };
    const result = compareWithFloatTolerance(actual, expected);
    expect(result.ok).toBe(false);
    expect(result.mismatches.length).toBe(20);
    expect(result.mismatchCount).toBe(100);
  });
});
