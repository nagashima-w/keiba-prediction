import { describe, expect, it } from "vitest";

import type { MaskedSettings } from "../src/shared/settings.js";
import {
  buildUpdate,
  createInitialSettingsState,
  isFormValid,
  settingsReducer,
  type SettingsFormState,
} from "../src/renderer/settings-reducer.js";

/** テスト用のマスク済み設定を作る。 */
function fakeMasked(overrides: Partial<MaskedSettings> = {}): MaskedSettings {
  return {
    apiKeyMasked: "sk-ant-a***",
    apiKeyFromEnv: false,
    discordWebhookUrl: "https://discord.com/api/webhooks/1/a",
    evThreshold: 1.0,
    biasWeights: {
      trackCondition: 1,
      venue: 1,
      season: 1,
      frame: 1,
      summerFatigue: 1,
      transport: 1,
      rotation: 1,
    },
    baseScoreWeights: {
      recentForm: 0.2,
      last3f: 0.1,
      courseDistance: 0.15,
      jockey: 0.15,
      weightChange: 1,
      courseFrameBias: 1,
    },
    autoSendDiscord: false,
    additionalInstruction: "",
    ...overrides,
  };
}

/** 読込成功済みの妥当な状態を作る。 */
function loadedState(masked = fakeMasked()): SettingsFormState {
  return settingsReducer(createInitialSettingsState(), {
    type: "読込成功",
    settings: masked,
  });
}

describe("settingsReducer(設定フォームの状態遷移)", () => {
  it("初期状態は未読込で status=idle", () => {
    const s = createInitialSettingsState();
    expect(s.loaded).toBe(false);
    expect(s.status).toBe("idle");
    expect(s.apiKeyInput).toBe("");
  });

  it("読込成功でマスク値・数値を文字列として反映し、APIキー入力は空のまま", () => {
    const s = loadedState();
    expect(s.loaded).toBe(true);
    expect(s.apiKeyMasked).toBe("sk-ant-a***");
    expect(s.apiKeyFromEnv).toBe(false);
    expect(s.evThreshold).toBe("1");
    expect(s.biasWeights.trackCondition).toBe("1");
    expect(s.baseScoreWeights.recentForm).toBe("0.2");
    // マスク表示のみ受け取り、入力欄には平文を置かない。
    expect(s.apiKeyInput).toBe("");
  });

  it("読込成功でプロンプト追加指示を反映すること(Task#28)", () => {
    const s = loadedState(
      fakeMasked({ additionalInstruction: "人気薄の複勝率は慎重に見積もること" }),
    );
    expect(s.additionalInstruction).toBe("人気薄の複勝率は慎重に見積もること");
  });

  it("各フィールドの入力アクションで値を更新する", () => {
    let s = loadedState();
    s = settingsReducer(s, { type: "APIキー入力", value: "sk-ant-new" });
    s = settingsReducer(s, { type: "Webhook入力", value: "https://x.example/y" });
    s = settingsReducer(s, { type: "EV閾値入力", value: "1.3" });
    s = settingsReducer(s, {
      type: "バイアス重み入力",
      key: "venue",
      value: "0.4",
    });
    s = settingsReducer(s, {
      type: "基礎重み入力",
      key: "jockey",
      value: "0.9",
    });
    s = settingsReducer(s, { type: "自動送信切替", value: true });
    s = settingsReducer(s, {
      type: "追加指示入力",
      value: "人気薄の複勝率は慎重に見積もること",
    });

    expect(s.apiKeyInput).toBe("sk-ant-new");
    expect(s.discordWebhookUrl).toBe("https://x.example/y");
    expect(s.evThreshold).toBe("1.3");
    expect(s.biasWeights.venue).toBe("0.4");
    expect(s.baseScoreWeights.jockey).toBe("0.9");
    expect(s.autoSendDiscord).toBe(true);
    expect(s.additionalInstruction).toBe("人気薄の複勝率は慎重に見積もること");
  });

  it("保存開始→保存成功でstatusが遷移し、APIキー入力をクリアしマスクを更新する", () => {
    let s = loadedState();
    s = settingsReducer(s, { type: "APIキー入力", value: "sk-ant-typed" });
    s = settingsReducer(s, { type: "保存開始" });
    expect(s.status).toBe("saving");
    s = settingsReducer(s, {
      type: "保存成功",
      settings: fakeMasked({ apiKeyMasked: "sk-ant-t***", evThreshold: 1.5 }),
    });
    expect(s.status).toBe("saved");
    expect(s.apiKeyInput).toBe("");
    expect(s.apiKeyMasked).toBe("sk-ant-t***");
    expect(s.evThreshold).toBe("1.5");
  });

  it("保存失敗でstatus=errorとメッセージを保持する", () => {
    let s = loadedState();
    s = settingsReducer(s, { type: "保存開始" });
    s = settingsReducer(s, { type: "保存失敗", message: "書き込み失敗" });
    expect(s.status).toBe("error");
    expect(s.message).toBe("書き込み失敗");
  });
});

describe("buildUpdate(フォーム→更新ペイロード)", () => {
  it("APIキー入力が空なら apiKey を含めない(現在値を保持させる)", () => {
    const update = buildUpdate(loadedState());
    expect(update.apiKey).toBeUndefined();
    expect(update.evThreshold).toBe(1);
    expect(update.biasWeights.trackCondition).toBe(1);
    expect(update.baseScoreWeights.recentForm).toBe(0.2);
    expect(update.autoSendDiscord).toBe(false);
  });

  it("APIキー入力があれば apiKey を数値化した重みとともに含める", () => {
    let s = loadedState();
    s = settingsReducer(s, { type: "APIキー入力", value: "sk-ant-new" });
    s = settingsReducer(s, { type: "EV閾値入力", value: "1.4" });
    s = settingsReducer(s, {
      type: "バイアス重み入力",
      key: "venue",
      value: "0.4",
    });
    const update = buildUpdate(s);
    expect(update.apiKey).toBe("sk-ant-new");
    expect(update.evThreshold).toBe(1.4);
    expect(update.biasWeights.venue).toBe(0.4);
  });

  it("プロンプト追加指示を含めること(Task#28)", () => {
    let s = loadedState();
    s = settingsReducer(s, {
      type: "追加指示入力",
      value: "人気薄の複勝率は慎重に見積もること",
    });
    const update = buildUpdate(s);
    expect(update.additionalInstruction).toBe("人気薄の複勝率は慎重に見積もること");
  });
});

describe("isFormValid(フォーム全体の妥当性)", () => {
  it("読込直後の既定値は妥当", () => {
    expect(isFormValid(loadedState())).toBe(true);
  });

  it("EV閾値が0以下なら不正", () => {
    const s = settingsReducer(loadedState(), {
      type: "EV閾値入力",
      value: "0",
    });
    expect(isFormValid(s)).toBe(false);
  });

  it("重みが負なら不正", () => {
    const s = settingsReducer(loadedState(), {
      type: "基礎重み入力",
      key: "jockey",
      value: "-1",
    });
    expect(isFormValid(s)).toBe(false);
  });

  it("Webhook URLが不正形式なら不正(空は許容)", () => {
    const bad = settingsReducer(loadedState(), {
      type: "Webhook入力",
      value: "not a url",
    });
    expect(isFormValid(bad)).toBe(false);

    const empty = settingsReducer(loadedState(), {
      type: "Webhook入力",
      value: "",
    });
    expect(isFormValid(empty)).toBe(true);
  });
});
