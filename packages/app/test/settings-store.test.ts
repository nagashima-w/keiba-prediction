import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_SCORER_CONFIG } from "@keiba/core/scorer/config";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyUpdate,
  buildEvConfig,
  buildScorerConfig,
  coerceSettings,
  DEFAULT_APP_SETTINGS,
  maskApiKey,
  maskSettings,
  resolveEffectiveApiKey,
  SettingsStore,
} from "../src/main/settings-store.js";
import type { AppSettings } from "../src/shared/settings.js";

describe("DEFAULT_APP_SETTINGS(既定設定)", () => {
  it("EV閾値1.0・重みはcoreの既定・APIキー等は空/false", () => {
    expect(DEFAULT_APP_SETTINGS.evThreshold).toBe(1.0);
    expect(DEFAULT_APP_SETTINGS.biasWeights).toEqual(DEFAULT_SCORER_CONFIG.weights);
    expect(DEFAULT_APP_SETTINGS.baseScoreWeights).toEqual(
      DEFAULT_SCORER_CONFIG.baseScore.weights,
    );
    expect(DEFAULT_APP_SETTINGS.apiKey).toBe("");
    expect(DEFAULT_APP_SETTINGS.discordWebhookUrl).toBe("");
    expect(DEFAULT_APP_SETTINGS.autoSendDiscord).toBe(false);
  });
});

