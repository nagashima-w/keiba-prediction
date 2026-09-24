import { describe, expect, it, vi } from "vitest";

import {
  createMixedAllocationCache,
  type MixedAllocationCacheKey,
} from "../src/renderer/mixed-allocation-cache.js";
import {
  createAllocationQueueRunner,
  type AllocationOutcome,
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
