import { describe, expect, it } from "vitest";
import {
  computePlackettLuceMarginals,
  fitPlackettLuceStrengths,
  FIT_TOLERANCE,
  MAX_FIT_ITERATIONS,
  PlackettLuceFitError,
  type PlackettLuceFitFailureReason,
  type PlackettLuceFitSuccess,
} from "../../src/ev/plackett-luce-strength.js";
import { PLACKETT_LUCE_MODEL } from "../../src/ev/plackett-luce-model.js";
import type { JointModelHorse } from "../../src/ev/place-joint-model.js";

/** 出走馬を umaban 昇順で組み立てる補助関数。 */
function horses(probs: readonly number[]): JointModelHorse[] {
  return probs.map((placeProb, i) => ({ umaban: i + 1, placeProb }));
}

/** n個の要素からk個を選ぶ組合せを列挙する(汎用)。 */
function combinations<T>(items: readonly T[], k: number): T[][] {
  const results: T[][] = [];
  const current: T[] = [];
  const backtrack = (start: number): void => {
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]!);
      backtrack(i + 1);
      current.pop();
    }
  };
  backtrack(0);
  return results;
}

/** 配列の順列を全列挙する(汎用、要素数は小さい前提)。 */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const results: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) {
      results.push([items[i]!, ...p]);
    }
  }
  return results;
}

/**
 * ブルートフォース: θ から「集合Sがちょうど上位k集合になる確率」を、k!通りの並び順の和として
 * 厳密に計算する(このテストファイル専用の検算実装。本体の実装とは独立に導出する)。
 * 分母は「これまでに選ばれたS内メンバーの累積θ」だけに依存する(補集合の中身に依存しない)という
 * 事実により、この和がP(S=上位k集合)の厳密値になる(place-joint-model.tsのJSDoc参照)。
 */
function bruteForceMarginals(theta: readonly number[], k: number): number[] {
  const n = theta.length;
  const Theta = theta.reduce((a, b) => a + b, 0);
  const marginals = new Array(n).fill(0);
  const indices = theta.map((_, i) => i);
  for (const combo of combinations(indices, k)) {
    let comboProb = 0;
    for (const perm of permutations(combo)) {
      let denom = Theta;
      let p = 1;
      for (const idx of perm) {
        p *= theta[idx]! / denom;
        denom -= theta[idx]!;
      }
      comboProb += p;
    }
    for (const idx of combo) {
      marginals[idx] += comboProb;
    }
  }
  return marginals;
}

