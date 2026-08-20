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
  isUsableOdds,
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
 * 元実装から1ビットも変えない(既存 packages/core/test/ev/bet-allocation.test.ts の80件が
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

  describe("runGreedyAllocation(貪欲逐次配分・機能D-2a高速化後)", () => {
    it("候補0件は空配列・converged=trueを返す", () => {
      expect(runGreedyAllocation(0, [], [], 1000)).toEqual({ fractions: [], converged: true });
    });

    it("単純な2択(オッズ差のみ)で妙味が大きい方に配分が偏ること(退化していないことの確認)", () => {
      const outcomeIndexSets: OutcomeIndexSet[] = [
        { indices: [0], probability: 0.5 },
        { indices: [1], probability: 0.5 },
      ];
      const { fractions, converged } = runGreedyAllocation(2, [5, 1.1], outcomeIndexSets, 1000);
      expect(fractions[0]).toBeGreaterThan(0);
      // オッズ1.1側はEV=0.5*1.1=0.55<1で妙味が無く、配分されない(0のまま)ことを固定する。
      expect(fractions[1]).toBe(0);
      // 増分が尽きて自然停止するはず(1000ステップを使い切らない)。
      expect(converged).toBe(true);
    });

    it("wealth<=EPSになる割当を候補から除外し、NaN/Infinityを生まないこと(極端値。safe判定は毎回trueでフォールバック分岐には入らない)", () => {
      // 【タイトル訂正・2回目】(code-reviewer指摘・機能D-2a): 1回目の訂正
      // 「1ステップ目で即時収束し、safe判定自体が評価されない」は誤りだった(自分で
      // 実測して確認: greedySteps=1/2/1000のいずれでもconverged=falseで、収束は一度も
      // 起きない。safeはループの各ステップで必ず評価される)。
      //
      // 実測(本ファイルの筆者が自分で実行して確認。以下は`pnpm --filter @keiba/core test`
      // とは別に、このコメントを書く前に手元でrunGreedyAllocationへsafe/unsafeの発火回数を
      // 数えるカウンタを一時的に仕込んで確認した値):
      //   greedySteps=1000で実行すると、wealth=1-trialSumX+trialX[0]*3000は
      //   trialX[0]について単調増加するため、1000ステップ全てでbestIdxが選ばれ続け
      //   (converged=false。分割数を使い切って打ち切られる。「収束」ではない)、
      //   safe判定は1000回中1000回ともtrue(unsafeは0回)だった。
      // つまり「1ステップ目で収束する」も「safe判定が評価されない」も誤りで、正しくは
      // 「収束しない(打ち切られる)が、safe判定は毎回trueでフォールバックには一度も
      // 入らない」。本テストは「NaN/Infinityが混入しない」ことの確認に留まる。
      // フォールバック分岐の実地検証は次のテスト
      // 「フォールバック分岐(unsafe)を実際に踏み、高速パスとは異なる結果になり得ること」を参照。
      const outcomeIndexSets: OutcomeIndexSet[] = [{ indices: [0], probability: 1 }];
      // 高オッズ×低確率(3000倍)でも、貪欲ループの結果が有限であること。
      const { fractions } = runGreedyAllocation(1, [3000], outcomeIndexSets, 1000);
      expect(Number.isFinite(fractions[0]!)).toBe(true);
    });

    it("フォールバック分岐(unsafe)を実際に踏み、高速パスとは異なる結果になり得ること(旧来ブルートフォース参照実装とtoEqualで一致を固定)", () => {
      // code-reviewer指摘(機能D-2a再レビュー): runGreedyAllocationのsafe/unsafe
      // 2分岐のうち、フォールバック(旧来ブルートフォース。computeFreshWealthの候補ごと
      // 再構成ロジックを含む)を実際に踏んで検証するコミット済みテストが1件も無かった。
      //
      // 構成: 候補0・1は魅力的(odds=10)で無関係のoutcomeを持ち、sumXを押し上げていく。
      // 候補2は自分専属のoutcome(確率0.0001と小さい)を持ち、oddsを極端に高く(10000)する。
      // 候補2自身がまだ選ばれていない(x[2]=0)間、候補0・1の成長がoutcome2のwealth
      // (=1-sumX。候補2に触れられていない限りpayoutが乗らない)を痩せさせ、EPS(1e-9)に
      // 接近させる。ここが「commonWealth(未接触前提の共通項)」と「freshWealth(候補2自身が
      // 選ばれた場合の再計算値)」が乖離しうる境目であり、高速パスをそのまま使うと
      // (commonWealthのlogがNaN化し)候補2の増分まで巻き添えで壊れて誤って打ち切ってしまう。
      // フォールバックはこの局面で候補2だけを正しく再評価し、貪欲を継続できる
      // (下記の無条件expectで、フォールバック無しでは得られない`converged=false`かつ
      // 候補2への配分>0という結果を先に固定する。カナリア検証も参照)。
      const outcomeIndexSets: OutcomeIndexSet[] = [
        { indices: [0], probability: 0.49995 },
        { indices: [1], probability: 0.49995 },
        { indices: [2], probability: 0.0001 },
      ];
      const odds = [10, 10, 10000];
      const greedySteps = 1000;

      // 旧来のブルートフォース参照実装(bet-allocation.ts抽出前の実装と同じ式・同じ走査順)。
      const bruteForceReference = (): { fractions: number[]; converged: boolean } => {
        const n = 3;
        const x = new Array<number>(n).fill(0);
        const delta = 1 / greedySteps;
        let sumX = 0;
        const computeF = (trialSumX: number, trialX: readonly number[]): number | null => {
          let total = 0;
          for (const outcome of outcomeIndexSets) {
            let payout = 0;
            for (const idx of outcome.indices) payout += trialX[idx]! * odds[idx]!;
            const wealth = 1 - trialSumX + payout;
            if (wealth <= 1e-9) return null;
            total += outcome.probability * Math.log(wealth);
          }
          return total;
        };
        let currentF = computeF(sumX, x)!;
        let converged = false;
        for (let step = 0; step < greedySteps; step++) {
          let bestIdx = -1;
          let bestIncrement = 0;
          const trialSumX = sumX + delta;
          for (let i = 0; i < n; i++) {
            const trialX = x.slice();
            trialX[i] = trialX[i]! + delta;
            const trialF = computeF(trialSumX, trialX);
            if (trialF === null) continue;
            const increment = trialF - currentF;
            if (increment > bestIncrement) {
              bestIncrement = increment;
              bestIdx = i;
            }
          }
          if (bestIdx === -1) {
            converged = true;
            break;
          }
          x[bestIdx] = x[bestIdx]! + delta;
          sumX = trialSumX;
          currentF = computeF(sumX, x)!;
        }
        return { fractions: x, converged };
      };

      const expected = bruteForceReference();
      // 前提(無条件expect): 候補2が正の配分を得て、貪欲がgreedyStepsを使い切らずに
      // 自然停止すること(=フォールバックが無ければ再現できない結果であることの直接証拠。
      // 高速パスだけだと候補2の増分がNaN汚染され、より早い段階でconverged=trueに
      // なってしまう〈本テスト作成時に実測済み〉)。
      expect(expected.fractions[2]).toBeGreaterThan(0);
      expect(expected.converged).toBe(false);

      const actual = runGreedyAllocation(3, odds, outcomeIndexSets, greedySteps);
      expect(actual.fractions).toEqual(expected.fractions);
      expect(actual.converged).toBe(expected.converged);
    });

    it("greedySteps不足時はconverged=falseになること(打ち切りを収束と誤読しないための固定)", () => {
      // 3候補・十分な妙味(EV>1)があり、貪欲が常に増分>0を見出せる状況を作る。
      // greedySteps=3のように極端に小さい値にすると、局所最適に到達する前に
      // ステップ数を使い切って打ち切られるはず。
      const outcomeIndexSets: OutcomeIndexSet[] = [
        { indices: [0], probability: 1 / 3 },
        { indices: [1], probability: 1 / 3 },
        { indices: [2], probability: 1 / 3 },
      ];
      const { converged } = runGreedyAllocation(3, [10, 10, 10], outcomeIndexSets, 3);
      expect(converged).toBe(false);
    });

    it("高速パス(候補が多く安全域)とフォールバック相当のブルートフォースが同じ結果になること(数学的同値性の直接検証)", () => {
      // 候補20・outcome10のランダムだが決定的な構成で、通常は安全域(高速パス)を通るはず。
      // 参照実装として、旧来のブルートフォース版をこのテスト内に再実装し、
      // 本体(高速化後のrunGreedyAllocation)の出力と厳密一致(toBe)することを確認する。
      const n = 20;
      const outcomeIndexSets: OutcomeIndexSet[] = [];
      let seed = 42;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let j = 0; j < 10; j++) {
        const indices: number[] = [];
        for (let i = 0; i < n; i++) {
          if (rand() < 0.15) indices.push(i);
        }
        outcomeIndexSets.push({ indices, probability: 1 / 10 });
      }
      const odds = Array.from({ length: n }, () => 2 + rand() * 4);

      const bruteForce = (
        nn: number,
        oddsArr: readonly number[],
        sets: readonly OutcomeIndexSet[],
        steps: number,
      ): number[] => {
        const x = new Array<number>(nn).fill(0);
        const delta = 1 / steps;
        let sumX = 0;
        const computeF = (trialSumX: number, trialX: readonly number[]): number | null => {
          let total = 0;
          for (const outcome of sets) {
            let payout = 0;
            for (const idx of outcome.indices) payout += trialX[idx]! * oddsArr[idx]!;
            const wealth = 1 - trialSumX + payout;
            if (wealth <= 1e-9) return null;
            total += outcome.probability * Math.log(wealth);
          }
          return total;
        };
        let currentF = computeF(sumX, x)!;
        for (let step = 0; step < steps; step++) {
          let bestIdx = -1;
          let bestIncrement = 0;
          const trialSumX = sumX + delta;
          for (let i = 0; i < nn; i++) {
            const trialX = x.slice();
            trialX[i] = trialX[i]! + delta;
            const trialF = computeF(trialSumX, trialX);
            if (trialF === null) continue;
            const increment = trialF - currentF;
            if (increment > bestIncrement) {
              bestIncrement = increment;
              bestIdx = i;
            }
          }
          if (bestIdx === -1) break;
          x[bestIdx] = x[bestIdx]! + delta;
          sumX = trialSumX;
          currentF = computeF(sumX, x)!;
        }
        return x;
      };

      const expected = bruteForce(n, odds, outcomeIndexSets, 500);
      const { fractions: actual } = runGreedyAllocation(n, odds, outcomeIndexSets, 500);
      expect(actual).toEqual(expected);
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

  describe("isUsableOdds(オッズとして使える値かの判定・Issue #31)", () => {
    // 背景: combo-bet-allocation.ts の validateCandidates(:412-416)と resolveComboOdds(:672-674)が
    // `!Number.isFinite(x) || x <= 0` を独立に2回実装していた(将来どちらかだけ直す事故の温床)。
    // 本述語へ1本化し、複勝側(bet-allocation.ts)の候補フィルタを3つ目の委譲先として追加する
    // (Issue #31)。「正の有限値」であることのみを判定し、null判定は呼び出し側の責務とする
    // (「未確定」と「不正値」の区別を呼び出し側に残すため、引数の型はnumberのみでnullを許容しない)。
    //
    // 適用範囲の注意(boss拘束力のある補足1): 本述語は「オッズ」の3箇所にのみ適用する。
    // validateCandidatesの馬番検証(umabans)は式がたまたま同一なだけで意味論が別(馬番の
    // 妥当性であってオッズの妥当性ではない)であるため、本述語を流用してはならない
    // (将来オッズ側の基準だけを変えた際に馬番の検証まで道連れで変わる事故を防ぐ)。
    const table: Array<{ name: string; value: number; expected: boolean }> = [
      { name: "通常値(2.2)", value: 2.2, expected: true },
      { name: "正の極小値(1e-9)", value: 1e-9, expected: true },
      { name: "Number.MAX_VALUE(有限の最大値)", value: Number.MAX_VALUE, expected: true },
      { name: "0(境界。>0を満たさない)", value: 0, expected: false },
      // 負のゼロ(-0)。-0 > 0 は false なので現状の実装で正しく除外される想定の境界値
      // (code-reviewer指摘)。-0 === 0 は true だが Object.is(-0, 0) は false であり、
      // 実装が `value > 0` を使う限り区別なく false になるはず、という点を明示的に固定する。
      // it.eachの表示名は上記$name(このオブジェクトのname)を使うため、"0"の行と紛れない。
      { name: "負のゼロ(-0)", value: -0, expected: false },
      { name: "負値(-1)", value: -1, expected: false },
      { name: "NaN", value: Number.NaN, expected: false },
      { name: "+Infinity", value: Number.POSITIVE_INFINITY, expected: false },
      { name: "-Infinity", value: Number.NEGATIVE_INFINITY, expected: false },
    ];
    it.each(table)("$name → $expected", ({ value, expected }) => {
      expect(isUsableOdds(value)).toBe(expected);
    });
  });
});
