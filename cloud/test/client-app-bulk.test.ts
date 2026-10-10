import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { Role } from "../client/role";
import type { VNode } from "../client/vnode";
import { createFakeTimers, deferred } from "./client-fakes";

/**
 * Issue #251: 場ごとの一括実行(`createApp` の制御レベル)。偽の fetch・偽のタイマー。実リクエストはしない。
 * 守ること: 押すと確認画面(この時点では POST しない)→「実行する」で POST を 1 回(二重押しの同期の印)→ 結果の表示と板の追跡/ 実行の直前に対象を取り直す(増やさない)/ 上限・失敗の表示 / 閲覧者には出ない。
 * 偽の現在時刻は 2026-06-28 09:00 JST(開催日 20260628 の今日)。
 */

const DATE = "20260628";
const LIST_HASH = `#date=${DATE}&venue=central`;
const RACES_URL = `/api/races?kaisai_date=${DATE}&venue=central`;
const BOARD_URL = `/api/analyses/status?kaisai_date=${DATE}`;
const BULK_URL = "/api/analyses/run/bulk";

type Resp = { status: number; json: () => Promise<unknown> };
type Init = Parameters<FetchLike>[1];
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
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
const jrow = (raceId: string, mode: string, status: string): JsonRow => ({ race_id: raceId, mode, status, attempts: 0, error: null, queued_at: 1000, updated_at: 2000, prior: false, analysis_id: null, detail: null, children_ok: null });

interface JsonRace {
  race_id: string;
  venue_name: string;
  race_number: number;
  race_name: string;
  course_type: string;
  distance: number;
  entry_count: number;
  grade: string | null;
  start_time: string | null;
}
const jrace = (raceId: string, venue: string, n: number, startTime: string | null): JsonRace => ({ race_id: raceId, venue_name: venue, race_number: n, race_name: `${venue}${n}R`, course_type: "芝", distance: 1800, entry_count: 16, grade: null, start_time: startTime });

// 福島 3 レース(10:00・11:00・時刻不明)、東京 2 レース(10:30・11:30)。偽の現在時刻は 09:00 なので、時刻のあるレースはすべて未発走。
const F1 = "202602020101";
const F2 = "202602020102";
const F3 = "202602020103";
const T1 = "202605020101";
const T2 = "202605020102";
const SINGLE_VENUE: JsonRace[] = [jrace(F1, "福島", 1, "10:00"), jrace(F2, "福島", 2, "11:00"), jrace(F3, "福島", 3, "12:00")];
const TWO_VENUES: JsonRace[] = [...SINGLE_VENUE, jrace(T1, "東京", 1, "10:30"), jrace(T2, "東京", 2, "11:30")];

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
  races: JsonRace[];
  rows: JsonRow[];
  readonly responders: Map<string, (init: Init) => Promise<Resp>>;
  hash: string;
  tree(): VNode;
  settle(): Promise<void>;
  bulkPosts(): Call[];
  allPosts(): Call[];
  gets(): string[];
}

