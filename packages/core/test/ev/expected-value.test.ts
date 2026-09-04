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
 * estimatePlaceOddsMinFromWin(推定複勝下限の換算)。
 * ユーザー要望(Task#25): 発売前(oddsStatus=yoso)は予想単勝オッズしかなく複勝が無いため、
 * 単勝オッズから複勝下限を経験則ベースで概算する。既定式:
 *   推定複勝下限 = max(1.0, 1.0 + (winOdds − 1.0) × coef)、coef 既定0.2。
 */
describe("estimatePlaceOddsMinFromWin(単勝オッズ→推定複勝下限の換算)", () => {
  describe("既定係数(coef=0.2)での換算値", () => {
    const cases: Array<{ winOdds: number; expected: number }> = [
      { winOdds: 1.5, expected: 1.1 },
      { winOdds: 10, expected: 2.8 },
      { winOdds: 50, expected: 10.8 },
    ];
    for (const c of cases) {
      it(`単勝${c.winOdds}倍 → 推定複勝下限${c.expected}`, () => {
        expect(
          estimatePlaceOddsMinFromWin(c.winOdds, DEFAULT_ESTIMATED_PLACE_CONFIG),
        ).toBeCloseTo(c.expected, 10);
      });
    }

    it("configを省略するとデフォルト係数(0.2)が使われる", () => {
      expect(DEFAULT_ESTIMATED_PLACE_CONFIG.coef).toBe(0.2);
      expect(estimatePlaceOddsMinFromWin(10)).toBeCloseTo(2.8, 10);
    });
  });

  describe("境界・異常値の扱い", () => {
    it("単勝オッズが1.0ちょうどのときは推定複勝下限も1.0(max(1.0, ...)の下限)", () => {
      expect(estimatePlaceOddsMinFromWin(1.0)).toBeCloseTo(1.0, 10);
    });

    it("winOddsがnullのときはnullを返す", () => {
      expect(estimatePlaceOddsMinFromWin(null)).toBeNull();
    });

    it("winOddsが1未満のときはnullを返す(オッズとして不正)", () => {
      expect(estimatePlaceOddsMinFromWin(0.9)).toBeNull();
    });

    it("winOddsがNaNのときはnullを返す(非有限)", () => {
      expect(estimatePlaceOddsMinFromWin(Number.NaN)).toBeNull();
    });

    it("winOddsがInfinityのときはnullを返す(非有限)", () => {
      expect(estimatePlaceOddsMinFromWin(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it("coefを変えると換算値も変わる(config化されていること)", () => {
      expect(
        estimatePlaceOddsMinFromWin(10, { coef: 0.5 }),
      ).toBeCloseTo(1.0 + 9 * 0.5, 10);
    });
  });

  describe(
    "AC-4(b)(boss メタレビューR1・2026-09-04): 非nullの戻り値はisUsableOddsを満たす" +
      "(境界winOdds=1.0はmax(1.0,…)の下限とisUsableOddsの>=1.0が整合する唯一の点。" +
      "既定coef〈0.2〉・妥当な数値coefの下でこの不変条件が成り立つことを値として固定する。" +
      "grep -rn \"estimatePlaceOddsMinFromWin\" packages/core/test | grep -i \"isUsableOdds\" が" +
      "0件だったこと〈本テスト追加前〉がboss指摘の根拠)",
    () => {
      const cases: Array<{ name: string; winOdds: number; config?: { coef: number } }> = [
        { name: "境界winOdds=1.0・既定coef(0.2)", winOdds: 1.0 },
        { name: "winOdds=1.5・既定coef(0.2)", winOdds: 1.5 },
        { name: "winOdds=10・既定coef(0.2)", winOdds: 10 },
        { name: "winOdds=50・既定coef(0.2)", winOdds: 50 },
        { name: "winOdds=10・coef=0.5(既定以外)", winOdds: 10, config: { coef: 0.5 } },
      ];
      it.each(cases)("$name → 戻り値がisUsableOddsを満たす(true)", ({ winOdds, config }) => {
        const result = estimatePlaceOddsMinFromWin(winOdds, config);
        expect(result).not.toBeNull();
        expect(isUsableOdds(result!)).toBe(true);
      });
    },
  );

  describe(
    "残余(boss メタレビューR1・選択(b)): coefが非有限のときisUsableOddsを満たさない値が" +
      "そのまま推定複勝下限として使われうる(#23-Bへ送る残余。本番では到達しない。" +
      "expected-value.tsのcomputeEstimatedRaceEv JSDoc参照)",
    () => {
      it("coef=NaNのとき、戻り値はNaN(isUsableOddsを満たさない)であること", () => {
        const result = estimatePlaceOddsMinFromWin(5, { coef: Number.NaN });
        expect(result).not.toBeNull();
        expect(Number.isNaN(result!)).toBe(true);
        expect(isUsableOdds(result!)).toBe(false);
      });

      it("coef=+Infinityのとき、戻り値は+Infinity(isUsableOddsを満たさない)であること", () => {
        const result = estimatePlaceOddsMinFromWin(5, { coef: Number.POSITIVE_INFINITY });
        expect(result).toBe(Number.POSITIVE_INFINITY);
        expect(isUsableOdds(result!)).toBe(false);
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
    "残余(boss メタレビューR1・選択(b)。#23-Bへ送る): evaluateEstimatedHorseは" +
      "estimatedOddsMin===nullしか見ておらずisUsableOddsを通さないため、非有限coefを渡すと" +
      "isUsableOddsを満たさないplaceOddsMinがisPositive=trueとして返ることがある" +
      "(本番では到達しない。estimatedPlaceConfigの供給元はpackages/app/srcに存在せず、" +
      "常に既定coef=0.2が使われるため)",
    () => {
      // code-reviewer指摘(2026-09-04): 残余ガードもAC-1と同じ規律(EstimatedHorseEvの
      // 全7フィールド〈umaban/placeProb/placeOddsMin/ev/isPositive/excludedReason/
      // evEstimated〉を射影する。一部だけを見るタプルにしない)で揃える。coef=+Infinity側だけ
      // excludedReasonをtoBeNull()で見ていたのに対しcoef=NaN側は見ておらず非対称だった
      // (#58のunavailableReason脱落と同型の検出力の穴)。toBe(NaN)はvitestがObject.isで
      // 比較するため素直に使える(Object.is(NaN,NaN)===trueを実行して確認済み)。
      it("coef=+Infinityのとき、isPositive=trueだがplaceOddsMinはisUsableOddsを満たさないこと(全7フィールド)", () => {
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
        expect(result!.ev).toBe(Number.POSITIVE_INFINITY);
        expect(result!.isPositive).toBe(true);
        expect(result!.excludedReason).toBeNull();
        expect(result!.evEstimated).toBe(true);
        expect(isUsableOdds(result!.placeOddsMin!)).toBe(false);
      });

      it("coef=NaNのとき、ev/placeOddsMinはNaNでisPositive=falseになること(全7フィールド)", () => {
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
        expect(result!.ev).toBe(Number.NaN);
        expect(result!.isPositive).toBe(false);
        expect(result!.excludedReason).toBeNull();
        expect(result!.evEstimated).toBe(true);
        expect(isUsableOdds(result!.placeOddsMin!)).toBe(false);
      });
    },
  );

  describe(
    "推定複勝下限が算出できない理由の文言(Issue #74 Eスコープ: 偽の断定除去。" +
      "estimatePlaceOddsMinFromWinはnull/非有限/MIN_VALID_ODDS未満を1つのnull戻り値に" +
      "統合しているため、「未確定」と断定すると単勝オッズが値域外〈存在するが不正〉の場合に偽になる。" +
      "code-reviewer指摘: 是正前の旧文言「単勝オッズが未確定のため推定複勝下限を算出できない」に" +
      "戻しても検出できなかったため、toBeによるリテラル比較を追加する)",
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
