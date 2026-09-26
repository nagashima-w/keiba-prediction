import { describe, expect, it, vi } from "vitest";

import {
  createMixedAllocationCache,
  type MixedAllocationCacheKey,
} from "../src/renderer/mixed-allocation-cache.js";
import type { AllocationOutcome } from "../src/renderer/mixed-allocation-queue.js";
import {
  ALLOCATION_WORKER_CRASH_OPERATION,
  ALLOCATION_WORKER_STARTUP_FAILURE_OPERATION,
  computeAllocationWorkerPoolCap,
  createAllocationRunner,
  createAllocationWorkerPool,
  type WorkerLike,
} from "../src/renderer/mixed-allocation-worker-pool.js";

// mixed-allocation-cache.test.ts / mixed-allocation-queue.test.tsと同じ流儀
// (安定した1つのrace参照・overridesで組み立てるkey()ヘルパー)。
const DEFAULT_RACE_REF: object = { marker: "race-A" };
function key(overrides: Partial<MixedAllocationCacheKey> = {}): MixedAllocationCacheKey {
  return {
    raceId: "202601010101",
    race: DEFAULT_RACE_REF,
    bankroll: 300000,
    perRaceCap: 20000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    includeExactaInAllocation: true,
    ...overrides,
  };
}

describe("computeAllocationWorkerPoolCap(プールの固定上限。Issue #119・#24-C3)", () => {
  it.each([
    { hardwareConcurrency: 1, expected: 1 },
    { hardwareConcurrency: 2, expected: 1 },
    { hardwareConcurrency: 5, expected: 4 },
    { hardwareConcurrency: 8, expected: 4 },
    { hardwareConcurrency: 0, expected: 1 },
    { hardwareConcurrency: -3, expected: 1 },
    { hardwareConcurrency: Number.NaN, expected: 1 },
  ])(
    "hardwareConcurrency=$hardwareConcurrency のとき既定上限4で $expected を返すこと",
    ({ hardwareConcurrency, expected }) => {
      expect(computeAllocationWorkerPoolCap(hardwareConcurrency)).toBe(expected);
    },
  );

  it("maxWorkersを指定すると、既定の4ではなくそちらが上限になること", () => {
    // 前提固定: 既定(4)なら9コアで4になるはずの条件で、maxWorkers=2を渡すと2になること。
    expect(computeAllocationWorkerPoolCap(9)).toBe(4);
    expect(computeAllocationWorkerPoolCap(9, 2)).toBe(2);
  });
});

/** テスト用のWorkerダブル(実Workerを模す)。テストからpostMessage・イベント発火を制御できる。 */
interface FakeWorkerHandle {
  readonly worker: WorkerLike;
  readonly postedMessages: unknown[];
  readonly terminate: ReturnType<typeof vi.fn>;
  triggerMessage(data: unknown): void;
  triggerError(error: unknown): void;
  triggerMessageError(error: unknown): void;
}
function createFakeWorker(): FakeWorkerHandle {
  const postedMessages: unknown[] = [];
  const terminate = vi.fn();
  const worker: WorkerLike = {
    postMessage: (m) => postedMessages.push(m),
    terminate,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
  };
  return {
    worker,
    postedMessages,
    terminate,
    // フェイクなので実際のMessageEvent/ErrorEventは作らず、テストが必要とする最小限の形
    // ({data}・任意のerror値)をキャストして渡す(本番コードのWorkerLikeの型はDOMの実型に
    // 合わせているが、このダブル自体はテスト専用でありDOMイベントを模す必要は無いため)。
    triggerMessage: (data) => worker.onmessage?.({ data } as MessageEvent),
    triggerError: (error) => worker.onerror?.(error as ErrorEvent),
    triggerMessageError: (error) => worker.onmessageerror?.(error as MessageEvent),
  };
}

/** createWorkerが呼ばれるたびに新しいFakeWorkerHandleを積んでいくファクトリ。 */
function createWorkerFactory(): {
  createWorker: () => WorkerLike;
  handles: FakeWorkerHandle[];
} {
  const handles: FakeWorkerHandle[] = [];
  return {
    createWorker: () => {
      const handle = createFakeWorker();
      handles.push(handle);
      return handle.worker;
    },
    handles,
  };
}

type Req = { readonly raceId: string };

