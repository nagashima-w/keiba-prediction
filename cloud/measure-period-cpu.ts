/**
 * 日報の「直前 27 日の再集計」(Issue #264。`D1ReportSource.readPeriodStats`)の、Worker(workerd)上の CPU 時間と D1 の読み取り行数の測定。
 * **コミット済みのスクリプトから再現できる**形で残す(見積もりに再現手段が無い数字を JSDoc・報告に書かないため)。実 API・netkeiba・本番の D1 には一切出ない(ローカルの workerd と、一時ディレクトリの D1)。
 *
 * 測るもの(1 回あたり。レース数 R ごと):
 *   noop      基準(何もしない)
 *   aggregate 行(メモリ上の JSON のオブジェクト)から `buildPeriodStats` で統計を作る CPU だけ
 *   read      D1 から 6 文を 1 回の batch で読み(結果のデシリアライズを含む)、統計まで作る(本番の `readPeriodStats` と同じ経路)
 *
 * 方法: `scripts/measure-worker-cpu.ts` と同じ。ローカルの workerd は CPU 上限を強制せず、Worker の中の時計は同期処理中に進まない。
 * そこで**外から**測る: `wrangler dev --local` を起動し、その子孫の workerd プロセスの CPU 時間(/proc/<pid>/stat の utime+stime)を、
 * N 回のループを 1 リクエストで走らせる前後で読み、差を N で割る。CPU 時間の刻みは 1/CLK_TCK 秒(通常 10ms)。
 *
 * 使い方(cloud/ で。Linux のみ): `pnpm tsx measure-period-cpu.ts [--races 300,1000] [--n 20] [--repeats 4] [--port 8932]`
 *
 * 限界:
 *  - **この機械の CPU の速度での値**で、Cloudflare の本番とは一致する保証がない。ローカルの D1 は workerd の中の SQLite で、本番の D1(別プロセスへのネットワーク往復)とは遅延の構造が違う
 *    (この値は、D1 の待ち時間を含まない=CPU 時間だけ)。
 *  - 値は実行ごとにばらつく(最小〜中央値〜最大で報告する)。モード間・レース数間の下位桁の差に意味を読まないこと。
 *  - これは「CPU 時間の実測」であり、本番の CPU 制限の判定ではない。日報の DO のアラームは Worker Free の 10ms ではなく Durable Object の上限(桁違いに緩い)で動くはずだが、本番での強制は確かめていない。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRANGLER = path.join(HERE, "node_modules", ".bin", "wrangler");

/** 測る Worker の入口(esbuild でバンドルする)。`seed` は D1 に R レースの行を流し込む。`read`・`aggregate`・`noop` は 1 リクエストで N 回繰り返す。 */
export const WORKER_ENTRY = `
import { D1ReportSource } from ${JSON.stringify(path.join(HERE, "src", "daily-report-repository.ts"))};
import { buildPeriodStats } from ${JSON.stringify(path.join(HERE, "src", "period-stats.ts"))};

const RANGE = { fromDate: "20260901", toDate: "20261010" };

function rowsFor(races) {
  const rows = { races: [], bets: [], marks: [], results: [], combos: [], imports: [] };
  for (let i = 0; i < races; i += 1) {
    const raceId = "2026" + String(i).padStart(8, "0");
    const day = 20 + (i % 8);
    rows.races.push({ analysisId: i + 1, raceId, kaisaiDate: "202609" + day, model: "claude-sonnet-5-5" });
    for (let u = 1; u <= 14; u += 1) if (u <= 6) rows.marks.push({ analysisId: i + 1, umaban: u, mark: "◎" });
    for (const [t, k] of [["win", "01"], ["place", "02"], ["wide", "0102"], ["trio", "010203"], ["quinella", "0102"]]) rows.bets.push({ analysisId: i + 1, betType: t, comboKey: k, stake: 100, odds: 4, ev: 1.2 });
    for (let u = 1; u <= 14; u += 1) rows.results.push({ raceId, umaban: u, finishPosition: u, winPayout: u === 1 ? 400 : null, placePayout: u <= 3 ? 150 : null });
    for (const t of ["wide", "trio", "quinella"]) {
      for (const k of ["0102", "0103", "0203"]) rows.combos.push({ raceId, betType: t, comboKey: k, payout: 500 });
      rows.imports.push({ raceId, betType: t });
    }
  }
  return rows;
}

async function seed(db, start, races) {
  for (let from = start; from < races; from += 100) {
    const ana = [], hor = [], bet = [], res = [], cmb = [], imp = [];
    for (let i = from; i < Math.min(from + 100, races); i += 1) {
      const raceId = "2026" + String(i).padStart(8, "0");
      const day = 20 + (i % 8);
      ana.push([i + 1, raceId, "2026-09-" + day + "T04:00:00.000Z", "202609" + day, "claude-sonnet-5-5"]);
      for (let u = 1; u <= 14; u += 1) hor.push([i + 1, u, u <= 6 ? "◎" : null]);
      for (const [t, k] of [["win", "01"], ["place", "02"], ["wide", "0102"], ["trio", "010203"], ["quinella", "0102"]]) bet.push([i + 1, t, k, 100, 4, 1.2]);
      for (let u = 1; u <= 14; u += 1) res.push([raceId, u, u, u === 1 ? 400 : null, u <= 3 ? 150 : null]);
      for (const t of ["wide", "trio", "quinella"]) {
        for (const k of ["0102", "0103", "0203"]) cmb.push([raceId, t, k, 500]);
        imp.push([raceId, t]);
      }
    }
    await db.batch([
      db.prepare("INSERT INTO analyses (id, race_id, analyzed_at, ev_estimated, kaisai_date, model) SELECT value->>0, value->>1, value->>2, 0, value->>3, value->>4 FROM json_each(?)").bind(JSON.stringify(ana)),
      db.prepare("INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, is_positive, mark) SELECT value->>0, value->>1, 0.3, 0.3, 0, value->>2 FROM json_each(?)").bind(JSON.stringify(hor)),
      db.prepare("INSERT INTO analysis_bets (analysis_id, bet_type, combo_key, stake, odds, ev) SELECT value->>0, value->>1, value->>2, value->>3, value->>4, value->>5 FROM json_each(?)").bind(JSON.stringify(bet)),
      db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_payout, place_payout) SELECT value->>0, value->>1, value->>2, value->>3, value->>4 FROM json_each(?)").bind(JSON.stringify(res)),
      db.prepare("INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) SELECT value->>0, value->>1, value->>2, value->>3 FROM json_each(?)").bind(JSON.stringify(cmb)),
      db.prepare("INSERT INTO race_combo_payout_imports (race_id, bet_type) SELECT value->>0, value->>1 FROM json_each(?)").bind(JSON.stringify(imp)),
    ]);
  }
}

let cached = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "noop";
    const n = Number(url.searchParams.get("n") ?? "1");
    const races = Number(url.searchParams.get("races") ?? "300");
    if (mode === "seed") {
      await seed(env.DB, Number(url.searchParams.get("from") ?? "0"), races);
      return new Response("seeded " + races);
    }
    let check = 0;
    if (mode === "aggregate") {
      if (cached === null || cached.races !== races) cached = { races, rows: rowsFor(races) };
      for (let i = 0; i < n; i += 1) check += buildPeriodStats(cached.rows, RANGE).raceCount;
    } else if (mode === "read") {
      const source = new D1ReportSource({ db: env.DB, analyses: {} });
      for (let i = 0; i < n; i += 1) check += (await source.readPeriodStats(RANGE.fromDate, RANGE.toDate)).raceCount;
    } else if (mode === "noop") {
      check = 1;
    } else {
      return new Response("unknown mode", { status: 400 });
    }
    return new Response(String(check));
  },
};
`;

