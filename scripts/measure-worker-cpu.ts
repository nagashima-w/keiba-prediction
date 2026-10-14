/**
 * Worker(workerd)上の CPU 時間の測定(Issue #174・#172-a)。R2 に置く詳細オブジェクトの圧縮(gzip)の要否・レベルを決めるための根拠を、
 * **コミット済みのスクリプトから再現できる**形で残す(#147 の「見積もりに再現手段がない」への対応)。
 *
 * 測るもの(1回あたりの CPU 時間。入力は R2 に置く詳細オブジェクト〈scripts/measure-d1-size.ts の `buildDetailText`。約 129KB〉):
 *   noop(基準)・encode(TextEncoder)・stringify(JSON.stringify)・zlib1/zlib6(`node:zlib` の gzipSync の level 1・6)・
 *   cs(CompressionStream。レベル指定不可)・gunzip(`node:zlib`)・ds(DecompressionStream)
 *
 * 方法: ローカルの workerd は `[limits] cpu_ms` を**強制しない**(`cpu_ms = 1` でも 20 回の gzip が通る。実測)ので、上限の判定には使えない。
 * Worker の中の `performance.now()`・`Date.now()` は同期処理中に進まない(Spectre 対策)ので、Worker の中からも測れない。
 * そこで**外から**測る: `wrangler dev --local` を起動し、その**子孫の workerd プロセス**の CPU 時間(/proc/<pid>/stat の utime+stime)を、
 * N 回のループを1リクエストで走らせる前後で読み、差を N で割る。CPU 時間の刻みは 1/CLK_TCK 秒(通常 10ms)なので、N を大きく取って分解能を稼ぐ
 * (N=500 なら 0.02ms)。各モードを R 回繰り返し、最小・中央値・最大を出す。**子孫だけを数える**ので、同じ機械の別の workerd は数えない。
 *
 * 使い方(リポジトリのルートで。Linux のみ。/proc を使う):
 *   pnpm tsx scripts/measure-worker-cpu.ts [--n 500] [--repeats 4] [--port 8931]
 *
 * 限界:
 *  - **この機械の CPU の速度での値**で、Cloudflare の本番の CPU とは一致する保証がない。Worker Free の CPU 上限は 10ms だが、本番での強制は確かめていない。
 *  - 値は実行ごとにばらつく(最小〜最大で報告する)。モード間の下位桁の差に意味を読まないこと。
 *  - Node で測った値(zlib level 6 が約 4.5ms)と近い。zlib はネイティブなので、V8 の差はほとんど効かない。
 *  - Windows・macOS では動かない(/proc が無い)。
 *  - **これは「CPU 時間の実測」であり、本番の CPU 制限の判定ではない。** DO の中で実行するなら、CPU 上限は桁違いに緩い(#159)。
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDetailText } from "./measure-d1-size.js";

/** 測るモード(Worker のソースが処理する名前と一致させる。`measure-worker-cpu.test.ts` が検査)。 */
export const MODES = ["noop", "encode", "stringify", "zlib1", "zlib6", "cs", "gunzip", "ds"] as const;
export type Mode = (typeof MODES)[number];

/** 測る Worker のソース(`detail.json` を同じディレクトリに置いて起動する)。1リクエストで `n` 回、指定のモードの処理を繰り返す。 */
export const WORKER_SOURCE = `import detail from "./detail.json";
import { gzipSync, gunzipSync } from "node:zlib";

const text = JSON.stringify(detail);
const bytes = new TextEncoder().encode(text);

async function viaStream(transform, input) {
  const w = transform.writable.getWriter();
  void w.write(input);
  void w.close();
  return new Uint8Array(await new Response(transform.readable).arrayBuffer());
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "noop";
    const n = Number(url.searchParams.get("n") ?? "1");
    // 解凍の入力は、リクエストの外側(1回だけ)で作る。測るのは解凍だけ。
    const gz = mode === "gunzip" || mode === "ds" ? gzipSync(bytes, { level: 6 }) : null;
    let size = 0;
    for (let i = 0; i < n; i += 1) {
      if (mode === "noop") size = 1;
      else if (mode === "encode") size = new TextEncoder().encode(text).length;
      else if (mode === "stringify") size = JSON.stringify(detail).length;
      else if (mode === "zlib1") size = gzipSync(bytes, { level: 1 }).length;
      else if (mode === "zlib6") size = gzipSync(bytes, { level: 6 }).length;
      else if (mode === "cs") size = (await viaStream(new CompressionStream("gzip"), bytes)).length;
      else if (mode === "gunzip") size = gunzipSync(gz).length;
      else if (mode === "ds") size = (await viaStream(new DecompressionStream("gzip"), gz)).length;
      else return new Response("unknown mode", { status: 400 });
    }
    return new Response(String(size));
  },
};
`;

const WRANGLER_TOML = `name = "keiba-cpu-measure"
main = "worker.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
`;

/** /proc/<pid>/stat の1行から、親プロセスと CPU 時間(utime+stime。クロック刻み)を取り出す。 */
export function parseProcStat(line: string): { readonly ppid: number; readonly cpuTicks: number } {
  // comm(2番目)は括弧で囲まれ、空白・括弧を含みうる。最後の ')' より後ろを、空白で分割する。
  const close = line.lastIndexOf(")");
  if (close < 0) {
    throw new Error("stat の形式が不正です(')' がない)");
  }
  const fields = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // 括弧の後ろの並び: state(3) ppid(4) pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime(14) stime(15) ...
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (fields.length < 13 || [ppid, utime, stime].some((v) => !Number.isFinite(v))) {
    throw new Error("stat のフィールドが足りないか、数値でありません");
  }
  return { ppid, cpuTicks: utime + stime };
}

