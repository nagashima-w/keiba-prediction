import { describe, expect, it } from "vitest";
import { createListClock, LIST_CLOCK_MS } from "../client/list-clock";
import { createFakeTimers } from "./client-fakes";

/** Issue #346: 一覧の「時間の経過で並べ替える」ための再描画のタイマー(取得はしない)。`sync(要るか)` は冪等で、`render()` の末尾から毎回呼ばれる。 */

function setup(visible = true) {
  const timers = createFakeTimers();
  let ticks = 0;
  const state = { visible };
  const clock = createListClock({ timers: { set: timers.set, clear: timers.clear }, isVisible: () => state.visible, onChange: () => (ticks += 1) });
  return { timers, clock, state, ticks: () => ticks };
}

describe("createListClock", () => {
  it("間隔は 30 秒", () => {
    expect(LIST_CLOCK_MS).toBe(30_000);
  });

  it("要るとき・見えているときに、30 秒後のタイマーを 1 本だけ張る(sync を重ねても増えない)", () => {
    const s = setup();
    expect(s.timers.pending()).toBe(0); // 前提: 最初は張っていない
    s.clock.sync(true);
    s.clock.sync(true);
    s.clock.sync(true);
    expect(s.timers.pending()).toBe(1);
    expect(s.timers.nextIn()).toBe(30_000);
  });

  it("発火すると onChange を 1 回呼び、そのままでは張り直さない(張り直しは呼び出し側が render → sync でする)", async () => {
    const s = setup();
    s.clock.sync(true);
    await s.timers.advance(30_000);
    expect(s.ticks()).toBe(1);
    expect(s.timers.pending()).toBe(0);
    s.clock.sync(true); // render の末尾の sync
    expect(s.timers.pending()).toBe(1);
    await s.timers.advance(30_000);
    expect(s.ticks()).toBe(2);
  });

  it("要らなくなったら(sync(false))タイマーを止める。止めたあとの sync(false) は何もしない", () => {
    const s = setup();
    s.clock.sync(true);
    expect(s.timers.pending()).toBe(1); // 前提
    s.clock.sync(false);
    expect(s.timers.pending()).toBe(0);
    s.clock.sync(false);
    expect(s.timers.pending()).toBe(0);
  });

  it("画面が見えていないときは張らない。見えない状態になった sync で止める。見えるようになれば張れる", () => {
    const s = setup(false);
    s.clock.sync(true);
    expect(s.timers.pending()).toBe(0);
    s.state.visible = true;
    s.clock.sync(true);
    expect(s.timers.pending()).toBe(1); // 前提
    s.state.visible = false;
    s.clock.sync(true);
    expect(s.timers.pending()).toBe(0);
  });
});
