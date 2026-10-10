import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import { createMounter, type DomDocument } from "../client/dom";
import type { VNode } from "../client/vnode";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { buildSavedRecord } from "./daily-report-fixtures";
import { createFakeTimers } from "./client-fakes";
import { CREATE_CAUTION, CREATE_TODAY_CAUTION } from "../client/report-model";

/**
 * Issue #235: アプリ全体の中の日報画面(`#report`・`#report=YYYYMMDD`)。画面の出入り・他の画面との分離・日付の切替・手動の作成・作成中のポーリング・離れたときの停止。
 * 守ること:
 *  - 日報画面は `GET /api/reports` と `GET /api/reports/{date}` だけを取る(一覧・板・設定・レース・分析・検証は取らない)。他の画面は `/api/reports` を取らない
 *  - 作成中だけ自動で取り直し、離れると止まる。遅れて届く応答は今の画面に反映しない
 * 今日は 2026-06-28(JST)。
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
  readonly timers: ReturnType<typeof createFakeTimers>;
  hash: string;
  /** 本文の応答(日付 → 呼ばれるたびに先頭から消費。残り 1 つなら繰り返す)。 */
  details: Record<string, Record<string, unknown>[]>;
  list: Record<string, unknown>[];
  tree(): VNode;
  go(hash: string): void;
}

const LIST_ROW = (date: string) => ({ date, created_at: "2026-06-27T11:00:00.000Z", model: null, race_count: 2, total_stake: 100, total_return: 0, summary: null });

