/**
 * クラウド版の移行の取り込み(Issue #216・#167-B1)の実測スクリプト。実際の規模に近い**合成ファイル**を、ローカルの workerd(`wrangler dev --local`。本番の `src/worker.ts`)に
 * upload し、移行の DO `CloudMigration` が最後まで取り込むのを観測する。**再現手順をコミット済みのコードに残す**ため(CLAUDE.md「再現手段のない数値を書かない」)。
 *
 * 測るもの(いずれも workerd プロセスの CPU 時間〈/proc/<pid>/stat の utime+stime。刻み 1/CLK_TCK 秒〉と、DO が status に出す壁時計のミリ秒):
 *  (i) 検証パス(アップロードされたファイル全体を展開して、フッタまで通す)の所要時間
 *  (ii) 取り込みの 1 回のアラーム(tick)の所要時間。**終盤(位置が大きい=毎回先頭から展開して読み飛ばす量が多い)**を含め、位置との関係を見る
 *  (iii) 1 分析・1 レースあたりの D1 の書き込み行数(D1 が報告する `meta.rows_written` の合計。DO が status に出す budget.usedRows と lastTick.rows から)
 *
 * 合成ファイル: exe の書き出しと同じ関数(`buildAnalysisLine`・`buildResultLine`・`serializeMigrationLine`・`MigrationTally`)で作る(形式の検証を通る)。詳細(race_snapshot_json・
 * contributions_json・raw_response)は、`scripts/measure-d1-size.ts` と同じ実フィクスチャ(中央 16 頭の 202603020211・LLM の実応答 36 本)から作り、圧縮率が実物より良くならないよう、
 * 小数の値を分析ごとに固定の種で別の値にする。**乱数は固定の種で、同じ引数なら同じファイル**。
 *
 * ★D1 の Free の 1 日の書き込み(10 万行)の上限があるので、1 回の測定で最後まで進められるよう、**既定は行数の少ない形**(馬 10 頭・買い目 0 件・結果は少なめ)にしてある
 *   (DO の 1 日の上限の環境変数 `MIGRATION_DAILY_ROW_LIMIT` は 100,000 が最大)。したがって **(iii) の行数は、買い目の件数を引数で変えて別々に測る**こと(`--bets`・`--horses`)。
 *   (ii) のバイト数(展開後の大きさ)は馬の頭数で決まるので、既定は実物に近い大きさにしてある(`--horses` を変えると変わる)。
 *
 * 使い方(リポジトリのルートで。Linux のみ。/proc を使う):
 *   pnpm tsx scripts/measure-migration-import.ts [--analyses 2300] [--results 300] [--horses 10] [--bets 0] [--combo-every 4] [--port 8941] [--keep-file path]
 *
 * 限界:
 *  - **この機械の CPU の速度・ローカルの D1(miniflare の SQLite)での値**。Cloudflare の本番の CPU・D1 の遅延とは一致する保証がない。
 *  - ローカルの workerd は CPU 上限を強制しない。ここで測るのは「どれだけの CPU 時間を使うか」で、本番の上限の判定ではない。
 *  - tick ごとの CPU は、status の `lastTick.at` が変わる間の workerd の CPU の増分(tick の間は DO が待つだけなので、ほぼ tick の分)。10ms の刻みで丸まる。
 *  - 1 回の実行の値(繰り返しなし)。下位桁に意味を読まないこと。
 */

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import {
  buildAnalysisLine,
  buildHeaderLine,
  buildResultLine,
  MigrationTally,
  serializeMigrationLine,
  type MigrationRow,
} from "../packages/core/src/ev/cloud-migration-format.js";
import { buildDetailText } from "./measure-d1-size.js";
import { descendantsOf, parseProcStat } from "./measure-worker-cpu.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLOUD = path.join(ROOT, "cloud");
const RESPONSES_DIR = path.join(ROOT, "docs", "investigations", "probability-quality-41-llm", "responses");

/** 固定の種の乱数(mulberry32)。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 小数(`1.234`)の値を、同じ桁数の別の値にする(圧縮率が、同じ値の繰り返しで実物より良くならないように)。 */
export function perturbDecimals(text: string, rand: () => number): string {
  return text.replace(/\d+\.\d+/g, (m) => {
    const decimals = m.length - m.indexOf(".") - 1;
    return (rand() * 10).toFixed(decimals);
  });
}

export interface SyntheticOptions {
  readonly analyses: number;
  readonly results: number;
  readonly horses: number;
  readonly bets: number;
  /** n 件に 1 件は、組合せオッズ全部入りの race_snapshot_json(約 73KB)。それ以外は組合せなし(約 4KB)。0 なら全部入り無し。 */
  readonly comboEvery: number;
}

