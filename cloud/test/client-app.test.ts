import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { VNode } from "../client/vnode";

/**
 * Issue #184: 一覧の画面の制御(取得・メモリキャッシュ・遷移)。偽の fetch・偽のハッシュ・描画の記録。
 * 守ること(netkeiba への取得と DO の起動を、画面の操作で増やさない):
 *  - 一覧(races)は (開催日, 区分) ごとに 1 回。画面の往復(一覧 → レース → 一覧、中央 → 地方 → 中央)で取り直さない
 *  - 板(status。race_id なし)は開催日ごとに 1 回。区分を切り替えても取り直さない
 *  - 失敗は自動で再試行しない(「更新」だけが取り直す)。同時に同じものを 2 本取らない
 *  - `POST` は呼ばない(起動は #186)
 * Issue #185: レース画面(`status?race_id=`・過去の分析の一覧を、開いたときに 1 回)・結果画面(`/api/analyses/{id}` を、開いたときに 1 回。メモリにキャッシュ)も同じ方針。
 * レース画面・結果画面は、一覧(`/api/races`)と板(`status`〈race_id なし〉)を取らない(netkeiba に出ない・DO を余計に起こさない)。
 */

const DATE = "20260628";
const RACES_CENTRAL = `/api/races?kaisai_date=${DATE}&venue=central`;
const RACES_NAR = `/api/races?kaisai_date=${DATE}&venue=nar`;
const BOARD = `/api/analyses/status?kaisai_date=${DATE}`;
const RACE_ID = "202603020211";
const RACE_STATUS = `${BOARD}&race_id=${RACE_ID}`;
const PAST = `/api/analyses?race_id=${RACE_ID}&kaisai_date=${DATE}&limit=20`;
const ANALYSIS_5 = "/api/analyses/5";

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
const raceRow = (raceId: string, name: string) => ({ race_id: raceId, venue_name: "福島", race_number: Number(raceId.slice(-2)), race_name: name, course_type: "芝", distance: 1800, entry_count: 16, grade: null });
const racesBody = (venue: string, rows: ReturnType<typeof raceRow>[]) => ({ ok: true, kaisai_date: DATE, venue, races: rows });
const boardRow = (raceId: string, mode: string, status: string, over: Record<string, unknown> = {}) => ({ race_id: raceId, mode, status, attempts: 0, error: null, queued_at: 1, updated_at: 2, prior: false, analysis_id: null, detail: null, children_ok: null, ...over });

const priorBody = {
  race_name: "福島民報杯",
  venue_name: "福島",
  date: "2026-06-28",
  computed_at: 5000,
  rows: [{ rank: 1, umaban: 3, horse_name: "アルファ", prior: 0.523 }],
};
const raceStatusBody = (rows: ReturnType<typeof boardRow>[], prior: unknown = null) => ({ ok: true, kaisai_date: DATE, races: rows, prior });
const pastBody = (ids: number[]) => ({ ok: true, analyses: ids.map((id) => ({ id, raceId: RACE_ID, analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: null, promptVersion: null, horses: [], hasDetail: true })) });
const analysisBody = (over: Record<string, unknown> = {}) => ({
  ok: true,
  analysis: {
    id: 5,
    raceId: RACE_ID,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: DATE,
    evEstimated: false,
    model: null,
    promptVersion: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", startTime: null, courseType: null, distance: null, weather: null, trackCondition: null },
    horses: [{ umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.2, isPositive: true, mark: null, reason: null }],
    allocation: null,
    detail: "present",
    ...over,
  },
});

function textOf(node: VNode | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join(" ");
}
function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}

interface Harness {
  readonly app: App;
  readonly calls: string[];
  readonly hashes: string[];
  readonly responders: Map<string, () => Promise<Resp>>;
  hash: string;
  tree(): VNode;
  text(): string;
  /** ハッシュを変えて、ブラウザの hashchange 相当を起こす。 */
  go(hash: string): void;
}

