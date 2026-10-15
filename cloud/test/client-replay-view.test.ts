import { describe, expect, it } from "vitest";
import type { AnalysisDetail, AnalysisHorse } from "../client/api-analysis";
import { mount, type DomDocument } from "../client/dom";
import { buildRaceModel } from "../client/race";
import { buildResultModel } from "../client/result";
import { REPLAY_AGAIN_LABEL, REPLAY_COLOR_NOTE, REPLAY_HEADING, REPLAY_NOTE, REPLAY_PLAY_LABEL, REPLAY_REPEAT_LABEL, REPLAY_SPEEDS, replaySectionOf } from "../client/replay-model";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #311(レース再生): 表示用データ(`replaySectionOf`・`contentOf` の `replay`)と VNode。
 * ボタンが出る条件(勝率が判定不能・2頭未満のときは出さない)、演出の注記、再生後の着順のテキスト、クリック処理の引数が data-* に出ること。
 */

function horse(umaban: number, over: Partial<AnalysisHorse> = {}): AnalysisHorse {
  return { umaban, name: `馬${umaban}`, prior: 0.3, adjustedProb: 0.25, placeOddsMin: 1.8, ev: 1.05, isPositive: false, mark: null, reason: null, highlights: [], concerns: [], winProb: 0.25, fairWinOdds: 3.2, winOdds: null, fairPlaceOdds: null, actualPlaceOddsMin: null, actualPlaceOddsMax: null, earlyPos: null, ...over };
}

function analysis(horses: AnalysisHorse[] = [horse(1), horse(2), horse(3), horse(4)]): AnalysisDetail {
  return {
    id: 7,
    raceId: "202603020211",
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: "20260628",
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テスト", grade: null, oddsStatus: "result", placeBasis: "top3", distance: 1800, turn: "right" },
    horses,
    allocation: null,
    detail: "present",
  } as AnalysisDetail;
}

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(""));

describe("replaySectionOf(表示用データ)", () => {
  it("再生できる分析: 見出し・演出の注記・ボタンの文言・速度(×1 ×2 ×4)。まだ再生していない(canvas を出さない)", () => {
    const s = replaySectionOf(analysis(), undefined);
    expect(s).toEqual({
      heading: REPLAY_HEADING,
      note: REPLAY_NOTE,
      colorNote: REPLAY_COLOR_NOTE,
      analysisId: 7,
      started: false,
      playLabel: REPLAY_PLAY_LABEL,
      repeatLabel: null,
      speeds: [
        { value: 1, label: "×1", pressed: true },
        { value: 2, label: "×2", pressed: false },
        { value: 4, label: "×4", pressed: false },
      ],
      finishHeading: null,
      finish: null,
    });
    expect(REPLAY_SPEEDS).toEqual([1, 2, 4]);
  });

  it("文言: 注記は『演出であって物理的なシミュレーションではない・確率・配分は変わらない』を言う。ボタンは『レースを再生』『別の展開で再生』", () => {
    expect(REPLAY_NOTE).toContain("演出");
    expect(REPLAY_NOTE).toContain("物理的なシミュレーションではなく");
    expect(REPLAY_NOTE).toContain("確率・配分は変わりません");
    expect(REPLAY_COLOR_NOTE).toBe("色の付いた丸は◎の馬(◎が無ければ勝率が最も高い馬)です。");
    expect(REPLAY_PLAY_LABEL).toBe("レースを再生");
    expect(REPLAY_AGAIN_LABEL).toBe("別の展開で再生");
    expect(REPLAY_REPEAT_LABEL).toBe("もう一度再生");
  });

  it("勝率が判定不能(winProb が null)・2頭未満なら null(ボタンを出さない)", () => {
    expect(replaySectionOf(analysis([1, 2, 3, 4].map((u) => horse(u, { winProb: null }))), undefined)).toBeNull();
    expect(replaySectionOf(analysis([horse(1)]), undefined)).toBeNull();
  });

  it("詳細(馬名)が無い分析でも出る(winProb は D1 の値だけで決まる)", () => {
    expect(replaySectionOf(analysis([1, 2, 3, 4].map((u) => horse(u, { name: null }))), undefined)).not.toBeNull();
  });

  it("再生を始めたあと(started): ボタンは『別の展開で再生』。速度の選択(pressed)が反映される。別の分析の再生中は started にしない", () => {
    const s = replaySectionOf(analysis(), { startedId: 7, speed: 2, finishOrder: null });
    expect(s).toMatchObject({ started: true, playLabel: REPLAY_AGAIN_LABEL, finish: null });
    expect(s!.speeds.map((x) => [x.value, x.pressed])).toEqual([[1, false], [2, true], [4, false]]);
    const other = replaySectionOf(analysis(), { startedId: 8, speed: 4, finishOrder: [1, 2, 3, 4] });
    expect(other).toMatchObject({ started: false, playLabel: REPLAY_PLAY_LABEL, finish: null });
    // 速度は分析をまたいで共通(始めていなくても選択は反映される)
    expect(other!.speeds.map((x) => x.pressed)).toEqual([false, false, true]);
  });

  it("終わった再生の着順: 『N着 馬番 馬名』の行(馬名が無ければ馬番だけ)。着順の通り", () => {
    const s = replaySectionOf(analysis([horse(1), horse(2, { name: null }), horse(3), horse(4)]), { startedId: 7, speed: 1, finishOrder: [3, 1, 2, 4] });
    expect(s!.finishHeading).not.toBeNull();
    expect(s!.finish).toEqual(["1着 3 馬3", "2着 1 馬1", "3着 2", "4着 4 馬4"]);
  });

  it("着順に知らない馬番が混じっても投げない(馬番だけの行)", () => {
    const s = replaySectionOf(analysis(), { startedId: 7, speed: 1, finishOrder: [9, 1] });
    expect(s!.finish).toEqual(["1着 9", "2着 1 馬1"]);
  });
});

