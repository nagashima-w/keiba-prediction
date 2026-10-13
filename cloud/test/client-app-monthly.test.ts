import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import { createMounter, type DomDocument } from "../client/dom";
import type { VNode } from "../client/vnode";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { createFakeTimers } from "./client-fakes";

/**
 * Issue #279(#265-A): アプリ全体の中の月報(`#report=YYYYMM`。日報の画面の中の「月」)。画面の出入り・日報との行き来・他の画面との分離・離れたときの破棄。
 * 守ること:
 *  - 月報は `GET /api/monthly-reports` と `GET /api/monthly-reports/{month}` だけを取る(日報・一覧・板・設定・分析・検証は取らない)。日報の画面は月報の API を取らない
 *  - 日報 ⇄ 月報の行き来で、片方の状態をもう片方へ持ち越さない。画面を離れると、遅れて届く応答を反映しない
 * 今日は 2026-11-05(JST)。
 */

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });

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
  /** POST の本文(URL つき)。 */
  readonly posts: Array<{ url: string; body: unknown }>;
  hash: string;
  tree(): VNode;
  go(hash: string): void;
}

function statsJson(): Record<string, unknown> {
  return {
    raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, betRaceCount: 2, llmUsedRaceCount: 3, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1,
    refundedBetCount: 0, refundedStake: 0, unjudgedBetCount: 0, unjudgedStake: 0, expectedBetCount: 0, expectedHits: 0, expectedBaseHits: 0, maxPayout: 800, maxPayoutStake: 200,
    byBetType: {}, byMark: [], whatIf: null, fromDate: "20261001", toDate: "20261031", dayCount: 1,
    days: [{ date: "20261003", raceCount: 3, resultRaceCount: 3, noResultRaceCount: 0, totalStake: 300, totalReturn: 800, recoveryRate: 800 / 300, judgedBetCount: 2, hitBetCount: 1, refundedBetCount: 0 }],
    byVersion: [],
  };
}
const monthJson = (month: string): Record<string, unknown> => ({
  month, created_at: "2026-10-31T13:00:00.000Z", model: null, race_count: 3, total_stake: 300, total_return: 800, summary: null,
  body: { format: 1, month, stats: statsJson(), lastDayPending: false },
});
const MONTH_LIST_ROW = (month: string) => ({ month, created_at: "2026-10-31T13:00:00.000Z", model: null, race_count: 3, total_stake: 300, total_return: 800, summary: null });

