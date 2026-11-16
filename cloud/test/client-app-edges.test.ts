import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import { createMounter, type DomDocument } from "../client/dom";
import type { VNode } from "../client/vnode";
import { createFakeTimers } from "./client-fakes";

/**
 * Issue #644: アプリ全体の中の指標の一覧(`#edges`)。画面の出入り・他の画面との分離・更新・閲覧者。
 * 守ること: `#edges` は `GET /api/market-edges` だけを取る(一覧・板・分析・検証・狙い目は取らない)。離れると遅れて届く応答を捨てる。一覧のトップに入口がある。閲覧者にも開く。
 */

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));

class FakeText {
  constructor(readonly data: string) {}
}
class FakeElement {
  readonly children: unknown[] = [];
  constructor(readonly tag: string) {}
  setAttribute(): void {}
  appendChild(child: unknown): void {
    this.children.push(child);
  }
  addEventListener(): void {}
}

const BASE = Date.parse("2026-10-17T05:00:00Z");

function harness(initialHash: string, role: "admin" | "viewer" = "admin") {
  const calls: string[] = [];
  const timers = createFakeTimers();
  let latest: VNode | null = null;
  const doc: DomDocument = { createElement: (tag) => new FakeElement(tag) as never, createTextNode: (t) => new FakeText(t) };
  const mounter = createMounter(doc, { replaceChildren: () => {} });
  const fetchLike: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url.startsWith("/api/market-edges?")) {
      const kind = new URL(url, "https://x.invalid").searchParams.get("kind")!;
      return { status: 200, json: async () => ({ ok: true, kind, note: "注記", rows: [{ name: kind === "jockey" ? "騎手の甲" : "調教師の乙", edge: 0.031, n: 312, hit_rate: 0.3, pred_mean: 0.28 }] }) };
    }
    throw new Error(`想定外の取得: ${init.method} ${url}`);
  };
  const h = {
    app: undefined as unknown as App,
    calls,
    hash: initialHash,
    tree: () => latest!,
    go: (hash: string) => {
      h.hash = hash;
      h.app.onHashChange();
    },
  };
  h.app = createApp({
    role,
    fetch: fetchLike,
    now: () => new Date(BASE + timers.now()),
    render: (tree, force) => {
      latest = tree;
      mounter(tree, force);
    },
    getHash: () => h.hash,
    setHash: () => {},
    timers: { set: timers.set, clear: timers.clear },
    isVisible: () => true,
  });
  return h;
}

describe("指標の一覧を開く", () => {
  it("#edges は騎手を 1 回だけ取る(他の API は取らない)。最初は読み込み中で、届くと行が出る。戻るリンクは一覧のトップ", async () => {
    const h = harness("#edges");
    h.app.start();
    expect(textOf(h.tree())).toContain("読み込み中…");
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/market-edges?kind=jockey"]);
    expect(textOf(h.tree())).toContain("騎手の甲");
    expect(textOf(h.tree())).toContain("+3.1pt");
    expect(byClass(h.tree(), "back")[0]!.attrs?.["href"]).toBe("#date=20261017&venue=central");
  });

  it("#edges=trainer は調教師を取る。騎手へ移ると取り直す。更新ボタンで取り直す", async () => {
    const h = harness("#edges=trainer");
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/market-edges?kind=trainer"]);
    expect(textOf(h.tree())).toContain("調教師の乙");
    h.go("#edges");
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/market-edges?kind=trainer", "GET /api/market-edges?kind=jockey"]);
    byClass(h.tree(), "refresh")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(3);
  });

  it("閲覧者にも同じに開く", async () => {
    const h = harness("#edges", "viewer");
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/market-edges?kind=jockey"]);
    expect(textOf(h.tree())).toContain("騎手の甲");
  });

  it("一覧のトップには入口のリンク(#edges)がある。一覧へ戻ると、この API は取らない", async () => {
    const h = harness("#edges");
    h.app.start();
    await h.app.whenIdle();
    h.calls.length = 0;
    h.go("#date=20261017&venue=central");
    // 一覧は /api/races などを取るので、偽の fetch が投げる(握られて失敗の表示になる)。ここでは、この API を取らないことだけを確かめる。
    await h.app.whenIdle();
    expect(h.calls.some((c) => c.includes("/api/market-edges"))).toBe(false);
    expect(findAll(h.tree(), (n) => n.tag === "a" && n.attrs?.["href"] === "#edges")).toHaveLength(1);
  });
});