const WRANGLER_TOML = `name = "keiba-period-cpu"
main = "worker.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "keiba-period-cpu"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = ${JSON.stringify(path.join(HERE, "migrations"))}
`;

/** /proc/<pid>/stat の 1 行から、親プロセスと CPU 時間(utime+stime。クロック刻み)を取り出す(`scripts/measure-worker-cpu.ts` と同じ)。 */
export function parseProcStat(line: string): { readonly ppid: number; readonly cpuTicks: number } {
  const close = line.lastIndexOf(")");
  if (close < 0) throw new Error("stat の形式が不正です(')' がない)");
  const fields = line.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (fields.length < 13 || [ppid, utime, stime].some((v) => !Number.isFinite(v))) throw new Error("stat のフィールドが足りないか、数値でありません");
  return { ppid, cpuTicks: utime + stime };
}

function procTable(): Map<number, { ppid: number; cpuTicks: number; comm: string }> {
  const table = new Map<number, { ppid: number; cpuTicks: number; comm: string }>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = parseProcStat(readFileSync(`/proc/${entry}/stat`, "utf-8"));
      table.set(Number(entry), { ...stat, comm: readFileSync(`/proc/${entry}/comm`, "utf-8").trim() });
    } catch {
      // 読む間に終了したプロセスは飛ばす。
    }
  }
  return table;
}

