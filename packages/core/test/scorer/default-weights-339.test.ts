import { describe, expect, it } from "vitest";
import { DEFAULT_SCORER_CONFIG } from "../../src/scorer/config.js";

/**
 * Issue #339(#258 第 2 段 a): 既定の重みを、本番の書き出し(#266。871 レース・11,339 頭)で当て直した値に固定する。
 * 値の根拠は config.ts の JSDoc と #258 のコメント(2026-10-16)。当てていない期間の検証で、
 * Brier が 0.0091〜0.0107 良くなった(基礎スコアは軽すぎ、バイアス 7 項目は結果とほぼ無関係なノイズだった)。
 * ここで固定するのは「変えた 4 値」と「据え置いた値」。取り違え(例: 騎手を一緒に上げる)を検出する。
 */
describe("既定の重み(Issue #339。#258 第 2 段 a)", () => {
  it("変えた 4 値: 近走着順 0.7・上がり3F 0.15・コース距離 0.3・バイアスの一律減衰 0.05", () => {
    expect(DEFAULT_SCORER_CONFIG.baseScore.weights.recentForm).toBe(0.7);
    expect(DEFAULT_SCORER_CONFIG.baseScore.weights.last3f).toBe(0.15);
    expect(DEFAULT_SCORER_CONFIG.baseScore.weights.courseDistance).toBe(0.3);
    expect(DEFAULT_SCORER_CONFIG.prior.biasCorrectionScale).toBe(0.05);
  });

  it("据え置いた値: 騎手 0.15(データ待ち)・斤量 1・コース枠順 1・バイアス 7 個の重み 1", () => {
    const base = DEFAULT_SCORER_CONFIG.baseScore.weights;
    expect(base.jockey).toBe(0.15);
    expect(base.weightChange).toBe(1);
    expect(base.courseFrameBias).toBe(1);
    expect(Object.values(DEFAULT_SCORER_CONFIG.weights)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("式に関わる他の設定は変えない(中立 0.33・クランプ・目標 3 頭)", () => {
    expect(DEFAULT_SCORER_CONFIG.baseScore.neutralPlaceRate).toBe(0.33);
    expect(DEFAULT_SCORER_CONFIG.prior.minPrior).toBe(0.02);
    expect(DEFAULT_SCORER_CONFIG.prior.maxPrior).toBe(0.95);
    expect(DEFAULT_SCORER_CONFIG.prior.targetPlaceCount).toBe(3);
  });
});
