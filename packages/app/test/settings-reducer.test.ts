import { describe, expect, it } from "vitest";

import {
  BASE_SCORE_WEIGHT_KEYS,
  BIAS_WEIGHT_KEYS,
  type MaskedSettings,
} from "../src/shared/settings.js";
import {
  buildUpdate,
  createInitialSettingsState,
  isDirty,
  isFormValid,
  settingsReducer,
  type SettingsAction,
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
    clipVariant: "default",
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

  it("読込成功でクリップ幅版(clipVariant)を反映すること(タスクD-2)", () => {
    const s = loadedState(fakeMasked({ clipVariant: "wide15" }));
    expect(s.clipVariant).toBe("wide15");
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
    s = settingsReducer(s, { type: "クリップ幅版選択", value: "wide15" });

    expect(s.apiKeyInput).toBe("sk-ant-new");
    expect(s.discordWebhookUrl).toBe("https://x.example/y");
    expect(s.evThreshold).toBe("1.3");
    expect(s.biasWeights.venue).toBe("0.4");
    expect(s.baseScoreWeights.jockey).toBe("0.9");
    expect(s.autoSendDiscord).toBe(true);
    expect(s.additionalInstruction).toBe("人気薄の複勝率は慎重に見積もること");
    expect(s.clipVariant).toBe("wide15");
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

describe("ログフォルダを開く・ログエクスポートの状態遷移(Task#36)", () => {
  it("初期状態はどちらも idle・メッセージ無し", () => {
    const s = createInitialSettingsState();
    expect(s.logFolderStatus).toBe("idle");
    expect(s.logFolderMessage).toBeNull();
    expect(s.logExportStatus).toBe("idle");
    expect(s.logExportMessage).toBeNull();
  });

  it("ログフォルダを開く: 開始→成功で status=success になる", () => {
    let s = createInitialSettingsState();
    s = settingsReducer(s, { type: "ログフォルダを開く開始" });
    expect(s.logFolderStatus).toBe("opening");
    s = settingsReducer(s, { type: "ログフォルダを開く成功" });
    expect(s.logFolderStatus).toBe("success");
    expect(s.logFolderMessage).toBeNull();
  });

  it("ログフォルダを開く: 開始→失敗でエラーメッセージを保持する", () => {
    let s = createInitialSettingsState();
    s = settingsReducer(s, { type: "ログフォルダを開く開始" });
    s = settingsReducer(s, {
      type: "ログフォルダを開く失敗",
      message: "権限がありません",
    });
    expect(s.logFolderStatus).toBe("error");
    expect(s.logFolderMessage).toBe("権限がありません");
  });

  it("ログエクスポート: 開始→保存成功で保存先パスをメッセージに保持する", () => {
    let s = createInitialSettingsState();
    s = settingsReducer(s, { type: "ログエクスポート開始" });
    expect(s.logExportStatus).toBe("exporting");
    s = settingsReducer(s, {
      type: "ログエクスポート成功",
      filePath: "/home/user/keiba-ev-tool-logs-20260716.txt",
    });
    expect(s.logExportStatus).toBe("saved");
    expect(s.logExportMessage).toBe(
      "/home/user/keiba-ev-tool-logs-20260716.txt",
    );
  });

  it("ログエクスポート: キャンセルで status=canceled になり何もしていない旨を保持する", () => {
    let s = createInitialSettingsState();
    s = settingsReducer(s, { type: "ログエクスポート開始" });
    s = settingsReducer(s, { type: "ログエクスポートキャンセル" });
    expect(s.logExportStatus).toBe("canceled");
  });

  it("ログエクスポート: 開始→失敗でエラーメッセージを保持する", () => {
    let s = createInitialSettingsState();
    s = settingsReducer(s, { type: "ログエクスポート開始" });
    s = settingsReducer(s, {
      type: "ログエクスポート失敗",
      message: "書き込みに失敗しました",
    });
    expect(s.logExportStatus).toBe("error");
    expect(s.logExportMessage).toBe("書き込みに失敗しました");
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

  it("クリップ幅版(clipVariant)を含めること(タスクD-2)", () => {
    let s = loadedState();
    s = settingsReducer(s, { type: "クリップ幅版選択", value: "wide15" });
    const update = buildUpdate(s);
    expect(update.clipVariant).toBe("wide15");
  });

  it("クリップ幅版未選択(既定)は'default'を含めること(タスクD-2)", () => {
    const update = buildUpdate(loadedState());
    expect(update.clipVariant).toBe("default");
  });
});

describe("isDirty(未保存インジケータ、Issue #11)", () => {
  it("未読込の初期状態は非dirty", () => {
    expect(isDirty(createInitialSettingsState())).toBe(false);
  });

  it("読込成功直後は非dirty(数値の表記揺れ'1'と'1.0'で誤dirtyにならない)", () => {
    const s = loadedState(fakeMasked({ evThreshold: 1.0 }));
    expect(isDirty(s)).toBe(false);
  });

  const singleFieldCases: { name: string; action: SettingsAction }[] = [
    {
      name: "Webhook入力",
      action: { type: "Webhook入力", value: "https://x.example/y" },
    },
    { name: "EV閾値入力", action: { type: "EV閾値入力", value: "1.3" } },
    { name: "自動送信切替", action: { type: "自動送信切替", value: true } },
    {
      name: "追加指示入力",
      action: { type: "追加指示入力", value: "テスト指示" },
    },
    {
      name: "クリップ幅版選択",
      action: { type: "クリップ幅版選択", value: "wide15" },
    },
    ...BIAS_WEIGHT_KEYS.map((key) => ({
      name: `バイアス重み入力(${key})`,
      action: {
        type: "バイアス重み入力",
        key,
        value: "0.4",
      } as SettingsAction,
    })),
    ...BASE_SCORE_WEIGHT_KEYS.map((key) => ({
      name: `基礎重み入力(${key})`,
      action: {
        type: "基礎重み入力",
        key,
        value: "0.4",
      } as SettingsAction,
    })),
  ];

  it.each(singleFieldCases)("$name 単独でdirtyになる", ({ action }) => {
    const s = settingsReducer(loadedState(), action);
    expect(isDirty(s)).toBe(true);
  });

  it("APIキー入力が非空でdirty、空に戻すと非dirtyに戻る(他フィールド不変の場合)", () => {
    let s = loadedState();
    s = settingsReducer(s, { type: "APIキー入力", value: "sk-ant-new" });
    expect(isDirty(s)).toBe(true);
    s = settingsReducer(s, { type: "APIキー入力", value: "" });
    expect(isDirty(s)).toBe(false);
  });

  it("apiKeyFromEnv=trueのときは入力欄が空のままなのでdirty化しない", () => {
    const s = loadedState(fakeMasked({ apiKeyFromEnv: true }));
    expect(isDirty(s)).toBe(false);
  });

  it("保存成功でdirtyが解消し、以後の再編集で再度dirtyになる", () => {
    let s = loadedState();
    s = settingsReducer(s, { type: "EV閾値入力", value: "1.5" });
    expect(isDirty(s)).toBe(true);
    s = settingsReducer(s, { type: "保存開始" });
    s = settingsReducer(s, {
      type: "保存成功",
      settings: fakeMasked({ evThreshold: 1.5 }),
    });
    expect(isDirty(s)).toBe(false);
    s = settingsReducer(s, {
      type: "Webhook入力",
      value: "https://y.example/z",
    });
    expect(isDirty(s)).toBe(true);
  });

  it("保存失敗ではスナップショットが更新されないためdirtyを維持する", () => {
    let s = loadedState();
    s = settingsReducer(s, { type: "EV閾値入力", value: "1.5" });
    expect(isDirty(s)).toBe(true);
    s = settingsReducer(s, { type: "保存開始" });
    s = settingsReducer(s, { type: "保存失敗", message: "書き込み失敗" });
    expect(isDirty(s)).toBe(true);
  });

  it("デフォルトに戻す(保存成功経由)でdirtyが解消する", () => {
    // handleReset は「保存開始」→(resetSettings成功時)「保存成功」を dispatch する(SettingsView.tsx参照)。
    let s = loadedState();
    s = settingsReducer(s, { type: "EV閾値入力", value: "1.5" });
    expect(isDirty(s)).toBe(true);
    s = settingsReducer(s, { type: "保存開始" });
    s = settingsReducer(s, { type: "保存成功", settings: fakeMasked() });
    expect(isDirty(s)).toBe(false);
  });

  it("isDirtyはstateを破壊しない(不変性)", () => {
    const s = loadedState();
    const before = JSON.stringify(s);
    isDirty(s);
    expect(JSON.stringify(s)).toBe(before);
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
