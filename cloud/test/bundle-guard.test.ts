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
/** 対照用(better-sqlite3 を巻き込む入口)の一時ファイル。.gitignore が除外する。 */
const NATIVE_PROBE_ENTRY = path.join(CLOUD, "native-probe.generated.ts");
const NATIVE_PROBE_CONFIG = path.join(CLOUD, "wrangler.native-probe.generated.toml");
/** runAnalysis(src/pipeline.ts)を巻き込む入口の一時ファイル(Issue #176)。.gitignore が除外する。 */
const PIPELINE_PROBE_ENTRY = path.join(CLOUD, "pipeline-probe.generated.ts");
const PIPELINE_PROBE_CONFIG = path.join(CLOUD, "wrangler.pipeline-probe.generated.toml");
/** core のバレルを巻き込む入口の一時ファイル(Issue #176。解決の失敗・better-sqlite3 の混入を検出できることの対照)。.gitignore が除外する。 */
const BARREL_PROBE_ENTRY = path.join(CLOUD, "barrel-probe.generated.ts");
const BARREL_PROBE_CONFIG = path.join(CLOUD, "wrangler.barrel-probe.generated.toml");
/** LLM の狭い入口(`@keiba/core/llm`。Issue #193)を巻き込む入口と、巻き込まない対照(`@keiba/core/pipeline` だけ)の一時ファイル。.gitignore が除外する。 */
const LLM_PROBE_ENTRY = path.join(CLOUD, "llm-probe.generated.ts");
const LLM_PROBE_CONFIG = path.join(CLOUD, "wrangler.llm-probe.generated.toml");
const LLM_ABSENT_ENTRY = path.join(CLOUD, "llm-absent-probe.generated.ts");
const LLM_ABSENT_CONFIG = path.join(CLOUD, "wrangler.llm-absent-probe.generated.toml");
/** 対照用(保存側のコード(D1AnalysisStore)を巻き込まない入口)の一時ファイル。.gitignore が除外する。 */
const STORE_ABSENT_ENTRY = path.join(CLOUD, "store-absent-probe.generated.ts");
const STORE_ABSENT_CONFIG = path.join(CLOUD, "wrangler.store-absent-probe.generated.toml");
const workDirs: string[] = [];

/** 偽ソケットの印(smoke-worker.ts が持つ文字列)。 */
const FAKE_SOCKET_MARKERS = ["keiba-smoke-fake-socket", "by fake socket"];

/**
 * 対照・probe 用の一時設定から、日単位の DO(RACE_DAY・RaceDay。Issue #177)の binding と migration v2 を除く。
 * wrangler は binding のクラスが入口から export されていることを要求するが、probe の入口は RaceDay を export しない(RaceDay を巻き込まない対照のため)。
 */
function withoutRaceDay(toml: string): string {
  const stripped = toml
    .replace(/\[\[durable_objects\.bindings\]\]\nname = "RACE_DAY"\nclass_name = "RaceDay"\n/, "")
    .replace(/\[\[migrations\]\]\ntag = "v2"\nnew_sqlite_classes = \["RaceDay"\]\n/, "");
  expect(stripped, "RACE_DAY の binding と migration v2 を除けている").not.toBe(toml);
  expect(stripped).not.toContain("RaceDay");
  return stripped;
}

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
  rmSync(NATIVE_PROBE_ENTRY, { force: true });
  rmSync(NATIVE_PROBE_CONFIG, { force: true });
  rmSync(STORE_ABSENT_ENTRY, { force: true });
  rmSync(STORE_ABSENT_CONFIG, { force: true });
  rmSync(PIPELINE_PROBE_ENTRY, { force: true });
  rmSync(PIPELINE_PROBE_CONFIG, { force: true });
  rmSync(BARREL_PROBE_ENTRY, { force: true });
  rmSync(BARREL_PROBE_CONFIG, { force: true });
  rmSync(LLM_PROBE_ENTRY, { force: true });
  rmSync(LLM_PROBE_CONFIG, { force: true });
  rmSync(LLM_ABSENT_ENTRY, { force: true });
  rmSync(LLM_ABSENT_CONFIG, { force: true });
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

/**
 * Issue #171(#169-a)AC-a6: 本番のバンドルに better-sqlite3(ネイティブ依存。Workers では動かない)が入らないこと。
 * **前提(空振り防止)**: D1 を呼ぶコード(`/api/health` の疎通確認)が、実際にバンドルされていること。
 * バンドルに D1 のコードが無ければ「better-sqlite3 が無い」は自明に成立するため、先に固定する。
 * 対照: core の better-sqlite3 を使うモジュール(`analysis-store.ts`)を巻き込む入口では、バンドル(または解決の失敗)に
 * better-sqlite3 が現れる。検出が、実際に巻き込まれたときに拾えることの確認。
 */
