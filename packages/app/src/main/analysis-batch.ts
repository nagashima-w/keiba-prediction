/**
 * 一括分析オーケストレータ(main プロセス)。
 *
 * 選択された複数レースを「直列に」分析する。並列化しない理由:
 * - netkeiba へのリクエスト間隔制御(レート制限)を守るため。
 * - LLM 呼び出しのコストを予測可能に保つため。
 *
 * 1レース分の分析本体(runAnalysis)は analyzeOne として注入する(この関数自体は
 * スタブだけでユニットテストでき、実ネットワーク・実APIのテストは書かない)。
 *
 * 部分失敗:
 * - 1レースの失敗は全体を止めない。エラーメッセージを failure アウトカムに記録して次へ進む。
 *
 * 中断(キャンセル):
 * - 各レースの「境界」で shouldCancel() を確認し、要求されていれば残りレースを skipped として
 *   即座に確定して打ち切る。実行中のレースは完走させる(レース内での即時中断はスコープ外)。
 */

import type {
  AnalysisProgress,
  AnalysisResult,
  BatchProgress,
  BatchRaceOutcome,
} from "../shared/analysis-types.js";

/** runBatchAnalysis に注入する依存。 */
export interface BatchRunnerDeps {
  /**
   * 1レースを分析する(通常は runAnalysis を束縛したもの)。
   * onStage で当該レースのレース内段階(スクレイピング等)を受け取り、全体進捗へ転送する。
   */
  readonly analyzeOne: (
    raceId: string,
    onStage: (stage: AnalysisProgress) => void,
  ) => Promise<AnalysisResult>;
  /** 中断が要求されたか。各レース境界で参照する(true なら残りをスキップ)。 */
  readonly shouldCancel: () => boolean;
  /** レースIDからレース名を引く(進捗・アウトカム表示用。無ければ null)。 */
  readonly raceNameOf?: (raceId: string) => string | null;
  /** 全体進捗の通知(省略可)。 */
  readonly onProgress?: (progress: BatchProgress) => void;
  /**
   * 1レースの分析が失敗したときの通知(省略可、Task#35 ログ基盤)。
   * ipc.ts が構造化エラーログ(raceId付き)を残すために使う。失敗アウトカムの記録には影響しない
   * (この関数が例外を投げても呼び出し元は無視し、全体処理は継続する)。
   */
  readonly onError?: (raceId: string, error: unknown) => void;
}

/** エラー値から表示用メッセージを取り出す。 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 複数レースを直列に一括分析する。
 * @param raceIds 対象レースID(入力順に処理する)
 * @param deps 注入依存(analyzeOne/shouldCancel ほか)
 * @returns レースごとの成功/失敗/スキップのアウトカム(入力順)
 */
export async function runBatchAnalysis(
  raceIds: readonly string[],
  deps: BatchRunnerDeps,
): Promise<BatchRaceOutcome[]> {
  const total = raceIds.length;
  const nameOf = (raceId: string): string | null =>
    deps.raceNameOf?.(raceId) ?? null;
  const outcomes: BatchRaceOutcome[] = [];
  let processed = 0;

  for (let i = 0; i < total; i += 1) {
    const raceId = raceIds[i]!;

    // レース境界での中断確認。要求済みなら現在レースを含む残り全部をスキップして打ち切る。
    if (deps.shouldCancel()) {
      for (let j = i; j < total; j += 1) {
        const skippedId = raceIds[j]!;
        outcomes.push({
          raceId: skippedId,
          raceName: nameOf(skippedId),
          status: "skipped",
          result: null,
          error: null,
        });
      }
      break;
    }

    const raceName = nameOf(raceId);
    // レース開始時の全体進捗(レース内段階はまだ無いので null)。
    deps.onProgress?.({
      completedRaces: processed,
      totalRaces: total,
      currentRaceId: raceId,
      currentRaceName: raceName,
      stage: null,
    });

    try {
      const result = await deps.analyzeOne(raceId, (stage) => {
        deps.onProgress?.({
          completedRaces: processed,
          totalRaces: total,
          currentRaceId: raceId,
          currentRaceName: raceName,
          stage,
        });
      });
      outcomes.push({
        raceId,
        raceName: result.raceName,
        status: "success",
        result,
        error: null,
      });
    } catch (e) {
      // ログ通知はベストエフォート: onError 自体が例外を投げても全体処理を止めない(防御的)。
      try {
        deps.onError?.(raceId, e);
      } catch {
        // 無視する(ログ記録の失敗で分析処理そのものを壊さない)。
      }
      outcomes.push({
        raceId,
        raceName,
        status: "failure",
        result: null,
        error: errorMessage(e),
      });
    }
    processed += 1;
  }

  // 全体完了の進捗(現在レースなし。completedRaces は実処理したレース数=総数−スキップ数)。
  deps.onProgress?.({
    completedRaces: processed,
    totalRaces: total,
    currentRaceId: null,
    currentRaceName: null,
    stage: null,
  });

  return outcomes;
}
