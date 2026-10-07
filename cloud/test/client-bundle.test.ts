import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildClientJs, CLIENT_DIR, GENERATED_PATH, renderGeneratedModule } from "../build-client";
import { CLIENT_JS } from "../src/client-bundle.generated";

/**
 * Issue #184: クライアントのバンドル(`client/` → `src/client-bundle.generated.ts`)の検査。
 *  - ドリフト: コミット済みの生成物が、今のソースから再ビルドした出力と一致する(クライアントを直して再生成を忘れると赤になる)
 *  - 決定性: minify により、出力にリポジトリの絶対パス・パスコメントが入らない(入ると cwd・OS で出力が変わり、ドリフトの検査が環境依存になる)
 *  - 静的ガード: HTML を文字列として解釈させる API・eval・Node の組込みを使わない(XSS・CSP)
 *  - 実行スモーク: 生成物を偽の DOM・偽の fetch で評価し、ロードで例外にならず、初回の取得と描画・更新の連打ガードが実際に動く
 */

const ROOT = path.resolve(CLIENT_DIR, "..", "..");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const clientFiles = readdirSync(CLIENT_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(CLIENT_DIR, f));

describe("生成物のドリフトと決定性", () => {
  it("前提: 生成物は空でなく、クライアントのソースがある", () => {
    expect(CLIENT_JS.length).toBeGreaterThan(1000);
    expect(clientFiles.length).toBeGreaterThanOrEqual(5);
  });

  it("コミット済みの CLIENT_JS・生成ファイルが、今のソースから再ビルドした出力と一致する(不一致なら `pnpm run build:client` で再生成する)", async () => {
    const js = await buildClientJs();
    expect(js, "CLIENT_JS が古い。cloud/ で `pnpm run build:client` を実行して再生成する").toBe(CLIENT_JS);
    const file = readFileSync(GENERATED_PATH, "utf-8").replace(/\r\n/g, "\n");
    expect(file).toBe(renderGeneratedModule(js));
  }, 60_000);

  it("出力にリポジトリの絶対パス・パスコメントが入らない(minify。cwd・OS によらず同じ出力になる)", () => {
    expect(CLIENT_JS).not.toContain(ROOT);
    expect(CLIENT_JS).not.toContain("keiba-prediction");
    expect(CLIENT_JS).not.toMatch(/^\s*\/\//m);
  });

  it("対照: minify を外すとパスコメントが入る(上の検査が、実際に入ったときに拾えることの確認)", async () => {
    const unminified = await buildClientJs({ minify: false });
    expect(unminified).toMatch(/^\s*\/\/ client\//m);
    expect(unminified).not.toBe(CLIENT_JS);
  }, 60_000);

  it("生成物は小さい(肥大の検知。上限は 100KB)", () => {
    expect(Buffer.byteLength(CLIENT_JS)).toBeLessThan(100_000);
  });
});

/** 外から来た文字列を HTML・コードとして解釈させる API と、ブラウザで使えない Node の組込み。 */
const FORBIDDEN: readonly [string, RegExp][] = [
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["document.write", /document\s*\.\s*write/],
  ["eval(", /\beval\s*\(/],
  ["new Function", /new\s+Function\b/],
  ["setAttribute('style')", /setAttribute\(\s*["']style["']/],
  ["node: の組込み", /["']node:/],
  ["require(", /\brequire\s*\(/],
  ["動的 import", /\bimport\s*\(/],
];

describe("静的ガード(クライアントのソースと生成物)", () => {
  it("ソース(コメントを除く)と生成物に、禁止の API が無い", () => {
    for (const file of clientFiles) {
      const code = stripComments(readFileSync(file, "utf-8"));
      for (const [name, pattern] of FORBIDDEN) {
        expect(pattern.test(code), `${path.basename(file)} に ${name}`).toBe(false);
      }
    }
    for (const [name, pattern] of FORBIDDEN) {
      expect(pattern.test(CLIENT_JS), `生成物に ${name}`).toBe(false);
    }
  });

  it("対照: 検出の正規表現は、実際に書かれたときに拾える(空振りでない)", () => {
    const samples: Record<string, string> = {
      innerHTML: "el.innerHTML = x;",
      outerHTML: "el.outerHTML = x;",
      insertAdjacentHTML: "el.insertAdjacentHTML('beforeend', x);",
      "document.write": "document.write(x);",
      "eval(": "eval(x);",
      "new Function": "new Function('return 1');",
      "setAttribute('style')": "el.setAttribute('style', x);",
      "node: の組込み": 'import "node:fs";',
      "require(": "require('fs');",
      "動的 import": "import('./x.js');",
    };
    expect(Object.keys(samples).sort()).toEqual(FORBIDDEN.map(([n]) => n).sort());
    for (const [name, pattern] of FORBIDDEN) {
      expect(pattern.test(samples[name]!), name).toBe(true);
    }
  });

  it("クライアントの import は、client/ の中の相対 import だけ(バレル・core・node_modules・Node の組込みを取り込まない。#185 で renderer の純関数を足すときに、この検査を見直す)", () => {
    let count = 0;
    for (const file of clientFiles) {
      const code = stripComments(readFileSync(file, "utf-8"));
      for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;"']*?\bfrom\s*["']([^"']+)["']/g)) {
        count += 1;
        expect(m[1]!.startsWith("./"), `${path.basename(file)} の import ${m[1]}`).toBe(true);
      }
    }
    expect(count).toBeGreaterThan(5); // 前提: import を実際に拾えている
  });
});

describe("生成物の実行スモーク(偽の DOM・偽の fetch。node:vm)", () => {
  const FIXED = new Date("2026-06-28T00:00:00Z").getTime(); // JST 2026-06-28 09:00
  const DATE = "20260628";

  class FakeText {
    constructor(readonly data: string) {}
  }
  class FakeElement {
    readonly attrs = new Map<string, string>();
    readonly children: (FakeElement | FakeText)[] = [];
    readonly listeners = new Map<string, ((event: unknown) => void)[]>();
    value = "";
    constructor(readonly tag: string) {}
    setAttribute(name: string, value: string): void {
      this.attrs.set(name, value);
    }
    appendChild(child: FakeElement | FakeText): void {
      this.children.push(child);
    }
    addEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
  }
  const flat = (n: FakeElement | FakeText): (FakeElement | FakeText)[] => (n instanceof FakeText ? [n] : [n, ...n.children.flatMap(flat)]);
  const textOf = (n: FakeElement | FakeText): string => flat(n).filter((x): x is FakeText => x instanceof FakeText).map((x) => x.data).join(" ");

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  function run() {
    const root = { children: [] as (FakeElement | FakeText)[], replaceChildren(...nodes: (FakeElement | FakeText)[]) { this.children = nodes; } };
    const listeners = new Map<string, (() => void)[]>();
    const calls: { url: string; init: { method?: string; credentials?: string; body?: string } }[] = [];
    const location = { hash: "" };
    const fetchStub = async (url: string, init: { method?: string; credentials?: string; body?: string }) => {
      calls.push({ url, init });
      if (url.startsWith("/api/races")) {
        return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, venue: "central", races: [{ race_id: "202603020211", venue_name: "福島", race_number: 11, race_name: "福島民報杯", course_type: "芝", distance: 1800, entry_count: 16, grade: null }] }) };
      }
      return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, races: [] }) };
    };
    class FixedDate extends Date {
      constructor(...args: unknown[]) {
        super(...((args.length === 0 ? [FIXED] : args) as [number]));
      }
      static override now(): number {
        return FIXED;
      }
    }
    const context = {
      document: { getElementById: (id: string) => (id === "app" ? root : null), createElement: (tag: string) => new FakeElement(tag), createTextNode: (t: string) => new FakeText(t) },
      window: { addEventListener: (type: string, fn: () => void) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
      location,
      fetch: fetchStub,
      Date: FixedDate,
      URLSearchParams,
      Promise,
      console,
    };
    vm.runInNewContext(CLIENT_JS, context);
    return { root, listeners, calls, location };
  }

  it("ロードで例外にならず、今日(JST)の一覧と板を 1 回ずつ取り(GET・同じオリジンの資格情報)、描画する。hashchange を購読する。ハッシュを書き換えない", async () => {
    const { root, listeners, calls, location } = run();
    await until(() => calls.length >= 2 && root.children.length > 0 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    expect(calls.map((c) => c.url).sort()).toEqual([`/api/analyses/status?kaisai_date=${DATE}`, `/api/races?kaisai_date=${DATE}&venue=central`].sort());
    for (const call of calls) {
      expect(call.init.method).toBe("GET");
      expect(call.init.credentials).toBe("same-origin");
      expect(call.init.body).toBeUndefined();
    }
    expect(root.children).toHaveLength(1);
    expect(textOf(root.children[0]!)).toContain("福島民報杯");
    expect((listeners.get("hashchange") ?? []).length).toBe(1);
    expect(location.hash).toBe("");
  });

  it("「更新」を連打しても、取得は 1 回分(一覧と板で 2 本)だけ増える。POST は呼ばれない", async () => {
    const { root, calls } = run();
    await until(() => calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    const before = calls.length;
    const refresh = flat(root.children[0]!).find((n): n is FakeElement => n instanceof FakeElement && n.tag === "button")!;
    const click = refresh.listeners.get("click")![0]!;
    click(undefined);
    click(undefined);
    click(undefined);
    await until(() => calls.length >= before + 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.length).toBe(before + 2);
    expect(calls.filter((c) => c.init.method !== "GET")).toEqual([]);
  });
});
