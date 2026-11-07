/**
 * 組合せの確率を尖らせる・差し替える試算の道具(Issue #661 段階 1。docs/investigations/combo-sharpen-661/sharpen.ts)の純粋な部分のテスト。
 */
import { describe, expect, it } from "vitest";
import { PLACKETT_LUCE_MODEL } from "../../packages/core/src/ev/plackett-luce-model.js";
import type { JointModelHorse, OrderedPlaceJointModel } from "../../packages/core/src/ev/place-joint-model.js";
import { fitPlackettLuceStrengths } from "../../packages/core/src/ev/plackett-luce-strength.js";
import {
  bandOf,
  betMinRank,
  frontHalfDates,
  popularityRanks,
  sharpenedPlModel,
  substituteProbsModel,
} from "../../docs/investigations/combo-sharpen-661/sharpen.js";

const mk = (ps: readonly number[]): JointModelHorse[] => ps.map((p, i) => ({ umaban: i + 1, placeProb: p }));
const FREE = mk([0.9, 0.8, 0.6, 0.4, 0.2, 0.1]); // 全馬が有限正の θ になる入力(Σ=3)
const FIXED = mk([1, 0.8, 0.7, 0.5, 0, 0]); // θ に Infinity と 0 が出る入力

const setMap = (d: readonly { placed: readonly number[]; probability: number }[]): Map<string, number> =>
  new Map(d.map((o) => [o.placed.join(","), o.probability]));
const ordMap = (d: readonly { order: readonly number[]; probability: number }[]): Map<string, number> =>
  new Map(d.map((o) => [o.order.join(","), o.probability]));
function expectSameMap(a: Map<string, number>, b: Map<string, number>): void {
  expect(a.size).toBe(b.size);
  for (const [k, v] of b) expect(a.get(k) ?? Number.NaN).toBeCloseTo(v, 10);
}

