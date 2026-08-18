/**
 * 券種一般の配分最適化(combo-bet-allocation.ts)のベンチマークスクリプト(機能D-2a・Issue #14)。
 *
 * 背景(boss指摘・2026-08-05): 「合成データ(ランダムなev)による性能報告」は現実のオッズ分布を
 * 反映しておらず誤った結論を導いた(candidateCapが効いて速く見えていただけで、実際には
 * 貪欲法が浅い局所解しか探索できていなかった)。**候補は必ず `buildComboCandidates` 経由**で
 * 生成し(=実運用と同じEV算出経路を通す)、オッズは「真の的中確率の逆数×ノイズ係数」という
 * 決定的な生成規則で作る(市場のオッズが的中確率にほぼ比例する、という前提を模す)。
 * 疑似乱数は外部ライブラリに依存しない自前の決定的LCGを使うため、実行のたびに同じ結果になる
 * (再現性)。
 *
 * 使い方:
 *   pnpm tsx scripts/bench-allocation.ts
 *
 * 出力: 複数の乱数シードについて、
 *   - 列挙した買い目数・正EV候補数(複勝相当+ワイド+3連複の内訳)
 *   - candidateCapを外した場合(=987件全候補)とcandidateCap=50相当に絞った場合、それぞれの
 *     実行時間・Σx*(連続最適比率の合計)・converged(収束したか、それとも貪欲分割数を
 *     使い切って打ち切られただけか)・totalStake・betCount
 * を表示する。
 *
 * ## 「全点正EV」regime(boss指摘・2026-08-05への対応)
 *
 * 「現実的な市場」regime(ノイズ係数0.75〜1.25のランダム)では正EV候補が数百件規模
 * (実測502件程度)に留まり、貪欲法は greedySteps=1000 を使い切る前に自然収束する
 * (`converged=true`)。**この regime だけを見て「無制限側は常に収束する」と一般化するのは
 * 誤り**(boss訂正)。オッズの乖離幅を「真の的中確率の逆数 × 0.75 × 1.8」という固定倍率
 * (=1.35倍、ノイズを一切ランダム化しない)にすると、複勝18+ワイド153+3連複816=**987点
 * すべて**が正EV候補になり、貪欲法は改善の余地を残したまま `greedySteps` を使い切って
 * 打ち切られる(`converged=false`)。**打ち切りが実在することを一次データとして残すため**、
 * このregimeを別途 `runAllPositive` として実行する。
 */

import {
  allocateGeneralBets,
  buildComboCandidates,
  CONDITIONAL_BERNOULLI_MODEL,
  type AllocationCandidate,
  type ComboCandidateBuildResult,
} from "../packages/core/src/ev/combo-bet-allocation.js";
import type { JointModelHorse, PlaceOutcome } from "../packages/core/src/ev/place-joint-model.js";