describe("computePlackettLuceMarginals(θからの周辺確率の閉形式)", () => {
  it("k=1のときF_i = θ_i/Σθ に一致する(自明解での検算)", () => {
    const theta = [2, 3, 5];
    const result = computePlackettLuceMarginals(theta, 1);
    const total = 10;
    expect(result[0]).toBeCloseTo(2 / total, 12);
    expect(result[1]).toBeCloseTo(3 / total, 12);
    expect(result[2]).toBeCloseTo(5 / total, 12);
  });

  describe("ブルートフォース等価性(n<=8の全k・θは6桁以上の動的レンジを含む)", () => {
    const wideThetaSets: Array<{ name: string; theta: number[] }> = [
      { name: "n=4・動的レンジ1e6", theta: [1, 10, 1000, 1_000_000] },
      { name: "n=5・動的レンジ1e6(非単調配置)", theta: [1_000_000, 1, 5000, 10, 1] },
      { name: "n=6・動的レンジ1e7", theta: [0.001, 0.5, 1, 100, 10_000, 10_000_000] },
      { name: "n=8・動的レンジ1e6", theta: [2, 2000, 4, 4000, 8, 8000, 1, 1_000_000] },
    ];
    for (const { name, theta } of wideThetaSets) {
      const n = theta.length;
      // production の placeCount は 1/2/3 のみ(resolvePlaceBetTarget由来は2/3、combo経路は3、
      // 単勝相当のテストで1)。k を n-1 まで広げると d=k-1 が大きくなり、交代和の項数が増えて
      // 桁落ちが指数的に悪化する(下の「dが大きい場合の桁落ち」テストで実測して分離する)。
      // ここは production 到達可能な k<=3 の範囲(かつ k<=n-1)に絞って高精度を要求する。
      for (let k = 1; k <= Math.min(n - 1, 3); k++) {
        it(`${name}, k=${k}`, () => {
          const closedForm = computePlackettLuceMarginals(theta, k);
          const brute = bruteForceMarginals(theta, k);
          // k<=3(production到達域)では、θの動的レンジが1e7程度でも誤差は1e-14オーダーに
          // 留まることを自分で測定済み(下の「θ比1e9・k<=3」テストで別途固定)。ここでは
          // 複数の異なるθ配置(単調増加・非単調・小数含み等)を広く1e-6という十分緩い許容誤差で
          // まとめて検算する(個々のfixtureの厳密な桁を主張する意図ではない)。
          for (let i = 0; i < n; i++) {
            expect(Math.abs(closedForm[i]! - brute[i]!)).toBeLessThan(1e-6);
          }
        });
      }
    }
  });

  describe("dが大きい場合(kがnに近い)の桁落ち増大(隠さず実測値で固定する)", () => {
    // n=6・動的レンジ1e10の固定fixtureで、k(=d+1)を増やすほど交代和の項数が増え、
    // 桁落ちが指数的に悪化することを実測値で固定する(production はk<=3のみ使うため実害はない)。
    const theta = [0.001, 0.5, 1, 100, 10_000, 10_000_000];
    const cases: Array<{ k: number; maxError: number }> = [
      { k: 1, maxError: 1e-9 },
      { k: 2, maxError: 1e-9 },
      { k: 3, maxError: 1e-9 },
      { k: 4, maxError: 1e-5 },
      { k: 5, maxError: 1e-2 },
    ];
    for (const { k, maxError } of cases) {
      it(`k=${k}: 誤差が${maxError}未満`, () => {
        const closedForm = computePlackettLuceMarginals(theta, k);
        const brute = bruteForceMarginals(theta, k);
        let maxObserved = 0;
        for (let i = 0; i < theta.length; i++) {
          maxObserved = Math.max(maxObserved, Math.abs(closedForm[i]! - brute[i]!));
        }
        expect(maxObserved).toBeLessThan(maxError);
      });
    }
    it("k=4の誤差はk=3の誤差より明確に大きい(桁落ちが実際に悪化することの検出力)", () => {
      const err = (k: number) => {
        const cf = computePlackettLuceMarginals(theta, k);
        const bf = bruteForceMarginals(theta, k);
        return Math.max(...theta.map((_, i) => Math.abs(cf[i]! - bf[i]!)));
      };
      const errK3 = err(3);
      const errK4 = err(4);
      expect(errK3).toBeGreaterThan(0); // 前提: k=3の誤差自体が0でないことを先に固定する
      expect(errK4).toBeGreaterThan(errK3 * 100);
    });
  });

  it("Σ_i F_i(θ) = k の恒等式(PLの構造そのもの。許容誤差はリテラル1e-9)", () => {
    const theta = [3, 1, 4, 1, 5, 9, 2, 6];
    for (let k = 1; k <= 7; k++) {
      const result = computePlackettLuceMarginals(theta, k);
      const sum = result.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - k)).toBeLessThan(1e-9);
    }
  });

  describe("桁落ちの上限(θの動的レンジと誤差の関係。テストで固定。要修正3で追加)", () => {
    // n=6,k=3で θ_max/θ_min を変えたときの、ブルートフォースとの最大絶対誤差を固定する。
    // 要修正3: production が唯一使うk<=3では、θ比が1e9・1e12に達しても誤差は1e-14
    // オーダーに留まる(自分の実装で実測)。FIT_TOLERANCE=1e-6の根拠は「閉形式の桁落ち」
    // ではなく反復更新の収束速度であることの裏付けになる(FIT_TOLERANCEのJSDoc参照)。
    const cases: Array<{ name: string; ratio: number; maxError: number }> = [
      { name: "θ比1e3", ratio: 1e3, maxError: 1e-9 },
      { name: "θ比1e6", ratio: 1e6, maxError: 1e-6 },
      { name: "θ比1e9(k<=3ではk=5と違い誤差は極小)", ratio: 1e9, maxError: 1e-13 },
      { name: "θ比1e12(k<=3ではさらに動的レンジを広げても誤差は極小)", ratio: 1e12, maxError: 1e-13 },
    ];
    for (const { name, ratio, maxError } of cases) {
      it(name, () => {
        const theta = [1, ratio / 4, ratio / 2, ratio, ratio * 0.7, ratio * 0.3];
        const closedForm = computePlackettLuceMarginals(theta, 3);
        const brute = bruteForceMarginals(theta, 3);
        let maxObserved = 0;
        for (let i = 0; i < theta.length; i++) {
          maxObserved = Math.max(maxObserved, Math.abs(closedForm[i]! - brute[i]!));
        }
        expect(maxObserved).toBeLessThan(maxError);
      });
    }
  });
});

