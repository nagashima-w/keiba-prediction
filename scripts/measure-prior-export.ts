/**
 * クラウド版の「統計モデル用の書き出し」(Issue #266)の実測スクリプト。実際の規模に近い**合成データ**(既定: 分析 2,225 件・結果 1,301 レース・1 レース 14 頭。本番の移行の件数と #258 の概算)を、
 * ローカルの D1・R2 に**本番と同じ保存の関数**(`D1AnalysisStore.saveAnalysis` の文・codec)で入れ、ローカルの workerd(`wrangler dev --local`。本番の `src/worker.ts`)の書き出しの DO
 * `PriorExportDO` を `GET /api/export/prior-dataset` で動かして測る。再現手順をコミット済みのコードに残すため(CLAUDE.md「再現手段のない数値を書かない」)。
 *
 * 測るもの:
 *  (i) 作成(refresh を含めて `--repeat` 回): 作成の壁時計(最初の要求から ready まで)・要求の回数(ポーリング)・workerd の CPU 時間(`/proc/<pid>/stat` の utime+stime。刻み 10ms)・
 *      DO が数えた D1 の読み取り行数(`meta.rows_read` の合計。状態の `file.diag.rowsRead`)・R2 の取得を試みた回数(`file.diag.gets`)・ファイルの大きさ(gzip 後)
 *  (ii) ダウンロード: 壁時計・workerd の CPU(Worker が R2 の本体を流すだけ)・本体のバイト数・展開後のバイト数と、開発側のローダ(`scripts/prior-dataset.ts`)で全行を読めること・
 *       自由文(reason)が含まれないこと
 *
 * 合成データ: 詳細(race_snapshot_json・raw_response)は `scripts/measure-d1-size.ts` と同じ実フィクスチャ・LLM の実応答 36 本から作り、寄与度(contributions)は本番の形(core の `ScoreContribution` の
 * 13 項目の配列)の合成({@link syntheticContributions})に差し替える。分析・結果・レース ID は `scripts/measure-verify.ts` の合成(`syntheticAnalyses`・`syntheticRaceId`)をそのまま使う
 * (遮断なしの旧い形の割合は `--legacy-ratio`、既定 0.7。**本番の実数は未確認**)。結果には確定の単勝オッズ・人気(Issue #259)を入れる。**乱数は固定の種で、同じ引数なら同じデータ**。
 *
 * 使い方(リポジトリのルートで。Linux のみ。/proc を使う):
 *   pnpm tsx scripts/measure-prior-export.ts [--analyses 2225] [--results 1301] [--horses 14] [--legacy-ratio 0.7] [--repeat 1] [--port 8943]
 *   `--repeat` は 1 日の上限(3 回。DO の既定)を超えられない。
 *
 * 限界:
 *  - **この機械の CPU の速度・ローカルの D1(miniflare の SQLite)での値**。Cloudflare の本番の CPU・D1 の遅延とは一致しない。ローカルの workerd は CPU 上限を強制しない(使う量の測定であり、本番の上限の判定ではない)。
 *  - ローカルの D1 の `meta.rows_read` が本番と同じ数え方かは未確認(主キーの索引を引く文は、返した行数より多く数えられる。例: 4 行を返す文で 9〜10)。本番の値は、最初の作成の `?status=1` の `file.diag.rowsRead` で確かめる。
 *  - 1 回の実行の値。下位桁に意味を読まないこと。CPU は 10ms の刻みで丸まる。
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { encodeDetail } from "../cloud/src/analysis-detail.js";
import {
  analysisParams,
  horseParams,
  INSERT_ANALYSIS_HORSE_SQL,
  INSERT_ANALYSIS_SQL,
  raceResultParams,
  UPSERT_RACE_RESULT_META_SQL,
  UPSERT_RACE_RESULT_SQL,
} from "../packages/core/src/ev/analysis-store-codec.js";
import { syntheticAnalyses, syntheticResult, type SyntheticVerifyOptions } from "./measure-verify.js";
import { descendantsOf, parseProcStat } from "./measure-worker-cpu.js";
import { seededRandom } from "./measure-migration-import.js";
import { parsePriorDataset, summarize } from "./prior-dataset.js";

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

/** 本番の寄与度ログ(core の `ScoreContribution` の配列)の 13 項目の名前(基礎 6 + バイアス 7)。 */
const BIAS_NAMES = ["近走着順", "上がり3F", "コース・距離適性", "騎手当該コース", "斤量", "距離・コース面", "馬場状態", "競馬場", "季節", "枠順", "夏の疲労", "輸送", "ローテーション"] as const;

