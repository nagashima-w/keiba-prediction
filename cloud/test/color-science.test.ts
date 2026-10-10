/**
 * Issue #239: 色の計算ヘルパ(`color-science.ts`)自体の正しさ。
 * パレットのテスト(palette.test.ts)の判定は、このヘルパの数値に依存する。ヘルパが間違っていれば、そちらのテストが通っても意味がないので、
 * **公開されたテストデータ・性質・独立実装の出力**と突き合わせて固定する。
 */
import { describe, expect, it } from "vitest";
import { CVD_MATRICES, contrastRatio, deltaE2000, deltaE2000Hex, hexToLab, parseHex, simulateCvd, type CvdType } from "./color-science";

describe("parseHex(#rrggbb の読み取り)", () => {
  it("6 桁の 16 進を [r, g, b](0〜255)にする。大文字小文字を区別しない", () => {
    expect(parseHex("#117D4c")).toEqual([0x11, 0x7d, 0x4c]);
    expect(parseHex("#000000")).toEqual([0, 0, 0]);
    expect(parseHex("#ffffff")).toEqual([255, 255, 255]);
  });

  it("# が無い・桁数が違う・16 進でない文字列は throw する(テストの打ち間違いを黙って 0 にしない)", () => {
    for (const bad of ["117d4c", "#fff", "#12345", "#1234567", "#gggggg", ""]) {
      expect(() => parseHex(bad)).toThrow();
    }
  });
});

describe("contrastRatio(WCAG 2.x の相対輝度によるコントラスト比)", () => {
  it("黒と白は 21:1、同色は 1:1。引数の順序に依らない", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
    expect(contrastRatio("#6b6b70", "#6b6b70")).toBeCloseTo(1, 10);
  });

  it("WCAG の公開例: #767676 と白は約 4.54:1(AA の 4.5 をぎりぎり超える灰色として知られる)。#777777 は 4.48:1 で AA に届かない", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });
});

describe("deltaE2000(CIEDE2000)", () => {
  // Sharma, Wu & Dalal (2005) "The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary Test Data, and Mathematical Observations" の公開テストデータから抜粋。
  // 色相角の境界・彩度ゼロ・符号の違いなど、実装の誤りが出やすい行を選んだ。
  const SHARMA: readonly (readonly [readonly [number, number, number], readonly [number, number, number], number])[] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];

  it.each(SHARMA)("Sharma の公開テストデータ %j と %j の色差は %f", (lab1, lab2, expected) => {
    expect(deltaE2000(lab1, lab2)).toBeCloseTo(expected, 3);
    expect(deltaE2000(lab2, lab1)).toBeCloseTo(expected, 3); // 対称
  });

  it("同じ色の差は 0", () => {
    expect(deltaE2000Hex("#117d4c", "#117d4c", "normal")).toBe(0);
  });
});

describe("hexToLab(sRGB → CIE Lab、D65)", () => {
  it("白は L=100・a≈0・b≈0、黒は L=0", () => {
    const [lw, aw, bw] = hexToLab("#ffffff");
    expect(lw).toBeCloseTo(100, 2);
    expect(aw).toBeCloseTo(0, 1);
    expect(bw).toBeCloseTo(0, 1);
    expect(hexToLab("#000000")[0]).toBeCloseTo(0, 5);
  });

  it("純赤は a が大きく正、純青は b が負(向きの確認)。公開値は赤 (53.24, 80.09, 67.20)・青 (32.30, 79.19, -107.86)", () => {
    const [lr, ar, br] = hexToLab("#ff0000");
    expect([lr, ar, br].map((v) => Math.round(v * 10) / 10)).toEqual([53.2, 80.1, 67.2]);
    const [lb, ab, bb] = hexToLab("#0000ff");
    expect([lb, ab, bb].map((v) => Math.round(v * 10) / 10)).toEqual([32.3, 79.2, -107.9]);
  });
});

describe("色覚シミュレーション(Machado, Oliveira & Fernandes 2009、重篤度 1.0)", () => {
  const TYPES: readonly Exclude<CvdType, "normal">[] = ["protan", "deutan", "tritan"];

  it("行列の各行の和が 1(= 白・灰色が変わらない性質)。転記ミスの検出", () => {
    for (const t of TYPES) {
      const m = CVD_MATRICES[t];
      expect(m).toHaveLength(3);
      for (const row of m) {
        expect(row).toHaveLength(3);
        expect(row[0]! + row[1]! + row[2]!).toBeCloseTo(1, 5);
      }
    }
  });

  it("白・黒・灰色はどの型でも変わらない", () => {
    for (const t of TYPES) {
      expect(simulateCvd("#ffffff", t)).toBe("#ffffff");
      expect(simulateCvd("#000000", t)).toBe("#000000");
      expect(simulateCvd("#808080", t)).toBe("#808080");
    }
  });

  it("normal は何もしない", () => {
    expect(simulateCvd("#117d4c", "normal")).toBe("#117d4c");
  });

  it("P 型・D 型は赤と緑の差を縮める: 純赤と純緑は、通常視覚では大きく離れるが、P・D 型では遥かに近づく", () => {
    const normal = deltaE2000Hex("#ff0000", "#00a000", "normal");
    const p = deltaE2000Hex("#ff0000", "#00a000", "protan");
    const d = deltaE2000Hex("#ff0000", "#00a000", "deutan");
    expect(normal).toBeGreaterThan(50);
    expect(p).toBeLessThan(normal / 2);
    expect(d).toBeLessThan(normal / 2);
  });

  // 期待値は、独立実装(Python の colorspacious。Machado 2009 を実装しているライブラリ)で `sRGB1+CVD`(severity=100)に通した出力を 16 進に丸めたもの。
  // 行列の係数をこちらの実装と同じ誤りで写している可能性を避けるため、ここは別実装の出力を固定する。
  // 取り直し方: 仮想環境に colorspacious を入れ、cspace_convert(rgb/255, {"name":"sRGB1+CVD","cvd_type":"protanomaly"|"deuteranomaly"|"tritanomaly","severity":100}, "sRGB1") を 0〜255 に丸める。
  const GOLDEN: readonly (readonly [string, string, string, string])[] = [
    // [元の色, P, D, T]
    ["#177c55", "#7a7253", "#6e6958", "#007c72"],
    ["#8e6610", "#766700", "#7f7115", "#9b5a57"],
    ["#922b2b", "#48422a", "#625828", "#a10c2c"],
    ["#7cd9ac", "#d7cdaa", "#c8c3af", "#63d9cc"],
    ["#e3b548", "#cab43a", "#d5c04d", "#f6a69e"],
    ["#ec7971", "#948c70", "#b0a46f", "#ff6778"],
    ["#009e73", "#9a9271", "#8a8676", "#009e92"],
    ["#e69f00", "#b9a200", "#cab411", "#fb8c87"],
    ["#d02040", "#595440", "#84783a", "#e5002f"],
    ["#95a5a6", "#a2a3a6", "#9fa1a6", "#90a6a5"],
  ];

  it.each(GOLDEN)("%s: 独立実装の出力と一致する(P=%s・D=%s・T=%s)", (hex, p, d, t) => {
    expect(simulateCvd(hex, "protan")).toBe(p);
    expect(simulateCvd(hex, "deutan")).toBe(d);
    expect(simulateCvd(hex, "tritan")).toBe(t);
  });
});