/** 決定的な疑似乱数生成器(LCG)。シードを変えると別系列になるが、同じシードなら常に同じ列。 */
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** items(昇順)からk個の組合せを列挙する(place-joint-model.tsのkCombinationsと同じ発想)。 */
function kCombinations(items: readonly number[], k: number): number[][] {
  const results: number[][] = [];
  const current: number[] = [];
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

/**
 * オッズのノイズ係数を決める関数。真の的中確率pに対しodds=(1/p)*noiseFactor(p, rand)で
 * オッズを組み立てる。呼び出し側(市場regime / 全点正EV regime)で差し替える。
 */
type NoiseFactorFn = (rand: () => number) => number;

/** 「現実的な市場」regime: ノイズ係数0.75〜1.25のランダム(控除率・見積り誤差を模す)。
 *  1.0を跨ぐ範囲を含むため、EVがプラスになる買い目とマイナスになる買い目が両方生まれる
 *  (正EV候補は数百件規模に留まる。現実の市場に近い)。 */
const MARKET_NOISE: NoiseFactorFn = (rand) => 0.75 + rand() * 0.5;

/**
 * 「全点正EV」regime(boss指摘・2026-08-05再現条件): ノイズ係数を「0.75×1.8=1.35」に
 * 固定する(ランダム化しない)。的中確率×オッズ=1.35>閾値1.0となり、列挙した買い目
 * (複勝18+ワイド153+3連複816=987点)が**すべて**正EV候補になる。
 */
const ALL_POSITIVE_NOISE: NoiseFactorFn = () => 0.75 * 1.8;

/**
 * 1レース分の決定的なベンチデータを作る。
 * n頭・各馬の複勝圏内確率をランダム(だが決定的)に生成し、条件付きベルヌーイモデルで
 * 求めた各買い目の「真の的中確率」の逆数にノイズ係数を掛けたものをオッズとして採用する
 * (ノイズ係数の決め方はnoiseFactorで差し替える。市場regime/全点正EV regimeの切替に使う)。
 */
function buildRaceData(
  n: number,
  seed: number,
  noiseFactor: NoiseFactorFn,
): {
  horses: JointModelHorse[];
  oddsByKey: Map<string, number | null>;
} {
  const rand = makeRng(seed);
  const raw = Array.from({ length: n }, () => 0.05 + rand() * 0.3);
  const sum = raw.reduce((a, b) => a + b, 0);
  const horses: JointModelHorse[] = raw.map((p, i) => ({
    umaban: i + 1,
    placeProb: (p / sum) * 3,
  }));

  // 真の的中確率は本番と同じ条件付きベルヌーイモデル(CONDITIONAL_BERNOULLI_MODEL)から
  // 直接求める(buildComboCandidates内部の計算経路と同一のモデル)。
  const rawDistribution: readonly PlaceOutcome[] = CONDITIONAL_BERNOULLI_MODEL.buildDistribution(
    horses,
    3,
  );
  const hitProb = (combo: readonly number[]): number => {
    let total = 0;
    for (const outcome of rawDistribution) {
      if (combo.every((u) => outcome.placed.includes(u))) {
        total += outcome.probability;
      }
    }
    return total;
  };

  const oddsByKey = new Map<string, number | null>();
  const umabans = horses.map((h) => h.umaban);
  for (const comboSize of [1, 2, 3]) {
    for (const combo of kCombinations(umabans, comboSize)) {
      const key = combo.map((u) => String(u).padStart(2, "0")).join("");
      const p = hitProb(combo);
      if (p <= 0) {
        oddsByKey.set(key, null); // 的中確率0は現実には出目しない組合せ(欠損扱い)。
        continue;
      }
      oddsByKey.set(key, (1 / p) * noiseFactor(rand));
    }
  }

  return { horses, oddsByKey };
}

function run(seed: number, noiseFactor: NoiseFactorFn): void {
  const n = 18;
  const { horses, oddsByKey } = buildRaceData(n, seed, noiseFactor);

  const built1: ComboCandidateBuildResult = buildComboCandidates(horses, 3, 1, oddsByKey);
  const built2: ComboCandidateBuildResult = buildComboCandidates(horses, 3, 2, oddsByKey);
  const built3: ComboCandidateBuildResult = buildComboCandidates(horses, 3, 3, oddsByKey);
  const allCandidates: AllocationCandidate[] = [
    ...built1.candidates,
    ...built2.candidates,
    ...built3.candidates,
  ];

  console.log(
    `seed=${seed}: 正EV候補 ${allCandidates.length}件` +
      `(複勝相当${built1.candidates.length} / ワイド相当${built2.candidates.length} / 3連複相当${built3.candidates.length})`,
  );

  if (allCandidates.length === 0) {
    console.log("  (正EV候補が0件のためスキップ)");
    return;
  }

  const greedySteps = 1000;
  for (const candidateCap of [50, allCandidates.length]) {
    const t0 = performance.now();
    const result = allocateGeneralBets(horses, 3, allCandidates, {
      bankroll: 1_000_000,
      perRaceCap: 100_000,
      kellyFraction: 0.5,
      betUnit: 100,
      greedySteps,
      candidateCap,
    });
    const t1 = performance.now();
    const sumX = result.allocations.reduce((acc, a) => acc + a.continuousFraction, 0);
    // Σx* = 使用ステップ数 × (1/greedySteps) が貪欲ループの不変条件(1ステップ=δの加算)
    // なので、使用ステップ数はΣx*から逆算できる(表示用の参考値。判定の根拠はconverged)。
    const stepsUsed = Math.round(sumX * greedySteps);
    console.log(
      `  candidateCap=${candidateCap}: ${(t1 - t0).toFixed(1)}ms` +
        ` / Σx*=${sumX.toFixed(6)}` +
        ` / 使用ステップ=${stepsUsed}/${greedySteps}` +
        ` / converged=${result.diagnostics.converged}` +
        ` / totalStake=${result.totalStake}` +
        ` / betCount=${result.betCount}` +
        ` / truncated=${result.diagnostics.truncatedByCapCount}`,
    );
  }
}

console.log("=== 市場regime(ノイズ0.75〜1.25のランダム。正EV候補は数百件規模) ===");
const marketSeeds = [7, 13, 99, 555, 4242, 8, 21, 100];
for (const seed of marketSeeds) {
  run(seed, MARKET_NOISE);
}

console.log("");
console.log(
  "=== 全点正EV regime(オッズ=真の的中確率の逆数×1.35固定。987点すべてが正EV候補。boss再現条件) ===",
);
// このregimeは正EV候補数が常に987(複勝18+ワイド153+3連複816の全数)になるため、
// 複数シードを試して「打ち切り(converged=false)が偶然ではなく再現する」ことを示す。
const allPositiveSeeds = [7, 13, 99];
for (const seed of allPositiveSeeds) {
  run(seed, ALL_POSITIVE_NOISE);
}