describe("本番のバンドルと D1(Issue #171)", () => {
  it(
    "D1 の疎通確認のコード(SQL 文と binding 名の参照)がバンドルに入っていて、better-sqlite3 は入っていない",
    () => {
      const code = bundle(null, "worker.js");
      // 前提: D1 を呼ぶコードが入っている(空振りでない)
      expect(code.includes("SELECT detail_key, llm_note FROM analyses LIMIT 1"), "D1 の疎通確認の文(migration 0002・0005 の列を読む。Issue #194)がバンドルにある").toBe(true);
      expect(code.includes("env.DB"), "D1 の binding(env.DB)を参照するコードがバンドルにある").toBe(true);
      // 本題
      expect(code.includes("better-sqlite3"), "バンドルに better-sqlite3 が無い").toBe(false);
      expect(code.includes("sqlite3"), "バンドルにネイティブの sqlite3 の痕跡が無い").toBe(false);
    },
    120_000,
  );

  it(
    "対照: better-sqlite3 を使う core のモジュールを import する入口をバンドルすると、better-sqlite3 が現れる(バンドルに入るか、解決に失敗してエラーに出る)",
    () => {
      writeFileSync(
        NATIVE_PROBE_ENTRY,
        'import { AnalysisStore } from "../packages/core/src/ev/analysis-store";\nexport { NetkeibaGate } from "./src/netkeiba-gate-do";\nexport default { fetch() { return new Response(String(AnalysisStore)); } };\n',
      );
      const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
      const probeConfig = withoutRaceDay(base).replace('main = "src/worker.ts"', 'main = "native-probe.generated.ts"');
      expect(probeConfig).not.toBe(base);
      writeFileSync(NATIVE_PROBE_CONFIG, probeConfig);
      let seen: string;
      try {
        seen = bundle(NATIVE_PROBE_CONFIG, "native-probe.generated.js");
      } catch (error) {
        // packages/core/node_modules が無い配置(CI)では、better-sqlite3 を解決できずにエラーになる。メッセージに名前が出る。
        const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
        seen = `${String(e.stdout ?? "")}${String(e.stderr ?? "")}${e.message ?? ""}`;
      }
      expect(seen.includes("better-sqlite3")).toBe(true);
    },
    120_000,
  );
});

/**
 * Issue #175(#172-b): 保存側のコード(`D1AnalysisStore`。D1 の batch・`json_each`・R2 の詳細・gzip)が、本番のバンドルに入っていること。
 * 本番の呼び出し元は、まだ読み取り専用の `GET /api/analyses`(一覧)だけ(保存の呼び出し元は #164)。**クラスの参照が残れば、メソッド(保存を含む)もバンドルに残る**
 * ので、ここで「保存側のコードがバンドルにある」を固定する(無いと、better-sqlite3 が無いという検査が自明に成立する)。
 * 前提(空振り防止): 検出する文字列が、ソースに実際にある。対照: ストアを参照しない入口でバンドルすると、同じ文字列が見つからない。
 */
const STORE_MARKERS = ["FROM json_each(?)", "UPDATE analyses SET detail_key = ", "'analyses/' || id", "node:zlib", "application/gzip", "ON CONFLICT(ym) DO UPDATE SET class_a = class_a + 1", "getUTCFullYear"];

