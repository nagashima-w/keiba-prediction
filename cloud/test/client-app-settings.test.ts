import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { VNode } from "../client/vnode";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { createMounter, type DomDocument } from "../client/dom";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #189(段階2): 設定画面(`#settings`)の制御。偽の fetch・偽のハッシュ・描画の記録(描画した回数と force の印)。
 * 守ること:
 *  - 設定画面は `GET /api/settings` だけを取る(一覧・板・レース・分析を取らない。netkeiba・DO・R2 に出ない)。失敗は自動で再試行しない(「再読込」だけ)
 *  - **入力の change は下書きを書くだけで、再描画しない**(入力中の欄・フォーカスを壊さない)。保存・再読込・失敗の直後は、強制的に再描画する(木が同じでも DOM を下書きに戻す)
 *  - 保存は、保存の押下時に検証(エラーは項目ごと・POST しない)→ POST。保存中は二重に送らず、入力を受けない。失敗しても入力は残る
 *  - 画面を離れたら下書きを破棄する。遅れて届いた応答(離れる前に出した取得・保存)は、今の画面に反映しない
 */

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
const SERVER: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 500_000, perRaceCap: 50_000, includeComboOdds: true, preRaceOffsetMinutes: 90 };

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
/** 保留中の非同期の後始末だけを流す(有限回)。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));

interface Harness {
  readonly app: App;
  /** "METHOD url" の記録。 */
  readonly calls: string[];
  readonly posts: Record<string, unknown>[];
  /** 描画の記録: 木と force の印。 */
  readonly renders: { tree: VNode; force: boolean }[];
  getResponder: () => Promise<Resp>;
  postResponder: (body: Record<string, unknown>) => Promise<Resp>;
  hash: string;
  tree(): VNode;
  field(key: string): VNode;
  go(hash: string): void;
  /** 入力欄に値を入れる(ブラウザの change イベント相当)。描画はしない。 */
  type(key: string, value: string): void;
  /** 入力欄に値を打つ(ブラウザの input イベント相当。change は起きない=フォーカスがあるまま保存を押した状況)。描画はしない。 */
  typeInput(key: string, value: string): void;
  clickSave(): void;
  clickRefresh(): void;
}

function harness(initialHash: string): Harness {
  const calls: string[] = [];
  const posts: Record<string, unknown>[] = [];
  const renders: { tree: VNode; force: boolean }[] = [];
  const fetchLike: FetchLike = (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url === "/api/settings" && init.method === "GET") return h.getResponder();
    if (url === "/api/settings" && init.method === "POST") {
      const body = JSON.parse(init.body!) as Record<string, unknown>;
      posts.push(body);
      return h.postResponder(body);
    }
    throw new Error(`想定外の取得: ${init.method} ${url}`);
  };
  const h: Harness = {
    hash: initialHash,
    calls,
    posts,
    renders,
    getResponder: async () => ok({ ok: true, settings: SERVER, source: "d1" }),
    postResponder: async (body) => ok({ ok: true, settings: body }),
    tree: () => renders[renders.length - 1]!.tree,
    field: (key) => {
      const found = findAll(h.tree(), (n) => n.attrs?.["data-field"] === key);
      expect(found.length, `入力欄 ${key}`).toBe(1);
      return found[0]!;
    },
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
    type: (key, value) => h.field(key).on!.change!(value),
    typeInput: (key, value) => h.field(key).on!.input!(value),
    clickSave: () => byClass(h.tree(), "settings-save")[0]!.on!.click!(),
    clickRefresh: () => byClass(h.tree(), "refresh")[0]!.on!.click!(),
    app: undefined as never,
  };
  (h as { app: App }).app = createApp({
    fetch: fetchLike,
    now: () => new Date("2026-06-28T00:00:00Z"),
    render: (tree, force) => void renders.push({ tree, force: force === true }),
    getHash: () => h.hash,
    setHash: () => {},
    timers: { set: () => 0, clear: () => {} },
    isVisible: () => true,
  });
  return h;
}

async function started(over: Partial<Pick<Harness, "getResponder" | "postResponder">> = {}): Promise<Harness> {
  const h = harness("#settings");
  Object.assign(h, over);
  h.app.start();
  await h.app.whenIdle();
  return h;
}

