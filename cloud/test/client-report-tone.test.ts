import { describe, expect, it } from "vitest";
import type { ReportDetail } from "../client/api-report";
import type { DomDocument } from "../client/dom";
import { buildReportModel, statTiles, type ReportModelInput } from "../client/report-model";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";
import { mount } from "./support/dom-mount";
import { renderPage } from "../src/page";

/**
 * Issue #579: 日報・月報の回収率のタイルを、100% 以上か未満かで色分けする(文字でも示す)。レースごとの行の賭け金・払戻・差額を色分けし、右に揃える。
 * 判定は**丸める前の回収率**で行う(100.0% に丸まる 0.99996 は「未満」)。保存済みの日報の JSON の形(`ReportDetail`)は変えない。
 */

const stats = (recoveryRate: number | null) => ({
  raceCount: 1, resultRaceCount: 1, noResultRaceCount: 0, betRaceCount: 1, llmUsedRaceCount: 1, totalStake: 1000, totalReturn: 1000, recoveryRate, judgedBetCount: 4, hitBetCount: 1, unjudgedBetCount: 0, unjudgedStake: 0,
  byBetType: {}, byMark: [],
});
const recovery = (rate: number | null) => statTiles(stats(rate)).find((t) => t.label === "回収率")!;

describe("回収率タイルの tone(丸める前の値で判定)", () => {
  const cases: [string, number, "gain" | "loss"][] = [
    ["130%", 1.3, "gain"],
    ["ちょうど 100%(損益ゼロは gain)", 1, "gain"],
    ["100.0% に丸まる 1.00004 は gain", 1.00004, "gain"],
    ["100.0% に丸まる 0.99996 は loss", 0.99996, "loss"],
    ["87.3%", 0.873, "loss"],
    ["0%", 0, "loss"],
  ];
  for (const [name, rate, tone] of cases) {
    it(`${name} → ${tone}。注記の文字も付く`, () => {
      const t = recovery(rate);
      expect(t.tone).toBe(tone);
      expect(t.toneText).toBe(tone === "gain" ? "▲100%以上" : "▼100%未満");
      expect(t.strong).toBe(true);
    });
  }
  it("回収率が無い(null)ときは値 '-' で、tone も注記も付けない", () => {
    const t = recovery(null);
    expect(t.value).toBe("-");
    expect(t.tone).toBeUndefined();
    expect(t.toneText).toBeUndefined();
  });
  it("回収率以外のタイルには tone が付かない(4 枚のうち 1 枚だけ)", () => {
    const tiles = statTiles(stats(1.2));
    expect(tiles).toHaveLength(4);
    expect(tiles.filter((t) => t.tone !== undefined).map((t) => t.label)).toEqual(["回収率"]);
  });
});

function race(over: Partial<ReportDetail["races"][number]> = {}): ReportDetail["races"][number] {
  return { raceId: "202605030801", analysisId: 1, title: "東京1R", llmUsed: true, hasResult: true, top3: [], marks: [], totalStake: 700, totalReturn: 1300, judgedBetCount: 3, hitCount: 1, unjudgedBetCount: 0, allocationNote: null, comment: null, ...over };
}
function report(races: ReportDetail["races"], rate: number | null = 1.3): ReportDetail {
  return { date: "20261010", createdAt: "2026-10-10T11:12:00.000Z", model: null, raceCount: races.length, totalStake: 1000, totalReturn: 1300, summary: null, stats: stats(rate), races, narrative: null, narrativeRaw: null, note: null };
}
const input = (r: ReportDetail, readOnly = false): ReportModelInput => ({ today: "20261010", shownDate: "20261010", list: { kind: "ready", items: [] }, detail: { kind: "ready", report: r, job: null }, run: { kind: "idle" }, pollStopped: false, readOnly });
const moneyOf = (r: ReportDetail["races"][number]) => buildReportModel(input(report([r]))).body!.races[0]!.money;

