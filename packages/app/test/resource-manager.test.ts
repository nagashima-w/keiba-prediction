import { describe, expect, it } from "vitest";

import { ResourceManager } from "../src/main/resource-manager.js";

/** テスト用の依存: 生成ごとに連番IDを振り、close で open=false にして閉じたIDを記録する。 */
function makeManager(): {
  manager: ResourceManager<{ id: number; open: boolean }>;
  closed: number[];
  createdCount: () => number;
} {
  let created = 0;
  const closed: number[] = [];
  const manager = new ResourceManager<{ id: number; open: boolean }>({
    create: () => ({ id: ++created, open: true }),
    close: (r) => {
      r.open = false;
      closed.push(r.id);
    },
  });
  return { manager, closed, createdCount: () => created };
}

describe("ResourceManager(依存のライフサイクル管理)", () => {
  it("acquire は初回に生成し、以降は同一インスタンスを再利用する", () => {
    const { manager, createdCount } = makeManager();
    const a = manager.acquire();
    const b = manager.acquire();
    expect(a).toBe(b);
    expect(createdCount()).toBe(1);
  });

  it("アイドル時の markDirty は即座に閉じ、次回 acquire で再構築する", () => {
    const { manager, closed } = makeManager();
    const first = manager.acquire();
    manager.markDirty();
    expect(closed).toEqual([first.id]);
    const second = manager.acquire();
    expect(second.id).toBe(first.id + 1);
    expect(second.open).toBe(true);
  });

  it("実行中に markDirty しても、実行中の依存は閉じられない(分析が途中で落ちない)", async () => {
    const { manager, closed } = makeManager();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let openAtEnd: boolean | null = null;

    const run = manager.runExclusive(async (r) => {
      await gate; // 実行中を模擬(この間に設定保存が来る)。
      openAtEnd = r.open; // 実行完了時点で依存はまだ開いているべき。
      return r.id;
    });

    // 実行中に設定保存(markDirty)が発生。
    manager.markDirty();
    // 実行中は close してはならない。
    expect(closed).toEqual([]);

    release();
    const usedId = await run;
    expect(usedId).toBe(1);
    expect(openAtEnd).toBe(true);

    // 完了後、次回 acquire で古いものを閉じて再構築する(次回分析に新設定が反映)。
    const next = manager.acquire();
    expect(closed).toEqual([1]);
    expect(next.id).toBe(2);
  });

  it("runExclusive は完了後に実行中フラグを下げ、次の markDirty が即時反映される", async () => {
    const { manager, closed } = makeManager();
    await manager.runExclusive(async () => "done");
    // 実行が終わっていれば markDirty は即座に閉じる。
    manager.markDirty();
    expect(closed).toEqual([1]);
  });

  it("runExclusive が例外でも実行中フラグを確実に下げる", async () => {
    const { manager, closed } = makeManager();
    await expect(
      manager.runExclusive(async () => {
        throw new Error("失敗");
      }),
    ).rejects.toThrow("失敗");
    manager.markDirty();
    expect(closed).toEqual([1]);
  });

  it("close は現在の依存を閉じ、未生成なら何もしない(冪等)", () => {
    const { manager, closed } = makeManager();
    manager.close(); // 未生成: 何もしない。
    expect(closed).toEqual([]);
    const r = manager.acquire();
    manager.close();
    expect(closed).toEqual([r.id]);
    manager.close(); // 二重呼び出しでも安全。
    expect(closed).toEqual([r.id]);
  });
});
