import type { KeibaApi } from "../shared/api.js";

// preload が contextBridge で公開する API をレンダラーの window 型に宣言する。
declare global {
  interface Window {
    readonly keibaApi: KeibaApi;
  }
}

export {};