function harness(role: Role, initialHash: string, races: JsonRace[]): Harness {
  const timers = createFakeTimers();
  const calls: Call[] = [];
  let tree: VNode | null = null;
  const h: Harness = {
    app: undefined as never,
    calls,
    timers,
    races,
    rows: [],
    responders: new Map(),
    hash: initialHash,
    tree: () => tree!,
    settle: () => timers.flush(),
    bulkPosts: () => calls.filter((c) => c.method === "POST" && c.url === BULK_URL),
    allPosts: () => calls.filter((c) => c.method === "POST"),
    gets: () => calls.filter((c) => c.method === "GET").map((c) => c.url),
  };
  const respondDefault = (method: string, url: string, init: Init): Resp => {
    if (method === "POST" && url === BULK_URL) {
      const body = JSON.parse(init.body as string) as { kaisai_date: string; mode: string; race_ids: string[] };
      const results = body.race_ids.map((raceId) => {
        const running = h.rows.find((r) => r.race_id === raceId && r.mode === body.mode && (r.status === "queued" || r.status === "fetched"));
        if (running !== undefined) return { race_id: raceId, result: "already-running", status: running.status };
        h.rows = [...h.rows.filter((r) => !(r.race_id === raceId && r.mode === body.mode)), jrow(raceId, body.mode, "queued")];
        return { race_id: raceId, result: "accepted" };
      });
      return resp(202, { ok: true, accepted: true, kaisai_date: body.kaisai_date, mode: body.mode, results });
    }
    if (url === RACES_URL) return ok({ ok: true, kaisai_date: DATE, venue: "central", races: h.races });
    if (url === BOARD_URL) return ok({ ok: true, kaisai_date: DATE, races: h.rows });
    throw new Error(`想定外の要求: ${method} ${url}`);
  };
  const fetchLike: FetchLike = (url, init) => {
    calls.push({ method: init.method, url, init });
    const custom = h.responders.get(`${init.method} ${url}`);
    if (custom !== undefined) return custom(init);
    return Promise.resolve(respondDefault(init.method, url, init));
  };
  (h as { app: App }).app = createApp({
    role,
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

async function started(role: Role, hash: string, races: JsonRace[], setup: (h: Harness) => void = () => {}): Promise<Harness> {
  const h = harness(role, hash, races);
  setup(h);
  h.app.start();
  await h.settle();
  return h;
}

const click = (node: VNode): void => node.on!.click!();
const bulkButton = (h: Harness, mode: "morning" | "pre_race", index = 0): VNode => {
  const found = byClass(h.tree(), "bulk-run").filter((b) => b.attrs?.["data-mode"] === mode);
  expect(found.length, `前提: ${mode} の一括実行のボタンが ${index + 1} 個以上ある`).toBeGreaterThan(index);
  return found[index]!;
};
const goButton = (h: Harness): VNode => {
  const found = byClass(h.tree(), "bulk-go");
  expect(found, "前提: 確認画面の「実行する」がある").toHaveLength(1);
  return found[0]!;
};
const bulkText = (h: Harness): string => byClass(h.tree(), "bulk").map(textOf).join(" ");
const badgeTexts = (h: Harness): string[] => byClass(h.tree(), "badge").map(textOf);

describe("一括実行: 確認画面を挟む(Issue #251)", () => {
  it("ボタンを押しただけでは POST しない。確認画面に、対象の件数・事前分析の説明が出る。「やめる」で閉じ、POST しない", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE);
    expect(byClass(h.tree(), "bulk")).toHaveLength(1); // 前提: 場が 1 つなら開いていて、一括実行が出ている
    click(bulkButton(h, "morning"));
    await h.settle();
    expect(h.allPosts()).toHaveLength(0);
    expect(bulkText(h)).toContain("福島の事前分析を一括実行しますか");
    expect(bulkText(h)).toContain("対象: 3 レース");
    click(byClass(h.tree(), "bulk-cancel")[0]!);
    await h.settle();
    expect(byClass(h.tree(), "bulk-panel")).toHaveLength(0);
    expect(h.allPosts()).toHaveLength(0);
  });

  it("発走前を押すと、LLM の回数と 2 つの注意書きが出る。発走時刻が不明のレースは対象から外れ、その件数が除外の行に出る", async () => {
    const races = [jrace(F1, "福島", 1, "10:00"), jrace(F2, "福島", 2, "11:00"), jrace(F3, "福島", 3, null)];
    const h = await started("admin", LIST_HASH, races);
    click(bulkButton(h, "pre_race"));
    await h.settle();
    const text = bulkText(h);
    expect(text).toContain("対象: 2 レース");
    expect(text).toContain("LLM の呼び出し: 通常 2 回");
    expect(text).toContain("最大 4 回");
    expect(text).toContain("除外: 発走時刻が不明 1");
    expect(text).toContain("二重に課金");
    expect(text).toContain("開始が遅れる");
  });

  it("場が複数あるときは、開いた場にだけ出る。別の場の確認画面とは独立", async () => {
    const h = await started("admin", LIST_HASH, TWO_VENUES);
    expect(byClass(h.tree(), "bulk")).toHaveLength(0); // 前提: 既定は全部閉じている
    click(byClass(h.tree(), "venue-toggle")[1]!); // 東京を開く
    await h.settle();
    expect(byClass(h.tree(), "bulk")).toHaveLength(1);
    click(bulkButton(h, "morning"));
    await h.settle();
    expect(bulkText(h)).toContain("東京の事前分析を一括実行しますか");
    expect(bulkText(h)).toContain("対象: 2 レース");
    click(byClass(h.tree(), "venue-toggle")[0]!); // 福島も開く
    await h.settle();
    expect(byClass(h.tree(), "bulk")).toHaveLength(2);
    expect(byClass(h.tree(), "bulk-panel")).toHaveLength(1); // 確認画面は東京だけ
  });
});

describe("一括実行: 実行(POST)", () => {
  it("「実行する」で、その場のレースだけを 1 回の POST で送る。本文は {kaisai_date, mode, race_ids}。init は単独の起動と同じ(同じオリジンの資格情報・referrerPolicy: same-origin・mode なし)", async () => {
    const h = await started("admin", LIST_HASH, TWO_VENUES);
    click(byClass(h.tree(), "venue-toggle")[1]!);
    await h.settle();
    click(bulkButton(h, "pre_race"));
    await h.settle();
    click(goButton(h));
    await h.settle();
    const posts = h.bulkPosts();
    expect(posts).toHaveLength(1);
    expect(h.allPosts()).toHaveLength(1); // 1 レースごとの POST は出ない
    expect(JSON.parse(posts[0]!.init.body as string)).toEqual({ kaisai_date: DATE, mode: "pre_race", race_ids: [T1, T2] });
    expect(posts[0]!.init.method).toBe("POST");
    expect(posts[0]!.init.credentials).toBe("same-origin");
    expect(posts[0]!.init.referrerPolicy).toBe("same-origin");
    expect(posts[0]!.init.headers?.["content-type"]).toBe("application/json");
    expect([undefined, "cors"]).toContain((posts[0]!.init as { mode?: string }).mode);
  });

  it("実行中・完了済みのレースは送らない(対象は件数どおり)。失敗のレースは送る", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE, (x) => {
      x.rows = [jrow(F1, "morning", "queued"), jrow(F2, "morning", "done"), jrow(F3, "morning", "failed")];
    });
    click(bulkButton(h, "morning"));
    await h.settle();
    expect(bulkText(h)).toContain("対象: 1 レース");
    expect(bulkText(h)).toContain("除外: 実行中 1・完了済み 1");
    click(goButton(h));
    await h.settle();
    expect(JSON.parse(h.bulkPosts()[0]!.init.body as string).race_ids).toEqual([F3]);
  });

  it("応答を待つ間は「予約しています」で、ボタンは無効。「実行する」を続けて押しても POST は 1 回だけ(同期の印)", async () => {
    const gate = deferred<Resp>();
    const h = await started("admin", LIST_HASH, SINGLE_VENUE, (x) => x.responders.set(`POST ${BULK_URL}`, () => gate.promise));
    click(bulkButton(h, "morning"));
    await h.settle();
    const go = goButton(h);
    click(go);
    click(go); // 同期で続けて押す(await の前に印が立っていないと 2 回目も POST になる)
    expect(h.bulkPosts()).toHaveLength(1);
    expect(bulkText(h)).toContain("事前分析を予約しています…");
    expect(byClass(h.tree(), "bulk-run").map((b) => b.attrs?.["disabled"])).toEqual([true, true]);
    expect(byClass(h.tree(), "bulk-go")).toHaveLength(0);
    gate.resolve(resp(202, { ok: true, accepted: true, kaisai_date: DATE, mode: "morning", results: [F1, F2, F3].map((id) => ({ race_id: id, result: "accepted" })) }));
    await h.settle();
    expect(byClass(h.tree(), "bulk-sending")).toHaveLength(0);
  });

  it("送信中は「予約しています」を出し、失敗の応答が届くと結果(失敗)に置き換わる", async () => {
    const gate = deferred<Resp>();
    const h = await started("admin", LIST_HASH, SINGLE_VENUE, (x) => x.responders.set(`POST ${BULK_URL}`, () => gate.promise));
    click(bulkButton(h, "morning"));
    await h.settle();
    click(goButton(h));
    expect(byClass(h.tree(), "bulk-sending")).toHaveLength(1);
    gate.resolve(resp(503, { ok: false, error: { type: "race-day-error" } }));
    await h.settle();
    expect(byClass(h.tree(), "bulk-result")).toHaveLength(1);
  });
});

