/**
 * #156(#41-B)段階1: プロンプト生成。#41 の raw の `RaceData` から、production の `runAnalysis` と
 * 同じ組み立て(`driveRunAnalysis`)で `BuildPromptInput` を捕まえ、`buildPrompt` の文字列を
 * レースごとのファイルに書く。ネットワークに出るのは**重賞バッジのあるレースの `AplGradeWinner` 1回だけ**
 * (記録フェッチャ。記録済みなら出ない)。
 *
 * ## 実行(計画の文書と対象コードをコミットしてから。未コミットなら起動時に失敗する)
 *   pnpm tsx scripts/probability-quality-41-llm/build-prompts.ts --raw-dir <#41 の raw> --work-dir <リポジトリ外・raw と入れ子にしない。例: scratchpad/pq156-work>
 * - リポジトリ側(`docs/investigations/probability-quality-41-llm/`)に `prompts/<raceId>.txt`・
 *   `grade-winner/<raceId>.json`・`index.json` を書く(**コミットしてから応答を作らせる**)。
 * - 作業ディレクトリ側に、サブエージェントに見せる `subagent/case-NN.txt` を書く(匿名のケース ID。
 *   対応表は書かない)。
 * - 取得間隔は `HttpClient.minIntervalMs = 2000`。HTTP 400・403・429 が連続2回で止まる(終了コード 2)。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPrompt,
  CachedFetcher,
  CLIP_VARIANTS,
  HttpClient,
  PROMPT_VERSION,
  ScrapeCache,
  type BuildPromptInput,
  type GradeWinnerFetcher,
  type RaceData,
} from "../../packages/core/src/index.js";
import { FetchHaltedError, HaltOnConsecutiveBlockFetcher } from "../probability-quality-41/guarded-fetcher.js";
import { loadObservations } from "../probability-quality-41/aggregate.js";
import { assertPathsClean, assertPlanCommitted, MIN_INTERVAL_MS } from "../probability-quality-41/run.js";
import { assignCaseIds, CASE_ID_SEED } from "./case-ids.js";
import { driveRunAnalysis } from "./drive.js";
import { createRecordedGradeFetcher } from "./grade-recorder.js";
import { CASE_INDEX_SCHEMA_VERSION, sha256Hex, type CaseIndex, type CaseIndexEntry } from "./records.js";

/** プロンプトを作る対象1レース。 */
export interface PromptTarget {
  readonly raceId: string;
  readonly region: "central" | "nar";
  /** 実レース日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
}

/** 注入する依存(ファイル・ネットワークはここだけ)。 */
export interface BuildPromptsDeps {
  /** raw の `RaceData` と自レースの結果ページ HTML を読む。 */
  readonly loadRaw: (raceId: string) => { readonly raceData: RaceData; readonly resultHtml: string };
  /** 他レースの結果ページ HTML(同日傾向用)。 */
  readonly resultHtmlOf: (raceId: string) => string | undefined;
  /** そのレースの重賞過去結果フェッチャ(記録または再生)。 */
  readonly gradeFetcherFor: (raceId: string) => GradeWinnerFetcher;
  /** リポジトリ側にプロンプトを書く(コミット対象)。 */
  readonly writeRepoPrompt: (raceId: string, text: string) => void;
  /** サブエージェントに見せるプロンプトを書く(匿名のケース ID)。 */
  readonly writeSubagentPrompt: (caseId: string, text: string) => void;
}

/**
 * 全対象のプロンプトを作って書き、対応表を返す。**1件でも失敗したら何も書かずに失敗する**
 * (全レースのプロンプトを先に作り、成功したあとにまとめて書く)。重賞の過去結果の取得失敗は
 * production では黙って null になるが、計測では黙らせない(プロンプトが変わるため)。
 */
export async function buildPromptArtifacts(
  targets: readonly PromptTarget[],
  deps: BuildPromptsDeps,
  meta: { readonly gitCommit: string },
): Promise<CaseIndex> {
  const ids = targets.map((t) => t.raceId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("対象のレース ID が重複している");
  }
  const caseIds = assignCaseIds(ids);
  const built: Array<{ target: PromptTarget; caseId: string; prompt: string; gradeFetched: boolean }> = [];

  for (const target of [...targets].sort((a, b) => (a.raceId < b.raceId ? -1 : 1))) {
    const raw = deps.loadRaw(target.raceId);
    let gradeFetched = false;
    const inner = deps.gradeFetcherFor(target.raceId);
    const gradeFetcher: GradeWinnerFetcher = {
      fetchText: async (url, options) => {
        gradeFetched = true;
        return inner.fetchText(url, options);
      },
    };
    let captured: BuildPromptInput | null = null;
    const out = await driveRunAnalysis(
      {
        raceId: target.raceId,
        kaisaiDate: target.kaisaiDate,
        raceData: raw.raceData,
        resultHtml: raw.resultHtml,
        resultHtmlOf: deps.resultHtmlOf,
        gradeFetcher,
      },
      async (input) => {
        captured = input;
        return { horses: [], fallback: true, retryCount: 0, fallbackReason: "プロンプトの捕捉のみ" };
      },
    );
    if (out.gradeWinnerErrors.length > 0) {
      throw new Error(
        `${target.raceId}: 重賞の過去結果の取得に失敗(プロンプトが production と変わるため中止): ` +
          out.gradeWinnerErrors.map((e) => e.message).join(" / "),
      );
    }
    const input = captured as BuildPromptInput | null;
    if (input === null) {
      throw new Error(`${target.raceId}: analyze が呼ばれず、プロンプトを捕まえられなかった`);
    }
    built.push({
      target,
      caseId: caseIds.get(target.raceId)!,
      prompt: buildPrompt(input),
      gradeFetched,
    });
  }

  const entries: CaseIndexEntry[] = [];
  for (const b of built) {
    deps.writeRepoPrompt(b.target.raceId, b.prompt);
    deps.writeSubagentPrompt(b.caseId, b.prompt);
    entries.push({
      caseId: b.caseId,
      raceId: b.target.raceId,
      region: b.target.region,
      kaisaiDate: b.target.kaisaiDate,
      promptSha256: sha256Hex(b.prompt),
      promptChars: b.prompt.length,
      gradeWinnerFetched: b.gradeFetched,
    });
  }
  return {
    schemaVersion: CASE_INDEX_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    clipVariant: "default",
    maxAdjust: CLIP_VARIANTS.default.maxAdjust,
    caseIdSeed: CASE_ID_SEED,
    gitCommit: meta.gitCommit,
    entries,
  };
}

// ---------------------------------------------------------------------------
// CLI(ネットワークに出る。計画と対象コードがコミット済みでなければ起動時に失敗する)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LLM_OUT_ROOT = path.join(REPO_ROOT, "docs", "investigations", "probability-quality-41-llm");
const PLAN_PATH = "docs/investigations/probability-quality-41-llm/measurement-plan.md";
const OBS_DIR = path.join(REPO_ROOT, "docs", "investigations", "probability-quality-41", "observations");

/** 取得に使うコードのうち、未コミットなら実行を拒否するパス。 */
export const LLM_CODE_PATHS_MUST_BE_CLEAN: readonly string[] = [
  "scripts/probability-quality-41-llm",
  "scripts/probability-quality-41",
  "packages/core/src",
  "packages/app/src",
];

function argValue(argv: readonly string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`${name} <ディレクトリ> が必要です`);
  }
  return path.resolve(v);
}

