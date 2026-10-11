/**
 * Issue #239: 配色(カラーユニバーサルデザイン)を数値で固定する。
 *
 *  - 文字色のコントラスト比(WCAG AA = 4.5:1)を、ライト・ダークの両方で、背景(`--bg`)とカード(`--card`)の上で。
 *  - 状態の色どうし(ok・wait・fail)と、強調の色(accent)と状態の色の組が、P・D・T 型の色覚シミュレーション後も ΔE2000 ≥ 10 で離れていること。
 *  - Discord の帯の4色(ok・warn・fail・none)も同じ基準。
 *
 * **web は `renderPage` の出力から CSS 変数を実際に読み取って検査する**(palette.ts の定数だけを見ない)。ただし読むのは**最初の `:root` とダークの `@media` だけ**なので、
 * `page.ts` の後ろに別の `:root { --fail: …; }` や色の直書きを足す退行は、これだけでは検出できない。それは「Issue #239 R2」のテストが、
 * `<style>` 全体から `paletteCss()` の出力とコメントを除いた残りに、16 進・rgb()・hsl() などの色のリテラルが無いことで検出する。
 * 色の意味の割り当て(ok・fail を入れ替えても閾値は通る)は、「Issue #239 R1」のテストが採用した値のリテラルで固定する。
 * 色の計算(色覚シミュレーション・ΔE2000・コントラスト比)は color-science.ts。その正しさは color-science.test.ts が別に固定している。
 *
 * ΔE2000 の閾値 10 は経験則: 約 1 が知覚できる最小差、2〜5 が並べて見比べて分かる差、10 以上は離れて見ても別の色と分かる差、という目安に基づく(厳密な標準ではない)。
 * 文字・記号を併記するので、色差は「唯一の手がかり」ではなく補強。この閾値は、旧配色(下の OLD_*)が満たさないこと(= テストが問題を検出できること)を、このファイルで確認している。
 * muted(未実行の灰)は状態の組に含めない: 未実行のバッジには文字ラベルがあり、補助的な文字の色にも使うため。
 */
import { describe, expect, it } from "vitest";
import { renderPage } from "../src/page";
import { DISCORD_COLORS, WEB_DARK, WEB_LIGHT, paletteCss } from "../src/palette";
import { CVD_TYPES, contrastRatio, deltaE2000Hex, intToHex } from "./color-science";

const MIN_CONTRAST = 4.5;
const MIN_DELTA_E = 10;

const KEYS = ["fg", "bg", "muted", "line", "card", "accent", "ok", "wait", "fail"] as const;

/** `{ --fg: #1c1c1e; --bg: ... }` の中身から、変数名 → 色を読む。 */
function parseVariables(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z]+):\s*(#[0-9a-fA-F]{6});/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

/** 実際に配信される HTML の `<style>` から、ライトとダークの CSS 変数を読む。 */
function pageVariables(): { light: Record<string, string>; dark: Record<string, string> } {
  const html = renderPage("owner@example.com", "admin");
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  expect(style, "<style> が1つある").toBeDefined();
  const media = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/.exec(style!);
  expect(media, "ダークの @media ブロックがある").not.toBeNull();
  const root = /(?:^|\n)\s*:root\s*\{([^}]*)\}/.exec(style!);
  expect(root, "ライトの :root ブロックがある").not.toBeNull();
  return { light: parseVariables(root![1]!), dark: parseVariables(media![1]!) };
}

const PAGE = pageVariables();
const MODES = [
  { name: "ライト", vars: PAGE.light, palette: WEB_LIGHT },
  { name: "ダーク", vars: PAGE.dark, palette: WEB_DARK },
] as const;

/** 旧配色(Issue #239 より前)。閾値がこれを弾く(= 新配色の検査が空振りでない)ことの確認にだけ使う。 */
const OLD_WEB = {
  light: { ok: "#146c2e", wait: "#8a5a00", fail: "#b3261e", accent: "#0a58ca" },
  dark: { ok: "#6fcf8a", wait: "#e0b24a", fail: "#ff8a80", accent: "#7cacf8" },
} as const;
const OLD_DISCORD = { ok: 0x2ecc71, warn: 0xe67e22, fail: 0xe74c3c, none: 0x95a5a6 } as const;

type Colors = Readonly<Record<string, string>>;

/** 状態の3組({ok, wait, fail} の全組合せ)と、強調色との3組。 */
function statePairs(c: Colors): readonly (readonly [string, string, string, string])[] {
  return [
    ["ok", "wait", c["ok"]!, c["wait"]!],
    ["ok", "fail", c["ok"]!, c["fail"]!],
    ["wait", "fail", c["wait"]!, c["fail"]!],
    ["accent", "ok", c["accent"]!, c["ok"]!],
    ["accent", "wait", c["accent"]!, c["wait"]!],
    ["accent", "fail", c["accent"]!, c["fail"]!],
  ];
}

/** すべての視覚(通常・P・D・T)での ΔE2000 の最小値と、そのときの型。 */
function worstDeltaE(a: string, b: string): { value: number; type: string } {
  let worst = { value: Number.POSITIVE_INFINITY, type: "" };
  for (const type of CVD_TYPES) {
    const value = deltaE2000Hex(a, b, type);
    if (value < worst.value) worst = { value, type };
  }
  return worst;
}

