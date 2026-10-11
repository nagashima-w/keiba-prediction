/**
 * PNG の画素を読む、テスト用の最小の道具(Issue #246。アイコンの取り違えの検出に使う)。
 * 対応: 8 ビットの RGB(色タイプ 2)と RGBA(色タイプ 6)、インターレースなし。それ以外は例外にする(生成物の形式が変わったら、黙って誤読せず落とす)。
 * フィルタ 0〜4(なし・Sub・Up・Average・Paeth)をすべて復号する。CRC は検証しない(形式の検査は icons.test.ts が別にしている)。
 * Node の `node:zlib` を使う(テストは Node で走る。Worker の束には入らない)。
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** 1 画素 4 バイト(R・G・B・A)。RGB の PNG は A=255。 */
  readonly rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

/** PNG を復号する。 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new Error("PNG の署名ではありません");
  }
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = -1;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = u32(data, 0);
      height = u32(data, 4);
      depth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`未対応の PNG(深さ ${depth}・色タイプ ${colorType}・インターレース ${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) {
    throw new Error("画素のデータの長さが想定と違います");
  }
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? out[y * stride + x - channels]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const upLeft = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      out[y * stride + x] = (cur + predictor(filter, left, up, upLeft)) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = out[i * channels]!;
    rgba[i * 4 + 1] = out[i * channels + 1]!;
    rgba[i * 4 + 2] = out[i * channels + 2]!;
    rgba[i * 4 + 3] = channels === 4 ? out[i * channels + 3]! : 255;
  }
  return { width, height, rgba };
}

/** フィルタごとの予測値(復号は `cur + predictor`、符号化は `cur - predictor`)。 */
function predictor(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
    }
    default:
      throw new Error(`未知のフィルタ ${filter}`);
  }
}

/**
 * 復号器の自己検査用の符号化(RGB・8 ビット)。行ごとのフィルタの種類を `filters`(行数と同じ長さ)で指定する。CRC は 0 のまま(`decodePng` は見ない)。
 * **復号と同じ `predictor` を使う**ので、フィルタの取り違え(Sub と Up の入れ替え、Average の丸めの違い)では往復が崩れない。往復の検査でしかない
 * (`pngFromFilteredRows` の既知のベクトルが、`predictor` の中身を独立に固定する)。
 */
export function encodePngForTest(width: number, height: number, rgb: Uint8Array, filters: readonly number[]): Uint8Array {
  const channels = 3;
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = filters[y]!;
    for (let x = 0; x < stride; x += 1) {
      const cur = rgb[y * stride + x]!;
      const left = x >= channels ? rgb[y * stride + x - channels]! : 0;
      const up = y > 0 ? rgb[(y - 1) * stride + x]! : 0;
      const upLeft = x >= channels && y > 0 ? rgb[(y - 1) * stride + x - channels]! : 0;
      raw[y * (stride + 1) + 1 + x] = (cur - predictor(filters[y]!, left, up, upLeft)) & 255;
    }
  }
  return assemblePng(width, height, raw);
}

/**
 * **フィルタをかけたあとの値**(ファイルに入っているバイト)を、そのまま並べた PNG(RGB・8 ビット)を作る。`predictor` を通さないので、
 * 復号の結果と比べる期待値を、PNG の仕様から手計算(または別実装)で求めておけば、`predictor` と独立した検査になる(Issue #255)。
 * `rows` の各行は、フィルタの種類と、その行の保存値(幅 × 3 バイト)。
 */
export function pngFromFilteredRows(width: number, rows: readonly { readonly filter: number; readonly stored: readonly number[] }[]): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array(rows.length * (stride + 1));
  rows.forEach((row, y) => {
    if (row.stored.length !== stride) {
      throw new Error(`行 ${y} の保存値が ${row.stored.length} バイト(期待 ${stride})`);
    }
    raw[y * (stride + 1)] = row.filter;
    raw.set(row.stored, y * (stride + 1) + 1);
  });
  return assemblePng(width, rows.length, raw);
}

/** IHDR・IDAT・IEND を並べる(CRC は 0 のまま)。`raw` は行ごとの「フィルタ種別 + 保存値」。 */
function assemblePng(width: number, height: number, raw: Uint8Array): Uint8Array {
  const chunk = (type: string, data: Uint8Array): number[] => {
    const len = data.length;
    return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  };
  const ihdr = new Uint8Array(13);
  ihdr.set([(width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255, (height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255, 8, 2, 0, 0, 0]);
  return new Uint8Array([...SIGNATURE, ...chunk("IHDR", ihdr), ...chunk("IDAT", deflateSync(raw)), ...chunk("IEND", new Uint8Array(0))]);
}

/** 画素の平均輝度(Rec.709 の係数。0〜255)。全画素の単純平均(画素数 N = 幅 × 高さ)。 */
export function meanLuminance(png: DecodedPng): number {
  let sum = 0;
  for (let i = 0; i < png.width * png.height; i += 1) {
    sum += 0.2126 * png.rgba[i * 4]! + 0.7152 * png.rgba[i * 4 + 1]! + 0.0722 * png.rgba[i * 4 + 2]!;
  }
  return sum / (png.width * png.height);
}
