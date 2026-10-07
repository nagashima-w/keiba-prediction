import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { VNode } from "../client/vnode";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #186 段階2: 起動(`POST /api/analyses/run`)と追跡(ポーリング)の、画面の制御(`createApp`)レベルの検査。
 * 偽の fetch(呼び出しの記録・好きなタイミングで解決できる応答)・偽のタイマー・偽の可視状態・偽のハッシュ。実リクエストはしない。
 *
 * 守ること(AC。ブリーフの A1〜A10・B1〜B13・D5):
 *  - 起動: 本文・init(referrerPolicy・mode なし)・二重押しの同期の印・202/409/失敗の扱い・固定の文言
 *  - 追跡: 3 秒 × 10 回 → 5 秒・`status`(race_id なし)だけを呼ぶ・全部終わる/5 分/失敗 3 回で止まり「状態を更新」・非表示で止まる・世代
 *  - 完了への遷移で prior(朝)・過去の分析(発走前)を 1 回だけ取り直す(一覧にいるときはキャッシュを捨てるだけ)
 *  - 古い応答が新しい状態を上書きしない・ポーリングの失敗は板の注記に出さない・ポーリング中も「更新」は押せる
 */

const DATE = "20260628";
const RACE_ID = "202603020211";
const OTHER_RACE_ID = "202603020212";
const RACE_HASH = `#date=${DATE}&venue=central&race=${RACE_ID}`;
const LIST_HASH = `#date=${DATE}&venue=central`;
const BOARD_URL = `/api/analyses/status?kaisai_date=${DATE}`;
const STATUS_URL = `${BOARD_URL}&race_id=${RACE_ID}`;
const PAST_URL = `/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE}&limit=20`;
const RACES_URL = `/api/races?kaisai_date=${DATE}&venue=central`;

type Resp = { status: number; json: () => Promise<unknown> };
type Init = Parameters<FetchLike>[1];
const ok = (body: unknown): Resp => ({ status: 200, json: async () => ({ ...(body as object) }) });
const resp = (status: number, body: unknown): Resp => ({ status, json: async () => body });

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
  readonly init: Init;
}

interface Harness {
  readonly app: App;
  readonly calls: Call[];
  readonly timers: ReturnType<typeof createFakeTimers>;
  /** サーバが持っている板の行(GET の応答・POST の予約が反映される)。 */
  rows: JsonRow[];
  /** サーバが持っている朝の prior(`status?race_id=` の応答)。 */
  prior: unknown;
  /** サーバが持っている過去の分析の id(`GET /api/analyses` の応答)。 */
  pastIds: number[];
  readonly responders: Map<string, (init: Init) => Promise<Resp>>;
  visible: boolean;
  hash: string;
  readonly renders: { force: boolean }[];
  tree(): VNode;
  text(): string;
  go(hash: string): void;
  settle(): Promise<void>;
  gets(): string[];
  posts(): Call[];
  /** `GET /api/analyses/{id}` の呼び出し(Issue #188)。 */
  detailGets(): string[];
}

