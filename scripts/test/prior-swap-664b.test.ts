/**
 * #664 段階 1b(回収率の試算)の道具の純粋な部分のテスト(docs/investigations/prior-swap-664b/)。
 */
import { describe, expect, it } from "vitest";
import { SHADOW_COEF_NODDS, SHADOW_CONTRIB_NAMES } from "../../packages/core/src/ev/stat-shadow-coef.js";
import { lrTop3 } from "../../docs/investigations/prior-swap-662/lr.js";
import { buildExtra, lr664Top3, MARK_FEATURES, FLAG_FEATURES } from "../../docs/investigations/prior-swap-664b/lr664.js";
import { pairedRateDiff, ruleCheck, type RaceCell } from "../../docs/investigations/prior-swap-664b/stats664.js";

function rng(seed: number): () => number {
  let a = seed;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function field(n: number, seed: number) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    umaban: i + 1,
    prior: 0.05 + 0.5 * r(),
    contrib: Object.fromEntries(SHADOW_CONTRIB_NAMES.map((k) => [k, (r() - 0.5) * 0.2])) as Record<string, number>,
    extra: buildExtra(i % 2 === 0 ? { noprev: 0, filly: 1, rest180: i % 4 === 0 ? 1 : 0 } : undefined, i % 3 === 0 ? "▲" : null),
  }));
}
/** 追加特徴量の重みを持つ係数(オッズなし版の係数に、旗・印を足したもの)。 */
const COEF = (() => {
  const add = ["noprev", "filly", "rest180", "mk_▲"];
  return {
    ...SHADOW_COEF_NODDS,
    features: [...SHADOW_COEF_NODDS.features, ...add],
    top3: { ...SHADOW_COEF_NODDS.top3, weights: [...SHADOW_COEF_NODDS.top3.weights, 0.3, -0.2, 0.15, 0.5] },
  };
})();

describe("buildExtra(旗と印の組み立て)", () => {
  it("特徴量の行が無い馬は noprev=1・ほかの旗は 0(fit_eval.py と同じ)", () => {
    const e = buildExtra(undefined, null);
    expect(e.noprev).toBe(1);
    for (const f of FLAG_FEATURES) if (f !== "noprev") expect(e[f]).toBe(0);
    for (const m of MARK_FEATURES) expect(e[m]).toBe(0);
  });
  it("行があればその値、印は該当する 1 つだけ 1", () => {
    const e = buildExtra({ noprev: 0, filly: 1 }, "☆");
    expect(e.noprev).toBe(0);
    expect(e.filly).toBe(1);
    expect(e["mk_☆"]).toBe(1);
    expect(MARK_FEATURES.filter((m) => e[m] === 1)).toEqual(["mk_☆"]);
  });
  it("旗は 14 個・印は 5 個", () => {
    expect(FLAG_FEATURES).toHaveLength(14);
    expect(MARK_FEATURES).toHaveLength(5);
  });
});

describe("lr664Top3", () => {
  it("追加の重みが 0 なら #662 の lrTop3 と一致する(退化でないことを、追加の重みが 0 でないときとの差で確認)", () => {
    const horses = field(10, 5);
    const zeroW = { ...COEF, top3: { ...COEF.top3, weights: [...SHADOW_COEF_NODDS.top3.weights, 0, 0, 0, 0] } };
    const a = lr664Top3(horses, zeroW)!, b = lrTop3(horses, SHADOW_COEF_NODDS)!;
    for (const [u, p] of b) expect(Math.abs(a.get(u)! - p)).toBeLessThan(1e-12);
    const c = lr664Top3(horses, COEF)!;
    expect(Math.max(...[...b].map(([u, p]) => Math.abs(c.get(u)! - p)))).toBeGreaterThan(1e-3);
    expect([...c.values()].reduce((s, x) => s + x, 0)).toBeCloseTo(3, 9);
  });
  it("旗の値がその馬の確率に効く(重みの符号どおり)", () => {
    const base = field(8, 2);
    const flip = base.map((h) => (h.umaban === 3 ? { ...h, extra: { ...h.extra, "mk_▲": 1 } } : h));
    const off = base.map((h) => (h.umaban === 3 ? { ...h, extra: { ...h.extra, "mk_▲": 0 } } : h));
    expect(lr664Top3(flip, COEF)!.get(3)!).toBeGreaterThan(lr664Top3(off, COEF)!.get(3)!);
  });
  it("5 頭未満は null、知らない特徴量は例外", () => {
    expect(lr664Top3(field(4, 1), COEF)).toBeNull();
    const bad = { ...COEF, features: [...COEF.features, "zzz"], top3: { ...COEF.top3, weights: [...COEF.top3.weights, 1] } };
    expect(() => lr664Top3(field(6, 1), bad)).toThrow();
  });
});

const cell = (stake: number, ret: number, exp: number, act: number): RaceCell => ({ stake, ret, exp, act });

describe("ruleCheck(回収率が cur 以上、かつ |見込み/実−1| が cur より小さい)", () => {
  const cur = [cell(1000, 960, 11, 10)]; // 96%・見込み/実 1.1
  it.each([
    ["回収率が同じ・見込み/実が 1 に近い", [cell(1000, 960, 10.5, 10)], true],
    ["回収率が上・見込み/実が遠い", [cell(1000, 1100, 12, 10)], false],
    ["回収率が下・見込み/実が近い", [cell(1000, 900, 10.2, 10)], false],
    ["見込み/実が 1 の反対側(0.85)で cur(1.1)より 1 から遠い", [cell(1000, 960, 8.5, 10)], false],
    ["見込み/実が 1 の反対側(0.95)で cur(1.1)より 1 に近い", [cell(1000, 960, 9.5, 10)], true],
    ["実的中 0 は不可", [cell(1000, 1100, 1, 0)], false],
  ])("%s", (_n, cand, expected) => {
    expect(ruleCheck(cur, cand).qualified).toBe(expected);
  });
  it("(1)(2) を別々に返す", () => {
    const r = ruleCheck(cur, [cell(1000, 900, 10.2, 10)]);
    expect(r.ok1).toBe(false);
    expect(r.ok2).toBe(true);
  });
});

describe("pairedRateDiff(回収率の差の対ブートストラップ)", () => {
  const a = Array.from({ length: 200 }, (_, i) => cell(100, i % 10 === 0 ? 900 : 0, 0, 0));
  it("同一なら点推定も区間も 0", () => {
    const r = pairedRateDiff(a, a, 7, 500);
    expect(r.point).toBe(0);
    expect(r.lo).toBe(0);
    expect(r.hi).toBe(0);
  });
  it("全レースで払戻が +20 なら、点推定 +0.2 で区間も 0 を含まず、正の割合は 1(差が 0 でないことを先に固定)", () => {
    const b = a.map((c) => cell(c.stake, c.ret + 20, 0, 0));
    const r = pairedRateDiff(a, b, 7, 500);
    expect(r.point).toBeCloseTo(0.2, 12);
    expect(r.lo).toBeCloseTo(0.2, 12);
    expect(r.hi).toBeCloseTo(0.2, 12);
    expect(r.positiveFrac).toBe(1);
  });
  it("同じシードなら同じ結果(再現可能)", () => {
    const b = a.map((_c, i) => cell(100, i % 7 === 0 ? 700 : 0, 0, 0));
    expect(pairedRateDiff(a, b, 3, 300)).toEqual(pairedRateDiff(a, b, 3, 300));
  });
});
