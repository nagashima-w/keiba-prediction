import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { Role } from "../client/role";
import type { VNode } from "../client/vnode";
import { deferred } from "./client-fakes";

/**
 * Issue #571: レース画面・結果画面のパンくずと前後のレース。一覧(`GET /api/races`)の取得の配線(`race-data.ts`)を、`createApp` を通して固定する。
 * ユーザーの決定: レース画面・結果画面を開いたとき、その (開催日, 区分) の一覧がキャッシュに無ければ**一覧を取りに行って**前後を出す(一覧の画面と同じ取得の口。二重に取らない)。
 * 取得中・失敗のときは前後を出さない(パンくずは出す)。失敗で画面のほかの部分を壊さない・エラーの表示を増やさない・自動で再試行しない。板(race_id なし)は取らない。
 * 今日は 2026-06-28(JST)。
 */

const DATE = "20260628";
const OTHER_DATE = "20260621";
const RACE_ID = "202603020211";
const RACES_CENTRAL = `/api/races?kaisai_date=${DATE}&venue=central`;
const RACES_NAR = `/api/races?kaisai_date=${DATE}&venue=nar`;
const RACES_OTHER = `/api/races?kaisai_date=${OTHER_DATE}&venue=central`;
const BOARD = `/api/analyses/status?kaisai_date=${DATE}`;
const statusUrl = (raceId: string) => `${BOARD}&race_id=${raceId}`;
const pastUrl = (raceId: string, date = DATE) => `/api/analyses?race_id=${raceId}&kaisai_date=${date}&limit=20`;

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
const fail503: Resp = { status: 503, json: async () => ({ ok: false, error: { type: "netkeiba-unavailable", reason: "busy" } }) };
const raceRow = (raceId: string, venueName: string | null = "福島") => ({ race_id: raceId, venue_name: venueName, race_number: Number(raceId.slice(10)), race_name: `R${raceId.slice(10)}`, course_type: "芝", distance: 1800, entry_count: 16, grade: null });
const racesBody = (venue: string, rows: ReturnType<typeof raceRow>[], date = DATE) => ({ ok: true, kaisai_date: date, venue, races: rows });
const CENTRAL_ROWS = [raceRow("202603020210"), raceRow(RACE_ID), raceRow("202603020212"), raceRow("202609020101", "阪神")];
const boardRow = (raceId: string, mode: string, status: string, over: Record<string, unknown> = {}) => ({ race_id: raceId, mode, status, attempts: 0, error: null, queued_at: 1, updated_at: 2, prior: false, analysis_id: null, detail: null, children_ok: null, ...over });
const statusBody = (raceId: string) => ({ ok: true, kaisai_date: DATE, races: [boardRow(raceId, "pre_race", "queued")], prior: null });
const analysisBody = (id: number, kaisaiDate: string, raceId = RACE_ID) => ({
  ok: true,
  analysis: {
    id,
    raceId,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate,
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    promptVersion: null,
    race: { venueName: "福島", raceNumber: Number(raceId.slice(10)), raceName: "テストステークス", startTime: null, courseType: null, distance: null, weather: null, trackCondition: null, oddsStatus: null, placeBasis: null },
    horses: [],
    allocation: null,
    detail: "present",
  },
});

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const rawTextOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(rawTextOf).join(""));
const navOf = (tree: VNode, label: string): VNode | undefined => findAll(tree, (n) => n.tag === "nav" && n.attrs?.["aria-label"] === label)[0];

interface Harness {
  readonly app: App;
  readonly calls: string[];
  readonly responders: Map<string, () => Promise<Resp>>;
  hash: string;
  tree(): VNode;
  go(hash: string): void;
  /** 前後のリンクの [文言, href](無ければ空)。 */
  neighbors(): [string, string][];
  breadcrumb(): string | undefined;
  noticeCount(): number;
  racesCalls(): string[];
}

