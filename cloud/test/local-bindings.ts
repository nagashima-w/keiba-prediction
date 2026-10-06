/**
 * テスト用: ローカル(workerd)の D1・R2 を開く。migration は CI と同じ実コマンド(`wrangler d1 migrations apply DB --local`)で適用する。
 * **本番の D1・R2 には一切触れない**(`--local`・一時ディレクトリ。wrangler.toml に `remote = true` は無い)。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import type { AnalysisBucket, AnalysisDb } from "../src/analysis-repository";

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(CLOUD, "node_modules", ".bin", "wrangler");

export interface LocalBindings {
  readonly db: D1Database;
  readonly r2: R2Bucket;
  /** 全表の行を消す(外部キーの順)。R2 のオブジェクトは消さない(キーは analysis id で決まり、id は再利用されない)。 */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export async function openLocalBindings(): Promise<LocalBindings> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "keiba-local-bindings-"));
  execFileSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir], {
    cwd: CLOUD,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    stdio: "pipe",
    timeout: 120_000,
  });
  const proxy = await getPlatformProxy<{ DB: D1Database; ANALYSIS_DETAIL: R2Bucket }>({
    configPath: path.join(CLOUD, "wrangler.toml"),
    persist: { path: path.join(stateDir, "v3") },
  });
  const db = proxy.env.DB;
  return {
    db,
    r2: proxy.env.ANALYSIS_DETAIL,
    async reset() {
      for (const table of ["analysis_bets", "analysis_horses", "analysis_allocation_meta", "analyses", "race_combo_payouts", "race_combo_payout_imports", "race_result_meta", "race_results", "r2_ops"]) {
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

/** D1 の窓口の記録つき転送: 発行された SQL と、batch の文の数を記録する。 */
export function spyDb(real: D1Database): { db: AnalysisDb; prepared: string[]; batches: number[] } {
  const prepared: string[] = [];
  const batches: number[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return real.prepare(sql);
    },
    batch(statements: D1PreparedStatement[]) {
      batches.push(statements.length);
      return real.batch(statements);
    },
  } as unknown as AnalysisDb;
  return { db, prepared, batches };
}
