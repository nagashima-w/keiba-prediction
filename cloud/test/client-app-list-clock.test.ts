import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { Role } from "../client/role";
import type { VNode } from "../client/vnode";
import { createFakeTimers } from "./client-fakes";

/**
 * Issue #346: 一覧の発走済みを下へ回す。アプリ全体(`createApp`)の中で、時間の経過だけで(取得なしで)並びが変わること・タイマーの出入り・管理者の操作が壊れないこと。
 * 偽の現在時刻は 2026-06-28 09:00 JST(開催日 20260628 の今日)から、偽のタイマーの進みだけ進む。実リクエストはしない。
 */

const DATE = "20260628";
const MIN = 60_000;
const RACES_URL = `/api/races?kaisai_date=${DATE}&venue=central`;
const BOARD_URL = `/api/analyses/status?kaisai_date=${DATE}`;
const BULK_URL = "/api/analyses/run/bulk";

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown, status = 200): Resp => ({ status, json: async () => body });

const jrace = (n: number, startTime: string | null) => ({
  race_id: `2026020201${String(n).padStart(2, "0")}`,
  venue_name: "福島",
  race_number: n,
  race_name: `福島${n}R`,
  course_type: "芝",
  distance: 1800,
  entry_count: 16,
  grade: null,
  start_time: startTime,
});
// 福島 4 レース(10:00・11:00・12:00・時刻不明)。開始時点(09:00)ではどれも未発走。
const RACES = [jrace(1, "10:00"), jrace(2, "11:00"), jrace(3, "12:00"), jrace(4, null)];
const ID = (n: number): string => `2026020201${String(n).padStart(2, "0")}`;

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
  visible: boolean;
  tree(): VNode;
  /** 一覧の行の並び(レース番号)と past の印。 */
  order(): { n: number; past: boolean }[];
}

async function started(role: Role, hash: string, races = RACES): Promise<Harness> {
  const timers = createFakeTimers();
  const calls: Harness["calls"] = [];
  let tree: VNode | null = null;
  const h: Harness = {
    app: undefined as never,
    timers,
    calls,
    hash,
    visible: true,
    tree: () => tree!,
    order: () =>
      byClass(tree!, "race").map((n) => ({ n: Number(String(n.attrs?.["href"]).slice(-2)), past: String(n.attrs?.["class"]).split(" ").includes("started") })),
  };
  const fetchLike: FetchLike = async (url, init): Promise<Resp> => {
    calls.push({ method: init.method, url, body: init.body as string | undefined });
    const date = /kaisai_date=(\d{8})/.exec(url)?.[1] ?? DATE;
    if (url.startsWith("/api/races?")) return ok({ ok: true, kaisai_date: date, venue: "central", races });
    if (url.startsWith("/api/analyses/status?")) return ok({ ok: true, kaisai_date: date, races: [] });
    if (init.method === "POST" && url === BULK_URL) {
      const body = JSON.parse(init.body as string) as { kaisai_date: string; mode: string; race_ids: string[] };
      return ok({ ok: true, accepted: true, kaisai_date: body.kaisai_date, mode: body.mode, results: body.race_ids.map((id) => ({ race_id: id, result: "accepted" })) }, 202);
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
    isVisible: () => h.visible,
  });
  h.app.start();
  await h.app.whenIdle();
  await timers.flush();
  return h;
}

const gets = (h: Harness): string[] => h.calls.filter((c) => c.method === "GET").map((c) => c.url);
const nums = (h: Harness): number[] => h.order().map((r) => r.n);