describe("fitPlackettLuceStrengths(θ推定器・判別共用体)", () => {
  describe("reason(5値)の(正)対照", () => {
    it('invalid-probability: placeProbが1を超える馬を含む', () => {
      const result = fitPlackettLuceStrengths(horses([0.5, 1.5, 0.3]), 2);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-probability");
    });

    it("invalid-probability: placeProbが負の馬を含む", () => {
      const result = fitPlackettLuceStrengths(horses([0.5, -0.1, 0.3]), 2);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-probability");
    });

    it("invalid-probability: placeProbがNaNの馬を含む", () => {
      const result = fitPlackettLuceStrengths(horses([0.5, Number.NaN, 0.3]), 2);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-probability");
    });

    it("invalid-place-count: placeCountが負", () => {
      const result = fitPlackettLuceStrengths(horses([0.5, 0.4, 0.3]), -1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-place-count");
    });

    it("invalid-place-count: placeCountが非整数", () => {
      const result = fitPlackettLuceStrengths(horses([0.5, 0.4, 0.3]), 1.5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-place-count");
    });

    it("invalid-place-count: placeCountがNaN", () => {
      const result = fitPlackettLuceStrengths(horses([0.5, 0.4, 0.3]), Number.NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-place-count");
    });

    it("infeasible-support: p>0の馬がk頭未満(4頭中1頭だけp>0でk=2)", () => {
      const result = fitPlackettLuceStrengths(horses([0.9, 0, 0, 0]), 2);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("infeasible-support");
    });

    it("infeasible-support: 全馬p=0でk=1", () => {
      const result = fitPlackettLuceStrengths(horses([0, 0, 0]), 1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("infeasible-support");
    });

    it("not-converged: 縮約後の内点が1に極めて近い残余ケース(実測で発見した具体的な入力)", () => {
      // 18頭・k=3・1頭だけ q=0.998 近傍、残り17頭で残余(3-0.998)を均等に分ける。
      // MAX_FIT_ITERATIONS=2000・FIT_TOLERANCE=1e-6の下で収束しないことを自分の実装で実測した
      // 具体的な入力(「実現不能」ではなく「この上限では収束しなかった」ケース)。
      const n = 18;
      const near = 0.998;
      const rest = (3 - near) / (n - 1);
      const probs = [near, ...Array.from({ length: n - 1 }, () => rest)];
      const result = fitPlackettLuceStrengths(horses(probs), 3);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not-converged");
    });
  });

  describe("numerically-unstableの根拠(実装が到達しないことの記録・#20-Aでの誠実な報告)", () => {
    // 反復更新 θ←θ・(q/F) がΘ非有限/0を起こしうる根本原因(computePlackettLuceMarginalsの
    // Θ-θ_D計算における破局的桁落ち)自体は実在することを、直接構成したθで固定する。
    it("θの動的レンジが極端(比1e20)だとcomputePlackettLuceMarginalsが非有限値を返しうる", () => {
      const result = computePlackettLuceMarginals([1, 1, 1e20], 2);
      // 前提: 少なくとも1要素が非有限であることを先に固定する(空振り防止)。
      const hasNonFinite = result.some((v) => !Number.isFinite(v));
      expect(hasNonFinite).toBe(true);
    });

    // ただしfitPlackettLuceStrengths自体は、[0,1]箱の水詰め射影で真の境界(p=0/p=1)を
    // 事前に厳密除外/固定するため、上記のような極端なθ動的レンジ(1e20)には自然には到達しない
    // (自由集合の初期値 q/(1-q) は 0<q<1 の浮動小数表現の制約により最大でも約4.5e15程度に
    // 留まり、乗法的更新もq_i/F_iの比が概ねO(1)に留まる限り自己修正的に振る舞う)。
    // n=4〜60・θ比を変えた多数の入力(1頭だけq→1近傍・複数頭が同時にq→1近傍・
    // 極小pを混在させた入力など)で探索したが、numerically-unstableを実際に踏む具体的な入力は
    // 見つからなかった(この探索過程は本タスクの完了報告に記録する)。ガード自体は
    // 上記のとおり数学的根拠のある防御であり、コードには残すが、
    // fitPlackettLuceStrengthsを通した(正)対照テストは#20-A時点では持たない
    // (見つからないことを実装未完了と混同しないよう、ここに理由とともに明記する)。
  });

  describe("reason(5値)の(負の対照): 正常入力ではok:falseにならない", () => {
    const normalCases: Array<{ name: string; probs: number[]; k: number }> = [
      { name: "Σp=kちょうど", probs: [0.5, 0.3, 0.2], k: 1 },
      { name: "Σp<k(内点)", probs: [0.3, 0.3, 0.3, 0.3], k: 3 },
      { name: "Σp>k(内点)", probs: [0.7, 0.7, 0.7, 0.5, 0.4], k: 3 },
      { name: "p=0を含むがΣp=kちょうど", probs: [0, 0.6, 0.4], k: 1 },
      { name: "p=1を含むがΣp=kちょうど", probs: [1, 0.5, 0.5], k: 2 },
      { name: "18頭k=3(本番相当)", probs: Array.from({ length: 18 }, (_, i) => (0.05 + (i % 6) * 0.03)), k: 3 },
    ];
    for (const c of normalCases) {
      it(c.name, () => {
        const result = fitPlackettLuceStrengths(horses(c.probs), c.k);
        expect(result.ok).toBe(true);
      });
    }
  });

  describe("infeasible-supportの境界(p>0がちょうどk頭)", () => {
    it("p>0がちょうどk頭のとき、その頭が確率1で全て固定される(全頭固定=単一集合confirmed)", () => {
      // 4頭中2頭がp>0、k=2ちょうど。
      const result = fitPlackettLuceStrengths(horses([0.3, 0.6, 0, 0]), 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.degenerateFixedCount).toBe(2);
        expect(result.degenerateZeroCount).toBe(2);
        expect(result.reducedHorseCount).toBe(0);
        expect(result.reducedPlaceCount).toBe(0);
        // p>0の2頭のthetaはInfinity(上位k枠に厳密固定)。
        expect(result.theta[0]).toBe(Number.POSITIVE_INFINITY);
        expect(result.theta[1]).toBe(Number.POSITIVE_INFINITY);
        expect(result.theta[2]).toBe(0);
        expect(result.theta[3]).toBe(0);
      }
    });

    it("p>0がちょうどk頭で、かつ既にΣp=kちょうどなら再スケールなし", () => {
      // p=1が2頭ちょうど、k=2。Σp=2=kなのでrescaleApplied=false。
      const result = fitPlackettLuceStrengths(horses([1, 1, 0, 0]), 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rescaleApplied).toBe(false);
        expect(result.degenerateFixedCount).toBe(2);
        expect(result.rescaleInducedFixedCount).toBe(0);
      }
    });
  });

  describe("p=0/p=1は正常入力(第2回撤回・EPSクランプ不使用)", () => {
    it("p=0の馬のθは厳密に0(toBeCloseTeで誤魔化さない)", () => {
      const result = fitPlackettLuceStrengths(horses([0, 0.5, 0.3, 0.2]), 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.theta[0]).toBe(0);
        expect(result.degenerateZeroCount).toBe(1);
      }
    });

    it("p=1の馬のθは厳密にInfinity", () => {
      // Σp=1+0.4+0.3+0.2+0.1=2=kちょうどなのでrescaleApplied=false・固定は入力のp=1由来の1頭のみ
      // (要修正7の指摘を受け、他のテストと同様に述語検査ではなく厳密値で固定する)。
      const result = fitPlackettLuceStrengths(horses([1, 0.4, 0.3, 0.2, 0.1]), 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.theta[0]).toBe(Number.POSITIVE_INFINITY);
        expect(result.rescaleApplied).toBe(false);
        expect(result.degenerateFixedCount).toBe(1);
      }
    });
  });

  describe("rescaleInducedFixedCountとdegenerateFixedCountの分離(2本必須)", () => {
    it("境界値を含まずΣp<kでもrescaleInducedFixedCount>=1かつdegenerateZeroCount=0になりうる", () => {
      // 18頭、全馬0.05〜0.2程度でΣp<3だが、1頭だけ突出して高いケースを作る。
      const probs = [0.9, ...Array.from({ length: 17 }, (_, i) => 0.05 + (i % 5) * 0.01)];
      const sum = probs.reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThan(3); // 前提: Σp<k=3を固定する
      const result = fitPlackettLuceStrengths(horses(probs), 3);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rescaleApplied).toBe(true);
        // 自分の実装で実測した厳密値(要修正7と同型の指摘への対応。述語検査ではなく値で固定する)。
        expect(result.rescaleFactor).toBeCloseTo(1.724137931034482, 9);
        expect(result.rescaleInducedFixedCount).toBe(1);
        expect(result.degenerateZeroCount).toBe(0);
        expect(result.degenerateFixedCount).toBe(1);
      }
    });

    it("p=0を含みΣp=kちょうどならdegenerateZeroCount>=1かつrescaleApplied=false", () => {
      const probs = [0, 0.4, 0.4, 0.4, 0.4, 0.4];
      const sum = probs.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(2, 9); // 前提: Σp=k=2ちょうどを固定する
      const result = fitPlackettLuceStrengths(horses(probs), 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rescaleApplied).toBe(false);
        expect(result.degenerateZeroCount).toBe(1);
      }
    });
  });

  describe("Σpとkの関係(AC-2)", () => {
    it("Σp=kちょうど: 残差が1e-9未満に落ちる", () => {
      const result = fitPlackettLuceStrengths(horses([0.5, 0.3, 0.2]), 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.residualMax).toBeLessThan(1e-9);
        expect(result.rescaleApplied).toBe(false);
      }
    });

    it("Σp<k: rescaleAppliedがtrueでrescaleFactorが値として固定される(>1)", () => {
      // Σp=1.2、クランプが発生しないためλ=k/Σp=3/1.2=2.5を厳密に計算できる(要修正7)。
      const result = fitPlackettLuceStrengths(horses([0.3, 0.3, 0.3, 0.3]), 3);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rescaleApplied).toBe(true);
        expect(result.rescaleFactor).toBeCloseTo(2.5, 9);
      }
    });

    it("Σp>k: rescaleAppliedがtrueでrescaleFactorが値として固定される(<1)", () => {
      // Σ=3.7(>k=3を浮動小数の丸め誤差なく明確に上回る値にする)。
      // クランプが発生しないためλ=k/Σp=3/3.7を厳密に計算できる(要修正7)。
      const result = fitPlackettLuceStrengths(horses([0.8, 0.8, 0.8, 0.7, 0.6]), 3);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rescaleApplied).toBe(true);
        expect(result.rescaleFactor).toBeCloseTo(3 / 3.7, 9);
      }
    });
  });

  describe("p=1をm頭含む入力は(n-m,k-m)の縮約問題と一致する(ブルートフォース照合。重大1で是正)", () => {
    /**
     * 標準のPlackett-Luce厳密式(k!通りの並び順の和)でP(S=上位k集合)を計算する
     * ブルートフォース(このテストファイル専用の検算実装。本体の実装からは独立)。
     */
    function bruteForceSetProbability(theta: readonly number[], combo: readonly number[]): number {
      const Theta = theta.reduce((a, b) => a + b, 0);
      let total = 0;
      for (const perm of permutations(combo)) {
        let denom = Theta;
        let prob = 1;
        for (const idx of perm) {
          prob *= theta[idx]! / denom;
          denom -= theta[idx]!;
        }
        total += prob;
      }
      return total;
    }

    it("6頭中1頭がp=1・k=3 -> 縮約後(5頭,k'=2)がブルートフォース(固定馬をθ=巨大値に置換したフル6頭モデル)と一致する", () => {
      // reducedPlaceCount=1(前回の欠陥テスト)はΣF_i=k'=1の恒等式が効いて何でも通ってしまう
      // ため、k'>=2になる縮約ケースを使う(boss指摘)。
      const probs = [1, 0.6, 0.5, 0.4, 0.3, 0.2];
      const sum = probs.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(3, 9); // 前提: Σp=k=3ちょうど(再スケールなしの素直なケース)。

      const result = fitPlackettLuceStrengths(horses(probs), 3);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.degenerateFixedCount).toBe(1);
      expect(result.reducedPlaceCount).toBe(2); // 前提: k'>=2の縮約ケースであることを固定する。
      expect(result.reducedHorseCount).toBe(5);

      // 固定馬(添字0)をθ=M(巨大値)に置き換えたフル6頭のθで、標準のPL式によるブルートフォースを
      // 行う。M→∞の極限でPLACKETT_LUCE_MODELの縮約結果と一致するはず(自分で実測: M=1e6で
      // 最大誤差1.3e-11。M=1e4/1e8でも同オーダー。十分な余裕を持たせ1e-6を閾値にする)。
      const M = 1_000_000;
      const freeTheta = result.theta.slice(1) as number[];
      const fullTheta = [M, ...freeTheta];

      const modelDistribution = PLACKETT_LUCE_MODEL.buildDistribution(horses(probs), 3);
      const modelByKey = new Map(modelDistribution.map((o) => [o.placed.join(","), o.probability]));

      // 馬0(umaban=1、固定馬)を含むC(5,2)=10通りの組合せすべてを検算する。
      const otherIndices = [1, 2, 3, 4, 5];
      const combosOfOthers = combinations(otherIndices, 2);
      expect(combosOfOthers.length).toBe(10); // 前提: C(5,2)=10通りであることを固定する。

      let maxDiff = 0;
      for (const combo of combosOfOthers) {
        const fullCombo = [0, ...combo];
        const bfProb = bruteForceSetProbability(fullTheta, fullCombo);
        const umabans = fullCombo.map((idx) => idx + 1).sort((a, b) => a - b);
        const modelProb = modelByKey.get(umabans.join(","));
        expect(modelProb).toBeDefined();
        maxDiff = Math.max(maxDiff, Math.abs(bfProb - modelProb!));
      }
      expect(maxDiff).toBeLessThan(1e-6);
    });
  });

  describe("出力契約(theta配列の長さ・スケール規約)", () => {
    it("thetaの長さは入力horsesと同じ(並びも一致)", () => {
      const result = fitPlackettLuceStrengths(horses([0.5, 0.3, 0.2, 0.4]), 2);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.theta.length).toBe(4);
    });

    it("スケール規約: 自由集合のΣθ = reducedHorseCount(値として固定。重大2で是正)", () => {
      // 対称フィクスチャ([0.3,0.3,0.3,0.3])は初期値q/(1-q)の時点で既にΣθ=n'が成立し、
      // scale=1(no-op)になってしまい M6(scale=1への変異)を検出できなかった(boss実測)。
      // 非対称フィクスチャに変え、reducedHorseCount をリテラルで別掲(自己参照を避ける)、
      // さらにθの各要素も自分の実測値でリテラル固定する。
      const result = fitPlackettLuceStrengths(horses([0.5, 0.3, 0.2, 0.4]), 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.reducedHorseCount).toBe(4); // リテラル(resultの他フィールドと比較しない)。
        const freeSum = result.theta
          .filter((t) => Number.isFinite(t) && t > 0)
          .reduce((a, b) => a + b, 0);
        expect(freeSum).toBeCloseTo(4, 6); // リテラル4(reducedHorseCountを介さない)。
        // θの各要素も自分の実測値でリテラル固定する(M6=scaleを1に変異させると全て変わる)。
        expect(result.theta[0]).toBeCloseTo(1.617521102703636, 6);
        expect(result.theta[1]).toBeCloseTo(0.7778448169590897, 6);
        expect(result.theta[2]).toBeCloseTo(0.49609338581274703, 6);
        expect(result.theta[3]).toBeCloseTo(1.108540694524527, 6);
      }
    });

    it("同じ入力から2回フィットするとthetaがビット一致する(決定性)", () => {
      const probs = [0.3, 0.35, 0.4, 0.25, 0.15, 0.5];
      const r1 = fitPlackettLuceStrengths(horses(probs), 2);
      const r2 = fitPlackettLuceStrengths(horses(probs), 2);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.theta).toEqual(r2.theta);
      }
    });

    it("スケール不変性: θ全体をc倍してもF(θ)は不変(k>=2の一般ケース)", () => {
      const theta = [1.5, 2.5, 0.7, 3.1, 0.9];
      const scaled = theta.map((t) => t * 1000);
      const f1 = computePlackettLuceMarginals(theta, 2);
      const f2 = computePlackettLuceMarginals(scaled, 2);
      for (let i = 0; i < theta.length; i++) {
        expect(Math.abs(f1[i]! - f2[i]!)).toBeLessThan(1e-9);
      }
    });
  });

  describe("収束後の再検算ガード(要修正1・M5対策)", () => {
    it("residualMaxは、返されたthetaから自分で再計算した残差と一致する(生のループ内残差ではない。M5検出)", () => {
      // M5(residualMax: finalResidual → fit.residualMaxに変異)を検出するテスト。
      // 一般のフィクスチャでは「正規化前(ループ内)の残差」と「正規化後(返り値)の残差」の差が
      // 1e-12〜1e-16程度と極小で、緩い許容誤差では変異を検出できない(自分で実測して確認済み)。
      // k(=reducedPlaceCount)をnに近づけて桁落ちを誘発すると差が測定可能な大きさ(約2.2e-10)に
      // なることを実測した(このテスト専用のフィクスチャ。production の k<=3 制約とは無関係の
      // 内部一般性のテスト——fitPlackettLuceStrengths自体はkを汎用に扱う設計のため)。
      const n = 13;
      const k = 6; // reducedPlaceCount=6(n=13に対して桁落ちが測定可能になる程度に近い)。
      const near = 0.9830729289680128;
      const rest = (k - near) / (n - 1);
      const probs = [near, ...Array.from({ length: n - 1 }, () => rest)];
      const sum = probs.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(k, 9); // 前提: Σp=kちょうど(再スケールなし)を固定する。

      const result = fitPlackettLuceStrengths(horses(probs), k);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rescaleApplied).toBe(false);
      expect(result.reducedHorseCount).toBe(n); // 前提: 全馬が自由集合であることを固定する。

      // 自由集合のthetaとその目標q(=λ・p=p、クランプなし)を再構成する。
      const freeTheta = result.theta as number[];
      const recomputedF = computePlackettLuceMarginals(freeTheta, result.reducedPlaceCount);
      let recomputedResidual = 0;
      for (let i = 0; i < probs.length; i++) {
        recomputedResidual = Math.max(recomputedResidual, Math.abs(recomputedF[i]! - probs[i]!));
      }
      // 独立に再計算した残差が result.residualMax と一致すること。このフィクスチャでは
      // 「正規化前(ループ内)残差」との差が約2.2e-10あるため、1e-11という桁落ち由来の
      // 誤差より十分小さい許容誤差で、生のループ内残差(M5の変異後の値)との違いを検出できる。
      expect(Math.abs(result.residualMax - recomputedResidual)).toBeLessThan(1e-11);
    });
  });

  describe("収束後の再検算ガードの発火(要修正A・M3対策)", () => {
    // M3(if (finalResidual >= FIT_TOLERANCE) → if (false))を殺す入力。
    //
    // 発火の機序: 両極端(非常に小さいtinyと非常に大きいrest)をほぼ同数混ぜると、θの動的
    // レンジが極端(1e12オーダー)に達する。自由集合のΣθをreducedHorseCountへ正規化する
    // 乗算(t * scale)自体の相対丸め(浮動小数点の1ULP、約1e-16)が、この極端な条件数の
    // 下では閉形式の計算を通じて増幅され、正規化前(ループ内)の残差がFIT_TOLERANCE未満でも
    // 正規化後(実際に返すtheta)の残差がFIT_TOLERANCE以上になりうる。
    //
    // これまでの探索(このファイルの「numerically-unstableの根拠」と同種の片側だけを極端に
    // する探索)がこの入力を見つけられなかったのは、両極端を「同時に」振る必要があったため
    // (どちらか一方だけを極端にしても、もう一方が中庸だと条件数が上がりきらない)。
    it("(正)n=14・k=7・tiny=1e-6を7頭+rest=0.999999を7頭 -> not-convergedになる", () => {
      const n = 14;
      const k = 7;
      const tiny = 1e-6;
      const rest = 0.999999;
      const probs = [
        ...Array.from({ length: 7 }, () => tiny),
        ...Array.from({ length: 7 }, () => rest),
      ];
      const sum = probs.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(k, 9); // 前提: Σp=kちょうど(再スケールなし)を固定する。

      const result = fitPlackettLuceStrengths(horses(probs), k);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("not-converged");
    });

    it("(負の対照)tinyとrestをわずかに変えるとok:trueに戻る(ガードが無差別に発火していないことの確認)", () => {
      // (正)からtiny/restを1桁だけ変えた近傍の入力。ガードが「常に発火する」壊れた実装
      // ではないことを示す対照(#31「判定不能と判定結果を混同しない」の逆側の確認)。
      const n = 14;
      const k = 7;
      const tiny = 1e-7;
      const rest = 0.9999999;
      const probs = [
        ...Array.from({ length: 7 }, () => tiny),
        ...Array.from({ length: 7 }, () => rest),
      ];
      const sum = probs.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(k, 9);

      const result = fitPlackettLuceStrengths(horses(probs), k);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.iterations).toBe(0); // k'=7だが実質縮退せず全馬自由集合(閉形式には非該当)。
      // 自分の実測値をリテラルで固定する(boss実測の1.0004e-7と同オーダーであることを確認済み)。
      expect(result.residualMax).toBeCloseTo(1.0003750661180533e-7, 12);
    });

    // 【到達可能性の記録・テスト化はしない(空振りになるため)】
    // 上の(正)入力は n=14・placeCount=7 であり、production範囲外(placeCount<=3)。
    // fitPlackettLuceStrengths のJSDoc(「本関数自体も防御的に妥当な結果を返す〈将来の
    // 呼び出し元のための頑健性〉」)がカバーする一般性の検査であり、production到達可能性の
    // 主張ではない。k<=3(production到達可能な唯一の範囲)で同じ両極端構造
    // (n=4..18・k∈{2,3}・nt=1..n-1・tiny=1e-4〜1e-12)を自分で2295件掃引したが、
    // finalResidual>=FIT_TOLERANCEに達する(=ガードが発火する)入力は見つかっていない
    // (numerically-unstableと同じ流儀。「実現不能」とは断定しない。再現コマンドは
    // 完了報告に記載する)。
  });

  describe("k'=1の反復回数(閉形式・反復不要)", () => {
    it("outer k=1(縮退なし)ではiterationsが厳密に0", () => {
      const result = fitPlackettLuceStrengths(horses([0.5, 0.3, 0.2]), 1);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.iterations).toBe(0);
    });

    it("reducedPlaceCount=1に落ちる縮約後ケースでもiterationsが厳密に0", () => {
      // 5頭k=3、1頭p=1で固定。縮約後は4頭・k'=2になる(まだk'=1ではない例なので別途)。
      // k'=1になる例: 4頭中1頭p=1、k=2 -> 縮約後3頭・k'=1。
      const result = fitPlackettLuceStrengths(horses([1, 0.3, 0.3, 0.3]), 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.reducedPlaceCount).toBe(1);
        expect(result.iterations).toBe(0);
      }
    });
  });

  describe("反復上限・許容誤差の公開定数(#55: リテラル併置。要修正1で是正)", () => {
    it("MAX_FIT_ITERATIONSが2000にリテラルで固定されている", () => {
      // 変異(2000→5等)を検出できるよう、実装からimportした値と別にリテラル2000を併記する。
      expect(MAX_FIT_ITERATIONS).toBe(2000);
    });

    it("FIT_TOLERANCEが1e-6にリテラルで固定されている", () => {
      expect(FIT_TOLERANCE).toBe(1e-6);
    });
  });
});

describe("PlackettLuceFitError", () => {
  it("nameが'PlackettLuceFitError'に固定されている(instanceofだけに頼らない)", () => {
    const err = new PlackettLuceFitError("not-converged", "test");
    expect(err.name).toBe("PlackettLuceFitError");
    expect(err instanceof PlackettLuceFitError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("reasonがコンストラクタ引数と一致する", () => {
    const reasons: PlackettLuceFitFailureReason[] = [
      "invalid-probability",
      "invalid-place-count",
      "infeasible-support",
      "not-converged",
      "numerically-unstable",
    ];
    for (const r of reasons) {
      const err = new PlackettLuceFitError(r, "test");
      expect(err.reason).toBe(r);
    }
  });
});
