import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { VNode } from "../client/vnode";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { deferred } from "./client-fakes";

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
