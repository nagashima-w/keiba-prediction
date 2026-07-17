/**
 * CopyErrorButton のコピー状態遷移ロジック(純ロジック、Task#36 code-reviewer指摘の要修正2)。
 *
 * navigator.clipboard.writeText の呼び出しと setTimeout によるラベル巻き戻しを、
 * clipboard 関数・タイマー関数を注入できる形の小さなコントローラへ切り出す。
 * こうすることで React のレンダリング(@testing-library 未導入のこのリポジトリでは
 * テストしづらい)を経由せず、vitest(fake timers)で状態遷移だけを検証できる。
 *
 * 状態遷移:
 * - copy() → writeText 成功 → onCopiedChange(true) → 一定時間後に onCopiedChange(false)
 * - copy() → writeText 失敗 → 何もしない(赤エラー自体は既に画面に出ているため握りつぶす)
 * - dispose() 済みなら、保留中のタイマーやその後の Promise 解決で onCopiedChange を呼ばない
 *   (アンマウント後の setState 防止。React コンポーネント側は useEffect のクリーンアップで
 *   dispose を呼ぶ)
 */

/** コピー完了表示を元のラベルへ戻すまでの時間(ミリ秒)。 */
export const COPIED_LABEL_DURATION_MS = 2000;

/** createCopyErrorController に注入する依存。 */
export interface CopyErrorControllerDeps {
  /** クリップボードへの書き込み(通常は navigator.clipboard.writeText)。 */
  readonly writeText: (text: string) => Promise<void>;
  /** タイマー開始(通常は setTimeout)。テストでは fake timers に差し替える。 */
  readonly setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** タイマー解除(通常は clearTimeout)。 */
  readonly clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  /** コピー状態(true=コピーしました表示中)が変わったときの通知(通常は setState)。 */
  readonly onCopiedChange: (copied: boolean) => void;
}

/** createCopyErrorController が返すコントローラ。 */
export interface CopyErrorController {
  /** テキストをクリップボードへコピーし、成功時のみコピー状態を一定時間trueにする。 */
  readonly copy: (text: string) => void;
  /**
   * 破棄する(以後 onCopiedChange を呼ばない)。保留中のタイマーも解除する。
   * コンポーネントのアンマウント時(useEffect クリーンアップ)に呼ぶ想定。
   */
  readonly dispose: () => void;
}

/** コピー状態遷移の純ロジックを組み立てる。 */
export function createCopyErrorController(
  deps: CopyErrorControllerDeps,
): CopyErrorController {
  let pendingTimerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearPendingTimer(): void {
    if (pendingTimerId !== null) {
      deps.clearTimeout(pendingTimerId);
      pendingTimerId = null;
    }
  }

  function copy(text: string): void {
    deps.writeText(text).then(
      () => {
        if (disposed) return;
        // 連続クリックで保留中のタイマーが残っていれば、二重に発火させないよう解除してから積み直す。
        clearPendingTimer();
        deps.onCopiedChange(true);
        pendingTimerId = deps.setTimeout(() => {
          pendingTimerId = null;
          if (!disposed) deps.onCopiedChange(false);
        }, COPIED_LABEL_DURATION_MS);
      },
      () => {
        // クリップボードへの書き込み失敗(権限拒否等)は静かに諦める。
        // 赤エラー自体は既に画面に出ているため、コピー失敗で追加のエラー表示は行わない。
      },
    );
  }

  function dispose(): void {
    disposed = true;
    clearPendingTimer();
  }

  return { copy, dispose };
}
