import { describe, expect, it } from "vitest";
import {
  MARKET_SHRINK_COEF,
  MARKET_SHRINK_MIN_ODDS_HORSES,
  marketPlaceProbs,
  shrinkTowardMarket,
  type ShrinkHorse,
} from "../../src/ev/market-shrink.js";

/**
 * 確率を市場(単勝オッズ)の 3着内率に寄せる計算(Issue #656)。
 * logit(p') = w·logit(p) + (1−w)·logit(m) を混ぜ、レース内の合計が min(3, 頭数) になるよう共通のロジットのずらしで合わせる。
 * 固定する性質: ①w=1 は入力そのまま(恒等) ②w=0 は m を正規化した値 ③合計が min(3, 頭数) ④オッズの無い馬は混ぜない
 * ⑤全馬(または 5 頭未満)にオッズが無ければ寄せない ⑥頭数が 3 以下なら寄せない ⑦写し方の値を独立に手計算した値と突き合わせる。
 */

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const logit = (p: number): number => Math.log(p / (1 - p));

/** 8 頭立て: 単勝オッズ 2.0〜30 と、それとずれた p。 */
const FIELD: ShrinkHorse[] = [
  { umaban: 1, p: 0.62, winOdds: 2.0 },
  { umaban: 2, p: 0.2, winOdds: 4.5 },
  { umaban: 3, p: 0.5, winOdds: 6.0 },
  { umaban: 4, p: 0.3, winOdds: 9.0 },
  { umaban: 5, p: 0.25, winOdds: 14.0 },
  { umaban: 6, p: 0.55, winOdds: 20.0 },
  { umaban: 7, p: 0.1, winOdds: 30.0 },
  { umaban: 8, p: 0.12, winOdds: 30.0 },
];

