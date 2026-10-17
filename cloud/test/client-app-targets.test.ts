import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import { createMounter, type DomDocument } from "../client/dom";
import { TARGETS_POLL_MS } from "../client/targets-screen";
import type { VNode } from "../client/vnode";
import { createFakeTimers } from "./client-fakes";

/**
 * Issue #336 段階 B: アプリ全体の中の狙い目画面(`#targets`)。画面の出入り・他の画面との分離・更新・可視状態・閲覧者。
 * 守ること: 狙い目画面は `GET /api/targets` だけを取る(一覧・板・設定・レース・分析・検証・日報は取らない)。他の画面は `/api/targets` を取らない。
 * 離れるとタイマー・遅れて届く応答を捨てる。閲覧者にも同じに開く。
 */

const BASE = Date.parse("2026-10-17T05:00:00Z");
const MIN = 60_000;

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

interface Harness {
  readonly app: App;
  readonly calls: string[];
  readonly timers: ReturnType<typeof createFakeTimers>;
  hash: string;
  visible: boolean;
  tree(): VNode;
  go(hash: string): void;
}

function harness(initialHash: string, role: "admin" | "viewer" = "admin"): Harness {
  const calls: string[] = [];
  const timers = createFakeTimers();
  let latest: VNode | null = null;
  const doc: DomDocument = { createElement: (tag) => new FakeElement(tag) as never, createTextNode: (t) => new FakeText(t) };
  const mounter = createMounter(doc, { replaceChildren: () => {} });
  const now = (): number => BASE + timers.now();
  const fetchLike: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url.startsWith("/api/targets?")) {
      const races = [{ race_id: "202605050811", analysis_id: 11, start_ms: BASE + 30 * MIN, start_time: "15:40", place: "東京11R", pick: "◎7", skipped: false, detail: "5点 1,200円 EV 1.42・分析時" }];
      return { status: 200, json: async () => ({ ok: true, kaisai_date: new URL(url, "https://x.invalid").searchParams.get("kaisai_date"), now_ms: now(), summary: "分析済み 1 レース中、狙い目 1", races }) };
    }
    throw new Error(`想定外の取得: ${init.method} ${url}`);
  };
  const h: Harness = {
    app: undefined as never,
    calls,
    timers,
    hash: initialHash,
    visible: true,
    tree: () => latest!,
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
  };
  (h as { app: App }).app = createApp({
    role,
    fetch: fetchLike,
    now: () => new Date(now()),
    render: (tree, force) => {
      latest = tree;
      mounter(tree, force);
    },
    getHash: () => h.hash,
    setHash: () => {},
    timers: { set: timers.set, clear: timers.clear },
    isVisible: () => h.visible,
  });
  return h;
}

describe("狙い目画面を開く", () => {
  it("#targets=今日で始めると、GET /api/targets を 1 回だけ取る(一覧・板・設定・分析は取らない)。最初は読み込み中で、届くと行が出る", async () => {
    const h = harness("#targets=20261017");
    h.app.start();
    expect(textOf(h.tree())).toContain("読み込み中…");
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/targets?kaisai_date=20261017"]);
    expect(textOf(byClass(h.tree(), "title")[0]!)).toBe("狙い目 2026-10-17");
    const rows = byClass(h.tree(), "race");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attrs?.["href"]).toBe("#date=20261017&venue=central&analysis=11");
    expect(textOf(rows[0]!)).toContain("あと30分");
  });

  it("#targets(日付なし)は今日の日付(JST)で取る", async () => {
    const h = harness("#targets");
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/targets?kaisai_date=20261017"]);
  });

  it("閲覧者にも同じに開く(同じ取得・同じ表示。更新ボタンもある)", async () => {
    const h = harness("#targets=20261017", "viewer");
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/targets?kaisai_date=20261017"]);
    expect(byClass(h.tree(), "race")).toHaveLength(1);
    expect(byClass(h.tree(), "refresh")).toHaveLength(1);
  });

  it("「更新」で取り直す(取得中は無視)。残り時間は取得なしで 30 秒ごとに減る", async () => {
    const h = harness("#targets=20261017");
    h.app.start();
    await h.app.whenIdle();
    await h.timers.advance(MIN);
    expect(textOf(byClass(h.tree(), "race")[0]!)).toContain("あと29分");
    expect(h.calls).toHaveLength(1);
    byClass(h.tree(), "refresh")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(2);
  });

  it("別の日の #targets=… へ移ると取り直す。一覧へ戻ると(狙い目の取得は止まり)タイマーも無くなる。一覧は狙い目を取らない", async () => {
    const h = harness("#targets=20261017");
    h.app.start();
    await h.app.whenIdle();
    h.go("#targets=20261016");
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/targets?kaisai_date=20261017", "GET /api/targets?kaisai_date=20261016"]);
    expect(textOf(byClass(h.tree(), "title")[0]!)).toBe("狙い目 2026-10-16");
    // 離れる(検証画面は /api/verify を取るが、ここでは偽の fetch が想定外として投げるだけで、狙い目の取得とタイマーが止まることを見る)
    h.go("#verify");
    expect(h.timers.pending()).toBe(0);
    const before = h.calls.filter((c) => c.includes("/api/targets")).length;
    await h.timers.advance(10 * TARGETS_POLL_MS);
    expect(h.calls.filter((c) => c.includes("/api/targets")).length).toBe(before);
  });

  it("見えない間は取り直さず、見えるようになったときに(1 分以上たっていれば)取り直す", async () => {
    const h = harness("#targets=20261017");
    h.app.start();
    await h.app.whenIdle();
    h.visible = false;
    h.app.onVisibilityChange();
    await h.timers.advance(20 * MIN);
    expect(h.calls).toHaveLength(1);
    h.visible = true;
    h.app.onVisibilityChange();
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(2);
  });

  it("3 分で自動の取り直しが 1 回起きる(今日・発走前のレースあり)", async () => {
    const h = harness("#targets=20261017");
    h.app.start();
    await h.app.whenIdle();
    await h.timers.advance(TARGETS_POLL_MS);
    expect(h.calls).toHaveLength(2);
  });
});

