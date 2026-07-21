/**
 * 設定フォームの状態遷移(純関数 reducer)。
 *
 * 数値項目(EV閾値・各重み)は自由入力のため文字列で保持し、検証・数値化は shared の純関数で行う。
 * 副作用(IPC の getSettings/saveSettings/resetSettings)はコンポーネント側に置き、
 * 遷移規則・更新ペイロード生成・妥当性判定だけをこの純関数に集約して単体テストで固定する。
 * すべての遷移は新しいオブジェクトを返し、入力 state を破壊しない(不変性)。
 */

import {
  BASE_SCORE_WEIGHT_KEYS,
  BIAS_WEIGHT_KEYS,
  isValidThreshold,
  isValidWebhookUrl,
  isValidWeight,
  type BaseScoreWeightKey,
  type BaseScoreWeightValues,
  type BiasWeightKey,
  type BiasWeightValues,
  type ClipVariantId,
  type MaskedSettings,
  type SettingsUpdate,
} from "../shared/settings.js";

/** 保存操作の状態。 */
export type SettingsStatus =
  | "idle"
  | "loading"
  | "saving"
  | "saved"
  | "error";

/** 「ログフォルダを開く」操作の状態(Task#36 受け入れ条件1)。 */
export type LogFolderStatus = "idle" | "opening" | "success" | "error";

/** 「最新ログをエクスポート」操作の状態(Task#36 受け入れ条件2)。 */
export type LogExportStatus =
  | "idle"
  | "exporting"
  | "saved"
  | "canceled"
  | "error";

/** 設定フォームの状態。数値は文字列で保持する。 */
export interface SettingsFormState {
  /** 読込済みか(未読込ならフォームを描画しない)。 */
  readonly loaded: boolean;
  /** APIキーの入力欄(空なら「現在値を保持」)。マスク表示は別に持つ。 */
  readonly apiKeyInput: string;
  /** 現在のマスク済みAPIキー表示。 */
  readonly apiKeyMasked: string;
  /** 環境変数優先か(true なら入力しても環境変数が使われる旨を表示)。 */
  readonly apiKeyFromEnv: boolean;
  /** Discord Webhook URL。 */
  readonly discordWebhookUrl: string;
  /** EV閾値(文字列)。 */
  readonly evThreshold: string;
  /** バイアス重み7項目(文字列)。 */
  readonly biasWeights: Record<BiasWeightKey, string>;
  /** 基礎スコア重み6項目(文字列)。 */
  readonly baseScoreWeights: Record<BaseScoreWeightKey, string>;
  /** 自動Discord送信ON/OFF。 */
  readonly autoSendDiscord: boolean;
  /** プロンプト追加指示(Task#28)。 */
  readonly additionalInstruction: string;
  /** クリップ幅の版ID(タスクD-2: ±10%↔±15%のA/B)。 */
  readonly clipVariant: ClipVariantId;
  /** 保存操作の状態。 */
  readonly status: SettingsStatus;
  /** エラー・通知メッセージ(無ければ null)。 */
  readonly message: string | null;
  /** 「ログフォルダを開く」操作の状態(Task#36)。 */
  readonly logFolderStatus: LogFolderStatus;
  /** ログフォルダを開く操作の失敗メッセージ(無ければ null)。 */
  readonly logFolderMessage: string | null;
  /** 「最新ログをエクスポート」操作の状態(Task#36)。 */
  readonly logExportStatus: LogExportStatus;
  /**
   * ログエクスポート操作のメッセージ(無ければ null)。
   * status="saved" のときは保存先パス、status="error" のときは失敗メッセージを保持する。
   */
  readonly logExportMessage: string | null;
}

