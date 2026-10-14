import { describe, expect, it } from "vitest";
import {
  computeEstimatedRaceEv,
  computeRaceEv,
  DEFAULT_ESTIMATED_PLACE_CONFIG,
  DEFAULT_EV_CONFIG,
  estimatePlaceOddsMinFromWin,
  resolveEvThreshold,
  type EvConfig,
  type HorsePrior,
} from "../../src/ev/expected-value.js";
import { isUsableOdds } from "../../src/ev/allocation-primitives.js";
import type { OddsSnapshot, PlaceOdds } from "../../src/scraper/types.js";

/** 複勝オッズ(下限・上限・人気)を最小構成で組み立てる。 */
function place(oddsMin: number | null, oddsMax: number | null = null): PlaceOdds {
  return { oddsMin, oddsMax: oddsMax ?? oddsMin, ninki: null };
}

/** 馬番→複勝オッズの OddsSnapshot を組み立てる(単勝は空でよい)。 */
function oddsSnapshot(place: Record<number, PlaceOdds>): OddsSnapshot {
  return { officialDatetime: null, oddsStatus: "result", win: {}, place };
}

describe("computeRaceEv(複勝期待値計算)", () => {
  describe("基本計算(EV = place_prob × 複勝オッズ下限)", () => {
    // 仕様「4. ev」: 複勝期待値 = place_prob × 複勝オッズ(下限値を使用)、EV>閾値のみ抽出。
    // 境界(EV=閾値ちょうど)は「プラスではない」(> 判定)。
    const cases: Array<{
      name: string;
      placeProb: number;
      oddsMin: number;
      threshold: number;
      expectedEv: number;
      expectedPositive: boolean;
    }> = [
      {
        name: "EVが閾値を上回る馬はプラス",
        placeProb: 0.5,
        oddsMin: 2.5,
        threshold: 1.0,
        expectedEv: 1.25,
        expectedPositive: true,
      },
      {
        name: "EVが閾値ちょうどの馬はプラスではない(> 判定)",
        placeProb: 0.4,
        oddsMin: 2.5,
        threshold: 1.0,
        expectedEv: 1.0,
        expectedPositive: false,
      },
      {
        name: "EVが閾値を下回る馬はプラスではない",
        placeProb: 0.3,
        oddsMin: 2.5,
        threshold: 1.0,
        expectedEv: 0.75,
        expectedPositive: false,
      },
      {
        name: "閾値を上げると同じEVでもプラス判定が変わる(EV=1.25 < 閾値1.3)",
        placeProb: 0.5,
        oddsMin: 2.5,
        threshold: 1.3,
        expectedEv: 1.25,
        expectedPositive: false,
      },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const priors: HorsePrior[] = [{ umaban: 1, placeProb: c.placeProb }];
        const odds = oddsSnapshot({ 1: place(c.oddsMin) });
        const [result] = computeRaceEv(priors, odds, { threshold: c.threshold });
        expect(result!.ev).toBeCloseTo(c.expectedEv, 10);
        expect(result!.isPositive).toBe(c.expectedPositive);
        expect(result!.placeOddsMin).toBe(c.oddsMin);
        expect(result!.excludedReason).toBeNull();
      });
    }
  });

  describe("オッズ欠損馬の扱い(EV計算対象外)", () => {
    it("複勝オッズに馬番が存在しない馬は対象外(ev=null・理由付き)", () => {
      const priors: HorsePrior[] = [{ umaban: 7, placeProb: 0.5 }];
      const odds = oddsSnapshot({ 1: place(2.5) }); // 馬番7のオッズがない
      const [result] = computeRaceEv(priors, odds);
      expect(result!.ev).toBeNull();
      expect(result!.placeOddsMin).toBeNull();
      expect(result!.isPositive).toBe(false);
      expect(result!.excludedReason).not.toBeNull();
      expect(result!.excludedReason).toContain("馬番");
    });

    it("複勝オッズ下限がnullの馬は対象外(ev=null・理由付き)", () => {
      const priors: HorsePrior[] = [{ umaban: 3, placeProb: 0.5 }];
      const odds = oddsSnapshot({ 3: place(null) });
      const [result] = computeRaceEv(priors, odds);
      expect(result!.ev).toBeNull();
      expect(result!.placeOddsMin).toBeNull();
      expect(result!.isPositive).toBe(false);
      expect(result!.excludedReason).not.toBeNull();
      expect(result!.excludedReason).toContain("下限");
    });
  });

  describe(
    "オッズが値域外の馬の扱い(Issue #74: オッズの値域は1.0以上であり0は値域外。" +
      "旧実装は`oddsMin===null`しか見ておらず、値域外の値〈0等〉を通して" +
      "`ev=placeProb×0=0`という「正常な判定結果」に潰していた。判定不能〈値域外〉を" +
      "判定結果〈EV=0〉に混ぜない)",
    () => {
      // 3つの除外理由(馬番が無い/下限が未確定/値域外)。#74で3つ目(値域外)を新設する。
      const REASON_NO_UMABAN = "複勝オッズに該当馬番が存在しないため対象外";
      const REASON_NULL = "複勝オッズ下限が未確定(null)のため対象外";
      // boss裁定Q1(a)(2026-09-04): 到達しうる全入力(0/-0/(0,1)/NaN/±Infinity)に対して
      // 真であることが必須。「1.0未満」単独だとNaN・+Infinityで偽になる(NaN<1.0もInfinity<1.0も
      // false)。「1.0未満・非有限」の選言にすることで、値域外(1.0未満)と非有限のどちらで
      // 除外されても文言が偽にならない。
      const REASON_MALFORMED = "複勝オッズ下限が不正な値(1.0未満・非有限)のため対象外";

      const placeProb = 0.5;

      /** umaban=1のみを持つOddsSnapshotを組み立てる。undefinedなら馬番自体を含めない。 */
      function snapshotWith(oddsMin: number | null | undefined): OddsSnapshot {
        if (oddsMin === undefined) {
          return oddsSnapshot({});
        }
        return oddsSnapshot({ 1: place(oddsMin) });
      }

      type Case = {
        name: string;
        oddsMin: number | null | undefined;
        expectedEv: number | null;
        expectedPlaceOddsMin: number | null;
        expectedReason: string | null;
      };

      // AC-1: oddsMin ∈ {0, -0, 0.5, 0.9999999, 1, 1.0000001, 2.5, NaN, +Infinity, -Infinity,
      // null, 馬番自体が無い} × 期待(ev, placeOddsMin, excludedReason)。
      const cases: Case[] = [
        { name: "oddsMin=0(値域外・境界)", oddsMin: 0, expectedEv: null, expectedPlaceOddsMin: 0, expectedReason: REASON_MALFORMED },
        { name: "oddsMin=-0(値域外)", oddsMin: -0, expectedEv: null, expectedPlaceOddsMin: -0, expectedReason: REASON_MALFORMED },
        { name: "oddsMin=0.5(値域外)", oddsMin: 0.5, expectedEv: null, expectedPlaceOddsMin: 0.5, expectedReason: REASON_MALFORMED },
        { name: "oddsMin=0.9999999(値域外・境界のすぐ下)", oddsMin: 0.9999999, expectedEv: null, expectedPlaceOddsMin: 0.9999999, expectedReason: REASON_MALFORMED },
        { name: "oddsMin=1(境界ちょうど・値域内)", oddsMin: 1, expectedEv: placeProb * 1, expectedPlaceOddsMin: 1, expectedReason: null },
        { name: "oddsMin=1.0000001(境界を僅かに超える・値域内)", oddsMin: 1.0000001, expectedEv: placeProb * 1.0000001, expectedPlaceOddsMin: 1.0000001, expectedReason: null },
        { name: "oddsMin=2.5(通常値・値域内)", oddsMin: 2.5, expectedEv: placeProb * 2.5, expectedPlaceOddsMin: 2.5, expectedReason: null },
        { name: "oddsMin=NaN(非有限)", oddsMin: Number.NaN, expectedEv: null, expectedPlaceOddsMin: Number.NaN, expectedReason: REASON_MALFORMED },
        { name: "oddsMin=+Infinity(非有限)", oddsMin: Number.POSITIVE_INFINITY, expectedEv: null, expectedPlaceOddsMin: Number.POSITIVE_INFINITY, expectedReason: REASON_MALFORMED },
        { name: "oddsMin=-Infinity(非有限)", oddsMin: Number.NEGATIVE_INFINITY, expectedEv: null, expectedPlaceOddsMin: Number.NEGATIVE_INFINITY, expectedReason: REASON_MALFORMED },
        { name: "oddsMin=null(未確定)", oddsMin: null, expectedEv: null, expectedPlaceOddsMin: null, expectedReason: REASON_NULL },
        { name: "馬番自体が無い", oddsMin: undefined, expectedEv: null, expectedPlaceOddsMin: null, expectedReason: REASON_NO_UMABAN },
      ];

      it.each(cases)(
        "$name → HorseEvの全6フィールド(umaban/placeProb/placeOddsMin/ev/isPositive/excludedReason)を値として固定する(AC-1)",
        ({ oddsMin, expectedEv, expectedPlaceOddsMin, expectedReason }) => {
          const priors: HorsePrior[] = [{ umaban: 1, placeProb }];
          const [result] = computeRaceEv(priors, snapshotWith(oddsMin));

          // HorseEvの全6フィールドを射影する(#58のunavailableReason脱落と同型の検出力低下を
          // 防ぐため、一部だけを見るタプルにしない)。
          expect(result!.umaban).toBe(1);
          expect(result!.placeProb).toBe(placeProb);

          if (typeof expectedPlaceOddsMin === "number" && Number.isNaN(expectedPlaceOddsMin)) {
            expect(Number.isNaN(result!.placeOddsMin as number)).toBe(true);
          } else {
            expect(result!.placeOddsMin).toBe(expectedPlaceOddsMin);
          }

          if (expectedEv === null) {
            expect(result!.ev).toBeNull();
          } else {
            expect(result!.ev).toBeCloseTo(expectedEv, 10);
          }

          expect(result!.isPositive).toBe(expectedEv !== null && expectedEv > 1.0);
          expect(result!.excludedReason).toBe(expectedReason);
        },
      );

      it("3つの除外理由(馬番が無い/下限が未確定/値域外)はリテラルとして固定され、相互に相異なる(AC-2)", () => {
        // リテラルとの一致(#55: 実装からimportした定数とのtoEqualは自己参照になるため使わない。
        // ここではハードコードした文字列同士を比較する)。
        expect(REASON_NO_UMABAN).toBe("複勝オッズに該当馬番が存在しないため対象外");
        expect(REASON_NULL).toBe("複勝オッズ下限が未確定(null)のため対象外");
        expect(REASON_MALFORMED).toBe("複勝オッズ下限が不正な値(1.0未満・非有限)のため対象外");
        // 相互相異(Set.sizeだけだと3つ同時に差し替えても通ってしまうため、対ごとの比較も置く)。
        expect(new Set([REASON_NO_UMABAN, REASON_NULL, REASON_MALFORMED]).size).toBe(3);
        expect(REASON_NO_UMABAN).not.toBe(REASON_NULL);
        expect(REASON_NO_UMABAN).not.toBe(REASON_MALFORMED);
        expect(REASON_NULL).not.toBe(REASON_MALFORMED);
      });
    },
  );

  describe("入力全体の扱い", () => {
    it("全馬を入力順で返し、対象外馬も欠落させない", () => {
      const priors: HorsePrior[] = [
        { umaban: 5, placeProb: 0.6 },
        { umaban: 2, placeProb: 0.5 }, // オッズ欠損
        { umaban: 8, placeProb: 0.2 },
      ];
      const odds = oddsSnapshot({ 5: place(2.0), 8: place(3.0) });
      const results = computeRaceEv(priors, odds);
      expect(results.map((r) => r.umaban)).toEqual([5, 2, 8]);
      expect(results[0]!.ev).toBeCloseTo(1.2, 10);
      expect(results[1]!.ev).toBeNull();
      expect(results[2]!.ev).toBeCloseTo(0.6, 10);
    });

    it("configを省略するとデフォルト閾値(1.0)が使われる", () => {
      expect(DEFAULT_EV_CONFIG.threshold).toBe(1.0);
      const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.45 }];
      const odds = oddsSnapshot({ 1: place(2.5) }); // EV=1.125
      const [result] = computeRaceEv(priors, odds);
      expect(result!.isPositive).toBe(true);
    });

    it.each([
      { name: "threshold=NaN", threshold: Number.NaN },
      { name: "threshold=+Infinity", threshold: Number.POSITIVE_INFINITY },
      { name: "threshold=-Infinity", threshold: Number.NEGATIVE_INFINITY },
    ])(
      "$name は既定閾値(1.0)へフォールバックすること(受け入れ条件19。boss指摘2026-08-06: " +
        "非有限のまま比較に使うと全馬が黙って妙味なし〈NaN/+Infinity〉または " +
        "妙味あり〈-Infinity〉に化ける)",
      ({ threshold }) => {
        // 2頭混在(1頭は明らかに正EV、もう1頭は明らかに非正EV)を使う。全馬が同じ判定になる
        // データだと、threshold=-Infinity(ev>-Infinityは常にtrue)が「たまたま既定閾値と
        // 同じ結果」になり判別力を失う(実際に踏んだ落とし穴。カナリア検証時に発見)。
        const priors: HorsePrior[] = [
          { umaban: 1, placeProb: 0.5 }, // EV=1.25(閾値1.0なら正EV)
          { umaban: 2, placeProb: 0.1 }, // EV=0.25(閾値1.0なら非正EV)
        ];
        const odds = oddsSnapshot({ 1: place(2.5), 2: place(2.5) });
        const expected = computeRaceEv(priors, odds, { threshold: 1.0 });
        // 前提(無条件expect): 既定閾値では正EV・非正EVの両方が生じる混在データであること。
        expect(expected.some((r) => r.isPositive)).toBe(true);
        expect(expected.some((r) => !r.isPositive)).toBe(true);

        const actual = computeRaceEv(priors, odds, { threshold });
        expect(actual).toEqual(expected);
      },
    );
  });
});

