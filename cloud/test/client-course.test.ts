import { describe, expect, it } from "vitest";
import type { AnalysisCourse, AnalysisCourseFit, AnalysisDetail, AnalysisHorse } from "../client/api-analysis";
import type { DomDocument } from "../client/dom";
import { buildResultModel } from "../client/result";
import { renderScreen } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";
import { mount } from "./support/dom-mount";

/**
 * Issue #802: 分析の画面の「コースの類似(参考)」の欄と、馬の詳しい中身の「同じコース」「似たコース」の行。
 * サーバが検査して付けた `course`・`courseFit` から作る。欄が無い応答(今の版)は、今までの画面と同じ。
 */

const NOTE = "参考の情報。モデルの確率には使っていない";
const REC = { runs: 5, wins: 1, top3: 2, best: 1 };
const FIT = (over: Partial<AnalysisCourseFit> = {}): AnalysisCourseFit => ({ same: REC, similar: { runs: 12, wins: 2, top3: 6, best: 1 }, unknownRing: 0, ...over });
const COURSE: AnalysisCourse = {
  name: "東京 芝1600",
  similarShape: [{ name: "中山 芝2000", s: 0.5 }, { name: "阪神 芝1600", s: 0.987 }],
  similarResults: [{ name: "京都 芝1600", s: 0.25, n: 12 }],
};

function horse(umaban: number, over: Partial<AnalysisHorse> = {}): AnalysisHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.05, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: null, fairWinOdds: null, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, ...over };
}
function analysis(over: Partial<AnalysisDetail> = {}): AnalysisDetail {
  return {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: "20260628",
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス", grade: null, oddsStatus: "result", placeBasis: "top3" },
    horses: [horse(1), horse(2)],
    allocation: null,
    detail: "present",
    ...over,
  } as AnalysisDetail;
}
const ROUTE = { date: "20260628", venue: "central", race: null, analysis: 7, settings: false } as const;
const content = (a: AnalysisDetail) => buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a } }).content!;
const tree = (a: AnalysisDetail, open: number[] = a.horses.map((h) => h.umaban)): VNode => renderScreen(buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a }, openHorses: open }), noopActions);

function textOf(node: VNode | string): string {
  return typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" ");
}
function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (t: VNode, cls: string): VNode[] => findAll(t, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));

describe("馬の成績の文(HorseCard.courseFit)", () => {
  const lines = (fit: AnalysisCourseFit | undefined) => content(analysis({ horses: [horse(1, fit === undefined ? {} : { courseFit: fit })] })).horses[0]!.courseFit;

  it("欄が無い馬は null", () => {
    expect(lines(undefined)).toBeNull();
  });

  it("形は「同じコース: 5走 1勝 3着内2(最高1着)」「似たコース: …」。回りの決まらない過去走は 0 のとき出さない", () => {
    expect(lines(FIT())).toEqual({ same: "同じコース: 5走 1勝 3着内2(最高1着)", similar: "似たコース: 12走 2勝 3着内6(最高1着)", ring: null });
  });

  it("runs 0 は「0走」だけ(勝・3着内・最高は出さない)", () => {
    const fit = FIT({ same: { runs: 0, wins: 0, top3: 0, best: null } });
    expect(lines(fit)!.same).toBe("同じコース: 0走");
  });

  it("runs が 1 以上で best が null は、最高を出さない。wins 0 の「0勝」は出す", () => {
    const fit = FIT({ same: { runs: 3, wins: 0, top3: 0, best: null } });
    expect(lines(fit)!.same).toBe("同じコース: 3走 0勝 3着内0");
  });

  it("best の 2 桁(18 着)もそのまま", () => {
    expect(lines(FIT({ same: { runs: 4, wins: 0, top3: 0, best: 18 } }))!.same).toBe("同じコース: 4走 0勝 3着内0(最高18着)");
  });

  it.each([
    [0, null],
    [1, "回りの決まらない過去走: 1"],
    [7, "回りの決まらない過去走: 7"],
  ])("unknownRing %i", (n, want) => {
    expect(lines(FIT({ unknownRing: n }))!.ring).toBe(want);
  });
});

