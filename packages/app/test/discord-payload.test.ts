/**
 * 分析結果→Discordペイロード変換(純関数)のテスト。
 *
 * 仕様「5. ui(Discordに送信)」に対応。AnalysisResult を core の buildAnalysisEmbed へ橋渡しし、
 * embeds 1件のペイロードに包むことを検証する(実送信は行わない)。
 */

import { describe, expect, it } from "vitest";

import { buildDiscordPayload } from "../src/main/discord-payload.js";
import type { AnalysisResult } from "../src/shared/analysis-types.js";

const result: AnalysisResult = {
  raceId: "202605020811",
  venueName: "東京",
  raceName: "テストステークス",
  courseType: "芝",
  distance: 1600,
  date: "2026/07/12",
  dateApproximate: false,
  llmUsed: true,
  llmSkippedReason: null,
  fallback: false,
  rows: [
    {
      umaban: 3,
      wakuban: 2,
      horseName: "ウマA",
      prior: 0.4,
      adjustedProb: 0.421,
      placeOddsMin: 2.5,
      ev: 1.05,
      isPositive: true,
      reason: "調教良好",
    },
    {
      umaban: 1,
      wakuban: 1,
      horseName: "ウマC",
      prior: 0.5,
      adjustedProb: 0.5,
      placeOddsMin: 1.4,
      ev: 0.7,
      isPositive: false,
      reason: null,
    },
  ],
  warnings: [],
  analyzedAt: "2026-07-12T00:00:00.000Z",
};

describe("buildDiscordPayload(分析結果→Discordペイロード)", () => {
  it("embeds を1件持つペイロードを返す", () => {
    const payload = buildDiscordPayload(result);
    expect(payload.embeds).toHaveLength(1);
  });

  it("embed のタイトル・説明にレース情報とEVプラス馬を反映する", () => {
    const embed = buildDiscordPayload(result).embeds[0]!;
    expect(embed.title).toContain("東京");
    expect(embed.title).toContain("テストステークス");
    const desc = embed.description ?? "";
    expect(desc).toContain("芝1600m");
    expect(desc).toContain("ウマA");
    // EVプラスでない馬は載らない。
    expect(desc).not.toContain("ウマC");
    expect(desc).toContain("LLM補正: 実行");
  });
});
