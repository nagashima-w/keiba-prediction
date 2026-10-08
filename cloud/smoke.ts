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
 *  C. B からメールだけを変える → 403
 *  D. B から AUD だけを変える → 403
 *  E. (#162 段階2b)B と同じ認証の構成で、`main` を `smoke-worker.ts`(DO の接続関数を**偽ソケット**に差し替えた smoke 専用エントリ)に
 *     した一時設定で起動し、`GET /api/netkeiba/check` を通す。workerd と nodejs_compat の実環境で、
 *     Worker → DO → ソケットクライアント → HttpClient → cheerio が fixture で通り、頭数が返ること、2 秒間隔(DO の kv と実際の
 *     タイマー)・ブレーカー(403 の連続)が効くことを、netkeiba へ出さずに確かめる。
 *  F. (#177・#180ほか)日単位の DO `RaceDay` を、偽ソケットの実環境で通す(手動の起動・朝の取得・発走前の分析・一覧・分析の詳細)。
 *  G. (#206)cron の入口 `scheduled` を、`/cdn-cgi/local/scheduled`(cron の手動発火)で起動し、計画が確定すること・重複配信で状態が変わらないこと・
 *     `GET /api/plan` で観測できることを確かめる。Webhook は入れない(外へ出さない)。
 * ローカルでは Access の JWT(本物の鍵での署名)は作れないため、200 になる経路は ctx.access だけである。
 * JWT の検証そのものは単体テスト(test/)が担う。値はすべて文書用のダミー。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  return { status: response.status, text: await response.text(), headers: response.headers };
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

function vars(email: string, aud: string): string[] {
  return [
    "--var", `ACCESS_TEAM_NAME:${TEAM}`,
    "--var", `ACCESS_AUD:${aud}`,
    "--var", `ACCESS_ALLOWED_EMAIL:${email}`,
  ];
}

async function expectAllForbidden(port: number, label: string): Promise<void> {
  const bogus = { "Cf-Access-Jwt-Assertion": "aaa.bbb.ccc" };
  for (const [method, path] of [["GET", "/"], ["GET", "/app.js"], ["GET", "/check"], ["GET", "/api/health"], ["GET", "/api/analyses"], ["GET", "/api/analyses/status?kaisai_date=20260628"], ["GET", "/api/analyses/1"], ["GET", "/api/races?kaisai_date=20260628&venue=central"], ["GET", "/api/plan?kaisai_date=20260628"], ["POST", "/api/analyses/run"], ["POST", "/api/results/import"], ["POST", "/"], ["GET", "/no-such-path"]] as const) {
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
      const tamperedJs = await req(port, "GET", "/app.js", { "Cf-Access-Jwt-Assertion": "aaa.bbb.ccc" });
      check("B: 不正な JWT が付いていれば GET /app.js も 403(認証の素通りがない)", tamperedJs.status === 403 && tamperedJs.text === "forbidden", `${tamperedJs.status}`);
      check("B: HEAD /app.js は本文なしの 200。POST /app.js は 405", (await req(port, "HEAD", "/app.js")).status === 200 && (await req(port, "POST", "/app.js")).status === 405);
      const check404 = await req(port, "GET", "/check");
      check("B: GET /check は 200 で確認フォーム(旧 / の内容)を返す", check404.status === 200 && check404.text.includes('<form method="get" action="/api/netkeiba/check">'), `${check404.status}`);
      const health = await req(port, "GET", "/api/health");
      check("B: GET /api/health が 200 で DO の SQLite と D1(migration 適用済みの表・列)が動き、API キー・Webhook は未登録(secrets.anthropic:false・secrets.discord:false。smoke はどちらも持たない)", health.status === 200 && health.text === JSON.stringify({ ok: true, durableObject: { sqlite: true }, d1: { ok: true }, secrets: { anthropic: false, discord: false } }), `${health.status} ${health.text.slice(0, 120)}`);
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
    });

    // C. メールだけ違う。
    await withWorker(BASE_PORT + 2, ["--config", CONFIG_PATH, ...vars("stranger@example.com", AUD)], async () => {
      await expectAllForbidden(BASE_PORT + 2, "C(許可メールが違う)");
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

      const all = [central.text, nar.text, first403.text, blocked.text].join("\n");
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
      check(`${label}: 一覧の各行は固定のキー(race_id・venue_name・race_number・race_name・course_type・distance・entry_count・grade)だけ`, centralRows.length > 0 && Object.keys(centralRows[0]!).sort().join(",") === "course_type,distance,entry_count,grade,race_id,race_name,race_number,venue_name", JSON.stringify(centralRows[0]));
      const cachedStarted = Date.now();
      const racesCentral2 = await req(port, "GET", `/api/races?kaisai_date=${date}&venue=central`);
      const cachedMs = Date.now() - cachedStarted;
      check(`${label}: 2回目の一覧はキャッシュに当たり、gate の間隔(2 秒)を待たない(同じ内容・1 秒未満)`, racesCentral2.status === 200 && racesCentral2.text === racesCentral.text && cachedMs < 1000, `${cachedMs}ms`);
      const racesNar = await req(port, "GET", "/api/races?kaisai_date=20260927&venue=nar");
      const narRows = (parseJson(racesNar.text)["races"] as { race_id: string }[] | undefined) ?? [];
      check(`${label}: GET /api/races(地方。nar のホスト)が 200 で、フィクスチャと同じ件数(${expectedNar})。帯広(場コード65)を含まない`, racesNar.status === 200 && expectedNar > 0 && narRows.length === expectedNar && narRows.every((r) => r.race_id.slice(4, 6) !== "65"), `${racesNar.status} ${racesNar.text.slice(0, 200)}`);
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
      //   cron の時刻は 2026-06-29T00:00Z(JST 6/29 9:00)なので、窓は 20260622〜20260627 ではなく 20260622〜20260628(前日 = 20260628 を含む)。DO の「今日」は実時計なので、20260628 は過去。
      //   取得は NetkeibaGate の偽ソケット(実フィクスチャの結果ページ)・保存はローカルの D1。D1 の列挙(ROW_NUMBER・DENSE_RANK を使う 1 クエリ)も workerd の実環境で通る。
      const jstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
      const fireCron = async (time: number): Promise<{ status: number; text: string }> => {
        const r = await fetch(`http://127.0.0.1:${port}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("0 0 * * *")}&time=${String(time)}&format=json`, { signal: AbortSignal.timeout(60_000) });
        return { status: r.status, text: await r.text() };
      };
      type ResultImportView = { total: number; queued: number; imported: number; gave_up: number; races: { race_id: string; state: string; attempts: number; deferrals: number; requested_on: string; next_try_at: number | null; last_class: string | null }[] };
      const resultImportOf = async (day: string): Promise<{ status: number; view: ResultImportView | undefined; text: string }> => {
        const r = await req(port, "GET", `/api/plan?kaisai_date=${day}`);
        return { status: r.status, view: parseJson(r.text)["result_import"] as ResultImportView | undefined, text: r.text };
      };
      const beforeImport = await resultImportOf(date);
      check(`${label}: 取り込みの前は result_import が空(total 0)で、D1 に結果が無い`, beforeImport.status === 200 && beforeImport.view?.total === 0 && parseJson((await req(port, "GET", `/smoke/results?race_id=${raceId}`)).text)["result"] === null, beforeImport.text.slice(0, 160));
      const cronTime = Date.parse("2026-06-29T00:00:00Z");
      const cron = await fireCron(cronTime);
      check(`${label}: cron の発火(scheduledTime = 2026-06-29T00:00Z)が成功する(結果の依頼を含む)`, cron.status === 200 && parseJson(cron.text)["outcome"] === "ok", `${cron.status} ${cron.text.slice(0, 200)}`);
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
    //    scheduledTime が過去の開催日(2026-06-28)なので、発走時刻はすべて過去: 中央の一覧 36 件は全件 skip(started)になり、morning も pre_race も積まれない
    //    (netkeiba への追加の取得も Claude API の呼び出しも起きない。取得は偽ソケットの一覧 2 本だけ)。Webhook は入れない(外へ出さない)。
    await withWorker(BASE_PORT + 6, ["--config", FAKE_CONFIG_PATH, ...vars(EMAIL, AUD)], async () => {
      const port = BASE_PORT + 6;
      const label = "G(scheduled)";
      const fire = async (time: number): Promise<{ status: number; text: string }> => {
        const r = await fetch(`http://127.0.0.1:${port}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("0 0 * * *")}&time=${String(time)}&format=json`, { signal: AbortSignal.timeout(60_000) });
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

      const t0628 = Date.parse("2026-06-28T00:00:00Z"); // UTC 0:00 = JST 9:00(2026-06-28)
      const before = await req(port, "GET", "/api/plan?kaisai_date=20260628");
      check(`${label}: 発火の前は stage none`, before.status === 200 && (parseJson(before.text)["plan"] as { stage?: string }).stage === "none", `${before.status} ${before.text.slice(0, 160)}`);
      const first = await fire(t0628);
      check(`${label}: cron の発火(scheduledTime = 2026-06-28T00:00Z)が成功する`, first.status === 200 && parseJson(first.text)["outcome"] === "ok", `${first.status} ${first.text.slice(0, 200)}`);
      const done = await waitPlanDone("20260628");
      const plan = done.body["plan"] as { stage: string; requested_at: number | null; finalized_at: number | null; offset_minutes: number | null; venues: { venue: string; state: string; listed: number | null; targeted: number | null }[]; rows: { disposition: string; skip_reason: string | null; morning: string | null }[] } | undefined;
      check(`${label}: 計画が確定する(stage done。開催日は scheduledTime の JST の日付 20260628)`, done.status === 200 && done.body["kaisai_date"] === "20260628" && plan?.stage === "done" && typeof plan.requested_at === "number" && typeof plan.finalized_at === "number", `${done.status} ${done.text.slice(0, 300)}`);
      check(`${label}: 中央の一覧 36 件・地方は 0 件(偽ソケットの一覧)。対象はどちらも会場の取得に成功(ok)`, plan?.venues.length === 2 && plan.venues.every((v) => v.state === "ok") && plan.venues.find((v) => v.venue === "central")?.listed === 36 && plan.venues.find((v) => v.venue === "nar")?.listed === 0, JSON.stringify(plan?.venues));
      check(`${label}: 計画の行 36 件はすべて skip(started)で、morning を積んでいない(発走が過去なので netkeiba にも LLM にも出ない)`, plan?.rows.length === 36 && plan.rows.every((r) => r.disposition === "skip" && r.skip_reason === "started" && r.morning === null), JSON.stringify(plan?.rows.slice(0, 2)));
      const results = done.body["results"] as { outcome: { kind: string; reason: string | null } }[] | undefined;
      check(`${label}: 自動実行の結果 36 件はすべて skipped(started)。通知は 0 件(Webhook なし)`, results?.length === 36 && results.every((r) => r.outcome.kind === "skipped" && r.outcome.reason === "started") && Array.isArray(done.body["notifications"]) && (done.body["notifications"] as unknown[]).length === 0, JSON.stringify(results?.slice(0, 2)));
      check(`${label}: GET /api/plan の応答に webhook の語が無い`, !/webhook/i.test(done.text), done.text.slice(0, 80));
      // 重複配信: 同じ scheduledTime を再度発火しても、状態は変わらない(already-planned)
      const second = await fire(t0628);
      check(`${label}: 同じ scheduledTime の再発火(重複配信)も成功する`, second.status === 200 && parseJson(second.text)["outcome"] === "ok", `${second.status} ${second.text.slice(0, 200)}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const after = await req(port, "GET", "/api/plan?kaisai_date=20260628");
      check(`${label}: 重複配信のあとも、計画・結果・通知の本文が 1 バイトも変わらない`, after.status === 200 && after.text === done.text, `${after.status} ${after.text.slice(0, 120)}`);
      // 開催のない日: 一覧が空でも stage done になり、行は 0 件
      const emptyDay = await fire(Date.parse("2026-01-01T00:00:00Z"));
      check(`${label}: 開催のない日(2026-01-01)の発火も成功する`, emptyDay.status === 200 && parseJson(emptyDay.text)["outcome"] === "ok", `${emptyDay.status} ${emptyDay.text.slice(0, 200)}`);
      const emptyDone = await waitPlanDone("20260101");
      const emptyPlan = emptyDone.body["plan"] as { stage: string; rows: unknown[]; venues: { listed: number | null; targeted: number | null }[] } | undefined;
      check(`${label}: 開催のない日は、stage done・行 0 件・結果 0 件(会場の一覧は 0 件)`, emptyPlan?.stage === "done" && emptyPlan.rows.length === 0 && (emptyDone.body["results"] as unknown[]).length === 0 && emptyPlan.venues.every((v) => v.listed === 0), emptyDone.text.slice(0, 300));
      // UTC 15:00 以降の scheduledTime は JST の翌日の開催日になる(開催日は UTC でなく JST で決まる)
      const nextDay = await fire(Date.parse("2026-06-30T15:00:00Z"));
      check(`${label}: scheduledTime = 2026-06-30T15:00Z(JST 7/1 0:00)は開催日 20260701 の DO に入る`, nextDay.status === 200 && parseJson(nextDay.text)["outcome"] === "ok" && (await waitPlanDone("20260701")).body["kaisai_date"] === "20260701", `${nextDay.status} ${nextDay.text.slice(0, 200)}`);
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
