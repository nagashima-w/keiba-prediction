import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Issue #207(#182-A): 結果ストア(`src/result-repository.ts`)と、結果の取込フロー(core の `ev/result-import.ts`)を巻き込む入口を `wrangler deploy --dry-run` で
 * バンドルし、Worker に載せられることを確かめる(**これらはまだ本番の入口〈worker.ts〉から import されていない**ので、`bundle-guard.test.ts` の本番のバンドルには入らない。
 * 呼び出しが入る #208 より前に、バンドルできること・better-sqlite3 を巻き込まないこと・Free の大きさ上限に収まることを固定しておく)。
 * 入口の一時ファイルは .gitignore が除外する。
 */

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(CLOUD, "node_modules", ".bin", "wrangler");
const PROBE_ENTRY = path.join(CLOUD, "result-store-probe.generated.ts");
const PROBE_CONFIG = path.join(CLOUD, "wrangler.result-store-probe.generated.toml");
const workDirs: string[] = [];

afterAll(() => {
  rmSync(PROBE_ENTRY, { force: true });
  rmSync(PROBE_CONFIG, { force: true });
  for (const dir of workDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("結果ストアのバンドル(Issue #207)", () => {
  it(
    "D1ResultStore と core の importRaceResult(+ parseRaceResult)を巻き込む入口がバンドルでき、better-sqlite3 を含まず、圧縮後 3 MB 以内",
    () => {
      writeFileSync(
        PROBE_ENTRY,
        [
          'import { D1ResultStore } from "./src/result-repository";',
          'import { importRaceResult } from "../packages/core/src/ev/result-import";',
          'import { parseRaceResult } from "../packages/core/src/scraper/parse-race-result";',
          'export { NetkeibaGate } from "./src/netkeiba-gate-do";',
          "export default { fetch() { return new Response(String([D1ResultStore, importRaceResult, parseRaceResult])); } };",
          "",
        ].join("\n"),
      );
      // RaceDay を巻き込まない入口なので、日単位の DO の binding と migration v2 を除く(bundle-guard.test.ts の withoutRaceDay と同じ)。
      const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
      const withoutRaceDay = base
        .replace(/\[\[durable_objects\.bindings\]\]\nname = "RACE_DAY"\nclass_name = "RaceDay"\n/, "")
        .replace(/\[\[migrations\]\]\ntag = "v2"\nnew_sqlite_classes = \["RaceDay"\]\n/, "");
      expect(withoutRaceDay, "RACE_DAY の binding と migration v2 を除けている").not.toBe(base);
      const config = withoutRaceDay.replace('main = "src/worker.ts"', 'main = "result-store-probe.generated.ts"');
      expect(config).not.toBe(withoutRaceDay);
      writeFileSync(PROBE_CONFIG, config);

      const outDir = mkdtempSync(path.join(tmpdir(), "keiba-result-store-bundle-"));
      workDirs.push(outDir);
      execFileSync(WRANGLER, ["deploy", "--dry-run", "--outdir", outDir, "--config", PROBE_CONFIG], {
        cwd: CLOUD,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
        stdio: "pipe",
        timeout: 120_000,
      });
      const code = readFileSync(path.join(outDir, "result-store-probe.generated.js"), "utf-8");

      // 前提(空振り防止): 結果ストアと取込フロー・パーサが実際にバンドルされている
      for (const marker of ["json_each", "race_combo_payout_imports", "race_result_meta", "/race/result.html", "RaceResultNotConfirmedError"]) {
        expect(code.includes(marker), `バンドルに ${marker} がある`).toBe(true);
      }
      // 本題
      expect(code.includes("better-sqlite3"), "バンドルに better-sqlite3 が無い").toBe(false);
      expect(code.includes("sqlite3"), "バンドルにネイティブの sqlite3 の痕跡が無い").toBe(false);
      expect(/from\s*["']electron["']|require\(["']electron["']\)/.test(code), "バンドルに electron が無い").toBe(false);
      expect(gzipSync(code).length).toBeLessThan(3 * 1024 * 1024);
    },
    120_000,
  );
});
