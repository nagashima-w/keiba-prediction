/**
 * #156(#41-B)段階3: 全レースの適用(オフライン。ネットワークには出ない)。
 * 対応表(`index.json`)の各レースについて、応答ファイルを production の `analyzeRace` に通し、
 * 揃ったレースの記録(`llm-observations/<raceId>.json`)を書く。揃っていないレースは pending として
 * 返す(メインがその `caseId` に新しいサブエージェントを起動して attempt を取り直し、再実行する)。
 *
 * ## 実行
 *   pnpm tsx scripts/probability-quality-41-llm/apply-all.ts --raw-dir <#41 の raw> --work-dir <作業ディレクトリ> \
 *       [--responses-dir <応答の置き場。既定: <work-dir>/responses>]
 * 終了コード: 全レースが final なら 0、pending があれば 3。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { GradeWinnerFetcher, RaceData } from "../../packages/core/src/index.js";
import { loadObservations } from "../probability-quality-41/aggregate.js";
import { applyRace } from "./apply.js";
import { createRecordedGradeFetcher } from "./grade-recorder.js";
import { sha256Hex, type CaseIndex, type CaseIndexEntry, type LlmRaceRecord } from "./records.js";

/** 注入する依存(ファイルはここだけ)。 */
export interface ApplyAllDeps {
  readonly loadRaw: (raceId: string) => {
    readonly raceData: RaceData;
    readonly resultHtml: string;
    readonly kaisaiDate: string;
  };
  readonly resultHtmlOf: (raceId: string) => string | undefined;
  /** 重賞過去結果の再生フェッチャ(ネットワークに出ない)。 */
  readonly gradeFetcherFor: (raceId: string) => GradeWinnerFetcher;
  /** リポジトリ側の `prompts/<raceId>.txt` の全文。 */
  readonly readPrompt: (raceId: string) => string;
  /** #41 の観測の馬番→prior。 */
  readonly observedPriors: (raceId: string) => ReadonlyMap<number, number>;
  /** `case-NN.attemptN.txt` の中身(無ければ undefined)。 */
  readonly readResponse: (caseId: string, attempt: number) => string | undefined;
  readonly writeRecord: (record: LlmRaceRecord) => void;
}

export interface ApplyAllResult {
  readonly finalRaceIds: readonly string[];
  readonly pending: ReadonlyArray<{ readonly caseId: string; readonly raceId: string; readonly missingAttempt: number }>;
}

/**
 * 全レースを適用する。**対応表のプロンプトの SHA-256 とリポジトリ側のプロンプトファイルが
 * 食い違うレースが1件でもあれば、何も書かずに失敗する**(段階1の後でプロンプトが書き換わっていないこと)。
 */
export async function applyAll(entries: readonly CaseIndexEntry[], deps: ApplyAllDeps): Promise<ApplyAllResult> {
  for (const e of entries) {
    if (sha256Hex(deps.readPrompt(e.raceId)) !== e.promptSha256) {
      throw new Error(`${e.raceId}: リポジトリ側のプロンプトの SHA-256 が対応表(index.json)と食い違う`);
    }
  }
  const finalRaceIds: string[] = [];
  const pending: Array<{ caseId: string; raceId: string; missingAttempt: number }> = [];
  for (const e of [...entries].sort((a, b) => (a.raceId < b.raceId ? -1 : 1))) {
    const raw = deps.loadRaw(e.raceId);
    const outcome = await applyRace({
      drive: {
        raceId: e.raceId,
        kaisaiDate: e.kaisaiDate,
        raceData: raw.raceData,
        resultHtml: raw.resultHtml,
        resultHtmlOf: deps.resultHtmlOf,
        gradeFetcher: deps.gradeFetcherFor(e.raceId),
      },
      caseId: e.caseId,
      promptSha256: e.promptSha256,
      observedPriors: deps.observedPriors(e.raceId),
      readAttempt: (n) => deps.readResponse(e.caseId, n),
    });
    if (outcome.status === "final") {
      deps.writeRecord(outcome.record);
      finalRaceIds.push(e.raceId);
    } else {
      pending.push({ caseId: e.caseId, raceId: e.raceId, missingAttempt: outcome.missingAttempt });
    }
  }
  return { finalRaceIds, pending };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LLM_OUT_ROOT = path.join(REPO_ROOT, "docs", "investigations", "probability-quality-41-llm");
const OBS_DIR = path.join(REPO_ROOT, "docs", "investigations", "probability-quality-41", "observations");

function optValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v === undefined || v.startsWith("--") ? undefined : path.resolve(v);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rawDir = optValue(argv, "--raw-dir");
  const workDir = optValue(argv, "--work-dir");
  if (rawDir === undefined || workDir === undefined) {
    throw new Error("--raw-dir <#41 の raw> と --work-dir <作業ディレクトリ> が必要です");
  }
  const responsesDir = optValue(argv, "--responses-dir") ?? path.join(workDir, "responses");
  const index = JSON.parse(readFileSync(path.join(LLM_OUT_ROOT, "index.json"), "utf-8")) as CaseIndex;
  const priorsByRace = new Map(
    loadObservations(OBS_DIR).flatMap((o) =>
      o.status === "ok" ? [[o.raceId, new Map(o.horses.map((h) => [h.umaban, h.prior] as const))] as const] : [],
    ),
  );
  const outDir = path.join(LLM_OUT_ROOT, "llm-observations");
  mkdirSync(outDir, { recursive: true });

  const result = await applyAll(index.entries, {
    loadRaw: (raceId) => ({
      raceData: JSON.parse(readFileSync(path.join(rawDir, "race-data", `${raceId}.json`), "utf-8")) as RaceData,
      resultHtml: readFileSync(path.join(rawDir, "result-html", `${raceId}.html`), "utf-8"),
      kaisaiDate: index.entries.find((e) => e.raceId === raceId)!.kaisaiDate,
    }),
    resultHtmlOf: (raceId) => {
      const f = path.join(rawDir, "result-html", `${raceId}.html`);
      return existsSync(f) ? readFileSync(f, "utf-8") : undefined;
    },
    gradeFetcherFor: (raceId) =>
      createRecordedGradeFetcher({ dir: path.join(LLM_OUT_ROOT, "grade-winner"), raceId, network: null }),
    readPrompt: (raceId) => readFileSync(path.join(LLM_OUT_ROOT, "prompts", `${raceId}.txt`), "utf-8"),
    observedPriors: (raceId) => {
      const p = priorsByRace.get(raceId);
      if (p === undefined) throw new Error(`${raceId}: #41 の観測(status: ok)がない`);
      return p;
    },
    readResponse: (caseId, attempt) => {
      const f = path.join(responsesDir, `${caseId}.attempt${attempt}.txt`);
      return existsSync(f) ? readFileSync(f, "utf-8") : undefined;
    },
    writeRecord: (record) =>
      writeFileSync(path.join(outDir, `${record.raceId}.json`), JSON.stringify(record, null, 2), "utf-8"),
  });

  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, "pending.json"), JSON.stringify(result.pending, null, 2), "utf-8");
  console.error(`記録を書いたレース: ${result.finalRaceIds.length}件 / 未生成(pending): ${result.pending.length}件`);
  for (const p of result.pending) {
    console.error(
      `  ${p.caseId}(attempt ${p.missingAttempt} が必要${p.missingAttempt === 2 ? ": 1回目の応答が production のパースを通らなかった" : ""})`,
    );
  }
  process.exitCode = result.pending.length > 0 ? 3 : 0;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
