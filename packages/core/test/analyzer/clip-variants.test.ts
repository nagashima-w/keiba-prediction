/**
 * クリップ幅の版(clip variant)registry の純関数テスト(タスクD-2: ±10%↔±15%のA/B・新版並走)。
 *
 * このレジストリ(CLIP_VARIANTS)が「単一の真実源」であることを検証する:
 *  - 対照(default)は幅0.10・版文字列(build-prompt.ts の既存PROMPT_VERSIONと同一の値を手動同期。
 *    #8で"2026-07-23.4"に更新)。
 *  - 新版(wide15)は幅0.15(絶対値)・対照と同じ日付系列+"-clip015"接尾辞の版文字列
 *    (ユーザー確定事項A: 対照のPROMPT_VERSION更新に新版も追随する運用。#8で"2026-07-23.4-clip015"に更新)。
 *  - resolveClipVariant は未指定・不正値を対照へフォールバックする。
 *  - clipPercentLabel/clipAbsoluteLabel は build-prompt.ts のプロンプト文面生成と
 *    parseAnalyzerResponse への maxAdjust 受け渡しの双方が同じ数値から導出するための整形関数。
 */

import { describe, expect, it } from "vitest";
import {
  clipAbsoluteLabel,
  clipPercentLabel,
  CLIP_VARIANTS,
  resolveClipVariant,
  type ClipVariantId,
} from "../../src/analyzer/clip-variants.js";

describe("CLIP_VARIANTS(クリップ幅の版registry)", () => {
  it("対照(default)は幅0.10・版文字列が既存PROMPT_VERSIONと同一の2026-07-23.4であること(#8で追随)", () => {
    expect(CLIP_VARIANTS.default.id).toBe("default");
    expect(CLIP_VARIANTS.default.maxAdjust).toBe(0.1);
    expect(CLIP_VARIANTS.default.promptVersion).toBe("2026-07-23.4");
  });

  it("新版(wide15)は幅0.15(絶対値)・対照と異なる版文字列を持つこと", () => {
    expect(CLIP_VARIANTS.wide15.id).toBe("wide15");
    expect(CLIP_VARIANTS.wide15.maxAdjust).toBe(0.15);
    expect(CLIP_VARIANTS.wide15.promptVersion).not.toBe(CLIP_VARIANTS.default.promptVersion);
    // 版文字列に幅を内包する運用(D-4合意)。
    expect(CLIP_VARIANTS.wide15.promptVersion).toContain("clip015");
  });

  it("新版(wide15)の版文字列は「対照と同じ日付系列」+「-clip015」接尾辞であること(#8で対照に追随。ユーザー確定事項A)", () => {
    // 対照が"2026-07-23.4"に更新されたら、新版は"2026-07-23.4-clip015"(対照の値+接尾辞)になる。
    expect(CLIP_VARIANTS.wide15.promptVersion).toBe(
      `${CLIP_VARIANTS.default.promptVersion}-clip015`,
    );
    expect(CLIP_VARIANTS.wide15.promptVersion).toBe("2026-07-23.4-clip015");
  });

  it("登録エントリはdefault/wide15の2件のみであること(±0.15の1新版のみ、ユーザー確定事項)", () => {
    expect(Object.keys(CLIP_VARIANTS).sort()).toEqual(["default", "wide15"]);
  });
});

describe("resolveClipVariant(variantId解決。不正値/未設定は対照へフォールバック)", () => {
  it("未指定(undefined)は対照(default)を返すこと", () => {
    expect(resolveClipVariant(undefined)).toBe(CLIP_VARIANTS.default);
  });

  it("null は対照(default)を返すこと", () => {
    expect(resolveClipVariant(null)).toBe(CLIP_VARIANTS.default);
  });

  it("未知の文字列(不正値)は対照(default)へフォールバックすること", () => {
    expect(resolveClipVariant("bogus" as ClipVariantId)).toBe(CLIP_VARIANTS.default);
  });

  it("'wide15' を渡すと新版を返すこと", () => {
    expect(resolveClipVariant("wide15")).toBe(CLIP_VARIANTS.wide15);
  });

  it("'default' を渡すと対照を返すこと", () => {
    expect(resolveClipVariant("default")).toBe(CLIP_VARIANTS.default);
  });
});

describe("clipPercentLabel/clipAbsoluteLabel(プロンプト文面の許容幅表記を導出する整形関数)", () => {
  it("0.10 は「10%」「0.10」になること", () => {
    expect(clipPercentLabel(0.1)).toBe("10%");
    expect(clipAbsoluteLabel(0.1)).toBe("0.10");
  });

  it("0.15 は「15%」「0.15」になること", () => {
    expect(clipPercentLabel(0.15)).toBe("15%");
    expect(clipAbsoluteLabel(0.15)).toBe("0.15");
  });
});
