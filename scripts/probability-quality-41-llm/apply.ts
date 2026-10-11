/**
 * #156(#41-B)段階3の適用(1レース)。サブエージェントが作った応答ファイルを、production の
 * `analyzeRace`(パース・`maxAdjust` のクリップ・リトライ・フォールバック)に通して補正後確率を作る。
 * `runAnalysis` を `driveRunAnalysis` 経由で駆動し(段階1と同じ組み立て)、`deps.analyze` に
 * 「ファイル版 `LlmClient` を使う `analyzeRace`」を入れる(`pipeline-deps.ts` の束縛と同じ形)。
 *
 * ## 整合性の検証(食い違えば例外。黙って進まない)
 * - `analyzeRace` が組み立てて `complete` に渡したプロンプトの SHA-256 が、段階1が記録した値と一致する。
 *   (重賞の過去結果・同日傾向が再現できず、段階1と違うプロンプトになった場合もここで検出される)
 * - `runAnalysis` の prior が #41 の観測 JSON の prior と一致する(馬番の集合も)。
 * - 重賞の過去結果の取得(再生)が失敗していない(production は黙って null にするが、計測では黙らせない)。
 *
 * ## 応答が揃っていないとき
 * `FileLlmClient` が「何回目が未生成か」を記録する。1回目なら応答未生成、2回目ならリトライ用が未生成
 * (1回目が壊れていた)。いずれも `pending` を返し、記録(`final`)は作らない。
 */

import {
  analyzeRace,
  CLIP_VARIANTS,
  PROMPT_VERSION,
  type AnalyzeRaceResult,
} from "../../packages/core/src/index.js";
import { driveRunAnalysis, type DriveInput } from "./drive.js";
import { FileLlmClient } from "./file-llm-client.js";
import { LLM_OBSERVATION_SCHEMA_VERSION, sha256Hex, type LlmRaceRecord } from "./records.js";

/** prior の一致の許容差(同じコード・同じ入力なら完全一致するはずの浮動小数の安全幅)。 */
const PRIOR_TOLERANCE = 1e-9;

export interface ApplyInput {
  readonly drive: DriveInput;
  readonly caseId: string;
  /** 段階1が記録したプロンプトの SHA-256。 */
  readonly promptSha256: string;
  /** #41 の観測 JSON の馬番→prior。 */
  readonly observedPriors: ReadonlyMap<number, number>;
  /** N 回目(1始まり)の応答テキスト。無ければ undefined。 */
  readonly readAttempt: (attempt: number) => string | undefined;
}

export type ApplyOutcome =
  | { readonly status: "final"; readonly record: LlmRaceRecord }
  | { readonly status: "pending"; readonly missingAttempt: number };

export async function applyRace(input: ApplyInput): Promise<ApplyOutcome> {
  const client = new FileLlmClient(input.readAttempt);
  const maxAdjust = CLIP_VARIANTS.default.maxAdjust;
  let analyzed: AnalyzeRaceResult | null = null;

  const out = await driveRunAnalysis(input.drive, async (promptInput) => {
    const result = await analyzeRace(promptInput, { llm: client, maxAdjust });
    analyzed = result;
    return result;
  });

  if (out.gradeWinnerErrors.length > 0) {
    throw new Error(
      `${input.drive.raceId}: 重賞の過去結果を再生できない(プロンプトが段階1と変わる): ` +
        out.gradeWinnerErrors.map((e) => e.message).join(" / "),
    );
  }
  const result = analyzed as AnalyzeRaceResult | null;
  if (result === null || client.prompts.length === 0) {
    throw new Error(`${input.drive.raceId}: analyze が呼ばれなかった`);
  }
  for (const prompt of client.prompts) {
    if (sha256Hex(prompt) !== input.promptSha256) {
      throw new Error(
        `${input.drive.raceId}: 段階3で組み立てたプロンプトが段階1の記録と一致しない` +
          `(SHA-256: ${sha256Hex(prompt)} ≠ ${input.promptSha256})`,
      );
    }
  }

  if (client.missingAttempt !== null) {
    return { status: "pending", missingAttempt: client.missingAttempt };
  }

  // prior の照合(馬番の集合と値)。
  const rowUmabans = out.analysis.rows.map((r) => r.umaban).sort((a, b) => a - b);
  const observedUmabans = [...input.observedPriors.keys()].sort((a, b) => a - b);
  if (rowUmabans.join(",") !== observedUmabans.join(",")) {
    throw new Error(
      `${input.drive.raceId}: 馬番の集合が #41 の観測と違う(段階3: ${rowUmabans.join(",")} / 観測: ${observedUmabans.join(",")})`,
    );
  }
  for (const row of out.analysis.rows) {
    const observed = input.observedPriors.get(row.umaban)!;
    if (Math.abs(row.prior - observed) > PRIOR_TOLERANCE) {
      throw new Error(
        `${input.drive.raceId}: 馬番${row.umaban}の prior が #41 の観測と食い違う(${row.prior} ≠ ${observed})`,
      );
    }
  }

  const attempts = client.prompts.length;
  const responseSha256: string[] = [];
  for (let n = 1; n <= attempts; n++) {
    responseSha256.push(sha256Hex(input.readAttempt(n) ?? ""));
  }
  const record: LlmRaceRecord = {
    schemaVersion: LLM_OBSERVATION_SCHEMA_VERSION,
    raceId: input.drive.raceId,
    caseId: input.caseId,
    promptVersion: PROMPT_VERSION,
    maxAdjust,
    promptSha256: input.promptSha256,
    responseSha256,
    attempts,
    retryCount: result.retryCount,
    fallback: result.fallback,
    fallbackReason: result.fallbackReason,
    marksDropped: result.marksDropped ?? false,
    truncated: result.truncated ?? false,
    horses: [...result.horses]
      .sort((a, b) => a.umaban - b.umaban)
      .map((h) => ({
        umaban: h.umaban,
        prior: h.prior,
        adjustedProb: h.adjustedProb,
        clipped: h.clipped,
        usedPrior: h.usedPrior,
        mark: h.mark,
      })),
  };
  return { status: "final", record };
}
