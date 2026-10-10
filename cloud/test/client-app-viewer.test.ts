import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import type { Role } from "../client/role";
import type { VNode } from "../client/vnode";
import { requiredRole } from "../src/route-policy";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { createFakeTimers } from "./client-fakes";

/**
 * Issue #238: 閲覧者(viewer)の画面。ボタンを隠すのは補助で、拒否はサーバ側だが、**画面が管理者専用の API を叩いて 403 を出さない**ことを固定する。
 *  - **不変条件**: 閲覧者が開ける画面(と、そこで押せるすべての操作)が出す要求は、サーバの表(`route-policy.ts` の `requiredRole`)で viewer に足りるものだけ。
 *    表をクライアントのテストに直接つなぐので、画面が管理者専用の API を読む変更を足すと、ここで落ちる。
 *  - 設定・検証・移行の画面を直接(`#settings` など)開いた閲覧者には、API を取らずに固定文言「管理者だけが使えます」を出す。
 *  - 対照として、管理者は同じ操作で入口・ボタンが出る(隠す条件が逆でも気づけるように、毎回、管理者側の存在を無条件に確かめる)。
 * 今日は 2026-06-28(JST)。
 */

const DATE = "20260628";
const RACE_ID = "202603020211";
type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
const boardRow = (raceId: string, mode: string, status: string, over: Record<string, unknown> = {}) => ({ race_id: raceId, mode, status, attempts: 0, error: null, queued_at: 1, updated_at: 2, prior: false, analysis_id: null, detail: null, children_ok: null, ...over });

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));

/** 配分が unset(総資金・1レース上限が未設定。cloud の既定値なので、ほぼ全件がこの状態)の分析。 */
const ANALYSIS_5 = {
  ok: true,
  analysis: {
    id: 5,
    raceId: RACE_ID,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: DATE,
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    promptVersion: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", startTime: null, courseType: null, distance: null, weather: null, trackCondition: null },
    horses: [{ umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.2, isPositive: true, mark: null, reason: null, highlights: [], concerns: [] }],
    allocation: { route: "unset", unavailableReason: null, fallbackReason: null, skipReasonCode: null, bankroll: 0, perRaceCap: 0, kellyFraction: 0.25, evThreshold: 1.1, includeComboOdds: false, includeWide: true, includeTrio: true, includeQuinella: null, includeExacta: null, includeTrifecta: null, includeBracketQuinella: null, betUnit: 100, oddsStatus: "result", bets: [] },
    detail: "present",
  },
};

/** 偽の fetch の応答。管理者専用の API にも、画面が読める形の応答を返す(閲覧者が叩いたかどうかは、応答ではなく記録した要求で判定する)。 */
function respond(method: string, url: string): Resp {
  const path = url.split("?")[0]!;
  if (method === "GET" && path === "/api/races") return ok({ ok: true, kaisai_date: DATE, venue: "central", races: [{ race_id: RACE_ID, venue_name: "福島", race_number: 11, race_name: "福島民報杯", course_type: "芝", distance: 1800, entry_count: 16, grade: null }] });
  if (method === "GET" && path === "/api/analyses/status") {
    const rows = [boardRow(RACE_ID, "morning", "done", { prior: true }), boardRow(RACE_ID, "pre_race", "done", { analysis_id: 5 })];
    return url.includes("race_id=") ? ok({ ok: true, kaisai_date: DATE, races: rows, prior: null }) : ok({ ok: true, kaisai_date: DATE, races: rows });
  }
  if (method === "GET" && path === "/api/analyses/5") return ok(ANALYSIS_5);
  if (method === "GET" && path === "/api/analyses") return ok({ ok: true, analyses: [] });
  if (method === "GET" && path === "/api/reports") return ok({ ok: true, reports: [] });
  if (method === "GET" && /^\/api\/reports\/\d{8}$/.test(path)) return ok({ ok: true, report: null, job: null });
  if (method === "GET" && path === "/api/settings") return ok({ ok: true, settings: DEFAULT_CLOUD_SETTINGS, source: "d1" });
  return ok({ ok: true });
}

interface Harness {
  readonly app: App;
  readonly calls: { readonly method: string; readonly url: string }[];
  readonly timers: ReturnType<typeof createFakeTimers>;
  tree(): VNode;
}

function harness(role: Role, hash: string): Harness {
  const calls: { method: string; url: string }[] = [];
  const timers = createFakeTimers();
  let latest: VNode | null = null;
  const fetchLike: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url });
    return respond(init.method, url);
  };
  const app = createApp({
    fetch: fetchLike,
    now: () => new Date("2026-06-28T00:00:00Z"),
    render: (tree) => {
      latest = tree;
    },
    getHash: () => hash,
    setHash: () => {},
    timers: { set: timers.set, clear: timers.clear },
    isVisible: () => true,
    role,
  });
  return { app, calls, timers, tree: () => latest! };
}

