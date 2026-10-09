import { describe, expect, it } from "vitest";
import { parseRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids.js";
import { syntheticRaceId } from "../measure-verify.js";

/** Issue #219: 検証の実測スクリプト(scripts/measure-verify.ts)の合成データの作り方の検査。測定そのもの(wrangler dev・/proc)は機械に依存するため固定しない。 */
describe("syntheticRaceId(合成のレース ID)", () => {
  it("1,301 件が互いに異なり、すべて 12 桁で、実在の形(parseRaceId を通る)。中央と地方が 7:3 で混ざる", () => {
    const ids = Array.from({ length: 1301 }, (_, i) => syntheticRaceId(i));
    expect(new Set(ids).size).toBe(1301);
    const kinds = ids.map((id) => venueKindOfRaceId(parseRaceId(id)));
    // 0〜1300: 10 件ごとに中央 7・地方 3。130 組 + 末尾の 1 件(中央)= 中央 911・地方 390
    expect(kinds.filter((k) => k === "central")).toHaveLength(911);
    expect(kinds.filter((k) => k === "nar")).toHaveLength(390);
  });
});
