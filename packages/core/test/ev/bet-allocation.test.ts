import { describe, expect, it } from "vitest";
import {
  allocateBets,
  CONDITIONAL_BERNOULLI_MODEL,
  DEFAULT_BET_ALLOCATION_CONFIG,
  type AllocationHorse,
  type BetAllocationConfig,
  type PlaceJointModel,
  type PlaceOutcome,
} from "../../src/ev/bet-allocation.js";

/** 候補馬(EVプラス・オッズあり)を組み立てる補助関数。 */
function candidate(
  umaban: number,
  placeProb: number,
  placeOddsMin: number,
): AllocationHorse {
  const ev = placeProb * placeOddsMin;
  return { umaban, placeProb, placeOddsMin, ev, isPositive: ev > 1 };
}

/** 非候補馬(EVマイナス)を組み立てる補助関数。 */
function nonCandidate(umaban: number, placeProb: number, placeOddsMin: number | null = null): AllocationHorse {
  const ev = placeOddsMin === null ? null : placeProb * placeOddsMin;
  return { umaban, placeProb, placeOddsMin, ev, isPositive: ev !== null && ev > 1 };
}

/** テスト用の固定分布を返すスタブモデル(独立性を仮定しないことの構造的検証に使う)。 */
function stubModel(distribution: readonly PlaceOutcome[]): PlaceJointModel {
  return {
    id: "stub",
    approximate: false,
    buildDistribution: () => distribution,
  };
}

