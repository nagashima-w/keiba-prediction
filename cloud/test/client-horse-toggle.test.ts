import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import type { AnalysisDetail } from "../client/api-analysis";
import { createApp, type App } from "../client/app";
import { buildRaceModel } from "../client/race";
import { buildResultModel } from "../client/result";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #740: 結果画面の「馬ごとの評価」。馬のカード(12 枚の縦の並び)をやめ、普段は閉じておき、表の馬の行を押すとその行の直後に詳しい中身(旧カードの中身)が開く。
 *  - 既定は全部閉じる(閉じた中身は木に出ない)。開閉の状態は分析 id ごとにアプリがメモリに持つ(既存の 6 つの開閉〈`onToggleNotes` など〉と同じ型)。
 *  - 開閉はボタン(`button.horse-toggle`。Enter・Space でそのまま操作できる)。`aria-expanded`・`aria-controls`・`data-analysis`・`data-umaban` を持つ。
 *  - 閲覧者(readOnly)も開閉できる(詳しい中身は読むだけで、実行のボタンを持たない)。
 */

const RACE_ID = "202603020211";
const DATE = "20260628";
const route = { date: DATE, venue: "central" as const, race: null, analysis: 7, settings: false };

function horse(umaban: number, name: string, over: Record<string, unknown> = {}) {
  return { umaban, name, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.25, isPositive: umaban === 1, mark: umaban === 1 ? "◎" : null, reason: `根拠${umaban}`, highlights: ["強調"], concerns: ["懸念"], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, ...over };
}
function analysis(over: Partial<AnalysisDetail> = {}): AnalysisDetail {
  return {
    id: 7, raceId: RACE_ID, analyzedAt: "2026-06-28T05:00:00.000Z", kaisaiDate: DATE, evEstimated: false, model: "claude-x", llmNote: null, llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", grade: null, oddsStatus: "result", placeBasis: "top3" },
    horses: [horse(1, "アルファ"), horse(2, "ブラボー", { ev: 0.9 }), horse(3, "チャーリー", { ev: 1.1 })],
    allocation: null, detail: "present", ...over,
  } as AnalysisDetail;
}

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
const resultTree = (a: AnalysisDetail, over: { openHorses?: number[]; readOnly?: boolean; horseSort?: { key: "umaban" | "ev"; dir: "asc" | "desc" } } = {}, actions: ViewActions = noopActions) =>
  renderScreen(buildResultModel({ route, source: { kind: "ready", analysis: a }, ...over }), actions);
const tbodyRows = (tree: VNode): VNode[] => findAll(tree, (n) => n.tag === "tbody").flatMap((t) => (t.children ?? []) as VNode[]);

