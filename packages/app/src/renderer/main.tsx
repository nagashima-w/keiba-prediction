import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

// レンダラーのエントリポイント。index.html の #root にマウントする。
const container = document.getElementById("root");
if (container === null) {
  throw new Error("#root 要素が見つかりません");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
