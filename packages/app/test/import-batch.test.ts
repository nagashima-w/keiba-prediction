/**
 * 一括結果取込オーケストレータ(runBulkImport)のテスト。Task#31。
 *
 * 実IO(importRaceResult 本体)は importOne として注入し、直列実行・レース間の1.5秒レート制限・
 * 未確定(not_confirmed)の自動スキップ・部分失敗の継続・中断境界での残りスキップ・全体進捗の
 * 通知を、スタブとモック sleep だけで固定する(electron・実タイマー非依存)。
 */

import { describe, expect, it, vi } from "vitest";

import {
  BULK_IMPORT_RATE_LIMIT_MS,
  runBulkImport,
} from "../src/main/import-batch.js";
import type {
  BulkImportProgress,
  ImportResultOutcome,
} from "../src/shared/analysis-types.js";

/** status="imported" の最小のImportResultOutcomeを作る。 */
function imported(raceId: string): ImportResultOutcome {
  return {
    status: "imported",
    raceId,
    horseCount: 10,
    placePayoutCount: 3,
    hasPayout: true,
  };
}

describe("runBulkImport(一括結果取込オーケストレータ)", () => {
  it("選択レースを入力順どおり直列に取込み、成功アウトカムを返す", async () => {
    const order: string[] = [];
    let active = 0;
    const importOne = vi.fn(async (raceId: string) => {
      // 直列であることの検証: 同時にアクティブなのは常に1件のみ。
      active += 1;
      expect(active).toBe(1);
      order.push(raceId);
      await Promise.resolve();
      active -= 1;
      return imported(raceId);
    });

    const outcomes = await runBulkImport(["A", "B", "C"], {
      importOne,
      shouldCancel: () => false,
      sleep: vi.fn(async () => {}),
    });

    expect(order).toEqual(["A", "B", "C"]);
    expect(outcomes).toEqual([
      { raceId: "A", status: "imported", error: null },
      { raceId: "B", status: "imported", error: null },
      { raceId: "C", status: "imported", error: null },
    ]);
  });

  it("レース間に最低1.5秒のレート制限を課すこと(1件目の前は待たない)", async () => {
    const sleep = vi.fn(async () => {});
    const importOne = vi.fn(async (raceId: string) => imported(raceId));

    await runBulkImport(["A", "B", "C"], {
      importOne,
      shouldCancel: () => false,
      sleep,
    });

    // レース数3件なら間隔は2回だけ(A→B, B→C)。1件目の前には待たない。
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, BULK_IMPORT_RATE_LIMIT_MS);
    expect(sleep).toHaveBeenNthCalledWith(2, BULK_IMPORT_RATE_LIMIT_MS);
  });

  it("未確定(status='not_confirmed')は例外にせず自動スキップとして記録すること", async () => {
    const importOne = vi.fn(async (raceId: string) => {
      if (raceId === "B") {
        return { status: "not_confirmed" as const, raceId };
      }
      return imported(raceId);
    });

    const outcomes = await runBulkImport(["A", "B", "C"], {
      importOne,
      shouldCancel: () => false,
      sleep: vi.fn(async () => {}),
    });

    expect(outcomes.map((o) => o.status)).toEqual([
      "imported",
      "not_confirmed",
      "imported",
    ]);
    expect(outcomes[1]!.error).toBeNull();
  });

  it("1レースの失敗(例外)で全体を止めず、失敗を記録して次へ進む(部分失敗)", async () => {
    const importOne = vi.fn(async (raceId: string) => {
      if (raceId === "B") {
        throw new Error("Bの取込に失敗");
      }
      return imported(raceId);
    });

    const outcomes = await runBulkImport(["A", "B", "C"], {
      importOne,
      shouldCancel: () => false,
      sleep: vi.fn(async () => {}),
    });

    expect(importOne).toHaveBeenCalledTimes(3);
    expect(outcomes.map((o) => o.status)).toEqual([
      "imported",
      "failure",
      "imported",
    ]);
    expect(outcomes[1]!.error).toBe("Bの取込に失敗");
  });

  it("中断要求後は次のレース境界で停止し、残りをスキップする(実行中レースは完走)", async () => {
    let canceled = false;
    const importOne = vi.fn(async (raceId: string) => {
      if (raceId === "A") {
        canceled = true;
      }
      return imported(raceId);
    });

    const outcomes = await runBulkImport(["A", "B", "C"], {
      importOne,
      shouldCancel: () => canceled,
      sleep: vi.fn(async () => {}),
    });

    expect(importOne).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.status)).toEqual([
      "imported",
      "skipped",
      "skipped",
    ]);
    expect(outcomes[1]).toEqual({ raceId: "B", status: "skipped", error: null });
    expect(outcomes[2]).toEqual({ raceId: "C", status: "skipped", error: null });
  });

  it("最初から中断済みなら全レースをスキップし、一度も取込まない", async () => {
    const importOne = vi.fn(async (raceId: string) => imported(raceId));
    const outcomes = await runBulkImport(["A", "B"], {
      importOne,
      shouldCancel: () => true,
      sleep: vi.fn(async () => {}),
    });
    expect(importOne).not.toHaveBeenCalled();
    expect(outcomes.map((o) => o.status)).toEqual(["skipped", "skipped"]);
  });

  it("1レースの失敗時にonErrorへraceIdと例外を渡す(ログ用フック、Task#35)", async () => {
    const original = new Error("Bの取込に失敗");
    const importOne = vi.fn(async (raceId: string) => {
      if (raceId === "B") {
        throw original;
      }
      return imported(raceId);
    });
    const onError = vi.fn();

    await runBulkImport(["A", "B", "C"], {
      importOne,
      shouldCancel: () => false,
      sleep: vi.fn(async () => {}),
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("B", original);
  });

  it("onError自体が例外を投げても後続レースの処理とoutcomes記録は壊れない(防御的try/catch)", async () => {
    const importOne = vi.fn(async (raceId: string) => {
      if (raceId === "B") {
        throw new Error("Bの取込に失敗");
      }
      return imported(raceId);
    });
    // onError自体がログ記録の失敗等で例外を投げるケースを模擬する。
    const onError = vi.fn(() => {
      throw new Error("ログ記録自体が失敗");
    });

    const outcomes = await runBulkImport(["A", "B", "C"], {
      importOne,
      shouldCancel: () => false,
      sleep: vi.fn(async () => {}),
      onError,
    });

    // onErrorが投げた例外はrunBulkImport全体を止めず、Cまで処理が継続する。
    expect(importOne).toHaveBeenCalledTimes(3);
    expect(outcomes.map((o) => o.status)).toEqual([
      "imported",
      "failure",
      "imported",
    ]);
    expect(outcomes[1]!.error).toBe("Bの取込に失敗");
  });

  it("onErrorが与えられなくても失敗時の挙動は変わらない(省略可)", async () => {
    const importOne = vi.fn(async (raceId: string) => {
      if (raceId === "B") {
        throw new Error("Bの取込に失敗");
      }
      return imported(raceId);
    });

    const outcomes = await runBulkImport(["A", "B"], {
      importOne,
      shouldCancel: () => false,
      sleep: vi.fn(async () => {}),
    });

    expect(outcomes.map((o) => o.status)).toEqual(["imported", "failure"]);
  });

  it("対象レースが0件なら importOne を呼ばず空配列を返す", async () => {
    const importOne = vi.fn(async (raceId: string) => imported(raceId));
    const outcomes = await runBulkImport([], {
      importOne,
      shouldCancel: () => false,
      sleep: vi.fn(async () => {}),
    });
    expect(importOne).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it("全体進捗を通知する(完了レース数・総数・現在レースIDの転送)", async () => {
    const progresses: BulkImportProgress[] = [];
    const importOne = vi.fn(async (raceId: string) => imported(raceId));

    await runBulkImport(["A", "B"], {
      importOne,
      shouldCancel: () => false,
      sleep: vi.fn(async () => {}),
      onProgress: (p) => progresses.push(p),
    });

    // 開始時点(0/2・現在レースA)の進捗がある。
    const firstEvent = progresses.find((p) => p.currentRaceId === "A");
    expect(firstEvent).toBeDefined();
    expect(firstEvent!.completedRaces).toBe(0);
    expect(firstEvent!.totalRaces).toBe(2);

    // 最終進捗は完了2/2・現在レースなし。
    const last = progresses[progresses.length - 1]!;
    expect(last.completedRaces).toBe(2);
    expect(last.totalRaces).toBe(2);
    expect(last.currentRaceId).toBeNull();
  });
});
