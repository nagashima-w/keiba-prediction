import { describe, expect, it } from "vitest";
import type { AnalysisDetail, AnalysisHorse, LegStyle } from "../client/api-analysis";
import { PREDICTION_MARKS } from "../../packages/core/src/analyzer/parse-response";
import { buildFormation, FORMATION_SLOTS, MAIN_MARK } from "../client/formation-model";

/**
 * Issue #362(想定隊列図): 純関数 — 道中と4コーナーの「列」の割り当て・凡例・注記。
 * 抽選・乱数は使わない(同じ分析なら同じ図)。勝率・3着内率は位置に影響しない(脚質と想定ペースだけで決める)。
 */

function horse(umaban: number, over: Partial<AnalysisHorse> = {}): AnalysisHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.3, adjustedProb: 0.25, placeOddsMin: 1.8, ev: 1.05, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: 0.1, fairWinOdds: 8, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, earlyPos: null, latePos: null, legStyle: null, ...over };
}

function analysis(horses: AnalysisHorse[], race: Partial<AnalysisDetail["race"]> = {}, development: AnalysisDetail["development"] = null): AnalysisDetail {
  return {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: "20260628",
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テスト", grade: null, oddsStatus: "result", placeBasis: "top3", distance: 1800, pace: "平均", ...race } as AnalysisDetail["race"],
    development,
    horses,
    allocation: null,
    detail: "present",
  } as AnalysisDetail;
}

/** 脚質が 逃げ・先行・差し・追込 の 1 頭ずつ(馬番 1〜4)。 */
const four = (): AnalysisHorse[] => [
  horse(1, { legStyle: "逃げ", earlyPos: 0.1 }),
  horse(2, { legStyle: "先行", earlyPos: 0.3 }),
  horse(3, { legStyle: "差し", earlyPos: 0.5 }),
  horse(4, { legStyle: "追込", earlyPos: 0.8 }),
];

const slotsOf = (a: AnalysisDetail, phase: 0 | 1): Record<number, number> => {
  const f = buildFormation(a);
  expect(f).not.toBeNull();
  return Object.fromEntries(f!.phases[phase]!.chips.map((c) => [c.umaban, c.slot]));
};