describe("一括実行: 結果と追跡", () => {
  it("202: 結果の文言を出し、予約したレースのバッジを「待ち」にして、板の追跡(ポーリング)を始める。確認画面は閉じる", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE);
    expect(badgeTexts(h).every((t) => t.includes("未実行"))).toBe(true); // 前提: 6 つのバッジ(3 レース × 2)がすべて未実行
    expect(badgeTexts(h)).toHaveLength(6);
    click(bulkButton(h, "morning"));
    await h.settle();
    click(goButton(h));
    await h.settle();
    expect(textOf(byClass(h.tree(), "bulk-result")[0]!)).toContain("3 レースを予約しました。");
    expect(byClass(h.tree(), "bulk-panel")).toHaveLength(0);
    expect(badgeTexts(h).filter((t) => t.includes("待ち"))).toHaveLength(3); // 事前分析のバッジ 3 つ(発走前の 3 つは未実行のまま)
    expect(badgeTexts(h).filter((t) => t.includes("未実行"))).toHaveLength(3);
    const boardGetsBefore = h.gets().filter((u) => u === BOARD_URL).length;
    await h.timers.advance(3000);
    expect(h.gets().filter((u) => u === BOARD_URL).length).toBeGreaterThan(boardGetsBefore); // 追跡が板を取り直す
  });

  it("実行中だったレースは「実行中のため見送り」として文言に出し、そのレースのバッジは実行中の状態のまま", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE);
    click(bulkButton(h, "morning"));
    await h.settle();
    // 確認画面を開いたあとで、サーバ側では F1 が実行中になった(自動の実行など)。画面の板はまだ知らない。
    h.rows = [jrow(F1, "morning", "fetched")];
    click(goButton(h));
    await h.settle();
    expect(textOf(byClass(h.tree(), "bulk-result")[0]!)).toContain("2 レースを予約しました(実行中のため見送り: 1 レース)。");
    expect(badgeTexts(h).filter((t) => t.includes("取得済み"))).toHaveLength(1); // 見送ったレースのバッジは、サーバが返した実行中の状態(fetched)
    expect(badgeTexts(h).filter((t) => t.includes("待ち"))).toHaveLength(2);
  });

  it("結果の「閉じる」で消える。そのあと、また押せる", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE);
    click(bulkButton(h, "morning"));
    await h.settle();
    click(goButton(h));
    await h.settle();
    click(byClass(h.tree(), "bulk-close")[0]!);
    await h.settle();
    expect(byClass(h.tree(), "bulk-result")).toHaveLength(0);
    // 対象が 0 件になったので事前分析のボタンは無効(予約したレースは実行中)。発走前は押せる
    expect(bulkButton(h, "morning").attrs?.["disabled"]).toBe(true);
    expect(bulkButton(h, "pre_race").attrs?.["disabled"]).toBe(false);
  });

  it("409 day-cap: 何も予約していない旨を出し、バッジは変わらない。追跡は始めない", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE, (x) => x.responders.set(`POST ${BULK_URL}`, async () => resp(409, { ok: false, error: { type: "day-cap", limit: 100, used: 99, needed: 3 } })));
    click(bulkButton(h, "morning"));
    await h.settle();
    click(goButton(h));
    await h.settle();
    const result = byClass(h.tree(), "bulk-result")[0]!;
    expect(textOf(result)).toContain("この開催日に受け付けられる上限(100)を超えるため、何も予約していません(現在 99・追加で必要 3)。");
    expect(result.attrs?.["role"]).toBe("alert");
    expect(badgeTexts(h).every((t) => t.includes("未実行"))).toBe(true);
    const boardGetsBefore = h.gets().filter((u) => u === BOARD_URL).length;
    await h.timers.advance(10_000);
    expect(h.gets().filter((u) => u === BOARD_URL).length).toBe(boardGetsBefore);
  });

  it.each([
    ["503", () => resp(503, { ok: false, error: { type: "race-day-error" } }), "起動できませんでした。サーバでエラーが起きました。"],
    ["403(Origin の不一致)", () => resp(403, { ok: false, error: { type: "origin-mismatch" } }), "送信元の確認に失敗しました"],
    ["400", () => resp(400, { ok: false, error: { type: "bad-request" } }), "リクエストが正しくありません"],
  ])("失敗(%s)は固定の文言で、確認画面に戻れる状態(結果の「閉じる」のあとに再実行できる)。バッジは変わらない", async (_name, make, expected) => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE, (x) => x.responders.set(`POST ${BULK_URL}`, async () => make()));
    click(bulkButton(h, "morning"));
    await h.settle();
    click(goButton(h));
    await h.settle();
    expect(textOf(byClass(h.tree(), "bulk-result")[0]!)).toContain(expected);
    expect(badgeTexts(h).every((t) => t.includes("未実行"))).toBe(true);
    expect(bulkButton(h, "morning").attrs?.["disabled"]).toBe(false); // 再実行できる
  });

  it("通信の失敗(fetch が投げる)は network の文言", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE, (x) =>
      x.responders.set(`POST ${BULK_URL}`, async () => {
        throw new Error("secret detail");
      }),
    );
    click(bulkButton(h, "morning"));
    await h.settle();
    click(goButton(h));
    await h.settle();
    const text = textOf(byClass(h.tree(), "bulk-result")[0]!);
    expect(text).toContain("通信に失敗しました");
    expect(text).not.toContain("secret detail");
  });

  it("202 でも本文が想定外なら失敗の文言を出し、サーバは受理しているので追跡は始める(板が真実を教える)", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE, (x) => x.responders.set(`POST ${BULK_URL}`, async () => resp(202, { ok: true })));
    click(bulkButton(h, "morning"));
    await h.settle();
    click(goButton(h));
    await h.settle();
    expect(textOf(byClass(h.tree(), "bulk-result")[0]!)).toContain("応答が想定外でした(HTTP 202)");
    const boardGetsBefore = h.gets().filter((u) => u === BOARD_URL).length;
    await h.timers.advance(3000);
    expect(h.gets().filter((u) => u === BOARD_URL).length).toBeGreaterThan(boardGetsBefore);
  });
});

