/**
 * ログイン中の表示名(Issue #192)。ページの読み込み後に 1 回だけ、Cloudflare Access の `GET /cdn-cgi/access/get-identity`(同じオリジン)から
 * Google のユーザー名(`name`)を取り、「ログイン中: …」の行のメールアドレスの代わりに表示する。DOM に触れない純ロジックで、`fetch` は注入する。
 *
 * **名前は表示にだけ使う。認可には使わない**(認可はサーバの JWT の検証だけ)。
 * **取れなかったときは、メールアドレスのまま**(null を返す。これが正しい挙動):
 * 通信失敗(Access のセッション切れによるリダイレクトの CORS 失敗を含む)・200 以外・JSON でない(HTML が返った)・オブジェクトでない・`name` が文字列でない・整えた結果が空。
 * 失敗を画面に出さず、再試行もしない。`name` 以外のキーは読まない(IdP ごとに形が違い、増えもするので、`api-settings.ts` のように余計なキーを不可にはしない)。
 * Content-Type は確認しない(`FetchLike` はヘッダを返さない。HTML なら `json()` が失敗して同じ結果になる)。
 *
 * **XSS の守り**: 書き込みは `textContent`(HTML として解釈されない)だけ。加えて、表示を紛らわしくする文字(制御文字・双方向制御)を落とし、長さを切る。
 * 書き込み先の span は SSR の静的 HTML(`page.ts` の `p.who > span.email`)で、`dom.ts` の VNode の mounter の外にある(許可リストの対象外。`#app` だけが mounter の担当)。
 */
import { getJson, isRecord, type FetchLike } from "./api";

/** Access が同じオリジンで返す、ログイン中のユーザーの情報(`CF_Authorization` クッキーで認証される)。 */
export const IDENTITY_URL = "/cdn-cgi/access/get-identity";

/** 書き込み先の span(`page.ts` の `<p class="who">ログイン中: <span class="email">…</span></p>`)。`test/client-identity.test.ts` が `renderPage` の出力との対応を固定している。 */
export const WHO_NAME_SELECTOR = ".who .email";

/** 表示する名前の長さの上限(コードポイント)。超えたら、先頭 63 + 「…」。 */
export const DISPLAY_NAME_MAX = 64;

/** 長すぎる入力の処理を軽くするため、読む先頭の長さ(UTF-16 の単位)。 */
const READ_LIMIT = 1_000;

/**
 * 落とす文字: 制御文字(`Cc`。改行・タブ・C1 を含む)・行/段落の区切り(U+2028/2029)・
 * 双方向制御(U+061C・U+200E/200F・U+202A〜202E・U+2066〜2069)・幅ゼロの空白(U+200B)・BOM(U+FEFF)。
 * **U+200C/200D(ZWNJ・ZWJ)は残す**(絵文字の結合・ペルシャ語やインド系の文字の正しい表示に要る。書式文字 `Cf` を丸ごとは落とさない)。
 */
const DROP = /[\p{Cc}\u2028\u2029\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/** 孤立したサロゲート(先頭 1,000 単位で切ったときにペアが割れうる)。`\p{Cs}` はパーサによって通らないので、範囲で書く。 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** 応答の `name` を、表示してよい文字列に整える。文字列でない・整えた結果が空なら null。 */
export function sanitizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.slice(0, READ_LIMIT).replace(LONE_SURROGATE, "").replace(DROP, "").trim();
  const points = [...text];
  if (points.length > DISPLAY_NAME_MAX) {
    text = points.slice(0, DISPLAY_NAME_MAX - 1).join("").trimEnd() + "…";
  }
  return text === "" ? null : text;
}

/** `GET /cdn-cgi/access/get-identity` を 1 回呼び、表示する名前を返す。取れなければ null(メールアドレスのまま)。 */
export async function fetchDisplayName(fetchLike: FetchLike): Promise<string | null> {
  const got = await getJson(fetchLike, IDENTITY_URL);
  if (got === null || got.status !== 200 || !isRecord(got.body)) return null;
  return sanitizeDisplayName(got.body["name"]);
}

/** 書き込み先に名前を入れる(`textContent`。メールアドレスの代わりに、どこにも残さない)。name が null か、要素が無ければ何もしない。 */
export function applyDisplayName(target: { textContent: string | null } | null, name: string | null): void {
  if (target === null || name === null) return;
  target.textContent = name;
}
