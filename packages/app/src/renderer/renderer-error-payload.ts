/**
 * renderer側のcatch節で共通利用する、ログ集約用エラーペイロード組み立ての純関数(Task#35)。
 *
 * App.tsx の複数のcatch節(一括取込・一括分析の全体失敗)で同じロジック
 * (`{ operation, message: errorMessage(e), stack: e instanceof Error ? (e.stack ?? null) : null }`)
 * が重複していたため、1箇所に集約する(code-reviewer指摘: 要修正3-a)。
 * window.keibaApi.logRendererError(main側のIPCハンドラ)へそのまま渡せる形にする。
 */

/** logRendererError へ渡すペイロードの形。 */
export interface RendererErrorPayload {
  /** どの操作で発生したか(例: "renderer:bulk-import")。 */
  readonly operation: string;
  /** 表示・ログ用のメッセージ。 */
  readonly message: string;
  /** スタックトレース(Errorインスタンスでなければ null)。 */
  readonly stack: string | null;
}

/** エラー値から表示用メッセージを取り出す(App.tsxのerrorMessageと同じロジック)。 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * catch(e: unknown) で受け取った例外から、IPC経由でmain側のログへ委譲するための
 * ペイロードを組み立てる。
 * @param operation 操作名(例: "renderer:bulk-import"、"renderer:batch-analysis")
 * @param error catchで受け取った例外(unknown)
 */
export function buildRendererErrorPayload(
  operation: string,
  error: unknown,
): RendererErrorPayload {
  return {
    operation,
    message: errorMessage(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  };
}
