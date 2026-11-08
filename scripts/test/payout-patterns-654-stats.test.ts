// #654: ブートストラップ・候補の選別・後半の判定(計画 §4・§6・§7)のテスト。

import { describe, expect, it } from "vitest";

import {
  bootstrapRoi,
  judgeCandidates,
  selectFormCandidates,
  selectConditionCandidates,
  zPoisson,
  type FormResult,
  type ConditionResult,
} from "../payout-patterns-654/stats.js";

/** テスト用の FormResult を作る。perRace の配当から tickets・return を再計算する。 */
function fr(partial: Partial<FormResult> & { perRace: { cost: number; ret: number }[] }): FormResult {
  const tickets = partial.perRace.reduce((a, r) => a + r.cost, 0) / 100;
  const returnYen = partial.perRace.reduce((a, r) => a + r.ret, 0);
  const hitPayouts = partial.perRace.filter((r) => r.ret > 0).map((r) => r.ret);
  return {
    id: "f",
    family: "F1",
    bet: "quinella",
    definition: {},
    races: partial.perRace.length,
    tickets,
    returnYen,
    roi: returnYen / (tickets * 100),
    hits: hitPayouts.length,
    expectedHits: hitPayouts.length,
    fairYen: returnYen,
    hitPayouts,
    ...partial,
  };
}

describe("レース単位のブートストラップ", () => {
  it("同じ再標本でも区間は点推定を含み、シードが同じなら結果が再現する", () => {
    const perRace = [
      { cost: 100, ret: 0 },
      { cost: 100, ret: 300 },
      { cost: 100, ret: 0 },
      { cost: 100, ret: 150 },
      { cost: 100, ret: 0 },
      { cost: 100, ret: 0 },
    ];
    const a = bootstrapRoi(perRace, 500, 654);
    const b = bootstrapRoi(perRace, 500, 654);
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThanOrEqual(0.75);
    expect(a.hi).toBeGreaterThanOrEqual(0.75);
    expect(a.lo).toBeLessThan(a.hi);
    expect(a.pAbove1).toBeGreaterThan(0);
    expect(a.pAbove1).toBeLessThan(1);
  });

  it("全レースが同じ値なら区間は退化し、ROI が 1 を超えるなら p 値は 0", () => {
    const perRace = Array.from({ length: 10 }, () => ({ cost: 100, ret: 120 }));
    const a = bootstrapRoi(perRace, 200, 1);
    expect(a.lo).toBeCloseTo(1.2, 12);
    expect(a.hi).toBeCloseTo(1.2, 12);
    expect(a.pAbove1).toBe(0);
  });

  it("シードが違えば再標本が違う", () => {
    const perRace = [
      { cost: 100, ret: 0 },
      { cost: 100, ret: 900 },
      { cost: 100, ret: 0 },
      { cost: 100, ret: 0 },
    ];
    const a = bootstrapRoi(perRace, 300, 1);
    const b = bootstrapRoi(perRace, 300, 2);
    // 4 レースの再標本では分位点が同じ値になりうるので、平均で比べる
    expect(a.mean).not.toBe(b.mean);
  });
});

describe("ポアソン近似の z", () => {
  it("(A−E)/√E", () => {
    expect(zPoisson(50, 40)).toBeCloseTo(10 / Math.sqrt(40), 12);
    expect(zPoisson(0, 0)).toBe(0);
  });
});

describe("前半の候補の選別(計画 §6)", () => {
  const base = { cost: 100, ret: 0 };
  // 350 レース、的中 105 本(配当 400 円)→ ROI 1.2。
  // (的中が少なく配当が高い形だと、レース単位の区間の下限が 0.90 を割る。
  //  標準誤差 ≈ 400·√(0.3·0.7)/√350 ≈ 9.8 円/レース → ROI で ≈ 0.10。)
  const good = fr({
    id: "good",
    perRace: [...Array.from({ length: 105 }, () => ({ cost: 100, ret: 400 })), ...Array.from({ length: 245 }, () => base)],
  });
  // 的中数の比の候補: 的中 40、見込み 20 → z = 4.47
  const ratio = fr({ id: "ratio", perRace: Array.from({ length: 400 }, () => base), hits: 40, expectedHits: 20, roi: 0.8 });
  // 件数不足
  const few = fr({ id: "few", perRace: [...Array.from({ length: 40 }, () => ({ cost: 100, ret: 400 })), ...Array.from({ length: 95 }, () => base)] });
  // ROI は高いが上位 3 件で決まっている
  const spiky = fr({
    id: "spiky",
    perRace: [
      ...Array.from({ length: 3 }, () => ({ cost: 100, ret: 20000 })),
      ...Array.from({ length: 30 }, () => ({ cost: 100, ret: 200 })),
      ...Array.from({ length: 300 }, () => base),
    ],
  });

  it("ROI の族 F1: 件数・的中・ROI・区間の下限・上位 3 件除外をすべて満たすものだけ", () => {
    expect(good.roi).toBeCloseTo(1.2, 12);
    expect(spiky.roi).toBeGreaterThan(1.05);
    const sel = selectFormCandidates([good, ratio, few, spiky], { reps: 300, seed: 654 });
    const ids = sel.filter((c) => c.family === "F1").map((c) => c.id);
    expect(ids).toEqual(["good"]);
  });

  it("的中数の比の族 F2: 的中 30 以上で |z| ≥ 2", () => {
    const sel = selectFormCandidates([good, ratio, few, spiky], { reps: 300, seed: 654 });
    const ids = sel.filter((c) => c.family === "F2").map((c) => c.id);
    expect(ids).toEqual(["ratio"]);
  });
});

