import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 回帰ガード(実効化版): app main の実HTTP経路が Electron の net.fetch 注入を素通りしないことを、
 * ソース走査で検知する。
 *
 * 背景: undici を core の ^7 へ整合したため、非注入経路でも Electron 内で「壊れ」はしなくなった。
 * しかし net.fetch 注入には Chromium ネットワークスタック由来の実利(システムプロキシ・OS TLS・
 * Node バージョン非依存)があり、これを将来のコードが取りこぼさないよう固定する。
 *
 * 旧ガード(ビルド後バンドルに対する `require("undici").fetch` の正規表現)は、実バンドル形態
 * (esbuild のインライン化で `require_undici2()` 等になる)と一致せず、実際の回帰
 * (fetch 未注入の HttpClient / sendDiscordNotification の追加)を検知できなかった。
 * 本ガードは「ソース上の生成・呼び出しに fetch が渡っているか」を直接検証するため実効性がある。
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(currentDir, "../src");

/** 開き括弧 openIndex に対応する閉じ括弧までの部分文字列(入れ子対応)を返す。 */
function balancedParenSlice(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex, i + 1);
      }
    }
  }
  // 括弧が閉じない(構文的にありえない)場合は残り全体を返す。
  return source.slice(openIndex);
}

/**
 * `token`(末尾が "(" の呼び出し/生成)ごとに、その引数領域(括弧内)へ `fetch` が
 * 現れないもの(=注入漏れ)を数える。
 */
export function countUninjected(source: string, token: string): number {
  let violations = 0;
  let idx = 0;
  while ((idx = source.indexOf(token, idx)) !== -1) {
    const openIndex = idx + token.length - 1; // token は "(" で終わる
    const region = balancedParenSlice(source, openIndex);
    if (!/\bfetch\b/.test(region)) {
      violations += 1;
    }
    idx += token.length;
  }
  return violations;
}

/** app/src 配下の .ts ソースを結合して返す。 */
function readAllSource(): string {
  const entries = readdirSync(srcDir, { recursive: true, encoding: "utf8" });
  return entries
    .filter((rel) => rel.endsWith(".ts"))
    .map((rel) => readFileSync(path.join(srcDir, rel), "utf8"))
    .join("\n");
}

describe("net.fetch 注入の回帰ガード(app main の実HTTP経路)", () => {
  it("app/src の new HttpClient(...) はすべて fetch を注入している", () => {
    const source = readAllSource();
    expect(countUninjected(source, "new HttpClient(")).toBe(0);
  });

  it("app/src の sendDiscordNotification(...) はすべて fetch を注入している", () => {
    const source = readAllSource();
    expect(countUninjected(source, "sendDiscordNotification(")).toBe(0);
  });

  // ガード自身の実効性(=注入漏れを本当に検知できること)を固定する自己検証。
  it("注入漏れコード片を検知できる(検出器の実効性)", () => {
    expect(countUninjected("const c = new HttpClient();", "new HttpClient(")).toBe(1);
    expect(
      countUninjected(
        "const c = new HttpClient({ maxRetries: 2 });",
        "new HttpClient(",
      ),
    ).toBe(1);
    expect(
      countUninjected(
        "await sendDiscordNotification(url, payload);",
        "sendDiscordNotification(",
      ),
    ).toBe(1);
  });

  // 正しい注入は検知しない(誤検知しないこと)。
  it("fetch 注入済みコードは検知しない(誤検知しない)", () => {
    expect(
      countUninjected(
        "const c = new HttpClient({ fetch: config.fetch });",
        "new HttpClient(",
      ),
    ).toBe(0);
    expect(
      countUninjected(
        "await sendDiscordNotification(url, buildPayload(r), { fetch: adapter });",
        "sendDiscordNotification(",
      ),
    ).toBe(0);
  });
});
