/**
 * ページの HTML(Issue #161〈#21-C〉・#184〈#165-b〉)。
 *  - `renderPage`(`GET /`): スマホ画面(web の名前は「Uma Driller」。Issue #191。見出しはトップへのリンク)。描画先の `#app` と、`<script src="/app.js" defer>` だけ(**インラインスクリプトは使わない**。CSP は `script-src 'self'`)。
 *  - `renderCheckPage`(`GET /check`): 旧 `/` の確認フォーム(#162 の本番実機確認用。Issue #184 で `/` から移した。CSP は旧 `/` のまま。見出しは Issue #191 で「Uma Driller(確認ページ)」)。
 */

import { paletteCss } from "./palette";

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
<title>Uma Driller(確認ページ)</title>
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
<h1>Uma Driller(確認ページ)</h1>
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
<h2>POST の確認</h2>
<p class="note">重賞の「同レース過去10年傾向」の取得(POST)を1本だけ試し、読めた過去回の数などを JSON で返します。初期値は重賞のレースです(重賞でないレースは、過去回の数が null になります)。<strong>POST が拒否(400 など)されたら、安全のため、POST だけを 30 分間止めます(出馬表などの取得は止めません)。</strong></p>
<form method="get" action="/api/netkeiba/check">
<input type="hidden" name="type" value="grade-winner">
<label>race_id(12桁)
<input name="race_id" value="${CHECK_DEFAULT_RACE_ID}" inputmode="numeric" pattern="[0-9]{12}" maxlength="12" required>
</label>
<button type="submit">POST を試す</button>
</form>
</main>
</body>
</html>
`;
}

/**
 * スマホ画面(`GET /`)の CSP。スクリプトは同じオリジンの `/app.js` だけ・fetch は同じオリジンだけ(`default-src 'none'` では fetch も止まるため `connect-src` が要る)。
 * 画像は同じオリジンだけ(Issue #244。`default-src 'none'` では `<img>` も止まるため `img-src 'self'` が要る。`data:` は許さない)。
 */
export const APP_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** 確認ページ(`GET /check`)の CSP(旧 `/` のまま。スクリプトは無い)。 */
export const CHECK_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * スマホ画面(`GET /`)。**役割(Issue #238)は `#app` の `data-role` で画面に渡す**(インラインスクリプトは使えないので、`main.ts` が読む)。
 * admin 以外はすべて viewer として描く(型を破った呼び出しでも、管理者の印は出さない)。Issue #243 以降、「ログイン中」の行に役割の文言
 * (「閲覧専用」)は出さない(利用者の要望。ボタンが無い理由を明示しなくてよい)。**画面で隠すのは補助で、拒否はサーバ側(route-policy.ts と handler.ts)が行う**。
 */
