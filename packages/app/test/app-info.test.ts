import { DEFAULT_SCORER_CONFIG } from "@keiba/core/scorer/config";
import { describe, expect, it } from "vitest";

import { APP_NAME, buildAppInfo } from "../src/main/app-info.js";

describe("buildAppInfo(アプリ情報の組み立て)", () => {
  it("アプリ名は固定の日本語名称を返す", () => {
    const info = buildAppInfo("0.1.0");
    expect(info.appName).toBe("競馬期待値分析ツール");
    expect(APP_NAME).toBe("競馬期待値分析ツール");
  });

  it("開発フェーズ表示を含む", () => {
    const info = buildAppInfo("0.1.0");
    expect(info.phase).toBe("Phase 4 開発中");
  });

  it("渡されたバージョン文字列をそのまま返す", () => {
    expect(buildAppInfo("1.2.3").appVersion).toBe("1.2.3");
  });

  it("バージョンが空文字の場合は unknown にフォールバックする", () => {
    expect(buildAppInfo("").appVersion).toBe("unknown");
    expect(buildAppInfo("   ").appVersion).toBe("unknown");
  });

  it("core の DEFAULT_SCORER_CONFIG から要約値を取り込む(core読み込み確認)", () => {
    const info = buildAppInfo("0.1.0");
    expect(info.core.minSampleForBias).toBe(DEFAULT_SCORER_CONFIG.minSampleForBias);
    expect(info.core.priorMin).toBe(DEFAULT_SCORER_CONFIG.prior.minPrior);
    expect(info.core.priorMax).toBe(DEFAULT_SCORER_CONFIG.prior.maxPrior);
  });
});
