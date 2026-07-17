import { describe, expect, it } from "vitest";
import { AnalysisStore, type AnalysisHorseRecord } from "../../src/ev/analysis-store.js";
import type { PredictionMark } from "../../src/analyzer/parse-response.js";
import {
  computeRaceBreakdown,
  computeVerifyReport,
  computeVerifyReportByPromptVersion,
  DEFAULT_VERIFY_CONFIG,
} from "../../src/ev/verify.js";

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

  describe("未知のmark文字列に対する防御(Task#26 boss観察1 / Task#27)", () => {
    it("PREDICTION_MARKSに無い想定外のmark文字列が保存されていてもクラッシュしないこと", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [
          // 型システムを迂回し、将来のスキーマ変更・手動DB改変で紛れ込みうる未知のmark値を模す。
          { ...trendHorse(1, 0.5, 0.6), mark: "×" as unknown as PredictionMark },
        ],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      expect(() => computeVerifyReport(store)).not.toThrow();
      store.close();
    });

    it("未知のmark文字列は「印なし」群に集計されること(専用の集計外扱いにはしない)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [
          { ...trendHorse(1, 0.5, 0.6), mark: "×" as unknown as PredictionMark },
        ],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      const report = computeVerifyReport(store);
      const noMark = report.trend.markStats.find((m) => m.mark === null)!;
      expect(noMark.count).toBe(1);
      expect(noMark.placeRate).toBeCloseTo(1, 10);
      // 既知の印(◎など)には計上されない。
      const total = report.trend.markStats.reduce((sum, m) => sum + m.count, 0);
      expect(total).toBe(1);
      store.close();
    });
  });
});

