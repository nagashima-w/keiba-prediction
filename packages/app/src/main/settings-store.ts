/**
 * 設定の永続化(main プロセス)。
 *
 * 純ロジック(バリデーション付きデフォルトマージ・マスク・更新適用・core設定の組み立て)と、
 * 薄いIO層(JSONファイルの読み書き)を分離し、純関数側を単体テストで固定する。
 *
 * APIキーの扱い(設計判断):
 * - 保存は平文JSON。個人利用専用ツールの割り切りであり、設定画面にその旨を注記する。
 *   将来改善として Electron safeStorage による暗号化を検討する(本コメントに記録)。
 * - レンダラーへは maskSettings で必ずマスクしてから返し、平文キーは main の外へ出さない。
 * - 環境変数 ANTHROPIC_API_KEY が設定済みなら、実効キー・マスク表示ともに環境変数を優先する。
 *
 * core への依存は scorer 設定サブパス(@keiba/core/scorer/config)の narrow import のみ。
 * バレル(ev/scraper の native 依存)は取り込まない(EvConfig は型のみ import で消える)。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_SCORER_CONFIG,
  type ScorerConfig,
} from "@keiba/core/scorer/config";
import type { EvConfig } from "@keiba/core";

import {
  BASE_SCORE_WEIGHT_KEYS,
  BIAS_WEIGHT_KEYS,
  CLIP_VARIANT_IDS,
  type AppSettings,
  type BaseScoreWeightValues,
  type BiasWeightValues,
  type ClipVariantId,
  type MaskedSettings,
  type SettingsUpdate,
} from "../shared/settings.js";

/**
 * 既定設定。EV閾値は仕様の既定1.0、重みは core の DEFAULT_SCORER_CONFIG を出典とする。
 * (EvConfig の既定閾値もコアでは1.0。バレル import を避けるため数値を直接置く。)
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  apiKey: "",
  discordWebhookUrl: "",
  evThreshold: 1.0,
  biasWeights: { ...DEFAULT_SCORER_CONFIG.weights },
  baseScoreWeights: { ...DEFAULT_SCORER_CONFIG.baseScore.weights },
  autoSendDiscord: false,
  additionalInstruction: "",
  // クリップ幅版(タスクD-2)。既定は対照(±10%)。
  clipVariant: "default",
};

/** raw が number かつ有限かつ述語を満たせば採用、さもなくば fallback。 */
function coerceNumber(
  raw: unknown,
  fallback: number,
  predicate: (n: number) => boolean,
): number {
  return typeof raw === "number" && Number.isFinite(raw) && predicate(raw)
    ? raw
    : fallback;
}

/**
 * クリップ幅版ID(タスクD-2)を検証する。CLIP_VARIANT_IDS に含まれる文字列のみ採用し、
 * 未知の文字列・型違い・欠損はデフォルト(対照="default")へフォールバックする
 * (受け入れ条件「不正値/未設定フォールバック」)。
 */
function coerceClipVariant(raw: unknown): ClipVariantId {
  return typeof raw === "string" &&
    (CLIP_VARIANT_IDS as readonly string[]).includes(raw)
    ? (raw as ClipVariantId)
    : DEFAULT_APP_SETTINGS.clipVariant;
}

/** raw(unknown)を安全にプロパティ参照するためのレコード化。 */
function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)
    : {};
}

/** バイアス重みを 0以上でマージ(欠損・不正はデフォルト)。 */
function coerceBiasWeights(raw: unknown): BiasWeightValues {
  const rec = asRecord(raw);
  const out = {} as Record<(typeof BIAS_WEIGHT_KEYS)[number], number>;
  for (const key of BIAS_WEIGHT_KEYS) {
    out[key] = coerceNumber(
      rec[key],
      DEFAULT_APP_SETTINGS.biasWeights[key],
      (n) => n >= 0,
    );
  }
  return out;
}

