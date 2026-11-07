import { describe, expect, it } from "vitest";
import { keyHorses, horseRatios, betRecords, ninkiBand, quantile } from "../../docs/investigations/price-drift-657/drift.js";
import type { AllocationRaceRow } from "../allocation-dataset.js";

/** 最小の行。判定に使う列だけ埋める。 */
function row(over: { bets: Array<{ bet_type: string; combo_key: string; stake: number; odds: number; ev: number }>; payouts?: Record<string, Array<[string, number]>>; imports?: string[] }): AllocationRaceRow {
  const hs = [
    { umaban: 1, ninki: 1, aw: 2.0, fw: 1.0, pp: 120 },
    { umaban: 2, ninki: 2, aw: 4.0, fw: 6.0, pp: null },
    { umaban: 3, ninki: 7, aw: 20.0, fw: null, pp: null },
  ];
  return {
    analysis_id: 1, race_id: "x", kaisai_date: "20260801", venue_kind: "central", field_size: 3, analyzed_at: "2026-07-31T00:00:00Z",
    has_odds: true,
    horses: hs.map((h) => ({ umaban: h.umaban, wakuban: h.umaban, prior: 0.3, adjusted_prob: 0.3, win_odds: h.aw, ninki: h.ninki, place_min: 1.5, place_max: 2, place_odds_min: 1.5, ev: 1 })),
    combos: {}, combo_states: {},
    allocation: { settings: {}, codes: {}, odds_status: "x", bets: over.bets, missed: null },
    result: {
      horses: hs.map((h, i) => ({ umaban: h.umaban, finish_position: i + 1, scratched: null, wakuban: h.umaban, place_payout: h.pp, win_payout: i === 0 ? 100 : null, win_odds: h.fw, ninki: h.ninki })),
      combo_payouts: over.payouts ?? {}, payout_imports: over.imports ?? [],
    },
  } as unknown as AllocationRaceRow;
}

describe("keyHorses", () => {
  it.each([
    ["win", "03", [3]],
    ["place", "12", [12]],
    ["wide", "0208", [2, 8]],
    ["trio", "030406", [3, 4, 6]],
    ["exacta", "0901", [9, 1]],
    ["bracketQuinella", "0606", null],
    ["trifecta", "0309", null], // 桁数が券種と合わない
  ])("%s %s", (t, k, exp) => {
    expect(keyHorses(t, k)).toEqual(exp);
  });
});

describe("ninkiBand / quantile", () => {
  it("人気帯の境界", () => {
    expect([1, 3, 4, 6, 7, 18].map(ninkiBand)).toEqual(["1-3", "1-3", "4-6", "4-6", "7-", "7-"]);
  });
  it("分位点(線形補間)", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.9)).toBe(5);
  });
});

describe("horseRatios", () => {
  it("確定が無い馬は外し、買い目に入った馬の券種を持つ", () => {
    const r = row({ bets: [{ bet_type: "wide", combo_key: "0102", stake: 100, odds: 5, ev: 1.2 }, { bet_type: "win", combo_key: "01", stake: 100, odds: 2, ev: 1.1 }] });
    const hr = horseRatios(r);
    expect(hr.map((h) => h.umaban)).toEqual([1, 2]); // 3 は確定の単勝が無い
    expect(hr[0]).toMatchObject({ ratio: 0.5, ninki: 1, types: ["wide", "win"] });
    expect(hr[1]).toMatchObject({ ratio: 1.5, types: ["wide"] });
  });
  it("取消の馬は外す", () => {
    const r = row({ bets: [] });
    (r.result.horses[0] as { scratched: boolean | null }).scratched = true;
    expect(horseRatios(r).map((h) => h.umaban)).toEqual([2]);
  });
  it("買い目が無い行は全馬が入らなかった側", () => {
    const hr = horseRatios(row({ bets: [] }));
    expect(hr.length).toBe(2);
    expect(hr.every((h) => h.types.length === 0)).toBe(true);
  });
});

describe("betRecords", () => {
  it("単勝は確定オッズで実測、p = ev / odds、実際の払戻は判定どおり", () => {
    const r = row({ bets: [{ bet_type: "win", combo_key: "01", stake: 200, odds: 2, ev: 1.2 }] });
    const [b] = betRecords(r);
    expect(b!.p).toBeCloseTo(0.6, 12);
    expect(b!.oddsFinal).toBe(1); // 確定オッズ 1.0
    expect(b!.e0).toBeCloseTo(200 * 1.2, 9);
    expect(b!.e1Measured).toBeCloseTo(200 * 0.6 * 1.0, 9);
    expect(b!.actual).toBe(200); // 100 円あたり 100 → 200 円
  });
  it("複勝・組合せの感度試算は、馬ごとの単勝の比の積(積は E0 に掛ける)", () => {
    const r = row({ bets: [{ bet_type: "wide", combo_key: "0102", stake: 100, odds: 5, ev: 1.5 }], payouts: { wide: [["0203", 500]] }, imports: ["wide"] });
    const [b] = betRecords(r);
    expect(b!.proxyRatio).toBeCloseTo(0.5 * 1.5, 12);
    expect(b!.e1Proxy).toBeCloseTo(100 * 1.5 * 0.75, 9);
    expect(b!.e1Measured).toBeNull(); // 外れ: 確定オッズは不明
  });
  it("的中した組合せは払戻 ÷ 100 を確定オッズの実測にする", () => {
    const r = row({ bets: [{ bet_type: "wide", combo_key: "0102", stake: 100, odds: 5, ev: 1.5 }], payouts: { wide: [["0102", 380]] }, imports: ["wide"] });
    const [b] = betRecords(r);
    expect(b!.hit).toBe(true);
    expect(b!.oddsFinal).toBeCloseTo(3.8, 12);
    expect(b!.e1Measured).toBeCloseTo(100 * 0.3 * 3.8, 9);
    expect(b!.actual).toBe(380);
  });
  it("枠連・比が作れない買い目は proxyRatio が null", () => {
    const r = row({ bets: [{ bet_type: "bracketQuinella", combo_key: "0102", stake: 100, odds: 5, ev: 1 }, { bet_type: "win", combo_key: "03", stake: 100, odds: 20, ev: 1 }], payouts: { bracketQuinella: [["0303", 900]] }, imports: ["bracketQuinella"] });
    const bs = betRecords(r);
    expect(bs[0]!.proxyRatio).toBeNull();
    expect(bs[1]!.proxyRatio).toBeNull(); // 3 番は確定の単勝が無い
  });
  it("払戻表が未取込の買い目は除く", () => {
    const r = row({ bets: [{ bet_type: "wide", combo_key: "0102", stake: 100, odds: 5, ev: 1 }] });
    expect(betRecords(r)).toEqual([]);
  });
});
