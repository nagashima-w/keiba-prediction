/**
 * ローカル(`wrangler dev --local`。workerd)での配線のスモークテストと、1 reps あたり ms の計測
 * (Issue #159〈#21-A〉)。実デプロイの前に配線の誤りを捕まえるためのもので、ネットワーク(netkeiba)には
 * 出ない。ローカルでは時計が普通に進むので ms が読めるが、**本番の CPU 制限・CPU 速度とは同じではない**
 * (目安)。
 *
 * 使い方(spikes/cloudflare で): `pnpm run smoke`
 * 出力: 検査の PASS/FAIL と、local-calibration.json(ドライバが結果に取り込む)。
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { CpuRuntime, CpuWork, LocalCalibrationEntry } from "../../scripts/cloudflare-spike/result.js";

const PORT = Number(process.env["SMOKE_PORT"] ?? "8791");
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = randomBytes(16).toString("hex");
const OUT_PATH = process.env["LOCAL_CALIBRATION_PATH"] ?? "local-calibration.json";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) {
    failures += 1;
  }
}

async function req(
  method: string,
  path: string,
  headers: Record<string, string> = { "x-spike-secret": SECRET },
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // JSON でない応答(403 の forbidden など)。
  }
  return { status: response.status, json, text };
}

async function waitReady(logs: () => string): Promise<void> {
  for (let i = 0; i < 90; i += 1) {
    try {
      const r = await fetch(`${BASE}/ping`, { headers: { "x-spike-secret": SECRET }, signal: AbortSignal.timeout(5000) });
      if (r.status === 200) {
        return;
      }
    } catch {
      // まだ起動していない。
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`wrangler dev が起動しませんでした\n${logs()}`);
}

async function main(): Promise<void> {
  const child = spawn(
    "node_modules/.bin/wrangler",
    ["dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1", "--var", `SPIKE_SECRET:${SECRET}`],
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
    await waitReady(() => logBuffer.slice(-3000));

    // 共有秘密(認可)。
    check("ヘッダなしは 403", (await req("GET", "/ping", {})).status === 403);
    check("誤った秘密は 403", (await req("GET", "/ping", { "x-spike-secret": "wrong" })).status === 403);
    check("ヘッダなしでは netkeiba 取得も 403", (await req("POST", "/netkeiba", {}, {})).status === 403);
    check("ヘッダなしでは DO も 403", (await req("GET", "/do/ping", {})).status === 403);
    const ping = await req("GET", "/ping");
    check("正しい秘密で /ping が 200", ping.status === 200 && ping.json?.["runtime"] === "worker");

    // EUC-JP。
    const euc = await req("GET", "/selftest/euc-jp");
    check("EUC-JP の往復デコードが一致", euc.status === 200 && euc.json?.["roundTrip"] === true, euc.text.slice(0, 200));

    // CPU(普通の Worker)。
    for (const [work, min] of [["parse", 16], ["score", 16], ["alloc", 1], ["allocFull", 1]] as const) {
      const r = await req("POST", `/cpu/${work}?reps=1`);
      const checkValue = Number(r.json?.["check"]);
      check(`Worker /cpu/${work}?reps=1 が 200 で、結果が健全(check=${checkValue} >= ${min})`, r.status === 200 && checkValue >= min, r.text.slice(0, 200));
    }
    const basic = Number((await req("POST", "/cpu/alloc?reps=1")).json?.["check"]);
    const full = Number((await req("POST", "/cpu/allocFull?reps=1")).json?.["check"]);
    check(`allocFull は alloc より多くの買い目(点数 ${full} > ${basic})を出す(全券種の入力が効いている)`, full > basic);

    // Durable Object(SQLite)。
    const doPing = await req("GET", "/do/ping");
    check("DO /do/ping が 200 で、SQLite(ctx.storage.sql)のクエリが通る", doPing.status === 200 && doPing.json?.["sqliteOk"] === true, doPing.text.slice(0, 200));
    for (const work of ["parse", "score", "alloc", "allocFull"] as const) {
      const r = await req("POST", `/do/cpu/${work}?reps=1`);
      check(`DO /do/cpu/${work}?reps=1 が 200 で runtime=durableObject`, r.status === 200 && r.json?.["runtime"] === "durableObject", r.text.slice(0, 200));
    }

    // 入力の検証(外へ出ない・不正は弾く)。
    check("許可されていない URL は 400(netkeiba 以外へは出ない)", (await req("POST", "/netkeiba", undefined, { targetId: "x", url: "https://example.com/", kind: "shutuba", encoding: "utf-8" })).status === 400);
    check("不正な kind は 400", (await req("POST", "/netkeiba", undefined, { targetId: "x", url: "https://race.netkeiba.com/", kind: "evil", encoding: "utf-8" })).status === 400);
    check("reps=0 は 400", (await req("POST", "/cpu/parse?reps=0")).status === 400);
    check("未知の処理は 404", (await req("POST", "/cpu/nope?reps=1")).status === 404);
    check("POST 以外の /cpu は 404", (await req("GET", "/cpu/parse?reps=1")).status === 404);

    // ローカル計測(1 reps あたり ms。ウォームアップ1回を捨て、同じ条件で3回)。
    const entries: LocalCalibrationEntry[] = [];
    const plan: [CpuRuntime, CpuWork, number][] = [];
    for (const runtime of ["worker", "durableObject"] as const) {
      for (const [work, reps] of [["parse", 10], ["score", 10], ["alloc", 3], ["allocFull", 2]] as const) {
        plan.push([runtime, work, reps]);
      }
    }
    for (const [runtime, work, reps] of plan) {
      const path = `${runtime === "worker" ? "" : "/do"}/cpu/${work}?reps=${reps}`;
      await req("POST", path); // ウォームアップ
      const perRep: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await req("POST", path);
        perRep.push(Number(r.json?.["insideMs"]) / reps);
      }
      perRep.sort((a, b) => a - b);
      entries.push({ runtime, work, reps, runs: perRep.length, perRepMsSorted: perRep });
      console.log(`ローカル計測 ${runtime}/${work}: reps=${reps} 1 reps あたり ms(小さい順)=${perRep.map((v) => v.toFixed(2)).join(", ")}`);
    }
    check("ローカル計測の値がすべて正(時計が進んでいる)", entries.every((e) => e.perRepMsSorted.every((v) => v > 0)));
    writeFileSync(OUT_PATH, JSON.stringify({ entries }, null, 2));
  } finally {
    stop();
  }
  console.log(failures === 0 ? "スモークテスト: すべて PASS" : `スモークテスト: ${failures} 件 FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
