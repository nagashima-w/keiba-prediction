import { describe, expect, it } from "vitest";
import {
  allocateBets,
  CONDITIONAL_BERNOULLI_MODEL,
  DEFAULT_BET_ALLOCATION_CONFIG,
  resolveEffectivePerRaceCap,
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

/** 素の設定を組み立てる補助関数(DEFAULT_BET_ALLOCATION_CONFIGへの一部上書き)。 */
function config(overrides: Partial<BetAllocationConfig>): BetAllocationConfig {
  return { ...DEFAULT_BET_ALLOCATION_CONFIG, ...overrides };
}

describe("allocateBets(馬券配分の最適化・機能C-2契約)", () => {
  describe("Step0: resolvedBankroll/effectivePerRaceCapの解決", () => {
    it("effectivePerRaceCapはperRaceCapをbetUnitの倍数に切り捨てた値になること", () => {
      const horses = [candidate(1, 0.5, 3)];
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 100000, perRaceCap: 2550 }),
      );
      expect(result.effectivePerRaceCap).toBe(2500);
      expect(result.perRaceCapInput).toBe(2550);
    });

    it("resolvedBankrollは正の有限bankrollをそのまま(切り捨てない)採用すること", () => {
      const horses = [candidate(1, 0.5, 3)];
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 12345, perRaceCap: 100000 }),
      );
      expect(result.resolvedBankroll).toBe(12345);
      expect(result.bankrollInput).toBe(12345);
    });
  });

  describe("resolveEffectivePerRaceCap(公開関数・SettingsViewのライブプレビューと共有)", () => {
    it("正の値はbetUnitの倍数に切り捨てる", () => {
      expect(resolveEffectivePerRaceCap(2550, 100)).toBe(2500);
      expect(resolveEffectivePerRaceCap(150.7, 100)).toBe(100);
      expect(resolveEffectivePerRaceCap(100, 100)).toBe(100);
    });

    it("負値・0・非有限は0(floor(-50/100)*100=-100のような負のcapを作らない)", () => {
      expect(resolveEffectivePerRaceCap(-50, 100)).toBe(0);
      expect(resolveEffectivePerRaceCap(0, 100)).toBe(0);
      expect(resolveEffectivePerRaceCap(Number.NaN, 100)).toBe(0);
      expect(resolveEffectivePerRaceCap(Number.NEGATIVE_INFINITY, 100)).toBe(0);
      expect(resolveEffectivePerRaceCap(Number.POSITIVE_INFINITY, 100)).toBe(0);
    });

    it("betUnitが異常値でも既定100へ内部フォールバックし、Infinity/NaNを生まないこと", () => {
      expect(resolveEffectivePerRaceCap(2550, 0)).toBe(2500);
      expect(resolveEffectivePerRaceCap(2550, Number.NaN)).toBe(2500);
      expect(resolveEffectivePerRaceCap(2550, -100)).toBe(2500);
    });

    it("allocateBets内部もこの関数と同じ結果になること(コピー実装が無いことの間接確認)", () => {
      const horses = [candidate(1, 0.5, 3)];
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 100000, perRaceCap: 2599 }),
      );
      expect(result.effectivePerRaceCap).toBe(resolveEffectivePerRaceCap(2599, 100));
    });
  });

  describe("受け入れ条件1(無条件): totalStake <= effectivePerRaceCap", () => {
    it("配分額はすべてbetUnitの倍数であること", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), nonCandidate(3, 0.1)];
      const result = allocateBets(horses, 3, config({ bankroll: 1000000, perRaceCap: 10000 }));
      for (const a of result.allocations) {
        expect(a.stake % DEFAULT_BET_ALLOCATION_CONFIG.betUnit).toBe(0);
      }
    });

    it("totalStake <= effectivePerRaceCap が無条件に成立すること(λ>1・NaN・負値・betUnit異常値・cap極小を含む)", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const configs: BetAllocationConfig[] = [
        { bankroll: 1000000, perRaceCap: 10000, kellyFraction: 1, betUnit: 100, greedySteps: 1000 },
        { bankroll: 1000000, perRaceCap: 10000, kellyFraction: 0.5, betUnit: 100, greedySteps: 1000 },
        { bankroll: 1000000, perRaceCap: 12345, kellyFraction: 0.3, betUnit: 100, greedySteps: 1000 },
        // λ>1(範囲外)・NaN・負値。resolveKellyFractionで既定値へフォールバックされた後の
        // result.kellyFraction(実際に使われた値)を使う点はC-1と同じ流儀。
        { bankroll: 1000000, perRaceCap: 10000, kellyFraction: 1.5, betUnit: 100, greedySteps: 1000 },
        { bankroll: 1000000, perRaceCap: 10000, kellyFraction: Number.NaN, betUnit: 100, greedySteps: 1000 },
        { bankroll: 1000000, perRaceCap: 10000, kellyFraction: Number.POSITIVE_INFINITY, betUnit: 100, greedySteps: 1000 },
        { bankroll: 1000000, perRaceCap: 10000, kellyFraction: -0.5, betUnit: 100, greedySteps: 1000 },
        // betUnitの異常値。
        { bankroll: 1000000, perRaceCap: 10000, kellyFraction: 0.5, betUnit: 0, greedySteps: 1000 },
        { bankroll: 1000000, perRaceCap: 10000, kellyFraction: 0.5, betUnit: Number.NaN, greedySteps: 1000 },
        { bankroll: 1000000, perRaceCap: 10000, kellyFraction: 0.5, betUnit: Number.POSITIVE_INFINITY, greedySteps: 1000 },
        { bankroll: 1000000, perRaceCap: 10000, kellyFraction: 0.5, betUnit: -100, greedySteps: 1000 },
        // capが極小(キャップが強く効く境界)。
        { bankroll: 1000000, perRaceCap: 100, kellyFraction: 1, betUnit: 100, greedySteps: 1000 },
      ];
      for (const c of configs) {
        const result = allocateBets(horses, 3, c);
        expect(Number.isFinite(result.effectivePerRaceCap)).toBe(true);
        expect(Number.isFinite(result.totalStake)).toBe(true);
        expect(result.kellyFraction).toBeGreaterThanOrEqual(0);
        expect(result.kellyFraction).toBeLessThanOrEqual(1);
        // 無条件不変条件: totalStakeは常にeffectivePerRaceCap以下(cap非拘束・拘束いずれでも)。
        expect(result.totalStake).toBeLessThanOrEqual(result.effectivePerRaceCap);
      }
    });
  });

  describe("受け入れ条件2(条件付き): exceedsKellyTarget===falseのときのみ totalStake <= kellyTargetStake", () => {
    it("cap非拘束・最低額非適用の通常配分では exceedsKellyTarget===false かつ totalStake <= kellyTargetStake", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const result = allocateBets(horses, 3, config({ bankroll: 1000000, perRaceCap: 1000000, kellyFraction: 0.5 }));
      expect(result.exceedsKellyTarget).toBe(false);
      expect(result.totalStake).toBeLessThanOrEqual(result.kellyTargetStake + 1e-9);
    });

    it("最低額適用でexceedsKellyTarget===trueになったケースは、この条件付き不変条件の対象外である(受け入れ条件2はexceedsKellyTarget===falseの場合のみを主張する)", () => {
      // 単一候補・kellyTargetStakeが100円未満になる設定(後続の最低額4ケース(a)と同型)。
      const horses = [candidate(1, 0.5, 2.2)];
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 100, perRaceCap: 100000, kellyFraction: 0.5 }),
      );
      // 前提: このケースでは実際にexceedsKellyTarget===trueになる(でなければ本テストの意義がない)。
      expect(result.exceedsKellyTarget).toBe(true);
      // 条件付き不変条件はexceedsKellyTarget===falseのときのみ主張するものであり、
      // trueのケースでtotalStake<=kellyTargetStakeを要求しない(むしろ超過するのが正しい)。
      expect(result.totalStake).toBeGreaterThan(result.kellyTargetStake);
    });
  });

  describe("受け入れ条件3(構造的): exceedsKellyTarget===true ⟹ minimumStakeApplied===true(逆は成り立たない)", () => {
    it("exceedsKellyTarget===trueのケースは必ずminimumStakeApplied===trueであること", () => {
      const horses = [candidate(1, 0.5, 2.2)];
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 100, perRaceCap: 100000, kellyFraction: 0.5 }),
      );
      expect(result.exceedsKellyTarget).toBe(true);
      expect(result.minimumStakeApplied).toBe(true);
    });

    it("逆は成り立たない: minimumStakeApplied===trueだがexceedsKellyTarget===falseのケースが存在すること", () => {
      // ケース(b)相当: 2頭対称でkellyTargetStakeが150(100円未満に丸められるが150>100)。
      const horses = [candidate(1, 0.5, 2.5), candidate(2, 0.5, 2.5)];
      // bankroll/kellyFractionを調整してkellyTargetStake≈150程度になるよう作る(実測で微調整)。
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 300, perRaceCap: 100000, kellyFraction: 0.5 }),
      );
      expect(result.minimumStakeApplied).toBe(true);
      expect(result.exceedsKellyTarget).toBe(false);
    });
  });

  describe("受け入れ条件4: λΣx*bankroll=0のゼロ除算ガード(NaN/Infinityが一切生じないこと)", () => {
    it("bankroll=0(kellyTargetStake=0)でNaN/Infinityが生じず、①へ分類されること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, config({ bankroll: 0, perRaceCap: 10000 }));
      expect(Number.isFinite(result.kellyTargetStake)).toBe(true);
      expect(Number.isNaN(result.totalStake)).toBe(false);
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe("総資金が未設定のため配分を提案していません");
      expect(result.exceedsKellyTarget).toBe(false);
      expect(result.advisory).toBeNull();
    });

    it("候補0頭(Σx*=0)でkellyTargetStake=0となりNaN/Infinityが生じないこと", () => {
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(result.kellyTargetStake).toBe(0);
      expect(Number.isFinite(result.plannedStake)).toBe(true);
      expect(result.capApplied).toBe(false);
      expect(Number.isNaN(result.totalStake)).toBe(false);
    });

    it("kellyFraction=0(λ=0)でkellyTargetStake=0となりNaN/Infinityが生じないこと", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000, kellyFraction: 0 }));
      expect(result.kellyTargetStake).toBe(0);
      expect(result.totalStake).toBe(0);
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe("ケリー係数が0のため配分しません");
    });
  });

  describe("受け入れ条件5: キャップ非拘束時はC-1と同一配分(perRaceCapを十分大きくした回帰)", () => {
    it("perRaceCapを極端に大きくすると、cap無しのC-1と同じ配分ロジック(丸めのみ)になること", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const result = allocateBets(
        horses,
        3,
        config({ bankroll: 10000, perRaceCap: 100000000, kellyFraction: 1 }),
      );
      // capが十分大きいためcapApplied===false(非拘束)。
      expect(result.capApplied).toBe(false);
      // 非拘束時は各馬の stake が「λ×x*_i×resolvedBankroll をbetUnitで切り捨て」に一致する
      // (C-1の rawStake = floor(scaledFraction * effectiveBudget / betUnit) * betUnit と同型)。
      for (const a of result.allocations.filter((x) => x.excludedReason === null)) {
        const expected =
          Math.floor((a.scaledFraction * result.resolvedBankroll) / DEFAULT_BET_ALLOCATION_CONFIG.betUnit) *
          DEFAULT_BET_ALLOCATION_CONFIG.betUnit;
        expect(a.stake).toBe(expected < DEFAULT_BET_ALLOCATION_CONFIG.betUnit ? 0 : expected);
      }
    });
  });

  describe("受け入れ条件6: キャップ拘束時は比例縮小(各馬のstake比がx*比と一致)", () => {
    it("複数頭(3頭・placeCount2)でcapを絞ると、2頭以上の正のcontinuousFraction比を保ったまま比例縮小されること", () => {
      // 2頭構成(candidate(4,0.3,4)/candidate(7,0.15,8)・placeCount3)は退化解に陥り、
      // horse4のcontinuousFractionが常に0(全額horse7に集中)になってしまい、複数馬間の
      // 比率保持を検証できていなかった(code-reviewer指摘)。placeCount=2・3頭構成に差し替え、
      // 2頭以上が正のcontinuousFractionを持つことを無条件expectで先に固定してから比率を比較する。
      // perRaceCap=800はtsx実測で校正した値(2頭ともbetUnit切り捨て後も正のstakeを維持する)。
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.5, 2.2), candidate(3, 0.1, 5)];
      const wide = allocateBets(
        horses,
        2,
        config({ bankroll: 1000000, perRaceCap: 10000000, kellyFraction: 1 }),
      );
      const narrow = allocateBets(
        horses,
        2,
        config({ bankroll: 1000000, perRaceCap: 800, kellyFraction: 1 }),
      );

      // 前提(無条件expect): 2頭以上が正のcontinuousFractionを持つこと。
      // これが成立しないと、以降の「比率保持」の検証自体が意味をなさない。
      const positiveFractionCount = wide.allocations.filter(
        (a) => a.continuousFraction > 0,
      ).length;
      expect(positiveFractionCount).toBeGreaterThanOrEqual(2);
      // wide/narrowでcontinuousFraction自体は不変(スケール不変性。capはstake算出後にのみ効く)。
      for (let i = 0; i < wide.allocations.length; i++) {
        expect(narrow.allocations[i]!.continuousFraction).toBe(
          wide.allocations[i]!.continuousFraction,
        );
      }

      // 前提(無条件expect): このケースでは最低額ロジックが介入していないこと
      // (介入すると1頭に絞られ、比率保持の検証がそもそも成立しなくなるため)。
      expect(narrow.minimumStakeApplied).toBe(false);
      expect(narrow.capApplied).toBe(true);
      expect(narrow.totalStake).toBeLessThanOrEqual(800);
      const wideStakeSum = wide.allocations.reduce((acc, a) => acc + a.stake, 0);
      expect(wideStakeSum).toBeGreaterThan(800);

      // narrowの各馬stakeは、比例縮小された連続配分(s·λ·x*_i·bankroll)をbetUnit未満で
      // 切り捨てた値に一致する(全探索ではなく計算式そのものを直接検証する)。
      const kellyTargetStake = narrow.kellyTargetStake;
      const s = kellyTargetStake > 0 ? Math.min(1, narrow.effectivePerRaceCap / kellyTargetStake) : 0;
      for (const a of narrow.allocations.filter((x) => x.excludedReason === null)) {
        const expected =
          Math.floor((s * a.scaledFraction * narrow.resolvedBankroll) / DEFAULT_BET_ALLOCATION_CONFIG.betUnit) *
          DEFAULT_BET_ALLOCATION_CONFIG.betUnit;
        const expectedFloored = expected < DEFAULT_BET_ALLOCATION_CONFIG.betUnit ? 0 : expected;
        expect(a.stake).toBe(expectedFloored);
      }

      // 前提(無条件expect): 正のcontinuousFractionを持つ2頭が、丸め後もどちらも正のstakeを
      // 維持していること(退化解〈1頭だけに全額集中〉ではないことの直接証拠)。
      const positiveNarrow = narrow.allocations.filter((a) => a.continuousFraction > 0);
      expect(positiveNarrow).toHaveLength(2);
      const withStake = positiveNarrow.filter((a) => a.stake > 0);
      expect(withStake).toHaveLength(2);

      // 比率保持の直接検証: stake比がcontinuousFraction比とbetUnitの丸め誤差程度(相対15%以内)で
      // 一致すること。betUnit=100という粗い粒度での丸めが両馬の絶対値(500円・200円)に対して
      // 一定の相対誤差を生むため、絶対精度(toBeCloseTo)ではなく相対誤差で比較する。
      const [first, second] = withStake;
      const actualRatio = first!.stake / second!.stake;
      const expectedRatio = first!.continuousFraction / second!.continuousFraction;
      const relativeError = Math.abs(actualRatio - expectedRatio) / expectedRatio;
      expect(relativeError).toBeLessThan(0.15);
    });
  });

  describe("受け入れ条件7: 比例縮小 vs 貪欲打ち切り(制約付き最適)の差の上界", () => {
    it("目的関数値の差が小さい上界に収まること(2頭・少数単位・cap非拘束)", () => {
      const candidates = [candidate(1, 0.4, 3), candidate(2, 0.35, 3.2)];
      const model = CONDITIONAL_BERNOULLI_MODEL;
      const placeCount = 1;
      const steps = 20; // 全探索が可能な粗い粒度でテストする
      const delta = 1 / steps;

      const result = allocateBets(
        candidates,
        placeCount,
        config({ bankroll: 10000, perRaceCap: 1000000000, kellyFraction: 1, betUnit: 1, greedySteps: steps }),
        model,
      );

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

      const greedyX1 = result.allocations.find((a) => a.umaban === 1)!.continuousFraction;
      const greedyX2 = result.allocations.find((a) => a.umaban === 2)!.continuousFraction;
      const greedyF = objective(greedyX1, greedyX2);
      expect(greedyF).not.toBeNull();
      expect(bestF - greedyF!).toBeLessThan(0.01);
    });
  });

  describe("受け入れ条件8・最低額ロジック(4ケース必須)", () => {
    it("(a) 単一候補でkellyTargetStakeが100円未満 → totalStake=100・exceedsKellyTarget=true・advisory≠null", () => {
      const horses = [candidate(1, 0.5, 2.2)];
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 100, perRaceCap: 100000, kellyFraction: 0.5 }),
      );
      expect(result.kellyTargetStake).toBeGreaterThan(0);
      expect(result.kellyTargetStake).toBeLessThan(100);
      expect(result.minimumStakeApplied).toBe(true);
      expect(result.totalStake).toBe(100);
      expect(result.exceedsKellyTarget).toBe(true);
      expect(result.advisory).not.toBeNull();
    });

    it("(b) 2頭対称(75/75相当)でkellyTargetStake=150程度 → totalStake=100・exceedsKellyTarget=false・advisory=null", () => {
      const horses = [candidate(1, 0.5, 2.5), candidate(2, 0.5, 2.5)];
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 300, perRaceCap: 100000, kellyFraction: 0.5 }),
      );
      // 前提: 両馬とも丸めで0円になり、最低額ロジックが介入していること。
      expect(result.minimumStakeApplied).toBe(true);
      expect(result.totalStake).toBe(100);
      // kellyTargetStakeが100を上回っていること(このテストの意義の前提)。
      expect(result.kellyTargetStake).toBeGreaterThan(100);
      expect(result.exceedsKellyTarget).toBe(false);
      expect(result.advisory).toBeNull();
    });

    it("(c) cap=100・kellyTargetStakeが大きく縮小で全馬0円 → totalStake=100=cap・exceedsKellyTarget=false", () => {
      const horses = [candidate(1, 0.5, 2.5), candidate(2, 0.5, 2.5)];
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 1000000, perRaceCap: 100, kellyFraction: 1 }),
      );
      // 前提: kellyTargetStakeがperRaceCapを大きく上回っていること(強いキャップ)。
      expect(result.kellyTargetStake).toBeGreaterThan(1000);
      expect(result.capApplied).toBe(true);
      expect(result.minimumStakeApplied).toBe(true);
      expect(result.totalStake).toBe(100);
      expect(result.effectivePerRaceCap).toBe(100);
      expect(result.exceedsKellyTarget).toBe(false);
    });

    it("(d) λ=0のときは最低額を適用せず分類④(ケリー係数0)で見送りになること", () => {
      const horses = [candidate(1, 0.5, 2.2)];
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 100, perRaceCap: 100000, kellyFraction: 0 }),
      );
      expect(result.minimumStakeApplied).toBe(false);
      expect(result.totalStake).toBe(0);
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe("ケリー係数が0のため配分しません");
    });

    it("最低額は continuousFraction 最大の1頭のみに付与され、同値は馬番昇順で決まること(均等配分しない)", () => {
      // 完全対称(同一p・同一odds)の3頭。continuousFractionが全頭同値になるスタブモデルを使う。
      // oddsMin=3だとev=0.9(EVマイナス)で候補外になってしまうため4を使う(ev=1.2)。
      const horses = [candidate(3, 0.3, 4), candidate(1, 0.3, 4), candidate(2, 0.3, 4)];
      const model = stubModel([
        { placed: [], probability: 0.1 },
        { placed: [1], probability: 0.3 },
        { placed: [2], probability: 0.3 },
        { placed: [3], probability: 0.3 },
      ]);
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 100, perRaceCap: 100000, kellyFraction: 0.5 }),
        model,
      );
      expect(result.minimumStakeApplied).toBe(true);
      expect(result.totalStake).toBe(100);
      const withStake = result.allocations.filter((a) => a.stake > 0);
      expect(withStake).toHaveLength(1);
      // 同値タイブレークは馬番昇順(1番)。
      expect(withStake[0]!.umaban).toBe(1);
    });
  });

  describe("キャップでbetCountが2頭→1頭に減り、notDiversifiedが立つこと", () => {
    it("非拘束では2頭配分だが、capを絞ると1頭に減りnotDiversified=trueになること", () => {
      const horses = [candidate(1, 0.6, 3), candidate(2, 0.4, 3), candidate(3, 0.35, 3)];
      const wide = allocateBets(
        horses,
        3,
        config({ bankroll: 100000, perRaceCap: 100000, kellyFraction: 0.5 }),
      );
      expect(wide.betCount).toBeGreaterThanOrEqual(2);

      const narrow = allocateBets(
        horses,
        3,
        config({ bankroll: 100000, perRaceCap: 100, kellyFraction: 0.5 }),
      );
      // 前提: 最低額ロジックにより1頭のみ配分されること。
      expect(narrow.betCount).toBe(1);
      const positiveCount = narrow.allocations.filter((a) => a.continuousFraction > 0).length;
      expect(positiveCount).toBeGreaterThanOrEqual(2);
      expect(narrow.notDiversified).toBe(true);
    });
  });

  describe("受け入れ条件9・見送り6分類(優先順位順・テーブル駆動)", () => {
    it("① bankroll<=0/非有限(未設定)は「総資金が未設定」になること(候補・cap有効でも)", () => {
      for (const bankroll of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
        const horses = [candidate(1, 0.6, 3)];
        const result = allocateBets(horses, 1, config({ bankroll, perRaceCap: 10000 }));
        expect(result.isSkip).toBe(true);
        expect(result.skipReason).toBe("総資金が未設定のため配分を提案していません");
      }
    });

    it("② perRaceCap<=0/非有限(未設定)は「1レースの上限が未設定」になること(bankroll有効でも)", () => {
      for (const perRaceCap of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
        const horses = [candidate(1, 0.6, 3)];
        const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap }));
        expect(result.isSkip).toBe(true);
        expect(result.skipReason).toBe("1レースの上限が未設定のため配分を提案していません");
      }
    });

    it("③ 0<perRaceCap<betUnit(実効上限が100円未満)は「1レースの上限が100円未満」になること", () => {
      for (const perRaceCap of [1, 50, 99]) {
        const horses = [candidate(1, 0.6, 3)];
        const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap }));
        expect(result.isSkip).toBe(true);
        expect(result.effectivePerRaceCap).toBeLessThan(100);
        expect(result.skipReason).toBe("1レースの上限が100円未満のため配分できません");
      }
    });

    it("③の文言はbetUnitに追随してテンプレート化されていること(code-reviewer指摘: buildAdvisoryと同じ流儀でbetUnitを埋め込む)", () => {
      // betUnit=500のときは「1レースの上限が500円未満」になる(100のハードコードでないこと)。
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, {
        bankroll: 10000,
        perRaceCap: 200,
        kellyFraction: 0.5,
        betUnit: 500,
        greedySteps: 1000,
      });
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe("1レースの上限が500円未満のため配分できません");
    });

    it("優先順位: bankroll未設定かつperRaceCap未設定 → ①(bankroll)が優先されること", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, config({ bankroll: 0, perRaceCap: 0 }));
      expect(result.skipReason).toBe("総資金が未設定のため配分を提案していません");
    });

    it("優先順位: bankroll有効・perRaceCap=50(100円未満)かつ候補0頭 → ③(上限不足)が優先されること(⑤候補0頭ではない)", () => {
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 50 }));
      expect(result.skipReason).toBe("1レースの上限が100円未満のため配分できません");
    });

    it("④ kellyTargetStake===0かつλ=0は「ケリー係数が0」になること(候補ありでも)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000, kellyFraction: 0 }));
      expect(result.skipReason).toBe("ケリー係数が0のため配分しません");
    });

    it("⑤ 候補0頭(bankroll/perRaceCapとも有効)は「EVプラスの馬がいない」になること", () => {
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(result.skipReason).toBe("EVプラスの馬がいないため見送りです");
    });

    it("優先順位: λ=0かつ候補0頭 → ④(ケリー係数0)が優先されること(⑤候補0頭ではない)", () => {
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000, kellyFraction: 0 }));
      expect(result.skipReason).toBe("ケリー係数が0のため配分しません");
    });

    it("⑥ 連続最適解が全て0(妙味が極小)は「妙味が小さく」になること", () => {
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
        config({ bankroll: 10000, perRaceCap: 10000 }),
        model,
      );
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe("妙味が小さく、賭ける価値のある配分が見つかりませんでした");
    });

    it("見送り時もkellyTargetStake/plannedStake/capAppliedが有限であること(①〜④)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const cases: BetAllocationConfig[] = [
        config({ bankroll: 0, perRaceCap: 10000 }), // ①
        config({ bankroll: 10000, perRaceCap: 0 }), // ②
        config({ bankroll: 10000, perRaceCap: 50 }), // ③
        config({ bankroll: 10000, perRaceCap: 10000, kellyFraction: 0 }), // ④
      ];
      for (const c of cases) {
        const result = allocateBets(horses, 1, c);
        expect(result.isSkip).toBe(true);
        expect(Number.isFinite(result.kellyTargetStake)).toBe(true);
        expect(Number.isFinite(result.plannedStake)).toBe(true);
        expect(typeof result.capApplied).toBe("boolean");
      }
    });
  });

  describe("受け入れ条件10: 旧「丸めでゼロ」が到達不能であることの証明", () => {
    it("C-1で「⑤丸めでゼロ」だった入力が、改訂後はtotalStake===betUnit・minimumStakeApplied===trueになること", () => {
      // C-1旧テスト「⑤ 連続最適解は正だが100円単位への丸めで全て0になる場合」の入力をそのまま
      // bankroll/perRaceCapへ読み替える(budget:100 → bankroll:100, perRaceCap:100)。
      const horses = [candidate(1, 0.5, 2.2), candidate(2, 0.5, 2.2)];
      const result = allocateBets(horses, 1, {
        bankroll: 100,
        perRaceCap: 100,
        kellyFraction: 0.05,
        betUnit: 100,
        greedySteps: 1000,
      });
      // 連続最適解自体は正であること(旧④「連続最適解ゼロ」とは異なるケースである根拠)。
      expect(result.allocations.some((a) => a.continuousFraction > 0)).toBe(true);
      // 到達不能の証明: 到達していた旧「⑤丸めでゼロ」の代わりに最低額が適用され、見送りにならない。
      expect(result.minimumStakeApplied).toBe(true);
      expect(result.totalStake).toBe(DEFAULT_BET_ALLOCATION_CONFIG.betUnit);
      expect(result.isSkip).toBe(false);
      expect(result.skipReason).toBeNull();
    });
  });

  describe("受け入れ条件11: advisoryはcoreが数値込みで生成し、exceedsKellyTarget===falseならnull", () => {
    it("exceedsKellyTarget===trueのとき、advisoryにケリー適正額の数値が含まれること", () => {
      const horses = [candidate(1, 0.5, 2.2)];
      const result = allocateBets(
        horses,
        1,
        config({ bankroll: 100, perRaceCap: 100000, kellyFraction: 0.5 }),
      );
      expect(result.exceedsKellyTarget).toBe(true);
      expect(result.advisory).not.toBeNull();
      const rounded = Math.round(result.kellyTargetStake);
      expect(result.advisory).toContain(String(rounded));
      expect(result.advisory).toContain("100円");
    });

    it("exceedsKellyTarget===falseのとき、advisory===nullであること(通常配分・最低額非適用いずれも)", () => {
      const normal = allocateBets(
        [candidate(1, 0.6, 3)],
        1,
        config({ bankroll: 1000000, perRaceCap: 1000000 }),
      );
      expect(normal.exceedsKellyTarget).toBe(false);
      expect(normal.advisory).toBeNull();

      // ケース(b)相当(最低額適用だがexceedsKellyTarget===false)。
      const minimumButNotExceeding = allocateBets(
        [candidate(1, 0.5, 2.5), candidate(2, 0.5, 2.5)],
        1,
        config({ bankroll: 300, perRaceCap: 100000, kellyFraction: 0.5 }),
      );
      expect(minimumButNotExceeding.exceedsKellyTarget).toBe(false);
      expect(minimumButNotExceeding.advisory).toBeNull();
    });
  });

  describe("受け入れ条件12: BetAllocation/continuousFractionへの改称完了", () => {
    it("allocations[].continuousFraction が公開され、旧名kellyFractionのフィールドが存在しないこと", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000 }));
      const a = result.allocations[0]!;
      expect(typeof a.continuousFraction).toBe("number");
      expect((a as unknown as Record<string, unknown>).kellyFraction).toBeUndefined();
    });

    it("BetAllocationResult.kellyFraction(λ)は従来どおり存在すること(名前衝突の相手が消えたので問題ない)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000, kellyFraction: 0.3 }));
      expect(result.kellyFraction).toBe(0.3);
    });
  });

  describe("受け入れ条件13: C-1の不変条件の継承(契約変更で削る・緩めない)", () => {
    it("受け入れ条件5相当: 予算スケール不変性(bankrollを変えてもcontinuousFractionは完全一致すること)", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const bankrolls = [1000, 10000, 100000];
      const results = bankrolls.map((bankroll) =>
        allocateBets(horses, 3, config({ bankroll, perRaceCap: 100000000 })),
      );
      for (let i = 1; i < results.length; i++) {
        for (let j = 0; j < results[0]!.allocations.length; j++) {
          expect(results[i]!.allocations[j]!.continuousFraction).toBe(
            results[0]!.allocations[j]!.continuousFraction,
          );
        }
      }
    });

    it("受け入れ条件6相当: 独立性を一切仮定しない(スタブモデルで完全相関/完全排反の結果が異なること)", () => {
      const horses = [candidate(1, 0.4, 3), candidate(2, 0.4, 3)];
      const perfectlyCorrelated = stubModel([
        { placed: [], probability: 0.6 },
        { placed: [1, 2], probability: 0.4 },
      ]);
      const mutuallyExclusive = stubModel([
        { placed: [], probability: 0.2 },
        { placed: [1], probability: 0.4 },
        { placed: [2], probability: 0.4 },
      ]);
      const correlatedResult = allocateBets(
        horses,
        2,
        config({ bankroll: 10000, perRaceCap: 10000 }),
        perfectlyCorrelated,
      );
      const exclusiveResult = allocateBets(
        horses,
        2,
        config({ bankroll: 10000, perRaceCap: 10000 }),
        mutuallyExclusive,
      );
      expect(correlatedResult.allocations[0]!.continuousFraction).not.toBeCloseTo(
        exclusiveResult.allocations[0]!.continuousFraction,
        6,
      );
    });

    it("入力のplaceProbを書き換えないこと", () => {
      const horses = [candidate(1, 0.55, 2.5), candidate(2, 0.35, 3)];
      const original = horses.map((h) => ({ ...h }));
      allocateBets(horses, 2, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(horses).toEqual(original);
    });

    it("placeCountを引数で受け、3をハードコードしないこと(placeCount=2と3で異なる結果)", () => {
      const horses = [candidate(1, 0.5, 2.5), candidate(2, 0.5, 2.5), candidate(3, 0.5, 2.5)];
      const resultK2 = allocateBets(horses, 2, config({ bankroll: 10000, perRaceCap: 10000 }));
      const resultK3 = allocateBets(horses, 3, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(resultK2.allocations[0]!.continuousFraction).not.toBeCloseTo(
        resultK3.allocations[0]!.continuousFraction,
        6,
      );
    });

    it("候補外の馬も0円で欠落させないこと(EVマイナス/オッズ未確定を正しく区別)", () => {
      const horses = [candidate(1, 0.6, 3), nonCandidate(2, 0.1, 2)];
      const result = allocateBets(horses, 2, config({ bankroll: 10000, perRaceCap: 10000 }));
      const excluded = result.allocations.find((a) => a.umaban === 2)!;
      expect(excluded.stake).toBe(0);
      expect(excluded.excludedReason).toBe("EVがプラスではないため対象外");

      const horsesNoOdds: AllocationHorse[] = [
        candidate(1, 0.6, 3),
        { umaban: 2, placeProb: 0.5, placeOddsMin: null, ev: null, isPositive: false },
      ];
      const resultNoOdds = allocateBets(horsesNoOdds, 2, config({ bankroll: 10000, perRaceCap: 10000 }));
      const excludedNoOdds = resultNoOdds.allocations.find((a) => a.umaban === 2)!;
      expect(excludedNoOdds.excludedReason).toBe("複勝オッズ下限が未確定のため対象外");
    });

    it("全出走馬が馬番昇順で結果に含まれること", () => {
      const horses = [candidate(3, 0.6, 3), nonCandidate(1, 0.1), candidate(2, 0.5, 2.5)];
      const result = allocateBets(horses, 3, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(result.allocations.map((a) => a.umaban)).toEqual([1, 2, 3]);
    });

    describe("droppedBelowMinimum(意味の一貫性を維持)", () => {
      it("最低額を受け取った1頭はfalse、他の正比率馬はtrueのままであること", () => {
        const horses = [candidate(1, 0.5, 2.5), candidate(2, 0.5, 2.5)];
        const result = allocateBets(
          horses,
          1,
          config({ bankroll: 300, perRaceCap: 100000, kellyFraction: 0.5 }),
        );
        expect(result.minimumStakeApplied).toBe(true);
        const withStake = result.allocations.filter((a) => a.stake > 0);
        expect(withStake).toHaveLength(1);
        expect(withStake[0]!.droppedBelowMinimum).toBe(false);
        const withoutStake = result.allocations.filter(
          (a) => a.continuousFraction > 0 && a.stake === 0,
        );
        expect(withoutStake.length).toBeGreaterThanOrEqual(1);
        for (const a of withoutStake) {
          expect(a.droppedBelowMinimum).toBe(true);
        }
      });

      it("bankroll未設定・perRaceCap不足では丸め判定に到達しておらずdroppedBelowMinimumが常にfalseであること", () => {
        const horses = [candidate(1, 0.6, 3)];
        const unsetBankroll = allocateBets(horses, 1, config({ bankroll: 0, perRaceCap: 10000 }));
        for (const a of unsetBankroll.allocations) {
          expect(a.droppedBelowMinimum).toBe(false);
        }
        const smallCap = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 50 }));
        for (const a of smallCap.allocations) {
          expect(a.droppedBelowMinimum).toBe(false);
        }
      });
    });

    describe("notDiversified(betCount===1のときのみtrueになりうる)", () => {
      it("見送り(betCount=0)のときはnotDiversified=falseであること", () => {
        const horses = [nonCandidate(1, 0.3, 2)];
        const result = allocateBets(horses, 1, config({ bankroll: 0, perRaceCap: 10000 }));
        expect(result.betCount).toBe(0);
        expect(result.notDiversified).toBe(false);
      });

      it("1点配分だが他に正の候補がいない場合はfalseであること", () => {
        const horses = [candidate(1, 0.6, 3)];
        const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000 }));
        expect(result.betCount).toBe(1);
        expect(result.notDiversified).toBe(false);
      });

      it("2点以上配分されるときはnotDiversified=falseであること", () => {
        const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.5, 2.2), candidate(3, 0.1, 5)];
        const result = allocateBets(
          horses,
          2,
          config({ bankroll: 100000, perRaceCap: 100000, kellyFraction: 1 }),
        );
        expect(result.betCount).toBeGreaterThanOrEqual(2);
        expect(result.notDiversified).toBe(false);
      });
    });

    it("剰余の再配分を行わないこと(cap非拘束時、合計は各馬stakeの合計と一致)", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const result = allocateBets(
        horses,
        3,
        config({ bankroll: 10000, perRaceCap: 100000000, kellyFraction: 1 }),
      );
      const expectedStakeSum = result.allocations.reduce((acc, a) => acc + a.stake, 0);
      expect(result.totalStake).toBe(expectedStakeSum);
    });

    it("1頭のみのときのケリー解析解との一致(λ=1・丸め前・cap非拘束)", () => {
      const horses: AllocationHorse[] = [candidate(1, 0.5, 3), nonCandidate(2, 0.5, null)];
      const result = allocateBets(horses, 1, {
        bankroll: 10000,
        perRaceCap: 100000000,
        kellyFraction: 1,
        betUnit: 100,
        greedySteps: 10000,
      });
      const analytic = (1.5 - 1) / (3 - 1); // (EV-1)/(o-1) = 0.25
      const actual = result.allocations.find((a) => a.umaban === 1)!.continuousFraction;
      expect(actual).toBeCloseTo(analytic, 2);
    });

    it("modelId/modelApproximateが結果に載ること(既定モデル)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(result.modelId).toBe(CONDITIONAL_BERNOULLI_MODEL.id);
      expect(result.modelApproximate).toBe(true);
    });

    it("差し替えたモデルのid/approximateが反映されること(C-1由来の回帰テスト。model引数を無視して既定値をハードコードで返す退行の検出)", () => {
      // 既定(CONDITIONAL_BERNOULLI_MODEL: id="conditional-bernoulli"・approximate=true)とは
      // 異なるid・approximateを持つスタブモデルを注入し、結果にそのまま反映されることを確認する。
      const horses = [candidate(1, 0.6, 3)];
      const swappedModel: PlaceJointModel = {
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
        config({ bankroll: 10000, perRaceCap: 10000 }),
        swappedModel,
      );
      expect(result.modelId).toBe("exact-future-model");
      expect(result.modelApproximate).toBe(false);
      // 既定モデルの値と異なることも積極的に確認する(既定へのハードコード退行の直接検出)。
      expect(result.modelId).not.toBe(CONDITIONAL_BERNOULLI_MODEL.id);
      expect(result.modelApproximate).not.toBe(CONDITIONAL_BERNOULLI_MODEL.approximate);
    });

    it("診断値(placeProbSum等)が見送り時も含め算出されること", () => {
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, config({ bankroll: 0, perRaceCap: 10000 }));
      expect(result.isSkip).toBe(true);
      expect(result.diagnostics.placeProbSum).toBeCloseTo(0.3, 10);
      expect(result.diagnostics.candidateCount).toBe(0);
    });

    it("見送り(bankroll不足)のときもcontinuousFractionが算出されること(Step4は早期リターンで省略しない)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, config({ bankroll: 0, perRaceCap: 10000 }));
      expect(result.isSkip).toBe(true);
      expect(result.allocations[0]!.continuousFraction).toBeGreaterThan(0);
    });

    it("N=0(出走馬なし)でもクラッシュせず、候補0頭の見送りになること(C-1由来の回帰テスト)", () => {
      const result = allocateBets([], 3, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(result.allocations).toEqual([]);
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe("EVプラスの馬がいないため見送りです");
      expect(result.diagnostics.candidateCount).toBe(0);
      expect(result.diagnostics.placeProbSum).toBe(0);
    });

    it("N=4(複勝人数3に対して頭数が少ない境界)でもクラッシュせず正しく配分されること(C-1由来の回帰テスト)", () => {
      const horses = [
        candidate(1, 0.5, 2.5),
        candidate(2, 0.4, 2.5),
        candidate(3, 0.3, 2.2),
        candidate(4, 0.2, 2.2),
      ];
      const result = allocateBets(horses, 3, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(result.allocations).toHaveLength(4);
      expect(result.allocations.map((a) => a.umaban)).toEqual([1, 2, 3, 4]);
      for (const a of result.allocations) {
        expect(a.stake % DEFAULT_BET_ALLOCATION_CONFIG.betUnit).toBe(0);
      }
    });

    it("placeCount=NaNでもNaNが一切露出しないこと(C-1で実際に発生したバグの回帰テスト。Math.max(0,NaN)がNaNを素通りしてcombos=[]になり見送り理由が誤分類されていた)", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const result = allocateBets(horses, Number.NaN, {
        bankroll: 10000,
        perRaceCap: 10000,
        kellyFraction: 1,
        betUnit: 100,
        greedySteps: 1000,
      });
      expect(Number.isNaN(result.totalStake)).toBe(false);
      expect(Number.isNaN(result.diagnostics.placeProbSumTarget)).toBe(false);
      expect(Number.isNaN(result.diagnostics.placeProbSumDeviation)).toBe(false);
      expect(Number.isNaN(result.diagnostics.marginalDeviationMax)).toBe(false);
      for (const a of result.allocations) {
        expect(Number.isNaN(a.stake)).toBe(false);
        expect(Number.isNaN(a.continuousFraction)).toBe(false);
        expect(Number.isNaN(a.scaledFraction)).toBe(false);
      }
      // 負値(既存のMath.maxクランプ)と同じ一貫した結果(k=0扱い)として⑥に分類される。
      expect(result.isSkip).toBe(true);
      expect(result.skipReason).toBe(
        "妙味が小さく、賭ける価値のある配分が見つかりませんでした",
      );
    });
  });

  describe("λ(ケリー係数)の効果・防御(既存回帰の踏襲)", () => {
    it("λ=1とλ=0.5でstakeが概ね半分になること(cap非拘束)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const resultFull = allocateBets(horses, 1, {
        bankroll: 1000000,
        perRaceCap: 1000000,
        kellyFraction: 1,
        betUnit: 100,
        greedySteps: 1000,
      });
      const resultHalf = allocateBets(horses, 1, {
        bankroll: 1000000,
        perRaceCap: 1000000,
        kellyFraction: 0.5,
        betUnit: 100,
        greedySteps: 1000,
      });
      const ratio = resultHalf.totalStake / resultFull.totalStake;
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.6);
    });

    it("λ=1.5(範囲外)は既定値0.5へフォールバックされ、無条件不変条件(totalStake<=effectivePerRaceCap)を破らないこと", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const result = allocateBets(horses, 3, {
        bankroll: 10000,
        perRaceCap: 10000,
        kellyFraction: 1.5,
        betUnit: 100,
        greedySteps: 1000,
      });
      expect(result.kellyFraction).toBe(DEFAULT_BET_ALLOCATION_CONFIG.kellyFraction);
      expect(result.totalStake).toBeLessThanOrEqual(result.effectivePerRaceCap);
    });

    it("λ=NaN/Infinity/負値は既定値0.5へフォールバックされ、既定値を明示指定した結果と完全一致すること", () => {
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
      const base = { bankroll: 10000, perRaceCap: 10000, betUnit: 100, greedySteps: 1000 };
      const expected = allocateBets(horses, 3, { ...base, kellyFraction: 0.5 });
      for (const kellyFraction of [Number.NaN, Number.POSITIVE_INFINITY, -0.5]) {
        const result = allocateBets(horses, 3, { ...base, kellyFraction });
        expect(result.kellyFraction).toBe(0.5);
        expect(result.totalStake).toBe(expected.totalStake);
        expect(result.isSkip).toBe(expected.isSkip);
        expect(result.skipReason).toBe(expected.skipReason);
      }
    });
  });

  describe("betUnit/greedySteps の防御(重大バグ・水平展開の回帰テスト)", () => {
    const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.3, 4), candidate(3, 0.5, 3)];
    const validConfig: BetAllocationConfig = {
      bankroll: 10000,
      perRaceCap: 10000,
      kellyFraction: 1,
      betUnit: 100,
      greedySteps: 1000,
    };

    describe("betUnitの異常値", () => {
      const cases: Array<{ name: string; betUnit: number }> = [
        { name: "betUnit=0", betUnit: 0 },
        { name: "betUnit=NaN", betUnit: Number.NaN },
        { name: "betUnit=Infinity", betUnit: Number.POSITIVE_INFINITY },
        { name: "betUnit=-100(負値)", betUnit: -100 },
        { name: "betUnit=33.5(非整数)", betUnit: 33.5 },
      ];
      for (const c of cases) {
        it(`${c.name}でも既定betUnit(100)相当の結果と一致すること`, () => {
          const result = allocateBets(horses, 3, { ...validConfig, betUnit: c.betUnit });
          const expected = allocateBets(horses, 3, validConfig);
          expect(Number.isFinite(result.effectivePerRaceCap)).toBe(true);
          expect(Number.isFinite(result.totalStake)).toBe(true);
          for (const a of result.allocations) {
            expect(Number.isFinite(a.stake)).toBe(true);
          }
          expect(result.effectivePerRaceCap).toBe(expected.effectivePerRaceCap);
          expect(result.totalStake).toBe(expected.totalStake);
          expect(result.isSkip).toBe(expected.isSkip);
          expect(result.skipReason).toBe(expected.skipReason);
        });
      }
    });

    describe("greedyStepsの異常値", () => {
      const cases: Array<{ name: string; greedySteps: number }> = [
        { name: "greedySteps=0", greedySteps: 0 },
        { name: "greedySteps=NaN", greedySteps: Number.NaN },
        { name: "greedySteps=-5(負値)", greedySteps: -5 },
        { name: "greedySteps=Infinity", greedySteps: Number.POSITIVE_INFINITY },
      ];
      for (const c of cases) {
        it(`${c.name}でも既定greedySteps(1000)相当の結果になること`, () => {
          const result = allocateBets(horses, 3, { ...validConfig, greedySteps: c.greedySteps });
          const expected = allocateBets(horses, 3, validConfig);
          expect(Number.isFinite(result.totalStake)).toBe(true);
          expect(result.totalStake).toBe(expected.totalStake);
          expect(result.isSkip).toBe(expected.isSkip);
          expect(result.skipReason).toBe(expected.skipReason);
        });
      }
    });
  });

  describe("受け入れ条件33: bankroll/perRaceCapが負値・NaN・±Infinityでも全出力が有限かつ非負であること", () => {
    const badValues = [-10000, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];

    it("bankrollが異常値のとき、resolvedBankroll/kellyTargetStake/effectivePerRaceCap/plannedStakeが有限・非負で、①へ分類されること", () => {
      const horses = [candidate(1, 0.6, 3)];
      for (const bankroll of badValues) {
        const result = allocateBets(horses, 1, config({ bankroll, perRaceCap: 10000 }));
        expect(Number.isFinite(result.resolvedBankroll)).toBe(true);
        expect(result.resolvedBankroll).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(result.kellyTargetStake)).toBe(true);
        expect(result.kellyTargetStake).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(result.effectivePerRaceCap)).toBe(true);
        expect(result.effectivePerRaceCap).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(result.plannedStake)).toBe(true);
        expect(result.plannedStake).toBeGreaterThanOrEqual(0);
        expect(result.exceedsKellyTarget).toBe(false);
        expect(result.advisory).toBeNull();
        expect(result.skipReason).toBe("総資金が未設定のため配分を提案していません");
      }
    });

    it("perRaceCapが異常値のとき、effectivePerRaceCapが有限・非負(負のcapにならない)で、②へ分類されること", () => {
      const horses = [candidate(1, 0.6, 3)];
      for (const perRaceCap of badValues) {
        const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap }));
        expect(Number.isFinite(result.effectivePerRaceCap)).toBe(true);
        expect(result.effectivePerRaceCap).toBeGreaterThanOrEqual(0);
        expect(result.exceedsKellyTarget).toBe(false);
        expect(result.advisory).toBeNull();
        expect(result.skipReason).toBe("1レースの上限が未設定のため配分を提案していません");
      }
    });
  });
});
