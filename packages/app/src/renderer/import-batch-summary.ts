/**
 * 一括取込(Task#31)のサマリ(純関数)。
 *
 * runBulkImport の per-race アウトカム(BulkImportRaceOutcome[])から、取込/未確定スキップ/失敗/
 * 中断スキップの件数と、未確定・失敗のレースID一覧を副作用なく導出する。
 *
 * #30引き継ぎの設計メモ: 「#All_Result_Table要素はあるが着順行が0件」という構造変更由来の
 * 未確定判定と、本当に発走前・確定前の未確定は現状区別できない設計を受容している。
 * そのため一括取込のサマリでは未確定スキップの件数だけでなくレースIDも見えるようにし、
 * ユーザーが個別に状況を確認できる観測可能性を担保する(失敗レースのIDも同様の理由で持つ)。
 */

import type { BulkImportRaceOutcome } from "../shared/analysis-types.js";

/** 一括取込の件数集計(表示用)。 */
export interface BulkImportSummary {
  /** 対象レース総数。 */
  readonly total: number;
  /** 取込成功(status="imported")の件数。 */
  readonly importedCount: number;
  /** 未確定で自動スキップ(status="not_confirmed")した件数。 */
  readonly notConfirmedCount: number;
  /** 取込に失敗(status="failure")した件数。 */
  readonly failureCount: number;
  /** 中断要求によりスキップ(status="skipped")した件数。 */
  readonly skippedCount: number;
  /** 未確定で自動スキップしたレースID(発生順)。 */
  readonly notConfirmedRaceIds: readonly string[];
  /** 取込に失敗したレースID(発生順)。 */
  readonly failedRaceIds: readonly string[];
}

/** 一括取込の件数・レースID内訳を集計する。 */
export function summarizeBulkImport(
  outcomes: readonly BulkImportRaceOutcome[],
): BulkImportSummary {
  let importedCount = 0;
  let notConfirmedCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  const notConfirmedRaceIds: string[] = [];
  const failedRaceIds: string[] = [];

  for (const outcome of outcomes) {
    switch (outcome.status) {
      case "imported":
        importedCount += 1;
        break;
      case "not_confirmed":
        notConfirmedCount += 1;
        notConfirmedRaceIds.push(outcome.raceId);
        break;
      case "failure":
        failureCount += 1;
        failedRaceIds.push(outcome.raceId);
        break;
      case "skipped":
        skippedCount += 1;
        break;
    }
  }

  return {
    total: outcomes.length,
    importedCount,
    notConfirmedCount,
    failureCount,
    skippedCount,
    notConfirmedRaceIds,
    failedRaceIds,
  };
}
