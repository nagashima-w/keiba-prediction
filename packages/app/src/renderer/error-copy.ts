/**
 * エラーコピー用テキストの組み立て(純関数、Task#36 受け入れ条件3)。
 *
 * 「このエラーのログをコピー」ボタンでクリップボードへ書き込む文字列を組み立てる。
 * ユーザーがそのままAIへ貼り付けて原因特定を依頼できるよう、操作名・エラーメッセージ・
 * 関連コンテキスト(raceId等、renderer が持っている範囲)を1回のコピーで自己完結するテキストにする。
 * 副作用(navigator.clipboard.writeText)は CopyErrorButton.tsx 側に置き、ここでは
 * テキスト整形のみを担う(単体テストで固定するため)。
 */

/** buildErrorCopyText への入力。 */
export interface ErrorCopyInput {
  /** どの操作で発生したか(例: "検証:結果取込")。表示中のエラーの見出しと揃える。 */
  readonly operation: string;
  /** 表示中のエラーメッセージ。 */
  readonly message: string;
  /**
   * 関連コンテキスト(raceId・日付等、renderer が持っている範囲)。
   * 値が null/undefined/空文字の項目は「情報が無い」として省略する(無意味な行を作らない)。
   * オブジェクトのキー順に行として並べる。
   */
  readonly context?: Readonly<Record<string, string | null | undefined>>;
}

/**
 * コピー用テキストを組み立てる。
 * 形式(messageが単一行の場合):
 * ```
 * 操作: <operation>
 * エラー: <message>
 * <contextKey>: <contextValue>
 * ...
 * ```
 *
 * 形式(messageが複数行の場合、Task#36 code-reviewer再レビュー指摘の提案採用):
 * ```
 * 操作: <operation>
 * エラー一覧:
 * <message(そのまま複数行)>
 * <contextKey>: <contextValue>
 * ...
 * ```
 * 一括取込失敗(VerifyView.tsx)のように、呼び出し元が既に「raceId: message」形式で
 * 1行1件に整形した複数行文字列を message として渡すケースがある。「エラー: ${message}」の
 * まま連結すると1件目にだけ「エラー: 」が付き、2件目以降がプレフィックス無しで裸のまま
 * 見出しの外に並んでしまうため、複数行のときは見出し行(エラー一覧:)を独立させ、
 * 全行が見出しの下に揃うようにする。
 * この判定・整形をerror-copy.ts側(呼び出し元ではなくbuildErrorCopyText)に置くのは、
 * 「コピー用テキストの体裁を決めるのはbuildErrorCopyTextの責務」という既存設計
 * (VerifyView.tsx等の呼び出し元はメッセージ内容の組み立てのみを担い、体裁はここに一任している)
 * に沿わせるため。呼び出し元ごとに整形ロジックを重複させずに済む利点もある。
 */
export function buildErrorCopyText(input: ErrorCopyInput): string {
  const lines = input.message.includes("\n")
    ? [`操作: ${input.operation}`, "エラー一覧:", input.message]
    : [`操作: ${input.operation}`, `エラー: ${input.message}`];
  if (input.context !== undefined) {
    for (const [key, value] of Object.entries(input.context)) {
      if (value !== null && value !== undefined && value !== "") {
        lines.push(`${key}: ${value}`);
      }
    }
  }
  return lines.join("\n");
}
