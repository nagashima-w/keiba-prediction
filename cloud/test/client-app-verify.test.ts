import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import { createMounter, type DomDocument } from "../client/dom";
import type { VNode } from "../client/vnode";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { createFakeTimers } from "./client-fakes";
import { calibrationFixture, trendFixture, versionsFixture } from "./verify-fixtures";

/**
 * Issue #219: アプリ全体の中の検証画面(`#verify`)。画面の出入り・他の画面との分離・区分の切替・更新・可視状態。
 * 守ること:
 *  - 検証画面は `GET /api/verify?venue=all` だけを取る(一覧・板・設定・レース・分析は取らない)。他の画面は `/api/verify` を取らない
 *  - 補完中だけ自動で取り直し、離れると止まる。遅れて届く応答は今の画面に反映しない
 */

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });

const SUMMARY = { betCount: 1, totalStake: 100, totalReturn: 150, recoveryRate: 1.5, unjudgedCount: 0 };
const REPORT = {
  includedAnalysisCount: 3, excludedAnalysisCount: 0, supersededAnalysisCount: 0, excludedEstimatedCount: 0, excludedLookaheadSuspectCount: 0, excludedLookaheadUnknownCount: 0,
  bet: { betCount: 1, totalStake: 100, totalReturn: 150, recoveryRate: 1.5, actualPayoutCount: 1, approximatePayoutCount: 0 },
  calibration: calibrationFixture(),
  trend: trendFixture(),
  proposedBet: {
    population: { allocated: 1, skipped: 0, unreached: 0, noRecord: 0 },
    overall: SUMMARY, place: SUMMARY, win: SUMMARY, wide: SUMMARY, trio: SUMMARY, quinella: SUMMARY, exacta: SUMMARY, trifecta: SUMMARY, bracketQuinella: SUMMARY,
    unknownBetType: { count: 0, totalStake: 0, betTypes: [] },
  },
};
const readyFor = (venue: string): Record<string, unknown> => ({
  ok: true, status: "ready", venue, report: REPORT, promptVersions: versionsFixture(), computedAt: "2026-10-10T03:00:00.000Z", stale: false, staleReason: null, nextRecomputeAt: null, diag: { startTimeGaps: { lost: 0, affecting: 0 } },
});

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
  /** /api/verify の応答(呼ばれるたびに先頭から消費する。残りが無ければ最後のものを繰り返す)。 */
  responses: Record<string, unknown>[];
  tree(): VNode;
  go(hash: string): void;
}

