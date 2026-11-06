/**
 * テスト用: ローカル(workerd)の D1・R2 を開く。migration は CI と同じ実コマンド(`wrangler d1 migrations apply DB --local`)で適用する。
 * **本番の D1・R2 には一切触れない**(`--local`・一時ディレクトリ。wrangler.toml に `remote = true` は無い)。
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import type { AnalysisBucket, AnalysisDb } from "../src/analysis-repository";
import { checkpointSqliteFiles, computeTemplateKey, ensureD1Template } from "./d1-template-core";

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(CLOUD, "node_modules", ".bin", "wrangler");

export interface LocalBindings {
  readonly db: D1Database;
  readonly r2: R2Bucket;
  /** 全表の行を消す(外部キーの順)。R2 のオブジェクトは消さない(キーは analysis id で決まり、id は再利用されない)。 */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Issue #621: migration を当てた D1 の状態(ひな形)を、最初に必要になったときに 1 回だけ作る(wrangler の適用が 1 回あたり約 35 秒で、
 * 時間の大半を占めていたため)。置き場所は鍵(migration・wrangler.toml・wrangler の版)ごと、排他と完成品だけを見せる作りは d1-template-core.ts。
 * ひな形は掃除しない(鍵が変わるたびに 1.3MB ほどが tmpdir に残るだけで、掃除の処理自体が並列の取り合いの種になるため)。
 * migration を当てること自体の確認(d1-schema.integration.test.ts)は、この方式を使わず今の形のまま行う。
 */
export function getMigratedTemplate(): Promise<string> {
  return ensureD1Template({
    root: tmpdir(),
    key: computeTemplateKey(CLOUD),
    async build(dir) {
      execFileSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", dir], {
        cwd: CLOUD,
        env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
        stdio: "pipe",
        timeout: 300_000,
      });
      // wrangler は終了後も -wal(migration の内容が主に入る)・-shm を残すため、閉じた状態に整えてから完成品にする。
      checkpointSqliteFiles(dir);
    },
  });
}

export async function openLocalBindings(): Promise<LocalBindings> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "keiba-local-bindings-"));
  cpSync(await getMigratedTemplate(), stateDir, { recursive: true });
  const proxy = await getPlatformProxy<{ DB: D1Database; ANALYSIS_DETAIL: R2Bucket }>({
    configPath: path.join(CLOUD, "wrangler.toml"),
    persist: { path: path.join(stateDir, "v3") },
  });
  const db = proxy.env.DB;
  return {
    db,
    r2: proxy.env.ANALYSIS_DETAIL,
    async reset() {
      for (const table of ["jra_entry_fetches", "race_horse_entries", "horse_owner_history", "horse_profiles", "verify_race_mark", "race_backfill", "analysis_close_bets", "analysis_close", "analysis_bets", "analysis_horses", "analysis_allocation_meta", "analyses", "race_combo_payouts", "race_combo_payout_imports", "race_result_meta", "race_results", "daily_reports", "monthly_reports", "jockey_results", "trainer_results", "horse_runs", "horse_run_saves", "race_conditions", "baba_fetch_attempts", "baba_fetches", "baba_conditions", "kaisai_days", "jockey_names", "trainer_names", "race_archive", "r2_ops", "cloud_settings"]) {
        await db.prepare(`DELETE FROM ${table}`).run();
      }
    },
    async dispose() {
      await proxy.dispose();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

export interface BucketCall {
  readonly op: "put" | "get";
  readonly key: string;
  /** put のときの本文(バイト列)。 */
  readonly body?: Uint8Array;
}

export interface SpyBucketOptions {
  /** put の n 回目(1 始まり。全体の通し番号)を失敗させるか。 */
  readonly failPut?: (attempt: number) => boolean;
  /** get を例外にするか。 */
  readonly failGet?: boolean;
  /** put の直前(失敗の判定の前)に呼ぶ。D1 のコミットが先であることの確認に使う。 */
  readonly beforePut?: (key: string) => Promise<void>;
}

/**
 * R2 の偽の窓口: **get と put だけ**を持つ(list・head・delete を呼べば TypeError。ストアが LIST・HEAD を使わないことの強制)。
 * 呼び出しを記録し、実際の(ローカルの)バケットに転送する。
 */
export function spyBucket(real: R2Bucket, options: SpyBucketOptions = {}): { bucket: AnalysisBucket; calls: BucketCall[] } {
  const calls: BucketCall[] = [];
  let putCount = 0;
  const bucket = {
    async put(key: string, value: unknown, putOptions?: unknown) {
      putCount += 1;
      calls.push({ op: "put", key, body: value instanceof Uint8Array ? value : undefined });
      await options.beforePut?.(key);
      if (options.failPut?.(putCount) === true) {
        throw new Error("R2_ERROR: injected put failure");
      }
      return real.put(key, value as ArrayBufferView, putOptions as R2PutOptions);
    },
    async get(key: string) {
      calls.push({ op: "get", key });
      if (options.failGet === true) {
        throw new Error("R2_ERROR: injected get failure");
      }
      return real.get(key);
    },
  } as unknown as AnalysisBucket;
  return { bucket, calls };
}

/**
 * D1 の窓口の記録つき転送: 発行された SQL と、batch の文の数を記録する。
 * Issue #624: `batchSqls` は batch ごとの文の SQL の並び(bind した文を、元の SQL に対応づけて記録する。変更の印が最後に入っているかの確認に使う)。
 */
export function spyDb(real: D1Database): { db: AnalysisDb; prepared: string[]; batches: number[]; batchSqls: string[][] } {
  const prepared: string[] = [];
  const batches: number[] = [];
  const batchSqls: string[][] = [];
  const sqlOf = new WeakMap<object, string>();
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      const stmt = real.prepare(sql);
      return new Proxy(stmt, {
        get(target, prop) {
          if (prop === "bind") {
            return (...args: unknown[]) => {
              const bound = target.bind(...args);
              sqlOf.set(bound, sql);
              return bound;
            };
          }
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    },
    batch(statements: D1PreparedStatement[]) {
      batches.push(statements.length);
      batchSqls.push(statements.map((s) => sqlOf.get(s) ?? ""));
      return real.batch(statements);
    },
  } as unknown as AnalysisDb;
  return { db, prepared, batches, batchSqls };
}
