/**
 * Issue #315 の近似確認: サブエージェント(LLM の代わり)の出力テキストを、本番の解析にかけて観察項目を出す。
 * 判定ではなく観察(合否は読む人が決める)。ただし「解析できるか」(`usable`)だけは本番の解析の成否そのもの。
 */
import {
  AnalyzerMarkViolationError,
  AnalyzerResponseParseError,
  extractDevelopment,
  extractJsonObject,
  parseAnalyzerResponse,
  PARSE_DEVELOPMENT_MAX_CODEPOINTS,
} from "../../packages/core/src/analyzer/parse-response.js";
import type { ScenarioFacts } from "./scenarios.js";

/** プロンプトの出力スキーマの例の値。応答がこれをそのまま返していたら、例のコピー。 */
export const SCHEMA_EXAMPLE_DEVELOPMENT = "展開予想の短文";
export const SCHEMA_EXAMPLE_PACE = "スロー・平均・ハイのいずれか";

export type ParseOutcome = "ok" | "mark-violation" | "unusable";

export interface CheckReport {
  readonly scenario: string;
  /** ok = 本番の解析が通る / mark-violation = 印の制約違反(確率は救済される) / unusable = 本番ではフォールバック(prior 採用)。 */
  readonly outcome: ParseOutcome;
  readonly error: string | null;
  /** 解析が通った(ok・mark-violation)とき、全馬分の馬番がそろっているか。 */
  readonly allUmabansPresent: boolean | null;
  readonly clippedCount: number | null;
  readonly missingCount: number | null;
  readonly development: string | null;
  /** development のコードポイント数(null のとき 0)。 */
  readonly developmentLength: number;
  /** プロンプトの指示(全角200字以内)を超えているか。 */
  readonly overInstructedLength: boolean;
  /** 生の応答の pace の値(JSON の値そのもの。キー無しは undefined → null)。 */
  readonly rawPace: unknown;
  readonly pace: string | null;
  /** 規則(旧プロンプトの結論)との一致。pace が null のときは null。 */
  readonly paceMatchesRule: boolean | null;
  /** development の本文に、pace の語(スロー/平均/ハイ)が含まれるか。pace が null のときは null。 */
  readonly developmentMentionsPace: boolean | null;
  /** キーの並びが development → pace → horses の順か(応答のテキスト上の最初の出現位置で見る)。 */
  readonly keyOrderOk: boolean;
  readonly copiedSchemaExample: boolean;
  /** development の生の値に、改行またはダブルクォートが含まれる(指示違反。JSON として読めた場合のみ判定できる)。 */
  readonly developmentHasForbiddenChars: boolean | null;
  /** 応答全体の文字数(コードポイント)。 */
  readonly responseLength: number;
}

function keyIndex(text: string, key: string): number {
  return text.indexOf(`"${key}"`);
}

export function checkResponse(text: string, facts: ScenarioFacts): CheckReport {
  const priors = facts.priors;
  let outcome: ParseOutcome = "unusable";
  let error: string | null = null;
  let clipped: number | null = null;
  let missing: number | null = null;
  let umabansOk: boolean | null = null;
  try {
    const r = parseAnalyzerResponse(text, priors, { maxAdjust: facts.maxAdjust });
    outcome = "ok";
    clipped = r.clippedCount;
    missing = r.missingCount;
    umabansOk = r.missingCount === 0;
  } catch (e) {
    if (e instanceof AnalyzerMarkViolationError) {
      outcome = "mark-violation";
      error = e.message;
      umabansOk = e.horses.every((h) => !h.usedPrior);
      clipped = e.horses.filter((h) => h.clipped).length;
      missing = e.horses.filter((h) => h.usedPrior).length;
    } else {
      error = e instanceof AnalyzerResponseParseError ? e.message : String(e);
    }
  }

  const { development, pace } = extractDevelopment(text);
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = extractJsonObject(text);
    obj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    obj = null;
  }
  const rawDev = obj === null ? undefined : obj["development"];
  const rawPace = obj === null ? null : (obj["pace"] ?? null);

  const iDev = keyIndex(text, "development");
  const iPace = keyIndex(text, "pace");
  const iHorses = keyIndex(text, "horses");
  const developmentLength = development === null ? 0 : Array.from(development).length;

  return {
    scenario: facts.scenario,
    outcome,
    error,
    allUmabansPresent: umabansOk,
    clippedCount: clipped,
    missingCount: missing,
    development,
    developmentLength,
    overInstructedLength: developmentLength > 200,
    rawPace,
    pace,
    paceMatchesRule: pace === null ? null : pace === facts.rule.pace,
    developmentMentionsPace: pace === null || development === null ? null : development.includes(pace) || (pace === "平均" && development.includes("ミドル")),
    keyOrderOk: iDev >= 0 && iPace >= 0 && iHorses >= 0 && iDev < iPace && iPace < iHorses,
    copiedSchemaExample: development === SCHEMA_EXAMPLE_DEVELOPMENT || rawPace === SCHEMA_EXAMPLE_PACE,
    developmentHasForbiddenChars: typeof rawDev === "string" ? /[\n\r"]/.test(rawDev.trim()) : null,
    responseLength: Array.from(text).length,
  };
}

/** 人が読む形の要約(CLI が標準出力に出す)。 */
export function formatReport(r: CheckReport, facts: ScenarioFacts): string {
  const yn = (v: boolean | null): string => (v === null ? "-" : v ? "はい" : "いいえ");
  return [
    `シナリオ ${r.scenario}: ${facts.title}`,
    `観察点: ${facts.observe}`,
    `解析: ${r.outcome}${r.error === null ? "" : `(${r.error})`}  全馬の馬番がそろう: ${yn(r.allUmabansPresent)}  クリップ ${r.clippedCount ?? "-"} 頭 / 欠け ${r.missingCount ?? "-"} 頭`,
    `規則の想定ペース(旧プロンプトの結論): ${facts.rule.pace}  →  LLM の pace: ${r.pace ?? "null"}(生の値: ${JSON.stringify(r.rawPace)})  規則と一致: ${yn(r.paceMatchesRule)}`,
    `development: ${r.developmentLength} コードポイント(指示 200・解析の上限 ${PARSE_DEVELOPMENT_MAX_CODEPOINTS})  指示超過: ${yn(r.overInstructedLength)}  pace の語を含む: ${yn(r.developmentMentionsPace)}  改行/ダブルクォート: ${yn(r.developmentHasForbiddenChars)}`,
    `キー順 development→pace→horses: ${yn(r.keyOrderOk)}  例のコピー: ${yn(r.copiedSchemaExample)}  応答の長さ: ${r.responseLength} 字`,
    `展開予想: ${r.development ?? "(なし)"}`,
  ].join("\n");
}
