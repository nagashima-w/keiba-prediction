/**
 * LLM 呼び出しの記録(Issue #197・#196-a の段2)。**純ロジック**(import なし)。
 * クラウド版の発走前の分析で、LLM を呼ぶたびに1件ずつ記録し、`analyses.llm_calls_json`(JSON 配列の文字列)に保存する。
 * 公開後に、普段の分析で費用(トークン数)・時間・切り詰め(`stopReason`)を確かめるための記録。画面は #198。
 *
 * 記録するのは数値・固定の短い語だけ: プロンプト・応答の本文・API キー・エラーの本文は入れない
 * (`error` は `llm-run.ts` の `describeLlmErrorForLog` の出力、`status=429`・`種別=timeout` のような固定の形だけ)。
 */

/** LLM の1回の呼び出し(SDK への1リクエスト。`analyzeRace` の再送・モデルの切り替えの再送は、それぞれ別の1件になる)。 */
export interface LlmCallRecord {
  /** 応答を得られたか(HTTP の成功)。false は例外(認証・レート制限・タイムアウトなど)で、応答が無い。応答の中身の判定〈切り詰め・拒否・解析失敗〉は `stopReason` を見る。 */
  readonly ok: boolean;
  /** 呼び出しの所要時間(ミリ秒。送信から応答または例外まで)。測っていない(旧い記録の再生)ときは null。 */
  readonly ms: number | null;
  /** 入力トークン数(応答の usage)。応答が無い・usage が無いときは null。 */
  readonly inputTokens: number | null;
  /** 出力トークン数(応答の usage)。**thinking を含む**(max_tokens=16000 の中に数えられる)。応答が無い・usage が無いときは null。 */
  readonly outputTokens: number | null;
  /** 停止の理由(`end_turn`・`max_tokens`〈切り詰め〉・`refusal`〈拒否〉など)。応答が無いときは null。 */
  readonly stopReason: string | null;
  /** 実際に応答したモデル ID。応答が無いときは null。 */
  readonly model: string | null;
  /**
   * 前の実行の記録を再生した呼び出しか(計算ステップの再実行で、LLM に送り直さずに記録した応答を使った。Issue #194 の記録・再生)。
   * true の件の `ms`・トークンは**元の呼び出しのとき**の値で、課金・時間は元の1回きり(合計に二重に数えない)。
   */
  readonly replayed: boolean;
  /** 失敗の固定の説明(`status=429`・`種別=timeout` など。本文は入れない)。成功のときは null。 */
  readonly error: string | null;
}

/** 保存する JSON 文字列。記録なし(null・undefined・空配列)は null(NULL で保存する)。 */
export function serializeLlmCalls(calls: readonly LlmCallRecord[] | null | undefined): string | null {
  if (calls === null || calls === undefined || calls.length === 0) {
    return null;
  }
  return JSON.stringify(
    calls.map((c) => ({ ok: c.ok, ms: c.ms, inputTokens: c.inputTokens, outputTokens: c.outputTokens, stopReason: c.stopReason, model: c.model, replayed: c.replayed, error: c.error })),
  );
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * 保存した JSON 文字列から記録を復元する。**例外を投げない**: NULL・壊れた JSON・配列でない値・オブジェクトでない要素は、捨てる(記録なしは null)。
 * 許可したキーだけを、型を確かめて返す(余分なキーは返さない)。
 */
export function parseLlmCalls(raw: string | null | undefined): LlmCallRecord[] | null {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const calls: LlmCallRecord[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    calls.push({
      ok: e["ok"] === true,
      ms: count(e["ms"]),
      inputTokens: count(e["inputTokens"]),
      outputTokens: count(e["outputTokens"]),
      stopReason: text(e["stopReason"]),
      model: text(e["model"]),
      replayed: e["replayed"] === true,
      error: text(e["error"]),
    });
  }
  return calls.length === 0 ? null : calls;
}
