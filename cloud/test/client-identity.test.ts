import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { applyDisplayName, DISPLAY_NAME_MAX, fetchDisplayName, IDENTITY_URL, sanitizeDisplayName, WHO_NAME_SELECTOR } from "../client/identity";
import { renderPage } from "../src/page";

/**
 * Issue #192: ログイン中の表示を、Google のユーザー名にする。純関数・偽の fetch・偽の要素。
 * 名前は表示だけに使い、認可には使わない。取れない・形が違う・空のときは、メールアドレスのまま(null を返す)。
 * テストの値は example.com と仮の名前だけ(リポジトリは公開)。
 */

type Resp = { status: number; json: () => Promise<unknown> };
const resp = (status: number, body: unknown): Resp => ({ status, json: async () => body });

function fake(respond: () => Promise<Resp>): { fetch: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return respond();
    },
  };
}

describe("fetchDisplayName(GET /cdn-cgi/access/get-identity)", () => {
  it("リクエスト: 同じオリジンの GET(資格情報は same-origin)。1 回だけ", async () => {
    const f = fake(async () => resp(200, { name: "テスト 太郎" }));
    await fetchDisplayName(f.fetch);
    expect(IDENTITY_URL).toBe("/cdn-cgi/access/get-identity");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/cdn-cgi/access/get-identity");
    expect(f.calls[0]!.init.method).toBe("GET");
    expect(f.calls[0]!.init.credentials).toBe("same-origin");
  });

  it("200 の JSON で name が空でない文字列なら、整えた名前を返す(name 以外のキーは読まない・あっても構わない)", async () => {
    const f = fake(async () => resp(200, { name: "  テスト 太郎  ", email: "taro@example.com", idp: { type: "google" }, geo: { country: "JP" }, extra: 1 }));
    expect(await fetchDisplayName(f.fetch)).toBe("テスト 太郎");
  });

  it.each([
    ["200 で HTML(json() が失敗する)", async () => ({ status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } })],
    ["401", async () => resp(401, { name: "テスト 太郎" })],
    ["403", async () => resp(403, { name: "テスト 太郎" })],
    ["404", async () => resp(404, { name: "テスト 太郎" })],
    ["302", async () => resp(302, { name: "テスト 太郎" })],
    ["500", async () => resp(500, { name: "テスト 太郎" })],
    ["200 で name が無い", async () => resp(200, { email: "taro@example.com" })],
    ["200 で name が空文字", async () => resp(200, { name: "" })],
    ["200 で name が空白だけ", async () => resp(200, { name: " \u3000\u00a0 " })],
    ["200 で name が制御文字・双方向制御だけ", async () => resp(200, { name: "\u0000\u202e\u200b\ufeff\u2066" })],
    ["200 で name が数値", async () => resp(200, { name: 123 })],
    ["200 で name が null", async () => resp(200, { name: null })],
    ["200 で name が配列", async () => resp(200, { name: ["テスト"] })],
    ["200 で name がオブジェクト", async () => resp(200, { name: { first: "テスト" } })],
    ["200 で本文が配列", async () => resp(200, [{ name: "テスト" }])],
    ["200 で本文が文字列", async () => resp(200, "テスト")],
    ["200 で本文が null", async () => resp(200, null)],
    ["ネットワークエラー(例外)", async () => { throw new TypeError("Failed to fetch"); }],
  ] as const)("%s → null(メールアドレスのまま)", async (_label, respond) => {
    const f = fake(respond as () => Promise<Resp>);
    expect(await fetchDisplayName(f.fetch)).toBeNull();
    expect(f.calls).toHaveLength(1); // 失敗しても再試行しない
  });
});

