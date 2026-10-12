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
  /** `setHash` に渡された値(日付の入力の操作が書くハッシュ)。 */
  readonly hashes: string[];
  /** 描画の `force`(不正な入力のとき、入力欄を戻すための強制の再描画)の履歴。 */
  readonly forces: boolean[];
  /** 本文の応答(日付 → 呼ばれるたびに先頭から消費。残り 1 つなら繰り返す)。 */
  details: Record<string, Record<string, unknown>[]>;
  list: Record<string, unknown>[];
  tree(): VNode;
  go(hash: string): void;
}

const LIST_ROW = (date: string) => ({ date, created_at: "2026-06-27T11:00:00.000Z", model: null, race_count: 2, total_stake: 100, total_return: 0, summary: null });

async function harness(initialHash: string, role: "admin" | "viewer" = "admin"): Promise<Harness> {
  const calls: string[] = [];
  const hashes: string[] = [];
  const forces: boolean[] = [];
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
      const queue = h.details[m[1]!] ?? [{ ok: true, job_status: "ok", report: null, job: null }];
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
    hashes,
    forces,
    details: { "20260627": [{ ok: true, job_status: "ok", report: reportBody, job: null }] },
    list: [LIST_ROW("20260627")],
    tree: () => latest!,
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
  };
  (h as { app: App }).app = createApp({
    role,
    fetch: fetchLike,
    now: () => new Date("2026-06-28T00:00:00Z"),
    render: (tree, force) => {
      latest = tree;
      forces.push(force === true);
      mounter(tree, force);
    },
    getHash: () => h.hash,
    setHash: (hash) => {
      hashes.push(hash);
    },
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
    // 日付のタイルは無い。リンクは「今日」だけ(一覧は 20260627 の 1 件で、表示中の日が最新かつ最古なので前後は無い)。
    expect(byClass(h.tree(), "tab").map((n) => n.attrs?.["href"])).toEqual(["#report=20260628"]);
    h.go("#report=20260628");
    await h.app.whenIdle();
    expect(h.calls.slice(2)).toEqual(["GET /api/reports/20260628"]);
    expect(byClass(h.tree(), "report-run")).toHaveLength(1);
    expect(textOf(h.tree())).toContain("まだありません");
  });

  it("ボタンで作成を依頼し、作成中は 5 秒ごとに取り直し、日報が現れたら止まる", async () => {
    const h = await harness("#report=20260628");
    const created = { ...(h.details["20260627"]![0]!["report"] as object), date: "20260628" };
    h.details["20260628"] = [{ ok: true, job_status: "ok", report: null, job: null }, { ok: true, job_status: "ok", report: null, job: { phase: "gather", status: "running", attempts: 0 } }, { ok: true, job_status: "ok", report: created, job: null }];
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
    h.details["20260628"] = [{ ok: true, job_status: "ok", report: null, job: { phase: "gather", status: "running", attempts: 0 } }];
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

/**
 * Issue #273: 日報の日付の選択。日付のタイルをやめ、レース一覧と同じ日付の入力(`<input type="date">`)と、前・今日・次のリンクにした。
 * 守ること: 入力の初期値は表示中の日(既定の表示日の選び方は従来どおり〈最新の日報の日、無ければ今日〉)・選ぶと `#report=YYYYMMDD` へ(旧タイルと同じ経路)・不正/空は無視して入力欄を戻す・前後は一覧から。
 */
describe("日報の日付の選択(日付の入力と前・今日・次のリンク。Issue #273)", () => {
  const dateInput = (h: Harness): VNode => findAll(h.tree(), (n) => n.tag === "input" && n.attrs?.["type"] === "date")[0]!;
  const links = (h: Harness) => byClass(h.tree(), "tab").map((n) => [textOf(n), n.attrs?.["href"]]);

  it("入力の初期値は表示中の日: #report は最新の日報の日、日報が 1 件も無ければ今日、#report=日付 はその日(日報の無い日でも)", async () => {
    const latest = await harness("#report");
    latest.list = [LIST_ROW("20260627"), LIST_ROW("20260620")];
    latest.app.start();
    await latest.app.whenIdle();
    expect(dateInput(latest).attrs?.["value"]).toBe("2026-06-27");

    const empty = await harness("#report");
    empty.list = [];
    empty.app.start();
    await empty.app.whenIdle();
    expect(dateInput(empty).attrs?.["value"]).toBe("2026-06-28");

    const dated = await harness("#report=20260615");
    dated.app.start();
    await dated.app.whenIdle();
    expect(dateInput(dated).attrs?.["value"]).toBe("2026-06-15");
  });

  it("入力で日付を選ぶと #report=日付 へ移り(旧タイルのリンクと同じ書式)、そのハッシュで本文だけを取り直す。入力の値と前後のリンクも追従する", async () => {
    const h = await harness("#report");
    h.list = [LIST_ROW("20260627"), LIST_ROW("20260620")];
    h.app.start();
    await h.app.whenIdle();
    dateInput(h).on!.change!("2026-06-20");
    expect(h.hashes).toEqual(["#report=20260620"]);
    h.go(h.hashes[0]!);
    await h.app.whenIdle();
    expect(h.calls.slice(2)).toEqual(["GET /api/reports/20260620"]);
    expect(dateInput(h).attrs?.["value"]).toBe("2026-06-20");
    // 20260620 は最古: 前は無く、次は 20260627、今日は 20260628。
    expect(links(h)).toEqual([["今日", "#report=20260628"], ["次の日報", "#report=20260627"]]);
  });

  it("入力が空・不正(実在しない日)のときは何もせず、強制の再描画で入力欄を表示中の日に戻す", async () => {
    const h = await harness("#report");
    h.app.start();
    await h.app.whenIdle();
    const before = h.forces.length;
    dateInput(h).on!.change!("");
    dateInput(h).on!.change!("2026-02-30");
    expect(h.hashes).toEqual([]);
    expect(h.forces.slice(before)).toEqual([true, true]);
    expect(h.calls).toEqual(["GET /api/reports", "GET /api/reports/20260627"]); // 取得は増えない
  });

  it("前・今日・次のリンク: 日報のある日へ飛ぶ(表示中の日の前後)。今日のリンクは常にあり、端では前/次のリンクが消える", async () => {
    const h = await harness("#report=20260627");
    h.list = [LIST_ROW("20260627"), LIST_ROW("20260620"), LIST_ROW("20260613")];
    h.details["20260620"] = [{ ok: true, job_status: "ok", report: null, job: null }];
    h.app.start();
    await h.app.whenIdle();
    // 前提: 一覧は 3 件で、表示中の日(20260627)は最新。
    expect(h.list).toHaveLength(3);
    expect(links(h)).toEqual([["前の日報", "#report=20260620"], ["今日", "#report=20260628"]]);
    h.go("#report=20260620");
    await h.app.whenIdle();
    expect(links(h)).toEqual([["前の日報", "#report=20260613"], ["今日", "#report=20260628"], ["次の日報", "#report=20260627"]]);
    h.go("#report=20260628");
    await h.app.whenIdle();
    expect(links(h)).toEqual([["前の日報", "#report=20260627"], ["今日", "#report=20260628"]]);
  });
});

describe("Issue #268: アプリ全体の中の『日報を作り直す』", () => {
  it("管理者・日報がある日: ボタン → 確認(やめる/作り直す)→ POST → 作り直し中 → 新しい日報に替わって完了。作成のボタンは出ない", async () => {
    const h = await harness("#report=20260627");
    h.app.start();
    await h.app.whenIdle();
    expect(byClass(h.tree(), "report-run")).toHaveLength(0);
    expect(byClass(h.tree(), "report-regen")).toHaveLength(1);
    // 押すと確認が開く(POST はまだ出ない)。やめると閉じる
    byClass(h.tree(), "report-regen")[0]!.on!.click!();
    expect(byClass(h.tree(), "report-regen-confirm")).toHaveLength(1);
    expect(byClass(h.tree(), "report-regen")).toHaveLength(0);
    expect(h.calls).not.toContain("POST /api/reports/run");
    byClass(h.tree(), "report-regen-cancel")[0]!.on!.click!();
    expect(byClass(h.tree(), "report-regen")).toHaveLength(1);
    expect(h.calls).not.toContain("POST /api/reports/run");
    // もう一度開いて実行する
    byClass(h.tree(), "report-regen")[0]!.on!.click!();
    const first = h.details["20260627"]![0]!;
    h.details["20260627"] = [
      { ...first, job: { phase: "generate", status: "running", attempts: 0, regenerate: true } },
      { ...first, report: { ...(first["report"] as object), created_at: "2026-06-27T13:00:00.000Z" }, job: null },
    ];
    byClass(h.tree(), "report-regen-go")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.calls).toContain("POST /api/reports/run");
    expect(textOf(h.tree())).toContain("日報の作り直しを依頼しました");
    expect(byClass(h.tree(), "report-regen")).toHaveLength(0); // 作り直し中はボタンを出さない
    expect(textOf(h.tree())).toContain("回収率"); // 前の日報の本文は出したまま
    await h.timers.advance(5_000);
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("日報を作り直しました。");
    expect(byClass(h.tree(), "report-regen")).toHaveLength(1);
    expect(h.timers.pending()).toBe(0);
  });

  it("閲覧者: 日報があってもボタンも確認も出ない(対照: 同じ日報で管理者には出る)", async () => {
    for (const role of ["admin", "viewer"] as const) {
      const h = await harness("#report=20260627", role);
      h.app.start();
      await h.app.whenIdle();
      expect(textOf(h.tree()), role).toContain("回収率"); // 日報の本文は閲覧者にも出る
      expect(byClass(h.tree(), "report-regen").length, role).toBe(role === "admin" ? 1 : 0);
    }
  });
});
