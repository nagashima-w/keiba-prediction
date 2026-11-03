import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { Role } from "../client/role";
import type { VNode } from "../client/vnode";
import { deferred } from "./client-fakes";

/**
 * Issue #572: 一覧の「最終更新」。アプリ全体(`createApp`)の中で、取得に成功した時刻(端末の時計。JST で表示)が、一覧と板の古いほうとして出ること。
 *  - 時刻は取得の完了時の `now`(取得を出した時刻ではない)。時間が進んでも、取得なしでは変わらない
 *  - 「更新」で消え、取り直しが成功した時刻になる。失敗なら出ない
 *  - 中央 → 地方の切替(一覧は新しく取り、板はキャッシュのまま)では、古い板の時刻が出る(一覧だけで決める案 A なら新しい時刻が出てしまう)
 *  - レース画面から取った一覧(Issue #571)の時刻も、一覧へ戻ったとき実際の取得時刻のまま出る
 * 偽の現在時刻は手で進める。実リクエストはしない。
 */

const DATE = "20260628";
const RACES_CENTRAL = `/api/races?kaisai_date=${DATE}&venue=central`;
const RACES_NAR = `/api/races?kaisai_date=${DATE}&venue=nar`;
const BOARD = `/api/analyses/status?kaisai_date=${DATE}`;
const RACE_ID = "202603020211";
const RACE_STATUS = `${BOARD}&race_id=${RACE_ID}`;
const PAST = `/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE}&limit=20`;

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
const fail503: Resp = { status: 503, json: async () => ({ ok: false, error: { type: "race-day-error", message: "サーバの文面" } }) };
const raceRow = (raceId: string) => ({ race_id: raceId, venue_name: "福島", race_number: Number(raceId.slice(-2)), race_name: "福島民報杯", course_type: "芝", distance: 1800, entry_count: 16, grade: null, start_time: "20:00" });
const racesBody = (venue: string, ids: string[]) => ({ ok: true, kaisai_date: DATE, venue, races: ids.map(raceRow) });
const boardBody = { ok: true, kaisai_date: DATE, races: [] };

/** JST 09:00 = UTC 00:00。分で進める。 */
const BASE = Date.parse("2026-06-28T00:00:00Z");
const at = (hh: number, mm: number): number => BASE + ((hh - 9) * 60 + mm) * 60_000;

function textOf(node: VNode | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join(" ");
}
function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (t: VNode, cls: string): VNode[] => findAll(t, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));

interface Harness {
  readonly app: App;
  readonly calls: string[];
  readonly responders: Map<string, () => Promise<Resp>>;
  hash: string;
  clock: { ms: number };
  tree(): VNode;
  /** 最終更新の行の文言(無ければ null)。 */
  updated(): string | null;
  go(hash: string): void;
}

function harness(role: Role, hash: string, startMs = at(9, 0)): Harness {
  const responders = new Map<string, () => Promise<Resp>>([
    [RACES_CENTRAL, async () => ok(racesBody("central", [RACE_ID, "202603020212"]))],
    [RACES_NAR, async () => ok(racesBody("nar", ["202654062801"]))],
    [BOARD, async () => ok(boardBody)],
    [RACE_STATUS, async () => ok({ ok: true, kaisai_date: DATE, races: [], prior: null })],
    [PAST, async () => ok({ ok: true, analyses: [] })],
  ]);
  const calls: string[] = [];
  let tree: VNode | null = null;
  const clock = { ms: startMs };
  const fetchLike: FetchLike = (url) => {
    calls.push(url);
    const responder = responders.get(url);
    if (responder === undefined) throw new Error(`想定外の取得: ${url}`);
    return responder();
  };
  const h: Harness = {
    app: undefined as never,
    calls,
    responders,
    hash,
    clock,
    tree: () => tree!,
    updated: () => {
      const lines = byClass(tree!, "list-updated");
      return lines.length === 0 ? null : textOf(lines[0]!);
    },
    go: (next) => {
      h.hash = next;
      h.app.onHashChange();
    },
  };
  (h as { app: App }).app = createApp({
    role,
    fetch: fetchLike,
    now: () => new Date(clock.ms),
    render: (t) => {
      tree = t;
    },
    getHash: () => h.hash,
    setHash: (x) => {
      h.hash = x;
    },
    timers: { set: () => 0, clear: () => {} },
    isVisible: () => true,
  });
  return h;
}

