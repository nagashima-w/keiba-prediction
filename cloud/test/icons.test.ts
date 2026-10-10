import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/handler";
import { ICON_CACHE_CONTROL, ICON_PATHS, iconAsset } from "../src/icons";
import { requiredRole } from "../src/route-policy";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";
import { decodePng, encodePngForTest, meanLuminance } from "./png-pixels";

/**
 * Issue #244: アイコン(見出しの横の画像・ブラウザのタブの favicon・apple-touch-icon)の生成物と、その配信。
 *  - 生成物(`src/icons.generated.ts`。`cloud/gen-icons.py` が元画像から作る)は、寸法・形式・大きさをここで固定する
 *    (CI は cloud だけを install し Python を使わないので、生成スクリプトとの一致は検査できない。代わりに結果の形を固定する)。
 *  - 配信は Worker の中から(認証の後ろ)。閲覧者にも管理者にも 200(route-policy.ts の表に足してある)。
 *  - 期待値(パス・寸法)はこのファイルに手書きで持つ。実装の表を参照して期待値を作ると、実装を間違えたとき両方が一緒に間違う。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const ORIGIN = "https://cloud.invalid";
const VIEWER_EMAIL = "friend@example.com";

interface ExpectedIcon {
  readonly path: string;
  readonly contentType: string;
  /** PNG の一辺(px)。`/favicon.ico` は null(中身は ICO。下で別に検査する)。 */
  readonly size: number | null;
  /** 大きさの上限(バイト)。生成物が肥大していないことの確認(`gen-icons.py` が出力するバイト数の 2〜2.5 倍の余裕)。 */
  readonly maxBytes: number;
}

/** 配るアイコンの最終の一覧(手書き)。見出し用(A=全体)が 32・64・96、favicon(C=「穴」)が 16・32、apple-touch-icon(A)が 180、ICO(C)が 16・32・48 を束ねる。 */
const EXPECTED: readonly ExpectedIcon[] = [
  { path: "/favicon.ico", contentType: "image/x-icon", size: null, maxBytes: 10_000 },
  { path: "/apple-touch-icon.png", contentType: "image/png", size: 180, maxBytes: 65_000 },
  { path: "/icons/favicon-16.png", contentType: "image/png", size: 16, maxBytes: 1_500 },
  { path: "/icons/favicon-32.png", contentType: "image/png", size: 32, maxBytes: 3_000 },
  { path: "/icons/header-32.png", contentType: "image/png", size: 32, maxBytes: 4_500 },
  { path: "/icons/header-64.png", contentType: "image/png", size: 64, maxBytes: 13_000 },
  { path: "/icons/header-96.png", contentType: "image/png", size: 96, maxBytes: 24_000 },
];

function bytesOf(pathname: string): Uint8Array {
  const asset = iconAsset(pathname);
  expect(asset, `${pathname} のアイコンがある`).toBeDefined();
  return asset!.bytes;
}

const startsWithPng = (bytes: Uint8Array, offset = 0): boolean => PNG_SIGNATURE.every((b, i) => bytes[offset + i] === b);
const u32be = (bytes: Uint8Array, at: number): number => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
const u16le = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
const u32le = (bytes: Uint8Array, at: number): number => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;

/** PNG の IHDR(署名の直後のチャンク)から、幅・高さ。`offset` は PNG の先頭の位置(ICO の中の PNG を読むとき)。 */
function pngSize(bytes: Uint8Array, offset = 0): { width: number; height: number; chunk: string } {
  return {
    chunk: String.fromCharCode(bytes[offset + 12]!, bytes[offset + 13]!, bytes[offset + 14]!, bytes[offset + 15]!),
    width: u32be(bytes, offset + 16),
    height: u32be(bytes, offset + 20),
  };
}

describe("アイコンの一覧(ICON_PATHS)", () => {
  it("手書きの期待値と過不足なく一致する(7 本)", () => {
    expect(EXPECTED).toHaveLength(7);
    expect([...ICON_PATHS].sort()).toEqual(EXPECTED.map((e) => e.path).sort());
  });

  it("未知のパス(別の大きさ・大文字・末尾のスラッシュ・クエリ込みの文字列)は無い", () => {
    for (const pathname of ["/icons/header-33.png", "/Favicon.ico", "/favicon.ico/", "/icons/header-32.png/", "/icons/header-32.png?x=1", "/icons/", "/icons", "/favicon.png", ""]) {
      expect(iconAsset(pathname), pathname).toBeUndefined();
    }
  });
});

