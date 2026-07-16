import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { handleUnhandledRejection, handleWindowError } from "./global-error-handlers.js";

// レンダラーのエントリポイント。index.html の #root にマウントする。
const container = document.getElementById("root");
if (container === null) {
  throw new Error("#root 要素が見つかりません");
}

// IPC呼び出しのcatch節に紐付かない予期しない例外(白画面クラッシュ系)もmain側のログへ
// 集約する(Task#35 code-reviewer指摘: 要修正3-b)。ロジック本体はglobal-error-handlers.tsに
// 集約してあり、ここでは呼び出すだけの薄い配線にとどめる。
window.onerror = (message, source, lineno, colno, error) => {
  handleWindowError(
    { message: String(message), filename: source, lineno, colno, error },
    (payload) => window.keibaApi.logRendererError(payload),
  );
};

window.onunhandledrejection = (event) => {
  handleUnhandledRejection(event.reason, (payload) => window.keibaApi.logRendererError(payload));
};

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
