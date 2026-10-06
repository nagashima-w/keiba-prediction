/**
 * `GET /` の最小ページ(Issue #161〈#21-C〉)。ログイン中のメールアドレスを表示するだけ。スマホ幅で読める。
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 確認フォームの race_id の初期値。実在する中央の出馬表(fixture と #162 段階1の実測で HTTP 200 だったもの)。 */
export const CHECK_DEFAULT_RACE_ID = "202603020211";

export function renderPage(email: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>競馬期待値ツール(クラウド版)</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px 16px; line-height: 1.6; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; }
  .email { word-break: break-all; font-weight: bold; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  label { display: block; margin: 0.5rem 0; }
  input[name="race_id"] { font-size: 1rem; padding: 0.4rem; width: 100%; max-width: 16rem; box-sizing: border-box; }
  button { font-size: 1rem; padding: 0.5rem 1rem; }
  .note { font-size: 0.9rem; }
</style>
</head>
<body>
<main>
<h1>競馬期待値ツール(クラウド版)</h1>
<p>ログイン中のアカウント</p>
<p class="email">${escapeHtml(email)}</p>
<h2>netkeiba の取得の確認</h2>
<p class="note">レースの出馬表を1本、Cloudflare 上のソケットで取得し、読めた頭数などを JSON で返します。</p>
<form method="get" action="/api/netkeiba/check">
<label>race_id(12桁)
<input name="race_id" value="${CHECK_DEFAULT_RACE_ID}" inputmode="numeric" pattern="[0-9]{12}" maxlength="12" required>
</label>
<button type="submit">確認する</button>
</form>
<p class="note">初回は、初期値の実在するレースで確認してください。<strong>実在しない race_id は、netkeiba に拒否(400 など)されることがあります。拒否が 2 回続くと、安全のため 30 分間、すべての取得を止めます。</strong></p>
</main>
</body>
</html>
`;
}
