import { describe, expect, it } from "vitest";
import {
  ALL_SKIP_REASON_CODES,
  applyMinimumStake,
  buildOutcomeIndexSets,
  computeKellyTarget,
  DEFAULT_BET_UNIT,
  DEFAULT_GREEDY_STEPS,
  DEFAULT_KELLY_FRACTION,
  determineSkipReasonCode,
  foldOutcomeIndexSetsBySignature,
  foldToCandidateSubsets,
  isUsableOdds,
  MIN_VALID_ODDS,
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
import { computeRaceEv, type HorsePrior } from "../../src/ev/expected-value.js";
import type { OddsSnapshot, PlaceOdds } from "../../src/scraper/types.js";

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

  describe("foldOutcomeIndexSetsBySignature(indices署名畳み込み・Issue #96)", () => {
    // 背景: 単勝(win)候補が1件でもあると、combo-bet-allocation.tsのdetermined枝が
    // 順序付きoutcome空間(P(頭数,topFinishCount)通り、畳み込み無し)をそのままrunGreedyAllocation/
    // computeHitProbabilitiesへ渡すため計算量が跳ね上がる(Issue #96)。的中パターン(indices)が
    // 完全一致するoutcomeは`wealth_T`が同一なので、`P1·log(w)+P2·log(w)=(P1+P2)·log(w)`により
    // 確率を合算しても厳密に等価(win識別性〈indices列そのもの〉は一切失わない。
    // foldToCandidateSubsetsとは異なる畳み込みであることに注意: foldToCandidateSubsetsは
    // `placed`を候補集合と交差させ昇順ソートする「順序を捨てる」畳み込みであり、winの
    // identity判定〈order[0]===umaban〉を壊すため通せない。本関数はindices列自体を一切
    // 変更せず、同じindices列を持つ要素をまとめるだけなので、win識別性を壊さない)。
    it("(a)(b) 同一署名(indices完全一致)のoutcomeをまとめ、件数が減り確率総和が保存されること(値を直書きで固定)", () => {
      const input: OutcomeIndexSet[] = [
        { indices: [0, 2], probability: 0.1 },
        { indices: [1], probability: 0.2 },
        { indices: [0, 2], probability: 0.3 }, // 署名[0,2]がinput[0]と重複
        { indices: [], probability: 0.4 },
      ];
      const folded = foldOutcomeIndexSetsBySignature(input);
      // (a) 4件→3件(署名[0,2]の2件が1件にまとまる。件数を直書きで固定)。
      expect(folded).toHaveLength(3);
      const byKey = new Map(folded.map((o) => [o.indices.join(","), o.probability]));
      expect(byKey.get("0,2")).toBeCloseTo(0.4, 10); // 0.1+0.3
      expect(byKey.get("1")).toBeCloseTo(0.2, 10);
      expect(byKey.get("")).toBeCloseTo(0.4, 10);
      // (b) 確率総和が保存されること(自明でない: 畳み込みで確率を落とさないことの確認)。
      const total = folded.reduce((sum, o) => sum + o.probability, 0);
      expect(total).toBeCloseTo(1.0, 10);
    });

    it("(c) 署名がすべて異なる入力では件数・順序・probabilityが入力と完全に一致すること(ビット等価)", () => {
      const input: OutcomeIndexSet[] = [
        { indices: [0], probability: 0.3 },
        { indices: [1], probability: 0.25 },
        { indices: [0, 1], probability: 0.45 },
      ];
      const folded = foldOutcomeIndexSetsBySignature(input);
      expect(folded).toHaveLength(3);
      for (let i = 0; i < input.length; i++) {
        expect(folded[i]!.indices).toEqual(input[i]!.indices);
        // toBeによるビット等価(toBeCloseToではない)。
        expect(folded[i]!.probability).toBe(input[i]!.probability);
      }
    });

    it("(d) 出力順が決定的であること(同じ入力で2回呼んでtoEqual)", () => {
      const input: OutcomeIndexSet[] = [
        { indices: [0, 2], probability: 0.1 },
        { indices: [1], probability: 0.2 },
        { indices: [0, 2], probability: 0.3 },
      ];
      const first = foldOutcomeIndexSetsBySignature(input);
      const second = foldOutcomeIndexSetsBySignature(input);
      expect(first).toEqual(second);
    });

    it("(e) 畳み込み前後でrunGreedyAllocationのfractionsがビット一致すること(確率をべき乗値で構成した代表的な単純入力)", () => {
      // 0.125+0.125=0.25はどちらも2進で厳密に表現できる値同士の加算(倍精度で丸め誤差が
      // 出ない)であり、「一致するフィクスチャを恣意的に選ぶ」のではなく、代表的な単純入力
      // (2候補・4outcome、うち1組が同一署名)でargmaxの選択列が畳み込み前後で変わらない
      // ことを実行して確認する目的で構成した(boss指摘: 中間値〈commonLogSum等〉の一致では
      // なくfractions自体の一致が目的。argmaxが変わらない限りfractionsは同じ加算列になる)。
      const unfolded: OutcomeIndexSet[] = [
        { indices: [0], probability: 0.125 },
        { indices: [0], probability: 0.125 }, // 署名[0]がunfolded[0]と重複
        { indices: [1], probability: 0.25 },
        { indices: [0, 1], probability: 0.5 },
      ];
      const odds = [3, 5];
      const folded = foldOutcomeIndexSetsBySignature(unfolded);
      // 前提(空振り防止): 実際に畳み込まれて件数が減っていること。
      expect(folded.length).toBeLessThan(unfolded.length);
      expect(folded).toHaveLength(3);

      for (const greedySteps of [10, 100, 1000]) {
        const before = runGreedyAllocation(2, odds, unfolded, greedySteps);
        const after = runGreedyAllocation(2, odds, folded, greedySteps);
        expect(Object.is(after.fractions[0], before.fractions[0])).toBe(true);
        expect(Object.is(after.fractions[1], before.fractions[1])).toBe(true);
        expect(after.converged).toBe(before.converged);
      }
    });

    it("indicesが空・候補0件・n=0の縮退入力で壊れないこと", () => {
      expect(foldOutcomeIndexSetsBySignature([])).toEqual([]);
      const onlyEmpty: OutcomeIndexSet[] = [
        { indices: [], probability: 0.6 },
        { indices: [], probability: 0.4 },
      ];
      const folded = foldOutcomeIndexSetsBySignature(onlyEmpty);
      expect(folded).toEqual([{ indices: [], probability: 1.0 }]);
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

    describe("高速パス(候補が多く安全域)とフォールバック相当のブルートフォースが同じ結果になること(数学的同値性の直接検証・テーブル駆動)", () => {
      // Issue #96(ビット厳密なメモ化。commonWealth[j]のlog・freshWealthの候補ごとの
      // 事前計算)がargmaxの選択を反転させていないかを検出する唯一の網(このファイルの
      // 他のテストはargmax反転を直接は検出しない)。
      // 【採用C(computeFreshWealthのO(1)化)は不採用】: 数学的には同値だが浮動小数演算として
      // ビット一致するとは限らず、実際に`bet-allocation.test.ts`の退化ケース(全odds=3で
      // 目的関数が平坦になる番人テスト)でargmax反転(betCount 2→1)を引き起こしたため
      // 不採用にした(`runGreedyAllocation`のJSDoc「検討したが採用しなかった案」参照)。
      // 本テーブルはこの反転を再現しなかった(4条件×2水準すべてtoEqual一致)が、それは
      // 「メモ化のみ(採用C抜き)ではargmax反転が起きない」ことの確認であり、Cを採用した
      // 場合に反転が起きないことの確認ではない(Cはproduction codeに存在しない)。
      // 参照実装(旧来のブルートフォース)は元のテストのものをそのまま使い、一切弱めない
      // (toEqualによる厳密一致を維持する)。
      //
      // ★boss指摘への対応: 候補数・outcome数・接触密度・オッズ分布の異なる4条件以上、
      // greedySteps2水準以上のテーブルへ拡張する(旧版は1条件・greedySteps=500のみだった)。
      // 旧版の条件(候補20・outcome10・接触密度0.15・オッズ2-6・greedySteps=500・seed=42)は
      // 下記シナリオ1つ目としてそのまま保持し、条件を追加する形で拡張する(既存の保証を
      // 弱めない)。
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

      /** 決定的な疑似乱数生成器(元テストと同じ線形合同法)。 */
      function makeRand(seed: number): () => number {
        let s = seed;
        return () => {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          return s / 0x7fffffff;
        };
      }

      function buildScenario(
        n: number,
        outcomeCount: number,
        contactProbability: number,
        oddsMin: number,
        oddsMax: number,
        seed: number,
      ): { outcomeIndexSets: OutcomeIndexSet[]; odds: number[] } {
        const rand = makeRand(seed);
        const outcomeIndexSets: OutcomeIndexSet[] = [];
        for (let j = 0; j < outcomeCount; j++) {
          const indices: number[] = [];
          for (let i = 0; i < n; i++) {
            if (rand() < contactProbability) indices.push(i);
          }
          outcomeIndexSets.push({ indices, probability: 1 / outcomeCount });
        }
        const odds = Array.from({ length: n }, () => oddsMin + rand() * (oddsMax - oddsMin));
        return { outcomeIndexSets, odds };
      }

      const scenarios: {
        readonly label: string;
        readonly n: number;
        readonly outcomeCount: number;
        readonly contactProbability: number;
        readonly oddsMin: number;
        readonly oddsMax: number;
        readonly seed: number;
      }[] = [
        {
          label: "候補20・outcome10・接触密度0.15・オッズ2-6(旧版と同条件)",
          n: 20,
          outcomeCount: 10,
          contactProbability: 0.15,
          oddsMin: 2,
          oddsMax: 6,
          seed: 42,
        },
        {
          label: "候補5・outcome3・接触密度0.6(高密度)・オッズ1.5-3(低オッズ)",
          n: 5,
          outcomeCount: 3,
          contactProbability: 0.6,
          oddsMin: 1.5,
          oddsMax: 3,
          seed: 7,
        },
        {
          label: "候補50・outcome30・接触密度0.05(低密度)・オッズ3-20(高オッズ)",
          n: 50,
          outcomeCount: 30,
          contactProbability: 0.05,
          oddsMin: 3,
          oddsMax: 20,
          seed: 123,
        },
        {
          label: "候補8・outcome60(候補数よりoutcome数が多い)・接触密度0.3・オッズ1.1-2(1.0近傍)",
          n: 8,
          outcomeCount: 60,
          contactProbability: 0.3,
          oddsMin: 1.1,
          oddsMax: 2,
          seed: 999,
        },
      ];
      const greedyStepsValues = [50, 500];

      for (const scenario of scenarios) {
        for (const greedySteps of greedyStepsValues) {
          it(`${scenario.label} / greedySteps=${greedySteps}`, () => {
            const { outcomeIndexSets, odds } = buildScenario(
              scenario.n,
              scenario.outcomeCount,
              scenario.contactProbability,
              scenario.oddsMin,
              scenario.oddsMax,
              scenario.seed,
            );
            const expected = bruteForce(scenario.n, odds, outcomeIndexSets, greedySteps);
            const { fractions: actual } = runGreedyAllocation(scenario.n, odds, outcomeIndexSets, greedySteps);
            expect(actual).toEqual(expected);
          });
        }
      }
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

  describe("ALL_SKIP_REASON_CODES(Issue #80 AC-A5: SkipReasonCodeを増やしていないことの機械検査)", () => {
    it("6値ちょうどであり、値の集合がリテラル配列と一致すること", () => {
      // 前提固定(空振り防止): 6という数はALL_SKIP_REASON_CODES.length自身からではなく、
      // このリテラル配列(実装からのimportではない、このテストが書く独立した期待値)から来る。
      const expected = [
        "bankroll-unset",
        "cap-unset",
        "cap-too-small",
        "kelly-zero",
        "no-candidates",
        "no-edge",
      ];
      expect(expected).toHaveLength(6);
      // 順序に依存しない比較(定義順が変わっても壊れないよう、両者をソートしてtoEqual)。
      expect([...ALL_SKIP_REASON_CODES].sort()).toEqual([...expected].sort());
    });

    it("重複が無いこと(Setに変換しても6件のまま)", () => {
      expect(new Set(ALL_SKIP_REASON_CODES).size).toBe(6);
    });
  });

  describe("isUsableOdds(オッズとして使える値かの判定・Issue #31→#74で1.0以上へ引き上げ)", () => {
    // 背景: combo-bet-allocation.ts の validateCandidates(:412-416)と resolveComboOdds(:672-674)が
    // `!Number.isFinite(x) || x <= 0` を独立に2回実装していた(将来どちらかだけ直す事故の温床)。
    // 本述語へ1本化し、複勝側(bet-allocation.ts)の候補フィルタを3つ目の委譲先として追加する
    // (Issue #31)。「1.0以上の有限値」であることのみを判定し、null判定は呼び出し側の責務とする
    // (「未確定」と「不正値」の区別を呼び出し側に残すため、引数の型はnumberのみでnullを許容しない)。
    //
    // #74: オッズの値域は「1.0以上」であり0は値域外(Issue #74)。旧基準`value > 0`は
    // [0,1)を通してしまい、複勝EV側(expected-value.ts)がoddsMin=0を「ev=0」という
    // 正常な判定結果に潰していた(判定不能と判定結果の混同)。基準を`value >= MIN_VALID_ODDS`
    // (1.0)へ引き上げ、全呼び出し元に同時適用する。
    // 数(単位を明記): #74着手前は呼び出し6・モジュール3(combo-bet-allocation.ts 2・
    // bet-allocation.ts 3・verify.ts 1)。本Issueで expected-value.ts・build-prompt.ts・
    // probability-quality-metrics.ts の3モジュールが新たに委譲し、#74後は呼び出し9・
    // モジュール6になる(詳細・再現コマンドは allocation-primitives.ts の isUsableOdds JSDoc参照)。
    //
    // 適用範囲の注意(boss拘束力のある補足1): 本述語は「オッズ」の判定にのみ適用する
    // (呼び出し箇所の数は上記のとおり変動するため、ここでは数を断定しない)。
    // validateCandidatesの馬番検証(umabans)は式がたまたま同一なだけで意味論が別(馬番の
    // 妥当性であってオッズの妥当性ではない)であるため、本述語を流用してはならない
    // (将来オッズ側の基準だけを変えた際に馬番の検証まで道連れで変わる事故を防ぐ)。
    const table: Array<{ name: string; value: number; expected: boolean }> = [
      { name: "通常値(2.2)", value: 2.2, expected: true },
      // #74: 旧基準では true だったが、1.0未満は値域外のため false へ変更(引き上げの中核)。
      { name: "正の極小値(1e-9)", value: 1e-9, expected: false },
      { name: "Number.MAX_VALUE(有限の最大値)", value: Number.MAX_VALUE, expected: true },
      { name: "0(境界。1.0以上を満たさない)", value: 0, expected: false },
      // 負のゼロ(-0)。-0 >= 1.0 は false なので現状の実装で正しく除外される想定の境界値
      // (code-reviewer指摘)。-0 === 0 は true だが Object.is(-0, 0) は false であり、
      // 実装が `value >= MIN_VALID_ODDS` を使う限り区別なく false になるはず、という点を
      // 明示的に固定する。it.eachの表示名は上記$name(このオブジェクトのname)を使うため、
      // "0"の行と紛れない。
      { name: "負のゼロ(-0)", value: -0, expected: false },
      { name: "負値(-1)", value: -1, expected: false },
      { name: "NaN", value: Number.NaN, expected: false },
      { name: "+Infinity", value: Number.POSITIVE_INFINITY, expected: false },
      { name: "-Infinity", value: Number.NEGATIVE_INFINITY, expected: false },
      // #74 AC-3: 値域の境界(1.0未満/以上)を明示的に固定する。
      { name: "0.9999999(境界。1.0未満)", value: 0.9999999, expected: false },
      { name: "1(境界ちょうど。1.0以上を満たす)", value: 1, expected: true },
      { name: "1.0000001(境界を僅かに超える)", value: 1.0000001, expected: true },
    ];
    it.each(table)("$name → $expected", ({ value, expected }) => {
      expect(isUsableOdds(value)).toBe(expected);
    });

    it("MIN_VALID_ODDSは1.0である", () => {
      expect(MIN_VALID_ODDS).toBe(1.0);
    });

    // boss裁定(Q1(b)・2026-09-04): 値域の定数(MIN_VALID_ODDS)と、その定数を断定的に
    // 埋め込んだ除外理由の散文(expected-value.ts)を、1つのit()の中で両方ハードコードした
    // リテラルとして固定する。片方だけ直して緑になる経路を作らないため
    // (`expect(x).toEqual(実装からimportした定数)`は使わない。#55の自己参照比較の穴)。
    // MIN_VALID_ODDSを変更したら、このテストと下記2箇所を同時に直すこと:
    //   - expected-value.ts の除外理由文言「複勝オッズ下限が不正な値(1.0未満・非有限)のため対象外」
    //   - combo-bet-allocation.ts / bet-allocation.ts のAC-11是正箇所(散文中の「1.0未満」表記)
    it("値域の定数と除外理由の文言は同時に直す(定数を変えるとこのテストが赤くなる)", () => {
      expect(MIN_VALID_ODDS).toBe(1.0); // ハードコードしたリテラル
      const priors: HorsePrior[] = [{ umaban: 1, placeProb: 0.5 }];
      const place: PlaceOdds = { oddsMin: 0, oddsMax: 0, ninki: null };
      const odds: OddsSnapshot = {
        officialDatetime: null,
        oddsStatus: "result",
        win: {},
        place: { 1: place },
      };
      const [result] = computeRaceEv(priors, odds);
      expect(result!.excludedReason).toBe(
        "複勝オッズ下限が不正な値(1.0未満・非有限)のため対象外", // ハードコードしたリテラル
      );
    });
  });
});