describe("一括実行: 実行の直前に対象を取り直す(増やさない)", () => {
  it("確認画面を開いたあとで一部が完了・実行中になったら、残りだけを送る(確認した対象を超えて送らない)", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE);
    click(bulkButton(h, "morning"));
    await h.settle();
    expect(bulkText(h)).toContain("対象: 3 レース");
    h.rows = [jrow(F3, "morning", "done")];
    click(byClass(h.tree(), "refresh")[0]!); // 板を取り直す(確認画面は残る)
    await h.settle();
    expect(byClass(h.tree(), "bulk-panel")).toHaveLength(1);
    click(goButton(h));
    await h.settle();
    expect(JSON.parse(h.bulkPosts()[0]!.init.body as string).race_ids).toEqual([F1, F2]);
  });

  it("確認画面のあと、対象がすべてなくなっていたら POST しない(何も予約していない旨を出す)", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE);
    click(bulkButton(h, "morning"));
    await h.settle();
    h.rows = [F1, F2, F3].map((id) => jrow(id, "morning", "done"));
    click(byClass(h.tree(), "refresh")[0]!);
    await h.settle();
    click(goButton(h));
    await h.settle();
    expect(h.bulkPosts()).toHaveLength(0);
    expect(textOf(byClass(h.tree(), "bulk-result")[0]!)).toContain("対象のレースがなくなったため、何も予約していません。");
  });

  it("確認画面を開いたあとで増えたレース(更新で一覧に加わった)は送らない(確認した対象だけ)", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE);
    click(bulkButton(h, "morning"));
    await h.settle();
    h.races = [...SINGLE_VENUE, jrace("202602020104", "福島", 4, "13:00")];
    click(byClass(h.tree(), "refresh")[0]!);
    await h.settle();
    click(goButton(h));
    await h.settle();
    expect(JSON.parse(h.bulkPosts()[0]!.init.body as string).race_ids).toEqual([F1, F2, F3]);
  });
});