function harness(initialHash: string): Harness {
  const timers = createFakeTimers();
  const calls: Call[] = [];
  let tree: VNode | null = null;
  const renders: { force: boolean }[] = [];
  const h: Harness = {
    app: undefined as never,
    calls,
    timers,
    rows: [],
    prior: null,
    pastIds: [],
    responders: new Map(),
    visible: true,
    hash: initialHash,
    renders,
    tree: () => tree!,
    text: () => textOf(tree!),
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
    settle: () => timers.flush(),
    gets: () => calls.filter((c) => c.method === "GET").map((c) => c.url),
    posts: () => calls.filter((c) => c.method === "POST"),
    detailGets: () => calls.filter((c) => c.method === "GET" && /^\/api\/analyses\/[0-9]+$/.test(c.url)).map((c) => c.url),
  };
  const respondDefault = (method: string, url: string, init: Init): Resp => {
    if (method === "POST" && url === "/api/analyses/run") {
      const body = JSON.parse(init.body!) as { race_id: string; kaisai_date: string; mode: string };
      h.rows = [...h.rows.filter((r) => !(r.race_id === body.race_id && r.mode === body.mode)), jrow(body.race_id, body.mode, "queued", { queued_at: 10_000 + timers.now() })];
      return resp(202, { ok: true, accepted: true, race_id: body.race_id, kaisai_date: body.kaisai_date, mode: body.mode, status: "queued" });
    }
    if (url === RACES_URL) return ok({ ok: true, kaisai_date: DATE, venue: "central", races: [raceRow(RACE_ID, "福島民報杯"), raceRow(OTHER_RACE_ID, "福島12R")] });
    if (url === BOARD_URL) return ok({ ok: true, kaisai_date: DATE, races: h.rows });
    if (url === STATUS_URL) return ok({ ok: true, kaisai_date: DATE, races: h.rows, prior: h.prior });
    const detail = /^\/api\/analyses\/([0-9]+)$/.exec(url);
    if (method === "GET" && detail !== null) {
      // 分析の詳細(Issue #188)。馬の名前に id を入れ、どの分析がカードに出ているか分かるようにする。
      const id = Number(detail[1]);
      return ok({
        ok: true,
        analysis: {
          id,
          raceId: RACE_ID,
          analyzedAt: "2026-06-28T05:00:00.000Z",
          kaisaiDate: DATE,
          evEstimated: false,
          model: null,
          promptVersion: null,
          race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", startTime: null, courseType: null, distance: null, weather: null, trackCondition: null },
          horses: [{ umaban: 1, name: `分析${id}の馬`, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.2, isPositive: true, mark: null, reason: null }],
          allocation: null,
          detail: "present",
        },
      });
    }
    if (url === PAST_URL) {
      return ok({ ok: true, analyses: h.pastIds.map((id) => ({ id, raceId: RACE_ID, analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: null, promptVersion: null, horses: [], hasDetail: true })) });
    }
    throw new Error(`想定外の取得: ${method} ${url}`);
  };
  const fetchLike: FetchLike = (url, init) => {
    calls.push({ method: init.method, url, init });
    const custom = h.responders.get(`${init.method} ${url}`);
    if (custom !== undefined) return custom(init);
    return Promise.resolve(respondDefault(init.method, url, init));
  };
  (h as { app: App }).app = createApp({
    fetch: fetchLike,
    now: () => new Date(Date.parse("2026-06-28T00:00:00Z") + timers.now()),
    render: (t, force) => {
      tree = t;
      renders.push({ force: force === true });
    },
    getHash: () => h.hash,
    setHash: (hash) => {
      h.hash = hash;
    },
    timers: { set: (fn, ms) => timers.set(fn, ms), clear: (handle) => timers.clear(handle) },
    isVisible: () => h.visible,
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

const runButton = (h: Harness, mode: "morning" | "pre_race"): VNode => {
  const found = byClass(h.tree(), "run").filter((b) => b.attrs?.["data-mode"] === mode);
  expect(found, `前提: ${mode} の起動のボタンがある`).toHaveLength(1);
  return found[0]!;
};
const click = (node: VNode): void => node.on!.click!();
const cardText = (h: Harness, title: string): string => textOf(byClass(h.tree(), "card").find((c) => textOf(c).includes(title))!);
const trackingBox = (h: Harness): VNode[] => byClass(h.tree(), "tracking");
const refreshButton = (h: Harness): VNode => byClass(h.tree(), "refresh")[0]!;

describe("起動(POST)の内容(A1・A2)", () => {
  it("朝のボタン → morning、発走前のボタン → pre_race。本文は画面のレースと開催日。init は POST・同じオリジンの資格情報・referrerPolicy: same-origin で、fetch の mode は入れない", async () => {
    const h = await started(RACE_HASH);
    expect(h.posts()).toHaveLength(0); // 前提: ボタンを押すまで POST は出ない
    click(runButton(h, "morning"));
    await h.settle();
    click(runButton(h, "pre_race"));
    await h.settle();
    const posts = h.posts();
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => JSON.parse(p.init.body!))).toEqual([
      { race_id: RACE_ID, kaisai_date: DATE, mode: "morning" },
      { race_id: RACE_ID, kaisai_date: DATE, mode: "pre_race" },
    ]);
    for (const p of posts) {
      expect(p.url).toBe("/api/analyses/run");
      expect(p.init.method).toBe("POST");
      expect(p.init.credentials).toBe("same-origin");
      expect(p.init.referrerPolicy).toBe("same-origin");
      expect(p.init.headers?.["content-type"]).toBe("application/json");
      expect([undefined, "cors"]).toContain((p.init as { mode?: string }).mode);
    }
  });

  it("開催日は画面(ハッシュ)の日付。別の日のレース画面から起動すると、その日の開催日を送る", async () => {
    const h = await started("#date=20260629&venue=central&race=202603020211", (x) => {
      x.responders.set("GET /api/analyses/status?kaisai_date=20260629&race_id=202603020211", async () => ok({ ok: true, kaisai_date: "20260629", races: [], prior: null }));
      x.responders.set("GET /api/analyses?race_id=202603020211&kaisai_date=20260629&limit=20", async () => ok({ ok: true, analyses: [] }));
      x.responders.set("POST /api/analyses/run", async () => resp(202, { ok: true, accepted: true, race_id: "202603020211", kaisai_date: "20260629", mode: "morning", status: "queued" }));
    });
    click(runButton(h, "morning"));
    await h.settle();
    expect(JSON.parse(h.posts()[0]!.init.body!)).toEqual({ race_id: "202603020211", kaisai_date: "20260629", mode: "morning" });
  });
});

describe("二重押し(A3)", () => {
  it("応答を待っている間は「送信中…」で disabled。同じボタン(古い木のハンドラ)を続けて押しても POST は 1 回だけ。応答後は次の再実行ができる", async () => {
    const gate = deferred<Resp>();
    const h = await started(RACE_HASH, (x) => x.responders.set("POST /api/analyses/run", () => gate.promise));
    const button = runButton(h, "morning");
    expect(textOf(button)).toBe("朝の準備を実行"); // 前提: 押す前は押せる
    expect(button.attrs?.["disabled"]).toBe(false);
    click(button);
    click(button); // 同期で続けて押す(await の前に印が立っていないと 2 回目も POST になる)
    expect(h.posts()).toHaveLength(1);
    expect(textOf(runButton(h, "morning"))).toBe("送信中…");
    expect(runButton(h, "morning").attrs?.["disabled"]).toBe(true);
    expect(textOf(runButton(h, "pre_race"))).toBe("発走前の分析を実行"); // もう一方のモードは押せる
    click(button); // 描画後の古いハンドラでも
    expect(h.posts()).toHaveLength(1);
    gate.resolve(resp(202, { ok: true, accepted: true, race_id: RACE_ID, kaisai_date: DATE, mode: "morning", status: "queued" }));
    await h.settle();
    expect(h.posts()).toHaveLength(1);
  });

  it("失敗したあとは、印が戻って再試行できる(2 回目の POST が出る)", async () => {
    let failing = true;
    const h = await started(RACE_HASH, (x) =>
      x.responders.set("POST /api/analyses/run", async () => (failing ? resp(503, { ok: false, error: { type: "race-day-error" } }) : resp(202, { ok: true, accepted: true, race_id: RACE_ID, kaisai_date: DATE, mode: "morning", status: "queued" }))),
    );
    click(runButton(h, "morning"));
    await h.settle();
    expect(h.posts()).toHaveLength(1);
    expect(runButton(h, "morning").attrs?.["disabled"]).toBe(false); // 前提: 失敗後は押せる
    failing = false;
    click(runButton(h, "morning"));
    await h.settle();
    expect(h.posts()).toHaveLength(2);
    expect(textOf(runButton(h, "morning"))).toBe("待ち");
  });
});

describe("202(A4): 待ちを重ね、追跡を始める", () => {
  it("202 のあと、最初のポーリングまでの間も、カードのバッジ・ボタンは「待ち」(ローカルで重ねる)。最初の取得は 3 秒後", async () => {
    const h = await started(RACE_HASH);
    h.rows = []; // サーバの板は(まだ)空に見える=最初のポーリングが来るまでローカルで重ねる必要がある
    const posts = h.posts().length;
    expect(cardText(h, "発走前")).toContain("未実行");
    click(runButton(h, "pre_race"));
    await h.settle();
    expect(h.posts().length).toBe(posts + 1);
    expect(cardText(h, "発走前")).toContain("待ち");
    expect(textOf(runButton(h, "pre_race"))).toBe("待ち");
    expect(runButton(h, "pre_race").attrs?.["disabled"]).toBe(true);
    const gets = h.gets().length;
    await h.timers.advance(2999);
    expect(h.gets().length).toBe(gets); // まだ取らない
    await h.timers.advance(1);
    expect(h.gets().slice(gets)).toEqual([BOARD_URL]);
  });

  it("POST より前に出したポーリングの古い応答(その時点の板)が、あとから届いても、待ちは消えない(古い「完了」に戻らない)", async () => {
    const h = await started(RACE_HASH, (x) => {
      x.rows = [jrow(RACE_ID, "morning", "done", { prior: true })];
      x.prior = PRIOR_BODY;
    });
    click(runButton(h, "pre_race")); // 追跡が始まる(サーバの板に pre_race の queued が入る)
    await h.settle();
    const staleRows = [jrow(RACE_ID, "morning", "done", { prior: true }), jrow(RACE_ID, "pre_race", "queued", { queued_at: 10_000 })]; // この時点の板
    const gate = deferred<Resp>();
    h.responders.set(`GET ${BOARD_URL}`, () => gate.promise);
    await h.timers.advance(3000); // ポーリング(保留)。次の POST より前に出した取得
    expect(h.gets().filter((u) => u === BOARD_URL)).toHaveLength(1);
    click(runButton(h, "morning")); // 朝のやり直しを起動する。この POST は、保留中のポーリングより後
    await h.settle();
    expect(cardText(h, "朝の準備")).toContain("待ち"); // 前提: 朝の待ちが重なっている(板の行は完了のまま)
    gate.resolve(ok({ ok: true, kaisai_date: DATE, races: staleRows }));
    await h.settle();
    expect(cardText(h, "朝の準備")).toContain("待ち"); // 古い応答(朝は完了)で消えない
    expect(textOf(runButton(h, "morning"))).toBe("待ち");
    expect(cardText(h, "発走前")).toContain("待ち"); // 板の行(pre_race の queued)は反映される
  });
});

describe("409(A5・A6)", () => {
  it("409(status: fetched)は失敗にしない: 「すでに実行中」と出し、バッジは取得済み、追跡を始める(3 秒後に取る)", async () => {
    const h = await started(RACE_HASH, (x) => x.responders.set("POST /api/analyses/run", async () => resp(409, { ok: false, error: { type: "already-running", status: "fetched" } })));
    click(runButton(h, "morning"));
    await h.settle();
    expect(byClass(h.tree(), "card").flatMap((c) => findAll(c, (n) => n.attrs?.["role"] === "alert"))).toHaveLength(0); // 失敗の表示(alert)が出ない
    expect(cardText(h, "朝の準備")).toContain("すでに実行中");
    expect(cardText(h, "朝の準備")).toContain("取得済み");
    expect(textOf(runButton(h, "morning"))).toBe("取得済み");
    expect(h.timers.pending()).toBe(1);
    const gets = h.gets().length;
    await h.timers.advance(3000);
    expect(h.gets().slice(gets)).toEqual([BOARD_URL]);
  });

  it("409 でも本文が想定外(status が done・無い・形違い)なら、採用せず固定の失敗文言(追跡は始めない)", async () => {
    for (const body of [{ ok: false, error: { type: "already-running", status: "done" } }, { ok: false, error: { type: "already-running" } }, undefined]) {
      const h = await started(RACE_HASH, (x) => x.responders.set("POST /api/analyses/run", async () => resp(409, body)));
      click(runButton(h, "morning"));
      await h.settle();
      const alerts = byClass(h.tree(), "card").flatMap((c) => findAll(c, (n) => n.attrs?.["role"] === "alert")).map(textOf);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain("HTTP 409");
      expect(cardText(h, "朝の準備")).not.toContain("すでに実行中");
      expect(h.timers.pending()).toBe(0);
    }
  });
});

describe("失敗の表示(A7・A9)", () => {
  const SERVER_MESSAGE = "サーバの文面<script>秘密</script>";
  const cases: readonly [string, () => Promise<Resp>, string][] = [
    ["400", async () => resp(400, { ok: false, error: { type: "bad-request", message: SERVER_MESSAGE } }), "リクエストが正しくありません"],
    ["413", async () => resp(413, { ok: false, error: { type: "payload-too-large", message: SERVER_MESSAGE } }), "リクエストが正しくありません"],
    ["415", async () => resp(415, { ok: false, error: { type: "unsupported-media-type", message: SERVER_MESSAGE } }), "リクエストが正しくありません"],
    ["403(origin-mismatch)", async () => resp(403, { ok: false, error: { type: "origin-mismatch", message: SERVER_MESSAGE } }), "Origin"],
    ["403(Access の拒否の平文)", async () => ({ status: 403, json: async () => Promise.reject(new Error("not json")) }), "ログインの期限切れ"],
    ["503", async () => resp(503, { ok: false, error: { type: "race-day-error", message: SERVER_MESSAGE } }), "サーバでエラー"],
    ["通信失敗", async () => Promise.reject(new Error("Failed to fetch")), "通信に失敗"],
  ];
  for (const [name, respond, expected] of cases) {
    it(`${name}: 固定の文言を、そのカードに role=alert で出す。サーバの文面は出さない。再試行できる。追跡は始めない`, async () => {
      const h = await started(RACE_HASH, (x) => x.responders.set("POST /api/analyses/run", respond));
      click(runButton(h, "pre_race"));
      await h.settle();
      const alerts = byClass(h.tree(), "card").flatMap((c) => findAll(c, (n) => n.attrs?.["role"] === "alert"));
      expect(alerts).toHaveLength(1);
      expect(textOf(alerts[0]!)).toContain(expected);
      expect(h.text()).not.toContain("サーバの文面");
      expect(h.text()).not.toContain("秘密");
      expect(cardText(h, "朝の準備")).not.toContain(expected); // もう一方のカードには出ない
      expect(runButton(h, "pre_race").attrs?.["disabled"]).toBe(false); // 再試行できる
      expect(textOf(runButton(h, "pre_race"))).toBe("発走前の分析を実行");
      expect(h.timers.pending()).toBe(0);
    });
  }

  it("次に押すと、前の失敗の文言は消える", async () => {
    let failing = true;
    const h = await started(RACE_HASH, (x) =>
      x.responders.set("POST /api/analyses/run", async () => (failing ? resp(503, { ok: false, error: { type: "race-day-error" } }) : resp(202, { ok: true, accepted: true, race_id: RACE_ID, kaisai_date: DATE, mode: "morning", status: "queued" }))),
    );
    click(runButton(h, "morning"));
    await h.settle();
    expect(byClass(h.tree(), "card").flatMap((c) => findAll(c, (n) => n.attrs?.["role"] === "alert"))).toHaveLength(1);
    failing = false;
    click(runButton(h, "morning"));
    await h.settle();
    expect(byClass(h.tree(), "card").flatMap((c) => findAll(c, (n) => n.attrs?.["role"] === "alert"))).toHaveLength(0);
  });

  it("202 でも本文が想定外(D8)なら、失敗の文言を出しつつ、追跡は始める(開催日の板を取りに行く。実行中の行が無くても 1 回は取る)", async () => {
    const h = await started(RACE_HASH, (x) => x.responders.set("POST /api/analyses/run", async () => resp(202, { ok: true })));
    click(runButton(h, "morning"));
    await h.settle();
    const alerts = byClass(h.tree(), "card").flatMap((c) => findAll(c, (n) => n.attrs?.["role"] === "alert")).map(textOf);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("想定外");
    expect(h.timers.pending()).toBe(1);
    const gets = h.gets().length;
    await h.timers.advance(3000);
    expect(h.gets().slice(gets)).toEqual([BOARD_URL]);
  });

  it("画面を離れても、遅れて届いた 202 は、そのレースの待ちとして一覧のバッジに反映される(今の画面を壊さない)", async () => {
    const gate = deferred<Resp>();
    const h = await started(RACE_HASH, (x) => x.responders.set("POST /api/analyses/run", () => gate.promise));
    click(runButton(h, "morning"));
    h.go(LIST_HASH);
    await h.settle(); // 一覧と板を取る
    gate.resolve(resp(202, { ok: true, accepted: true, race_id: RACE_ID, kaisai_date: DATE, mode: "morning", status: "queued" }));
    await h.settle();
    const rows = byClass(h.tree(), "race");
    expect(rows).toHaveLength(2); // 前提: 場が 1 つ(福島)なので開いている
    expect(textOf(rows[0]!)).toContain("朝: 待ち");
    expect(textOf(rows[1]!)).toContain("朝: 未実行");
  });
});

describe("追跡(B1〜B3・B8・B10・B13)", () => {
  /** 板の GET だけの呼び出し(ポーリング)。 */
  const boardGets = (h: Harness): number => h.gets().filter((u) => u === BOARD_URL).length;

  it("起動のあと、3 秒間隔で 10 回、そのあとは 5 秒間隔。取るのは status(race_id なし)だけで、一覧・分析の詳細・status?race_id=・過去の分析は取らない", async () => {
    const h = await started(RACE_HASH);
    const base = h.calls.length;
    click(runButton(h, "morning"));
    await h.settle();
    h.responders.set(`GET ${BOARD_URL}`, async () => ok({ ok: true, kaisai_date: DATE, races: [jrow(RACE_ID, "morning", "queued", { queued_at: 10_000 })] })); // いつまでも待ち
    await h.timers.advance(30_000);
    expect(boardGets(h)).toBe(10); // 3 秒 × 10 回
    await h.timers.advance(4999);
    expect(boardGets(h)).toBe(10);
    await h.timers.advance(1);
    expect(boardGets(h)).toBe(11); // 11 回目は 5 秒後
    const urls = h.calls.slice(base).map((c) => `${c.method} ${c.url}`);
    expect(urls.filter((u) => u !== `GET ${BOARD_URL}` && u !== "POST /api/analyses/run")).toEqual([]);
  });

  it("画面を開いたとき板に queued・fetched がある場合だけ追跡を始める(開いたとき 3 秒後に最初の取得)。すべて終わっていれば、始めない", async () => {
    const active = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "fetched")]));
    expect(active.timers.pending()).toBe(1);
    const base = active.gets().length;
    await active.timers.advance(3000);
    expect(active.gets().slice(base)).toEqual([BOARD_URL]);
    const idle = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "done", { prior: true }), jrow(RACE_ID, "pre_race", "failed")]));
    expect(idle.timers.pending()).toBe(0);
    const list = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    expect(list.timers.pending()).toBe(1); // 一覧を開いたときも同じ
    const listIdle = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "done")]));
    expect(listIdle.timers.pending()).toBe(0);
  });

  it("追跡の結果は、レース画面のカード(状態バッジ・ボタン)にそのまま反映される(status?race_id= を取り直さずに)", async () => {
    const h = await started(RACE_HASH);
    click(runButton(h, "pre_race"));
    await h.settle();
    const statusFetches = h.gets().filter((u) => u === STATUS_URL).length;
    h.rows = [jrow(RACE_ID, "pre_race", "fetched", { queued_at: 10_000 })];
    await h.timers.advance(3000);
    expect(cardText(h, "発走前")).toContain("取得済み");
    expect(textOf(runButton(h, "pre_race"))).toBe("取得済み");
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(statusFetches);
  });

  it("追跡の結果は、一覧のバッジと、場の見出しの要約(実行中・失敗)にも反映される", async () => {
    const h = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    const heading = () => textOf(byClass(h.tree(), "venue-toggle")[0]!);
    expect(heading()).toBe("▾ 福島・実行中 1");
    h.rows = [jrow(RACE_ID, "morning", "failed", { error: "x" })];
    await h.timers.advance(3000);
    expect(heading()).toBe("▾ 福島・失敗 1");
    expect(textOf(byClass(h.tree(), "race")[0]!)).toContain("朝: 失敗");
  });

  it("全部終わったら追跡をやめる(タイマーも残らない)。そのあと取らない", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "pre_race", "queued")]));
    h.rows = [jrow(RACE_ID, "pre_race", "failed", { error: "x" })];
    await h.timers.advance(3000);
    expect(h.timers.pending()).toBe(0);
    const gets = h.gets().length;
    await h.timers.advance(120_000);
    expect(h.gets().length).toBe(gets);
    expect(trackingBox(h)).toHaveLength(0); // 全部終わったときは注記を出さない
  });

  it("ポーリングの失敗は、板の注記(「実行状態を取得できませんでした」)を出さず、最後に取れた板(バッジ)を残す。取得中も「更新」は押せる", async () => {
    const h = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    h.responders.set(`GET ${BOARD_URL}`, async () => resp(503, { ok: false, error: { type: "race-day-error" } }));
    await h.timers.advance(3000);
    expect(byClass(h.tree(), "notice").map(textOf).join(" ")).not.toContain("実行状態");
    expect(textOf(byClass(h.tree(), "race")[0]!)).toContain("朝: 待ち"); // バッジが残っている
    // 取得中(保留)でも「更新」は disabled でない
    const gate = deferred<Resp>();
    h.responders.set(`GET ${BOARD_URL}`, () => gate.promise);
    await h.timers.advance(3000);
    expect(textOf(refreshButton(h))).toBe("更新");
    expect(refreshButton(h).attrs?.["disabled"]).toBe(false);
    gate.resolve(ok({ ok: true, kaisai_date: DATE, races: [jrow(RACE_ID, "morning", "queued")] }));
    await h.settle();
  });
});

