/**
 * CopyErrorButton のコピー状態遷移ロジック(純ロジック、Task#36 code-reviewer指摘の要修正2)のテスト。
 *
 * このリポジトリは @testing-library 未導入(レンダリングテストの慣行なし)のため、
 * clipboard.writeText と setTimeout/clearTimeout を注入できる形に切り出した
 * createCopyErrorController の状態遷移だけを検証する(コンポーネント自体はレンダリングしない)。
 *
 * fake timers 下では vi.waitFor の内部ポーリングも偽タイマーに乗ってしまい待機が進まないため、
 * Promise の解決待ちには vi.advanceTimersByTimeAsync(0)(マイクロタスクをフラッシュしつつ
 * タイマーを0ms進める)を使う。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COPIED_LABEL_DURATION_MS,
  createCopyErrorController,
} from "../src/renderer/copy-error-controller.js";

describe("createCopyErrorController(コピー状態遷移の純ロジック)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("コピー成功時はコピー状態をtrueにし、一定時間後にfalseへ戻すこと", async () => {
    const onCopiedChange = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const controller = createCopyErrorController({
      writeText,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      onCopiedChange,
    });

    controller.copy("コピー対象テキスト");
    expect(writeText).toHaveBeenCalledWith("コピー対象テキスト");

    // writeText の Promise 解決(マイクロタスク)をフラッシュする。
    await vi.advanceTimersByTimeAsync(0);
    expect(onCopiedChange).toHaveBeenCalledWith(true);

    await vi.advanceTimersByTimeAsync(COPIED_LABEL_DURATION_MS);
    expect(onCopiedChange).toHaveBeenLastCalledWith(false);
  });

  it("コピー失敗時はコピー状態を変更しないこと(握りつぶす)", async () => {
    const onCopiedChange = vi.fn();
    const writeText = vi.fn().mockRejectedValue(new Error("権限拒否"));
    const controller = createCopyErrorController({
      writeText,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      onCopiedChange,
    });

    controller.copy("コピー対象テキスト");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(COPIED_LABEL_DURATION_MS);
    expect(onCopiedChange).not.toHaveBeenCalled();
  });

  it("dispose後はタイマーが発火してもコピー状態を変更しないこと(アンマウント後のsetState防止)", async () => {
    const onCopiedChange = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const controller = createCopyErrorController({
      writeText,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      onCopiedChange,
    });

    controller.copy("コピー対象テキスト");
    await vi.advanceTimersByTimeAsync(0);
    expect(onCopiedChange).toHaveBeenCalledWith(true);
    onCopiedChange.mockClear();

    controller.dispose();
    await vi.advanceTimersByTimeAsync(COPIED_LABEL_DURATION_MS);
    expect(onCopiedChange).not.toHaveBeenCalled();
  });

  it("copy呼び出し直後にdisposeした場合、Promise解決後もコピー状態を変更しないこと", async () => {
    const onCopiedChange = vi.fn();
    const deferred: { resolve: () => void } = { resolve: () => {} };
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const controller = createCopyErrorController({
      writeText,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      onCopiedChange,
    });

    controller.copy("コピー対象テキスト");
    controller.dispose();
    deferred.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(onCopiedChange).not.toHaveBeenCalled();
  });

  it("dispose後に作り直した新インスタンスは正常に動作すること(React 18 StrictModeのsetup→cleanup→setup相当)", async () => {
    // StrictMode(開発モード)ではuseEffectがsetup→cleanup→setupと2重実行される。
    // CopyErrorButton側はこれに対応するため、setupのたびにcreateCopyErrorControllerで
    // 新しいインスタンスを作り直す設計とした(1つ目のインスタンスをdisposeしても、
    // 2つ目のインスタンスが道連れにならず正常に動くことをここで固定する)。
    const onCopiedChange = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const deps = {
      writeText,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      onCopiedChange,
    };

    // 1つ目のインスタンス(1回目のsetup)を作ってすぐdispose(1回目のcleanup、StrictModeの疑似実行)。
    const firstController = createCopyErrorController(deps);
    firstController.dispose();

    // 2つ目のインスタンス(2回目のsetup、実際に使われ続けるインスタンス)。
    const secondController = createCopyErrorController(deps);
    secondController.copy("コピー対象テキスト");

    await vi.advanceTimersByTimeAsync(0);
    expect(onCopiedChange).toHaveBeenCalledWith(true);

    await vi.advanceTimersByTimeAsync(COPIED_LABEL_DURATION_MS);
    expect(onCopiedChange).toHaveBeenLastCalledWith(false);
  });

  it("copyを連続で呼んでも保留中タイマーは1つだけになること(多重タイマーの防止)", async () => {
    const onCopiedChange = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clearTimeoutSpy = vi.fn(globalThis.clearTimeout);
    const controller = createCopyErrorController({
      writeText,
      setTimeout: globalThis.setTimeout,
      clearTimeout: clearTimeoutSpy,
      onCopiedChange,
    });

    controller.copy("1回目");
    await vi.advanceTimersByTimeAsync(0);
    controller.copy("2回目");
    await vi.advanceTimersByTimeAsync(0);

    // 2回目の copy で1回目の保留タイマーがクリアされていること。
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});
