import { describe, expect, it, vi } from "vitest";

import {
  createMixedAllocationCache,
  type MixedAllocationCacheKey,
} from "../src/renderer/mixed-allocation-cache.js";
import {
  createAllocationQueueRunner,
  createAllocationScheduler,
  type AllocationOutcome,
  type AllocationSchedulable,
} from "../src/renderer/mixed-allocation-queue.js";

// mixed-allocation-cache.test.tsのkey()と同じ流儀(既定は互いに異なる値を持つ1つの安定した
// レース参照。key()を呼ぶたびに新しいリテラルを作ると「同じレースのつもり」でも参照が
// 毎回変わり、ヒットするはずのテストが誤ってミスと判定される)。
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
    ...overrides,
  };
}

describe("createAllocationQueueRunner(配分計算を1レースずつ進める実行役。Issue #110・#24-C2)", () => {
  it("setInputs前はpendingRaceIdsが空で、peekも常にundefinedであること", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const runner = createAllocationQueueRunner(cache);
    expect(runner.pendingRaceIds()).toEqual([]);
    expect(runner.peek("race-1")).toBeUndefined();
  });

  it("AC-2: stepは表示順の先頭にある未計算レースを1件だけ計算すること(残りは未計算のまま)", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const runner = createAllocationQueueRunner(cache);
    const compute = vi.fn((raceId: string) => `value-${raceId}`);
    runner.setInputs({
      order: ["race-1", "race-2", "race-3"],
      keyFor: (raceId) => key({ raceId }),
      compute,
    });
    // 前提固定: 3レースとも最初は未計算(pending)であること。
    expect(runner.pendingRaceIds()).toEqual(["race-1", "race-2", "race-3"]);

    runner.step();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(runner.peek("race-1")).toEqual({ status: "ok", value: "value-race-1" });
    // race-2・race-3はまだ未計算のまま(1ステップ=1レースの確認)。
    expect(runner.peek("race-2")).toBeUndefined();
    expect(runner.peek("race-3")).toBeUndefined();
    expect(runner.pendingRaceIds()).toEqual(["race-2", "race-3"]);

    runner.step();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(runner.peek("race-2")).toEqual({ status: "ok", value: "value-race-2" });
    expect(runner.pendingRaceIds()).toEqual(["race-3"]);
  });

  it("AC-4: 既にキャッシュ済み(get済み)のレースはpendingRaceIdsに現れず、stepでも再計算されないこと", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const preComputedKey = key({ raceId: "race-1" });
    cache.get(preComputedKey, () => ({ status: "ok", value: "already-cached" }));

    const runner = createAllocationQueueRunner(cache);
    const compute = vi.fn((raceId: string) => `computed-${raceId}`);
    runner.setInputs({
      order: ["race-1", "race-2"],
      keyFor: (raceId) => key({ raceId }),
      compute,
    });
    // 前提固定: race-1は既にキャッシュ済みなのでpendingに含まれないこと。
    expect(runner.pendingRaceIds()).toEqual(["race-2"]);
    expect(runner.peek("race-1")).toEqual({ status: "ok", value: "already-cached" });

    runner.step();
    // race-2だけが計算され、race-1のcomputeは一切呼ばれないこと。
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledWith("race-2", expect.anything());
    expect(runner.peek("race-1")).toEqual({ status: "ok", value: "already-cached" });
  });

  it("全レース計算済みの状態でstepを呼んでも何も起きないこと(computeは呼ばれない)", () => {
    const cache = createMixedAllocationCache<AllocationOutcome<string>>();
    const runner = createAllocationQueueRunner(cache);
    const compute = vi.fn((raceId: string) => `value-${raceId}`);
    runner.setInputs({ order: ["race-1"], keyFor: (raceId) => key({ raceId }), compute });
    runner.step();
    expect(compute).toHaveBeenCalledTimes(1);
    runner.step();
    runner.step();
    // 前提固定: 既に計算済みなのでpendingは空であること。
    expect(runner.pendingRaceIds()).toEqual([]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  describe("AC-7'(あるレースの計算が例外を投げても止まらず、かつ同じキーでは再試行しない)", () => {
    it("computeが例外を投げても、同じキーのままstepを繰り返してもcomputeは1回しか呼ばれないこと(無限ループ防止)", () => {
      const cache = createMixedAllocationCache<AllocationOutcome<string>>();
      const runner = createAllocationQueueRunner(cache);
      const compute = vi.fn(() => {
        throw new Error("boom");
      });
      runner.setInputs({ order: ["race-1"], keyFor: (raceId) => key({ raceId }), compute });

      runner.step();
      runner.step();
      runner.step();

      // 前提固定: 失敗結果がpeekできること(「計算中」のまま止まっているのではない)。
      expect(runner.peek("race-1")).toEqual({ status: "error" });
      // 殺すべき変異: 失敗をキャッシュに記録しない → ここが3になって赤になる。
      expect(compute).toHaveBeenCalledTimes(1);
      expect(runner.pendingRaceIds()).toEqual([]);
    });

    it("あるレースの計算が失敗しても、残りのレースの計算は続くこと", () => {
      const cache = createMixedAllocationCache<AllocationOutcome<string>>();
      const runner = createAllocationQueueRunner(cache);
      const compute = vi.fn((raceId: string) => {
        if (raceId === "race-1") {
          throw new Error("boom");
        }
        return `ok-${raceId}`;
      });
      runner.setInputs({
        order: ["race-1", "race-2"],
        keyFor: (raceId) => key({ raceId }),
        compute,
      });

      runner.step(); // race-1が失敗
      runner.step(); // race-2は失敗に巻き込まれず計算されること

      expect(runner.peek("race-1")).toEqual({ status: "error" });
      expect(runner.peek("race-2")).toEqual({ status: "ok", value: "ok-race-2" });
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it("失敗した後にキー(設定)が変わると、再度computeが呼ばれる(キーが変われば再試行される)こと", () => {
      const cache = createMixedAllocationCache<AllocationOutcome<string>>();
      const runner = createAllocationQueueRunner(cache);
      const compute = vi.fn(() => {
        throw new Error("boom");
      });
      runner.setInputs({
        order: ["race-1"],
        keyFor: (raceId) => key({ raceId, bankroll: 100000 }),
        compute,
      });
      runner.step();
      expect(compute).toHaveBeenCalledTimes(1);

      // 設定変更(bankroll変更)。
      runner.setInputs({
        order: ["race-1"],
        keyFor: (raceId) => key({ raceId, bankroll: 200000 }),
        compute,
      });
      // 前提固定: キーが変わったので再びpendingに現れること。
      expect(runner.pendingRaceIds()).toEqual(["race-1"]);
      runner.step();
      expect(compute).toHaveBeenCalledTimes(2);
    });
  });

  describe("AC-3'(古い金額を出さない。Issue #110)", () => {
    it("AC-3'(a): 計算済みのレースの設定を変えると、そのレースはpeekでヒットしなくなる(古い金額を表示しない)", () => {
      const cache = createMixedAllocationCache<AllocationOutcome<string>>();
      const runner = createAllocationQueueRunner(cache);
      runner.setInputs({
        order: ["race-1"],
        keyFor: (raceId) => key({ raceId, bankroll: 100000 }),
        compute: (raceId) => `v1-${raceId}`,
      });
      runner.step();
      // 前提固定: 設定変更前は計算済みの値がpeekできること。
      expect(runner.peek("race-1")).toEqual({ status: "ok", value: "v1-race-1" });

      // 設定変更(bankroll変更)。
      runner.setInputs({
        order: ["race-1"],
        keyFor: (raceId) => key({ raceId, bankroll: 200000 }),
        compute: (raceId) => `v2-${raceId}`,
      });
      // 殺すべき変異: peekがキーを見ずにraceIdだけで引く → ここが古い値のままになり赤になる。
      expect(runner.peek("race-1")).toBeUndefined();
    });

    it("AC-3'(b): 1レース目を計算した後に設定が変わると、2レース目は変更後の設定で直接computeを呼んだ結果と一致すること", () => {
      const cache = createMixedAllocationCache<AllocationOutcome<string>>();
      const runner = createAllocationQueueRunner(cache);

      // 設定A(bankroll=100000)でrace-1を計算する。
      runner.setInputs({
        order: ["race-1"],
        keyFor: (raceId) => key({ raceId, bankroll: 100000 }),
        compute: (raceId) => `computed(bankroll=100000,${raceId})`,
      });
      runner.step();
      expect(runner.peek("race-1")).toEqual({
        status: "ok",
        value: "computed(bankroll=100000,race-1)",
      });

      // 設定B(bankroll=200000)に変わり、race-2が新たに対象になる。
      // 殺すべき変異: setInputsを最初の呼び出しだけ採用し以降を無視する(=「スケジュール開始時に
      // 捕まえた古いキー・古いorderを使い回す」)。この変異が入ると、orderが["race-1"]のまま
      // 更新されず、race-2が一切pendingに現れないためstepが何もせず、下のpeekはundefinedのまま
      // 赤になる。
      runner.setInputs({
        order: ["race-2"],
        keyFor: (raceId) => key({ raceId, bankroll: 200000 }),
        compute: (raceId) => `computed(bankroll=200000,${raceId})`,
      });
      runner.step();

      // 「今の設定(B)で直接computeを呼んだ結果」と一致することを無条件expectで固定する。
      const directResult = `computed(bankroll=200000,race-2)`;
      expect(runner.peek("race-2")).toEqual({ status: "ok", value: directResult });
    });
  });
});

// ============================================================================
// Issue #110差し戻し(メタレビュー): 「計算ループが止まったまま再開しない」経路
//
// 旧実装(BatchAnalysisView.tsx側の`useEffect(..., [hasPendingAllocation])`)は、
// 「未計算0件→1件以上」という**真偽値の遷移**でしか再起動しなかった。しかしReactの
// バッチ処理により、ループが最後の1件を計算して止まった直後に別の更新(設定変更等)が
// 同じコミットへまとめられると、`hasPendingAllocation`は`true→(falseを経由せず)→true`と
// なり、依存配列の変化が起きないため**effectが再実行されず、ループが再開しない**
// (詳細はIssue #110のメタレビュー差し戻しコメント参照)。
//
// 対策として、判断ロジックを`sync()`(冪等: タイマーが張られているか・未計算があるかの
// 「今の状態」だけを見る。過去の真偽値を記憶しない)という純粋なオブジェクトへ切り出す。
// ============================================================================

/** テスト用のダミーrunner(pendingRaceIdsを外から差し替えられる)。 */
function createFakeRunner(initialPending: readonly string[]): AllocationSchedulable & {
  readonly step: ReturnType<typeof vi.fn>;
  setPending(ids: readonly string[]): void;
} {
  let current = [...initialPending];
  const step = vi.fn(() => {
    // 実際のAllocationQueueRunner.step()と同じく、先頭の1件を消費する形を模す。
    current = current.slice(1);
  });
  return {
    pendingRaceIds: () => current,
    step,
    setPending(ids) {
      current = [...ids];
    },
  };
}

/**
 * テスト用の偽スケジューラ(setTimeout相当)。`schedule`が返すidに対応するコールバックを
 * `fire(id)`で手動発火できる(「テストでは手でステップを進める」という本タスクの
 * テスト方針に倣う)。`cancel`は呼び出し記録のみで実際にはコールバックを消さない
 * (dispose後に「万一発火してしまった」場合の二重防御をテストするため)。
 */
function createFakeTimerSource() {
  let nextId = 1;
  const callbacksById = new Map<number, () => void>();
  const schedule = vi.fn((callback: () => void) => {
    const id = nextId;
    nextId += 1;
    callbacksById.set(id, callback);
    return id;
  });
  const cancel = vi.fn((_id: number) => {
    // 記録のみ(意図的にcallbacksByIdからは消さない。上記コメント参照)。
  });
  return {
    schedule,
    cancel,
    fire(id: number) {
      const callback = callbacksById.get(id);
      if (callback === undefined) {
        throw new Error(`id ${id} はscheduleされていません`);
      }
      callback();
    },
  };
}

describe("createAllocationScheduler(計算ループの再開判断を切り出した純粋なオブジェクト。AC-9)", () => {
  it("sync(): 未計算があり、タイマーが張られていなければ1つ張ること", () => {
    const runner = createFakeRunner(["race-1"]);
    const timers = createFakeTimerSource();
    const scheduler = createAllocationScheduler({
      runner,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onStepped: vi.fn(),
    });
    scheduler.sync();
    expect(timers.schedule).toHaveBeenCalledTimes(1);
  });

  it("未計算が無ければ何も張らないこと", () => {
    const runner = createFakeRunner([]);
    const timers = createFakeTimerSource();
    const scheduler = createAllocationScheduler({
      runner,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onStepped: vi.fn(),
    });
    scheduler.sync();
    expect(timers.schedule).not.toHaveBeenCalled();
  });

  it("AC-9(飢餓防止): タイマーが既に張られている状態でsync()を何回呼んでも、張られるタイマーは1つだけであること", () => {
    const runner = createFakeRunner(["race-1", "race-2"]);
    const timers = createFakeTimerSource();
    const scheduler = createAllocationScheduler({
      runner,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onStepped: vi.fn(),
    });
    scheduler.sync();
    scheduler.sync();
    scheduler.sync();
    // 前提固定: この時点でまだ発火していないので未計算は変わらず残っていること
    // (「たまたま1回で終わって0件になった」ことによる空振りではないことの確認)。
    expect(runner.pendingRaceIds()).toEqual(["race-1", "race-2"]);
    expect(timers.schedule).toHaveBeenCalledTimes(1);
  });

  it("タイマー発火でrunner.step()とonStepped()が呼ばれ、タイマーが「無い」状態に戻ること", () => {
    const runner = createFakeRunner(["race-1"]);
    const timers = createFakeTimerSource();
    const onStepped = vi.fn();
    const scheduler = createAllocationScheduler({
      runner,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onStepped,
    });
    scheduler.sync();
    timers.fire(1);
    expect(runner.step).toHaveBeenCalledTimes(1);
    expect(onStepped).toHaveBeenCalledTimes(1);
    // 前提固定: 発火によりrace-1が消費され、未計算が0件になっていること。
    expect(runner.pendingRaceIds()).toEqual([]);
    // 未計算が無いので、続けてsync()しても新たなタイマーは張らない。
    scheduler.sync();
    expect(timers.schedule).toHaveBeenCalledTimes(1);
  });

  it("AC-9(最重要・コードレビュー指摘の再現): 最後の1件を計算してタイマーが無くなった直後に、sync()を挟まずに入力が変わって未計算が生じても、次のsync()でタイマーが張られ計算が再開すること", () => {
    const runner = createFakeRunner(["race-1"]);
    const timers = createFakeTimerSource();
    const onStepped = vi.fn();
    const scheduler = createAllocationScheduler({
      runner,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onStepped,
    });
    scheduler.sync();
    timers.fire(1); // race-1を計算。タイマーは「無い」状態に戻る。
    expect(runner.step).toHaveBeenCalledTimes(1);
    expect(runner.pendingRaceIds()).toEqual([]);

    // ★ここが本質: 「未計算0件」の状態でsync()を一度も呼ばずに、いきなり設定変更相当で
    // 新たな未計算が生じる(Reactのバッチ処理により中間の「0件」コミットが観測されない
    // シナリオを模す。メタレビュー差し戻しコメントの手順4〜8参照)。
    runner.setPending(["race-2"]);

    scheduler.sync();
    // 殺すべき変異: sync()を「前回呼んだ時からpendingが0件→1件以上に変わったときだけ張る」
    // (=真偽値の遷移だけを見る)実装にすると、内部の「前回はpendingありだった」という
    // 記憶のせいでここが再スケジュールされず、この expect が赤になる。
    expect(timers.schedule).toHaveBeenCalledTimes(2);

    timers.fire(2);
    expect(runner.step).toHaveBeenCalledTimes(2);
    expect(onStepped).toHaveBeenCalledTimes(2);
  });

  it("dispose(): 張られていたタイマーをcancelし、以降sync()しても新たに張らないこと", () => {
    const runner = createFakeRunner(["race-1"]);
    const timers = createFakeTimerSource();
    const scheduler = createAllocationScheduler({
      runner,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onStepped: vi.fn(),
    });
    scheduler.sync();
    scheduler.dispose();
    expect(timers.cancel).toHaveBeenCalledTimes(1);

    // 前提固定: disposeの時点ではまだrace-1が未消費(=本来ならsyncで再度張られてしまう
    // はずの状況)であること。
    expect(runner.pendingRaceIds()).toEqual(["race-1"]);
    scheduler.sync();
    expect(timers.schedule).toHaveBeenCalledTimes(1);
  });

  it("dispose()後にタイマーが発火しても計算しないこと(cancelが間に合わなかった場合の二重防御)", () => {
    const runner = createFakeRunner(["race-1"]);
    const timers = createFakeTimerSource();
    const onStepped = vi.fn();
    const scheduler = createAllocationScheduler({
      runner,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onStepped,
    });
    scheduler.sync();
    scheduler.dispose();
    // cancelが実際にはタイマーを止められなかった状況を模し、直接コールバックを発火させる
    // (createFakeTimerSourceのcancelは記録のみでコールバックを消さない設計)。
    timers.fire(1);
    expect(runner.step).not.toHaveBeenCalled();
    expect(onStepped).not.toHaveBeenCalled();
  });
});
