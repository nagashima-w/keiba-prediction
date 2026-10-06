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
  for (const [method, path] of [["GET", "/"], ["GET", "/api/health"], ["GET", "/api/analyses"], ["GET", "/api/analyses/status?kaisai_date=20260628"], ["POST", "/api/analyses/run"], ["POST", "/"], ["GET", "/no-such-path"]] as const) {
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
      // Issue #175: 読み取り専用の一覧(D1 だけ)。migration 適用済みの空の D1 では、空の配列が返る。
      const analyses = await req(port, "GET", "/api/analyses");
      check("B: GET /api/analyses が 200 で、空の D1 では { ok: true, analyses: [] }", analyses.status === 200 && analyses.text === JSON.stringify({ ok: true, analyses: [] }), `${analyses.status} ${analyses.text.slice(0, 120)}`);
      const filtered = await req(port, "GET", "/api/analyses?race_id=202603020211&kaisai_date=20261006&limit=5");
      check("B: GET /api/analyses は絞り込み(race_id・kaisai_date・limit)でも 200(空の配列)", filtered.status === 200 && filtered.text === JSON.stringify({ ok: true, analyses: [] }), `${filtered.status} ${filtered.text.slice(0, 120)}`);
      const badLimit = await req(port, "GET", "/api/analyses?limit=0");
      check("B: GET /api/analyses?limit=0 は 400", badLimit.status === 400 && parseJson(badLimit.text)["ok"] === false, `${badLimit.status}`);
      check("B: HEAD /api/analyses は 405(D1 を引かない)", (await req(port, "HEAD", "/api/analyses")).status === 405);
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

      // 2回目: キャッシュ(出馬表 10 分・戦績 24 時間・調教 6 時間・オッズ 60 秒の内側)で、gate への取得が0本 = 間隔の待ちが無く速い
      const second = await run(goodBody);
      check(`${label}: 完了済みのレースは再び起動できる(202)`, second.status === 202, `${second.status} ${second.text.slice(0, 200)}`);
      const secondStarted = Date.now();
      const secondBoard = await waitDone();
      const secondMs = Date.now() - secondStarted;
      check(`${label}: 2回目はキャッシュに当たり、gate の取得が無い(10 秒以内に done)`, (secondBoard["races"] as { status: string }[])[0]?.status === "done" && secondMs < 10_000, `${secondMs}ms`);

      // D1 に何も書かれていない(朝の prior は DO にだけ置く)
      const analyses = await req(port, "GET", "/api/analyses");
      check(`${label}: D1 には何も書かれない(GET /api/analyses が空のまま)`, analyses.status === 200 && analyses.text === JSON.stringify({ ok: true, analyses: [] }), `${analyses.status} ${analyses.text.slice(0, 120)}`);
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
