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
 * 1レース分の決定的なベンチデータを作る。
 * n頭・各馬の複勝圏内確率をランダム(だが決定的)に生成し、条件付きベルヌーイモデルで
 * 求めた各買い目の「真の的中確率」の逆数にノイズ係数(0.75〜1.25。控除率・見積り誤差を
 * 模す)を掛けたものをオッズとして採用する。これにより「オッズがたまたま的中確率と
 * 釣り合う」買い目が一定割合残り、正EV候補が数百件規模になる(現実の市場に近い)。
 */
function buildRaceData(
  n: number,
  seed: number,
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

  // オッズ = 1/真の的中確率 × ノイズ係数(0.75〜1.25。控除率・見積り誤差を模す)。
  // ノイズが1.0を跨ぐ範囲を含むため、EVがプラスになる買い目とマイナスになる買い目が
  // 両方生まれる(現実のオッズ表と同じ「玉石混交」の分布になる)。
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
      const noise = 0.75 + rand() * 0.5;
      oddsByKey.set(key, (1 / p) * noise);
    }
  }

  return { horses, oddsByKey };
}

function run(seed: number): void {
  const n = 18;
  const { horses, oddsByKey } = buildRaceData(n, seed);

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

  for (const candidateCap of [50, allCandidates.length]) {
    const t0 = performance.now();
    const result = allocateGeneralBets(horses, 3, allCandidates, {
      bankroll: 1_000_000,
      perRaceCap: 100_000,
      kellyFraction: 0.5,
      betUnit: 100,
      greedySteps: 1000,
      candidateCap,
    });
    const t1 = performance.now();
    const sumX = result.allocations.reduce((acc, a) => acc + a.continuousFraction, 0);
    console.log(
      `  candidateCap=${candidateCap}: ${(t1 - t0).toFixed(1)}ms` +
        ` / Σx*=${sumX.toFixed(4)}` +
        ` / converged=${result.diagnostics.converged}` +
        ` / totalStake=${result.totalStake}` +
        ` / betCount=${result.betCount}` +
        ` / truncated=${result.diagnostics.truncatedByCapCount}`,
    );
  }
}

const seeds = [7, 13, 99, 555, 4242, 8, 21, 100];
for (const seed of seeds) {
  run(seed);
}
