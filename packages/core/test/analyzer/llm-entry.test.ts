/**
 * Issue #193(#179-a): 狭い入口 `src/llm.ts`(`@keiba/core/llm`)が公開する名前。
 * クラウド版(`cloud/`)が LLM の実行(#179-b)で使うものを、バレル(`index.ts`)を経由せずに取れること。
 * バレルと同じ実体を指す(別実装ではない)ことを、値の同一性で固定する。
 */
import { describe, expect, it } from "vitest";
import * as barrelFree from "../../src/llm.js";
import { analyzeRace } from "../../src/analyzer/analyze-race.js";
import {
  AnthropicLlmClient,
  createSdkMessageSender,
  DEFAULT_ANALYZER_CONFIG,
} from "../../src/analyzer/anthropic-client.js";
import {
  createModelSelector,
  createSdkModelLister,
} from "../../src/analyzer/model-selection.js";
import {
  FALLBACK_REASON_INVOCATION_ERROR,
  FALLBACK_REASON_PARSE_ERROR,
  FALLBACK_REASON_REFUSED,
  FALLBACK_REASON_TRUNCATED,
} from "../../src/analyzer/analyze-race.js";

describe("src/llm.ts の公開物(Issue #193)", () => {
  it("analyzeRace・AnthropicLlmClient・createSdkMessageSender・モデル選択・既定設定・フォールバックの固定文言を、元の実体のまま公開する", () => {
    expect(barrelFree.analyzeRace).toBe(analyzeRace);
    expect(barrelFree.AnthropicLlmClient).toBe(AnthropicLlmClient);
    expect(barrelFree.createSdkMessageSender).toBe(createSdkMessageSender);
    expect(barrelFree.createModelSelector).toBe(createModelSelector);
    expect(barrelFree.createSdkModelLister).toBe(createSdkModelLister);
    expect(barrelFree.DEFAULT_ANALYZER_CONFIG).toBe(DEFAULT_ANALYZER_CONFIG);
    expect(barrelFree.FALLBACK_REASON_TRUNCATED).toBe(FALLBACK_REASON_TRUNCATED);
    expect(barrelFree.FALLBACK_REASON_PARSE_ERROR).toBe(FALLBACK_REASON_PARSE_ERROR);
    expect(barrelFree.FALLBACK_REASON_INVOCATION_ERROR).toBe(FALLBACK_REASON_INVOCATION_ERROR);
    expect(barrelFree.FALLBACK_REASON_REFUSED).toBe(FALLBACK_REASON_REFUSED);
  });

  it("前提(空振り防止): 公開された値は、すべて実在する(undefined がない)", () => {
    const values = Object.values(barrelFree);
    expect(values.length).toBeGreaterThanOrEqual(10);
    expect(values.every((v) => v !== undefined)).toBe(true);
  });
});
