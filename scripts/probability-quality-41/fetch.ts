/**
 * #41 の取得(**ネットワークに出る唯一のスクリプト**)。
 * `docs/investigations/probability-quality-41/measurement-plan.md` の選定ルールに従い、
 * 馬ごとの観測 JSON を `observations/<raceId>.json` に保存する。集計は別スクリプト
 * (`aggregate.ts`・オフライン)。
 *
 * ## 実行(計画の文書をコミットしてから。未コミットなら起動時に失敗する)
 *   pnpm tsx scripts/probability-quality-41/fetch.ts --raw-dir <リポジトリ外の保存先>
 *
 * - 取得間隔は `HttpClient.minIntervalMs = 2000`(2秒以上)。自前の sleep は持たない。
 *   `HttpClient` はこのスクリプト全体で1個だけ使う。
 * - HTTP 400 が連続2回で止まる(`guarded-fetcher.ts`)。
 * - 保存済みのレースは飛ばす(再実行しても同じレースを取り直さない)。
 * - raw(結果 HTML・`RaceData`)は `--raw-dir` に保存する。リポジトリの外に置くこと
 *   (コンテナが消えれば失われる。コミットするのは観測 JSON だけ)。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CachedFetcher,
  HttpClient,
  listNarRaces,
  listRaces,
  parseKaisaiDate,
  raceResultUrl,
  scrapeRace,
  ScrapeCache,
} from "../../packages/core/src/index.js";
import { FetchHaltedError, HaltOnConsecutive400Fetcher } from "./guarded-fetcher.js";
import { measureRace, type RawKind } from "./measure.js";
import type { RaceObservation } from "./observation.js";
import {
  assertPathsClean,
  assertPlanCommitted,
  DEFAULT_PLAN,
  MIN_INTERVAL_MS,
  runMeasurement,
  type RunManifest,
} from "./run.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_ROOT = path.join(REPO_ROOT, "docs", "investigations", "probability-quality-41");
const PLAN_PATH = "docs/investigations/probability-quality-41/measurement-plan.md";

function parseRawDir(argv: readonly string[]): string {
  const i = argv.indexOf("--raw-dir");
  const dir = i >= 0 ? argv[i + 1] : undefined;
  if (dir === undefined || dir.startsWith("--")) {
    throw new Error("--raw-dir <リポジトリ外の保存先> が必要です(raw の RaceData・結果HTMLの保存先)");
  }
  const resolved = path.resolve(dir);
  if (resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`--raw-dir はリポジトリの外を指定してください(指定: ${resolved})`);
  }
  return resolved;
}

async function main(): Promise<void> {
  const rawDir = parseRawDir(process.argv.slice(2));

  // 計画の文書がコミット済みでなければ取得しない(cherry-pick 防止。順序をコードで強制する)。
  assertPlanCommitted(
    (args) => execFileSync("git", [...args], { cwd: REPO_ROOT, encoding: "utf-8" }),
    PLAN_PATH,
  );
  // 取得に使うコード(測定スクリプトと core)も未コミットなら取得しない(使った版を履歴に残す)。
  assertPathsClean(
    (args) => execFileSync("git", [...args], { cwd: REPO_ROOT, encoding: "utf-8" }),
    ["scripts/probability-quality-41", "packages/core/src"],
  );

  const obsDir = path.join(OUT_ROOT, "observations");
  mkdirSync(obsDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });

  // HttpClient はスクリプト全体で1個だけ(レート制限の直列保証はインスタンス内部の状態に依存する)。
  const client = new HttpClient({ minIntervalMs: MIN_INTERVAL_MS });
  const cache = new ScrapeCache();
  const guard = new HaltOnConsecutive400Fetcher(new CachedFetcher({ fetcher: client, cache }));

  const saveRaw = (kind: RawKind, raceId: string, content: string): void => {
    const ext = kind === "result-html" ? "html" : "json";
    const dir = path.join(rawDir, kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${raceId}.${ext}`), content, "utf-8");
  };

  const obsPath = (raceId: string) => path.join(obsDir, `${raceId}.json`);
  const manifestPath = path.join(OUT_ROOT, "manifest.json");

  try {
    await runMeasurement(
      {
        fetchCentralList: (d) => listRaces(parseKaisaiDate(d), { fetcher: guard }),
        fetchNarList: (d) => listNarRaces(parseKaisaiDate(d), { fetcher: guard }),
        measure: (target) =>
          measureRace(target, {
            fetchResultHtml: (raceId) => guard.fetchText(raceResultUrl(raceId), { bypassCache: true }),
            scrape: async (raceId) => {
              const race = await scrapeRace(raceId, { fetcher: guard }, { includeComboOdds: false });
              // scrapeRace は馬ごとの戦績の例外を警告に握りつぶす。停止していたら、途中までの
              // データで観測を作らず、取得全体の停止として伝える。
              if (guard.tripped) {
                throw new FetchHaltedError("取得の途中で HTTP 400 の連続により停止した");
              }
              return race;
            },
            saveRaw,
          }),
        store: {
          exists: (raceId) => existsSync(obsPath(raceId)),
          write: (obs: RaceObservation) => {
            // 取得した直後に書く(解析や集計より先)。
            writeFileSync(obsPath(obs.raceId), JSON.stringify(obs, null, 2), "utf-8");
            console.error(
              `[${obs.region}] ${obs.raceId} ${obs.status}${obs.status === "excluded" ? `(${obs.reason}: ${obs.detail})` : ""}`,
            );
          },
        },
        guard,
        writeManifest: (manifest: RunManifest) => {
          const previous: RunManifest[] = existsSync(manifestPath)
            ? (JSON.parse(readFileSync(manifestPath, "utf-8")) as { runs: RunManifest[] }).runs
            : [];
          writeFileSync(manifestPath, JSON.stringify({ runs: [...previous, manifest] }, null, 2), "utf-8");
          console.error(`実行記録を保存しました: ${manifestPath}`);
        },
      },
      DEFAULT_PLAN,
    );
  } finally {
    cache.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