const sumOf = (m: Map<number, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

describe("marketPlaceProbs(市場の 3着内率 m)", () => {
  it("係数は #642・#649 と同じ [2.857, 0.9216, −0.5561]", () => {
    expect(MARKET_SHRINK_COEF).toEqual([2.857, 0.9216, -0.5561]);
  });

  it("独立に手計算した値と一致する(q = 1/オッズを割り戻す → 切片 + logit(q) + log(頭数))", () => {
    const m = marketPlaceProbs(FIELD);
    const inv = FIELD.map((h) => 1 / h.winOdds!);
    const tot = inv.reduce((a, b) => a + b, 0);
    FIELD.forEach((h, i) => {
      const q = inv[i]! / tot;
      const expected = sigmoid(2.857 + 0.9216 * logit(q) - 0.5561 * Math.log(8));
      expect(m.get(h.umaban)).toBeCloseTo(expected, 12);
    });
    // 人気が上の馬ほど m が高い(前提の固定: 差があること)
    expect(m.get(1)!).toBeGreaterThan(m.get(7)!);
    expect(m.get(1)! - m.get(7)!).toBeGreaterThan(0.3);
  });

  it("オッズの無い馬(null・0・負)は m を持たず、頭数にも数えない", () => {
    const horses: ShrinkHorse[] = [...FIELD, { umaban: 9, p: 0.2, winOdds: null }, { umaban: 10, p: 0.2, winOdds: 0 }];
    const m = marketPlaceProbs(horses);
    expect(m.has(9)).toBe(false);
    expect(m.has(10)).toBe(false);
    expect(m.size).toBe(8);
    expect(m.get(1)).toBeCloseTo(marketPlaceProbs(FIELD).get(1)!, 12);
  });
});

describe("shrinkTowardMarket(寄せる)", () => {
  it("w=1 は入力をそのまま返す(合計の調整もしない)", () => {
    const out = shrinkTowardMarket(FIELD, 1);
    FIELD.forEach((h) => expect(out.get(h.umaban)).toBe(h.p));
    // 前提: 入力の合計は min(3, 頭数)=3 ではない(調整が入れば値が動く)
    expect(Math.abs(sumOf(out) - 3)).toBeGreaterThan(0.1);
  });

  it("w=0 は市場の m を合計 3 に合わせた値(m の順位が保たれる)", () => {
    const out = shrinkTowardMarket(FIELD, 0);
    expect(sumOf(out)).toBeCloseTo(3, 9);
    const m = marketPlaceProbs(FIELD);
    const order = (x: Map<number, number>): number[] => [...x.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([k]) => k);
    expect(order(out)).toEqual(order(m));
  });

  it.each([0.75, 0.5, 0.25, 0.1])("w=%s: 合計が min(3, 頭数) で、すべて 0〜1 の開区間の中", (w) => {
    const out = shrinkTowardMarket(FIELD, w);
    expect(sumOf(out)).toBeCloseTo(3, 9);
    for (const v of out.values()) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("w=0.5: 市場より高く見積もっていた馬(6 番: p=0.55 は m よりかなり高い)は下がり、安く見積もっていた馬は上がる", () => {
    const m = marketPlaceProbs(FIELD);
    const out = shrinkTowardMarket(FIELD, 0.5);
    // 前提: 6 番は p が m より 0.2 以上高い
    expect(0.55 - m.get(6)!).toBeGreaterThan(0.2);
    expect(out.get(6)!).toBeLessThan(0.55);
    expect(out.get(6)!).toBeGreaterThan(m.get(6)!);
  });

  it("独立に手計算した値と一致する(w=0.5・合計 3 になるずらしを二分法で求める)", () => {
    const m = marketPlaceProbs(FIELD);
    const z = FIELD.map((h) => 0.5 * logit(h.p) + 0.5 * logit(m.get(h.umaban)!));
    let lo = -20;
    let hi = 20;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (z.reduce((a, v) => a + sigmoid(v + mid), 0) < 3) lo = mid;
      else hi = mid;
    }
    const out = shrinkTowardMarket(FIELD, 0.5);
    FIELD.forEach((h, i) => expect(out.get(h.umaban)).toBeCloseTo(sigmoid(z[i]! + (lo + hi) / 2), 9));
  });

  it("一部の馬だけオッズが無い: その馬は混ぜず(m=p)、ほかは寄せ、全体を合計 3 に合わせる", () => {
    const horses: ShrinkHorse[] = FIELD.map((h) => (h.umaban === 2 ? { ...h, winOdds: null } : h));
    const out = shrinkTowardMarket(horses, 0.5);
    expect(sumOf(out)).toBeCloseTo(3, 9);
    // オッズのある馬の m は、オッズの無い馬を除いた 7 頭で作る
    const m = marketPlaceProbs(horses);
    expect(m.size).toBe(7);
    // 手計算: 2 番は w に関わらず logit(p) のまま(ずらしだけ)
    const z = horses.map((h) => (m.has(h.umaban) ? 0.5 * logit(h.p) + 0.5 * logit(m.get(h.umaban)!) : logit(h.p)));
    let lo = -20;
    let hi = 20;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (z.reduce((a, v) => a + sigmoid(v + mid), 0) < 3) lo = mid;
      else hi = mid;
    }
    horses.forEach((h, i) => expect(out.get(h.umaban)).toBeCloseTo(sigmoid(z[i]! + (lo + hi) / 2), 9));
  });

  it("全馬にオッズが無い・オッズのある馬が最小頭数未満なら寄せない(入力そのまま)", () => {
    const none = FIELD.map((h) => ({ ...h, winOdds: null }));
    for (const v of shrinkTowardMarket(none, 0.5)) expect(v[1]).toBe(none.find((h) => h.umaban === v[0])!.p);
    expect(MARKET_SHRINK_MIN_ODDS_HORSES).toBe(5);
    const few = FIELD.map((h, i) => (i < 4 ? h : { ...h, winOdds: null }));
    for (const v of shrinkTowardMarket(few, 0.5)) expect(v[1]).toBe(few.find((h) => h.umaban === v[0])!.p);
  });

  it("3 頭以下の立ては寄せない(合計 = 頭数は 0〜1 の確率では作れない)", () => {
    const small: ShrinkHorse[] = FIELD.slice(0, 3);
    for (const v of shrinkTowardMarket(small, 0.5)) expect(v[1]).toBe(small.find((h) => h.umaban === v[0])!.p);
  });

  it("4 頭立て: オッズのある馬が最小頭数(5)未満なので寄せない", () => {
    const four = FIELD.slice(0, 4).map((h, i) => ({ ...h, winOdds: [1.5, 3, 6, 12][i]! }));
    // オッズのある馬が 4 頭 < 最小頭数 5 のため寄せない
    for (const v of shrinkTowardMarket(four, 0.5)) expect(v[1]).toBe(four.find((h) => h.umaban === v[0])!.p);
  });

  it("w が 0〜1 の外・非有限は例外", () => {
    expect(() => shrinkTowardMarket(FIELD, 1.1)).toThrow();
    expect(() => shrinkTowardMarket(FIELD, -0.1)).toThrow();
    expect(() => shrinkTowardMarket(FIELD, Number.NaN)).toThrow();
  });

  it("入力を書き換えない・p が 0 や 1 でも有限の値を返す", () => {
    const horses: ShrinkHorse[] = FIELD.map((h) => ({ ...h }));
    horses[0] = { ...horses[0]!, p: 1 };
    horses[6] = { ...horses[6]!, p: 0 };
    const copy = JSON.stringify(horses);
    const out = shrinkTowardMarket(horses, 0.5);
    expect(JSON.stringify(horses)).toBe(copy);
    for (const v of out.values()) expect(Number.isFinite(v)).toBe(true);
    expect(sumOf(out)).toBeCloseTo(3, 9);
  });
});
