/**
 * 管理者だけの画面(設定・検証・移行)を、閲覧者が直接(`#settings` などで)開いたときの案内(Issue #238。純関数)。
 * **API は取らない**(サーバも 403 を返すが、閲覧者の画面が 403 を踏まないようにする)。固定文言だけで、入力欄・ボタンは出さない。
 */
export interface AdminOnlyModel {
  readonly kind: "admin-only";
  /** 一覧(トップ)へ戻るリンク先。 */
  readonly backHref: "#";
  readonly heading: string;
  readonly message: string;
}

export const ADMIN_ONLY_HEADING = "管理者だけが使えます";
export const ADMIN_ONLY_MESSAGE = "この画面は管理者だけが使えます。レース一覧と分析結果、日報は閲覧できます。";

export function buildAdminOnlyModel(): AdminOnlyModel {
  return { kind: "admin-only", backHref: "#", heading: ADMIN_ONLY_HEADING, message: ADMIN_ONLY_MESSAGE };
}
