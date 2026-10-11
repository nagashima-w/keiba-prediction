/**
 * ローカル(`wrangler dev --local`。workerd)での配線のスモークテスト(Issue #161〈#21-C〉)。
 * 実デプロイの前に、バンドル・DO の配線・認証の関門が workerd 上で効くことを確かめる。netkeiba などの外部へは出ない。
 *
 * 使い方(cloud/ で): `pnpm run smoke`
 *
 * 複数の構成で wrangler dev を起動して確かめる(起動のたびに、終了時に必ずプロセスを止める)。
 *  (どの構成も、起動の前に D1 の migration を一時の保存先へ適用する〈wrangler d1 migrations apply DB --local〉。Issue #171)
 *  A. 設定なし(secret が無い本番の初回デプロイ直後と同じ)→ すべて 403(JWT が付いていても)
 *  B. `[access.dev]` で ctx.access を注入し、secret 相当を --var で渡す(正しい構成)→ 200。ただし不正な JWT が付けば 403
 *  C. (Issue #238)B から ACCESS_ALLOWED_EMAIL だけを変える(ログインするアカウントは管理者でなくなる)→ **閲覧者として通る**(旧: 403)。
 *     閲覧者は読み取りの画面・API だけ(200)、管理者専用(設定・検証・移行・health・確認・POST のすべて)は 403(本文は admin-only の固定)。
 *  J. (Issue #238)ADMIN_USER を別の人に登録する → ACCESS_ALLOWED_EMAIL の人は(フォールバックせず)閲覧者。
 *  K. (Issue #238)ADMIN_USER に複数(大文字・空白つき)を登録し、ログインするアカウントがその 1 人 → 管理者(ACCESS_ALLOWED_EMAIL とは別でも)。
 *  L. (Issue #238)ADMIN_USER が不正な区切り(登録済みで有効 0 件)→ 管理者なし。ACCESS_ALLOWED_EMAIL の人も閲覧者(フォールバックしない)。
 *  D. B から AUD だけを変える → 403
 *  E. (#162 段階2b)B と同じ認証の構成で、`main` を `smoke-worker.ts`(DO の接続関数を**偽ソケット**に差し替えた smoke 専用エントリ)に
 *     した一時設定で起動し、`GET /api/netkeiba/check` を通す。workerd と nodejs_compat の実環境で、
 *     Worker → DO → ソケットクライアント → HttpClient → cheerio が fixture で通り、頭数が返ること、2 秒間隔(DO の kv と実際の
 *     タイマー)・ブレーカー(403 の連続)が効くことを、netkeiba へ出さずに確かめる。
 *  F. (#177・#180ほか)日単位の DO `RaceDay` を、偽ソケットの実環境で通す(手動の起動・朝の取得・発走前の分析・一覧・分析の詳細)。
 *  G. (#206・#249)cron の入口 `scheduled` を、`/cdn-cgi/local/scheduled`(cron の手動発火)で起動し、21 時(1 本目)で翌日の計画が確定すること・重複配信で状態が変わらないこと・
 *     23 時(2 本目)の再実行(rescue)が正常な日を変えないこと・JST の日付の境界(23:59 と翌 0:00・年またぎ)・`GET /api/plan` で観測できることを確かめる。Webhook は入れない(外へ出さない)。
 * ローカルでは Access の JWT(本物の鍵での署名)は作れないため、200 になる経路は ctx.access だけである。
 * JWT の検証そのものは単体テスト(test/)が担う。値はすべて文書用のダミー。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE_PORT = Number(process.env["SMOKE_PORT"] ?? "8801");
const CONFIG_PATH = "wrangler.smoke.generated.toml";
const FAKE_CONFIG_PATH = "wrangler.smoke-fake.generated.toml";

const EMAIL = "owner@example.com";
const AUD = "smoke-aud-0001";
const TEAM = "smoke-team";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) {
    failures += 1;
  }
}

async function req(port: number, method: string, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  // 本文はバイト列で読み(画像の署名を見るため)、text は同じバイト列の UTF-8 復号(従来の response.text() と同じ)。
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, text: new TextDecoder().decode(bytes), bytes, headers: response.headers };
}

/** Issue #244: 先頭の 4 バイトが PNG の署名(89 50 4E 47)か。 */
function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function gateOf(json: Record<string, unknown>): Record<string, unknown> {
  const gate = json["gate"];
  return typeof gate === "object" && gate !== null ? (gate as Record<string, unknown>) : {};
}