describe("buildFormation: 列の割り当て(手計算した値。単位はチップ 1 個分)", () => {
  it("前提: 列は 10 本、局面は「道中」「4コーナー」の 2 つ(この順)", () => {
    expect(FORMATION_SLOTS).toBe(10);
    const f = buildFormation(analysis(four()));
    expect(f!.phases.map((p) => p.label)).toEqual(["道中", "4コーナー"]);
  });

  it("平均ペース: 道中は集団の間が 1.6 → 位置 0・1.6・3.2・4.8 → 列 0・2・3・5。4コーナーは差し×0.6・追込×0.55 → 0・1.6・1.92・2.64 → 列 0・2・2・3", () => {
    const a = analysis(four(), { pace: "平均" });
    expect(slotsOf(a, 0)).toEqual({ 1: 0, 2: 2, 3: 3, 4: 5 });
    expect(slotsOf(a, 1)).toEqual({ 1: 0, 2: 2, 3: 2, 4: 3 });
  });

  it("ハイペース: 隊列が長い(×1.25 → 0・2・4・6)。4コーナーは逃げ+0.8・先行+0.5 後退、差し×0.5・追込×0.45 → 0.8・2.5・2・2.7 を先頭 0 に取り直して 0・1.7・1.2・1.9 → 列 0・2・1・2(差しが先行の前に出る)", () => {
    const a = analysis(four(), { pace: "ハイ" });
    expect(slotsOf(a, 0)).toEqual({ 1: 0, 2: 2, 3: 4, 4: 6 });
    expect(slotsOf(a, 1)).toEqual({ 1: 0, 2: 2, 3: 1, 4: 2 });
  });

  it("スローペース: 隊列が詰まる(×0.75 → 0・1.2・2.4・3.6)。4コーナーは差し×0.75・追込×0.7 → 0・1.2・1.8・2.52 → 列 0・1・2・3", () => {
    const a = analysis(four(), { pace: "スロー" });
    expect(slotsOf(a, 0)).toEqual({ 1: 0, 2: 1, 3: 2, 4: 4 });
    expect(slotsOf(a, 1)).toEqual({ 1: 0, 2: 1, 3: 2, 4: 3 });
  });

  it("想定ペースが「不明」は平均として描く(列は平均と同じ)", () => {
    expect(slotsOf(analysis(four(), { pace: "不明" }), 0)).toEqual(slotsOf(analysis(four(), { pace: "平均" }), 0));
    expect(slotsOf(analysis(four(), { pace: "不明" }), 1)).toEqual(slotsOf(analysis(four(), { pace: "平均" }), 1));
    // キー無し(古いサーバの応答)も平均
    const noPace = analysis(four());
    delete (noPace.race as { pace?: unknown }).pace;
    expect(slotsOf(noPace, 0)).toEqual(slotsOf(analysis(four(), { pace: "平均" }), 0));
  });

  it("どのペースでも、4コーナーの先頭は列 0(先頭を 0 に取り直す)。道中の先頭も列 0", () => {
    for (const pace of ["スロー", "平均", "ハイ", "不明"] as const) {
      const a = analysis(four(), { pace });
      expect(Math.min(...Object.values(slotsOf(a, 0))), pace).toBe(0);
      expect(Math.min(...Object.values(slotsOf(a, 1))), pace).toBe(0);
    }
  });

  it("ペースが速いほど道中の隊列(最後尾の列)が長い: スロー < 平均 < ハイ(前提の値を固定してから比べる)", () => {
    const tail = (pace: "スロー" | "平均" | "ハイ") => Math.max(...Object.values(slotsOf(analysis(four(), { pace }), 0)));
    expect([tail("スロー"), tail("平均"), tail("ハイ")]).toEqual([4, 5, 6]);
  });

  it("頭数が多くても最後尾は列 9 を超えない。上限で縮めたあともペースの差が残る(ハイ 9・平均 7・スロー 5)", () => {
    const styles: LegStyle[] = [...Array(2).fill("逃げ"), ...Array(6).fill("先行"), ...Array(6).fill("差し"), ...Array(4).fill("追込")];
    expect(styles.length).toBe(18);
    const horses = styles.map((s, i) => horse(i + 1, { legStyle: s, earlyPos: (i + 1) / 20 }));
    const tail = (pace: "スロー" | "平均" | "ハイ") => {
      const slots = Object.values(slotsOf(analysis(horses, { pace }), 0));
      expect(slots.length).toBe(18);
      return Math.max(...slots);
    };
    expect([tail("ハイ"), tail("平均"), tail("スロー")]).toEqual([9, 7, 5]);
  });
});

