/**
 * CPU 測定の処理本体(Issue #159〈#21-A〉)。普通の Worker と Durable Object の両方から同じ関数を呼ぶ。
 *
 * 測る処理(同梱の保存済みフィクスチャを入力にし、ネットワークは使わない):
 *  - parse: 出馬表1ページ(中央16頭・277KB)のパース(`parseShutuba`)
 *  - score: 1レース分の確率計算(analysis-pipeline.ts のスコアリング段と同じ経路: 先読みリーク遮断 →
 *    `buildPriorInput` → `computeFieldPriors`。LLM は使わない)
 *  - alloc: 配分計算 `buildMixedAllocationDisplay`(単勝・複勝・ワイド・三連複。`scripts/bench-mixed-allocation.ts`
 *    の「1レースあたりの所要時間」節と同じ入力・同じ設定)
 *  - allocFull: 同(馬連・馬単・三連単・枠連の実オッズも渡す。同ファイル 5. 節と同じ入力。全券種を
 *    配分に含めたときの実運用と同じ負荷)
 * 入力の alloc 系 JSON は `pnpm tsx scripts/cloudflare-spike/gen-alloc-input.ts` で再生成できる。
 *
 * **時計について**: 本番の Workers では、実行中に I/O がないと `performance.now()` は進まない。そこで
 * 処理の直後の差(insideMs)と、I/O を1つ挟んだ後の差(afterIoMs)の両方を返す。ローカル(workerd)では
 * どちらも実時間が読める。
 */

import raceDataJson from "../../../docs/investigations/combo-odds-real-fetch/central-on.json";
import shutubaHtml from "../../../fixtures/shutuba_202603020211.html";
import { buildMixedAllocationDisplay } from "../../../packages/app/src/renderer/mixed-allocation-view.js";
import type { MixedCandidateBuildInput } from "../../../packages/app/src/shared/mixed-candidates.js";
import type { MixedAllocationSettings } from "../../../packages/app/src/shared/mixed-race-allocation.js";
import { parseRaceId, venueKindOfRaceId } from "../../../packages/core/src/scraper/ids.js";
import { parseShutuba } from "../../../packages/core/src/scraper/parse-shutuba.js";
import type { RaceData } from "../../../packages/core/src/scraper/scrape-race.js";
import { classifyTrackWetness } from "../../../packages/core/src/scorer/derive-features.js";
import { buildPriorInput, computeFieldPriors } from "../../../packages/core/src/scorer/prior.js";
import { excludeOwnRaceResults, filterRaceDataBefore } from "../../../packages/core/src/scorer/snapshot-filter.js";
import type { CpuRuntime, CpuWork } from "../../../scripts/cloudflare-spike/result.js";
import allocFullInput from "./fixtures/alloc-full-input.json";
import allocInput from "./fixtures/alloc-input.json";

/** 実レース日(`scripts/bench-mixed-allocation.ts` と同じ。日付がドリフトしないよう固定する)。 */
const RACE_DATE = "2026/06/28";
/** race_id=202603020211 の場コード 03 = 福島(`venueNameFromRaceId` と同じ結果)。 */
const VENUE_NAME = "福島";

/** `scripts/bench-mixed-allocation.ts` の `runPerRaceTiming` と同じ既定の設定。 */
const ALLOC_SETTINGS: MixedAllocationSettings = {
  bankroll: 1_000_000,
  perRaceCap: 100_000,
  kellyFraction: 0.5,
  evThreshold: 1.0,
  includeComboOdds: true,
  includeWideInAllocation: true,
  includeTrioInAllocation: true,
  includeQuinellaInAllocation: true,
  includeExactaInAllocation: true,
  includeTrifectaInAllocation: true,
  includeBracketQuinellaInAllocation: true,
};

const raceData = raceDataJson as unknown as RaceData;

/** 反復回数の上限(誤指定で1リクエストが暴走しないようにする)。 */
export const MAX_REPS = 1_000_000;

/** 処理を1回実行し、結果の健全性を示す数(出馬表の頭数など)を返す。 */
function runOnce(work: CpuWork): number {
  switch (work) {
    case "parse":
      return parseShutuba(shutubaHtml).horses.length;
    case "score": {
      const raceId = parseRaceId(raceData.raceId);
      const race = filterRaceDataBefore(excludeOwnRaceResults(raceData, raceId).raceData, RACE_DATE).raceData;
      const isWet = classifyTrackWetness(race.race.trackCondition ?? null, race.race.courseType)?.isWet ?? false;
      const inputs = race.horses.map((horse) =>
        buildPriorInput({
          horse: horse.shutuba,
          raceResults: horse.results ?? [],
          race: {
            courseType: race.race.courseType,
            distance: race.race.distance,
            venueName: VENUE_NAME,
            isWet,
            date: RACE_DATE,
            venueKind: venueKindOfRaceId(raceId),
          },
          fieldSize: race.horses.length,
        }),
      );
      return computeFieldPriors(inputs).length;
    }
    case "alloc":
    case "allocFull": {
      const input = (work === "alloc" ? allocInput : allocFullInput) as unknown as MixedCandidateBuildInput;
      const view = buildMixedAllocationDisplay(input, ALLOC_SETTINGS);
      // 「混在配分が実際に計算された」ことの確認(早期 return で空振りしていないこと)。
      return view.kind === "mixed" ? view.result.betCount : -1;
    }
  }
}

export interface CpuResponse {
  readonly ok: true;
  readonly runtime: CpuRuntime;
  readonly work: CpuWork;
  readonly reps: number;
  /** 最後の1回の結果の健全性を示す数(parse=頭数 / score=頭数 / alloc系=買い目の点数。-1 は混在配分にならなかった)。 */
  readonly check: number;
  /** 処理の直後の時刻差(ms)。本番では 0 になりうる。 */
  readonly insideMs: number;
  /** 処理のあと I/O を1つ挟んだ後の時刻差(ms)。 */
  readonly afterIoMs: number;
}

export function isCpuWork(value: string): value is CpuWork {
  return value === "parse" || value === "score" || value === "alloc" || value === "allocFull";
}

/** work を reps 回繰り返す。`io` は処理のあとに挟む I/O(Worker は Cache API、DO は storage の読み)。 */
export async function runCpu(
  runtime: CpuRuntime,
  work: CpuWork,
  reps: number,
  io: () => Promise<unknown>,
): Promise<CpuResponse> {
  const t0 = performance.now();
  let check = 0;
  for (let i = 0; i < reps; i += 1) {
    check = runOnce(work);
  }
  const insideMs = performance.now() - t0;
  await io();
  const afterIoMs = performance.now() - t0;
  return { ok: true, runtime, work, reps, check, insideMs, afterIoMs };
}
