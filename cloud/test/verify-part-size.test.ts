import { serialize } from "node:v8";
import { describe, expect, it } from "vitest";
import { buildVerifyPart, PRODUCTION_VERIFY_CONFIG, buildPromptVersionParts } from "../../packages/core/src/ev/verify.js";
import { randomVerifyData } from "../../packages/core/test/support/verify-random-data.js";
import { buildCloseParts } from "../src/verify-close";
import { buildVerifyBreakdownParts } from "../src/verify-breakdown";

/**
 * Issue #625: 部分の大きさ(開催日ごとの保存〈段階 3〉の見積り用)。1 レースあたりのバイト数を、乱数のデータ(40 レース・馬は 5〜16 頭・買い目 1〜6 点)で測る。
 * 測った値は `PART_SIZE=1 pnpm exec vitest run test/verify-part-size.test.ts` で標準エラーに出る。上限は、部分が肥大化していないことだけを見る緩い値。
 */
describe("部分の大きさ(Issue #625)", () => {
  it("1 レースあたりのバイト数(JSON と v8 の構造化複製)が上限に収まる", () => {
    const { source, analyses, raceIds } = randomVerifyData(91, 40);
    const parts = {
      全体: buildVerifyPart(source, analyses, PRODUCTION_VERIFY_CONFIG),
      版別: buildPromptVersionParts(source, analyses, PRODUCTION_VERIFY_CONFIG),
      締切: buildCloseParts(source, { meta: analyses.flatMap((a) => [1, 2].map((round) => ({ analysisId: a.id, round, status: "ok", route: "mixed", skipReasonCode: null }))), bets: [] }, analyses, new Set()),
      内訳: buildVerifyBreakdownParts(source, [], analyses),
    };
    const races = raceIds.length;
    const sizes = Object.entries(parts).map(([name, part]) => ({ name, json: JSON.stringify(part).length / races, v8: serialize(part).length / races }));
    if (process.env.PART_SIZE !== undefined) {
      process.stderr.write(`PART_SIZE(1 レースあたりのバイト数, ${races} レース)\n${sizes.map((s) => `${s.name}: JSON ${s.json.toFixed(0)} / v8 ${s.v8.toFixed(0)}`).join("\n")}\n`);
    }
    for (const s of sizes) {
      expect(s.json, s.name).toBeGreaterThan(0);
      expect(s.json, s.name).toBeLessThan(6000);
    }
  });
});
