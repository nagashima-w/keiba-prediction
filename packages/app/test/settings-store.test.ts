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
    // プロンプト追加指示(Task#28)は既定で空(何も注入しない)。
    expect(DEFAULT_APP_SETTINGS.additionalInstruction).toBe("");
    // クリップ幅版(タスクD-2)は既定で対照("default"、±10%)。
    expect(DEFAULT_APP_SETTINGS.clipVariant).toBe("default");
    // 組合せオッズ取得(機能D-2c第3段)は既定OFF(受け入れ条件2: U-A既定OFFの定義元)。
    expect(DEFAULT_APP_SETTINGS.includeComboOdds).toBe(false);
  });

  it("馬券配分3項目(機能C-2)は既定でbankroll=0・perRaceCap=0(未設定)・kellyFraction=0.5", () => {
    expect(DEFAULT_APP_SETTINGS.bankroll).toBe(0);
    expect(DEFAULT_APP_SETTINGS.perRaceCap).toBe(0);
    expect(DEFAULT_APP_SETTINGS.kellyFraction).toBe(0.5);
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

  it("プロンプト追加指示(additionalInstruction)は文字列であればそのまま採用し、型違い・欠損はデフォルト(空文字)にする(Task#28)", () => {
    expect(
      coerceSettings({ additionalInstruction: "人気薄の複勝率は慎重に見積もること" })
        .additionalInstruction,
    ).toBe("人気薄の複勝率は慎重に見積もること");
    expect(coerceSettings({ additionalInstruction: 123 }).additionalInstruction).toBe("");
    expect(coerceSettings({}).additionalInstruction).toBe("");
    // 複数行の指示もそのまま保持する。
    expect(
      coerceSettings({ additionalInstruction: "1行目\n2行目" }).additionalInstruction,
    ).toBe("1行目\n2行目");
  });

  it("クリップ幅版(clipVariant)はCLIP_VARIANT_IDSに含まれる値ならそのまま採用すること(タスクD-2)", () => {
    expect(coerceSettings({ clipVariant: "wide15" }).clipVariant).toBe("wide15");
    expect(coerceSettings({ clipVariant: "default" }).clipVariant).toBe("default");
  });

  it("クリップ幅版(clipVariant)は未知の文字列・型違い・欠損はdefaultへフォールバックすること(タスクD-2: 不正値/未設定フォールバック)", () => {
    expect(coerceSettings({ clipVariant: "bogus" }).clipVariant).toBe("default");
    expect(coerceSettings({ clipVariant: 123 }).clipVariant).toBe("default");
    expect(coerceSettings({ clipVariant: null }).clipVariant).toBe("default");
    expect(coerceSettings({}).clipVariant).toBe("default");
  });

  describe("includeComboOdds(組合せオッズ取得。機能D-2c第3段・Issue #28): boolean以外は既定(false)へフォールバック", () => {
    it.each([
      { name: "欠損はfalse", raw: undefined, expected: false },
      { name: "文字列'true'はfalse", raw: "true", expected: false },
      { name: "数値1はfalse", raw: 1, expected: false },
      { name: "nullはfalse", raw: null, expected: false },
      { name: "true(boolean)はtrueのまま採用", raw: true, expected: true },
      { name: "false(boolean)はfalseのまま採用", raw: false, expected: false },
    ])("$name", ({ raw, expected }) => {
      const input = raw === undefined ? {} : { includeComboOdds: raw };
      expect(coerceSettings(input).includeComboOdds).toBe(expected);
    });

    // 入れ替え変異の検知: autoSendDiscord(隣接するboolean項目)と非対称な値を与え、
    // includeComboOddsがautoSendDiscordの値と取り違えられていないことを固定する。
    it("autoSendDiscordと異なる値を与えても、それぞれ独立に反映されること(隣接boolean項目の取り違え検知)", () => {
      const a = coerceSettings({ autoSendDiscord: true, includeComboOdds: false });
      expect(a.autoSendDiscord).toBe(true);
      expect(a.includeComboOdds).toBe(false);

      const b = coerceSettings({ autoSendDiscord: false, includeComboOdds: true });
      expect(b.autoSendDiscord).toBe(false);
      expect(b.includeComboOdds).toBe(true);
    });
  });

  describe("馬券配分3項目(機能C-2): 欠損/非数値/負/非有限/非整数/範囲外は既定へフォールバック", () => {
    it.each([
      { name: "妥当な整数はそのまま採用", raw: 50000, expected: 50000 },
      { name: "欠損はデフォルト", raw: undefined, expected: 0 },
      { name: "文字列はデフォルト", raw: "50000", expected: 0 },
      { name: "負値はデフォルト", raw: -1, expected: 0 },
      { name: "非有限(NaN)はデフォルト", raw: Number.NaN, expected: 0 },
      { name: "非有限(Infinity)はデフォルト", raw: Number.POSITIVE_INFINITY, expected: 0 },
      { name: "非整数はデフォルト", raw: 100.5, expected: 0 },
      { name: "上限超過(100,000,001)はデフォルト", raw: 100_000_001, expected: 0 },
      { name: "上限ちょうど(100,000,000)は採用", raw: 100_000_000, expected: 100_000_000 },
      { name: "0(未設定)は採用", raw: 0, expected: 0 },
    ])("bankroll: $name", ({ raw, expected }) => {
      const input = raw === undefined ? {} : { bankroll: raw };
      expect(coerceSettings(input).bankroll).toBe(expected);
    });

    it.each([
      { name: "妥当な整数はそのまま採用", raw: 5000, expected: 5000 },
      { name: "欠損はデフォルト", raw: undefined, expected: 0 },
      { name: "文字列はデフォルト", raw: "5000", expected: 0 },
      { name: "負値はデフォルト", raw: -1, expected: 0 },
      { name: "非有限(NaN)はデフォルト", raw: Number.NaN, expected: 0 },
      { name: "非有限(-Infinity)はデフォルト", raw: Number.NEGATIVE_INFINITY, expected: 0 },
      { name: "非整数はデフォルト", raw: 99.9, expected: 0 },
      { name: "上限超過(10,000,001)はデフォルト", raw: 10_000_001, expected: 0 },
      { name: "上限ちょうど(10,000,000)は採用", raw: 10_000_000, expected: 10_000_000 },
      { name: "0(未設定)は採用", raw: 0, expected: 0 },
    ])("perRaceCap: $name", ({ raw, expected }) => {
      const input = raw === undefined ? {} : { perRaceCap: raw };
      expect(coerceSettings(input).perRaceCap).toBe(expected);
    });

    it.each([
      { name: "妥当な値はそのまま採用", raw: 0.3, expected: 0.3 },
      { name: "欠損はデフォルト(0.5)", raw: undefined, expected: 0.5 },
      { name: "文字列はデフォルト", raw: "0.3", expected: 0.5 },
      { name: "負値はデフォルト", raw: -0.1, expected: 0.5 },
      { name: "非有限(NaN)はデフォルト", raw: Number.NaN, expected: 0.5 },
      { name: "上限超過(1.0000001)はデフォルト", raw: 1.0000001, expected: 0.5 },
      { name: "下限ちょうど(0.05)は採用", raw: 0.05, expected: 0.05 },
      { name: "上限ちょうど(1)は採用", raw: 1, expected: 1 },
    ])("kellyFraction: $name", ({ raw, expected }) => {
      const input = raw === undefined ? {} : { kellyFraction: raw };
      expect(coerceSettings(input).kellyFraction).toBe(expected);
    });

    it("0はUIの下限(0.05)未満だが、settings.json手編集経由ではmain側は矯正せずそのまま0を採用すること(core見送り理由④への到達契約。boss着手前ゲート2026-07-30)", () => {
      // UI(shared/settings.ts の isValidKellyFraction)は0を弾くが、main側のcoerceKellyFractionは
      // core resolveKellyFractionと同じ[0,1]範囲を許容し、0をそのままcoreへ届ける契約になっている。
      expect(coerceSettings({ kellyFraction: 0 }).kellyFraction).toBe(0);
    });
  });

  it("馬券配分3項目が無い既存settings.json(後方互換)を読んでも他項目が壊れず既定が入ること", () => {
    // 機能C-2導入前のsettings.json相当(3項目を含まない)。
    const legacy = {
      apiKey: "sk-ant-legacy",
      discordWebhookUrl: "https://discord.com/api/webhooks/1/a",
      evThreshold: 1.2,
      biasWeights: DEFAULT_SCORER_CONFIG.weights,
      baseScoreWeights: DEFAULT_SCORER_CONFIG.baseScore.weights,
      autoSendDiscord: true,
      additionalInstruction: "",
      clipVariant: "default",
    };
    const coerced = coerceSettings(legacy);
    // 3項目は新規既定値へフォールバックする。
    expect(coerced.bankroll).toBe(0);
    expect(coerced.perRaceCap).toBe(0);
    expect(coerced.kellyFraction).toBe(0.5);
    // 既存項目は壊れず維持される。
    expect(coerced.apiKey).toBe("sk-ant-legacy");
    expect(coerced.evThreshold).toBe(1.2);
    expect(coerced.autoSendDiscord).toBe(true);
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
    additionalInstruction: "人気薄の複勝率は慎重に見積もること",
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

  it("プロンプト追加指示はAPIキーと違い平文のまま返す(Discord URLと同様の設計判断、Task#28)", () => {
    const masked = maskSettings(base, undefined);
    expect(masked.additionalInstruction).toBe("人気薄の複勝率は慎重に見積もること");
  });

  it("クリップ幅版(clipVariant)をそのまま返す(タスクD-2)", () => {
    const masked = maskSettings({ ...base, clipVariant: "wide15" }, undefined);
    expect(masked.clipVariant).toBe("wide15");
  });

  it("馬券配分3項目(bankroll/perRaceCap/kellyFraction)をそのまま返す(機能C-2・往復編集フォーム表示のため平文)", () => {
    const masked = maskSettings(
      { ...base, bankroll: 300000, perRaceCap: 20000, kellyFraction: 0.3 },
      undefined,
    );
    expect(masked.bankroll).toBe(300000);
    expect(masked.perRaceCap).toBe(20000);
    expect(masked.kellyFraction).toBe(0.3);
  });

  it("includeComboOdds(機能D-2c第3段)をそのまま返す(往復編集フォーム表示のため平文。OFF/ON両方向)", () => {
    expect(maskSettings({ ...base, includeComboOdds: false }, undefined).includeComboOdds).toBe(
      false,
    );
    expect(maskSettings({ ...base, includeComboOdds: true }, undefined).includeComboOdds).toBe(
      true,
    );
  });

  it("includeComboOddsとautoSendDiscordが非対称でも取り違えないこと(隣接boolean項目の入れ替え変異検知)", () => {
    const masked = maskSettings(
      { ...base, autoSendDiscord: true, includeComboOdds: false },
      undefined,
    );
    expect(masked.autoSendDiscord).toBe(true);
    expect(masked.includeComboOdds).toBe(false);

    const flipped = maskSettings(
      { ...base, autoSendDiscord: false, includeComboOdds: true },
      undefined,
    );
    expect(flipped.autoSendDiscord).toBe(false);
    expect(flipped.includeComboOdds).toBe(true);
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
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
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
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
    });
    expect(replaced.apiKey).toBe("new-key");

    const cleared = applyUpdate(current, {
      apiKey: "",
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
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
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
    });
    expect(withNull.apiKey).toBe("keep-me");

    const withNumber = applyUpdate(current, {
      apiKey: 12345 as unknown as string,
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
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
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
    });
    expect(next.evThreshold).toBe(1.0);
    expect(next.biasWeights.venue).toBe(DEFAULT_SCORER_CONFIG.weights.venue);
  });

  it("additionalInstructionを渡すとそのまま反映される(Task#28)", () => {
    const next = applyUpdate(current, {
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "人気薄の複勝率は慎重に見積もること",
      clipVariant: "default",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
    });
    expect(next.additionalInstruction).toBe("人気薄の複勝率は慎重に見積もること");
  });

  it("clipVariantを渡すとそのまま反映される(タスクD-2)", () => {
    const next = applyUpdate(current, {
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "",
      clipVariant: "wide15",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
    });
    expect(next.clipVariant).toBe("wide15");
  });

  it("clipVariantに不正な値(未知の文字列・型違い)を渡すとdefaultへフォールバックすること(タスクD-2)", () => {
    const next = applyUpdate(current, {
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "",
      clipVariant: "bogus" as unknown as AppSettings["clipVariant"],
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
    });
    expect(next.clipVariant).toBe("default");
  });

  it("馬券配分3項目(bankroll/perRaceCap/kellyFraction)を渡すとそのまま反映される(機能C-2)", () => {
    const next = applyUpdate(current, {
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 500000,
      perRaceCap: 30000,
      kellyFraction: 0.4,
      includeComboOdds: false,
    });
    expect(next.bankroll).toBe(500000);
    expect(next.perRaceCap).toBe(30000);
    expect(next.kellyFraction).toBe(0.4);
  });

  it("馬券配分3項目に不正な値を渡すとcoerceで既定へフォールバックされる(機能C-2)", () => {
    const next = applyUpdate(current, {
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: -1,
      perRaceCap: Number.NaN,
      // kellyFraction=0はmain側では有効値として通る(coerceKellyFractionのテスト参照)ため、
      // ここでは範囲外(負値)を使ってフォールバックを確認する。
      kellyFraction: -0.5,
      includeComboOdds: false,
    });
    expect(next.bankroll).toBe(0);
    expect(next.perRaceCap).toBe(0);
    expect(next.kellyFraction).toBe(0.5);
  });

  it("includeComboOdds(機能D-2c第3段)を渡すとそのまま反映される(OFF/ON両方向)", () => {
    const onNext = applyUpdate(current, {
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: true,
    });
    expect(onNext.includeComboOdds).toBe(true);

    const offNext = applyUpdate(current, {
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: false,
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
    });
    expect(offNext.includeComboOdds).toBe(false);
  });

  it("includeComboOddsとautoSendDiscordが非対称でも取り違えないこと(隣接boolean項目の入れ替え変異検知)", () => {
    const next = applyUpdate(current, {
      discordWebhookUrl: "",
      evThreshold: 1,
      biasWeights: DEFAULT_APP_SETTINGS.biasWeights,
      baseScoreWeights: DEFAULT_APP_SETTINGS.baseScoreWeights,
      autoSendDiscord: true,
      additionalInstruction: "",
      clipVariant: "default",
      bankroll: 10000,
      perRaceCap: 5000,
      kellyFraction: 0.5,
      includeComboOdds: false,
    });
    expect(next.autoSendDiscord).toBe(true);
    expect(next.includeComboOdds).toBe(false);
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

  it("馬券配分3項目(bankroll/perRaceCap/kellyFraction)を変えてもScorerConfigは一切変化しないこと(受け入れ条件28: 既存出力の非破壊性)", () => {
    // buildScorerConfigはスコアリング(ひいては妙味ランキング・レース別ハイライト・
    // Discordサマリ・エクスポート・DB保存内容すべての土台)を組み立てる関数であり、
    // ここが3項目に無反応であることを確認すれば下流の既存出力が影響を受けないことの
    // 土台が担保される(妙味ランキング等の各出力はこのScorerConfig/EvConfigを経由するため)。
    const base = buildScorerConfig(DEFAULT_APP_SETTINGS);
    const variants: AppSettings[] = [
      { ...DEFAULT_APP_SETTINGS, bankroll: 500000, perRaceCap: 20000, kellyFraction: 0.3 },
      { ...DEFAULT_APP_SETTINGS, bankroll: 0, perRaceCap: 0, kellyFraction: 1 },
      { ...DEFAULT_APP_SETTINGS, bankroll: 100_000_000, perRaceCap: 10_000_000, kellyFraction: 0.05 },
    ];
    for (const settings of variants) {
      expect(buildScorerConfig(settings)).toEqual(base);
    }
  });
});

describe("buildEvConfig(設定→EvConfig)", () => {
  it("閾値を反映する", () => {
    expect(buildEvConfig({ ...DEFAULT_APP_SETTINGS, evThreshold: 1.4 })).toEqual({
      threshold: 1.4,
    });
  });

  it("馬券配分3項目(bankroll/perRaceCap/kellyFraction)を変えてもEvConfigは一切変化しないこと(受け入れ条件28: 既存出力の非破壊性)", () => {
    const base = buildEvConfig(DEFAULT_APP_SETTINGS);
    const variants: AppSettings[] = [
      { ...DEFAULT_APP_SETTINGS, bankroll: 500000, perRaceCap: 20000, kellyFraction: 0.3 },
      { ...DEFAULT_APP_SETTINGS, bankroll: 0, perRaceCap: 0, kellyFraction: 1 },
    ];
    for (const settings of variants) {
      expect(buildEvConfig(settings)).toEqual(base);
    }
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