async function waitReady(port: number, logs: () => string): Promise<void> {
  for (let i = 0; i < 90; i += 1) {
    try {
      // どの応答(403 でも 200 でも)でも、起動できたとみなす。
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
      return;
    } catch {
      // まだ起動していない。
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`wrangler dev が起動しませんでした\n${logs()}`);
}

/** wrangler dev を起動して fn を実行し、必ず止める。 */
async function withWorker(
  port: number,
  args: string[],
  fn: () => Promise<void>,
): Promise<void> {
  // DO の保存(kv)は、wrangler dev の既定では .wrangler/state に残り、次回の起動に引き継がれる(前回のブレーカーが開いたままになる)。
  // 毎回、新しい一時ディレクトリに保存して、終了時に消す(起動のたびに空の状態から始める)。
  const stateDir = mkdtempSync(path.join(tmpdir(), "keiba-smoke-state-"));
  // D1(分析履歴。#171)の migration を、同じ保存先(--persist-to)に適用してから起動する(/api/health が D1 の表・列を確かめる)。
  // wrangler dev と同じ設定ファイル(--config)・同じ保存先で、ローカルの D1 にだけ適用する(本番には触れない)。
  const configIndex = args.indexOf("--config");
  const configArgs = configIndex >= 0 ? ["--config", args[configIndex + 1]!] : [];
  execFileSync("node_modules/.bin/wrangler", ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir, ...configArgs], {
    stdio: "pipe",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    timeout: 120_000,
  });
  const child = spawn(
    "node_modules/.bin/wrangler",
    ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", stateDir, ...args],
    { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" } },
  );
  let logBuffer = "";
  child.stdout.on("data", (d: Buffer) => (logBuffer += d.toString()));
  child.stderr.on("data", (d: Buffer) => (logBuffer += d.toString()));
  const stop = (): void => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // すでに終了している。
    }
  };
  process.on("exit", stop);
  try {
    await waitReady(port, () => logBuffer.slice(-3000));
    await fn();
  } finally {
    stop();
    process.off("exit", stop);
    rmSync(stateDir, { recursive: true, force: true });
    // ポートが解放されるまで少し待つ。
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** 管理者専用への閲覧者のアクセスの拒否の本文(handler.ts の `adminOnly()`)。 */
const ADMIN_ONLY_BODY = JSON.stringify({ ok: false, error: { type: "admin-only" } });

function vars(email: string, aud: string, adminUser?: string): string[] {
  return [
    // Issue #217: 結果の補完を止める(`RESULT_BACKFILL_NIGHTLY_LIMIT=0`)。smoke(CI でも走る)が、時刻によって補完の窓(JST 1:00〜6:00)に当たっても、
    // 本物の netkeiba に出ないことを保証する。補完の DO は kick もアラームも何もしない(`scripts/test/cloud-config-guard.test.ts` が、すべての構成でこの指定があることを固定する)。
    "--var", "RESULT_BACKFILL_NIGHTLY_LIMIT:0",
    "--var", `ACCESS_TEAM_NAME:${TEAM}`,
    "--var", `ACCESS_AUD:${aud}`,
    "--var", `ACCESS_ALLOWED_EMAIL:${email}`,
    // Issue #238: 管理者(カンマ区切り)。未指定は未登録(ACCESS_ALLOWED_EMAIL が管理者になる移行期間)。
    ...(adminUser === undefined ? [] : ["--var", `ADMIN_USER:${adminUser}`]),
  ];
}

/**
 * Issue #238: ログインしているアカウントが**閲覧者**であることの確認。読み取りの画面・API は通り、管理者専用は 403(admin-only)で止まる。
 * 管理者専用の確認は、netkeiba・LLM・DO に届く前に止まるので、偽ソケットでない本物の Worker でも安全に叩ける(`/api/races` は日付なしで 400 を見るだけ)。
 */
async function expectViewer(port: number, label: string, email: string): Promise<void> {
  const page = await req(port, "GET", "/");
  check(`${label}: GET / は 200 で、閲覧者の印(data-role="viewer")と自分のメールが出て、閲覧専用の文言は出ない(Issue #243)`, page.status === 200 && page.text.includes('data-role="viewer"') && !page.text.includes("閲覧専用") && page.text.includes(email) && !page.text.includes('data-role="admin"'), `${page.status}`);
  check(`${label}: GET /app.js は 200`, (await req(port, "GET", "/app.js")).status === 200);
  // Issue #244: アイコンは閲覧者にも開く(表に足してある)。見出しの画像・favicon の取得が 403 にならない。POST は管理者専用(403)。
  const icon = await req(port, "GET", "/icons/header-32.png");
  check(`${label}: GET /icons/header-32.png は 200・image/png・PNG の署名(閲覧者にも開く。Issue #244)`, icon.status === 200 && icon.headers.get("content-type") === "image/png" && isPng(icon.bytes), `${icon.status} ${icon.headers.get("content-type")}`);
  const favicon = await req(port, "GET", "/favicon.ico");
  check(`${label}: GET /favicon.ico は 200・image/x-icon(閲覧者にも開く)`, favicon.status === 200 && favicon.headers.get("content-type") === "image/x-icon" && favicon.bytes[2] === 1, `${favicon.status}`);
  check(`${label}: HEAD /favicon.ico は 200。POST /favicon.ico は 403(admin-only)`, (await req(port, "HEAD", "/favicon.ico")).status === 200 && (await req(port, "POST", "/favicon.ico")).status === 403);
  const analyses = await req(port, "GET", "/api/analyses");
  check(`${label}: GET /api/analyses は 200(読み取り)`, analyses.status === 200 && parseJson(analyses.text)["ok"] === true, `${analyses.status} ${analyses.text.slice(0, 80)}`);
  const plan = await req(port, "GET", "/api/plan?kaisai_date=20261008");
  check(`${label}: GET /api/plan は 200(読み取り)`, plan.status === 200 && parseJson(plan.text)["ok"] === true, `${plan.status} ${plan.text.slice(0, 80)}`);
  const reports = await req(port, "GET", "/api/reports");
  check(`${label}: GET /api/reports は 200(日報は閲覧できる)`, reports.status === 200 && parseJson(reports.text)["ok"] === true, `${reports.status} ${reports.text.slice(0, 80)}`);
  check(`${label}: GET /api/analyses/status(日付なし)は 400・GET /api/races(日付なし)は 400(役割の関門を通って、各ハンドラの入力の検証に届く。403 ではない)`, (await req(port, "GET", "/api/analyses/status")).status === 400 && (await req(port, "GET", "/api/races")).status === 400);
  const adminOnly = [["GET", "/api/health"], ["GET", "/check"], ["GET", "/api/settings"], ["GET", "/api/verify?venue=all"], ["GET", "/api/migration"], ["GET", "/api/results/backfill"], ["GET", "/api/netkeiba/check?race_id=202603020211"], ["POST", "/api/settings"], ["POST", "/api/analyses/run"], ["POST", "/api/analyses/run/bulk"], ["GET", "/api/analyses/run/bulk"], ["POST", "/api/results/import"], ["POST", "/api/migration/upload"], ["POST", "/api/reports/run"], ["GET", "/no-such-path"]] as const;
  for (const [method, path] of adminOnly) {
    const r = await req(port, method, path);
    check(`${label}: ${method} ${path.split("?")[0]} は 403(本文は admin-only の固定。メール・AUD・チーム名を含まない)`, r.status === 403 && r.text === ADMIN_ONLY_BODY, `${r.status} ${r.text.slice(0, 80)}`);
  }
  check(`${label}: HEAD /api/plan は 403(表の外の method は管理者専用)`, (await req(port, "HEAD", "/api/plan?kaisai_date=20261008")).status === 403);
}

/** Issue #238: ログインしているアカウントが**管理者**であることの確認。管理者専用の API が 200・POST は役割の関門を通って各ハンドラの守り(Origin)に届く。 */
async function expectAdmin(port: number, label: string, email: string): Promise<void> {
  const page = await req(port, "GET", "/");
  check(`${label}: GET / は 200 で、管理者の印(data-role="admin")が出て、閲覧専用の文言は出ない`, page.status === 200 && page.text.includes('data-role="admin"') && !page.text.includes("閲覧専用") && page.text.includes(email), `${page.status}`);
  const health = await req(port, "GET", "/api/health");
  check(`${label}: GET /api/health は 200(管理者だけ)`, health.status === 200 && parseJson(health.text)["ok"] === true, `${health.status} ${health.text.slice(0, 80)}`);
  const settings = await req(port, "GET", "/api/settings");
  check(`${label}: GET /api/settings は 200(管理者だけ)`, settings.status === 200 && parseJson(settings.text)["ok"] === true, `${settings.status} ${settings.text.slice(0, 80)}`);
  const migration = await req(port, "GET", "/api/migration");
  check(`${label}: GET /api/migration は 200(管理者だけ)`, migration.status === 200 && parseJson(migration.text)["ok"] === true, `${migration.status} ${migration.text.slice(0, 80)}`);
  check(`${label}: GET /api/verify?venue=bad は 400(役割の関門を通って、入力の検証に届く)・GET /check は 200`, (await req(port, "GET", "/api/verify?venue=bad")).status === 400 && (await req(port, "GET", "/check")).status === 200);
  const post = await req(port, "POST", "/api/analyses/run");
  check(`${label}: POST /api/analyses/run は(Origin が無いので)origin-mismatch の 403。admin-only ではない(役割の関門を通って、ハンドラの守りに届く)`, post.status === 403 && post.text !== ADMIN_ONLY_BODY && post.text.includes("origin-mismatch"), `${post.status} ${post.text.slice(0, 80)}`);
  const bulk = await req(port, "POST", "/api/analyses/run/bulk");
  check(`${label}: POST /api/analyses/run/bulk(Issue #251)も(Origin が無いので)origin-mismatch の 403。admin-only ではない`, bulk.status === 403 && bulk.text !== ADMIN_ONLY_BODY && bulk.text.includes("origin-mismatch"), `${bulk.status} ${bulk.text.slice(0, 80)}`);
}

async function expectAllForbidden(port: number, label: string): Promise<void> {
  const bogus = { "Cf-Access-Jwt-Assertion": "aaa.bbb.ccc" };
  for (const [method, path] of [["GET", "/"], ["GET", "/app.js"], ["GET", "/check"], ["GET", "/api/health"], ["GET", "/api/analyses"], ["GET", "/api/analyses/status?kaisai_date=20260628"], ["GET", "/api/analyses/1"], ["GET", "/api/races?kaisai_date=20260628&venue=central"], ["GET", "/api/plan?kaisai_date=20260628"], ["POST", "/api/analyses/run"], ["POST", "/api/analyses/run/bulk"], ["POST", "/api/results/import"], ["GET", "/api/migration"], ["GET", "/api/results/backfill"], ["POST", "/api/migration/upload"], ["POST", "/"], ["GET", "/no-such-path"]] as const) {
    const r = await req(port, method, path);
    check(`${label}: ${method} ${path} は 403(本文は forbidden だけ)`, r.status === 403 && r.text === "forbidden", `${r.status} ${r.text.slice(0, 80)}`);
  }
  const r = await req(port, "GET", "/", bogus);
  check(`${label}: 壊れた JWT が付いていても GET / は 403`, r.status === 403 && r.text === "forbidden", `${r.status}`);
}

async function main(): Promise<void> {
  const base = readFileSync("wrangler.toml", "utf-8");
  // ctx.access の注入(wrangler の [access.dev]。本番のデプロイには使わない)。
  const injected = (aud: string): string =>
    `${base}\n[access.dev]\naud = "${aud}"\n\n[access.dev.identity]\nemail = "${EMAIL}"\n`;

  try {
    // A. 設定なし。
    await withWorker(BASE_PORT, [], async () => {
      await expectAllForbidden(BASE_PORT, "A(設定なし)");
    });

    // B. 正しい構成(ctx.access の aud・メールが secret 相当の設定と一致)。
    writeFileSync(CONFIG_PATH, injected(AUD));
    await withWorker(BASE_PORT + 1, ["--config", CONFIG_PATH, ...vars(EMAIL, AUD)], async () => {
      const port = BASE_PORT + 1;
      const page = await req(port, "GET", "/");
      check("B: GET / が 200 でメールを表示する", page.status === 200 && page.text.includes(EMAIL), `${page.status}`);
      check("B: GET / に viewport(スマホ幅)がある", page.text.includes('name="viewport"'));
      // Issue #184: スマホ画面。スクリプトは認証の後ろの /app.js だけ(インラインなし)。CSP は script-src 'self'・connect-src 'self'。
      const csp = page.headers.get("content-security-policy") ?? "";
      check("B: GET / の CSP が script-src 'self'・connect-src 'self'・default-src 'none'", csp.includes("script-src 'self'") && csp.includes("connect-src 'self'") && csp.includes("default-src 'none'") && !csp.includes("unsafe-eval"), csp);
      const scripts = [...page.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      check("B: GET / のスクリプトは <script src=\"/app.js\" defer> の 1 本だけ(インラインなし)", scripts.length === 1 && scripts[0]![1]!.includes('src="/app.js"') && scripts[0]![2] === "", `${scripts.length}`);
      const appJs = await req(port, "GET", "/app.js");
      check("B: GET /app.js が 200・text/javascript・no-store で、IIFE のバンドルを返す", appJs.status === 200 && (appJs.headers.get("content-type") ?? "").startsWith("text/javascript") && appJs.headers.get("cache-control") === "no-store" && appJs.text.length > 1000 && appJs.text.includes("/api/races"), `${appJs.status} ${appJs.headers.get("content-type")} ${appJs.text.length}`);
      // Issue #244: アイコン。CSP に img-src 'self'・<head> に <link rel="icon">・見出しの <img>。配信は image/png・private のキャッシュ・PNG の署名。不正な JWT なら 403。
      check("B: GET / の CSP に img-src 'self'(data: は無い)", csp.includes("img-src 'self'") && !csp.includes("data:"), csp);
      check("B: GET / の <head> に <link rel=\"icon\">(PNG 2 本)と apple-touch-icon、見出しに装飾の <img>(alt 空)", page.text.includes('rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png"') && page.text.includes('rel="apple-touch-icon"') && page.text.includes('class="logo" src="/icons/header-32.png"') && page.text.includes('alt=""'));
      const iconRes = await req(port, "GET", "/icons/header-96.png");
      check("B: GET /icons/header-96.png が 200・image/png・cache-control: private, max-age=86400・PNG の署名", iconRes.status === 200 && iconRes.headers.get("content-type") === "image/png" && iconRes.headers.get("cache-control") === "private, max-age=86400" && isPng(iconRes.bytes), `${iconRes.status} ${iconRes.headers.get("content-type")} ${iconRes.headers.get("cache-control")}`);
      const icoRes = await req(port, "GET", "/favicon.ico");
      check("B: GET /favicon.ico が 200・image/x-icon・ICO のヘッダ(種類 1・画像 3 枚)", icoRes.status === 200 && icoRes.headers.get("content-type") === "image/x-icon" && icoRes.bytes[2] === 1 && icoRes.bytes[4] === 3, `${icoRes.status}`);
      const tamperedIcon = await req(port, "GET", "/favicon.ico", { "Cf-Access-Jwt-Assertion": "aaa.bbb.ccc" });
      check("B: 不正な JWT が付いていれば GET /favicon.ico も 403(認証の素通りがない)", tamperedIcon.status === 403 && tamperedIcon.text === "forbidden", `${tamperedIcon.status}`);
      const tamperedJs = await req(port, "GET", "/app.js", { "Cf-Access-Jwt-Assertion": "aaa.bbb.ccc" });
      check("B: 不正な JWT が付いていれば GET /app.js も 403(認証の素通りがない)", tamperedJs.status === 403 && tamperedJs.text === "forbidden", `${tamperedJs.status}`);
      check("B: HEAD /app.js は本文なしの 200。POST /app.js は 405", (await req(port, "HEAD", "/app.js")).status === 200 && (await req(port, "POST", "/app.js")).status === 405);
      const check404 = await req(port, "GET", "/check");
      check("B: GET /check は 200 で確認フォーム(旧 / の内容)を返す", check404.status === 200 && check404.text.includes('<form method="get" action="/api/netkeiba/check">'), `${check404.status}`);
      const health = await req(port, "GET", "/api/health");
      check("B: GET /api/health が 200 で DO の SQLite と D1(migration 適用済みの表・列)が動き、API キー・Webhook・サイトの URL は未登録(secrets.anthropic:false・secrets.discord:false・secrets.appBaseUrl:false。smoke はどれも持たない)", health.status === 200 && health.text === JSON.stringify({ ok: true, durableObject: { sqlite: true }, d1: { ok: true }, secrets: { anthropic: false, discord: false, appBaseUrl: false } }), `${health.status} ${health.text.slice(0, 160)}`);
      // Issue #175: 読み取り専用の一覧(D1 だけ)。migration 適用済みの空の D1 では、空の配列が返る。
      const analyses = await req(port, "GET", "/api/analyses");
      check("B: GET /api/analyses が 200 で、空の D1 では { ok: true, analyses: [] }", analyses.status === 200 && analyses.text === JSON.stringify({ ok: true, analyses: [] }), `${analyses.status} ${analyses.text.slice(0, 120)}`);
      const filtered = await req(port, "GET", "/api/analyses?race_id=202603020211&kaisai_date=20261006&limit=5");
      check("B: GET /api/analyses は絞り込み(race_id・kaisai_date・limit)でも 200(空の配列)", filtered.status === 200 && filtered.text === JSON.stringify({ ok: true, analyses: [] }), `${filtered.status} ${filtered.text.slice(0, 120)}`);
      const badLimit = await req(port, "GET", "/api/analyses?limit=0");
      check("B: GET /api/analyses?limit=0 は 400", badLimit.status === 400 && parseJson(badLimit.text)["ok"] === false, `${badLimit.status}`);
      check("B: HEAD /api/analyses は 405(D1 を引かない)", (await req(port, "HEAD", "/api/analyses")).status === 405);
      // Issue #206・#208: GET /api/plan(読み取り専用)。本物の DO の RPC(getPlanProgress・getAutoRunResults・getNotifications・getResultImportProgress)を通す。依頼の前の日は stage none・空。
      const planEmpty = await req(port, "GET", "/api/plan?kaisai_date=20261008");
      check("B: GET /api/plan は 200 で、依頼の前の日は stage none・空の結果・空の通知・空の結果の取り込み(本物の DO の 4 つの RPC を通る)", planEmpty.status === 200 && planEmpty.text === JSON.stringify({ ok: true, kaisai_date: "20261008", plan: { stage: "none", requested_at: null, finalized_at: null, offset_minutes: null, offset_source: null, morning_all_terminal: false, venues: [], rows: [] }, results: [], notifications: [], result_import: { total: 0, queued: 0, imported: 0, gave_up: 0, races: [] } }), `${planEmpty.status} ${planEmpty.text.slice(0, 200)}`);
      check("B: GET /api/plan は HEAD で 405・日付なし/不正/未知のキーで 400・別サイト(cross-site)で 403", (await req(port, "HEAD", "/api/plan?kaisai_date=20261008")).status === 405 && (await req(port, "GET", "/api/plan")).status === 400 && (await req(port, "GET", "/api/plan?kaisai_date=20260230")).status === 400 && (await req(port, "GET", "/api/plan?kaisai_date=20261008&x=1")).status === 400 && (await req(port, "GET", "/api/plan?kaisai_date=20261008", { "Sec-Fetch-Site": "cross-site" })).status === 403);
      const tampered = await req(port, "GET", "/", { "Cf-Access-Jwt-Assertion": "aaa.bbb.ccc" });
      check("B: 不正な JWT が付いていれば、ctx.access が正しくても 403(別の経路で救わない)", tampered.status === 403 && tampered.text === "forbidden", `${tampered.status}`);
      check("B: 未知のパスは 404", (await req(port, "GET", "/no-such-path")).status === 404);
      check("B: POST / は 405", (await req(port, "POST", "/")).status === 405);
      // Issue #238: ADMIN_USER が未登録(この構成)では、ACCESS_ALLOWED_EMAIL の人が管理者(移行期間のフォールバック)。
      await expectAdmin(port, "B(ADMIN_USER 未登録 = ACCESS_ALLOWED_EMAIL が管理者)", EMAIL);
    });

    // H. (Issue #216)移行ファイルの受け取りと取り込み(本番の worker.ts。偽ソケットは使わない=netkeiba・LLM に出る経路が無い)。
    //    exe の書き出しの実物(core のテストが今の書き出しと一致を固定しているファイル)を gzip で upload → 本物の DO `CloudMigration` が workerd で
    //    検証 → アラームで取り込み(D1・R2)→ 完了。同じファイルをもう一度 upload しても重複しない。一覧は分析日時の降順。
    await withWorker(BASE_PORT + 7, ["--config", CONFIG_PATH, ...vars(EMAIL, AUD)], async () => {
      const port = BASE_PORT + 7;
      const label = "H(移行)";
      const origin = `http://127.0.0.1:${port}`;
      const golden = gzipSync(readFileSync(path.join("..", "packages", "core", "test", "fixtures", "cloud-migration-small.ndjson")));
      const upload = (body: Uint8Array, headers: Record<string, string> = { Origin: origin, "Content-Type": "application/gzip" }) =>
        fetch(`${origin}/api/migration/upload`, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) }).then(async (r) => ({ status: r.status, text: await r.text() }));
      const waitState = async (done: (j: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
        let last: Record<string, unknown> = {};
        for (let i = 0; i < 120; i += 1) {
          last = parseJson((await req(port, "GET", "/api/migration")).text);
          if (done(last)) return last;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return last;
      };
      const idle = await req(port, "GET", "/api/migration");
      check(`${label}: GET /api/migration は 200 で state idle(本物の DO を通る)`, idle.status === 200 && parseJson(idle.text)["state"] === "idle" && parseJson(idle.text)["ok"] === true, `${idle.status} ${idle.text.slice(0, 160)}`);
      check(`${label}: POST は Origin 無しで 403・Content-Type が違えば 415・HEAD/POST の取り違え(GET /upload・POST /api/migration)は 405`, (await upload(golden, { "Content-Type": "application/gzip" })).status === 403 && (await upload(golden, { Origin: origin, "Content-Type": "application/json" })).status === 415 && (await req(port, "GET", "/api/migration/upload")).status === 405 && (await req(port, "POST", "/api/migration")).status === 405);

      // Issue #217: 結果の補完の進捗(本物の DO `ResultBackfill` が、移行の DO `CloudMigration` の状態を RPC で読む)。移行が完了するまでは waiting-migration。
      const backfillIdle = await req(port, "GET", "/api/results/backfill");
      const backfillIdleJson = parseJson(backfillIdle.text);
      check(`${label}: GET /api/results/backfill は 200 で state disabled(smoke は補完を止めている)・移行の状態は idle(本物の DO 同士の RPC を通る)・残り 0・開催日不明 0・次の実行なし(アラームを張っていない)`, backfillIdle.status === 200 && backfillIdleJson["ok"] === true && backfillIdleJson["state"] === "disabled" && backfillIdleJson["migrationState"] === "idle" && backfillIdleJson["nextRunAt"] === null && backfillIdleJson["remaining"] === 0 && backfillIdleJson["undated"] === 0, `${backfillIdle.status} ${backfillIdle.text.slice(0, 300)}`);
      check(`${label}: POST /api/results/backfill は 405(GET だけ)`, (await req(port, "POST", "/api/results/backfill")).status === 405);

      const broken = await upload(golden.subarray(0, Math.floor(golden.length / 2)));
      check(`${label}: 途中で切れたファイルは 202 で受け付けたあと、検証で failed(phase verify)。D1 には何も書かれない`, broken.status === 202, `${broken.status} ${broken.text.slice(0, 160)}`);
      const failed = await waitState((j) => j["state"] === "failed");
      const failure = failed["failure"] as { phase?: string } | null;
      check(`${label}: 検証の失敗が状態に出る(failure.phase が verify)`, failed["state"] === "failed" && failure?.phase === "verify", JSON.stringify(failed).slice(0, 300));
      check(`${label}: 検証に失敗したので、分析の一覧は空のまま`, (await req(port, "GET", "/api/analyses?limit=200")).text === JSON.stringify({ ok: true, analyses: [] }));

      const first = await upload(golden);
      check(`${label}: 正しいファイルは 202(進捗が返る)`, first.status === 202 && parseJson(first.text)["ok"] === true, `${first.status} ${first.text.slice(0, 160)}`);
      const completed = await waitState((j) => j["state"] === "completed" || j["state"] === "failed");
      const analyses = completed["analyses"] as { total: number; processed: number; imported: number } | undefined;
      const results = completed["results"] as { total: number; processed: number } | undefined;
      check(`${label}: 取り込みが完了する(分析 5 件・結果 5 レース。すべて新規)`, completed["state"] === "completed" && analyses?.total === 5 && analyses.processed === 5 && analyses.imported === 5 && results?.total === 5 && results.processed === 5, JSON.stringify(completed).slice(0, 400));
      // 移行の完了後の補完の進捗。smoke は補完を止めているので、窓(JST 1:00〜6:00)の中で実行しても netkeiba に出ない(state は disabled のまま、アラームは張られない)。
      const backfillDone = parseJson((await req(port, "GET", "/api/results/backfill")).text);
      // golden の 202603020213 は、結果の行に馬の行が無い(組合せの取込記録だけ)ので、`race_results` に行が無く「未取込」と数えられる(残り 1)。開催日不明は 0(同じレースの別の分析に開催日がある)。
      check(`${label}: 移行の完了後は migrationState completed・状態 disabled・残り 1・開催日不明 0・取得済み 0・取得できなかった 0・次の実行なし(golden の馬の行が無い 1 レースが未取込として数えられる。本物の DO 同士の RPC)`, backfillDone["migrationState"] === "completed" && backfillDone["state"] === "disabled" && backfillDone["remaining"] === 1 && backfillDone["undated"] === 0 && backfillDone["imported"] === 0 && (backfillDone["abandoned"] as { total: number }).total === 0 && backfillDone["nextRunAt"] === null, JSON.stringify(backfillDone).slice(0, 400));
      const list = parseJson((await req(port, "GET", "/api/analyses?limit=200")).text);
      const items = list["analyses"] as { id: number; raceId: string; analyzedAt: string }[];
      check(`${label}: 一覧に 5 件。分析日時の降順(id の順ではない)`, items.length === 5 && items.every((a, i) => i === 0 || items[i - 1]!.analyzedAt >= a.analyzedAt) && items[0]!.analyzedAt === "2026-03-02T05:00:00.000Z", JSON.stringify(items.map((a) => [a.id, a.analyzedAt])));
      const detail = await req(port, "GET", `/api/analyses/${items[items.length - 2]!.id}`);
      check(`${label}: 詳細(D1 + R2)が読める(detail present)`, detail.status === 200 && detail.text.includes('"detail":"present"'), `${detail.status} ${detail.text.slice(0, 200)}`);

      // Issue #219: 検証の集計(本物の DO `VerifyReportDO`)。移行した 5 件は start_time が NULL なので、DO がアラームで R2 の詳細から写してから(preparing → ready)、本物の D1 を読んで集計する。
      let verifyJson: Record<string, unknown> = {};
      let verifyPolls = 0;
      for (; verifyPolls < 120; verifyPolls += 1) {
        verifyJson = parseJson((await req(port, "GET", "/api/verify?venue=all")).text);
        if (verifyJson["status"] !== "preparing") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const verifyReport = verifyJson["report"] as Record<string, number> | undefined;
      const verifyCounters = verifyReport === undefined ? -1 : ["includedAnalysisCount", "excludedAnalysisCount", "supersededAnalysisCount", "excludedEstimatedCount", "excludedLookaheadSuspectCount", "excludedLookaheadUnknownCount"].reduce((n, k) => n + (verifyReport[k] ?? 0), 0);
      check(`${label}: GET /api/verify は ready(発走時刻の補完のあと。本物の DO・D1・R2)。除外 6 カウンタの和が分析の総数 5 に一致し、D1 の読み取り行数が診断に出る`, verifyJson["ok"] === true && verifyJson["status"] === "ready" && verifyCounters === 5 && typeof (verifyJson["diag"] as { rowsRead?: number } | undefined)?.rowsRead === "number" && (verifyJson["diag"] as { rowsRead: number }).rowsRead > 0, `${verifyPolls} ${JSON.stringify(verifyJson).slice(0, 400)}`);
      const verifyCentral = parseJson((await req(port, "GET", "/api/verify?venue=central")).text);
      const verifyNar = parseJson((await req(port, "GET", "/api/verify?venue=nar")).text);
      const sumOf = (j: Record<string, unknown>): number => ((j["report"] as Record<string, number> | undefined)?.["includedAnalysisCount"] ?? -1);
      check(`${label}: 区分の切替(central・nar)はキャッシュから返り、中央 + 地方 = 全体(集計した分析の件数)`, sumOf(verifyCentral) + sumOf(verifyNar) === sumOf(verifyJson) && (verifyCentral["computedAt"] === verifyJson["computedAt"]), `${sumOf(verifyCentral)} ${sumOf(verifyNar)} ${sumOf(verifyJson)}`);
      check(`${label}: GET /api/verify は不正な区分で 400・POST は 405`, (await req(port, "GET", "/api/verify?venue=both")).status === 400 && (await req(port, "POST", "/api/verify")).status === 405);

      const second = await upload(golden);
      check(`${label}: 同じファイルをもう一度 upload しても 202`, second.status === 202, `${second.status}`);
      const again = await waitState((j) => (j["state"] === "completed" || j["state"] === "failed") && (j["analyses"] as { alreadyImported: number }).alreadyImported === 5);
      check(`${label}: 2 回目は全件が取り込み済み(alreadyImported 5・imported 0)で完了。一覧は 5 件のまま`, again["state"] === "completed" && (again["analyses"] as { imported: number; alreadyImported: number }).imported === 0 && (parseJson((await req(port, "GET", "/api/analyses?limit=200")).text)["analyses"] as unknown[]).length === 5, JSON.stringify(again).slice(0, 300));
      check(`${label}: 応答にメール・AUD・チーム名が含まれない`, ![first.text, second.text, JSON.stringify(completed)].join("\n").includes(EMAIL));
    });

    // C. (Issue #238)ACCESS_ALLOWED_EMAIL と違うアカウントでログインする = 閲覧者。旧: 全リクエストが 403。
    await withWorker(BASE_PORT + 2, ["--config", CONFIG_PATH, ...vars("stranger@example.com", AUD)], async () => {
      await expectViewer(BASE_PORT + 2, "C(ACCESS_ALLOWED_EMAIL と違うアカウント = 閲覧者)", EMAIL);
    });

    // J. (Issue #238)ADMIN_USER を別の人に登録する: ACCESS_ALLOWED_EMAIL の人(ログインしているアカウント)は閲覧者になる(フォールバックしない)。
    await withWorker(BASE_PORT + 8, ["--config", CONFIG_PATH, ...vars(EMAIL, AUD, "admin2@example.com")], async () => {
      await expectViewer(BASE_PORT + 8, "J(ADMIN_USER が別の人 = ACCESS_ALLOWED_EMAIL の人も閲覧者)", EMAIL);
    });

    // K. (Issue #238)ADMIN_USER に複数(大文字・空白つき)を登録し、ログインしているアカウントがその 1 人: 管理者(ACCESS_ALLOWED_EMAIL とは別でも)。
    await withWorker(BASE_PORT + 9, ["--config", CONFIG_PATH, ...vars("stranger@example.com", AUD, " Owner@Example.COM , admin2@example.com")], async () => {
      await expectAdmin(BASE_PORT + 9, "K(ADMIN_USER に複数 = 載っている人が管理者)", EMAIL);
    });

    // L. (Issue #238)ADMIN_USER が不正な区切り(登録済みで有効 0 件): 管理者なし。ACCESS_ALLOWED_EMAIL の人も閲覧者(フォールバックしない)。閲覧は止まらない。
    await withWorker(BASE_PORT + 10, ["--config", CONFIG_PATH, ...vars(EMAIL, AUD, "owner@example.com;admin2@example.com")], async () => {
      await expectViewer(BASE_PORT + 10, "L(ADMIN_USER が不正な区切り = 管理者なし)", EMAIL);
    });

    // D. AUD だけ違う。
    await withWorker(BASE_PORT + 3, ["--config", CONFIG_PATH, ...vars(EMAIL, "another-aud-0002")], async () => {
      await expectAllForbidden(BASE_PORT + 3, "D(AUD が違う)");
    });

    // E. 偽ソケットで、確認用エンドポイントを通す(netkeiba へは出ない)。
    const fakeBase = base.replace('main = "src/worker.ts"', 'main = "smoke-worker.ts"');
    if (fakeBase === base) {
      throw new Error('wrangler.toml に main = "src/worker.ts" が見つかりません(smoke の一時設定を作れません)');
    }
    writeFileSync(FAKE_CONFIG_PATH, `${fakeBase}\n[access.dev]\naud = "${AUD}"\n\n[access.dev.identity]\nemail = "${EMAIL}"\n`);
    await withWorker(BASE_PORT + 4, ["--config", FAKE_CONFIG_PATH, ...vars(EMAIL, AUD)], async () => {
      const port = BASE_PORT + 4;
      const label = "E(偽ソケット)";
      const page = await req(port, "GET", "/check");
      check(`${label}: GET /check に確認フォーム(GET で /api/netkeiba/check へ。初期値 202603020211)がある`, page.status === 200 && page.text.includes('<form method="get" action="/api/netkeiba/check">') && page.text.includes('value="202603020211"'), `${page.status}`);

      // Issue #176: runAnalysis(クラウド版の入口)が workerd で、フィクスチャから最後まで通り、exe 側の golden と同じ出力になる。
      const analysis = await req(port, "GET", "/smoke/analysis");
      const analysisJson = parseJson(analysis.text);
      const golden = JSON.parse(readFileSync(path.join("..", "packages", "app", "test", "golden", "pipeline-golden.json"), "utf-8")) as {
        noLlmAllBets: { result: unknown; record: { allocation: { bets: unknown[] } } };
      };
      const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
      check(`${label}: runAnalysis が workerd で最後まで通る(保存1件・16頭・配分は多点)`, analysis.status === 200 && analysisJson["ok"] === true && analysisJson["saved"] === 1 && analysisJson["rows"] === 16 && typeof analysisJson["bets"] === "number" && (analysisJson["bets"] as number) > 1, `${analysis.status} ${analysis.text.slice(0, 300)}`);
      check(`${label}: workerd の runAnalysis の結果(AnalysisResult)・保存レコード(AnalysisRecord)が、exe 側の golden と SHA-256 まで一致する`, analysisJson["resultSha256"] === sha(golden.noLlmAllBets.result) && analysisJson["recordSha256"] === sha(golden.noLlmAllBets.record) && analysisJson["bets"] === golden.noLlmAllBets.record.allocation.bets.length, `${String(analysisJson["resultSha256"])} / ${String(analysisJson["recordSha256"])}`);
      // (上の runAnalysis の確認は、ゲートの間隔(2 秒)の確認に影響しないよう、取得の確認の前に置く)

      const central = await req(port, "GET", "/api/netkeiba/check?race_id=202603020211");
      const centralJson = parseJson(central.text);
      check(`${label}: 中央の出馬表が Worker → DO → ソケット → HttpClient → cheerio で読め、頭数 16 が返る`, central.status === 200 && centralJson["ok"] === true && centralJson["horses"] === 16 && centralJson["kind"] === "central" && centralJson["status"] === 200, `${central.status} ${central.text.slice(0, 200)}`);

      const nar = await req(port, "GET", "/api/netkeiba/check?race_id=202654071210");
      const narJson = parseJson(nar.text);
      check(`${label}: 地方の出馬表(nar のホスト)も読め、頭数 12 が返る`, nar.status === 200 && narJson["ok"] === true && narJson["horses"] === 12 && narJson["kind"] === "nar", `${nar.status} ${nar.text.slice(0, 200)}`);
      // 直前の取得の終了直後に呼んでいるので、DO の kv に永続化した最後の開始時刻と実際のタイマーで、約 2 秒待たされる(間隔 2000ms の下限は単体テストが固定)。
      check(`${label}: 2 本目は間隔(約 2 秒)を待って始まる(queuedMs が 1000 以上)`, typeof narJson["queuedMs"] === "number" && (narJson["queuedMs"] as number) >= 1000, `queuedMs=${String(narJson["queuedMs"])}`);

      const invalid = await req(port, "GET", "/api/netkeiba/check?race_id=202665010101");
      check(`${label}: 無効な race_id(帯広)は 400`, invalid.status === 400, `${invalid.status}`);
      const head = await req(port, "HEAD", "/api/netkeiba/check?race_id=202603020211");
      check(`${label}: HEAD は 405(取得を起こさない)`, head.status === 405, `${head.status}`);

      // Issue #181: POST(重賞の過去10年傾向の API)。偽ソケットは、送られたヘッダ(Content-Type・X-Requested-With・Referer・Origin)と Content-Length を検査し、揃っていなければ 400 を返す。
      //   Worker → DO の RPC(構造化した指定)→ 許可リスト → ソケット → core の fetchGradeWinnerEntries(node:zlib の inflate を含む)が、workerd で通ることの確認。
      const gradePost = await req(port, "GET", "/api/netkeiba/check?race_id=202603020211&type=grade-winner");
      const gradePostJson = parseJson(gradePost.text);
      check(`${label}: POST の確認(中央・type=grade-winner)が通り、過去回 10 が読め、POST のブレーカーは開いていない`, gradePost.status === 200 && gradePostJson["ok"] === true && gradePostJson["target"] === "grade-winner" && gradePostJson["kind"] === "central" && gradePostJson["status"] === 200 && gradePostJson["entries"] === 10 && gateOf(gradePostJson)["postBlockedUntil"] === null, `${gradePost.status} ${gradePost.text.slice(0, 300)}`);
      const gradePostNar = await req(port, "GET", "/api/netkeiba/check?race_id=202644070111&type=grade-winner");
      const gradePostNarJson = parseJson(gradePostNar.text);
      check(`${label}: 地方(nar のホスト)の POST の確認も通り、過去回が読める`, gradePostNar.status === 200 && gradePostNarJson["ok"] === true && gradePostNarJson["kind"] === "nar" && typeof gradePostNarJson["entries"] === "number" && (gradePostNarJson["entries"] as number) > 0, `${gradePostNar.status} ${gradePostNar.text.slice(0, 300)}`);
      const gradePostHead = await req(port, "HEAD", "/api/netkeiba/check?race_id=202603020211&type=grade-winner");
      check(`${label}: HEAD の POST の確認は 405(取得を起こさない)`, gradePostHead.status === 405, `${gradePostHead.status}`);
      // POST のブレーカー: 偽ソケットが 403 を返す race_id で 1 回拒否されたら、POST だけが止まる(GET の連続回数は 0 のまま・GET は通る)。
      const post403 = await req(port, "GET", "/api/netkeiba/check?race_id=202605010101&type=grade-winner");
      const post403Json = parseJson(post403.text);
      check(`${label}: POST の拒否(403)は 502(http-error・status 403)。POST の解除時刻が入るが、GET の連続回数は 0 のまま・GET のブレーカーは開かない`, post403.status === 502 && post403Json["status"] === 403 && typeof gateOf(post403Json)["postBlockedUntil"] === "number" && gateOf(post403Json)["consecutiveRefusals"] === 0 && gateOf(post403Json)["blockedUntil"] === null, `${post403.status} ${post403.text.slice(0, 300)}`);
      const postBlocked = await req(port, "GET", "/api/netkeiba/check?race_id=202603020211&type=grade-winner");
      const postBlockedJson = parseJson(postBlocked.text);
      check(`${label}: POST のブレーカーが開いている間は、通るはずの POST も接続せずに 503(gate-refused・post-blocked)`, postBlocked.status === 503 && postBlockedJson["ok"] === false && (postBlockedJson["error"] as Record<string, unknown> | undefined)?.["reason"] === "post-blocked", `${postBlocked.status} ${postBlocked.text.slice(0, 300)}`);
      const getAfterPostBlock = await req(port, "GET", "/api/netkeiba/check?race_id=202603020211");
      const getAfterPostBlockJson = parseJson(getAfterPostBlock.text);
      check(`${label}: POST のブレーカーが開いていても、GET(出馬表)は通る`, getAfterPostBlock.status === 200 && getAfterPostBlockJson["ok"] === true && getAfterPostBlockJson["horses"] === 16, `${getAfterPostBlock.status} ${getAfterPostBlock.text.slice(0, 200)}`);

      // ブレーカー: 偽ソケットが 403 を返す race_id を 2 回 → 開く → 以降は(200 を返せる ID でも)接続せずに 503。
      const first403 = await req(port, "GET", "/api/netkeiba/check?race_id=202605010101");
      const first403Json = parseJson(first403.text);
      check(`${label}: 拒否(403)は 502(http-error・status 403)で、連続回数 1`, first403.status === 502 && first403Json["status"] === 403 && gateOf(first403Json)["consecutiveRefusals"] === 1, `${first403.status} ${first403.text.slice(0, 200)}`);
      const second403 = await req(port, "GET", "/api/netkeiba/check?race_id=202605010101");
      const second403Json = parseJson(second403.text);
      check(`${label}: 2 回連続の 403 でブレーカーが開く(解除時刻が入る)`, second403.status === 502 && gateOf(second403Json)["blockedUntil"] !== null && typeof gateOf(second403Json)["blockedUntil"] === "number", `${second403.status} ${second403.text.slice(0, 200)}`);
      const blocked = await req(port, "GET", "/api/netkeiba/check?race_id=202603020211");
      const blockedJson = parseJson(blocked.text);
      check(`${label}: ブレーカーが開いている間は、取得できるはずの race_id でも 503(gate-refused・blocked)`, blocked.status === 503 && blockedJson["ok"] === false && (blockedJson["error"] as Record<string, unknown> | undefined)?.["reason"] === "blocked", `${blocked.status} ${blocked.text.slice(0, 200)}`);

      // GET のブレーカーが開いている間は、POST も(POST のブレーカーとは別に)接続せずに止まる。reason は GET 側の blocked。
      const postWhileGetBlocked = await req(port, "GET", "/api/netkeiba/check?race_id=202603020211&type=grade-winner");
      const postWhileGetBlockedJson = parseJson(postWhileGetBlocked.text);
      check(`${label}: GET のブレーカーが開いている間は、POST も 503(gate-refused・blocked)`, postWhileGetBlocked.status === 503 && (postWhileGetBlockedJson["error"] as Record<string, unknown> | undefined)?.["reason"] === "blocked", `${postWhileGetBlocked.status} ${postWhileGetBlocked.text.slice(0, 300)}`);

      const all = [central.text, nar.text, gradePost.text, gradePostNar.text, post403.text, postBlocked.text, first403.text, blocked.text, postWhileGetBlocked.text].join("\n");
      for (const secret of [EMAIL, AUD, TEAM]) {
        check(`${label}: 応答に ${secret === EMAIL ? "メール" : secret === AUD ? "AUD" : "チーム名"} が含まれない`, !all.includes(secret));
      }
    });

    // F. (Issue #177)日単位の DO `RaceDay` を、workerd の実環境で通す: 予約(RPC は予約だけ)→ アラーム(取得 → 計算の2ステップ)→ 朝の prior が DO に残る。
    //    取得は NetkeibaGate の偽ソケット経由(中央16頭の 19 本。gate の間隔 2 秒で、約 40 秒かかる)。2回目はキャッシュで、gate の間隔の待ちが無く速い。
    //    D1 には何も書かれない(GET /api/analyses が空のまま)。E とは別の起動(E はブレーカーを開くので、その前の別の状態で動かす)。
    await withWorker(BASE_PORT + 5, ["--config", FAKE_CONFIG_PATH, ...vars(EMAIL, AUD)], async () => {
      const port = BASE_PORT + 5;
      const label = "F(RaceDay)";
      const date = "20260628";
      const raceId = "202603020211";
      const golden = JSON.parse(readFileSync(path.join("..", "packages", "app", "test", "golden", "pipeline-golden.json"), "utf-8")) as {
        noLlmNoAllocationNoDate: { result: { rows: { umaban: number; prior: number }[] } };
      };

      // Issue #180: 手動起動の入口(POST /api/analyses/run)。Origin・Content-Type・入力の検証 → 予約(202)→ 重複は 409。
      const origin = `http://127.0.0.1:${port}`;
      const run = (body: unknown, headers: Record<string, string> = { Origin: origin, "Content-Type": "application/json" }) =>
        fetch(`http://127.0.0.1:${port}/api/analyses/run`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }).then(async (r) => ({ status: r.status, text: await r.text() }));
      const goodBody = { race_id: raceId, kaisai_date: date };
      const noOrigin = await run(goodBody, { "Content-Type": "application/json" });
      check(`${label}: POST は Origin が無いと 403(origin-mismatch)`, noOrigin.status === 403 && noOrigin.text.includes("origin-mismatch"), `${noOrigin.status} ${noOrigin.text.slice(0, 120)}`);
      const evil = await run(goodBody, { Origin: "https://evil.example", "Content-Type": "application/json" });
      check(`${label}: 他サイトの Origin の POST は 403`, evil.status === 403, `${evil.status}`);
      const wrongType = await run(goodBody, { Origin: origin, "Content-Type": "text/plain" });
      check(`${label}: Content-Type が application/json でない POST は 415`, wrongType.status === 415, `${wrongType.status}`);
      const badInput = await run({ race_id: "202654071210", kaisai_date: "20260713" });
      check(`${label}: 地方のレースIDの月日が開催日と違う POST は 400(DO を呼ばない)`, badInput.status === 400, `${badInput.status} ${badInput.text.slice(0, 160)}`);
      const idleBoard = parseJson((await req(port, "GET", `/api/analyses/status?kaisai_date=${date}`)).text);
      check(`${label}: ここまでの拒否では、何も予約されていない(状態は空)`, Array.isArray(idleBoard["races"]) && (idleBoard["races"] as unknown[]).length === 0, JSON.stringify(idleBoard).slice(0, 160));

      const scheduled = await run(goodBody);
      const scheduledJson = parseJson(scheduled.text);
      check(`${label}: 正しい POST は 202 で、予約だけをして戻る(accepted・status queued)`, scheduled.status === 202 && scheduledJson["accepted"] === true && scheduledJson["status"] === "queued", `${scheduled.status} ${scheduled.text.slice(0, 200)}`);
      const duplicate = await run(goodBody);
      check(`${label}: 実行中の同じレースの二重の起動は 409(already-running)`, duplicate.status === 409 && duplicate.text.includes("already-running"), `${duplicate.status} ${duplicate.text.slice(0, 200)}`);

      // アラームが動いて done になるまで、GET /api/analyses/status で待つ(上限つき: 1 秒間隔で最大 150 回 = 150 秒)
      const waitDone = async (): Promise<Record<string, unknown>> => {
        let board: Record<string, unknown> = {};
        for (let i = 0; i < 150; i++) {
          board = parseJson((await req(port, "GET", `/api/analyses/status?kaisai_date=${date}`)).text);
          const races = board["races"] as { status: string }[] | undefined;
          if (races?.[0]?.status === "done" || races?.[0]?.status === "failed") {
            return board;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return board;
      };
      const started = Date.now();
      const board = await waitDone();
      const firstMs = Date.now() - started;
      const race = (board["races"] as Record<string, unknown>[] | undefined)?.[0];
      check(`${label}: アラームで取得 → 計算が進み、状態が done になる(約 ${Math.round(firstMs / 1000)} 秒)`, race?.["status"] === "done" && race["error"] === null && race["prior"] === true && board["kaisai_date"] === date, JSON.stringify(board).slice(0, 300));
      check(`${label}: 取得は gate の間隔(2 秒 × 19 本)を守っている(冷えた状態で 30 秒以上かかる)`, firstMs >= 30_000, `${firstMs}ms`);
      const withPrior = parseJson((await req(port, "GET", `/api/analyses/status?kaisai_date=${date}&race_id=${raceId}`)).text);
      const priorRows = (withPrior["prior"] as { rows: { prior: number }[] } | null)?.rows ?? [];
      check(`${label}: GET /api/analyses/status?race_id= が朝の prior の最小限(16頭・prior の高い順)を返す`, priorRows.length === 16 && priorRows.every((r, i) => i === 0 || priorRows[i - 1]!.prior >= r.prior), JSON.stringify(withPrior).slice(0, 200));

      const prior = parseJson((await req(port, "GET", `/smoke/race-day/prior?date=${date}&race_id=${raceId}`)).text)["prior"] as Record<string, unknown> | null;
      check(`${label}: 朝の prior が DO に残る(16頭・LLM なし・組合せオッズなし・近似の日付ではない)`, prior !== null && prior["rows"] === 16 && prior["llmUsed"] === false && prior["hasWideCombo"] === false && prior["dateApproximate"] === false, JSON.stringify(prior).slice(0, 200));
      check(`${label}: 朝の prior の値が、exe 側の golden(LLM なし)の prior と一致する(workerd でも同じ計算)`, JSON.stringify(prior?.["priors"]) === JSON.stringify(golden.noLlmNoAllocationNoDate.result.rows.map((r) => [r.umaban, r.prior])), "");

      // 2回目: キャッシュ(出馬表 10 分・戦績・調教 24 時間・オッズ 60 秒の内側)で、gate への取得が0本 = 間隔の待ちが無く速い
      const second = await run(goodBody);
      check(`${label}: 完了済みのレースは再び起動できる(202)`, second.status === 202, `${second.status} ${second.text.slice(0, 200)}`);
      const secondStarted = Date.now();
      const secondBoard = await waitDone();
      const secondMs = Date.now() - secondStarted;
      check(`${label}: 2回目はキャッシュに当たり、gate の取得が無い(10 秒以内に done)`, (secondBoard["races"] as { status: string }[])[0]?.status === "done" && secondMs < 10_000, `${secondMs}ms`);

      // Issue #251: 一括の手動起動(POST /api/analyses/run/bulk)。本物の DO の RPC(scheduleMany)を通す。守り(Origin・415・400)→ 予約(202。レースごとの結果)→ アラームで done。
      //   朝(morning)のキャッシュが効くので速い。morning は D1 に書かない(下の「D1 には何も書かれない」の確認が引き続き成り立つ)。
      const bulk = (body: unknown, headers: Record<string, string> = { Origin: origin, "Content-Type": "application/json" }) =>
        fetch(`http://127.0.0.1:${port}/api/analyses/run/bulk`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }).then(async (r) => ({ status: r.status, text: await r.text() }));
      const bulkBody = { kaisai_date: date, mode: "morning", race_ids: [raceId] };
      const bulkNoOrigin = await bulk(bulkBody, { "Content-Type": "application/json" });
      check(`${label}: 一括の POST は Origin が無いと 403(origin-mismatch)`, bulkNoOrigin.status === 403 && bulkNoOrigin.text.includes("origin-mismatch"), `${bulkNoOrigin.status} ${bulkNoOrigin.text.slice(0, 120)}`);
      const bulkWrongType = await bulk(bulkBody, { Origin: origin, "Content-Type": "text/plain" });
      check(`${label}: 一括の POST は Content-Type が application/json でないと 415`, bulkWrongType.status === 415, `${bulkWrongType.status}`);
      const bulkBad = await bulk({ ...bulkBody, race_ids: [] });
      check(`${label}: 一括の POST は race_ids が空だと 400(DO を呼ばない)`, bulkBad.status === 400, `${bulkBad.status} ${bulkBad.text.slice(0, 160)}`);
      const bulkNoMode = await bulk({ kaisai_date: date, race_ids: [raceId] });
      check(`${label}: 一括の POST は mode が無いと 400(既定の種類を持たない)`, bulkNoMode.status === 400, `${bulkNoMode.status}`);
      const queuedBefore = ((parseJson((await req(port, "GET", `/api/analyses/status?kaisai_date=${date}`)).text)["races"] as Record<string, unknown>[]).find((r) => r["mode"] === "morning"))?.["queued_at"];
      const bulkRun = await bulk(bulkBody);
      const bulkJson = parseJson(bulkRun.text);
      const bulkResults = (bulkJson["results"] as { race_id: string; result: string }[] | undefined) ?? [];
      check(`${label}: 一括の POST は 202 で、レースごとの結果(完了済みの朝は accepted)を返す`, bulkRun.status === 202 && bulkJson["accepted"] === true && bulkJson["mode"] === "morning" && bulkResults.length === 1 && bulkResults[0]!.race_id === raceId && bulkResults[0]!.result === "accepted", `${bulkRun.status} ${bulkRun.text.slice(0, 200)}`);
      let bulkRow: Record<string, unknown> | undefined;
      for (let i = 0; i < 60; i++) {
        const b = parseJson((await req(port, "GET", `/api/analyses/status?kaisai_date=${date}`)).text);
        bulkRow = (b["races"] as Record<string, unknown>[] | undefined)?.find((r) => r["mode"] === "morning");
        if (bulkRow !== undefined && bulkRow["queued_at"] !== queuedBefore && (bulkRow["status"] === "done" || bulkRow["status"] === "failed")) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      check(`${label}: 一括で積んだ朝がアラームで done になる(積み直されたので queued_at が新しい。キャッシュで速い)`, bulkRow?.["status"] === "done" && bulkRow["queued_at"] !== queuedBefore && bulkRow["error"] === null, JSON.stringify(bulkRow).slice(0, 300));

      // D1 に何も書かれていない(朝の prior は DO にだけ置く)
      const analyses = await req(port, "GET", "/api/analyses");
      check(`${label}: D1 には何も書かれない(GET /api/analyses が空のまま)`, analyses.status === 200 && analyses.text === JSON.stringify({ ok: true, analyses: [] }), `${analyses.status} ${analyses.text.slice(0, 120)}`);

      // Issue #178: 発走前の分析(mode: "pre_race"。LLM なし)。朝のキャッシュがあるので、取得は(出馬表は TTL 内・戦績・調教はキャッシュ)オッズだけを取り直す。
      //   D1(本物のローカルの D1・R2)に1件保存され、子の行が正しい親 id に紐づく(childrenOk)。設定の行は無いので、既定値(資金 0 = 配分なし・組合せ取得なし)。
      const preBody = { ...goodBody, mode: "pre_race" };
      const preStarted = Date.now();
      const pre = await run(preBody);
      check(`${label}: 発走前の分析の POST は 202(mode: pre_race)`, pre.status === 202 && parseJson(pre.text)["mode"] === "pre_race", `${pre.status} ${pre.text.slice(0, 160)}`);
      const preDuplicate = await run(preBody);
      check(`${label}: 実行中の発走前の分析の二重の起動は 409`, preDuplicate.status === 409, `${preDuplicate.status}`);
      let preRow: Record<string, unknown> | undefined;
      for (let i = 0; i < 90; i++) {
        const b = parseJson((await req(port, "GET", `/api/analyses/status?kaisai_date=${date}`)).text);
        preRow = (b["races"] as Record<string, unknown>[] | undefined)?.find((r) => r["mode"] === "pre_race");
        if (preRow?.["status"] === "done" || preRow?.["status"] === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const preMs = Date.now() - preStarted;
      check(`${label}: 発走前の分析が done になる(約 ${Math.round(preMs / 1000)} 秒。朝のキャッシュで取得は少ない)`, preRow?.["status"] === "done" && preRow["error"] === null && typeof preRow["analysis_id"] === "number", JSON.stringify(preRow).slice(0, 300));
      check(`${label}: 保存した子の行(馬・買い目)の件数が一致し(children_ok)、R2 の詳細が置かれた(detail: stored)`, preRow?.["children_ok"] === true && preRow["detail"] === "stored", JSON.stringify(preRow).slice(0, 300));
      check(`${label}: 発走前の取得は、朝の 19 本よりずっと速い(キャッシュ。gate の間隔 2 秒 × 19 本の約 36 秒を待たない)`, preMs < 20_000, `${preMs}ms`);
      const saved = parseJson((await req(port, "GET", `/api/analyses?race_id=${raceId}`)).text);
      const savedList = (saved["analyses"] as { id: number; raceId: string; kaisaiDate: string | null; horses: unknown[]; hasDetail: boolean }[] | undefined) ?? [];
      check(`${label}: D1 に分析が1件だけ保存された(GET /api/analyses。16頭・開催日・R2 の詳細あり)`, savedList.length === 1 && savedList[0]!.raceId === raceId && savedList[0]!.kaisaiDate === date && savedList[0]!.horses.length === 16 && savedList[0]!.hasDetail === true && savedList[0]!.id === preRow?.["analysis_id"], JSON.stringify(saved).slice(0, 300));

      // Issue #183(#165-a): 読み取りの API を2つ。取得は gate 経由の偽ソケット(一覧は実フィクスチャ)・D1・R2 はローカルの本物。
      //   (a) GET /api/races: 件数・並び・キャッシュ(2回目は gate を待たない)・空の日・検証・HEAD・Sec-Fetch-Site
      const listFixture = (name: string): string => readFileSync(path.join("..", "fixtures", name), "utf-8");
      // 期待する件数は、フィクスチャの HTML から race_id(12桁)の重複を除いて数える(帯広〈場コード65〉は除く)。smoke.ts は Node(tsx)で動き、core のパーサは
      // cheerio を解決できない配置(CI)があるので import しない。数え方が実装のパーサと食い違えば、件数の確認が落ちる(フィクスチャでは一致を確認済み)。
      const countRaceIds = (html: string): number => new Set([...html.matchAll(/race_id=(\d{12})/g)].map((m) => m[1]!).filter((id) => id.slice(4, 6) !== "65")).size;
      const expectedCentral = countRaceIds(listFixture("race_list_sub_20260628.html"));
      const expectedNar = countRaceIds(listFixture("nar_race_list_sub_20260927.html"));
      const racesCentral = await req(port, "GET", `/api/races?kaisai_date=${date}&venue=central`);
      const centralBody = parseJson(racesCentral.text);
      const centralRows = (centralBody["races"] as { race_id: string; race_number: number; race_name: string; grade: string | null }[] | undefined) ?? [];
      check(`${label}: GET /api/races(中央)が 200 で、フィクスチャと同じ件数(${expectedCentral})を、race_id の昇順(場 → R)で返す`, racesCentral.status === 200 && expectedCentral > 0 && centralRows.length === expectedCentral && centralRows.every((r, i) => i === 0 || centralRows[i - 1]!.race_id < r.race_id), `${racesCentral.status} ${racesCentral.text.slice(0, 200)}`);
      check(`${label}: 一覧の各行は固定のキー(race_id・venue_name・race_number・race_name・course_type・distance・entry_count・grade・start_time)だけ`, centralRows.length > 0 && Object.keys(centralRows[0]!).sort().join(",") === "course_type,distance,entry_count,grade,race_id,race_name,race_number,start_time,venue_name", JSON.stringify(centralRows[0]));
      // Issue #236: 発走予定時刻。中央の 1 行目は HH:MM の文字列(フィクスチャ race_list_sub_20260628 は発走前の取得で、先頭の行に時刻がある)。すべての行が「HH:MM か null」。
      const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
      const centralTimes = (centralBody["races"] as { start_time?: unknown }[] | undefined) ?? [];
      check(`${label}: 一覧(中央)の 1 行目の start_time は HH:MM の文字列で、全行が HH:MM か null`, centralTimes.length > 0 && typeof centralTimes[0]!.start_time === "string" && HHMM.test(centralTimes[0]!.start_time as string) && centralTimes.every((r) => r.start_time === null || (typeof r.start_time === "string" && HHMM.test(r.start_time))), JSON.stringify(centralTimes.slice(0, 2)));
      const cachedStarted = Date.now();
      const racesCentral2 = await req(port, "GET", `/api/races?kaisai_date=${date}&venue=central`);
      const cachedMs = Date.now() - cachedStarted;
      check(`${label}: 2回目の一覧はキャッシュに当たり、gate の間隔(2 秒)を待たない(同じ内容・1 秒未満)`, racesCentral2.status === 200 && racesCentral2.text === racesCentral.text && cachedMs < 1000, `${cachedMs}ms`);
      const racesNar = await req(port, "GET", "/api/races?kaisai_date=20260927&venue=nar");
      const narRows = (parseJson(racesNar.text)["races"] as { race_id: string; start_time?: unknown }[] | undefined) ?? [];
      check(`${label}: GET /api/races(地方。nar のホスト)が 200 で、フィクスチャと同じ件数(${expectedNar})。帯広(場コード65)を含まない`, racesNar.status === 200 && expectedNar > 0 && narRows.length === expectedNar && narRows.every((r) => r.race_id.slice(4, 6) !== "65"), `${racesNar.status} ${racesNar.text.slice(0, 200)}`);
      check(`${label}: 一覧(地方)も start_time のキーを持ち、1 行目は HH:MM の文字列(全行が HH:MM か null)`, narRows.length > 0 && typeof narRows[0]!.start_time === "string" && HHMM.test(narRows[0]!.start_time) && narRows.every((r) => r.start_time === null || (typeof r.start_time === "string" && HHMM.test(r.start_time))), JSON.stringify(narRows.slice(0, 2)));
      const racesEmpty = await req(port, "GET", "/api/races?kaisai_date=20260101&venue=central");
      check(`${label}: 開催なしの日は 200 で races: []`, racesEmpty.status === 200 && racesEmpty.text === JSON.stringify({ ok: true, kaisai_date: "20260101", venue: "central", races: [] }), `${racesEmpty.status} ${racesEmpty.text.slice(0, 160)}`);
      check(`${label}: GET /api/races の venue が無い・未知は 400`, (await req(port, "GET", `/api/races?kaisai_date=${date}`)).status === 400 && (await req(port, "GET", `/api/races?kaisai_date=${date}&venue=foo`)).status === 400);
      check(`${label}: HEAD /api/races は 405(取得を起こさない)`, (await req(port, "HEAD", `/api/races?kaisai_date=${date}&venue=central`)).status === 405);
      const crossSite = await req(port, "GET", `/api/races?kaisai_date=${date}&venue=central`, { "Sec-Fetch-Site": "cross-site" });
      check(`${label}: Sec-Fetch-Site: cross-site の GET /api/races は 403(origin-mismatch)`, crossSite.status === 403 && crossSite.text.includes("origin-mismatch"), `${crossSite.status} ${crossSite.text.slice(0, 120)}`);
      //   (b) GET /api/analyses/{id}: 上で保存した発走前の分析を、馬名つき・R2 の柵の内側で読む
      const detailId = preRow?.["analysis_id"];
      const detailRes = await req(port, "GET", `/api/analyses/${String(detailId)}`);
      const view = (parseJson(detailRes.text)["analysis"] as { id: number; raceId: string; detail: string; race: Record<string, unknown>; horses: { umaban: number; name: unknown }[]; allocation: unknown } | undefined);
      check(`${label}: GET /api/analyses/{id} が 200 で、16 頭すべてに馬名があり、レース名・場名(福島)・R(11)が付く(detail: present)`, detailRes.status === 200 && view?.id === detailId && view?.raceId === raceId && view?.detail === "present" && view.horses.length === 16 && view.horses.every((h) => typeof h.name === "string" && h.name.length > 0) && typeof view.race["raceName"] === "string" && view.race["venueName"] === "福島" && view.race["raceNumber"] === 11 && "allocation" in view, `${detailRes.status} ${detailRes.text.slice(0, 300)}`);
      check(`${label}: 応答に rawResponse・contributions・raceSnapshot の全体(騎手など)が含まれない`, !detailRes.text.includes("rawResponse") && !detailRes.text.includes("contributions") && !detailRes.text.includes("jockeyName") && !detailRes.text.includes("raceSnapshot"), detailRes.text.slice(0, 120));
      check(`${label}: 無い id は 404・不正な id は 400・HEAD は 405・クエリつきは 400`, (await req(port, "GET", "/api/analyses/999999")).status === 404 && (await req(port, "GET", "/api/analyses/abc")).status === 400 && (await req(port, "HEAD", `/api/analyses/${String(detailId)}`)).status === 405 && (await req(port, "GET", `/api/analyses/${String(detailId)}?x=1`)).status === 400);

      // Issue #208(#182-B): 結果の取り込み。上で D1 に保存した発走前の分析(開催日 20260628)の結果を、cron の入口 `scheduled` から取り込む。
      //   cron の時刻は 2026-06-29T14:00Z(JST 6/29 23:00。Issue #249 で結果の取り込みは 23 時の再実行だけ)なので、窓は 20260622〜20260627 ではなく 20260622〜20260628(前日 = 20260628 を含む)。DO の「今日」は実時計なので、20260628 は過去。
      //   取得は NetkeibaGate の偽ソケット(実フィクスチャの結果ページ)・保存はローカルの D1。D1 の列挙(ROW_NUMBER・DENSE_RANK を使う 1 クエリ)も workerd の実環境で通る。
      const jstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
      const fireCron = async (time: number): Promise<{ status: number; text: string }> => {
        const r = await fetch(`http://127.0.0.1:${port}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("0 14 * * *")}&time=${String(time)}&format=json`, { signal: AbortSignal.timeout(60_000) });
        return { status: r.status, text: await r.text() };
      };
      type ResultImportView = { total: number; queued: number; imported: number; gave_up: number; races: { race_id: string; state: string; attempts: number; deferrals: number; requested_on: string; next_try_at: number | null; last_class: string | null }[] };
      const resultImportOf = async (day: string): Promise<{ status: number; view: ResultImportView | undefined; text: string }> => {
        const r = await req(port, "GET", `/api/plan?kaisai_date=${day}`);
        return { status: r.status, view: parseJson(r.text)["result_import"] as ResultImportView | undefined, text: r.text };
      };
      const beforeImport = await resultImportOf(date);
      check(`${label}: 取り込みの前は result_import が空(total 0)で、D1 に結果が無い`, beforeImport.status === 200 && beforeImport.view?.total === 0 && parseJson((await req(port, "GET", `/smoke/results?race_id=${raceId}`)).text)["result"] === null, beforeImport.text.slice(0, 160));
      const cronTime = Date.parse("2026-06-29T14:00:00Z"); // UTC 14:00 = JST 6/29 23:00(2 本目の cron。翌日 20260630 の再実行 + 結果の取り込み)
      const cron = await fireCron(cronTime);
      check(`${label}: cron の発火(scheduledTime = 2026-06-29T14:00Z = JST 23:00 の再実行)が成功する(結果の依頼を含む)`, cron.status === 200 && parseJson(cron.text)["outcome"] === "ok", `${cron.status} ${cron.text.slice(0, 200)}`);
      let imported: ResultImportView | undefined;
      for (let i = 0; i < 60; i++) {
        imported = (await resultImportOf(date)).view;
        if (imported !== undefined && imported.total > 0 && imported.queued === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const importedRow = imported?.races[0];
      check(`${label}: 窓の未取込(上の分析)が 1 件だけ依頼され、アラームの中で 1 回の取得で取り込み済みになる(imported・試行 1・保留 0・分類 imported)`, imported?.total === 1 && imported.imported === 1 && importedRow?.race_id === raceId && importedRow.state === "imported" && importedRow.attempts === 1 && importedRow.deferrals === 0 && importedRow.last_class === "imported" && importedRow.next_try_at === null, JSON.stringify(imported));
      check(`${label}: 依頼の日は DO の時計の JST の今日(${jstToday})`, importedRow?.requested_on === jstToday, String(importedRow?.requested_on));
      const savedResult = parseJson((await req(port, "GET", `/smoke/results?race_id=${raceId}`)).text)["result"] as { horses: number; courseType: string | null; comboPayoutRows: number } | null;
      check(`${label}: D1 に結果が保存された(16 頭・面は芝・組合せ払戻の行がある。払戻のテーブルが出ているページだけ保存する)`, savedResult !== null && savedResult.horses === 16 && savedResult.courseType === "芝" && savedResult.comboPayoutRows > 0, JSON.stringify(savedResult));
      // 重複配信: 同じ scheduledTime を再度発火しても、状態は変わらない(D1 に結果があるので列挙に出ず、依頼もされない)
      const afterOnce = (await resultImportOf(date)).text;
      const again = await fireCron(cronTime);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      check(`${label}: 同じ scheduledTime の再発火(重複配信)も成功し、結果の取り込みの状態は変わらない`, again.status === 200 && parseJson(again.text)["outcome"] === "ok" && (await resultImportOf(date)).text === afterOnce, `${again.status}`);
      //   手動の入口 POST /api/results/import: 検証(400/403)と、同じ日の重複(D1 の結果を消しても、DO は同じ日に取り込み済みなので積み直さない)
      const importPost = (body: unknown, headers: Record<string, string> = { Origin: origin, "Content-Type": "application/json" }) =>
        fetch(`http://127.0.0.1:${port}/api/results/import`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }).then(async (r) => ({ status: r.status, text: await r.text() }));
      check(`${label}: POST /api/results/import は Origin が無いと 403・今日を含む範囲は 400・32 日の範囲は 400`, (await importPost({ from: "20260601", to: "20260628" }, { "Content-Type": "application/json" })).status === 403 && (await importPost({ from: "20260601", to: jstToday })).status === 400 && (await importPost({ from: "20260101", to: "20260628" })).status === 400);
      const clear = await req(port, "GET", `/smoke/results/clear?race_id=${raceId}`);
      const manualEmpty = await importPost({ from: "20260601", to: "20260628" });
      check(`${label}: 手動 POST: D1 の結果を消すと未取込として列挙され(listed 1)、DO は同じ日に取り込み済みなので積み直さない(accepted 0)。202`, clear.status === 200 && manualEmpty.status === 202 && manualEmpty.text === JSON.stringify({ ok: true, listed: 1, days: 1, accepted: 0, failed_days: 0 }), `${manualEmpty.status} ${manualEmpty.text}`);
      //   未確定(地方の発売前のページ): 保存せず、分類 not-confirmed で再試行待ち(10 分後)になる。直接 RPC(DO の依頼)で確かめる。
      const narDate = "20260716";
      const narRaceId = "202642071612";
      const requestNar = await req(port, "GET", `/smoke/race-day/request-result?date=${narDate}&race_ids=${narRaceId}`);
      check(`${label}: 地方の結果の依頼の RPC は受理される(accepted 1)`, requestNar.status === 200 && (parseJson(requestNar.text) as { accepted?: number }).accepted === 1, requestNar.text.slice(0, 160));
      let narView: ResultImportView | undefined;
      for (let i = 0; i < 40; i++) {
        narView = (await resultImportOf(narDate)).view;
        if (narView?.races[0]?.last_class !== null && narView?.races[0]?.last_class !== undefined) break; // 試行の数え(取得の前)ではなく、結果の分類が付くまで待つ
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const narRow = narView?.races[0];
      check(`${label}: 未確定のページは保存せず、分類 not-confirmed・試行 1・queued で再試行待ち(次の試行は未来)になる`, narRow?.race_id === narRaceId && narRow.state === "queued" && narRow.attempts === 1 && narRow.last_class === "not-confirmed" && typeof narRow.next_try_at === "number" && narRow.next_try_at > Date.now() && parseJson((await req(port, "GET", `/smoke/results?race_id=${narRaceId}`)).text)["result"] === null, JSON.stringify(narView));
      const todayRequest = await req(port, "GET", `/smoke/race-day/request-result?date=${jstToday}&race_ids=${raceId}`);
      check(`${label}: 今日の開催日の結果の依頼は DO が拒否する(当日中の取り込みは対象外。smoke の経路は 500)`, todayRequest.status === 500, `${todayRequest.status}`);
    });

    // G. (Issue #206)cron の入口 `scheduled` を、workerd の実環境(本物の DO・アラーム・NetkeibaGate への RPC・偽ソケット)で通す。
    //    wrangler dev の `/cdn-cgi/local/scheduled?cron=...&time=<ms>` で cron を手動発火する(本番では手動で scheduled を起動する手段が無い)。
    //    Issue #249: cron は 21:00 JST(1 本目。翌日の計画)と 23:00 JST(2 本目。翌日の計画の再実行 + 結果の取り込み + 補完)。計画する開催日は scheduledTime の JST の今日 + 1。
    //    scheduledTime が過去の開催日(2026-06-28)なので、発走時刻はすべて過去: 中央の一覧 36 件は全件 skip(started)になり、morning も pre_race も積まれない
    //    (netkeiba への追加の取得も Claude API の呼び出しも起きない。取得は偽ソケットの一覧 2 本だけ)。Webhook は入れない(外へ出さない)。
    await withWorker(BASE_PORT + 6, ["--config", FAKE_CONFIG_PATH, ...vars(EMAIL, AUD)], async () => {
      const port = BASE_PORT + 6;
      const label = "G(scheduled)";
      // cron 引数は情報だけ(runScheduled は使わない。scheduledTime の JST の時刻で 21 時 / 23 時を判別する)。
      const fire = async (time: number, cron = "0 12 * * *"): Promise<{ status: number; text: string }> => {
        const r = await fetch(`http://127.0.0.1:${port}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(cron)}&time=${String(time)}&format=json`, { signal: AbortSignal.timeout(60_000) });
        return { status: r.status, text: await r.text() };
      };
      const waitPlanDone = async (date: string): Promise<{ status: number; text: string; body: Record<string, unknown> }> => {
        let last = { status: 0, text: "", body: {} as Record<string, unknown> };
        for (let i = 0; i < 90; i++) {
          const r = await req(port, "GET", `/api/plan?kaisai_date=${date}`);
          last = { status: r.status, text: r.text, body: parseJson(r.text) };
          if ((last.body["plan"] as { stage?: string } | undefined)?.stage === "done") {
            return last;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return last;
      };

      const t0628 = Date.parse("2026-06-27T12:00:00Z"); // UTC 12:00 = JST 6/27 21:00(1 本目)→ 計画する開催日は翌日の 20260628
      const before = await req(port, "GET", "/api/plan?kaisai_date=20260628");
      check(`${label}: 発火の前は stage none`, before.status === 200 && (parseJson(before.text)["plan"] as { stage?: string }).stage === "none", `${before.status} ${before.text.slice(0, 160)}`);
      const first = await fire(t0628);
      check(`${label}: cron の発火(scheduledTime = 2026-06-27T12:00Z = JST 6/27 21:00。翌日 20260628 の計画)が成功する`, first.status === 200 && parseJson(first.text)["outcome"] === "ok", `${first.status} ${first.text.slice(0, 200)}`);
      const done = await waitPlanDone("20260628");
      const plan = done.body["plan"] as { stage: string; requested_at: number | null; finalized_at: number | null; offset_minutes: number | null; venues: { venue: string; state: string; listed: number | null; targeted: number | null }[]; rows: { disposition: string; skip_reason: string | null; morning: string | null }[] } | undefined;
      check(`${label}: 計画が確定する(stage done。開催日は scheduledTime の JST の今日 + 1 = 20260628)`, done.status === 200 && done.body["kaisai_date"] === "20260628" && plan?.stage === "done" && typeof plan.requested_at === "number" && typeof plan.finalized_at === "number", `${done.status} ${done.text.slice(0, 300)}`);
      check(`${label}: 中央の一覧 36 件・地方は 0 件(偽ソケットの一覧)。対象はどちらも会場の取得に成功(ok)`, plan?.venues.length === 2 && plan.venues.every((v) => v.state === "ok") && plan.venues.find((v) => v.venue === "central")?.listed === 36 && plan.venues.find((v) => v.venue === "nar")?.listed === 0, JSON.stringify(plan?.venues));
      check(`${label}: 計画の行 36 件はすべて skip(started)で、morning を積んでいない(発走が過去なので netkeiba にも LLM にも出ない)`, plan?.rows.length === 36 && plan.rows.every((r) => r.disposition === "skip" && r.skip_reason === "started" && r.morning === null), JSON.stringify(plan?.rows.slice(0, 2)));
      const results = done.body["results"] as { outcome: { kind: string; reason: string | null } }[] | undefined;
      check(`${label}: 自動実行の結果 36 件はすべて skipped(started)。通知は 0 件(Webhook なし)`, results?.length === 36 && results.every((r) => r.outcome.kind === "skipped" && r.outcome.reason === "started") && Array.isArray(done.body["notifications"]) && (done.body["notifications"] as unknown[]).length === 0, JSON.stringify(results?.slice(0, 2)));
      check(`${label}: 期限を待つ planned の行が無い日(36 件すべて発走済み)は、当日中の結果の取り込みの行を積まない(result_import は 0 件。本物の DO を通る。Issue #209)`, JSON.stringify(done.body["result_import"]) === JSON.stringify({ total: 0, queued: 0, imported: 0, gave_up: 0, races: [] }), JSON.stringify(done.body["result_import"]));
      check(`${label}: GET /api/plan の応答に webhook の語が無い`, !/webhook/i.test(done.text), done.text.slice(0, 80));
      // 重複配信: 同じ scheduledTime を再度発火しても、状態は変わらない(already-planned)
      const second = await fire(t0628);
      check(`${label}: 同じ scheduledTime の再発火(重複配信)も成功する`, second.status === 200 && parseJson(second.text)["outcome"] === "ok", `${second.status} ${second.text.slice(0, 200)}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const after = await req(port, "GET", "/api/plan?kaisai_date=20260628");
      check(`${label}: 重複配信のあとも、計画・結果・通知の本文が 1 バイトも変わらない`, after.status === 200 && after.text === done.text, `${after.status} ${after.text.slice(0, 120)}`);
      // 23 時の再実行(2 本目): 同じ翌日 20260628 に rescue つきの requestPlan を呼ぶ。正常に計画済みの日は何も変わらない(救済する失敗が無い)
      const t0627retry = Date.parse("2026-06-27T14:00:00Z"); // UTC 14:00 = JST 6/27 23:00
      const retry = await fire(t0627retry, "0 14 * * *");
      check(`${label}: 23 時の再実行(scheduledTime = 2026-06-27T14:00Z)も成功する(同じ翌日 20260628 への rescue つきの依頼。結果の取り込み・補完の起動も含む)`, retry.status === 200 && parseJson(retry.text)["outcome"] === "ok", `${retry.status} ${retry.text.slice(0, 200)}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const afterRetry = await req(port, "GET", "/api/plan?kaisai_date=20260628");
      check(`${label}: 正常に計画済みの日の 23 時の再実行(救済)は、計画・結果・通知の本文を 1 バイトも変えない(冪等)。通知は 0 件のまま`, afterRetry.status === 200 && afterRetry.text === done.text, `${afterRetry.status} ${afterRetry.text.slice(0, 120)}`);
      // 開催のない日: 一覧が空でも stage done になり、行は 0 件。年またぎ(JST 12/31 21:00 → 翌年 1/1 の開催日)
      const emptyDay = await fire(Date.parse("2025-12-31T12:00:00Z"));
      check(`${label}: 開催のない日(JST 2025/12/31 21:00 の発火 → 翌年 2026-01-01 の開催日。年またぎ)の発火も成功する`, emptyDay.status === 200 && parseJson(emptyDay.text)["outcome"] === "ok", `${emptyDay.status} ${emptyDay.text.slice(0, 200)}`);
      const emptyDone = await waitPlanDone("20260101");
      const emptyPlan = emptyDone.body["plan"] as { stage: string; rows: unknown[]; venues: { listed: number | null; targeted: number | null }[] } | undefined;
      check(`${label}: 開催のない日は、stage done・行 0 件・結果 0 件(会場の一覧は 0 件)`, emptyPlan?.stage === "done" && emptyPlan.rows.length === 0 && (emptyDone.body["results"] as unknown[]).length === 0 && emptyPlan.venues.every((v) => v.listed === 0), emptyDone.text.slice(0, 300));
      // 日付の境界: JST 23:59(UTC 14:59。2 本目と同じ日)は翌日 20260701、JST 翌 0:00(UTC 15:00)は日付が進んで 20260702 の DO に入る(開催日は UTC でなく JST で決まる)
      const lateNight = await fire(Date.parse("2026-06-30T14:59:00Z"), "0 14 * * *");
      check(`${label}: scheduledTime = 2026-06-30T14:59Z(JST 6/30 23:59)は開催日 20260701 の DO に入る`, lateNight.status === 200 && parseJson(lateNight.text)["outcome"] === "ok" && (await waitPlanDone("20260701")).body["kaisai_date"] === "20260701", `${lateNight.status} ${lateNight.text.slice(0, 200)}`);
      const nextDay = await fire(Date.parse("2026-06-30T15:00:00Z"));
      check(`${label}: scheduledTime = 2026-06-30T15:00Z(JST 7/1 0:00)は日付が進み、開催日 20260702 の DO に入る`, nextDay.status === 200 && parseJson(nextDay.text)["outcome"] === "ok" && (await waitPlanDone("20260702")).body["kaisai_date"] === "20260702", `${nextDay.status} ${nextDay.text.slice(0, 200)}`);
    });
  } finally {
    rmSync(CONFIG_PATH, { force: true });
    rmSync(FAKE_CONFIG_PATH, { force: true });
  }

  console.log(failures === 0 ? "\nすべての確認が通りました" : `\n${failures} 件の確認が失敗しました`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