describe("コースの欄(ResultContent.course)", () => {
  it("欄が無い応答では null", () => {
    expect(content(analysis()).course).toBeNull();
  });

  it("今日のコース名・形から似たコース(s は小数 2 桁)・成績から似たコース(n を必ず並べる)・注記", () => {
    expect(content(analysis({ course: COURSE })).course).toEqual({
      heading: "コースの類似(参考)",
      todayLine: "今日のコース: 東京 芝1600",
      shape: { label: "形から似たコース", items: ["中山 芝2000 0.50", "阪神 芝1600 0.99"] },
      results: { label: "成績から似たコース", items: ["京都 芝1600 0.25(根拠の馬 12頭)"] },
      note: NOTE,
    });
  });

  it("s の 0 と 1 も 2 桁。n の 0 も並べる", () => {
    const c = content(analysis({ course: { name: "東京 芝1600", similarShape: [{ name: "a", s: 0 }, { name: "b", s: 1 }], similarResults: [{ name: "c", s: 0, n: 0 }] } })).course!;
    expect(c.shape!.items).toEqual(["a 0.00", "b 1.00"]);
    expect(c.results!.items).toEqual(["c 0.00(根拠の馬 0頭)"]);
  });

  it("配列が null か空なら、その一覧は出さない(今日のコースと注記は残る)", () => {
    const c = content(analysis({ course: { name: "東京 芝1600", similarShape: null, similarResults: [] } })).course!;
    expect(c.shape).toBeNull();
    expect(c.results).toBeNull();
    expect(c.todayLine).toBe("今日のコース: 東京 芝1600");
  });

  it("注記に、探索の検証の結果や類似の作り方の説明は書かない(参考の情報であることだけ)", () => {
    expect(content(analysis({ course: COURSE })).course!.note).toBe(NOTE);
  });
});

describe("画面(view)", () => {
  it("欄が無い応答では、コースの欄も成績の行も出ない(今までと同じ)", () => {
    const t = tree(analysis());
    expect(byClass(t, "course-ref")).toHaveLength(0);
    expect(byClass(t, "course-fit")).toHaveLength(0);
    expect(textOf(t)).not.toContain("コースの類似");
  });

  it("コースの欄は、馬ごとの評価の表の直後に出る。内容は model の文のとおり、注記つき", () => {
    const t = tree(analysis({ course: COURSE }));
    const box = byClass(t, "course-ref");
    expect(box).toHaveLength(1);
    const text = textOf(box[0]!);
    for (const s of ["コースの類似(参考)", "今日のコース: 東京 芝1600", "形から似たコース", "中山 芝2000 0.50", "成績から似たコース", "京都 芝1600 0.25(根拠の馬 12頭)", NOTE]) {
      expect(text, s).toContain(s);
    }
    const wrap = byClass(t, "horse-table-wrap")[0]!;
    const parent = findAll(t, (n) => (n.children ?? []).includes(wrap))[0]!;
    const order = (parent.children ?? []).filter((c): c is VNode => typeof c !== "string");
    expect(order.indexOf(box[0]!)).toBeGreaterThan(order.indexOf(wrap));
  });

  it("馬の成績は、開いた行の詳しい中身(タイム指数の下・根拠の上)に出る。閉じた馬には出ない。表の列は増えない", () => {
    const a = analysis({ model: "claude-x", horses: [horse(1, { courseFit: FIT({ unknownRing: 3 }), timeIndexLine: "タイム指数 …", reason: "根拠の文" }), horse(2, { courseFit: FIT() })], course: COURSE });
    const closed = tree(a, [1]);
    const details = byClass(closed, "eval-detail");
    expect(details).toHaveLength(1);
    const lines = byClass(details[0]!, "course-fit").map(textOf);
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining("同じコース: 5走 1勝 3着内2(最高1着)"), expect.stringContaining("似たコース: 12走 2勝 3着内6(最高1着)"), expect.stringContaining("回りの決まらない過去走: 3")]));
    expect(byClass(closed, "course-fit").length, "閉じた馬 2 には出ない").toBe(lines.length);
    const kids = byClass(details[0]!, "horse")[0]!.children!.map((c) => (typeof c === "string" ? "" : String(c.attrs?.["class"])));
    const iTime = kids.findIndex((c) => c.includes("time-index"));
    const iFit = kids.findIndex((c) => c.includes("course-fit"));
    const iReason = kids.findIndex((c) => c.includes("horse-reason"));
    expect(iTime).toBeGreaterThanOrEqual(0);
    expect(iFit).toBeGreaterThan(iTime);
    expect(iReason).toBeGreaterThan(iFit);
    expect(findAll(closed, (n) => n.tag === "th")).toHaveLength(findAll(tree(analysis({ model: "claude-x" }), [1]), (n) => n.tag === "th").length);
  });

  it("回りの決まらない過去走が 0 なら、その行は出ない", () => {
    const t = tree(analysis({ horses: [horse(1, { courseFit: FIT() })] }));
    expect(textOf(t)).not.toContain("回りの決まらない過去走");
    expect(textOf(t)).toContain("同じコース");
  });

  it("外から来た文字列(コース名)はテキストノードだけ(許可リストの外の要素・属性は作らない)", () => {
    const a = analysis({ course: { name: "<img src=x onerror=alert(1)>", similarShape: [{ name: "<b>x</b>", s: 0.5 }], similarResults: null } });
    const tags: string[] = [];
    const texts: string[] = [];
    const doc: DomDocument = {
      createElement: (tag) => (tags.push(tag), { setAttribute() {}, appendChild() {}, addEventListener() {} }),
      createTextNode: (text) => (texts.push(text), {}),
    };
    mount(doc, { replaceChildren() {} }, tree(a));
    expect(tags).not.toContain("img");
    expect(tags).not.toContain("b");
    expect(texts.some((x) => x.includes("<img"))).toBe(true);
  });
});
