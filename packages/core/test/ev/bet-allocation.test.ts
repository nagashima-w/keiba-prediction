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
  type SkipReasonCode,
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

  describe("貪欲法とC-1由来の格子探索比較(経験的一致。理論保証ではない。2026-07-30 boss指摘で名称・アサーションを是正)", () => {
    it("このフィクスチャでは貪欲法が全探索の最適格子点と一致すること(実測。理論保証ではない)", () => {
      // このテストは「受け入れ条件7」ではない(旧来この describe 名を名乗っていたが中身は
      // C-1由来の「貪欲 vs 全探索」の突き合わせであり、AC7〈比例縮小の代償の定量化〉とは
      // 別の性質を検証している。5周のレビューで describe 名だけを見て本体を読まなかったために
      // 見逃されていた〈2026-07-30 boss指摘〉。AC7本体は次のdescribeで別途実装する。
      //
      // 貪欲法に大域最適の理論保証は無い(bet-allocation.tsのoptimizeContinuousFractions
      // JSDoc参照: 目的関数は非分離なlogの内側で変数が結合しており、分離可能凹目的やM♮凹関数の
      // ケースのような保証が及ばない)。このテストは「試した範囲(2頭・粗い格子)では一致した」
      // という経験則を実測で固定するものであり、Phase 2でモデルを差し替えた際に失敗しうる
      // (失敗したらこのテストを消すか閾値を見直す。契約として固定しているわけではない)。
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
      // 実測差は1e-16〜1e-17(2026-07-30 boss実測)。片側(bestF-greedyF<0.01)だと、格子の
      // 取り違えで貪欲が全探索を「上回る」符号逆転の不整合を見逃す。両側で固定する(3-b)。
      expect(Math.abs(bestF - greedyF!)).toBeLessThan(1e-9);
    });
  });

  describe("受け入れ条件7: 比例縮小の代償(制約付き最適=貪欲打ち切りとの差の定量化)", () => {
    it("capApplied===trueのとき、比例縮小は制約付き最適(cap内で貪欲打ち切り)よりF値が実測差だけ劣ること", () => {
      // 着手前ゲートでboss が「キャップは比例縮小で実装する。貪欲打ち切りは採らない」と決めた
      // 設計判断の代償を定量化する(2026-07-30 boss指摘: この定量化が5周のレビューを通過する間
      // 一度も実装されていなかった)。
      //
      // 比較対象:
      //   (A) 実装(allocateBets): 無制約の連続最適比率x*を求めてから s=cap/kellyTargetStake で
      //       比例縮小する(全候補を同じ比率で縮小)。
      //   (B) 参照実装(テスト内): 同じ貪欲法だが、Σx(バンクロール比率換算)がcapFraction=
      //       effectivePerRaceCap/resolvedBankroll を超えないよう打ち切りながら進める
      //       (=「キャップ内で最も目的関数を改善する候補に優先的に配る」制約付き貪欲)。
      // (B)は各ステップでその時点の目的関数改善が最大の候補を選ぶため、(A)の一律比例縮小とは
      // 異なる配分比率になり得る。両者のF値の差が「比例縮小を採用した設計判断の代償」。
      const candidates = [candidate(1, 0.4, 3), candidate(2, 0.35, 3.2)];
      const model = CONDITIONAL_BERNOULLI_MODEL;
      const placeCount = 1;
      const bankroll = 10000;
      const perRaceCap = 3000; // kellyTargetStake(≈10000。λ=1でΣx*≈1に近いため)の3割程度に絞る
      const steps = 200;
      const delta = 1 / steps;

      const result = allocateBets(
        candidates,
        placeCount,
        config({ bankroll, perRaceCap, kellyFraction: 1, betUnit: 1, greedySteps: steps }),
        model,
      );

      // 前提(無条件expect): キャップが実際に拘束していること。拘束していなければ
      // 比例縮小のs=1となり、以降の比較はAC7が測ろうとしている代償を何も検証しない。
      expect(result.capApplied).toBe(true);

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

      // (A) 実装が実際に出力したstakeを、バンクロール比率(fraction)へ変換する
      // (sを自前で再計算せず、実際のallocateBets出力をそのまま使う。betUnit=1のため
      // 丸めによる離散化損失が実質無く、fraction換算しても比例縮小の実態を正しく反映する)。
      const propX1 = result.allocations.find((a) => a.umaban === 1)!.stake / result.resolvedBankroll;
      const propX2 = result.allocations.find((a) => a.umaban === 2)!.stake / result.resolvedBankroll;
      const propF = objective(propX1, propX2);
      expect(propF).not.toBeNull();

      // (B) 参照実装: capFraction(=perRaceCap/bankroll)を超えないよう打ち切る制約付き貪欲。
      // optimizeContinuousFractions本体と同じ「各ステップで目的関数改善が最大の候補にdelta分
      // 加える」ロジックだが、ΣxがcapFractionを超える手前で停止する点だけが異なる
      // (制約なしのoptimizeContinuousFractionsをそのまま呼ぶことはできないため、テスト内に
      // 参照実装を持つ。boss許可済み: 「テスト内実装で可」)。
      const capFraction = perRaceCap / bankroll;
      const greedyX = [0, 0];
      let sumX = 0;
      let currentF = objective(0, 0)!;
      for (let step = 0; step < steps; step++) {
        const trialSumX = sumX + delta;
        if (trialSumX > capFraction + 1e-12) {
          break; // これ以上はキャップを超えるため打ち切る。
        }
        let bestIdx = -1;
        let bestIncrement = 0;
        for (let i = 0; i < 2; i++) {
          const trialX = greedyX.slice();
          trialX[i] = trialX[i]! + delta;
          const f = objective(trialX[0]!, trialX[1]!);
          if (f === null) {
            continue;
          }
          const increment = f - currentF;
          if (increment > bestIncrement) {
            bestIncrement = increment;
            bestIdx = i;
          }
        }
        if (bestIdx === -1) {
          break;
        }
        greedyX[bestIdx] = greedyX[bestIdx]! + delta;
        sumX = trialSumX;
        currentF = objective(greedyX[0]!, greedyX[1]!)!;
      }
      const constrainedGreedyF = objective(greedyX[0]!, greedyX[1]!);
      expect(constrainedGreedyF).not.toBeNull();

      // 実測(2026-07-30・steps=200・この構成): 制約付き貪欲F − 比例縮小F ≈ 0.00101。
      // 比例縮小は制約付き最適に対して正の代償(F値の劣化)を払っており、その代償はゼロではない
      // (=キャップ拘束時、比例縮小は理論上の制約付き最適から実際に離れる)。
      const cost = constrainedGreedyF! - propF!;
      expect(cost).toBeGreaterThan(0);
      // 上界は実測値(≈0.00101)から意味のある距離に設定する(約5倍の余裕。旧AC7の閾値0.01は
      // 実測1e-16から6.0e+13倍も離れており無意味だった。同じ轍を踏まない)。
      expect(cost).toBeLessThan(0.005);
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
    // 【リファクタの番人】(機能D-2a・boss指摘2026-08-05への対応で追記。アサーション・期待値は
    // 一切変更していない): このテストの3頭(placeOddsMin=3倍で揃っている)は単一outcomeにしか
    // 属さない退化ケースで、目的関数がΣx_iの合計にしか依存しない「平坦な最適解」を持つ
    // (payout=Σx_i·oddsはoddsが全員3で共通のため、個々の配分先ではなく合計だけで値が決まる)。
    // したがって `wide.betCount>=2`(=具体的な配分が複数頭に割れること)という期待値は、
    // 数学的に一意な正解ではなく「貪欲の評価順序・加算順序が生む丸め誤差というタイブレークが
    // たまたま選んだ1点」にすぎない。**値そのものに数学的な意味は無い**が、貪欲の評価順序や
    // 加算順序を変えると容易に壊れるため、リファクタで複勝の挙動が変わっていないことを
    // 検知する番人として機能している。`toBeCloseTo` 等へ緩めてはならない
    // (緩めると番人としての検知力を失う)。
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

    it("優先順位: bankroll未設定かつ候補0頭 → ①(未設定)が優先されること(⑤候補0頭ではない。C-1由来の回帰テスト)", () => {
      // C-1旧テスト「優先順位: budget=0かつEVプラス0頭 → ①(未設定)が返る」の読み替え。
      // 未設定は「妙味なし」ではなく「まだ判定していない」状態であり、候補の有無より優先する。
      const horses = [nonCandidate(1, 0.3, 2)];
      const result = allocateBets(horses, 1, config({ bankroll: 0, perRaceCap: 10000 }));
      expect(result.skipReason).toBe("総資金が未設定のため配分を提案していません");
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

  describe("Issue #58: skipReasonCodeがskipReason(日本語文言)と独立に見送り理由を表すこと(AC3)", () => {
    /**
     * 6分類それぞれについて、skipReasonの文言に加えてskipReasonCodeが対応するコード値を
     * 持つことをテーブル駆動で固定する。文言とコードが同じ入力から独立に導出されることの
     * 構造的検証(AC3(b))。テーブルの各行は「受け入れ条件9」の同一入力を流用する。
     */
    const table: {
      readonly label: string;
      readonly horses: readonly AllocationHorse[];
      readonly config: BetAllocationConfig;
      readonly model?: PlaceJointModel;
      readonly expectedCode: SkipReasonCode;
    }[] = [
      {
        label: "① bankroll未設定",
        horses: [candidate(1, 0.6, 3)],
        config: config({ bankroll: 0, perRaceCap: 10000 }),
        expectedCode: "bankroll-unset",
      },
      {
        label: "② perRaceCap未設定",
        horses: [candidate(1, 0.6, 3)],
        config: config({ bankroll: 10000, perRaceCap: 0 }),
        expectedCode: "cap-unset",
      },
      {
        label: "③ 実効上限がbetUnit未満",
        horses: [candidate(1, 0.6, 3)],
        config: config({ bankroll: 10000, perRaceCap: 50 }),
        expectedCode: "cap-too-small",
      },
      {
        label: "④ ケリー係数0",
        horses: [candidate(1, 0.6, 3)],
        config: config({ bankroll: 10000, perRaceCap: 10000, kellyFraction: 0 }),
        expectedCode: "kelly-zero",
      },
      {
        label: "⑤ 候補0頭",
        horses: [nonCandidate(1, 0.3, 2)],
        config: config({ bankroll: 10000, perRaceCap: 10000 }),
        expectedCode: "no-candidates",
      },
      {
        label: "⑥ 連続最適解ゼロ(妙味が極小)",
        horses: [{ umaban: 1, placeProb: 0.5, placeOddsMin: 1.0000001, ev: 1.00000005, isPositive: true }],
        config: config({ bankroll: 10000, perRaceCap: 10000 }),
        model: stubModel([
          { placed: [], probability: 0.5 },
          { placed: [1], probability: 0.5 },
        ]),
        expectedCode: "no-edge",
      },
    ];

    it.each(table)("$label はskipReasonCode=$expectedCode になること", ({ horses, config: cfg, model, expectedCode }) => {
      const result = allocateBets(horses, 1, cfg, model);
      // 前提固定(空振り防止): このテーブルは見送りケースだけを扱う。
      expect(result.isSkip).toBe(true);
      expect(result.skipReasonCode).toBe(expectedCode);
    });

    it("6分類のskipReasonCodeが互いに異なる値であること(集合サイズで機械的に固定)", () => {
      const codes = table.map((t) => t.expectedCode);
      expect(new Set(codes).size).toBe(6);
    });

    it("見送りでなければskipReasonCode===nullであること(skipReasonと対称)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(result.isSkip).toBe(false);
      expect(result.skipReason).toBeNull();
      expect(result.skipReasonCode).toBeNull();
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

    it("結果のBetAllocation.placeProbが入力と一致すること(C-1由来の回帰テスト。入力配列が不変であることとは別の主張)", () => {
      const horses = [candidate(1, 0.55, 2.5), candidate(2, 0.35, 3)];
      const result = allocateBets(horses, 2, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(result.allocations.find((a) => a.umaban === 1)!.placeProb).toBe(0.55);
      expect(result.allocations.find((a) => a.umaban === 2)!.placeProb).toBe(0.35);
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

    it("候補馬のexcludedReasonはnullであること(C-1由来の回帰テスト)", () => {
      const horses = [candidate(1, 0.6, 3)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(result.allocations[0]!.excludedReason).toBeNull();
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

    it("剰余の再配分を行わないこと(切り捨て前との差がbetUnit未満に収まり、実際に丸めが発生していること。C-1由来の回帰テスト)", () => {
      // 【2周目の空振り修正】前回の修正(候補3頭・placeCount3・kellyFraction1)はΣx*が
      // ちょうど1.0に張り付く退化解になり、continuousFraction×λ×resolvedBankrollが
      // betUnitの倍数(floorが恒等写像)になって、差が全馬0になっていた(boss実測: 7.27e-12は
      // 「丸めが起きた証拠」ではなく「一度も起きていない証拠」だった)。placeCount=2の非退化
      // フィクスチャ(頭数>複勝人数)に差し替え、2頭が正のcontinuousFractionを持ち、かつ
      // 丸めが実際に発生する(差が0でない)ことを無条件expectで先に固定してから検証する。
      const horses = [candidate(1, 0.6, 2.5), candidate(2, 0.5, 2.2), candidate(3, 0.1, 5)];
      const result = allocateBets(
        horses,
        2,
        config({ bankroll: 10000, perRaceCap: 100000000, kellyFraction: 1 }),
      );

      // 前提1(無条件expect): 剰余が複数馬にまたがる状況であること(2頭以上に配分)。
      expect(result.betCount).toBeGreaterThanOrEqual(2);

      const withPositiveContinuous = result.allocations.filter((a) => a.continuousFraction > 0);
      const diffs = withPositiveContinuous.map((a) => ({
        umaban: a.umaban,
        diff:
          a.continuousFraction * result.kellyFraction * result.resolvedBankroll - a.stake,
      }));

      // 前提2(無条件expect): 少なくとも1頭でcontinuous−stake>0であること
      // (=betUnit単位への丸めが実際に発生していること。差が全馬0なら床関数が恒等写像に
      // なっているだけで、以降のアサーションは何も検証していない空振りになる)。
      expect(diffs.some((d) => d.diff > 1e-9)).toBe(true);

      const expectedStakeSum = result.allocations.reduce((acc, a) => acc + a.stake, 0);
      expect(result.totalStake).toBe(expectedStakeSum);
      // 各馬の切り捨て前(継続配分 = continuousFraction×λ×resolvedBankroll。cap非拘束のためs=1)
      // との差はbetUnit未満のはず(切り上げ補填していない証拠。前提2により、この不等式は
      // 実際に丸めが発生した馬に対して意味のある検証になっている)。
      for (const a of result.allocations) {
        const continuous = a.continuousFraction * result.kellyFraction * result.resolvedBankroll;
        expect(continuous - a.stake).toBeLessThan(DEFAULT_BET_ALLOCATION_CONFIG.betUnit);
        expect(continuous - a.stake).toBeGreaterThanOrEqual(-1e-6);
      }
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

    it("diagnosticsの各フィールドが算出されること(非見送り・C-1由来の回帰テスト)", () => {
      const horses = [candidate(1, 0.6, 3), candidate(2, 0.3, 4), nonCandidate(3, 0.1)];
      const result = allocateBets(horses, 3, config({ bankroll: 10000, perRaceCap: 10000 }));
      expect(result.diagnostics.placeProbSum).toBeCloseTo(1.0, 10);
      expect(result.diagnostics.placeProbSumTarget).toBe(3);
      expect(result.diagnostics.placeProbSumDeviation).toBeCloseTo(1.0 - 3, 10);
      expect(result.diagnostics.marginalDeviationMax).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.candidateCount).toBe(2);
      expect(result.diagnostics.excludedCount).toBe(1);
    });

    it("placeProbSumDeviationは符号付き(合計が目標を上回るとき正)であること(C-1由来の回帰テスト。boss指摘: 符号規約テストが契約変更で削除され等価物が無かった)", () => {
      // marginalDeviationMax(絶対値)と対比してplaceProbSumDeviationをわざわざ符号付きに
      // した設計判断(JSDoc「8. 診断値の符号規約」)への回帰テスト。符号を反転させる退行を
      // 検出する(Math.absを使う実害〈probabilitySumWarning〉には現れないため見落とされやすい)。
      const horses = [candidate(1, 0.9, 3), candidate(2, 0.9, 2.5), candidate(3, 0.9, 2.2)];
      const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000 }));
      // 合計2.7、目標(placeCount)1 → 正の乖離。
      expect(result.diagnostics.placeProbSumDeviation).toBeGreaterThan(0);
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

  describe("不正なオッズ値の候補外化(Issue #31)", () => {
    // 背景: 候補選定が `h.isPositive && h.placeOddsMin !== null` のみで、値が「使える値か」を
    // 検証していなかった。無関係な1頭に NaN/Infinity が混じると `runGreedyAllocation` の
    // payout計算(`trialX[idx] * odds[idx]`)がNaN汚染され、健全な他の馬の配分まで巻き添えで
    // 消えて「妙味が小さく…」という誤った見送り理由に化けていた(#31再現ログ)。
    // 判定基準は allocation-primitives.ts の isUsableOdds(正の有限値)に委譲する
    // (combo-bet-allocation.ts の validateCandidates/resolveComboOdds と同一基準を共有)。

    describe("候補選定・excludedReasonのテーブル駆動検証", () => {
      const excludedTable: Array<{ name: string; value: number }> = [
        { name: "NaN", value: Number.NaN },
        { name: "+Infinity", value: Number.POSITIVE_INFINITY },
        { name: "-Infinity", value: Number.NEGATIVE_INFINITY },
        { name: "0(境界。>0を満たさない)", value: 0 },
        { name: "負値(-1)", value: -1 },
      ];
      it.each(excludedTable)(
        "placeOddsMin=$name の馬はisPositive===trueであっても候補外になり、新設の「不正な値」理由が付くこと(AC2)",
        ({ value }) => {
          const horses: AllocationHorse[] = [
            candidate(1, 0.6, 3),
            // isPositive:true を明示的に与える(#31再現の核心: 実運用でこの組み合わせが起き得るかに
            // 関わらず、候補フィルタが isPositive だけを見て通してしまわないことを検証する)。
            { umaban: 2, placeProb: 0.35, placeOddsMin: value, ev: 1.5, isPositive: true },
          ];
          const result = allocateBets(horses, 2, config({ bankroll: 10000, perRaceCap: 10000 }));
          const excluded = result.allocations.find((a) => a.umaban === 2)!;
          expect(excluded.stake).toBe(0);
          expect(excluded.excludedReason).toBe("複勝オッズ下限が不正な値のため対象外");
        },
      );

      const retainedTable: Array<{ name: string; value: number }> = [
        { name: "正の極小値(1e-9)", value: 1e-9 },
        { name: "Number.MAX_VALUE(有限の最大値)", value: Number.MAX_VALUE },
      ];
      it.each(retainedTable)(
        "placeOddsMin=$name の馬は候補として残ること(過剰除外の否定側)",
        ({ value }) => {
          const horses: AllocationHorse[] = [
            { umaban: 1, placeProb: 0.6, placeOddsMin: value, ev: 1.5, isPositive: true },
          ];
          const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000 }));
          expect(result.allocations[0]!.excludedReason).toBeNull();
          expect(result.diagnostics.candidateCount).toBe(1);
        },
      );

      it("placeOddsMin===null(未確定)は従来どおり既存文言のままであること(AC1・非破壊の明示的固定)", () => {
        const horses: AllocationHorse[] = [
          candidate(1, 0.6, 3),
          { umaban: 2, placeProb: 0.35, placeOddsMin: null, ev: null, isPositive: false },
        ];
        const result = allocateBets(horses, 2, config({ bankroll: 10000, perRaceCap: 10000 }));
        const excluded = result.allocations.find((a) => a.umaban === 2)!;
        expect(excluded.excludedReason).toBe("複勝オッズ下限が未確定のため対象外");
      });

      it("不正な値かつisPositive===falseの馬は「EVがプラスではない」に誤ラベルされず「不正な値」と報告されること" +
        "(boss拘束力のある補足2: #31が直そうとした誤ラベルの再生産防止)", () => {
        const horses: AllocationHorse[] = [
          candidate(1, 0.6, 3),
          { umaban: 2, placeProb: 0.35, placeOddsMin: Number.NaN, ev: null, isPositive: false },
        ];
        const result = allocateBets(horses, 2, config({ bankroll: 10000, perRaceCap: 10000 }));
        const excluded = result.allocations.find((a) => a.umaban === 2)!;
        expect(excluded.excludedReason).toBe("複勝オッズ下限が不正な値のため対象外");
        expect(excluded.excludedReason).not.toBe("EVがプラスではないため対象外");
      });

      it("通常値(2.2)の候補は引き続き候補になること(過剰除外の否定・回帰)", () => {
        const horses = [candidate(1, 0.6, 2.2)];
        const result = allocateBets(horses, 1, config({ bankroll: 10000, perRaceCap: 10000 }));
        expect(result.allocations[0]!.excludedReason).toBeNull();
      });
    });

    describe("診断値(oddsMalformedCount)の整合(AC4)", () => {
      it("不正値2頭を含むレースでoddsMalformedCount=2、かつcandidateCount+excludedCount=全出走頭数を崩さないこと", () => {
        const horses: AllocationHorse[] = [
          candidate(1, 0.6, 3),
          { umaban: 2, placeProb: 0.15, placeOddsMin: Number.NaN, ev: 1.5, isPositive: true },
          { umaban: 3, placeProb: 0.15, placeOddsMin: Number.POSITIVE_INFINITY, ev: 1.5, isPositive: true },
          nonCandidate(4, 0.1, 2), // 通常のEVマイナス候補外(不正値ではない)との混在
        ];
        const result = allocateBets(horses, 2, config({ bankroll: 10000, perRaceCap: 10000 }));
        expect(result.diagnostics.candidateCount).toBe(1);
        expect(result.diagnostics.excludedCount).toBe(3);
        expect(result.diagnostics.candidateCount + result.diagnostics.excludedCount).toBe(horses.length);
        expect(result.diagnostics.oddsMalformedCount).toBe(2);
        // boss拘束力のある補足2: oddsMalformedCountはexcludedCountの内訳(部分集合)であって
        // 別枠ではないことの不変条件。
        expect(result.diagnostics.oddsMalformedCount).toBeGreaterThanOrEqual(0);
        expect(result.diagnostics.oddsMalformedCount).toBeLessThanOrEqual(result.diagnostics.excludedCount);
      });

      it("正常系(全馬健全)ではoddsMalformedCountが0であること(ノイズを出さない側の固定)", () => {
        const horses = [candidate(1, 0.6, 3), candidate(2, 0.3, 4), nonCandidate(3, 0.1)];
        const result = allocateBets(horses, 3, config({ bankroll: 10000, perRaceCap: 10000 }));
        expect(result.diagnostics.oddsMalformedCount).toBe(0);
      });

      it("除外馬が全員不正値(未確定・EVマイナスがゼロ)のとき、oddsMalformedCountがexcludedCountの" +
        "上端に張り付く(等号成立)こと(code-reviewer指摘・境界値)", () => {
        const horses: AllocationHorse[] = [
          candidate(1, 0.6, 3),
          { umaban: 2, placeProb: 0.2, placeOddsMin: Number.NaN, ev: 1.5, isPositive: true },
          { umaban: 3, placeProb: 0.2, placeOddsMin: Number.POSITIVE_INFINITY, ev: 1.5, isPositive: true },
        ];
        const result = allocateBets(horses, 2, config({ bankroll: 10000, perRaceCap: 10000 }));
        // 前提固定: 除外馬(umaban 2・3)がplaceOddsMin===null・EVマイナスのいずれでもなく、
        // 「全員不正値」であることをまず確定させる(空振り防止)。
        expect(result.diagnostics.excludedCount).toBe(2);
        expect(result.diagnostics.oddsMalformedCount).toBe(2);
        // 【本題】上端の等号: oddsMalformedCount === excludedCount。
        expect(result.diagnostics.oddsMalformedCount).toBe(result.diagnostics.excludedCount);
      });
    });

    describe("AC3(#31の本丸): 無関係な1頭の不正値が健全な馬の配分を巻き添えにしないこと", () => {
      it("不正値の馬を、同じplaceProbを持つ候補外の馬(placeOddsMin=null・isPositive=false)に" +
        "差し替えた対照レースと、totalStake・健全な馬のstake/continuousFractionが完全一致すること", () => {
        const healthy = candidate(1, 0.6, 3);
        const contaminated: AllocationHorse[] = [
          healthy,
          { umaban: 2, placeProb: 0.35, placeOddsMin: Number.NaN, ev: 1.5, isPositive: true },
        ];
        const control: AllocationHorse[] = [
          healthy,
          { umaban: 2, placeProb: 0.35, placeOddsMin: null, ev: null, isPositive: false },
        ];
        const cfg = config({ bankroll: 10000, perRaceCap: 10000 });
        const contaminatedResult = allocateBets(contaminated, 2, cfg);
        const controlResult = allocateBets(control, 2, cfg);

        // 前提固定(空振り防止): 健全な馬は両レースでisSkip=false・stake>0であること。
        expect(contaminatedResult.isSkip).toBe(false);
        expect(controlResult.isSkip).toBe(false);
        const contaminatedHealthy = contaminatedResult.allocations.find((a) => a.umaban === 1)!;
        const controlHealthy = controlResult.allocations.find((a) => a.umaban === 1)!;
        expect(contaminatedHealthy.stake).toBeGreaterThan(0);
        expect(controlHealthy.stake).toBeGreaterThan(0);

        // 一致すべきフィールド(boss拘束力のある補足3のスコープ)。結果オブジェクト全体の
        // toEqualは使わない(差し替えた1頭のexcludedReason/placeOddsMin・
        // diagnostics.oddsMalformedCountは意図的に差が出るため)。
        expect(contaminatedResult.totalStake).toBe(controlResult.totalStake);
        expect(contaminatedResult.skipReason).toBe(controlResult.skipReason);
        expect(contaminatedResult.kellyTargetStake).toBe(controlResult.kellyTargetStake);
        expect(contaminatedResult.capApplied).toBe(controlResult.capApplied);
        expect(contaminatedResult.minimumStakeApplied).toBe(controlResult.minimumStakeApplied);
        expect(contaminatedResult.betCount).toBe(controlResult.betCount);
        expect(contaminatedResult.notDiversified).toBe(controlResult.notDiversified);
        expect(contaminatedHealthy.stake).toBe(controlHealthy.stake);
        expect(contaminatedHealthy.continuousFraction).toBe(controlHealthy.continuousFraction);
        expect(contaminatedHealthy.scaledFraction).toBe(controlHealthy.scaledFraction);
        expect(contaminatedResult.diagnostics.placeProbSum).toBe(controlResult.diagnostics.placeProbSum);
        expect(contaminatedResult.diagnostics.marginalDeviationMax).toBe(
          controlResult.diagnostics.marginalDeviationMax,
        );
        expect(contaminatedResult.diagnostics.candidateCount).toBe(controlResult.diagnostics.candidateCount);
        expect(contaminatedResult.diagnostics.excludedCount).toBe(controlResult.diagnostics.excludedCount);

        // 一致しなくてよい(むしろ差が出るのが正しい)側の明示的な固定(boss拘束力のある補足3)。
        const contaminatedRow = contaminatedResult.allocations.find((a) => a.umaban === 2)!;
        const controlRow = controlResult.allocations.find((a) => a.umaban === 2)!;
        expect(contaminatedRow.excludedReason).toBe("複勝オッズ下限が不正な値のため対象外");
        expect(controlRow.excludedReason).toBe("複勝オッズ下限が未確定のため対象外");
        expect(Number.isNaN(contaminatedRow.placeOddsMin as number)).toBe(true);
        expect(controlRow.placeOddsMin).toBeNull();
        expect(contaminatedResult.diagnostics.oddsMalformedCount).toBe(1);
        expect(controlResult.diagnostics.oddsMalformedCount).toBe(0);
      });
    });

    describe("skipReasonの特性化(boss差し戻し・要修正1)", () => {
      // 【この経路が偽の原因を報告する現状(本タスクでは是正しない)】
      // isPositive===trueと判定された馬(ev = prob × odds なので、oddsがInfinityならev=Infinity
      // > 閾値でisPositive=trueになりうる。#31本文が挙げている組み合わせ)が、不正なオッズのため
      // 候補フィルタで全頭除外されると、candidateHorses.length===0になり、
      // determineSkipReasonCode(allocation-primitives.ts)は「候補0頭」を無条件に
      // no-candidates(文言「EVプラスの馬がいないため見送りです」)へ分類する。
      // しかし実際には「EVプラスと判定した馬は存在した(isPositive===trueだった)」のであり、
      // 見送りの真の原因は「そのオッズが判定不能(不正な値)だった」ことである。
      // 同じ BetAllocationResult の中で、skipReason(「EVプラスの馬がいない」)と
      // allocations[].excludedReason(「オッズ下限が不正な値のため対象外」)が矛盾した説明を
      // 同時に返す状態は本テスト作成時点で解消されていない。
      //
      // 【今回是正しない理由(boss指示・記録用)】
      // 1. #31の処方箋(boss着手前ゲートで合意したブリーフ)に専用skipReasonの新設は無い。
      // 2. 文言の出し分けはUI側の受け皿設計(見送り理由をどう表示し直すか)と一緒に決めるべきで、
      //    本タスク単独で先取りすると設計の手戻りを招く(後続タスクで扱う)。
      // 3. 修正前(#31着手前)は同じ入力が「妙味が小さく…」(#31再現ログと同じ偽の理由)に
      //    化けていたため、本タスクの変更は「偽の理由を出す」という状態を悪化させてはいない
      //    (原因の文言は変わったが、依然として偽である点は変わらない)。
      //
      // 本テストは「現状の挙動を変えない」ことを保証する特性化テストであり、上記の矛盾が
      // 解消されていないことを可視化する目的で残す(将来この経路を直す際の回帰検出にもなる)。
      it("EVプラス判定の馬が全員不正オッズのとき、skipReasonは真の原因(判定不能)を名指しせず" +
        "「EVプラスの馬がいない」という判定結果の文言になること(現状の固定・是正は別タスク)", () => {
        const horses: AllocationHorse[] = [
          // isPositive===trueだがplaceOddsMin=Infinityで不正(#31本文が挙げた組み合わせ)。
          { umaban: 1, placeProb: 0.5, placeOddsMin: Number.POSITIVE_INFINITY, ev: Number.POSITIVE_INFINITY, isPositive: true },
          nonCandidate(2, 0.3, 2), // 通常のEVマイナス(不正値ではない)
        ];
        const result = allocateBets(horses, 2, config({ bankroll: 10000, perRaceCap: 10000 }));

        // 前提固定: 候補が実際に0頭になり、見送りになること(空振り防止)。
        expect(result.diagnostics.candidateCount).toBe(0);
        expect(result.diagnostics.excludedCount).toBe(2);
        expect(result.isSkip).toBe(true);

        // 【本題】skipReasonは「EVプラスの馬がいない」という判定結果の文言になる
        // (真の原因=判定不能ではない。矛盾の固定)。
        expect(result.skipReason).toBe("EVプラスの馬がいないため見送りです");

        // 真の原因を示す情報はdiagnostics.oddsMalformedCountとexcludedReasonにのみ残る
        // (skipReasonからは読み取れないことの対比)。
        expect(result.diagnostics.oddsMalformedCount).toBe(1);
        expect(result.allocations.find((a) => a.umaban === 1)!.excludedReason).toBe(
          "複勝オッズ下限が不正な値のため対象外",
        );
      });
    });
  });
});