describe("生成物の形式・寸法・大きさ(PNG)", () => {
  const pngs = EXPECTED.filter((e) => e.size !== null);

  it("前提: PNG は 6 本(ICO の 1 本を除く)", () => {
    expect(pngs).toHaveLength(6);
  });

  it.each(pngs.map((e) => [e.path, e] as const))("%s は PNG の署名で始まり、先頭のチャンクは IHDR で、一辺は期待どおりの正方形", (_path, e) => {
    const bytes = bytesOf(e.path);
    expect(startsWithPng(bytes)).toBe(true);
    expect(pngSize(bytes)).toEqual({ chunk: "IHDR", width: e.size, height: e.size });
  });

  it.each(pngs.map((e) => [e.path, e] as const))("%s の大きさは上限以内で、空白の画像ではない(圧縮後でも一定以上の情報量がある)", (_path, e) => {
    const bytes = bytesOf(e.path);
    expect(bytes.length).toBeLessThanOrEqual(e.maxBytes);
    // 単色の PNG は、96px でも 200 バイト未満に収まる。絵が入っていれば、最小の 16px でも 300 バイトを超える。
    expect(bytes.length).toBeGreaterThan(300);
  });

  it("見出し用(A=全体)と favicon(C=「穴」だけ)は別の絵(同じ一辺の 32px どうしでバイトが違う)", () => {
    const a = bytesOf("/icons/header-32.png");
    const c = bytesOf("/icons/favicon-32.png");
    expect(a.length).toBeGreaterThan(0);
    expect(c.length).toBeGreaterThan(0);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it("見出し用の 3 本(32・64・96)はどれも別のバイト列(同じ絵を使い回していない)", () => {
    const set = new Set(["/icons/header-32.png", "/icons/header-64.png", "/icons/header-96.png"].map((p) => Buffer.from(bytesOf(p)).toString("base64")));
    expect(set.size).toBe(3);
  });
});

describe("生成物の形式・寸法(/favicon.ico)", () => {
  const ico = (): Uint8Array => bytesOf("/favicon.ico");

  it("ICO のヘッダ(予約 0・種類 1・画像 3 枚)で、各画像は 16・32・48 の PNG で、ディレクトリの範囲がファイル内に収まる", () => {
    const bytes = ico();
    expect(u16le(bytes, 0)).toBe(0);
    expect(u16le(bytes, 2)).toBe(1);
    expect(u16le(bytes, 4)).toBe(3);
    const sizes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const entry = 6 + i * 16;
      const width = bytes[entry]!; // 0 は 256 を意味する(ここでは使わない)
      const height = bytes[entry + 1]!;
      const length = u32le(bytes, entry + 8);
      const offset = u32le(bytes, entry + 12);
      expect(width).toBe(height);
      expect(offset + length).toBeLessThanOrEqual(bytes.length);
      expect(startsWithPng(bytes, offset), `エントリ ${i} は PNG`).toBe(true);
      expect(pngSize(bytes, offset)).toEqual({ chunk: "IHDR", width, height });
      sizes.push(width);
    }
    expect(sizes).toEqual([16, 32, 48]);
  });

  it("大きさは上限以内", () => {
    const e = EXPECTED.find((x) => x.path === "/favicon.ico")!;
    expect(ico().length).toBeLessThanOrEqual(e.maxBytes);
    expect(ico().length).toBeGreaterThan(300);
  });
});

/**
 * Issue #246(#244 の【記録】): 見出し用(A=全体の絵)と favicon(C=「穴」だけ)の取り違えを、画素で検出する。
 * 寸法・形式・大きさの検査(上)は、**同じ 32px の header-32 と favicon-32 を入れ替えても通る**(どちらも 32×32 の PNG で、大きさの上限も近い)。
 * 絵が違えば画素の平均輝度が違う(A は全体の絵で、C は切り抜きなので、平均が離れる)ことを使う。画素は PNG を復号して読む(`png-pixels.ts`)。
 *
 * **閾値は、今の絵(コミット済みの生成物。`gen-icons.py` が決定的に作る)に対する値。絵を差し替えるとき(元画像・切り抜きの変更)は、
 * ここの閾値〈族内の差の上限と、族の間の差の下限〉を見直すこと。** 今の絵の平均輝度は、A の族が互いに 1 未満の差で、C の族も 1 未満の差、A と C の間はその 20 倍以上の差
 * (値は下のテストが `meanLuminance` で計算する。全画素の単純平均で、画素数 N は各画像の 幅 × 高さ。生成物は決定的なので実行間のばらつきは無い)。
 */
describe("A(見出し)と C(favicon)の取り違えの検出(画素の平均輝度)", () => {
  const A_PATHS = ["/icons/header-32.png", "/icons/header-64.png", "/icons/header-96.png", "/apple-touch-icon.png"] as const;
  const C_PATHS = ["/icons/favicon-16.png", "/icons/favicon-32.png"] as const;
  const lum = (p: string): number => meanLuminance(decodePng(bytesOf(p)));
  const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);

  it("復号器の自己検査: 5 種のフィルタ(なし・Sub・Up・Average・Paeth)を行ごとに使って符号化した既知の画像が、元の画素に戻る", () => {
    const width = 7;
    const height = 5;
    const rgb = new Uint8Array(width * height * 3).map((_, i) => (i * 37 + (i % 5) * 91) & 255); // 値が大きく動く(フィルタの差が出る)
    const png = decodePng(encodePngForTest(width, height, rgb, [0, 1, 2, 3, 4]));
    expect({ w: png.width, h: png.height }).toEqual({ w: width, h: height });
    const back = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      back.set([png.rgba[i * 4]!, png.rgba[i * 4 + 1]!, png.rgba[i * 4 + 2]!], i * 3);
      expect(png.rgba[i * 4 + 3], "RGB の PNG は不透明").toBe(255);
    }
    expect(Array.from(back)).toEqual(Array.from(rgb));
    // 前提: 画像が単色でない(単色なら、どのフィルタでも通ってしまう)
    expect(new Set(rgb).size).toBeGreaterThan(20);
    // 行ごとのフィルタを入れ替えても(すべて Paeth)戻る
    const paeth = decodePng(encodePngForTest(width, height, rgb, [4, 4, 4, 4, 4]));
    expect(Array.from(paeth.rgba.filter((_, i) => i % 4 !== 3))).toEqual(Array.from(rgb));
  });

  it("配るすべての PNG が復号でき、寸法が IHDR と一致し、不透明(平均輝度が意味を持つ)", () => {
    for (const p of [...A_PATHS, ...C_PATHS]) {
      const png = decodePng(bytesOf(p));
      const expected = EXPECTED.find((e) => e.path === p)!.size!;
      expect({ w: png.width, h: png.height }, p).toEqual({ w: expected, h: expected });
      let opaque = 0;
      for (let i = 0; i < png.width * png.height; i += 1) opaque += png.rgba[i * 4 + 3] === 255 ? 1 : 0;
      expect(opaque, p).toBe(png.width * png.height);
    }
  });

  it("A の族(header-32・64・96・apple-touch-icon)の平均輝度は互いに 3 未満の差、C の族(favicon-16・32)も 3 未満の差", () => {
    expect(spread(A_PATHS.map(lum))).toBeLessThan(3);
    expect(spread(C_PATHS.map(lum))).toBeLessThan(3);
  });

  it("A と C は別の絵: 同じ 32px どうし(header-32 と favicon-32)の平均輝度が 15 以上離れ、A の族のどれと C の族のどれを比べても 15 以上離れる", () => {
    const gap = Math.abs(lum("/icons/header-32.png") - lum("/icons/favicon-32.png"));
    expect(gap, "header-32 と favicon-32 の平均輝度の差").toBeGreaterThanOrEqual(15);
    for (const a of A_PATHS) {
      for (const c of C_PATHS) {
        expect(Math.abs(lum(a) - lum(c)), `${a} と ${c}`).toBeGreaterThanOrEqual(15);
      }
    }
    // 前提: 差が 0 に張り付いていない(取り違えがあれば、族内の検査〈上〉と族間の検査のどちらかが必ず落ちる)
    expect(gap).toBeGreaterThan(0);
  });

  it("/favicon.ico の中の 16・32px の PNG は、favicon-16・favicon-32 とバイト列が同じ(ICO は C の束)。48px は C の族の平均輝度", () => {
    const ico = bytesOf("/favicon.ico");
    const inner = (index: number): Uint8Array => {
      const entry = 6 + index * 16;
      const offset = u32le(ico, entry + 12);
      return ico.subarray(offset, offset + u32le(ico, entry + 8));
    };
    expect(Buffer.from(inner(0)).equals(Buffer.from(bytesOf("/icons/favicon-16.png")))).toBe(true);
    expect(Buffer.from(inner(1)).equals(Buffer.from(bytesOf("/icons/favicon-32.png")))).toBe(true);
    const c48 = meanLuminance(decodePng(inner(2)));
    expect(Math.abs(c48 - lum("/icons/favicon-32.png"))).toBeLessThan(3);
    expect(Math.abs(c48 - lum("/icons/header-32.png"))).toBeGreaterThanOrEqual(15);
  });
});

