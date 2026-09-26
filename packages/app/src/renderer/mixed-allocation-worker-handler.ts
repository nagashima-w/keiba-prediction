/**
 * mixed-allocation-worker-handler — Worker側で実際に配分計算を行うロジック本体
 * (Issue #119・#24-C3)。`mixed-allocation.worker.ts`(薄い配線)から呼ばれる。
 *
 * 「ロジックは型検査される通常のモジュールに置く」(2026-09-25ゴーサイン)方針により、
 * このファイル自体はDOM/WebWorker固有のグローバル(`self`等)に一切触れず、ただの
 * 純関数として実装する(`global-error-handlers.ts`が`main.tsx`の薄い配線からロジックだけを
 * 切り出して単体テスト可能にしているのと同じ構造)。
 *
 * AC-1: `buildMixedAllocationDisplay`(画面側の同期経路〈`mixed-allocation-queue.ts`の
 * フォールバック〉と全く同じ関数)をそのまま呼ぶ。別実装を作らない。
 *
 * AC-4: 計算中の例外は、Worker自体をクラッシュさせず`{status:"error"}`という**メッセージ**で
 * 返す(`mixed-allocation-worker-pool.ts`のJSDoc「Worker自体の故障 と 1レースの計算失敗の
 * 切り分け」参照。これにより`onerror`/`onmessageerror`イベントは純粋にWorker自体の故障だけを
 * 意味するようになる)。
 */

import type { AnalysisResult } from "../shared/analysis-types.js";
import type { AllocationOutcome } from "./mixed-allocation-queue.js";
import type { MixedAllocationSettings } from "../shared/mixed-race-allocation.js";
import {
  buildMixedAllocationDisplay,
  type MixedRaceAllocationDisplayView,
} from "./mixed-allocation-view.js";
import type { AllocationWorkerResponseEnvelope } from "./mixed-allocation-worker-pool.js";

/** メインスレッドからWorkerへ送るリクエストの形。 */
export interface AllocationWorkerRequest {
  /** 応答を正しいレースへ結び付けるための識別子(計算内容には使わない)。 */
  readonly raceId: string;
  /** `buildMixedAllocationDisplay`の第1引数と同じもの(画面側の`computeAllocation`と同じ値)。 */
  readonly race: AnalysisResult;
  /** `buildMixedAllocationDisplay`の第2引数と同じもの。 */
  readonly settings: MixedAllocationSettings;
}

/**
 * リクエストを受けて配分計算を行い、応答メッセージを組み立てる(Worker側のロジック本体)。
 * 例外はここで捕まえ、Worker自体をクラッシュさせない(AC-4)。
 */
export function handleAllocationWorkerRequest(
  request: AllocationWorkerRequest,
): AllocationWorkerResponseEnvelope<MixedRaceAllocationDisplayView> {
  let outcome: AllocationOutcome<MixedRaceAllocationDisplayView>;
  try {
    outcome = { status: "ok", value: buildMixedAllocationDisplay(request.race, request.settings) };
  } catch {
    outcome = { status: "error" };
  }
  return { raceId: request.raceId, outcome };
}
