/**
 * 一括結果取込オーケストレータ(main プロセス)。Task#31。
 *
 * 分析済みで結果未取込のレース(AnalysisStore.listUnimportedRaceIds、core側でNOT EXISTSにより
 * 判定済みのレースID一覧)を「直列に」取り込む。並列化しない理由は runBatchAnalysis(一括分析)と
 * 同じく netkeiba へのリクエスト間隔制御(レート制限)を守るため。
 *
 * レート制限:
 * - importRaceResult 自体も共有 HttpClient 経由でレート制限されるが、この層でも明示的に
 *   レース間へ最低1.5秒(BULK_IMPORT_RATE_LIMIT_MS)の待機を挟む。意図(取込の負荷配慮)を
 *   この層だけで独立してテスト・保証できるようにするため。
 * - 待機は sleep を関数注入することでテストからモックできる(discord.ts の sleep 注入と同じ流儀)。
 * - 1件目の前には待たない(前回発火が無いため)。2件目以降、直前の取込完了を待ってから待機する。
 *
 * 未確定(status: "not_confirmed"):
 * - importOne(通常は importRaceResult)は未確定レースを例外ではなく正常応答として返す(Task#30)。
 *   これをエラー扱いせず自動スキップとして outcomes に記録する。
 *
 * 部分失敗:
 * - 1レースの失敗(例外)は全体を止めない。エラーメッセージを failure アウトカムに記録して次へ進む。
 *
 * 中断(キャンセル):
 * - 各レースの「境界」で shouldCancel() を確認し、要求されていれば残りレースを skipped として
 *   即座に確定して打ち切る(実行中のレースは完走させる。runBatchAnalysis と同じ設計)。
 */

import type {
  BulkImportProgress,
  BulkImportRaceOutcome,
  ImportResultOutcome,
} from "../shared/analysis-types.js";

/** レース間の最低リクエスト間隔(ミリ秒)。仕様の「1.5秒レート制限」を満たす。 */
export const BULK_IMPORT_RATE_LIMIT_MS = 1500;

/** runBulkImport に注入する依存。 */
export interface BulkImportRunnerDeps {
  /** 1レースを取り込む(通常は importRaceResult を束縛したもの)。 */
  readonly importOne: (raceId: string) => Promise<ImportResultOutcome>;
  /** 中断が要求されたか。各レース境界で参照する(true なら残りをスキップ)。 */
  readonly shouldCancel: () => boolean;
  /** 全体進捗の通知(省略可)。 */
  readonly onProgress?: (progress: BulkImportProgress) => void;
  /**
   * レート制限の待機(注入。省略時は実タイマーによる待機)。
   * テストではモック(vi.fn(async () => {}))に差し替え、実時間を消費せずに検証する。
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** setTimeout ベースの既定の待機。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** エラー値から表示用メッセージを取り出す。 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 分析済みで結果未取込のレースを直列に一括取込する。
 * @param raceIds 対象レースID(入力順に処理する。通常は listUnimportedRaceIds の結果)
 * @param deps 注入依存(importOne/shouldCancel ほか)
 * @returns レースごとの取込/未確定スキップ/失敗/中断スキップのアウトカム(入力順)
 */
export async function runBulkImport(
  raceIds: readonly string[],
  deps: BulkImportRunnerDeps,
): Promise<BulkImportRaceOutcome[]> {
  const sleep = deps.sleep ?? defaultSleep;
  const total = raceIds.length;
  const outcomes: BulkImportRaceOutcome[] = [];
  let processed = 0;

  for (let i = 0; i < total; i += 1) {
    const raceId = raceIds[i]!;

    // レース境界での中断確認。要求済みなら現在レースを含む残り全部をスキップして打ち切る。
    if (deps.shouldCancel()) {
      for (let j = i; j < total; j += 1) {
        outcomes.push({ raceId: raceIds[j]!, status: "skipped", error: null });
      }
      break;
    }

    // レート制限: 2件目以降は前回のリクエストから最低 BULK_IMPORT_RATE_LIMIT_MS 空ける。
    if (i > 0) {
      await sleep(BULK_IMPORT_RATE_LIMIT_MS);
    }

    // レース開始時の全体進捗。
    deps.onProgress?.({
      completedRaces: processed,
      totalRaces: total,
      currentRaceId: raceId,
    });

    try {
      const outcome = await deps.importOne(raceId);
      outcomes.push(
        outcome.status === "imported"
          ? { raceId, status: "imported", error: null }
          : { raceId, status: "not_confirmed", error: null },
      );
    } catch (e) {
      outcomes.push({ raceId, status: "failure", error: errorMessage(e) });
    }
    processed += 1;
  }

  // 全体完了の進捗(現在レースなし。completedRaces は実処理したレース数=総数−スキップ数)。
  deps.onProgress?.({
    completedRaces: processed,
    totalRaces: total,
    currentRaceId: null,
  });

  return outcomes;
}