/** reducer が処理するアクション。 */
export type SettingsAction =
  | { readonly type: "読込開始" }
  | { readonly type: "読込成功"; readonly settings: MaskedSettings }
  | { readonly type: "読込失敗"; readonly message: string }
  | { readonly type: "APIキー入力"; readonly value: string }
  | { readonly type: "Webhook入力"; readonly value: string }
  | { readonly type: "EV閾値入力"; readonly value: string }
  | {
      readonly type: "バイアス重み入力";
      readonly key: BiasWeightKey;
      readonly value: string;
    }
  | {
      readonly type: "基礎重み入力";
      readonly key: BaseScoreWeightKey;
      readonly value: string;
    }
  | { readonly type: "自動送信切替"; readonly value: boolean }
  | { readonly type: "追加指示入力"; readonly value: string }
  | { readonly type: "クリップ幅版選択"; readonly value: ClipVariantId }
  | { readonly type: "保存開始" }
  | { readonly type: "保存成功"; readonly settings: MaskedSettings }
  | { readonly type: "保存失敗"; readonly message: string }
  | { readonly type: "ログフォルダを開く開始" }
  | { readonly type: "ログフォルダを開く成功" }
  | { readonly type: "ログフォルダを開く失敗"; readonly message: string }
  | { readonly type: "ログエクスポート開始" }
  | { readonly type: "ログエクスポート成功"; readonly filePath: string }
  | { readonly type: "ログエクスポートキャンセル" }
  | { readonly type: "ログエクスポート失敗"; readonly message: string };

/** 全キーを空文字で初期化したレコードを作る。 */
function emptyRecord<K extends string>(keys: readonly K[]): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of keys) {
    out[key] = "";
  }
  return out;
}

/** 数値レコードを文字列レコードへ変換する。 */
function numberRecordToStrings<K extends string>(
  keys: readonly K[],
  values: Record<K, number>,
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of keys) {
    out[key] = String(values[key]);
  }
  return out;
}

/** 文字列レコードを数値レコードへ変換する。 */
function stringRecordToNumbers<K extends string>(
  keys: readonly K[],
  values: Record<K, string>,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) {
    out[key] = Number(values[key]);
  }
  return out;
}

/** 初期状態(未読込・空)。 */
export function createInitialSettingsState(): SettingsFormState {
  return {
    loaded: false,
    apiKeyInput: "",
    apiKeyMasked: "",
    apiKeyFromEnv: false,
    discordWebhookUrl: "",
    evThreshold: "",
    biasWeights: emptyRecord(BIAS_WEIGHT_KEYS),
    baseScoreWeights: emptyRecord(BASE_SCORE_WEIGHT_KEYS),
    autoSendDiscord: false,
    additionalInstruction: "",
    clipVariant: "default",
    status: "idle",
    message: null,
    logFolderStatus: "idle",
    logFolderMessage: null,
    logExportStatus: "idle",
    logExportMessage: null,
  };
}

/** マスク済み設定をフォーム状態へ反映する(読込成功・保存成功で共通利用)。 */
function applyMasked(
  state: SettingsFormState,
  settings: MaskedSettings,
): SettingsFormState {
  return {
    ...state,
    loaded: true,
    // マスク表示のみ受け取り、入力欄には平文を置かない(常にクリア)。
    apiKeyInput: "",
    apiKeyMasked: settings.apiKeyMasked,
    apiKeyFromEnv: settings.apiKeyFromEnv,
    discordWebhookUrl: settings.discordWebhookUrl,
    evThreshold: String(settings.evThreshold),
    biasWeights: numberRecordToStrings(BIAS_WEIGHT_KEYS, settings.biasWeights),
    baseScoreWeights: numberRecordToStrings(
      BASE_SCORE_WEIGHT_KEYS,
      settings.baseScoreWeights,
    ),
    autoSendDiscord: settings.autoSendDiscord,
    additionalInstruction: settings.additionalInstruction,
    clipVariant: settings.clipVariant,
  };
}