describe("buildFormation: 4コーナーの位置に馬ごとの latePos を使う(Issue #363。手計算した値)", () => {
  /** 脚質 逃げ・先行・差し・追込 の 1 頭ずつ(馬番 1〜4)。earlyPos は four() と同じ(道中の位置は変わらない)。 */
  const withLate = (late: readonly (number | null)[]): AnalysisHorse[] => four().map((h, i) => ({ ...h, latePos: late[i]! }));

  it("全馬に latePos があれば 4コーナーの先頭との差は latePos×9 を最小値で取り直した値: 0.2・0.3・0.5・0.9 → 1.8・2.7・4.5・8.1 → 0・0.9・2.7・6.3 → 列 0・1・3・6", () => {
    const a = analysis(withLate([0.2, 0.3, 0.5, 0.9]), { pace: "平均" });
    expect(slotsOf(a, 1)).toEqual({ 1: 0, 2: 1, 3: 3, 4: 6 });
    // 前提: 脚質と想定ペースだけの値(従来)とは違う列になる(latePos が効いている)
    expect(slotsOf(analysis(four(), { pace: "平均" }), 1)).toEqual({ 1: 0, 2: 2, 3: 2, 4: 3 });
  });

  it("latePos のある馬には想定ペースの補正をかけない: どのペースでも同じ列(ハイの逃げ+0.8・先行+0.5 の後退も、差し・追込の係数もかからない)", () => {
    const expected = { 1: 0, 2: 1, 3: 3, 4: 6 };
    for (const pace of ["スロー", "平均", "ハイ", "不明"] as const) {
      expect(slotsOf(analysis(withLate([0.2, 0.3, 0.5, 0.9]), { pace }), 1), pace).toEqual(expected);
    }
  });

  it("道中の位置は latePos に影響されない(latePos あり・なしで道中の列が同じ。4コーナーの列は違う)", () => {
    for (const pace of ["スロー", "平均", "ハイ"] as const) {
      const withL = analysis(withLate([0.2, 0.3, 0.5, 0.9]), { pace });
      const without = analysis(four(), { pace });
      expect(slotsOf(withL, 0), pace).toEqual(slotsOf(without, 0));
    }
    expect(slotsOf(analysis(withLate([0.2, 0.3, 0.5, 0.9]), { pace: "平均" }), 1)).not.toEqual(slotsOf(analysis(four(), { pace: "平均" }), 1));
  });

  it("一部の馬だけ latePos が無いとき、latePos のある馬は「その中の最小値」を先頭(0)とし、その馬は従来の値(道中の差×係数+後退)で補う: 平均ペースで 逃げ0.4・先行なし・差し0.5・追込なし → latePos の差 0・0.9、補い 1.6・2.64 → 列 0・2・1・3 (Issue #375)", () => {
    const a = analysis(withLate([0.4, null, 0.5, null]), { pace: "平均" });
    expect(slotsOf(a, 1)).toEqual({ 1: 0, 2: 2, 3: 1, 4: 3 });
    // 前提: latePos を絶対位置(0.4×9=3.6・0.5×9=4.5)のまま混ぜる旧式とは別の列(旧式は 2・0・3・1)
    expect(slotsOf(a, 1)).not.toEqual({ 1: 2, 2: 0, 3: 3, 4: 1 });
    expect(buildFormation(a)!.phases[1]!.chips.map((c) => c.umaban)).toEqual([1, 3, 2, 4]);
  });

  it("混在で latePos のある馬が最小になるとき、先頭に取り直す基準は全頭の最小値(補う馬だけの最小値ではない): 平均ペースで 逃げ0.05・先行なし・差し なし・追込0.3 → latePos の差 0・2.25、補い 1.6・1.92 → 列 0・2・2・2 (Issue #373・#375)", () => {
    const a = analysis(withLate([0.05, null, null, 0.3]), { pace: "平均" });
    expect(slotsOf(a, 1)).toEqual({ 1: 0, 2: 2, 3: 2, 4: 2 });
    // 前提(補う馬だけの最小値〈馬2 の 1.6〉で取り直す変異): 補いが 0・0.32、latePos の馬が 0・2.25 → 列 0・0・0・2 で、期待値とは別の列
    expect(slotsOf(a, 1)).not.toEqual({ 1: 0, 2: 0, 3: 0, 4: 2 });
    // 前提(latePos を絶対位置で混ぜる旧式〈Issue #375 より前〉): 0.45・1.6・1.92・2.7 を 0 に取り直して 列 0・1・1・2 で、これとも別の列
    expect(slotsOf(a, 1)).not.toEqual({ 1: 0, 2: 1, 3: 1, 4: 2 });
    // 先頭は latePos のある馬(補う馬は、latePos のある馬の先頭より前には出ない)
    expect(buildFormation(a)!.phases[1]!.chips.map((c) => c.umaban)).toEqual([1, 2, 3, 4]);
  });

  it("補う馬が道中で先頭でも、latePos のある馬は後ろへずれない(Issue #375): 平均ペースで 逃げなし・先行0.5・差し0.7・追込なし → 補い 0・2.64、latePos の差 0・1.8 → 列 逃げ0・先行0・差し2・追込3(旧式は先行 5・差し 6)", () => {
    const a = analysis(withLate([null, 0.5, 0.7, null]), { pace: "平均" });
    expect(slotsOf(a, 1)).toEqual({ 1: 0, 2: 0, 3: 2, 4: 3 });
    expect(slotsOf(a, 1)).not.toEqual({ 1: 0, 2: 5, 3: 6, 4: 3 });
  });

  it("全馬に latePos があるときの結果は、latePos×9 を最小値で取り直した値と一致する(頭数・並びを変えた表。Issue #375 の式の変更で変わらない)", () => {
    const table: readonly { late: readonly number[]; slots: readonly number[] }[] = [
      // [0.1, 0.1, 0.4, 0.9, 0.55, 0.3] → ×9 = 0.9・0.9・3.6・8.1・4.95・2.7 → 最小 0.9 を引いて 0・0・2.7・7.2・4.05・1.8 → 列 0・0・3・7・4・2
      { late: [0.1, 0.1, 0.4, 0.9, 0.55, 0.3], slots: [0, 0, 3, 7, 4, 2] },
      // [0.6, 0.2, 0.2] → 5.4・1.8・1.8 → 3.6・0・0 → 列 4・0・0
      { late: [0.6, 0.2, 0.2], slots: [4, 0, 0] },
    ];
    const styles: LegStyle[] = ["逃げ", "先行", "差し", "追込", "差し", "先行"];
    for (const { late, slots } of table) {
      expect(late.length).toBe(slots.length); // 前提: 表の長さが合っている
      const horses = late.map((l, i) => horse(i + 1, { legStyle: styles[i]!, earlyPos: 0.1 * (i + 1), latePos: l }));
      for (const pace of ["スロー", "平均", "ハイ"] as const) {
        expect(Object.values(slotsOf(analysis(horses, { pace }), 1)), pace).toEqual(slots);
      }
    }
  });

  it("丸めの 0.5 の境界: 全馬に latePos があるとき、列は `late×9 − min×9`(旧式と浮動小数点まで同一)で決まり、`(late − min)×9` とは別の列になる対がある(Issue #380。式の書き方を固定する)", () => {
    // 差がちょうど 1/18 の奇数倍の対は、2 つの書き方で 0.5 の境界の両側に分かれる(JS の浮動小数点で確認した値):
    //   [0.32, 0.82]   : 0.82×9 − 0.32×9 = 4.5(丸めて 5)       / (0.82 − 0.32)×9 = 4.499999999999999(丸めて 4)
    //   [0.092, 0.592] : 0.592×9 − 0.092×9 = 4.499999999999999(丸めて 4) / (0.592 − 0.092)×9 = 4.5(丸めて 5)  ← 逆向き
    const table: readonly { min: number; late: number; slot: number }[] = [
      { min: 0.32, late: 0.82, slot: 5 },
      { min: 0.092, late: 0.592, slot: 4 },
    ];
    for (const { min, late, slot } of table) {
      const current = Math.round(late * 9 - min * 9);
      const rewritten = Math.round((late - min) * 9);
      expect(current, `前提: 現行式の列 (${min}, ${late})`).toBe(slot);
      expect(rewritten, `前提: 書き換えた式は別の列になる (${min}, ${late})`).not.toBe(current);
      const horses = [horse(1, { legStyle: "逃げ", earlyPos: 0.1, latePos: min }), horse(2, { legStyle: "先行", earlyPos: 0.3, latePos: late })];
      for (const pace of ["スロー", "平均", "ハイ"] as const) {
        expect(slotsOf(analysis(horses, { pace }), 1), `${pace} (${min}, ${late})`).toEqual({ 1: 0, 2: slot });
      }
    }
  });

  it("latePos が無い馬の補いにはペースの補正がかかる(ハイペース: 先行 +0.5。latePos のある馬にはかからない)", () => {
    // ハイ: 道中 0・2・4・6。逃げ latePos 0.3・先行 なし(2×1+0.5=2.5)・差し latePos 0.4・追込 なし(6×0.45=2.7)
    // latePos の差は 0・0.9。列 0・3・1・3 (Issue #375)
    const high = analysis(withLate([0.3, null, 0.4, null]), { pace: "ハイ" });
    expect(slotsOf(high, 1)).toEqual({ 1: 0, 2: 3, 3: 1, 4: 3 });
    // 平均なら先行は 1.6×1=1.6 → 列 2(後退 +0.5 の有無で先行の列が変わる)。latePos の馬は同じ列
    const avg = analysis(withLate([0.3, null, 0.4, null]), { pace: "平均" });
    expect(slotsOf(avg, 1)).toEqual({ 1: 0, 2: 2, 3: 1, 4: 3 });
    expect(slotsOf(high, 1)[2]).not.toBe(slotsOf(avg, 1)[2]);
    expect(slotsOf(high, 1)[3]).toBe(slotsOf(avg, 1)[3]);
  });

  it("全馬の latePos が null(古い分析)なら従来と同じ結果。キー自体が無い(古いサーバの応答)ときも同じ", () => {
    const stripped = (pace: "スロー" | "平均" | "ハイ") => analysis(four().map((h) => {
      const copy: Record<string, unknown> = { ...h };
      delete copy["latePos"];
      return copy as unknown as AnalysisHorse;
    }), { pace });
    expect(slotsOf(analysis(four(), { pace: "平均" }), 1)).toEqual({ 1: 0, 2: 2, 3: 2, 4: 3 });
    expect(slotsOf(analysis(four(), { pace: "ハイ" }), 1)).toEqual({ 1: 0, 2: 2, 3: 1, 4: 2 });
    expect(slotsOf(analysis(four(), { pace: "スロー" }), 1)).toEqual({ 1: 0, 2: 1, 3: 2, 4: 3 });
    for (const pace of ["スロー", "平均", "ハイ"] as const) {
      expect(slotsOf(stripped(pace), 1), pace).toEqual(slotsOf(analysis(four(), { pace }), 1));
    }
  });

  it("4コーナーの先頭は列 0。latePos が全頭同じなら全員が列 0", () => {
    expect(slotsOf(analysis(withLate([0.5, 0.5, 0.5, 0.5])), 1)).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0 });
    expect(Math.min(...Object.values(slotsOf(analysis(withLate([0.4, 0.5, 0.6, 0.7])), 1)))).toBe(0);
  });

  it("最後尾は列 9 を超えない: latePos 0.1 と 1 の差 8.1 → 列 8(クランプに頼らず収まる)", () => {
    const a = analysis(withLate([0.1, 1, 0.5, 0.5]));
    expect(slotsOf(a, 1)).toEqual({ 1: 0, 2: 8, 3: 4, 4: 4 });
  });

  it("4コーナーの並びは latePos の順(道中の集団・earlyPos の順ではない)。latePos が同じなら馬番の小さい方が前", () => {
    // 差し 2 頭: 道中は earlyPos の昇順で 馬5・馬3。4コーナーは latePos が同じなので馬番の小さい馬3が前
    const same = buildFormation(analysis([horse(5, { legStyle: "差し", earlyPos: 0.1, latePos: 0.5 }), horse(3, { legStyle: "差し", earlyPos: 0.9, latePos: 0.5 })]))!;
    expect(same.phases[0]!.chips.map((c) => c.umaban)).toEqual([5, 3]);
    expect(same.phases[1]!.chips.map((c) => c.umaban)).toEqual([3, 5]);
    // latePos が逆なら、道中で前だった馬が 4コーナーで後ろになる
    const swap = buildFormation(analysis([horse(1, { legStyle: "先行", earlyPos: 0.1, latePos: 0.8 }), horse(2, { legStyle: "先行", earlyPos: 0.9, latePos: 0.2 })]))!;
    expect(swap.phases[0]!.chips.map((c) => c.umaban)).toEqual([1, 2]);
    expect(swap.phases[1]!.chips.map((c) => c.umaban)).toEqual([2, 1]);
  });

  it("勝率・3着内率は 4コーナーの位置に影響しない(latePos があっても)", () => {
    const base = withLate([0.2, 0.3, 0.5, 0.9]);
    const skewed = base.map((h, i) => ({ ...h, winProb: i === 3 ? 0.9 : 0.01, adjustedProb: i === 3 ? 0.9 : 0.01 }));
    expect(slotsOf(analysis(skewed), 1)).toEqual(slotsOf(analysis(base), 1));
  });
});

