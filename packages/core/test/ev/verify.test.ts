import { describe, expect, it } from "vitest";
import { AnalysisStore, type AnalysisHorseRecord } from "../../src/ev/analysis-store.js";
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
});
