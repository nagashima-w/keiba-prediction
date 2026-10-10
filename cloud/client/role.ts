/**
 * 役割(Issue #238。純関数)。サーバが `GET /` の `#app` の `data-role` で渡す(インラインスクリプトは使えないので、属性で渡す)。
 *
 * **画面で隠すのは補助で、拒否はサーバ側**(`src/route-policy.ts` の表と `handler.ts`)。ここは「閲覧者に、使えない入口・ボタンを出さない」ためだけにある。
 * 不明・欠落は閲覧者に倒す(管理者の入口を出さない)。判定は完全一致の `admin` だけ。
 */
export type Role = "admin" | "viewer";

/** `data-role` の値 → 役割。`admin` の完全一致だけが管理者で、それ以外(欠落・空・大文字小文字違い・未知の値)は閲覧者。 */
export function roleFromAttribute(value: string | null | undefined): Role {
  return value === "admin" ? "admin" : "viewer";
}

/** 管理者か。型を破った値(`admin` 以外)は false。 */
export function isAdmin(role: Role): boolean {
  return role === "admin";
}
