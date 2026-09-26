/**
 * verify-worker-pool-prepare — Issue #119(#24-C3)のAC-7・AC-8の実機確認用フィクスチャを
 * 生成する。
 *
 * `bench-mixed-allocation.ts`と**同じ実オッズ・実prior・同じ計測条件**(中央16頭・
 * `docs/investigations/combo-odds-real-fetch/central-on.json`・kaisaiDate=20260628・
 * LLM未使用・λ=0.5・EV閾値1.0)でAnalysisResultを読み込み(`loadAnalysisResult`を再利用。
 * 単一定義の原則)、`buildMixedAllocationDisplay`を直接呼んだ「正解」の結果と合わせて
 * JSONファイルへ書き出す。ネットワークには一切出ない。
 *
 * このファイル自体はNode(vitestではなくtsx)で実行する通常のスクリプトであり、
 * `pnpm typecheck`(ルート、tsconfig.scripts.json)の対象になる。
 *
 * ## 使い方
 *   pnpm tsx scripts/verify-worker-pool-prepare.ts <出力先JSONパス>
 *
 * 出力先を省略すると `os.tmpdir()/keiba-worker-pool-verify.json` に書く。
 * 出力JSONの形は`WorkerPoolVerifyFixture`(このファイルの型をそのまま`verify-worker-pool-electron.mjs`
 * 側でも参照する。ただしElectron側は.mjsのため型は付かず、JSON構造として合わせる)。
 */

import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadAnalysisResult } from "./bench-mixed-allocation.js";
import { buildMixedAllocationDisplay } from "../packages/app/src/renderer/mixed-allocation-view.js";
import type { AnalysisResult } from "../packages/app/src/shared/analysis-types.js";
import type { MixedAllocationSettings } from "../packages/app/src/shared/mixed-race-allocation.js";
import type { MixedRaceAllocationDisplayView } from "../packages/app/src/renderer/mixed-allocation-view.js";

/** `verify-worker-pool-electron.mjs`が読み込むフィクスチャの形。 */
export interface WorkerPoolVerifyFixture {
  readonly race: AnalysisResult;
  readonly settings: MixedAllocationSettings;
  /** `buildMixedAllocationDisplay(race, settings)`を直接呼んだ「正解」の結果。 */
  readonly expected: MixedRaceAllocationDisplayView;
}

async function main(): Promise<void> {
  const outPath = process.argv[2] ?? path.join(os.tmpdir(), "keiba-worker-pool-verify.json");

  const race = await loadAnalysisResult();
  // bench-mixed-allocation.tsのrunPerRaceTimingと同じ既定設定(実運用相当)。
  const settings: MixedAllocationSettings = {
    bankroll: 1_000_000,
    perRaceCap: 100_000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    includeExactaInAllocation: true,
  };
  const expected = buildMixedAllocationDisplay(race, settings);

  const fixture: WorkerPoolVerifyFixture = { race, settings, expected };
  writeFileSync(outPath, JSON.stringify(fixture), "utf-8");
  console.log(`フィクスチャを書き出しました: ${outPath}`);
  console.log(`raceId=${race.raceId} rows=${race.rows.length}頭`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