describe("結果画面: 馬の行の開閉(Issue #740)", () => {
  it("既定は全部閉じる: 詳しい中身(.horse・.horse-detail の行)は木に無く、各行に開閉のボタンが 3 つ。ボタンは閉(aria-expanded=false)", () => {
    const tree = resultTree(analysis());
    expect(byClass(tree, "horse")).toHaveLength(0);
    expect(byClass(tree, "eval-detail")).toHaveLength(0);
    expect(byClass(tree, "horse-list").filter((n) => byClass(n, "horse").length > 0)).toHaveLength(0);
    const toggles = byClass(tree, "horse-toggle");
    expect(toggles).toHaveLength(3); // 前提: 馬が 3 頭いて、開閉のボタンが 3 つ
    expect(toggles.every((t) => t.tag === "button" && t.attrs?.["aria-expanded"] === "false")).toBe(true); // ボタン=Enter・Space で操作できる
    expect(toggles.map((t) => t.attrs?.["data-umaban"])).toEqual(["1", "2", "3"]);
    expect(toggles.every((t) => t.attrs?.["data-analysis"] === "7")).toBe(true);
    expect(textOf(toggles[0]!)).toContain("アルファ");
  });

  it("開いた馬だけ、その行の直後に詳しい行(tr.eval-detail)が出る。id が aria-controls と一致し、中身は旧カードと同じ文言(根拠・強調材料・懸念事項・EV)", () => {
    const tree = resultTree(analysis(), { openHorses: [2] });
    const rows = tbodyRows(tree);
    expect(rows.map((r) => (r.attrs?.["class"] ?? "").toString().split(" ")[0])).toEqual(["eval-row", "eval-row", "eval-detail", "eval-row"]);
    const detail = rows[2]!;
    const toggle = byClass(rows[1]!, "horse-toggle")[0]!;
    expect(toggle.attrs?.["aria-expanded"]).toBe("true");
    expect(toggle.attrs?.["aria-controls"]).toBe("horse-detail-7-2");
    expect(detail.attrs?.["id"]).toBe("horse-detail-7-2");
    const text = textOf(detail);
    // 表に無いものだけが残る(Issue #765)。
    for (const s of ["根拠 根拠2", "強調", "懸念", "単勝", "複勝"]) expect(text, s).toContain(s);
    // 表の列にある値(馬番・馬名・3着内率・EV・複勝下限)は詳しい中身に出さない。同じ値は表の行にある。
    for (const s of ["ブラボー", "3着内率", "複勝オッズ下限", "EV 0.90"]) expect(text, s).not.toContain(s);
    const rowText = textOf(rows[1]!);
    for (const s of ["ブラボー", "20.0%", "0.90", "1.8"]) expect(rowText, `表の行に ${s}`).toContain(s);
    expect(byClass(tree, "eval-detail")).toHaveLength(1); // 前提: 開いていない馬の行は出ない
  });

  it("詳しい行の td の colspan は、表の列の数(補正後あり=LLM が効いた分析)と一致する。LLM なし(補正後の列なし)では 1 列少ない", () => {
    for (const model of ["claude-x", null]) {
      const tree = resultTree(analysis({ model }), { openHorses: [1] });
      const columns = findAll(tree, (n) => n.tag === "th").length;
      const td = findAll(byClass(tree, "eval-detail")[0]!, (n) => n.tag === "td")[0]!;
      expect(columns, `前提: 列がある(model=${String(model)})`).toBeGreaterThan(5);
      expect(td.attrs?.["colspan"]).toBe(String(columns));
    }
  });

  it("騎手・調教師の列があるとき(marketEdge を持つ馬がいる)も、colspan は列の数と一致する", () => {
    const edge = { jockey: { name: "騎手A", edge: 0.03, n: 312, hitRate: 0.3, predMean: 0.28 }, trainer: { name: "調教師B", edge: 0.01, n: 200, hitRate: 0.3, predMean: 0.29 } };
    const a = analysis({ horses: [horse(1, "アルファ", { marketEdge: edge }), horse(2, "ブラボー", { marketEdge: edge })] as never, marketEdgeNote: "注記" } as never);
    const tree = resultTree(a, { openHorses: [1] });
    const columns = findAll(tree, (n) => n.tag === "th").length;
    const noEdge = findAll(resultTree(analysis(), { openHorses: [1] }), (n) => n.tag === "th").length;
    expect(columns, "前提: 騎手・調教師の列で列が増えている").toBe(noEdge + 2);
    expect(findAll(byClass(tree, "eval-detail")[0]!, (n) => n.tag === "td")[0]!.attrs?.["colspan"]).toBe(String(columns));
  });

  it("並べ替えても、詳しい行は自分の馬の行の直後にある(EV の大きい順にしても 1 番の直後)", () => {
    const tree = resultTree(analysis(), { openHorses: [1], horseSort: { key: "ev", dir: "desc" } });
    const rows = tbodyRows(tree);
    const at = rows.findIndex((r) => byClass(r, "horse-toggle").some((t) => t.attrs?.["data-umaban"] === "1"));
    expect(at, "前提: 1 番は先頭(EV 1.25 が最大)").toBe(0);
    expect((rows[at + 1]!.attrs?.["class"] ?? "").toString()).toContain("eval-detail");
    expect(rows[at + 1]!.attrs?.["id"]).toBe("horse-detail-7-1");
  });

  it("閲覧者(readOnly)も開閉できる。開いた中身に実行のボタンは無い", () => {
    const viewer = resultTree(analysis(), { readOnly: true, openHorses: [1] });
    expect(byClass(viewer, "horse-toggle")).toHaveLength(3);
    const detail = byClass(viewer, "eval-detail")[0]!;
    expect(findAll(detail, (n) => n.tag === "button")).toHaveLength(0);
  });

  it("ボタンを押すと onToggleHorse(分析 id・馬番・押したあとの開閉)。閉→開、開→閉", () => {
    const calls: unknown[][] = [];
    const actions = { ...noopActions, onToggleHorse: (...args: unknown[]) => void calls.push(args) } as unknown as ViewActions;
    const closed = resultTree(analysis(), {}, actions);
    byClass(closed, "horse-toggle")[1]!.on!.click!();
    const open = resultTree(analysis(), { openHorses: [2] }, actions);
    byClass(open, "horse-toggle")[1]!.on!.click!();
    expect(calls).toEqual([[7, 2, true], [7, 2, false]]);
  });

  it("レース画面の発走前のカードの中の結果にも同じ開閉がある(開いた馬だけ詳しい行が出る)", () => {
    const row = { raceId: RACE_ID, mode: "pre_race" as const, status: "done" as const, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: 7 };
    const input = {
      route: { date: DATE, venue: "central" as const, race: RACE_ID, analysis: null, settings: false },
      status: { kind: "ready" as const, rows: [row], prior: null },
      past: { kind: "ready" as const, analyses: [] },
      listRow: undefined,
      result: { kind: "ready" as const, analysis: analysis() },
    };
    const closed = renderScreen(buildRaceModel(input), noopActions);
    expect(byClass(closed, "horse-toggle")).toHaveLength(3);
    expect(byClass(closed, "eval-detail")).toHaveLength(0);
    const open = renderScreen(buildRaceModel({ ...input, openHorses: [3] }), noopActions);
    expect(byClass(open, "eval-detail")).toHaveLength(1);
  });
});