const reasonsOf = (text: string): string[] => [...text.matchAll(/"reason":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);

/** 合成した移行ファイルの行(末尾の改行なし)を順に返す。 */
export function* syntheticLines(options: SyntheticOptions): Generator<string> {
  const rand = seededRandom(20261009);
  const detail = JSON.parse(buildDetailText()) as {
    raceSnapshot: Record<string, unknown>;
    rawResponse: string;
    contributions: Array<{ umaban: number; contributions: unknown }>;
  };
  const responses = readdirSync(RESPONSES_DIR).sort().map((f) => readFileSync(path.join(RESPONSES_DIR, f), "utf-8"));
  const comboKeys = Object.keys(detail.raceSnapshot).filter((k) => k.endsWith("Combo"));
  const lightSnapshot = JSON.stringify(Object.fromEntries(Object.entries(detail.raceSnapshot).filter(([k]) => !comboKeys.includes(k))));
  const fullSnapshot = JSON.stringify(detail.raceSnapshot);
  const contributionTexts = detail.contributions.map((c) => JSON.stringify(c.contributions));

  const tally = new MigrationTally();
  const header = buildHeaderLine({ exportedAt: "2026-10-09T00:00:00.000Z", appVersion: "measure" });
  tally.accept(header);
  yield serializeMigrationLine(header);

  for (let i = 1; i <= options.analyses; i += 1) {
    const raceNo = 1 + (i % Math.max(1, options.results || 1));
    const raceId = String(202500000000 + raceNo);
    const response = responses[i % responses.length]!;
    const reasons = reasonsOf(response);
    const snapshot = options.comboEvery > 0 && i % options.comboEvery === 0 ? fullSnapshot : lightSnapshot;
    const analysis: MigrationRow = {
      id: i,
      race_id: raceId,
      analyzed_at: new Date(Date.UTC(2025, 0, 1) + i * 3_600_000).toISOString(),
      ev_estimated: 0,
      prompt_version: "v8",
      additional_instruction: null,
      kaisai_date: "20250101",
      model: "claude-sonnet-5-5",
      raw_response: response,
      race_snapshot_json: perturbDecimals(snapshot, rand),
      history_cutoff_date: "20250101",
      prompt_lookahead_guarded: 1,
    };
    const horses: MigrationRow[] = Array.from({ length: options.horses }, (_, k) => ({
      analysis_id: i,
      umaban: k + 1,
      prior: rand(),
      adjusted_prob: rand(),
      place_odds_min: 1 + rand() * 20,
      ev: rand() * 2,
      is_positive: rand() < 0.3 ? 1 : 0,
      contributions_json: perturbDecimals(contributionTexts[k % contributionTexts.length]!, rand),
      mark: (["◎", "〇", "▲", null] as const)[k % 4] ?? null,
      reason: reasons[k % Math.max(1, reasons.length)] ?? null,
      highlights_json: JSON.stringify(["近走の内容が良い", "距離適性あり", "鞍上強化"]),
      concerns_json: JSON.stringify(["斤量増", "間隔が短い"]),
    }));
    const bets: MigrationRow[] = Array.from({ length: options.bets }, (_, b) => ({
      analysis_id: i,
      bet_type: ["place", "wide", "trio", "quinella", "exacta", "trifecta"][b % 6]!,
      combo_key: String(100000 + b * 37 + i).padStart(8, "0"),
      stake: 100,
      odds: 5.5,
      ev: 1.2,
    }));
    const allocationMeta: MigrationRow = {
      analysis_id: i, route: "mixed", unavailable_reason: null, fallback_reason: null, skip_reason_code: null, combo_odds_wide: "available", combo_odds_trio: "available",
      bankroll: 10000, per_race_cap: 2000, kelly_fraction: 0.25, ev_threshold: 1, include_combo_odds: 1, include_wide: 1, include_trio: 1, include_quinella: 1, include_exacta: 1,
      include_trifecta: 1, include_bracket_quinella: 1, bet_unit: 100, greedy_steps: 50, candidate_cap: 200, model_id: "m", model_approximate: 0, odds_status: "result",
    };
    const line = buildAnalysisLine({ analysis, horses, bets, allocationMeta });
    const text = serializeMigrationLine(line);
    tally.accept(line);
    yield text;
  }

  for (let r = 1; r <= options.results; r += 1) {
    const raceId = String(202500000000 + r);
    const n = 14 + (r % 5);
    const results: MigrationRow[] = Array.from({ length: n }, (_, k) => ({
      race_id: raceId, umaban: k + 1, finish_position: k + 1, place_payout: k < 3 ? 150 + k * 40 : null, win_payout: k === 0 ? 380 : null, passing_json: JSON.stringify([3, 3, 2, 1]), last3f: 34 + rand(),
    }));
    const betTypes = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"];
    const comboPayouts: MigrationRow[] = betTypes.flatMap((t, ti) => (ti === 0 ? [0, 1, 2] : [0]).map((j) => ({ race_id: raceId, bet_type: t, combo_key: `${String(ti + 1).padStart(2, "0")}${String(j + 1).padStart(2, "0")}`, payout: 500 + ti * 100 + j })));
    const line = buildResultLine({
      raceId,
      results,
      meta: { race_id: raceId, course_type: "芝" },
      comboPayouts,
      comboPayoutImports: betTypes.map((t) => ({ race_id: raceId, bet_type: t })),
    });
    const text = serializeMigrationLine(line);
    tally.accept(line);
    yield text;
  }
  yield serializeMigrationLine(tally.buildFooter());
}

// ---------------------------------------------------------------------------
// 以下は実行(Linux の /proc と wrangler dev を使う)
// ---------------------------------------------------------------------------

function argNumber(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
function argString(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function workerdTicks(wranglerPid: number): number {
  const table = new Map<number, { ppid: number; cpuTicks: number; comm: string }>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = parseProcStat(readFileSync(`/proc/${entry}/stat`, "utf-8"));
      table.set(Number(entry), { ...stat, comm: readFileSync(`/proc/${entry}/comm`, "utf-8").trim() });
    } catch {
      // 読む間に終了したプロセス。
    }
  }
  const parents = new Map<number, number>([...table].map(([pid, v]) => [pid, v.ppid]));
  let total = 0;
  for (const pid of descendantsOf(wranglerPid, parents)) {
    const p = table.get(pid);
    if (p !== undefined && p.comm === "workerd") total += p.cpuTicks;
  }
  return total;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function quantile(sorted: readonly number[], q: number): number {
  return sorted.length === 0 ? Number.NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

interface StatusView {
  state: string;
  analyses: { total: number | null; processed: number; imported: number; alreadyImported: number; conflicts: number };
  results: { total: number | null; processed: number };
  budget: { usedRows: number; limitRows: number };
  verified: { bytes: number; lines: number; ms: number } | null;
  lastTick: { at: string; queries: number; rows: number; lines: number; ms: number } | null;
  resumeAt: string | null;
  failure: { phase: string; message: string } | null;
  attempts: number;
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("このスクリプトは Linux(/proc)でだけ動きます");
  const options: SyntheticOptions = {
    analyses: argNumber("--analyses", 2300),
    results: argNumber("--results", 300),
    horses: argNumber("--horses", 10),
    bets: argNumber("--bets", 0),
    comboEvery: argNumber("--combo-every", 4),
  };
  const port = argNumber("--port", 8941);
  const clkTck = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf-8" }).trim());
  const msPerTick = 1000 / clkTck;
  const dir = mkdtempSync(path.join(tmpdir(), "keiba-migration-measure-"));
  const filePath = argString("--keep-file") ?? path.join(dir, "migration.ndjson.gz");

  // 1. 合成ファイルを作る(行を 1 つずつ gzip に流す。全体をメモリに載せない)。
  let rawBytes = 0;
  let lineCount = 0;
  await new Promise<void>((resolve, reject) => {
    const gzip = createGzip({ level: 6 });
    const out = createWriteStream(filePath);
    gzip.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    for (const line of syntheticLines(options)) {
      const chunk = `${line}\n`;
      rawBytes += Buffer.byteLength(chunk);
      lineCount += 1;
      gzip.write(chunk);
    }
    gzip.end();
  });
  const gzBytes = statSync(filePath).size;
  console.log(`## 合成ファイル: 分析 ${options.analyses} 件(馬 ${options.horses} 頭・買い目 ${options.bets} 件・組合せ全部入りの snapshot は ${options.comboEvery} 件に 1 件)・結果 ${options.results} レース`);
  console.log(`  行数 ${lineCount}、展開後 ${(rawBytes / 1e6).toFixed(1)}MB、gzip ${(gzBytes / 1e6).toFixed(1)}MB(圧縮率 ${(rawBytes / gzBytes).toFixed(1)}:1)`);

  // 2. 本番の worker.ts を wrangler dev --local で起動する(ctx.access を注入。DO の上限は環境変数で 10 万行/日に)。
  const stateDir = path.join(dir, "state");
  const configPath = path.join(CLOUD, "wrangler.measure.generated.toml");
  const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
  writeFileSync(configPath, `${base}\n[access.dev]\naud = "measure-aud"\n\n[access.dev.identity]\nemail = "owner@example.com"\n`);
  const env = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  execFileSync(path.join(CLOUD, "node_modules", ".bin", "wrangler"), ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir, "--config", configPath], { cwd: CLOUD, env, stdio: "pipe", timeout: 120_000 });
  const child = spawn(
    path.join(CLOUD, "node_modules", ".bin", "wrangler"),
    ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", stateDir, "--config", configPath,
      "--var", "ACCESS_TEAM_NAME:measure", "--var", "ACCESS_AUD:measure-aud", "--var", "ACCESS_ALLOWED_EMAIL:owner@example.com", "--var", "MIGRATION_DAILY_ROW_LIMIT:100000"],
    { cwd: CLOUD, stdio: ["ignore", "pipe", "pipe"], detached: true, env },
  );
  let logs = "";
  child.stdout.on("data", (d: Buffer) => (logs += d.toString()));
  child.stderr.on("data", (d: Buffer) => (logs += d.toString()));
  const stop = (): void => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // すでに終了。
    }
  };
  process.on("exit", stop);
  try {
    for (let i = 0; ; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
        break;
      } catch {
        if (i > 90) throw new Error(`wrangler dev が起動しませんでした\n${logs.slice(-2000)}`);
        await sleep(1000);
      }
    }
    const origin = `http://127.0.0.1:${port}`;
    const status = async (): Promise<StatusView> => (await (await fetch(`${origin}/api/migration`, { signal: AbortSignal.timeout(30_000) })).json()) as StatusView;

    // 3. upload。前後の CPU を読む。
    const c0 = workerdTicks(child.pid!);
    const t0 = Date.now();
    const body = readFileSync(filePath);
    const res = await fetch(`${origin}/api/migration/upload`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/gzip" }, body, signal: AbortSignal.timeout(120_000) });
    const t1 = Date.now();
    const c1 = workerdTicks(child.pid!);
    if (res.status !== 202) throw new Error(`upload が ${res.status}: ${(await res.text()).slice(0, 300)}`);
    console.log(`\n## upload(本文 ${(gzBytes / 1e6).toFixed(1)}MB を R2 にそのまま置く): ${t1 - t0}ms、workerd の CPU ${((c1 - c0) * msPerTick).toFixed(0)}ms(検証の開始と重なる分を含む)`);

    // 4. 観測: 100ms ごとに status と CPU を読む。lastTick.at が変わるたびに 1 tick を記録する。
    const ticks: Array<{ n: number; offsetFraction: number; wallMs: number; cpuMs: number; queries: number; rows: number; lines: number; analyses: number; results: number }> = [];
    let verifyCpuMs: number | null = null;
    let verified: StatusView["verified"] = null;
    let lastSeenAt: string | null = null;
    let cpuBeforeTick = c1;
    let rowsAtAnalysesDone: number | null = null;
    let last: StatusView | null = null;
    const startedAll = Date.now();
    for (;;) {
      const s = await status();
      const cpuNow = workerdTicks(child.pid!);
      last = s;
      if (verified === null && s.verified !== null) {
        verified = s.verified;
        verifyCpuMs = (cpuNow - c1) * msPerTick;
        cpuBeforeTick = cpuNow;
      }
      if (s.lastTick !== null && s.lastTick.at !== lastSeenAt) {
        lastSeenAt = s.lastTick.at;
        const processedLines = s.analyses.processed + s.results.processed;
        const totalLines = (s.analyses.total ?? 0) + (s.results.total ?? 0);
        ticks.push({
          n: ticks.length + 1,
          offsetFraction: totalLines === 0 ? 0 : processedLines / totalLines,
          wallMs: s.lastTick.ms,
          cpuMs: (cpuNow - cpuBeforeTick) * msPerTick,
          queries: s.lastTick.queries,
          rows: s.lastTick.rows,
          lines: s.lastTick.lines,
          analyses: s.analyses.processed,
          results: s.results.processed,
        });
        cpuBeforeTick = cpuNow;
        if (rowsAtAnalysesDone === null && s.analyses.total !== null && s.analyses.processed >= s.analyses.total) {
          rowsAtAnalysesDone = s.budget.usedRows;
        }
      }
      if (s.state === "completed" || s.state === "failed" || s.state === "waiting-budget" || s.state === "waiting-r2") break;
      if (Date.now() - startedAll > 3 * 3600_000) throw new Error("3 時間経っても終わらない");
      await sleep(100);
    }
    const s = last!;
    console.log(`\n## 終了時の状態: ${s.state}${s.failure === null ? "" : ` ${JSON.stringify(s.failure)}`}(経過 ${((Date.now() - startedAll) / 1000).toFixed(0)}秒)`);
    console.log(`  分析 ${JSON.stringify(s.analyses)}、結果 ${JSON.stringify(s.results)}、D1 の書き込み行数の使用量 ${s.budget.usedRows}(上限 ${s.budget.limitRows})`);

    console.log("\n## (i) 検証パス(ファイル全体を 1 回流してフッタまで通す。1 回のアラーム)");
    if (verified !== null) {
      console.log(`  壊れていないか全行を JSON.parse・検証・変換: 展開後 ${(verified.bytes / 1e6).toFixed(1)}MB・${verified.lines} 行、壁時計 ${verified.ms}ms、workerd の CPU ${verifyCpuMs?.toFixed(0)}ms(upload の応答の後から、状態が importing になるまでの増分)`);
    } else {
      console.log("  検証の実績が取れなかった");
    }

    console.log("\n## (ii) 取り込みの 1 回のアラーム(tick)。位置(処理済みの行の割合)で 5 区間に分けた壁時計 ms(DO の lastTick.ms)と workerd の CPU ms");
    const bins = 5;
    for (let b = 0; b < bins; b += 1) {
      const part = ticks.filter((t) => t.offsetFraction >= b / bins && (b === bins - 1 ? t.offsetFraction <= 1 : t.offsetFraction < (b + 1) / bins));
      const wall = part.map((t) => t.wallMs).sort((x, y) => x - y);
      const cpu = part.map((t) => t.cpuMs).sort((x, y) => x - y);
      console.log(`  位置 ${Math.round((b / bins) * 100)}〜${Math.round(((b + 1) / bins) * 100)}%: tick ${part.length} 回、壁時計 中央値 ${quantile(wall, 0.5)}ms・p95 ${quantile(wall, 0.95)}ms・最大 ${wall[wall.length - 1]}ms、CPU 中央値 ${quantile(cpu, 0.5).toFixed(0)}ms・最大 ${cpu[cpu.length - 1]?.toFixed(0)}ms`);
    }
    const tail = ticks.slice(-10);
    console.log(`  終盤の最後の ${tail.length} tick: 壁時計 ${tail.map((t) => t.wallMs).join(",")} ms、CPU ${tail.map((t) => t.cpuMs.toFixed(0)).join(",")} ms(位置 ${(tail[0]?.offsetFraction ?? 0).toFixed(2)}〜${(tail[tail.length - 1]?.offsetFraction ?? 0).toFixed(2)})`);
    console.log(`  1 tick の問い合わせ数(D1 の文+R2): 最大 ${Math.max(...ticks.map((t) => t.queries))}(上限 40)、tick 数 ${ticks.length}`);

    console.log("\n## (iii) D1 の書き込み行数(meta.rows_written の合計。索引・カウンタを含む)");
    const analysisTicks = ticks.filter((t) => t.results === 0);
    const analysisRows = analysisTicks.reduce((n, t) => n + t.rows, 0);
    const analysisLines = analysisTicks.reduce((n, t) => n + t.lines, 0);
    const tickOverhead = analysisTicks.length; // tick ごとの R2 読み出しの計上(1 行)
    console.log(`  分析: ${analysisLines} 件で ${analysisRows} 行(tick ごとの読み出しの計上 ${tickOverhead} 行を除くと 1 件あたり ${((analysisRows - tickOverhead) / Math.max(1, analysisLines)).toFixed(1)} 行。馬 ${options.horses} 頭・買い目 ${options.bets} 件)`);
    console.log(`  期待値の式(rows-written.test.ts と同じ): 1(カウンタ)+ 8(analyses)+ 1(detail_key)+ 2(exe の id)+ 2×馬 + 1(メタ)+ 2×買い目 = ${1 + 8 + 1 + 2 + 2 * options.horses + 1 + 2 * options.bets}`);
    if (rowsAtAnalysesDone !== null) {
      const resultRows = s.budget.usedRows - rowsAtAnalysesDone;
      console.log(`  結果: ${s.results.processed} レースで ${resultRows} 行(1 レースあたり ${(resultRows / Math.max(1, s.results.processed)).toFixed(1)} 行。tick の読み出しの計上を含む)`);
    }
  } finally {
    stop();
    process.off("exit", stop);
    rmSync(configPath, { force: true });
    if (argString("--keep-file") === null) rmSync(dir, { recursive: true, force: true });
    await sleep(1000);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