function harness(initialHash: string): Harness {
  const calls: string[] = [];
  const timers = createFakeTimers();
  let latest: VNode | null = null;
  const doc: DomDocument = { createElement: (tag) => new FakeElement(tag) as never, createTextNode: (t) => new FakeText(t) };
  const mounter = createMounter(doc, { replaceChildren: () => {} });
  const fetchLike: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url.startsWith("/api/verify?")) {
      const venue = new URL(url, "https://x.invalid").searchParams.get("venue") ?? "all";
      const next = h.responses.length > 1 ? h.responses.shift()! : (h.responses[0] ?? readyFor(venue));
      return ok(next);
    }
    if (url === "/api/settings" && init.method === "GET") return ok({ ok: true, settings: DEFAULT_CLOUD_SETTINGS, source: "d1" });
    throw new Error(`想定外の取得: ${init.method} ${url}`);
  };
  const h: Harness = {
    app: undefined as never,
    calls,
    timers,
    hash: initialHash,
    visible: true,
    responses: [readyFor("all")],
    tree: () => latest!,
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
  };
  (h as { app: App }).app = createApp({
    role: "admin",
    fetch: fetchLike,
    now: () => new Date("2026-06-28T00:00:00Z"),
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

describe("検証画面を開く", () => {
  it("#verify で始めると、GET /api/verify?venue=all を 1 回だけ取る(一覧・板・設定・分析は取らない)。最初の描画は「読み込み中…」", async () => {
    const h = harness("#verify");
    h.app.start();
    expect(textOf(h.tree())).toContain("読み込み中…");
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/verify?venue=all"]);
    expect(textOf(byClass(h.tree(), "title")[0]!)).toBe("検証");
    expect(textOf(h.tree())).toContain("累積回収率");
    expect(textOf(h.tree())).toContain("150.0%");
  });

  it("区分のボタンで取り直し、更新は refresh=1。画面の区分の表示が替わる", async () => {
    const h = harness("#verify");
    h.app.start();
    await h.app.whenIdle();
    byClass(h.tree(), "verify-venue")[2]!.on!.click!();
    await h.app.whenIdle();
    byClass(h.tree(), "refresh")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/verify?venue=all", "GET /api/verify?venue=nar", "GET /api/verify?venue=nar&refresh=1"]);
    expect(byClass(h.tree(), "verify-venue").map((n) => n.attrs?.["aria-pressed"])).toEqual(["false", "false", "true"]);
  });

  it("版別のキャリブレーションの開閉のボタンが app まで届き、取得は増えずに再描画される(区分を替えても開いたまま)", async () => {
    const h = harness("#verify");
    h.app.start();
    await h.app.whenIdle();
    expect(byClass(h.tree(), "verify-version")).toHaveLength(3);
    expect(byClass(h.tree(), "verify-stat-bar")).toHaveLength(20); // 前提(空振り防止): 主表の 20 帯だけ(版別は閉じている)
    byClass(h.tree(), "verify-version-toggle")[0]!.on!.click!();
    expect(byClass(h.tree(), "verify-stat-bar")).toHaveLength(40);
    expect(byClass(h.tree(), "verify-version-toggle")[0]!.attrs?.["aria-expanded"]).toBe("true");
    expect(h.calls).toEqual(["GET /api/verify?venue=all"]);
    byClass(h.tree(), "verify-venue")[1]!.on!.click!();
    await h.app.whenIdle();
    expect(byClass(h.tree(), "verify-stat-bar")).toHaveLength(40);
    byClass(h.tree(), "verify-version-toggle")[0]!.on!.click!();
    expect(byClass(h.tree(), "verify-stat-bar")).toHaveLength(20);
  });

  it("準備中は 3 秒ごとに取り直し、離れると止まる。戻ると取り直す(区分は全体に戻る)", async () => {
    const h = harness("#verify");
    h.responses = [{ ok: true, status: "preparing", remaining: 9, blocked: null, resumeAt: null }];
    h.app.start();
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("9件");
    await h.timers.advance(3_000);
    await h.app.whenIdle();
    expect(h.calls.filter((c) => c.includes("/api/verify"))).toHaveLength(2);
    h.go("#settings");
    await h.app.whenIdle();
    await h.timers.advance(60_000);
    expect(h.calls.filter((c) => c.includes("/api/verify"))).toHaveLength(2);
    h.responses = [readyFor("all")];
    h.go("#verify");
    await h.app.whenIdle();
    expect(h.calls.filter((c) => c.includes("/api/verify"))).toHaveLength(3);
  });

  it("非表示でポーリングを止め、表示に戻ると即時に 1 回取る(app の onVisibilityChange が届く)", async () => {
    const h = harness("#verify");
    h.responses = [{ ok: true, status: "preparing", remaining: 9, blocked: null, resumeAt: null }];
    h.app.start();
    await h.app.whenIdle();
    h.visible = false;
    h.app.onVisibilityChange();
    await h.timers.advance(60_000);
    expect(h.calls).toHaveLength(1);
    h.visible = true;
    h.app.onVisibilityChange();
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(2);
  });
});

describe("他の画面との分離", () => {
  it("設定画面は /api/verify を取らない", async () => {
    const h = harness("#settings");
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/settings"]);
    expect(h.calls.some((c) => c.includes("/api/verify"))).toBe(false);
  });
});
