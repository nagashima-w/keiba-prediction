/**
 * #156(#41-B)ファイル形式の型と SHA-256。
 *
 * - `CaseIndex`(`index.json`): ケース ID とレース ID の対応表・プロンプトの SHA-256。
 *   サブエージェントの見える場所には置かない(リポジトリ側にだけ置く)。
 * - `LlmRaceRecord`(`llm-observations/<raceId>.json`): 段階3(適用)の出力。集計はこの JSON と
 *   #41 の観測 JSON だけから再計算できる。
 */

import { createHash } from "node:crypto";

/** 文字列(UTF-8)の SHA-256(16進)。 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export const CASE_INDEX_SCHEMA_VERSION = 1;
export const LLM_OBSERVATION_SCHEMA_VERSION = 1;

/** 対応表の1件。 */
export interface CaseIndexEntry {
  readonly caseId: string;
  readonly raceId: string;
  readonly region: "central" | "nar";
  /** 実レース日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
  /** プロンプト(`prompts/<raceId>.txt` の全文)の SHA-256。 */
  readonly promptSha256: string;
  readonly promptChars: number;
  /** 重賞の過去結果(`AplGradeWinner`)を取得したか(バッジありのレース)。 */
  readonly gradeWinnerFetched: boolean;
}

/** `index.json`。 */
export interface CaseIndex {
  readonly schemaVersion: typeof CASE_INDEX_SCHEMA_VERSION;
  readonly promptVersion: string;
  readonly clipVariant: "default";
  readonly maxAdjust: number;
  readonly caseIdSeed: number;
  readonly gitCommit: string;
  readonly entries: readonly CaseIndexEntry[];
}

/** 段階3の出力の1頭分。 */
export interface LlmHorseRecord {
  readonly umaban: number;
  /** prior(`runAnalysis` の出力。#41 の観測の prior と一致を検証済み)。 */
  readonly prior: number;
  /** production の `analyzeRace`(パース・クリップ・フォールバック後)の補正後確率。 */
  readonly adjustedProb: number;
  /** ±maxAdjust(または [0,1])を逸脱してクリップしたか。 */
  readonly clipped: boolean;
  /** LLM の値が使えず(馬番欠け・不正値)prior をそのまま採用したか。 */
  readonly usedPrior: boolean;
  /** 予想印(印なし・全馬 null への救済・フォールバック時は null)。 */
  readonly mark: string | null;
}

/** 段階3の出力(1レース)。 */
export interface LlmRaceRecord {
  readonly schemaVersion: typeof LLM_OBSERVATION_SCHEMA_VERSION;
  readonly raceId: string;
  readonly caseId: string;
  readonly promptVersion: string;
  readonly maxAdjust: number;
  readonly promptSha256: string;
  /** 使った応答ファイル(attempt1, attempt2)の SHA-256(`complete` が呼ばれた回数ぶん)。 */
  readonly responseSha256: readonly string[];
  /** `complete` が呼ばれた回数(1 または 2)。 */
  readonly attempts: number;
  readonly retryCount: number;
  /** 補正を捨てて prior に戻ったか(補正後=prior)。 */
  readonly fallback: boolean;
  readonly fallbackReason: string | null;
  /** 印だけを諦めたか(確率補正は有効)。 */
  readonly marksDropped: boolean;
  /** 応答の切り詰めによる fallback か(サブエージェントでは起きない見込み)。 */
  readonly truncated: boolean;
  readonly horses: readonly LlmHorseRecord[];
}
