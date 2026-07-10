/**
 * 分析結果(AnalysisResult)を Discord Webhook ペイロードへ変換する純関数。
 *
 * embed の整形本体は core の buildAnalysisEmbed に委ね、ここでは AnalysisResult のフィールドを
 * core の EmbedRaceInfo へ写し替え、embeds 1件のペイロードに包むだけにする(結線の薄さを保つ)。
 * AnalysisRow は EmbedHorse と構造互換なので rows はそのまま渡す。
 */

import { buildAnalysisEmbed, type DiscordPayload } from "@keiba/core";

import type { AnalysisResult } from "../shared/analysis-types.js";

/** 分析結果から Discord 送信ペイロード(embed 1件)を組み立てる。 */
export function buildDiscordPayload(result: AnalysisResult): DiscordPayload {
  const embed = buildAnalysisEmbed(
    {
      raceName: result.raceName,
      date: result.date,
      venueName: result.venueName,
      courseType: result.courseType,
      distance: result.distance,
      llmUsed: result.llmUsed,
    },
    result.rows,
  );
  return { embeds: [embed] };
}