describe("条件の候補の選別(族 F3)", () => {
  const cond = (id: string, p: Partial<ConditionResult>): ConditionResult => ({
    id,
    bet: "trifecta",
    condition: { key: "fieldSize", value: "16" },
    races: 300,
    // 既定は三連単の 1−t = 0.725 を下回る(どちらの規則にも掛からない)
    allRoi: 0.7,
    allRoiLo: 0.6,
    allRoiHi: 0.8,
    bigHits: 20,
    bigHitsExpected: 20,
    hugeHits: 0,
    hugeHitsExpected: 0,
    fairRatio: 1,
    ...p,
  });

  it("全買いの ROI の下限が 1−t を超える、または万馬券の比 ≥ 1.3 かつ見込み ≥ 10 かつ z ≥ 2", () => {
    const a = cond("roi", { allRoiLo: 0.76 }); // 三連単 1−t = 0.725
    const b = cond("big", { bigHits: 40, bigHitsExpected: 25 }); // 比 1.6、z = 3
    const c = cond("none", {});
    const d = cond("fewExp", { bigHits: 20, bigHitsExpected: 8 }); // 見込み不足
    const e = cond("fewRaces", { allRoiLo: 0.9, races: 100 });
    const sel = selectConditionCandidates([a, b, c, d, e]);
    expect(sel.map((x) => x.id).sort()).toEqual(["big", "roi"]);
  });
});

describe("後半の判定(計画 §7)", () => {
  it("ROI の族: 同じ向き・BH q<0.10・上位 3 件除外 ≥ 0.95・件数で判定する", () => {
    // 300 レース、的中 50 本(1,000 円)→ ROI 1.67。標準誤差 ≈ 0.21 なので片側 p は 0.01 未満。
    const pass = fr({
      id: "pass",
      perRace: [...Array.from({ length: 50 }, () => ({ cost: 100, ret: 1000 })), ...Array.from({ length: 250 }, () => ({ cost: 100, ret: 0 }))],
    });
    const fail = fr({
      id: "fail",
      perRace: [...Array.from({ length: 20 }, () => ({ cost: 100, ret: 1000 })), ...Array.from({ length: 280 }, () => ({ cost: 100, ret: 0 }))],
    });
    const few = fr({
      id: "few",
      perRace: [...Array.from({ length: 20 }, () => ({ cost: 100, ret: 1000 })), ...Array.from({ length: 80 }, () => ({ cost: 100, ret: 0 }))],
    });
    expect(pass.roi).toBeGreaterThan(1);
    expect(fail.roi).toBeLessThan(1);
    expect(few.roi).toBeGreaterThan(1);
    const out = judgeCandidates(
      [
        { id: "pass", family: "F1" },
        { id: "fail", family: "F1" },
        { id: "few", family: "F1" },
      ],
      { pass, fail, few },
      { reps: 300, seed: 654 },
    );
    const byId = Object.fromEntries(out.map((o) => [o.id, o]));
    expect(byId.pass?.survived).toBe(true);
    expect(byId.fail?.survived).toBe(false);
    expect(byId.few?.survived).toBe(false);
    expect(byId.few?.reasons).toContain("件数");
    expect(byId.fail?.reasons).toContain("向き");
    expect(byId.pass?.bhQ).toBeLessThan(0.1);
  });

  it("比の族 F2: 前半と同じ符号で BH q<0.10", () => {
    const same = fr({ id: "same", perRace: Array.from({ length: 200 }, () => ({ cost: 100, ret: 0 })), hits: 40, expectedHits: 20 });
    const flipped = fr({ id: "flipped", perRace: Array.from({ length: 200 }, () => ({ cost: 100, ret: 0 })), hits: 10, expectedHits: 20 });
    const out = judgeCandidates(
      [
        { id: "same", family: "F2", direction: 1 },
        { id: "flipped", family: "F2", direction: 1 },
      ],
      { same, flipped },
      { reps: 100, seed: 1 },
    );
    const byId = Object.fromEntries(out.map((o) => [o.id, o]));
    expect(byId.same?.survived).toBe(true);
    expect(byId.flipped?.survived).toBe(false);
  });
});
