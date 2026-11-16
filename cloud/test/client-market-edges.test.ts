import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { fetchMarketEdges, parseMarketEdgesResponse } from "../client/api-market-edges";
import { buildMarketEdgesModel } from "../client/market-edges-model";
import { createMarketEdgesScreen } from "../client/market-edges-screen";
import { MARKET_EDGE_FEW_N } from "../client/result";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #644: 騎手・調教師の指標の一覧(`#edges`)の API の解釈・表示用データ・VNode・画面の制御。
 * サーバが並べた順をそのまま使う(クライアントで並べ替えない)。値は #643 と同じ `formatAdjustment`(「+3.0pt」)、3着内率・市場の予測は %。件数 50 未満は「少」と薄い字。
 */

const note = "参考(確かめ中)の注記";
const row = (name: string, edge: number, n: number, hit = 0.3, pred = 0.28) => ({ name, edge, n, hit_rate: hit, pred_mean: pred });
const body = (kind: string, rows: unknown[]) => ({ ok: true, kind, note, rows });

function textOf(node: VNode | string): string {
  return typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" ");
}
function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));

describe("parseMarketEdgesResponse", () => {
  it("正しい応答を読む", () => {
    const r = parseMarketEdgesResponse(200, body("trainer", [row("甲", 0.03, 312)]));
    expect(r).toStrictEqual({ ok: true, data: { kind: "trainer", note, rows: [{ name: "甲", edge: 0.03, n: 312, hitRate: 0.3, predMean: 0.28 }] } });
  });

  it.each([
    ["kind が想定外", body("horse", [])],
    ["rows が配列でない", { ok: true, kind: "jockey", note, rows: null }],
    ["note が無い", { ok: true, kind: "jockey", rows: [] }],
    ["行の値が文字列", body("jockey", [{ name: "甲", edge: "0.1", n: 1, hit_rate: 0.1, pred_mean: 0.1 }])],
    ["行の件数が小数", body("jockey", [row("甲", 0.01, 1.5)])],
    ["行の件数が負", body("jockey", [row("甲", 0.01, -1)])],
    ["行の名前が無い", body("jockey", [{ edge: 0.1, n: 1, hit_rate: 0.1, pred_mean: 0.1 }])],
    ["ok が false", { ok: false }],
  ])("想定外の応答は unexpected(一部の行だけ黙って落とさない): %s", (_label, b) => {
    expect(parseMarketEdgesResponse(200, b)).toStrictEqual({ ok: false, error: { kind: "unexpected", httpStatus: 200 } });
  });

  it("200 以外は分類した失敗", () => {
    const r = parseMarketEdgesResponse(503, { ok: false, error: { type: "d1-error" } });
    expect(r.ok).toBe(false);
  });

  it("fetchMarketEdges は kind をクエリに載せる。ネットワークの失敗は network", async () => {
    const calls: string[] = [];
    const f: FetchLike = async (url) => {
      calls.push(url);
      return { status: 200, json: async () => body("trainer", []) };
    };
    expect((await fetchMarketEdges(f, "trainer")).ok).toBe(true);
    expect(calls).toEqual(["/api/market-edges?kind=trainer"]);
    const bad: FetchLike = async () => {
      throw new Error("x");
    };
    expect(await fetchMarketEdges(bad, "jockey")).toStrictEqual({ ok: false, error: { kind: "network" } });
  });
});