function harness(initialHash: string, now = new Date("2026-06-28T00:00:00Z")): Harness {
  const responders = new Map<string, () => Promise<Resp>>([
    [RACES_CENTRAL, async () => ok(racesBody("central", [raceRow("202603020211", "福島民報杯"), raceRow("202603020212", "福島12R")]))],
    [RACES_NAR, async () => ok(racesBody("nar", [raceRow("202654062801", "地方1R")]))],
    [BOARD, async () => ok({ ok: true, kaisai_date: DATE, races: [boardRow("202603020211", "morning", "done")] })],
    [RACE_STATUS, async () => ok(raceStatusBody([boardRow(RACE_ID, "morning", "done", { prior: true }), boardRow(RACE_ID, "pre_race", "done", { analysis_id: 5 })], priorBody))],
    [PAST, async () => ok(pastBody([5]))],
    [ANALYSIS_5, async () => ok(analysisBody())],
  ]);
  const calls: string[] = [];
  const hashes: string[] = [];
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
    hashes,
    responders,
    tree: () => tree!,
    text: () => textOf(tree!),
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
    app: undefined as never,
  };
  (h as { app: App }).app = createApp({
    fetch: fetchLike,
    now: () => now,
    render: (t) => {
      tree = t;
    },
    getHash: () => h.hash,
    setHash: (hash) => {
      hashes.push(hash);
    },
  });
  return h;
}

describe("起動と取得", () => {
  it("ハッシュが無ければ、今日(JST)・中央の一覧と、その日の板を 1 回ずつ取る(UTC の 15:00 は JST の翌日)", async () => {
    const h = harness("", new Date("2026-06-27T15:00:00Z"));
    h.app.start();
    await h.app.whenIdle();
    expect([...h.calls].sort()).toEqual([BOARD, RACES_CENTRAL].sort());
    expect(h.hashes).toEqual([]); // 起動でハッシュを書き換えない
  });

  it("一覧とバッジを描画する(板の (race_id, mode) → バッジ)", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    h.app.start();
    expect(h.text()).toContain("読み込み中"); // 取得前も描画される
    await h.app.whenIdle();
    expect(h.text()).toContain("福島民報杯");
    expect(h.text()).toContain("福島12R");
    const rows = findAll(h.tree(), (n) => n.attrs?.["class"] === "race");
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0]!)).toContain("朝: 完了");
    expect(textOf(rows[0]!)).toContain("発走前: 未実行");
    expect(textOf(rows[1]!)).toContain("朝: 未実行");
  });

  it("板の取得に失敗しても一覧は出る(注記つき)。一覧の取得に失敗したら、失敗の文言を出す", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    h.responders.set(BOARD, async () => ({ status: 503, json: async () => ({ ok: false, error: { type: "race-day-error" } }) }));
    h.app.start();
    await h.app.whenIdle();
    expect(h.text()).toContain("福島民報杯");
    expect(findAll(h.tree(), (n) => n.attrs?.["class"] === "notice").length).toBeGreaterThan(0);
    expect(h.text()).not.toContain("朝: 完了");

    const e = harness(`#date=${DATE}&venue=central`);
    e.responders.set(RACES_CENTRAL, async () => ({ status: 503, json: async () => ({ ok: false, error: { type: "netkeiba-unavailable", reason: "busy" } }) }));
    e.app.start();
    await e.app.whenIdle();
    expect(e.text()).toContain("混み合っています");
    expect(findAll(e.tree(), (n) => n.attrs?.["class"] === "race")).toHaveLength(0);
  });
});