/** 状態遷移(純関数)。 */
export function settingsReducer(
  state: SettingsFormState,
  action: SettingsAction,
): SettingsFormState {
  switch (action.type) {
    case "読込開始":
      return { ...state, status: "loading", message: null };

    case "読込成功":
      return { ...applyMasked(state, action.settings), status: "idle", message: null };

    case "読込失敗":
      return { ...state, status: "error", message: action.message };

    case "APIキー入力":
      return { ...state, apiKeyInput: action.value };

    case "Webhook入力":
      return { ...state, discordWebhookUrl: action.value };

    case "EV閾値入力":
      return { ...state, evThreshold: action.value };

    case "バイアス重み入力":
      return {
        ...state,
        biasWeights: { ...state.biasWeights, [action.key]: action.value },
      };

    case "基礎重み入力":
      return {
        ...state,
        baseScoreWeights: {
          ...state.baseScoreWeights,
          [action.key]: action.value,
        },
      };

    case "自動送信切替":
      return { ...state, autoSendDiscord: action.value };

    case "追加指示入力":
      return { ...state, additionalInstruction: action.value };

    case "クリップ幅版選択":
      return { ...state, clipVariant: action.value };

    case "保存開始":
      return { ...state, status: "saving", message: null };

    case "保存成功":
      // 保存後のマスク済み設定を反映し、入力欄をクリアする。
      return { ...applyMasked(state, action.settings), status: "saved", message: null };

    case "保存失敗":
      return { ...state, status: "error", message: action.message };

    case "ログフォルダを開く開始":
      return { ...state, logFolderStatus: "opening", logFolderMessage: null };

    case "ログフォルダを開く成功":
      return { ...state, logFolderStatus: "success", logFolderMessage: null };

    case "ログフォルダを開く失敗":
      return {
        ...state,
        logFolderStatus: "error",
        logFolderMessage: action.message,
      };

    case "ログエクスポート開始":
      return { ...state, logExportStatus: "exporting", logExportMessage: null };

    case "ログエクスポート成功":
      return {
        ...state,
        logExportStatus: "saved",
        logExportMessage: action.filePath,
      };

    case "ログエクスポートキャンセル":
      return { ...state, logExportStatus: "canceled", logExportMessage: null };

    case "ログエクスポート失敗":
      return {
        ...state,
        logExportStatus: "error",
        logExportMessage: action.message,
      };

    default: {
      // 網羅性チェック(未知のアクションはコンパイル時に検出)。
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * フォーム状態から保存用の更新ペイロードを組み立てる。
 * APIキー入力が空なら apiKey を含めない(main 側で現在値を保持させる)。
 * 数値項目は Number 化する(妥当性は isFormValid で事前確認する前提)。
 */
export function buildUpdate(state: SettingsFormState): SettingsUpdate {
  const biasWeights = stringRecordToNumbers(
    BIAS_WEIGHT_KEYS,
    state.biasWeights,
  ) as BiasWeightValues;
  const baseScoreWeights = stringRecordToNumbers(
    BASE_SCORE_WEIGHT_KEYS,
    state.baseScoreWeights,
  ) as BaseScoreWeightValues;
  const update: SettingsUpdate = {
    discordWebhookUrl: state.discordWebhookUrl,
    evThreshold: Number(state.evThreshold),
    biasWeights,
    baseScoreWeights,
    autoSendDiscord: state.autoSendDiscord,
    additionalInstruction: state.additionalInstruction,
    clipVariant: state.clipVariant,
  };
  return state.apiKeyInput !== ""
    ? { ...update, apiKey: state.apiKeyInput }
    : update;
}

/** フォーム全体が妥当か(EV閾値・全重み・Webhook URL)。 */
export function isFormValid(state: SettingsFormState): boolean {
  if (!isValidThreshold(state.evThreshold)) {
    return false;
  }
  if (!isValidWebhookUrl(state.discordWebhookUrl)) {
    return false;
  }
  for (const key of BIAS_WEIGHT_KEYS) {
    if (!isValidWeight(state.biasWeights[key])) {
      return false;
    }
  }
  for (const key of BASE_SCORE_WEIGHT_KEYS) {
    if (!isValidWeight(state.baseScoreWeights[key])) {
      return false;
    }
  }
  return true;
}
