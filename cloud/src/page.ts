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
  /* Issue #544: 40rem → 50rem。トップの上の並び(開催日・中央/地方・更新・狙い目・検証・日報・月報・設定)の必要幅は実測で約 740px(46.25rem)で、40rem だと「設定」が 2 段目に落ちた。狭い画面は従来どおり折り返す */
  main { max-width: 50rem; margin: 0 auto; min-width: 0; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  h2 { font-size: 1.05rem; margin: 20px 0 8px; }
  /* Issue #191: 見出しのリンク(押すとトップ=一覧の画面。見出しの見た目のまま・タップしやすい高さ) */
  .home { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; color: inherit; text-decoration: none; }
  /* Issue #244: 見出しの横の画像(装飾。幅・高さを固定して、読み込み中もレイアウトを動かさない) */
  .logo { width: 32px; height: 32px; flex: none; border-radius: 6px; }
  .who { margin: 0 0 12px; font-size: 0.85rem; color: var(--muted); }
  .email { font-weight: bold; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-bottom: 12px; }
  /* Issue #560: トップの上の並びを役割で 2 つに分ける。左が一覧の絞り込み(開催日・中央/地方・更新)、右が画面の移動(狙い目・検証・日報・月報・設定)。右寄せは塊が受け持つ(リンクごとの margin-left: auto は持たない)。
     狭い画面(折り返す幅)では、画面の移動が幅いっぱいの専用の段になり、上に区切り線が入って、リンクが等幅に並ぶ(広い画面の見た目は従来どおり)。境目 48.25rem は、広い画面で 1 段に収まる幅(#544)の少し下 */
  .list-filters, .list-nav { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
  .list-nav { margin-left: auto; }
  @media (max-width: 48.25rem) {
    .list-nav { flex: 1 1 100%; margin-left: 0; padding-top: 8px; border-top: 1px solid var(--line); }
    .list-nav a { flex: 1 1 0; min-width: 0; padding: 0 4px; white-space: nowrap; }
  }
  .date { display: flex; flex-direction: column; font-size: 0.85rem; color: var(--muted); }
  input[type="date"] { font-size: 1rem; min-height: 44px; padding: 0 8px; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  .tabs { display: flex; gap: 4px; }
  .tab, .report-tab { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 64px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); text-decoration: none; background: var(--card); }
  .tab[aria-current="page"], .report-tab[aria-current="page"] { border-color: var(--accent); color: var(--accent); font-weight: bold; }
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
  /* Issue #251: 場ごとの一括実行(管理者だけ。場を開いたときの上部。ボタンは横に並べ、狭い幅では折り返す。確認画面は枠で囲む) */
  .bulk { margin: 0 0 12px; }
  .bulk-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
  .bulk-run { flex: 1 1 12rem; }
  .bulk-note { margin: 4px 0 0; }
  .bulk-panel { margin: 8px 0 0; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .bulk-panel h3 { margin: 0 0 4px; font-size: 1rem; }
  .bulk-lines { margin: 4px 0; padding-left: 1.2em; font-size: 0.9rem; }
  .bulk-notes { list-style: none; margin: 4px 0; padding: 0; }
  .bulk-notes .notice { margin: 4px 0; }
  .bulk-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .bulk-go { border-color: var(--accent); color: var(--accent); font-weight: bold; }
  .bulk-result p { margin: 0 0 8px; }
  .race { display: block; min-height: 44px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); text-decoration: none; }
  /* Issue #559: 一覧の先頭の「次に発走するレース」。見出しは p、行は div.next-race(h2・li・a.race は使わない)。ボタンはリンクの外 */
  .next-races { margin: 0 0 12px; }
  .next-head { margin: 8px 0 4px; }
  .next-race { margin: 0 0 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .next-link { display: block; color: var(--fg); text-decoration: none; }
  .race-head { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
  .race-detail { display: block; font-size: 0.85rem; color: var(--muted); }
  .race-result { font-weight: 600; color: inherit; }
  .result-pending, .result-pending_payout, .result-none, .result-excluded, .result-no_proposal { font-weight: normal; color: var(--muted); }
  .grade { font-size: 0.75rem; padding: 0 6px; border: 1px solid var(--line); border-radius: 4px; }
  .badges { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 6px; font-size: 0.8rem; }
  .badge.ok { color: var(--ok); }
  .badge.wait { color: var(--wait); }
  .badge.fail { color: var(--fail); }
  .badge.none { color: var(--muted); }
  /* Issue #558: 一覧のバッジ(ピル)。ok・wait・fail は tone 色の塗りに --bg の文字、未実行は --line の枠線に --muted の文字(新しい色は足さない=文字と背景の組は palette.test で 4.5 以上の組)。文字(「事前: 完了」)は残す。タスクカードの .badge は変えない(.badges の中だけ) */
  .badges .badge { display: inline-block; padding: 0 8px; border: 1px solid transparent; border-radius: 999px; font-weight: 600; line-height: 1.6; }
  .badges .badge.ok { background: var(--ok); border-color: var(--ok); color: var(--bg); }
  .badges .badge.wait { background: var(--wait); border-color: var(--wait); color: var(--bg); }
  .badges .badge.fail { background: var(--fail); border-color: var(--fail); color: var(--bg); }
  .badges .badge.none { background: transparent; border-color: var(--line); color: var(--muted); }
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
  /* Issue #344: 締切直前の再計算(回ごとの塊。見出しの段落は strong) */
  .close-round { margin: 12px 0 0; }
  .close-round-title { margin: 0 0 4px; }
  .horse { display: flex; flex-direction: column; gap: 2px; margin: 0 0 8px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .horse.positive { border-color: var(--ok); border-width: 2px; }
  .horse-head { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
  .mark { font-weight: bold; }
  /* Issue #317: 印を補修した馬の目印(「直」と元の印→今の印)。色だけに頼らない=文字がある */
  .mark-fixed { font-size: 0.75rem; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; white-space: nowrap; }
  .horse-line { font-size: 0.9rem; }
  .horse-reason { font-size: 0.85rem; color: var(--muted); overflow-wrap: anywhere; }
  .ev-plus { margin-left: 8px; color: var(--ok); }
  .odds-higher { margin-left: 8px; }
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
  .race-guide { margin: 8px 0 0; font-size: 0.85rem; color: var(--muted); }
  /* Issue #189: 設定画面(トップの入口のリンク・入力欄。タップしやすい高さ 44px 以上。色だけに頼らない=エラーは文字と role=alert) */
  .settings-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); text-decoration: none; background: var(--card); }
  /* Issue #219: 検証画面(一覧の入口のリンク・区分の切替・数値のタイル・内訳の行。スマホ幅で横に伸ばさない=タイルは 2 列・行は折り返す。色だけに頼らない=回収率は太字) */
  .verify-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); text-decoration: none; background: var(--card); }
  /* Issue #336: 今日の狙い目(一覧の入口のリンクは検証の左。行は一覧のレースの行〈.race〉を流用し、残り時間を右端に寄せる。見送りと発走済みは薄く、10 分以内は色+太字で強調する) */
  .targets-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); text-decoration: none; background: var(--card); }
  .race.skipped { opacity: 0.65; }
  /* Issue #558: 発走済みは、バッジの入れ物(.badges)以外の子を薄くする(行ごと薄くすると、バッジの文字のコントラストが 4.5 を割る)。狙い目の発走済みの行にも同じ規則(バッジは無い)。
     見送り(.skipped)の行は上の規則で行全体が薄いので外す(狙い目の行は skipped と started の両方が付きうる。外さないと 0.65 × 0.65 の二重がけになる) */
  .race.started:not(.skipped) > :not(.badges) { opacity: 0.65; }
  .t-left { margin-left: auto; font-weight: bold; white-space: nowrap; }
  .t-left.soon { color: var(--wait); }
  /* Issue #235: 日報画面(一覧の入口のリンク・レースごとのカード・箇条書き・生の文章。スマホ幅で横に伸ばさない=改行で折り返す) */
  .report-link, .monthly-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); text-decoration: none; background: var(--card); }
  .report-run { min-height: 44px; margin: 8px 0; }
  .report-list { margin: 4px 0 8px; padding-left: 1.3em; }
  .report-summary { margin: 4px 0 8px; overflow-wrap: anywhere; }
  .report-raw { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
  .report-race { margin: 10px 0; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .report-race h3 { margin: 0 0 4px; font-size: 1rem; }
  /* Issue #279: 月報(日報の画面の中の「月」)。月の見出し・注記・日ごと/版ごとの行(値が長いので、ラベルの下に折り返す。日付のリンクはタップしやすい高さ 44px 以上) */
  .report-month { margin: 8px 0 4px; font-size: 1.1rem; }
  .report-tabs { flex-wrap: wrap; margin: 4px 0 8px; }
  .report-note, .report-version-note { overflow-wrap: anywhere; }
  .report-days { list-style: none; margin: 4px 0 12px; padding: 0; }
  .report-days li { padding: 4px 0; border-bottom: 1px solid var(--line); font-size: 0.9rem; }
  .report-day-link { display: flex; align-items: center; min-height: 44px; font-weight: bold; color: var(--accent); }
  .report-row-label { display: block; font-weight: bold; padding: 4px 0; }
  .report-row-value { display: block; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .report-race p { margin: 2px 0; overflow-wrap: anywhere; font-size: 0.9rem; }
  .verify-venues { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
  .verify-venue { min-width: 64px; }
  .verify-venue[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: bold; }
  /* Issue #254: 対応表の対象の切替(補正後〈AI〉/補正前〈統計〉)。区分の切替と同じ見た目(押されている側を太字+枠色で示す=色だけに頼らない) */
  .verify-targets { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
  .verify-target { min-width: 64px; }
  .verify-target[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: bold; }
  .verify-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 8px 0; }
  .verify-tile { display: flex; flex-direction: column; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .verify-tile.strong { border-color: var(--accent); }
  .verify-tile-label { font-size: 0.8rem; color: var(--muted); }
  .verify-tile-value { font-size: 1.1rem; }
  .verify-rows { list-style: none; margin: 4px 0 12px; padding: 0; }
  /* Issue #369: 値が長い行(日報・月報の「もしも」。『判定できた 36 レース中 …(対象外 18 レース)』)は、値を次の行へ回し、値の中でも折り返す(ラベルは潰さない)。
     1 行に収まる行は、ラベルが左・値の箱が右(margin-left: auto。text-align は付けない = 折り返した値の中は左揃えで、行頭がそろう)。
     ラベルは行の幅から 5em を引いた幅まで(長いラベルの行で、短い値〈N 件〉が次の行へ回らない = 検証画面の既存の行の見た目を変えない)。 */
  .verify-rows li { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; column-gap: 12px; row-gap: 2px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 0.9rem; }
  .verify-row-label { flex: 0 1 auto; max-width: calc(100% - 5em); overflow-wrap: anywhere; }
  .verify-row-value { flex: 0 1 auto; min-width: 0; margin-left: auto; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
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
  .verify-versions-link { display: block; margin: 8px 0; padding: 10px 0; }
  .verify-version-toggle { display: block; width: 100%; min-height: 44px; margin: 8px 0 0; padding: 8px 12px; text-align: left; font-weight: bold; }
  .verify-version-calibration-heading { margin: 12px 0 4px; font-size: 0.9rem; font-weight: bold; overflow-wrap: anywhere; }
  .verify-version-table-label { margin: 12px 0 4px; font-weight: bold; }
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
  .notice.ok { border-color: var(--ok); color: var(--ok); }
  .notice.wait { border-color: var(--wait); color: var(--wait); }
  /* Issue #239: 色だけで状態を伝えない(カラーユニバーサルデザイン)。文字のない所には記号を添える: 失敗・警告=⚠、成功=✓、待機=…。バッジ(未実行・待ち・取得済み・完了・失敗)は文字のラベルがあるので足さない */
  .notice.error::before, .card-error::before, .notice.llm-usage-warn::before { content: "⚠ "; }
  .notice.ok::before { content: "✓ "; }
  .notice.wait::before { content: "… "; }
  /* Issue #188: 発走前のカードの中の結果(開閉の見出しは h3 の中のボタン。文字の ▾/▸ でも開閉が分かる) */
  .card-result { margin-top: 8px; }
  .card-result h3 { margin: 8px 0 4px; font-size: 1rem; }
  /* Issue #362: 想定隊列図(旧レース再生〈#311〉の置き換え)。位置は VNode に style 属性を持てないため、data-slot + grid-column で決める(列の本数 10 は client/formation-model.ts の FORMATION_SLOTS)。
     チップは円形で幅は列に合わせる(上限 28px)。同じ列の馬は縦に積む。◎は accent の太枠(色だけに頼らず、凡例の「◎」でも示す)。 */
  .formation-phase { margin: 8px 0; }
  .formation-phase-title { margin: 0 0 2px; }
  .formation-axis { display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--muted); }
  .formation-track { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); grid-auto-flow: row dense; gap: 3px; align-items: start; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .formation-chip { box-sizing: border-box; justify-self: center; display: flex; align-items: center; justify-content: center; width: 100%; max-width: 28px; aspect-ratio: 1; border: 1px solid var(--fg); border-radius: 50%; background: var(--card); color: var(--fg); font-size: 0.75rem; line-height: 1; }
  .formation-chip.formation-main { border: 3px solid var(--accent); font-weight: bold; }
  .formation-chip[data-slot="0"] { grid-column: 1; }
  .formation-chip[data-slot="1"] { grid-column: 2; }
  .formation-chip[data-slot="2"] { grid-column: 3; }
  .formation-chip[data-slot="3"] { grid-column: 4; }
  .formation-chip[data-slot="4"] { grid-column: 5; }
  .formation-chip[data-slot="5"] { grid-column: 6; }
  .formation-chip[data-slot="6"] { grid-column: 7; }
  .formation-chip[data-slot="7"] { grid-column: 8; }
  .formation-chip[data-slot="8"] { grid-column: 9; }
  .formation-chip[data-slot="9"] { grid-column: 10; }
  .formation-legend { list-style: none; margin: 8px 0 0; padding: 0; columns: 2; font-size: 0.85rem; }
  .formation-legend li { break-inside: avoid; }
  .formation-legend li.formation-main { font-weight: bold; }
  .result-toggle { display: block; width: 100%; min-height: 44px; padding: 8px 12px; text-align: left; font-weight: bold; }
  /* Issue #546: 結果の先頭の要約(印・買い目と合計・発走時刻・分析時刻・締切直前の再計算の 1 行)と、説明文の開閉のボタン(「仕組みを見る」。タップしやすい高さ 44px 以上。開閉は ▾/▸ の文字でも示す) */
  .summary { margin: 0 0 12px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .summary h2, .summary h3 { margin: 0 0 4px; font-size: 1rem; }
  .summary-marks { display: flex; flex-wrap: wrap; gap: 2px 14px; list-style: none; margin: 4px 0 0; padding: 0; }
  .summary-marked-mark { font-weight: bold; }
  .summary-bet-line { margin: 6px 0 0; font-weight: bold; }
  .summary-bets { list-style: none; margin: 4px 0 0; padding: 0; }
  .summary-bet { display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: baseline; padding: 4px 0; border-top: 1px solid var(--line); }
  .summary .meta { margin: 4px 0 0; }
  .notes-toggle { display: block; width: 100%; min-height: 44px; margin: 4px 0; padding: 8px 12px; text-align: left; }
  /* 馬ごとの評価の表(Issue #546-2)。枠が横にスクロールし、ページ全体は横にはみ出さない。列見出しのボタンは見た目を抑え、タップの高さは 44px を保つ。 */
  .horse-table-wrap { overflow-x: auto; max-width: 100%; margin: 8px 0; border: 1px solid var(--line); border-radius: 8px; }
  .horse-table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  .horse-table th, .horse-table td { padding: 6px 4px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
  /* 馬名の列だけは折り返す(最大幅つき)。375px の幅でも、開いてすぐ 3着内率・AI補正後・EV が枠の中に収まるようにするため(実測は Issue #546-2 のコミットメッセージ)。数字の列は nowrap のまま(「1.40(推定)」を割らない)。 */
  .horse-table th:nth-child(3), .horse-table td:nth-child(3) { text-align: left; }
  .horse-table td:nth-child(3) { white-space: normal; max-width: 6em; min-width: 5em; }
  .horse-table th:nth-child(2), .horse-table td:nth-child(2) { text-align: center; }
  .horse-table th { padding: 0; font-weight: normal; color: var(--muted); }
  .horse-table th:nth-child(2), .horse-table th:nth-child(3) { padding: 6px 4px; }
  .horse-table .sort-button { width: 100%; min-height: 44px; padding: 0 3px; border: 0; border-radius: 0; background: transparent; color: inherit; font-size: 0.8rem; white-space: nowrap; }
  .horse-table th[aria-sort="ascending"] .sort-button, .horse-table th[aria-sort="descending"] .sort-button { color: var(--fg); font-weight: bold; }
  .horse-table tbody tr:last-child td { border-bottom: 0; }
  .horse-table .eval-marked td { font-weight: bold; }
  .horse-table .eval-positive td { background: var(--card); }
  .horse-table .ev-table-plus { display: block; font-size: 0.75rem; font-weight: bold; color: var(--accent); }
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
