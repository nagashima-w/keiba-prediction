import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Issue #174(#172-a): R2 の binding(`ANALYSIS_DETAIL`。wrangler.toml の `[[r2_buckets]]`)が配線されていることの確認。
 *  1. `wrangler deploy --dry-run`(CI の check ジョブの `pnpm run deploy:dry` と同じコマンド)が、binding を認識する(資格情報なしで通る)
 *  2. ローカル(workerd)の R2 を `getPlatformProxy` で開き、実際に put・get・上書き・存在しないキーの get(null)ができる
 *
 * **本番のバケットには一切触れない**(`remote = true` は無く、保存先は一時ディレクトリ。wrangler.toml の静的ガードは
 * scripts/test/cloud-config-guard.test.ts)。限界: ローカルの R2 のシミュレータの挙動であり、本番のバケットの存在・
 * トークンの権限は、承認印付き push 後の CI(deploy ジョブの「R2 の権限を確認」)で確かめる。
 */

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(CLOUD, "node_modules", ".bin", "wrangler");

let stateDir: string;
let bucket: R2Bucket;
let dispose: () => Promise<void>;

beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "keiba-r2-binding-"));
  const proxy = await getPlatformProxy<{ ANALYSIS_DETAIL: R2Bucket }>({
    configPath: path.join(CLOUD, "wrangler.toml"),
    persist: { path: path.join(stateDir, "v3") },
  });
  bucket = proxy.env.ANALYSIS_DETAIL;
  dispose = () => proxy.dispose();
}, 120_000);

afterAll(async () => {
  await dispose?.();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("R2 の binding(ローカルの workerd)", () => {
  it("binding ANALYSIS_DETAIL が存在し、put した値を get できる。存在しないキーは null。同じキーへの put は上書き", async () => {
    // 前提: binding が実際に取れている(取れていないと、以降が undefined への呼び出しで落ちる)
    expect(bucket).toBeDefined();
    expect(typeof bucket.put).toBe("function");
    const key = "analyses/174-binding-check.json";
    expect(await bucket.get(key), "最初は存在しない").toBeNull();
    await bucket.put(key, new TextEncoder().encode('{"v":1}'));
    expect(await (await bucket.get(key))!.text()).toBe('{"v":1}');
    await bucket.put(key, new TextEncoder().encode('{"v":2}'));
    expect(await (await bucket.get(key))!.text()).toBe('{"v":2}');
    expect(await bucket.get("analyses/does-not-exist.json")).toBeNull();
  });

  it("バイト列(gzip の圧縮後のような非 UTF-8 のバイト)も、1 バイトも変わらず戻る", async () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    await bucket.put("analyses/174-bytes.bin", bytes);
    const back = new Uint8Array(await (await bucket.get("analyses/174-bytes.bin"))!.arrayBuffer());
    expect(Array.from(back)).toEqual(Array.from(bytes));
    expect(back.length).toBe(256);
  });
});

describe("wrangler deploy --dry-run(CI の check ジョブと同じコマンド)", () => {
  it("R2 の binding(ANALYSIS_DETAIL → keiba-cloud-r2)を認識する。資格情報は要らない", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "keiba-r2-dryrun-"));
    try {
      const out = execFileSync(WRANGLER, ["deploy", "--dry-run", "--outdir", outDir], {
        cwd: CLOUD,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "true" },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      expect(out).toMatch(/env\.ANALYSIS_DETAIL \(keiba-cloud-r2\)\s+R2 Bucket/);
      // 対照: 既存の binding(D1)は同じ表に出る(表の読み取りが空振りでない)
      expect(out).toMatch(/env\.DB \(keiba-cloud-db\)\s+D1 Database/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});