/** 合成した馬 1 頭の寄与度ログ(13 項目。`reason` の自由文つき。書き出しはこれを落とす)。値は乱数(同じ値の繰り返しで圧縮率が実物より良くならないよう、全精度の小数)。 */
export function syntheticContributions(rand: () => number): unknown[] {
  return BIAS_NAMES.map((biasName, j) => {
    const applied = rand() > 0.25;
    const rate = j < 5;
    return {
      biasName,
      applied,
      reason: applied ? `${biasName}の実績から補正(サンプル${Math.floor(rand() * 30)}走)` : `${biasName}のデータ不足のため補正なし`,
      weight: [0.1, 0.15, 0.2, 0.3][j % 4]!,
      correction: applied ? (rand() - 0.4) * 0.12 : 0,
      ...(rate ? { sampleCount: Math.floor(rand() * 30), targetRate: applied ? rand() : null, overallRate: 0.33 } : {}),
    };
  });
}

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

interface ExportView {
  status: string;
  phase?: string;
  racesDone?: number;
  races?: number | null;
  file?: { generatedAt: string; rows: number; races: number; missingDetail: number; excluded: Record<string, number>; bytes: number; diag: { rowsRead: number; gets: number } } | null;
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("このスクリプトは Linux(/proc)でだけ動きます");
  const options: SyntheticVerifyOptions = {
    analyses: argNumber("--analyses", 2225),
    results: argNumber("--results", 1301),
    horses: argNumber("--horses", 14),
    bets: 0,
    legacyRatio: argNumber("--legacy-ratio", 0.7),
    versions: 1,
    instructionLength: 0,
  };
  const repeat = argNumber("--repeat", 1);
  const port = argNumber("--port", 8943);
  const clkTck = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf-8" }).trim());
  const msPerTick = 1000 / clkTck;
  const dir = mkdtempSync(path.join(tmpdir(), "keiba-prior-export-measure-"));
  const stateDir = path.join(dir, "state");
  const configPath = path.join(CLOUD, "wrangler.measure-prior-export.generated.toml");
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
    // 1. migration を適用し、本番と同じ保存の文・束縛値(codec)で合成データを入れる。
    execFileSync(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir, "--config", configPath], { cwd: CLOUD, env, stdio: "pipe", timeout: 120_000 });
    const { getPlatformProxy } = createRequire(path.join(CLOUD, "package.json"))("wrangler") as {
      getPlatformProxy(options: { configPath: string; persist: { path: string } }): Promise<{ env: { DB: SeedD1; ANALYSIS_DETAIL: SeedR2 }; dispose(): Promise<void> }>;
    };
    const proxy = await getPlatformProxy({ configPath, persist: { path: path.join(stateDir, "v3") } });
    const db = proxy.env.DB;
    const seedStarted = Date.now();
    const rand = seededRandom(266);
    let saved = 0;
    for (const rec0 of syntheticAnalyses(options)) {
      const rec = { ...rec0, horses: rec0.horses.map((h) => ({ ...h, contributions: syntheticContributions(rand) })) };
      const [inserted] = await db.batch([db.prepare(INSERT_ANALYSIS_SQL).bind(...analysisParams({ ...rec, rawResponse: null, raceSnapshot: null }))]);
      const id = inserted!.meta.last_row_id;
      const statements: SeedStatement[] = [db.prepare("UPDATE analyses SET detail_key = ? WHERE id = ?").bind(`analyses/${id}.json.gz`, id)];
      for (const h of rec.horses) statements.push(db.prepare(INSERT_ANALYSIS_HORSE_SQL).bind(...horseParams(id, { ...h, contributions: null })));
      await db.batch(statements);
      await proxy.env.ANALYSIS_DETAIL.put(`analyses/${id}.json.gz`, encodeDetail(rec));
      saved += 1;
    }
    // 発走時刻の写し(start_time)は、検証の DO が遅延で埋める。この測定では書き出しだけを見たいので、詳細の発走時刻を直接写す(NULL のままだと遮断なしの行が unchecked になる)。
    await db.batch([db.prepare("UPDATE analyses SET start_time = CASE id % 3 WHEN 0 THEN '10:05' WHEN 1 THEN '15:45' ELSE '20:50' END")]);
    const rand2 = seededRandom(7);
    for (let r = 0; r < options.results; r += 1) {
      const { raceId, entries } = syntheticResult(r, rand2);
      const statements: SeedStatement[] = entries.map((e) => db.prepare(UPSERT_RACE_RESULT_SQL).bind(...raceResultParams(raceId, e)));
      statements.push(db.prepare(UPSERT_RACE_RESULT_META_SQL).bind(raceId, "芝"));
      for (const e of entries) {
        statements.push(db.prepare("UPDATE race_results SET win_odds = ?, ninki = ? WHERE race_id = ? AND umaban = ?").bind(1.5 + e.umaban * 1.7, e.finishPosition, raceId, e.umaban));
      }
      await db.batch(statements);
    }
    const tableCounts: Record<string, number> = {};
    for (const table of ["analyses", "analysis_horses", "race_results", "race_result_meta"]) {
      tableCounts[table] = (await db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c;
    }
    await proxy.dispose();
    console.log(`## 合成データ(${((Date.now() - seedStarted) / 1000).toFixed(0)}秒): 分析 ${saved} 件(1 レース ${options.horses} 頭・遮断なしの旧い形 ${(options.legacyRatio * 100).toFixed(0)}%)・結果 ${options.results} レース`);
    console.log(`  表の行数: ${JSON.stringify(tableCounts)}`);

    // 2. 本番の worker.ts を wrangler dev --local で起動する。
    child = spawn(wrangler, ["dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", stateDir, "--config", configPath,
      "--var", "ACCESS_TEAM_NAME:measure", "--var", "ACCESS_AUD:measure-aud", "--var", "ACCESS_ALLOWED_EMAIL:owner@example.com"],
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
    const url = `http://127.0.0.1:${port}/api/export/prior-dataset`;

    // 3. (i) 作成を repeat 回。
    for (let n = 1; n <= repeat; n += 1) {
      const c0 = workerdTicks(pid);
      const started = Date.now();
      let polls = 0;
      let view: ExportView;
      // 作成を始める(最初は通常の GET。2 回目以降は refresh=1)。応答は 202(進捗)。本体は読まない。
      const first = await fetch(`${url}${n === 1 ? "" : "?refresh=1"}`, { signal: AbortSignal.timeout(60_000) });
      await first.arrayBuffer();
      if (first.status !== 202) throw new Error(`作成が始まらなかった: ${first.status}`);
      for (;;) {
        polls += 1;
        view = (await (await fetch(`${url}?status=1`, { signal: AbortSignal.timeout(60_000) })).json()) as ExportView;
        if (view.status === "ready" && view.file !== null && view.file !== undefined && Date.parse(view.file.generatedAt) >= started) break;
        if (view.status === "failed") throw new Error(`作成が失敗した: ${JSON.stringify(view)}`);
        if (Date.now() - started > 30 * 60_000) throw new Error("30 分経っても作成が終わらない");
        await sleep(500);
      }
      const wall = Date.now() - started;
      const cpu = (workerdTicks(pid) - c0) * msPerTick;
      const f = view.file!;
      console.log(`\n## (i-${n}) 作成(${n === 1 ? "通常の GET" : "refresh=1"}): 壁時計 ${(wall / 1000).toFixed(1)}秒(状態のポーリング ${polls} 回)、workerd の CPU 合計 ${cpu.toFixed(0)}ms(10ms 刻み)`);
      console.log(`  ファイル: ${f.rows} 行・${f.races} レース・詳細なし ${f.missingDetail}・gzip ${f.bytes} バイト・除外 ${JSON.stringify(f.excluded)}`);
      console.log(`  D1 の読み取り行数(meta.rows_read の合計): ${f.diag.rowsRead} 行、R2 の取得を試みた回数: ${f.diag.gets}`);
    }

    // 4. (ii) ダウンロード。
    const c1 = workerdTicks(pid);
    const t1 = Date.now();
    const dl = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    const body = new Uint8Array(await dl.arrayBuffer());
    const dlWall = Date.now() - t1;
    const dlCpu = (workerdTicks(pid) - c1) * msPerTick;
    const raw = gunzipSync(body);
    const loaded = parsePriorDataset(body);
    console.log(`\n## (ii) ダウンロード: ${dl.status}・${dl.headers.get("content-disposition")}・本体 ${body.length} バイト(展開後 ${raw.length} バイト)、壁時計 ${dlWall}ms、workerd の CPU ${dlCpu.toFixed(0)}ms`);
    console.log(`  ローダで全行を読めた: ${loaded.rows.length} 行・要約 ${JSON.stringify(summarize(loaded.rows))}`);
    console.log(`  自由文(reason)を含まない: ${!raw.toString("utf-8").includes('"reason"')}・1 行の平均 ${Math.round(raw.length / Math.max(1, loaded.rows.length))} バイト`);
  } finally {
    stop();
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