describe("一覧: 時間の経過で発走済みが下へ回る(Issue #346)", () => {
  it("開いた時点(09:00)は全部が未発走で R 順。10:01 になると、取得なしで 1R が発走済みとして末尾へ回り薄くなる", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    expect(nums(h)).toEqual([1, 2, 3, 4]); // 前提: 開いた時点の並び
    expect(h.order().some((r) => r.past)).toBe(false);
    const before = gets(h);
    expect(before).toEqual([RACES_URL, BOARD_URL]); // 前提: 取得はこの 2 回
    expect(h.timers.pending()).toBe(1); // 前提: 並べ替えのタイマーが張られている
    await h.timers.advance(61 * MIN);
    expect(nums(h)).toEqual([2, 3, 4, 1]);
    expect(h.order().map((r) => r.past)).toEqual([false, false, false, true]);
    expect(gets(h)).toEqual(before); // 時間の経過だけで、取得は増えない
    expect(h.timers.pending()).toBe(1); // まだ未発走(2R・3R)があるので続く
  });

  it("時刻のあるレースが全部発走済みになると、並べ替えの再描画のタイマーは止まる(時刻不明の 4R は未発走のまま先頭)", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    await h.timers.advance(3 * 60 * MIN + MIN); // 12:01
    expect(nums(h)).toEqual([4, 1, 2, 3]);
    expect(h.order().map((r) => r.past)).toEqual([false, true, true, true]);
    expect(h.timers.pending()).toBe(0);
  });

  it("閲覧者でも同じに並び替わる", async () => {
    const h = await started("viewer", `#date=${DATE}&venue=central`);
    await h.timers.advance(61 * MIN);
    expect(nums(h)).toEqual([2, 3, 4, 1]);
    expect(byClass(h.tree(), "bulk")).toHaveLength(0); // 前提: 閲覧者に一括実行は無い
  });

  it.each([
    ["過去の開催日", "20260627"],
    ["未来の開催日", "20260629"],
  ])("%s: タイマーを張らず、並びは元のまま・薄くしない", async (_name, date) => {
    const h = await started("admin", `#date=${date}&venue=central`, RACES);
    expect(nums(h)).toEqual([1, 2, 3, 4]); // 前提: 一覧は出ている(取得に失敗して空のまま、ではない)
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(5 * 60 * MIN);
    expect(nums(h)).toEqual([1, 2, 3, 4]);
    expect(h.order().some((r) => r.past)).toBe(false);
  });

  it("日付を過去へ移ると、張っていたタイマーが止まる。今日へ戻ると再び張る", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    expect(h.timers.pending()).toBe(1); // 前提
    h.hash = "#date=20260627&venue=central";
    h.app.onHashChange();
    await h.app.whenIdle();
    await h.timers.flush();
    expect(h.timers.pending()).toBe(0);
    h.hash = `#date=${DATE}&venue=central`;
    h.app.onHashChange();
    await h.app.whenIdle();
    await h.timers.flush();
    expect(h.timers.pending()).toBe(1);
  });

  it("一覧からレース詳細へ移ると、タイマーが止まる(詳細の画面では並べ替えの再描画をしない)。一覧へ戻ると再び張る", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    expect(h.timers.pending()).toBe(1); // 前提: 一覧では張っている
    expect(nums(h)).toEqual([1, 2, 3, 4]); // 前提: 一覧が出ている
    h.hash = `#date=${DATE}&venue=central&race=${ID(2)}`;
    h.app.onHashChange();
    await h.app.whenIdle();
    await h.timers.flush();
    expect(nums(h)).toEqual([]); // 前提: 一覧の行は無い=詳細の画面に移っている
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(61 * MIN);
    expect(h.timers.pending()).toBe(0); // 時間が経っても張り直されない
    h.hash = `#date=${DATE}&venue=central`;
    h.app.onHashChange();
    await h.app.whenIdle();
    await h.timers.flush();
    expect(nums(h)).toEqual([2, 3, 4, 1]); // 戻った時点(10:01)の並び
    expect(h.timers.pending()).toBe(1);
  });

  it("画面が見えない間はタイマーを止め、見えるようになったらすぐ今の時刻で並べ直して張り直す", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    expect(h.timers.pending()).toBe(1); // 前提
    h.visible = false;
    h.app.onVisibilityChange();
    expect(h.timers.pending()).toBe(0);
    await h.timers.advance(61 * MIN);
    expect(nums(h)).toEqual([1, 2, 3, 4]); // 隠れている間は再描画しない
    h.visible = true;
    h.app.onVisibilityChange();
    expect(nums(h)).toEqual([2, 3, 4, 1]); // 見えた時点で 10:01 の並び
    expect(h.timers.pending()).toBe(1);
  });

  it("管理者の確認画面は、並べ替えのあとも残る(対象は押した時点のまま)。実行すると、そのときの未発走だけを R 順で送る", async () => {
    const h = await started("admin", `#date=${DATE}&venue=central`);
    byClass(h.tree(), "bulk-run").filter((b) => b.attrs?.["data-mode"] === "pre_race")[0]!.on!.click!();
    await h.timers.flush();
    const panelText = (): string => byClass(h.tree(), "bulk-panel").map(textOf).join(" ");
    expect(panelText()).toContain("対象: 3 レース"); // 前提: 時刻不明の 4R を除く 3 レース
    await h.timers.advance(61 * MIN); // 1R が発走済みになり、並びが変わる
    expect(nums(h)).toEqual([2, 3, 4, 1]); // 前提: 並べ替わった
    expect(panelText()).toContain("対象: 3 レース"); // 確認画面は消えず、件数も変わらない
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    byClass(h.tree(), "bulk-go")[0]!.on!.click!();
    await h.app.whenIdle();
    const posts = h.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect((JSON.parse(posts[0]!.body!) as { race_ids: string[] }).race_ids).toEqual([ID(2), ID(3)]);
  });
});