describe("一括実行: 出さない/押せない場合", () => {
  it("過去の開催日は両方のボタンが無効で、理由を出す。押しても確認画面は開かない", async () => {
    const h = await started("admin", "#date=20260627&venue=central", SINGLE_VENUE, (x) => {
      x.responders.set("GET /api/races?kaisai_date=20260627&venue=central", async () => ok({ ok: true, kaisai_date: "20260627", venue: "central", races: [jrace("202602020101", "福島", 1, "10:00")] }));
      x.responders.set("GET /api/analyses/status?kaisai_date=20260627", async () => ok({ ok: true, kaisai_date: "20260627", races: [] }));
    });
    expect(byClass(h.tree(), "bulk-run").map((b) => b.attrs?.["disabled"])).toEqual([true, true]);
    expect(textOf(byClass(h.tree(), "bulk-note")[0]!)).toBe("過去の開催日には一括実行できません。");
    click(bulkButton(h, "morning"));
    await h.settle();
    expect(byClass(h.tree(), "bulk-panel")).toHaveLength(0);
    expect(h.allPosts()).toHaveLength(0);
  });

  it("板(実行状態)が取れていないときは無効で、確認画面を開かない", async () => {
    const h = await started("admin", LIST_HASH, SINGLE_VENUE, (x) => x.responders.set(`GET ${BOARD_URL}`, async () => resp(503, { ok: false, error: { type: "race-day-error" } })));
    expect(byClass(h.tree(), "bulk-run").map((b) => b.attrs?.["disabled"])).toEqual([true, true]);
    click(bulkButton(h, "morning"));
    await h.settle();
    expect(byClass(h.tree(), "bulk-panel")).toHaveLength(0);
  });

  it("閲覧者(viewer)には、一括実行の要素が一切出ない。POST も出さない。管理者の同じ画面には出る(対照)", async () => {
    const admin = await started("admin", LIST_HASH, SINGLE_VENUE);
    expect(byClass(admin.tree(), "bulk-run")).toHaveLength(2); // 対照: 管理者には出る
    const viewer = await started("viewer", LIST_HASH, SINGLE_VENUE);
    expect(byClass(viewer.tree(), "races")).toHaveLength(1); // 前提: 場は開いていてレースが描画されている
    for (const cls of ["bulk", "bulk-run", "bulk-note", "bulk-panel", "bulk-go", "bulk-result"]) {
      expect(byClass(viewer.tree(), cls), cls).toHaveLength(0);
    }
    expect(viewer.allPosts()).toHaveLength(0);
  });
});
