/**
 * ページの HTML(Issue #161〈#21-C〉・#184〈#165-b〉)。
 *  - `renderPage`(`GET /`): スマホ画面。描画先の `#app` と、`<script src="/app.js" defer>` だけ(**インラインスクリプトは使わない**。CSP は `script-src 'self'`)。
 *  - `renderCheckPage`(`GET /check`): 旧 `/` の確認フォーム(#162 の本番実機確認用。Issue #184 で `/` から移した。内容も CSP も旧 `/` のまま)。
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

export function renderCheckPage(email: string): string {
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

/** スマホ画面(`GET /`)の CSP。スクリプトは同じオリジンの `/app.js` だけ・fetch は同じオリジンだけ(`default-src 'none'` では fetch も止まるため `connect-src` が要る)。 */
export const APP_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** 確認ページ(`GET /check`)の CSP(旧 `/` のまま。スクリプトは無い)。 */
export const CHECK_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function renderPage(email: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>競馬期待値ツール</title>
<style>
  :root { --fg: #1c1c1e; --bg: #ffffff; --muted: #6b6b70; --line: #d8d8dc; --card: #f5f5f7; --accent: #0a58ca; --ok: #146c2e; --wait: #8a5a00; --fail: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f2f2f5; --bg: #151517; --muted: #a0a0a8; --line: #3a3a3f; --card: #212125; --accent: #7cacf8; --ok: #6fcf8a; --wait: #e0b24a; --fail: #ff8a80; } }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; line-height: 1.5; color: var(--fg); background: var(--bg); overflow-wrap: anywhere; }
  main { max-width: 40rem; margin: 0 auto; min-width: 0; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  h2 { font-size: 1.05rem; margin: 20px 0 8px; }
  .who { margin: 0 0 12px; font-size: 0.85rem; color: var(--muted); }
  .email { font-weight: bold; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-bottom: 12px; }
  .date { display: flex; flex-direction: column; font-size: 0.85rem; color: var(--muted); }
  input[type="date"] { font-size: 1rem; min-height: 44px; padding: 0 8px; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  .tabs { display: flex; gap: 4px; }
  .tab { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 64px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); text-decoration: none; background: var(--card); }
  .tab[aria-current="page"] { border-color: var(--accent); color: var(--accent); font-weight: bold; }
  button { font-size: 1rem; min-height: 44px; padding: 0 16px; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); background: var(--card); }
  button[disabled] { opacity: 0.6; }
  .notice { margin: 8px 0; padding: 8px 12px; border-radius: 8px; background: var(--card); border: 1px solid var(--line); font-size: 0.9rem; }
  .notice.error { border-color: var(--fail); color: var(--fail); }
  .empty { color: var(--muted); }
  .races { list-style: none; margin: 0; padding: 0; }
  .races li { margin: 0 0 8px; }
  .race { display: block; min-height: 44px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); text-decoration: none; }
  .race-head { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
  .race-detail { display: block; font-size: 0.85rem; color: var(--muted); }
  .grade { font-size: 0.75rem; padding: 0 6px; border: 1px solid var(--line); border-radius: 4px; }
  .badges { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: 0.8rem; }
  .badge.ok { color: var(--ok); }
  .badge.wait { color: var(--wait); }
  .badge.fail { color: var(--fail); }
  .badge.none { color: var(--muted); }
  .back { display: inline-flex; align-items: center; min-height: 44px; color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>競馬期待値ツール</h1>
<p class="who">ログイン中: <span class="email">${escapeHtml(email)}</span></p>
<div id="app" aria-live="polite">読み込み中…</div>
<noscript><p>この画面には JavaScript が必要です。JavaScript を有効にしてください。</p></noscript>
</main>
<script src="/app.js" defer></script>
</body>
</html>
`;
}
