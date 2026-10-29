import { describe, expect, it } from "vitest";
import { runGreedyAllocation, type GreedyGroupLimit, type OutcomeIndexSet } from "../../src/ev/allocation-primitives.js";

/**
 * runGreedyAllocation の群ごとの点数の上限(Issue #533)。
 *
 * 上限は貪欲の中に入れる(後から削るのではない): 群の中で割合が正の候補が上限に達したら、まだ 0 の同じ群の候補は
 * それ以降のステップで選ばない(ロック方式)。固定する性質:
 *  1. 上限を超えて正の割合を持たない
 *  2. 上限なし(未指定・空・上限 0 の群)は、上限を渡さない呼び出しと完全一致する
 *  3. 上限が効かない(上限なしの結果で正の候補が上限以下)ときは、上限なしの結果と完全一致する
 *  4. 上限が効く経路でも、高速パスと(同じロックを入れた)旧来のブルートフォースが一致する
 *  5. 契約違反(群の重複・範囲外の候補番号)は例外
 */

/** 決定的な疑似乱数生成器(allocation-primitives.test.ts と同じ線形合同法)。 */
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

/** 上限つきの旧来のブルートフォース参照実装(元のテストの bruteForce に「群が満杯なら x=0 の候補を選ばない」だけを足したもの)。 */
function bruteForceWithLimits(
  nn: number,
  oddsArr: readonly number[],
  sets: readonly OutcomeIndexSet[],
  steps: number,
  limits: readonly GreedyGroupLimit[],
): number[] {
  const x = new Array<number>(nn).fill(0);
  const delta = 1 / steps;
  let sumX = 0;
  const groupIndexOf = (i: number): number => limits.findIndex((l) => l.members.includes(i));
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
      const g = groupIndexOf(i);
      if (g >= 0 && limits[g]!.max >= 1 && x[i] === 0) {
        const positive = limits[g]!.members.filter((m) => x[m]! > 0).length;
        if (positive >= Math.floor(limits[g]!.max)) continue;
      }
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
}

const positiveCount = (x: readonly number[], members: readonly number[]): number => members.filter((m) => x[m]! > 0).length;
const evenIndices = (n: number): number[] => Array.from({ length: n }, (_, i) => i).filter((i) => i % 2 === 0);
const oddIndices = (n: number): number[] => Array.from({ length: n }, (_, i) => i).filter((i) => i % 2 === 1);

/**
 * 上限が実際に効く入力。偶数番・奇数番の候補を2つの群とみなす。`maxes` は、少なくとも片方の群が上限なしで
 * その値を超える点数を持つ(= 上限が効く)ように選んだ値(各シナリオの上限なしの点数は下のテストが無条件に確かめる)。
 */
const SCENARIOS = [
  { label: "候補16・outcome40・接触密度0.1・オッズ5-15", n: 16, outcomeCount: 40, contact: 0.1, oddsMin: 5, oddsMax: 15, seed: 11, maxes: [1, 2] },
  { label: "候補10・outcome40・接触密度0.15・オッズ5-12", n: 10, outcomeCount: 40, contact: 0.15, oddsMin: 5, oddsMax: 12, seed: 3, maxes: [1] },
  { label: "候補12・outcome12・接触密度0.2・オッズ4-12", n: 12, outcomeCount: 12, contact: 0.2, oddsMin: 4, oddsMax: 12, seed: 7, maxes: [1, 2] },
  { label: "候補30・outcome20・接触密度0.1・オッズ4-15(片方の群だけ点数が多い)", n: 30, outcomeCount: 20, contact: 0.1, oddsMin: 4, oddsMax: 15, seed: 5, maxes: [1, 2, 3] },
] as const;