describe("手動の取得とポーリングの関係(B13)", () => {
  it("手動の「更新」で板を取得中(行は一度消える)に、ポーリングが失敗しても、板の失敗の注記は出ない。ポーリングの取得は手動の取得に束ねず、別に出る", async () => {
    const h = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    const manual = deferred<Resp>();
    let call = 0;
    h.responders.set(`GET ${BOARD_URL}`, () => (call++ === 0 ? manual.promise : Promise.reject(new Error("poll failed"))));
    const before = h.gets().filter((u) => u === BOARD_URL).length;
    click(refreshButton(h)); // 手動の更新(一覧と板)。板の取得は保留
    await h.settle();
    expect(h.gets().filter((u) => u === BOARD_URL)).toHaveLength(before + 1);
    expect(byClass(h.tree(), "race").every((r) => !textOf(r).includes("朝:"))).toBe(true); // 前提: 板の行は一度消えている(バッジが出ない)
    await h.timers.advance(3000); // ポーリング(失敗する)
    expect(h.gets().filter((u) => u === BOARD_URL)).toHaveLength(before + 2); // 手動の取得に束ねず、別の取得が出た
    expect(byClass(h.tree(), "notice").map(textOf).join(" ")).not.toContain("実行状態");
    manual.resolve(ok({ ok: true, kaisai_date: DATE, races: [jrow(RACE_ID, "morning", "queued")] }));
    await h.settle();
    expect(textOf(byClass(h.tree(), "race")[0]!)).toContain("朝: 待ち");
  });
});

