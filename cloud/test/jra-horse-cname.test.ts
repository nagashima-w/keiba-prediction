import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { horseCnameSuffix } from "../src/jra-horse-cname";

/**
 * Issue #697: JRA の馬ごとの頁の cname の末尾の 2 桁(馬の ID 10 桁から計算する。`docs/investigations/past-blinker-695.md` §10)。
 * 本物の頁で確かめた 3 例と、フィクスチャのリンク(`pw01dud10<10桁>/<2桁>`)の全組を固定する。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = path.join(ROOT, "fixtures");

/** フィクスチャ(Shift_JIS の原本)のバイト列を latin1 として読み、リンクの cname を全部拾う(リンクは ASCII なので文字化けしない)。 */
function fixtureCnames(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(FIXTURE_DIR).filter((x) => x.endsWith(".html"))) {
    const text = readFileSync(path.join(FIXTURE_DIR, f)).toString("latin1");
    for (const m of text.matchAll(/pw01dud10(\d{10})\/([0-9A-F]{2})/g)) out.set(m[1]!, m[2]!);
  }
  return out;
}

describe("horseCnameSuffix(末尾の 2 桁の計算)", () => {
  it("本物の頁で確かめた 3 例(2019106837→9D、2018104667→01、2020103173→6C)", () => {
    expect(horseCnameSuffix("2019106837")).toBe("9D");
    expect(horseCnameSuffix("2018104667")).toBe("01"); // 0 埋めの 2 桁
    expect(horseCnameSuffix("2020103173")).toBe("6C"); // 16 進は大文字
  });

  it("フィクスチャのリンク 123 組すべてで、計算した 2 桁がリンクの 2 桁と一致する", () => {
    const pairs = fixtureCnames();
    expect(pairs.size, "前提: 組を拾えている").toBe(123);
    for (const [id, suffix] of pairs) {
      expect(horseCnameSuffix(id), id).toBe(suffix);
    }
  });

  it("桁ごとの重み(143・107・140・206・239・49・16・115)。1 桁だけ変えると、重み × 差だけ動く(重みの 1 つだけを変えた変異で赤になる)", () => {
    const base = "2018106541"; // 計算値 DC = 220
    const baseValue = parseInt(horseCnameSuffix(base)!, 16);
    expect(baseValue).toBe(0xdc);
    // [桁の位置(0 始まり), 重み]。位置 1・4(重み 0)は計算の対象外の桁なので入れない。
    const weights: [number, number][] = [[0, 143], [2, 107], [3, 140], [5, 206], [6, 239], [7, 49], [8, 16], [9, 115]];
    for (const [pos, w] of weights) {
      const digits = base.split("");
      const old = Number(digits[pos]);
      const next = (old + 1) % 10; // +1 になるとは限らない(9→0)ので、実際の差を使う
      digits[pos] = String(next);
      const got = parseInt(horseCnameSuffix(digits.join(""))!, 16);
      expect(got, `位置 ${pos}`).toBe((((baseValue + w * (next - old)) % 256) + 256) % 256);
      expect(got, `位置 ${pos} は基準から動く(差が 0 でない)`).not.toBe(baseValue);
    }
  });

  it("定数 K(177)は、全桁 0 の ID(2 桁目 0・5 桁目 1 を許す形)で現れる", () => {
    // 0000100000 → K + 0 = 177 = B1
    expect(horseCnameSuffix("0000100000")).toBe("B1");
  });

  it("重み 0 の桁(2 桁目は 0/9、5 桁目は 1)以外は、計算を信用できないので null", () => {
    expect(horseCnameSuffix("2018106541")).not.toBeNull();
    expect(horseCnameSuffix("2918106541")).not.toBeNull(); // 2 桁目 9
    expect(horseCnameSuffix("2518106541")).toBeNull(); // 2 桁目 5
    expect(horseCnameSuffix("2018006541")).toBeNull(); // 5 桁目 0
    expect(horseCnameSuffix("2018206541")).toBeNull(); // 5 桁目 2
  });

  it("10 桁の数字でない ID は null", () => {
    for (const bad of ["", "201810654", "20181065411", "201810654a", "２０１８１０６５４１", " 2018106541"]) {
      expect(horseCnameSuffix(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
