/**
 * 券種横断の馬券配分(機能D-2c第4段・Issue #28)の再現可能な計測スクリプト。
 *
 * ## 経緯(code-reviewer指摘・boss確認2026-08-13)
 *
 * `mixed-allocation-view.ts`・`mixed-allocation-cache.ts` のJSDocには当初、
 * (a) `greedySteps` の刻み幅が券種構成比を左右する具体的な数値例
 * (b) 1レースあたりの所要時間(約93ms・12レースで約1.1秒/レンダー)
 * という2つの実測値の主張が書かれていたが、**いずれもリポジトリ内に再現手段が無かった**
 * (`performance.now()`/`Date.now()` の計測コードが0件)。boss が実データで測り直したところ
 * (a) の具体的な数値(「資金500万でも0円」)は**再現しなかった**(条件を落として伝えた
 * オーケストレーターの誤り。α平坦化した合成確率での計測を無条件の事実として伝えていた)。
 *
 * この欠陥クラス(検証手段のない数値をコードに書く)が本プロジェクトで繰り返し指摘された
 * ため、`scripts/bench-allocation.ts`(D-2a・Issue #14)の前例に倣い、**次に読む人が
 * 同じ数値を自分の手元で再現できる**スクリプトとしてここに残す。
 *
 * ## 計測条件(必ず併記すること。boss指摘)
 * - 保存済みの実オッズフィクスチャ `docs/investigations/combo-odds-real-fetch/central-on.json`
 *   (中央16頭・race_id=202603020211・確定オッズ・**実レース日 2026/06/28**)を入力にする。
 *   **ネットワークには一切出ない**
 * - `runAnalysis` には `kaisaiDate="20260628"`(実レース日)を明示して渡す。渡さないと
 *   `resolveAnalysisDate` が実行日(`now()`)へフォールバックし、季節分類・休み明け走目の
 *   基準日が壁時計時刻とともにドリフトする(#40「#35-1a」で判明した欠陥。
 *   `docs/current-spec.md`「9. 確率の質の計測基盤」・Issue #40 参照)
 * - `runAnalysis` を `deps.analyze: null`(LLM未使用)で実行し、scorer が出す **実 prior**
 *   (LLM補正なし=adjustedProb===prior)をそのまま使う
 * - **戦績の先読みリークは遮断していない**: `deps.scrape` に渡すフィクスチャの
 *   `horses[].results` は日付フィルタをかけていない生データであり、当該レース自身の着順が
 *   prior の材料に混入したまま計測している(本番の `analysis-pipeline.ts` と同じ状態。
 *   是正は #39)。したがって本スクリプトが出す prior・EV・配分の絶対値は、確率の質の指標として
 *   額面通りに読んではならない(リーク遮断込みの計測は `ev/probability-quality.ts` +
 *   `scripts/test/probability-quality-regression.test.ts` を参照すること。#40「#35-1a」)。
 *   本スクリプトの目的は `greedySteps` 感度・所要時間の計測であり、prior の質そのものの
 *   計測ではないため、ここでは意図的にリーク遮断を追加していない
 * - ケリー係数 λ=0.5、EV閾値1.0(既定)
 *
 * ## 使い方
 *   pnpm tsx scripts/bench-mixed-allocation.ts
 *
 * ## 出力
 * 1. `greedySteps` 感度表: 資金/1レース上限の組合せ × greedySteps(既定1000 / 400)で、
 *    総額・点数・券種別構成比(複勝/ワイド/三連複)を表示する。
 * 2. 1レースあたりの所要時間(`buildMixedAllocationDisplay` を実運用と同じ既定設定で
 *    複数回実行した平均。ウォームアップ1回を除く)。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseKaisaiDate, type RaceData } from "../packages/core/src/index.js";
import {
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../packages/app/src/main/analysis-pipeline.js";
import type { AnalysisResult } from "../packages/app/src/shared/analysis-types.js";
import {
  buildMixedCandidates,
  type MixedCandidateBuildInput,
} from "../packages/app/src/renderer/mixed-candidates.js";
import {
  allocateGeneralBets,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type GeneralBetAllocationConfig,
  type JointModelHorse,
} from "../packages/core/src/ev/combo-bet-allocation.js";
import {
  buildMixedAllocationDisplay,
  type MixedAllocationSettings,
} from "../packages/app/src/renderer/mixed-allocation-view.js";

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "investigations",
  "combo-odds-real-fetch",
  "central-on.json",
);

/** フィクスチャ(保存済みRaceData)を読み、runAnalysisを実LLM無しで実行してAnalysisResultを得る。 */
async function loadAnalysisResult(): Promise<AnalysisResult> {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  // 保存済みフィクスチャは scrapeRace の戻り値(RaceData)をそのまま JSON.stringify したもの
  // (scripts/investigate-combo-odds-real-fetch.ts が書き出した形式)。ネットワークには出ない。
  const raceData = JSON.parse(raw) as RaceData;

  const deps: AnalysisPipelineDeps = {
    scrape: async () => raceData,
    // LLM未使用(analyze:null)。scorerが出すpriorがそのままadjustedProbになる(実prior)。
    analyze: null,
    saveAnalysis: () => 0,
  };
  // kaisaiDateを明示する(実レース日2026/06/28。#40「#35-1a」)。渡さないとresolveAnalysisDateが
  // 実行日(now())へフォールバックし、季節分類・休み明け走目の基準日が壁時計時刻とともに
  // ドリフトする(計測条件のJSDoc参照)。
  return runAnalysis(raceData.raceId, parseKaisaiDate("20260628"), deps);
}

