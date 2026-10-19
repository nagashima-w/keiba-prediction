import { describe, expect, it } from "vitest";
import { toContributions } from "../../cloud/src/prior-export-format.js";
import { syntheticContributions } from "../measure-prior-export.js";
import { seededRandom } from "../synthetic-random.js";

/** Issue #266: 書き出しの実測スクリプト(scripts/measure-prior-export.ts)の合成データの作り方の検査。測定そのもの(wrangler dev・/proc)は機械に依存するため固定しない。 */
describe("syntheticContributions(合成の寄与度)", () => {
  it("本番の形(core の ScoreContribution の配列。13 項目)で、書き出しの toContributions が null にしない。乱数が違えば値が違う(同じ値の繰り返しで圧縮率が良くなりすぎない)", () => {
    const a = syntheticContributions(seededRandom(1));
    expect(a).toHaveLength(13);
    expect(toContributions(a)).not.toBeNull();
    expect(toContributions(a)).toHaveLength(13);
    const b = syntheticContributions(seededRandom(2));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("自由文の reason を持つ(書き出しが落とすことを実測でも確かめるため)。名前が重複しない", () => {
    const a = syntheticContributions(seededRandom(1)) as Array<{ reason?: string; biasName: string }>;
    expect(a.every((c) => typeof c.reason === "string" && c.reason.length > 0)).toBe(true);
    expect(new Set(a.map((c) => c.biasName)).size).toBe(13);
  });
});
