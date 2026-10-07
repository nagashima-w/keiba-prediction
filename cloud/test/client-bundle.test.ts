import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildClientJs, CLIENT_DIR, GENERATED_PATH, listBundledInputs, renderGeneratedModule } from "../build-client";
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


/** クライアントが取り込んでよい exe 側のモジュール(相対 import の指定子。拡張子なし)。exe の renderer・shared の純関数だけ。#185 で配分の表示(`buildAllocationProposalView`)を流用するため。 */
const ALLOWED_EXTERNAL_IMPORTS = new Set([
  "../../packages/app/src/renderer/allocation-proposal-view",
  "../../packages/app/src/renderer/format",
  "../../packages/app/src/shared/analysis-types",
]);

function importAllowed(specifier: string): boolean {
  return specifier.startsWith("./") || ALLOWED_EXTERNAL_IMPORTS.has(specifier);
}

/** バンドルの入力(metafile)のうち、入れてはいけないもの: node_modules・バレル・better-sqlite3 に依存する core のモジュール・exe の main・Node の組込み。 */
function forbiddenInputs(inputs: readonly string[]): string[] {
  return inputs.filter(
    (f) =>
      /node_modules/.test(f) ||
      /packages\/core\/src\/index\.ts$/.test(f) ||
      /packages\/core\/src\/(?:ev\/analysis-store|scraper\/cache)\.ts$/.test(f) ||
      /packages\/app\/src\/main\//.test(f) ||
      /^node:/.test(f),
  );
}

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

  it("クライアントの import は、client/ の中(`./`)と、許可リストの exe の renderer・shared だけ(バレル・core の直接 import・node_modules・Node の組込みを取り込まない)", () => {
    let count = 0;
    let external = 0;
    for (const file of clientFiles) {
      const code = stripComments(readFileSync(file, "utf-8"));
      for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;"']*?\bfrom\s*["']([^"']+)["']/g)) {
        count += 1;
        const spec = m[1]!;
        if (!spec.startsWith("./")) external += 1;
        expect(importAllowed(spec), `${path.basename(file)} の import ${spec}`).toBe(true);
      }
    }
    expect(count).toBeGreaterThan(5); // 前提: import を実際に拾えている
    expect(external, "前提: renderer の import を実際に拾えている(0 だと許可リストの検査が空振り)").toBeGreaterThan(0);
  });

  it("対照: import の許可判定は、バレル・core の直接 import・bare specifier・許可外の renderer を拒否する(上の検査が空振りでない)", () => {
    for (const bad of ["@keiba/core", "@keiba/core/ev/bet-allocation", "react", "node:fs", "../../packages/core/src/index", "../../packages/app/src/renderer/VerifyView", "../src/handler", "../../packages/app/src/main/analysis-export"]) {
      expect(importAllowed(bad), bad).toBe(false);
    }
    for (const good of ["./api", "../../packages/app/src/renderer/allocation-proposal-view", "../../packages/app/src/renderer/format", "../../packages/app/src/shared/analysis-types"]) {
      expect(importAllowed(good), good).toBe(true);
    }
  });

  it("バンドルの閉包(esbuild の metafile): exe の renderer の純関数が実際に入っており、node_modules・バレル・better-sqlite3 に依存するモジュール・Node の組込みは入っていない", async () => {
    const inputs = await listBundledInputs();
    expect(inputs.some((f) => f.endsWith("packages/app/src/renderer/allocation-proposal-view.ts")), "前提: renderer の流用が閉包に入っている").toBe(true);
    expect(inputs.some((f) => f.endsWith("packages/core/src/ev/combo-bet-allocation.ts")), "前提: core のサブパスが tsconfig の paths で解決されている").toBe(true);
    expect(forbiddenInputs(inputs)).toEqual([]);
  }, 60_000);

  it("対照: 閉包の検査は、node_modules・バレル・better-sqlite3 に依存するモジュール・node: を拾える(空振りでない)", () => {
    const bad = [
      "../node_modules/cheerio/lib/index.js",
      "../packages/core/src/index.ts",
      "../packages/core/src/ev/analysis-store.ts",
      "../packages/core/src/scraper/cache.ts",
      "node:zlib",
      "../packages/app/src/main/analysis-export.ts",
    ];
    expect(forbiddenInputs(bad)).toEqual(bad);
    expect(forbiddenInputs(["client/main.ts", "../packages/app/src/renderer/format.ts", "../packages/core/src/ev/bet-allocation.ts"])).toEqual([]);
  });
});

