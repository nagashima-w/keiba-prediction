import { describe, expect, it } from "vitest";
import { buildMarketEdgesView } from "../src/market-edges-view";
import type { MarketEdgeMeta, StoredMarketEdge } from "../src/market-edge-repository";

/**
 * Issue #644: 騎手・調教師の指標の一覧の応答(サーバの組み立て)。並びは指標の大きい順(同点は件数の多い順 → ID の昇順)。
 * 注記・説明の文はサーバで組み立てる(クライアントの束に日本語を置かない)。
 */

const META: MarketEdgeMeta = {
  computedOn: "2026-11-16",
  windowFrom: "2024-11-17",
  windowTo: "2026-11-15",
  coef: [2.857, 0.922, -0.556],
  converged: true,
  iterations: 6,
  races: 7718,
  horses: 105316,
};

const edge = (id: string, name: string | null, n: number, e: number, hit = 0.3, pred = 0.28): StoredMarketEdge => ({ id, name, n, edge: e, hitRate: hit, predMean: pred, computedOn: "2026-11-16" });

describe("buildMarketEdgesView(Issue #644)", () => {
  it("指標の大きい順に並べる(降順。昇順や ID 順ではない)", () => {
    const v = buildMarketEdgesView("jockey", [edge("a", "甲", 100, 0.01), edge("b", "乙", 100, 0.03), edge("c", "丙", 100, -0.02)], META);
    expect(v.rows.map((r) => r.name)).toEqual(["乙", "甲", "丙"]);
  });

  it("同点は件数の多い順、それも同じなら ID の昇順(決まった順)", () => {
    const v = buildMarketEdgesView(
      "trainer",
      [edge("z", "Z", 50, 0.02), edge("b", "B", 80, 0.02), edge("a", "A", 80, 0.02), edge("y", "Y", 10, 0.02)],
      META,
    );
    expect(v.rows.map((r) => r.name)).toEqual(["A", "B", "Z", "Y"]);
  });

  it("行は名前・指標・件数・3着内率・市場の予測を、そのまま渡す(ID は返さない)。名前が無い人は ID を名前の代わりにする", () => {
    const v = buildMarketEdgesView("jockey", [edge("01234", null, 312, 0.031, 0.31, 0.279)], META);
    expect(v.rows).toStrictEqual([{ name: "01234", edge: 0.031, n: 312, hit_rate: 0.31, pred_mean: 0.279 }]);
  });

  it("note は参考(確かめ中)・分析に使っていない・期間・意味・0 への寄せ・計算日・芝ダ別と競馬場別が無いことを含む", () => {
    const v = buildMarketEdgesView("jockey", [edge("a", "甲", 100, 0.01)], META);
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("jockey");
    for (const s of ["参考(確かめ中)", "分析(LLM・配分)には使っていません", "2024-11-17〜2026-11-15", "単勝オッズから見込まれる", "件数が少ないほど 0 に寄せてあります(「少」の印は 50 回未満)。", "2026-11-16", "芝・ダート別や競馬場別の値はありません"]) {
      expect(v.note).toContain(s);
    }
    expect(v.note).not.toContain("件数が少ない人(");
  });

  it("meta が無いとき(計算前)は rows が空で、「まだ計算していません」の文。行があっても返さない", () => {
    const v = buildMarketEdgesView("trainer", [edge("a", "甲", 100, 0.01)], null);
    expect(v.rows).toEqual([]);
    expect(v.note).toContain("まだ計算していません");
    expect(v.kind).toBe("trainer");
  });
});