describe("web の配色: 実際に配信される CSS と palette.ts の一致", () => {
  for (const { name, vars, palette } of MODES) {
    it(`${name}: 9 個の変数がすべて読め、palette.ts の値と同じ`, () => {
      expect(Object.keys(vars).sort()).toEqual([...KEYS].sort()); // 前提: 欠けも余りもない(読み損ないで検査が空振りしない)
      for (const key of KEYS) {
        expect(vars[key]?.toLowerCase(), `--${key}`).toBe(palette[key].toLowerCase());
      }
    });
  }

  it("palette.ts の WEB_LIGHT・WEB_DARK は、検査する 9 個の変数と同じキーを持つ(キーが増えたのに検査が追い付いていない状態を防ぐ)", () => {
    expect(Object.keys(WEB_LIGHT).sort()).toEqual([...KEYS].sort());
    expect(Object.keys(WEB_DARK).sort()).toEqual([...KEYS].sort());
  });

  it("paletteCss() の出力が、そのままページの <style> に入っている", () => {
    expect(renderPage("owner@example.com", "admin")).toContain(paletteCss());
  });

  it("ライトとダークは別の値(ダークにも同じ値を入れて通るのを防ぐ)", () => {
    for (const key of ["fg", "bg", "ok", "wait", "fail"] as const) {
      expect(WEB_LIGHT[key], key).not.toBe(WEB_DARK[key]);
    }
  });
});

describe("Issue #239 R1: 意味の割り当て(どの状態にどの色か)を、採用した値のリテラルで固定する", () => {
  // 定数どうしを比べる検査(`toBe(DISCORD_COLORS.ok)` など)は、ok と fail の値を入れ替えても通ってしまう。
  // 緑系=成功・赤系=失敗という意味は、ここで値そのものに結び付ける。色を変える変更では、このリテラルも意図して書き換える。
  it("Discord の帯: ok=青みの緑・warn=橙・fail=赤寄りの朱・none=灰", () => {
    expect(DISCORD_COLORS).toEqual({ ok: 0x009e73, warn: 0xe69f00, fail: 0xd02040, none: 0x95a5a6 });
  });

  it("web ライト: ok=青緑寄りの緑・wait=黄土・fail=煉瓦色", () => {
    expect({ ok: WEB_LIGHT.ok, wait: WEB_LIGHT.wait, fail: WEB_LIGHT.fail }).toEqual({ ok: "#177c55", wait: "#8e6610", fail: "#922b2b" });
  });

  it("web ダーク: ok=緑・wait=琥珀・fail=サーモン", () => {
    expect({ ok: WEB_DARK.ok, wait: WEB_DARK.wait, fail: WEB_DARK.fail }).toEqual({ ok: "#7cd9ac", wait: "#e3b548", fail: "#ec7971" });
  });

  it("実際に配信される CSS でも同じ割り当て(palette.ts の定数ではなく、<style> から読んだ値)", () => {
    expect({ ok: PAGE.light["ok"], wait: PAGE.light["wait"], fail: PAGE.light["fail"] }).toEqual({ ok: "#177c55", wait: "#8e6610", fail: "#922b2b" });
    expect({ ok: PAGE.dark["ok"], wait: PAGE.dark["wait"], fail: PAGE.dark["fail"] }).toEqual({ ok: "#7cd9ac", wait: "#e3b548", fail: "#ec7971" });
  });
});

describe("Issue #239 R2: 色の直書きが無い(<style> 全体で、16 進・rgb()・hsl() の色は paletteCss() の出力の中だけ)", () => {
  /** CSS のコメントを除く(コメントには `Issue #239` のように 16 進に見える文字列がある)。 */
  const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;

  const style = (role: "admin" | "viewer"): string => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(renderPage("owner@example.com", role))?.[1];
    expect(css, "<style> が1つある").toBeDefined();
    return css!;
  };

  // Issue #238 以降、画面は役割(admin・viewer)で HTML が変わる(`data-role` など)。<style> は同じはずだが、役割ごとに検査する。
  for (const role of ["admin", "viewer"] as const) {
    it(`${role}: paletteCss() の出力を除くと、色のリテラルが1つも残らない(後ろに \`:root { --fail: #…; }\` や直書きの色を足すと赤くなる)`, () => {
      const css = style(role);
      expect(css).toContain(paletteCss()); // 前提: 取り除く対象が実際に含まれている(含まれなければ下の検査が空振りする)
      const rest = withoutComments(css.replace(paletteCss(), ""));
      expect(rest.match(new RegExp(COLOR_LITERAL, "g")) ?? []).toEqual([]);
    });
  }

  it("検査が効く: 色のリテラルの検出が、16 進・rgb()・hsl() を拾う", () => {
    for (const sample of ["a { color: #b3261e; }", ":root { --fail: #f00; }", "a { color: rgb(1,2,3); }", "a { color: hsl(0 50% 50%); }"]) {
      expect(COLOR_LITERAL.test(sample), sample).toBe(true);
    }
    // コメント内の Issue 番号は除かれる
    expect(COLOR_LITERAL.test(withoutComments("/* Issue #239 */ a { margin: 0; }"))).toBe(false);
  });

  it("palette.ts の色の値は、paletteCss() の出力に全部現れる(CSS 変数の一部が出力から抜けていない)", () => {
    const css = paletteCss();
    for (const value of [...Object.values(WEB_LIGHT), ...Object.values(WEB_DARK)]) {
      expect(css).toContain(value);
    }
  });
});