/** `table`(pid → ppid)から、`root` の子孫(子・孫…。根自身は含まない)の pid を返す。 */
export function descendantsOf(root: number, table: ReadonlyMap<number, number>): number[] {
  const result: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [pid, ppid] of table) {
      if (ppid === parent && !result.includes(pid)) {
        result.push(pid);
        queue.push(pid);
      }
    }
  }
  return result;
}

/** CPU 時間の刻みの差 → 1回あたりのミリ秒。刻みは 1/clkTck 秒。 */
export function perCallMs(ticks: number, clkTck: number, n: number): number {
  if (!(n > 0) || !(clkTck > 0) || ticks < 0) {
    throw new Error("n・clkTck は正、ticks は 0 以上でなければなりません");
  }
  return ((ticks / clkTck) * 1000) / n;
}

export interface Summary {
  readonly min: number;
  readonly median: number;
  readonly max: number;
  readonly count: number;
}

/** 最小・中央値・最大(入力は変更しない)。 */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) {
    throw new Error("値がありません");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { min: sorted[0]!, median, max: sorted[sorted.length - 1]!, count: sorted.length };
}

/** 結果の1行。N と繰り返し回数を必ず添える(添えないと、読み手が下位桁の差に意味を読む)。 */
export function formatResult(name: string, s: Summary, n: number, outputBytes?: number): string {
  const output = outputBytes === undefined ? "" : `、出力 ${outputBytes} バイト`;
  return `  ${name.padEnd(9)} 中央値 ${s.median.toFixed(2)} ms/回(最小 ${s.min.toFixed(2)}・最大 ${s.max.toFixed(2)}。${s.count} 回の繰り返し、各 N=${n}${output})`;
}

// ---------------------------------------------------------------------------
// 以下は実行(Linux の /proc と wrangler dev を使う。単体テストの対象外)
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "cloud", "node_modules", ".bin", "wrangler");

function argNumber(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

function procTable(): Map<number, { ppid: number; cpuTicks: number; comm: string }> {
  const table = new Map<number, { ppid: number; cpuTicks: number; comm: string }>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const stat = parseProcStat(readFileSync(`/proc/${entry}/stat`, "utf-8"));
      const comm = readFileSync(`/proc/${entry}/comm`, "utf-8").trim();
      table.set(Number(entry), { ...stat, comm });
    } catch {
      // 読む間に終了したプロセスは飛ばす。
    }
  }
  return table;
}

/** wrangler の子孫のうち workerd の CPU 時間(刻み)の合計。 */
function workerdTicks(wranglerPid: number): number {
  const table = procTable();
  const parents = new Map<number, number>([...table].map(([pid, v]) => [pid, v.ppid]));
  let total = 0;
  for (const pid of descendantsOf(wranglerPid, parents)) {
    const p = table.get(pid);
    if (p !== undefined && p.comm === "workerd") {
      total += p.cpuTicks;
    }
  }
  return total;
}

async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 90; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/?mode=noop`, { signal: AbortSignal.timeout(5000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("wrangler dev が起動しませんでした");
}

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("このスクリプトは Linux(/proc)でだけ動きます");
  }
  const n = argNumber("--n", 500);
  const repeats = argNumber("--repeats", 4);
  const port = argNumber("--port", 8931);
  const clkTck = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf-8" }).trim());

  const dir = mkdtempSync(path.join(tmpdir(), "keiba-worker-cpu-"));
  writeFileSync(path.join(dir, "detail.json"), buildDetailText());
  writeFileSync(path.join(dir, "worker.js"), WORKER_SOURCE);
  writeFileSync(path.join(dir, "wrangler.toml"), WRANGLER_TOML);

  const child = spawn(WRANGLER, ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", path.join(dir, "state")], {
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  const stop = (): void => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // すでに終了している。
    }
  };
  process.on("exit", stop);
  try {
    await waitReady(port);
    console.log(`## Worker(workerd)上の CPU 時間(入力: R2 の詳細オブジェクト ${Buffer.byteLength(readFileSync(path.join(dir, "detail.json")))} バイト。CLK_TCK=${clkTck})`);
    console.log("  ★この機械の CPU の速度での値。Cloudflare の本番とは一致する保証がない。ローカルの workerd は CPU 上限を強制しない。");
    const results: Record<string, Summary> = {};
    for (const mode of MODES) {
      const samples: number[] = [];
      let outputBytes = 0;
      for (let r = 0; r < repeats; r += 1) {
        const before = workerdTicks(child.pid!);
        const response = await fetch(`http://127.0.0.1:${port}/?mode=${mode}&n=${n}`, { signal: AbortSignal.timeout(300_000) });
        const body = await response.text();
        const after = workerdTicks(child.pid!);
        if (response.status !== 200 || !/^\d+$/.test(body) || Number(body) <= 0) {
          throw new Error(`モード ${mode} の応答が不正です(HTTP ${response.status})`);
        }
        samples.push(perCallMs(after - before, clkTck, n));
        outputBytes = Number(body);
      }
      results[mode] = summarize(samples);
      // 出力の大きさ(Worker が返した、処理の結果の長さ)は、圧縮のモードでだけ意味がある(圧縮後のバイト数)。
      console.log(formatResult(mode, results[mode]!, n, mode === "zlib1" || mode === "zlib6" || mode === "cs" ? outputBytes : undefined));
    }
  } finally {
    stop();
    process.off("exit", stop);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
