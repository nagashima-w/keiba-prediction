import { describe, expect, it } from "vitest";
import { buildVerifyPart, computeVerifyReport, DEFAULT_VERIFY_CONFIG } from "../../src/ev/verify.js";
import type { StoredAnalysis, StoredAnalysisHorse, VerifyDataSource } from "../../src/ev/analysis-store-types.js";

/**
 * #717: 確率(prior・補正後)が NaN・Infinity の馬があっても、検証の集計は TypeError で止まらない。
 *
 * 決め方(今の検証の関数の慣行に合わせた): 帯の番号が決まらないのは NaN だけ(±Infinity・範囲外の有限値は従来どおり帯の端に入り、
 * Brier が null になる。verify-parts.test.ts・verify-quality.test.ts が固定している)。そこで NaN の馬は、
 * 着順が確定していない馬と同じに、確率に基づく集計(帯・Brier の評価頭数・補正方向)から外す。帯の件数の合計と Brier の評価頭数は
 * 同じ馬の集合のまま(Issue #271 の不変条件)。ただし不正な確率を黙って数値にしない慣行(Brier は null)に合わせ、
 * NaN の馬が 1 頭でもいれば補正前・補正後の Brier はどちらも null にする。印別の集計と回収率の集計(確率を使わない)には残す。
 *
 * 本番では保存の前の検証でここへ届かない。届いたときに集計全体を落とさないための防御。
 */

function horse(umaban: number, prior: number, adjustedProb: number, extra: Partial<StoredAnalysisHorse> = {}): StoredAnalysisHorse {
  return {
    umaban,
    prior,
    adjustedProb,
    placeOddsMin: null,
    ev: null,
    isPositive: false,
    contributions: null,
    mark: null,
    reason: null,
    highlights: [],
    concerns: [],
    ...extra,
  };
}

function source(horses: StoredAnalysisHorse[], finishes: Record<number, number>): VerifyDataSource {
  const analysis = {
    id: 1,
    raceId: "202506010101",
    analyzedAt: "2026-01-01T00:00:00Z",
    horses,
    evEstimated: false,
    promptVersion: null,
    additionalInstruction: null,
    kaisaiDate: null,
  } as unknown as StoredAnalysis;
  return {
    listAnalyses: () => [analysis],
    getResult: () =>
      Object.entries(finishes).map(([umaban, finishPosition]) => ({ umaban: Number(umaban), finishPosition, placePayout: null })),
    getComboPayouts: () => ({ status: "not_imported" }) as never,
    getAllocationForVerify: () => undefined,
  };
}

const sum = (bins: readonly { readonly predictedCount: number }[]): number => bins.reduce((a, b) => a + b.predictedCount, 0);

describe("確率が有限でない馬の扱い(#717)", () => {
  const FINISH = { 1: 1, 2: 5, 3: 2 };

  for (const [name, priorOf, adjustedOf] of [
    ["prior", Number.NaN, 0.3],
    ["補正後の確率", 0.3, Number.NaN],
  ] as const) {
    it(`${name}が NaN の馬がいても投げず、その馬は帯・評価頭数・補正方向から外れ、残りの馬の値は変わらない。Brier は両方 null`, () => {
      const store = source([horse(1, 0.5, 0.5), horse(2, priorOf, adjustedOf), horse(3, 0.2, 0.4)], FINISH);
      const ref = source([horse(1, 0.5, 0.5), horse(3, 0.2, 0.4)], { 1: 1, 3: 2 });
      expect(() => computeVerifyReport(store)).not.toThrow();
      const r = computeVerifyReport(store);
      const expected = computeVerifyReport(ref);
      // 前提(空振り防止): 外した馬の分だけ母集団が小さい(3 頭中 2 頭)
      expect(r.quality.evaluatedCount).toBe(2);
      expect(sum(r.calibration)).toBe(2);
      expect(sum(r.priorCalibration)).toBe(2);
      // 残りの馬だけで作ったレポートと同じ(NaN が合計に混ざっていない)
      expect(r.calibration).toEqual(expected.calibration);
      expect(r.priorCalibration).toEqual(expected.priorCalibration);
      expect(r.trend.directionGroups).toEqual(expected.trend.directionGroups);
      // 対照: 残りの馬だけなら Brier は出る(null は NaN の馬のせい)。NaN の馬がいると、不正な確率を黙って数値にしないため両方 null
      expect(expected.quality.priorBrier).not.toBeNull();
      expect(expected.quality.adjustedBrier).not.toBeNull();
      expect(r.quality).toEqual({ evaluatedCount: 2, priorBrier: null, adjustedBrier: null });
    });
  }

  it("確率が NaN の馬も、印別の集計と回収率の集計には残る(確率を使わないため)", () => {
    const store = source(
      [horse(1, 0.5, 0.5), horse(2, Number.NaN, 0.3, { mark: "◎", isPositive: true, placeOddsMin: 2, ev: 1.2 }), horse(3, 0.2, 0.4)],
      FINISH,
    );
    const r = computeVerifyReport(store);
    const mark = r.trend.markStats.find((m) => m.mark === "◎");
    expect(mark?.count).toBe(1);
    expect(r.bet.betCount).toBe(1);
  });

  it("buildVerifyPart の部分も有限な値だけを持つ(JSON に往復して変わらない)", () => {
    const store = source([horse(1, Number.NaN, 0.5), horse(2, 0.3, 0.3)], { 1: 1, 2: 5 });
    const part = buildVerifyPart(store, store.listAnalyses(), DEFAULT_VERIFY_CONFIG);
    expect(JSON.parse(JSON.stringify(part))).toEqual(part);
  });
});
