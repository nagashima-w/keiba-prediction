/**
 * Issue #304: Anthropic の宛先(baseURL)の固定。
 *
 * `@anthropic-ai/sdk` 0.70.1 のコンストラクタは `baseURL` の既定値を環境変数 `ANTHROPIC_BASE_URL` から読む
 * (`client.js` の `baseURL = readEnv('ANTHROPIC_BASE_URL')`)。Worker は `nodejs_compat` で secret が `process.env` に入りうるので、
 * その名前の secret を誤って登録すると、API キーが別のホストへ送られる。
 * そこで `new Anthropic({...})` に `baseURL: ANTHROPIC_API_BASE_URL`(`https://api.anthropic.com`)を固定で渡す。
 *
 * このファイルが固定すること:
 *  1. 環境変数 `ANTHROPIC_BASE_URL` に別のホストを入れても、messages(`createSdkMessageSender`)・Models API(`createSdkModelLister`)の
 *     実際の送信先(偽 fetch が受け取った URL)のホストは `api.anthropic.com` のまま
 *  2. リポジトリ内の `new Anthropic(` はすべて `baseURL: ANTHROPIC_API_BASE_URL` を渡している(静的ガード。新しく足した箇所の渡し忘れを検出する)
 * すべて偽 fetch で、実 API には出ない。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSdkMessageSender, type AnthropicRequestParams } from "../../src/analyzer/anthropic-client.js";
import { ANTHROPIC_API_BASE_URL } from "../../src/analyzer/anthropic-endpoint.js";
import { createSdkModelLister } from "../../src/analyzer/model-selection.js";

const FAKE_KEY = "sk-ant-fake-test-key-not-real";
const EVIL_BASE_URL = "https://evil.example.test";
const REQUEST: AnthropicRequestParams = {
  model: "claude-sonnet-5-5",
  max_tokens: 10,
  output_config: { effort: "low" },
  messages: [{ role: "user", content: "p" }],
};

/** 受け取った URL を記録し、種類に応じた固定の応答を返す偽 fetch(実 API には出ない)。 */
function recordingFetch() {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: unknown) => {
    urls.push(String(url));
    const body = String(url).includes("/v1/models")
      ? { data: [], has_more: false, first_id: null, last_id: null }
      : {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "x" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { urls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("環境変数 ANTHROPIC_BASE_URL が効かない(Issue #304)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = EVIL_BASE_URL;
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = saved;
    }
  });

  it("定数は https://api.anthropic.com", () => {
    expect(ANTHROPIC_API_BASE_URL).toBe("https://api.anthropic.com");
  });

  it("createSdkMessageSender: 環境変数に別のホストを入れても、送信先は api.anthropic.com(messages)", async () => {
    // 前提(空振り防止): 環境変数は実際に別のホストに設定されている
    expect(process.env.ANTHROPIC_BASE_URL).toBe(EVIL_BASE_URL);
    const { urls, fetchImpl } = recordingFetch();
    await createSdkMessageSender({ apiKey: FAKE_KEY, fetch: fetchImpl })(REQUEST);
    // 前提: 偽 fetch は実際に 1 本受け取っている
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.host).toBe("api.anthropic.com");
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/v1/messages");
  });

  it("createSdkModelLister: 環境変数に別のホストを入れても、送信先は api.anthropic.com(Models API)", async () => {
    expect(process.env.ANTHROPIC_BASE_URL).toBe(EVIL_BASE_URL);
    const { urls, fetchImpl } = recordingFetch();
    await createSdkModelLister({ apiKey: FAKE_KEY, fetch: fetchImpl })();
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.host).toBe("api.anthropic.com");
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/v1/models");
  });
});

describe("静的ガード: new Anthropic( はすべて baseURL を固定で渡す(Issue #304)", () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const SCAN_DIRS = ["packages/core/src", "cloud/src", "scripts"];

  /** 拡張子 .ts/.tsx/.js/.mjs のファイルを再帰で集める(node_modules・dist は除く)。 */
  function collect(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        out.push(...collect(full));
      } else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
        out.push(full);
      }
    }
    return out;
  }

  /** `new Anthropic(` の開き括弧から対応する閉じ括弧までの文字列(引数のブロック)を、出現ごとに返す。 */
  function constructorBlocks(source: string): string[] {
    const blocks: string[] = [];
    const re = /new\s+Anthropic\s*\(/g;
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (c === "(") depth += 1;
        else if (c === ")") depth -= 1;
        i += 1;
      }
      blocks.push(source.slice(start, i - 1));
    }
    return blocks;
  }

  const found: { file: string; block: string }[] = [];
  for (const d of SCAN_DIRS) {
    for (const f of collect(path.join(REPO_ROOT, d))) {
      for (const block of constructorBlocks(readFileSync(f, "utf-8"))) {
        found.push({ file: path.relative(REPO_ROOT, f), block });
      }
    }
  }

  it("前提(空振り防止): 少なくとも 2 箇所(messages と Models API)の new Anthropic( を見つけている", () => {
    expect(found.length).toBeGreaterThanOrEqual(2);
    const files = found.map((f) => f.file);
    expect(files).toContain("packages/core/src/analyzer/anthropic-client.ts");
    expect(files).toContain("packages/core/src/analyzer/model-selection.ts");
  });

  it("見つけた new Anthropic( のすべての引数に baseURL: ANTHROPIC_API_BASE_URL がある", () => {
    const missing = found.filter((f) => !/baseURL\s*:\s*ANTHROPIC_API_BASE_URL\b/.test(f.block)).map((f) => f.file);
    expect(missing).toEqual([]);
  });

  it("括弧の対応づけの自己検査: 渡し忘れのブロックは検出される", () => {
    const blocks = constructorBlocks("const a = new Anthropic({ apiKey: f(1), ...(x ? {} : { y: 1 }) });\nconst b = new Anthropic({ baseURL: ANTHROPIC_API_BASE_URL });");
    expect(blocks).toHaveLength(2);
    expect(/baseURL\s*:\s*ANTHROPIC_API_BASE_URL\b/.test(blocks[0]!)).toBe(false);
    expect(/baseURL\s*:\s*ANTHROPIC_API_BASE_URL\b/.test(blocks[1]!)).toBe(true);
  });
});