describe("生成物の実行スモーク(偽の DOM・偽の fetch。node:vm)", () => {
  const FIXED = new Date("2026-06-28T00:00:00Z").getTime(); // JST 2026-06-28 09:00
  const DATE = "20260628";
  const RACE_ID = "202603020211";
  const ANALYSIS = {
    id: 5,
    raceId: RACE_ID,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: DATE,
    evEstimated: false,
    model: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス" },
    horses: [{ umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.2, isPositive: true, mark: null, reason: null }],
    allocation: {
      route: "mixed", unavailableReason: null, fallbackReason: "no-combo-candidates", skipReasonCode: null, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1.1,
      includeComboOdds: true, includeWide: true, includeTrio: false, includeQuinella: null, includeExacta: true, includeTrifecta: false, includeBracketQuinella: null, betUnit: 100, oddsStatus: "result",
      bets: [{ betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 }],
    },
    detail: "present",
  };

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

  function run(initialHash = "") {
    const root = { children: [] as (FakeElement | FakeText)[], replaceChildren(...nodes: (FakeElement | FakeText)[]) { this.children = nodes; } };
    const listeners = new Map<string, (() => void)[]>();
    const calls: { url: string; init: { method?: string; credentials?: string; body?: string } }[] = [];
    const location = { hash: initialHash };
    const fetchStub = async (url: string, init: { method?: string; credentials?: string; body?: string }) => {
      calls.push({ url, init });
      if (url.startsWith("/api/races")) {
        return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, venue: "central", races: [{ race_id: "202603020211", venue_name: "福島", race_number: 11, race_name: "福島民報杯", course_type: "芝", distance: 1800, entry_count: 16, grade: null }] }) };
      }
      if (url === `/api/analyses/status?kaisai_date=${DATE}&race_id=${RACE_ID}`) {
        return { status: 200, json: async () => ({ ok: true, kaisai_date: DATE, races: [{ race_id: RACE_ID, mode: "morning", status: "done", attempts: 1, error: null, queued_at: 1, updated_at: 2, prior: true, analysis_id: null, detail: null, children_ok: null }], prior: { race_name: "福島民報杯", venue_name: "福島", date: "2026-06-28", computed_at: 5, rows: [{ rank: 1, umaban: 3, horse_name: "アルファ", prior: 0.523 }] } }) };
      }
      if (url.startsWith("/api/analyses?race_id=")) {
        return { status: 200, json: async () => ({ ok: true, analyses: [] }) };
      }
      if (url === "/api/analyses/5") {
        return { status: 200, json: async () => ({ ok: true, analysis: ANALYSIS }) };
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

  it("レース画面(#…&race=): 状態(race_id つき)と過去の分析の 2 本だけを取り、カードと朝の prior を描画する。一覧・板・分析の詳細・POST は呼ばない", async () => {
    const { root, calls } = run(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await until(() => root.children.some((c) => textOf(c).includes("アルファ")));
    expect(calls.map((c) => c.url).sort()).toEqual([`/api/analyses/status?kaisai_date=${DATE}&race_id=${RACE_ID}`, `/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE}&limit=20`].sort());
    expect(calls.filter((c) => c.init.method !== "GET")).toEqual([]);
    const text = textOf(root.children[0]!);
    expect(text).toContain("朝の準備");
    expect(text).toContain("発走前");
    expect(text).toContain("3着内率 52.3%");
  });

  it("結果画面(#analysis=): /api/analyses/{id} を 1 回だけ取り、馬のカードと配分(exe の renderer の純関数を、Node の組込みの無い環境で実行)を描画する", async () => {
    const { root, calls } = run("#analysis=5");
    await until(() => root.children.some((c) => textOf(c).includes("配分の提案")));
    expect(calls.map((c) => c.url)).toEqual(["/api/analyses/5"]);
    const text = textOf(root.children[0]!);
    expect(text).toContain("福島11R テストステークス");
    expect(text).toContain("3着内率 20.0%");
    expect(text).toContain("組合せ券種にEVプラスの候補が無かったため複勝のみの配分になっています。"); // fallbackReason が exe の注記になる
    expect(text).toContain("300円");
    expect(text).not.toContain("AI補正後");
  });
});
