import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { Role } from "../client/role";
import type { VNode } from "../client/vnode";
import { createFakeTimers } from "./client-fakes";

/**
 * Issue #559: 一覧の先頭の「次に発走するレース」を、アプリ全体(`createApp`)の中で確かめる。
 * 偽の現在時刻は 2026-06-28 09:00 JST(開催日 20260628 の今日)から、偽のタイマーの進みだけ進む。実リクエストはしない。
 * 見るもの: 時間の経過だけで(取得なしで)次のレースに切り替わる・タイマーは 1 本のまま・全部発走済みでカードが消える・管理者のボタンで POST が出る・区分の切替。
 */

const DATE = "20260628";
const MIN = 60_000;

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown, status = 200): Resp => ({ status, json: async () => body });

const mk = (venue: "central" | "nar", n: number, startTime: string | null) => ({
  race_id: venue === "central" ? `2026020201${String(n).padStart(2, "0")}` : `2026300101${String(n).padStart(2, "0")}`,
  venue_name: venue === "central" ? "福島" : "大井",
  race_number: n,
  race_name: `${venue === "central" ? "福島" : "大井"}${n}R`,
  course_type: "芝",
  distance: 1800,
  entry_count: 16,
  grade: null,
  start_time: startTime,
});
const CENTRAL = [mk("central", 1, "10:00"), mk("central", 2, "11:00"), mk("central", 3, "12:00")];
const NAR = [mk("nar", 1, "09:30"), mk("nar", 2, "20:00")];
const CID = (n: number): string => mk("central", n, null).race_id;

function textOf(node: VNode | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join(" ");
}
function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));

interface Harness {
  readonly app: App;
  readonly timers: ReturnType<typeof createFakeTimers>;
  readonly calls: { method: string; url: string; body: string | undefined }[];
  hash: string;
  tree(): VNode;
  /** カードに出ているレースのラベル(「福島 1R」など)。 */
  cards(): string[];
}

async function started(role: Role, hash: string, board: Record<string, unknown>[] = []): Promise<Harness> {
  const timers = createFakeTimers();
  const calls: Harness["calls"] = [];
  let tree: VNode | null = null;
  const h: Harness = {
    app: undefined as never,
    timers,
    calls,
    hash,
    tree: () => tree!,
    cards: () => byClass(tree!, "next-race").map((n) => textOf(n).slice(0, 6).trim()),
  };
  const fetchLike: FetchLike = async (url, init): Promise<Resp> => {
    calls.push({ method: init.method, url, body: init.body as string | undefined });
    const date = /kaisai_date=(\d{8})/.exec(url)?.[1] ?? DATE;
    if (url.startsWith("/api/races?")) {
      const venue = /venue=(\w+)/.exec(url)![1] as "central" | "nar";
      return ok({ ok: true, kaisai_date: date, venue, races: venue === "central" ? CENTRAL : NAR });
    }
    if (url.startsWith("/api/analyses/status?")) return ok({ ok: true, kaisai_date: date, races: board });
    if (init.method === "POST" && url === "/api/analyses/run") {
      const body = JSON.parse(init.body as string) as { race_id: string; kaisai_date: string; mode: string };
      return ok({ ok: true, accepted: true, race_id: body.race_id, kaisai_date: body.kaisai_date, mode: body.mode, status: "queued" }, 202);
    }
    throw new Error(`想定外の要求: ${init.method} ${url}`);
  };
  (h as { app: App }).app = createApp({
    role,
    fetch: fetchLike,
    now: () => new Date(Date.parse("2026-06-28T00:00:00Z") + timers.now()),
    render: (t) => {
      tree = t;
    },
    getHash: () => h.hash,
    setHash: (x) => {
      h.hash = x;
    },
    timers: { set: timers.set, clear: timers.clear },
    isVisible: () => true,
  });
  h.app.start();
  await h.app.whenIdle();
  await timers.flush();
  return h;
}

const gets = (h: Harness): string[] => h.calls.filter((c) => c.method === "GET").map((c) => c.url);
const boardRow = (raceId: string, status: string): Record<string, unknown> => ({ race_id: raceId, mode: "pre_race", status, attempts: 0, error: null, queued_at: 1, updated_at: 2, prior: false, analysis_id: status === "done" ? 5 : null });

