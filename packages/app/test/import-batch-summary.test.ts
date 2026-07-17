/**
 * 一括取込のサマリ(純関数)のテスト。Task#31。
 *
 * boss メタレビューの観点(#30引き継ぎ): 「構造変更による行0件」と「本当の未確定」は
 * 区別できない設計を受容しているため、一括取込のサマリでは未確定スキップの件数だけでなく
 * レースIDも見えるようにし、観測可能性を担保する(失敗レースも同様)。
 */

import { describe, expect, it } from "vitest";

import type { BulkImportRaceOutcome } from "../src/shared/analysis-types.js";
import {
  formatFailedRaceErrors,
  summarizeBulkImport,
} from "../src/renderer/import-batch-summary.js";

describe("summarizeBulkImport(一括取込の件数集計)", () => {
  it("取込/未確定スキップ/失敗/中断スキップの件数を数えること", () => {
    const outcomes: BulkImportRaceOutcome[] = [
      { raceId: "R1", status: "imported", error: null },
      { raceId: "R2", status: "imported", error: null },
      { raceId: "R3", status: "not_confirmed", error: null },
      { raceId: "R4", status: "failure", error: "取得失敗" },
      { raceId: "R5", status: "skipped", error: null },
    ];
    const summary = summarizeBulkImport(outcomes);
    expect(summary.total).toBe(5);
    expect(summary.importedCount).toBe(2);
    expect(summary.notConfirmedCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
  });

  it("未確定スキップのレースIDを一覧として持つこと(観測可能性の担保)", () => {
    const outcomes: BulkImportRaceOutcome[] = [
      { raceId: "R1", status: "imported", error: null },
      { raceId: "R2", status: "not_confirmed", error: null },
      { raceId: "R3", status: "not_confirmed", error: null },
    ];
    const summary = summarizeBulkImport(outcomes);
    expect(summary.notConfirmedRaceIds).toEqual(["R2", "R3"]);
  });

  it("失敗レースのIDを一覧として持つこと(内訳表示用)", () => {
    const outcomes: BulkImportRaceOutcome[] = [
      { raceId: "R1", status: "failure", error: "エラーA" },
      { raceId: "R2", status: "imported", error: null },
      { raceId: "R3", status: "failure", error: "エラーB" },
    ];
    const summary = summarizeBulkImport(outcomes);
    expect(summary.failedRaceIds).toEqual(["R1", "R3"]);
  });

  it("空配列なら全件0・両リストとも空であること", () => {
    const summary = summarizeBulkImport([]);
    expect(summary).toEqual({
      total: 0,
      importedCount: 0,
      notConfirmedCount: 0,
      failureCount: 0,
      skippedCount: 0,
      notConfirmedRaceIds: [],
      failedRaceIds: [],
      failedRaceErrors: [],
    });
  });

  // code-reviewer指摘(Task#36 要修正1): 一括取込失敗一覧にコピー導線が無い前提が誤りだった。
  // BulkImportRaceOutcome.error に個別エラーメッセージが保持されているため、
  // raceId+エラーメッセージの一覧を組み立てられるようにする。
  it("失敗レースのraceIdとエラーメッセージの一覧(failedRaceErrors)を持つこと", () => {
    const outcomes: BulkImportRaceOutcome[] = [
      { raceId: "R1", status: "failure", error: "エラーA" },
      { raceId: "R2", status: "imported", error: null },
      { raceId: "R3", status: "failure", error: "エラーB" },
    ];
    const summary = summarizeBulkImport(outcomes);
    expect(summary.failedRaceErrors).toEqual([
      { raceId: "R1", message: "エラーA" },
      { raceId: "R3", message: "エラーB" },
    ]);
  });

  it("失敗レースのエラーメッセージがnullの場合はフォールバック文言を使うこと", () => {
    const outcomes: BulkImportRaceOutcome[] = [
      { raceId: "R1", status: "failure", error: null },
    ];
    const summary = summarizeBulkImport(outcomes);
    expect(summary.failedRaceErrors).toEqual([
      { raceId: "R1", message: "(エラーメッセージなし)" },
    ]);
  });
});

describe("formatFailedRaceErrors(失敗レース一覧のコピー用テキスト整形)", () => {
  it("raceIdとエラーメッセージを1行ずつ「raceId: message」形式で並べること", () => {
    const text = formatFailedRaceErrors([
      { raceId: "R1", message: "エラーA" },
      { raceId: "R3", message: "エラーB" },
    ]);
    expect(text).toBe("R1: エラーA\nR3: エラーB");
  });

  it("空配列なら空文字列を返すこと", () => {
    expect(formatFailedRaceErrors([])).toBe("");
  });
});
