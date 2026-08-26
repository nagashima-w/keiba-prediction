// バレル(@keiba/core)ではなく scorer 設定のサブパスだけを narrow import する。
// バレル経由だと ev/scraper 一式(better-sqlite3 等の native 依存)を巻き込み、
// main バンドルの起動時にネイティブ解決を要求してしまうため。
import { DEFAULT_SCORER_CONFIG } from "@keiba/core/scorer/config";

// Issue #57: CoreSummary/AppInfoの宣言実体は shared/app-info-types.ts に移設した
// (shared → main の逆依存を作らないため。相対import範囲ガード〈Issue #57〉参照)。
// 後方互換のため、このファイルからも従来どおり import { AppInfo, CoreSummary } from
// "./app-info.js" で参照できるよう type export で再輸出する。
import type { AppInfo, CoreSummary } from "../shared/app-info-types.js";
export type { AppInfo, CoreSummary };

/** アプリの表示名称(固定)。 */
export const APP_NAME = "競馬期待値分析ツール";

/**
 * 現在の開発フェーズ表示。
 *
 * Phase 1〜5(scraper/scorer/LLM分析/検証/配布ビルド)は実装済み。
 * Phase 6(discord.js bot)は「未着手・やり残し」ではなく、現行の配布形態(Windows portable exe)
 * では対象外という判断であり、通知はアプリ内蔵のWebhook送信で完結している(実装済み・稼働中)。
 * 値そのものは簡潔な現況ラベルに留め、「なぜ対象外か」「いつ更新すべきか」の詳細はこのコメントに書く
 * (将来UIに表示する可能性を考慮し、値を長い説明文にしない)。
 *
 * 更新タイミング: 配布形態を変える(常駐サーバー上で discord.js bot を動かす等)場合は
 * Phase 6 を再検討し、この文字列を更新すること。
 */
export const APP_PHASE = "Phase 6(discord.js bot)のみ対象外(現行のexe配布はWebhook通知で完結)";

/**
 * アプリ情報を組み立てる純関数。
 *
 * Electron の app.getVersion() から得たバージョン文字列を受け取り、
 * core の DEFAULT_SCORER_CONFIG の一部を要約して返す。
 * バージョンが空(または空白のみ)の場合は "unknown" にフォールバックする。
 */
export function buildAppInfo(version: string): AppInfo {
  const trimmed = version.trim();
  return {
    appName: APP_NAME,
    appVersion: trimmed === "" ? "unknown" : trimmed,
    phase: APP_PHASE,
    core: {
      minSampleForBias: DEFAULT_SCORER_CONFIG.minSampleForBias,
      priorMin: DEFAULT_SCORER_CONFIG.prior.minPrior,
      priorMax: DEFAULT_SCORER_CONFIG.prior.maxPrior,
    },
  };
}
