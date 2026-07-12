/**
 * 一括分析の横断サマリ(純関数)。
 *
 * 複数レースを一括分析した結果(BatchRaceOutcome[])から、
 * - 全レース横断の「EVプラス馬サマリ」(EV降順)
 * - 成功/失敗/スキップの件数(部分失敗の集計)
 * を副作用なく導出する。表示(JSX)から集計ロジックを切り離し、単体テストで固定する。
 */

import type {
  AnalysisResult,
  EvPlusSummaryRow,
} from "../shared/analysis-types.js";

/**
 * 集計が必要とする最小構造。共有の BatchRaceOutcome と renderer の BatchRaceEntry
 * (status に "pending" を含む)の双方を受け付けられるよう、構造的な型で受ける。
 */
export interface EvSummarySource {
  /** 実行状態。"success" 以外は集計対象外。 */
  readonly status: "success" | "failure" | "skipped" | "pending";
  /** 成功時の分析結果(それ以外は null)。 */
  readonly result: AnalysisResult | null;
}

/**
 * 成功レースのEVプラス馬(isPositive かつ EV が算出済み)だけを1つに集約し、EV降順に並べる。
 * EVが同値のときはレースID昇順→馬番昇順で安定に整列する(表示のブレを防ぐ)。
 * 失敗・スキップのレースは対象に含めない。
 */
export function collectEvPlusSummary(
  outcomes: readonly EvSummarySource[],
): EvPlusSummaryRow[] {
  const rows: EvPlusSummaryRow[] = [];
  for (const outcome of outcomes) {
    if (outcome.status !== "success" || outcome.result === null) {
      continue;
    }
    const result = outcome.result;
    for (const row of result.rows) {
      // EV=null(オッズ欠損)の馬は isPositive でも金額評価できないため除外する(安全側)。
      if (!row.isPositive || row.ev === null) {
        continue;
      }
      rows.push({
        raceId: result.raceId,
        raceName: result.raceName,
        umaban: row.umaban,
        horseName: row.horseName,
        adjustedProb: row.adjustedProb,
        placeOddsMin: row.placeOddsMin,
        ev: row.ev,
      });
    }
  }
  return rows.sort((a, b) => {
    if (b.ev !== a.ev) {
      return b.ev - a.ev;
    }
    if (a.raceId !== b.raceId) {
      return a.raceId < b.raceId ? -1 : 1;
    }
    return a.umaban - b.umaban;
  });
}

/** 一括分析の件数集計(部分失敗の内訳)。 */
export interface BatchSummaryCounts {
  /** 対象レース総数。 */
  readonly total: number;
  /** 成功したレース数。 */
  readonly success: number;
  /** 失敗したレース数。 */
  readonly failure: number;
  /** 中断でスキップしたレース数。 */
  readonly skipped: number;
  /** 横断でのEVプラス馬の総数。 */
  readonly evPlusCount: number;
}

/** 成功/失敗/スキップの件数とEVプラス総数を数える。 */
export function summarizeBatch(
  outcomes: readonly EvSummarySource[],
): BatchSummaryCounts {
  let success = 0;
  let failure = 0;
  let skipped = 0;
  for (const outcome of outcomes) {
    // 実行前(pending)はどのバケットにも数えない(完了後に呼ぶ想定。安全側)。
    if (outcome.status === "success") {
      success += 1;
    } else if (outcome.status === "failure") {
      failure += 1;
    } else if (outcome.status === "skipped") {
      skipped += 1;
    }
  }
  return {
    total: outcomes.length,
    success,
    failure,
    skipped,
    evPlusCount: collectEvPlusSummary(outcomes).length,
  };
}