export function renderPage(email: string, role: "admin" | "viewer"): string {
  const viewer = role !== "admin";
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Uma Driller</title>
<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
${paletteCss()}
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; line-height: 1.5; color: var(--fg); background: var(--bg); overflow-wrap: anywhere; }
  main { max-width: 40rem; margin: 0 auto; min-width: 0; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  h2 { font-size: 1.05rem; margin: 20px 0 8px; }
  /* Issue #191: 見出しのリンク(押すとトップ=一覧の画面。見出しの見た目のまま・タップしやすい高さ) */
  .home { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; color: inherit; text-decoration: none; }
  /* Issue #244: 見出しの横の画像(装飾。幅・高さを固定して、読み込み中もレイアウトを動かさない) */
  .logo { width: 32px; height: 32px; flex: none; border-radius: 6px; }
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
  /* Issue #187: 場ごとの見出し(開閉のボタン。h2 の中。文字の ▾/▸ でも開閉が分かる) */
  .venue h2 { margin: 12px 0 8px; font-size: 1.05rem; }
  .venue-toggle { display: block; width: 100%; min-height: 44px; padding: 8px 12px; text-align: left; font-size: 1.05rem; font-weight: bold; }
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
  /* Issue #185: レース画面・結果画面(色だけに頼らない。強調は文字〈EVプラス〉も付ける) */
  .controls .back { margin-right: auto; }
  .title { font-size: 1.15rem; margin: 4px 0 8px; }
  .card { margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .card h2 { display: inline-block; margin: 0 8px 0 0; }
  .card .badge { font-size: 0.85rem; }
  .card-error { margin: 6px 0 0; font-size: 0.8rem; color: var(--fail); }
  .prior, .past, .horse-list, .bets, .settings { list-style: none; margin: 8px 0 0; padding: 0; }
  .prior-row, .bet { display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: baseline; padding: 4px 0; border-top: 1px solid var(--line); }
  .past-link { display: inline-flex; align-items: center; min-height: 44px; margin-top: 8px; color: var(--accent); }
  .past li { margin: 0; }
  .past-link { margin-top: 0; }
  .meta { margin: 0 0 4px; font-size: 0.9rem; color: var(--muted); }
  .horse { display: flex; flex-direction: column; gap: 2px; margin: 0 0 8px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .horse.positive { border-color: var(--ok); border-width: 2px; }
  .horse-head { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
  .mark { font-weight: bold; }
  .horse-line { font-size: 0.9rem; }
  .horse-reason { font-size: 0.85rem; color: var(--muted); overflow-wrap: anywhere; }
  .ev-plus { margin-left: 8px; color: var(--ok); }
  /* Issue #198: 馬ごとの強調材料・懸念事項(ラベルと箇条書き。色だけに頼らない=ラベルの文字がある)と、LLM の所要時間・usage の警告 */
  .horse-points { margin-top: 4px; padding-left: 8px; border-left: 3px solid var(--line); }
  .horse-points.highlights { border-left-color: var(--ok); }
  .horse-points.concerns { border-left-color: var(--wait); }
  .points-label { display: block; font-size: 0.8rem; font-weight: bold; color: var(--muted); }
  .points-list { margin: 0; padding-left: 1.2em; font-size: 0.85rem; overflow-wrap: anywhere; }
  .notice.llm-usage-warn { margin: 4px 0; padding: 4px 12px; font-size: 0.85rem; border-color: var(--wait); color: var(--wait); }
  .settings small { color: var(--muted); }
  /* Issue #186: 起動のボタン・追跡の停止の注記(「状態を更新」)・カードの補足 */
  .run { display: block; width: 100%; margin-top: 8px; }
  .tracking { margin: 8px 0; }
  .tracking .notice { margin-bottom: 8px; }
  .card-note { margin: 6px 0 0; font-size: 0.8rem; color: var(--muted); }
  /* Issue #191: カードの説明(何をするか。1〜2行) */
  .card-desc { margin: 6px 0 0; font-size: 0.85rem; color: var(--muted); }
  /* Issue #189: 設定画面(トップの入口のリンク・入力欄。タップしやすい高さ 44px 以上。色だけに頼らない=エラーは文字と role=alert) */
  .settings-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 14px; margin-left: auto; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); text-decoration: none; background: var(--card); }
  /* Issue #219: 検証画面(一覧の入口のリンク・区分の切替・数値のタイル・内訳の行。スマホ幅で横に伸ばさない=タイルは 2 列・行は折り返す。色だけに頼らない=回収率は太字) */
  .verify-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 14px; margin-left: auto; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); text-decoration: none; background: var(--card); }
  .verify-link + .settings-link { margin-left: 0; }
  /* Issue #235: 日報画面(一覧の入口のリンク・レースごとのカード・箇条書き・生の文章。スマホ幅で横に伸ばさない=改行で折り返す) */
  .report-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); text-decoration: none; background: var(--card); }
  .report-link + .settings-link { margin-left: 0; }
  .report-run { min-height: 44px; margin: 8px 0; }
  .report-list { margin: 4px 0 8px; padding-left: 1.3em; }
  .report-summary { margin: 4px 0 8px; overflow-wrap: anywhere; }
  .report-raw { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
  .report-race { margin: 10px 0; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .report-race h3 { margin: 0 0 4px; font-size: 1rem; }
  .report-race p { margin: 2px 0; overflow-wrap: anywhere; font-size: 0.9rem; }
  .verify-venues { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
  .verify-venue { min-width: 64px; }
  .verify-venue[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: bold; }
  .verify-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 8px 0; }
  .verify-tile { display: flex; flex-direction: column; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .verify-tile.strong { border-color: var(--accent); }
  .verify-tile-label { font-size: 0.8rem; color: var(--muted); }
  .verify-tile-value { font-size: 1.1rem; }
  .verify-rows { list-style: none; margin: 4px 0 12px; padding: 0; }
  .verify-rows li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 0.9rem; }
  .verify-row-value { flex: none; font-variant-numeric: tabular-nums; }
  .verify-screen h3 { font-size: 0.95rem; margin: 16px 0 4px; }
  /* Issue #220: 補正方向・キャリブレーション・印別(ラベル+「名前 値」の項目。狭い幅では折り返す=表も横スクロールも使わない)。帯グラフは progress */
  .verify-stats { list-style: none; margin: 4px 0 12px; padding: 0; }
  .verify-stat { padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 0.9rem; }
  .verify-stat-label { font-weight: bold; }
  .verify-stat-cells { display: flex; flex-wrap: wrap; gap: 2px 14px; margin-top: 2px; }
  .verify-stat-cell { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .verify-stat-name { margin-right: 4px; color: var(--muted); font-size: 0.8rem; }
  /* Issue #220: 版別比較のカード(タイル+開閉ボタン。開閉のボタンはタップしやすい高さ 44px 以上) */
  .verify-version { margin: 12px 0; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .verify-version h3 { margin: 0 0 4px; overflow-wrap: anywhere; }
  .verify-version .meta { overflow-wrap: anywhere; }
  .verify-version-toggle { display: block; width: 100%; min-height: 44px; margin: 8px 0 0; padding: 8px 12px; text-align: left; font-weight: bold; }
  .verify-version-calibration-heading { margin: 12px 0 4px; font-size: 0.9rem; font-weight: bold; overflow-wrap: anywhere; }
  .verify-stat-bar { display: block; width: 100%; height: 8px; margin-top: 4px; }
  .field { margin: 0 0 16px; }
  .field-label { display: flex; flex-direction: column; gap: 4px; font-size: 0.95rem; font-weight: bold; }
  .field-check { display: flex; align-items: flex-start; gap: 8px; min-height: 44px; font-size: 0.95rem; font-weight: bold; }
  .field-check input { width: 24px; height: 24px; margin: 10px 0 0; flex: none; }
  .field input[type="text"], .field textarea, .field select { width: 100%; min-height: 44px; padding: 8px; font-size: 1rem; font-weight: normal; font-family: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  .field textarea { min-height: 120px; resize: vertical; }
  .field [aria-invalid="true"] { border-color: var(--fail); border-width: 2px; }
  .field-help { margin: 4px 0 0; font-size: 0.8rem; color: var(--muted); }
  .field-error { margin: 4px 0 0; font-size: 0.85rem; font-weight: bold; color: var(--fail); }
  .settings-save { display: block; width: 100%; margin: 8px 0 12px; font-weight: bold; }
  /* Issue #218: スコアリングの重みの節(入力欄は通常の項目と同じ縦並び。ボタンは幅 100%・高さ 44px 以上) */
  .weights { margin: 24px 0 16px; padding-top: 8px; border-top: 1px solid var(--line); }
  .weights h2 { margin: 8px 0 4px; font-size: 1.05rem; }
  .weights h3 { margin: 16px 0 8px; font-size: 0.95rem; }
  .weights-help { margin: 4px 0; font-size: 0.8rem; color: var(--muted); }
  .weights-reset { display: block; width: 100%; min-height: 44px; margin: 8px 0 0; font-weight: bold; }
  /* Issue #201: 設定画面のプロンプトのプレビュー(開閉の見出しは h3 の中のボタン。文面は div。改行・折り返しは CSS。内側のスクロールは付けない=スマホで操作しづらいため、ページのスクロールに任せる) */
  .preview { margin: 16px 0; }
  .preview h3 { margin: 8px 0 4px; font-size: 1rem; }
  .preview-toggle { display: block; width: 100%; min-height: 44px; padding: 8px 12px; text-align: left; font-weight: bold; }
  .preview-note { margin: 8px 0 0; font-size: 0.8rem; color: var(--muted); }
  .preview-refresh { display: block; width: 100%; min-height: 44px; margin: 12px 0 8px; font-weight: bold; }
  .prompt-preview { padding: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  /* Issue #222: 移行(設定画面の「exe から移行」の節と、移行画面。ファイル選択・開始・取り消しはタップしやすい高さ 44px 以上。進捗は progress 要素+文字〈色だけに頼らない〉。横スクロールを出さない=幅は 100% に収める) */
  .migration-section { margin: 20px 0 8px; padding-top: 8px; border-top: 1px solid var(--line); }
  .migration-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; color: var(--accent); text-decoration: none; background: var(--card); }
  .migration-file { display: block; width: 100%; max-width: 100%; min-height: 44px; padding: 8px; font-size: 1rem; font-family: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  .migration-bar { display: block; width: 100%; height: 14px; margin: 8px 0; }
  .migration-lines { margin: 8px 0; padding-left: 1.2em; font-size: 0.9rem; overflow-wrap: anywhere; }
  .migration-start, .migration-cancel { display: block; width: 100%; margin: 8px 0; font-weight: bold; }
  .notice.ok { border-color: var(--ok); color: var(--ok); }
  .notice.wait { border-color: var(--wait); color: var(--wait); }
  /* Issue #239: 色だけで状態を伝えない(カラーユニバーサルデザイン)。文字のない所には記号を添える: 失敗・警告=⚠、成功=✓、待機=…。バッジ(未実行・待ち・取得済み・完了・失敗)は文字のラベルがあるので足さない */
  .notice.error::before, .card-error::before, .notice.llm-usage-warn::before { content: "⚠ "; }
  .notice.ok::before { content: "✓ "; }
  .notice.wait::before { content: "… "; }
  /* Issue #188: 発走前のカードの中の結果(開閉の見出しは h3 の中のボタン。文字の ▾/▸ でも開閉が分かる) */
  .card-result { margin-top: 8px; }
  .card-result h3 { margin: 8px 0 4px; font-size: 1rem; }
  .result-toggle { display: block; width: 100%; min-height: 44px; padding: 8px 12px; text-align: left; font-weight: bold; }
</style>
</head>
<body>
<main>
<h1><a class="home" href="#"><img class="logo" src="/icons/header-32.png" srcset="/icons/header-64.png 2x, /icons/header-96.png 3x" width="32" height="32" alt="">Uma Driller</a></h1>
<p class="who">ログイン中: <span class="email">${escapeHtml(email)}</span></p>
<div id="app" data-role="${viewer ? "viewer" : "admin"}" aria-live="polite">読み込み中…</div>
<noscript><p>この画面には JavaScript が必要です。JavaScript を有効にしてください。</p></noscript>
</main>
<script src="/app.js" defer></script>
</body>
</html>
`;
}