describe("完了への遷移(B11・B12・D5)", () => {
  it("朝の完了: レース画面にいれば、status?race_id= を 1 回だけ取り直し、prior の順位が出る。ポーリングはそのあと止まる", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(1); // 前提: 開いたとき 1 回
    expect(cardText(h, "朝の準備")).not.toContain("アルファ");
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true })];
    h.prior = PRIOR_BODY;
    await h.timers.advance(3000);
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(2); // 取り直しは 1 回
    expect(cardText(h, "朝の準備")).toContain("アルファ");
    expect(cardText(h, "朝の準備")).toContain("52.3%");
    await h.timers.advance(60_000);
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(2);
    expect(h.gets().filter((u) => u === PAST_URL)).toHaveLength(1); // 朝の完了では過去の分析を取り直さない
  });

  it("発走前の完了: 過去の分析を 1 回だけ取り直し、新しい分析へのリンクが出る(「結果を見る」は Issue #188 で廃止。結果はカードの中に出る〈下の describe〉)。prior は取り直さない", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "pre_race", "queued")]));
    expect(h.gets().filter((u) => u === PAST_URL)).toHaveLength(1);
    h.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 7 })];
    h.pastIds = [7];
    await h.timers.advance(3000);
    expect(h.gets().filter((u) => u === PAST_URL)).toHaveLength(2);
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(1);
    const hrefs = findAll(h.tree(), (n) => n.tag === "a").map((n) => n.attrs?.["href"]);
    expect(hrefs).toContain(`#date=${DATE}&venue=central&analysis=7`);
    expect(byClass(h.tree(), "past-link")).toHaveLength(1);
    expect(cardText(h, "発走前")).not.toContain("結果を見る");
    expect(cardText(h, "発走前")).toContain("分析7の馬"); // 結果は最初からカードの中に出る(旧版は「結果を見る」のリンクだった)
  });

  it("一覧にいるときの完了は、取得せずキャッシュを捨てるだけ。そのレース画面を開いたときに取り直す(1 回)", async () => {
    // 先にレース画面を開いてキャッシュを作ってから、一覧へ戻る。
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    h.go(LIST_HASH);
    await h.settle(); // 一覧を取る(板は種まきされているので板は取らない)
    const before = h.calls.length;
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true })];
    h.prior = PRIOR_BODY;
    await h.timers.advance(3000);
    const after = h.calls.slice(before).map((c) => c.url);
    expect(after).toEqual([BOARD_URL]); // ポーリングの 1 本だけ(prior は取り直さない)
    h.go(RACE_HASH);
    await h.settle();
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(2); // 開いたときに取り直した
    expect(cardText(h, "朝の準備")).toContain("アルファ");
  });

  it("レース画面の「更新」で完了を初めて見たときは、prior の取り直しを重ねない(更新の取得が、prior を一緒に持ってくる)", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true })];
    h.prior = PRIOR_BODY;
    click(refreshButton(h));
    await h.settle();
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(2); // 開いたとき + 更新(完了の取り直しで 3 回目にならない)
    expect(cardText(h, "朝の準備")).toContain("アルファ");
  });

  it("再実行の完了も 1 回(同じ完了を重ねて数えない)。最初から完了している板を開いても、取り直さない", async () => {
    const h = await started(RACE_HASH, (x) => {
      x.rows = [jrow(RACE_ID, "morning", "done", { prior: true, queued_at: 1000 })];
      x.prior = PRIOR_BODY;
    });
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(1);
    click(runButton(h, "morning")); // やり直し(サーバの行は queued_at が新しい queued になる)
    await h.settle();
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true, queued_at: 10_000 })];
    await h.timers.advance(3000);
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(2);
    await h.timers.advance(30_000);
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(2);
  });

  it("取り直しに失敗しても、カード(状態・ボタン・古い順位)は残り、注記だけが出る(カード全体を注記に置き換えない)", async () => {
    const h = await started(RACE_HASH, (x) => {
      x.rows = [jrow(RACE_ID, "morning", "queued")];
    });
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true })];
    h.responders.set(`GET ${STATUS_URL}`, async () => resp(503, { ok: false, error: { type: "race-day-error", message: "サーバの文面" } }));
    await h.timers.advance(3000);
    expect(byClass(h.tree(), "card")).toHaveLength(2);
    expect(cardText(h, "朝の準備")).toContain("完了");
    expect(cardText(h, "朝の準備")).toContain("順位");
    expect(cardText(h, "朝の準備")).toContain("取得できませんでした");
    expect(h.text()).not.toContain("サーバの文面");
    expect(textOf(runButton(h, "morning"))).toBe("朝の準備をやり直す");
  });
});