function harness(initialHash: string, role: Role = "admin"): Harness {
  const responders = new Map<string, () => Promise<Resp>>([
    [RACES_CENTRAL, async () => ok(racesBody("central", CENTRAL_ROWS))],
    [RACES_NAR, async () => ok(racesBody("nar", [raceRow("202644062804", "大井"), raceRow("202644062805", "大井"), raceRow("202644062806", "大井")]))],
    [RACES_OTHER, async () => ok(racesBody("central", CENTRAL_ROWS, OTHER_DATE))],
    [BOARD, async () => ok({ ok: true, kaisai_date: DATE, races: [] })],
    ...["202603020210", RACE_ID, "202603020212", "202644062805"].flatMap((id): [string, () => Promise<Resp>][] => [
      [statusUrl(id), async () => ok(statusBody(id))],
      [pastUrl(id), async () => ok({ ok: true, analyses: [] })],
    ]),
    ["/api/analyses/5", async () => ok(analysisBody(5, DATE))],
    ["/api/analyses/6", async () => ok(analysisBody(6, OTHER_DATE))],
  ]);
  const calls: string[] = [];
  let tree: VNode | null = null;
  const fetchLike: FetchLike = (url) => {
    calls.push(url);
    const responder = responders.get(url);
    if (responder === undefined) throw new Error(`想定外の取得: ${url}`);
    return responder();
  };
  const h: Harness = {
    hash: initialHash,
    calls,
    responders,
    tree: () => tree!,
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
    neighbors: () => {
      const nav = navOf(tree!, "前後のレース");
      return nav === undefined ? [] : findAll(nav, (n) => n.tag === "a").map((a): [string, string] => [rawTextOf(a), String(a.attrs?.["href"])]);
    },
    breadcrumb: () => {
      const nav = navOf(tree!, "パンくず");
      return nav === undefined ? undefined : rawTextOf(nav);
    },
    noticeCount: () => findAll(tree!, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes("notice")).length,
    racesCalls: () => calls.filter((u) => u.startsWith("/api/races")),
    app: undefined as never,
  };
  (h as { app: App }).app = createApp({
    role,
    fetch: fetchLike,
    now: () => new Date("2026-06-28T00:00:00Z"),
    render: (t) => {
      tree = t;
    },
    getHash: () => h.hash,
    setHash: () => {},
    timers: { set: () => 0, clear: () => {} },
    isVisible: () => true,
  });
  return h;
}

const raceHash = (raceId: string, venue = "central", date = DATE) => `#date=${date}&venue=${venue}&race=${raceId}`;
const NEIGHBORS_OF_11: [string, string][] = [
  ["前のレース 10R", raceHash("202603020210")],
  ["次のレース 12R", raceHash("202603020212")],
];

describe("レース画面を直接開く(一覧がキャッシュに無い)", () => {
  it("一覧を (開催日, 区分) ごとに 1 回だけ取り、取れたら前後が出る。取得中はパンくずだけで前後は出ない。板(race_id なし)は取らない", async () => {
    const h = harness(raceHash(RACE_ID));
    h.app.start();
    expect(h.breadcrumb(), "取得中でもパンくずは出る(競馬場名は一覧がまだ無いので省く)").toBe("一覧›6/28(日)›11R");
    expect(h.neighbors(), "取得中は前後を出さない").toEqual([]);
    await h.app.whenIdle();
    expect(h.racesCalls()).toEqual([RACES_CENTRAL]);
    expect(h.calls).not.toContain(BOARD);
    expect([...h.calls].sort()).toEqual([RACES_CENTRAL, pastUrl(RACE_ID), statusUrl(RACE_ID)].sort());
    expect(h.neighbors()).toEqual(NEIGHBORS_OF_11);
    expect(h.breadcrumb(), "一覧が届くと競馬場名も入る").toBe("一覧›6/28(日)›福島›11R");
  });

  it("前のレースへ移っても、一覧は取り直さない(同じキャッシュ)。移った先の前後に変わる", async () => {
    const h = harness(raceHash(RACE_ID));
    h.app.start();
    await h.app.whenIdle();
    h.go(raceHash("202603020210"));
    await h.app.whenIdle();
    expect(h.racesCalls(), "一覧は 1 回のまま").toEqual([RACES_CENTRAL]);
    expect(h.neighbors(), "R10 は前が無く、次が R11").toEqual([["次のレース 11R", raceHash(RACE_ID)]]);
    expect(h.breadcrumb()).toBe("一覧›6/28(日)›福島›10R");
  });

  it("地方: 地方の一覧を取り(中央の一覧は取らない)、区分を保ったリンクが出る", async () => {
    const h = harness(raceHash("202644062805", "nar"));
    h.app.start();
    await h.app.whenIdle();
    expect(h.racesCalls()).toEqual([RACES_NAR]);
    expect(h.neighbors()).toEqual([
      ["前のレース 4R", raceHash("202644062804", "nar")],
      ["次のレース 6R", raceHash("202644062806", "nar")],
    ]);
  });

  it("閲覧者でも同じに出る", async () => {
    const h = harness(raceHash(RACE_ID), "viewer");
    h.app.start();
    await h.app.whenIdle();
    expect(h.neighbors()).toEqual(NEIGHBORS_OF_11);
  });

  it("一覧の取得に失敗しても、レース画面のほかの部分は壊れない: カードは出て、パンくずも出る。前後だけ出ず、エラーの表示を増やさず、自動で取り直さない", async () => {
    const good = harness(raceHash(RACE_ID));
    good.app.start();
    await good.app.whenIdle();
    const noticesWhenOk = good.noticeCount();

    const h = harness(raceHash(RACE_ID));
    h.responders.set(RACES_CENTRAL, async () => fail503);
    h.app.start();
    await h.app.whenIdle();
    expect(findAll(h.tree(), (n) => n.tag === "section" && String(n.attrs?.["class"]) === "card"), "前提: カードは出ている").toHaveLength(2);
    expect(h.breadcrumb()).toBe("一覧›6/28(日)›11R");
    expect(h.neighbors()).toEqual([]);
    expect(h.noticeCount(), "エラーの表示を増やさない").toBe(noticesWhenOk);
    expect(h.racesCalls()).toEqual([RACES_CENTRAL]);
    h.go(raceHash("202603020212"));
    await h.app.whenIdle();
    h.go(raceHash(RACE_ID));
    await h.app.whenIdle();
    expect(h.racesCalls(), "失敗は自動で再試行しない").toEqual([RACES_CENTRAL]);
  });
});

