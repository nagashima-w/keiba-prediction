/**
 * スマホ画面のエントリ(Issue #184)。ブラウザの `document`・`location`・`fetch` を、制御(`app.ts`)に繋ぐだけの薄い層。
 * DOM に触れるのはこのファイルだけ(型検査は tsconfig.client.json)。ロジックはすべて純関数・注入で、Node のテストが担う。
 * インラインスクリプトは使わない(CSP の `script-src 'self'`)。この 1 ファイルが、`/app.js` として Worker から配られる。
 */
import { createApp } from "./app";
import { createMounter } from "./dom";
import { applyDisplayName, fetchDisplayName, WHO_NAME_SELECTOR } from "./identity";
import { roleFromAttribute } from "./role";
import type { DrawColors } from "./replay-draw";
import { createReplayPlayer, type PlayerCanvas } from "./replay-player";

/** キャンバスの文字・線の色を、画面の CSS 変数(`page.ts` の配色。ライト/ダークで切り替わる)から読む。取れなければ無難な色。 */
function readReplayColors(canvas: PlayerCanvas): DrawColors {
  const style = getComputedStyle(canvas as unknown as Element);
  const pick = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return { fg: pick("--fg", "#1c1c1e"), bg: pick("--bg", "#ffffff"), muted: pick("--muted", "#6b6b70"), line: pick("--line", "#d8d8dc"), card: pick("--card", "#f5f5f7"), accent: pick("--accent", "#0a58ca") };
}

const root = document.getElementById("app");
if (root !== null) {
  // 同じ木なら DOM を触らない(Issue #186。ポーリングの再描画がタップ・開閉・日付ピッカーを壊さない)。
  const mountTree = createMounter(document, root);
  // レース再生(Issue #311)。キャンバスへの描画は木の外(プレーヤ)。画面の再描画でキャンバスが置き換わったら、直後に今のコマを描き直す。
  // 止まる条件はプレーヤが持つ(キャンバスが消えた・別の分析になった・タブが非表示)。`app` はプレーヤより後に作る(走り終えた通知は、始まってから届くので間に合う)。
  const replayPlayer = createReplayPlayer({
    getCanvas: () => document.querySelector("canvas[data-replay-id]") as unknown as PlayerCanvas | null,
    raf: (callback) => requestAnimationFrame(callback),
    cancelRaf: (handle) => cancelAnimationFrame(handle),
    isVisible: () => document.visibilityState !== "hidden",
    random: () => Math.random(),
    reducedMotion: () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    colors: readReplayColors,
    onFinish: (analysisId, order) => app.onReplayFinish(analysisId, order),
  });
  const mount: typeof mountTree = (tree, force) => {
    mountTree(tree, force);
    replayPlayer.redraw();
  };
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
    // 移行ファイルの検証(Issue #222)は主スレッドで展開・JSON.parse するので、一定時間ごとに描画・入力へ制御を返す。
    yieldToUi: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    // 役割(Issue #238)。サーバが `#app` の `data-role` で渡す。欠落・不明は閲覧者(管理者の入口を出さない)。画面で隠すのは補助で、拒否はサーバ側。
    role: roleFromAttribute(root.getAttribute("data-role")),
    replay: replayPlayer,
  });
  window.addEventListener("hashchange", () => app.onHashChange());
  document.addEventListener("visibilitychange", () => {
    app.onVisibilityChange();
    replayPlayer.onVisibilityChange();
  });
  app.start();
}

// Issue #192: 「ログイン中: …」の行のメールアドレスを、Google のユーザー名にする。ページの読み込み後に 1 回だけ(ハッシュの遷移・「更新」では呼ばない)。
// 取れない・形が違う・空のときは、メールアドレスのまま(失敗を画面に出さず、再試行もしない)。書き込みは textContent だけ。#app とは独立(app が無くても動く)。
void fetchDisplayName((url, init) => fetch(url, init)).then((name) => applyDisplayName(document.querySelector(WHO_NAME_SELECTOR), name));