describe("buildFormation: 並びと材料", () => {
  it("集団の中の並びは earlyPos の昇順(null は値のある馬の中央値で補う)。同じ値は馬番の小さい方が前。チップは前から後ろの順", () => {
    // 先行 3 頭: earlyPos 0.5・0.2・null(= 0.2 と 0.5 の中央値 0.35)→ 前から 馬2・馬3・馬1
    const a = analysis([horse(1, { legStyle: "先行", earlyPos: 0.5 }), horse(2, { legStyle: "先行", earlyPos: 0.2 }), horse(3, { legStyle: "先行", earlyPos: null })]);
    const f = buildFormation(a)!;
    expect(f.phases[0]!.chips.map((c) => c.umaban)).toEqual([2, 3, 1]);
    expect(f.phases[1]!.chips.map((c) => c.umaban)).toEqual([2, 3, 1]); // 集団内の並びは道中のまま
    const tie = buildFormation(analysis([horse(5, { legStyle: "差し", earlyPos: 0.4 }), horse(3, { legStyle: "差し", earlyPos: 0.4 })]))!;
    expect(tie.phases[0]!.chips.map((c) => c.umaban)).toEqual([3, 5]);
  });

  it("earlyPos が全馬 null でも描ける(馬番の順)", () => {
    const f = buildFormation(analysis([horse(2, { legStyle: "差し" }), horse(1, { legStyle: "差し" })]))!;
    expect(f.phases[0]!.chips.map((c) => c.umaban)).toEqual([1, 2]);
  });

  it("脚質が無い馬は図に置かず、「位置を推定できない馬」に馬番の昇順で並べる。置いた馬は両方の局面に過不足なく出る", () => {
    const horses = [horse(1, { legStyle: "逃げ" }), horse(7, { legStyle: null }), horse(2, { legStyle: "先行" }), horse(3, { legStyle: null }), horse(4, { legStyle: "差し" })];
    const f = buildFormation(analysis(horses))!;
    expect(f.unknownLine).toBe("位置を推定できない馬: 3, 7");
    for (const p of f.phases) {
      expect(p.chips.map((c) => c.umaban).sort((x, y) => x - y)).toEqual([1, 2, 4]);
    }
  });

  it("全馬の脚質が分かれば「位置を推定できない馬」は出さない(null)", () => {
    expect(buildFormation(analysis(four()))!.unknownLine).toBeNull();
  });

  it("脚質の分かる馬が 2 頭未満(1 頭・0 頭)は節ごと出さない(null)。ちょうど 2 頭は出す。キー無し(古い固定データ)の脚質も未推定", () => {
    expect(buildFormation(analysis([horse(1, { legStyle: "逃げ" }), horse(2), horse(3)]))).toBeNull();
    expect(buildFormation(analysis([horse(1), horse(2), horse(3)]))).toBeNull();
    expect(buildFormation(analysis([horse(1, { legStyle: "逃げ" }), horse(2, { legStyle: "追込" }), horse(3)]))).not.toBeNull();
    const noKey = [horse(1, { legStyle: "逃げ" }), horse(2)];
    delete (noKey[1] as { legStyle?: unknown }).legStyle;
    expect(buildFormation(analysis(noKey))).toBeNull();
    expect(buildFormation(analysis([]))).toBeNull();
  });

  it("勝率・3着内率は位置に影響しない(脚質と想定ペースだけ)。勝率が null・0 の馬も置く", () => {
    const base = slotsOf(analysis(four()), 1);
    const changed = four().map((h, i) => ({ ...h, winProb: [0.7, 0.2, 0.05, 0][i]!, adjustedProb: [0.9, 0.6, 0.2, 0.01][i]! }));
    expect(slotsOf(analysis(changed), 0)).toEqual(slotsOf(analysis(four()), 0));
    expect(slotsOf(analysis(changed), 1)).toEqual(base);
    const nulls = four().map((h) => ({ ...h, winProb: null }));
    expect(slotsOf(analysis(nulls), 0)).toEqual(slotsOf(analysis(four()), 0));
  });

  it("同じ分析からは同じ図(乱数を使わない)", () => {
    const a = analysis(four(), { pace: "ハイ" });
    expect(buildFormation(a)).toEqual(buildFormation(a));
  });
});