/** AnalysisResultから、buildMixedCandidates/allocateGeneralBetsが要求する最小構造を取り出す。 */
function toMixedCandidateInput(result: AnalysisResult): MixedCandidateBuildInput {
  return {
    oddsStatus: result.oddsStatus,
    rows: result.rows,
    ...(result.wideCombo !== undefined ? { wideCombo: result.wideCombo } : {}),
    ...(result.trioCombo !== undefined ? { trioCombo: result.trioCombo } : {}),
    ...(result.comboOdds !== undefined ? { comboOdds: result.comboOdds } : {}),
  };
}

/** 券種別(umabans.length)に金額・点数を集計する(mixed-allocation-view.tsのbuildMixedAllocationBreakdownと同じ集計方式)。 */
function summarizeByBetType(
  allocations: readonly { readonly umabans: readonly number[]; readonly stake: number }[],
): { place: number; wide: number; trio: number } {
  const sumOf = (n: number): number =>
    allocations.filter((a) => a.umabans.length === n).reduce((s, a) => s + a.stake, 0);
  return { place: sumOf(1), wide: sumOf(2), trio: sumOf(3) };
}

async function runGreedyStepsSensitivity(result: AnalysisResult): Promise<void> {
  const race = toMixedCandidateInput(result);
  const mixed = buildMixedCandidates(race, { evConfig: { threshold: 1.0 } });
  const horses: JointModelHorse[] = result.rows.map((r) => ({
    umaban: r.umaban,
    placeProb: r.adjustedProb,
  }));

  console.log("=== greedySteps 感度(中央16頭・実オッズ・実prior・λ=0.5) ===");
  console.log(
    `候補: 複勝${mixed.candidates.filter((c) => c.umabans.length === 1).length}件 / ` +
      `ワイド${mixed.candidates.filter((c) => c.umabans.length === 2).length}件 / ` +
      `三連複${mixed.candidates.filter((c) => c.umabans.length === 3).length}件`,
  );

  const scenarios: { readonly label: string; readonly bankroll: number; readonly perRaceCap: number }[] = [
    { label: "100万/100万", bankroll: 1_000_000, perRaceCap: 1_000_000 },
    { label: "100万/10万", bankroll: 1_000_000, perRaceCap: 100_000 },
    { label: "500万/500万", bankroll: 5_000_000, perRaceCap: 5_000_000 },
  ];
  const greedyStepsValues = [DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps, 400];

  for (const scenario of scenarios) {
    for (const greedySteps of greedyStepsValues) {
      const config: GeneralBetAllocationConfig = {
        bankroll: scenario.bankroll,
        perRaceCap: scenario.perRaceCap,
        kellyFraction: 0.5,
        betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
        greedySteps,
        candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
      };
      const alloc = allocateGeneralBets(horses, mixed.topFinishCount, mixed.candidates, config);
      const byType = summarizeByBetType(alloc.allocations);
      const total = alloc.totalStake;
      const pct = (n: number): string => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%");
      console.log(
        `  ${scenario.label} / greedySteps=${greedySteps}: ` +
          `総額${total.toLocaleString()}円 / ${alloc.betCount}点 / ` +
          `複勝${pct(byType.place)} / ワイド${pct(byType.wide)} / 三連複${pct(byType.trio)}`,
      );
    }
  }
}

async function runPerRaceTiming(result: AnalysisResult): Promise<void> {
  const race = toMixedCandidateInput(result);
  const settings: MixedAllocationSettings = {
    bankroll: 1_000_000,
    perRaceCap: 100_000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
  };

  // ウォームアップ1回(JITの影響を減らす)を除いた上で、実運用の1レース分の呼び出し
  // (buildMixedAllocationDisplay。既定greedySteps)を繰り返し計測する。
  buildMixedAllocationDisplay(race, settings);
  const iterations = 30;
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    buildMixedAllocationDisplay(race, settings);
    samples.push(performance.now() - t0);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const max = Math.max(...samples);
  console.log("");
  console.log("=== 1レースあたりの所要時間(buildMixedAllocationDisplay・既定greedySteps) ===");
  console.log(
    `平均${avg.toFixed(1)}ms / 最大${max.toFixed(1)}ms(n=${iterations}回・中央16頭。候補件数は上のgreedySteps感度の出力を参照)`,
  );
  console.log(
    `12レース一括分析の参考値(単純に12倍。実際は details 開閉等でレース単位に再計算される` +
      `〈AC21・mixed-allocation-cache.ts〉ため常に発生するわけではない): 約${(avg * 12).toFixed(0)}ms/レンダー`,
  );
}

async function main(): Promise<void> {
  const result = await loadAnalysisResult();
  console.log(`raceId=${result.raceId} rows=${result.rows.length}頭 oddsStatus=${result.oddsStatus}`);
  await runGreedyStepsSensitivity(result);
  await runPerRaceTiming(result);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