/** 基礎スコア重みを 0以上でマージ(欠損・不正はデフォルト)。 */
function coerceBaseScoreWeights(raw: unknown): BaseScoreWeightValues {
  const rec = asRecord(raw);
  const out = {} as Record<(typeof BASE_SCORE_WEIGHT_KEYS)[number], number>;
  for (const key of BASE_SCORE_WEIGHT_KEYS) {
    out[key] = coerceNumber(
      rec[key],
      DEFAULT_APP_SETTINGS.baseScoreWeights[key],
      (n) => n >= 0,
    );
  }
  return out;
}

/**
 * 任意の入力(JSONパース結果など)を検証しつつデフォルトへマージして AppSettings を得る純関数。
 * 不正値・欠損は既定へフォールバックする(部分的な破損でも安全に起動できる)。
 */
export function coerceSettings(raw: unknown): AppSettings {
  const rec = asRecord(raw);
  return {
    apiKey: typeof rec.apiKey === "string" ? rec.apiKey : DEFAULT_APP_SETTINGS.apiKey,
    // 記録: discordWebhookUrl は現状「文字列であること」のみを検証する。URL形式の main 側検証は
    // 実際に送信する Phase 5(Discord Webhook 通知)で、送信可否判定と合わせて実装する。
    // フォーム段階の URL 形式チェックは renderer(shared/settings の isValidWebhookUrl)で行っている。
    discordWebhookUrl:
      typeof rec.discordWebhookUrl === "string"
        ? rec.discordWebhookUrl
        : DEFAULT_APP_SETTINGS.discordWebhookUrl,
    evThreshold: coerceNumber(
      rec.evThreshold,
      DEFAULT_APP_SETTINGS.evThreshold,
      (n) => n > 0,
    ),
    biasWeights: coerceBiasWeights(rec.biasWeights),
    baseScoreWeights: coerceBaseScoreWeights(rec.baseScoreWeights),
    autoSendDiscord:
      typeof rec.autoSendDiscord === "boolean"
        ? rec.autoSendDiscord
        : DEFAULT_APP_SETTINGS.autoSendDiscord,
    // プロンプト追加指示(Task#28)。文字列であればそのまま採用し、型違い・欠損はデフォルト(空文字)。
    additionalInstruction:
      typeof rec.additionalInstruction === "string"
        ? rec.additionalInstruction
        : DEFAULT_APP_SETTINGS.additionalInstruction,
    // クリップ幅版(タスクD-2)。CLIP_VARIANT_IDS に無い値・欠損はdefaultへフォールバック。
    clipVariant: coerceClipVariant(rec.clipVariant),
  };
}

/** 文字列が空白のみでない実効値を持つか。 */
function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * APIキーをマスクする。先頭数文字のみ残し、残りを "***" で伏せる(平文を返さない)。
 * 空文字は空文字のまま。
 */
export function maskApiKey(key: string): string {
  if (key === "") {
    return "";
  }
  // 先頭最大8文字("sk-ant-a" 相当)を残す。短いキーはそのぶんだけ残す。
  return `${key.slice(0, 8)}***`;
}

/**
 * 実効APIキーを解決する。環境変数(空白でない)があればそれを優先、無ければ保存キー。
 * @param settings 保存済み設定
 * @param envApiKey 環境変数 ANTHROPIC_API_KEY の値
 */
export function resolveEffectiveApiKey(
  settings: AppSettings,
  envApiKey: string | undefined,
): string {
  return isNonEmpty(envApiKey) ? envApiKey : settings.apiKey;
}

/**
 * レンダラー向けにマスク済み設定を組み立てる純関数。
 * 環境変数優先(fromEnv)を反映し、マスク対象は実効キー(環境変数 or 保存キー)。
 *
 * discordWebhookUrl は APIキーと違い平文でレンダラーへ返す(意図的な設計判断)。
 * 設定画面で編集フィールドとして表示する必要があり、かつ機微度が APIキーより低い
 * (漏えい時の影響は「当該チャンネルへの投稿」に限られ、Discord 側で容易に再発行・無効化できる)ため、
 * マスクせず往復させる。APIキーのみ maskApiKey でマスクし、main の外に平文を出さない。
 */