describe("アプリ: 馬の行の開閉の状態(Issue #740)", () => {
  type Resp = { status: number; json: () => Promise<unknown> };
  const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
  function harness(startHash = `#date=${DATE}&venue=central&race=${RACE_ID}&analysis=7`): { app: App; tree: () => VNode; click: (umaban: number) => void; go: (hash: string) => Promise<void>; calls: string[] } {
    const calls: string[] = [];
    let tree: VNode | null = null;
    let hash = startHash;
    const fetchLike: FetchLike = async (url) => {
      calls.push(url);
      if (url.startsWith("/api/analyses/status")) return ok({ ok: true, kaisai_date: DATE, races: [{ race_id: RACE_ID, mode: "pre_race", status: "done", attempts: 0, error: null, queued_at: 1, updated_at: 2, prior: false, analysis_id: 7, detail: null, children_ok: null }], prior: null });
      if (url.startsWith("/api/analyses?")) return ok({ ok: true, analyses: [] });
      if (url.startsWith("/api/analyses/7")) return ok({ ok: true, analysis: analysis() });
      if (url.startsWith("/api/analyses/8")) return ok({ ok: true, analysis: analysis({ id: 8 }) });
      return ok({ ok: true, kaisai_date: DATE, venue: "central", races: [] });
    };
    const app = createApp({ role: "admin", fetch: fetchLike, now: () => new Date("2026-06-28T00:00:00Z"), render: (t) => void (tree = t), getHash: () => hash, setHash: (x) => void (hash = x), timers: { set: () => 0, clear: () => {} }, isVisible: () => true });
    return {
      app,
      tree: () => tree!,
      calls,
      go: async (next) => {
        hash = next;
        app.onHashChange();
        await flush();
      },
      click: (umaban) => {
        const t = byClass(tree!, "horse-toggle").find((n) => n.attrs?.["data-umaban"] === String(umaban))!;
        t.on!.click!();
      },
    };
  }
  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r));
  }

  it("押すと開き、もう一度押すと閉じる。取得(fetch)は増えない。別の馬の開閉とは独立", async () => {
    const h = harness();
    h.app.start();
    await flush();
    expect(byClass(h.tree(), "eval-detail")).toHaveLength(0);
    const before = h.calls.length;
    h.click(2);
    expect(byClass(h.tree(), "eval-detail").map((n) => n.attrs?.["id"])).toEqual(["horse-detail-7-2"]);
    h.click(3);
    expect(byClass(h.tree(), "eval-detail").map((n) => n.attrs?.["id"])).toEqual(["horse-detail-7-2", "horse-detail-7-3"]);
    h.click(2);
    expect(byClass(h.tree(), "eval-detail").map((n) => n.attrs?.["id"])).toEqual(["horse-detail-7-3"]);
    expect(h.calls.length, "描画だけで、取得は起こさない").toBe(before);
  });

  it("開いた状態は、並べ替えをしても、「更新」で再描画しても残る(分析 id ごとのメモリ)", async () => {
    const h = harness();
    h.app.start();
    await flush();
    h.click(1);
    const sort = byClass(h.tree(), "sort-button").find((n) => n.attrs?.["data-sort-key"] === "ev")!;
    sort.on!.click!();
    expect(byClass(h.tree(), "eval-detail").map((n) => n.attrs?.["id"])).toEqual(["horse-detail-7-1"]);
  });

  it("レース画面の発走前のカードの中の結果でも、押すと開き、結果画面と同じ分析 id の状態を共有する", async () => {
    const h = harness(`#date=${DATE}&venue=central&race=${RACE_ID}`);
    h.app.start();
    await flush();
    expect(byClass(h.tree(), "horse-toggle")).toHaveLength(3); // 前提: レース画面の結果にも開閉のボタンがある
    h.click(3);
    expect(byClass(h.tree(), "eval-detail").map((n) => n.attrs?.["id"])).toEqual(["horse-detail-7-3"]);
  });

  it("開閉は分析 id ごとに分かれる: 分析 7 で馬 3 を開いても、分析 8 の結果画面では閉じている。7 に戻ると開いたまま(Issue #765。app.ts の horseOpenChoices のキーが分析 id)", async () => {
    const h = harness();
    h.app.start();
    await flush();
    h.click(3);
    expect(byClass(h.tree(), "eval-detail").map((n) => n.attrs?.["id"]), "前提: 分析 7 で馬 3 が開いた").toEqual(["horse-detail-7-3"]);
    await h.go(`#date=${DATE}&venue=central&race=${RACE_ID}&analysis=8`);
    expect(byClass(h.tree(), "horse-toggle"), "前提: 分析 8 の結果画面に着いた(馬の行がある)").toHaveLength(3);
    expect(byClass(h.tree(), "horse-toggle").every((n) => n.attrs?.["data-analysis"] === "8")).toBe(true);
    expect(byClass(h.tree(), "eval-detail"), "分析 8 では閉じている").toHaveLength(0);
    h.click(1);
    expect(byClass(h.tree(), "eval-detail").map((n) => n.attrs?.["id"])).toEqual(["horse-detail-8-1"]);
    await h.go(`#date=${DATE}&venue=central&race=${RACE_ID}&analysis=7`);
    expect(byClass(h.tree(), "eval-detail").map((n) => n.attrs?.["id"]), "7 に戻ると、7 の状態のまま(8 の馬 1 は混ざらない)").toEqual(["horse-detail-7-3"]);
  });
});
