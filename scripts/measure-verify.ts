/**
 * クラウド版の検証の集計(Issue #219)の実測スクリプト。実際の規模に近い**合成データ**(既定: 分析 2,225 件・結果 1,301 レース。本番の移行の件数)を、ローカルの D1・R2 に
 * **本番と同じ保存の関数**(`D1AnalysisStore.saveAnalysis`・`D1ResultStore.saveResult`)で入れ、ローカルの workerd(`wrangler dev --local`。本番の `src/worker.ts`)の
 * 検証の DO `VerifyReportDO` を `GET /api/verify` で動かして測る。再現手順をコミット済みのコードに残すため(CLAUDE.md「再現手段のない数値を書かない」)。
 *
 * 測るもの:
 *  (i) 発走時刻の補完(`start_time` が NULL の全件を R2 の詳細から写す): 準備中の応答の回数・全体の壁時計・workerd の CPU 時間
 *  (ii) 集計の再計算(`refresh=1`)の繰り返し: 1 回あたりの D1 の読み取り行数(D1 が報告する `meta.rows_read` の合計。DO が応答の `diag.rowsRead` に出す)・表ごとの行数・
 *       D1 の読みの壁時計(`diag.readMs`)・3 区分の集計の壁時計(`diag.computeMs`)・workerd の CPU 時間(`/proc/<pid>/stat` の utime+stime。刻み 10ms)
 *  (iii) キャッシュのヒット時の呼び出し: 壁時計・CPU(D1 は透かしと補完待ちの確認の 2 クエリ)
 *
 * 合成データ: 詳細(race_snapshot_json・contributions_json・raw_response)は `scripts/measure-d1-size.ts` と同じ実フィクスチャ(中央 16 頭の 202603020211・LLM の実応答 36 本)から作り、
 * 小数の値を固定の種で別の値にする(`measure-migration-import.ts` と同じ)。**乱数は固定の種で、同じ引数なら同じデータ**。分析の `historyCutoffDate` は `--legacy-ratio`(既定 0.7)の割合で NULL
 * (旧い exe 由来の遮断なし=先読み判定が発走時刻を読む行)。レース ID は中央 70%・地方 30%(区分の絞り込みが効く形)。1 レースに平均 1.7 件の分析。
 * 買い目の件数は **本番の `analysis_bets` の実数が未確認**なので `--bets`(既定 12)で変えて測る(読み取り行数の最大の不確定要素)。
 *
 * 使い方(リポジトリのルートで。Linux のみ。/proc を使う):
 *   pnpm tsx scripts/measure-verify.ts [--analyses 2225] [--results 1301] [--horses 13] [--bets 12] [--legacy-ratio 0.7] [--repeat 5] [--port 8942]
 *
 * 限界:
 *  - **この機械の CPU の速度・ローカルの D1(miniflare の SQLite)での値**。Cloudflare の本番の CPU・D1 の遅延とは一致しない。ローカルの workerd は CPU 上限を強制しない(使う量の測定であり、本番の上限の判定ではない)。
 *  - ローカルの D1 の `meta.rows_read` が本番と同じ数え方かは未確認(SQLite の走査した行数を返す前提)。本番の値は、デプロイ後の最初の `GET /api/verify` の `diag.rowsRead` で確かめる。
 *  - 1 回の実行の値。繰り返し(`--repeat`)の最小〜最大を出すが、下位桁に意味を読まないこと。CPU は 10ms の刻みで丸まる。
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { encodeDetail } from "../cloud/src/analysis-detail.js";
import {
  allocationBetParams,
  allocationMetaParams,
  analysisParams,
  comboPayoutParams,
  horseParams,
  INSERT_ALLOCATION_BET_SQL,
  INSERT_ALLOCATION_META_SQL,
  INSERT_ANALYSIS_HORSE_SQL,
  INSERT_ANALYSIS_SQL,
  INSERT_COMBO_PAYOUT_SQL,
  MARK_COMBO_IMPORTED_SQL,
  planComboWrites,
  raceResultParams,
  UPSERT_RACE_RESULT_META_SQL,
  UPSERT_RACE_RESULT_SQL,
} from "../packages/core/src/ev/analysis-store-codec.js";
import type { AnalysisRecord, RaceComboPayoutsSaveInput, RaceResultEntry } from "../packages/core/src/ev/analysis-store-types.js";
import { buildComboOddsKeyFor, type ComboBetType } from "../packages/core/src/scraper/combo-odds-key.js";
import { buildDetailText } from "./measure-d1-size.js";
import { descendantsOf, parseProcStat } from "./measure-worker-cpu.js";
import { perturbDecimals, seededRandom } from "./measure-migration-import.js";

/** ローカルの D1・R2 のうち、シードに使う部分だけ(wrangler の `getPlatformProxy` の env。cloud の型を root の型検査に持ち込まないため、最小の形を自前で宣言する)。 */
interface SeedStatement {
  bind(...values: unknown[]): SeedStatement;
  first<T>(): Promise<T | null>;
}
interface SeedD1 {
  prepare(sql: string): SeedStatement;
  batch(statements: SeedStatement[]): Promise<Array<{ meta: { last_row_id: number } }>>;
}
interface SeedR2 {
  put(key: string, value: Uint8Array): Promise<unknown>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLOUD = path.join(ROOT, "cloud");
const RESPONSES_DIR = path.join(ROOT, "docs", "investigations", "probability-quality-41-llm", "responses");

export interface SyntheticVerifyOptions {
  readonly analyses: number;
  readonly results: number;
  readonly horses: number;
  readonly bets: number;
  readonly legacyRatio: number;
}

const COMBO_TYPES: readonly ComboBetType[] = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"];
const COMBO_SIZE: Record<string, number> = { wide: 2, trio: 3, quinella: 2, exacta: 2, trifecta: 3, bracketQuinella: 2 };

/** 中央 70%・地方 30% のレース ID(12 桁)。`index` から決定的に作る。 */
export function syntheticRaceId(index: number): string {
  if (index % 10 < 7) {
    const place = String(1 + (index % 10)).padStart(2, "0");
    const day = String(1 + (index % 8)).padStart(2, "0");
    const race = String(1 + (index % 12)).padStart(2, "0");
    return `2025${place}0${1 + (Math.floor(index / 120) % 5)}${day}${race}`;
  }
  const mmdd = `${String(1 + (Math.floor(index / 300) % 12)).padStart(2, "0")}${String(1 + (index % 28)).padStart(2, "0")}`;
  return `202544${mmdd}${String(1 + (index % 12)).padStart(2, "0")}`;
}

/** 合成した分析の列。`results` 件のレースに分析を割り当てる(1 レースに複数回)。 */
export function* syntheticAnalyses(options: SyntheticVerifyOptions): Generator<AnalysisRecord> {
  const rand = seededRandom(20261010);
  const detail = JSON.parse(buildDetailText()) as { raceSnapshot: Record<string, unknown>; rawResponse: string };
  const responses = readdirSync(RESPONSES_DIR).sort().map((f) => readFileSync(path.join(RESPONSES_DIR, f), "utf-8"));
  const comboKeys = Object.keys(detail.raceSnapshot).filter((k) => k.endsWith("Combo"));
  const lightSnapshot = JSON.stringify(Object.fromEntries(Object.entries(detail.raceSnapshot).filter(([k]) => !comboKeys.includes(k))));
  for (let i = 1; i <= options.analyses; i += 1) {
    const raceId = syntheticRaceId(i % options.results);
    const kaisai = raceId.startsWith("202544") ? `2025${raceId.slice(6, 10)}` : "20250105";
    const legacy = rand() < options.legacyRatio;
    const snapshot = JSON.parse(perturbDecimals(lightSnapshot, rand)) as { race?: Record<string, unknown> };
    snapshot.race = { ...(snapshot.race ?? {}), startTime: ["10:05", "15:45", "20:50"][i % 3] };
    const analyzedAtMs = Date.UTC(2025, 0, 5, 3, 0, 0) + (i % 5 === 0 ? 8 : -3) * 3_600_000 + i * 1000;
    yield {
      raceId,
      analyzedAt: new Date(analyzedAtMs).toISOString(),
      evEstimated: i % 40 === 0,
      promptVersion: i % 6 === 0 ? null : "v8",
      additionalInstruction: null,
      kaisaiDate: i % 25 === 0 ? null : kaisai,
      model: "claude-sonnet-5-5",
      rawResponse: responses[i % responses.length]!,
      raceSnapshot: snapshot,
      historyCutoffDate: legacy ? null : kaisai,
      promptLookaheadGuarded: legacy ? null : true,
      horses: Array.from({ length: options.horses }, (_, k) => ({
        umaban: k + 1,
        prior: 0.05 + rand() * 0.4,
        adjustedProb: 0.05 + rand() * 0.4,
        placeOddsMin: 1.1 + rand() * 10,
        ev: rand() * 2,
        isPositive: rand() < 0.3,
        contributions: { biases: { trackCondition: rand(), venue: rand() }, baseScore: { recentForm: rand() } },
        mark: (["◎", "〇", "▲", "△", null] as const)[k % 5] ?? null,
        reason: "近走の内容が良く、距離適性もある。",
        highlights: ["近走の内容が良い", "距離適性あり"],
        concerns: ["斤量増"],
      })),
      allocation: {
        meta: {
          route: i % 9 === 0 ? "unset" : i % 11 === 0 ? "place-only" : "mixed",
          unavailableReason: null, fallbackReason: null, skipReasonCode: i % 13 === 0 ? "no-candidates" : null, comboOddsWide: "available", comboOddsTrio: "available",
          bankroll: 10000, perRaceCap: 2000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: true, includeWide: true, includeTrio: true, includeQuinella: true, includeExacta: true,
          includeTrifecta: true, includeBracketQuinella: true, betUnit: 100, greedySteps: 50, candidateCap: 200, modelId: "m", modelApproximate: false, oddsStatus: "result",
        },
        bets: Array.from({ length: options.bets }, (_, b) => {
          const type = (["place", "win", ...COMBO_TYPES] as const)[b % 8]!;
          const umabans = type === "place" || type === "win" ? [1 + ((b + i) % options.horses)] : Array.from({ length: COMBO_SIZE[type]! }, (_, k) => 1 + ((b * 3 + k * 5 + i) % options.horses));
          const comboKey = type === "place" || type === "win" ? String(umabans[0]).padStart(2, "0") : buildComboOddsKeyFor(type, [...new Set(umabans)].length === umabans.length ? umabans : [1, 2, 3].slice(0, COMBO_SIZE[type]));
          return { betType: type, comboKey, stake: 100, odds: 5.5, ev: 1.2 };
        }).filter((b, idx, all) => all.findIndex((x) => x.betType === b.betType && x.comboKey === b.comboKey) === idx),
      },
    };
  }
}

/** 合成した結果(1 レース)。 */
export function syntheticResult(index: number, rand: () => number): { raceId: string; entries: RaceResultEntry[]; combo: RaceComboPayoutsSaveInput } {
  const raceId = syntheticRaceId(index);
  const n = 14 + (index % 5);
  const entries: RaceResultEntry[] = Array.from({ length: n }, (_, k) => ({
    umaban: k + 1, finishPosition: k + 1, placePayout: k < 3 ? 150 + k * 40 : null, winPayout: k === 0 ? 380 : null, passing: [3, 3, 2, 1], last3f: 34 + rand(),
  }));
  const combo: Record<string, { state: "parsed"; payouts: Array<{ umabans: number[]; payout: number }> }> = {};
  COMBO_TYPES.forEach((type, ti) => {
    combo[type] = {
      state: "parsed",
      payouts: (ti === 0 ? [0, 1, 2] : [0]).map((j) => ({ umabans: Array.from({ length: COMBO_SIZE[type]! }, (_, k) => 1 + ((j + k * 2) % 8)), payout: 500 + ti * 100 + j })),
    };
  });
  return { raceId, entries, combo: combo as RaceComboPayoutsSaveInput };
}

// ---------------------------------------------------------------------------
// 以下は実行(Linux の /proc と wrangler dev を使う)
// ---------------------------------------------------------------------------

function argNumber(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
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

interface VerifyView {
  ok: boolean;
  status: "ready" | "preparing" | "throttled";
  remaining?: number;
  stale?: boolean;
  staleReason?: string | null;
  computedAt?: string;
  report?: { includedAnalysisCount: number; excludedLookaheadSuspectCount: number; excludedLookaheadUnknownCount: number; proposedBet: { overall: { betCount: number } } };
  diag?: { rowsRead: number; counts: Record<string, number>; readMs: number; computeMs: number; startTimeGaps: { lost: number; affecting: number } };
}

const range = (xs: readonly number[]): string => (xs.length === 0 ? "-" : `${Math.min(...xs)}〜${Math.max(...xs)}`);

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("このスクリプトは Linux(/proc)でだけ動きます");
  const options: SyntheticVerifyOptions = {
    analyses: argNumber("--analyses", 2225),
    results: argNumber("--results", 1301),
    horses: argNumber("--horses", 13),
    bets: argNumber("--bets", 12),
    legacyRatio: argNumber("--legacy-ratio", 0.7),
  };
  const repeat = argNumber("--repeat", 5);
  const port = argNumber("--port", 8942);
  const clkTck = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf-8" }).trim());
  const msPerTick = 1000 / clkTck;
  const dir = mkdtempSync(path.join(tmpdir(), "keiba-verify-measure-"));
  const stateDir = path.join(dir, "state");
  const configPath = path.join(CLOUD, "wrangler.measure-verify.generated.toml");
  const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
  writeFileSync(configPath, `${base}\n[access.dev]\naud = "measure-aud"\n\n[access.dev.identity]\nemail = "owner@example.com"\n`);
  const env = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  const wrangler = path.join(CLOUD, "node_modules", ".bin", "wrangler");
  let child: ReturnType<typeof spawn> | null = null;
  const stop = (): void => {
    if (child?.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // すでに終了。
      }
    }
  };
  process.on("exit", stop);
  try {
    // 1. migration を適用し、本番と同じ保存の関数で合成データを入れる(D1 の書き込みの上限は、ローカルでは強制されない)。
    execFileSync(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir, "--config", configPath], { cwd: CLOUD, env, stdio: "pipe", timeout: 120_000 });
    // wrangler は cloud/node_modules にある(root には無い)。cloud の package.json から解決する。
    const { getPlatformProxy } = createRequire(path.join(CLOUD, "package.json"))("wrangler") as {
      getPlatformProxy(options: { configPath: string; persist: { path: string } }): Promise<{ env: { DB: SeedD1; ANALYSIS_DETAIL: SeedR2 }; dispose(): Promise<void> }>;
    };
    const proxy = await getPlatformProxy({ configPath, persist: { path: path.join(stateDir, "v3") } });
    const db = proxy.env.DB;
    const seedStarted = Date.now();
    let saved = 0;
    for (const rec of syntheticAnalyses(options)) {
      // 本番の保存(analysis-repository.ts の buildSaveStatements)と同じ文・同じ束縛値(codec)。id を先に採番してから、子と詳細の参照を 1 回の batch で書く。
      const [inserted] = await db.batch([db.prepare(INSERT_ANALYSIS_SQL).bind(...analysisParams({ ...rec, rawResponse: null, raceSnapshot: null }))]);
      const id = inserted!.meta.last_row_id;
      const statements: SeedStatement[] = [db.prepare("UPDATE analyses SET detail_key = ? WHERE id = ?").bind(`analyses/${id}.json.gz`, id)];
      for (const h of rec.horses) statements.push(db.prepare(INSERT_ANALYSIS_HORSE_SQL).bind(...horseParams(id, { ...h, contributions: null })));
      if (rec.allocation !== undefined) {
        statements.push(db.prepare(INSERT_ALLOCATION_META_SQL).bind(...allocationMetaParams(id, rec.allocation.meta)));
        for (const b of rec.allocation.bets) statements.push(db.prepare(INSERT_ALLOCATION_BET_SQL).bind(...allocationBetParams(id, b)));
      }
      await db.batch(statements);
      await proxy.env.ANALYSIS_DETAIL.put(`analyses/${id}.json.gz`, encodeDetail(rec));
      saved += 1;
    }
    const rand = seededRandom(7);
    for (let r = 0; r < options.results; r += 1) {
      const { raceId, entries, combo } = syntheticResult(r, rand);
      const statements: SeedStatement[] = entries.map((e) => db.prepare(UPSERT_RACE_RESULT_SQL).bind(...raceResultParams(raceId, e)));
      statements.push(db.prepare(UPSERT_RACE_RESULT_META_SQL).bind(raceId, "芝"));
      for (const { betType, payouts } of planComboWrites(combo)) {
        for (const entry of payouts) statements.push(db.prepare(INSERT_COMBO_PAYOUT_SQL).bind(...comboPayoutParams(raceId, betType, entry)));
        statements.push(db.prepare(MARK_COMBO_IMPORTED_SQL).bind(raceId, betType));
      }
      await db.batch(statements);
    }
    const tableCounts: Record<string, number> = {};
    for (const table of ["analyses", "analysis_horses", "analysis_allocation_meta", "analysis_bets", "race_results", "race_combo_payouts", "race_combo_payout_imports"]) {
      tableCounts[table] = (await db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c;
    }
    await proxy.dispose();
    console.log(`## 合成データ(本番と同じ保存の関数で投入。${((Date.now() - seedStarted) / 1000).toFixed(0)}秒): 分析 ${saved} 件(馬 ${options.horses} 頭・買い目 ${options.bets} 件・遮断なしの旧い形 ${(options.legacyRatio * 100).toFixed(0)}%)・結果 ${options.results} レース`);
    console.log(`  表の行数: ${JSON.stringify(tableCounts)}`);

    // 2. 本番の worker.ts を wrangler dev --local で起動する(最短間隔は 1ms に、1 日の上限は既定の 24 のまま)。
    child = spawn(wrangler, ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", stateDir, "--config", configPath,
      "--var", "ACCESS_TEAM_NAME:measure", "--var", "ACCESS_AUD:measure-aud", "--var", "ACCESS_ALLOWED_EMAIL:owner@example.com", "--var", "VERIFY_MIN_INTERVAL_MS:1"],
    { cwd: CLOUD, stdio: ["ignore", "pipe", "pipe"], detached: true, env });
    let logs = "";
    child.stdout?.on("data", (d: Buffer) => (logs += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (logs += d.toString()));
    for (let i = 0; ; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
        break;
      } catch {
        if (i > 90) throw new Error(`wrangler dev が起動しませんでした\n${logs.slice(-2000)}`);
        await sleep(1000);
      }
    }
    const pid = child.pid!;
    const origin = `http://127.0.0.1:${port}`;
    const call = async (query: string): Promise<{ view: VerifyView; wallMs: number; cpuMs: number }> => {
      const c0 = workerdTicks(pid);
      const t0 = Date.now();
      const res = await fetch(`${origin}/api/verify${query}`, { signal: AbortSignal.timeout(300_000) });
      const view = (await res.json()) as VerifyView;
      const t1 = Date.now();
      return { view, wallMs: t1 - t0, cpuMs: (workerdTicks(pid) - c0) * msPerTick };
    };