/** 画面を開き、取得を待ち、時間を進め、押せるボタンをすべて押す(画面が出しうる要求をできるだけ引き出す)。 */
async function exercise(h: Harness): Promise<void> {
  h.app.start();
  await h.app.whenIdle();
  await h.timers.advance(60_000);
  await h.app.whenIdle();
  for (const node of findAll(h.tree(), (n) => n.on?.click !== undefined)) {
    node.on!.click!();
    await h.app.whenIdle();
  }
  await h.timers.advance(60_000);
  await h.app.whenIdle();
}

const SCREENS: readonly (readonly [string, string])[] = [
  ["一覧(中央)", `#date=${DATE}&venue=central`],
  ["一覧(地方)", `#date=${DATE}&venue=nar`],
  ["レース画面", `#date=${DATE}&venue=central&race=${RACE_ID}`],
  ["結果画面", `#date=${DATE}&venue=central&race=${RACE_ID}&analysis=5`],
  ["日報(最新)", "#report"],
  ["日報(日付指定)", "#report=20260627"],
  ["日報(日報の無い日)", "#report=20260628"],
  ["設定", "#settings"],
  ["検証", "#verify"],
  ["移行", "#migration"],
];

describe("不変条件: 閲覧者の画面が出す要求は、サーバの表で viewer に足りるものだけ(管理者専用の API を叩いて 403 を出さない)", () => {
  it.each(SCREENS)("閲覧者・%s(%s): すべての要求が viewer に足りる", async (_name, hash) => {
    const h = harness("viewer", hash);
    await exercise(h);
    for (const call of h.calls) {
      const pathname = call.url.split("?")[0]!;
      expect(requiredRole(call.method, pathname), `${call.method} ${call.url}`).toBe("viewer");
    }
  });

  it("前提(検出が空振りでない): 閲覧者が開ける 7 つの画面は実際に要求を出し、管理者専用の画面を管理者が開くと admin の要求が出る(= この検査は admin の要求を検出できる)", async () => {
    const viewable = SCREENS.filter(([, hash]) => !["#settings", "#verify", "#migration"].includes(hash));
    expect(viewable).toHaveLength(7);
    for (const [name, hash] of viewable) {
      const h = harness("viewer", hash);
      await exercise(h);
      expect(h.calls.length, name).toBeGreaterThan(0);
    }
    for (const hash of ["#settings", "#verify", "#migration"]) {
      const admin = harness("admin", hash);
      await exercise(admin);
      expect(admin.calls.some((c) => requiredRole(c.method, c.url.split("?")[0]!) === "admin"), hash).toBe(true);
    }
  });

  it("対照: 管理者が分析の実行ボタンを押すと POST /api/analyses/run が出る(= 閲覧者に出ないのは、ボタンが無いから)", async () => {
    const admin = harness("admin", `#date=${DATE}&venue=central&race=${RACE_ID}`);
    await exercise(admin);
    expect(admin.calls.some((c) => c.method === "POST" && c.url === "/api/analyses/run")).toBe(true);
    const viewer = harness("viewer", `#date=${DATE}&venue=central&race=${RACE_ID}`);
    await exercise(viewer);
    expect(viewer.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("設定・検証・移行の画面を直接開いた閲覧者: API を取らず、固定文言で案内する", () => {
  it.each([["設定", "#settings"], ["検証", "#verify"], ["移行", "#migration"]])("%s(%s): 要求が 0 件で、「管理者だけが使えます」と、一覧へ戻るリンクが出る", async (_name, hash) => {
    const viewer = harness("viewer", hash);
    viewer.app.start();
    await viewer.app.whenIdle();
    expect(viewer.calls).toEqual([]);
    expect(textOf(viewer.tree())).toContain("管理者だけが使えます");
    expect(byClass(viewer.tree(), "back").map((n) => n.attrs?.["href"])).toEqual(["#"]);
    // 設定の入力欄・保存ボタン・移行のファイル選択のような操作部品が無い
    expect(findAll(viewer.tree(), (n) => n.tag === "input" || n.tag === "textarea" || n.tag === "select")).toEqual([]);
    expect(byClass(viewer.tree(), "settings-save")).toHaveLength(0);
    expect(byClass(viewer.tree(), "migration-start")).toHaveLength(0);
    // 対照: 管理者は同じハッシュで、その画面が開く(固定文言は出ず、取得が走る)
    const admin = harness("admin", hash);
    admin.app.start();
    await admin.app.whenIdle();
    expect(textOf(admin.tree())).not.toContain("管理者だけが使えます");
    expect(admin.calls.length).toBeGreaterThan(0);
  });
});

describe("閲覧者の画面から、管理者の入口・ボタンが消える(管理者には出る)", () => {
  it("一覧: 「検証」「設定」のリンクが無い。「日報」のリンクは残る。管理者には 3 つとも出る", async () => {
    const admin = harness("admin", `#date=${DATE}&venue=central`);
    admin.app.start();
    await admin.app.whenIdle();
    expect(byClass(admin.tree(), "verify-link")).toHaveLength(1);
    expect(byClass(admin.tree(), "settings-link")).toHaveLength(1);
    expect(byClass(admin.tree(), "report-link")).toHaveLength(1);
    const viewer = harness("viewer", `#date=${DATE}&venue=central`);
    viewer.app.start();
    await viewer.app.whenIdle();
    expect(byClass(viewer.tree(), "verify-link")).toHaveLength(0);
    expect(byClass(viewer.tree(), "settings-link")).toHaveLength(0);
    expect(byClass(viewer.tree(), "report-link")).toHaveLength(1);
    // 一覧そのもの(レースの行)は閲覧者にも出る
    expect(byClass(viewer.tree(), "race").length + byClass(viewer.tree(), "venue-toggle").length).toBeGreaterThan(0);
  });

  it("レース画面: 分析の実行ボタン(朝・発走前)が無い。カードと状態(バッジ)・結果は出る。管理者には 2 つ出る", async () => {
    const hash = `#date=${DATE}&venue=central&race=${RACE_ID}`;
    const admin = harness("admin", hash);
    admin.app.start();
    await admin.app.whenIdle();
    expect(byClass(admin.tree(), "run")).toHaveLength(2);
    const viewer = harness("viewer", hash);
    viewer.app.start();
    await viewer.app.whenIdle();
    expect(byClass(viewer.tree(), "run")).toHaveLength(0);
    expect(byClass(viewer.tree(), "card")).toHaveLength(2);
    expect(byClass(viewer.tree(), "badge").length).toBeGreaterThan(0);
  });

  it("日報画面: 日報の無い日に「この日の日報を作る」ボタンと、その案内文が無い。管理者には出る", async () => {
    const hash = "#report=20260628";
    const admin = harness("admin", hash);
    admin.app.start();
    await admin.app.whenIdle();
    expect(byClass(admin.tree(), "report-run")).toHaveLength(1);
    expect(textOf(admin.tree())).toContain("下のボタンで依頼できます");
    const viewer = harness("viewer", hash);
    viewer.app.start();
    await viewer.app.whenIdle();
    expect(byClass(viewer.tree(), "report-run")).toHaveLength(0);
    expect(byClass(viewer.tree(), "report-caution")).toHaveLength(0);
    expect(textOf(viewer.tree())).toContain("まだありません");
    expect(textOf(viewer.tree())).not.toContain("下のボタン");
  });

  it("役割が admin でも viewer でもない値(型を破った呼び出し)は、閲覧者として扱う(管理者の入口を出さない)", async () => {
    const h = harness("root" as never, `#date=${DATE}&venue=central`);
    h.app.start();
    await h.app.whenIdle();
    expect(byClass(h.tree(), "settings-link")).toHaveLength(0);
    expect(byClass(h.tree(), "verify-link")).toHaveLength(0);
    const direct = harness("root" as never, "#settings");
    direct.app.start();
    await direct.app.whenIdle();
    expect(direct.calls).toEqual([]);
    expect(textOf(direct.tree())).toContain("管理者だけが使えます");
  });
});

describe("閲覧者の画面に、設定・ボタンへの案内の文が残らない(結果画面とレース画面のカードの配分の注記)", () => {
  const SETTINGS_GUIDE = "トップの「設定」から入れられます";

  it.each([
    ["結果画面", `#date=${DATE}&venue=central&race=${RACE_ID}&analysis=5`],
    ["レース画面のカードの結果", `#date=${DATE}&venue=central&race=${RACE_ID}`],
  ])("%s: 管理者には「トップの「設定」から入れられます」、閲覧者にはその案内が無い(同じ注記の本文は残る)", async (_name, hash) => {
    const admin = harness("admin", hash);
    admin.app.start();
    await admin.app.whenIdle();
    expect(textOf(admin.tree())).toContain(SETTINGS_GUIDE);
    const viewer = harness("viewer", hash);
    viewer.app.start();
    await viewer.app.whenIdle();
    expect(textOf(viewer.tree())).toContain("配分の提案は出ていません。クラウド版の「馬券用の総資金」と「1レースの上限」が未設定です。");
    expect(textOf(viewer.tree())).not.toContain(SETTINGS_GUIDE);
    expect(textOf(viewer.tree())).not.toContain("入れられます");
  });
});