describe("メモリキャッシュ(画面の往復で取り直さない)", () => {
  it("区分を切り替えても板は取り直さず、一覧は区分ごとに 1 回。戻っても取り直さない", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(2);

    h.go(`#date=${DATE}&venue=nar`);
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]).toBe(RACES_NAR);
    expect(h.text()).toContain("地方1R");

    h.go(`#date=${DATE}&venue=central`);
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(3); // 戻っても取り直さない
    expect(h.text()).toContain("福島民報杯");
  });

  it("日付を変えると、その日の一覧と板を取る(別の日は別のキー)", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    h.responders.set("/api/races?kaisai_date=20260627&venue=central", async () => ok(racesBody("central", [])));
    h.responders.set("/api/analyses/status?kaisai_date=20260627", async () => ok({ ok: true, kaisai_date: "20260627", races: [] }));
    h.app.start();
    await h.app.whenIdle();
    h.go("#date=20260627&venue=central");
    await h.app.whenIdle();
    expect(h.calls.slice(2).sort()).toEqual(["/api/analyses/status?kaisai_date=20260627", "/api/races?kaisai_date=20260627&venue=central"]);
    expect(h.text()).toContain("開催はありません");
  });

  it("一覧からレースの行へ進むと、レース画面の取得(状態・過去の分析)だけが増える。一覧へ戻っても取り直さない。レース画面は一覧のキャッシュから見出しを作る", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    h.app.start();
    await h.app.whenIdle();
    const before = h.calls.length;
    h.go(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await h.app.whenIdle();
    expect(h.calls.slice(before).sort()).toEqual([PAST, RACE_STATUS].sort());
    expect(h.text()).toContain("福島民報杯");
    expect(h.text()).toContain("朝の準備");
    h.go(`#date=${DATE}&venue=central`);
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(before + 2);
    expect(h.text()).toContain("福島12R");
    h.go(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(before + 2); // レース画面に戻っても取り直さない
  });

  it("race 付きのハッシュで直接開くと、状態(race_id つき)と過去の分析の 2 本だけを取る。一覧(netkeiba に出る)・板(race_id なし)・分析の詳細・POST は呼ばない", async () => {
    const h = harness(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls.sort()).toEqual([PAST, RACE_STATUS].sort());
    expect(h.text()).toContain("朝の準備");
    expect(h.text()).toContain("発走前");
    expect(h.text()).toContain("1位"); // 朝が完了・prior あり → 順位
    expect(findAll(h.tree(), (n) => n.tag === "a" && textOf(n).includes("結果を見る"))[0]!.attrs?.["href"]).toBe(`#date=${DATE}&venue=central&analysis=5`);
    expect(findAll(h.tree(), (n) => n.tag === "a" && n.attrs?.["class"] === "past-link").map((n) => n.attrs?.["href"])).toEqual([`#date=${DATE}&venue=central&analysis=5`]);
    // 「結果を見る」は明示の操作(リンク)で、自動で結果画面を開かない
    expect(h.calls.filter((u) => /^\/api\/analyses\/\d/.test(u))).toEqual([]);
    expect(h.hashes).toEqual([]);
  });

  it("結果画面(#analysis=<id>)は、開いたとき /api/analyses/{id} を 1 回だけ取る。往復・再描画で取り直さない。一覧・板・レース画面の取得は起こさない", async () => {
    const h = harness(`#analysis=5`);
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toEqual([ANALYSIS_5]);
    expect(h.text()).toContain("福島11R テストステークス");
    expect(h.text()).toContain("LLM 未使用(統計のみ)");
    h.go(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await h.app.whenIdle();
    h.go(`#analysis=5`);
    await h.app.whenIdle();
    h.go(`#analysis=5`);
    h.go(`#analysis=5`);
    await h.app.whenIdle();
    expect(h.calls.filter((u) => u === ANALYSIS_5)).toHaveLength(1);
    expect(h.calls.filter((u) => u.startsWith("/api/races") || u === BOARD)).toEqual([]);
  });

  it("別の分析 id は別に 1 回取る。取得中に何度 hashchange しても 1 本", async () => {
    const h = harness(`#analysis=5`);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.responders.set(ANALYSIS_5, async () => {
      await gate;
      return ok(analysisBody());
    });
    h.responders.set("/api/analyses/6", async () => ok(analysisBody({ id: 6 })));
    h.app.start();
    h.go(`#analysis=5`);
    h.go(`#analysis=5`);
    release();
    await h.app.whenIdle();
    expect(h.calls).toEqual([ANALYSIS_5]);
    h.go(`#analysis=6`);
    await h.app.whenIdle();
    expect(h.calls).toEqual([ANALYSIS_5, "/api/analyses/6"]);
  });

  it("race と analysis が両方あるハッシュは、結果画面(analysis)を開く", async () => {
    const h = harness(`#date=${DATE}&venue=central&race=${RACE_ID}&analysis=5`);
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toEqual([ANALYSIS_5]);
    expect(h.text()).toContain("分析時刻");
  });

  it("結果の取得に失敗したら、固定の文言(サーバの文面でない)と「更新」。自動では再試行せず(戻っても取り直さない)、「更新」で 1 回だけ取り直す。成功した画面に「更新」は無い", async () => {
    const h = harness(`#analysis=5`);
    let failing = true;
    h.responders.set(ANALYSIS_5, async () => (failing ? { status: 503, json: async () => ({ ok: false, error: { type: "d1-error", message: "秘密の文面" } }) } : ok(analysisBody())));
    h.app.start();
    await h.app.whenIdle();
    expect(h.text()).toContain("サーバでエラー");
    expect(h.text()).not.toContain("秘密の文面");
    h.go(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await h.app.whenIdle();
    h.go(`#analysis=5`);
    await h.app.whenIdle();
    expect(h.calls.filter((u) => u === ANALYSIS_5)).toHaveLength(1); // 自動の再試行なし
    failing = false;
    const refresh = findAll(h.tree(), (n) => n.tag === "button" && textOf(n).includes("更新"))[0]!;
    refresh.on!.click!();
    refresh.on!.click!(); // 取得中の連打は 1 本
    await h.app.whenIdle();
    expect(h.calls.filter((u) => u === ANALYSIS_5)).toHaveLength(2);
    expect(h.text()).toContain("福島11R テストステークス");
    expect(findAll(h.tree(), (n) => n.tag === "button")).toHaveLength(0);
  });

  it("結果が 404(無い id)なら「見つかりません」の文言", async () => {
    const h = harness(`#analysis=5`);
    h.responders.set(ANALYSIS_5, async () => ({ status: 404, json: async () => ({ ok: false, error: { type: "not-found" } }) }));
    h.app.start();
    await h.app.whenIdle();
    expect(h.text()).toContain("見つかりません");
  });

  it("結果画面の「戻る」は、分析の開催日のレース画面へ(ハッシュの日付が既定の今日でも)", async () => {
    const h = harness(`#analysis=5`, new Date("2026-10-07T00:00:00Z"));
    h.app.start();
    await h.app.whenIdle();
    const back = findAll(h.tree(), (n) => n.tag === "a" && n.attrs?.["class"] === "back")[0]!;
    expect(back.attrs?.["href"]).toBe(`#date=${DATE}&venue=central&race=${RACE_ID}`);
  });
});

describe("レース画面の失敗・更新", () => {
  it("状態の取得に失敗しても過去の分析は出る(逆も)。自動では再試行しない。「更新」は状態と過去の分析の 2 本を 1 回ずつ取り直す(取得中は押せない)", async () => {
    const h = harness(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    let failing = true;
    h.responders.set(RACE_STATUS, async () => (failing ? { status: 503, json: async () => ({ ok: false, error: { type: "race-day-error" } }) } : ok(raceStatusBody([boardRow(RACE_ID, "morning", "queued")]))));
    h.app.start();
    await h.app.whenIdle();
    expect(h.text()).toContain("サーバでエラー");
    expect(findAll(h.tree(), (n) => n.attrs?.["class"] === "card")).toHaveLength(0);
    expect(h.text()).toContain("過去の分析");
    expect(findAll(h.tree(), (n) => n.attrs?.["class"] === "past-link")).toHaveLength(1);
    h.go(`#date=${DATE}&venue=nar`);
    await h.app.whenIdle();
    h.go(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await h.app.whenIdle();
    expect(h.calls.filter((u) => u === RACE_STATUS)).toHaveLength(1);

    failing = false;
    const before = h.calls.length;
    const refresh = findAll(h.tree(), (n) => n.tag === "button" && textOf(n).includes("更新"))[0]!;
    refresh.on!.click!();
    refresh.on!.click!();
    await h.app.whenIdle();
    expect(h.calls.slice(before).sort()).toEqual([PAST, RACE_STATUS].sort());
    expect(findAll(h.tree(), (n) => n.attrs?.["class"] === "card")).toHaveLength(2);
  });

  it("同じ race_id でも日付が違えば別のキー(別の日のレース画面に、別の日の状態を混ぜない)", async () => {
    const h = harness(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    const OTHER = "20260627";
    h.responders.set(`/api/analyses/status?kaisai_date=${OTHER}&race_id=${RACE_ID}`, async () => ok(raceStatusBody([boardRow(RACE_ID, "morning", "failed")])));
    h.responders.set(`/api/analyses?race_id=${RACE_ID}&kaisai_date=${OTHER}&limit=20`, async () => ok(pastBody([])));
    h.app.start();
    await h.app.whenIdle();
    h.go(`#date=${OTHER}&venue=central&race=${RACE_ID}`);
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(4);
    expect(h.text()).toContain("失敗");
    expect(h.text()).not.toContain("1位");
  });

  it("取得中に別の画面へ移っても、遅れて届いた結果はキャッシュされ、今の画面を壊さない", async () => {
    const h = harness(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.responders.set(RACE_STATUS, async () => {
      await gate;
      return ok(raceStatusBody([boardRow(RACE_ID, "morning", "queued")]));
    });
    h.app.start();
    h.go(`#analysis=5`);
    release();
    await h.app.whenIdle();
    expect(h.text()).toContain("分析時刻");
    expect(h.text()).not.toContain("朝の準備");
    const before = h.calls.length;
    h.go(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(before);
    expect(h.text()).toContain("待ち");
  });
});

describe("同時取得・失敗・更新", () => {
  it("取得中に同じキーへ何度 hashchange しても、取得は 1 本", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.responders.set(RACES_CENTRAL, async () => {
      await gate;
      return ok(racesBody("central", [raceRow("202603020211", "福島民報杯")]));
    });
    h.app.start();
    h.go(`#date=${DATE}&venue=central`);
    h.go(`#date=${DATE}&venue=central`);
    release();
    await h.app.whenIdle();
    expect(h.calls.filter((u) => u === RACES_CENTRAL)).toHaveLength(1);
    expect(h.calls.filter((u) => u === BOARD)).toHaveLength(1);
  });

  it("取得中に別の画面へ移っても、遅れて届いた結果は(その画面を壊さず)キャッシュされ、戻ったときに取り直さない", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.responders.set(RACES_CENTRAL, async () => {
      await gate;
      return ok(racesBody("central", [raceRow("202603020211", "福島民報杯")]));
    });
    h.app.start();
    h.go(`#date=${DATE}&venue=nar`);
    release();
    await h.app.whenIdle();
    expect(h.text()).toContain("地方1R");
    expect(h.text()).not.toContain("福島民報杯"); // 地方の画面に中央の結果が混ざらない
    const before = h.calls.length;
    h.go(`#date=${DATE}&venue=central`);
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(before);
    expect(h.text()).toContain("福島民報杯");
  });

  it("失敗は自動で再試行しない(別の画面から戻っても取り直さない)。「更新」だけが、一覧と板を取り直す", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    let failing = true;
    h.responders.set(RACES_CENTRAL, async () =>
      failing ? { status: 503, json: async () => ({ ok: false, error: { type: "netkeiba-unavailable", reason: "blocked" } }) } : ok(racesBody("central", [raceRow("202603020211", "福島民報杯")])),
    );
    h.app.start();
    await h.app.whenIdle();
    expect(h.text()).toContain("止められています");
    const before = h.calls.length;

    h.go(`#date=${DATE}&venue=nar`);
    await h.app.whenIdle();
    h.go(`#date=${DATE}&venue=central`);
    await h.app.whenIdle();
    expect(h.calls.filter((u) => u === RACES_CENTRAL)).toHaveLength(1); // 自動の再試行なし
    expect(h.calls.length).toBe(before + 1); // 地方の一覧だけ

    failing = false;
    const refresh = findAll(h.tree(), (n) => n.tag === "button" && textOf(n).includes("更新"))[0]!;
    expect(refresh.attrs?.["disabled"]).toBeFalsy();
    const beforeRefresh = h.calls.length;
    refresh.on!.click!();
    await h.app.whenIdle();
    expect(h.calls.slice(beforeRefresh).sort()).toEqual([BOARD, RACES_CENTRAL].sort());
    expect(h.text()).toContain("福島民報杯");
  });

  it("読み込み中は「更新」を押せない(disabled)。押されても取得は増えない", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.responders.set(RACES_CENTRAL, async () => {
      await gate;
      return ok(racesBody("central", []));
    });
    h.app.start();
    const refresh = findAll(h.tree(), (n) => n.tag === "button" && textOf(n).includes("読み込み中"))[0]!;
    expect(refresh.attrs?.["disabled"]).toBe(true);
    const before = h.calls.length;
    refresh.on!.click!();
    refresh.on!.click!();
    expect(h.calls).toHaveLength(before);
    release();
    await h.app.whenIdle();
  });
});

describe("板の取得中・失敗(#184 の【記録】。Issue #186 段階1)", () => {
  const refreshButton = (h: Harness) => findAll(h.tree(), (n) => n.tag === "button" && n.attrs?.["class"] === "refresh")[0]!;
  const notices = (h: Harness) => findAll(h.tree(), (n) => n.attrs?.["class"] === "notice").map(textOf);

  it("板の取得中は「更新」を押せない(一覧は取得済みでも)。押されても取得は増えない。板が届けば押せる", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.responders.set(BOARD, async () => {
      await gate;
      return ok({ ok: true, kaisai_date: DATE, races: [] });
    });
    h.app.start();
    // 一覧だけが先に届くまで待つ(板は保留のまま)
    for (let i = 0; i < 20 && !h.text().includes("福島民報杯"); i += 1) await Promise.resolve();
    expect(h.text()).toContain("福島民報杯"); // 前提: 一覧は取得済み・板は取得中
    expect(h.calls.filter((u) => u === BOARD)).toHaveLength(1);
    expect(h.calls.filter((u) => u === RACES_CENTRAL)).toHaveLength(1);
    const during = refreshButton(h);
    expect(textOf(during)).toBe("読み込み中…");
    expect(during.attrs?.["disabled"]).toBe(true);
    const before = h.calls.length;
    during.on!.click!();
    during.on!.click!();
    expect(h.calls).toHaveLength(before);
    release();
    await h.app.whenIdle();
    const after = refreshButton(h);
    expect(textOf(after)).toBe("更新");
    expect(after.attrs?.["disabled"]).toBe(false);
  });

  it("板だけが失敗したとき、一覧は出たまま、「実行状態を取得できなかった」注記が出る(一覧の失敗の文言とは別)。一覧だけが失敗したときは、その注記は出ない", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    h.responders.set(BOARD, async () => ({ status: 503, json: async () => ({ ok: false, error: { type: "race-day-error", message: "サーバの文面" } }) }));
    h.app.start();
    await h.app.whenIdle();
    expect(h.text()).toContain("福島民報杯");
    expect(notices(h)).toHaveLength(1);
    expect(notices(h)[0]).toContain("実行状態");
    expect(notices(h)[0]).toContain("サーバでエラーが起きました"); // 固定の文言(サーバの文面でない)
    expect(h.text()).not.toContain("サーバの文面");

    const e = harness(`#date=${DATE}&venue=central`);
    e.responders.set(RACES_CENTRAL, async () => ({ status: 503, json: async () => ({ ok: false, error: { type: "netkeiba-unavailable", reason: "busy" } }) }));
    e.app.start();
    await e.app.whenIdle();
    expect(e.text()).toContain("混み合っています");
    expect(notices(e)).toEqual([]); // 板は取れている(注記は一覧の失敗の role=alert の方)
  });
});

