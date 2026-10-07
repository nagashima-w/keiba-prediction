import { describe, expect, it } from "vitest";
import type { LlmCall } from "../client/api-analysis";
import { buildLlmUsage, formatLlmDuration, formatTokenCount } from "../client/llm-usage";

/**
 * Issue #198: LLM の所要時間・usage の表示用データ(純関数)。公開後に、普段の分析で費用(トークン数)・時間・出力の切り詰めを確かめるための表示。
 * 決定(ゲート・着手前の合意):
 *  - 件数・時間・トークンは、**再生した呼び出し(`replayed`)も含めて合計する**。再生の1件は、前の実行で実際に課金・消費があった呼び出しの**唯一の記録**
 *    (元の呼び出しの記録は前の実行と一緒に消えている)ので、含めても二重にならない。警告欄で「うち N 回は再生」と明示する
 *  - 出力トークンは thinking を含むので、ラベルに「出力(思考を含む)」と常に書く
 *  - 切り詰め(`stopReason` が `max_tokens`)・拒否(`refusal`)・失敗(`ok` が false)・再生・記録の欠けは、警告として別の行にする。**数値の上限は文言に書かない**(記録に無い)
 */

const OK: LlmCall = { ok: true, ms: 41_234, inputTokens: 15_001, outputTokens: 6_020, stopReason: "end_turn", model: "claude-sonnet-5-5", replayed: false, error: null };
const FAILED: LlmCall = { ok: false, ms: 180_001, inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: "種別=timeout" };
const TRUNCATED: LlmCall = { ...OK, ms: 90_000, inputTokens: 15_001, outputTokens: 16_000, stopReason: "max_tokens" };
const REFUSED: LlmCall = { ...OK, ms: 3_000, outputTokens: 40, stopReason: "refusal" };
const REPLAYED: LlmCall = { ...OK, replayed: true };
const REPLAYED_NO_MEASURE: LlmCall = { ...OK, replayed: true, ms: null, inputTokens: null, outputTokens: null };

describe("formatLlmDuration(所要時間の表記)", () => {
  it.each([
    [0, "1秒未満"],
    [999, "1秒未満"],
    [1000, "1秒"],
    [1499, "1秒"],
    [1500, "2秒"],
    [41_234, "41秒"],
    [59_499, "59秒"],
    [59_500, "1分00秒"], // 四捨五入して 60 秒になるときは「60秒」ではなく分に繰り上げる
    [60_000, "1分00秒"],
    [125_000, "2分05秒"],
    [221_235, "3分41秒"],
    [3_600_000, "60分00秒"],
  ])("%i ms → %s", (ms, expected) => {
    expect(formatLlmDuration(ms)).toBe(expected);
  });
});

describe("formatTokenCount(桁区切り。実行環境のロケールに依らない)", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1,000"],
    [5123, "5,123"],
    [16_000, "16,000"],
    [1_234_567, "1,234,567"],
    [1234.6, "1,235"], // 整数に丸める
  ])("%d → %s", (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected);
  });
});