describe("sanitizeDisplayName(整形)", () => {
  it("上限は 64 コードポイント", () => {
    expect(DISPLAY_NAME_MAX).toBe(64);
  });

  it.each([
    ["通常", "テスト 太郎", "テスト 太郎"],
    ["前後の空白(全角・NBSP を含む)を除く", "\u3000 \u00a0テスト 太郎\t\n ", "テスト 太郎"],
    ["内部の全角の空白はそのまま(畳まない)", "山田\u3000太郎", "山田\u3000太郎"],
    ["制御文字(NUL・改行・タブ・C1)を落とす", "テ\u0000ス\nト\t\u0085太郎", "テスト太郎"],
    ["行・段落の区切りを落とす", "テ\u2028ス\u2029ト", "テスト"],
    ["双方向制御(LRM・RLM・ALM・LRE〜RLO・LRI〜PDI)を落とす", "a\u200eb\u200fc\u061cd\u202ae\u202bf\u202cg\u202dh\u202ei\u2066j\u2067k\u2068l\u2069m", "abcdefghijklm"],
    ["幅ゼロの空白・BOM を落とす", "テ\u200bス\ufeffト", "テスト"],
    ["ZWJ・ZWNJ は残す(絵文字・ペルシャ語等の正しい表示に要る)", "a\u200db\u200cc", "a\u200db\u200cc"],
    ["サロゲートペア(絵文字)はそのまま", "テスト😀", "テスト😀"],
    ["HTML らしい文字列も、文字のまま(解釈は textContent が防ぐ。ここでは変えない)", "<b>テスト</b>", "<b>テスト</b>"],
  ])("%s", (_label, input, expected) => {
    expect(sanitizeDisplayName(input)).toBe(expected);
  });

  it.each([[""], [" "], ["\u202e"], ["\u0000\u0001"], [123], [null], [undefined], [{}], [[]], [true]])("%j は null", (input) => {
    expect(sanitizeDisplayName(input)).toBeNull();
  });

  it("64 コードポイントちょうどはそのまま(境界)", () => {
    const name = "あ".repeat(64);
    expect([...name]).toHaveLength(64);
    expect(sanitizeDisplayName(name)).toBe(name);
  });

  it("65 コードポイントは、先頭 63 + 「…」(境界。合計 64)", () => {
    const out = sanitizeDisplayName("あ".repeat(65))!;
    expect(out).toBe("あ".repeat(63) + "…");
    expect([...out]).toHaveLength(64);
  });

  it("長すぎる(10,000 文字)名前も、先頭 63 + 「…」", () => {
    const out = sanitizeDisplayName("い".repeat(10_000))!;
    expect(out).toBe("い".repeat(63) + "…");
  });

  it("切る位置がサロゲートペアの途中にならない(絵文字を割らない)", () => {
    // 62 文字 + 絵文字 3 つ = 65 コードポイント。先頭 63 コードポイント = 62 文字 + 絵文字 1 つ。UTF-16 の単位で切ると絵文字が割れる。
    const input = "あ".repeat(62) + "😀😀😀";
    expect([...input]).toHaveLength(65);
    const out = sanitizeDisplayName(input)!;
    expect(out).toBe("あ".repeat(62) + "😀…");
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/); // 孤立したサロゲートが無い
  });

  it("切った末尾が空白なら、その空白も除いてから「…」を付ける", () => {
    // 先頭 63 コードポイント = 62 文字 + 空白。空白を除いて「…」を付ける。
    const out = sanitizeDisplayName("あ".repeat(62) + " " + "い".repeat(10))!;
    expect(out).toBe("あ".repeat(62) + "…");
  });

  it("先頭の 1,000 UTF-16 単位だけを読む(それより後ろは見ない)", () => {
    // 先頭 1,000 単位がすべて落とす文字なら、その後ろに名前があっても読まない(読むなら「テスト」になる。上限の有無で結果が変わる)。
    expect(sanitizeDisplayName("\u202e".repeat(1_000) + "テスト")).toBeNull();
    // 999 単位が落とす文字なら、1,000 単位目の 1 文字だけが読まれる(境界)。
    expect(sanitizeDisplayName("\u202e".repeat(999) + "テスト")).toBe("テ");
    // 先頭が長い名前なら、先頭 63 + 「…」。
    expect(sanitizeDisplayName("う".repeat(1_000) + "\u202e" + "え".repeat(1_000))).toBe("う".repeat(63) + "…");
    // 落としたあとで 64 以内になる場合は、落としたあとの長さで判定する。
    expect(sanitizeDisplayName("\u202e".repeat(500) + "テスト")).toBe("テスト");
  });
});

describe("applyDisplayName(書き込み)", () => {
  it("name があれば、textContent を置き換える(テキストとして)", () => {
    const el = { textContent: "taro@example.com" };
    applyDisplayName(el, "テスト 太郎");
    expect(el.textContent).toBe("テスト 太郎");
  });

  it("HTML らしい名前も、そのまま文字として入る(textContent なので解釈されない)", () => {
    const el = { textContent: "taro@example.com" };
    applyDisplayName(el, "<img src=x onerror=alert(1)>");
    expect(el.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("name が null なら、メールアドレスのまま(触らない)", () => {
    const el = { textContent: "taro@example.com" };
    applyDisplayName(el, null);
    expect(el.textContent).toBe("taro@example.com");
  });

  it("要素が無い(null)ときも投げない", () => {
    expect(() => applyDisplayName(null, "テスト 太郎")).not.toThrow();
  });
});

describe("書き込み先(renderPage の出力との対応。page.ts の改名で静かに効かなくなるのを防ぐ)", () => {
  it("セレクタは `.who .email`", () => {
    expect(WHO_NAME_SELECTOR).toBe(".who .email");
  });

  it("renderPage の出力に、class=who の p の中の class=email の span があり、そこにメールアドレス(エスケープ済み)が入る", () => {
    const html = renderPage("taro@example.com", "admin");
    expect(html).toMatch(/<p class="who">[^<]*<span class="email">taro@example\.com<\/span><\/p>/);
    // 該当する span は 1 つだけ(querySelector が別の要素を拾わない)
    expect(html.match(/class="email"/g)).toHaveLength(1);
    expect(html.match(/class="who"/g)).toHaveLength(1);
  });

  it("Issue #238: 閲覧者の出力でも、書き込み先(.who .email)は 1 つだけで、メールの span の中身はメールアドレスのまま(Issue #243 以降、「閲覧専用」の span は無い)", () => {
    const html = renderPage("taro@example.com", "viewer");
    expect(html).toMatch(/<p class="who">[^<]*<span class="email">taro@example\.com<\/span><\/p>/);
    expect(html).not.toContain("閲覧専用");
    expect(html.match(/class="email"/g)).toHaveLength(1);
    expect(html.match(/class="who"/g)).toHaveLength(1);
  });
});