describe("停止と再開(B3・B4・D1)", () => {
  it("通信の失敗が 3 回続くと止まり、注記と「状態を更新」が出る(レース画面・一覧の両方)。それ以降は取らない", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    h.responders.set(`GET ${BOARD_URL}`, async () => Promise.reject(new Error("Failed to fetch")));
    await h.timers.advance(3000);
    await h.timers.advance(3000);
    expect(trackingBox(h)).toHaveLength(0); // 2 回では出ない
    await h.timers.advance(3000);
    expect(trackingBox(h)).toHaveLength(1);
    expect(textOf(trackingBox(h)[0]!)).toContain("通信に失敗");
    expect(textOf(byClass(trackingBox(h)[0]!, "retrack")[0]!)).toBe("状態を更新");
    const gets = h.gets().length;
    await h.timers.advance(60_000);
    expect(h.gets().length).toBe(gets);
    h.go(LIST_HASH); // 一覧にも出る
    await h.settle();
    expect(trackingBox(h)).toHaveLength(1);
  });

  it("5 分たつと止まる(注記に 5分)。5 分より前は止まらない", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    await h.timers.advance(299_999);
    expect(trackingBox(h)).toHaveLength(0);
    await h.timers.advance(1);
    expect(trackingBox(h)).toHaveLength(1);
    expect(textOf(trackingBox(h)[0]!)).toContain("5分");
  });

  it("「状態を更新」: すぐ 1 回取り、予算を新しくして再開する。全部終わっていれば注記が消える", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    h.responders.set(`GET ${BOARD_URL}`, async () => Promise.reject(new Error("x")));
    await h.timers.advance(9000);
    expect(trackingBox(h)).toHaveLength(1); // 前提: 止まっている
    h.responders.delete(`GET ${BOARD_URL}`);
    const gets = h.gets().length;
    click(byClass(trackingBox(h)[0]!, "retrack")[0]!);
    await h.settle();
    expect(h.gets().length).toBe(gets + 1); // すぐ 1 回
    expect(trackingBox(h)).toHaveLength(0); // 再開した(実行中のままなので追跡は続く)
    expect(h.timers.pending()).toBe(1);
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true })];
    await h.timers.advance(3000);
    expect(h.timers.pending()).toBe(0); // 全部終わった
  });

  it("D1: 止まったあと、既存の「更新」(レース画面・一覧)も追跡を再開する。実行中の行が無ければ再開しない", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    h.responders.set(`GET ${BOARD_URL}`, async () => Promise.reject(new Error("x")));
    await h.timers.advance(9000);
    expect(trackingBox(h)).toHaveLength(1);
    h.responders.delete(`GET ${BOARD_URL}`);
    click(refreshButton(h)); // レース画面の「更新」(status?race_id= と過去の分析を取り直す)
    await h.settle();
    expect(trackingBox(h)).toHaveLength(0);
    expect(h.timers.pending()).toBe(1);

    const g = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    g.responders.set(`GET ${BOARD_URL}`, async () => Promise.reject(new Error("x")));
    await g.timers.advance(9000);
    expect(trackingBox(g)).toHaveLength(1);
    g.rows = [jrow(RACE_ID, "morning", "done")];
    g.responders.delete(`GET ${BOARD_URL}`);
    click(refreshButton(g)); // 一覧の「更新」。全部終わっている板なので、再開しない
    await g.settle();
    expect(g.timers.pending()).toBe(0);
    expect(trackingBox(g)).toHaveLength(0);
  });

  it("世代・通し番号: 取得が止まったまま(タイムアウトなし)でも、表示の切り替えで新しい取得が追い越せる。あとから届いた古い取得の応答は、新しい板を古い内容に戻さず、追跡も再開しない", async () => {
    const h = await started(LIST_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    const heading = () => textOf(byClass(h.tree(), "venue-toggle")[0]!);
    expect(heading()).toBe("▾ 福島・実行中 1"); // 前提
    const hung = deferred<Resp>();
    h.responders.set(`GET ${BOARD_URL}`, () => hung.promise);
    await h.timers.advance(3000); // 取得 1(止まったまま)
    expect(h.gets().filter((u) => u === BOARD_URL)).toHaveLength(2); // 開いたとき 1 回 + 取得 1
    h.visible = false;
    h.app.onVisibilityChange();
    h.visible = true;
    h.responders.set(`GET ${BOARD_URL}`, async () => ok({ ok: true, kaisai_date: DATE, races: [jrow(RACE_ID, "morning", "done")] }));
    h.app.onVisibilityChange(); // 表示に戻る=世代を進めて即時に取る(止まった取得とは別の本)
    await h.settle();
    expect(h.gets().filter((u) => u === BOARD_URL)).toHaveLength(3);
    expect(heading()).toBe("▾ 福島"); // 完了(実行中が消えた)
    expect(h.timers.pending()).toBe(0);
    hung.resolve(ok({ ok: true, kaisai_date: DATE, races: [jrow(RACE_ID, "morning", "queued")] })); // 古い内容(待ち)の応答が、今ごろ届く
    await h.settle();
    expect(heading()).toBe("▾ 福島"); // 古い内容に戻らない
    expect(h.timers.pending()).toBe(0); // 追跡を再開しない
    expect(trackingBox(h)).toHaveLength(0);
  });
});

