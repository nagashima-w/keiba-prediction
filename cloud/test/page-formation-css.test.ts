import { describe, expect, it } from "vitest";
import { FORMATION_SLOTS } from "../client/formation-model";
import { renderPage } from "../src/page";

/**
 * Issue #362(想定隊列図): 図の位置は VNode の `style` 属性ではなく、`data-slot` 属性 + CSS の `grid-column` で決める(`dom.ts` は `style` を作れない)。
 * したがって、CSS が全列(0〜FORMATION_SLOTS − 1)の規則を持っていなければ、その列のチップは位置が決まらない。
 * レース再生(#311)の CSS(`.replay-*`)は消えている。
 */
const css = (/<style>([\s\S]*?)<\/style>/.exec(renderPage("owner@example.com", "admin"))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("想定隊列図の CSS", () => {
  it("前提: 列の本数は 10(格子の列の数 repeat(10, …) と一致させる)", () => {
    expect(FORMATION_SLOTS).toBe(10);
    expect(css).toContain(`grid-template-columns: repeat(${FORMATION_SLOTS},`);
  });

  it("全列(0〜9)に grid-column の規則がある。列 n は n + 1 番目の格子の列", () => {
    for (let n = 0; n < FORMATION_SLOTS; n++) {
      expect(css, `列 ${n}`).toContain(`.formation-chip[data-slot="${n}"] { grid-column: ${n + 1}; }`);
    }
    // 列 10 以上の規則は無い(列の本数を超えるチップは出ない)
    expect(css).not.toContain(`data-slot="${FORMATION_SLOTS}"`);
  });

  it("同じ列のチップは縦に積む(密な自動配置)。◎のチップは accent の太枠", () => {
    expect(css).toMatch(/\.formation-track \{[^}]*grid-auto-flow: row dense;/);
    expect(css).toMatch(/\.formation-chip\.formation-main \{[^}]*border: 3px solid var\(--accent\);/);
  });

  it("レース再生の CSS(.replay-*)は残っていない", () => {
    expect(css).not.toContain(".replay-");
  });
});