describe("allocateBets(馬券配分の最適化)", () => {
  describe("Step0: 実効予算とbetUnit丸め", () => {
    it("effectiveBudgetはbudgetをbetUnitの倍数に切り捨てた値になること", () => {
      const horses = [candidate(1, 0.5, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 2550 });
      expect(result.effectiveBudget).toBe(2500);
      expect(result.budgetInput).toBe(2550);
    });
  });

  describe("受け入れ条件1: 配分額はbetUnitの倍数、総額は上限内", () => {
    it("配分額はすべてbetUnitの倍数であること", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), nonCandidate(3, 0.1)];
      const result = allocateBets(horses, 3, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      for (const a of result.allocations) {
        expect(a.stake % DEFAULT_BET_ALLOCATION_CONFIG.betUnit).toBe(0);
      }
    });

    it("totalStake <= kellyFraction * effectiveBudget <= effectiveBudget が無条件に成立すること(λ>1・NaN・負値を含む)", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const configs: BetAllocationConfig[] = [
        { budget: 10000, kellyFraction: 1, betUnit: 100, greedySteps: 1000 },
        { budget: 10000, kellyFraction: 0.5, betUnit: 100, greedySteps: 1000 },
        { budget: 12345, kellyFraction: 0.3, betUnit: 100, greedySteps: 1000 },
        // λ>1(範囲外)・NaN・負値。resolveKellyFractionで既定値へフォールバックされた後の
        // result.kellyFraction(実際に使われた値)で不等式を検証する(config.kellyFractionの
        // 生値ではない。これらが無防御だと予算超過・NaN混入が起きることの回帰テスト)。
        { budget: 10000, kellyFraction: 1.5, betUnit: 100, greedySteps: 1000 },
        { budget: 10000, kellyFraction: Number.NaN, betUnit: 100, greedySteps: 1000 },
        { budget: 10000, kellyFraction: Number.POSITIVE_INFINITY, betUnit: 100, greedySteps: 1000 },
        { budget: 10000, kellyFraction: -0.5, betUnit: 100, greedySteps: 1000 },
      ];
      for (const config of configs) {
        const result = allocateBets(horses, 3, config);
        // 採用された(サニタイズ後の)λは常に[0,1]に収まる。
        expect(result.kellyFraction).toBeGreaterThanOrEqual(0);
        expect(result.kellyFraction).toBeLessThanOrEqual(1);
        expect(Number.isFinite(result.totalStake)).toBe(true);
        expect(result.totalStake).toBeLessThanOrEqual(
          result.kellyFraction * result.effectiveBudget + 1e-9,
        );
        expect(result.kellyFraction * result.effectiveBudget).toBeLessThanOrEqual(
          result.effectiveBudget + 1e-9,
        );
      }
    });
  });

  describe("受け入れ条件2: EVプラス0頭・エッジ不足での見送り", () => {
    it("EVプラス0頭ならisSkip=trueで見送り理由が付くこと", () => {
      const horses = [nonCandidate(1, 0.3, 2), nonCandidate(2, 0.2, 3)];
      const result = allocateBets(horses, 2, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe("EVプラスの馬がいないため見送りです");
      expect(result.totalStake).toBe(0);
    });
  });

  describe("受け入れ条件3・見送りの5分類とその優先順位", () => {
    it("① budget===0(未設定)は「未設定」の理由になること(候補がいても)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 0 });
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe("予算が未設定のため配分を提案していません");
    });

    it("budgetが負値のときも①(未設定扱い)に落ちること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: -100 });
      expect(result.skipReason).toBe("予算が未設定のため配分を提案していません");
    });

    it("budgetがNaNのときも①(未設定扱い)に落ちること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, {
        ...DEFAULT_BET_ALLOCATION_CONFIG,
        budget: Number.NaN,
      });
      expect(result.skipReason).toBe("予算が未設定のため配分を提案していません");
    });

    it("budgetがInfinityのときも①(未設定扱い)に落ちること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, {
        ...DEFAULT_BET_ALLOCATION_CONFIG,
        budget: Number.POSITIVE_INFINITY,
      });
      expect(result.skipReason).toBe("予算が未設定のため配分を提案していません");
    });

    it("② 0<budget<betUnit(100円未満)は「100円未満」の理由になること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 50 });
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe("予算が100円未満のため配分できません");
    });

    it("effectiveBudget<100が常に見送りになること(受け入れ条件3)", () => {
      for (const budget of [1, 50, 99]) {
        const horses = [candidate(1, 0.6, 3)];
        const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget });
        expect(result.isSkip).toBe(true);
        expect(result.effectiveBudget).toBeLessThan(100);
      }
    });

    it("優先順位: budget=50かつEVプラス0頭 → ②(予算不足)が返る(③候補0頭ではない)", () => {
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 50 });
      expect(result.skipReason).toBe("予算が100円未満のため配分できません");
    });

    it("優先順位: budget=0かつEVプラス0頭 → ①(未設定)が返る", () => {
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 0 });
      expect(result.skipReason).toBe("予算が未設定のため配分を提案していません");
    });

    it("③ 候補0頭(予算は十分)は「EVプラスの馬がいない」の理由になること", () => {
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(result.skipReason).toBe("EVプラスの馬がいないため見送りです");
    });

    it("④ 連続最適解が全て0(妙味が極小)は専用理由になること", () => {
      // EVがほぼ1(閾値ちょうど超え程度)の候補で、連続最適比率が実質0になるケースを
      // スタブモデルで作る(オッズがほぼ1に近い低倍率で複勝人数条件が的中確率をほぼ確定させる)。
      const horses: AllocationHorse[] = [
        { umaban: 1, placeProb: 0.5, placeOddsMin: 1.0000001, ev: 1.00000005, isPositive: true },
      ];
      const model = stubModel([
        { placed: [], probability: 0.5 },
        { placed: [1], probability: 0.5 },
      ]);
      const result = allocateBets(
        horses,
        1,
        { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 },
        model,
      );
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe(
        "妙味が小さく、賭ける価値のある配分が見つかりませんでした",
      );
    });

    it("⑤ 連続最適解は正だが100円単位への丸めで全て0になる場合は専用理由になること", () => {
      // 予算100円・betUnit100で、連続最適比率(x*≈0.5・実測)が小さいλで縮小されると
      // 100円未満に丸められて全体が0になるケース(候補馬2頭・対称でEVプラス)。
      const horses = [candidate(1, 0.5, 2.2), candidate(2, 0.5, 2.2)];
      const result = allocateBets(horses, 1, {
        budget: 100,
        kellyFraction: 0.05,
        betUnit: 100,
        greedySteps: 1000,
      });
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe(
        "妙味に対して予算が小さく、100円単位で配分できませんでした",
      );
      // 連続最適解自体は正であること(④ではなく⑤に分類される根拠)。
      expect(result.allocations.some((a) => a.kellyFraction > 0)).toBe(true);
    });
  });

  describe("受け入れ条件4: 予算100円は1点配分または見送り", () => {
    it("予算100円なら1点のみ配分されるか見送りのいずれかであること", () => {
      const horses = [candidate(1, 0.6, 3), candidate(2, 0.5, 2.5)];
      const result = allocateBets(horses, 2, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 100 });
      expect(result.betCount).toBeLessThanOrEqual(1);
      expect(result.totalStake).toBeLessThanOrEqual(100);
    });

    it("budget=100はeffectiveBudget=100(betUnit以上)であり②(予算不足)ではなく⑤(丸めでゼロ)になること", () => {
      // boss訂正②の境界確認: budget===betUnit(100)は「0<effectiveBudget<betUnit」に該当しない。
      // 候補が1頭のみで妙味が小さい設定のため見送りにはなり(isSkipを無条件にassertする)、
      // その理由は②ではなく⑤(丸めで全て0)であることを積極的に確認する(否定形assertは弱いため
      // 使わない。isSkip===falseに将来変わってもテストが素通りしないよう、isSkipも必ず検証する)。
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, {
        budget: 100,
        kellyFraction: 0.5,
        betUnit: 100,
        greedySteps: 1000,
      });
      expect(result.effectiveBudget).toBe(100);
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe(
        "妙味に対して予算が小さく、100円単位で配分できませんでした",
      );
    });

    it("budget=101/150はいずれもeffectiveBudget=100に切り捨てられ、②ではなく⑤になること", () => {
      const horses = [candidate(1, 0.6, 3)];
      for (const budget of [101, 150]) {
        const result = allocateBets(horses, 1, {
          budget,
          kellyFraction: 0.5,
          betUnit: 100,
          greedySteps: 1000,
        });
        expect(result.effectiveBudget).toBe(100);
        expect(result.isSkip).toBe(true);
        expect(result.skipReason).toBe(
          "妙味に対して予算が小さく、100円単位で配分できませんでした",
        );
      }
    });
  });

  describe("頭数の境界(統合レベル。クラッシュしないこと)", () => {
    it("N=0(出走馬なし)でもクラッシュせず、候補0頭の見送りになること", () => {
      const result = allocateBets([], 3, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(result.allocations).toEqual([]);
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe("EVプラスの馬がいないため見送りです");
      expect(result.diagnostics.candidateCount).toBe(0);
      expect(result.diagnostics.placeProbSum).toBe(0);
    });

    it("N=4(複勝人数3に対して頭数が少ない境界)でもクラッシュせず正しく配分されること", () => {
      const horses = [
        candidate(1, 0.5, 2.5),
        candidate(2, 0.4, 2.5),
        candidate(3, 0.3, 2.2),
        candidate(4, 0.2, 2.2),
      ];
      const result = allocateBets(horses, 3, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(result.allocations).toHaveLength(4);
      expect(result.allocations.map((a) => a.umaban)).toEqual([1, 2, 3, 4]);
      for (const a of result.allocations) {
        expect(a.stake % DEFAULT_BET_ALLOCATION_CONFIG.betUnit).toBe(0);
      }
    });
  });

  describe("受け入れ条件5: 予算スケール不変性(継続的最適比率は予算に依存しない・厳密一致)", () => {
    it("予算を1,000/10,000/100,000と変えてもkellyFraction(連続最適比率)は完全一致すること", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const budgets = [1000, 10000, 100000];
      const results = budgets.map((budget) =>
        allocateBets(horses, 3, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget }),
      );
      for (let i = 1; i < results.length; i++) {
        for (let j = 0; j < results[0]!.allocations.length; j++) {
          expect(results[i]!.allocations[j]!.kellyFraction).toBe(
            results[0]!.allocations[j]!.kellyFraction,
          );
        }
      }
    });
  });

  describe("受け入れ条件6: bet-allocationは独立性を一切仮定しない(構造的検証)", () => {
    it("スタブモデルで強い相関(片方が当たれば必ずもう片方も当たる)を与えると、独立仮定の結果とは異なる最適化になること", () => {
      const horses = [candidate(1, 0.4, 3), candidate(2, 0.4, 3)];
      // 完全相関: 両方当たるか、両方外れるかのいずれか(独立なら有り得ない同時分布)。
      const perfectlyCorrelated = stubModel([
        { placed: [], probability: 0.6 },
        { placed: [1, 2], probability: 0.4 },
      ]);
      // 完全排反: 片方が当たれば必ずもう片方は外れる。
      const mutuallyExclusive = stubModel([
        { placed: [], probability: 0.2 },
        { placed: [1], probability: 0.4 },
        { placed: [2], probability: 0.4 },
      ]);
      const correlatedResult = allocateBets(
        horses,
        2,
        { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 },
        perfectlyCorrelated,
      );
      const exclusiveResult = allocateBets(
        horses,
        2,
        { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 },
        mutuallyExclusive,
      );
      // 同一の周辺確率(0.4)・同一オッズでも、同時分布が異なれば連続最適比率も異なるはず
      // (独立性を仮定していれば、同時分布モデルを無視して同じ結果になってしまう)。
      expect(correlatedResult.allocations[0]!.kellyFraction).not.toBeCloseTo(
        exclusiveResult.allocations[0]!.kellyFraction,
        6,
      );
    });
  });

  describe("受け入れ条件7: 入力のplaceProbを書き換えないこと", () => {
    it("AllocationHorseのplaceProbが変更されず、結果にそのまま反映されること", () => {
      const horses = [candidate(1, 0.55, 2.5), candidate(2, 0.35, 3)];
      const original = horses.map((h) => ({ ...h }));
      allocateBets(horses, 2, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(horses).toEqual(original);
    });

    it("結果のHorseAllocation.placeProbが入力と一致すること", () => {
      const horses = [candidate(1, 0.55, 2.5), candidate(2, 0.35, 3)];
      const result = allocateBets(horses, 2, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(result.allocations.find((a) => a.umaban === 1)!.placeProb).toBe(0.55);
      expect(result.allocations.find((a) => a.umaban === 2)!.placeProb).toBe(0.35);
    });
  });

  describe("受け入れ条件8: placeCountを引数で受け、3をハードコードしないこと", () => {
    it("placeCountを2にすると、複勝人数3のときと異なる同時分布(=異なる最適配分)になること", () => {
      const horses = [candidate(1, 0.5, 2.5), candidate(2, 0.5, 2.5), candidate(3, 0.5, 2.5)];
      const resultK2 = allocateBets(horses, 2, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      const resultK3 = allocateBets(horses, 3, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(resultK2.allocations[0]!.kellyFraction).not.toBeCloseTo(
        resultK3.allocations[0]!.kellyFraction,
        6,
      );
    });
  });

  describe("受け入れ条件9: 候補外の馬も欠落させないこと", () => {
    it("isPositive=false(オッズはあるがEVマイナス)の馬は「EVがプラスではない」の理由になること", () => {
      const horses = [candidate(1, 0.6, 3), nonCandidate(2, 0.1, 2)];
      const result = allocateBets(horses, 2, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      const excluded = result.allocations.find((a) => a.umaban === 2)!;
      expect(excluded.stake).toBe(0);
      // オッズはある(2)がEVマイナス(0.1×2=0.2)。「未判定(オッズ未確定)」ではなく
      // 「判定した結果マイナス」であることを文言で厳密に確認する(重大バグの再発防止)。
      expect(excluded.excludedReason).toBe("EVがプラスではないため対象外");
    });

    it("placeOddsMin=null(オッズ未確定)の馬は「オッズ未確定」の理由になること(EVマイナスと誤表示しない)", () => {
      const horses: AllocationHorse[] = [
        candidate(1, 0.6, 3),
        { umaban: 2, placeProb: 0.5, placeOddsMin: null, ev: null, isPositive: false },
      ];
      const result = allocateBets(horses, 2, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      const excluded = result.allocations.find((a) => a.umaban === 2)!;
      expect(excluded.stake).toBe(0);
      // placeOddsMin===null の馬は isPositive===false にもなるが、これは「判定未了(オッズが
      // まだ確定していない)」であり「EVがプラスではない(判定した結果マイナス)」ではない。
      // 優先判定を誤ると「EVがプラスではないため対象外」に誤ラベルされる(重大バグの再発防止)。
      expect(excluded.excludedReason).toBe("複勝オッズ下限が未確定のため対象外");
    });

    it("候補馬のexcludedReasonはnullであること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(result.allocations[0]!.excludedReason).toBeNull();
    });

    it("全出走馬が馬番昇順で結果に含まれること", () => {
      const horses = [candidate(3, 0.6, 3), nonCandidate(1, 0.1), candidate(2, 0.5, 2.5)];
      const result = allocateBets(horses, 3, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(result.allocations.map((a) => a.umaban)).toEqual([1, 2, 3]);
    });
  });

  describe("受け入れ条件10: modelId/modelApproximateが結果に載ること", () => {
    it("既定モデル(条件付きベルヌーイ)のid/approximateが反映されること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(result.modelId).toBe(CONDITIONAL_BERNOULLI_MODEL.id);
      expect(result.modelApproximate).toBe(true);
    });

    it("差し替えたモデルのid/approximateが反映されること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const model: PlaceJointModel = {
        id: "exact-future-model",
        approximate: false,
        buildDistribution: () => [
          { placed: [], probability: 0.4 },
          { placed: [1], probability: 0.6 },
        ],
      };
      const result = allocateBets(
        horses,
        1,
        { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 },
        model,
      );
      expect(result.modelId).toBe("exact-future-model");
      expect(result.modelApproximate).toBe(false);
    });
  });

  describe("受け入れ条件11: 診断値3種(実質5フィールド)が結果に載ること", () => {
    it("diagnosticsの各フィールドが算出されること", () => {
      const horses = [candidate(1, 0.6, 3), candidate(2, 0.3, 4), nonCandidate(3, 0.1)];
      const result = allocateBets(horses, 3, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(result.diagnostics.placeProbSum).toBeCloseTo(1.0, 10);
      expect(result.diagnostics.placeProbSumTarget).toBe(3);
      expect(result.diagnostics.placeProbSumDeviation).toBeCloseTo(1.0 - 3, 10);
      expect(result.diagnostics.marginalDeviationMax).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.candidateCount).toBe(2);
      expect(result.diagnostics.excludedCount).toBe(1);
    });

    it("placeProbSumDeviationは符号付き(合計が目標を上回るとき正)であること", () => {
      const horses = [candidate(1, 0.9, 3), candidate(2, 0.9, 2.5), candidate(3, 0.9, 2.2)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      // 合計2.7、目標(placeCount)1 → 正の乖離。
      expect(result.diagnostics.placeProbSumDeviation).toBeGreaterThan(0);
    });

    it("見送り(isSkip)のときも診断値が算出されること(Step0/1の早期リターンでも省略しない)", () => {
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 0 });
      expect(result.isSkip).toBe(true);
      expect(result.diagnostics.placeProbSum).toBeCloseTo(0.3, 10);
      expect(result.diagnostics.candidateCount).toBe(0);
      expect(result.diagnostics.excludedCount).toBe(1);
    });

    it("見送り(budget不足)のときもkellyFraction(連続最適比率)が算出されること(Step4は早期リターンで省略しない)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 50 });
      expect(result.isSkip).toBe(true);
      expect(result.allocations[0]!.kellyFraction).toBeGreaterThan(0);
    });
  });

  describe("受け入れ条件12: exportsの2サブパス(package.json)", () => {
    it("bet-allocation.tsからplace-joint-model.tsの主要な型・既定モデルがre-exportされていること", () => {
      expect(CONDITIONAL_BERNOULLI_MODEL).toBeDefined();
      expect(CONDITIONAL_BERNOULLI_MODEL.id).toBe("conditional-bernoulli");
    });
  });

  describe("λ(ケリー係数)の効果", () => {
    it("λ=1とλ=0.5でstakeが概ね半分になること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const resultFull = allocateBets(horses, 1, {
        budget: 100000,
        kellyFraction: 1,
        betUnit: 100,
        greedySteps: 1000,
      });
      const resultHalf = allocateBets(horses, 1, {
        budget: 100000,
        kellyFraction: 0.5,
        betUnit: 100,
        greedySteps: 1000,
      });
      const ratio = resultHalf.totalStake / resultFull.totalStake;
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.6);
    });

    it("λ=0で全額0円になること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, {
        budget: 100000,
        kellyFraction: 0,
        betUnit: 100,
        greedySteps: 1000,
      });
      expect(result.totalStake).toBe(0);
      expect(result.isSkip).toBe(true);
    });
  });

  describe("λ(ケリー係数)の防御(重大バグの回帰テスト: budgetと同じ内部一貫性で防御する)", () => {
    const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];

    it("λ=1.5(範囲外)は既定値0.5へフォールボックされ、予算超過が起きないこと", () => {
      const result = allocateBets(horses, 3, {
        budget: 10000,
        kellyFraction: 1.5,
        betUnit: 100,
        greedySteps: 1000,
      });
      expect(result.kellyFraction).toBe(DEFAULT_BET_ALLOCATION_CONFIG.kellyFraction);
      expect(result.totalStake).toBeLessThanOrEqual(result.effectiveBudget);
    });

    it("λ=NaNは既定値0.5へフォールバックされ、stakeにNaNが混入しないこと", () => {
      const result = allocateBets(horses, 3, {
        budget: 10000,
        kellyFraction: Number.NaN,
        betUnit: 100,
        greedySteps: 1000,
      });
      expect(result.kellyFraction).toBe(DEFAULT_BET_ALLOCATION_CONFIG.kellyFraction);
      expect(Number.isNaN(result.totalStake)).toBe(false);
      for (const a of result.allocations) {
        expect(Number.isNaN(a.stake)).toBe(false);
      }
    });

    it("λ=Infinityは既定値0.5へフォールバックされること", () => {
      const result = allocateBets(horses, 3, {
        budget: 10000,
        kellyFraction: Number.POSITIVE_INFINITY,
        betUnit: 100,
        greedySteps: 1000,
      });
      expect(result.kellyFraction).toBe(DEFAULT_BET_ALLOCATION_CONFIG.kellyFraction);
      expect(Number.isFinite(result.totalStake)).toBe(true);
    });

    it("λ=-0.5(負値)は既定値0.5へフォールバックされ、誤った見送り理由にならないこと", () => {
      const resultNegative = allocateBets(horses, 3, {
        budget: 10000,
        kellyFraction: -0.5,
        betUnit: 100,
        greedySteps: 1000,
      });
      const resultDefault = allocateBets(horses, 3, {
        budget: 10000,
        kellyFraction: DEFAULT_BET_ALLOCATION_CONFIG.kellyFraction,
        betUnit: 100,
        greedySteps: 1000,
      });
      expect(resultNegative.kellyFraction).toBe(DEFAULT_BET_ALLOCATION_CONFIG.kellyFraction);
      // 既定値λで計算した結果と完全に一致する(フォールバックが実際に効いていることの確認)。
      expect(resultNegative.totalStake).toBe(resultDefault.totalStake);
      expect(resultNegative.isSkip).toBe(resultDefault.isSkip);
      expect(resultNegative.skipReason).toBe(resultDefault.skipReason);
    });
  });

  describe("droppedBelowMinimum", () => {
    it("連続最適比率は正だが丸めで0になった馬はdroppedBelowMinimum=trueになること", () => {
      const horses = [candidate(1, 0.5, 2.2), candidate(2, 0.5, 2.2)];
      const result = allocateBets(horses, 1, {
        budget: 100,
        kellyFraction: 0.05,
        betUnit: 100,
        greedySteps: 1000,
      });
      // 前提(連続最適比率が正であること)を無条件に確認してから検証する(観察4対応)。
      const positiveCandidates = result.allocations.filter((a) => a.kellyFraction > 0);
      expect(positiveCandidates.length).toBeGreaterThanOrEqual(1);
      for (const a of positiveCandidates) {
        expect(a.droppedBelowMinimum).toBe(true);
        expect(a.stake).toBe(0);
      }
    });

    it("配分された馬はdroppedBelowMinimum=falseであること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      const a = result.allocations[0]!;
      // 前提(実際に配分されたこと)を無条件に確認してから検証する(観察4対応)。
      expect(a.stake).toBeGreaterThan(0);
      expect(a.droppedBelowMinimum).toBe(false);
    });

    it("budget=0(予算未設定)では丸め判定に到達しておらず、droppedBelowMinimumが常にfalseであること(要修正3)", () => {
      // 予算未設定はskipReason①「予算が未設定」が正しく説明する状態であり、馬単位の
      // droppedBelowMinimumが「丸めで落とされた」と矛盾した説明をしてはならない。
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 0 });
      expect(result.skipReason).toBe("予算が未設定のため配分を提案していません");
      for (const a of result.allocations) {
        expect(a.droppedBelowMinimum).toBe(false);
      }
    });

    it("budget<betUnit(予算不足)でも丸め判定に到達しておらず、droppedBelowMinimumが常にfalseであること(要修正3)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 50 });
      expect(result.skipReason).toBe("予算が100円未満のため配分できません");
      for (const a of result.allocations) {
        expect(a.droppedBelowMinimum).toBe(false);
      }
    });
  });

  describe("notDiversified(訂正①: betCount===1のときのみtrueになりうる)", () => {
    it("1点配分かつ他に正の連続最適比率を持つ候補が2頭以上ならtrueになること", () => {
      const horses = [candidate(1, 0.7, 3), candidate(2, 0.4, 3), candidate(3, 0.35, 3)];
      // 予算を絞り、最も妙味の大きい1頭にしか100円単位の配分が届かない状況を作る
      // (実測: betCount===1になることを確認済み)。
      const result = allocateBets(horses, 3, { budget: 300, kellyFraction: 0.5, betUnit: 100, greedySteps: 1000 });
      expect(result.betCount).toBe(1);
      const positiveCount = result.allocations.filter((a) => a.kellyFraction > 0).length;
      expect(positiveCount).toBeGreaterThanOrEqual(2);
      expect(result.notDiversified).toBe(true);
    });

    it("2点以上配分されるときはnotDiversified=falseであること", () => {
      // 非退化(placeCount < 頭数)かつ非対称オッズの入力を使う。頭数=複勝人数(k>=n)だと
      // 「全頭が必ず複勝圏内」という無リスクな退化に陥り、全outcomeで増分が完全同値になって
      // 貪欲が厳密不等号(increment > bestIncrement)により先頭候補だけに1000ステップ全てを
      // 集中させてしまう(betCount=1に縮退する。重大2の回帰テスト)。
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.5, 2.2), candidate(3, 0.1, 5)];
      const result = allocateBets(horses, 2, {
        budget: 100000,
        kellyFraction: 1,
        betUnit: 100,
        greedySteps: 1000,
      });
      // 前提(実際に2点以上配分されること)を無条件に確認してから検証する。
      expect(result.betCount).toBeGreaterThanOrEqual(2);
      expect(result.notDiversified).toBe(false);
    });

    it("見送り(betCount=0)のときはnotDiversified=falseであること(訂正①)", () => {
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 0 });
      expect(result.betCount).toBe(0);
      expect(result.notDiversified).toBe(false);
    });

    it("1点配分だが他に正の候補がいない(分散しようがない)場合はfalseであること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000 });
      expect(result.betCount).toBe(1);
      expect(result.notDiversified).toBe(false);
    });
  });

  describe("剰余の再配分を行わないこと", () => {
    it("betUnit単位で切り捨てた剰余が他の候補に補填されないこと(合計が必ず切り捨て後の値以下)", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const result = allocateBets(horses, 3, { ...DEFAULT_BET_ALLOCATION_CONFIG, budget: 10000, kellyFraction: 1 });
      const expectedStakeSum = result.allocations.reduce((acc, a) => acc + a.stake, 0);
      expect(result.totalStake).toBe(expectedStakeSum);
      // 各馬の切り捨て前(連続配分×実効予算)との差はbetUnit未満のはず(切り上げ補填していない証拠)。
      for (const a of result.allocations) {
        const continuous = a.kellyFraction * result.kellyFraction * result.effectiveBudget;
        expect(continuous - a.stake).toBeLessThan(DEFAULT_BET_ALLOCATION_CONFIG.betUnit);
        expect(continuous - a.stake).toBeGreaterThanOrEqual(-1e-6);
      }
    });
  });

  describe("1頭のみのときのケリー解析解との一致(λ=1・丸め前)", () => {
    it("2頭中1頭のみ候補・対称な同時分布のとき、連続最適比率が(EV-1)/(o-1)に一致すること", () => {
      // umaban1が候補(placeProb0.5・oddsMin3・EV1.5)、umaban2は非候補で確率0.5(対称)。
      // 2頭・placeCount1の条件付きベルヌーイでは対称性によりP(候補が複勝)=0.5となり、
      // 二値ケリー(勝ち確率0.5・倍率3)の解析解と厳密一致する。
      const horses: AllocationHorse[] = [
        candidate(1, 0.5, 3),
        nonCandidate(2, 0.5, null),
      ];
      const result = allocateBets(horses, 1, {
        budget: 10000,
        kellyFraction: 1,
        betUnit: 100,
        greedySteps: 10000,
      });
      const analytic = (1.5 - 1) / (3 - 1); // (EV-1)/(o-1) = 0.25
      const actual = result.allocations.find((a) => a.umaban === 1)!.kellyFraction;
      expect(actual).toBeCloseTo(analytic, 2);
    });
  });

  describe("貪欲配分と全探索の突き合わせ(2頭・少数単位)", () => {
    it("目的関数値の差が小さい上界に収まること", () => {
      const candidates = [candidate(1, 0.4, 3), candidate(2, 0.35, 3.2)];
      const model = CONDITIONAL_BERNOULLI_MODEL;
      const placeCount = 1;
      const steps = 20; // 全探索が可能な粗い粒度でテストする
      const delta = 1 / steps;

      const result = allocateBets(
        candidates,
        placeCount,
        { budget: 10000, kellyFraction: 1, betUnit: 1, greedySteps: steps },
        model,
      );

      // テスト側で同じ粒度の目的関数を再現し、全探索で最良値を求める。
      const jointHorses = candidates.map((h) => ({ umaban: h.umaban, placeProb: h.placeProb }));
      const distribution = model.buildDistribution(jointHorses, placeCount);
      const odds = [candidates[0]!.placeOddsMin!, candidates[1]!.placeOddsMin!];

      function objective(x1: number, x2: number): number | null {
        let total = 0;
        for (const outcome of distribution) {
          const has1 = outcome.placed.includes(1);
          const has2 = outcome.placed.includes(2);
          const wealth = 1 - x1 - x2 + (has1 ? x1 * odds[0]! : 0) + (has2 ? x2 * odds[1]! : 0);
          if (wealth <= 0) {
            return null;
          }
          total += outcome.probability * Math.log(wealth);
        }
        return total;
      }

      let bestF = -Infinity;
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps - i; j++) {
          const f = objective(i * delta, j * delta);
          if (f !== null && f > bestF) {
            bestF = f;
          }
        }
      }

      const greedyX1 = result.allocations.find((a) => a.umaban === 1)!.kellyFraction;
      const greedyX2 = result.allocations.find((a) => a.umaban === 2)!.kellyFraction;
      const greedyF = objective(greedyX1, greedyX2);
      expect(greedyF).not.toBeNull();
      // 貪欲配分は大域最適の保証がないため、目的関数値の差を上界(粒度に起因する誤差程度)で固定する。
      expect(bestF - greedyF!).toBeLessThan(0.01);
    });
  });
});
