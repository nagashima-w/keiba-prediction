/**
 * Issue #621: migration を当てた D1 の状態(「ひな形」)を 1 回だけ作り、各テストはその写しから開くための、ファイル操作だけの部品。
 * wrangler は import しない(ユニットの層のテストからも使えるように)。wrangler を動かす作り手は local-bindings.ts が渡す。
 *
 * 置き場所は `<root>/keiba-d1-template-<鍵>/`。鍵は migration の中身・wrangler.toml・wrangler の版から作るので、
 * これらが変わると別の置き場所になり、古いひな形は使われない。
 * 排他: `<root>/keiba-d1-template-<鍵>.lock` を mkdir(原子的)で取った 1 者だけが、一時ディレクトリに作り、完成したら rename で置く。
 * したがって置き場所が存在すれば常に完成品で、作りかけは読まれない。作る側が死んでロックが残っても、期限(既定 10 分)を過ぎれば奪う。
 * 期限を超えて作り続ける側がいて 2 者が作ったときは、後から rename する側が、既にある完成品を見て自分の作りかけを捨てる(Issue #626)。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** ロックの期限: migration の適用は、負荷の高いときに単独で 35 秒かかる実測がある(CI の並列ではさらに延びうる)ので、余裕を持たせる。 */
export const DEFAULT_LOCK_STALE_MS = 10 * 60_000;

/** ひな形の鍵: cloud/migrations/*.sql(名前と中身)・wrangler.toml・node_modules/wrangler の版。 */
export function computeTemplateKey(cloudDir: string): string {
  const hash = createHash("sha256");
  const migrationsDir = path.join(cloudDir, "migrations");
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    hash.update(`migration:${name}\0`).update(readFileSync(path.join(migrationsDir, name))).update("\0");
  }
  hash.update("wrangler.toml\0").update(readFileSync(path.join(cloudDir, "wrangler.toml"))).update("\0");
  const version = (JSON.parse(readFileSync(path.join(cloudDir, "node_modules", "wrangler", "package.json"), "utf8")) as { version: string }).version;
  hash.update(`wrangler-version:${version}`);
  return hash.digest("hex").slice(0, 32);
}

export interface EnsureTemplateOptions {
  /** ひな形を置く親ディレクトリ(通常は os.tmpdir())。 */
  readonly root: string;
  readonly key: string;
  /** 空のディレクトリに migration 済みの状態を作る。 */
  readonly build: (dir: string) => Promise<void>;
  readonly pollMs?: number;
  readonly lockStaleMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ひな形のディレクトリを返す(無ければ 1 回だけ作る)。 */
export async function ensureD1Template(options: EnsureTemplateOptions): Promise<string> {
  const { root, key, build, pollMs = 200, lockStaleMs = DEFAULT_LOCK_STALE_MS } = options;
  const finalDir = path.join(root, `keiba-d1-template-${key}`);
  const lockDir = `${finalDir}.lock`;
  for (;;) {
    if (existsSync(finalDir)) return finalDir;
    try {
      mkdirSync(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // 他者が作っている。期限切れのロックだけ、一意な名前へ rename して(原子的に)取り除く。
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > lockStaleMs) {
          const trash = `${lockDir}.stale-${process.pid}-${Date.now()}`;
          renameSync(lockDir, trash);
          rmSync(trash, { recursive: true, force: true });
        }
      } catch {
        // 他者が先に外した等。次の周回でやり直す。
      }
      await sleep(pollMs);
      continue;
    }
    // ロックを取った。取る間に他者が完成させていないか確かめてから作る。
    const stage = mkdtempSync(`${finalDir}.tmp-`);
    try {
      if (!existsSync(finalDir)) {
        await build(stage);
        try {
          renameSync(stage, finalDir);
        } catch (error) {
          // 作っている間に期限を過ぎてロックを奪われ、別の者が先に完成品を置いたとき(Issue #626〈#621〉)。完成品があるなら自分の作りかけは捨てて成功とする。
          if (!existsSync(finalDir)) throw error;
        }
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

/** ディレクトリ以下の SQLite の書きかけ(-wal・-shm)のパス。 */
export function findWalLeftovers(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findWalLeftovers(full));
    else if (/\.sqlite-(wal|shm)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * ディレクトリ以下の `*.sqlite` を、WAL をチェックポイントして主ファイルに取り込み、-wal・-shm を残さない状態にする。
 * wrangler は終了後も -wal(migration の内容が主に入っている)・-shm を残すため、そのまま写すのではなくここで閉じる。
 */
export function checkpointSqliteFiles(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      checkpointSqliteFiles(full);
    } else if (entry.name.endsWith(".sqlite")) {
      const db = new DatabaseSync(full);
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        db.close(); // 最後の接続を閉じると -wal・-shm は消える
      }
    }
  }
  for (const leftover of findWalLeftovers(dir)) {
    // 閉じたあとに残っていれば、チェックポイント済みの空の残骸のはず。中身があるなら消さずに失敗させる(データを失わないため)。
    if (leftover.endsWith("-wal") && statSync(leftover).size > 0) throw new Error(`チェックポイント後も -wal に内容が残っている: ${leftover}`);
    rmSync(leftover, { force: true });
  }
}
