import path from "node:path";

import { app, BrowserWindow } from "electron";

import { closeResources, registerIpcHandlers } from "./ipc.js";

// main は esbuild で CommonJS にバンドルされるため __dirname が利用できる
// (dist/main/main.cjs を基準に preload/renderer への相対パスを解決する)。
const currentDir = __dirname;

/** Vite 開発サーバの URL(dev 実行時のみ環境変数で渡される)。 */
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

/** メインウィンドウを生成し、レンダラーを読み込む。 */
function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "競馬期待値分析ツール",
    webPreferences: {
      // セキュリティ既定: Node 統合は無効、コンテキスト分離は有効、sandbox 有効。
      // レンダラーは preload が公開する API 経由でのみ main と通信する。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(currentDir, "..", "preload", "preload.cjs"),
    },
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(currentDir, "..", "renderer", "index.html"));
  }
}

// アプリ起動時に IPC ハンドラを登録してからウィンドウを開く。
void app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();

  // macOS 対応: Dock からの再アクティブ化でウィンドウが無ければ再生成。
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// macOS 以外では全ウィンドウを閉じたらアプリを終了する。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// 終了時に分析パイプラインの依存(SQLite接続など)を解放する。
app.on("will-quit", () => {
  closeResources();
});