describe("createAllocationWorkerPool(配分計算をWorkerプールで進める。Issue #119・#24-C3)", () => {
  it("cap個までWorkerを遅延生成し、pending件数がcapを超えてもそれ以上は作らないこと", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const { createWorker, handles } = createWorkerFactory();
    const pool = createAllocationWorkerPool<Req, string>({
      cache,
      createWorker,
      cap: 2,
      onProgress: vi.fn(),
      onBroken: vi.fn(),
    });
    pool.setInputs({
      order: ["race-1", "race-2", "race-3"],
      keyFor: (raceId) => key({ raceId }),
      buildRequest: (raceId) => ({ raceId }),
    });
    pool.pump();
    // 前提固定: pendingは3件あるが、capが2なのでWorkerは2個しか作られないこと。
    expect(handles.length).toBe(2);
    expect(handles[0]!.postedMessages).toEqual([{ raceId: "race-1" }]);
    expect(handles[1]!.postedMessages).toEqual([{ raceId: "race-2" }]);
  });

  it("完了順が入れ替わっても、結果は正しいraceIdのキャッシュスロットへ入ること", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const { createWorker, handles } = createWorkerFactory();
    const onProgress = vi.fn();
    const pool = createAllocationWorkerPool<Req, string>({
      cache,
      createWorker,
      cap: 2,
      onProgress,
      onBroken: vi.fn(),
    });
    pool.setInputs({
      order: ["race-1", "race-2"],
      keyFor: (raceId) => key({ raceId }),
      buildRequest: (raceId) => ({ raceId }),
    });
    pool.pump();
    expect(handles.length).toBe(2);

    // 後発のrace-2(worker[1])が先に応答する(完了順の入れ替わり)。
    handles[1]!.triggerMessage({ raceId: "race-2", outcome: { status: "ok", value: "v-race-2" } });
    handles[0]!.triggerMessage({ raceId: "race-1", outcome: { status: "ok", value: "v-race-1" } });

    expect(cache.peek(key({ raceId: "race-1" }))).toEqual({ status: "ok", value: "v-race-1" });
    expect(cache.peek(key({ raceId: "race-2" }))).toEqual({ status: "ok", value: "v-race-2" });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("同じraceIdが計算中の間は、二重に発注しないこと(空きWorkerがあっても)", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const { createWorker, handles } = createWorkerFactory();
    const pool = createAllocationWorkerPool<Req, string>({
      cache,
      createWorker,
      cap: 2,
      onProgress: vi.fn(),
      onBroken: vi.fn(),
    });
    pool.setInputs({
      order: ["race-1"],
      keyFor: (raceId) => key({ raceId }),
      buildRequest: (raceId) => ({ raceId }),
    });
    pool.pump();
    pool.pump();
    pool.pump();
    // 前提固定: race-1はまだ未計算(応答が来ていない)ままpumpを3回呼んでいること。
    expect(cache.peek(key({ raceId: "race-1" }))).toBeUndefined();
    // 殺すべき変異: in-flight判定を忘れると、空いている2つ目のWorkerにも同じrace-1が発注される。
    expect(handles.length).toBe(1);
    expect(handles[0]!.postedMessages).toEqual([{ raceId: "race-1" }]);
  });

  it("設定変更で古いキーになった応答は破棄され、キャッシュを上書きしないこと(AC-3再評価)", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const { createWorker, handles } = createWorkerFactory();
    const pool = createAllocationWorkerPool<Req, string>({
      cache,
      createWorker,
      cap: 1,
      onProgress: vi.fn(),
      onBroken: vi.fn(),
    });
    // 設定A(bankroll=100000)でrace-1を発注する。
    pool.setInputs({
      order: ["race-1"],
      keyFor: (raceId) => key({ raceId, bankroll: 100000 }),
      buildRequest: (raceId) => ({ raceId }),
    });
    pool.pump();
    expect(handles.length).toBe(1);

    // 応答が届く前に設定が変わる(bankroll=200000)。
    pool.setInputs({
      order: ["race-1"],
      keyFor: (raceId) => key({ raceId, bankroll: 200000 }),
      buildRequest: (raceId) => ({ raceId }),
    });

    // 古い設定(bankroll=100000)ぶんの応答が今ごろ届く。応答処理の直後、空いたWorkerへ
    // 内部で即座に再発注する(cap=1なので同じWorkerが再利用される。次のコミットを待たない)。
    handles[0]!.triggerMessage({
      raceId: "race-1",
      outcome: { status: "ok", value: "computed-with-bankroll-100000" },
    });

    // 殺すべき変異: 送信時キーの再評価をせず素通しすると、ここがヒットしてしまう。
    expect(cache.peek(key({ raceId: "race-1", bankroll: 100000 }))).toBeUndefined();
    expect(cache.peek(key({ raceId: "race-1", bankroll: 200000 }))).toBeUndefined();

    // cap=1なので新しいWorkerは作られず、同じWorkerが新しい設定のもと再利用されていること。
    expect(handles.length).toBe(1);
    expect(handles[0]!.postedMessages).toEqual([{ raceId: "race-1" }, { raceId: "race-1" }]);
    handles[0]!.triggerMessage({
      raceId: "race-1",
      outcome: { status: "ok", value: "computed-with-bankroll-200000" },
    });
    expect(cache.peek(key({ raceId: "race-1", bankroll: 200000 }))).toEqual({
      status: "ok",
      value: "computed-with-bankroll-200000",
    });
  });

  it("Worker内の計算失敗(status:error)は該当レースだけerrorとしてキャッシュし、プールは壊れず同じWorkerを使い続けること", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const { createWorker, handles } = createWorkerFactory();
    const onBroken = vi.fn();
    const pool = createAllocationWorkerPool<Req, string>({
      cache,
      createWorker,
      cap: 1,
      onProgress: vi.fn(),
      onBroken,
    });
    pool.setInputs({
      order: ["race-1", "race-2"],
      keyFor: (raceId) => key({ raceId }),
      buildRequest: (raceId) => ({ raceId }),
    });
    pool.pump();
    handles[0]!.triggerMessage({ raceId: "race-1", outcome: { status: "error" } });
    expect(cache.peek(key({ raceId: "race-1" }))).toEqual({ status: "error" });
    expect(onBroken).not.toHaveBeenCalled();

    // 同じWorkerが引き続き使われ、race-2が発注されること(terminateされていない)。
    pool.pump();
    expect(handles.length).toBe(1);
    expect(handles[0]!.terminate).not.toHaveBeenCalled();
    expect(handles[0]!.postedMessages).toEqual([{ raceId: "race-1" }, { raceId: "race-2" }]);
  });

  it("Workerのonerrorが発生したら、その時計算中だったレースはerrorとして記録せず未計算のまま残し、プール全体をterminateしてonBrokenを1回だけ呼ぶこと", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const { createWorker, handles } = createWorkerFactory();
    const onBroken = vi.fn();
    const pool = createAllocationWorkerPool<Req, string>({
      cache,
      createWorker,
      cap: 2,
      onProgress: vi.fn(),
      onBroken,
    });
    pool.setInputs({
      order: ["race-1", "race-2"],
      keyFor: (raceId) => key({ raceId }),
      buildRequest: (raceId) => ({ raceId }),
    });
    pool.pump();
    expect(handles.length).toBe(2);

    handles[0]!.triggerError(new Error("worker crashed"));

    // 前提固定: 壊れる直前、race-1は計算中(まだerrorとしても記録されていない)だったこと。
    expect(cache.peek(key({ raceId: "race-1" }))).toBeUndefined();
    // 計算中だったレースをerrorとしてキャッシュしない(逐次側で計算し直すため)。
    expect(cache.peek(key({ raceId: "race-1" }))).not.toEqual({ status: "error" });
    expect(handles[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(handles[1]!.terminate).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenCalledWith(ALLOCATION_WORKER_CRASH_OPERATION, expect.anything());

    // 2つ目のWorkerがさらにonerrorを起こしても、ログ(onBroken)は1回だけ。
    handles[1]!.triggerError(new Error("second crash"));
    expect(onBroken).toHaveBeenCalledTimes(1);

    // 壊れた後にpump()しても新たにWorkerを作らないこと。
    pool.pump();
    expect(handles.length).toBe(2);
  });

  it("Workerのonmessageerrorもonerrorと同様にプール全体の異常として扱うこと", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const { createWorker, handles } = createWorkerFactory();
    const onBroken = vi.fn();
    const pool = createAllocationWorkerPool<Req, string>({
      cache,
      createWorker,
      cap: 1,
      onProgress: vi.fn(),
      onBroken,
    });
    pool.setInputs({
      order: ["race-1"],
      keyFor: (raceId) => key({ raceId }),
      buildRequest: (raceId) => ({ raceId }),
    });
    pool.pump();
    handles[0]!.triggerMessageError(new Error("deserialize failed"));
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenCalledWith(ALLOCATION_WORKER_CRASH_OPERATION, expect.anything());
    expect(handles[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("createWorkerが同期的に例外を投げたら、そのレースは未計算のまま残り、既存Workerも含めてterminateしonBrokenを起動失敗として1回だけ呼ぶこと", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    let calls = 0;
    const created: FakeWorkerHandle[] = [];
    const createWorker = (): WorkerLike => {
      calls += 1;
      if (calls === 2) {
        throw new Error("Worker construction failed");
      }
      const handle = createFakeWorker();
      created.push(handle);
      return handle.worker;
    };
    const onBroken = vi.fn();
    const pool = createAllocationWorkerPool<Req, string>({
      cache,
      createWorker,
      cap: 2,
      onProgress: vi.fn(),
      onBroken,
    });
    pool.setInputs({
      order: ["race-1", "race-2"],
      keyFor: (raceId) => key({ raceId }),
      buildRequest: (raceId) => ({ raceId }),
    });
    pool.pump();

    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenCalledWith(
      ALLOCATION_WORKER_STARTUP_FAILURE_OPERATION,
      expect.anything(),
    );
    // 1つ目(race-1向け)は生成に成功していたので、それもterminateされること。
    expect(created.length).toBe(1);
    expect(created[0]!.terminate).toHaveBeenCalledTimes(1);
    // race-2は発注できなかったので未計算のまま。
    expect(cache.peek(key({ raceId: "race-2" }))).toBeUndefined();

    pool.pump();
    // 壊れた後は新たにWorkerを作らない(callsが増えない)。
    expect(calls).toBe(2);
  });
});

describe("createAllocationRunner(Worker起動失敗時に逐次計算へフォールバックする統合ロジック。Issue #119・#24-C3)", () => {
  it("通常時はWorkerプール経由で計算されること", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const { createWorker, handles } = createWorkerFactory();
    const runner = createAllocationRunner<Req, string>({
      cache,
      createWorker,
      hardwareConcurrency: 5,
      schedule: vi.fn(() => 1),
      cancel: vi.fn(),
      onProgress: vi.fn(),
      onLog: vi.fn(),
    });
    runner.setInputs({
      order: ["race-1"],
      keyFor: (raceId) => key({ raceId }),
      buildRequest: (raceId) => ({ raceId }),
      compute: () => {
        throw new Error("フォールバック前提: 通常時はcomputeを直接呼ばないこと");
      },
    });
    runner.pump();
    expect(handles.length).toBe(1);
    handles[0]!.triggerMessage({ raceId: "race-1", outcome: { status: "ok", value: "pool-value" } });
    expect(cache.peek(key({ raceId: "race-1" }))).toEqual({ status: "ok", value: "pool-value" });
  });

  it("Worker起動に失敗すると、以降は逐次計算(compute直接呼び出し)にフォールバックし、ログを1回だけ記録すること", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const createWorker = (): WorkerLike => {
      throw new Error("この環境ではWorkerを作れない");
    };
    const onLog = vi.fn();
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const schedule = vi.fn((cb: () => void) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, cb);
      return id;
    });
    const cancel = vi.fn();
    const runner = createAllocationRunner<Req, string>({
      cache,
      createWorker,
      hardwareConcurrency: 5,
      schedule,
      cancel,
      onProgress: vi.fn(),
      onLog,
    });
    runner.setInputs({
      order: ["race-1", "race-2"],
      keyFor: (raceId) => key({ raceId }),
      buildRequest: (raceId) => ({ raceId }),
      compute: (raceId) => `sequential-${raceId}`,
    });
    runner.pump();

    // 起動失敗が1回だけログされること。
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith(
      ALLOCATION_WORKER_STARTUP_FAILURE_OPERATION,
      expect.anything(),
    );

    // 逐次フォールバック(createAllocationScheduler)はタイマー経由で1件ずつ進む。
    expect(schedule).toHaveBeenCalledTimes(1);
    timers.get(1)!();
    expect(cache.peek(key({ raceId: "race-1" }))).toEqual({
      status: "ok",
      value: "sequential-race-1",
    });

    // 以降のpump()でも再びWorkerを作ろうとしない(フォールバックしたまま)。
    runner.pump();
    expect(schedule).toHaveBeenCalledTimes(2);
    timers.get(2)!();
    expect(cache.peek(key({ raceId: "race-2" }))).toEqual({
      status: "ok",
      value: "sequential-race-2",
    });
    // ログは最初の1回だけ(以降のpump()で増えない)。
    expect(onLog).toHaveBeenCalledTimes(1);
  });

  it("稼働中にWorkerが壊れた場合も、計算中だったレースを含めて逐次計算へ引き継ぐこと", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const { createWorker, handles } = createWorkerFactory();
    const onLog = vi.fn();
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const schedule = vi.fn((cb: () => void) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, cb);
      return id;
    });
    const runner = createAllocationRunner<Req, string>({
      cache,
      createWorker,
      hardwareConcurrency: 2,
      schedule,
      cancel: vi.fn(),
      onProgress: vi.fn(),
      onLog,
    });
    runner.setInputs({
      order: ["race-1"],
      keyFor: (raceId) => key({ raceId }),
      buildRequest: (raceId) => ({ raceId }),
      compute: (raceId) => `sequential-${raceId}`,
    });
    runner.pump();
    expect(handles.length).toBe(1);

    handles[0]!.triggerError(new Error("boom"));
    expect(onLog).toHaveBeenCalledWith(ALLOCATION_WORKER_CRASH_OPERATION, expect.anything());

    // race-1はerrorとして記録されておらず、逐次フォールバックが最終的に計算すること。
    runner.pump();
    expect(schedule).toHaveBeenCalledTimes(1);
    timers.get(1)!();
    expect(cache.peek(key({ raceId: "race-1" }))).toEqual({
      status: "ok",
      value: "sequential-race-1",
    });
  });
});
