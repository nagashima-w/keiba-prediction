import { describe, expect, it } from "vitest";
import { AnalysisStore, type AnalysisHorseRecord } from "../../src/ev/analysis-store.js";
import type { PredictionMark } from "../../src/analyzer/parse-response.js";
import { computeVerifyReport, DEFAULT_VERIFY_CONFIG } from "../../src/ev/verify.js";

/** 分析馬レコードを最小構成で組み立てる(prior=adjustedProb はPhase3まで同値)。 */
function horse(
  umaban: number,
  prob: number,
  placeOddsMin: number | null,
  ev: number | null,
  isPositive: boolean,
): AnalysisHorseRecord {
  return {
    umaban,
    prior: prob,
    adjustedProb: prob,
    placeOddsMin,
    ev,
    isPositive,
    contributions: null,
    mark: null,
  };
}

/**
 * 傾向サマリ(Task#26)テスト用: prior と adjustedProb を独立指定できる分析馬レコードを組み立てる。
 * 回収率集計には使わないため placeOddsMin/ev/isPositive は無関係な値(null/false)にしておく。
 */
function trendHorse(
  umaban: number,
  prior: number,
  adjustedProb: number,
  mark: PredictionMark | null = null,
): AnalysisHorseRecord {
  return {
    umaban,
    prior,
    adjustedProb,
    placeOddsMin: null,
    ev: null,
    isPositive: false,
    contributions: null,
    mark,
  };
}

