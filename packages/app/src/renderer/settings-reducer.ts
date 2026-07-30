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
  isValidBankroll,
  isValidKellyFraction,
  isValidPerRaceCap,
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
  /** 馬券用の総資金(文字列。機能C-2)。 */
  readonly bankroll: string;
  /** 1レースの上限(文字列。機能C-2)。 */
  readonly perRaceCap: string;
  /** 馬券配分のケリー係数λ(文字列。機能C-2)。 */
  readonly kellyFraction: string;
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
  /**
   * 未保存(dirty)判定の基準となるスナップショット(Issue #11)。
   * 読込成功・保存成功のたびに applyMasked 内で更新され、フォームの現在値との差分が isDirty の判定に使われる。
   */
  readonly savedSnapshot: SettingsSnapshot;
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
  | { readonly type: "総資金入力"; readonly value: string }
  | { readonly type: "1レース上限入力"; readonly value: string }
  | { readonly type: "ケリー係数入力"; readonly value: string }
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

/**
 * 未保存(dirty)判定の基準となるスナップショット(Issue #11)。
 * applyMasked がフォームへ反映するのと同じ正規化済み文字列表現(String()/numberRecordToStrings済み)を
 * 保持する。MaskedSettings の数値をそのまま比較すると "1" vs "1.0" のような表記揺れで誤 dirty になるため、
 * 必ず applyMasked の生成結果と同じ経路を通した値をここに置く。
 * APIキーはスナップショットを持たない(apiKeyInput !== "" 自体を dirty 条件にするため、shared/settings.ts の
 * SettingsUpdate/isFormValid には一切影響しない)。
 */
export interface SettingsSnapshot {
  readonly discordWebhookUrl: string;
  readonly evThreshold: string;
  readonly biasWeights: Record<BiasWeightKey, string>;
  readonly baseScoreWeights: Record<BaseScoreWeightKey, string>;
  readonly autoSendDiscord: boolean;
  readonly additionalInstruction: string;
  readonly clipVariant: ClipVariantId;
  /** 馬券用の総資金(文字列。機能C-2)。 */
  readonly bankroll: string;
  /** 1レースの上限(文字列。機能C-2)。 */
  readonly perRaceCap: string;
  /** 馬券配分のケリー係数λ(文字列。機能C-2)。 */
  readonly kellyFraction: string;
}

/** 空文字ベースの初期スナップショットを作る。 */
function emptySnapshot(): SettingsSnapshot {
  return {
    discordWebhookUrl: "",
    evThreshold: "",
    biasWeights: emptyRecord(BIAS_WEIGHT_KEYS),
    baseScoreWeights: emptyRecord(BASE_SCORE_WEIGHT_KEYS),
    autoSendDiscord: false,
    additionalInstruction: "",
    clipVariant: "default",
    bankroll: "",
    perRaceCap: "",
    kellyFraction: "",
  };
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
    bankroll: "",
    perRaceCap: "",
    kellyFraction: "",
    status: "idle",
    message: null,
    logFolderStatus: "idle",
    logFolderMessage: null,
    logExportStatus: "idle",
    logExportMessage: null,
    savedSnapshot: emptySnapshot(),
  };
}

/**
 * マスク済み設定をフォーム状態へ反映する(読込成功・保存成功で共通利用)。
 * 反映と同時に savedSnapshot(dirty判定の基準)も同じ正規化済み文字列で更新する(Issue #11)。
 * こうすることで読込直後・保存直後は必ず isDirty=false になり、
 * スナップショット更新箇所がこの1関数に集約される。
 */