describe("設定画面を開く", () => {
  it("#settings で始めると、GET /api/settings を 1 回だけ取る。一覧・板・レース・分析は取らない(偽の fetch は想定外の取得で投げる)。最初の描画は「読み込み中…」", async () => {
    const h = harness("#settings");
    const gate = deferred<Resp>();
    h.getResponder = () => gate.promise;
    h.app.start();
    expect(h.calls).toEqual(["GET /api/settings"]);
    expect(textOf(h.tree())).toContain("読み込み中…");
    expect(findAll(h.tree(), (n) => n.attrs?.["data-field"] !== undefined)).toEqual([]);
    gate.resolve(ok({ ok: true, settings: SERVER, source: "d1" }));
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/settings"]);
  });

  it("取得できたら、サーバの値で 14 個の入力欄を出す。source: default なら「まだ保存されていません」の注記", async () => {
    const h = await started();
    expect(findAll(h.tree(), (n) => n.attrs?.["data-field"] !== undefined).length).toBe(14);
    expect(h.field("bankroll").attrs?.["value"]).toBe("500000");
    expect(h.field("includeComboOdds").attrs?.["checked"]).toBe(true);
    expect(h.field("preRaceOffsetMinutes").attrs?.["value"]).toBe("90");
    expect(textOf(h.tree())).not.toContain("まだ保存されていません");
    const d = await started({ getResponder: async () => ok({ ok: true, settings: DEFAULT_CLOUD_SETTINGS, source: "default" }) });
    expect(textOf(d.tree())).toContain("まだ保存されていません");
    const i = await started({ getResponder: async () => ok({ ok: true, settings: DEFAULT_CLOUD_SETTINGS, source: "invalid" }) });
    expect(textOf(i.tree())).toContain("保存済みの設定が読めない");
  });

  it("取得に失敗したら、固定の文言を出し、入力欄・保存ボタンは出さない。自動で再試行しない(取得は 1 回のまま)。「再読込」で取り直し、成功すれば入力欄が出る", async () => {
    let attempt = 0;
    const h = await started({ getResponder: async () => (attempt++ === 0 ? { status: 503, json: async () => ({ ok: false, error: { type: "d1-error", message: "秘密" } }) } : ok({ ok: true, settings: SERVER, source: "d1" })) });
    expect(textOf(h.tree())).toContain("設定を取得できませんでした");
    expect(textOf(h.tree())).not.toContain("秘密");
    expect(findAll(h.tree(), (n) => n.attrs?.["data-field"] !== undefined)).toEqual([]);
    expect(byClass(h.tree(), "settings-save")).toEqual([]);
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/settings"]); // 自動で再試行しない
    h.clickRefresh();
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/settings", "GET /api/settings"]);
    expect(h.field("bankroll").attrs?.["value"]).toBe("500000");
  });

  it("想定外の応答(キーが足りない)は、想定外として扱う(一部の項目だけ採用しない)", async () => {
    const { bankroll: _omit, ...partial } = SERVER;
    const h = await started({ getResponder: async () => ok({ ok: true, settings: partial, source: "d1" }) });
    expect(textOf(h.tree())).toContain("想定外");
    expect(findAll(h.tree(), (n) => n.attrs?.["data-field"] !== undefined)).toEqual([]);
  });

  it("取得中の「再読込」は無視する(同じものを同時に 2 本取らない)", async () => {
    const h = harness("#settings");
    const gate = deferred<Resp>();
    h.getResponder = () => gate.promise;
    h.app.start();
    h.clickRefresh();
    h.clickRefresh();
    expect(h.calls).toEqual(["GET /api/settings"]);
    gate.resolve(ok({ ok: true, settings: SERVER, source: "d1" }));
    await h.app.whenIdle();
    expect(h.calls.length).toBe(1);
  });

  it("一覧から #settings へ移っても、設定画面は一覧・板を取らない。一覧へ戻っても、一覧は取り直さない(キャッシュ)", async () => {
    // 一覧の取得も答える偽の fetch
    const calls: string[] = [];
    let hash = "";
    let latest: VNode | null = null;
    const app = createApp({
      fetch: async (url, init) => {
        calls.push(`${init.method} ${url}`);
        if (url.startsWith("/api/races")) return ok({ ok: true, kaisai_date: "20260628", venue: "central", races: [] });
        if (url.startsWith("/api/analyses/status")) return ok({ ok: true, kaisai_date: "20260628", races: [] });
        if (url === "/api/settings") return ok({ ok: true, settings: SERVER, source: "d1" });
        throw new Error(`想定外の取得: ${url}`);
      },
      now: () => new Date("2026-06-28T00:00:00Z"),
      render: (t) => {
        latest = t;
      },
      getHash: () => hash,
      setHash: () => {},
      timers: { set: () => 0, clear: () => {} },
      isVisible: () => true,
    });
    app.start();
    await app.whenIdle();
    const listCalls = [...calls];
    expect(listCalls.length).toBe(2);
    expect(byClass(latest!, "settings-link")[0]!.attrs?.["href"]).toBe("#settings"); // トップの入口
    hash = "#settings";
    app.onHashChange();
    await app.whenIdle();
    expect(calls.slice(listCalls.length)).toEqual(["GET /api/settings"]);
    hash = "#";
    app.onHashChange();
    await app.whenIdle();
    expect(calls.length).toBe(listCalls.length + 1); // 一覧・板は取り直さない
  });
});

