/**
 * combo-odds-key.ts の buildComboOddsCellMap 自己防御(受け入れ条件18・
 * code-reviewer指摘4・機能D-2b-A・Issue #32)の性能検証スクリプト。
 *
 * 背景(boss差し戻し・2026-08-07): buildComboOddsCellMapのJSDocに書いた
 * 「検証あり/検証なしの実行時間差は約1〜2%で無視できる」という主張が、
 * リポジトリ内のどのファイル・コマンドからも再現できない状態だった
 * (AC16違反・#14で確立した規律〈scripts/bench-allocation.ts〉の不履行)。
 * 本スクリプトはその再現手段として追加する(scripts/bench-allocation.tsの流儀に倣う:
 * 決定的な入力・CIから呼ばない・再現コマンドをJSDocに併記)。
 *
 * 使い方:
 *   pnpm tsx scripts/bench-combo-odds-key.ts
 *
 * 入力: C(18,3)=816通りの馬番3頭組(1〜18の全組合せ。頭数18は既存 MAX_UMABAN の上限)。
 * 疑似乱数は使わない(入力そのものが組合せの列挙で既に決定的なため、実測ベンチマークとしては
 * 疑似乱数のシード管理が不要)。
 *
 * 出力: 「検証あり(buildComboOddsCellMapを直接呼ぶ、現行実装)」と
 * 「検証なし(修正前相当。同じキー生成・Map格納ロジックだけをローカルに複製し、
 * validateComboUmabanRangeの呼び出しだけを取り除いたもの)」を、同じ入力に対して
 * 交互に複数回実行し、実行時間の分布(中央値・平均・p95)を比較する。
 */

import {
  buildComboOddsCellMap,
  buildComboOddsKey,
  type ComboOddsCell,
  type ComboOddsEntry,
} from "../packages/core/src/scraper/combo-odds-key.js";

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
 * 検証なし版(修正前相当のローカル複製)。buildComboOddsCellMapから
 * validateComboUmabanRangeの呼び出しだけを取り除いた同型の実装。
 * combo-odds-key.ts本体を変更せず、ベンチマーク専用にここへ複製する
 * (本番コードに「検証を無効化するモード」を持たせるのは事故のもとであり、避ける)。
 */
function buildComboOddsCellMapNoValidate(
  entries: readonly ComboOddsEntry[],
): Map<string, ComboOddsCell> {
  const map = new Map<string, ComboOddsCell>();
  for (const { umabans, cell } of entries) {
    const key = buildComboOddsKey(umabans);
    map.set(key, cell);
  }
  return map;
}

/** 実行時間の分布(ms)から中央値・平均・p95を求める。 */
function stats(samples: readonly number[]): { median: number; mean: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  return { median, mean, p95 };
}

const umabans = Array.from({ length: 18 }, (_, i) => i + 1);
const combos = kCombinations(umabans, 3); // C(18,3) = 816
console.log(`組合せ数: ${combos.length}(C(18,3)。期待値816と一致: ${combos.length === 816}）`);

const entries: ComboOddsEntry[] = combos.map((c) => ({
  umabans: c,
  cell: { oddsMin: 5.0, oddsMax: null, ninki: null },
}));

const ITER = 500;
const withValidation: number[] = [];
const withoutValidation: number[] = [];

// 交互に実行してJITウォームアップ・実行順序に由来する偏りを避ける。
for (let i = 0; i < ITER; i++) {
  const t1 = performance.now();
  buildComboOddsCellMap(entries);
  withValidation.push(performance.now() - t1);

  const t2 = performance.now();
  buildComboOddsCellMapNoValidate(entries);
  withoutValidation.push(performance.now() - t2);
}

const withStats = stats(withValidation);
const withoutStats = stats(withoutValidation);

console.log(`試行回数: ${ITER}`);
console.log(
  `検証あり(現行実装): 中央値=${withStats.median.toFixed(4)}ms 平均=${withStats.mean.toFixed(4)}ms p95=${withStats.p95.toFixed(4)}ms`,
);
console.log(
  `検証なし(修正前相当): 中央値=${withoutStats.median.toFixed(4)}ms 平均=${withoutStats.mean.toFixed(4)}ms p95=${withoutStats.p95.toFixed(4)}ms`,
);
const diffPercent = ((withStats.mean - withoutStats.mean) / withoutStats.mean) * 100;
console.log(`平均の差: ${(withStats.mean - withoutStats.mean).toFixed(4)}ms(${diffPercent.toFixed(1)}%)`);
