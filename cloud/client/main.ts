/**
 * スマホ画面のエントリ(Issue #184)。ブラウザの `document`・`location`・`fetch` を、制御(`app.ts`)に繋ぐだけの薄い層。
 * DOM に触れるのはこのファイルだけ(型検査は tsconfig.client.json)。ロジックはすべて純関数・注入で、Node のテストが担う。
 * インラインスクリプトは使わない(CSP の `script-src 'self'`)。この 1 ファイルが、`/app.js` として Worker から配られる。
 */
import { createApp } from "./app";
import { createMounter } from "./dom";

const root = document.getElementById("app");
if (root !== null) {
  // 同じ木なら DOM を触らない(Issue #186。ポーリングの再描画がタップ・開閉・日付ピッカーを壊さない)。
  const mount = createMounter(document, root);
  const app = createApp({
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    render: mount,
    getHash: () => location.hash,
    setHash: (hash) => {
      location.hash = hash;
    },
    // 追跡(Issue #186)のタイマーと可視状態。非表示の間は追跡を止め、表示に戻ったら即時に 1 回取って再開する。
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as number) },
    isVisible: () => document.visibilityState !== "hidden",
  });
  window.addEventListener("hashchange", () => app.onHashChange());
  document.addEventListener("visibilitychange", () => app.onVisibilityChange());
  app.start();
}