describe("resolveEvThreshold(EV閾値の防御。受け入れ条件19)", () => {
  it("有限値はそのまま返す", () => {
    expect(resolveEvThreshold(1.3)).toBe(1.3);
    expect(resolveEvThreshold(0)).toBe(0);
    expect(resolveEvThreshold(-1)).toBe(-1); // 閾値自体の意味論的な妥当性は呼び出し側の責務。ここでは有限性のみを見る。
  });

  it("非有限(NaN/±Infinity)は既定値(1.0)へフォールバックする", () => {
    expect(resolveEvThreshold(Number.NaN)).toBe(DEFAULT_EV_CONFIG.threshold);
    expect(resolveEvThreshold(Number.POSITIVE_INFINITY)).toBe(DEFAULT_EV_CONFIG.threshold);
    expect(resolveEvThreshold(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_EV_CONFIG.threshold);
  });
});

/**
 * estimatePlaceOddsMinFromWin(推定複勝下限の換算・判別共用体)。
 * ユーザー要望(Task#25): 発売前(oddsStatus=yoso)は予想単勝オッズしかなく複勝が無いため、
 * 単勝オッズから複勝下限を経験則ベースで概算する。既定式:
 *   推定複勝下限 = max(1.0, 1.0 + (winOdds − 1.0) × coef)、coef 既定0.2。
 *
 * Issue #88(#23-B0): 旧版(`git show a12af62:...`)は「未確定」「値域外」の2状況をnullへ
 * 統合する一方、算出結果自体がisUsableOddsを満たさない状況は判定すらせず、生のNaN/+Infinityを
 * そのまま返していた(#74 R1 boss メタレビュー2026-09-04で発見・選択(b)で残余化)。これを
 * 判別共用体(EstimatedPlaceOddsMinResult)化し、「算出成功」「単勝オッズ未確定」
 * 「単勝オッズ値域外」「算出値不正(算出結果自体がisUsableOddsを満たさない。到達条件は
 * coefが非有限であることではない。詳細はEstimatedPlaceOddsMinResultのJSDoc参照)」の4状態を
 * 互いに区別できるようにした。
 */
describe("estimatePlaceOddsMinFromWin(単勝オッズ→推定複勝下限の換算・判別共用体・Issue #88)", () => {
  /** kind="算出成功"であることを固定しつつvalueを取り出す(型ガードを兼ねるヘルパー)。 */
  function okValue(result: ReturnType<typeof estimatePlaceOddsMinFromWin>): number {
    expect(result.kind).toBe("算出成功");
    if (result.kind !== "算出成功") {
      throw new Error("到達しないはずの分岐(直前のtoBeで既に検出されている)");
    }
    return result.value;
  }

  describe('kind="算出成功"(既定係数coef=0.2での換算値)', () => {
    const cases: Array<{ winOdds: number; expected: number }> = [
      { winOdds: 1.5, expected: 1.1 },
      { winOdds: 10, expected: 2.8 },
      { winOdds: 50, expected: 10.8 },
    ];
    for (const c of cases) {
      it(`単勝${c.winOdds}倍 → kind="算出成功"・推定複勝下限${c.expected}`, () => {
        const result = estimatePlaceOddsMinFromWin(c.winOdds, DEFAULT_ESTIMATED_PLACE_CONFIG);
        expect(okValue(result)).toBeCloseTo(c.expected, 10);
      });
    }

    it("configを省略するとデフォルト係数(0.2)が使われる", () => {
      expect(DEFAULT_ESTIMATED_PLACE_CONFIG.coef).toBe(0.2);
      expect(okValue(estimatePlaceOddsMinFromWin(10))).toBeCloseTo(2.8, 10);
    });

    it('単勝オッズが1.0ちょうどのときはkind="算出成功"・推定複勝下限も1.0(max(1.0, ...)の下限)', () => {
      expect(okValue(estimatePlaceOddsMinFromWin(1.0))).toBeCloseTo(1.0, 10);
    });

    it("coefを変えると換算値も変わる(config化されていること)", () => {
      expect(okValue(estimatePlaceOddsMinFromWin(10, { coef: 0.5 }))).toBeCloseTo(1.0 + 9 * 0.5, 10);
    });
  });

  describe('kind="単勝オッズ未確定"(状態(b): winOdds===null。真に未確定)', () => {
    it('winOddsがnullのとき、kind="単勝オッズ未確定"を返す(状態(c)「値域外」とは別の状態)', () => {
      const result = estimatePlaceOddsMinFromWin(null);
      expect(result.kind).toBe("単勝オッズ未確定");
    });
  });

  describe('kind="単勝オッズ値域外"(状態(c): winOddsは存在するが非有限・1.0未満)', () => {
    const cases: Array<{ name: string; winOdds: number }> = [
      { name: "winOddsが1未満(0.9)", winOdds: 0.9 },
      { name: "winOddsがNaN(非有限)", winOdds: Number.NaN },
      { name: "winOddsが+Infinity(非有限)", winOdds: Number.POSITIVE_INFINITY },
      { name: "winOddsが負値(-5)", winOdds: -5 },
    ];
    it.each(cases)('$name → kind="単勝オッズ値域外"・winOddsを生の値のまま保持する', ({ winOdds }) => {
      const result = estimatePlaceOddsMinFromWin(winOdds);
      expect(result.kind).toBe("単勝オッズ値域外");
      if (result.kind === "単勝オッズ値域外") {
        if (Number.isNaN(winOdds)) {
          expect(Number.isNaN(result.winOdds)).toBe(true);
        } else {
          expect(result.winOdds).toBe(winOdds);
        }
      }
    });
  });

  describe(
    'kind="算出値不正"(状態(d): winOddsは値域内だが算出結果自体がisUsableOddsを満たさない。' +
      "到達条件は「coefが非有限であること」ではない(次項の否定側テストが反例を固定する)。" +
      "#74 R1で発見された残余の解消対象。本番はcoefが常に既定0.2であり、かつこの固定値では" +
      "オーバーフローも起きないため到達しない)",
    () => {
      it('coef=NaNのとき、kind="算出値不正"・valueはNaNであること', () => {
        const result = estimatePlaceOddsMinFromWin(5, { coef: Number.NaN });
        expect(result.kind).toBe("算出値不正");
        if (result.kind === "算出値不正") {
          expect(Number.isNaN(result.value)).toBe(true);
          expect(isUsableOdds(result.value)).toBe(false);
        }
      });

      it('coef=+Infinityのとき、kind="算出値不正"・valueは+Infinityであること', () => {
        const result = estimatePlaceOddsMinFromWin(5, { coef: Number.POSITIVE_INFINITY });
        expect(result.kind).toBe("算出値不正");
        if (result.kind === "算出値不正") {
          expect(result.value).toBe(Number.POSITIVE_INFINITY);
          expect(isUsableOdds(result.value)).toBe(false);
        }
      });

      it(
        'coef=+InfinityかつwinOdds=1.0(境界)のとき、加算項が0×Infinity=NaNになりkind="算出値不正"・' +
          "valueもNaNになること(AC-4(b)相当が名指しした境界そのもの)",
        () => {
          const result = estimatePlaceOddsMinFromWin(1.0, { coef: Number.POSITIVE_INFINITY });
          expect(result.kind).toBe("算出値不正");
          if (result.kind === "算出値不正") {
            expect(Number.isNaN(result.value)).toBe(true);
          }
        },
      );

      // boss メタレビューR3(2026-09-04): 「Infinityが混じると常に下限クランプが機能しない」という
      // 過剰一般化を否定する側。winOdds=5・coef=-Infinityでは加算項が(5-1)×(-Infinity)=-Infinityに
      // なりclamp後は1.0(isUsableOddsを満たす)なのでkind="算出成功"になる(「算出値不正」には
      // 分類されない)。ただしこれはwinOdds=5に限った話であり、winOdds=1.0(境界)では加算項が
      // 0×(-Infinity)=NaNになりkind="算出値不正"になる(直後のテストが反例として固定する。
      // boss差し戻し(Issue #88再メタレビュー要修正1): この文言がwinOddsについて全称として
      // 読めてしまい、winOdds=1.0で偽になっていたことの是正)。
      it(
        'coef=-Infinity・winOdds=5のとき、Math.maxが1.0側にクランプしkind="算出成功"になること' +
          "(過剰一般化の否定側: 「Infinityが混じると常に壊れる」わけではない)",
        () => {
          const result = estimatePlaceOddsMinFromWin(5, { coef: Number.NEGATIVE_INFINITY });
          expect(result.kind).toBe("算出成功");
          expect(okValue(result)).toBe(1);
        },
      );

      // boss差し戻し(Issue #88再メタレビュー要修正1)の反例そのものを固定する: 直前のテスト
      // (winOdds=5・coef=-Infinity→算出成功)と対になり、境界winOdds=1.0では同じcoef=-Infinityでも
      // 算出値不正になることを示す(「coef=-Infinityなら算出成功になる」という全称命題の反証)。
      it(
        'coef=-Infinity・winOdds=1.0(境界)のとき、加算項が0×(-Infinity)=NaNになりkind="算出値不正"・' +
          "valueもNaNになること(直前のテスト〈winOdds=5・coef=-Infinity→算出成功〉と対になる反例)",
        () => {
          const result = estimatePlaceOddsMinFromWin(1.0, { coef: Number.NEGATIVE_INFINITY });
          expect(result.kind).toBe("算出値不正");
          if (result.kind === "算出値不正") {
            expect(Number.isNaN(result.value)).toBe(true);
          }
        },
      );

      // boss差し戻し(Issue #88再メタレビュー要修正2): JSDocが「coefが有限でも到達する」根拠として
      // 掲げた実測例(winOdds=1e308, coef=1e10)がテストで固定されておらず、次の編集者が
      // 「coefが非有限であるために」へ書き戻してもこのテストが1本も赤くならない穴があった。
      // coefが有限であることを無条件expectで固定し、その退化(非有限coefへの書き戻し)にも
      // 気づけるようにする。
      it(
        "coef=1e10(有限)・winOdds=1e308のとき、算出結果がオーバーフローし+Infinityになり" +
          'kind="算出値不正"になること(coefが有限でも到達することの反例。coefが有限であることを' +
          "同時に固定し、非有限coefへの書き戻しでこのテストの前提が壊れることも検出できるようにする)",
        () => {
          const finiteCoef = 1e10;
          // 前提(無条件expect): coefが実際に有限であること。
          expect(Number.isFinite(finiteCoef)).toBe(true);
          const result = estimatePlaceOddsMinFromWin(1e308, { coef: finiteCoef });
          expect(result.kind).toBe("算出値不正");
          if (result.kind === "算出値不正") {
            expect(Number.isFinite(result.value)).toBe(false);
          }
        },
      );
    },
  );

  describe(
    'AC-4(b)相当(boss メタレビューR1・2026-09-04): kind="算出成功"のvalueはisUsableOddsを満たす' +
      "(境界winOdds=1.0はmax(1.0,…)の下限とisUsableOddsの>=1.0が整合する唯一の点。" +
      "既定coef〈0.2〉・妥当な数値coefの下でこの不変条件が成り立つことを値として固定する)",
    () => {
      const cases: Array<{ name: string; winOdds: number; config?: { coef: number } }> = [
        { name: "境界winOdds=1.0・既定coef(0.2)", winOdds: 1.0 },
        { name: "winOdds=1.5・既定coef(0.2)", winOdds: 1.5 },
        { name: "winOdds=10・既定coef(0.2)", winOdds: 10 },
        { name: "winOdds=50・既定coef(0.2)", winOdds: 50 },
        { name: "winOdds=10・coef=0.5(既定以外)", winOdds: 10, config: { coef: 0.5 } },
      ];
      it.each(cases)('$name → kind="算出成功"・isUsableOddsを満たす(true)', ({ winOdds, config }) => {
        const result = estimatePlaceOddsMinFromWin(winOdds, config);
        expect(result.kind).toBe("算出成功");
        expect(isUsableOdds(okValue(result))).toBe(true);
      });
    },
  );

  describe(
    "AC-B0-1: 4状態(算出成功/単勝オッズ未確定/単勝オッズ値域外/算出値不正)が互いに区別できること" +
      "(kindが4通りの相異なるリテラルであることをテーブル駆動で無条件expectする。" +
      "殺す変異: (b)と(c)を同一kindに潰す・(d)の枝を削って(a)に合流させる)",
    () => {
      const cases: Array<{
        name: string;
        winOdds: number | null;
        config?: { coef: number };
        expectedKind: string;
      }> = [
        { name: "算出成功(既定coef・winOdds=10)", winOdds: 10, expectedKind: "算出成功" },
        { name: "単勝オッズ未確定(winOdds=null)", winOdds: null, expectedKind: "単勝オッズ未確定" },
        { name: "単勝オッズ値域外(winOdds=0.9)", winOdds: 0.9, expectedKind: "単勝オッズ値域外" },
        {
          name: "算出値不正(winOdds=5・coef=+Infinity)",
          winOdds: 5,
          config: { coef: Number.POSITIVE_INFINITY },
          expectedKind: "算出値不正",
        },
      ];

      it.each(cases)("$name → kindが$expectedKindであること", ({ winOdds, config, expectedKind }) => {
        const result = estimatePlaceOddsMinFromWin(winOdds, config);
        expect(result.kind).toBe(expectedKind);
      });

      it("4状態のkind文字列は相互に相異なる(Set.sizeが4)", () => {
        const kinds = cases.map((c) => estimatePlaceOddsMinFromWin(c.winOdds, c.config).kind);
        // 前提(無条件expect): 4ケース分のkindが実際に収集できていること。
        expect(kinds.length).toBe(4);
        expect(new Set(kinds).size).toBe(4);
      });
    },
  );
});

/**
 * computeEstimatedRaceEv(推定EV計算)。
 * 発売前(複勝オッズが存在しない)レースで、単勝オッズから推定した複勝下限を用いてEVを概算する。
 * 確定EV経路(computeRaceEv)とは別関数とし、結果の型(EstimatedHorseEv)にも evEstimated: true を
 * 持たせて確定EVと型レベルで区別する。
 */
describe("computeEstimatedRaceEv(推定複勝下限によるEV概算)", () => {
  it("単勝オッズから推定した複勝下限でEVを計算し、evEstimated=trueを付与すること", () => {
    const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.5 }];
    // yoso想定: place は空、win のみ存在。
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: { 1: { odds: 10, ninki: 1 } },
      place: {},
    };
    const [result] = computeEstimatedRaceEv(priors, odds);
    // 推定複勝下限 = 1.0 + (10-1)×0.2 = 2.8。EV = 0.5×2.8 = 1.4。
    expect(result!.placeOddsMin).toBeCloseTo(2.8, 10);
    expect(result!.ev).toBeCloseTo(1.4, 10);
    expect(result!.isPositive).toBe(true);
    expect(result!.evEstimated).toBe(true);
    expect(result!.excludedReason).toBeNull();
  });

  describe(
    "AC-B0-2(Issue #88): coefが非有限で算出値不正(kind=\"算出値不正\")になったとき、" +
      "isPositive=trueにならず対象外(ev=null)になること(#74 R1の残余の解消。" +
      "旧版はcoef=+InfinityでisusableでないplaceOddsMinがisPositive=trueとして返っていた" +
      "——その挙動が消えたことを固定する。殺す変異: isUsableOddsの適用〈kind=\"算出値不正\"の" +
      "分岐〉を外し\"算出成功\"と同じ扱いに合流させる)",
    () => {
      // code-reviewer指摘(2026-09-04)由来の規律を維持: EstimatedHorseEvの全7フィールド
      // (umaban/placeProb/placeOddsMin/ev/isPositive/excludedReason/evEstimated)を射影する。
      // 一部だけを見るタプルにしない(#58のunavailableReason脱落と同型の検出力の穴を防ぐ)。
      // toBe(NaN)はvitestがObject.isで比較するため素直に使える(Object.is(NaN,NaN)===true)。
      it(
        "coef=+Infinityのとき、対象外(ev=null・isPositive=false)になり、" +
          "rawなplaceOddsMin(+Infinity)は#31原則どおりnullに潰さず保持すること(全7フィールド)",
        () => {
          const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.4 }];
          const odds: OddsSnapshot = {
            officialDatetime: null,
            oddsStatus: "yoso",
            win: { 1: { odds: 5, ninki: null } },
            place: {},
          };
          const [result] = computeEstimatedRaceEv(
            priors,
            odds,
            { threshold: 1.0 },
            { coef: Number.POSITIVE_INFINITY },
          );
          expect(result!.umaban).toBe(1);
          expect(result!.placeProb).toBe(0.4);
          expect(result!.placeOddsMin).toBe(Number.POSITIVE_INFINITY);
          expect(result!.ev).toBeNull();
          expect(result!.isPositive).toBe(false);
          expect(result!.excludedReason).not.toBeNull();
          expect(result!.evEstimated).toBe(true);
          expect(isUsableOdds(result!.placeOddsMin!)).toBe(false);
        },
      );

      it(
        "coef=NaNのとき、対象外(ev=null・isPositive=false)になり、" +
          "rawなplaceOddsMin(NaN)は#31原則どおりnullに潰さず保持すること(全7フィールド)",
        () => {
          const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.4 }];
          const odds: OddsSnapshot = {
            officialDatetime: null,
            oddsStatus: "yoso",
            win: { 1: { odds: 5, ninki: null } },
            place: {},
          };
          const [result] = computeEstimatedRaceEv(
            priors,
            odds,
            { threshold: 1.0 },
            { coef: Number.NaN },
          );
          expect(result!.umaban).toBe(1);
          expect(result!.placeProb).toBe(0.4);
          expect(result!.placeOddsMin).toBe(Number.NaN);
          expect(result!.ev).toBeNull();
          expect(result!.isPositive).toBe(false);
          expect(result!.excludedReason).not.toBeNull();
          expect(result!.evEstimated).toBe(true);
          expect(isUsableOdds(result!.placeOddsMin!)).toBe(false);
        },
      );

      it("coef=+Infinity・coef=NaNのどちらも除外理由が同一のリテラルであること(算出値不正の文言を固定)", () => {
        // boss メタレビュー差し戻し(Issue #88要修正3): valueはMath.max(MIN_VALID_ODDS, ...)の
        // 結果であり有限かつ1.0未満を取ることが構造上ありえないため、文言から「1.0未満」を外し
        // 「非有限」のみにする(到達可能な原因だけを書く)。
        const REASON = "推定複勝下限の算出結果が不正な値(非有限)のため対象外";
        const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.4 }];
        const oddsFor = (): OddsSnapshot => ({
          officialDatetime: null,
          oddsStatus: "yoso",
          win: { 1: { odds: 5, ninki: null } },
          place: {},
        });
        const infReason = computeEstimatedRaceEv(
          priors,
          oddsFor(),
          { threshold: 1.0 },
          { coef: Number.POSITIVE_INFINITY },
        )[0]!.excludedReason;
        const nanReason = computeEstimatedRaceEv(
          priors,
          oddsFor(),
          { threshold: 1.0 },
          { coef: Number.NaN },
        )[0]!.excludedReason;
        expect(infReason).toBe(REASON);
        expect(nanReason).toBe(REASON);
        // 「未確定/値域外」側の文言(状態(b)/(c))とは別のリテラルであることも固定する。
        expect(infReason).not.toBe("単勝オッズが未確定または不正な値のため推定複勝下限を算出できない");
      });
    },
  );

  describe(
    "推定複勝下限が算出できない理由の文言(Issue #74 Eスコープ: 偽の断定除去。" +
      "estimatePlaceOddsMinFromWinは現在(Issue #88で判別共用体化した後)、" +
      "「単勝オッズ未確定」〈winOdds===null〉と「単勝オッズ値域外」〈非有限・MIN_VALID_ODDS未満〉を" +
      "kindで区別できるが、evaluateEstimatedHorse側はこの2kindを同一の対象外理由に統合して返す" +
      "設計を維持している。そのため「未確定」とだけ断定すると単勝オッズが値域外〈存在するが不正〉の" +
      "場合に偽になる。code-reviewer指摘: 是正前の旧文言「単勝オッズが未確定のため推定複勝下限を" +
      "算出できない」に戻しても検出できなかったため、toBeによるリテラル比較を追加する)",
    () => {
      // 是正前の旧文言(偽の断定そのもの)。旧文言に戻す変異が入ったら下記テストが赤くなる
      // ことを、このテストを書く過程で実際に確認した(Red→Green のログは完了報告参照)。
      const OLD_FALSE_REASON = "単勝オッズが未確定のため推定複勝下限を算出できない";
      const NEW_REASON = "単勝オッズが未確定または不正な値のため推定複勝下限を算出できない";

      const cases: Array<{ name: string; winOdds: number | null }> = [
        { name: "単勝オッズがnull(真に未確定)", winOdds: null },
        { name: "単勝オッズがNaN(非有限。未確定ではなく不正な値)", winOdds: Number.NaN },
        { name: "単勝オッズが負値(-5。未確定ではなく不正な値)", winOdds: -5 },
        { name: "単勝オッズが0.9(1.0未満・値域外。未確定ではなく不正な値)", winOdds: 0.9 },
      ];

      it.each(cases)(
        "$name → 新文言がリテラルとして固定されること(AC A0: 値として比較)",
        ({ winOdds }) => {
          const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.4 }];
          const odds: OddsSnapshot = {
            officialDatetime: null,
            oddsStatus: "yoso",
            win: { 1: { odds: winOdds, ninki: null } },
            place: {},
          };
          const [result] = computeEstimatedRaceEv(priors, odds);
          expect(result!.ev).toBeNull();
          expect(result!.excludedReason).toBe(NEW_REASON);
          // 旧文言(偽の断定)ではないことも明示的に固定する。
          expect(result!.excludedReason).not.toBe(OLD_FALSE_REASON);
        },
      );

      it("NaN・負値・0.9のいずれも「未確定」ではなく同一の新文言に統一されること(偽の断定を分岐で作り直さない)", () => {
        const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.4 }];
        const values = [Number.NaN, -5, 0.9];
        const reasons = values.map((winOdds) => {
          const odds: OddsSnapshot = {
            officialDatetime: null,
            oddsStatus: "yoso",
            win: { 1: { odds: winOdds, ninki: null } },
            place: {},
          };
          return computeEstimatedRaceEv(priors, odds)[0]!.excludedReason;
        });
        // 前提(無条件expect): 3ケースとも対象外(nullではない理由が付く)であること。
        expect(reasons.every((r) => r !== null)).toBe(true);
        expect(new Set(reasons).size).toBe(1);
        expect(reasons[0]).toBe(NEW_REASON);
      });
    },
  );

  it("単勝オッズも欠損している馬は対象外(ev=null・理由付き)", () => {
    const priors: HorsePrior[] = [{ umaban: 3, placeProb: 0.4 }];
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: { 3: { odds: null, ninki: null } }, // 取消等で単勝オッズも欠損
      place: {},
    };
    const [result] = computeEstimatedRaceEv(priors, odds);
    expect(result!.ev).toBeNull();
    expect(result!.placeOddsMin).toBeNull();
    expect(result!.isPositive).toBe(false);
    expect(result!.evEstimated).toBe(true);
    expect(result!.excludedReason).not.toBeNull();
  });

  it("単勝オッズに馬番自体が無い馬も対象外(ev=null・理由付き)", () => {
    const priors: HorsePrior[] = [{ umaban: 9, placeProb: 0.4 }];
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: {},
      place: {},
    };
    const [result] = computeEstimatedRaceEv(priors, odds);
    expect(result!.ev).toBeNull();
    expect(result!.excludedReason).not.toBeNull();
  });

  it("EvConfig(閾値)は確定EV経路と同じ意味で効くこと", () => {
    const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.5 }];
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: { 1: { odds: 10, ninki: 1 } },
      place: {},
    };
    // EV=1.4なので閾値1.5だとプラスではない。
    const [result] = computeEstimatedRaceEv(priors, odds, { threshold: 1.5 });
    expect(result!.ev).toBeCloseTo(1.4, 10);
    expect(result!.isPositive).toBe(false);
  });

  it.each([
    { name: "threshold=NaN", threshold: Number.NaN },
    { name: "threshold=+Infinity", threshold: Number.POSITIVE_INFINITY },
    { name: "threshold=-Infinity", threshold: Number.NEGATIVE_INFINITY },
  ])(
    "$name は既定閾値(1.0)へフォールバックすること(受け入れ条件19。confirmedEV経路と非対称にならないこと)",
    ({ threshold }) => {
      // 2頭混在(1頭は明らかに正EV、もう1頭は明らかに非正EV)。理由はcomputeRaceEv側の
      // 同種テストのコメント参照(-Infinityの判別力を保つため)。
      const priors: HorsePrior[] = [
        { umaban: 1, placeProb: 0.5 }, // 推定複勝下限2.8→EV=1.4(閾値1.0なら正EV)
        { umaban: 2, placeProb: 0.1 }, // 同条件でEV=0.28(閾値1.0なら非正EV)
      ];
      const odds: OddsSnapshot = {
        officialDatetime: null,
        oddsStatus: "yoso",
        win: { 1: { odds: 10, ninki: 1 }, 2: { odds: 10, ninki: 2 } },
        place: {},
      };
      const expected = computeEstimatedRaceEv(priors, odds, { threshold: 1.0 });
      // 前提(無条件expect): 既定閾値では正EV・非正EVの両方が生じる混在データであること。
      expect(expected.some((r) => r.isPositive)).toBe(true);
      expect(expected.some((r) => !r.isPositive)).toBe(true);

      const actual = computeEstimatedRaceEv(priors, odds, { threshold });
      expect(actual).toEqual(expected);
    },
  );

  it("estimatedPlaceConfig(coef)を差し替えられること", () => {
    const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.5 }];
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: { 1: { odds: 10, ninki: 1 } },
      place: {},
    };
    const [result] = computeEstimatedRaceEv(
      priors,
      odds,
      DEFAULT_EV_CONFIG,
      { coef: 0.5 },
    );
    // 推定複勝下限 = 1.0 + 9×0.5 = 5.5。EV = 0.5×5.5 = 2.75。
    expect(result!.placeOddsMin).toBeCloseTo(5.5, 10);
    expect(result!.ev).toBeCloseTo(2.75, 10);
  });

  it("全馬を入力順で返し、対象外馬も欠落させない", () => {
    const priors: HorsePrior[] = [
      { umaban: 5, placeProb: 0.6 },
      { umaban: 2, placeProb: 0.5 }, // 単勝オッズ欠損
    ];
    const odds: OddsSnapshot = {
      officialDatetime: null,
      oddsStatus: "yoso",
      win: { 5: { odds: 5.5, ninki: 1 }, 2: { odds: null, ninki: null } },
      place: {},
    };
    const results = computeEstimatedRaceEv(priors, odds);
    expect(results.map((r) => r.umaban)).toEqual([5, 2]);
    expect(results[0]!.ev).not.toBeNull();
    expect(results[1]!.ev).toBeNull();
  });
});
