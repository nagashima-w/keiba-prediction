import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Issue #162 段階2b: 本番のバンドル(`wrangler deploy --dry-run` の出力)の検査。
 *  1. smoke 専用の偽ソケット(`smoke-worker.ts`)・テスト用の入口が、本番のバンドルに入っていない
 *  2. core のパーサ・HttpClient が実際にバンドルされている(`[alias]` が効いている。効いていなければ dry-run が失敗する)
 *  3. Free プランの Worker のサイズ上限(圧縮後 3 MB)に収まっている
 * 非空振りの対照: smoke 専用エントリを `main` にした一時設定で同じ検査をすると、偽ソケットの印が見つかる
 * (検出の文字列が、実際にバンドルされたときに拾えることの確認)。
 */

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(CLOUD, "node_modules", ".bin", "wrangler");
const TEMP_CONFIG = path.join(CLOUD, "wrangler.bundle-guard.generated.toml");
const workDirs: string[] = [];

/** 偽ソケットの印(smoke-worker.ts が持つ文字列)。 */
const FAKE_SOCKET_MARKERS = ["keiba-smoke-fake-socket", "by fake socket"];

function bundle(configPath: string | null, outputName: string): string {
  const outDir = mkdtempSync(path.join(tmpdir(), "keiba-bundle-guard-"));
  workDirs.push(outDir);
  execFileSync(WRANGLER, ["deploy", "--dry-run", "--outdir", outDir, ...(configPath === null ? [] : ["--config", configPath])], {
    cwd: CLOUD,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    stdio: "pipe",
    timeout: 120_000,
  });
  return readFileSync(path.join(outDir, outputName), "utf-8");
}

afterAll(() => {
  rmSync(TEMP_CONFIG, { force: true });
  for (const dir of workDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("本番のバンドル(deploy --dry-run)", () => {
  it("前提: smoke 専用エントリは偽ソケットの印を持ち、本番の main(src/worker.ts)はそれを import しない", () => {
    const smokeWorker = readFileSync(path.join(CLOUD, "smoke-worker.ts"), "utf-8");
    for (const marker of FAKE_SOCKET_MARKERS) {
      expect(smokeWorker, `smoke-worker.ts に ${marker}`).toContain(marker);
    }
    expect(readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8")).toMatch(/^main = "src\/worker\.ts"$/m);
    const workerSource = readFileSync(path.join(CLOUD, "src", "worker.ts"), "utf-8");
    expect(workerSource).not.toMatch(/smoke/i);
  });

  it(
    "偽ソケット・smoke 専用エントリの文字列が入っていない。core のパーサ・HttpClient は入っている。圧縮後 3 MB 以内",
    () => {
      const code = bundle(null, "worker.js");
      for (const marker of [...FAKE_SOCKET_MARKERS, "wrangler.smoke"]) {
        expect(code.includes(marker), `本番のバンドルに ${marker} が無い`).toBe(false);
      }
      // [alias] が効いて、core が実際にバンドルされている(parseShutuba・HttpClient・iconv-lite・cheerio)
      for (const present of ["parseShutuba", "var HttpClient = class", "keiba-ev-tool/0.1", "iconv", "cheerio", "NetkeibaGate"]) {
        expect(code.includes(present), `本番のバンドルに ${present} がある`).toBe(true);
      }
      // 本番の接続関数は cloudflare:sockets の connect
      expect(code).toContain("cloudflare:sockets");
      const gzipBytes = gzipSync(code).length;
      expect(gzipBytes).toBeLessThan(3 * 1024 * 1024);
      expect(Buffer.byteLength(code)).toBeGreaterThan(100_000); // 前提: core が入っている(空振りでない)
    },
    120_000,
  );

  it(
    "対照: smoke 専用エントリを main にした設定でバンドルすると、偽ソケットの印が見つかる(検査が空振りでない)",
    () => {
      const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
      const smokeConfig = base.replace('main = "src/worker.ts"', 'main = "smoke-worker.ts"');
      expect(smokeConfig).not.toBe(base);
      writeFileSync(TEMP_CONFIG, smokeConfig);
      expect(existsSync(TEMP_CONFIG)).toBe(true);
      const code = bundle(TEMP_CONFIG, "smoke-worker.js");
      for (const marker of FAKE_SOCKET_MARKERS) {
        expect(code.includes(marker), `smoke のバンドルに ${marker} がある`).toBe(true);
      }
    },
    120_000,
  );
});