describe("runGreedyAllocation の群ごとの点数の上限(Issue #533)", () => {
  describe("上限なしは、上限を渡さない呼び出しと完全一致する(ビット単位)", () => {
    for (const s of SCENARIOS) {
      it(`未指定・空配列・上限0の群・上限が候補数以上の群が、すべて同一の結果になる / ${s.label}`, () => {
        const { outcomeIndexSets, odds } = buildScenario(s.n, s.outcomeCount, s.contact, s.oddsMin, s.oddsMax, s.seed);
        const base = runGreedyAllocation(s.n, odds, outcomeIndexSets, 200);
        const all = Array.from({ length: s.n }, (_, i) => i);
        expect(runGreedyAllocation(s.n, odds, outcomeIndexSets, 200, undefined)).toEqual(base);
        expect(runGreedyAllocation(s.n, odds, outcomeIndexSets, 200, [])).toEqual(base);
        expect(runGreedyAllocation(s.n, odds, outcomeIndexSets, 200, [{ members: all, max: 0 }])).toEqual(base);
        expect(runGreedyAllocation(s.n, odds, outcomeIndexSets, 200, [{ members: all, max: s.n }])).toEqual(base);
        // 前提(空振りの防止): 基準の結果で、何かが正の割合を持っている
        expect(positiveCount(base.fractions, all)).toBeGreaterThanOrEqual(1);
      });
    }
  });

  describe("上限を超えて正の割合を持たない / 上限が効くと上限なしと結果が変わる", () => {
    for (const s of SCENARIOS) {
      for (const max of s.maxes) {
        it(`群ごとに正の候補は ${max} 点以下 / ${s.label}`, () => {
          const { outcomeIndexSets, odds } = buildScenario(s.n, s.outcomeCount, s.contact, s.oddsMin, s.oddsMax, s.seed);
          const even = evenIndices(s.n);
          const odd = oddIndices(s.n);
          const free = runGreedyAllocation(s.n, odds, outcomeIndexSets, 200);
          const freeEven = positiveCount(free.fractions, even);
          const freeOdd = positiveCount(free.fractions, odd);
          // 前提: 上限なしでは、少なくとも片方の群で上限を超える点数が正になる(上限が実際に効く入力)
          expect(Math.max(freeEven, freeOdd)).toBeGreaterThan(max);

          const limited = runGreedyAllocation(s.n, odds, outcomeIndexSets, 200, [
            { members: even, max },
            { members: odd, max },
          ]);
          const limitedEven = positiveCount(limited.fractions, even);
          const limitedOdd = positiveCount(limited.fractions, odd);
          expect(limitedEven).toBeLessThanOrEqual(max);
          expect(limitedOdd).toBeLessThanOrEqual(max);
          // 上限なしで上限を超えていた群は、上限ちょうどまで使っている(0点に潰れていない)
          if (freeEven > max) expect(limitedEven).toBe(max);
          if (freeOdd > max) expect(limitedOdd).toBe(max);
          // 上限が効いたので、結果は上限なしと違う
          expect(limited.fractions).not.toEqual(free.fractions);
        });
      }
    }

    it("群に入れていない候補は上限の影響を受けない(上限は群の中だけ)", () => {
      const s = SCENARIOS[3];
      const { outcomeIndexSets, odds } = buildScenario(s.n, s.outcomeCount, s.contact, s.oddsMin, s.oddsMax, s.seed);
      const even = evenIndices(s.n);
      const odd = oddIndices(s.n);
      const free = runGreedyAllocation(s.n, odds, outcomeIndexSets, 200);
      // 前提: 上限なしでは偶数番が2点以上、奇数番が2点より多く正になる(偶数番に上限1を付けると効く)
      expect(positiveCount(free.fractions, even)).toBeGreaterThanOrEqual(1);
      expect(positiveCount(free.fractions, odd)).toBeGreaterThan(2);
      const limited = runGreedyAllocation(s.n, odds, outcomeIndexSets, 200, [{ members: even, max: 1 }]);
      expect(positiveCount(limited.fractions, even)).toBeLessThanOrEqual(1);
      // 上限を付けなかった奇数番は、2点を超えて正のままでよい
      expect(positiveCount(limited.fractions, odd)).toBeGreaterThan(2);
    });
  });

  describe("上限が効かないときは、上限なしと完全一致する(ビット単位)", () => {
    for (const s of SCENARIOS) {
      it(`上限なしで正の候補数ちょうどを上限にしても結果が変わらない / ${s.label}`, () => {
        const { outcomeIndexSets, odds } = buildScenario(s.n, s.outcomeCount, s.contact, s.oddsMin, s.oddsMax, s.seed);
        const even = evenIndices(s.n);
        const odd = oddIndices(s.n);
        const free = runGreedyAllocation(s.n, odds, outcomeIndexSets, 200);
        const evenPositive = positiveCount(free.fractions, even);
        const oddPositive = positiveCount(free.fractions, odd);
        // 前提: 両群とも、上限なしで1点以上が正(上限1以上を渡せる)
        expect(evenPositive + oddPositive).toBeGreaterThanOrEqual(1);
        const limits: GreedyGroupLimit[] = [];
        if (evenPositive >= 1) limits.push({ members: even, max: evenPositive });
        if (oddPositive >= 1) limits.push({ members: odd, max: oddPositive });
        expect(limits.length).toBeGreaterThanOrEqual(1);
        expect(runGreedyAllocation(s.n, odds, outcomeIndexSets, 200, limits)).toEqual(free);
      });
    }
  });

  describe("上限が効く経路でも、高速パスと旧来のブルートフォース(同じロック付き)が一致する(テーブル駆動)", () => {
    for (const s of SCENARIOS) {
      for (const steps of [50, 500]) {
        for (const max of s.maxes) {
          it(`${s.label} / 上限=${max} / greedySteps=${steps}`, () => {
            const { outcomeIndexSets, odds } = buildScenario(s.n, s.outcomeCount, s.contact, s.oddsMin, s.oddsMax, s.seed);
            const limits: GreedyGroupLimit[] = [
              { members: evenIndices(s.n), max },
              { members: oddIndices(s.n), max },
            ];
            const free = runGreedyAllocation(s.n, odds, outcomeIndexSets, steps);
            const expected = bruteForceWithLimits(s.n, odds, outcomeIndexSets, steps, limits);
            const actual = runGreedyAllocation(s.n, odds, outcomeIndexSets, steps, limits);
            expect(actual.fractions).toEqual(expected);
            // 前提(空振りの防止): 上限なしでは上限を超える点数が正になる入力である(ロックが効く可能性がある)。
            // greedySteps=50 でも成り立つことを確かめる(分割が粗くても上限が効く入力であること)。
            expect(Math.max(positiveCount(free.fractions, evenIndices(s.n)), positiveCount(free.fractions, oddIndices(s.n)))).toBeGreaterThan(max);
            expect(actual.fractions).not.toEqual(free.fractions);
          });
        }
      }
    }

    // allocation-primitives.test.ts の「フォールバック分岐(unsafe)を実際に踏む」入力と同じ構成
    // (候補0・1が sumX を押し上げ、候補2の専属 outcome の資産が最終ステップで EPS に達する)。
    // 上限の機構が有効(群あり)なまま、EPS ガードのフォールバックを通っても結果が変わらないことを確かめる。
    // (群の上限が実際にブロックを起こす入力では sumX が 1 に届かず、この分岐には入らない。ブロックありの
    //  高速パスの一致は上のテーブルが固定する。)
    it("EPS ガードのフォールバックを通る入力で、上限が効かない群を付けても結果が変わらず、旧来のブルートフォースとも一致する", () => {
      const sets: OutcomeIndexSet[] = [
        { indices: [0], probability: 0.49995 },
        { indices: [1], probability: 0.49995 },
        { indices: [2], probability: 0.0001 },
      ];
      const odds = [10, 10, 10000];
      const limits: GreedyGroupLimit[] = [{ members: [2], max: 1 }];
      const free = runGreedyAllocation(3, odds, sets, 1000);
      // 前提: 上限なしで、候補2が正の配分を得て貪欲が使い切られる(= このフォールバックを通る入力)
      expect(free.fractions[2]!).toBeGreaterThan(0);
      expect(free.converged).toBe(false);
      const actual = runGreedyAllocation(3, odds, sets, 1000, limits);
      expect(actual).toEqual(free);
      expect(actual.fractions).toEqual(bruteForceWithLimits(3, odds, sets, 1000, limits));
    });

    it("EPS ガードのフォールバックを通るステップで、ブロックされた候補は選ばれない(群の上限を守り、旧来のブルートフォースと一致する)", () => {
      // 上と同じ構成に、候補2と同じ形の候補3(同じ outcome・同じ極端なオッズ)を足す。群 {0, 2}(上限1)では、候補0が先に正になり、候補2は
      // ブロックされる。最後のステップ(sumX が 1 に届く。EPS ガードのフォールバック)では、候補2と候補3の増分が同じなので、ブロックを無視すると
      // 添字の小さい候補2(ブロック済み)が選ばれて上限を破る。ブロックを守れば候補3が選ばれる。
      const sets: OutcomeIndexSet[] = [
        { indices: [0], probability: 0.49995 },
        { indices: [1], probability: 0.49995 },
        { indices: [2, 3], probability: 0.0001 },
      ];
      const odds = [10, 10, 10000, 10000];
      const limits: GreedyGroupLimit[] = [{ members: [0, 2], max: 1 }];
      const free = runGreedyAllocation(4, odds, sets, 1000);
      // 前提: 上限なしでは、最後のステップで候補2(添字の小さい方)が選ばれる(= ブロックを無視した場合の選択)。群の2点とも正になる
      expect(free.fractions[2]!).toBeGreaterThan(0);
      expect(free.fractions[3]!).toBe(0);
      expect(positiveCount(free.fractions, [0, 2])).toBe(2);
      const actual = runGreedyAllocation(4, odds, sets, 1000, limits);
      expect(actual.fractions[2]!).toBe(0);
      expect(actual.fractions[3]!).toBeGreaterThan(0);
      expect(positiveCount(actual.fractions, [0, 2])).toBe(1);
      expect(actual.fractions).toEqual(bruteForceWithLimits(4, odds, sets, 1000, limits));
    });
  });

  describe("契約違反は例外にする", () => {
    const sets: OutcomeIndexSet[] = [{ indices: [0], probability: 1 }];
    it("同じ候補が複数の群に入っている", () => {
      expect(() =>
        runGreedyAllocation(3, [2, 2, 2], sets, 10, [
          { members: [0, 1], max: 1 },
          { members: [1, 2], max: 1 },
        ]),
      ).toThrow();
    });
    // Issue #535-B: 重複の検査は、上限なしの群(max が 1 未満)も含めて行う。本番(combo-bet-allocation.ts・bet-allocation.ts)は
    // 券種ごとに 1 群を、昇順の候補番号で重複なく作るので、これらの入力は本番からは届かない(組み立て方の誤りを捕まえる検査)。
    it("上限なしの群(max=0)に入った候補が、有効な群にも入っている(群の順序によらない)", () => {
      expect(() =>
        runGreedyAllocation(3, [2, 2, 2], sets, 10, [
          { members: [0, 1], max: 0 },
          { members: [1, 2], max: 1 },
        ]),
      ).toThrow(/候補 1 が複数の上限の群/);
      expect(() =>
        runGreedyAllocation(3, [2, 2, 2], sets, 10, [
          { members: [0, 1], max: 1 },
          { members: [1, 2], max: 0 },
        ]),
      ).toThrow(/候補 1 が複数の上限の群/);
    });
    it("上限なしの群どうしで同じ候補が重複している", () => {
      expect(() =>
        runGreedyAllocation(3, [2, 2, 2], sets, 10, [
          { members: [0, 1], max: 0 },
          { members: [1, 2], max: Number.NaN },
        ]),
      ).toThrow(/候補 1 が複数の上限の群/);
    });
    it("同じ群の中で同じ候補が 2 回入っている(有効な群・上限なしの群のどちらも)", () => {
      expect(() => runGreedyAllocation(3, [2, 2, 2], sets, 10, [{ members: [1, 1], max: 1 }])).toThrow(/候補 1 が複数の上限の群/);
      expect(() => runGreedyAllocation(3, [2, 2, 2], sets, 10, [{ members: [1, 1], max: 0 }])).toThrow(/候補 1 が複数の上限の群/);
    });
    it("重複のない上限なしの群が付いても、上限を渡さない呼び出しとビット単位で一致する", () => {
      const odds = [3, 2.5, 4];
      const multi: OutcomeIndexSet[] = [
        { indices: [0], probability: 0.4 },
        { indices: [1, 2], probability: 0.3 },
        { indices: [], probability: 0.3 },
      ];
      const base = runGreedyAllocation(3, odds, multi, 200);
      expect(base.fractions.filter((x) => x > 0).length).toBeGreaterThanOrEqual(1);
      expect(runGreedyAllocation(3, odds, multi, 200, [{ members: [0, 1], max: 0 }, { members: [2], max: -1 }])).toEqual(base);
    });
    it("候補番号が範囲外・非整数", () => {
      expect(() => runGreedyAllocation(3, [2, 2, 2], sets, 10, [{ members: [3], max: 1 }])).toThrow();
      expect(() => runGreedyAllocation(3, [2, 2, 2], sets, 10, [{ members: [-1], max: 1 }])).toThrow();
      expect(() => runGreedyAllocation(3, [2, 2, 2], sets, 10, [{ members: [0.5], max: 1 }])).toThrow();
    });
  });
});