describe("可視状態(B5)", () => {
  it("非表示にするとタイマーが無くなり、取らない。表示に戻ると即時に 1 回取る", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "morning", "queued")]));
    expect(h.timers.pending()).toBe(1); // 前提: 追跡している
    h.visible = false;
    h.app.onVisibilityChange();
    expect(h.timers.pending()).toBe(0);
    const gets = h.gets().length;
    await h.timers.advance(120_000);
    expect(h.gets().length).toBe(gets);
    h.visible = true;
    h.app.onVisibilityChange();
    await h.settle();
    expect(h.gets().slice(gets)).toEqual([BOARD_URL]);
    expect(h.timers.pending()).toBe(1);
  });
});

describe("複数の日(B9)", () => {
  it("別の日の画面に移っても、起動した日の板を追い続ける。その日が終わったら、その日は追わない", async () => {
    const OTHER = "20260629";
    const h = await started(RACE_HASH);
    click(runButton(h, "morning"));
    await h.settle();
    h.responders.set(`GET /api/races?kaisai_date=${OTHER}&venue=central`, async () => ok({ ok: true, kaisai_date: OTHER, venue: "central", races: [] }));
    h.responders.set(`GET /api/analyses/status?kaisai_date=${OTHER}`, async () => ok({ ok: true, kaisai_date: OTHER, races: [] }));
    h.go(`#date=${OTHER}&venue=central`);
    await h.settle();
    const base = h.gets().length;
    await h.timers.advance(3000);
    expect(h.gets().slice(base)).toEqual([BOARD_URL]); // 起動した日(別の日の画面にいても)だけ。実行中でない日は取らない
    h.rows = [jrow(RACE_ID, "morning", "done", { prior: true, queued_at: 10_000 })];
    await h.timers.advance(3000);
    expect(h.timers.pending()).toBe(0);
  });
});