describe("computeVerifyReportByPromptVersion(プロンプト版別のverify集計、Task#27)", () => {
  it("prompt_versionごとに分析を分けて集計すること(版が互いに影響しないこと)", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "t",
      promptVersion: "2026-07-01.1",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
    store.saveAnalysis({
      raceId: "R2",
      analyzedAt: "t",
      promptVersion: "2026-07-14.1",
      horses: [horse(1, 0.5, 4.0, 2.0, true)],
    });
    store.saveResult("R2", [{ umaban: 1, finishPosition: 5 }]);

    const reports = computeVerifyReportByPromptVersion(store);
    expect(reports).toHaveLength(2);

    const v1 = reports.find((r) => r.promptVersion === "2026-07-01.1")!;
    expect(v1.report.includedAnalysisCount).toBe(1);
    expect(v1.report.bet.recoveryRate).toBeCloseTo(2.0, 10); // 的中(複勝下限2.0倍)

    const v2 = reports.find((r) => r.promptVersion === "2026-07-14.1")!;
    expect(v2.report.includedAnalysisCount).toBe(1);
    expect(v2.report.bet.recoveryRate).toBeCloseTo(0, 10); // 不的中
    store.close();
  });

  it("版不明(promptVersion=null)の分析は1グループとして集計されること", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "t",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);

    const reports = computeVerifyReportByPromptVersion(store);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.promptVersion).toBeNull();
    expect(reports[0]!.report.includedAnalysisCount).toBe(1);
    store.close();
  });

  it("版番号は昇順で返し、版不明(null)は末尾に来ること", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "t",
      promptVersion: "2026-07-14.1",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveAnalysis({
      raceId: "R2",
      analyzedAt: "t",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveAnalysis({
      raceId: "R3",
      analyzedAt: "t",
      promptVersion: "2026-07-01.1",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });

    const reports = computeVerifyReportByPromptVersion(store);
    expect(reports.map((r) => r.promptVersion)).toEqual([
      "2026-07-01.1",
      "2026-07-14.1",
      null,
    ]);
    store.close();
  });

  it("同一版内でも同一レースの二重計上防止(latestモード)が独立して適用されること", () => {
    const store = new AnalysisStore();
    // 同一版・同一レースの新旧分析。
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "2026-07-08T09:00:00.000Z",
      promptVersion: "2026-07-14.1",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "2026-07-08T15:00:00.000Z",
      promptVersion: "2026-07-14.1",
      horses: [horse(1, 0.5, 3.0, 1.5, true)],
    });
    store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);

    const reports = computeVerifyReportByPromptVersion(store);
    const v1 = reports.find((r) => r.promptVersion === "2026-07-14.1")!;
    expect(v1.report.includedAnalysisCount).toBe(1);
    expect(v1.report.supersededAnalysisCount).toBe(1);
    // 最新分析(複勝下限3.0倍)の払戻が採用される。
    expect(v1.report.bet.totalReturn).toBeCloseTo(300, 10);
    store.close();
  });

  it("分析が1件も保存されていなければ空配列を返すこと", () => {
    const store = new AnalysisStore();
    expect(computeVerifyReportByPromptVersion(store)).toEqual([]);
    store.close();
  });

  describe("同一レースが異なる版で複数回分析された場合(版をまたいだ最新判定はしないこと)", () => {
    // 同一raceIdを版A(旧・先に分析)と版B(新・後で再分析)の両方で保存する状況を作る。
    // computeVerifyReportByPromptVersion は「版ごとに独立した母集団」で latest選択するため、
    // 版Aの分析は版Bの分析に取って代わられず、両方の版グループにそれぞれ計上されるはず。
    // 一方、既存の computeVerifyReport(全体集計)は従来どおり版をまたいで最新1件に絞り込む。
    function setupTwoVersionsOfSameRace(): AnalysisStore {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "2026-07-01T09:00:00.000Z",
        promptVersion: "2026-07-01.1",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "2026-07-14T09:00:00.000Z",
        promptVersion: "2026-07-14.1",
        horses: [horse(1, 0.5, 5.0, 2.5, true)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
      return store;
    }

    it("(a) 版A・版Bそれぞれのグループにincluded=1で計上されること", () => {
      const store = setupTwoVersionsOfSameRace();
      const reports = computeVerifyReportByPromptVersion(store);

      const versionA = reports.find((r) => r.promptVersion === "2026-07-01.1")!;
      expect(versionA.report.includedAnalysisCount).toBe(1);
      expect(versionA.report.bet.totalReturn).toBeCloseTo(200, 10); // 複勝下限2.0倍

      const versionB = reports.find((r) => r.promptVersion === "2026-07-14.1")!;
      expect(versionB.report.includedAnalysisCount).toBe(1);
      expect(versionB.report.bet.totalReturn).toBeCloseTo(500, 10); // 複勝下限5.0倍
      store.close();
    });

    it("(b) 版をまたいだsuperseded判定は起きないこと(各版内では最新のみで、supersededは0)", () => {
      const store = setupTwoVersionsOfSameRace();
      const reports = computeVerifyReportByPromptVersion(store);

      const versionA = reports.find((r) => r.promptVersion === "2026-07-01.1")!;
      expect(versionA.report.supersededAnalysisCount).toBe(0);

      const versionB = reports.find((r) => r.promptVersion === "2026-07-14.1")!;
      expect(versionB.report.supersededAnalysisCount).toBe(0);
      store.close();
    });

    it("(c) 全体集計(computeVerifyReport)は従来どおり版をまたいで最新1件のみに絞ること(回帰確認)", () => {
      const store = setupTwoVersionsOfSameRace();
      const overall = computeVerifyReport(store);

      expect(overall.includedAnalysisCount).toBe(1);
      expect(overall.supersededAnalysisCount).toBe(1);
      // 最新(版B・analyzedAtが新しい方、複勝下限5.0倍)の払戻が採用される。
      expect(overall.bet.totalReturn).toBeCloseTo(500, 10);
      store.close();
    });
  });

  describe("additionalInstructions(版内で使われた追加指示の要約、Task#28 プロンプト改善C)", () => {
    // 追加指示は実質的にプロンプトを変えるため、同じprompt_version内でも追加指示が異なれば
    // 別条件として区別できる必要がある(docs/prompt-improvement-plan.md 方式C)。
    // computeVerifyReportByPromptVersion は版でグループ化した上で、そのグループ内に登場した
    // additionalInstruction の重複しない値の一覧を additionalInstructions として返す。

    it("追加指示が無い分析のみの版は additionalInstructions が [null] になること", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        promptVersion: "2026-07-14.1",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      const reports = computeVerifyReportByPromptVersion(store);
      expect(reports[0]!.additionalInstructions).toEqual([null]);
      store.close();
    });

    it("同一版内で同じ追加指示のみが使われていれば、その1件だけを返すこと(重複排除)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        promptVersion: "2026-07-14.1",
        additionalInstruction: "人気薄の複勝率は慎重に見積もること",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      store.saveAnalysis({
        raceId: "R2",
        analyzedAt: "t",
        promptVersion: "2026-07-14.1",
        additionalInstruction: "人気薄の複勝率は慎重に見積もること",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      const reports = computeVerifyReportByPromptVersion(store);
      expect(reports[0]!.additionalInstructions).toEqual([
        "人気薄の複勝率は慎重に見積もること",
      ]);
      store.close();
    });

    it("同一版内で異なる追加指示(追加指示なしを含む)が混在すれば、両方を返すこと(nullは末尾)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        promptVersion: "2026-07-14.1",
        additionalInstruction: "指示B",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      store.saveAnalysis({
        raceId: "R2",
        analyzedAt: "t",
        promptVersion: "2026-07-14.1",
        additionalInstruction: "指示A",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      store.saveAnalysis({
        raceId: "R3",
        analyzedAt: "t",
        promptVersion: "2026-07-14.1",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      const reports = computeVerifyReportByPromptVersion(store);
      // 非null値は文字列昇順、nullは末尾という決定的な順序。
      expect(reports[0]!.additionalInstructions).toEqual(["指示A", "指示B", null]);
      store.close();
    });

    it("版が異なれば追加指示の集計も独立していること(他版の追加指示が混入しないこと)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        promptVersion: "2026-07-01.1",
        additionalInstruction: "旧版の指示",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      store.saveAnalysis({
        raceId: "R2",
        analyzedAt: "t",
        promptVersion: "2026-07-14.1",
        additionalInstruction: "新版の指示",
        horses: [horse(1, 0.5, 2.0, 1.0, true)],
      });
      const reports = computeVerifyReportByPromptVersion(store);
      const oldVersion = reports.find((r) => r.promptVersion === "2026-07-01.1")!;
      const newVersion = reports.find((r) => r.promptVersion === "2026-07-14.1")!;
      expect(oldVersion.additionalInstructions).toEqual(["旧版の指示"]);
      expect(newVersion.additionalInstructions).toEqual(["新版の指示"]);
      store.close();
    });
  });
});

describe("computeRaceBreakdown(レース単位の予実ブレークダウン、Task#34)", () => {
  it("verifyと同じ賭け判定(実配当優先・EVプラス馬に賭ける)で1頭ごとの予測・結果・賭け金/払戻を返すこと", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      kaisaiDate: "20260708",
      promptVersion: "2026-07-14.1",
      horses: [
        horse(1, 0.5, 2.0, 1.0, true), // EVプラス・複勝圏内 → 実配当計上
        horse(2, 0.2, 1.5, 0.3, false), // EVプラスでない → 賭けない
      ],
    });
    store.saveResult("R1", [
      { umaban: 1, finishPosition: 1, placePayout: 300 },
      { umaban: 2, finishPosition: 4 },
    ]);
    const [breakdown] = computeRaceBreakdown(store);
    expect(breakdown).toBeDefined();
    expect(breakdown!.raceId).toBe("R1");
    expect(breakdown!.kaisaiDate).toBe("20260708");
    expect(breakdown!.promptVersion).toBe("2026-07-14.1");
    expect(breakdown!.horses).toHaveLength(2);

    const [h1, h2] = breakdown!.horses;
    // 1番: EVプラス・的中・実配当300円計上。
    expect(h1!.umaban).toBe(1);
    expect(h1!.isPositive).toBe(true);
    expect(h1!.adjustedProb).toBe(0.5);
    expect(h1!.finishPosition).toBe(1);
    expect(h1!.isPlaced).toBe(true);
    expect(h1!.stake).toBe(100);
    expect(h1!.payout).toBe(300);
    expect(h1!.payoutSource).toBe("actual");
    // 2番: EVプラスでないため賭け金・払戻とも0。
    expect(h2!.umaban).toBe(2);
    expect(h2!.isPositive).toBe(false);
    expect(h2!.finishPosition).toBe(4);
    expect(h2!.isPlaced).toBe(false);
    expect(h2!.stake).toBe(0);
    expect(h2!.payout).toBe(0);
    expect(h2!.payoutSource).toBeNull();

    // レース単位の合計は各馬の賭け金/払戻の合計と一致する。
    expect(breakdown!.betCount).toBe(1);
    expect(breakdown!.totalStake).toBe(100);
    expect(breakdown!.totalReturn).toBe(300);
    expect(breakdown!.recoveryRate).toBeCloseTo(3.0, 10);
    store.close();
  });

  it("実配当が無ければ複勝オッズ下限で近似計上すること(verifyの近似フォールバックと一致)", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "t",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]); // placePayout未取込
    const [breakdown] = computeRaceBreakdown(store);
    const [h1] = breakdown!.horses;
    expect(h1!.payout).toBe(200); // 下限2.0 × 100円
    expect(h1!.payoutSource).toBe("approximate");
    store.close();
  });

  it("着順不明(中止・除外でfinish_positionがNULL)の馬は複勝的中不明・賭け金/払戻0で表示すること", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "t",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveResult("R1", [{ umaban: 1, finishPosition: null }]);
    const [breakdown] = computeRaceBreakdown(store);
    const [h1] = breakdown!.horses;
    expect(h1!.finishPosition).toBeNull();
    expect(h1!.isPlaced).toBeNull();
    expect(h1!.stake).toBe(0);
    expect(h1!.payout).toBe(0);
    expect(h1!.payoutSource).toBeNull();
    store.close();
  });

  it("結果が保存されていないレースは対象外(verifyのexcludedAnalysisCountと同じ母集団)", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "t",
      horses: [horse(1, 0.5, 2.5, 1.25, true)],
    });
    expect(computeRaceBreakdown(store)).toEqual([]);
    store.close();
  });

  it("推定EV(evEstimated=true)の分析は対象外(verifyのexcludedEstimatedCountと同じ母集団)", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "t",
      evEstimated: true,
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
    expect(computeRaceBreakdown(store)).toEqual([]);
    store.close();
  });

  it("既定(latestモード)では同一レースの最新分析のみ対象になること(旧分析は含まない)", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "2026-07-08T09:00:00.000Z",
      horses: [horse(1, 0.5, 2.5, 1.25, true)],
    });
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
    const breakdowns = computeRaceBreakdown(store);
    expect(breakdowns).toHaveLength(1);
    // 最新分析(placeOddsMin=2.0)の方が採用される。
    expect(breakdowns[0]!.horses[0]!.placeOddsMin).toBe(2.0);
    store.close();
  });

  it("includeAllAnalyses=trueでは同一レースの分析ごとに別のブレークダウンを返すこと", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "2026-07-08T09:00:00.000Z",
      horses: [horse(1, 0.5, 2.5, 1.25, true)],
    });
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "2026-07-08T10:00:00.000Z",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
    const breakdowns = computeRaceBreakdown(store, {
      ...DEFAULT_VERIFY_CONFIG,
      includeAllAnalyses: true,
    });
    expect(breakdowns).toHaveLength(2);
    store.close();
  });

  it("開催日(kaisaiDate)・プロンプト版が未保存(旧データ)ならnullで返すこと", () => {
    const store = new AnalysisStore();
    store.saveAnalysis({
      raceId: "R1",
      analyzedAt: "t",
      horses: [horse(1, 0.5, 2.0, 1.0, true)],
    });
    store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
    const [breakdown] = computeRaceBreakdown(store);
    expect(breakdown!.kaisaiDate).toBeNull();
    expect(breakdown!.promptVersion).toBeNull();
    store.close();
  });

  describe("recoveryRateの境界(賭け0点ならnull。docコメントに明記された境界のテーブル駆動確認)", () => {
    it.each([
      {
        title: "全馬EVプラスでない(EVプラス馬が1頭も無くtotalStake=0)",
        horses: [
          horse(1, 0.1, 2.0, 0.2, false),
          horse(2, 0.05, 3.0, 0.15, false),
        ],
        results: [
          { umaban: 1, finishPosition: 1 },
          { umaban: 2, finishPosition: 2 },
        ],
      },
      {
        title: "全馬着順不明(finish_position NULL=中止・除外)のみでtotalStake=0",
        horses: [
          horse(1, 0.5, 2.0, 1.0, true),
          horse(2, 0.4, 2.5, 1.0, true),
        ],
        results: [
          { umaban: 1, finishPosition: null },
          { umaban: 2, finishPosition: null },
        ],
      },
    ])("$title のときrecoveryRateがnullになること", ({ horses, results }) => {
      const store = new AnalysisStore();
      store.saveAnalysis({ raceId: "R1", analyzedAt: "t", horses });
      store.saveResult("R1", results);
      const [breakdown] = computeRaceBreakdown(store);
      expect(breakdown!.totalStake).toBe(0);
      expect(breakdown!.betCount).toBe(0);
      expect(breakdown!.recoveryRate).toBeNull();
      store.close();
    });
  });

  describe("不変条件: レース単位ブレークダウンの合算はcomputeVerifyReportのトータルと厳密一致すること", () => {
    it("通常レース・latest選択で上書きされる旧分析・推定EV除外・結果未取込除外・全馬着順不明が混在しても、totalStake/totalReturn/betCountの合算が一致すること", () => {
      const store = new AnalysisStore();

      // (1) 通常レース: EVプラス2頭(的中1・不的中1、実配当あり)。
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [
          horse(1, 0.5, 2.0, 1.0, true), // 的中 → 実配当計上
          horse(2, 0.4, 2.5, 1.2, true), // 不的中
        ],
      });
      store.saveResult("R1", [
        { umaban: 1, finishPosition: 1, placePayout: 280 },
        { umaban: 2, finishPosition: 6 },
      ]);

      // (2) latest選択で上書きされる旧分析: 同一レースの新旧分析。旧分析は集計対象外。
      store.saveAnalysis({
        raceId: "R2",
        analyzedAt: "2026-07-08T09:00:00.000Z",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      store.saveAnalysis({
        raceId: "R2",
        analyzedAt: "2026-07-08T15:00:00.000Z",
        horses: [horse(1, 0.5, 3.0, 1.5, true)],
      });
      store.saveResult("R2", [{ umaban: 1, finishPosition: 1 }]); // 近似(下限3.0)で払戻

      // (3) 推定EV除外: evEstimated:true は丸ごと除外。
      store.saveAnalysis({
        raceId: "R3",
        analyzedAt: "t",
        evEstimated: true,
        horses: [horse(1, 0.5, 2.8, 1.4, true)],
      });
      store.saveResult("R3", [{ umaban: 1, finishPosition: 1 }]);

      // (4) 結果未取込除外: 結果を保存しない。
      store.saveAnalysis({
        raceId: "R4",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 2.2, 1.1, true)],
      });

      // (5) 全馬着順不明: 賭け金/払戻は0だが集計対象には含まれる。
      store.saveAnalysis({
        raceId: "R5",
        analyzedAt: "t",
        horses: [
          horse(1, 0.5, 2.0, 1.0, true),
          horse(2, 0.4, 2.5, 1.2, true),
        ],
      });
      store.saveResult("R5", [
        { umaban: 1, finishPosition: null },
        { umaban: 2, finishPosition: null },
      ]);

      const breakdowns = computeRaceBreakdown(store);
      const report = computeVerifyReport(store);

      // 母集団の内訳確認(R1・R2(最新のみ)・R5の3レース分。R3は推定EV除外、R4は結果未取込除外)。
      expect(breakdowns).toHaveLength(3);
      expect(report.includedAnalysisCount).toBe(3);
      expect(report.excludedAnalysisCount).toBe(1); // R4
      expect(report.supersededAnalysisCount).toBe(1); // R2の旧分析
      expect(report.excludedEstimatedCount).toBe(1); // R3

      // レース単位の合算が computeVerifyReport のトータルと厳密一致すること(本タスク最重要の不変条件)。
      const summedStake = breakdowns.reduce((sum, b) => sum + b.totalStake, 0);
      const summedReturn = breakdowns.reduce((sum, b) => sum + b.totalReturn, 0);
      const summedBetCount = breakdowns.reduce((sum, b) => sum + b.betCount, 0);
      expect(summedStake).toBe(report.bet.totalStake);
      expect(summedReturn).toBe(report.bet.totalReturn);
      expect(summedBetCount).toBe(report.bet.betCount);

      // 合算値自体が期待どおりであることも確認する(不変条件テストが「両方とも0のまま一致」で
      // 見かけ上パスするのを防ぐため)。
      // R1: 実配当280円(的中) + 不的中0円 = 280円、賭け金200円。
      // R2: 近似払戻(下限3.0×100円=300円)、賭け金100円。
      // R5: 着順不明のため賭け金・払戻とも0円。
      expect(summedStake).toBe(300);
      expect(summedReturn).toBe(580);
      expect(summedBetCount).toBe(3);
      store.close();
    });
  });

  describe("開催区分(venueKind)別集計(Task#32)", () => {
    describe("境界値のテーブル駆動テスト(raceId場コードから中央/地方/未知を判定)", () => {
      const cases: Array<{
        readonly label: string;
        readonly raceId: string;
        /** 期待される開催区分。中央・地方いずれにも属さない場コードは null。 */
        readonly expected: "central" | "nar" | null;
      }> = [
        { label: "場コード01(中央の下限)", raceId: "202601010101", expected: "central" },
        { label: "場コード10(中央の上限)", raceId: "202610010101", expected: "central" },
        { label: "場コード30(地方の下限)", raceId: "202630070101", expected: "nar" },
        { label: "場コード64(地方の上限)", raceId: "202664070101", expected: "nar" },
        {
          label: "場コード20(中央・地方いずれの範囲にも属さない未知コード)",
          raceId: "202620010101",
          expected: null,
        },
        {
          label: "場コード65(帯広・ばんえい。地方範囲直上だが対象外の未知コード)",
          raceId: "202665070101",
          expected: null,
        },
      ];

      it.each(cases)(
        "$label: venueKind=central/nar/all それぞれの集計対象への含まれ方が正しいこと",
        ({ raceId, expected }) => {
          const store = new AnalysisStore();
          store.saveAnalysis({
            raceId,
            analyzedAt: "t",
            horses: [horse(1, 0.5, 2.5, 1.25, true)],
          });
          store.saveResult(raceId, [{ umaban: 1, finishPosition: 1 }]);

          // "all"(既定)は場コードの妥当性に関わらず常に集計対象へ含まれる
          // (raceId のパース失敗で全体集計がクラッシュしないことも兼ねて確認する)。
          expect(computeVerifyReport(store).includedAnalysisCount).toBe(1);

          expect(
            computeVerifyReport(store, DEFAULT_VERIFY_CONFIG, "central")
              .includedAnalysisCount,
          ).toBe(expected === "central" ? 1 : 0);
          expect(
            computeVerifyReport(store, DEFAULT_VERIFY_CONFIG, "nar")
              .includedAnalysisCount,
          ).toBe(expected === "nar" ? 1 : 0);
          store.close();
        },
      );
    });

    it("venueKind省略時は従来どおり全体集計(all相当)であること(後方互換)", () => {
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "202601010101",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      store.saveResult("202601010101", [{ umaban: 1, finishPosition: 1 }]);

      const omitted = computeVerifyReport(store);
      const explicitAll = computeVerifyReport(store, DEFAULT_VERIFY_CONFIG, "all");
      expect(omitted).toEqual(explicitAll);
      store.close();
    });

    it("raceIdが12桁の妥当な形式でない既存データでもvenueKind省略(all)なら従来どおり集計されること", () => {
      // 場コード判定のための raceId パースは venueKind!=='all' のときのみ行うため、
      // 12桁形式でない旧来のテストデータ("R1"等)を使っても all集計は落ちない
      // (既存882件のテストが全て通っていること自体がこの回帰確認の主だが、明示的にも固定する)。
      const store = new AnalysisStore();
      store.saveAnalysis({
        raceId: "R1",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      store.saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);

      const report = computeVerifyReport(store);
      expect(report.includedAnalysisCount).toBe(1);
      expect(report.bet.betCount).toBe(1);
      store.close();
    });

    it("不変条件: 中央のみ+地方のみ=全体(件数・賭け金・払戻の合算が一致すること)", () => {
      const store = new AnalysisStore();

      // 中央のレース×2(1件は的中で実配当あり、1件は不的中)。
      store.saveAnalysis({
        raceId: "202601010101",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 2.5, 1.25, true)],
      });
      store.saveResult("202601010101", [
        { umaban: 1, finishPosition: 1, placePayout: 280 },
      ]);
      store.saveAnalysis({
        raceId: "202605020801",
        analyzedAt: "t",
        horses: [horse(1, 0.4, 2.0, 0.8, true)],
      });
      store.saveResult("202605020801", [{ umaban: 1, finishPosition: 5 }]);

      // 地方のレース×2(近似払戻1件・着順不明1頭を含むレース1件)。
      store.saveAnalysis({
        raceId: "202630070101",
        analyzedAt: "t",
        horses: [horse(1, 0.5, 3.0, 1.5, true)],
      });
      store.saveResult("202630070101", [{ umaban: 1, finishPosition: 2 }]);
      store.saveAnalysis({
        raceId: "202664070201",
        analyzedAt: "t",
        horses: [
          horse(1, 0.5, 2.2, 1.1, true),
          horse(2, 0.3, 1.8, 0.54, false),
        ],
      });
      store.saveResult("202664070201", [
        { umaban: 1, finishPosition: null },
        { umaban: 2, finishPosition: 4 },
      ]);

      const all = computeVerifyReport(store, DEFAULT_VERIFY_CONFIG, "all");
      const central = computeVerifyReport(store, DEFAULT_VERIFY_CONFIG, "central");
      const nar = computeVerifyReport(store, DEFAULT_VERIFY_CONFIG, "nar");

      // 見かけ上0=0で一致してしまう「トリビアルな一致」を防ぐため、絶対値も固定する。
      expect(central.includedAnalysisCount).toBe(2);
      expect(nar.includedAnalysisCount).toBe(2);
      expect(all.includedAnalysisCount).toBe(4);

      expect(central.includedAnalysisCount + nar.includedAnalysisCount).toBe(
        all.includedAnalysisCount,
      );
      expect(central.bet.betCount + nar.bet.betCount).toBe(all.bet.betCount);
      expect(central.bet.totalStake + nar.bet.totalStake).toBe(all.bet.totalStake);
      expect(central.bet.totalReturn + nar.bet.totalReturn).toBe(all.bet.totalReturn);
      expect(all.bet.totalStake).toBeGreaterThan(0);
      expect(all.bet.totalReturn).toBeGreaterThan(0);

      // trend(補正傾向サマリ)も同じ母集団から算出されるため、印別的中率の件数合算も一致すること。
      const sumMarkCount = (report: typeof all) =>
        report.trend.markStats.reduce((sum, s) => sum + s.count, 0);
      expect(sumMarkCount(central) + sumMarkCount(nar)).toBe(sumMarkCount(all));

      store.close();
    });
  });
});