describe("入力と描画(change は下書きを書くだけ)", () => {
  it("入力欄の change は、再描画しない(描画の回数が増えない)。下書きは保存の POST に反映される", async () => {
    const h = await started();
    const before = h.renders.length;
    h.type("bankroll", "123456");
    h.type("includeComboOdds", "false");
    h.type("additionalInstruction", "追加\n指示");
    h.type("clipVariant", "wide15");
    expect(h.renders.length).toBe(before);
    h.clickSave();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ bankroll: 123456, includeComboOdds: false, additionalInstruction: "追加\n指示", clipVariant: "wide15", perRaceCap: 50_000 });
    await h.app.whenIdle();
  });

  it("input イベントだけ(change なし。フォーカスがあるまま保存をタップして、click が change より先に届いた状況)で保存しても、入力した値が POST の本文に入る。再描画はしない(入力中の欄を壊さない)", async () => {
    const h = await started();
    const before = h.renders.length;
    h.typeInput("bankroll", "777000");
    h.typeInput("additionalInstruction", "打ちかけの指示");
    h.typeInput("kellyFraction", "0.3");
    expect(h.renders.length).toBe(before);
    h.clickSave(); // change は 1 度も起きていない
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ bankroll: 777_000, additionalInstruction: "打ちかけの指示", kellyFraction: 0.3, perRaceCap: 50_000 });
    await h.app.whenIdle();
    expect(h.field("bankroll").attrs?.["value"]).toBe("777000"); // 保存後の表示も、打った値(サーバが返した値)
  });

  it("保存の押下: 検証 OK なら、全 14 項目(数値は数値型)を 1 回 POST する。保存中は強制の再描画で、入力欄・保存ボタンが disabled", async () => {
    const gate = deferred<Resp>();
    const h = await started({ postResponder: () => gate.promise });
    const before = h.renders.length;
    h.clickSave();
    expect(h.posts).toHaveLength(1);
    expect(Object.keys(h.posts[0]!).length).toBe(14);
    expect(h.posts[0]!["bankroll"]).toBe(500_000);
    expect(typeof h.posts[0]!["kellyFraction"]).toBe("number");
    expect(h.renders.length).toBe(before + 1);
    expect(h.renders[before]!.force).toBe(true);
    expect(byClass(h.tree(), "settings-save")[0]!.attrs?.["disabled"]).toBe(true);
    expect(findAll(h.tree(), (n) => n.attrs?.["data-field"] !== undefined).every((n) => n.attrs?.["disabled"] === true)).toBe(true);
    gate.resolve(ok({ ok: true, settings: SERVER }));
    await h.app.whenIdle();
  });

  it("保存の成功: 保存した設定(サーバが返した値)で入力欄を戻し、「保存しました」を出す。強制の再描画", async () => {
    const h = await started({ postResponder: async (body) => ok({ ok: true, settings: { ...body, bankroll: 777 } }) });
    h.type("bankroll", "1000");
    h.clickSave();
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("保存しました");
    expect(h.field("bankroll").attrs?.["value"]).toBe("777"); // サーバの値が真実
    expect(byClass(h.tree(), "settings-save")[0]!.attrs?.["disabled"]).toBeFalsy();
    expect(h.renders[h.renders.length - 1]!.force).toBe(true);
  });

  it("検証エラー: 不正な入力(資金 abc・発走 5)は、POST せず、項目ごとにエラーを出す。強制の再描画。直して保存すると、エラーは消えて POST される", async () => {
    const h = await started();
    h.type("bankroll", "abc");
    h.type("preRaceOffsetMinutes", "5");
    const before = h.renders.length;
    h.clickSave();
    expect(h.posts).toEqual([]);
    expect(h.renders.length).toBe(before + 1);
    expect(h.renders[before]!.force).toBe(true);
    const alerts = findAll(h.tree(), (n) => n.attrs?.["role"] === "alert").map(textOf);
    expect(alerts.length).toBe(2);
    expect(alerts.join("")).toContain("100,000,000");
    expect(alerts.join("")).toContain("180");
    expect(h.field("bankroll").attrs?.["aria-invalid"]).toBe("true");
    expect(h.field("bankroll").attrs?.["value"]).toBe("abc"); // 入力は残る
    expect(h.field("evThreshold").attrs?.["aria-invalid"]).toBeUndefined();
    h.type("bankroll", "1000");
    h.type("preRaceOffsetMinutes", "60");
    h.clickSave();
    expect(h.posts).toHaveLength(1);
    await h.app.whenIdle();
    expect(findAll(h.tree(), (n) => n.attrs?.["role"] === "alert")).toEqual([]);
  });

  it("保存の失敗(サーバ 503): 固定の文言(入力が残っていることを示す)を role=alert で出し、入力欄は編集した値のまま。強制の再描画。もう一度保存できる", async () => {
    let fail = true;
    const h = await started({ postResponder: async (body) => (fail ? { status: 503, json: async () => ({ ok: false, error: { type: "d1-error" } }) } : ok({ ok: true, settings: body })) });
    h.type("bankroll", "4321");
    h.clickSave();
    await h.app.whenIdle();
    expect(findAll(h.tree(), (n) => n.attrs?.["role"] === "alert").map(textOf).join("")).toContain("入力した内容は残っています");
    expect(h.field("bankroll").attrs?.["value"]).toBe("4321");
    expect(h.renders[h.renders.length - 1]!.force).toBe(true);
    expect(byClass(h.tree(), "settings-save")[0]!.attrs?.["disabled"]).toBeFalsy();
    fail = false;
    h.clickSave();
    await h.app.whenIdle();
    expect(h.posts).toHaveLength(2);
    expect(textOf(h.tree())).toContain("保存しました");
  });

  it("保存中の二重押し・保存中の入力・保存中の再読込は無視する(POST は 1 回・下書きは変わらない・取得は増えない)", async () => {
    const gate = deferred<Resp>();
    const h = await started({ postResponder: () => gate.promise });
    h.type("bankroll", "2000");
    h.clickSave();
    h.clickSave();
    h.clickSave();
    expect(h.posts).toHaveLength(1);
    h.type("bankroll", "9999"); // 保存中の入力(無視)
    h.clickRefresh();
    expect(h.calls.filter((c) => c === "GET /api/settings")).toHaveLength(1);
    gate.resolve(ok({ ok: true, settings: { ...SERVER, bankroll: 2000 } }));
    await h.app.whenIdle();
    expect(h.field("bankroll").attrs?.["value"]).toBe("2000");
  });

  it("「再読込」は未保存の入力を捨てて、サーバの値を取り直す(強制の再描画)。保存の通知・検証エラーも消える", async () => {
    const h = await started();
    h.type("bankroll", "abc");
    h.clickSave(); // 検証エラー
    expect(findAll(h.tree(), (n) => n.attrs?.["role"] === "alert").length).toBe(1);
    h.clickRefresh();
    await h.app.whenIdle();
    expect(h.calls.filter((c) => c === "GET /api/settings")).toHaveLength(2);
    expect(h.field("bankroll").attrs?.["value"]).toBe("500000");
    expect(findAll(h.tree(), (n) => n.attrs?.["role"] === "alert")).toEqual([]);
    expect(h.renders[h.renders.length - 1]!.force).toBe(true);
  });
});

