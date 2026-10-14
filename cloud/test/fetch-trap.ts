import { afterEach, beforeEach, expect, vi } from "vitest";

/**
 * Issue #294: 馬場の API のテスト共通の安全網。**実際の API には一切アクセスしない**ため、グローバルの `fetch` を「呼ばれたら落ちる」スタブにする。
 * 取得の段階は例外を握る(DO のアラームを再実行させないため)ので、落ちるだけでは握られて見逃される。
 * そこで各テストの後に「呼ばれた回数が 0」であることも確かめる(握られても検出する)。
 * 偽の取得口・偽の fetch が注入されていれば、グローバルの `fetch` は呼ばれない。
 */
export function installFetchTrap(): void {
  let trap: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    trap = vi.fn(() => {
      throw new Error("グローバルの fetch は呼ばれてはならない(実 API に出る)");
    });
    vi.stubGlobal("fetch", trap);
  });
  afterEach(() => {
    const calls = trap.mock.calls.length;
    vi.unstubAllGlobals();
    expect(calls, "グローバルの fetch が呼ばれた(実 API に出る経路がある)").toBe(0);
  });
}
