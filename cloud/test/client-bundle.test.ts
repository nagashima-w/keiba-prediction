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
  "../../packages/app/src/renderer/bet-allocation-view",
  "../../packages/app/src/renderer/format",
  "../../packages/app/src/shared/analysis-types",
  // Issue #189(設定画面): ラベルと版 ID は exe の共有定数(import なしの純モジュール)、範囲の述語は cloud/src の純モジュール(サーバと同じ述語を使う)。
  "../../packages/app/src/shared/settings",
  "../src/settings",
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
    for (const good of ["./api", "../../packages/app/src/renderer/allocation-proposal-view", "../../packages/app/src/renderer/bet-allocation-view", "../../packages/app/src/renderer/format", "../../packages/app/src/shared/analysis-types", "../../packages/app/src/shared/settings", "../src/settings"]) {
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

  const SETTINGS = {
    evThreshold: 1, additionalInstruction: "", clipVariant: "default", bankroll: 500000, perRaceCap: 50000, kellyFraction: 0.5, includeComboOdds: false,
    includeWideInAllocation: true, includeTrioInAllocation: true, includeQuinellaInAllocation: true, includeExactaInAllocation: true, includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true, preRaceOffsetMinutes: 45,
  };

  class FakeText {
    constructor(readonly data: string) {}
  }
  class FakeElement {
    readonly attrs = new Map<string, string>();
    readonly children: (FakeElement | FakeText)[] = [];
    readonly listeners = new Map<string, ((event: unknown) => void)[]>();
    value = "";
    checked: boolean | undefined = undefined;
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

  /** 条件が成り立つまで、I/O の 1 巡ずつ待つ(上限つき。実時間の待ちを使わない=CI で不安定にならない)。 */
  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** 取得の後始末(マイクロタスク・I/O)を流す(上限つきの有限回)。 */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Issue #192: get-identity の応答(偽)。既定は 404(HTML が返った場合と同じく json() が失敗する)=メールアドレスのまま。 */
  type IdentityReply = { status: number; json: () => Promise<unknown> } | "network-error";
  const NOT_FOUND: IdentityReply = { status: 404, json: async () => { throw new SyntaxError("Unexpected token <"); } };

  function run(initialHash = "", identityReply: IdentityReply = NOT_FOUND) {
    const root = { children: [] as (FakeElement | FakeText)[], replaced: 0, replaceChildren(...nodes: (FakeElement | FakeText)[]) { this.replaced += 1; this.children = nodes; } };
    const listeners = new Map<string, (() => void)[]>();
    const calls: { url: string; init: { method?: string; credentials?: string; referrerPolicy?: string; body?: string } }[] = [];
    const location = { hash: initialHash };
    // Issue #192: get-identity の呼び出しは calls と別に数える(既存のテストが数える取得の本数に混ぜない)。表示の行は `.who .email`(偽の要素。textContent を持つ)。
    const identityCalls: { url: string; init: { method?: string; credentials?: string } }[] = [];
    const who = { textContent: "taro@example.com" as string | null };
    // 追跡のタイマー(偽。時間は進めない=張られた数だけを見る)と、可視状態(偽の document)。
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const documentListeners = new Map<string, (() => void)[]>();
    const doc = {
      visibilityState: "visible",
      getElementById: (id: string) => (id === "app" ? root : null),
      querySelector: (selector: string) => (selector === ".who .email" ? who : null),
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (t: string) => new FakeText(t),
      addEventListener: (type: string, fn: () => void) => void documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]),
    };
    const fetchStub = async (url: string, init: { method?: string; credentials?: string; referrerPolicy?: string; body?: string }) => {
      if (url === "/cdn-cgi/access/get-identity") {
        identityCalls.push({ url, init });
        if (identityReply === "network-error") throw new TypeError("Failed to fetch");
        return identityReply;
      }
      calls.push({ url, init });
      if (init.method === "POST" && url === "/api/analyses/run") {
        const body = JSON.parse(init.body!) as { race_id: string; kaisai_date: string; mode: string };
        return { status: 202, json: async () => ({ ok: true, accepted: true, race_id: body.race_id, kaisai_date: body.kaisai_date, mode: body.mode, status: "queued" }) };
      }
      if (url === "/api/settings") {
        // Issue #189: 設定の取得(GET)と保存(POST は受けた本文をそのまま返す)
        const settings = init.method === "POST" ? JSON.parse(init.body!) : SETTINGS;
        return { status: 200, json: async () => (init.method === "POST" ? { ok: true, settings } : { ok: true, settings, source: "d1" }) };
      }
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
      document: doc,
      setTimeout: (fn: () => void) => {
        timerId += 1;
        timers.set(timerId, fn);
        return timerId;
      },
      clearTimeout: (id: number) => void timers.delete(id),
      window: { addEventListener: (type: string, fn: () => void) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
      location,
      fetch: fetchStub,
      Date: FixedDate,
      URLSearchParams,
      Promise,
      console,
    };
    vm.runInNewContext(CLIENT_JS, context);
    return { root, listeners, calls, location, timers, doc, documentListeners, identityCalls, who };
  }

  it("Issue #192: ロード時に get-identity を 1 回だけ呼び(GET・同じオリジンの資格情報)、name を「ログイン中」の行(`.who .email`)の textContent に入れる。メールアドレスはどこにも残らない", async () => {
    const { who, identityCalls } = run("", { status: 200, json: async () => ({ name: "テスト 太郎", email: "taro@example.com" }) });
    await until(() => who.textContent !== "taro@example.com");
    expect(who.textContent).toBe("テスト 太郎");
    expect(identityCalls).toHaveLength(1);
    expect(identityCalls[0]!.init.method).toBe("GET");
    expect(identityCalls[0]!.init.credentials).toBe("same-origin");
  });

  it.each([
    ["404(HTML が返る)", NOT_FOUND],
    ["ネットワークエラー", "network-error" as const],
    ["name が空", { status: 200, json: async () => ({ name: "" }) }],
    ["name が無い", { status: 200, json: async () => ({ email: "taro@example.com" }) }],
  ] as [string, IdentityReply][])("Issue #192: get-identity が %s のときは、メールアドレスのまま(例外にならず、画面の描画も続く)", async (_label, reply) => {
    const { who, identityCalls, root, calls } = run("", reply);
    await until(() => identityCalls.length >= 1 && calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    await settle();
    expect(identityCalls).toHaveLength(1); // 前提: 呼ばれた(呼ばれていなければ、メールのままは自明)
    expect(who.textContent).toBe("taro@example.com");
    expect(root.children.some((c) => textOf(c).includes("福島民報杯"))).toBe(true);
  });

  it("Issue #192: ハッシュの遷移・「更新」・設定画面への遷移でも、get-identity は呼ばれない(1 回だけ)", async () => {
    const { listeners, location, identityCalls, calls, root } = run("", { status: 200, json: async () => ({ name: "テスト 太郎" }) });
    await until(() => calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    await settle();
    expect(identityCalls).toHaveLength(1);
    location.hash = "#settings";
    listeners.get("hashchange")![0]!();
    await settle();
    location.hash = "";
    listeners.get("hashchange")![0]!();
    await settle();
    expect(identityCalls).toHaveLength(1);
  });

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

  it("同じ状態の再描画(同じハッシュの hashchange)では DOM を触らない(Issue #186 段階1。createMounter が main.ts に配線されている)", async () => {
    const { root, listeners, calls } = run();
    await until(() => calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    await settle(); // 取得の後始末の再描画を待つ
    const settled = root.replaced;
    const shown = root.children[0];
    expect(settled).toBeGreaterThanOrEqual(1);
    expect((listeners.get("hashchange") ?? []).length).toBe(1); // 前提: hashchange を購読している
    listeners.get("hashchange")![0]!();
    listeners.get("hashchange")![0]!();
    expect(root.replaced).toBe(settled);
    expect(root.children[0]).toBe(shown);
  });

  it("「更新」を連打しても、取得は 1 回分(一覧と板で 2 本)だけ増える。起動のボタンを押さない限り POST は呼ばれない", async () => {
    const { root, calls } = run();
    await until(() => calls.length >= 2 && root.children.some((c) => textOf(c).includes("福島民報杯")));
    const before = calls.length;
    const refresh = flat(root.children[0]!).find((n): n is FakeElement => n instanceof FakeElement && n.tag === "button")!;
    const click = refresh.listeners.get("click")![0]!;
    click(undefined);
    click(undefined);
    click(undefined);
    await until(() => calls.length >= before + 2);
    await settle();
    expect(calls.length).toBe(before + 2);
    expect(calls.filter((c) => c.init.method !== "GET")).toEqual([]);
  });

  it("Issue #189: 設定画面(#settings): GET /api/settings だけを取り、14 個の入力欄(textarea・select・checkbox を含む)を描画する。入力して保存すると、DOM のイベントの値が 14 項目の POST になる(一覧・板は取らない)", async () => {
    const { root, calls } = run("#settings");
    await until(() => root.children.some((c) => flat(c).some((n) => n instanceof FakeElement && n.attrs.has("data-field"))));
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(["GET /api/settings"]);
    const fields = flat(root.children[0]!).filter((n): n is FakeElement => n instanceof FakeElement && n.attrs.has("data-field"));
    expect(fields.length).toBe(14);
    expect(fields.map((n) => n.tag).sort()).toEqual([...Array(7).fill("input"), "input", "input", "input", "input", "input", "select", "textarea"].sort());
    const field = (key: string) => fields.find((n) => n.attrs.get("data-field") === key)!;
    expect(field("bankroll").value).toBe("500000");
    expect(field("clipVariant").value).toBe("default"); // select は option を入れたあとに value が設定される
    expect(field("includeWideInAllocation").checked).toBe(true);
    expect(field("includeComboOdds").checked).toBeFalsy();
    field("bankroll").listeners.get("change")![0]!({ target: { value: "123456" } });
    field("includeComboOdds").listeners.get("change")![0]!({ target: { value: "on", checked: true } });
    const save = flat(root.children[0]!).find((n): n is FakeElement => n instanceof FakeElement && n.attrs.get("class") === "settings-save")!;
    save.listeners.get("click")![0]!(undefined);
    await until(() => calls.some((c) => c.init.method === "POST"));
    const post = calls.find((c) => c.init.method === "POST")!;
    expect(post.url).toBe("/api/settings");
    expect(post.init.referrerPolicy).toBe("same-origin");
    expect(JSON.parse(post.init.body!)).toEqual({ ...SETTINGS, bankroll: 123456, includeComboOdds: true });
    await until(() => root.children.some((c) => textOf(c).includes("保存しました")));
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

  it("起動のボタン(生成物の実行): 押すと POST が 1 回(同じオリジンの資格情報・referrerPolicy: same-origin・fetch の mode なし)出て、「待ち」になり、追跡のタイマーが張られる。非表示でタイマーが止まる", async () => {
    const { root, calls, timers, doc, documentListeners } = run(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await until(() => root.children.some((c) => textOf(c).includes("アルファ")));
    expect((documentListeners.get("visibilitychange") ?? []).length).toBe(1); // 可視状態を購読している
    expect(calls.filter((c) => c.init.method === "POST")).toHaveLength(0); // 前提: 押すまで POST は無い
    expect(timers.size).toBe(0); // 前提: 実行中の行が無いので追跡していない
    const buttons = flat(root.children[0]!).filter((n): n is FakeElement => n instanceof FakeElement && n.tag === "button" && n.attrs.get("data-mode") === "pre_race");
    expect(buttons).toHaveLength(1);
    expect(textOf(buttons[0]!)).toBe("発走前の分析を実行");
    expect(buttons[0]!.attrs.get("data-race")).toBe(RACE_ID);
    buttons[0]!.listeners.get("click")![0]!(undefined);
    buttons[0]!.listeners.get("click")![0]!(undefined); // 二重押し
    await until(() => calls.some((c) => c.init.method === "POST"));
    await settle();
    const posts = calls.filter((c) => c.init.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/analyses/run");
    expect(JSON.parse(posts[0]!.init.body!)).toEqual({ race_id: RACE_ID, kaisai_date: DATE, mode: "pre_race" });
    expect(posts[0]!.init.credentials).toBe("same-origin");
    expect(posts[0]!.init.referrerPolicy).toBe("same-origin");
    expect(Object.keys(posts[0]!.init)).not.toContain("mode"); // fetch の mode は入れない
    const after = flat(root.children[0]!).filter((n): n is FakeElement => n instanceof FakeElement && n.tag === "button" && n.attrs.get("data-mode") === "pre_race")[0]!;
    expect(textOf(after)).toBe("待ち");
    expect(timers.size).toBe(1); // 追跡のタイマー
    doc.visibilityState = "hidden";
    documentListeners.get("visibilitychange")![0]!();
    expect(timers.size).toBe(0); // 非表示で止まる
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