describe("一覧: 次に発走するレースのカード(Issue #559。アプリ全体)", () => {
  it("開いた時点(09:00)は 1R。時間が進むと、取得なしで 2R → 3R と切り替わり、全部発走済みでカードが消える。タイマーは常に 1 本以下", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    expect(h.cards()).toEqual(["福島 1R"]);
    const before = gets(h);
    expect(before).toHaveLength(2); // 前提: 取得は一覧と板の 2 回だけ
    expect(h.timers.pending()).toBe(1);
    await h.timers.advance(61 * MIN); // 10:01
    expect(h.cards()).toEqual(["福島 2R"]);
    expect(textOf(byClass(h.tree(), "next-race")[0]!)).toContain("あと59分");
    expect(h.timers.pending()).toBe(1);
    await h.timers.advance(60 * MIN); // 11:01
    expect(h.cards()).toEqual(["福島 3R"]);
    expect(h.timers.pending()).toBe(1);
    await h.timers.advance(60 * MIN); // 12:01
    expect(h.cards()).toEqual([]);
    expect(byClass(h.tree(), "next-races")).toHaveLength(0);
    expect(h.timers.pending()).toBe(0); // 全部発走済み: 時計は止まる
    expect(gets(h)).toEqual(before); // 時間の経過だけで、取得は増えない
  });

  it("残り時間の文言は 30 秒の時計で更新される(09:00 → 09:31 に「あと29分」)", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    expect(textOf(byClass(h.tree(), "next-race")[0]!)).toContain("あと1時間");
    await h.timers.advance(31 * MIN);
    expect(textOf(byClass(h.tree(), "next-race")[0]!)).toContain("あと29分");
  });

  it("管理者がボタンを押すと POST /api/analyses/run が 1 回出る(pre_race・そのレース・今日の日付)", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    const b = byClass(h.tree(), "run")[0]!;
    expect(b.attrs?.["disabled"]).toBe(false);
    b.on!.click!();
    await h.app.whenIdle();
    const posts = h.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/analyses/run");
    expect(JSON.parse(posts[0]!.body!)).toEqual({ race_id: CID(1), kaisai_date: DATE, mode: "pre_race" });
  });

  it("押した直後は「送信中…」で押せない(二重押しを防ぐ)。受理されると板が待ちになりボタンは「待ち」で押せない", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    byClass(h.tree(), "run")[0]!.on!.click!();
    expect(textOf(byClass(h.tree(), "run")[0]!)).toBe("送信中…"); // 同期の印
    expect(byClass(h.tree(), "run")[0]!.attrs?.["disabled"]).toBe(true);
    await h.app.whenIdle();
    await h.timers.flush();
    expect(textOf(byClass(h.tree(), "run")[0]!)).toBe("待ち");
    expect(byClass(h.tree(), "run")[0]!.attrs?.["disabled"]).toBe(true);
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("閲覧者: カードは出る(バッジ・リンク)が、ボタンはなく、POST も出ない", async () => {
    const h = await started("viewer", `#date=${DATE}&venue=central`);
    expect(h.cards()).toEqual(["福島 1R"]);
    expect(byClass(h.tree(), "run")).toHaveLength(0);
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("発走前の分析が完了しているレースは、ボタンなし(管理者でも)。バッジは「完了」", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`, [boardRow(CID(1), "done")]);
    expect(h.cards()).toEqual(["福島 1R"]);
    expect(byClass(h.tree(), "run")).toHaveLength(0);
    expect(textOf(byClass(h.tree(), "next-race")[0]!)).toContain("発走前: 完了");
  });

  it.each([
    ["過去の開催日", "20260627"],
    ["未来の開催日", "20260629"],
  ])("%s: カードを出さない(前提: 一覧は出ている)", async (_label, date) => {
    const h = await started("admin", `#date=${date}&venue=central`);
    expect(byClass(h.tree(), "race")).toHaveLength(3);
    expect(byClass(h.tree(), "next-races")).toHaveLength(0);
  });

  it("区分を替えると、その区分の一覧だけから導かれる(地方は 09:30 の大井 1R)。その区分の一覧が未取得なら取りに行くのは一覧の通常の取得だけ", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    expect(h.cards()).toEqual(["福島 1R"]);
    const central = gets(h);
    expect(central).toHaveLength(2); // 前提: 開いていない地方の一覧は取っていない(カードのために取得を増やさない)
    expect(central.some((u) => u.includes("venue=nar"))).toBe(false);
    h.hash = `#date=${DATE}&venue=nar`;
    h.app.onHashChange();
    await h.app.whenIdle();
    await h.timers.flush();
    expect(h.cards()).toEqual(["大井 1R"]);
    const added = gets(h).slice(central.length);
    expect(added.filter((u) => u.startsWith("/api/races?"))).toEqual([`/api/races?kaisai_date=${DATE}&venue=nar`]); // 地方を開いたときの通常の取得 1 回
    expect(added.filter((u) => u.startsWith("/api/races?") && u.includes("venue=central"))).toHaveLength(0);
  });

  it("レース画面へ移るとカードもタイマーも無く、一覧へ戻ると出る", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    h.hash = `#date=${DATE}&venue=central&race=${CID(2)}`;
    h.app.onHashChange();
    await h.app.whenIdle();
    await h.timers.flush();
    expect(byClass(h.tree(), "next-races")).toHaveLength(0);
    expect(h.timers.pending()).toBe(0);
    h.hash = `#date=${DATE}&venue=central`;
    h.app.onHashChange();
    await h.app.whenIdle();
    await h.timers.flush();
    expect(h.cards()).toEqual(["福島 1R"]);
    expect(h.timers.pending()).toBe(1);
  });
});