describe("本番のバンドルと保存側のコード(Issue #175)", () => {
  it("前提: 検出する文字列は、ソース(analysis-repository.ts・analysis-detail.ts・r2-fence.ts)に実際にある", () => {
    const source = ["analysis-repository.ts", "analysis-detail.ts", "r2-fence.ts"].map((f) => readFileSync(path.join(CLOUD, "src", f), "utf-8")).join("\n");
    for (const marker of STORE_MARKERS) {
      expect(source.includes(marker), `ソースに ${marker}`).toBe(true);
    }
    // 本番の入口は、ストアを直接 import しない(handler.ts 経由)。worker.ts が smoke 用の入口でないことは上で確認済み
    expect(readFileSync(path.join(CLOUD, "src", "handler.ts"), "utf-8")).toContain("D1AnalysisStore");
  });

  it(
    "本番のバンドルに、保存側のコード(json_each の INSERT・detail_key の UPDATE・R2 のキー・node:zlib・gzip の型・#173 のカウンタと UTC の月の区切り)が入っていて、better-sqlite3 は入っていない",
    () => {
      const code = bundle(null, "worker.js");
      for (const marker of STORE_MARKERS) {
        expect(code.includes(marker), `本番のバンドルに ${marker} がある`).toBe(true);
      }
      expect(code.includes("better-sqlite3"), "バンドルに better-sqlite3 が無い").toBe(false);
      expect(code.includes("sqlite3"), "バンドルにネイティブの sqlite3 の痕跡が無い").toBe(false);
      // core の codec(SQL 文の定数)が入っている。バレル(index)を巻き込むと値で better-sqlite3 が入る(上の検査が落ちる)
      expect(code.includes("INSERT INTO ${ANALYSES_TABLE}"), "codec の SQL 文(テンプレートのまま)がバンドルにある").toBe(true);
    },
    120_000,
  );

  it(
    "対照: ストアを参照しない入口でバンドルすると、保存側の文字列は見つからない(検出が、実際に入っているときだけ拾えることの確認)",
    () => {
      writeFileSync(STORE_ABSENT_ENTRY, 'export { NetkeibaGate } from "./src/netkeiba-gate-do";\nexport default { fetch() { return new Response("probe"); } };\n');
      const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
      const probeConfig = withoutRaceDay(base).replace('main = "src/worker.ts"', 'main = "store-absent-probe.generated.ts"');
      expect(probeConfig).not.toBe(base);
      writeFileSync(STORE_ABSENT_CONFIG, probeConfig);
      const code = bundle(STORE_ABSENT_CONFIG, "store-absent-probe.generated.js");
      expect(code.includes("FROM json_each(?)")).toBe(false);
      expect(code.includes("UPDATE analyses SET detail_key = ")).toBe(false);
      expect(code.includes("application/gzip")).toBe(false);
      expect(code.includes("ON CONFLICT(ym)")).toBe(false);
    },
    120_000,
  );
});

/**
 * Issue #176(#164-a)AC-a2: runAnalysis(exe の分析パイプライン)が、cloud のバンドルに入ること。better-sqlite3 は入らないこと。
 * 本番のエントリ(worker.ts)はまだ runAnalysis を呼ばない(呼び出し元は #177 以降)ので、`src/pipeline.ts` を参照する入口(一時ファイル)を
 * 本番と同じ wrangler.toml([alias] を含む)でバンドルして検査する。
 * **前提(空振り防止)**: runAnalysis 固有の文字列(進捗メッセージ・LLM スキップの文言・scorer の文言)がバンドルに実際にあること。
 * 無ければ「better-sqlite3 が無い」は自明に成立してしまう。対照: core のバレルを import する入口では、解決の失敗か better-sqlite3 が現れる。
 */
// ASCII の識別子を使う(wrangler のバンドルは日本語の文字列を \uXXXX に直すので、日本語の文言では見つからない)。いずれも runAnalysis・runCloudAnalysis にだけある名前。
const PIPELINE_MARKERS = ["runCloudAnalysis", "promptLookaheadGuarded", "historyCutoffDate", "careerRunCount", "dateApproximate"];

