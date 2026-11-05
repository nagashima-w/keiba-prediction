import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpointSqliteFiles, computeTemplateKey, ensureD1Template, findWalLeftovers } from "./d1-template-core";

/**
 * Issue #621: migration を当てた D1 の「ひな形」を 1 回だけ作り、各テストはその写しから開く。
 * ここはひな形の置き場所(鍵)・排他・完成品だけを見せる作り方・閉じた状態への整え方の単体テスト(偽の作り手を使い、wrangler は動かさない)。
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keiba-d1-template-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCloud(): string {
  const cloud = path.join(root, "cloud");
  mkdirSync(path.join(cloud, "migrations"), { recursive: true });
  mkdirSync(path.join(cloud, "node_modules", "wrangler"), { recursive: true });
  writeFileSync(path.join(cloud, "migrations", "0001_a.sql"), "CREATE TABLE a (id INTEGER);");
  writeFileSync(path.join(cloud, "migrations", "0002_b.sql"), "CREATE TABLE b (id INTEGER);");
  writeFileSync(path.join(cloud, "wrangler.toml"), 'name = "x"\n');
  writeFileSync(path.join(cloud, "node_modules", "wrangler", "package.json"), '{"version":"4.0.0"}');
  return cloud;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("computeTemplateKey: migration・設定・wrangler の版が変わればひな形の鍵が変わる", () => {
  it("同じ内容なら同じ鍵(前提)", () => {
    const cloud = makeCloud();
    expect(computeTemplateKey(cloud)).toBe(computeTemplateKey(cloud));
    expect(computeTemplateKey(cloud)).toMatch(/^[0-9a-f]{16,}$/);
  });
  const mutations: Array<[string, (cloud: string) => void]> = [
    ["migration の中身を変える", (c) => writeFileSync(path.join(c, "migrations", "0002_b.sql"), "CREATE TABLE b (id INTEGER, x TEXT);")],
    ["migration を足す", (c) => writeFileSync(path.join(c, "migrations", "0003_c.sql"), "CREATE TABLE c (id INTEGER);")],
    ["migration のファイル名を変える(中身は同じ)", (c) => cpSync(path.join(c, "migrations", "0002_b.sql"), path.join(c, "migrations", "0002_z.sql")) ],
    ["wrangler.toml を変える", (c) => writeFileSync(path.join(c, "wrangler.toml"), 'name = "y"\n')],
    ["wrangler の版を変える", (c) => writeFileSync(path.join(c, "node_modules", "wrangler", "package.json"), '{"version":"4.0.1"}')],
  ];
  for (const [name, mutate] of mutations) {
    it(`${name}と鍵が変わる`, () => {
      const cloud = makeCloud();
      const before = computeTemplateKey(cloud);
      mutate(cloud);
      expect(computeTemplateKey(cloud)).not.toBe(before);
    });
  }
  it("migration 以外のファイル(.sql 以外)は鍵に影響しない", () => {
    const cloud = makeCloud();
    const before = computeTemplateKey(cloud);
    writeFileSync(path.join(cloud, "migrations", "README.md"), "メモ");
    expect(computeTemplateKey(cloud)).toBe(before);
  });
});

describe("ensureD1Template: 1 回だけ作り、完成品だけを見せる", () => {
  const key = "k1";
  function fakeBuild(counter: { n: number }, delayMs = 0) {
    return async (dir: string): Promise<void> => {
      counter.n += 1;
      mkdirSync(path.join(dir, "v3"), { recursive: true });
      writeFileSync(path.join(dir, "v3", "first"), "1");
      await sleep(delayMs);
      writeFileSync(path.join(dir, "v3", "second"), "2");
    };
  }

  it("並列に 4 件求めても作るのは 1 回で、返った時点で作りかけではない(両方のファイルがある)", async () => {
    const counter = { n: 0 };
    const results = await Promise.all(
      [1, 2, 3, 4].map(async () => {
        const dir = await ensureD1Template({ root, key, build: fakeBuild(counter, 150), pollMs: 20 });
        return { dir, first: existsSync(path.join(dir, "v3", "first")), second: existsSync(path.join(dir, "v3", "second")) };
      }),
    );
    expect(counter.n).toBe(1);
    expect(new Set(results.map((r) => r.dir)).size).toBe(1);
    for (const r of results) {
      expect(r.first).toBe(true);
      expect(r.second).toBe(true);
    }
  });

  it("作り終えたあとの 2 回目は作らない。ロックも一時ディレクトリも残らない", async () => {
    const counter = { n: 0 };
    await ensureD1Template({ root, key, build: fakeBuild(counter), pollMs: 20 });
    await ensureD1Template({ root, key, build: fakeBuild(counter), pollMs: 20 });
    expect(counter.n).toBe(1);
    expect(readdirSync(root).filter((n) => n.includes(key))).toEqual([`keiba-d1-template-${key}`]);
  });

  it("鍵が違えば別のひな形(古い鍵のひな形は使われない)", async () => {
    const counter = { n: 0 };
    const a = await ensureD1Template({ root, key: "old", build: fakeBuild(counter), pollMs: 20 });
    const b = await ensureD1Template({ root, key: "new", build: fakeBuild(counter), pollMs: 20 });
    expect(a).not.toBe(b);
    expect(counter.n).toBe(2);
  });

  it("作り手が失敗したら、エラーを返し、ロックを外し、作りかけを置かない。次の呼び出しは作り直せる", async () => {
    await expect(
      ensureD1Template({ root, key, build: async () => { throw new Error("boom"); }, pollMs: 20 }),
    ).rejects.toThrow("boom");
    expect(readdirSync(root).filter((n) => n.includes(key))).toEqual([]);
    const counter = { n: 0 };
    const dir = await ensureD1Template({ root, key, build: fakeBuild(counter), pollMs: 20 });
    expect(counter.n).toBe(1);
    expect(existsSync(path.join(dir, "v3", "second"))).toBe(true);
  });

  it("期限内のロックは奪わない: 5 分前のロックの持ち主が終わるまで待ち、自分では作らない(期限は 10 分)", async () => {
    const lock = path.join(root, `keiba-d1-template-${key}.lock`);
    mkdirSync(lock);
    const past = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, past, past);
    const counter = { n: 0 };
    const pending = ensureD1Template({ root, key, build: fakeBuild(counter), pollMs: 20 });
    await sleep(200);
    // 持ち主が完成品を置いてロックを外した、という状態を作る
    const done = path.join(root, `keiba-d1-template-${key}`);
    mkdirSync(path.join(done, "v3"), { recursive: true });
    writeFileSync(path.join(done, "v3", "owner"), "x");
    rmSync(lock, { recursive: true });
    const dir = await pending;
    expect(counter.n).toBe(0);
    expect(existsSync(path.join(dir, "v3", "owner"))).toBe(true);
  });

  it("期限切れのロック(11 分前)は奪って作る", async () => {
    const lock = path.join(root, `keiba-d1-template-${key}.lock`);
    mkdirSync(lock);
    const past = new Date(Date.now() - 11 * 60_000);
    utimesSync(lock, past, past);
    const counter = { n: 0 };
    const dir = await ensureD1Template({ root, key, build: fakeBuild(counter), pollMs: 20 });
    expect(counter.n).toBe(1);
    expect(existsSync(path.join(dir, "v3", "second"))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("閉じた状態: checkpointSqliteFiles", () => {
  it("書きかけ(-wal・-shm)が残る状態から、チェックポイントで主ファイルだけにし、データを失わない", () => {
    const live = path.join(root, "live");
    const copy = path.join(root, "copy", "v3");
    mkdirSync(live);
    mkdirSync(copy, { recursive: true });
    const db = new DatabaseSync(path.join(live, "x.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a'),('b');");
    // 書き手が開いたまま 3 ファイルを写す = wrangler が終わったあとに -wal・-shm が残った状態の再現
    for (const f of readdirSync(live)) cpSync(path.join(live, f), path.join(copy, f));
    db.close();
    const copyDir = path.join(root, "copy");
    expect(readdirSync(copy).filter((f) => f.endsWith("-wal")).length).toBe(1);
    expect(findWalLeftovers(copyDir).length).toBeGreaterThan(0);

    checkpointSqliteFiles(copyDir);

    expect(findWalLeftovers(copyDir)).toEqual([]);
    expect(readdirSync(copy)).toEqual(["x.sqlite"]);
    const reopened = new DatabaseSync(path.join(copy, "x.sqlite"), { readOnly: true });
    expect(reopened.prepare("SELECT v FROM t ORDER BY v").all()).toEqual([{ v: "a" }, { v: "b" }]);
    reopened.close();
    expect(readFileSync(path.join(copy, "x.sqlite")).length).toBeGreaterThan(0);
  });

  it("チェックポイント後も中身のある -wal が残るなら、消さずに throw する(データを黙って捨てない)", () => {
    const dir = path.join(root, "orphan");
    mkdirSync(dir);
    // 対応する主ファイルが無い、中身のある -wal(チェックポイントでは取り込めない)
    writeFileSync(path.join(dir, "x.sqlite-wal"), "データ");
    expect(() => checkpointSqliteFiles(dir)).toThrow(/-wal に内容が残っている/);
    expect(existsSync(path.join(dir, "x.sqlite-wal"))).toBe(true);
  });

  it("空の -wal・-shm の残骸は消す(前のテストと対比: 内容の有無だけが違う)", () => {
    const dir = path.join(root, "empty-leftover");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "x.sqlite-wal"), "");
    writeFileSync(path.join(dir, "x.sqlite-shm"), "s");
    checkpointSqliteFiles(dir);
    expect(readdirSync(dir)).toEqual([]);
  });
});
