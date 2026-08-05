import { describe, expect, it } from "vitest";
import {
  applyMinimumStake,
  buildOutcomeIndexSets,
  computeKellyTarget,
  DEFAULT_BET_UNIT,
  DEFAULT_GREEDY_STEPS,
  DEFAULT_KELLY_FRACTION,
  determineSkipReasonCode,
  foldToCandidateSubsets,
  resolveBankroll,
  resolveBetUnit,
  resolveEffectivePerRaceCap,
  resolveGreedySteps,
  resolveKellyFraction,
  roundStakes,
  runGreedyAllocation,
  type OutcomeIndexSet,
} from "../../src/ev/allocation-primitives.js";
import type { PlaceOutcome } from "../../src/ev/place-joint-model.js";

/**
 * allocation-primitives — 機能D-2a(Issue #14)で bet-allocation.ts から抽出した
 * 券種非依存プリミティブの単体テスト。
 *
 * 抽出方針(boss決定・2026-08-05): 防御関数群・貪欲最適化・畳み込み・betUnit丸め・
 * キャップ比例縮小のゼロ除算ガード・最低額ロジックの数値部分・見送り理由の判定ロジック
 * (文言を除く)は複勝経路と組合せ経路で同一実装を共有する。挙動は bet-allocation.ts の
 * 元実装から1ビットも変えない(既存 packages/core/test/ev/bet-allocation.test.ts の73件が
 * 無改変のまま全件パスすることで検証する。本ファイルはそれとは別に、抽出した各プリミティブを
 * 直接ユニットテストする)。
 */
