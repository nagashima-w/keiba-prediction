/**
 * 配分計算の CPU 測定(Issue #159〈#21-A〉)で Worker に同梱する入力を生成する。
 *
 * `scripts/bench-mixed-allocation.ts` と同じ入力・同じ計測条件(中央16頭・race_id=202603020211・
 * 実オッズ・実 prior・実レース日 2026/06/28・LLM 未使用)で `AnalysisResult` を作り、
 * `buildMixedAllocationDisplay` が受け取る最小構造(`MixedCandidateBuildInput`)だけを JSON に書く。
 * `runAnalysis` 本体は better-sqlite3 等を巻き込むため Worker には載せず、入力だけをここで作る。
 * ネットワークには出ない。
 *
 * 2種類の入力を作る(Worker 側では alloc / allocFull と呼ぶ)。
 *  - `alloc-input.json`: `bench-mixed-allocation.ts` の「1レースあたりの所要時間」節と同じ入力
 *    (単勝・複勝・ワイド・三連複の候補。馬連・馬単・三連単・枠連の組合せオッズは渡さない)
 *  - `alloc-full-input.json`: 同 5. 節(`runBracketQuinellaAllocationComparison`)の「枠連が入るレース」と
 *    同じ入力(馬連・馬単・三連単・枠連の実オッズフィクスチャも渡す。全券種を配分に含めたときの
 *    実運用と同じ負荷)。
 *
 * 使い方(リポジトリのルートで):
 *   pnpm tsx scripts/cloudflare-spike/gen-alloc-input.ts
 * 出力: spikes/cloudflare/src/fixtures/alloc-input.json と alloc-full-input.json
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AnalysisResult,
  ComboOddsScrapeOutcomeView,
} from "../../packages/app/src/shared/analysis-types.js";
import type { MixedCandidateBuildInput } from "../../packages/app/src/shared/mixed-candidates.js";
import { toComboOddsScalarMap } from "../../packages/core/src/scraper/combo-odds-key.js";
import { parseComboOdds } from "../../packages/core/src/scraper/parse-combo-odds.js";
import { loadAnalysisResult } from "../bench-mixed-allocation.js";

/** AnalysisResult から、候補ビルダー・配分計算が要求する最小構造を取り出す(bench と同じ形)。 */
export function toMixedCandidateInput(result: AnalysisResult): MixedCandidateBuildInput {
  return {
    oddsStatus: result.oddsStatus,
    rows: result.rows,
    ...(result.wideCombo !== undefined ? { wideCombo: result.wideCombo } : {}),
    ...(result.trioCombo !== undefined ? { trioCombo: result.trioCombo } : {}),
    ...(result.comboOdds !== undefined ? { comboOdds: result.comboOdds } : {}),
  };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "spikes", "cloudflare", "src", "fixtures");

type ComboBetType = "quinella" | "exacta" | "trifecta" | "bracketQuinella";

/** 組合せオッズのフィクスチャをパースして Record 形にする(scrape-race.ts と同じ変換経路)。 */
function loadCombo(fileName: string, betType: ComboBetType): Record<string, number | null> {
  const json = readFileSync(path.join(REPO_ROOT, "fixtures", fileName), "utf-8");
  const parsed = parseComboOdds(json, betType);
  if (parsed.state !== "available") {
    throw new Error(`${fileName} が available ではありません(state=${parsed.state})`);
  }
  return Object.fromEntries(toComboOddsScalarMap(parsed.odds));
}

/** 全券種(馬連・馬単・三連単・枠連)の実オッズを足した入力。bench 5. 節の race16 と同じ。 */
export function toFullMixedCandidateInput(result: AnalysisResult): MixedCandidateBuildInput {
  const base = toMixedCandidateInput(result);
  const bracketOutcome: NonNullable<ComboOddsScrapeOutcomeView["bracketQuinella"]> = {
    state: "available",
    diagnostics: {
      betType: "bracketQuinella",
      requestCount: 1,
      expectedComboCount: 0,
      obtainedComboCount: 0,
      missingComboCount: 0,
      axisUmabans: [],
      attempts: [],
      numericConflictCount: 0,
      nullWinConflictCount: 0,
      conflictSamples: [],
    },
  };
  return {
    ...base,
    quinellaCombo: loadCombo("odds_quinella_202603020211.json", "quinella"),
    exactaCombo: loadCombo("odds_exacta_202603020211.json", "exacta"),
    trifectaCombo: loadCombo("odds_trifecta_202603020211.json", "trifecta"),
    bracketQuinellaCombo: loadCombo("odds_wakuren_202603020211.json", "bracketQuinella"),
    comboOdds: { ...base.comboOdds, bracketQuinella: bracketOutcome },
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await loadAnalysisResult();
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [fileName, input] of [
    ["alloc-input.json", toMixedCandidateInput(result)],
    ["alloc-full-input.json", toFullMixedCandidateInput(result)],
  ] as const) {
    writeFileSync(path.join(OUT_DIR, fileName), JSON.stringify(input));
    console.log(`書き出しました: ${path.join(OUT_DIR, fileName)}(rows=${input.rows.length}頭)`);
  }
}