describe("画面を離れる(下書きの破棄と、遅れて届いた応答)", () => {
  it("離れて戻ると、未保存の入力は捨てられ、サーバの値を取り直す(GET が増える)", async () => {
    const h = await started();
    h.type("bankroll", "1");
    h.go("#date=20260628&venue=central");
    h.go("#settings");
    await h.app.whenIdle();
    expect(h.calls.filter((c) => c === "GET /api/settings")).toHaveLength(2);
    expect(h.field("bankroll").attrs?.["value"]).toBe("500000");
  });

  it("取得中に離れて戻った場合、先に出した取得の応答は捨て、後の取得の応答で表示する(古い応答が上書きしない)", async () => {
    const h = harness("#settings");
    const first = deferred<Resp>();
    const second = deferred<Resp>();
    const queue = [first, second];
    h.getResponder = () => queue.shift()!.promise;
    // 離れた先(一覧)は取得に答えられないので、離れた先が取得を起こさないよう、ハッシュは「日付だけ」の一覧ではなく結果画面にして偽の取得を答える
    h.app.start();
    h.go("#analysis=5");
    h.go("#settings");
    first.resolve(ok({ ok: true, settings: { ...SERVER, bankroll: 111 }, source: "d1" }));
    second.resolve(ok({ ok: true, settings: { ...SERVER, bankroll: 222 }, source: "d1" }));
    await h.app.whenIdle();
    expect(h.field("bankroll").attrs?.["value"]).toBe("222");
  });

  it("保存中に離れた場合、あとから届いた保存の応答は、戻った画面に反映しない(戻ると、取り直したサーバの値と、保存の通知なし)", async () => {
    const gate = deferred<Resp>();
    const h = await started({ postResponder: () => gate.promise });
    h.type("bankroll", "5");
    h.clickSave();
    h.go("#analysis=5");
    h.go("#settings");
    // 保存の応答はまだ保留(whenIdle は保留中の保存を待つので、ここでは使わず、後始末だけ流す)
    await flush();
    expect(h.field("bankroll").attrs?.["value"]).toBe("500000"); // 戻った画面は、取り直したサーバの値
    const rendersBefore = h.renders.length;
    gate.resolve(ok({ ok: true, settings: { ...SERVER, bankroll: 5 } }));
    await h.app.whenIdle();
    await flush();
    expect(h.renders.length).toBe(rendersBefore); // 古い保存の応答は、描画を起こさない
    expect(h.field("bankroll").attrs?.["value"]).toBe("500000");
    expect(textOf(h.tree())).not.toContain("保存しました");
  });
});