describe("coerceSettings(バリデーション+デフォルトマージ)", () => {
  it("空オブジェクトは全項目デフォルトになる", () => {
    expect(coerceSettings({})).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("null/非オブジェクトはデフォルトになる", () => {
    expect(coerceSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(coerceSettings(42)).toEqual(DEFAULT_APP_SETTINGS);
    expect(coerceSettings("x")).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("不正なEV閾値(0・負・非数値)はデフォルト1.0にフォールバック", () => {
    expect(coerceSettings({ evThreshold: 0 }).evThreshold).toBe(1.0);
    expect(coerceSettings({ evThreshold: -1 }).evThreshold).toBe(1.0);
    expect(coerceSettings({ evThreshold: "1.5" }).evThreshold).toBe(1.0);
    expect(coerceSettings({ evThreshold: Number.NaN }).evThreshold).toBe(1.0);
  });

  it("妥当なEV閾値は採用する", () => {
    expect(coerceSettings({ evThreshold: 1.3 }).evThreshold).toBe(1.3);
  });

  it("負の重みはデフォルトにフォールバックし、0以上は採用する", () => {
    const coerced = coerceSettings({
      biasWeights: { trackCondition: -1, venue: 0, season: 2 },
    });
    expect(coerced.biasWeights.trackCondition).toBe(
      DEFAULT_SCORER_CONFIG.weights.trackCondition,
    );
    expect(coerced.biasWeights.venue).toBe(0);
    expect(coerced.biasWeights.season).toBe(2);
    // 欠損キーはデフォルトで補完される。
    expect(coerced.biasWeights.rotation).toBe(
      DEFAULT_SCORER_CONFIG.weights.rotation,
    );
  });

  it("基礎重みの欠損・不正もデフォルト補完する", () => {
    const coerced = coerceSettings({ baseScoreWeights: { recentForm: 0.5 } });
    expect(coerced.baseScoreWeights.recentForm).toBe(0.5);
    expect(coerced.baseScoreWeights.jockey).toBe(
      DEFAULT_SCORER_CONFIG.baseScore.weights.jockey,
    );
  });

  it("文字列項目・真偽値は型が違えばデフォルトにする", () => {
    expect(coerceSettings({ apiKey: 123 }).apiKey).toBe("");
    expect(coerceSettings({ discordWebhookUrl: 1 }).discordWebhookUrl).toBe("");
    expect(coerceSettings({ autoSendDiscord: "yes" }).autoSendDiscord).toBe(false);
    expect(coerceSettings({ autoSendDiscord: true }).autoSendDiscord).toBe(true);
    expect(coerceSettings({ apiKey: "sk-ant-xxx" }).apiKey).toBe("sk-ant-xxx");
  });
});

describe("maskApiKey(APIキーのマスク)", () => {
  it("空文字は空文字のまま", () => {
    expect(maskApiKey("")).toBe("");
  });

  it("先頭数文字のみ残し、残りは*** で伏せる(平文を返さない)", () => {
    const masked = maskApiKey("sk-ant-api03-secretsecret");
    expect(masked.startsWith("sk-ant-")).toBe(true);
    expect(masked.endsWith("***")).toBe(true);
    expect(masked).not.toContain("secretsecret");
  });
});

describe("maskSettings(レンダラー向けマスク+環境変数優先)", () => {
  const base: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    apiKey: "sk-ant-stored-key-value",
    discordWebhookUrl: "https://discord.com/api/webhooks/1/a",
  };

  it("環境変数が未設定なら保存キーをマスクして返す(fromEnv=false)", () => {
    const masked = maskSettings(base, undefined);
    expect(masked.apiKeyFromEnv).toBe(false);
    expect(masked.apiKeyMasked.endsWith("***")).toBe(true);
    expect(masked.apiKeyMasked).not.toContain("stored-key-value");
    expect(masked.discordWebhookUrl).toBe(base.discordWebhookUrl);
    // 平文キーはマスク済み結果に含まれない。
    expect(JSON.stringify(masked)).not.toContain("sk-ant-stored-key-value");
  });

  it("環境変数が設定済みなら環境変数を優先し fromEnv=true・環境キーをマスク", () => {
    const masked = maskSettings(base, "sk-ant-env-key-value");
    expect(masked.apiKeyFromEnv).toBe(true);
    expect(masked.apiKeyMasked.endsWith("***")).toBe(true);
    expect(JSON.stringify(masked)).not.toContain("sk-ant-env-key-value");
    expect(JSON.stringify(masked)).not.toContain("sk-ant-stored-key-value");
  });

  it("空白のみの環境変数は未設定扱い", () => {
    const masked = maskSettings(base, "   ");
    expect(masked.apiKeyFromEnv).toBe(false);
  });
});

describe("resolveEffectiveApiKey(実効APIキーの解決)", () => {
  const settings: AppSettings = { ...DEFAULT_APP_SETTINGS, apiKey: "stored" };

  it("環境変数があれば環境変数を採用", () => {
    expect(resolveEffectiveApiKey(settings, "env")).toBe("env");
  });

  it("環境変数が空・空白なら保存キーを採用", () => {
    expect(resolveEffectiveApiKey(settings, undefined)).toBe("stored");
    expect(resolveEffectiveApiKey(settings, "")).toBe("stored");
    expect(resolveEffectiveApiKey(settings, "  ")).toBe("stored");
  });
});

describe("applyUpdate(現在設定への更新適用)", () => {
  const current: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    apiKey: "keep-me",
    discordWebhookUrl: "https://old.example.com/x",
  };

  it("apiKey未指定(undefined)なら現在のキーを保持する", () => {
    const next = applyUpdate(current, {
      discordWebhookUrl: "https://new.example.com/x",
      evThreshold: 1.2,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: true,
    });
    expect(next.apiKey).toBe("keep-me");
    expect(next.discordWebhookUrl).toBe("https://new.example.com/x");
    expect(next.evThreshold).toBe(1.2);
    expect(next.autoSendDiscord).toBe(true);
  });

  it("apiKeyに文字列を指定すれば差し替え、空文字ならクリアする", () => {
    const replaced = applyUpdate(current, {
      apiKey: "new-key",
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
    });
    expect(replaced.apiKey).toBe("new-key");

    const cleared = applyUpdate(current, {
      apiKey: "",
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
    });
    expect(cleared.apiKey).toBe("");
  });

  it("apiKeyが文字列でない(null等の不正入力)なら現在のキーを保持する", () => {
    // IPC 由来で null が来ても保存済みキーが消えないこと(防御)。
    const withNull = applyUpdate(current, {
      apiKey: null as unknown as string,
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
    });
    expect(withNull.apiKey).toBe("keep-me");

    const withNumber = applyUpdate(current, {
      apiKey: 12345 as unknown as string,
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
    });
    expect(withNumber.apiKey).toBe("keep-me");
  });

  it("不正な値は保存時にcoerceでフォールバックされる", () => {
    const next = applyUpdate(current, {
      discordWebhookUrl: "",
      evThreshold: -5,
      biasWeights: { ...DEFAULT_APP_SETTINGS.biasWeights, venue: -3 },
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
    });
    expect(next.evThreshold).toBe(1.0);
    expect(next.biasWeights.venue).toBe(DEFAULT_SCORER_CONFIG.weights.venue);
  });
});

describe("buildScorerConfig(設定→ScorerConfigのディープマージ)", () => {
  it("重みだけを上書きし、他の既定項目は保持する", () => {
    const settings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      biasWeights: { ...DEFAULT_APP_SETTINGS.biasWeights, trackCondition: 0.5 },
      baseScoreWeights: { ...DEFAULT_APP_SETTINGS.baseScoreWeights, jockey: 0.9 },
    };
    const config = buildScorerConfig(settings);
    expect(config.weights.trackCondition).toBe(0.5);
    expect(config.baseScore.weights.jockey).toBe(0.9);
    // 重み以外の既定は維持。
    expect(config.minSampleForBias).toBe(DEFAULT_SCORER_CONFIG.minSampleForBias);
    expect(config.prior).toEqual(DEFAULT_SCORER_CONFIG.prior);
    expect(config.baseScore.neutralPlaceRate).toBe(
      DEFAULT_SCORER_CONFIG.baseScore.neutralPlaceRate,
    );
  });
});

describe("buildEvConfig(設定→EvConfig)", () => {
  it("閾値を反映する", () => {
    expect(buildEvConfig({ ...DEFAULT_APP_SETTINGS, evThreshold: 1.4 })).toEqual({
      threshold: 1.4,
    });
  });
});

describe("SettingsStore(JSONファイルの読み書き)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });
  function tempFile(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "keiba-settings-"));
    dirs.push(dir);
    return path.join(dir, "settings.json");
  }

  it("保存した設定を読み込むと同じ値が返る(往復)", () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    const settings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      apiKey: "sk-ant-abc",
      evThreshold: 1.25,
    };
    store.save(settings);
    expect(store.load()).toEqual(settings);
  });

  it("ファイルが無ければデフォルトを返す", () => {
    const store = new SettingsStore(tempFile());
    expect(store.load()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("壊れたJSONはデフォルトにフォールバックする", () => {
    const file = tempFile();
    writeFileSync(file, "{ this is not json", "utf8");
    expect(new SettingsStore(file).load()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("保存ファイルは平文JSON(個人利用の割り切り)で、キーがそのまま含まれる", () => {
    const file = tempFile();
    new SettingsStore(file).save({
      ...DEFAULT_APP_SETTINGS,
      apiKey: "sk-ant-plaintext",
    });
    // 注記どおり平文で保存される(safeStorage暗号化は将来改善)。
    expect(readFileSync(file, "utf8")).toContain("sk-ant-plaintext");
  });
});