    // 3. (i) 発走時刻の補完: 準備中でなくなるまで 500ms ごとに呼ぶ。
    const c0 = workerdTicks(pid);
    const started = Date.now();
    let polls = 0;
    let firstRemaining: number | null = null;
    let first: VerifyView | null = null;
    for (;;) {
      const { view } = await call("?venue=all");
      polls += 1;
      if (view.status === "preparing") {
        firstRemaining ??= view.remaining ?? null;
      } else {
        first = view;
        break;
      }
      if (Date.now() - started > 30 * 60_000) throw new Error("30 分経っても準備が終わらない");
      await sleep(500);
    }
    const backfillWall = Date.now() - started;
    const backfillCpu = (workerdTicks(pid) - c0) * msPerTick;
    console.log(`\n## (i) 発走時刻の補完 + 最初の集計(最初の呼び出しから ready まで)`);
    console.log(`  補完待ち ${firstRemaining} 件 → 壁時計 ${(backfillWall / 1000).toFixed(1)}秒、呼び出し ${polls} 回(500ms おきのポーリング)、workerd の CPU 合計 ${backfillCpu.toFixed(0)}ms(最初の集計の計算を含む)`);
    console.log(`  最初の集計: ${JSON.stringify(first?.diag)}`);

    // 4. (ii) 再計算を繰り返す。
    const rows: number[] = [];
    const reads: number[] = [];
    const computes: number[] = [];
    const walls: number[] = [];
    const cpus: number[] = [];
    let lastView: VerifyView | null = null;
    for (let i = 0; i < repeat; i += 1) {
      const { view, wallMs, cpuMs } = await call("?venue=all&refresh=1");
      if (view.status !== "ready" || view.stale === true || view.diag === undefined) throw new Error(`再計算できなかった: ${JSON.stringify(view).slice(0, 300)}`);
      rows.push(view.diag.rowsRead);
      reads.push(view.diag.readMs);
      computes.push(view.diag.computeMs);
      walls.push(wallMs);
      cpus.push(cpuMs);
      lastView = view;
      await sleep(50);
    }
    console.log(`\n## (ii) 集計の再計算(refresh=1)を ${repeat} 回`);
    console.log(`  D1 の読み取り行数(meta.rows_read の合計): ${range(rows)} 行/回。表ごとの行数: ${JSON.stringify(lastView?.diag?.counts)}`);
    console.log(`  D1 の読み ${range(reads)}ms、3 区分の集計 ${range(computes)}ms、呼び出し全体の壁時計 ${range(walls)}ms、workerd の CPU ${range(cpus.map((c) => Math.round(c)))}ms(10ms 刻み)`);
    console.log(`  集計の中身(区分 all): 集計 ${lastView?.report?.includedAnalysisCount} 件・先読み疑いで除外 ${lastView?.report?.excludedLookaheadSuspectCount} 件・判定不能で除外 ${lastView?.report?.excludedLookaheadUnknownCount} 件・配分ベースの点数 ${lastView?.report?.proposedBet.overall.betCount}`);

    // 5. (iii) キャッシュのヒット(最短間隔 1ms でも、透かしが同じで TTL 内ならヒット)。
    const hitWalls: number[] = [];
    const hitCpus: number[] = [];
    for (let i = 0; i < repeat; i += 1) {
      const { view, wallMs, cpuMs } = await call("?venue=central");
      if (view.status !== "ready" || view.stale === true) throw new Error(`ヒットしなかった: ${JSON.stringify(view).slice(0, 300)}`);
      hitWalls.push(wallMs);
      hitCpus.push(Math.round(cpuMs));
    }
    console.log(`\n## (iii) キャッシュのヒット(venue=central)を ${repeat} 回: 壁時計 ${range(hitWalls)}ms、workerd の CPU ${range(hitCpus)}ms`);
  } finally {
    stop();
    process.off("exit", stop);
    rmSync(configPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
    await sleep(1000);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