describe("buildLlmUsage: 要約の1行", () => {
  it("1回・成功: 回数・時間・入力・出力(思考を含む)のトークン数。警告なし", () => {
    expect(buildLlmUsage([OK])).toEqual({ summary: "LLM: 1回・41秒・入力 15,001・出力(思考を含む) 6,020 トークン", warnings: [] });
  });

  it("再送(失敗 → 成功): 回数・時間は全部を合計し(失敗の時間も含む)、トークンは応答があった分。失敗の警告が出る", () => {
    const u = buildLlmUsage([FAILED, OK]);
    expect(u.summary).toBe("LLM: 2回・3分41秒・入力 15,001・出力(思考を含む) 6,020 トークン"); // 180,001 + 41,234 = 221,235 ms
    expect(u.warnings).toEqual(["失敗した呼び出しが 1 回ありました"]);
  });

  it("切り詰め(max_tokens)のあと再送で成功: 2回分を合計し、切り詰めの警告が出る。上限の数値は文言に書かない", () => {
    const u = buildLlmUsage([TRUNCATED, OK]);
    expect(u.summary).toBe("LLM: 2回・2分11秒・入力 30,002・出力(思考を含む) 22,020 トークン"); // 90,000 + 41,234 = 131,234 ms
    expect(u.warnings).toEqual(["出力の上限に達して途中で切れた呼び出しが 1 回ありました"]);
    expect(u.warnings.join("")).not.toMatch(/16,?000/);
  });

  it("切り詰めが複数回なら、その回数", () => {
    expect(buildLlmUsage([TRUNCATED, TRUNCATED, OK]).warnings).toEqual(["出力の上限に達して途中で切れた呼び出しが 2 回ありました"]);
  });

  it("拒否(refusal)は拒否の警告。切り詰めとは別に数える", () => {
    expect(buildLlmUsage([REFUSED, TRUNCATED]).warnings).toEqual(["出力の上限に達して途中で切れた呼び出しが 1 回ありました", "拒否された呼び出しが 1 回ありました"]);
  });

  it("全回が失敗(フォールバックした分析): 回数と時間だけ。トークンの項は出さない。失敗の回数の警告", () => {
    const u = buildLlmUsage([FAILED, FAILED]);
    expect(u.summary).toBe("LLM: 2回・6分00秒"); // 360,002 ms
    expect(u.warnings).toEqual(["失敗した呼び出しが 2 回ありました"]);
    expect(u.summary).not.toContain("トークン");
  });

  it("再生した呼び出しは合計に含める(その1件が、実際に消費した呼び出しの唯一の記録)。警告欄で「うち N 回は再生」と明示する", () => {
    const only = buildLlmUsage([REPLAYED]);
    expect(only.summary, "再生の1件だけでも、元の値を合計に出す(除外すると費用が過小に見える)").toBe("LLM: 1回・41秒・入力 15,001・出力(思考を含む) 6,020 トークン");
    expect(only.warnings).toEqual(["うち 1 回は、前の実行で記録した応答を再生したものです(時間・トークン数は元の呼び出しの値)"]);
    // 再生 + 実送信(再実行のあとに、別の呼び出しがあった)は、両方を足す
    const both = buildLlmUsage([REPLAYED, { ...OK, ms: 10_000, inputTokens: 1_000, outputTokens: 2_000 }]);
    expect(both.summary).toBe("LLM: 2回・51秒・入力 16,001・出力(思考を含む) 8,020 トークン");
    expect(both.warnings).toHaveLength(1);
  });

  it("測っていない旧い記録の再生(時間・トークンが null): 値を足さず、要約は回数だけ。『記録が無い』警告を出す", () => {
    const u = buildLlmUsage([REPLAYED_NO_MEASURE]);
    expect(u.summary).toBe("LLM: 1回");
    expect(u.warnings).toEqual(["うち 1 回は、前の実行で記録した応答を再生したものです(時間・トークン数は元の呼び出しの値)", "一部の呼び出しは時間・トークン数の記録が無く、合計はその分を含みません"]);
  });

  it("一部だけ記録が無いとき: 記録のある分だけを合計し、『記録が無い』警告を出す(失敗の null は欠けではないので、警告の対象にしない)", () => {
    const u = buildLlmUsage([REPLAYED_NO_MEASURE, OK]);
    expect(u.summary).toBe("LLM: 2回・41秒・入力 15,001・出力(思考を含む) 6,020 トークン");
    expect(u.warnings.some((w) => w.startsWith("一部の呼び出しは時間・トークン数の記録が無く"))).toBe(true);
    // 失敗の呼び出しだけが null を持つ場合は、欠けの警告を出さない
    expect(buildLlmUsage([FAILED, OK]).warnings.some((w) => w.includes("記録が無く"))).toBe(false);
  });

  it("入力だけ・出力だけが分かるときは、分かる側だけを出す", () => {
    expect(buildLlmUsage([{ ...OK, outputTokens: null }]).summary).toBe("LLM: 1回・41秒・入力 15,001 トークン");
    expect(buildLlmUsage([{ ...OK, inputTokens: null }]).summary).toBe("LLM: 1回・41秒・出力(思考を含む) 6,020 トークン");
    expect(buildLlmUsage([{ ...OK, ms: null }]).summary).toBe("LLM: 1回・入力 15,001・出力(思考を含む) 6,020 トークン");
  });

  it("警告の並び: 切り詰め → 拒否 → 失敗 → 再生 → 記録の欠け。すべて重なっても、その順で1回ずつ", () => {
    const u = buildLlmUsage([TRUNCATED, REFUSED, FAILED, REPLAYED_NO_MEASURE]);
    expect(u.warnings).toEqual([
      "出力の上限に達して途中で切れた呼び出しが 1 回ありました",
      "拒否された呼び出しが 1 回ありました",
      "失敗した呼び出しが 1 回ありました",
      "うち 1 回は、前の実行で記録した応答を再生したものです(時間・トークン数は元の呼び出しの値)",
      "一部の呼び出しは時間・トークン数の記録が無く、合計はその分を含みません",
    ]);
  });

  it("未知の stopReason・エラーの説明・モデル名は、画面のデータに出さない(外から来た文字列を、要約と警告に混ぜない)", () => {
    const u = buildLlmUsage([{ ...OK, stopReason: "<img src=x onerror=alert(1)>", model: "<b>m</b>" }, { ...FAILED, error: "<script>x</script>" }]);
    expect(JSON.stringify(u)).not.toMatch(/<img|<b>|<script>/);
    expect(u.warnings, "未知の stopReason は切り詰め・拒否に数えない").toEqual(["失敗した呼び出しが 1 回ありました"]);
  });

  it("入力の配列を変更しない", () => {
    const calls = [FAILED, OK];
    const copy = JSON.parse(JSON.stringify(calls));
    buildLlmUsage(calls);
    expect(calls).toEqual(copy);
  });
});