export function maskSettings(
  settings: AppSettings,
  envApiKey: string | undefined,
): MaskedSettings {
  const fromEnv = isNonEmpty(envApiKey);
  const effectiveKey = fromEnv ? envApiKey : settings.apiKey;
  return {
    apiKeyMasked: maskApiKey(effectiveKey),
    apiKeyFromEnv: fromEnv,
    discordWebhookUrl: settings.discordWebhookUrl,
    evThreshold: settings.evThreshold,
    biasWeights: settings.biasWeights,
    baseScoreWeights: settings.baseScoreWeights,
    autoSendDiscord: settings.autoSendDiscord,
    // プロンプト追加指示はDiscord URLと同様、平文のまま返す(編集フォーム表示のため)。
    additionalInstruction: settings.additionalInstruction,
    // クリップ幅版(タスクD-2)も往復編集フォームとして表示するため平文のまま返す。
    clipVariant: settings.clipVariant,
  };
}

/**
 * 現在設定に更新を適用する純関数。apiKey は「文字列のときだけ」差し替え、それ以外は現在値を保持する。
 * 最後に coerceSettings で正規化し、不正値をフォールバックする(サーバ側の防御)。
 */
export function applyUpdate(
  current: AppSettings,
  update: SettingsUpdate,
): AppSettings {
  return coerceSettings({
    // apiKey は文字列のときだけ差し替える。undefined/null など非文字列(IPC 由来の不正入力を含む)は
    // 現在値を保持し、null 送信で保存済みキーが消える事故を防ぐ。
    apiKey: typeof update.apiKey === "string" ? update.apiKey : current.apiKey,
    discordWebhookUrl: update.discordWebhookUrl,
    evThreshold: update.evThreshold,
    biasWeights: update.biasWeights,
    baseScoreWeights: update.baseScoreWeights,
    autoSendDiscord: update.autoSendDiscord,
    additionalInstruction: update.additionalInstruction,
    clipVariant: update.clipVariant,
  });
}

/**
 * 設定から ScorerConfig を組み立てる(DEFAULT_SCORER_CONFIG へのディープマージ)。
 * 重み2グループ(バイアス・基礎)のみ上書きし、他の既定項目(prior・minSampleForBias 等)は保持する。
 */
export function buildScorerConfig(settings: AppSettings): ScorerConfig {
  return {
    ...DEFAULT_SCORER_CONFIG,
    weights: { ...settings.biasWeights },
    baseScore: {
      ...DEFAULT_SCORER_CONFIG.baseScore,
      weights: { ...settings.baseScoreWeights },
    },
  };
}

/** 設定から EvConfig(閾値)を組み立てる。 */
export function buildEvConfig(settings: AppSettings): EvConfig {
  return { threshold: settings.evThreshold };
}

/**
 * 設定JSONの読み書きを担う薄いIO層。
 * 読み込みは coerceSettings で正規化し、ファイル欠損・破損時はデフォルトへフォールバックする。
 */
export class SettingsStore {
  private readonly filePath: string;

  /** @param filePath settings.json の絶対パス(通常は userData 配下)。 */
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** 設定を読み込む。存在しない・壊れている場合はデフォルトを返す。 */
  load(): AppSettings {
    try {
      const text = readFileSync(this.filePath, "utf8");
      return coerceSettings(JSON.parse(text));
    } catch {
      return DEFAULT_APP_SETTINGS;
    }
  }

  /** 設定を平文JSONで保存する(親ディレクトリが無ければ作成)。 */
  save(settings: AppSettings): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(settings, null, 2), "utf8");
  }
}
