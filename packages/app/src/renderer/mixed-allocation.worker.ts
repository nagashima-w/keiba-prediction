/**
 * mixed-allocation.worker — 配分計算を実行するWorkerの薄い配線(Issue #119・#24-C3)。
 *
 * 受信 → `handleAllocationWorkerRequest`(ロジック本体・`mixed-allocation-worker-handler.ts`。
 * 単体テスト済み) → 返信、だけを行う。ロジックは一切持たない。
 *
 * ## 型検査の方針(2026-09-25ゴーサイン): tsconfigにWebWorker libを追加しない
 *
 * `packages/app/tsconfig.json`は`lib: ["ES2022","DOM","DOM.Iterable"]`で、`WebWorker`libを
 * 含まない(DOM libとWebWorker libを同一プログラムで混在させると型が衝突しやすいため)。
 * このファイルでは`self`をDedicatedWorkerGlobalScopeとして型付けせず、
 * **このファイル内だけで使うAPI(受信・送信の2つ)だけを持つ最小限のローカル型**に
 * `as unknown as`でキャストして使う。ロジック本体(`mixed-allocation-worker-handler.ts`)は
 * このような特殊な型付けを一切必要としない、通常の(DOM libの範囲で型検査される)モジュールに
 * 置いてある。
 *
 * Vite/Rollupは`new Worker(new URL("./mixed-allocation.worker.ts", import.meta.url), {type:
 * "module"})`という呼び出しパターン(`mixed-allocation-worker-pool.ts`の
 * `createRealAllocationWorker`)を静的に検出し、本ファイルを別チャンクとしてビルドする。
 */

import {
  handleAllocationWorkerRequest,
  type AllocationWorkerRequest,
} from "./mixed-allocation-worker-handler.js";

/** このファイル内だけで使う最小限のself型(WebWorker libを増やさないための局所的な型)。 */
interface AllocationWorkerSelf {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

const workerSelf = self as unknown as AllocationWorkerSelf;

workerSelf.onmessage = (event) => {
  const response = handleAllocationWorkerRequest(event.data as AllocationWorkerRequest);
  workerSelf.postMessage(response);
};
