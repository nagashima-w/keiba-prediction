/**
 * Issue #324: iconv-lite の更新(0.6.3 → 0.7.3)で EUC-JP の変換結果が変わっていないことの回帰テスト。
 *
 * iconv-lite は core の HttpClient(`iconv.decode(body, "euc-jp")`。db.netkeiba.com の馬ページ等)で使う。
 * 期待値(sha256)は **更新前の iconv-lite 0.6.3 で測った値**で、更新後(0.7.3)も同じであることを固定する。
 * 順序: このテストを先に足して 0.6.3 で緑にし、更新して緑のままであることを確かめた(Issue #324)。
 *
 * 再現方法: 各 sha256 は、下の関数と同じ手順(フィクスチャのテキストを `iconv.encode(text, "euc-jp")` したバイト列、
 * 0xA1〜0xFE の 2 バイト全組を `iconv.decode(…, "euc-jp")` した文字列を UTF-8 にしたバイト列)の sha256。
 * 版が違えば値が変わりうる(だから固定する)。実サイトへのリクエストは含まない。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";

function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  // 改行コードの違い(チェックアウト設定)で値が変わらないよう LF に揃える
  return readFileSync(fileURLToPath(url), "utf-8").replace(/\r\n/g, "\n");
}

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** [フィクスチャ, EUC-JP にしたバイト数, そのバイト列の sha256(iconv-lite 0.6.3 で測定)] */
const FIXTURE_CASES: ReadonlyArray<readonly [string, number, string]> = [
  ["horse_2021105857.html", 66954, "184d4323c18f296c35ccbc0a4c89b48bace1915b12788e52a3d68b2f55a13ddf"],
  ["horse_2023103386.html", 67196, "eb3c5a3782b002a16406c0da053e7fcb5dc3c28dbcfa183a1527dfbf9939dc96"],
  ["jockey_results_01170.html", 68421, "39d8ef3c495b065f789f42b0e63b87e739be645f0925e86bb8b027de240bd269"],
];

describe("iconv-lite の EUC-JP 変換が更新前(0.6.3)と変わらない(Issue #324)", () => {
  it.each(FIXTURE_CASES)("フィクスチャ %s: EUC-JP にしたバイト列が測定済みの値と一致し、デコードで元の文字列に戻る", (name, bytes, digest) => {
    const text = loadFixture(name);
    // 前提(空振り防止): 日本語を含む十分な長さのテキストである
    expect(text.length).toBeGreaterThan(10000);
    expect(/[ぁ-んァ-ン一-龥]/.test(text)).toBe(true);
    const encoded = iconv.encode(text, "euc-jp");
    expect(encoded.length).toBe(bytes);
    expect(sha256(encoded)).toBe(digest);
    expect(iconv.decode(encoded, "euc-jp")).toBe(text);
  });

  it("JIS X 0208 の 2 バイト全組(0xA1〜0xFE × 0xA1〜0xFE)のデコード結果が測定済みの値と一致する", () => {
    const pairs: number[] = [];
    for (let a = 0xa1; a <= 0xfe; a += 1) for (let b = 0xa1; b <= 0xfe; b += 1) pairs.push(a, b);
    // 前提: 94 × 94 組 = 17672 バイトを渡している
    expect(pairs).toHaveLength(94 * 94 * 2);
    const decoded = iconv.decode(Buffer.from(pairs), "euc-jp");
    expect(decoded.length).toBe(9108);
    expect(sha256(Buffer.from(decoded, "utf-8"))).toBe("732add2eeb5e3b980b374d753614c746ab25a421464a7d3c65b6cc5e6a949b8a");
  });

  it("半角カナ(0x8E 0xA1〜0xDF)のデコード結果が測定済みの値と一致する", () => {
    const bytes: number[] = [];
    for (let b = 0xa1; b <= 0xdf; b += 1) bytes.push(0x8e, b);
    expect(bytes).toHaveLength(63 * 2);
    const decoded = iconv.decode(Buffer.from(bytes), "euc-jp");
    expect(decoded.length).toBe(63);
    expect(sha256(Buffer.from(decoded, "utf-8"))).toBe("7fde920d40aa714b2d065aba80954894f7f94c26749a166c21a0af977da711fd");
  });

  it("サポート対象のエンコーディング名(euc-jp・eucjp・utf-8)が使える", () => {
    for (const name of ["euc-jp", "eucjp", "utf-8"]) {
      expect(iconv.encodingExists(name), name).toBe(true);
    }
  });
});