describe("allocation-primitives(券種非依存プリミティブ・機能D-2a)", () => {
  describe("resolveBankroll(総資金の解決)", () => {
    it("正の有限値はそのまま返す(切り捨てない)", () => {
      expect(resolveBankroll(12345)).toBe(12345);
    });

    it("0以下・非有限は0にクランプする", () => {
      expect(resolveBankroll(0)).toBe(0);
      expect(resolveBankroll(-100)).toBe(0);
      expect(resolveBankroll(Number.NaN)).toBe(0);
      expect(resolveBankroll(Number.POSITIVE_INFINITY)).toBe(0);
      expect(resolveBankroll(Number.NEGATIVE_INFINITY)).toBe(0);
    });
  });

  describe("resolveBetUnit(賭け金の最小単位の解決)", () => {
    it("正の整数はそのまま返す", () => {
      expect(resolveBetUnit(500)).toBe(500);
    });

    it("非有限・0以下・非整数は既定値(100)へフォールバックする", () => {
      expect(resolveBetUnit(0)).toBe(DEFAULT_BET_UNIT);
      expect(resolveBetUnit(-100)).toBe(DEFAULT_BET_UNIT);
      expect(resolveBetUnit(Number.NaN)).toBe(DEFAULT_BET_UNIT);
      expect(resolveBetUnit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BET_UNIT);
      expect(resolveBetUnit(33.5)).toBe(DEFAULT_BET_UNIT);
    });
  });

  describe("resolveGreedySteps(貪欲分割数の解決)", () => {
    it("正の整数はそのまま返す", () => {
      expect(resolveGreedySteps(2000)).toBe(2000);
    });

    it("非有限・0以下・非整数は既定値(1000)へフォールバックする", () => {
      expect(resolveGreedySteps(0)).toBe(DEFAULT_GREEDY_STEPS);
      expect(resolveGreedySteps(-5)).toBe(DEFAULT_GREEDY_STEPS);
      expect(resolveGreedySteps(Number.NaN)).toBe(DEFAULT_GREEDY_STEPS);
      expect(resolveGreedySteps(Number.POSITIVE_INFINITY)).toBe(DEFAULT_GREEDY_STEPS);
    });
  });

  describe("resolveKellyFraction(ケリー係数の解決)", () => {
    it("[0,1]の値はそのまま返す", () => {
      expect(resolveKellyFraction(0.3)).toBe(0.3);
      expect(resolveKellyFraction(0)).toBe(0);
      expect(resolveKellyFraction(1)).toBe(1);
    });

    it("範囲外・非有限は既定値(0.5)へフォールバックする", () => {
      expect(resolveKellyFraction(1.5)).toBe(DEFAULT_KELLY_FRACTION);
      expect(resolveKellyFraction(-0.5)).toBe(DEFAULT_KELLY_FRACTION);
      expect(resolveKellyFraction(Number.NaN)).toBe(DEFAULT_KELLY_FRACTION);
      expect(resolveKellyFraction(Number.POSITIVE_INFINITY)).toBe(DEFAULT_KELLY_FRACTION);
    });
  });

  describe("resolveEffectivePerRaceCap(1レース上限の解決・公開関数)", () => {
    it("正の値はbetUnitの倍数に切り捨てる", () => {
      expect(resolveEffectivePerRaceCap(2550, 100)).toBe(2500);
      expect(resolveEffectivePerRaceCap(150.7, 100)).toBe(100);
    });

    it("負値・0・非有限は0(負のcapを作らない)", () => {
      expect(resolveEffectivePerRaceCap(-50, 100)).toBe(0);
      expect(resolveEffectivePerRaceCap(0, 100)).toBe(0);
      expect(resolveEffectivePerRaceCap(Number.NaN, 100)).toBe(0);
    });

    it("betUnitが異常値でも既定100へ内部フォールバックする", () => {
      expect(resolveEffectivePerRaceCap(2550, 0)).toBe(2500);
      expect(resolveEffectivePerRaceCap(2550, Number.NaN)).toBe(2500);
    });
  });

  describe("foldToCandidateSubsets(部分集合への畳み込み)", () => {
    it("候補集合との交差でoutcomeを合算すること(候補外の馬は畳み込まれる)", () => {
      const raw: PlaceOutcome[] = [
        { placed: [1, 2, 3], probability: 0.3 },
        { placed: [1, 2, 4], probability: 0.2 },
        { placed: [1, 3, 4], probability: 0.1 },
        { placed: [2, 3, 4], probability: 0.4 },
      ];
      // 候補は {1,2} のみ(3,4は候補外)。
      const folded = foldToCandidateSubsets(raw, new Set([1, 2]));
      // {1,2,3}→{1,2}, {1,2,4}→{1,2}: 合算されて0.5。
      // {1,3,4}→{1}: 0.1。{2,3,4}→{2}: 0.4。
      const byKey = new Map(folded.map((o) => [[...o.placed].sort((a, b) => a - b).join(","), o.probability]));
      expect(byKey.get("1,2")).toBeCloseTo(0.5, 10);
      expect(byKey.get("1")).toBeCloseTo(0.1, 10);
      expect(byKey.get("2")).toBeCloseTo(0.4, 10);
    });

    it("合算しても確率の総和は1のまま保たれること(自明でない: 畳み込みで確率を落とさないことの確認)", () => {
      const raw: PlaceOutcome[] = [
        { placed: [1, 2], probability: 0.6 },
        { placed: [3, 4], probability: 0.4 },
      ];
      const folded = foldToCandidateSubsets(raw, new Set([1, 3]));
      const total = folded.reduce((acc, o) => acc + o.probability, 0);
      expect(total).toBeCloseTo(1, 10);
    });
  });

  describe("buildOutcomeIndexSets(的中判定の一般化: isHitで馬/組を切り替え)", () => {
    it("単一馬の的中判定(umaban member判定)で従来と同じ結果になること", () => {
      const candidates = [{ umaban: 1 }, { umaban: 2 }];
      const folded: PlaceOutcome[] = [
        { placed: [1], probability: 0.3 },
        { placed: [2], probability: 0.3 },
        { placed: [1, 2], probability: 0.4 },
      ];
      const sets = buildOutcomeIndexSets(candidates, folded, (c, o) => o.placed.includes(c.umaban));
      expect(sets[0]).toEqual({ indices: [0], probability: 0.3 });
      expect(sets[1]).toEqual({ indices: [1], probability: 0.3 });
      expect(sets[2]).toEqual({ indices: [0, 1], probability: 0.4 });
    });

    it("組合せ(部分集合包含)の的中判定を独自に定義できること(券種非依存性の確認)", () => {
      const candidates = [{ umabans: [1, 2] }, { umabans: [1, 3] }];
      const folded: PlaceOutcome[] = [
        { placed: [1, 2, 3], probability: 1 }, // 両方の組がここに含まれる
      ];
      const sets = buildOutcomeIndexSets(candidates, folded, (c, o) =>
        c.umabans.every((u) => o.placed.includes(u)),
      );
      expect(sets[0]).toEqual({ indices: [0, 1], probability: 1 });
    });
  });

  describe("runGreedyAllocation(貪欲逐次配分)", () => {
    it("候補0件は空配列を返す", () => {
      expect(runGreedyAllocation(0, [], [], 1000)).toEqual([]);
    });

    it("単純な2択(オッズ差のみ)で妙味が大きい方に配分が偏ること(退化していないことの確認)", () => {
      const outcomeIndexSets: OutcomeIndexSet[] = [
        { indices: [0], probability: 0.5 },
        { indices: [1], probability: 0.5 },
      ];
      const x = runGreedyAllocation(2, [5, 1.1], outcomeIndexSets, 1000);
      expect(x[0]).toBeGreaterThan(0);
      // オッズ1.1側はEV=0.5*1.1=0.55<1で妙味が無く、配分されない(0のまま)ことを固定する。
      expect(x[1]).toBe(0);
    });

    it("wealth<=EPSになる割当を候補から除外し、NaN/Infinityを生まないこと(極端値)", () => {
      const outcomeIndexSets: OutcomeIndexSet[] = [{ indices: [0], probability: 1 }];
      // 高オッズ×低確率(3000倍)でも、貪欲ループの結果が有限であること。
      const x = runGreedyAllocation(1, [3000], outcomeIndexSets, 1000);
      expect(Number.isFinite(x[0]!)).toBe(true);
    });
  });

  describe("computeKellyTarget(ケリー適正額・キャップ・比例縮小係数s)", () => {
    it("kellyTargetStakeがeffectivePerRaceCapを超えないときcapApplied=false・s=1相当", () => {
      const r = computeKellyTarget(0.5, 0.4, 10000, 100000);
      expect(r.kellyTargetStake).toBe(0.5 * 0.4 * 10000);
      expect(r.capApplied).toBe(false);
      expect(r.plannedStake).toBe(r.kellyTargetStake);
    });

    it("kellyTargetStake=0のときs=0(ゼロ除算ガード。NaNにならない)", () => {
      const r = computeKellyTarget(0, 0, 10000, 10000);
      expect(r.kellyTargetStake).toBe(0);
      expect(r.s).toBe(0);
      expect(Number.isFinite(r.s)).toBe(true);
    });

    it("上限拘束時はcapApplied=true・s=effectivePerRaceCap/kellyTargetStake", () => {
      const r = computeKellyTarget(1, 1, 10000, 3000);
      expect(r.kellyTargetStake).toBe(10000);
      expect(r.capApplied).toBe(true);
      expect(r.s).toBeCloseTo(0.3, 10);
      expect(r.plannedStake).toBe(3000);
    });
  });

  describe("roundStakes(betUnit丸め。剰余は再配分しない)", () => {
    it("continuousFraction比のstakeをbetUnit単位へ切り捨てること", () => {
      const r = roundStakes([0.6, 0.3], 1, 1, 10000, 100);
      // scaledFraction=0.6,0.3。s=1。raw = floor(0.6*10000/100)*100=6000, floor(0.3*10000/100)*100=3000
      expect(r.rawStakes).toEqual([6000, 3000]);
      expect(r.totalStake).toBe(9000);
    });

    it("betUnit未満に切り捨てられたら0円になること(妙味はあるが丸めで消える)", () => {
      const r = roundStakes([0.001], 1, 1, 10000, 100);
      // 0.001*10000=10 < betUnit(100) → 0円
      expect(r.rawStakes).toEqual([0]);
      expect(r.totalStake).toBe(0);
    });
  });

  describe("applyMinimumStake(最低額ロジック・4条件)", () => {
    it("4条件を全て満たすときcontinuousFraction最大の1頭にbetUnitを与えること", () => {
      const r = applyMinimumStake([0, 0], [0.3, 0.7], 0, 2, 10000, 10000, 100, 50);
      expect(r.minimumStakeApplied).toBe(true);
      expect(r.rawStakes).toEqual([0, 100]);
      expect(r.totalStake).toBe(100);
    });

    it("totalStakeが既に正のときは適用しないこと(全馬0円の場合のみ介入)", () => {
      const r = applyMinimumStake([100, 0], [0.3, 0.7], 100, 2, 10000, 10000, 100, 50);
      expect(r.minimumStakeApplied).toBe(false);
      expect(r.rawStakes).toEqual([100, 0]);
    });

    it("kellyTargetStake===0のときは適用しないこと(λ=0の明示的指定を尊重)", () => {
      const r = applyMinimumStake([0, 0], [0.3, 0.7], 0, 2, 10000, 10000, 100, 0);
      expect(r.minimumStakeApplied).toBe(false);
      expect(r.totalStake).toBe(0);
    });

    it("effectivePerRaceCap<betUnitのときは適用しないこと(上限不足を救済しない)", () => {
      const r = applyMinimumStake([0, 0], [0.3, 0.7], 0, 2, 10000, 50, 100, 50);
      expect(r.minimumStakeApplied).toBe(false);
    });

    it("同値タイブレークは先頭(呼び出し側が優先順で並べたインデックス順)が勝つこと", () => {
      const r = applyMinimumStake([0, 0], [0.5, 0.5], 0, 2, 10000, 10000, 100, 50);
      expect(r.rawStakes).toEqual([100, 0]);
    });
  });

  describe("determineSkipReasonCode(見送り理由コードの判定・6分類優先順位。文言は含まない)", () => {
    const table: Array<{
      name: string;
      args: readonly [number, number, number, number, number, number, number];
      expected: ReturnType<typeof determineSkipReasonCode>;
    }> = [
      { name: "①総資金未設定", args: [0, 10000, 10000, 100, 0, 0.5, 1], expected: "bankroll-unset" },
      { name: "②上限未設定", args: [10000, 0, 0, 100, 0, 0.5, 1], expected: "cap-unset" },
      { name: "③上限不足", args: [10000, 50, 0, 100, 0, 0.5, 1], expected: "cap-too-small" },
      { name: "④ケリー係数0", args: [10000, 10000, 10000, 100, 0, 0, 1], expected: "kelly-zero" },
      { name: "⑤候補0頭", args: [10000, 10000, 10000, 100, 0, 0.5, 0], expected: "no-candidates" },
      { name: "⑥妙味小", args: [10000, 10000, 10000, 100, 0, 0.5, 1], expected: "no-edge" },
    ];
    it.each(table)("$name → $expected", ({ args, expected }) => {
      expect(determineSkipReasonCode(...args)).toBe(expected);
    });

    it("優先順位: bankroll未設定かつperRaceCap未設定 → bankroll-unsetが優先されること", () => {
      expect(determineSkipReasonCode(0, 0, 0, 100, 0, 0.5, 1)).toBe("bankroll-unset");
    });

    it("優先順位: λ=0かつ候補0頭 → kelly-zeroが優先されること(no-candidatesではない)", () => {
      expect(determineSkipReasonCode(10000, 10000, 10000, 100, 0, 0, 0)).toBe("kelly-zero");
    });
  });
});
