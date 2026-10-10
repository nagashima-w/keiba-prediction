/**
 * Issue #239: 配色のテスト用の色計算(**テスト専用**。本番のコードは import しない。依存パッケージは足していない)。
 *
 *  - WCAG 2.x の相対輝度・コントラスト比({@link contrastRatio})
 *  - 色覚シミュレーション({@link simulateCvd}): Machado, Oliveira & Fernandes (2009) "A Physiologically-based Model for Simulation of Color Vision Deficiency",
 *    IEEE Transactions on Visualization and Computer Graphics 15(6) の行列(重篤度 1.0 = 2 色型色覚)。線形 RGB に掛ける。
 *  - 色差({@link deltaE2000}): CIEDE2000。Sharma, Wu & Dalal (2005) の実装ノートに沿う。
 *
 * 正しさは color-science.test.ts で、公開テストデータ・性質・独立実装(colorspacious)の出力と突き合わせて固定している。
 */

export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];
/** 色覚の型。P=1 型 2 色覚(protan)、D=2 型 2 色覚(deutan)、T=3 型 2 色覚(tritan)。normal は通常の色覚(何もしない)。 */
export type CvdType = "normal" | "protan" | "deutan" | "tritan";

export const CVD_TYPES: readonly CvdType[] = ["normal", "protan", "deutan", "tritan"];

/** Machado et al. (2009) の行列(重篤度 1.0)。線形 RGB の列ベクトルに左から掛ける。 */
export const CVD_MATRICES: Readonly<Record<Exclude<CvdType, "normal">, readonly (readonly [number, number, number])[]>> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** `#rrggbb`(大文字小文字は不問)を [r, g, b](0〜255)にする。形式が違えば throw する。 */
export function parseHex(hex: string): Rgb {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`#rrggbb の形式ではありません: ${JSON.stringify(hex)}`);
  }
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 数値(0xRRGGBB)を `#rrggbb` にする(Discord の帯の色用)。 */
export function intToHex(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new Error(`0x000000〜0xffffff の整数ではありません: ${value}`);
  }
  return `#${value.toString(16).padStart(6, "0")}`;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** sRGB(0〜255)→ 線形(0〜1)。 */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** 線形(0〜1)→ sRGB(0〜255)。範囲外は丸める。 */
function fromLinear(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
}

/** WCAG 2.x の相対輝度。 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x のコントラスト比((明るい方 + 0.05) / (暗い方 + 0.05))。引数の順序に依らない。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 色覚シミュレーション後の色(`#rrggbb`)。normal は入力をそのまま返す(大文字小文字は小文字にそろえる)。 */
export function simulateCvd(hex: string, type: CvdType): string {
  const rgb = parseHex(hex);
  if (type === "normal") {
    return toHex(rgb);
  }
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  const m = CVD_MATRICES[type];
  const out = m.map((row) => fromLinear(row[0] * r + row[1] * g + row[2] * b)) as unknown as Rgb;
  return toHex(out);
}

/** sRGB(D65)→ CIE Lab(D65 の白色点)。 */
export function hexToLab(hex: string): Lab {
  const [r, g, b] = parseHex(hex).map(toLinear) as [number, number, number];
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x / 0.95047);
  const fy = f(y);
  const fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 の色差(Sharma, Wu & Dalal 2005 の実装ノートに沿う。kL=kC=kH=1)。 */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [l1, a1, b1] = lab1;
  const [l2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number): number => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dL = l2 - l1;
  const dC = c2p - c1p;
  let dh = 0;
  if (c1p * c2p !== 0) {
    dh = h2p - h1p;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh * rad) / 2);
  const lBar = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBar: number;
  if (c1p * c2p === 0) {
    hBar = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hBar = (h1p + h2p) / 2;
  } else {
    hBar = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const t = 1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad) + 0.32 * Math.cos((3 * hBar + 6) * rad) - 0.2 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

/** 2 色に同じ色覚シミュレーションをかけたあとの CIEDE2000。 */
export function deltaE2000Hex(a: string, b: string, type: CvdType): number {
  return deltaE2000(hexToLab(simulateCvd(a, type)), hexToLab(simulateCvd(b, type)));
}