describe("本番相当のバンドルと runAnalysis(Issue #176)", () => {
  it("前提: 検出する文字列は、runAnalysis のソースに実際にある。cloud/src/pipeline.ts は narrow な入口だけを使う", () => {
    const pipelineSource = readFileSync(path.join(CLOUD, "..", "packages", "app", "src", "main", "analysis-pipeline.ts"), "utf-8");
    const source = pipelineSource + readFileSync(path.join(CLOUD, "src", "pipeline.ts"), "utf-8");
    for (const marker of PIPELINE_MARKERS) {
      expect(source.includes(marker), `ソースに ${marker}`).toBe(true);
    }
    expect(pipelineSource).toContain('from "@keiba/core/pipeline"');
    expect(pipelineSource).not.toMatch(/from "@keiba\/core";/);
  });

  it(
    "runAnalysis を参照する入口をバンドルすると、runAnalysis 固有の文字列・core の scorer・配分の文字列が入っていて、better-sqlite3・Electron は入っていない",
    () => {
      writeFileSync(
        PIPELINE_PROBE_ENTRY,
        'import { runCloudAnalysis } from "./src/pipeline";\nexport { NetkeibaGate } from "./src/netkeiba-gate-do";\nexport default { fetch() { return new Response(String(runCloudAnalysis)); } };\n',
      );
      const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
      const probeConfig = withoutRaceDay(base).replace('main = "src/worker.ts"', 'main = "pipeline-probe.generated.ts"');
      expect(probeConfig).not.toBe(base);
      writeFileSync(PIPELINE_PROBE_CONFIG, probeConfig);
      const code = bundle(PIPELINE_PROBE_CONFIG, "pipeline-probe.generated.js");
      // 前提(空振り防止): runAnalysis が実際にバンドルされている
      for (const marker of PIPELINE_MARKERS) {
        expect(code.includes(marker), `バンドルに ${marker} がある`).toBe(true);
      }
      // 本題
      expect(code.includes("better-sqlite3"), "バンドルに better-sqlite3 が無い").toBe(false);
      expect(code.includes("sqlite3"), "バンドルにネイティブの sqlite3 の痕跡が無い").toBe(false);
      expect(/from\s*["']electron["']|require\(["']electron["']\)/.test(code), "バンドルに electron が無い").toBe(false);
      // 圧縮後の大きさが Free の上限(3 MB)に収まる(runAnalysis を載せた分を含めて)
      expect(gzipSync(code).length).toBeLessThan(3 * 1024 * 1024);
    },
    120_000,
  );

  it(
    "対照: core のバレルから better-sqlite3 に依存するクラス(ScrapeCache)を参照する入口をバンドルすると、better-sqlite3 が現れる(runAnalysis の import をバレルに戻す退行を、この検査が検出できることの確認)",
    () => {
      writeFileSync(
        BARREL_PROBE_ENTRY,
        'import { ScrapeCache } from "../packages/core/src/index";\nexport { NetkeibaGate } from "./src/netkeiba-gate-do";\nexport default { fetch() { return new Response(String(ScrapeCache)); } };\n',
      );
      const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
      const probeConfig = withoutRaceDay(base).replace('main = "src/worker.ts"', 'main = "barrel-probe.generated.ts"');
      expect(probeConfig).not.toBe(base);
      writeFileSync(BARREL_PROBE_CONFIG, probeConfig);
      let seen: string;
      try {
        seen = bundle(BARREL_PROBE_CONFIG, "barrel-probe.generated.js");
      } catch (error) {
        const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
        seen = `${String(e.stdout ?? "")}${String(e.stderr ?? "")}${e.message ?? ""}`;
      }
      expect(seen.includes("better-sqlite3")).toBe(true);
    },
    120_000,
  );
});

/**
 * Issue #177(#164-b): 日単位の DO `RaceDay` と、それが使う runAnalysis・取得キャッシュが、**本番のバンドル**(`src/worker.ts`)に入ること。
 * `worker.ts` が `RaceDay` を export する(wrangler が binding のクラスを要求する)ので、runCloudAnalysis も本番のバンドルに入る。
 * **前提(空振り防止)**: RaceDay・取得キャッシュ・runAnalysis 固有の ASCII 識別子(wrangler のバンドルは日本語を \uXXXX に直すので、日本語では見つからない)が
 * ソースにあり、バンドルにある。対照: RaceDay を export しない入口(store-absent の対照)のバンドルには、これらが無い。
 * テスト専用の `node:sqlite` はバンドルに入らない。
 */
const RACE_DAY_MARKERS = ["race_day_morning_prior", "race_day_tasks", "fetch_cache", "serializeGate", "CacheMissError", "RaceDayCore", "cloud_settings", "findByAnalyzedAt", "countChildren"];

describe("本番のバンドルと日単位の DO(Issue #177)", () => {
  it("前提: 検出する文字列は、race-day-core.ts・do-cache-store.ts・settings.ts に実際にある。worker.ts は RaceDay を export する", () => {
    const source =
      readFileSync(path.join(CLOUD, "src", "race-day-core.ts"), "utf-8") +
      readFileSync(path.join(CLOUD, "src", "do-cache-store.ts"), "utf-8") +
      readFileSync(path.join(CLOUD, "src", "settings.ts"), "utf-8");
    for (const marker of RACE_DAY_MARKERS) {
      expect(source.includes(marker), `ソースに ${marker}`).toBe(true);
    }
    expect(readFileSync(path.join(CLOUD, "src", "worker.ts"), "utf-8")).toMatch(/export \{ RaceDay \} from "\.\/race-day-do"/);
  });

  it(
    "本番のバンドルに、RaceDay・取得キャッシュ・runAnalysis の識別子が入っていて、better-sqlite3・node:sqlite・偽ソケットは入っていない。圧縮後 3 MB 以内",
    () => {
      const code = bundle(null, "worker.js");
      for (const marker of [...RACE_DAY_MARKERS, ...PIPELINE_MARKERS]) {
        expect(code.includes(marker), `本番のバンドルに ${marker} がある`).toBe(true);
      }
      expect(code.includes("better-sqlite3"), "better-sqlite3 が無い").toBe(false);
      expect(code.includes("node:sqlite"), "テスト専用の node:sqlite が無い").toBe(false);
      for (const marker of FAKE_SOCKET_MARKERS) {
        expect(code.includes(marker), `偽ソケットの印 ${marker} が無い`).toBe(false);
      }
      expect(gzipSync(code).length).toBeLessThan(3 * 1024 * 1024);
    },
    120_000,
  );

  it(
    "対照: RaceDay を参照しない入口でバンドルすると、RaceDay の識別子は見つからない(検出が、実際に入っているときだけ拾えることの確認)",
    () => {
      writeFileSync(STORE_ABSENT_ENTRY, 'export { NetkeibaGate } from "./src/netkeiba-gate-do";\nexport default { fetch() { return new Response("probe"); } };\n');
      const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
      const probeConfig = withoutRaceDay(base).replace('main = "src/worker.ts"', 'main = "store-absent-probe.generated.ts"');
      expect(probeConfig).not.toBe(base);
      writeFileSync(STORE_ABSENT_CONFIG, probeConfig);
      const code = bundle(STORE_ABSENT_CONFIG, "store-absent-probe.generated.js");
      for (const marker of ["race_day_morning_prior", "fetch_cache", "RaceDayCore"]) {
        expect(code.includes(marker), `対照のバンドルに ${marker} が無い`).toBe(false);
      }
    },
    120_000,
  );
});

/**
 * Issue #193(#179-a): LLM の狭い入口 `@keiba/core/llm`(`@anthropic-ai/sdk` を値で import する)が、cloud のバンドルに入ること(SDK が Workers でバンドルできる)。
 * 本番のエントリ(worker.ts)は、まだこの入口を使わない(呼び出し元は #194)ので、入口を参照する一時ファイルを、本番と同じ wrangler.toml([alias] を含む)でバンドルして検査する。
 *  - **前提(空振り防止)**: SDK 固有の文字列(`AnthropicError`・`api.anthropic.com`・`anthropic-version`)と、入口が運ぶ core の識別子(`pickLatestSonnet`・`createSdkMessageSender`)が
 *    ソース(SDK の実体・core)にあり、バンドルにある。対照: `@keiba/core/pipeline` だけを参照する入口には、SDK の文字列が無い(= SDK が入るのは LLM の入口を import したときだけ)。
 *  - better-sqlite3・electron は入らない。
 *  - **サイズ**: probe 単体と、本番(worker.ts)の圧縮後サイズの和が Free の上限(圧縮後 3 MB)に収まる(和は重なりを数えない上限側の見積り)。
 *    probe 単体にも上限(512 KiB)を置く(SDK を足した分が、想定外に膨らんだら気づくため。実測は SDK + analyzeRace の一式〈NetkeibaGate の export を含む〉で gzip 63.10 KiB)。
 */
const SDK_MARKERS = ["AnthropicError", "api.anthropic.com", "anthropic-version"];
const LLM_CORE_MARKERS = ["pickLatestSonnet", "createSdkMessageSender"];

describe("LLM の入口と SDK のバンドル(Issue #193)", () => {
  it("前提: 検出する文字列は、SDK と core のソースに実際にある。cloud の wrangler.toml の [alias] は SDK を cloud/node_modules に向けている", () => {
    const sdkSource = readFileSync(path.join(CLOUD, "node_modules", "@anthropic-ai", "sdk", "client.mjs"), "utf-8") + readFileSync(path.join(CLOUD, "node_modules", "@anthropic-ai", "sdk", "error.mjs"), "utf-8");
    for (const marker of SDK_MARKERS) {
      expect(sdkSource.includes(marker), `SDK のソースに ${marker}`).toBe(true);
    }
    const coreSource = ["anthropic-client.ts", "model-selection.ts"].map((f) => readFileSync(path.join(CLOUD, "..", "packages", "core", "src", "analyzer", f), "utf-8")).join("\n");
    for (const marker of LLM_CORE_MARKERS) {
      expect(coreSource.includes(marker), `core のソースに ${marker}`).toBe(true);
    }
    expect(readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8")).toContain('"@anthropic-ai/sdk" = "./node_modules/@anthropic-ai/sdk"');
  });

  it(
    "LLM の入口を参照する入口をバンドルすると、SDK と core の LLM の識別子が入っていて、better-sqlite3・Electron は入っていない。本番と合わせて圧縮後 3 MB 以内",
    () => {
      writeFileSync(
        LLM_PROBE_ENTRY,
        'import { analyzeRace, AnthropicLlmClient, createModelSelector, createSdkMessageSender, createSdkModelLister } from "@keiba/core/llm";\nexport { NetkeibaGate } from "./src/netkeiba-gate-do";\nexport default { fetch() { return new Response(String([analyzeRace, AnthropicLlmClient, createModelSelector, createSdkMessageSender, createSdkModelLister])); } };\n',
      );
      const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
      const probeConfig = withoutRaceDay(base).replace('main = "src/worker.ts"', 'main = "llm-probe.generated.ts"');
      expect(probeConfig).not.toBe(base);
      writeFileSync(LLM_PROBE_CONFIG, probeConfig);
      const code = bundle(LLM_PROBE_CONFIG, "llm-probe.generated.js");
      // 前提(空振り防止): SDK と core の LLM のコードが実際にバンドルされている
      for (const marker of [...SDK_MARKERS, ...LLM_CORE_MARKERS]) {
        expect(code.includes(marker), `バンドルに ${marker} がある`).toBe(true);
      }
      // 本題
      expect(code.includes("better-sqlite3"), "バンドルに better-sqlite3 が無い").toBe(false);
      expect(code.includes("sqlite3"), "バンドルにネイティブの sqlite3 の痕跡が無い").toBe(false);
      expect(/from\s*["']electron["']|require\(["']electron["']\)/.test(code), "バンドルに electron が無い").toBe(false);
      // サイズ
      const probeGzip = gzipSync(code).length;
      const productionGzip = gzipSync(bundle(null, "worker.js")).length;
      expect(probeGzip).toBeGreaterThan(10 * 1024); // 前提: SDK が入っている(空振りでない)
      expect(probeGzip).toBeLessThan(512 * 1024);
      expect(productionGzip + probeGzip).toBeLessThan(3 * 1024 * 1024);
    },
    240_000,
  );

  it(
    "Issue #194: 本番のバンドル(worker.ts)に、LLM の配線(記録の表・キーの secret の名前)と SDK が入っていて、better-sqlite3 は入っていない。圧縮後 3 MB 以内(SDK を含めた実測値)",
    () => {
      const code = bundle(null, "worker.js");
      // 前提(空振り防止): LLM の配線が、実際に本番のバンドルにある(RaceDay が llm を使う)
      for (const marker of ["race_day_llm_responses", "ANTHROPIC_API_KEY", ...SDK_MARKERS, ...LLM_CORE_MARKERS]) {
        expect(code.includes(marker), `本番のバンドルに ${marker} がある`).toBe(true);
      }
      expect(code.includes("better-sqlite3"), "バンドルに better-sqlite3 が無い").toBe(false);
      expect(gzipSync(code).length).toBeLessThan(3 * 1024 * 1024);
    },
    120_000,
  );

  it(
    "対照: `@keiba/core/pipeline` だけを参照する入口(runAnalysis の入口)には、SDK の文字列が入らない(SDK がバンドルに入るのは、LLM の入口を import したときだけ)",
    () => {
      writeFileSync(
        LLM_ABSENT_ENTRY,
        'import { runCloudAnalysis } from "./src/pipeline";\nexport { NetkeibaGate } from "./src/netkeiba-gate-do";\nexport default { fetch() { return new Response(String(runCloudAnalysis)); } };\n',
      );
      const base = readFileSync(path.join(CLOUD, "wrangler.toml"), "utf-8");
      const probeConfig = withoutRaceDay(base).replace('main = "src/worker.ts"', 'main = "llm-absent-probe.generated.ts"');
      expect(probeConfig).not.toBe(base);
      writeFileSync(LLM_ABSENT_CONFIG, probeConfig);
      const code = bundle(LLM_ABSENT_CONFIG, "llm-absent-probe.generated.js");
      expect(code.includes("runCloudAnalysis"), "前提: runAnalysis の入口は入っている").toBe(true);
      for (const marker of [...SDK_MARKERS, "pickLatestSonnet"]) {
        expect(code.includes(marker), `LLM の入口を import しないバンドルに ${marker} が無い`).toBe(false);
      }
    },
    120_000,
  );
});
