import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { VNode } from "../client/vnode";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #400 R-11b(`createApp` から読み込みと追跡を `race-data.ts` へ切り出す)の前に足した、振る舞いの特性テスト(追加のみ。既存のテストは変えない)。
 * 切り出し前の `app.ts` の読み込み・追跡・「更新」の部分(約 300 行)に変異(条件の置換・文の削除・比較の反転ほか)を機械的に注入したところ、
 * 既存の client 系テストが全緑のまま生き残った変異のうち、**利用者から見える挙動に当たるもの**を固定する。
 * 切り出し後も同じ振る舞いであることを、`createApp` を通して確かめる(切り出し前の `app.ts` でも緑)。
 * 偽の fetch(保留できる応答)・偽のタイマー・偽のハッシュ。実リクエストはしない。
 */

const DATE = "20260628";
const DATE2 = "20260629";
const RACE_ID = "202603020211";
const OTHER_RACE_ID = "202603020212";
const RACE_HASH = `#date=${DATE}&venue=central&race=${RACE_ID}`;
const LIST_HASH = `#date=${DATE}&venue=central`;
const RACE_HASH2 = `#date=${DATE2}&venue=central&race=${RACE_ID}`;
const RACES_URL = `/api/races?kaisai_date=${DATE}&venue=central`;
const BOARD_URL = `/api/analyses/status?kaisai_date=${DATE}`;
const BOARD_URL2 = `/api/analyses/status?kaisai_date=${DATE2}`;
const STATUS_URL = `${BOARD_URL}&race_id=${RACE_ID}`;
const STATUS_URL2 = `${BOARD_URL2}&race_id=${RACE_ID}`;
const PAST_URL = `/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE}&limit=20`;
const PAST_URL2 = `/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE2}&limit=20`;
const ANALYSIS_URL = "/api/analyses/5";

type Resp = { status: number; json: () => Promise<unknown> };
type Init = Parameters<FetchLike>[1];
const ok = (body: unknown): Resp => ({ status: 200, json: async () => ({ ...(body as object) }) });
const resp = (status: number, body: unknown): Resp => ({ status, json: async () => body });
const fail503 = (): Resp => resp(503, { ok: false, error: { type: "race-day-error", message: "サーバの文面" } });

interface JsonRow {
  race_id: string;
  mode: string;
  status: string;
  attempts: number;
  error: string | null;
  queued_at: number;
  updated_at: number;
  prior: boolean;
  analysis_id: number | null;
  detail: null;
  children_ok: null;
}
const jrow = (raceId: string, mode: string, status: string, over: Partial<JsonRow> = {}): JsonRow => ({
  race_id: raceId,
  mode,
  status,
  attempts: 0,
  error: null,
  queued_at: 1000,
  updated_at: 2000,
  prior: false,
  analysis_id: null,
  detail: null,
  children_ok: null,
  ...over,
});
const raceRow = (raceId: string, name: string) => ({ race_id: raceId, venue_name: "福島", race_number: Number(raceId.slice(-2)), race_name: name, course_type: "芝", distance: 1800, entry_count: 16, grade: null });
const PRIOR_BODY = { race_name: "福島民報杯", venue_name: "福島", date: "2026-06-28", computed_at: 5000, rows: [{ rank: 1, umaban: 3, horse_name: "アルファ", prior: 0.523 }] };

function textOf(node: VNode | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join(" ");
}
function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));

interface Call {
  readonly method: string;
  readonly url: string;
}
interface Harness {
  readonly app: App;
  readonly calls: Call[];
  readonly timers: ReturnType<typeof createFakeTimers>;
  /** サーバが持っている板の行(開催日 1 の GET の応答。POST の予約が反映される)。 */
  rows: JsonRow[];
  prior: unknown;
  pastIds: number[];
  readonly responders: Map<string, () => Promise<Resp>>;
  hash: string;
  tree(): VNode;
  text(): string;
  go(hash: string): void;
  settle(): Promise<void>;
  count(url: string): number;
  /** 偽の fetch が受けた全 GET の URL。 */
  gets(): string[];
}

