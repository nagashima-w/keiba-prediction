/**
 * ローカル(`wrangler dev --local`。workerd)での配線のスモークテスト(Issue #161〈#21-C〉)。
 * 実デプロイの前に、バンドル・DO の配線・認証の関門が workerd 上で効くことを確かめる。netkeiba などの外部へは出ない。
 *
 * 使い方(cloud/ で): `pnpm run smoke`
 *
 * 4つの構成で wrangler dev を起動して確かめる(起動のたびに、終了時に必ずプロセスを止める)。
 *  (どの構成も、起動の前に D1 の migration を一時の保存先へ適用する〈wrangler d1 migrations apply DB --local〉。Issue #171)
 *  A. 設定なし(secret が無い本番の初回デプロイ直後と同じ)→ すべて 403(JWT が付いていても)
 *  B. `[access.dev]` で ctx.access を注入し、secret 相当を --var で渡す(正しい構成)→ 200。ただし不正な JWT が付けば 403
 *  C. B からメールだけを変える → 403
 *  D. B から AUD だけを変える → 403
 *  E. (#162 段階2b)B と同じ認証の構成で、`main` を `smoke-worker.ts`(DO の接続関数を**偽ソケット**に差し替えた smoke 専用エントリ)に
 *     した一時設定で起動し、`GET /api/netkeiba/check` を通す。workerd と nodejs_compat の実環境で、
 *     Worker → DO → ソケットクライアント → HttpClient → cheerio が fixture で通り、頭数が返ること、2 秒間隔(DO の kv と実際の
 *     タイマー)・ブレーカー(403 の連続)が効くことを、netkeiba へ出さずに確かめる。
 * ローカルでは Access の JWT(本物の鍵での署名)は作れないため、200 になる経路は ctx.access だけである。
 * JWT の検証そのものは単体テスト(test/)が担う。値はすべて文書用のダミー。
 */
import { execFileSync, spawn } from "node:child_process";
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
  return { status: response.status, text: await response.text() };
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
  for (const [method, path] of [["GET", "/"], ["GET", "/api/health"], ["POST", "/"], ["GET", "/no-such-path"]] as const) {
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
      const health = await req(port, "GET", "/api/health");
      check("B: GET /api/health が 200 で DO の SQLite と D1(migration 適用済みの表・列)が動いている", health.status === 200 && health.text === JSON.stringify({ ok: true, durableObject: { sqlite: true }, d1: { ok: true } }), `${health.status} ${health.text.slice(0, 120)}`);
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
      const page = await req(port, "GET", "/");
      check(`${label}: GET / に確認フォーム(GET で /api/netkeiba/check へ。初期値 202603020211)がある`, page.status === 200 && page.text.includes('<form method="get" action="/api/netkeiba/check">') && page.text.includes('value="202603020211"'), `${page.status}`);

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