describe("computeVerifyReport(verify集計)", () => {
  describe("結果未保存分析の除外", () => {
    it("結果が保存されていない分析はレポートから除外し件数を報告すること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      // R1 の結果は保存しない。
      const report = computeVerifyReport(store);
      expect(report.includedAnalysisCount).toBe(0);
      expect(report.excludedAnalysisCount).toBe(1);
      expect(report.bet.betCount).toBe(0);
      expect(report.bet.recoveryRate).toBeNull();
      store.close();
    });
  });

  describe("同一レース複数分析の扱い(二重計上防止)", () => {
    it("既定では同一レースの最新分析のみ集計される(賭け金が1回分・最新のオッズで払戻)", () => {
      const store = new AnalysisStore();
      // 発走前(古い)分析。
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "2026-07-08T09:00:00.000Z",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      // 直前(新しい)分析。オッズ下限が更新されている。
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "2026-07-08T15:00:00.000Z",
        horses: [horse(1, 0.5, 3.0, 1.5, true)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);

      const report = computeVerifyReport(store);
      expect(report.includedAnalysisCount).toBe(1);
      expect(report.supersededAnalysisCount).toBe(1);
      expect(report.bet.betCount).toBe(1);
      expect(report.bet.totalStake).toBe(100);
      // 最新分析(oddsMin=3.0)で払戻される。
      expect(report.bet.totalReturn).toBeCloseTo(300, 10);
      store.close();
    });

    it("分析日時が同時刻タイのときはid大(後に保存した方)を最新として採用する", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "2026-07-08T15:00:00.000Z",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "2026-07-08T15:00:00.000Z",
        horses: [horse(1, 0.5, 3.0, 1.5, true)], // id大 → こちらを採用
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);

      const report = computeVerifyReport(store);
      expect(report.bet.betCount).toBe(1);
      expect(report.bet.totalReturn).toBeCloseTo(300, 10);
      store.close();
    });

    it("includeAllAnalyses:true では全分析を独立集計する(2回計上)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "2026-07-08T09:00:00.000Z",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "2026-07-08T15:00:00.000Z",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);

      const report = computeVerifyReport(store, {
        ...DEFAULT_VERIFY_CONFIG,
        includeAllAnalyses: true,
      });
      expect(report.includedAnalysisCount).toBe(2);
      expect(report.supersededAnalysisCount).toBe(0);
      expect(report.bet.betCount).toBe(2);
      expect(report.bet.totalStake).toBe(200);
      expect(report.bet.totalReturn).toBeCloseTo(500, 10);
      store.close();
    });
  });

  describe("累積回収率(EVプラス馬券を複勝100円ずつ)", () => {
    it("全件的中: 回収率は払戻(オッズ下限×100)合計/賭け金合計になること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [
          horse(1, 0.5, 2.5, 1.25, true), // EV+ 、複勝圏内
          horse(2, 0.4, 3.0, 1.2, true), // EV+ 、複勝圏内
          horse(3, 0.1, 5.0, 0.5, false), // EV- 、賭けない
        ],
      });
      store.saveResult("R1", [
        { umaban: 1, finishPosition: 1 },
        { umaban: 2, finishPosition: 3 },
        { umaban: 3, finishPosition: 2 },
      ]);
      const report = computeVerifyReport(store);
      expect(report.includedAnalysisCount).toBe(1);
      expect(report.bet.betCount).toBe(2); // EV+ の2頭のみ
      expect(report.bet.totalStake).toBe(200);
      // 払戻 = 100×2.5 + 100×3.0 = 550
      expect(report.bet.totalReturn).toBeCloseTo(550, 10);
      expect(report.bet.recoveryRate).toBeCloseTo(550 / 200, 10);
      store.close();
    });

    it("的中0件: 払戻0・回収率0になること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 8 }]); // 圏外
      const report = computeVerifyReport(store);
      expect(report.bet.betCount).toBe(1);
      expect(report.bet.totalReturn).toBe(0);
      expect(report.bet.recoveryRate).toBe(0);
      store.close();
    });

    it("EVプラス馬券が無ければ回収率は null(0除算を避ける)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [horse(1, 0.1, 2.0, 0.2, false)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      const report = computeVerifyReport(store);
      expect(report.bet.betCount).toBe(0);
      expect(report.bet.recoveryRate).toBeNull();
      store.close();
    });

    it("着順不明(null)のEVプラス馬は賭け集計から除外されること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [
          horse(1, 0.5, 2.5, 1.25, true), // 着順不明 → 除外
          horse(2, 0.5, 2.0, 1.0, true), // 的中
        ],
      });
      store.saveResult("R1", [
        { umaban: 1, finishPosition: null },
        { umaban: 2, finishPosition: 2 },
      ]);
      const report = computeVerifyReport(store);
      expect(report.bet.betCount).toBe(1); // 馬番2のみ
      expect(report.bet.totalStake).toBe(100);
      expect(report.bet.totalReturn).toBeCloseTo(200, 10);
      store.close();
    });
  });

  describe("キャリブレーション表(推定確率帯ごとの実際の複勝率)", () => {
    it("10個の確率帯(0-10%..90-100%)を返すこと", () => {
      const store = new AnalysisStore();
      const report = computeVerifyReport(store);
      expect(report.calibration).toHaveLength(10);
      expect(report.calibration[0]!.lowerBound).toBeCloseTo(0, 10);
      expect(report.calibration[0]!.upperBound).toBeCloseTo(0.1, 10);
      expect(report.calibration[9]!.lowerBound).toBeCloseTo(0.9, 10);
      expect(report.calibration[9]!.upperBound).toBeCloseTo(1.0, 10);
    });

    it("確率帯の下限は含み上限は含まない(10%ちょうどは10-20%帯、100%は90-100%帯)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [
          horse(1, 0.1, 2.0, 0.2, false), // → 10-20% 帯
          horse(2, 0.2, 2.0, 0.4, false), // → 20-30% 帯
          horse(3, 1.0, 2.0, 2.0, true), // → 90-100% 帯
        ],
      });
      store.saveResult("R1", [
        { umaban: 1, finishPosition: 1 },
        { umaban: 2, finishPosition: 8 },
        { umaban: 3, finishPosition: 2 },
      ]);
      const report = computeVerifyReport(store);
      expect(report.calibration[1]!.predictedCount).toBe(1); // 10-20%
      expect(report.calibration[2]!.predictedCount).toBe(1); // 20-30%
      expect(report.calibration[9]!.predictedCount).toBe(1); // 90-100%
      // 0-10% 帯には誰も入らない。
      expect(report.calibration[0]!.predictedCount).toBe(0);
      store.close();
    });

    it("各帯の実際の複勝率 = 複勝圏内(3着以内)件数 / 予測件数", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [
          horse(1, 0.45, 2.0, 0.9, false), // 40-50%、複勝圏内
          horse(2, 0.42, 2.0, 0.84, false), // 40-50%、圏外
        ],
      });
      store.saveResult("R1", [
        { umaban: 1, finishPosition: 3 },
        { umaban: 2, finishPosition: 5 },
      ]);
      const report = computeVerifyReport(store);
      const bin = report.calibration[4]!; // 40-50%
      expect(bin.predictedCount).toBe(2);
      expect(bin.placedCount).toBe(1);
      expect(bin.actualPlaceRate).toBeCloseTo(0.5, 10);
    });

    it("予測件数0の帯は複勝率 null(0除算を避ける)", () => {
      const store = new AnalysisStore();
      const report = computeVerifyReport(store);
      expect(report.calibration[5]!.predictedCount).toBe(0);
      expect(report.calibration[5]!.actualPlaceRate).toBeNull();
    });

    it("着順不明(null)は確率帯集計からも除外されること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [horse(1, 0.45, 2.0, 0.9, false)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: null }]);
      const report = computeVerifyReport(store);
      expect(report.calibration[4]!.predictedCount).toBe(0);
      store.close();
    });
  });

  describe("推定EVフラグ付き分析の除外(Task#25)", () => {
    it("evEstimated:trueの分析は既定で集計から除外され、excludedEstimatedCountに計上されること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        evEstimated: true,
        horses: [horse(1, 0.5, 2.8, 1.4, true)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      const report = computeVerifyReport(store);
      expect(report.includedAnalysisCount).toBe(0);
      expect(report.excludedEstimatedCount).toBe(1);
      // 回収率集計(bet)からも除外される。
      expect(report.bet.betCount).toBe(0);
      // キャリブレーション表にも計上しない(推定EV分析は丸ごと除外する設計判断)。
      expect(report.calibration.every((bin) => bin.predictedCount === 0)).toBe(
        true,
      );
      store.close();
    });

    it("evEstimated未指定(既定false)の分析は従来どおり集計されること(回帰確認)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      const report = computeVerifyReport(store);
      expect(report.includedAnalysisCount).toBe(1);
      expect(report.excludedEstimatedCount).toBe(0);
      expect(report.bet.betCount).toBe(1);
      store.close();
    });

    it("同一レースで推定EV分析の後に確定EV分析が行われた場合、最新(確定)分析のみ集計されること", () => {
      const store = new AnalysisStore();
      // 発売前(推定EV)。
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "2026-07-08T09:00:00.000Z",
        evEstimated: true,
        horses: [horse(1, 0.5, 2.8, 1.4, true)],
      });
      // 発売後の再分析(確定EV)。
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "2026-07-08T15:00:00.000Z",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      const report = computeVerifyReport(store);
      expect(report.includedAnalysisCount).toBe(1);
      expect(report.supersededAnalysisCount).toBe(1);
      expect(report.excludedEstimatedCount).toBe(0);
      expect(report.bet.betCount).toBe(1);
      // 最新(確定EV, oddsMin=2.5)で払戻される。
      expect(report.bet.totalReturn).toBeCloseTo(250, 10);
      store.close();
    });
  });

  describe("実配当による回収率(actualPayout優先・近似フォールバック)", () => {
    it("実配当(placePayout)があれば近似ではなく実配当で払戻を計上すること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        // 複勝下限2.0(近似では的中で200円)。EVプラスで購入。
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      // 実際の複勝確定払戻は300円(100円あたり)。的中(3着以内)。
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1, placePayout: 300 }]);
      const report = computeVerifyReport(store);
      expect(report.bet.betCount).toBe(1);
      expect(report.bet.totalStake).toBe(100);
      // 近似(下限2.0 → 200円)ではなく実配当300円で計上される。
      expect(report.bet.totalReturn).toBe(300);
      expect(report.bet.actualPayoutCount).toBe(1);
      expect(report.bet.approximatePayoutCount).toBe(0);
      store.close();
    });

    it("実配当が無ければ従来どおり複勝オッズ下限で近似すること(後方互換)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      // placePayout を保存しない(旧データ相当)。
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      const report = computeVerifyReport(store);
      expect(report.bet.totalReturn).toBe(200); // 下限2.0 × 100円
      expect(report.bet.actualPayoutCount).toBe(0);
      expect(report.bet.approximatePayoutCount).toBe(1);
      store.close();
    });

    it("賭け金が100円以外でも実配当を100円あたりで按分して計上すること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1, placePayout: 300 }]);
      const report = computeVerifyReport(store, {
        ...DEFAULT_VERIFY_CONFIG,
        stakePerBet: 200,
      });
      expect(report.bet.totalStake).toBe(200);
      // 実配当300円/100円 × 200円 = 600円。
      expect(report.bet.totalReturn).toBe(600);
      expect(report.bet.actualPayoutCount).toBe(1);
      store.close();
    });

    it("不的中の購入は実配当・近似いずれの件数にも計上しないこと", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 5 }]); // 圏外
      const report = computeVerifyReport(store);
      expect(report.bet.betCount).toBe(1);
      expect(report.bet.totalReturn).toBe(0);
      expect(report.bet.actualPayoutCount).toBe(0);
      expect(report.bet.approximatePayoutCount).toBe(0);
      store.close();
    });
  });

  describe("補正傾向サマリ(VerifyTrendReport, Task#26)", () => {
    describe("(1) 補正方向×結果", () => {
      it("分析0件のとき上げ・下げ・据え置きの3群を件数0・rateはnullで返すこと", () => {
        const store = new AnalysisStore();
        const report = computeVerifyReport(store);
        expect(report.trend.directionGroups).toHaveLength(3);
        expect(
          report.trend.directionGroups.map((g) => g.direction).slice().sort(),
        ).toEqual(["lowered", "raised", "unchanged"]);
        for (const g of report.trend.directionGroups) {
          expect(g.count).toBe(0);
          expect(g.actualPlaceRate).toBeNull();
          expect(g.averageAdjustment).toBeNull();
        }
        store.close();
      });

      it("diffがちょうどε(既定0.005)なら据え置きに分類されること(境界は据え置き側)", () => {
        const store = new AnalysisStore();
        store.saveAnalysis({
          raceId: "R1",
          analyzedAt: "t",
          horses: [trendHorse(1, 0, 0.005, null)], // diff = +0.005 ちょうど
        });
        store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
        const report = computeVerifyReport(store);
        const unchanged = report.trend.directionGroups.find(
          (g) => g.direction === "unchanged",
        )!;
        expect(unchanged.count).toBe(1);
        const raised = report.trend.directionGroups.find(
          (g) => g.direction === "raised",
        )!;
        expect(raised.count).toBe(0);
        store.close();
      });

      it("diffがちょうど-εなら据え置きに分類されること(境界は据え置き側)", () => {
        const store = new AnalysisStore();
        store.saveAnalysis({
          raceId: "R1",
          analyzedAt: "t",
          horses: [trendHorse(1, 0, -0.005, null)], // diff = -0.005 ちょうど
        });
        store.saveResult("R1", [{ umaban: 1, finishPosition: 5 }]);
        const report = computeVerifyReport(store);
        const unchanged = report.trend.directionGroups.find(
          (g) => g.direction === "unchanged",
        )!;
        expect(unchanged.count).toBe(1);
        const lowered = report.trend.directionGroups.find(
          (g) => g.direction === "lowered",
        )!;
        expect(lowered.count).toBe(0);
        store.close();
      });

      it("上げ・下げ・据え置きの3群それぞれに件数・実複勝率・平均補正幅を算出すること", () => {
        const store = new AnalysisStore();
        store.saveAnalysis({
          raceId: "R1",
          analyzedAt: "t",
          horses: [
            trendHorse(1, 0.2, 0.3, null), // diff +0.10 上げ、複勝
            trendHorse(2, 0.2, 0.28, null), // diff +0.08 上げ、圏外
            trendHorse(3, 0.4, 0.3, null), // diff -0.10 下げ、複勝
            trendHorse(4, 0.4, 0.2, null), // diff -0.20 下げ、圏外
            trendHorse(5, 0.5, 0.501, null), // diff +0.001(<ε) 据え置き、複勝
          ],
        });
        store.saveResult("R1", [
          { umaban: 1, finishPosition: 1 },
          { umaban: 2, finishPosition: 8 },
          { umaban: 3, finishPosition: 2 },
          { umaban: 4, finishPosition: 9 },
          { umaban: 5, finishPosition: 3 },
        ]);
        const report = computeVerifyReport(store);

        const raised = report.trend.directionGroups.find(
          (g) => g.direction === "raised",
        )!;
        expect(raised.count).toBe(2);
        expect(raised.actualPlaceRate).toBeCloseTo(0.5, 10); // 2頭中1頭複勝
        expect(raised.averageAdjustment).toBeCloseTo((0.1 + 0.08) / 2, 10);

        const lowered = report.trend.directionGroups.find(
          (g) => g.direction === "lowered",
        )!;
        expect(lowered.count).toBe(2);
        expect(lowered.actualPlaceRate).toBeCloseTo(0.5, 10); // 2頭中1頭複勝
        expect(lowered.averageAdjustment).toBeCloseTo((-0.1 + -0.2) / 2, 10);

        const unchanged = report.trend.directionGroups.find(
          (g) => g.direction === "unchanged",
        )!;
        expect(unchanged.count).toBe(1);
        expect(unchanged.actualPlaceRate).toBeCloseTo(1, 10);
        expect(unchanged.averageAdjustment).toBeCloseTo(0.001, 10);
        store.close();
      });

      it("着順不明の馬はdirectionGroupsの集計から除外されること", () => {
        const store = new AnalysisStore();
        store.saveAnalysis({
          raceId: "R1",
          analyzedAt: "t",
          horses: [trendHorse(1, 0.5, 0.6, "◎")],
        });
        store.saveResult("R1", [{ umaban: 1, finishPosition: null }]);
        const report = computeVerifyReport(store);
        expect(report.trend.directionGroups.every((g) => g.count === 0)).toBe(
          true,
        );
        store.close();
      });
    });

    describe("(2) キャリブレーションの過信バイアス", () => {
      it("代表予測値は帯の中央値であること(例 20-30%帯→0.25)、予測0件の帯はoverconfidenceGapがnullであること", () => {
        const store = new AnalysisStore();
        const report = computeVerifyReport(store);
        expect(report.trend.calibrationBias).toHaveLength(10);
        expect(report.trend.calibrationBias[2]!.representativeProb).toBeCloseTo(
          0.25,
          10,
        );
        expect(report.trend.calibrationBias[2]!.predictedCount).toBe(0);
        expect(report.trend.calibrationBias[2]!.overconfidenceGap).toBeNull();
        store.close();
      });

      it("予測(代表値)が実績を上回るときoverconfidenceGapは正(過信)になること", () => {
        const store = new AnalysisStore();
        store.saveAnalysis({
          raceId: "R1",
          analyzedAt: "t",
          horses: [
            trendHorse(1, 0.25, 0.25, null), // 20-30%帯、圏外
            trendHorse(2, 0.25, 0.25, null), // 20-30%帯、圏外
          ],
        });
        store.saveResult("R1", [
          { umaban: 1, finishPosition: 8 },
          { umaban: 2, finishPosition: 9 },
        ]);
        const report = computeVerifyReport(store);
        const bin = report.trend.calibrationBias[2]!;
        expect(bin.predictedCount).toBe(2);
        expect(bin.actualPlaceRate).toBeCloseTo(0, 10);
        expect(bin.representativeProb).toBeCloseTo(0.25, 10);
        // 予測0.25 − 実績0 = +0.25(過信)。
        expect(bin.overconfidenceGap).toBeCloseTo(0.25, 10);
        store.close();
      });

      it("実績が予測(代表値)を上回るときoverconfidenceGapは負(過小評価)になること", () => {
        const store = new AnalysisStore();
        store.saveAnalysis({
          raceId: "R1",
          analyzedAt: "t",
          horses: [trendHorse(1, 0.05, 0.05, null)], // 0-10%帯
        });
        store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]); // 的中→実績1
        const report = computeVerifyReport(store);
        const bin = report.trend.calibrationBias[0]!;
        expect(bin.representativeProb).toBeCloseTo(0.05, 10);
        expect(bin.actualPlaceRate).toBeCloseTo(1, 10);
        expect(bin.overconfidenceGap).toBeCloseTo(0.05 - 1, 10);
        store.close();
      });
    });

    describe("(3) 印別的中率", () => {
      it("印なし(null)を含む7群を常に返し、0件は件数0・rateはnullであること", () => {
        const store = new AnalysisStore();
        const report = computeVerifyReport(store);
        expect(report.trend.markStats).toHaveLength(7);
        expect(report.trend.markStats.map((m) => m.mark)).toEqual([
          "◎",
          "〇",
          "▲",
          "△",
          "☆",
          "注",
          null,
        ]);
        for (const m of report.trend.markStats) {
          expect(m.count).toBe(0);
          expect(m.placeRate).toBeNull();
          expect(m.winRate).toBeNull();
        }
        store.close();
      });

      it("印ごとに件数・複勝率(finish<=3)・勝率(finish=1)を算出すること", () => {
        const store = new AnalysisStore();
        store.saveAnalysis({
          raceId: "R1",
          analyzedAt: "t",
          horses: [
            trendHorse(1, 0.5, 0.5, "◎"), // finish1: 勝ち・複勝
            trendHorse(2, 0.3, 0.3, "〇"), // finish4: 圏外
            trendHorse(3, 0.2, 0.2, null), // finish2: 複勝(勝ちではない)
          ],
        });
        store.saveResult("R1", [
          { umaban: 1, finishPosition: 1 },
          { umaban: 2, finishPosition: 4 },
          { umaban: 3, finishPosition: 2 },
        ]);
        const report = computeVerifyReport(store);

        const honmei = report.trend.markStats.find((m) => m.mark === "◎")!;
        expect(honmei.count).toBe(1);
        expect(honmei.placeRate).toBeCloseTo(1, 10);
        expect(honmei.winRate).toBeCloseTo(1, 10);

        const taikou = report.trend.markStats.find((m) => m.mark === "〇")!;
        expect(taikou.count).toBe(1);
        expect(taikou.placeRate).toBeCloseTo(0, 10);
        expect(taikou.winRate).toBeCloseTo(0, 10);

        const noMark = report.trend.markStats.find((m) => m.mark === null)!;
        expect(noMark.count).toBe(1);
        expect(noMark.placeRate).toBeCloseTo(1, 10);
        expect(noMark.winRate).toBeCloseTo(0, 10);

        // ▲△☆注は0件のまま。
        for (const mark of ["▲", "△", "☆", "注"] as const) {
          const stat = report.trend.markStats.find((m) => m.mark === mark)!;
          expect(stat.count).toBe(0);
          expect(stat.placeRate).toBeNull();
          expect(stat.winRate).toBeNull();
        }
        store.close();
      });

      it("着順不明の馬はmarkStatsの集計から除外されること", () => {
        const store = new AnalysisStore();
        store.saveAnalysis({
          raceId: "R1",
          analyzedAt: "t",
          horses: [trendHorse(1, 0.5, 0.6, "☆")],
        });
        store.saveResult("R1", [{ umaban: 1, finishPosition: null }]);
        const report = computeVerifyReport(store);
        expect(report.trend.markStats.every((m) => m.count === 0)).toBe(true);
        store.close();
      });
    });

    describe("母集団の整合性(既存verifyと同じ絞り込みを共有すること)", () => {
      it("結果未保存・推定EV・旧分析(latestで取って代わられた分析)は傾向サマリからも除外されること", () => {
        const store = new AnalysisStore();
        // 結果未保存 → 除外。
        store.saveAnalysis({
          raceId: "R1",
          analyzedAt: "t",
          horses: [trendHorse(1, 0.5, 0.6, "◎")],
        });
        // 推定EV → 除外。
        store.saveAnalysis({
          raceId: "R2",
          analyzedAt: "t",
          evEstimated: true,
          horses: [trendHorse(1, 0.5, 0.6, "◎")],
        });
        store.saveResult("R2", [{ umaban: 1, finishPosition: 1 }]);
        // 同一レースの旧分析(supersededされ除外)と最新分析。
        store.saveAnalysis({
          raceId: "R3",
          analyzedAt: "2026-07-08T09:00:00.000Z",
          horses: [trendHorse(1, 0.5, 0.6, "◎")],
        });
        store.saveAnalysis({
          raceId: "R3",
          analyzedAt: "2026-07-08T15:00:00.000Z",
          horses: [trendHorse(1, 0.5, 0.6, "〇")],
        });
        store.saveResult("R3", [{ umaban: 1, finishPosition: 1 }]);

        const report = computeVerifyReport(store);
        // R1(結果未保存)・R2(推定EV)の「◎」は計上されず、R3最新分析の「〇」のみ計上される。
        const honmei = report.trend.markStats.find((m) => m.mark === "◎")!;
        expect(honmei.count).toBe(0);
        const taikou = report.trend.markStats.find((m) => m.mark === "〇")!;
        expect(taikou.count).toBe(1);
        store.close();
      });
    });
  });
});
