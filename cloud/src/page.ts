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
</style>
</head>
<body>
<main>
<h1>競馬期待値ツール(クラウド版)</h1>
<p>ログイン中のアカウント</p>
<p class="email">${escapeHtml(email)}</p>
</main>
</body>
</html>
`;
}
