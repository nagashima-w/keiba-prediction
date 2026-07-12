/**
 * 一括分析サマリ→Discordペイロード変換(純関数)のテスト。
 *
 * 全レース横断のEVプラス馬を embed 1件に集約する(EV降順)。該当なしは「該当なし」表記。
 * 成功/失敗/スキップの件数を注記し、長文は Discord の上限内へ切り詰める。
 */

import { describe, expect, it } from "vitest";

import { buildBatchDiscordPayload } from "../src/main/batch-discord-payload.js";
import type {
  AnalysisResult,
  AnalysisRow,
  BatchRaceOutcome,
} from "../src/shared/analysis-types.js";

const row = (over: Partial<AnalysisRow>): AnalysisRow => ({
  umaban: 1,
  wakuban: 1,
  horseName: "馬",
  prior: 0.3,
  adjustedProb: 0.3,
  placeOddsMin: 2.0,
  ev: 0.6,
  isPositive: false,
  reason: null,
  ...over,
});

const result = (
  raceId: string,
  raceName: string,
  rows: readonly AnalysisRow[],
): AnalysisResult => ({
  raceId,
  venueName: "東京",
  raceName,
  courseType: "芝",
  distance: 1600,
  date: "2026/07/12",
  dateApproximate: false,
  llmUsed: true,
  llmSkippedReason: null,
  fallback: false,
  oddsStatus: "result",
  rows,
  warnings: [],
  analyzedAt: "2026-07-12T00:00:00.000Z",
});

const success = (
  raceId: string,
  raceName: string,
  rows: readonly AnalysisRow[],
): BatchRaceOutcome => ({
  raceId,
  raceName,
  status: "success",
  result: result(raceId, raceName, rows),
  error: null,
});

describe("buildBatchDiscordPayload(一括サマリ→Discordペイロード)", () => {
  it("embeds を1件だけ持つ", () => {
    const payload = buildBatchDiscordPayload([
      success("111111111111", "1R", [row({ ev: 1.2, isPositive: true })]),
    ]);
    expect(payload.embeds).toHaveLength(1);
  });

  it("横断EVプラス馬をEV降順で列挙し、レース名・馬名を含める", () => {
    const outcomes: BatchRaceOutcome[] = [
      success("111111111111", "東京1R", [
        row({ umaban: 4, horseName: "アルファ", ev: 1.1, isPositive: true }),
      ]),
      success("222222222222", "中山2R", [
        row({ umaban: 7, horseName: "ベータ", ev: 1.6, isPositive: true }),
      ]),
    ];
    const desc = buildBatchDiscordPayload(outcomes).embeds[0]!.description ?? "";
    expect(desc).toContain("アルファ");
    expect(desc).toContain("ベータ");
    expect(desc).toContain("中山2R");
    // EV降順(ベータ EV1.6 が先)。
    expect(desc.indexOf("ベータ")).toBeLessThan(desc.indexOf("アルファ"));
  });

  it("EVプラスが1頭も無ければ該当なしを表記する", () => {
    const outcomes = [
      success("111111111111", "1R", [row({ ev: 0.5, isPositive: false })]),
    ];
    const desc = buildBatchDiscordPayload(outcomes).embeds[0]!.description ?? "";
    expect(desc).toContain("該当なし");
  });

  it("成功・失敗・スキップの件数を注記する", () => {
    const outcomes: BatchRaceOutcome[] = [
      success("111111111111", "1R", [row({ ev: 1.2, isPositive: true })]),
      { raceId: "222222222222", raceName: null, status: "failure", result: null, error: "x" },
      { raceId: "333333333333", raceName: null, status: "skipped", result: null, error: null },
    ];
    const desc = buildBatchDiscordPayload(outcomes).embeds[0]!.description ?? "";
    expect(desc).toContain("成功1");
    expect(desc).toContain("失敗1");
    expect(desc).toContain("スキップ1");
  });

  it("EVプラスが大量でも説明文はDiscordの上限(4096字)を超えない", () => {
    const rows: AnalysisRow[] = Array.from({ length: 500 }, (_, i) =>
      row({
        umaban: (i % 18) + 1,
        horseName: `ナガイウマメイ${i}番`,
        ev: 1 + i / 1000,
        isPositive: true,
      }),
    );
    const outcomes = [success("111111111111", "1R", rows)];
    const desc = buildBatchDiscordPayload(outcomes).embeds[0]!.description ?? "";
    expect([...desc].length).toBeLessThanOrEqual(4096);
  });

  it("上限で溢れる場合は無言で切らず「…他N頭省略」と省略数を明示する", () => {
    const rows: AnalysisRow[] = Array.from({ length: 500 }, (_, i) =>
      row({
        umaban: (i % 18) + 1,
        horseName: `ナガイウマメイ${i}番`,
        // EV降順で先頭が最大になるように。
        ev: 2 - i / 1000,
        isPositive: true,
      }),
    );
    const outcomes = [success("111111111111", "1R", rows)];
    const desc = buildBatchDiscordPayload(outcomes).embeds[0]!.description ?? "";

    // 省略注記があり、省略数は「掲載しきれなかった頭数」= 500 − 掲載行数 に一致する。
    const match = desc.match(/…他(\d+)頭省略/);
    expect(match).not.toBeNull();
    const omitted = Number(match![1]);
    // 実際に説明文へ現れた馬行の数(「番」を含む行)を数える。
    const shownLines = desc
      .split("\n")
      .filter((line) => /\d+番 /.test(line)).length;
    expect(omitted).toBe(500 - shownLines);
    expect(omitted).toBeGreaterThan(0);
    // 最上位(EV最大)の馬は必ず残る。
    expect(desc).toContain("1番 ナガイウマメイ0番");
    expect([...desc].length).toBeLessThanOrEqual(4096);
  });

  it("全馬が収まる場合は省略注記を付けない", () => {
    const outcomes = [
      success("111111111111", "1R", [
        row({ umaban: 3, horseName: "アルファ", ev: 1.2, isPositive: true }),
      ]),
    ];
    const desc = buildBatchDiscordPayload(outcomes).embeds[0]!.description ?? "";
    expect(desc).not.toContain("省略");
  });
});
