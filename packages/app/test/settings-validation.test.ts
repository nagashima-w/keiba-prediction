import { describe, expect, it } from "vitest";

import {
  BASE_SCORE_WEIGHT_KEYS,
  BASE_SCORE_WEIGHT_LABELS,
  BET_ALLOCATION_LABELS,
  BIAS_WEIGHT_KEYS,
  BIAS_WEIGHT_LABELS,
  isValidBankroll,
  isValidKellyFraction,
  isValidPerRaceCap,
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

  describe("isValidBankroll(総資金: 0〜100,000,000の整数。機能C-2)", () => {
    it("0(未設定を表す既定値)・正の整数・上限ちょうどは妥当", () => {
      expect(isValidBankroll("0")).toBe(true);
      expect(isValidBankroll("100000")).toBe(true);
      expect(isValidBankroll("100000000")).toBe(true);
    });

    it("負値・非整数・上限超過・空・非数値は不正", () => {
      expect(isValidBankroll("-1")).toBe(false);
      expect(isValidBankroll("1.5")).toBe(false);
      expect(isValidBankroll("100000001")).toBe(false);
      expect(isValidBankroll("")).toBe(false);
      expect(isValidBankroll("abc")).toBe(false);
      expect(isValidBankroll("NaN")).toBe(false);
      expect(isValidBankroll("Infinity")).toBe(false);
    });
  });

  describe("isValidPerRaceCap(1レースの上限: 0〜10,000,000の整数。機能C-2)", () => {
    it("0(未設定を表す既定値)・正の整数・上限ちょうどは妥当", () => {
      expect(isValidPerRaceCap("0")).toBe(true);
      expect(isValidPerRaceCap("10000")).toBe(true);
      expect(isValidPerRaceCap("10000000")).toBe(true);
    });

    it("負値・非整数・上限超過・空・非数値は不正", () => {
      expect(isValidPerRaceCap("-1")).toBe(false);
      expect(isValidPerRaceCap("99.9")).toBe(false);
      expect(isValidPerRaceCap("10000001")).toBe(false);
      expect(isValidPerRaceCap("")).toBe(false);
      expect(isValidPerRaceCap("x")).toBe(false);
    });
  });

  describe("isValidKellyFraction(ケリー係数: 0.05〜1。機能C-2・UIからλ=0を到達不能にする)", () => {
    it("0.05(下限)・0.5・1(上限)は妥当", () => {
      expect(isValidKellyFraction("0.05")).toBe(true);
      expect(isValidKellyFraction("0.5")).toBe(true);
      expect(isValidKellyFraction("1")).toBe(true);
    });

    it("0(下限未満)・1.0000001(上限超過)・負値・空・非数値は不正", () => {
      expect(isValidKellyFraction("0")).toBe(false);
      expect(isValidKellyFraction("0.049")).toBe(false);
      expect(isValidKellyFraction("1.0000001")).toBe(false);
      expect(isValidKellyFraction("-0.1")).toBe(false);
      expect(isValidKellyFraction("")).toBe(false);
      expect(isValidKellyFraction("abc")).toBe(false);
    });
  });

  describe("BET_ALLOCATION_LABELS(機能C-2ラベル文字列の集約。1箇所定義)", () => {
    it("総資金・1レース上限・ケリー係数のラベルが定義されていること", () => {
      expect(BET_ALLOCATION_LABELS.bankroll).toBeTruthy();
      expect(BET_ALLOCATION_LABELS.bankrollHelp).toBeTruthy();
      expect(BET_ALLOCATION_LABELS.perRaceCap).toBeTruthy();
      expect(BET_ALLOCATION_LABELS.kellyFraction).toBeTruthy();
      // 総資金の補助文は「1レースで使う金額ではない」ことを明示する(仕様の必須要件)。
      expect(BET_ALLOCATION_LABELS.bankrollHelp).toContain("1レースで使う金額ではありません");
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