describe("閲覧者・管理者に配る(handle())", () => {
  async function setup() {
    const key = await makeKey("k1");
    const deps = { keys: () => localKeys(key), now: () => NOW, log: () => undefined };
    return { deps, adminToken: await signToken(key), viewerToken: await signToken(key, { email: VIEWER_EMAIL }) };
  }
  const get = (path: string, token: string, method = "GET"): Request => new Request(`${ORIGIN}${path}`, { method, headers: { "Cf-Access-Jwt-Assertion": token } });
  /** バインディングを持たない環境(アイコンの配信が裏側に触れないことの確認を兼ねる)。 */
  const env = GOOD_ENV as unknown as Env;

  const combos = EXPECTED.flatMap((e) => (["admin", "viewer"] as const).map((role) => [e.path, role, e] as const));

  it("前提: 7 本 × 2 役割 = 14 通り", () => {
    expect(combos).toHaveLength(14);
  });

  it.each(combos)("GET %s(%s)→ 200・Content-Type・本文は生成物のバイト列そのもの・キャッシュは private・nosniff", async (path, role, e) => {
    const { deps, adminToken, viewerToken } = await setup();
    const response = await handle(get(path, role === "admin" ? adminToken : viewerToken), env, {}, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(e.contentType);
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(ICON_CACHE_CONTROL).toBe("private, max-age=86400");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Buffer.from(body).equals(Buffer.from(bytesOf(path)))).toBe(true);
    expect(body.length).toBeGreaterThan(300); // 前提: 本文が空でない
  });

  it.each(combos)("HEAD %s(%s)→ 本文なしの 200(同じ Content-Type)", async (path, role, e) => {
    const { deps, adminToken, viewerToken } = await setup();
    const response = await handle(get(path, role === "admin" ? adminToken : viewerToken, "HEAD"), env, {}, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(e.contentType);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("表の上でも閲覧者に開く(GET・HEAD)。POST は管理者専用(閲覧者は 403)、管理者の POST は 405(Allow: GET, HEAD)", async () => {
    const { deps, adminToken, viewerToken } = await setup();
    for (const e of EXPECTED) {
      expect(requiredRole("GET", e.path), e.path).toBe("viewer");
      expect(requiredRole("HEAD", e.path), e.path).toBe("viewer");
      expect(requiredRole("POST", e.path), e.path).toBe("admin");
    }
    const viewerPost = await handle(get("/favicon.ico", viewerToken, "POST"), env, {}, deps);
    expect(viewerPost.status).toBe(403);
    const adminPost = await handle(get("/favicon.ico", adminToken, "POST"), env, {}, deps);
    expect(adminPost.status).toBe(405);
    expect(adminPost.headers.get("allow")).toBe("GET, HEAD");
  });

  it("認証に失敗したら(JWT なし・不正な JWT)アイコンも 403 forbidden。認証の後ろから出さない", async () => {
    const { deps } = await setup();
    const none = await handle(new Request(`${ORIGIN}/favicon.ico`), env, {}, deps);
    expect(none.status).toBe(403);
    expect(await none.text()).toBe("forbidden");
    const bad = await handle(get("/icons/header-32.png", "aaa.bbb.ccc"), env, {}, deps);
    expect(bad.status).toBe(403);
    expect(await bad.text()).toBe("forbidden");
  });

  it("未知のアイコンのパスは、管理者には 404・閲覧者には 403(表に無いので管理者専用に倒れる)", async () => {
    const { deps, adminToken, viewerToken } = await setup();
    for (const path of ["/icons/header-33.png", "/Favicon.ico", "/favicon.ico/", "/icons/"]) {
      expect((await handle(get(path, adminToken), env, {}, deps)).status, path).toBe(404);
      expect((await handle(get(path, viewerToken), env, {}, deps)).status, path).toBe(403);
    }
  });
});