/** wrangler の子孫のうち workerd の CPU 時間(刻み)の合計。 */
function workerdTicks(wranglerPid: number): number {
  const table = procTable();
  const descendants = new Set<number>();
  const queue = [wranglerPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [pid, p] of table) {
      if (p.ppid === parent && !descendants.has(pid)) {
        descendants.add(pid);
        queue.push(pid);
      }
    }
  }
  let total = 0;
  for (const pid of descendants) {
    const p = table.get(pid);
    if (p !== undefined && p.comm === "workerd") total += p.cpuTicks;
  }
  return total;
}

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
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

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("このスクリプトは Linux(/proc)でだけ動きます");
  const raceCounts = arg("--races", "300,1000").split(",").map(Number);
  const n = Number(arg("--n", "20"));
  const repeats = Number(arg("--repeats", "4"));
  const port = Number(arg("--port", "8932"));
  const clkTck = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf-8" }).trim());

  const dir = mkdtempSync(path.join(tmpdir(), "keiba-period-cpu-"));
  const state = path.join(dir, "state");
  writeFileSync(path.join(dir, "entry.ts"), WORKER_ENTRY);
  await build({
    absWorkingDir: HERE,
    entryPoints: [path.join(dir, "entry.ts")],
    outfile: path.join(dir, "worker.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser"],
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    tsconfig: path.join(HERE, "tsconfig.json"),
    logLevel: "error",
  });
  writeFileSync(path.join(dir, "wrangler.toml"), WRANGLER_TOML);
  const env = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  execFileSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state], { cwd: dir, env, stdio: "pipe", timeout: 120_000 });

  const child = spawn(WRANGLER, ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state], { cwd: dir, stdio: ["ignore", "ignore", "ignore"], detached: true, env });
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
    console.log(`## 直前 27 日の再集計の CPU 時間(workerd。CLK_TCK=${clkTck}、各 N=${n}、${repeats} 回の繰り返しの中央値・最小・最大)`);
    console.log("  ★この機械の CPU の速度での値。D1 の待ち時間は含まない。Cloudflare の本番とは一致する保証がない。ローカルの workerd は CPU 上限を強制しない。");
    const call = async (query: string): Promise<string> => {
      const res = await fetch(`http://127.0.0.1:${port}/?${query}`, { signal: AbortSignal.timeout(600_000) });
      const body = await res.text();
      if (res.status !== 200) throw new Error(`応答が不正です(HTTP ${res.status}: ${body.slice(0, 200)})`);
      return body;
    };
    let seeded = 0;
    for (const races of raceCounts) {
      // 行はレース数の分だけ足す(読む範囲は常に全行。前のレース数のぶんに続けて足すので、累計が races になるようにする)。
      if (races > seeded) {
        await call(`mode=seed&from=${seeded}&races=${races}`);
        seeded = races;
      }
      for (const mode of ["noop", "aggregate", "read"] as const) {
        const samples: number[] = [];
        for (let r = 0; r < repeats; r += 1) {
          const before = workerdTicks(child.pid!);
          const body = await call(`mode=${mode}&n=${n}&races=${races}`);
          const after = workerdTicks(child.pid!);
          if (mode !== "noop" && !(Number(body) >= races * n)) throw new Error(`モード ${mode} の結果が不正です(${body})`);
          samples.push((((after - before) / clkTck) * 1000) / n);
        }
        console.log(`  R=${String(races).padEnd(5)} ${mode.padEnd(9)} 中央値 ${median(samples).toFixed(2)} ms/回(最小 ${Math.min(...samples).toFixed(2)}・最大 ${Math.max(...samples).toFixed(2)})`);
      }
    }
  } finally {
    stop();
    process.off("exit", stop);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