const ROUTE = { date: "20260628", venue: "central", race: null, analysis: 7, settings: false } as const;
const view = (a: AnalysisDetail, replay?: Parameters<typeof buildResultModel>[0]["replay"], actions: ViewActions = noopActions): VNode =>
  renderScreen(buildResultModel({ route: ROUTE, source: { kind: "ready", analysis: a }, ...(replay === undefined ? {} : { replay }) }), actions);

describe("結果画面のレース再生の節(VNode)", () => {
  it("再生前: 見出し・注記・『レースを再生』ボタン・速度ボタン。canvas は出さない。節は『3着内率の上位5頭』のあと・『馬ごとの評価』の前", () => {
    const tree = view(analysis());
    const sections = byClass(tree, "replay");
    expect(sections.length).toBe(1);
    const sec = sections[0]!;
    expect(textOf(sec)).toContain(REPLAY_HEADING);
    expect(byClass(sec, "replay-note").map(textOf)).toEqual([REPLAY_NOTE]);
    // 色の意味の説明(Issue #316)。再生前から出す
    expect(byClass(sec, "replay-color-note").map(textOf)).toEqual([REPLAY_COLOR_NOTE]);
    const play = byClass(sec, "replay-play");
    expect(play.map(textOf)).toEqual([REPLAY_PLAY_LABEL]);
    expect(play[0]!.attrs?.["data-analysis-id"]).toBe("7");
    expect(findAll(sec, (n) => n.tag === "canvas").length).toBe(0);
    expect(byClass(sec, "replay-speed").map((b) => [textOf(b), b.attrs?.["data-speed"], b.attrs?.["aria-pressed"]])).toEqual([
      ["×1", "1", "true"],
      ["×2", "2", "false"],
      ["×4", "4", "false"],
    ]);
    // 節の順
    const order = findAll(tree, (n) => n.tag === "section").map((n) => (n.attrs?.["class"] ?? "").toString());
    expect(order.indexOf("replay")).toBeGreaterThan(order.indexOf("top-probs"));
    expect(order.indexOf("replay")).toBeLessThan(order.indexOf("horses"));
  });

  it("再生を始めたあと: canvas(data-replay-id・role=img・aria-label)が出て、ボタンは『別の展開で再生』。終わるまで着順のテキストは出さない", () => {
    const tree = view(analysis(), { startedId: 7, speed: 1, finishOrder: null });
    const sec = byClass(tree, "replay")[0]!;
    const canvases = findAll(sec, (n) => n.tag === "canvas");
    expect(canvases.length).toBe(1);
    expect(canvases[0]!.attrs).toMatchObject({ class: "replay-canvas", "data-replay-id": "7", role: "img" });
    expect(String(canvases[0]!.attrs?.["aria-label"]).length).toBeGreaterThan(5);
    expect(byClass(sec, "replay-play").map(textOf)).toEqual([REPLAY_AGAIN_LABEL]);
    expect(byClass(sec, "replay-finish").length).toBe(0);
  });

  it("再生が終わったら着順のテキスト(見出し + 行)が出る。馬名は外から来た文字列なのでテキストとして入る", () => {
    const tree = view(analysis([horse(1, { name: "<b>x</b>" }), horse(2), horse(3), horse(4)]), { startedId: 7, speed: 1, finishOrder: [1, 2, 3, 4] });
    const fin = byClass(tree, "replay-finish")[0]!;
    const items = findAll(fin, (n) => n.tag === "li").map(textOf);
    expect(items).toEqual(["1着 1 <b>x</b>", "2着 2 馬2", "3着 3 馬3", "4着 4 馬4"]);
  });

  it("『もう一度再生』(Issue #314): 最初の再生の前は出さない。再生を始めたあとは(再生中・終了後とも)出る。別の分析を再生した状態では出ない", () => {
    expect(replaySectionOf(analysis(), undefined)!.repeatLabel).toBeNull();
    expect(replaySectionOf(analysis(), { startedId: 7, speed: 1, finishOrder: null })!.repeatLabel).toBe(REPLAY_REPEAT_LABEL);
    expect(replaySectionOf(analysis(), { startedId: 7, speed: 1, finishOrder: [1, 2, 3, 4] })!.repeatLabel).toBe(REPLAY_REPEAT_LABEL);
    expect(replaySectionOf(analysis(), { startedId: 8, speed: 1, finishOrder: [1, 2, 3, 4] })!.repeatLabel).toBeNull();
    expect(replaySectionOf(analysis(), { startedId: null, speed: 1, finishOrder: null })!.repeatLabel).toBeNull();
  });

  it("『もう一度再生』のボタン(VNode): 再生前は無い。再生中・終了後はある(『別の展開で再生』とは別のボタン)。クリックは分析 id を渡す", () => {
    const before = byClass(byClass(view(analysis()), "replay")[0]!, "replay-repeat");
    expect(before.length).toBe(0);
    for (const finishOrder of [null, [1, 2, 3, 4]] as const) {
      const calls: unknown[] = [];
      const actions: ViewActions = { ...noopActions, onReplayPlay: (id) => calls.push(["play", id]), onReplayRepeat: (id) => calls.push(["repeat", id]) };
      const sec = byClass(view(analysis(), { startedId: 7, speed: 1, finishOrder }, actions), "replay")[0]!;
      const repeat = byClass(sec, "replay-repeat");
      expect(repeat.map(textOf)).toEqual([REPLAY_REPEAT_LABEL]);
      expect(repeat[0]!.attrs?.["data-analysis-id"]).toBe("7");
      expect(byClass(sec, "replay-play").map(textOf), "別の展開は別のボタン").toEqual([REPLAY_AGAIN_LABEL]);
      repeat[0]!.on!.click!();
      expect(calls).toEqual([["repeat", 7]]);
    }
  });

  it("勝率が判定不能の分析には節ごと出さない", () => {
    expect(byClass(view(analysis([1, 2, 3, 4].map((u) => horse(u, { winProb: null })))), "replay").length).toBe(0);
  });

  it("クリック処理: 『再生』は分析 id、速度は値を渡す。引数は data-* にも出ている(同じ木なら DOM を触らない仕組みのため)", () => {
    const calls: unknown[] = [];
    const actions: ViewActions = { ...noopActions, onReplayPlay: (id) => calls.push(["play", id]), onReplaySpeed: (v) => calls.push(["speed", v]) };
    const tree = view(analysis(), undefined, actions);
    const sec = byClass(tree, "replay")[0]!;
    byClass(sec, "replay-play")[0]!.on!.click!();
    for (const b of byClass(sec, "replay-speed")) b.on!.click!();
    expect(calls).toEqual([["play", 7], ["speed", 1], ["speed", 2], ["speed", 4]]);
  });

  it("許可リスト(dom.ts)で組み立てられる(canvas・aria-pressed・data-*)", () => {
    const tags: string[] = [];
    const attrs: string[] = [];
    const doc: DomDocument = {
      createElement: (tag) => {
        tags.push(tag);
        return { setAttribute: (n: string) => attrs.push(n), appendChild() {}, addEventListener() {} };
      },
      createTextNode: () => ({}),
    };
    mount(doc, { replaceChildren() {} }, view(analysis(), { startedId: 7, speed: 1, finishOrder: [1, 2, 3, 4] }));
    expect(tags).toContain("canvas");
    expect(attrs).toContain("data-replay-id");
    expect(attrs).toContain("aria-pressed");
  });
});

describe("発走前のカードの中の結果にも同じ節が出る", () => {
  it("レース画面の発走前のカード: 最新の分析の結果の中に『レース再生』の節。再生の状態が反映される", () => {
    const board = [{ raceId: "202603020211", mode: "pre_race", status: "done", attempts: 1, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: 7 }] as const;
    const model = buildRaceModel({
      route: { date: "20260628", venue: "central", race: "202603020211", analysis: null, settings: false },
      status: { kind: "ready", rows: board as never, prior: null },
      past: { kind: "ready", analyses: [] },
      listRow: undefined,
      result: { kind: "ready", analysis: analysis() },
      replay: { startedId: 7, speed: 4, finishOrder: null },
    });
    const tree = renderScreen(model, noopActions);
    const sec = byClass(tree, "replay")[0]!;
    expect(sec).toBeDefined();
    expect(byClass(sec, "replay-play").map(textOf)).toEqual([REPLAY_AGAIN_LABEL]);
    expect(findAll(sec, (n) => n.tag === "canvas").length).toBe(1);
    expect(byClass(sec, "replay-speed").map((b) => b.attrs?.["aria-pressed"])).toEqual(["false", "false", "true"]);
  });
});