/**
 * 追跡(ポーリング)が動いている間も、設定画面で打っている欄を壊さない(Issue #189。`input` でも下書きを書くようにしたことの副作用の是正)。
 * 追跡の周期・完了の検知などが呼ぶ**強制なしの `render()`** は、設定画面では「最後に強制描画したときの内容(画面に出ている内容)」から木を作る
 * =下書きの最新値は、次の強制描画(保存・再読込・取得完了・検証エラー・失敗)まで木に反映しない。木が同じなら `createMounter` は DOM を置き換えない(フォーカス・キーボードが保たれる)。
 */
describe("追跡のポーリング中も、打っている欄を壊さない", () => {
  class FakeNode {
    readonly children: FakeNode[] = [];
    value = "";
    checked = false;
    constructor(readonly tag: string) {}
    setAttribute(): void {}
    appendChild(child: FakeNode): void {
      this.children.push(child);
    }
    addEventListener(): void {}
  }
  const doc: DomDocument = { createElement: (tag) => new FakeNode(tag), createTextNode: () => new FakeNode("#text") };

  async function trackedHarness() {
    const timers = createFakeTimers();
    const calls: string[] = [];
    const posts: Record<string, unknown>[] = [];
    const root = { replaced: 0, replaceChildren(): void { this.replaced += 1; } };
    const mount = createMounter(doc, root);
    let latest: VNode | null = null;
    let renderCalls = 0;
    let hash = "";
    const board = { ok: true, kaisai_date: "20260628", races: [{ race_id: "202603020211", mode: "morning", status: "queued", attempts: 0, error: null, queued_at: 1, updated_at: 2, prior: false, analysis_id: null, detail: null, children_ok: null }] };
    const app = createApp({
      fetch: async (url, init) => {
        calls.push(`${init.method} ${url}`);
        if (url.startsWith("/api/races")) return ok({ ok: true, kaisai_date: "20260628", venue: "central", races: [] });
        if (url.startsWith("/api/analyses/status")) return ok(board); // いつまでも実行中(追跡が続く)
        if (url === "/api/settings" && init.method === "GET") return ok({ ok: true, settings: SERVER, source: "d1" });
        if (url === "/api/settings" && init.method === "POST") {
          const body = JSON.parse(init.body!) as Record<string, unknown>;
          posts.push(body);
          return ok({ ok: true, settings: body });
        }
        throw new Error(`想定外の取得: ${url}`);
      },
      now: () => new Date("2026-06-28T00:00:00Z"),
      render: (tree, force) => {
        renderCalls += 1;
        latest = tree;
        mount(tree, force === true);
      },
      getHash: () => hash,
      setHash: () => {},
      timers: { set: (fn, ms) => timers.set(fn, ms), clear: (handle) => timers.clear(handle) },
      isVisible: () => true,
    });
    app.start();
    await app.whenIdle();
    return {
      app,
      timers,
      calls,
      posts,
      root,
      tree: () => latest!,
      renderCalls: () => renderCalls,
      go: (next: string) => {
        hash = next;
        app.onHashChange();
      },
    };
  }

  it("一覧で追跡が動いている状態で #settings に移り、input で打っても、ポーリングの周期の再描画は DOM を置き換えない(木が変わらない)。その後に保存すると、打った値が POST に入る", async () => {
    const t = await trackedHarness();
    expect(t.timers.pending(), "前提: 追跡のタイマーが張られている").toBe(1);
    t.go("#settings");
    await t.app.whenIdle();
    const field = (key: string): VNode => findAll(t.tree(), (n) => n.attrs?.["data-field"] === key)[0]!;
    expect(field("bankroll").attrs?.["value"]).toBe("500000"); // 前提: 設定画面が出ている
    const polls = (): number => t.calls.filter((c) => c === "GET /api/analyses/status?kaisai_date=20260628").length;
    const pollsBefore = polls();
    const treeBefore = JSON.stringify(t.tree());
    const replacedBefore = t.root.replaced;
    const rendersBefore = t.renderCalls();

    field("bankroll").on!.input!("999000");
    field("additionalInstruction").on!.input!("打っている途中");
    await t.timers.advance(20_000); // ポーリングの周期を何度か進める(3 秒 × 10 回の最初の数回)

    expect(polls(), "前提: ポーリングが実際に走った").toBeGreaterThanOrEqual(pollsBefore + 3);
    expect(t.renderCalls(), "前提: 強制なしの再描画が実際に呼ばれた(空振りでない)").toBeGreaterThan(rendersBefore);
    expect(JSON.stringify(t.tree()), "画面に出ている内容(最後の強制描画時の下書き)から作るので、木は変わらない").toBe(treeBefore);
    expect(t.root.replaced, "DOM を置き換えない(打っている欄がフォーカスを失わない)").toBe(replacedBefore);

    findAll(t.tree(), (n) => String(n.attrs?.["class"] ?? "") === "settings-save")[0]!.on!.click!();
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]).toMatchObject({ bankroll: 999_000, additionalInstruction: "打っている途中" }); // 木に反映しなくても、下書きは最新
    await t.app.whenIdle();
  });

  it("画面に入った直後の描画・取得完了の強制描画では、画面に出す内容が正しく作られる(読み込み中 → 取得した設定の値)。再読込のあとは、下書きを捨てた内容", async () => {
    const t = await trackedHarness();
    t.go("#settings");
    // 入った直後(取得中)の描画は「読み込み中…」
    await t.app.whenIdle();
    expect(findAll(t.tree(), (n) => n.attrs?.["data-field"] === "bankroll")[0]!.attrs?.["value"]).toBe("500000");
    const field = (key: string): VNode => findAll(t.tree(), (n) => n.attrs?.["data-field"] === key)[0]!;
    field("bankroll").on!.input!("1");
    await t.timers.advance(10_000); // 追跡の再描画では、画面は変わらない
    expect(field("bankroll").attrs?.["value"]).toBe("500000");
    findAll(t.tree(), (n) => String(n.attrs?.["class"] ?? "").split(" ").includes("refresh"))[0]!.on!.click!(); // 再読込: 下書きを捨てて取り直す(強制描画)
    await t.app.whenIdle();
    expect(field("bankroll").attrs?.["value"]).toBe("500000");
    // 離れて戻ると、入った直後は取得中の表示
    t.go("#date=20260628&venue=central");
    t.go("#settings");
    expect(JSON.stringify(t.tree())).toContain("読み込み中…");
    await t.app.whenIdle();
    expect(field("bankroll").attrs?.["value"]).toBe("500000");
  });

  it("Issue #201: プレビューを開いたまま追跡のポーリングが動いても、文面は変わらず、DOM を置き換えない(打った追加指示は「入力中の内容を反映」を押すまで文面に出ない)", async () => {
    const t = await trackedHarness();
    t.go("#settings");
    await t.app.whenIdle();
    const field = (key: string): VNode => findAll(t.tree(), (n) => n.attrs?.["data-field"] === key)[0]!;
    const previewOf = (): string => String(findAll(t.tree(), (n) => String(n.attrs?.["class"] ?? "") === "prompt-preview")[0]!.children![0]);
    findAll(t.tree(), (n) => String(n.attrs?.["class"] ?? "") === "preview-toggle")[0]!.on!.click!();
    const opened = previewOf();
    expect(opened, "前提: 開いている").toContain("サンプルレース");
    const treeBefore = JSON.stringify(t.tree());
    const replacedBefore = t.root.replaced;
    const rendersBefore = t.renderCalls();
    field("additionalInstruction").on!.input!("ポーリング中に打った指示");
    await t.timers.advance(20_000);
    expect(t.renderCalls(), "前提: 強制なしの再描画が実際に呼ばれた(空振りでない)").toBeGreaterThan(rendersBefore);
    expect(previewOf()).toBe(opened);
    expect(previewOf()).not.toContain("ポーリング中に打った指示");
    expect(JSON.stringify(t.tree())).toBe(treeBefore);
    expect(t.root.replaced, "DOM を置き換えない").toBe(replacedBefore);
    findAll(t.tree(), (n) => String(n.attrs?.["class"] ?? "") === "preview-refresh")[0]!.on!.click!();
    expect(previewOf()).toContain("ポーリング中に打った指示");
  });

  it("検証エラー・保存の失敗の直後は強制描画なので、そのとき初めて最新の下書きが木に出る(エラーのある入力が画面に残る)", async () => {
    const t = await trackedHarness();
    t.go("#settings");
    await t.app.whenIdle();
    const field = (key: string): VNode => findAll(t.tree(), (n) => n.attrs?.["data-field"] === key)[0]!;
    field("bankroll").on!.input!("abc");
    expect(field("bankroll").attrs?.["value"]).toBe("500000"); // 打っている途中は木に出さない
    findAll(t.tree(), (n) => String(n.attrs?.["class"] ?? "") === "settings-save")[0]!.on!.click!();
    expect(t.posts).toEqual([]);
    expect(field("bankroll").attrs?.["value"]).toBe("abc"); // 検証エラーの強制描画で、最新の下書きが出る
    expect(field("bankroll").attrs?.["aria-invalid"]).toBe("true");
  });
});