async function harness(initialHash: string): Promise<Harness> {
  const calls: string[] = [];
  const timers = createFakeTimers();
  let latest: VNode | null = null;
  const doc: DomDocument = { createElement: (tag) => new FakeElement(tag) as never, createTextNode: (t) => new FakeText(t) };
  const mounter = createMounter(doc, { replaceChildren: () => {} });
  const record = await buildSavedRecord();
  const reportBody = { date: "20260627", created_at: record.createdAt, model: record.model, race_count: record.raceCount, total_stake: record.totalStake, total_return: record.totalReturn, summary: record.summary, body: record.body };
  const fetchLike: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url === "/api/reports" && init.method === "GET") return ok({ ok: true, reports: h.list });
    const m = /^\/api\/reports\/(\d{8})$/.exec(url);
    if (m !== null && init.method === "GET") {
      const queue = h.details[m[1]!] ?? [{ ok: true, report: null, job: null }];
      return ok(queue.length > 1 ? queue.shift()! : queue[0]!);
    }
    if (url === "/api/reports/run" && init.method === "POST") return { status: 202, json: async () => ({ ok: true, accepted: true, date: JSON.parse(init.body as string).date }) };
    if (url === "/api/settings" && init.method === "GET") return ok({ ok: true, settings: DEFAULT_CLOUD_SETTINGS, source: "d1" });
    throw new Error(`想定外の取得: ${init.method} ${url}`);
  };
  const h: Harness = {
    app: undefined as never,
    calls,
    timers,
    hash: initialHash,
    details: { "20260627": [{ ok: true, report: reportBody, job: null }] },
    list: [LIST_ROW("20260627")],
    tree: () => latest!,
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
  };
  (h as { app: App }).app = createApp({
    fetch: fetchLike,
    now: () => new Date("2026-06-28T00:00:00Z"),
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

describe("日報画面を開く", () => {
  it("#report で始めると、一覧を取り、最新の日報の日の本文を取る(一覧・板・設定・分析は取らない)。最初の描画は「読み込み中…」", async () => {
    const h = await harness("#report");
    h.app.start();
    expect(textOf(h.tree())).toContain("読み込み中…");
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/reports", "GET /api/reports/20260627"]);
    expect(textOf(byClass(h.tree(), "title")[0]!)).toBe("日報");
    expect(textOf(h.tree())).toContain("2026年6月27日(土)の日報");
    expect(textOf(h.tree())).toContain("回収率");
  });

  it("日付のリンク(#report=日付)で同じ画面の中の日付を替えると、本文だけを取り直す。日報の無い日は作成のボタンが出る", async () => {
    const h = await harness("#report");
    h.app.start();
    await h.app.whenIdle();
    const chips = byClass(h.tree(), "tab").map((n) => n.attrs?.["href"]);
    expect(chips).toEqual(["#report=20260628", "#report=20260627"]);
    h.go("#report=20260628");
    await h.app.whenIdle();
    expect(h.calls.slice(2)).toEqual(["GET /api/reports/20260628"]);
    expect(byClass(h.tree(), "report-run")).toHaveLength(1);
    expect(textOf(h.tree())).toContain("まだありません");
  });

  it("ボタンで作成を依頼し、作成中は 5 秒ごとに取り直し、日報が現れたら止まる", async () => {
    const h = await harness("#report=20260628");
    const created = { ...(h.details["20260627"]![0]!["report"] as object), date: "20260628" };
    h.details["20260628"] = [{ ok: true, report: null, job: null }, { ok: true, report: null, job: { phase: "gather", status: "running", attempts: 0 } }, { ok: true, report: created, job: null }];
    h.app.start();
    await h.app.whenIdle();
    byClass(h.tree(), "report-run")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.calls).toContain("POST /api/reports/run");
    expect(byClass(h.tree(), "report-run")).toHaveLength(0);
    expect(textOf(h.tree())).toContain("作成");
    await h.timers.advance(5_000);
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("2026年6月28日(日)の日報");
    expect(h.timers.pending()).toBe(0);
  });

  it("R3: 作成のボタンの手前に確定の注意が出る。今日の日付のときだけ強めの注意も出る", async () => {
    const today = await harness("#report=20260628"); // 今日 = 2026-06-28
    today.app.start();
    await today.app.whenIdle();
    const text = textOf(today.tree());
    expect(text).toContain(CREATE_CAUTION);
    expect(text).toContain(CREATE_TODAY_CAUTION);
    // 注意は、ボタンより前(押す前に読める位置)にある
    const flat = findAll(today.tree(), () => true).map((n) => String(n.attrs?.["class"] ?? ""));
    expect(flat.indexOf("meta report-caution")).toBeGreaterThan(-1);
    expect(flat.indexOf("meta report-caution")).toBeLessThan(flat.indexOf("report-run"));
    const past = await harness("#report=20260620");
    past.app.start();
    await past.app.whenIdle();
    expect(textOf(past.tree())).toContain(CREATE_CAUTION);
    expect(textOf(past.tree())).not.toContain(CREATE_TODAY_CAUTION);
  });

  it("R1: 分析が 0 件の日にボタンを押すと、作られずに終わった案内が出て、確認の自動更新は止まる", async () => {
    const h = await harness("#report=20260628");
    h.app.start();
    await h.app.whenIdle();
    byClass(h.tree(), "report-run")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("分析したレースが無いため、日報は作られませんでした");
    expect(byClass(h.tree(), "report-run")).toHaveLength(0);
    expect(h.timers.pending()).toBe(0);
  });

  it("離れると止まり(タイマー・取得)、他の画面は /api/reports を取らない。戻ると取り直す", async () => {
    const h = await harness("#report=20260628");
    h.details["20260628"] = [{ ok: true, report: null, job: { phase: "gather", status: "running", attempts: 0 } }];
    h.app.start();
    await h.app.whenIdle();
    expect(h.timers.pending()).toBe(1);
    h.go("#settings");
    await h.app.whenIdle();
    await h.timers.advance(60_000);
    expect(h.timers.pending()).toBe(0);
    expect(h.calls.filter((c) => c.includes("/api/reports"))).toHaveLength(2); // 開いたときの一覧と本文だけ(離れたあとは増えない)
    h.go("#report=20260628");
    await h.app.whenIdle();
    expect(h.calls.filter((c) => c.includes("/api/reports"))).toHaveLength(4);
  });

  it("一覧(トップ)に日報への入口のリンクがあり、ハッシュは #report", async () => {
    const h = await harness("");
    h.app.start();
    const link = byClass(h.tree(), "report-link")[0]!;
    expect(link.attrs?.["href"]).toBe("#report");
    expect(textOf(link)).toBe("日報");
  });
});