describe("web の配色: 文字色のコントラスト比(WCAG AA = 4.5:1 以上)", () => {
  const TEXT_KEYS = ["fg", "muted", "accent", "ok", "wait", "fail"] as const;
  for (const { name, vars } of MODES) {
    for (const key of TEXT_KEYS) {
      for (const surface of ["bg", "card"] as const) {
        it(`${name}: --${key} と --${surface} のコントラスト比が ${MIN_CONTRAST} 以上`, () => {
          expect(contrastRatio(vars[key]!, vars[surface]!)).toBeGreaterThanOrEqual(MIN_CONTRAST);
        });
      }
    }
  }

  it("検査が効く: 白の上の薄い灰色(#777777)は 4.5 に届かず、AA を満たさないと判定される", () => {
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(MIN_CONTRAST);
  });
});

describe(`web の配色: 色覚シミュレーション(P・D・T 型)後も ΔE2000 ≥ ${MIN_DELTA_E}`, () => {
  for (const { name, vars } of MODES) {
    const pairs = statePairs(vars);

    it(`${name}: 検査する組は 6 組(状態 3 + 強調色と状態 3)`, () => {
      expect(pairs).toHaveLength(6);
    });

    for (const [a, b, colorA, colorB] of pairs) {
      for (const type of CVD_TYPES) {
        it(`${name}: ${a}(${colorA}) と ${b}(${colorB}) — ${type}`, () => {
          expect(deltaE2000Hex(colorA, colorB, type)).toBeGreaterThanOrEqual(MIN_DELTA_E);
        });
      }
    }
  }

  it("検査が効く: 旧配色は閾値を満たさない(ライトの wait と fail、ダークの ok と fail が、D 型で近づく)", () => {
    expect(worstDeltaE(OLD_WEB.light.wait, OLD_WEB.light.fail).value).toBeLessThan(MIN_DELTA_E);
    expect(worstDeltaE(OLD_WEB.dark.ok, OLD_WEB.dark.fail).value).toBeLessThan(MIN_DELTA_E);
    // 旧配色のどれかの組が閾値を割っていることを、組の全体でも確認する
    for (const mode of ["light", "dark"] as const) {
      const worst = Math.min(...statePairs(OLD_WEB[mode]).map(([, , a, b]) => worstDeltaE(a, b).value));
      expect(worst, `旧配色 ${mode}`).toBeLessThan(MIN_DELTA_E);
    }
  });
});

describe(`Discord の帯の配色: 4 色どうしが、P・D・T 型でも ΔE2000 ≥ ${MIN_DELTA_E}`, () => {
  const names = ["ok", "warn", "fail", "none"] as const;
  const hex = (colors: Readonly<Record<(typeof names)[number], number>>): Record<string, string> => Object.fromEntries(names.map((n) => [n, intToHex(colors[n])]));
  const pairsOf = (c: Record<string, string>): readonly (readonly [string, string, string, string])[] =>
    names.flatMap((a, i) => names.slice(i + 1).map((b) => [a, b, c[a]!, c[b]!] as const));
  const current = hex(DISCORD_COLORS);

  it("4 色の全 6 組を検査する", () => {
    expect(pairsOf(current)).toHaveLength(6);
  });

  for (const [a, b, colorA, colorB] of pairsOf(current)) {
    for (const type of CVD_TYPES) {
      it(`${a}(${colorA}) と ${b}(${colorB}) — ${type}`, () => {
        expect(deltaE2000Hex(colorA, colorB, type)).toBeGreaterThanOrEqual(MIN_DELTA_E);
      });
    }
  }

  it("4 色は互いに違う値(定数が同じ値になっても既存の embed のテストが通ってしまうのを防ぐ)", () => {
    expect(new Set(names.map((n) => DISCORD_COLORS[n])).size).toBe(4);
  });

  it("検査が効く: 旧配色は閾値を満たさない(橙と赤が D 型で近づく)", () => {
    const old = hex(OLD_DISCORD);
    const worst = Math.min(...pairsOf(old).map(([, , a, b]) => worstDeltaE(a, b).value));
    expect(worst).toBeLessThan(MIN_DELTA_E);
  });

  it("0x000000〜0xffffff の整数(Discord の color として有効)", () => {
    for (const n of names) {
      expect(Number.isInteger(DISCORD_COLORS[n])).toBe(true);
      expect(DISCORD_COLORS[n]).toBeGreaterThanOrEqual(0);
      expect(DISCORD_COLORS[n]).toBeLessThanOrEqual(0xffffff);
    }
  });
});