/**
 * サブエージェントに読ませるプロンプトの置き場(作業ディレクトリ)を、#41 の raw(着順・払戻を含む結果ページ)と
 * 同一・入れ子にしない。`ls`・Glob で raw が見える場所にプロンプトを置かないため。
 */
export function assertWorkDirApartFromRaw(workDir: string, rawDir: string): void {
  const w = path.resolve(workDir);
  const r = path.resolve(rawDir);
  const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + path.sep);
  if (inside(w, r) || inside(r, w)) {
    throw new Error(`--work-dir は #41 の raw(--raw-dir)と同一・入れ子にしないでください(work: ${w} / raw: ${r})`);
  }
}

function outsideRepo(dir: string, name: string): string {
  if (dir === REPO_ROOT || dir.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`${name} はリポジトリの外を指定してください(指定: ${dir})`);
  }
  return dir;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rawDir = outsideRepo(argValue(argv, "--raw-dir"), "--raw-dir");
  const workDir = outsideRepo(argValue(argv, "--work-dir"), "--work-dir");
  assertWorkDirApartFromRaw(workDir, rawDir);

  const git = (args: readonly string[]) => execFileSync("git", [...args], { cwd: REPO_ROOT, encoding: "utf-8" });
  assertPlanCommitted(git, PLAN_PATH);
  assertPathsClean(git, LLM_CODE_PATHS_MUST_BE_CLEAN);
  const gitCommit = git(["rev-parse", "HEAD"]).trim();

  const targets: PromptTarget[] = loadObservations(OBS_DIR)
    .flatMap((o) => (o.status === "ok" ? [{ raceId: o.raceId, region: o.region, kaisaiDate: o.kaisaiDate }] : []));
  if (targets.length === 0) throw new Error("対象のレースがありません(#41 の観測が空)");

  const gradeDir = path.join(LLM_OUT_ROOT, "grade-winner");
  const promptsDir = path.join(LLM_OUT_ROOT, "prompts");
  const subagentDir = path.join(workDir, "subagent");
  mkdirSync(promptsDir, { recursive: true });
  mkdirSync(subagentDir, { recursive: true });

  // HttpClient はスクリプト全体で1個だけ(レート制限の直列保証はインスタンス内部の状態に依存する)。
  const client = new HttpClient({ minIntervalMs: MIN_INTERVAL_MS });
  const cache = new ScrapeCache();
  const guard = new HaltOnConsecutiveBlockFetcher(new CachedFetcher({ fetcher: client, cache }));
  try {
    const index = await buildPromptArtifacts(
      targets,
      {
        loadRaw: (raceId) => ({
          raceData: JSON.parse(readFileSync(path.join(rawDir, "race-data", `${raceId}.json`), "utf-8")) as RaceData,
          resultHtml: readFileSync(path.join(rawDir, "result-html", `${raceId}.html`), "utf-8"),
        }),
        resultHtmlOf: (raceId) => {
          const f = path.join(rawDir, "result-html", `${raceId}.html`);
          return existsSync(f) ? readFileSync(f, "utf-8") : undefined;
        },
        gradeFetcherFor: (raceId) => createRecordedGradeFetcher({ dir: gradeDir, raceId, network: guard }),
        writeRepoPrompt: (raceId, text) => writeFileSync(path.join(promptsDir, `${raceId}.txt`), text, "utf-8"),
        writeSubagentPrompt: (caseId, text) => writeFileSync(path.join(subagentDir, `${caseId}.txt`), text, "utf-8"),
      },
      { gitCommit },
    );
    writeFileSync(path.join(LLM_OUT_ROOT, "index.json"), JSON.stringify(index, null, 2), "utf-8");
    console.error(
      `${index.entries.length}件のプロンプトを書きました(重賞の過去結果を取得: ${index.entries.filter((e) => e.gradeWinnerFetched).length}件)。リクエスト数: ${guard.requestCount}`,
    );
  } catch (error) {
    if (error instanceof FetchHaltedError || guard.tripped) {
      console.error(`取得を停止しました: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    cache.close();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
