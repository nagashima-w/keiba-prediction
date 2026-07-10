import { describe, expect, it } from "vitest";

import {
  BASE_SCORE_WEIGHT_KEYS,
  BASE_SCORE_WEIGHT_LABELS,
  BIAS_WEIGHT_KEYS,
  BIAS_WEIGHT_LABELS,
  isValidThreshold,
  isValidWebhookUrl,
  isValidWeight,
} from "../src/shared/settings.js";

describe("設定フォームの入力検証(純関数)", () => {
  describe("isValidThreshold(EV閾値 > 0)", () => {
    it("正の数は妥当", () => {
      expect(isValidThreshold("1.0")).toBe(true);
      expect(isValidThreshold("0.5")).toBe(true);
      expect(isValidThreshold("2")).toBe(true);
    });

    it("0・負数・空・非数値は不正", () => {
      expect(isValidThreshold("0")).toBe(false);
      expect(isValidThreshold("-1")).toBe(false);
      expect(isValidThreshold("")).toBe(false);
      expect(isValidThreshold("  ")).toBe(false);
      expect(isValidThreshold("abc")).toBe(false);
    });
  });

  describe("isValidWeight(重み >= 0)", () => {
    it("0以上の数は妥当", () => {
      expect(isValidWeight("0")).toBe(true);
      expect(isValidWeight("1.5")).toBe(true);
      expect(isValidWeight("0.2")).toBe(true);
    });

    it("負数・空・非数値は不正", () => {
      expect(isValidWeight("-0.1")).toBe(false);
      expect(isValidWeight("")).toBe(false);
      expect(isValidWeight("x")).toBe(false);
    });
  });

  describe("isValidWebhookUrl(URL形式・任意)", () => {
    it("空文字は許容(未設定)", () => {
      expect(isValidWebhookUrl("")).toBe(true);
      expect(isValidWebhookUrl("   ")).toBe(true);
    });

    it("http/https のURLは妥当", () => {
      expect(
        isValidWebhookUrl("https://discord.com/api/webhooks/123/abc"),
      ).toBe(true);
      expect(isValidWebhookUrl("http://example.com/x")).toBe(true);
    });

    it("URL形式でない・http以外は不正", () => {
      expect(isValidWebhookUrl("notaurl")).toBe(false);
      expect(isValidWebhookUrl("ftp://example.com")).toBe(false);
      expect(isValidWebhookUrl("discord.com/webhooks")).toBe(false);
    });
  });

  describe("重みキーの定義", () => {
    it("バイアス7種・基礎6種のキーが揃っている(仕様の重み項目)", () => {
      expect(BIAS_WEIGHT_KEYS).toHaveLength(7);
      expect(BASE_SCORE_WEIGHT_KEYS).toHaveLength(6);
      // すべてのキーに日本語ラベルが対応する。
      for (const key of BIAS_WEIGHT_KEYS) {
        expect(BIAS_WEIGHT_LABELS[key]).toBeTruthy();
      }
      for (const key of BASE_SCORE_WEIGHT_KEYS) {
        expect(BASE_SCORE_WEIGHT_LABELS[key]).toBeTruthy();
      }
    });
  });
});
