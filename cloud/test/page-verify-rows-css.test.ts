import { describe, expect, it } from "vitest";
import { renderPage } from "../src/page";

/**
 * Issue #369(日報の「もしも」などの行が、スマホの幅で折り返さずにはみ出し、ラベルが縦書き状態になる)。
 * `verify-rows`(検証画面・日報・月報の左右 2 列の行)は、値が `flex: none` で縮まず、`li` も折り返さなかったため、
 * 長い値(「判定できた 36 レース中 13 的中・賭け金 …」)があるとラベルが最小幅に潰れ、値が画面の右へはみ出した。
 * 狙いの見た目: 値が 1 行に収まる行は今のまま(ラベル左・値右)。収まらない行は、値が次の行へ回り、値の中でも折り返す(ラベルは潰さない)。
 * ここでは「その規則が書いてあること」を固定する。実際に崩れないことは、Chromium の 360px 幅のスクリーンショットと寸法で確かめた(Issue #369 のコメント)。
 */
const css = (/<style>([\s\S]*?)<\/style>/.exec(renderPage("owner@example.com", "admin"))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");

/** セレクタ完全一致の規則の本体(`{ … }` の中)を全部返す。 */
function bodiesOf(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]!);
}

describe("verify-rows の CSS(Issue #369)", () => {
  const li = bodiesOf(".verify-rows li");
  const label = bodiesOf(".verify-row-label");
  const value = bodiesOf(".verify-row-value");

  it("前提: 行・ラベル・値の規則が、それぞれちょうど 1 つ取り出せる", () => {
    expect(li).toHaveLength(1);
    expect(label).toHaveLength(1);
    expect(value).toHaveLength(1);
  });

  it("行は、値が収まらないとき値を次の行へ回せる(flex-wrap: wrap)。1 行のときの左右配置・枠線・余白は今のまま", () => {
    expect(li[0]).toMatch(/display: flex;/);
    expect(li[0]).toMatch(/flex-wrap: wrap;/);
    expect(li[0]).toMatch(/justify-content: space-between;/);
    expect(li[0]).toMatch(/padding: 6px 0;/);
    expect(li[0]).toMatch(/border-bottom: 1px solid var\(--line\);/);
    expect(li[0]).toMatch(/font-size: 0\.9rem;/);
  });

  it("ラベルは行の幅から 5em を引いた幅までで折り返す(長いラベルの行で、短い値が次の行へ回らない = 検証画面の長いラベルの行は今のまま)。極端に長くても行からはみ出さない", () => {
    expect(label[0]).toMatch(/flex: 0 1 auto;/);
    expect(label[0]).toMatch(/max-width: calc\(100% - 5em\);/);
    expect(label[0]).toMatch(/overflow-wrap: anywhere;/);
    expect(label[0]).not.toMatch(/flex: none;/);
  });

  it("値は行の幅まで縮められ(flex: 0 1 auto・min-width: 0)、値の中で折り返す(overflow-wrap: anywhere)。数字は桁をそろえる", () => {
    expect(value[0]).toMatch(/flex: 0 1 auto;/);
    expect(value[0]).toMatch(/min-width: 0;/);
    expect(value[0]).toMatch(/overflow-wrap: anywhere;/);
    expect(value[0]).toMatch(/font-variant-numeric: tabular-nums;/);
    expect(value[0]).not.toMatch(/flex: none;/);
  });

  it("値の箱は margin-left: auto で右に寄る(1 行のときは今の見た目)。text-align: right は付けない(折り返した値の中は左揃えで、行頭がそろう)", () => {
    expect(value[0]).toMatch(/margin-left: auto;/);
    expect(value[0]).not.toMatch(/text-align/);
  });
});