describe("日付の入力", () => {
  it("日付の入力(YYYY-MM-DD)は、区分を保ったハッシュへの遷移になる(再描画はハッシュの変化から)。不正・空は無視する", async () => {
    const h = harness(`#date=${DATE}&venue=nar`);
    h.app.start();
    await h.app.whenIdle();
    const input = findAll(h.tree(), (n) => n.tag === "input")[0]!;
    expect(input.attrs?.["type"]).toBe("date");
    expect(input.attrs?.["value"]).toBe("2026-06-28");
    input.on!.change!("2026-06-27");
    expect(h.hashes).toEqual(["#date=20260627&venue=nar"]);
    input.on!.change!("");
    input.on!.change!("2026-02-30");
    expect(h.hashes).toHaveLength(1);
  });
});

/** Issue #187: 場ごとの開閉。状態はアプリのメモリに (開催日, 区分) ごと・場ごとに持ち、利用者が押した値だけを保存する(既定は描画のたびに導く)。 */
describe("場ごとの開閉(#187)", () => {
  const rowAt = (raceId: string, venueName: string, name: string) => ({ ...raceRow(raceId, name), venue_name: venueName });
  const TWO_VENUES = [rowAt("202602010101", "函館", "函館1"), rowAt("202602010102", "函館", "函館2"), rowAt("202603020211", "福島", "福島11")];
  const NAR_TWO = [rowAt("202654062801", "大井", "大井1"), rowAt("202655062801", "川崎", "川崎1")];

  const toggles = (h: Harness) => findAll(h.tree(), (n) => n.attrs?.["class"] === "venue-toggle");
  const raceLinks = (h: Harness) => findAll(h.tree(), (n) => n.attrs?.["class"] === "race");
  const expanded = (h: Harness) => toggles(h).map((t) => t.attrs?.["aria-expanded"]);
  const nameOf = (t: VNode) => textOf(t);
  const refreshButton = (h: Harness) => findAll(h.tree(), (n) => n.tag === "button" && n.attrs?.["class"] === "refresh")[0]!;

  async function started(hash: string, central: ReturnType<typeof rowAt>[] | null = TWO_VENUES, nar: ReturnType<typeof rowAt>[] = NAR_TWO): Promise<Harness> {
    const h = harness(hash);
    if (central !== null) h.responders.set(RACES_CENTRAL, async () => ok(racesBody("central", central)));
    h.responders.set(RACES_NAR, async () => ok(racesBody("nar", nar)));
    h.app.start();
    await h.app.whenIdle();
    return h;
  }

  it("既定: 場が 2 つ以上なら全部閉じる(レースの行は描画されない)。1 つなら開く", async () => {
    const two = await started(`#date=${DATE}&venue=central`);
    expect(toggles(two)).toHaveLength(2);
    expect(expanded(two)).toEqual(["false", "false"]);
    expect(raceLinks(two)).toHaveLength(0);
    const one = await started(`#date=${DATE}&venue=central`, [rowAt("202603020211", "福島", "福島11"), rowAt("202603020212", "福島", "福島12")]);
    expect(toggles(one)).toHaveLength(1);
    expect(expanded(one)).toEqual(["true"]);
    expect(raceLinks(one)).toHaveLength(2);
  });

  it("見出しのタップで、その場だけが開閉する。aria-expanded と行の描画が実際の状態と一致する。取得は増えない", async () => {
    const h = await started(`#date=${DATE}&venue=central`);
    const calls = h.calls.length;
    expect(nameOf(toggles(h)[0]!)).toContain("函館");
    toggles(h)[0]!.on!.click!();
    expect(expanded(h)).toEqual(["true", "false"]);
    expect(raceLinks(h).map(textOf).join("|")).toContain("函館1");
    expect(raceLinks(h)).toHaveLength(2); // 函館の 2 レースだけ(福島は閉じたまま)
    expect(raceLinks(h).map(textOf).join("|")).not.toContain("福島11");
    toggles(h)[1]!.on!.click!();
    expect(expanded(h)).toEqual(["true", "true"]);
    expect(raceLinks(h)).toHaveLength(3);
    toggles(h)[0]!.on!.click!();
    expect(expanded(h)).toEqual(["false", "true"]);
    expect(raceLinks(h)).toHaveLength(1);
    expect(h.calls).toHaveLength(calls); // 開閉で何も取らない
  });

  it("1 場の一覧(既定で開)も、タップで閉じられる", async () => {
    const h = await started(`#date=${DATE}&venue=central`, [rowAt("202603020211", "福島", "福島11")]);
    expect(expanded(h)).toEqual(["true"]);
    toggles(h)[0]!.on!.click!();
    expect(expanded(h)).toEqual(["false"]);
    expect(raceLinks(h)).toHaveLength(0);
  });

  it("別の (開催日, 区分) は別の状態。戻ると、押した状態が残っている", async () => {
    const h = await started(`#date=${DATE}&venue=central`);
    h.responders.set("/api/races?kaisai_date=20260627&venue=central", async () => ok(racesBody("central", TWO_VENUES)));
    h.responders.set("/api/analyses/status?kaisai_date=20260627", async () => ok({ ok: true, kaisai_date: "20260627", races: [] }));
    toggles(h)[0]!.on!.click!(); // 中央・今日の函館を開く
    expect(expanded(h)).toEqual(["true", "false"]);
    h.go(`#date=${DATE}&venue=nar`);
    await h.app.whenIdle();
    expect(toggles(h)).toHaveLength(2);
    expect(expanded(h)).toEqual(["false", "false"]); // 区分が違う → 別の状態(中央の選択が漏れない)
    toggles(h)[1]!.on!.click!();
    expect(expanded(h)).toEqual(["false", "true"]);
    h.go("#date=20260627&venue=central");
    await h.app.whenIdle();
    expect(expanded(h)).toEqual(["false", "false"]); // 日付が違う → 別の状態
    h.go(`#date=${DATE}&venue=central`);
    expect(expanded(h)).toEqual(["true", "false"]); // 戻ると中央・今日の選択が残っている
    h.go(`#date=${DATE}&venue=nar`);
    expect(expanded(h)).toEqual(["false", "true"]);
  });

  it("「更新」(一覧と板の取り直し)で、開閉の状態が保たれる(取り直しの間も、取り直したあとも)", async () => {
    const h = await started(`#date=${DATE}&venue=central`);
    toggles(h)[1]!.on!.click!(); // 福島を開く
    expect(expanded(h)).toEqual(["false", "true"]);
    const before = h.calls.length;
    refreshButton(h).on!.click!();
    expect(h.calls.length).toBeGreaterThan(before); // 前提: 取り直しが実際に走った
    expect(toggles(h)).toHaveLength(0); // 取り直しの間は一覧が空(読み込み中)
    await h.app.whenIdle();
    expect(toggles(h)).toHaveLength(2);
    expect(expanded(h)).toEqual(["false", "true"]);
    expect(raceLinks(h)).toHaveLength(1);
  });

  it("レース画面へ進んで一覧へ戻っても、開閉の状態が保たれる", async () => {
    const h = await started(`#date=${DATE}&venue=central`);
    toggles(h)[0]!.on!.click!();
    h.go(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    await h.app.whenIdle();
    h.go(`#date=${DATE}&venue=central`);
    expect(expanded(h)).toEqual(["true", "false"]);
  });

  it("更新で場の数が変わったとき、押していない場は既定に追従し、押した場は保たれる(1 場 → 2 場)", async () => {
    const h = await started(`#date=${DATE}&venue=central`, [rowAt("202603020211", "福島", "福島11")]);
    expect(expanded(h)).toEqual(["true"]); // 1 場 = 開(押していない)
    h.responders.set(RACES_CENTRAL, async () => ok(racesBody("central", TWO_VENUES)));
    refreshButton(h).on!.click!();
    await h.app.whenIdle();
    expect(toggles(h)).toHaveLength(2);
    expect(expanded(h)).toEqual(["false", "false"]); // 2 場になったので、押していない福島は既定(閉)に追従
  });

  it("見出しの要約は板から出す(取得済み・待ち=実行中、失敗)。板の取得に失敗したときは要約を出さない(場名だけ。数字+R は出さない)", async () => {
    const h = await started(`#date=${DATE}&venue=central`);
    h.responders.set(BOARD, async () =>
      ok({ ok: true, kaisai_date: DATE, races: [boardRow("202602010101", "morning", "queued"), boardRow("202602010102", "pre_race", "failed"), boardRow("202603020211", "morning", "done")] }),
    );
    refreshButton(h).on!.click!();
    await h.app.whenIdle();
    const [hako, fuku] = toggles(h).map(textOf);
    expect(hako).toBe("▸ 函館・実行中 1・失敗 1");
    expect(hako).toContain("実行中 1");
    expect(hako).toContain("失敗 1");
    expect(fuku).not.toContain("実行中");
    expect(fuku).not.toContain("失敗");

    h.responders.set(BOARD, async () => ({ status: 503, json: async () => ({ ok: false, error: { type: "race-day-error" } }) }));
    refreshButton(h).on!.click!();
    await h.app.whenIdle();
    expect(toggles(h).map(textOf).join(" ")).not.toContain("実行中");
    expect(toggles(h).map(textOf).join(" ")).not.toContain("失敗");
    // Issue #186(ユーザーの依頼): 見出しにレース数(旧版は `2R`)は出さない。要約が無ければ「▸ 場名」だけ
    expect(toggles(h).map(textOf)).toEqual(["▸ 函館", "▸ 福島"]);
  });
});