const refreshButton = (h: Harness): VNode => findAll(h.tree(), (n) => n.tag === "button" && String(n.attrs?.["class"]) === "refresh")[0]!;

describe("一覧の最終更新(Issue #572)", () => {
  it("取得の完了時の時刻が出る(出した時刻ではない)。一覧が 09:03・板が 09:05 に届くと、古いほうの 09:03", async () => {
    const h = harness("admin", `#date=${DATE}&venue=central`);
    const races = deferred<Resp>();
    const board = deferred<Resp>();
    h.responders.set(RACES_CENTRAL, () => races.promise);
    h.responders.set(BOARD, () => board.promise);
    h.app.start();
    expect(h.updated()).toBeNull(); // 取得前は出ない
    expect(textOf(byClass(h.tree(), "empty")[0]!)).toBe("読み込み中…"); // 一覧が読み込み中の本文
    h.clock.ms = at(9, 3);
    races.resolve(ok(racesBody("central", [RACE_ID])));
    await Promise.all([races.promise]);
    await new Promise<void>((r) => setImmediate(r));
    expect(h.updated(), "板がまだ届いていないときは、一覧の時刻").toBe("最終更新 09:03");
    h.clock.ms = at(9, 5);
    board.resolve(ok(boardBody));
    await h.app.whenIdle();
    expect(h.updated(), "板のほうが新しいので、古い一覧の時刻のまま").toBe("最終更新 09:03");
    expect(byClass(h.tree(), "empty")).toHaveLength(0); // 読み込み中の本文は消えた
  });

  it("板が先に届いて古い(09:01)ときは、板の時刻 09:01 が出る(新しいほうの一覧 09:04 ではなく)", async () => {
    const h = harness("admin", `#date=${DATE}&venue=central`);
    const races = deferred<Resp>();
    h.responders.set(RACES_CENTRAL, () => races.promise);
    h.app.start();
    h.clock.ms = at(9, 1);
    await new Promise<void>((r) => setImmediate(r)); // 板が 09:01 に届く
    h.clock.ms = at(9, 4);
    races.resolve(ok(racesBody("central", [RACE_ID])));
    await h.app.whenIdle();
    expect(h.updated()).toBe("最終更新 09:01");
  });

  it("時間が進んでも、取得なしでは時刻は変わらず、取得も増えない。閲覧者にも出る", async () => {
    for (const role of ["admin", "viewer"] as const) {
      const h = harness(role, `#date=${DATE}&venue=central`);
      h.app.start();
      await h.app.whenIdle();
      expect(h.updated()).toBe("最終更新 09:00");
      const before = [...h.calls];
      h.clock.ms = at(9, 40);
      h.app.onVisibilityChange(); // 再描画
      expect(h.updated()).toBe("最終更新 09:00");
      expect(h.calls).toEqual(before);
    }
  });

  it("「更新」: 取り直しの間は消えて『読み込み中…』、届いたら取り直しが成功した時刻(10:00)になる", async () => {
    const h = harness("admin", `#date=${DATE}&venue=central`);
    h.app.start();
    await h.app.whenIdle();
    expect(h.updated()).toBe("最終更新 09:00"); // 前提
    h.clock.ms = at(10, 0);
    const races = deferred<Resp>();
    h.responders.set(RACES_CENTRAL, () => races.promise);
    refreshButton(h).on!.click!();
    expect(h.updated()).toBeNull();
    expect(textOf(byClass(h.tree(), "empty")[0]!)).toBe("読み込み中…");
    races.resolve(ok(racesBody("central", [RACE_ID])));
    await h.app.whenIdle();
    expect(h.updated()).toBe("最終更新 10:00");
  });

  it("「更新」が失敗したら、最終更新は出ない(エラーの注記だけ。前の時刻は残さない)", async () => {
    const h = harness("admin", `#date=${DATE}&venue=central`);
    h.app.start();
    await h.app.whenIdle();
    expect(h.updated()).toBe("最終更新 09:00"); // 前提
    h.responders.set(RACES_CENTRAL, async () => fail503);
    refreshButton(h).on!.click!();
    await h.app.whenIdle();
    expect(h.updated()).toBeNull();
    expect(byClass(h.tree(), "notice").some((n) => String(n.attrs?.["class"]).includes("error"))).toBe(true);
  });

  it("初回の一覧が失敗したら出ない", async () => {
    const h = harness("admin", `#date=${DATE}&venue=central`);
    h.responders.set(RACES_CENTRAL, async () => fail503);
    h.app.start();
    await h.app.whenIdle();
    expect(h.updated()).toBeNull();
  });

  it("板だけが失敗したときは、板を数えず一覧の時刻が出る(バッジの注記は別に出る)", async () => {
    const h = harness("admin", `#date=${DATE}&venue=central`);
    h.responders.set(BOARD, async () => fail503);
    h.app.start();
    await h.app.whenIdle();
    expect(h.updated()).toBe("最終更新 09:00");
    expect(byClass(h.tree(), "notice").length).toBeGreaterThan(0); // 前提: 板の失敗の注記
  });

  it("開催が 0 件でも出る", async () => {
    const h = harness("admin", `#date=${DATE}&venue=central`);
    h.responders.set(RACES_CENTRAL, async () => ok(racesBody("central", [])));
    h.app.start();
    await h.app.whenIdle();
    expect(byClass(h.tree(), "empty").map(textOf)).toEqual(["この日・この区分の開催はありません。"]); // 前提: 空
    expect(h.updated()).toBe("最終更新 09:00");
  });

  it("案 A(一覧の時刻だけ)を殺す: 中央 09:00 に開き、09:30 に地方へ切り替えると、新しい地方の一覧(09:30)ではなく、キャッシュのままの板の時刻 09:00 が出る", async () => {
    const h = harness("admin", `#date=${DATE}&venue=central`);
    h.app.start();
    await h.app.whenIdle();
    expect(h.updated()).toBe("最終更新 09:00"); // 前提
    h.clock.ms = at(9, 30);
    h.go(`#date=${DATE}&venue=nar`);
    await h.app.whenIdle();
    expect(h.calls.filter((u) => u === RACES_NAR)).toHaveLength(1); // 前提: 地方の一覧は 09:30 に取った
    expect(h.calls.filter((u) => u === BOARD)).toHaveLength(1); // 前提: 板は取り直していない
    expect(h.updated()).toBe("最終更新 09:00");
    // 中央へ戻ると、中央の一覧は 09:00 のまま
    h.go(`#date=${DATE}&venue=central`);
    expect(h.updated()).toBe("最終更新 09:00");
  });

  it("日付をまたぐ: 前日(JST)の 23:50 に取った一覧は、翌日(JST)の 00:10 に見ると『6/28 23:50』", async () => {
    const h = harness("admin", `#date=${DATE}&venue=central`, Date.parse("2026-06-28T14:50:00Z")); // JST 23:50
    h.app.start();
    await h.app.whenIdle();
    expect(h.updated()).toBe("最終更新 23:50");
    h.clock.ms = Date.parse("2026-06-28T15:10:00Z"); // JST 6/29 00:10
    h.app.onVisibilityChange();
    expect(h.updated()).toBe("最終更新 6/28 23:50");
  });

  it("レース画面で取った一覧(Issue #571)の時刻が、一覧へ戻ったときそのまま出る(取り直さない)", async () => {
    const h = harness("admin", `#date=${DATE}&venue=central&race=${RACE_ID}`);
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toContain(RACES_CENTRAL); // 前提: レース画面が一覧を取った(09:00)
    h.clock.ms = at(9, 20);
    h.go(`#date=${DATE}&venue=central`);
    await h.app.whenIdle();
    expect(h.updated()).toBe("最終更新 09:00");
    expect(h.calls.filter((u) => u === RACES_CENTRAL)).toHaveLength(1);
    expect(h.calls.filter((u) => u === BOARD)).toHaveLength(0); // 板はレース画面の status 取得(race_id 付き)で届いているので、取り直さない
  });
});