describe("buildMarketEdgesModel", () => {
  const data = (rows: ReturnType<typeof row>[]) => {
    const r = parseMarketEdgesResponse(200, body("jockey", rows));
    if (!r.ok) throw new Error("x");
    return r.data;
  };

  it("行はサーバの順のまま。順位・名前・値(+3.0pt)・件数・3着内率(%)・市場の予測(%)", () => {
    const m = buildMarketEdgesModel({ kind: "jockey", data: data([row("甲", 0.031, 312, 0.314, 0.283), row("乙", -0.0126, 80, 0.2, 0.213)]), error: null, loading: false, backHref: "#b" });
    expect(m.kind).toBe("edges");
    expect(m.rows).toStrictEqual([
      { rank: 1, name: "甲", value: "+3.1pt", n: "312", few: false, hit: "31.4%", pred: "28.3%" },
      { rank: 2, name: "乙", value: "-1.3pt", n: "80", few: false, hit: "20.0%", pred: "21.3%" },
    ]);
  });

  it("丸めて 0 になる値は ±0.0pt", () => {
    const m = buildMarketEdgesModel({ kind: "jockey", data: data([row("甲", 0.0001, 100)]), error: null, loading: false, backHref: "#b" });
    expect(m.rows[0]!.value).toBe("±0.0pt");
  });

  it("件数の境界: 49 は少ない、50 は少なくない(MARKET_EDGE_FEW_N を共有)", () => {
    expect(MARKET_EDGE_FEW_N).toBe(50);
    const m = buildMarketEdgesModel({ kind: "jockey", data: data([row("甲", 0.01, 49), row("乙", 0.01, 50)]), error: null, loading: false, backHref: "#b" });
    expect(m.rows.map((r) => r.few)).toEqual([true, false]);
  });

  it("騎手/調教師の切り替えのリンク(今のほうが current)", () => {
    const j = buildMarketEdgesModel({ kind: "jockey", data: null, error: null, loading: true, backHref: "#b" });
    expect(j.tabs).toStrictEqual([
      { label: "騎手", href: "#edges", current: true },
      { label: "調教師", href: "#edges=trainer", current: false },
    ]);
    const t = buildMarketEdgesModel({ kind: "trainer", data: null, error: null, loading: false, backHref: "#b" });
    expect(t.tabs.map((x) => x.current)).toEqual([false, true]);
    expect(j.backHref).toBe("#b");
  });

  it("データが無いとき note は null・行は空", () => {
    const m = buildMarketEdgesModel({ kind: "jockey", data: null, error: "失敗", loading: false, backHref: "#b" });
    expect(m.note).toBeNull();
    expect(m.rows).toEqual([]);
    expect(m.error).toBe("失敗");
  });
});

describe("指標の一覧の VNode", () => {
  const tree = (rows: ReturnType<typeof row>[]): VNode => {
    const r = parseMarketEdgesResponse(200, body("jockey", rows));
    if (!r.ok) throw new Error("x");
    return renderScreen(buildMarketEdgesModel({ kind: "jockey", data: r.data, error: null, loading: false, backHref: "#b" }), noopActions);
  };

  it("表の見出し 6 列・行ごとのセル・注記が出る。少ない行だけ market-few と「少」", () => {
    const t = tree([row("甲", 0.03, 312), row("乙", 0.02, 49)]);
    expect(findAll(t, (n) => n.tag === "th").map((n) => textOf(n))).toEqual(["順位", "名前", "指標", "件数", "3着内率", "市場の予測"]);
    const trs = findAll(t, (n) => n.tag === "tr" && findAll(n, (c) => c.tag === "td").length > 0);
    expect(trs).toHaveLength(2);
    expect(String(trs[0]!.attrs?.["class"] ?? "")).not.toContain("market-few");
    expect(String(trs[1]!.attrs?.["class"] ?? "")).toContain("market-few");
    expect(byClass(trs[0]!, "market-few-mark")).toHaveLength(0);
    expect(textOf(byClass(trs[1]!, "market-few-mark")[0]!)).toBe("少");
    expect(textOf(byClass(t, "market-note")[0]!)).toBe(note);
    expect(textOf(trs[0]!)).toContain("+3.0pt");
  });

  it("名前は外から来る文字列で、テキストノードだけで入る(要素にならない)", () => {
    const evil = "<b>x</b><img src=x onerror=alert(1)>";
    const t = tree([row(evil, 0.03, 100)]);
    expect(findAll(t, (n) => n.tag === "b" || n.tag === "img")).toHaveLength(0);
    const cell = byClass(t, "market-name");
    expect(cell, "前提: 名前のセルが 1 つ").toHaveLength(1);
    expect(cell[0]!.children, "名前は文字列の子(テキストノード)だけ。属性には入れない").toStrictEqual([evil]);
    expect(cell[0]!.attrs).toStrictEqual({ class: "market-name" });
  });

  it("切り替えのリンク・戻るリンク・見出し・参考(確かめ中)の表示がある", () => {
    const t = tree([]);
    const hrefs = findAll(t, (n) => n.tag === "a").map((n) => String(n.attrs?.["href"]));
    expect(hrefs).toEqual(expect.arrayContaining(["#b", "#edges", "#edges=trainer"]));
    expect(textOf(t)).toContain("参考(確かめ中)");
  });
});

