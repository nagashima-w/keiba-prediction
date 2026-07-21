/**
 * 期間バッチの純ロジック収集ドライバ(main プロセス、タスクB2a)。
 *
 * enumerateDates(core)で期間内の開催日を列挙し、日次で lister を呼び出してレースIDを収集する。
 * この層は「収集」までを担い、LLM分析(analyzeOne)を一切知らない
 * (依存の型 RangeCollectDeps に analyzeOne 相当のフィールドを持たせないことで、
 * 「確定前にLLM呼出が発生しない」ことを構造的に担保する)。
 *
 * dedup(既分析との突合、Task#27の promptVersion 運用に準拠):
 * - 同一raceIdに対する既存分析のpromptVersion一覧のうち、1件でも現行版と一致すれば
 *   「既に現行版で分析済み」とみなし実行対象から除外する(skippedAlreadyAnalyzedにカウント)。
 * - 別版のみ、またはpromptVersion=null(LLM完全スキップ・列追加前の旧データ)のみの場合は
 *   実行対象に含める。
 *
 * 部分失敗:
 * - 日次listerがthrowした日は failure として記録し、他日の処理は継続する(全体を止めない)。
 * - entries=[] の空日は empty として記録し、failureにはしない(区別する)。
 *
 * 中断(キャンセル):
 * - 各日の「境界」(次の日の処理に入る前)で shouldCancel() を確認し、要求されていれば
 *   残りの日を打ち切り、収集済みまでで確定する(cancelled=true)。
 *   分析フェーズの batchCancelRequested とは別概念で、この層は独自の shouldCancel 注入のみを見る。
 */

import { enumerateDates, filterJpnOnlyEntries } from "@keiba/core";
import type { KaisaiDate, RaceId, RaceListEntry } from "@keiba/core";
import type { RaceListTarget } from "../renderer/race-list-target.js";

/** 日ごとの収集結果アウトカム。 */
export type DayOutcome =
  | { readonly date: KaisaiDate; readonly status: "hasRaces"; readonly raceCount: number }
  | { readonly date: KaisaiDate; readonly status: "empty" }
  | { readonly date: KaisaiDate; readonly status: "failure"; readonly error: string };

/** collectRaceIdsOverRange に注入する依存。 */
export interface RangeCollectDeps {
  /**
   * 1日分のレース一覧を取得する(通常は listRaces/listNarRaces 相当を束縛したもの)。
   * ネットワークエラー等は例外として投げてよい(driverがfailureとして記録し継続する)。
   */
  readonly listDayRaces: (
    date: KaisaiDate,
    target: RaceListTarget,
  ) => Promise<RaceListEntry[]>;
  /**
   * 指定raceIdに対する既存分析のpromptVersion一覧を返す(dedup判定源)。
   * 未分析なら空配列。LLM完全スキップ・旧データの分析はnullを含む(AnalysisStoreのStoredAnalysis.promptVersionと同じ方針)。
   */
  readonly analyzedPromptVersionsOf: (
    raceId: RaceId,
  ) => ReadonlyArray<string | null>;
  /** 現行のプロンプト版番号(dedup判定で一貫して使う。実行中に変わらないスナップショット)。 */
  readonly currentPromptVersion: string;
  /** 日ごとの進捗通知(省略可)。 */
  readonly onProgress?: (progress: {
    readonly completedDays: number;
    readonly totalDays: number;
  }) => void;
  /** 中断が要求されたか。各日の境界で参照する(true なら残りの日を打ち切る、省略時は常にfalse扱い)。 */
  readonly shouldCancel?: () => boolean;
}

/** collectRaceIdsOverRange の戻り値。 */
export interface RangeCollectResult {
  /** 収集成功レース総数(dedup前)。failureになった日のレースは含まれない。 */
  readonly totalRaces: number;
  /** dedupにより除外(現行版で分析済み)された件数。 */
  readonly skippedAlreadyAnalyzed: number;
  /** 実行対象のレースID(dedup後、収集順)。 */
  readonly targetRaceIds: readonly RaceId[];
  /** lister が失敗(throw)した日の一覧。 */
  readonly failureDays: readonly KaisaiDate[];
  /** 日ごとのアウトカム(処理した日のみ。shouldCancelで打ち切られた残りは含まない)。 */
  readonly perDayOutcome: readonly DayOutcome[];
  /** shouldCancel により途中で打ち切られたか。 */
  readonly cancelled: boolean;
}

/** エラー値から表示用メッセージを取り出す。 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 指定raceIdが「現行版で既に分析済み」かどうかを判定する(dedupの中核判定)。
 * 同一raceIdに複数分析があっても、1件でも現行版と一致すれば true。
 */
function isAlreadyAnalyzedWithCurrentVersion(
  raceId: RaceId,
  deps: RangeCollectDeps,
): boolean {
  const versions = deps.analyzedPromptVersionsOf(raceId);
  return versions.some((v) => v === deps.currentPromptVersion);
}

/**
 * 期間(from〜to、両端含む)のレースIDを収集する(純ロジック、LLM分析は含まない)。
 *
 * @param from 期間の開始日
 * @param to 期間の終了日
 * @param target 取得対象(中央/地方(全て)/地方(Jpnのみ))
 * @param deps 注入依存(listDayRaces/analyzedPromptVersionsOf ほか)
 */
export async function collectRaceIdsOverRange(
  from: KaisaiDate,
  to: KaisaiDate,
  target: RaceListTarget,
  deps: RangeCollectDeps,
): Promise<RangeCollectResult> {
  const dates = enumerateDates(from, to);
  const totalDays = dates.length;

  let totalRaces = 0;
  let skippedAlreadyAnalyzed = 0;
  const targetRaceIds: RaceId[] = [];
  const failureDays: KaisaiDate[] = [];
  const perDayOutcome: DayOutcome[] = [];
  let cancelled = false;

  for (let i = 0; i < totalDays; i += 1) {
    const date = dates[i]!;

    // 日の境界での中断確認。要求済みなら残りの日を打ち切り、収集済みまでで確定する。
    if (deps.shouldCancel?.()) {
      cancelled = true;
      break;
    }

    try {
      const entries = await deps.listDayRaces(date, target);
      // target=nar-jpn のときのみ交流重賞(Jpn1/2/3)へ絞り込む(B1のcore純関数を再利用)。
      const filtered =
        target === "nar-jpn" ? filterJpnOnlyEntries(entries) : entries;

      if (filtered.length === 0) {
        perDayOutcome.push({ date, status: "empty" });
      } else {
        perDayOutcome.push({
          date,
          status: "hasRaces",
          raceCount: filtered.length,
        });
        for (const entryItem of filtered) {
          totalRaces += 1;
          if (isAlreadyAnalyzedWithCurrentVersion(entryItem.raceId, deps)) {
            skippedAlreadyAnalyzed += 1;
          } else {
            targetRaceIds.push(entryItem.raceId);
          }
        }
      }
    } catch (e) {
      failureDays.push(date);
      perDayOutcome.push({ date, status: "failure", error: errorMessage(e) });
    }

    deps.onProgress?.({ completedDays: i + 1, totalDays });
  }

  return {
    totalRaces,
    skippedAlreadyAnalyzed,
    targetRaceIds,
    failureDays,
    perDayOutcome,
    cancelled,
  };
}