describe("一覧の画面から来たとき(一覧がキャッシュにある)", () => {
  it("一覧 → レース: 一覧は 1 回のまま増えず、板も 1 回のまま。前後は最初の描画から出る", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    h.app.start();
    await h.app.whenIdle();
    expect(h.racesCalls()).toEqual([RACES_CENTRAL]);
    h.go(raceHash(RACE_ID));
    expect(h.neighbors(), "キャッシュがあるので、取得を待たずに前後が出る").toEqual(NEIGHBORS_OF_11);
    await h.app.whenIdle();
    expect(h.racesCalls()).toEqual([RACES_CENTRAL]);
    expect(h.calls.filter((u) => u === BOARD)).toHaveLength(1);
  });

  it("レース画面の「更新」は一覧を取り直さない(一覧のキャッシュを捨てない)", async () => {
    const h = harness(raceHash(RACE_ID));
    h.app.start();
    await h.app.whenIdle();
    const refresh = findAll(h.tree(), (n) => n.tag === "button" && String(n.attrs?.["class"]) === "refresh")[0]!;
    refresh.on!.click!();
    await h.app.whenIdle();
    expect(h.racesCalls()).toEqual([RACES_CENTRAL]);
    expect(h.neighbors()).toEqual(NEIGHBORS_OF_11);
  });
});

describe("結果画面を直接開く", () => {
  it("分析が届いてから、分析の開催日(kaisaiDate)の一覧を 1 回取る。route の日付(今日)の一覧は取らない。前後の行き先はレース画面", async () => {
    const h = harness("#analysis=6");
    const analysis = deferred<Resp>();
    h.responders.set("/api/analyses/6", () => analysis.promise);
    h.app.start();
    expect(h.racesCalls(), "分析が届くまでは、どの日の一覧か分からないので取らない").toEqual([]);
    expect(h.breadcrumb()).toBeUndefined();
    analysis.resolve(ok(analysisBody(6, OTHER_DATE)));
    await h.app.whenIdle();
    expect(h.racesCalls()).toEqual([RACES_OTHER]);
    expect(h.breadcrumb()).toBe("一覧›6/21(日)›福島›11R");
    expect(h.neighbors()).toEqual([
      ["前のレース 10R", raceHash("202603020210", "central", OTHER_DATE)],
      ["次のレース 12R", raceHash("202603020212", "central", OTHER_DATE)],
    ]);
    expect(findAll(navOfTree(h), (n) => n.tag === "a" && String(n.attrs?.["href"]).includes("analysis=")), "前後はレース画面へ(analysis を持たない)").toHaveLength(0);
  });

  it("閲覧者でも同じに出る", async () => {
    const h = harness("#analysis=5", "viewer");
    h.app.start();
    await h.app.whenIdle();
    expect(h.neighbors()).toEqual(NEIGHBORS_OF_11);
  });

  it("分析の取得に失敗したら一覧は取らない。分析が届いたときに結果画面から離れていれば、一覧を取らない", async () => {
    const failed = harness("#analysis=5");
    failed.responders.set("/api/analyses/5", async () => fail503);
    failed.app.start();
    await failed.app.whenIdle();
    expect(failed.racesCalls()).toEqual([]);

    const left = harness("#analysis=5");
    const analysis = deferred<Resp>();
    left.responders.set("/api/analyses/5", () => analysis.promise);
    left.responders.set("/api/settings", async () => ok({ ok: true, settings: {} }));
    left.app.start();
    left.go("#settings");
    analysis.resolve(ok(analysisBody(5, DATE)));
    await left.app.whenIdle();
    expect(left.racesCalls(), "前提: 結果画面から離れたあとに届いた").toEqual([]);
  });

  it("レース画面 → 過去の分析(結果画面): 分析も一覧もキャッシュにあれば、取得は増えない", async () => {
    const h = harness(raceHash(RACE_ID));
    h.responders.set(statusUrl(RACE_ID), async () => ok({ ok: true, kaisai_date: DATE, races: [boardRow(RACE_ID, "pre_race", "done", { analysis_id: 5 })], prior: null }));
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls, "前提: 最新の分析 5 をレース画面が取っている").toContain("/api/analyses/5");
    const before = h.calls.length;
    h.go(`#date=${DATE}&venue=central&analysis=5`);
    await h.app.whenIdle();
    expect(h.calls.length, "取得は増えない").toBe(before);
    expect(h.neighbors()).toEqual(NEIGHBORS_OF_11);
  });
});

const navOfTree = (h: Harness): VNode => h.tree();
