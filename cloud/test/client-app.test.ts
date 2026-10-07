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
 *  - `/api/analyses/{id}`・`POST` は、この画面からは呼ばない(#185)
 */

const DATE = "20260628";
const RACES_CENTRAL = `/api/races?kaisai_date=${DATE}&venue=central`;
const RACES_NAR = `/api/races?kaisai_date=${DATE}&venue=nar`;
const BOARD = `/api/analyses/status?kaisai_date=${DATE}`;

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
const raceRow = (raceId: string, name: string) => ({ race_id: raceId, venue_name: "福島", race_number: Number(raceId.slice(-2)), race_name: name, course_type: "芝", distance: 1800, entry_count: 16, grade: null });
const racesBody = (venue: string, rows: ReturnType<typeof raceRow>[]) => ({ ok: true, kaisai_date: DATE, venue, races: rows });
const boardRow = (raceId: string, mode: string, status: string) => ({ race_id: raceId, mode, status, attempts: 0, error: null, queued_at: 1, updated_at: 2, prior: false, analysis_id: null, detail: null, children_ok: null });

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

  it("レースの行(race 付きのハッシュ)へ進むと、準備中の画面になり、何も取得しない。一覧へ戻っても取り直さない", async () => {
    const h = harness(`#date=${DATE}&venue=central`);
    h.app.start();
    await h.app.whenIdle();
    const before = h.calls.length;
    h.go(`#date=${DATE}&venue=central&race=202603020211`);
    await h.app.whenIdle();
    expect(h.text()).toContain("準備中");
    h.go(`#date=${DATE}&venue=central&analysis=12`);
    await h.app.whenIdle();
    expect(h.text()).toContain("準備中");
    h.go(`#date=${DATE}&venue=central`);
    await h.app.whenIdle();
    expect(h.calls).toHaveLength(before);
    expect(h.text()).toContain("福島民報杯");
  });

  it("race 付きのハッシュで直接開いても、一覧は取らない(#185 のレース画面が必要としたときに取る)。画面から /api/analyses/{id} と POST は呼ばない", async () => {
    const h = harness(`#date=${DATE}&venue=central&race=202603020211`);
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toEqual([]);
    for (const hash of [`#date=${DATE}&venue=central`, `#analysis=5`, `#date=${DATE}&venue=nar`]) {
      h.go(hash);
      await h.app.whenIdle();
    }
    expect(h.calls.filter((u) => /\/api\/analyses\/\d/.test(u))).toEqual([]);
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