function harness(initialHash: string): Harness {
  const timers = createFakeTimers();
  const calls: Call[] = [];
  let tree: VNode | null = null;
  const h: Harness = {
    app: undefined as never,
    calls,
    timers,
    rows: [],
    prior: null,
    pastIds: [],
    responders: new Map(),
    hash: initialHash,
    tree: () => tree!,
    text: () => textOf(tree!),
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
    settle: () => timers.flush(),
    count: (url) => calls.filter((c) => c.method === "GET" && c.url === url).length,
    gets: () => calls.filter((c) => c.method === "GET").map((c) => c.url),
  };
  const analysis = (id: number) => ({
    ok: true,
    analysis: {
      id,
      raceId: RACE_ID,
      analyzedAt: "2026-06-28T05:00:00.000Z",
      kaisaiDate: DATE,
      evEstimated: false,
      model: null,
      llmNote: null,
      llmCalls: null,
      promptVersion: null,
      race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", startTime: null, courseType: null, distance: null, weather: null, trackCondition: null, oddsStatus: null, placeBasis: null },
      horses: [{ umaban: 1, name: `分析${id}の馬`, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.2, isPositive: true, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null }],
      allocation: null,
      detail: "present",
    },
  });
  const respondDefault = (method: string, url: string, init: Init): Resp => {
    if (method === "POST" && url === "/api/analyses/run") {
      const body = JSON.parse(init.body as string) as { race_id: string; kaisai_date: string; mode: string };
      h.rows = [...h.rows.filter((r) => !(r.race_id === body.race_id && r.mode === body.mode)), jrow(body.race_id, body.mode, "queued", { queued_at: 10_000 + timers.now() })];
      return resp(202, { ok: true, accepted: true, race_id: body.race_id, kaisai_date: body.kaisai_date, mode: body.mode, status: "queued" });
    }
    if (url === RACES_URL) return ok({ ok: true, kaisai_date: DATE, venue: "central", races: [raceRow(RACE_ID, "福島民報杯"), raceRow(OTHER_RACE_ID, "福島12R")] });
    if (url === BOARD_URL) return ok({ ok: true, kaisai_date: DATE, races: h.rows });
    if (url === STATUS_URL) return ok({ ok: true, kaisai_date: DATE, races: h.rows, prior: h.prior });
    if (url === PAST_URL) return ok({ ok: true, analyses: h.pastIds.map((id) => ({ id, raceId: RACE_ID, analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: null, promptVersion: null, horses: [], hasDetail: true })) });
    const detail = /^\/api\/analyses\/([0-9]+)$/.exec(url);
    if (method === "GET" && detail !== null) return ok(analysis(Number(detail[1])));
    throw new Error(`想定外の取得: ${method} ${url}`);
  };
  const fetchLike: FetchLike = (url, init) => {
    calls.push({ method: init.method, url });
    const custom = h.responders.get(`${init.method} ${url}`);
    if (custom !== undefined) return custom();
    return Promise.resolve(respondDefault(init.method, url, init));
  };
  (h as { app: App }).app = createApp({
    role: "admin",
    fetch: fetchLike,
    now: () => new Date(Date.parse("2026-06-28T00:00:00Z") + timers.now()),
    render: (t) => {
      tree = t;
    },
    getHash: () => h.hash,
    setHash: (hash) => {
      h.hash = hash;
    },
    timers: { set: (fn, ms) => timers.set(fn, ms), clear: (handle) => timers.clear(handle) },
    isVisible: () => true,
  });
  return h;
}

async function started(initialHash: string, setup: (h: Harness) => void = () => {}): Promise<Harness> {
  const h = harness(initialHash);
  setup(h);
  h.app.start();
  await h.settle();
  return h;
}

/** 次の 1 回だけ保留する応答(2 回目以降は既定の応答に戻る)。 */
function holdOnce(h: Harness, key: string): { resolve: (r: Resp) => void } {
  const d = deferred<Resp>();
  h.responders.set(key, () => {
    h.responders.delete(key);
    return d.promise;
  });
  return { resolve: d.resolve };
}
/** 次の 1 回だけ、渡した応答を返す(以降は既定の応答に戻る)。 */
function replyOnce(h: Harness, key: string, r: Resp): void {
  h.responders.set(key, async () => {
    h.responders.delete(key);
    return r;
  });
}
/** 毎回、渡した応答を返す。 */
function replyAlways(h: Harness, key: string, make: () => Resp): void {
  h.responders.set(key, async () => make());
}

