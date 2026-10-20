import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { VNode } from "../client/vnode";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #400 R-11(`createApp` の分割)の前に足した、振る舞いの特性テスト(追加のみ。既存のテストは変えない)。
 * 分割前の `app.ts` に変異(門・世代・強制描画・順序などの削除)を機械的に注入したところ、既存の client 系テストが全緑のまま生き残った変異のうち、
 * **利用者から見える挙動に当たるもの**を固定する。分割後(設定・単体実行・一括実行を外へ出したあと)も同じ振る舞いであることを、`createApp` を通して確かめる。
 * 偽の fetch・偽のタイマー・偽のハッシュ。実リクエストはしない。
 */

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
const resp = (status: number, body: unknown): Resp => ({ status, json: async () => body });

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));
/** 保留中の非同期の後始末だけを流す(有限回)。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------------------------
// 設定画面
// ---------------------------------------------------------------------------------------------
describe("R-11 特性: 設定画面(#settings)", () => {
  const SERVER: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 500_000, perRaceCap: 50_000, preRaceOffsetMinutes: 90 };
  const LIST_HASH = "#date=20260628&venue=central";

  interface Harness {
    readonly app: App;
    readonly calls: string[];
    readonly posts: Record<string, unknown>[];
    readonly previews: { additionalInstruction: string; clipVariant: string }[];
    readonly renders: { tree: VNode; force: boolean }[];
    getResponder: () => Promise<Resp>;
    postResponder: (body: Record<string, unknown>) => Promise<Resp>;
    hash: string;
    tree(): VNode;
    field(key: string): VNode;
    go(hash: string): void;
    type(key: string, value: string): void;
    save(): void;
    refresh(): void;
    count(call: string): number;
  }

  function harness(initialHash: string): Harness {
    const calls: string[] = [];
    const posts: Record<string, unknown>[] = [];
    const previews: { additionalInstruction: string; clipVariant: string }[] = [];
    const renders: { tree: VNode; force: boolean }[] = [];
    const fetchLike: FetchLike = (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (url === "/api/settings" && init.method === "GET") return h.getResponder();
      if (url === "/api/settings" && init.method === "POST") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        posts.push(body);
        return h.postResponder(body);
      }
      if (url === "/api/settings/prompt-preview" && init.method === "POST") {
        const body = JSON.parse(init.body as string) as { additionalInstruction: string; clipVariant: string };
        previews.push(body);
        return Promise.resolve(ok({ ok: true, text: `【予想印】指示=[${body.additionalInstruction}] 幅=${body.clipVariant}`, clamped: false, promptVersion: "pv" }));
      }
      // 一覧など(設定画面から離れた先)は、取得に失敗する扱いにする(この検査の関心は設定画面の状態)。
      return Promise.resolve(resp(500, { ok: false }));
    };
    const h: Harness = {
      hash: initialHash,
      calls,
      posts,
      previews,
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
      save: () => byClass(h.tree(), "settings-save")[0]!.on!.click!(),
      refresh: () => byClass(h.tree(), "refresh")[0]!.on!.click!(),
      count: (call) => calls.filter((c) => c === call).length,
      app: undefined as never,
    };
    (h as { app: App }).app = createApp({
      role: "admin",
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

  it("保存中に打った入力は無視される: 保存が失敗したあと再保存しても、保存中に打った値は送られない(下書きは保存を押した時点のまま)", async () => {
    const h = await started();
    h.type("bankroll", "600000");
    const gate = deferred<Resp>();
    h.postResponder = () => gate.promise;
    h.save();
    expect(h.posts).toHaveLength(1);
    h.type("bankroll", "999999"); // 保存中の入力
    gate.resolve(resp(503, { ok: false, error: { type: "d1-error" } }));
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("保存できませんでした");
    expect(h.field("bankroll").attrs?.["value"]).toBe("600000"); // 画面の欄も保存を押した時点の値
    h.postResponder = async (body) => ok({ ok: true, settings: body });
    h.save();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]!["bankroll"]).toBe(600_000);
    await h.app.whenIdle();
  });

  it("保存の成功のあとに打つと、次の強制描画(ここではプレビューを開く操作)で「保存しました」の通知が消えている(未保存の入力が生まれた)", async () => {
    const h = await started();
    h.save();
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("保存しました"); // 前提
    h.type("bankroll", "123");
    byClass(h.tree(), "preview-toggle")[0]!.on!.click!(); // 強制描画(ここで状態から木を作り直す。この操作自体は保存の通知に触れない)
    expect(h.renders[h.renders.length - 1]!.force).toBe(true);
    expect(textOf(h.tree())).not.toContain("保存しました");
    expect(h.field("bankroll").attrs?.["value"]).toBe("123");
  });

  it("取得中に画面を離れ、応答が離れている間に届いても、反映しない: 戻ると取り直す(GET が 2 回)", async () => {
    const h = harness("#settings");
    const gate = deferred<Resp>();
    h.getResponder = () => gate.promise;
    h.app.start();
    expect(h.count("GET /api/settings")).toBe(1);
    h.go(LIST_HASH);
    gate.resolve(ok({ ok: true, settings: SERVER, source: "d1" }));
    await h.app.whenIdle();
    h.getResponder = async () => ok({ ok: true, settings: { ...SERVER, bankroll: 777_000 }, source: "d1" });
    h.go("#settings");
    await h.app.whenIdle();
    expect(h.count("GET /api/settings")).toBe(2); // 離れている間に届いた応答で「取得済み」にならない
    expect(h.field("bankroll").attrs?.["value"]).toBe("777000");
  });

  it("保存中に画面を離れ、保存の応答が離れている間に届いても、反映しない: 戻ると取り直す(GET が 2 回・サーバの値で表示)", async () => {
    const h = await started();
    const gate = deferred<Resp>();
    h.postResponder = () => gate.promise;
    h.type("bankroll", "321");
    h.save();
    h.go(LIST_HASH);
    gate.resolve(ok({ ok: true, settings: { ...SERVER, bankroll: 321 }, source: "d1" }));
    await h.app.whenIdle();
    h.getResponder = async () => ok({ ok: true, settings: { ...SERVER, bankroll: 888_000 }, source: "d1" });
    h.go("#settings");
    await h.app.whenIdle();
    expect(h.count("GET /api/settings")).toBe(2);
    expect(h.field("bankroll").attrs?.["value"]).toBe("888000");
    expect(textOf(h.tree())).not.toContain("保存しました");
  });

  it("保存の成功のあと、設定の出どころは「保存済み」になる(source が default だった「まだ保存されていません」の注記が消える)", async () => {
    const h = await started({ getResponder: async () => ok({ ok: true, settings: DEFAULT_CLOUD_SETTINGS, source: "default" }) });
    expect(textOf(h.tree())).toContain("まだ保存されていません"); // 前提
    h.save();
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("保存しました");
    expect(textOf(h.tree())).not.toContain("まだ保存されていません");
  });

  it("「再読込」は、保存の通知・保存の失敗の表示も消す(取得し直したあとに前の通知が残らない)", async () => {
    const h = await started();
    h.save();
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("保存しました"); // 前提
    h.refresh();
    await h.app.whenIdle();
    expect(textOf(h.tree())).not.toContain("保存しました");
    // 失敗の表示も同じ
    h.postResponder = async () => resp(503, { ok: false, error: { type: "d1-error" } });
    h.save();
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("保存できませんでした"); // 前提
    h.refresh();
    await h.app.whenIdle();
    expect(textOf(h.tree())).not.toContain("保存できませんでした");
  });

  it("「再読込」を押すと、強制描画で「読み込み中」に切り替わる(取得が終わるまで古い入力欄を出さない)", async () => {
    const h = await started();
    const gate = deferred<Resp>();
    h.getResponder = () => gate.promise;
    const before = h.renders.length;
    h.refresh();
    expect(h.renders.length).toBeGreaterThan(before);
    const last = h.renders[h.renders.length - 1]!;
    expect(last.force).toBe(true);
    expect(textOf(last.tree)).toContain("読み込み中…");
    expect(findAll(last.tree, (n) => n.attrs?.["data-field"] !== undefined)).toEqual([]);
    gate.resolve(ok({ ok: true, settings: SERVER, source: "d1" }));
    await h.app.whenIdle();
  });

  it("設定画面の中で同じハッシュの hashchange が来ても、設定を取り直さない(GET は 1 回のまま・入力も消えない)", async () => {
    const h = await started();
    h.type("bankroll", "123");
    h.go("#settings");
    await h.app.whenIdle();
    expect(h.count("GET /api/settings")).toBe(1);
    h.save();
    expect(h.posts[0]!["bankroll"]).toBe(123); // 未保存の下書きが残っている(取り直して捨てていない)
    await h.app.whenIdle();
  });

  it("プレビューの応答で入力に追いついた(強制描画で写しを更新した)あとでも、「入力中の内容を反映」はその都度取り直す(取得が止まらない)", async () => {
    const h = await started();
    byClass(h.tree(), "preview-toggle")[0]!.on!.click!(); // 開く(取得 1 回目)
    h.type("additionalInstruction", "指示A"); // 取得中に打つ(写しと下書きが違う状態で応答を迎える)
    await h.app.whenIdle();
    // 応答のとき、下書きが写しと違うので強制描画に切り替わり、新しい取得は起こさない
    expect(h.previews).toHaveLength(1);
    byClass(h.tree(), "preview-refresh")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.previews).toHaveLength(2);
    expect(h.previews[1]!.additionalInstruction).toBe("指示A");
  });
});

// ---------------------------------------------------------------------------------------------
// 単体実行・一括実行
// ---------------------------------------------------------------------------------------------
describe("R-11 特性: 起動(単体・一括)", () => {
  const DATE = "20260628";
  const RACE_ID = "202603020211";

  it("単体の起動: whenIdle は起動の POST の完了まで待つ", async () => {
    const timers = createFakeTimers();
    const gate = deferred<Resp>();
    let tree: VNode | null = null;
    const fetchLike: FetchLike = (url, init) => {
      if (init.method === "POST" && url === "/api/analyses/run") return gate.promise;
      if (url === `/api/analyses/status?kaisai_date=${DATE}&race_id=${RACE_ID}`) return Promise.resolve(ok({ ok: true, kaisai_date: DATE, races: [], prior: null }));
      if (url === `/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE}&limit=20`) return Promise.resolve(ok({ ok: true, analyses: [] }));
      throw new Error(`想定外の取得: ${init.method} ${url}`);
    };
    const app = createApp({
      role: "admin",
      fetch: fetchLike,
      now: () => new Date(Date.parse("2026-06-28T00:00:00Z") + timers.now()),
      render: (t) => {
        tree = t;
      },
      getHash: () => `#date=${DATE}&venue=central&race=${RACE_ID}`,
      setHash: () => {},
      timers: { set: (fn, ms) => timers.set(fn, ms), clear: (handle) => timers.clear(handle) },
      isVisible: () => true,
    });
    app.start();
    await app.whenIdle();
    const run = byClass(tree!, "run").filter((b) => b.attrs?.["data-mode"] === "morning");
    expect(run).toHaveLength(1);
    run[0]!.on!.click!();
    let idle = false;
    const waiting = app.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false); // POST の応答を待っている
    gate.resolve(resp(202, { ok: true, accepted: true, race_id: RACE_ID, kaisai_date: DATE, mode: "morning", status: "queued" }));
    await waiting;
    expect(idle).toBe(true);
  });

  describe("一括実行", () => {
    const LIST_HASH = `#date=${DATE}&venue=central`;
    const BULK_URL = "/api/analyses/run/bulk";
    const F1 = "202602020101";
    const F2 = "202602020102";
    const jrace = (raceId: string, n: number, startTime: string | null) => ({ race_id: raceId, venue_name: "福島", race_number: n, race_name: `福島${n}R`, course_type: "芝", distance: 1800, entry_count: 16, grade: null, start_time: startTime });

    async function startedBulk(bulkResponse: () => Promise<Resp>) {
      const timers = createFakeTimers();
      let tree: VNode | null = null;
      const bulkBodies: unknown[] = [];
      const fetchLike: FetchLike = (url, init) => {
        if (init.method === "POST" && url === BULK_URL) {
          bulkBodies.push(JSON.parse(init.body as string));
          return bulkResponse();
        }
        if (url === `/api/races?kaisai_date=${DATE}&venue=central`) return Promise.resolve(ok({ ok: true, kaisai_date: DATE, venue: "central", races: [jrace(F1, 1, "10:00"), jrace(F2, 2, "11:00")] }));
        if (url === `/api/analyses/status?kaisai_date=${DATE}`) return Promise.resolve(ok({ ok: true, kaisai_date: DATE, races: [] }));
        throw new Error(`想定外の取得: ${init.method} ${url}`);
      };
      const app = createApp({
        role: "admin",
        fetch: fetchLike,
        now: () => new Date(Date.parse("2026-06-28T00:00:00Z") + timers.now()),
        render: (t) => {
          tree = t;
        },
        getHash: () => LIST_HASH,
        setHash: () => {},
        timers: { set: (fn, ms) => timers.set(fn, ms), clear: (handle) => timers.clear(handle) },
        isVisible: () => true,
      });
      app.start();
      await timers.flush();
      await app.whenIdle();
      return { app, timers, tree: () => tree!, bulkBodies };
    }
    const accepted = (): Resp =>
      resp(202, { ok: true, accepted: true, kaisai_date: DATE, mode: "morning", results: [{ race_id: F1, result: "accepted" }, { race_id: F2, result: "accepted" }] });

    it("whenIdle は一括の POST の完了まで待つ", async () => {
      const gate = deferred<Resp>();
      const s = await startedBulk(() => gate.promise);
      byClass(s.tree(), "bulk-run").filter((b) => b.attrs?.["data-mode"] === "morning")[0]!.on!.click!();
      byClass(s.tree(), "bulk-go")[0]!.on!.click!();
      let idle = false;
      const waiting = s.app.whenIdle().then(() => {
        idle = true;
      });
      await flush();
      expect(idle).toBe(false);
      gate.resolve(accepted());
      await waiting;
      expect(idle).toBe(true);
    });

    it("成功の結果は「ok」の見た目(role=status・error の class なし)、失敗は error(role=alert・error の class)", async () => {
      const okRun = await startedBulk(async () => accepted());
      byClass(okRun.tree(), "bulk-run").filter((b) => b.attrs?.["data-mode"] === "morning")[0]!.on!.click!();
      byClass(okRun.tree(), "bulk-go")[0]!.on!.click!();
      await okRun.app.whenIdle();
      const okBox = byClass(okRun.tree(), "bulk-result");
      expect(okBox).toHaveLength(1);
      expect(okBox[0]!.attrs?.["role"]).toBe("status");
      expect(String(okBox[0]!.attrs?.["class"]).split(" ")).not.toContain("error");

      const ng = await startedBulk(async () => resp(500, { ok: false }));
      byClass(ng.tree(), "bulk-run").filter((b) => b.attrs?.["data-mode"] === "morning")[0]!.on!.click!();
      byClass(ng.tree(), "bulk-go")[0]!.on!.click!();
      await ng.app.whenIdle();
      const ngBox = byClass(ng.tree(), "bulk-result");
      expect(ngBox).toHaveLength(1);
      expect(ngBox[0]!.attrs?.["role"]).toBe("alert");
      expect(String(ngBox[0]!.attrs?.["class"]).split(" ")).toContain("error");
    });

    it("確認画面を開いたまま日本時間の日付が変わったら、「実行する」は POST せず、対象がなくなった旨の結果にする(過去の開催日には送らない)", async () => {
      const s = await startedBulk(async () => accepted());
      byClass(s.tree(), "bulk-run").filter((b) => b.attrs?.["data-mode"] === "morning")[0]!.on!.click!();
      const go = byClass(s.tree(), "bulk-go")[0]!;
      await s.timers.advance(15 * 60 * 60 * 1000); // 2026-06-28 09:00 JST → 29 日 00:00 JST
      go.on!.click!(); // 開く前に取った古いボタンの click(日付が変わったあとに押された状況)
      await s.app.whenIdle();
      expect(s.bulkBodies).toEqual([]);
      expect(textOf(s.tree())).toContain("対象のレースがなくなったため、何も予約していません。");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 権限(閲覧者/管理者)の配線
// ---------------------------------------------------------------------------------------------
describe("R-11 特性: 起動・一括の制御へ、役割から決めた admin を渡している(app.ts の静的な確認)", () => {
  // 閲覧者には起動・一括実行のボタンが無いので、`createApp` を通しては「制御へ admin を渡し忘れた/常に true にした」ことを検出できない
  // (閲覧者の画面からはハンドラに届かない)。制御側の「admin が false なら何もしない」は client-run-control.test.ts・client-bulk-control.test.ts が固定するので、
  // ここでは app.ts が `isAdmin(deps.role)` の結果をそのまま渡していることだけを、コメントを除いたソースで確かめる。
  const code = readFileSync(path.join(__dirname, "..", "client", "app.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const RUN_CALL = /createRunControl\(\{[^\n]*\badmin,/;
  const BULK_CALL = /createBulkControl\(\{\n(?: {4}[^\n]*\n)*? {4}admin,\n/;

  it("前提: admin は役割から決めた値で、起動・一括の制御の生成にそのまま渡している", () => {
    expect(code).toContain("const admin = isAdmin(deps.role);");
    expect(RUN_CALL.test(code)).toBe(true);
    expect(BULK_CALL.test(code)).toBe(true);
  });

  it("対照: 常に true を渡す書き方は、上の検出に当たらない(検出が空振りでない)", () => {
    expect(RUN_CALL.test(code.replace("now: deps.now, admin,", "now: deps.now, admin: true,"))).toBe(false);
    expect(BULK_CALL.test(code.replace("    admin,\n    onChange", "    admin: true,\n    onChange"))).toBe(false);
  });
});