describe("画面の制御", () => {
  function make(respond: (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>) {
    const calls: string[] = [];
    const changes = { n: 0 };
    const fetchLike: FetchLike = async (url) => {
      calls.push(url);
      return respond(url);
    };
    const screen = createMarketEdgesScreen({ fetch: fetchLike, onChange: () => (changes.n += 1) });
    return { screen, calls, changes };
  }

  it("enter で 1 回取り、同じ kind に重ねて入っても取得は増えない。kind が変われば取り直す", async () => {
    const { screen, calls } = make(async (url) => ({ status: 200, json: async () => body(new URL(url, "https://x.invalid").searchParams.get("kind")!, [row("甲", 0.03, 100)]) }));
    screen.enter("jockey");
    screen.enter("jockey");
    await Promise.all(screen.pending());
    expect(calls).toEqual(["/api/market-edges?kind=jockey"]);
    expect(screen.model("#b")!.rows).toHaveLength(1);
    screen.enter("trainer");
    await Promise.all(screen.pending());
    expect(calls).toEqual(["/api/market-edges?kind=jockey", "/api/market-edges?kind=trainer"]);
    expect(screen.model("#b")!.tabs.map((t) => t.current)).toEqual([false, true]);
  });

  it("離れた後に届いた古い応答は反映しない(leave で model は null)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { screen } = make(async () => {
      await gate;
      return { status: 200, json: async () => body("jockey", [row("甲", 0.03, 100)]) };
    });
    screen.enter("jockey");
    screen.leave();
    release();
    await Promise.all(screen.pending());
    expect(screen.model("#b")).toBeNull();
  });

  it("kind を切り替えた直後に届いた前の kind の応答は反映しない", async () => {
    const gates: Record<string, () => void> = {};
    const { screen } = make((url) => {
      const kind = new URL(url, "https://x.invalid").searchParams.get("kind")!;
      return new Promise((resolve) => {
        gates[kind] = () => resolve({ status: 200, json: async () => body(kind, [row(kind === "jockey" ? "騎手の人" : "調教師の人", 0.03, 100)]) });
      });
    });
    screen.enter("jockey");
    screen.enter("trainer");
    gates["jockey"]!(); // 前の kind の応答が先に届く
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(screen.model("#b")!.rows, "前の kind の応答は反映しない").toEqual([]);
    gates["trainer"]!();
    await Promise.all(screen.pending());
    expect(screen.model("#b")!.rows.map((r) => r.name)).toEqual(["調教師の人"]);
  });

  it("失敗は固定の文言(error)で、最初の取得の失敗は自動で再試行しない。「更新」で取り直す", async () => {
    let fail = true;
    const { screen, calls } = make(async () => (fail ? { status: 503, json: async () => ({ ok: false, error: { type: "d1-error" } }) } : { status: 200, json: async () => body("jockey", []) }));
    screen.enter("jockey");
    await Promise.all(screen.pending());
    expect(screen.model("#b")!.error).not.toBeNull();
    expect(calls).toHaveLength(1);
    fail = false;
    screen.onRefresh();
    await Promise.all(screen.pending());
    expect(calls).toHaveLength(2);
    expect(screen.model("#b")!.error).toBeNull();
  });
});