const statusBody = (h: Harness, date = DATE, prior: unknown = h.prior) => ({ ok: true, kaisai_date: date, races: h.rows, prior });
const runButton = (h: Harness, mode: "morning" | "pre_race"): VNode => {
  const found = byClass(h.tree(), "run").filter((b) => b.attrs?.["data-mode"] === mode);
  expect(found, `前提: ${mode} の起動のボタンがある`).toHaveLength(1);
  return found[0]!;
};
const click = (node: VNode): void => node.on!.click!();
const refreshButton = (h: Harness): VNode => {
  const found = byClass(h.tree(), "refresh");
  expect(found, "前提: 更新のボタンが 1 つある").toHaveLength(1);
  return found[0]!;
};
const pastLinks = (h: Harness): number => byClass(h.tree(), "past-link").length;

// ---------------------------------------------------------------------------------------------
// 取得の束ね・失敗の扱い・「更新」
// ---------------------------------------------------------------------------------------------
describe("R-11b 特性: 取得中の再要求は束ね、失敗は自動で再試行しない", () => {
  it("レース画面: 状態・過去の分析の取得中に同じ画面へ入り直しても、取得は 1 本のまま(束ねる)", async () => {
    const h = harness(RACE_HASH);
    const status = holdOnce(h, `GET ${STATUS_URL}`);
    const past = holdOnce(h, `GET ${PAST_URL}`);
    h.app.start();
    await h.settle();
    expect(h.count(STATUS_URL)).toBe(1);
    expect(h.count(PAST_URL)).toBe(1);
    h.go(RACE_HASH);
    h.go(RACE_HASH);
    await h.settle();
    expect(h.count(STATUS_URL), "状態の取得中の再要求は束ねる").toBe(1);
    expect(h.count(PAST_URL), "過去の分析の取得中の再要求は束ねる").toBe(1);
    status.resolve(ok(statusBody(h)));
    past.resolve(ok({ ok: true, analyses: [] }));
    await h.settle();
    expect(h.count(STATUS_URL)).toBe(1);
    expect(h.count(PAST_URL)).toBe(1);
  });

  it("過去の分析の取得に失敗したら、画面に失敗を出し(読み込み中のままにしない)、入り直しても自動では取り直さない。「更新」で取り直す", async () => {
    const h = await started(RACE_HASH, (x) => replyOnce(x, `GET ${PAST_URL}`, fail503()));
    expect(h.count(PAST_URL)).toBe(1);
    const alerts = findAll(h.tree(), (n) => n.attrs?.["role"] === "alert");
    expect(alerts, "前提: 失敗の表示がちょうど 1 つ(過去の分析の節)").toHaveLength(1);
    expect(textOf(alerts[0]!)).toContain("サーバでエラーが起きました");
    expect(h.text()).not.toContain("サーバの文面");
    h.go(RACE_HASH);
    await h.settle();
    expect(h.count(PAST_URL), "失敗は自動で取り直さない").toBe(1);
    h.pastIds = [5];
    click(refreshButton(h));
    await h.settle();
    expect(h.count(PAST_URL), "「更新」は失敗した過去の分析を取り直す").toBe(2);
    expect(pastLinks(h)).toBe(1);
    expect(findAll(h.tree(), (n) => n.attrs?.["role"] === "alert")).toHaveLength(0);
  });

  it("一覧: 板の取得に失敗したら入り直しても自動では取り直さない。「更新」は失敗した板を取り直し、検証画面の API は取らない", async () => {
    const h = await started(LIST_HASH, (x) => replyOnce(x, `GET ${BOARD_URL}`, fail503()));
    expect(h.count(BOARD_URL)).toBe(1);
    h.go(LIST_HASH);
    await h.settle();
    expect(h.count(BOARD_URL), "失敗した板は自動では取り直さない").toBe(1);
    expect(h.count(RACES_URL)).toBe(1);
    click(refreshButton(h));
    await h.settle();
    expect(h.count(BOARD_URL), "「更新」は失敗した板を取り直す").toBe(2);
    expect(h.count(RACES_URL)).toBe(2);
    expect(h.gets().filter((u) => u.startsWith("/api/verify")), "一覧の「更新」が検証画面の取得を起こさない").toEqual([]);
  });

  it("レース画面の「更新」は、一覧のキャッシュを捨てない(一覧へ戻っても /api/races を取り直さない)", async () => {
    const h = await started(LIST_HASH);
    expect(h.count(RACES_URL)).toBe(1);
    h.go(RACE_HASH);
    await h.settle();
    click(refreshButton(h));
    await h.settle();
    h.go(LIST_HASH);
    await h.settle();
    expect(h.count(RACES_URL)).toBe(1);
    expect(h.count(BOARD_URL)).toBe(1);
  });

  it("レース画面の「更新」は、押した直後に再描画する(応答を待つ間は読み込み中。古い内容のまま固まらない)", async () => {
    const h = await started(RACE_HASH, (x) => (x.pastIds = [5]));
    expect(refreshButton(h).attrs?.["disabled"]).toBe(false);
    expect(pastLinks(h)).toBe(1);
    const status = holdOnce(h, `GET ${STATUS_URL}`);
    const past = holdOnce(h, `GET ${PAST_URL}`);
    click(refreshButton(h));
    expect(refreshButton(h).attrs?.["disabled"], "押した直後に読み込み中になる").toBe(true);
    expect(pastLinks(h), "過去の分析は取り直すまで隠す").toBe(0);
    status.resolve(ok(statusBody(h)));
    past.resolve(ok({ ok: true, analyses: [{ id: 5, raceId: RACE_ID, analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: null, promptVersion: null, horses: [], hasDetail: true }] }));
    await h.settle();
    expect(refreshButton(h).attrs?.["disabled"]).toBe(false);
    expect(pastLinks(h)).toBe(1);
  });

  it("結果画面: 失敗した分析の「更新」は、押した直後に読み込み中へ戻り(失敗の表示を消し)、取り直した結果を出す", async () => {
    const h = harness("#analysis=5");
    replyOnce(h, `GET ${ANALYSIS_URL}`, fail503());
    h.app.start();
    await h.settle();
    expect(findAll(h.tree(), (n) => n.attrs?.["role"] === "alert")).toHaveLength(1);
    const again = holdOnce(h, `GET ${ANALYSIS_URL}`);
    click(refreshButton(h));
    expect(findAll(h.tree(), (n) => n.attrs?.["role"] === "alert"), "押した直後に失敗の表示が消える").toHaveLength(0);
    expect(h.text()).toContain("読み込み中");
    again.resolve(ok({ ok: true, analysis: { id: 5, raceId: RACE_ID, analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: null, llmNote: null, llmCalls: null, promptVersion: null, race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", startTime: null, courseType: null, distance: null, weather: null, trackCondition: null, oddsStatus: null, placeBasis: null }, horses: [], allocation: null, detail: "present" } }));
    await h.settle();
    expect(h.count(ANALYSIS_URL)).toBe(2);
    expect(h.text()).toContain("テストステークス");
  });

  it("取得中の「更新」は無視する(レース画面: 状態の取得中は過去の分析を、過去の分析の取得中は状態を、取り直さない。一覧: 一覧の取得中は板を取り直さない)", async () => {
    // 状態の取得中
    const a = harness(RACE_HASH);
    const statusHeld = holdOnce(a, `GET ${STATUS_URL}`);
    a.app.start();
    await a.settle();
    expect(a.count(PAST_URL)).toBe(1); // 過去の分析は取得済み
    click(refreshButton(a));
    await a.settle();
    expect(a.count(STATUS_URL), "状態の取得中の「更新」は無視する").toBe(1);
    expect(a.count(PAST_URL), "状態の取得中の「更新」で過去の分析を取り直さない").toBe(1);
    statusHeld.resolve(ok(statusBody(a)));
    await a.settle();
    // 過去の分析の取得中
    const b = harness(RACE_HASH);
    const pastHeld = holdOnce(b, `GET ${PAST_URL}`);
    b.app.start();
    await b.settle();
    expect(b.count(STATUS_URL)).toBe(1); // 状態は取得済み
    click(refreshButton(b));
    await b.settle();
    expect(b.count(PAST_URL), "過去の分析の取得中の「更新」は無視する").toBe(1);
    expect(b.count(STATUS_URL), "過去の分析の取得中の「更新」で状態を取り直さない").toBe(1);
    pastHeld.resolve(ok({ ok: true, analyses: [] }));
    await b.settle();
    // 一覧の取得中
    const c = harness(LIST_HASH);
    const racesHeld = holdOnce(c, `GET ${RACES_URL}`);
    c.app.start();
    await c.settle();
    expect(c.count(BOARD_URL)).toBe(1); // 板は取得済み
    click(refreshButton(c));
    await c.settle();
    expect(c.count(RACES_URL), "一覧の取得中の「更新」は無視する").toBe(1);
    expect(c.count(BOARD_URL), "一覧の取得中の「更新」で板を取り直さない").toBe(1);
    racesHeld.resolve(ok({ ok: true, kaisai_date: DATE, venue: "central", races: [raceRow(RACE_ID, "福島民報杯")] }));
    await c.settle();
  });
});

describe("R-11b 特性: whenIdle(取得中のものを待つ)", () => {
  it("状態・過去の分析の取得と、追跡の板の取得のどれが残っていても待つ(終わるまで解決しない)", async () => {
    const resolvedAfter = async (h: Harness, resolve: () => void): Promise<void> => {
      let done = false;
      const idle = h.app.whenIdle().then(() => {
        done = true;
      });
      await h.settle();
      expect(done, "取得が残っている間は解決しない").toBe(false);
      resolve();
      await idle;
      expect(done).toBe(true);
    };
    // 状態の取得
    const a = harness(RACE_HASH);
    const aStatus = holdOnce(a, `GET ${STATUS_URL}`);
    a.app.start();
    await a.settle();
    await resolvedAfter(a, () => aStatus.resolve(ok(statusBody(a))));
    // 過去の分析の取得
    const b = harness(RACE_HASH);
    const bPast = holdOnce(b, `GET ${PAST_URL}`);
    b.app.start();
    await b.settle();
    await resolvedAfter(b, () => bPast.resolve(ok({ ok: true, analyses: [] })));
    // 追跡の板の取得
    const c = harness(RACE_HASH);
    c.rows = [jrow(RACE_ID, "morning", "queued")];
    c.app.start();
    await c.settle();
    const cBoard = holdOnce(c, `GET ${BOARD_URL}`);
    await c.timers.advance(3000);
    expect(c.count(BOARD_URL), "前提: 追跡の板の取得が出ている").toBe(1);
    await resolvedAfter(c, () => cBoard.resolve(ok({ ok: true, kaisai_date: DATE, races: c.rows })));
  });
});

// ---------------------------------------------------------------------------------------------
// 追跡
// ---------------------------------------------------------------------------------------------
describe("R-11b 特性: 追跡", () => {
  it("追跡中に取得が成功しても追跡を張り直さない(予算・タイマーを延ばさない)。最初の取得は始めてから 3 秒後のまま", async () => {
    const h = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    expect(h.count(BOARD_URL), "前提: 一覧を開いたときの板の取得は 1 回").toBe(1);
    await h.timers.advance(2000);
    h.go(RACE_HASH); // 状態の取得が成功する(追跡を始める条件は満たしている)
    await h.settle();
    expect(h.count(STATUS_URL)).toBe(1);
    expect(h.count(BOARD_URL)).toBe(1);
    await h.timers.advance(999);
    expect(h.count(BOARD_URL), "3 秒に 1ms 足りない").toBe(1);
    await h.timers.advance(1);
    expect(h.count(BOARD_URL), "始めてから 3 秒後(張り直されていない)").toBe(2);
  });

  it("追跡する日が複数あり、片方の取得だけが失敗し続けても、失敗として数え、3 回で止まる(成功した日があっても止める)", async () => {
    const h = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    h.responders.set(`GET ${STATUS_URL2}`, async () => ok({ ok: true, kaisai_date: DATE2, races: [], prior: null }));
    h.responders.set(`GET ${PAST_URL2}`, async () => ok({ ok: true, analyses: [] }));
    replyAlways(h, `GET ${BOARD_URL2}`, fail503);
    h.go(RACE_HASH2);
    await h.settle();
    click(runButton(h, "morning")); // 2 日目の追跡を足す(板が無いので、実行中の行の代わりに強制の対象になる)
    await h.settle();
    await h.timers.advance(60_000);
    expect(h.count(BOARD_URL2), "失敗が 3 回続いたら止まる").toBe(3);
    expect(h.count(BOARD_URL), "成功する日も、止まるまでは取る(一覧を開いたときの 1 回 + 追跡の 3 周期)").toBe(4);
    await h.timers.advance(60_000);
    expect(h.count(BOARD_URL2)).toBe(3);
  });

  it("起動の受付より前に出した古いポーリングの応答が、あとから届いても、追跡の対象(強制)は外れない。次の周期で取りに行く", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    const poll = holdOnce(h, `GET ${BOARD_URL}`);
    await h.timers.advance(3000);
    expect(h.count(BOARD_URL), "前提: 古いポーリングが保留されている").toBe(1);
    // 202 だが本文が想定外(行を重ねない。追跡の対象だけが足される)
    h.responders.set("POST /api/analyses/run", async () => resp(202, {}));
    click(runButton(h, "pre_race"));
    await h.settle();
    // 古いポーリングが、実行中の行の無い板(失敗。完了ではない)を持って届く
    h.rows = [jrow(RACE_ID, "morning", "failed", { error: "x" })];
    poll.resolve(ok({ ok: true, kaisai_date: DATE, races: h.rows }));
    await h.settle();
    await h.timers.advance(3000);
    expect(h.count(BOARD_URL), "強制の対象が残っているので、3 秒後にもう 1 回取る").toBe(2);
  });

  it("一覧の「更新」より前に出した古いポーリングの応答が、あとから届いても、実行中だった日は追跡の対象に残る(板の取り直しが届くまで)", async () => {
    const h = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    const poll = holdOnce(h, `GET ${BOARD_URL}`);
    await h.timers.advance(3000);
    expect(h.count(BOARD_URL), "前提: 一覧を開いたとき 1 回 + 古いポーリングが保留されている").toBe(2);
    const manual = holdOnce(h, `GET ${BOARD_URL}`);
    click(refreshButton(h)); // 実行中の日を強制の対象にして、板を捨てて取り直す
    await h.settle();
    expect(h.count(BOARD_URL), "前提: 手動の取り直しが保留されている").toBe(3);
    h.rows = [jrow(RACE_ID, "morning", "failed", { error: "x" })]; // 実行中の行の無い板(失敗。完了ではない)
    poll.resolve(ok({ ok: true, kaisai_date: DATE, races: h.rows }));
    await h.settle();
    await h.timers.advance(3000);
    expect(h.count(BOARD_URL), "強制の対象が残っているので、3 秒後に追跡がもう 1 回取る").toBe(4);
    manual.resolve(ok({ ok: true, kaisai_date: DATE, races: h.rows }));
    await h.settle();
  });
});

// ---------------------------------------------------------------------------------------------
// 完了への遷移
// ---------------------------------------------------------------------------------------------
describe("R-11b 特性: 完了への遷移で取り直す", () => {
  it("発走前の完了を、過去の分析の取得中に見つけたら、その取得が終わってから取り直す(取得中に重ねない)。取り直す間は古い一覧を出さない", async () => {
    const h = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "pre_race", "queued")]));
    h.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 7 })];
    h.pastIds = [7];
    const past1 = holdOnce(h, `GET ${PAST_URL}`);
    h.go(RACE_HASH); // 状態は完了を持って届き、過去の分析はまだ取得中
    await h.settle();
    expect(h.count(STATUS_URL)).toBe(1);
    expect(h.count(PAST_URL)).toBe(1);
    const past2 = holdOnce(h, `GET ${PAST_URL}`);
    past1.resolve(ok({ ok: true, analyses: [{ id: 3, raceId: RACE_ID, analyzedAt: "2026-06-28T04:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: null, promptVersion: null, horses: [], hasDetail: true }] }));
    await h.settle();
    expect(h.count(PAST_URL), "取得が終わってから取り直す").toBe(2);
    expect(pastLinks(h), "取り直す間は、古い一覧を出さない").toBe(0);
    past2.resolve(ok({ ok: true, analyses: [{ id: 7, raceId: RACE_ID, analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: null, promptVersion: null, horses: [], hasDetail: true }] }));
    await h.settle();
    expect(pastLinks(h)).toBe(1);
    expect(findAll(h.tree(), (n) => n.tag === "a").map((n) => n.attrs?.["href"])).toContain(`#date=${DATE}&venue=central&analysis=7`);
    expect(h.count(PAST_URL)).toBe(2);
  });

  it("朝の完了を、状態の取得中に見つけたら、その取得が終わってから取り直す(取得中に重ねない)。取り直した順位が出る", async () => {
    const h = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    const status1 = holdOnce(h, `GET ${STATUS_URL}`);
    h.go(RACE_HASH);
    await h.settle();
    expect(h.count(STATUS_URL)).toBe(1);
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true })];
    h.prior = PRIOR_BODY;
    await h.timers.advance(3000); // 追跡が完了を見つける(状態は取得中)
    expect(h.count(STATUS_URL), "取得中に重ねない").toBe(1);
    status1.resolve(ok(statusBody(h, DATE, null))); // 先に出した取得は、順位を持たずに届く
    await h.settle();
    expect(h.count(STATUS_URL), "取得が終わってから 1 回だけ取り直す").toBe(2);
    expect(h.text()).toContain("アルファ");
  });

  it("朝の完了を見つけた状態の取得が失敗し、取り直しも失敗したら、画面に失敗を出す(読み込み中のままにしない)", async () => {
    const h = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    const status1 = holdOnce(h, `GET ${STATUS_URL}`);
    h.go(RACE_HASH);
    await h.settle();
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true })];
    await h.timers.advance(3000);
    replyAlways(h, `GET ${STATUS_URL}`, fail503);
    status1.resolve(fail503());
    await h.settle();
    expect(h.count(STATUS_URL)).toBe(2);
    const alerts = findAll(h.tree(), (n) => n.attrs?.["role"] === "alert");
    expect(alerts.length, "失敗の表示が出る").toBeGreaterThan(0);
    expect(alerts.map(textOf).join(" ")).toContain("サーバでエラーが起きました");
  });

  describe("別の画面にいる間の完了は、取得せずキャッシュ(失敗の記録を含む)を捨て、戻ったときに取り直す", () => {
    it.each([
      ["朝", "morning" as const, STATUS_URL],
      ["発走前", "pre_race" as const, PAST_URL],
    ])("%s: 失敗していた取得も、戻ったときに取り直す", async (_name, mode, failingUrl) => {
      const h = harness(RACE_HASH);
      h.rows = [jrow(RACE_ID, mode, "queued")];
      replyOnce(h, `GET ${failingUrl}`, fail503());
      h.app.start();
      await h.settle();
      expect(h.count(failingUrl), "前提: 取得が 1 回失敗している").toBe(1);
      expect(findAll(h.tree(), (n) => n.attrs?.["role"] === "alert").length, "前提: 失敗が表示されている").toBeGreaterThan(0);
      h.go(LIST_HASH);
      await h.settle();
      h.rows = [jrow(RACE_ID, mode, "done", { prior: true, analysis_id: 7 })];
      h.prior = PRIOR_BODY;
      h.pastIds = [7];
      await h.timers.advance(3000); // 追跡が完了を見つける(レース画面にはいない)
      expect(h.count(failingUrl), "一覧にいる間は取得しない").toBe(1);
      h.go(RACE_HASH);
      await h.settle();
      expect(h.count(failingUrl), "戻ったとき、失敗の記録が捨てられているので取り直す").toBe(2);
      expect(findAll(h.tree(), (n) => n.attrs?.["role"] === "alert"), "失敗の表示が消える").toHaveLength(0);
      if (mode === "morning") expect(h.text()).toContain("アルファ");
      else expect(pastLinks(h)).toBe(1);
    });

    it("発走前: 成功していた過去の分析も、戻ったときに取り直す(古い一覧のまま出さない)", async () => {
      const h = await started(RACE_HASH, (x) => {
        x.rows = [jrow(RACE_ID, "pre_race", "queued")];
        x.pastIds = [3];
      });
      expect(pastLinks(h)).toBe(1);
      h.go(LIST_HASH);
      await h.settle();
      h.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 7 })];
      h.pastIds = [3, 7];
      await h.timers.advance(3000);
      h.go(RACE_HASH);
      await h.settle();
      expect(h.count(PAST_URL)).toBe(2);
      expect(pastLinks(h)).toBe(2);
    });
  });

  it("取り直しの失敗の注記は、次の取り直しが成功したら消える", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued", { queued_at: 1000 })]));
    // 1 回目の完了: 取り直しに失敗 → 注記
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true, queued_at: 1000 })];
    replyOnce(h, `GET ${STATUS_URL}`, fail503());
    await h.timers.advance(3000);
    expect(h.text()).toContain("順位を取得できませんでした");
    // やり直し(新しい実行)の完了: 取り直しに成功 → 注記が消え、順位が出る
    click(runButton(h, "morning"));
    await h.settle();
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true, queued_at: 20_000 })];
    h.prior = PRIOR_BODY;
    await h.timers.advance(3000);
    expect(h.count(STATUS_URL)).toBe(3);
    expect(h.text()).toContain("アルファ");
    expect(h.text()).not.toContain("順位を取得できませんでした");
  });
});