describe("日付の入力(段階1【記録】1)", () => {
  it("不正・空の日付の入力は、強制の再描画を起こす(入力欄を画面の日付に戻す。同じ木の描画の省略に隠さない)。有効な日付は強制しない", async () => {
    const h = await started(LIST_HASH);
    const input = findAll(h.tree(), (n) => n.tag === "input")[0]!;
    const before = h.renders.length;
    input.on!.change!("");
    input.on!.change!("2026-02-30");
    input.on!.change!("not-a-date");
    expect(h.renders.slice(before)).toEqual([{ force: true }, { force: true }, { force: true }]);
    const valid = h.renders.length;
    input.on!.change!("2026-06-29");
    expect(h.renders.slice(valid).filter((r) => r.force)).toEqual([]); // 有効な日付はハッシュの遷移(hashchange)で描画される
    expect(h.hash).toContain("date=20260629");
  });
});

/**
 * Issue #188: 発走前の結果(`GET /api/analyses/{id}`。R2 の Class B +1)を、ポーリング・完了への遷移・再実行と組み合わせたときの取得の回数。
 * 画面を開いたときの取得・結果画面とのキャッシュ共有・「更新」・開閉は client-app.test.ts。
 */
describe("発走前の結果の取得(Issue #188): ポーリング・完了への遷移・再実行", () => {
  const horsesIn = (h: Harness): VNode[] => byClass(byClass(h.tree(), "card").find((c) => textOf(c).includes("発走前"))!, "horse");
  const DETAIL = (id: number): string => `/api/analyses/${id}`;

  it("ポーリングの周期では取らない: 完了済みの発走前(id 5)を開いて、別の行(朝)の追跡が続く間、ポーリングを何周しても 1 回のまま。朝の完了(prior の取り直し)でも増えない", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 5 }), jrow(RACE_ID, "morning", "queued")]));
    expect(h.detailGets()).toEqual([DETAIL(5)]);
    expect(horsesIn(h)).toHaveLength(1);
    const boardBefore = h.gets().filter((u) => u === BOARD_URL).length;
    for (let i = 0; i < 5; i += 1) await h.timers.advance(3000);
    expect(h.gets().filter((u) => u === BOARD_URL).length - boardBefore, "前提: ポーリングが実際に何周も回っている").toBeGreaterThanOrEqual(5);
    expect(h.detailGets()).toEqual([DETAIL(5)]);
    h.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 5 }), jrow(RACE_ID, "morning", "done", { prior: true })];
    h.prior = PRIOR_BODY;
    await h.timers.advance(3000);
    expect(h.gets().filter((u) => u === STATUS_URL)).toHaveLength(2); // 前提: 朝の完了で prior を取り直した
    expect(h.detailGets()).toEqual([DETAIL(5)]);
    expect(horsesIn(h)).toHaveLength(1);
  });

  it("完了への遷移: 発走前が queued → done(id 7)になったら、新しい id を 1 回だけ取り、カードに出す。あとのポーリング・描画では増えない", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "pre_race", "queued")]));
    expect(h.detailGets()).toEqual([]); // 前提: 実行中は取らない
    expect(horsesIn(h)).toHaveLength(0);
    h.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 7 })];
    h.pastIds = [7];
    await h.timers.advance(3000);
    expect(h.detailGets()).toEqual([DETAIL(7)]);
    expect(cardTextOf(h)).toContain("分析7の馬");
    await h.timers.advance(60_000);
    h.go(RACE_HASH);
    await h.settle();
    expect(h.detailGets()).toEqual([DETAIL(7)]);
  });

  it("再実行: 完了済み(id 5)のカードは、再実行を押すと結果を隠し(待ち)、新しい id(8)で完了したら 8 を 1 回だけ取って 8 を出す。旧 id 5 は取り直さない", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 5, queued_at: 1000 })]));
    expect(h.detailGets()).toEqual([DETAIL(5)]);
    expect(cardTextOf(h)).toContain("分析5の馬");
    click(runButton(h, "pre_race"));
    await h.settle();
    expect(h.posts()).toHaveLength(1); // 前提: 再実行が受け付けられた(板は queued・analysis_id なし)
    expect(horsesIn(h)).toHaveLength(0);
    expect(cardTextOf(h)).not.toContain("分析5の馬");
    await h.timers.advance(3000);
    expect(horsesIn(h), "実行中の間、前の結果は出ない").toHaveLength(0);
    expect(h.detailGets()).toEqual([DETAIL(5)]);
    h.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 8, queued_at: 10_000 })];
    h.pastIds = [8, 5];
    await h.timers.advance(3000);
    expect(h.detailGets()).toEqual([DETAIL(5), DETAIL(8)]);
    expect(cardTextOf(h)).toContain("分析8の馬");
    expect(cardTextOf(h)).not.toContain("分析5の馬");
    await h.timers.advance(60_000);
    expect(h.detailGets()).toEqual([DETAIL(5), DETAIL(8)]);
  });

  it("一覧にいる間に完了しても、取得はしない(板のポーリングだけ)。そのレース画面を開き直したとき、新しい id を 1 回だけ取る(状態がキャッシュ済みでも)", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "pre_race", "queued")]));
    h.go(LIST_HASH);
    await h.settle();
    const before = h.calls.length;
    h.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 7 })];
    await h.timers.advance(3000);
    expect(h.calls.slice(before).map((c) => c.url)).toEqual([BOARD_URL]); // 前提: 完了を検知した(板が取れた)。分析は取らない
    expect(h.detailGets()).toEqual([]);
    h.go(RACE_HASH);
    await h.settle();
    expect(h.detailGets()).toEqual([DETAIL(7)]);
    expect(cardTextOf(h)).toContain("分析7の馬");
    h.go(LIST_HASH);
    await h.settle();
    h.go(RACE_HASH);
    await h.settle();
    expect(h.detailGets()).toEqual([DETAIL(7)]);
  });

  it("失敗は、ポーリングの周期でも自動では再試行しない(1 回のまま)。カードには注記が出続ける", async () => {
    const h = await started(RACE_HASH, (x) => {
      x.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 5 }), jrow(RACE_ID, "morning", "queued")];
      x.responders.set(`GET ${DETAIL(5)}`, async () => resp(503, { ok: false, error: { type: "d1-error", message: "秘密の文面" } }));
    });
    expect(h.detailGets()).toEqual([DETAIL(5)]);
    expect(cardTextOf(h)).toContain("サーバでエラー");
    for (let i = 0; i < 5; i += 1) await h.timers.advance(3000);
    expect(h.detailGets()).toEqual([DETAIL(5)]);
    expect(cardTextOf(h)).toContain("サーバでエラー");
    expect(h.text()).not.toContain("秘密の文面");
    expect(horsesIn(h)).toHaveLength(0);
  });

  it("結果画面にいるとき(race と analysis が両方あるハッシュ=結果画面)は、板が完了しても最新の分析を取らない(レース画面の取得をしない。状態はキャッシュ済み)", async () => {
    const h = await started(RACE_HASH, (x) => (x.rows = [jrow(RACE_ID, "pre_race", "queued")]));
    h.go(`${RACE_HASH}&analysis=5`);
    await h.settle();
    expect(h.detailGets()).toEqual([DETAIL(5)]); // 前提: 結果画面が開いている
    h.rows = [jrow(RACE_ID, "pre_race", "done", { analysis_id: 9 })];
    await h.timers.advance(3000);
    expect(h.gets().filter((u) => u === BOARD_URL).length, "前提: 完了を検知した板が取れている").toBeGreaterThanOrEqual(1);
    await h.timers.advance(60_000);
    expect(h.detailGets()).toEqual([DETAIL(5)]);
  });
});

const cardTextOf = (h: Harness): string => textOf(byClass(h.tree(), "card").find((c) => textOf(c).includes("発走前"))!);