/**
 * Issue #201: プロンプトのプレビュー。開閉・反映は**ネットワークに出ない**(`GET /api/settings` 以外の取得を起こさない。偽の fetch は想定外の取得で投げる)。
 * 入力のたびには再描画しない(#189 の設計)ので、プレビューの文面が入力に追いつくのは「入力中の内容を反映」(と、保存・再読込などの強制描画)を押した時点。
 * **押したときは `render(true)` で、写し(`settingsShown`)を現在の下書きへ更新してから描く**(強制なしで描くと、古い写しで入力欄が作り直され、打った文字が消える)。
 */
describe("Issue #201: プロンプトのプレビュー(開閉・入力の反映)", () => {
  const toggleOf = (h: Harness): VNode => byClass(h.tree(), "preview-toggle")[0]!;
  const refreshOf = (h: Harness): VNode | undefined => byClass(h.tree(), "preview-refresh")[0];
  const previewText = (h: Harness): string | null => {
    const node = byClass(h.tree(), "prompt-preview")[0];
    return node === undefined ? null : String(node.children![0]);
  };

  it("画面に入った直後は閉じている(文面なし)。開くと強制描画で文面が出る。取得は増えない。閉じると文面は消える", async () => {
    const h = await started();
    expect(previewText(h)).toBeNull();
    expect(toggleOf(h).attrs?.["aria-expanded"]).toBe("false");
    const calls = [...h.calls];
    const before = h.renders.length;
    toggleOf(h).on!.click!();
    expect(h.renders.length).toBe(before + 1);
    expect(h.renders[before]!.force).toBe(true);
    expect(toggleOf(h).attrs?.["aria-expanded"]).toBe("true");
    expect(previewText(h)).toContain("サンプルレース");
    expect(h.calls).toEqual(calls); // ネットワークに出ない
    toggleOf(h).on!.click!();
    expect(h.renders[h.renders.length - 1]!.force).toBe(true);
    expect(previewText(h)).toBeNull();
    expect(toggleOf(h).attrs?.["aria-expanded"]).toBe("false");
    expect(h.calls).toEqual(calls);
  });

  it("開いた文面は、保存済み(サーバ)の追加指示・クリップ幅ではなく、その時点の下書きから作る", async () => {
    const h = await started();
    h.type("additionalInstruction", "未保存の指示");
    h.type("clipVariant", "wide15");
    toggleOf(h).on!.click!();
    expect(previewText(h)).toContain("未保存の指示");
    expect(previewText(h)).toContain("±15%(絶対値0.15)");
    expect(h.field("additionalInstruction").attrs?.["value"]).toBe("未保存の指示"); // 入力欄の打った文字は消えない
    expect(h.field("clipVariant").attrs?.["value"]).toBe("wide15");
  });

  it("開いたあとの入力は、再描画もプレビューの更新もしない。「入力中の内容を反映」で、強制描画して文面が入力に追いつく(入力欄は下書きのまま)", async () => {
    const h = await started();
    toggleOf(h).on!.click!();
    const opened = previewText(h)!;
    expect(opened).not.toContain("あとから打った指示");
    const before = h.renders.length;
    h.typeInput("additionalInstruction", "あとから打った指示");
    h.type("clipVariant", "wide15");
    expect(h.renders.length).toBe(before); // 再描画しない
    expect(previewText(h)).toBe(opened); // 文面もそのまま
    expect(refreshOf(h)).toBeDefined();
    refreshOf(h)!.on!.click!();
    expect(h.renders.length).toBe(before + 1);
    expect(h.renders[before]!.force).toBe(true);
    expect(previewText(h)).not.toBe(opened); // 前提: 変わった
    expect(previewText(h)).toContain("あとから打った指示");
    expect(previewText(h)).toContain("±15%(絶対値0.15)");
    expect(h.field("additionalInstruction").attrs?.["value"]).toBe("あとから打った指示");
    expect(h.field("clipVariant").attrs?.["value"]).toBe("wide15");
    expect(h.calls.filter((c) => c !== "GET /api/settings")).toEqual([]);
  });

  it("反映ボタンは開いているときだけ。閉じているときの反映の呼び出し(古いボタンの click など)は何もしない", async () => {
    const h = await started();
    expect(refreshOf(h)).toBeUndefined();
    const before = h.renders.length;
    toggleOf(h).on!.click!();
    const refresh = refreshOf(h)!.on!.click!;
    toggleOf(h).on!.click!(); // 閉じる
    const afterClose = h.renders.length;
    expect(afterClose).toBe(before + 2);
    refresh(); // 閉じたあとに届いた反映
    expect(h.renders.length).toBe(afterClose);
  });

  it("保存の成功: 開いたまま、サーバが返した設定で文面が更新される(保存した追加指示が文面に出る)", async () => {
    const h = await started();
    toggleOf(h).on!.click!();
    h.type("additionalInstruction", "保存する指示");
    h.clickSave();
    await h.app.whenIdle();
    expect(toggleOf(h).attrs?.["aria-expanded"]).toBe("true"); // 開いたまま
    expect(previewText(h)).toContain("保存する指示");
  });

  it("保存中の開閉・反映は無視する(描画は増えない)。入力を無視するのと同じ", async () => {
    const gate = deferred<Resp>();
    const h = await started({ postResponder: () => gate.promise });
    h.clickSave();
    const before = h.renders.length;
    toggleOf(h).on!.click!();
    expect(h.renders.length).toBe(before);
    expect(previewText(h)).toBeNull();
    gate.resolve(ok({ ok: true, settings: SERVER }));
    await h.app.whenIdle();
  });

  it("画面を離れて戻ると、閉じた状態に戻る(開閉はメモリだけ。戻ると設定を取り直す)", async () => {
    const h = await started();
    toggleOf(h).on!.click!();
    expect(previewText(h)).not.toBeNull();
    h.go("#date=20260628&venue=central");
    h.go("#settings");
    await h.app.whenIdle();
    expect(previewText(h)).toBeNull();
    expect(toggleOf(h).attrs?.["aria-expanded"]).toBe("false");
  });

  it("「再読込」は未保存の入力を捨てるので、開いたままの文面もサーバの値に戻る", async () => {
    const h = await started();
    h.type("additionalInstruction", "捨てられる指示");
    toggleOf(h).on!.click!();
    expect(previewText(h)).toContain("捨てられる指示");
    h.clickRefresh();
    await h.app.whenIdle();
    expect(toggleOf(h).attrs?.["aria-expanded"]).toBe("true");
    expect(previewText(h)).not.toContain("捨てられる指示");
  });

  it("取得前(読み込み中)は、プレビューのボタンが無い。取得できると出る", async () => {
    const h = harness("#settings");
    const gate = deferred<Resp>();
    h.getResponder = () => gate.promise;
    h.app.start();
    expect(byClass(h.tree(), "preview-toggle")).toEqual([]);
    gate.resolve(ok({ ok: true, settings: SERVER, source: "d1" }));
    await h.app.whenIdle();
    expect(toggleOf(h)).toBeDefined();
  });
});