describe("レースごとの行の損益(money)", () => {
  it("払戻が多い: 差額は '+600円'、tone は gain。賭け金・払戻は桁区切り", () => {
    expect(moneyOf(race())).toEqual({ stake: "700円", payout: "1,300円", net: "+600円", tone: "gain" });
  });
  it("払戻が少ない: 差額は U+2212 のマイナス '−300円'、tone は loss", () => {
    const m = moneyOf(race({ totalStake: 1000, totalReturn: 700, hitCount: 0 }))!;
    expect(m.net).toBe("−300円");
    expect(m.net.startsWith("-")).toBe(false);
    expect(m.tone).toBe("loss");
  });
  it("同額(返還のみなど): '±0円'、tone は none", () => {
    expect(moneyOf(race({ totalStake: 300, totalReturn: 300, hitCount: 0 }))).toEqual({ stake: "300円", payout: "300円", net: "±0円", tone: "none" });
  });
  it("賭け金 0 でも、判定できた買い目があれば行を出す(0 円・±0円)", () => {
    expect(moneyOf(race({ totalStake: 0, totalReturn: 0 }))!.net).toBe("±0円");
  });
  it("判定できた買い目が無い(判定不能だけ・買い目なし)なら null", () => {
    expect(moneyOf(race({ judgedBetCount: 0, hitCount: 0, totalStake: 0, totalReturn: 0, unjudgedBetCount: 1 }))).toBeNull();
    expect(moneyOf(race({ judgedBetCount: 0, hitCount: 0, totalStake: 0, totalReturn: 0 }))).toBeNull();
  });
  it("既存の bets の文言は変わらない(惜しかったレースが同じ文を使う)", () => {
    expect(buildReportModel(input(report([race()]))).body!.races[0]!.bets).toBe("買い目: 3 点中 1 点的中・賭け金 700円・払戻 1,300円");
  });
});

const findAll = (n: VNode | string, pred: (n: VNode) => boolean): VNode[] => (typeof n === "string" ? [] : [...(pred(n) ? [n] : []), ...(n.children ?? []).flatMap((c) => findAll(c, pred))]);
const cls = (n: VNode): string[] => String(n.attrs?.["class"] ?? "").split(" ");
const byClass = (t: VNode, c: string): VNode[] => findAll(t, (n) => cls(n).includes(c));
const text = (n: VNode | string): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(" "));

describe("VNode", () => {
  it("回収率のタイル: gain / loss のクラスと注記の文字。他のタイルには付かない", () => {
    const g = renderScreen(buildReportModel(input(report([race()], 1.3))), noopActions);
    const tile = byClass(g, "verify-tile").find((n) => text(n).includes("回収率"))!;
    expect(cls(tile)).toEqual(expect.arrayContaining(["strong", "gain"]));
    expect(text(byClass(tile, "verify-tile-tone")[0]!)).toBe("▲100%以上");
    expect(byClass(g, "verify-tile").filter((n) => cls(n).includes("gain"))).toHaveLength(1);
    const l = renderScreen(buildReportModel(input(report([race()], 0.5))), noopActions);
    const lt = byClass(l, "verify-tile").find((n) => text(n).includes("回収率"))!;
    expect(cls(lt)).toContain("loss");
    expect(cls(lt)).not.toContain("gain");
    expect(text(byClass(lt, "verify-tile-tone")[0]!)).toBe("▼100%未満");
  });
  it("閲覧者(readOnly)にも同じタイルと損益が出る", () => {
    const t = renderScreen(buildReportModel(input(report([race()]), true)), noopActions);
    expect(byClass(t, "gain").length).toBeGreaterThanOrEqual(2); // タイル + 差額
    expect(text(byClass(t, "report-money")[0]!)).toContain("差額 +600円");
  });
  it("損益の行: 賭け金・払戻・差額の 3 つ。差額に tone のクラス。損益の無いレースには出ない", () => {
    const t = renderScreen(buildReportModel(input(report([race(), race({ raceId: "202605030802", judgedBetCount: 0, hitCount: 0, totalStake: 0, totalReturn: 0 })]))), noopActions);
    const rows = byClass(t, "report-money");
    expect(rows).toHaveLength(1);
    expect(text(rows[0]!)).toBe("賭け金 700円 払戻 1,300円 差額 +600円");
    expect(cls(byClass(rows[0]!, "report-net")[0]!)).toContain("gain");
  });
  it("mount できる", () => {
    const doc: DomDocument = { createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }), createTextNode: () => ({}) };
    mount(doc, { replaceChildren() {} }, renderScreen(buildReportModel(input(report([race()]))), noopActions));
  });
});

describe("CSS", () => {
  const css = (/<style>([\s\S]*?)<\/style>/.exec(renderPage("owner@example.com", "admin"))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("gain は ok、loss は fail の色(ok・fail の変数だけ)。差額は右揃え", () => {
    expect(css).toMatch(/\.verify-tile\.gain\s*\{[^}]*var\(--ok\)/);
    expect(css).toMatch(/\.verify-tile\.loss\s*\{[^}]*var\(--fail\)/);
    expect(css).toMatch(/\.report-net\.gain\s*\{[^}]*var\(--ok\)/);
    expect(css).toMatch(/\.report-net\.loss\s*\{[^}]*var\(--fail\)/);
    expect(css).toMatch(/\.report-money\s*\{[^}]*justify-content:\s*flex-end/);
    expect(css).toMatch(/\.report-money\s*\{[^}]*tabular-nums/);
  });
});
