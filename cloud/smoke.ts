/**
 * ローカル(`wrangler dev --local`。workerd)での配線のスモークテスト(Issue #161〈#21-C〉)。
 * 実デプロイの前に、バンドル・DO の配線・認証の関門が workerd 上で効くことを確かめる。netkeiba などの外部へは出ない。
 *
 * 使い方(cloud/ で): `pnpm run smoke`
 *
 * 4つの構成で wrangler dev を起動して確かめる(起動のたびに、終了時に必ずプロセスを止める)。
 *  A. 設定なし(secret が無い本番の初回デプロイ直後と同じ)→ すべて 403(JWT が付いていても)
 *  B. `[access.dev]` で ctx.access を注入し、secret 相当を --var で渡す(正しい構成)→ 200
 *  C. B からメールだけを変える → 403
 *  D. B から AUD だけを変える → 403
 * ローカルでは Access の JWT(本物の鍵での署名)は作れないため、200 になる経路は ctx.access だけである。
 * JWT の検証そのものは単体テスト(test/)が担う。値はすべて文書用のダミー。
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const BASE_PORT = Number(process.env["SMOKE_PORT"] ?? "8801");
const CONFIG_PATH = "wrangler.smoke.generated.toml";

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
  const child = spawn(
    "node_modules/.bin/wrangler",
    ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", ...args],
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
      check("B: GET /api/health が 200 で DO の SQLite が動いている", health.status === 200 && health.text === JSON.stringify({ ok: true, durableObject: { sqlite: true } }), `${health.status} ${health.text.slice(0, 120)}`);
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
  } finally {
    rmSync(CONFIG_PATH, { force: true });
  }

  console.log(failures === 0 ? "\nすべての確認が通りました" : `\n${failures} 件の確認が失敗しました`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