describe("buildFormation: ◎の強調・凡例・注記", () => {
  it("前提: クライアントに写した本命の印は core の PREDICTION_MARKS の先頭と同じ", () => {
    expect(MAIN_MARK).toBe(PREDICTION_MARKS[0]);
  });

  it("◎の馬だけ main(強調)。◎が無ければ誰も強調しない(勝率の最も高い馬で代用しない)。◎以外の印は強調しない", () => {
    const withMark = four().map((h) => (h.umaban === 3 ? { ...h, mark: "◎" } : h.umaban === 1 ? { ...h, mark: "〇" } : h));
    const f = buildFormation(analysis(withMark))!;
    for (const p of f.phases) {
      expect(p.chips.filter((c) => c.main).map((c) => c.umaban)).toEqual([3]);
    }
    expect(f.legend.filter((l) => l.main).map((l) => l.umaban)).toEqual([3]);
    const none = buildFormation(analysis(four().map((h) => ({ ...h, winProb: h.umaban === 4 ? 0.9 : 0.01 }))))!;
    expect(none.phases.every((p) => p.chips.every((c) => !c.main))).toBe(true);
    expect(none.legend.every((l) => !l.main)).toBe(true);
  });

  it("凡例は全馬(位置を推定できない馬も)を馬番の昇順に「馬番 馬名」で。◎の行は先頭に「◎ 」を付ける。馬名は 6 文字まで、超えたら「…」(サロゲートペアは 1 文字)。名前なしは馬番だけ", () => {
    const horses = [
      horse(3, { legStyle: "差し", name: "ナムラクレアーズ", mark: "◎" }), // 8 文字
      horse(1, { legStyle: "逃げ", name: "ちょうど六字" }), // 6 文字
      horse(2, { legStyle: null, name: "🐴🐴🐴🐴🐴🐴🐴" }), // 7 文字(サロゲートペア)
      horse(10, { legStyle: "先行", name: null }),
    ];
    const f = buildFormation(analysis(horses))!;
    expect(f.legend.map((l) => l.umaban)).toEqual([1, 2, 3, 10]);
    expect(f.legend.map((l) => l.text)).toEqual(["1 ちょうど六字", "2 🐴🐴🐴🐴🐴🐴…", "◎ 3 ナムラクレア…", "10"]);
  });

  it("想定ペースの行: LLM の pace があれば「(AI の展開予想)」、無ければ「(逃げ馬の頭数からの規則)」、不明は平均として描く旨", () => {
    const ai = buildFormation(analysis(four(), { pace: "ハイ" }, { text: "前が競る", pace: "ハイ" }))!;
    expect(ai.paceLine).toBe("想定ペース: ハイ(AI の展開予想)");
    const textOnly = buildFormation(analysis(four(), { pace: "平均" }, { text: "展開", pace: null }))!;
    expect(textOnly.paceLine).toBe("想定ペース: 平均(逃げ馬の頭数からの規則)");
    const rule = buildFormation(analysis(four(), { pace: "スロー" }, null))!;
    expect(rule.paceLine).toBe("想定ペース: スロー(逃げ馬の頭数からの規則)");
    const unknown = buildFormation(analysis(four(), { pace: "不明" }, null))!;
    expect(unknown.paceLine).toBe("想定ペース: 不明(平均として描きます)");
  });

  const OLD_NOTE = "馬の脚質と想定ペースからの想定です(実際の隊列とは異なることがあります)。馬の実力・勝率は反映していません。縦の並びは重なりを避けるためで、内外を表しません。位置の計算に使う係数は経験則です。";
  const NEW_NOTE = "道中は馬の脚質と近走の序盤の位置から、4コーナーは近走の4コーナーの通過順位から(無い馬は脚質と想定ペースから)の想定です(実際の隊列とは異なることがあります)。馬の実力・勝率は反映していません。縦の並びは重なりを避けるためで、内外を表しません。位置の計算に使う係数は経験則です。";

  it("見出しと注記: 勝率を反映しないこと・縦の並びに意味がないこと・係数が経験則であることを言う(latePos のある分析でも、ない分析でも)", () => {
    const withLate = four().map((h) => ({ ...h, latePos: 0.5 }));
    for (const horses of [withLate, four()]) {
      const f = buildFormation(analysis(horses))!;
      expect(f.heading).toBe("想定隊列図");
      expect(f.note).toContain("脚質と想定ペース");
      expect(f.note).toContain("勝率");
      expect(f.note).toContain("縦");
      expect(f.note).toContain("経験則");
    }
  });

  it("注記は 4コーナーの材料(近走の4コーナーの通過順位。無い馬は脚質と想定ペース)を言う: 1 頭でも latePos がある分析では今の文言(Issue #375)", () => {
    const one = four().map((h, i) => (i === 2 ? { ...h, latePos: 0.4 } : h));
    expect(buildFormation(analysis(one))!.note).toBe(NEW_NOTE);
    const all = four().map((h) => ({ ...h, latePos: 0.4 }));
    expect(buildFormation(analysis(all))!.note).toBe(NEW_NOTE);
  });

  it("全馬の latePos が無い分析(#363 より前。null・キー無しとも)の注記は、#362 のときの文言(4コーナーの材料に触れない。Issue #375)", () => {
    expect(buildFormation(analysis(four()))!.note).toBe(OLD_NOTE);
    const stripped = four().map((h) => {
      const copy: Record<string, unknown> = { ...h };
      delete copy["latePos"];
      return copy as unknown as AnalysisHorse;
    });
    expect(buildFormation(analysis(stripped))!.note).toBe(OLD_NOTE);
    expect(OLD_NOTE).not.toContain("4コーナーの通過順位");
  });

  it("latePos があっても脚質が分からず図に置かない馬だけが持っているなら、図は latePos を使わないので #362 の文言(Issue #375)", () => {
    const horses = [...four(), horse(5, { legStyle: null as unknown as LegStyle, latePos: 0.3 })];
    const f = buildFormation(analysis(horses))!;
    expect(f.phases[0]!.chips).toHaveLength(4); // 前提: 馬5 は図に置かれていない
    expect(f.note).toBe(OLD_NOTE);
  });

  it("図の読み上げ文(ariaLabel): 局面名と、前から後ろへ 同じ列の馬を「・」でつないだ馬番", () => {
    const f = buildFormation(analysis(four(), { pace: "平均" }))!;
    expect(f.phases[0]!.ariaLabel).toBe("道中の想定隊列(先頭側から): 1番 / 2番 / 3番 / 4番");
    expect(f.phases[1]!.ariaLabel).toBe("4コーナーの想定隊列(先頭側から): 1番 / 2番・3番 / 4番");
  });
});