function applyMasked(
  state: SettingsFormState,
  settings: MaskedSettings,
): SettingsFormState {
  const discordWebhookUrl = settings.discordWebhookUrl;
  const evThreshold = String(settings.evThreshold);
  const biasWeights = numberRecordToStrings(
    BIAS_WEIGHT_KEYS,
    settings.biasWeights,
  );
  const baseScoreWeights = numberRecordToStrings(
    BASE_SCORE_WEIGHT_KEYS,
    settings.baseScoreWeights,
  );
  const autoSendDiscord = settings.autoSendDiscord;
  const additionalInstruction = settings.additionalInstruction;
  const clipVariant = settings.clipVariant;
  const bankroll = String(settings.bankroll);
  const perRaceCap = String(settings.perRaceCap);
  const kellyFraction = String(settings.kellyFraction);
  return {
    ...state,
    loaded: true,
    // マスク表示のみ受け取り、入力欄には平文を置かない(常にクリア)。
    apiKeyInput: "",
    apiKeyMasked: settings.apiKeyMasked,
    apiKeyFromEnv: settings.apiKeyFromEnv,
    discordWebhookUrl,
    evThreshold,
    biasWeights,
    baseScoreWeights,
    autoSendDiscord,
    additionalInstruction,
    clipVariant,
    bankroll,
    perRaceCap,
    kellyFraction,
    savedSnapshot: {
      discordWebhookUrl,
      evThreshold,
      biasWeights,
      baseScoreWeights,
      autoSendDiscord,
      additionalInstruction,
      clipVariant,
      bankroll,
      perRaceCap,
      kellyFraction,
    },
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

    case "総資金入力":
      return { ...state, bankroll: action.value };

    case "1レース上限入力":
      return { ...state, perRaceCap: action.value };

    case "ケリー係数入力":
      return { ...state, kellyFraction: action.value };

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
    bankroll: Number(state.bankroll),
    perRaceCap: Number(state.perRaceCap),
    kellyFraction: Number(state.kellyFraction),
  };
  return state.apiKeyInput !== ""
    ? { ...update, apiKey: state.apiKeyInput }
    : update;
}

/**
 * フォームに未保存の変更があるか(Issue #11「未保存(dirty)インジケータ」)。
 * savedSnapshot(最後に読込/保存した値)と現在のフォーム値を項目ごとに比較する。
 * APIキーはマスク値と比較せず、apiKeyInput が空文字でないこと自体を独立した dirty 条件とする
 * (apiKeyFromEnv=true のときは入力欄が disabled で apiKeyInput は常に空のため、dirty化しない)。
 * isFormValid とは独立(不正な入力でも dirty は成立しうる)。canSave の判定には使わない。
 */
export function isDirty(state: SettingsFormState): boolean {
  if (state.apiKeyInput !== "") {
    return true;
  }
  const snap = state.savedSnapshot;
  if (state.discordWebhookUrl !== snap.discordWebhookUrl) {
    return true;
  }
  if (state.evThreshold !== snap.evThreshold) {
    return true;
  }
  if (state.autoSendDiscord !== snap.autoSendDiscord) {
    return true;
  }
  if (state.additionalInstruction !== snap.additionalInstruction) {
    return true;
  }
  if (state.clipVariant !== snap.clipVariant) {
    return true;
  }
  if (state.bankroll !== snap.bankroll) {
    return true;
  }
  if (state.perRaceCap !== snap.perRaceCap) {
    return true;
  }
  if (state.kellyFraction !== snap.kellyFraction) {
    return true;
  }
  for (const key of BIAS_WEIGHT_KEYS) {
    if (state.biasWeights[key] !== snap.biasWeights[key]) {
      return true;
    }
  }
  for (const key of BASE_SCORE_WEIGHT_KEYS) {
    if (state.baseScoreWeights[key] !== snap.baseScoreWeights[key]) {
      return true;
    }
  }
  return false;
}

/** フォーム全体が妥当か(EV閾値・全重み・Webhook URL)。 */
export function isFormValid(state: SettingsFormState): boolean {
  if (!isValidThreshold(state.evThreshold)) {
    return false;
  }
  if (!isValidWebhookUrl(state.discordWebhookUrl)) {
    return false;
  }
  if (!isValidBankroll(state.bankroll)) {
    return false;
  }
  if (!isValidPerRaceCap(state.perRaceCap)) {
    return false;
  }
  if (!isValidKellyFraction(state.kellyFraction)) {
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