describe("sharpenedPlModel(θ を τ 乗した Plackett–Luce)", () => {
  it("前提: FREE の θ は全馬が有限正、FIXED は Infinity か 0 を含む", () => {
    const f = fitPlackettLuceStrengths(FREE, 3);
    expect(f.ok && f.theta.every((t) => Number.isFinite(t) && t > 0)).toBe(true);
    const g = fitPlackettLuceStrengths(FIXED, 3);
    expect(g.ok && g.theta.some((t) => t === 0 || t === Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("τ = 1 は本番の PLACKETT_LUCE_MODEL と集合の分布・順序の分布が一致する", () => {
    const m = sharpenedPlModel(1);
    expect(PLACKETT_LUCE_MODEL.buildDistribution(FREE, 3).length).toBe(20);
    expectSameMap(setMap(m.model.buildDistribution(FREE, 3)), setMap(PLACKETT_LUCE_MODEL.buildDistribution(FREE, 3)));
    const ord = m.model.buildOrderedDistribution(FREE, 3)!;
    expect(ord.length).toBe(120);
    expectSameMap(ordMap(ord), ordMap(PLACKETT_LUCE_MODEL.buildOrderedDistribution(FREE, 3)!));
  });

  it("τ = 1.6 の 1 着確率は θ^τ / Σθ^τ(θ は本番と同じ当てはめ)で、τ = 1 より本命が上がり合計は 1", () => {
    const f = fitPlackettLuceStrengths(FREE, 3);
    if (!f.ok) throw new Error("前提");
    const pow = f.theta.map((t) => t ** 1.6);
    const tot = pow.reduce((a, b) => a + b, 0);
    const ord = sharpenedPlModel(1.6).model.buildOrderedDistribution(FREE, 3)!;
    const win = new Map<number, number>();
    for (const o of ord) win.set(o.order[0]!, (win.get(o.order[0]!) ?? 0) + o.probability);
    pow.forEach((v, i) => expect(win.get(i + 1)!).toBeCloseTo(v / tot, 10));
    const base = new Map<number, number>();
    for (const o of PLACKETT_LUCE_MODEL.buildOrderedDistribution(FREE, 3)!) base.set(o.order[0]!, (base.get(o.order[0]!) ?? 0) + o.probability);
    expect(win.get(1)!).toBeGreaterThan(base.get(1)! + 0.01); // 差が 0 でないことを先に固定
    expect(ord.reduce((a, o) => a + o.probability, 0)).toBeCloseTo(1, 10);
  });

  it("集合の分布は順序の分布を畳んだものと一致し、合計は 1(τ = 1.4)", () => {
    const m = sharpenedPlModel(1.4).model;
    const folded = new Map<string, number>();
    for (const o of m.buildOrderedDistribution(FREE, 3)!) {
      const key = [...o.order].sort((a, b) => a - b).join(",");
      folded.set(key, (folded.get(key) ?? 0) + o.probability);
    }
    const set = m.buildDistribution(FREE, 3);
    expect(set.length).toBe(20);
    expectSameMap(setMap(set), folded);
    expect(set.reduce((a, o) => a + o.probability, 0)).toBeCloseTo(1, 10);
  });

  it("θ に 0・Infinity が出る入力は尖らせず本番モデルへ委ね、委ねた回数を数える(集合・順序の呼び出しごとに 1)", () => {
    const m = sharpenedPlModel(1.6);
    expect(m.delegated()).toBe(0);
    const ord = m.model.buildOrderedDistribution(FIXED, 3);
    expect(m.delegated()).toBe(1);
    expect(ord === null ? null : [...ordMap(ord)]).toEqual(
      PLACKETT_LUCE_MODEL.buildOrderedDistribution(FIXED, 3) === null ? null : [...ordMap(PLACKETT_LUCE_MODEL.buildOrderedDistribution(FIXED, 3)!)],
    );
    expectSameMap(setMap(m.model.buildDistribution(FIXED, 3)), setMap(PLACKETT_LUCE_MODEL.buildDistribution(FIXED, 3)));
    expect(m.delegated()).toBe(2);
  });

  it("縮退(k ≥ 頭数・0 頭・k = 0)は本番モデルと同じ結果", () => {
    const m = sharpenedPlModel(1.6).model;
    expect(m.buildDistribution(mk([0.9, 0.8, 0.6]), 3)).toEqual(PLACKETT_LUCE_MODEL.buildDistribution(mk([0.9, 0.8, 0.6]), 3));
    expect(m.buildOrderedDistribution(mk([0.9, 0.8, 0.6]), 3)).toEqual(PLACKETT_LUCE_MODEL.buildOrderedDistribution(mk([0.9, 0.8, 0.6]), 3));
    expect(m.buildDistribution([], 3)).toEqual(PLACKETT_LUCE_MODEL.buildDistribution([], 3));
  });

  it("τ が正の有限でなければ例外", () => {
    expect(() => sharpenedPlModel(0)).toThrow();
    expect(() => sharpenedPlModel(Number.NaN)).toThrow();
  });
});

describe("substituteProbsModel(馬ごとの確率を差し替えて本番モデルを呼ぶ)", () => {
  it("差し替えた確率で作った分布は、その確率を直接渡した本番モデルと一致し、元の確率とは違う", () => {
    const alt = new Map(FREE.map((h, i) => [h.umaban, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5][i]!] as const));
    const m = substituteProbsModel(alt, PLACKETT_LUCE_MODEL);
    const direct = PLACKETT_LUCE_MODEL.buildOrderedDistribution(mk([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), 3)!;
    expectSameMap(ordMap(m.model.buildOrderedDistribution(FREE, 3)!), ordMap(direct));
    const orig = ordMap(PLACKETT_LUCE_MODEL.buildOrderedDistribution(FREE, 3)!);
    expect(Math.abs(orig.get("1,2,3")! - ordMap(direct).get("1,2,3")!)).toBeGreaterThan(0.01);
  });

  it("差し替えた確率でモデルが例外を投げたら、元の確率で呼び直し、その回数を数える", () => {
    const MARK = 0.123;
    const base: OrderedPlaceJointModel = {
      ...PLACKETT_LUCE_MODEL,
      buildDistribution: (hs, k) => {
        if (hs[0]!.placeProb === MARK) throw new Error("当てはめ失敗");
        return PLACKETT_LUCE_MODEL.buildDistribution(hs, k);
      },
      buildOrderedDistribution: (hs, k) => {
        if (hs[0]!.placeProb === MARK) throw new Error("当てはめ失敗");
        return PLACKETT_LUCE_MODEL.buildOrderedDistribution(hs, k);
      },
    };
    const alt = new Map(FREE.map((h) => [h.umaban, h.umaban === 1 ? MARK : 0.5] as const));
    const m = substituteProbsModel(alt, base);
    expectSameMap(setMap(m.model.buildDistribution(FREE, 3)), setMap(PLACKETT_LUCE_MODEL.buildDistribution(FREE, 3)));
    expect(m.fallbacks()).toBe(1);
    expectSameMap(ordMap(m.model.buildOrderedDistribution(FREE, 3)!), ordMap(PLACKETT_LUCE_MODEL.buildOrderedDistribution(FREE, 3)!));
    expect(m.fallbacks()).toBe(2);
  });

  it("差し替えの表に無い馬は元の確率のまま", () => {
    const m = substituteProbsModel(new Map(), PLACKETT_LUCE_MODEL);
    expectSameMap(setMap(m.model.buildDistribution(FREE, 3)), setMap(PLACKETT_LUCE_MODEL.buildDistribution(FREE, 3)));
  });
});

describe("人気順・帯・買い目の最小人気", () => {
  const horses = [
    { umaban: 1, winOdds: 5.0 },
    { umaban: 2, winOdds: 1.5 },
    { umaban: 3, winOdds: 5.0 },
    { umaban: 4, winOdds: null },
    { umaban: 5, winOdds: 20 },
  ];
  it("popularityRanks: オッズの小さい順。同オッズは同順位(競争順位)、オッズ無しは最後", () => {
    const r = popularityRanks(horses);
    expect([...r]).toEqual([[1, 2], [2, 1], [3, 2], [4, 5], [5, 4]]);
  });
  it.each([
    [1, "1〜3番人気"], [3, "1〜3番人気"], [4, "4〜6番人気"], [6, "4〜6番人気"], [7, "7番人気〜"], [18, "7番人気〜"],
  ])("bandOf(%i) = %s", (rank, expected) => expect(bandOf(rank)).toBe(expected));
  it("betMinRank: 買い目に含む馬のうち人気の一番低い(順位の最大の)馬。馬単・三連単の順序付きキーも集合として読む", () => {
    const r = popularityRanks(horses);
    expect(betMinRank("win", "05", r, new Map())).toBe(4);
    expect(betMinRank("quinella", "0205", r, new Map())).toBe(4);
    expect(betMinRank("exacta", "0501", r, new Map())).toBe(4);
    expect(betMinRank("trifecta", "020103", r, new Map())).toBe(2);
  });
  it("betMinRank: 枠連は枠に入る馬のうち人気の一番低い馬(枠番 → 馬番の表を使う)。読めないキーは null", () => {
    const r = popularityRanks(horses);
    const waku = new Map([[1, 1], [2, 1], [3, 2], [4, 3], [5, 3]]);
    expect(betMinRank("bracketQuinella", "0103", r, waku)).toBe(5); // 枠 1(馬 1・2)と枠 3(馬 4・5)→ 馬 4 が 5 番人気
    expect(betMinRank("win", "abc", r, new Map())).toBeNull();
  });
});

describe("frontHalfDates(レース数がほぼ半々になる日付の境目。同じ日は同じ側)", () => {
  it("同日は分けず、前半のレース数と半数の差が最小になる境目を選ぶ", () => {
    // 日付ごとのレース数: 10/01=3, 10/02=3, 10/03=1, 10/04=3 → 計 10。前半 3+3=6(差 1)か 3+3+1=7(差 2)→ 6
    const dates = ["10/01", "10/01", "10/01", "10/02", "10/02", "10/02", "10/03", "10/04", "10/04", "10/04"];
    expect([...frontHalfDates(dates)].sort()).toEqual(["10/01", "10/02"]);
  });
  it("前半と後半が空にならず、日が 1 つだけなら例外", () => {
    expect(frontHalfDates(["a", "b"]).size).toBe(1);
    expect(() => frontHalfDates(["a", "a"])).toThrow();
  });
});