async function harness(initialHash: string, role: "admin" | "viewer" = "admin"): Promise<Harness> {
  const calls: string[] = [];
  const posts: Array<{ url: string; body: unknown }> = [];
  const timers = createFakeTimers();
  let latest: VNode | null = null;
  const doc: DomDocument = { createElement: (tag) => new FakeElement(tag) as never, createTextNode: (t) => new FakeText(t) };
  const mounter = createMounter(doc, { replaceChildren: () => {} });
  const fetchLike: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (init.method === "POST") {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      posts.push({ url, body });
      if (url === "/api/monthly-reports/run") return { status: 202, json: async () => ({ ok: true, accepted: true, month: body["month"] }) };
      if (url === "/api/reports/run") return { status: 202, json: async () => ({ ok: true, accepted: true, date: body["date"] }) };
      throw new Error(`想定外の POST: ${url}`);
    }
    if (url === "/api/monthly-reports" && init.method === "GET") return ok({ ok: true, reports: [MONTH_LIST_ROW("202610"), MONTH_LIST_ROW("202609")] });
    const m = /^\/api\/monthly-reports\/(\d{6})$/.exec(url);
    if (m !== null && init.method === "GET") return ok({ ok: true, report: m[1] === "202610" || m[1] === "202609" ? monthJson(m[1]!) : null, job: null, job_status: "ok" });
    if (url === "/api/reports" && init.method === "GET") return ok({ ok: true, reports: [] });
    if (/^\/api\/reports\/\d{8}$/.test(url) && init.method === "GET") return ok({ ok: true, job_status: "ok", report: null, job: null });
    if (url === "/api/settings" && init.method === "GET") return ok({ ok: true, settings: DEFAULT_CLOUD_SETTINGS, source: "d1" });
    throw new Error(`想定外の取得: ${init.method} ${url}`);
  };
  const h: Harness = {
    app: undefined as never,
    calls,
    posts,
    hash: initialHash,
    tree: () => latest!,
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
  };
  (h as { app: App }).app = createApp({
    role,
    fetch: fetchLike,
    now: () => new Date("2026-11-05T00:00:00Z"),
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

describe("月報を開く", () => {
  it("#report=YYYYMM で始めると、月報の一覧と、その月の本文だけを取る(日報・一覧・板・設定・分析は取らない)。最初の描画は「読み込み中…」", async () => {
    const h = await harness("#report=202610");
    h.app.start();
    expect(textOf(h.tree())).toContain("読み込み中…");
    await h.app.whenIdle();
    expect([...h.calls].sort()).toEqual(["GET /api/monthly-reports", "GET /api/monthly-reports/202610"]);
    expect(textOf(byClass(h.tree(), "title")[0]!)).toBe("月報");
    expect(textOf(h.tree())).toContain("2026年10月の月報");
    expect(textOf(h.tree())).toContain("266.7%");
  });

  it("閲覧者にも同じ月報が出る(作成・作り直しの操作は段階 A には無い)", async () => {
    const h = await harness("#report=202610", "viewer");
    h.app.start();
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("2026年10月の月報");
    expect(byClass(h.tree(), "report-run")).toHaveLength(0);
    expect(byClass(h.tree(), "report-regen")).toHaveLength(0);
  });

  it("月報のある月へのリンク(前の月報)で同じ画面の中の月を替えると、本文だけを取り直す(一覧は取り直さない)", async () => {
    const h = await harness("#report=202610");
    h.app.start();
    await h.app.whenIdle();
    const prev = findAll(h.tree(), (n) => n.tag === "a" && textOf(n) === "前の月報");
    expect(prev.map((a) => a.attrs?.["href"])).toEqual(["#report=202609"]);
    h.go("#report=202609");
    await h.app.whenIdle();
    expect(h.calls.slice(2)).toEqual(["GET /api/monthly-reports/202609"]);
    expect(textOf(h.tree())).toContain("2026年9月の月報");
  });

  it("月報が無い月は『まだありません』の案内だけ(本文なし)", async () => {
    const h = await harness("#report=202607");
    h.app.start();
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("まだありません");
    expect(textOf(h.tree())).not.toContain("2026年7月の月報");
    expect(findAll(h.tree(), (n) => n.tag === "h2")).toHaveLength(0);
  });
});

describe("日報 ⇄ 月報の行き来", () => {
  it("日報から月報へ(タブ): 月報の API だけを取り、日報の状態を持ち込まない。月報から日報へ戻ると日報の API だけを取る", async () => {
    const h = await harness("#report=20261003");
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/reports", "GET /api/reports/20261003"]);
    const monthTab = findAll(h.tree(), (n) => n.tag === "a" && textOf(n) === "月報");
    expect(monthTab.map((a) => a.attrs?.["href"])).toEqual(["#report=202610"]);
    h.go("#report=202610");
    await h.app.whenIdle();
    expect(h.calls.slice(2).sort()).toEqual(["GET /api/monthly-reports", "GET /api/monthly-reports/202610"]);
    expect(textOf(h.tree())).toContain("2026年10月の月報");
    const dayTab = findAll(h.tree(), (n) => n.tag === "a" && textOf(n) === "日報");
    expect(dayTab.map((a) => a.attrs?.["href"])).toEqual(["#report"]);
    h.go("#report");
    await h.app.whenIdle();
    expect(h.calls.slice(4)).toEqual(["GET /api/reports", "GET /api/reports/20261105"]);
    expect(textOf(byClass(h.tree(), "title")[0]!)).toBe("日報");
  });

  it("月報から日報の日付のリンク(開催日ごとの行)で、その日の日報を開く", async () => {
    const h = await harness("#report=202610");
    h.app.start();
    await h.app.whenIdle();
    const link = byClass(h.tree(), "report-day-link");
    expect(link.map((a) => a.attrs?.["href"])).toEqual(["#report=20261003"]);
    h.go("#report=20261003");
    await h.app.whenIdle();
    expect(h.calls.slice(2)).toEqual(["GET /api/reports", "GET /api/reports/20261003"]);
  });
});

describe("画面を離れる・更新", () => {
  it("月報から他の画面(一覧)へ移ると、月報の応答を反映せず、月報の API を取らない。戻ると取り直す", async () => {
    const h = await harness("#report=202610");
    h.app.start();
    await h.app.whenIdle();
    const before = h.calls.length;
    h.go("#date=20261105&venue=central");
    await h.app.whenIdle();
    expect(h.calls.slice(before).some((c) => c.includes("/api/monthly-reports"))).toBe(false);
    h.go("#report=202610");
    await h.app.whenIdle();
    expect(h.calls.filter((c) => c === "GET /api/monthly-reports")).toHaveLength(2);
  });

  it("日報の画面は月報の API を取らない(#report)", async () => {
    const h = await harness("#report");
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls.some((c) => c.includes("/api/monthly-reports"))).toBe(false);
  });

  it("『更新』で月報の一覧と本文を取り直す(日報の API は取らない)", async () => {
    const h = await harness("#report=202610");
    h.app.start();
    await h.app.whenIdle();
    const before = h.calls.length;
    byClass(h.tree(), "refresh")[0]!.on!.click!();
    await h.app.whenIdle();
    expect([...h.calls.slice(before)].sort()).toEqual(["GET /api/monthly-reports", "GET /api/monthly-reports/202610"]);
  });
});

describe("管理者の操作(Issue #280): 月報の画面の操作は月報の入口へ、日報の画面の操作は日報の入口へ振り分ける", () => {
  it("月報がある終わった月: 『月報を作り直す』→ 確認 →『作り直す』で POST /api/monthly-reports/run(本文は { month, regenerate: true })。日報の入口には POST しない", async () => {
    const h = await harness("#report=202610");
    h.app.start();
    await h.app.whenIdle();
    expect(h.posts).toEqual([]);
    byClass(h.tree(), "report-regen")[0]!.on!.click!();
    expect(textOf(byClass(h.tree(), "report-regen-confirm")[0]!)).toContain("元に戻せません");
    expect(h.posts).toEqual([]); // 確認を経るまで POST は出ない
    byClass(h.tree(), "report-regen-go")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.posts).toEqual([{ url: "/api/monthly-reports/run", body: { month: "202610", regenerate: true } }]);
    expect(textOf(h.tree())).toContain("月報の作り直しを依頼しました");
  });

  it("月報が無い終わった月: 『この月の月報を作る』で POST /api/monthly-reports/run(本文は { month })", async () => {
    const h = await harness("#report=202607");
    h.app.start();
    await h.app.whenIdle();
    byClass(h.tree(), "report-run")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.posts).toEqual([{ url: "/api/monthly-reports/run", body: { month: "202607" } }]);
  });

  it("日報の画面の『この日の日報を作る』は、従来どおり POST /api/reports/run(月報の入口ではない)", async () => {
    const h = await harness("#report=20261003");
    h.app.start();
    await h.app.whenIdle();
    byClass(h.tree(), "report-run")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.posts).toEqual([{ url: "/api/reports/run", body: { date: "20261003" } }]);
  });

  it("閲覧者には、月報の作成・作り直しのボタンが出ない(月報がある月・無い月のどちらも)", async () => {
    for (const hash of ["#report=202610", "#report=202607"]) {
      const h = await harness(hash, "viewer");
      h.app.start();
      await h.app.whenIdle();
      expect(byClass(h.tree(), "report-run"), hash).toHaveLength(0);
      expect(byClass(h.tree(), "report-regen"), hash).toHaveLength(0);
    }
  });

  it("月報から日報へ移ると、月報の作り直しの確認を持ち越さない", async () => {
    const h = await harness("#report=202610");
    h.app.start();
    await h.app.whenIdle();
    byClass(h.tree(), "report-regen")[0]!.on!.click!();
    expect(byClass(h.tree(), "report-regen-confirm")).toHaveLength(1);
    h.go("#report=20261003");
    await h.app.whenIdle();
    h.go("#report=202610");
    await h.app.whenIdle();
    expect(byClass(h.tree(), "report-regen-confirm")).toHaveLength(0);
    expect(byClass(h.tree(), "report-regen")).toHaveLength(1);
  });
});
