import { describe, expect, it } from "vitest";

import { coloLabel, COLO_CITIES } from "../src/colo-city";

/** Issue #812: 拠点のコードに添える都市名(固定の表)。表に無いコードは 3 文字だけ。 */
describe("coloLabel", () => {
  it.each([
    ["NRT", "NRT 成田"],
    ["KIX", "KIX 関西"],
    ["HKG", "HKG 香港"],
    ["SIN", "SIN シンガポール"],
    ["ICN", "ICN ソウル"],
    ["AMS", "AMS アムステルダム"],
    ["LAX", "LAX ロサンゼルス"],
    ["ATL", "ATL アトランタ"],
    ["MIA", "MIA マイアミ"],
    ["IAD", "IAD ワシントン"],
    ["ORD", "ORD シカゴ"],
    ["EWR", "EWR ニューヨーク"],
  ])("%s は「%s」", (code, label) => {
    expect(coloLabel(code)).toBe(label);
  });
  it("表に無いコードは 3 文字だけ", () => {
    expect(coloLabel("ZZZ")).toBe("ZZZ");
  });
  it("表のキーはすべて大文字 3 文字で、値は空でない", () => {
    expect(Object.keys(COLO_CITIES).length).toBeGreaterThanOrEqual(12);
    for (const [k, v] of Object.entries(COLO_CITIES)) {
      expect(k).toMatch(/^[A-Z]{3}$/);
      expect(v.length).toBeGreaterThan(0);
    }
  });
});
