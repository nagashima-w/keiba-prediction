/**
 * LLM の所要時間・usage の表示用データ(Issue #198。純関数・import は型だけ)。`result.ts` の `contentOf` が使う。
 *
 * 公開後に、ユーザーが普段の分析で費用(トークン数)・時間・出力の切り詰めを確かめるための表示。サーバの記録(`llmCalls`。#197)を、次の形に畳む:
 *  - 要約の1行: 「LLM: 2回・2分11秒・入力 30,002・出力(思考を含む) 22,020 トークン」
 *  - 警告の行(該当するものだけ): 切り詰め(`stopReason` が `max_tokens`)・拒否(`refusal`)・失敗・再生・記録の欠け
 *
 * 決定(着手前の合意):
 *  - **再生した呼び出し(`replayed`)も合計に含める。** 再生の1件は、前の実行で実際に消費があった呼び出しの**唯一の記録**(元の呼び出しの記録は、前の実行と一緒に消えている。
 *    cloud README の「呼び出しの記録」)なので、含めても二重にならない。除外すると、再実行を挟んだ分析の費用・時間が過小に見える。警告で「うち N 回は再生」と明示する
 *  - **出力トークンは thinking を含む**(max_tokens の中に数えられる)ので、ラベルに「出力(思考を含む)」と常に書く
 *  - 外から来た文字列(`stopReason`・`error`・`model`)は、画面に出さない。`stopReason` は固定の2語(`max_tokens`・`refusal`)との一致を数えるだけ
 *  - 切り詰めの上限の数値(`max_tokens`)は記録に無いので、文言に書かない
 */
import type { LlmCall } from "./api-analysis";

export interface LlmUsageView {
  /** 要約の1行(「LLM: …」)。 */
  readonly summary: string;
  /** 警告の行(該当するものだけ。並びは切り詰め → 拒否 → 失敗 → 再生 → 記録の欠け)。 */
  readonly warnings: readonly string[];
}

/** 所要時間の表記。1秒未満は「1秒未満」、60秒未満は整数秒、それ以上は「2分05秒」(四捨五入して60秒になるときは分に繰り上げる)。 */
export function formatLlmDuration(ms: number): string {
  if (ms < 1000) {
    return "1秒未満";
  }
  const total = Math.round(ms / 1000);
  if (total < 60) {
    return `${total}秒`;
  }
  return `${Math.floor(total / 60)}分${String(total % 60).padStart(2, "0")}秒`;
}

/** トークン数の桁区切り(`toLocaleString` は実行環境のロケールに依るので使わない)。整数に丸める。 */
export function formatTokenCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 値のある要素だけの合計。1つも無ければ null(「0」と「分からない」を区別する)。 */
function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

/** 記録(1件以上)から表示用データを作る。 */
export function buildLlmUsage(calls: readonly LlmCall[]): LlmUsageView {
  const ms = sumKnown(calls.map((c) => c.ms));
  const input = sumKnown(calls.map((c) => c.inputTokens));
  const output = sumKnown(calls.map((c) => c.outputTokens));

  const parts = [`LLM: ${calls.length}回`];
  if (ms !== null) {
    parts.push(formatLlmDuration(ms));
  }
  const tokens: string[] = [];
  if (input !== null) {
    tokens.push(`入力 ${formatTokenCount(input)}`);
  }
  if (output !== null) {
    tokens.push(`出力(思考を含む) ${formatTokenCount(output)}`);
  }
  if (tokens.length > 0) {
    parts.push(`${tokens.join("・")} トークン`);
  }

  const truncated = calls.filter((c) => c.stopReason === "max_tokens").length;
  const refused = calls.filter((c) => c.stopReason === "refusal").length;
  const failed = calls.filter((c) => !c.ok).length;
  const replayed = calls.filter((c) => c.replayed).length;
  // 記録の欠け: 時間が測れていない、または応答を得た呼び出しでトークン数が無い(失敗の呼び出しは、応答が無いのでトークン数が null なのが正常)。
  const unmeasured = calls.some((c) => c.ms === null || (c.ok && (c.inputTokens === null || c.outputTokens === null)));

  const warnings: string[] = [];
  if (truncated > 0) warnings.push(`出力の上限に達して途中で切れた呼び出しが ${truncated} 回ありました`);
  if (refused > 0) warnings.push(`拒否された呼び出しが ${refused} 回ありました`);
  if (failed > 0) warnings.push(`失敗した呼び出しが ${failed} 回ありました`);
  if (replayed > 0) warnings.push(`うち ${replayed} 回は、前の実行で記録した応答を再生したものです(時間・トークン数は元の呼び出しの値)`);
  if (unmeasured) warnings.push("一部の呼び出しは時間・トークン数の記録が無く、合計はその分を含みません");

  return { summary: parts.join("・"), warnings };
}
