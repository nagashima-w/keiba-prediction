import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_DARK, WEB_LIGHT } from "../src/palette";

/**
 * Issue #740: リポジトリ直下の DESIGN.md(画面の見た目の決まり。google-labs-code/design.md の形式: YAML の前書き + 本文の `##` 節)が、
 * 色の正(src/palette.ts)と食い違わないことを固定する。DESIGN.md は色の値を書き写しているだけで、正は palette.ts の 1 箇所のまま。
 * 前書きの colors のトークン名は、ライトが `paper`・`paper-alt`・`ink`・`ink-muted`・`rule`・`link`・`brand`・`ok`・`wait`・`fail`、ダークは同じ名前に `-night` を付ける。
 */
const text = readFileSync(path.join(__dirname, "..", "..", "DESIGN.md"), "utf8");
const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";

function colorsOf(): Record<string, string> {
  const block = /^colors:\n((?:  [a-z-]+: "#[0-9a-fA-F]{6}"\n?)+)/m.exec(`${front}\n`)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/^  ([a-z-]+): "(#[0-9a-fA-F]{6})"/gm)) out[m[1]!] = m[2]!;
  return out;
}
const TOKENS = { paper: "bg", "paper-alt": "card", ink: "fg", "ink-muted": "muted", rule: "line", link: "accent", brand: "brand", ok: "ok", wait: "wait", fail: "fail" } as const;
const SECTIONS = ["Overview", "Colors", "Typography", "Layout", "Elevation & Depth", "Shapes", "Components", "Do's and Don'ts"];

describe("DESIGN.md(Issue #740)", () => {
  it("前書き(YAML)が name・colors・typography・rounded・spacing・components を持つ", () => {
    expect(front).not.toBe("");
    for (const key of ["name", "colors", "typography", "rounded", "spacing", "components"]) expect(front, key).toMatch(new RegExp(`^${key}:`, "m"));
  });

  it("colors は 20 個(ライト 10・ダーク 10)すべて読め、palette.ts の WEB_LIGHT・WEB_DARK と同じ値", () => {
    const colors = colorsOf();
    expect(Object.keys(colors)).toHaveLength(20);
    for (const [token, key] of Object.entries(TOKENS)) {
      expect(colors[token], token).toBe(WEB_LIGHT[key]);
      expect(colors[`${token}-night`], `${token}-night`).toBe(WEB_DARK[key]);
    }
  });

  it("本文の `##` 節が、決まった順に並ぶ(Overview → … → Do's and Don'ts)", () => {
    const found = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
    expect(found).toEqual(SECTIONS);
  });

  it("rounded は角丸なし(0)と円形(50%)だけ", () => {
    const rounded = /^rounded:\n((?:  .+\n)+)/m.exec(`${front}\n`)?.[1] ?? "";
    expect(rounded.trim().split("\n").map((l) => l.trim().split(": ")[1])).toEqual(["0", "50%"]);
  });
});
