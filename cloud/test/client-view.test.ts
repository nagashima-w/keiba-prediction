import { describe, expect, it } from "vitest";
import type { AnalysisDetail } from "../client/api-analysis";
import { mount, type DomDocument } from "../client/dom";
import { buildListModel, type ListModelInput } from "../client/list";
import { buildRaceModel, type RaceModelInput, type RunUi } from "../client/race";
import { buildResultModel, type ResultSource } from "../client/result";
import { buildSettingsModel, draftFromSettings } from "../client/settings-form";
import { MARK_LEGEND } from "../../packages/app/src/renderer/format";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { renderScreen, type ViewActions } from "../client/view";
import { h, type VNode } from "../client/vnode";
import { noopActions } from "./client-fakes";

/**
 * Issue #185: レース画面・結果画面の VNode。モデル(純関数。race.test・result.test が検証)→ VNode の写し間違い(出し忘れ・出しすぎ)と、XSS の守り(外から来た文字列はテキストノードだけ。
 * 要素・属性は #184 の許可リストのまま=偽の document に mount して、許可リストに投げられないことを確かめる)。
 * Issue #188: 発走前のカードの中の最新の分析の結果(読み込み中・失敗・開閉の見出し・馬ごとの表示・配分)。旧「結果を見る」のリンクは出さない。
 * Issue #186: 起動のボタン・起動の失敗の注記・追跡の停止の注記(「状態を更新」)・クリック処理の引数が data-* に出ていること(`createMounter` が同じ木の DOM を触らないため)。
 */

const RACE_ID = "202603020211";

function textOf(node: VNode | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join(" ");
}
/** 実 DOM の `textContent` 相当(子の文字列を区切りなしで連結する)。`textOf` は子を空白で結ぶので、要素の間の空白が実 DOM に無くても成立してしまう(Issue #211 で見逃した)。 */
function rawTextOf(node: VNode | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(rawTextOf).join("");
}
function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => (n.attrs?.["class"] ?? "").toString().split(" ").includes(cls));
const hrefs = (tree: VNode): string[] => findAll(tree, (n) => n.tag === "a").map((n) => String(n.attrs?.["href"]));

/** VNode を許可リストつきのアダプタで偽の document に組み立てる(許可リスト外の要素・属性・href があれば投げる)。作った要素のタグと、テキストノードを返す。 */
function mountAll(tree: VNode): { tags: string[]; texts: string[] } {
  const tags: string[] = [];
  const texts: string[] = [];
  const doc: DomDocument = {
    createElement: (tag) => {
      tags.push(tag);
      return { setAttribute() {}, appendChild() {}, addEventListener() {} };
    },
    createTextNode: (text) => {
      texts.push(text);
      return {};
    },
  };
  mount(doc, { replaceChildren() {} }, tree);
  return { tags, texts };
}

const raceInput = (over: Partial<RaceModelInput> = {}): RaceModelInput => ({
  route: { date: "20260628", venue: "central", race: RACE_ID, analysis: null, settings: false },
  status: { kind: "ready", rows: [], prior: null },
  past: { kind: "ready", analyses: [] },
  listRow: undefined,
  ...over,
});

const PRIOR_VIEW = { raceName: "福島民報杯", venueName: "福島", date: "2026-06-28", computedAt: 5000, rows: [{ rank: 1, umaban: 3, horseName: "アルファ", prior: 0.523 }] };
const row = (mode: "morning" | "pre_race", status: "queued" | "fetched" | "done" | "failed", over: Record<string, unknown> = {}) =>
  ({ raceId: RACE_ID, mode, status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null, ...over }) as const;

describe("レース画面の VNode", () => {
  it("見出し・戻るリンク・2 枚のカード(朝の準備・発走前)・過去の分析。ボタンは「更新」と、各カードの起動のボタン(Issue #186。旧版は「更新」だけ)", () => {
    const tree = renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("morning", "done", { prior: true })], prior: null } })), noopActions);
    expect(textOf(tree)).toContain(`レース ${RACE_ID}`);
    expect(hrefs(tree)).toContain("#date=20260628&venue=central");
    const cards = byClass(tree, "card");
    expect(cards).toHaveLength(2);
    expect(textOf(cards[0]!)).toContain("朝の準備");
    expect(textOf(cards[0]!)).toContain("完了");
    expect(textOf(cards[1]!)).toContain("発走前");
    expect(textOf(cards[1]!)).toContain("未実行");
    const buttons = findAll(tree, (n) => n.tag === "button");
    expect(buttons.map(textOf)).toEqual(["更新", "朝の準備をやり直す", "発走前の分析を実行"]);
    expect(textOf(tree)).toContain("過去の分析");
    expect(textOf(tree)).toContain("過去の分析はありません");
  });

  it("朝の prior: 完了なら順位・馬番・馬名・3着内率が出る。馬名が null の馬も行は出る", () => {
    const tree = renderScreen(
      buildRaceModel(
        raceInput({
          status: {
            kind: "ready",
            rows: [row("morning", "done", { prior: true })],
            prior: { raceName: null, venueName: null, date: null, computedAt: 1, rows: [{ rank: 1, umaban: 3, horseName: "アルファ", prior: 0.523 }, { rank: 2, umaban: 1, horseName: null, prior: 0.3 }] },
          },
        }),
      ),
      noopActions,
    );
    const items = byClass(tree, "prior-row");
    expect(items).toHaveLength(2);
    expect(textOf(items[0]!)).toContain("1位");
    expect(textOf(items[0]!)).toContain("3番");
    expect(textOf(items[0]!)).toContain("アルファ");
    expect(textOf(items[0]!)).toContain("3着内率 52.3%");
    expect(textOf(items[1]!)).toContain("2位");
    expect(textOf(items[1]!)).toContain("30.0%");
  });

  it("「結果を見る」のリンクはどの状態でも出ない(Issue #188 で廃止。旧版は発走前の完了で a を出していた)。analysis= のリンクは過去の分析の一覧だけにある", () => {
    const past = { kind: "ready", analyses: [{ id: 12, analyzedAt: "2026-06-28T05:00:00.000Z", evEstimated: false, model: null }] } as const;
    const done = renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("pre_race", "done", { analysisId: 12 })], prior: null }, past, result: { kind: "ready", analysis: analysis({ id: 12 }) } })), noopActions);
    expect(textOf(done)).not.toContain("結果を見る");
    expect(byClass(done, "result-link")).toHaveLength(0);
    // 前提: 完了した発走前のカードには結果が出ている(リンクを消しただけでなく、中身に置き換わっている)
    expect(byClass(byClass(done, "card")[1]!, "horse").length).toBeGreaterThan(0);
    const analysisLinks = hrefs(done).filter((x) => x.includes("analysis="));
    expect(analysisLinks).toEqual(["#date=20260628&venue=central&analysis=12"]);
    expect(byClass(done, "past-link")).toHaveLength(1);
    expect(byClass(byClass(done, "card")[1]!, "past-link")).toHaveLength(0);
  });

  it("失敗したカードは、エラー文(板の error)を出す。状態が失敗でなければ出さない", () => {
    const failed = renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("pre_race", "failed", { error: "ソケット接続に失敗しました" })], prior: null } })), noopActions);
    expect(textOf(byClass(failed, "card")[1]!)).toContain("ソケット接続に失敗しました");
    expect(textOf(byClass(failed, "card")[0]!)).not.toContain("ソケット");
  });

  it("状態の取得に失敗したら、カードを出さず(「未実行」と誤読させない)、注記(role=alert)を出す。過去の分析は出る", () => {
    const tree = renderScreen(
      buildRaceModel(raceInput({ status: { kind: "error", message: "状態を取得できません" }, past: { kind: "ready", analyses: [{ id: 5, analyzedAt: "2026-06-28T05:00:00.000Z", evEstimated: false, model: null }] } })),
      noopActions,
    );
    expect(byClass(tree, "card")).toHaveLength(0);
    const alerts = findAll(tree, (n) => n.attrs?.["role"] === "alert");
    expect(alerts.map(textOf)).toEqual(["状態を取得できません"]);
    expect(hrefs(tree)).toContain("#date=20260628&venue=central&analysis=5");
    expect(textOf(tree)).toContain("2026-06-28 14:00");
  });

  it("過去の分析の取得に失敗しても、カードは出る。取得中は「更新」が disabled", () => {
    const failed = renderScreen(buildRaceModel(raceInput({ past: { kind: "error", message: "一覧を取得できません" } })), noopActions);
    expect(byClass(failed, "card")).toHaveLength(2);
    expect(textOf(failed)).toContain("一覧を取得できません");
    const loading = renderScreen(buildRaceModel(raceInput({ status: { kind: "loading" } })), noopActions);
    const refresh = findAll(loading, (n) => n.tag === "button")[0]!;
    expect(refresh.attrs?.["disabled"]).toBe(true);
    expect(textOf(refresh)).toContain("読み込み中");
  });

  it("「更新」のクリックは onRefresh に繋がる", () => {
    let count = 0;
    const tree = renderScreen(buildRaceModel(raceInput()), { ...noopActions, onRefresh: () => (count += 1) });
    findAll(tree, (n) => n.tag === "button")[0]!.on!.click!();
    expect(count).toBe(1);
  });
});

describe("起動のボタン・注記の VNode(Issue #186)", () => {
  const readyInput = (over: Partial<RaceModelInput> = {}) => raceInput({ status: { kind: "ready", rows: [], prior: null }, ...over });
  const runButtons = (tree: VNode) => byClass(tree, "run");

  it("各カードに起動のボタン(class=run)。文言・disabled はモデルのとおり。開催日・レース・モードを data-* に持つ", () => {
    const tree = renderScreen(buildRaceModel(readyInput({ status: { kind: "ready", rows: [row("pre_race", "queued")], prior: null } })), noopActions);
    const buttons = runButtons(tree);
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => b.tag === "button")).toBe(true);
    expect(buttons.map(textOf)).toEqual(["朝の準備を実行", "待ち"]);
    expect(buttons.map((b) => b.attrs?.["disabled"])).toEqual([false, true]);
    expect(buttons.map((b) => [b.attrs?.["data-date"], b.attrs?.["data-race"], b.attrs?.["data-mode"]])).toEqual([
      ["20260628", RACE_ID, "morning"],
      ["20260628", RACE_ID, "pre_race"],
    ]);
    // カードの中にある(それぞれのカードの子孫)
    const cards = byClass(tree, "card");
    expect(runButtons(cards[0]!)).toHaveLength(1);
    expect(runButtons(cards[1]!)).toHaveLength(1);
  });

  it("クリックは onRun(開催日, レース, モード)に繋がる(data-* と同じ値)", () => {
    const calls: [string, string, string][] = [];
    const actions: ViewActions = { ...noopActions, onRun: (date, raceId, mode) => void calls.push([date, raceId, mode]) };
    const buttons = runButtons(renderScreen(buildRaceModel(readyInput({ route: { date: "20260629", venue: "nar", race: "202654062801", analysis: null, settings: false } })), actions));
    expect(buttons).toHaveLength(2);
    for (const b of buttons) b.on!.click!();
    expect(calls).toEqual([
      ["20260629", "202654062801", "morning"],
      ["20260629", "202654062801", "pre_race"],
    ]);
    // data-* とクリックの引数が一致する
    expect(buttons.map((b) => [b.attrs?.["data-date"], b.attrs?.["data-race"], b.attrs?.["data-mode"]])).toEqual(calls);
  });

  it("状態を取得できていないレース画面(読み込み中・失敗)には、起動のボタンが出ない", () => {
    expect(runButtons(renderScreen(buildRaceModel(raceInput({ status: { kind: "loading" } })), noopActions))).toHaveLength(0);
    expect(runButtons(renderScreen(buildRaceModel(raceInput({ status: { kind: "error", message: "x" } })), noopActions))).toHaveLength(0);
  });

  it("起動の失敗は role=alert の段落、すでに実行中・prior の注記は通常の段落で、そのカードの中に出る。外から来た文字列はテキストノード", () => {
    const evil = `<img src=x onerror=alert(1)>`;
    const runs = new Map<"morning" | "pre_race", RunUi>([
      ["morning", { kind: "already" }],
      ["pre_race", { kind: "error", message: evil }],
    ]);
    const tree = renderScreen(
      buildRaceModel(readyInput({ status: { kind: "ready", rows: [row("morning", "queued")], prior: PRIOR_VIEW, priorNotice: "順位を取得できませんでした" }, runs })),
      noopActions,
    );
    const [morning, preRace] = byClass(tree, "card");
    const alerts = findAll(preRace!, (n) => n.attrs?.["role"] === "alert");
    expect(alerts.map(textOf)).toEqual([evil]);
    expect(findAll(morning!, (n) => n.attrs?.["role"] === "alert")).toHaveLength(0);
    expect(textOf(morning!)).toContain("すでに実行中");
    expect(textOf(preRace!)).not.toContain("すでに実行中");
    // prior の注記は朝のカードにだけ出る
    expect(textOf(preRace!)).not.toContain("順位を取得できませんでした");
    expect(textOf(morning!)).toContain("順位を取得できませんでした");
    expect(() => mountAll(tree)).not.toThrow();
    expect(mountAll(tree).texts.some((t) => t.includes(evil))).toBe(true);
    expect(mountAll(tree).tags.filter((t) => ["img", "script"].includes(t))).toEqual([]);
  });

  it("追跡の停止の注記: 文言と「状態を更新」ボタン(クリックは onRetrack)。一覧・レースの両方に出る。無ければ出ない", () => {
    let count = 0;
    const actions: ViewActions = { ...noopActions, onRetrack: () => (count += 1) };
    const list = renderScreen(buildListModel({ route: { date: "20260628", venue: "central", race: null, analysis: null, settings: false }, list: { kind: "ready", races: [] }, board: { kind: "none" }, tracking: "自動更新を止めました" }), actions);
    const race = renderScreen(buildRaceModel(readyInput({ tracking: "自動更新を止めました" })), actions);
    for (const tree of [list, race]) {
      const boxes = byClass(tree, "tracking");
      expect(boxes).toHaveLength(1);
      expect(textOf(boxes[0]!)).toContain("自動更新を止めました");
      const button = byClass(boxes[0]!, "retrack");
      expect(button).toHaveLength(1);
      expect(textOf(button[0]!)).toBe("状態を更新");
      button[0]!.on!.click!();
    }
    expect(count).toBe(2);
    expect(byClass(renderScreen(buildRaceModel(readyInput()), noopActions), "tracking")).toHaveLength(0);
    expect(byClass(renderScreen(buildListModel({ route: { date: "20260628", venue: "central", race: null, analysis: null, settings: false }, list: { kind: "ready", races: [] }, board: { kind: "none" } }), noopActions), "tracking")).toHaveLength(0);
  });
});

/**
 * **`data-*` の契約(Issue #186 段階1 の【記録】→ 段階2で機械的に固定)**: `createMounter` は JSON が同じ木の DOM を触らない。関数(クリック処理)は JSON にならないので、
 * 木が同じでクリック処理だけが違うと古い処理が残る。そこで「クリック処理に引数を渡すボタン」は、その引数を `data-*` にも出す。
 * 引数を取らない処理(更新・状態を更新・日付の入力〈値はイベントから読む〉)は、許可リスト(class)で除外する。
 */
describe("data-* の契約: 引数を渡すクリック処理は、引数を data-* に出している", () => {
  // Issue #189: 設定の「保存」ボタン(settings-save)も、引数を取らない処理。設定の入力欄は引数(項目名)を data-field に出すので、除外しない。
  // Issue #201: プレビューの「入力中の内容を反映」(preview-refresh)も、引数を取らない処理。開閉のボタン(preview-toggle)は引数(押したあとの状態)を data-open-after に出すので、除外しない。
  // Issue #218: 「重みを既定値に戻す」(weights-reset)も、引数を取らない処理。重みの入力欄は通常の設定の入力欄と同じ部品で、引数(項目名)を data-field に出す。
  const NO_ARGUMENT_CLASSES = new Set(["refresh", "retrack", "settings-save", "preview-refresh", "weights-reset"]);
  const hasDataAttr = (n: VNode): boolean => Object.keys(n.attrs ?? {}).some((k) => k.startsWith("data-"));
  const handlers = (tree: VNode): VNode[] => findAll(tree, (n) => n.on?.click !== undefined || n.on?.change !== undefined || n.on?.input !== undefined);
  const exempt = (n: VNode): boolean => String(n.attrs?.["class"] ?? "").split(" ").some((c) => NO_ARGUMENT_CLASSES.has(c)) || (n.tag === "input" && n.attrs?.["type"] === "date");

  const rr = (raceId: string, venueName: string) => ({ raceId, venueName, raceNumber: 1, raceName: "r", courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: null }) as const;
  const route = { date: "20260628", venue: "central", race: null, analysis: null, settings: false } as const;
  const trees = (): { name: string; tree: VNode }[] => [
    { name: "一覧(場が 2 つ・閉)", tree: renderScreen(buildListModel({ route, list: { kind: "ready", races: [rr("202602010101", "函館"), rr("202603020211", "福島")] }, board: { kind: "none" }, tracking: "止めました" }), noopActions) },
    { name: "レース画面(カード 2 枚・失敗の注記・追跡の注記つき)", tree: renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("morning", "failed")], prior: null }, tracking: "止めました", runs: new Map([["morning", { kind: "error", message: "x" }]]) })), noopActions) },
    { name: "レース画面(発走前の結果が ready。開閉の見出し)", tree: renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("pre_race", "done", { analysisId: 5 })], prior: null }, result: { kind: "ready", analysis: analysis({ id: 5 }) } })), noopActions) },
    { name: "結果画面(失敗の「更新」)", tree: renderScreen(buildResultModel({ route: { ...route, analysis: 5 }, source: { kind: "error", message: "失敗" } }), noopActions) },
    {
      name: "設定画面(取得済み。入力欄 28 個〈既存 15 + 重み 13〉・保存・再読込・重みを既定値に戻す・プレビューを開いた状態の開閉と反映)",
      tree: renderScreen(buildSettingsModel({ load: { kind: "ready", source: "d1" }, draft: draftFromSettings(DEFAULT_CLOUD_SETTINGS), errors: {}, save: { kind: "idle" }, previewOpen: true }), noopActions),
    },
  ];

  it("クリック・変更の処理を持つ要素は、data-* を持つか、引数を取らない許可リスト(更新・状態を更新・日付の入力)のどれか", () => {
    let withData = 0;
    let exemptCount = 0;
    for (const { name, tree } of trees()) {
      expect(handlers(tree).length, `前提: ${name} に処理を持つ要素がある`).toBeGreaterThan(0);
      for (const n of handlers(tree)) {
        if (exempt(n)) {
          exemptCount += 1;
          continue;
        }
        expect(hasDataAttr(n), `${name}: ${n.tag}.${String(n.attrs?.["class"])} に data-* が無い(引数を渡す処理は data-* に出す)`).toBe(true);
        withData += 1;
      }
    }
    // 空振り防止: 場の見出し(2)・起動のボタン(2+2)・結果の開閉の見出し(1)・設定の入力欄(15 + 重み 13 = 28)・プレビューの開閉(1)が data-* の対象として数えられ、除外も使われている(保存・再読込・重みを既定値に戻す・プレビューの反映を含む)
    expect(withData).toBe(7 + 28 + 1);
    expect(exemptCount).toBeGreaterThanOrEqual(4 + 2 + 1 + 1);
  });

  it("対照: 検査は、data-* の無いクリック処理(許可リスト外)を拾える(空振りでない)。data-field の無い設定の入力欄も拾う", () => {
    const bad = h("div", {}, [h("button", { class: "run" }, ["x"], { click: () => {} }), h("button", { class: "refresh" }, ["更新"], { click: () => {} })]);
    const offenders = handlers(bad).filter((n) => !exempt(n) && !hasDataAttr(n));
    expect(offenders.map((n) => n.attrs?.["class"])).toEqual(["run"]);
    const noField = h("div", {}, [h("input", { type: "text" }, [], { change: () => {} }), h("button", { class: "settings-save" }, ["保存"], { click: () => {} })]);
    expect(handlers(noField).filter((n) => !exempt(n) && !hasDataAttr(n)).map((n) => n.tag)).toEqual(["input"]); // 保存ボタンだけが除外される
  });
});

function analysis(over: Partial<AnalysisDetail> = {}): AnalysisDetail {
  return {
    id: 7,
    raceId: RACE_ID,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: "20260628",
    evEstimated: false,
    model: null,
    llmNote: null,
    llmCalls: null,
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス" },
    horses: [
      { umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.25, isPositive: true, mark: "◎", reason: null, highlights: [], concerns: [] },
      { umaban: 2, name: "ブラボー", prior: 0.1, adjustedProb: 0.09, placeOddsMin: null, ev: null, isPositive: false, mark: null, reason: null, highlights: [], concerns: [] },
    ],
    allocation: null,
    detail: "present",
    ...over,
  };
}
const route = { date: "20260628", venue: "central" as const, race: null, analysis: 7, settings: false };
const resultTree = (a: AnalysisDetail) => renderScreen(buildResultModel({ route, source: { kind: "ready", analysis: a } }), noopActions);

describe("結果画面の VNode", () => {
  it("見出し・分析時刻・分析モデル・戻るリンクを出す。モデルが null なら「LLM 未使用(統計のみ)」", () => {
    const tree = resultTree(analysis());
    expect(textOf(tree)).toContain("福島11R テストステークス");
    expect(textOf(tree)).toContain("分析時刻");
    expect(textOf(tree)).toContain("2026-06-28 14:00");
    expect(textOf(tree)).toContain("分析モデル");
    expect(textOf(tree)).toContain("LLM 未使用(統計のみ)");
    expect(hrefs(tree)).toEqual([`#date=20260628&venue=central&race=${RACE_ID}`]);
    expect(textOf(resultTree(analysis({ model: "claude-x" })))).toContain("claude-x");
  });

  it("馬のカード: 3着内率・複勝オッズ下限・EV を出し、EV プラスは強調(class と文字の両方。色だけに頼らない)。プラスでない馬は強調しない", () => {
    const tree = resultTree(analysis());
    const cards = byClass(tree, "horse");
    expect(cards).toHaveLength(2);
    expect(textOf(cards[0]!)).toContain("1");
    expect(textOf(cards[0]!)).toContain("アルファ");
    expect(textOf(cards[0]!)).toContain("3着内率 20.0%");
    expect(textOf(cards[0]!)).toContain("複勝オッズ下限 1.8");
    expect(textOf(cards[0]!)).toContain("EV 1.25");
    expect(textOf(cards[0]!)).toContain("EVプラス");
    expect(byClass(tree, "positive")).toHaveLength(1);
    expect(textOf(cards[1]!)).not.toContain("EVプラス");
    expect(textOf(cards[1]!)).toContain("複勝オッズ下限 -");
  });

  it("印は mark があるときだけ要素を出す(null の馬に印の要素を出さない)。LLM なし(モデル null)なら「AI補正後」は画面のどこにも出ない", () => {
    const tree = resultTree(analysis({ model: null }));
    const marks = byClass(tree, "mark");
    expect(marks.map(textOf)).toEqual(["◎"]);
    expect(textOf(tree)).not.toContain("AI補正後");
    expect(textOf(tree)).not.toContain("18.0%"); // adjustedProb(0.18。prior の 0.2 と違う値)は、LLM なしでは出さない
  });

  it("detail の注記: present では出さず、missing・none では注記を出す", () => {
    const present = textOf(resultTree(analysis()));
    expect(present).not.toContain("取得できませんでした");
    expect(present).not.toContain("保存されていません");
    expect(textOf(resultTree(analysis({ detail: "missing" })))).toContain("取得できませんでした");
    expect(textOf(resultTree(analysis({ detail: "none" })))).toContain("保存されていません");
  });

  it("配分: 注記・買い目・実効設定を出す。null は専用の文言", () => {
    const allocation = {
      route: "mixed", unavailableReason: null, fallbackReason: null, skipReasonCode: null, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1.1,
      includeComboOdds: true, includeWide: true, includeTrio: false, includeQuinella: null, includeExacta: true, includeTrifecta: false, includeBracketQuinella: null, betUnit: 100, oddsStatus: "result",
      bets: [{ betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 }],
    };
    const tree = resultTree(analysis({ allocation }));
    expect(textOf(tree)).toContain("配分の提案");
    const bets = byClass(tree, "bet");
    expect(bets).toHaveLength(1);
    expect(textOf(bets[0]!)).toContain("複勝");
    expect(textOf(bets[0]!)).toContain("300円");
    expect(textOf(tree)).toContain("総資金: 10,000円");
    const none = resultTree(analysis({ allocation: null }));
    expect(textOf(none)).toContain("配分の記録がありません");
    expect(byClass(none, "bet")).toHaveLength(0);
  });

  it("読み込み中は文言、失敗は role=alert と「更新」ボタン(再取得の手段)。内容がある(成功の)画面には「更新」を出さない(R2 の操作回数を無駄に使わない)", () => {
    const loading = renderScreen(buildResultModel({ route, source: { kind: "loading" } }), noopActions);
    expect(textOf(loading)).toContain("読み込み中");
    expect(findAll(loading, (n) => n.tag === "button")).toHaveLength(0);
    let count = 0;
    const failed = renderScreen(buildResultModel({ route, source: { kind: "error", message: "取得できません" } }), { ...noopActions, onRefresh: () => (count += 1) });
    expect(findAll(failed, (n) => n.attrs?.["role"] === "alert").map(textOf)).toEqual(["取得できません"]);
    const buttons = findAll(failed, (n) => n.tag === "button");
    expect(buttons.map(textOf)).toEqual(["更新"]);
    buttons[0]!.on!.click!();
    expect(count).toBe(1);
    expect(findAll(resultTree(analysis()), (n) => n.tag === "button")).toHaveLength(0);
  });
});

/** Issue #188: 発走前のカードの中の結果。馬ごと・配分の表示は結果画面と共通(`resultSections`)。読み込み中・失敗は開閉に関係なく常に出す。 */
describe("発走前のカードの結果(Issue #188)", () => {
  const ALLOCATION = {
    route: "mixed", unavailableReason: null, fallbackReason: null, skipReasonCode: null, bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1.1,
    includeComboOdds: true, includeWide: true, includeTrio: false, includeQuinella: null, includeExacta: true, includeTrifecta: false, includeBracketQuinella: null, betUnit: 100, oddsStatus: "result",
    bets: [{ betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 }],
  };
  const doneRows = { kind: "ready", rows: [row("morning", "done", { prior: true }), row("pre_race", "done", { analysisId: 7 })], prior: null } as const;
  const raceTree = (result: ResultSource | undefined, extra: Partial<RaceModelInput> = {}, actions: ViewActions = noopActions) =>
    renderScreen(buildRaceModel(raceInput({ status: doneRows, ...(result === undefined ? {} : { result }), ...extra })), actions);
  const preRaceCard = (tree: VNode): VNode => byClass(tree, "card")[1]!;
  const ready = (a: AnalysisDetail): ResultSource => ({ kind: "ready", analysis: a });

  it("読み込み中は発走前のカードに「読み込み中…」。馬のカードも開閉の見出しも出さない。朝のカードには何も出ない", () => {
    const tree = raceTree({ kind: "loading" });
    expect(textOf(preRaceCard(tree))).toContain("読み込み中…");
    expect(byClass(preRaceCard(tree), "horse")).toHaveLength(0);
    expect(byClass(tree, "result-toggle")).toHaveLength(0);
    expect(byClass(byClass(tree, "card")[0]!, "card-result")).toHaveLength(0);
    expect(textOf(byClass(tree, "card")[0]!)).not.toContain("読み込み中");
  });

  it("失敗は、固定の文言(role=alert)と「更新」での再取得の案内。馬のカードは出さない。開閉の見出しも出さない(失敗を畳みで隠さない)", () => {
    const tree = raceTree({ kind: "error", message: "分析の結果を取得できませんでした" });
    const alerts = findAll(preRaceCard(tree), (n) => n.attrs?.["role"] === "alert");
    expect(alerts).toHaveLength(1);
    expect(textOf(alerts[0]!)).toContain("分析の結果を取得できませんでした");
    expect(textOf(alerts[0]!)).toContain("更新");
    expect(byClass(preRaceCard(tree), "horse")).toHaveLength(0);
    expect(byClass(tree, "result-toggle")).toHaveLength(0);
  });

  it("取得できたら、開閉の見出し(h3 の中のボタン。aria-expanded=true・▾・data-date・data-race)の下に、分析時刻・分析モデル・馬のカード・配分を出す", () => {
    const tree = raceTree(ready(analysis({ id: 7, allocation: ALLOCATION })));
    const card = preRaceCard(tree);
    const toggles = byClass(card, "result-toggle");
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.tag).toBe("button");
    expect(toggles[0]!.attrs?.["aria-expanded"]).toBe("true");
    expect(toggles[0]!.attrs?.["data-date"]).toBe("20260628");
    expect(toggles[0]!.attrs?.["data-race"]).toBe(RACE_ID);
    expect(textOf(toggles[0]!)).toContain("▾");
    expect(findAll(card, (n) => n.tag === "h3" && byClass(n, "result-toggle").length === 1)).toHaveLength(1);
    expect(textOf(card)).toContain("分析時刻: 2026-06-28 14:00");
    expect(textOf(card)).toContain("分析モデル: LLM 未使用(統計のみ)");
    const horses = byClass(card, "horse");
    expect(horses).toHaveLength(2);
    expect(textOf(horses[0]!)).toContain("アルファ");
    expect(textOf(horses[0]!)).toContain("3着内率 20.0%");
    expect(textOf(horses[0]!)).toContain("複勝オッズ下限 1.8");
    expect(textOf(horses[0]!)).toContain("EV 1.25");
    expect(textOf(horses[0]!)).toContain("EVプラス");
    expect(byClass(card, "positive")).toHaveLength(1);
    expect(byClass(card, "mark").map(textOf)).toEqual(["◎"]);
    expect(textOf(card)).not.toContain("AI補正後");
    expect(byClass(card, "bet")).toHaveLength(1);
    expect(textOf(card)).toContain("配分の提案");
    // 朝のカードには出ない
    expect(byClass(byClass(tree, "card")[0]!, "horse")).toHaveLength(0);
  });

  it("結果は起動のボタンの前(朝のカードの prior と同じ並び)。結果の画面へのリンクは無い", () => {
    const card = preRaceCard(raceTree(ready(analysis({ id: 7 }))));
    const kids = card.children ?? [];
    const indexOf = (cls: string) => kids.findIndex((k) => typeof k !== "string" && (k.attrs?.["class"] ?? "").toString().split(" ").includes(cls));
    expect(indexOf("card-result")).toBeGreaterThan(-1);
    expect(indexOf("run")).toBeGreaterThan(-1);
    expect(indexOf("card-result")).toBeLessThan(indexOf("run"));
    expect(byClass(card, "result-link")).toHaveLength(0);
    expect(findAll(card, (n) => n.tag === "a")).toHaveLength(0);
  });

  it("畳んだとき(resultOpen: false): 見出しは残り aria-expanded=false・▸。馬のカード・配分・分析時刻は描画しない(描画と状態が一致する)", () => {
    const tree = raceTree(ready(analysis({ id: 7, allocation: ALLOCATION })), { resultOpen: false });
    const card = preRaceCard(tree);
    const toggles = byClass(card, "result-toggle");
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.attrs?.["aria-expanded"]).toBe("false");
    expect(textOf(toggles[0]!)).toContain("▸");
    expect(textOf(toggles[0]!)).not.toContain("▾");
    expect(byClass(card, "horse")).toHaveLength(0);
    expect(byClass(card, "bet")).toHaveLength(0);
    expect(textOf(card)).not.toContain("分析時刻");
    expect(textOf(card)).not.toContain("配分の提案");
  });

  it("開閉のクリックは onToggleResult(開催日, レース, 押したあとの状態)に繋がる。開いているときは false、畳んでいるときは true(引数は data-* と同じ値)", () => {
    const calls: [string, string, boolean][] = [];
    const actions: ViewActions = { ...noopActions, onToggleResult: (date, raceId, open) => void calls.push([date, raceId, open]) };
    for (const resultOpen of [true, false]) {
      const toggle = byClass(raceTree(ready(analysis({ id: 7 })), { resultOpen }, actions), "result-toggle")[0]!;
      toggle.on!.click!();
      expect([toggle.attrs?.["data-date"], toggle.attrs?.["data-race"]]).toEqual(["20260628", RACE_ID]);
    }
    expect(calls).toEqual([
      ["20260628", RACE_ID, false],
      ["20260628", RACE_ID, true],
    ]);
  });

  it("同じ見出し・別のレース(または別の日)は、data-* が違うので木が違う(同じ木なら DOM を触らない描画で、開閉の取り違えを隠さない)", () => {
    const a = JSON.stringify(raceTree(ready(analysis({ id: 7 }))));
    const otherRace = JSON.stringify(
      renderScreen(buildRaceModel({ ...raceInput({ status: { kind: "ready", rows: [{ ...row("pre_race", "done", { analysisId: 7 }), raceId: "202603020212" }], prior: null }, result: ready(analysis({ id: 7 })) }), route: { date: "20260628", venue: "central", race: "202603020212", analysis: null, settings: false } }), noopActions),
    );
    const otherDate = JSON.stringify(
      renderScreen(buildRaceModel({ ...raceInput({ status: doneRows, result: ready(analysis({ id: 7 })) }), route: { date: "20260629", venue: "central", race: RACE_ID, analysis: null, settings: false } }), noopActions),
    );
    expect(a).not.toBe(otherRace);
    expect(a).not.toBe(otherDate);
    expect(otherRace).toContain('"data-race":"202603020212"');
    expect(otherDate).toContain('"data-date":"20260629"');
  });

  it("馬のカード・配分の部分は結果画面と同じ木(共通の `resultSections`。見出しの h2/h3 の違いだけ)。detail の注記・配分なしの注記も同じ", () => {
    const strip = (n: VNode | string): unknown => (typeof n === "string" ? n : { ...n, tag: n.tag === "h2" || n.tag === "h3" ? "h" : n.tag, children: (n.children ?? []).map(strip), on: undefined });
    for (const a of [analysis({ id: 7, allocation: ALLOCATION }), analysis({ id: 7, allocation: null, detail: "missing" }), analysis({ id: 7, evEstimated: true, detail: "none" })]) {
      const screen = resultTree(a);
      const card = preRaceCard(raceTree(ready(a)));
      for (const cls of ["horses", "allocation"]) {
        const inScreen = byClass(screen, cls);
        const inCard = byClass(card, cls);
        expect(inScreen, `前提: 結果画面に ${cls}`).toHaveLength(1);
        expect(inCard, `前提: カードに ${cls}`).toHaveLength(1);
        expect(strip(inCard[0]!)).toEqual(strip(inScreen[0]!));
      }
      // 注記(detail)もカードに出る(結果画面と同じ文)
      const screenNotices = byClass(screen, "notice").map(textOf);
      for (const n of screenNotices) {
        expect(textOf(card)).toContain(n);
      }
    }
    // 対照: detail の注記が実際に出る分析が、上の分析の中にある(空振りでない)
    expect(textOf(preRaceCard(raceTree(ready(analysis({ id: 7, detail: "missing" })))))).toContain("取得できませんでした");
    expect(textOf(preRaceCard(raceTree(ready(analysis({ id: 7, detail: "none" })))))).toContain("保存されていません");
  });

  it("カードの結果の見出し(h3)は、カードの見出し(h2)の下。結果画面の見出し(h2)の階層は変えない", () => {
    const card = preRaceCard(raceTree(ready(analysis({ id: 7 }))));
    expect(findAll(card, (n) => n.tag === "h2").map(textOf)).toEqual(["発走前"]);
    expect(findAll(card, (n) => n.tag === "h3").map(textOf)).toEqual(["▾ 分析の結果", "印の付いた馬", "馬ごとの評価", "配分の提案(分析時点)"]); // 開閉・印の付いた馬(#211)・馬ごとの評価・配分の提案
    const screen = resultTree(analysis());
    expect(findAll(screen, (n) => n.tag === "h2").map(textOf)).toEqual(["印の付いた馬", "馬ごとの評価", "配分の提案(分析時点)"]); // Issue #211: 既定の分析は印「◎」の馬がいる
  });
});

describe("XSS: 馬名・レース名・エラー文・モデル名・注記の悪意のある文字列は、テキストノードだけになる(許可リストのアダプタを通る)", () => {
  const PAYLOAD = `<img src=x onerror=alert(1)>"><script>alert(2)</script>`;

  it("レース画面(エラー文・prior の馬名・レース名)", () => {
    const tree = renderScreen(
      buildRaceModel(
        raceInput({
          status: {
            kind: "ready",
            rows: [row("morning", "done", { prior: true }), row("pre_race", "failed", { error: PAYLOAD })],
            prior: { raceName: PAYLOAD, venueName: PAYLOAD, date: null, computedAt: 1, rows: [{ rank: 1, umaban: 1, horseName: PAYLOAD, prior: 0.5 }] },
          },
        }),
      ),
      noopActions,
    );
    const { tags, texts } = mountAll(tree);
    expect(tags.filter((t) => ["img", "script", "svg", "iframe", "style"].includes(t))).toEqual([]);
    expect(texts.filter((t) => t.includes("<img")).length).toBeGreaterThanOrEqual(3); // 悪意の文字列は、そのまま(解釈されず)テキストに入っている
  });

  it("レース画面の発走前のカードの結果(馬名・印・モデル名)", () => {
    const a = analysis({
      id: 7,
      model: PAYLOAD,
      horses: [{ umaban: 1, name: PAYLOAD, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.2, isPositive: true, mark: PAYLOAD, reason: PAYLOAD, highlights: [], concerns: [] }],
    });
    const tree = renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("pre_race", "done", { analysisId: 7 })], prior: null }, result: { kind: "ready", analysis: a } })), noopActions);
    expect(byClass(tree, "horse")).toHaveLength(1); // 前提: カードの中に馬が出ている
    const { tags, texts } = mountAll(tree);
    expect(tags.filter((t) => ["img", "script", "svg", "iframe", "style"].includes(t))).toEqual([]);
    expect(texts.filter((t) => t.includes("<img")).length).toBeGreaterThanOrEqual(3); // 馬名・印・モデル名
  });

  it("結果画面(馬名・レース名・モデル名・印)", () => {
    const a = analysis({
      model: PAYLOAD,
      race: { venueName: PAYLOAD, raceNumber: 11, raceName: PAYLOAD },
      horses: [{ umaban: 1, name: PAYLOAD, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.2, isPositive: true, mark: PAYLOAD, reason: PAYLOAD, highlights: [], concerns: [] }],
    });
    const { tags, texts } = mountAll(resultTree(a));
    expect(tags.filter((t) => ["img", "script", "svg", "iframe", "style"].includes(t))).toEqual([]);
    expect(texts.filter((t) => t.includes("<img")).length).toBeGreaterThanOrEqual(4);
  });

  it("href は # で始まるハッシュだけ(レース画面・結果画面のすべてのリンクが、許可リストを通る)", () => {
    const race = renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("pre_race", "done", { analysisId: 3 })], prior: null }, past: { kind: "ready", analyses: [{ id: 1, analyzedAt: "2026-06-28T05:00:00Z", evEstimated: false, model: null }] } })), noopActions);
    for (const href of [...hrefs(race), ...hrefs(resultTree(analysis()))]) {
      expect(href.startsWith("#"), href).toBe(true);
    }
    // 戻る・過去の分析(Issue #188 で、発走前の完了のリンク「結果を見る」を廃止したぶん 1 つ減った)
    expect(hrefs(race).length).toBeGreaterThanOrEqual(2);
    expect(() => mountAll(race)).not.toThrow();
    expect(() => mountAll(resultTree(analysis()))).not.toThrow();
  });
});

/** Issue #187: 一覧の場ごとの見出し(開閉のボタン)。開閉・aria-expanded・要約の表示と、閉じた場の行を描画しないこと。 */
describe("一覧の場の見出し(開閉ボタン)", () => {
  const rr = (raceId: string, venueName: string, over: Record<string, unknown> = {}) =>
    ({ raceId, venueName, raceNumber: Number(raceId.slice(-2)), raceName: `レース${raceId.slice(-2)}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, startTime: null, ...over }) as const;
  const FUKU = [rr("202603020211", "福島"), rr("202603020212", "福島")];
  const HAKO = [rr("202602010101", "函館"), rr("202602010102", "函館")];
  const brow = (raceId: string, mode: "morning" | "pre_race", status: "queued" | "fetched" | "done" | "failed") =>
    ({ raceId, mode, status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null }) as const;
  const listInput = (over: Partial<ListModelInput> = {}): ListModelInput => ({
    route: { date: "20260628", venue: "central", race: null, analysis: null, settings: false },
    list: { kind: "ready", races: [...FUKU, ...HAKO] },
    board: { kind: "none" },
    ...over,
  });
  const toggles = (tree: VNode): VNode[] => byClass(tree, "venue-toggle");
  const raceLinks = (tree: VNode): VNode[] => byClass(tree, "race");

  it("見出しは h2 の中のボタン。aria-expanded は開閉の実際の状態と一致し、開閉が文字(▾/▸)でも分かる", () => {
    const keysAll = buildListModel(listInput()).groups.map((g) => g.key);
    const tree = renderScreen(buildListModel(listInput({ choices: new Map([[keysAll[1]!, true]]) })), noopActions);
    const buttons = toggles(tree);
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => b.tag === "button")).toBe(true);
    // 函館(閉)・福島(開)の順
    expect(buttons.map((b) => b.attrs?.["aria-expanded"])).toEqual(["false", "true"]);
    expect(textOf(buttons[0]!)).toContain("▸");
    expect(textOf(buttons[0]!)).not.toContain("▾");
    expect(textOf(buttons[1]!)).toContain("▾");
    expect(textOf(buttons[1]!)).not.toContain("▸");
    // 見出し(h2)の中にある
    const headings = findAll(tree, (n) => n.tag === "h2" && byClass(n, "venue-toggle").length === 1);
    expect(headings).toHaveLength(2);
  });

  it("Issue #236: 開いた場の行に、発走予定時刻が見える。時刻なしの行には出ない", () => {
    const races = [rr("202603020211", "福島", { startTime: "15:40" }), rr("202603020212", "福島", { startTime: null })];
    const tree = renderScreen(buildListModel(listInput({ list: { kind: "ready", races } })), noopActions);
    const links = raceLinks(tree);
    expect(links).toHaveLength(2); // 前提: 場が 1 つなので開いている
    expect(textOf(links[0]!)).toContain("15:40 発走・芝 1800m・16頭");
    expect(textOf(links[1]!)).toContain("芝 1800m・16頭");
    expect(textOf(links[1]!)).not.toContain("発走");
  });

  it("閉じた場のレースの行(a.race と ul.races)は描画しない。開いた場の行だけが出る", () => {
    const keys = buildListModel(listInput()).groups.map((g) => g.key);
    const allClosed = renderScreen(buildListModel(listInput()), noopActions);
    expect(raceLinks(allClosed)).toHaveLength(0);
    expect(byClass(allClosed, "races")).toHaveLength(0);
    const oneOpen = renderScreen(buildListModel(listInput({ choices: new Map([[keys[1]!, true]]) })), noopActions);
    expect(raceLinks(oneOpen)).toHaveLength(2);
    expect(raceLinks(oneOpen).map((a) => a.attrs?.["href"])).toEqual(["#date=20260628&venue=central&race=202603020211", "#date=20260628&venue=central&race=202603020212"]);
    expect(byClass(oneOpen, "races")).toHaveLength(1);
  });

  // Issue #186(ユーザーの依頼 2026-10-07): 見出しからレース数(`12R`)を外した。旧版の「場名・レース数が出る」(`toContain("2R")`)は意図して置き換える。
  it("見出しの文字は「▸/▾ 場名」だけ(板が無いとき)。レース数(数字+R)は出さない。閉じていても場名は出る", () => {
    const tree = renderScreen(buildListModel(listInput()), noopActions);
    // 前提: 函館・福島の 2 つの見出し(どちらもレースが 2 つある=旧版ならどちらも「2R」が付いた)
    expect(toggles(tree)).toHaveLength(2);
    expect(toggles(tree).map(textOf)).toEqual(["▸ 函館", "▸ 福島"]);
    const keys = buildListModel(listInput()).groups.map((g) => g.key);
    const open = renderScreen(buildListModel(listInput({ choices: new Map([[keys[1]!, true]]) })), noopActions);
    expect(toggles(open).map(textOf)).toEqual(["▸ 函館", "▾ 福島"]);
    for (const text of [...toggles(tree), ...toggles(open)].map(textOf)) {
      expect(text).not.toMatch(/[0-9]+R/);
    }
  });

  it("要約があっても、見出しは「▸ 場名・実行中 n・失敗 m」(数字+R を挟まない。0 の項目は出さない)", () => {
    const board = [brow("202603020211", "morning", "queued"), brow("202603020212", "pre_race", "fetched"), brow("202603020212", "morning", "failed"), brow("202602010101", "morning", "done")];
    const closed = toggles(renderScreen(buildListModel(listInput({ board: { kind: "ready", rows: board } })), noopActions)).map(textOf);
    expect(closed).toEqual(["▸ 函館", "▸ 福島・実行中 2・失敗 1"]);
    const only = (rows: ReturnType<typeof brow>[]) => toggles(renderScreen(buildListModel(listInput({ board: { kind: "ready", rows } })), noopActions)).map(textOf)[1];
    expect(only([brow("202603020211", "morning", "failed")])).toBe("▸ 福島・失敗 1");
    expect(only([brow("202603020211", "morning", "queued")])).toBe("▸ 福島・実行中 1");
    for (const text of closed) {
      expect(text).not.toMatch(/[0-9]+R/);
    }
  });

  it("要約: 実行中・失敗の数を見出しに出す。0 の項目は出さない。板が無ければ要約を出さない", () => {
    const board = [brow("202603020211", "morning", "queued"), brow("202603020212", "pre_race", "fetched"), brow("202603020212", "morning", "failed"), brow("202602010101", "morning", "done")];
    const tree = renderScreen(buildListModel(listInput({ board: { kind: "ready", rows: board } })), noopActions);
    const [hako, fuku] = toggles(tree).map(textOf);
    // 函館: 完了だけ → 実行中・失敗とも 0 で、どちらの語も出ない
    expect(hako).not.toContain("実行中");
    expect(hako).not.toContain("失敗");
    // 福島: 2 レースとも実行中(1 つは失敗も)。失敗 1
    expect(fuku).toContain("実行中 2");
    expect(fuku).toContain("失敗 1");
    const noBoard = toggles(renderScreen(buildListModel(listInput()), noopActions)).map(textOf);
    expect(noBoard.join(" ")).not.toContain("実行中");
    expect(noBoard.join(" ")).not.toContain("失敗");
  });

  it("失敗だけ・実行中だけのとき、出すのはその語だけ", () => {
    const failedOnly = toggles(renderScreen(buildListModel(listInput({ board: { kind: "ready", rows: [brow("202603020211", "morning", "failed")] } })), noopActions)).map(textOf);
    expect(failedOnly[1]).toContain("失敗 1");
    expect(failedOnly[1]).not.toContain("実行中");
    const runningOnly = toggles(renderScreen(buildListModel(listInput({ board: { kind: "ready", rows: [brow("202603020211", "morning", "queued")] } })), noopActions)).map(textOf);
    expect(runningOnly[1]).toContain("実行中 1");
    expect(runningOnly[1]).not.toContain("失敗");
  });

  // Issue #186 段階1: 「同じ木なら DOM を触らない」(createMounter)では、JSON にならない関数(クリック処理)が古いまま残りうる。
  // そこで、クリック処理に渡す引数は必ず data-* にも出す(= 引数が違えば木が違う)。
  it("見出しのボタンは、クリックで onToggleGroup に渡すキーと同じ値を data-key に持つ(同じ木なら DOM を触らない描画で、古い処理が残らないため)", () => {
    const calls: string[] = [];
    const actions: ViewActions = { ...noopActions, onToggleGroup: (key) => void calls.push(key) };
    const model = buildListModel(listInput());
    const buttons = toggles(renderScreen(model, actions));
    expect(buttons).toHaveLength(2); // 前提: 2 つの見出し
    expect(model.groups.map((g) => g.key)).toEqual(["函館#0", "福島#0"]); // 前提: キーは「場名#出現順」(値そのものを固定)
    for (const b of buttons) {
      b.on!.click!();
    }
    expect(calls).toHaveLength(2);
    expect(buttons.map((b) => b.attrs?.["data-key"])).toEqual(calls);
  });

  it("同じ場名が離れて 2 組できても(見出しの文字は同じ)、data-key が違うので木が違う(開閉の取り違えを、描画のスキップに隠さない)", () => {
    const rows = [rr("202601010101", "福島"), rr("202602010101", "函館"), rr("202603010101", "福島")];
    const model = buildListModel(listInput({ list: { kind: "ready", races: rows } }));
    expect(model.groups.map((g) => g.name)).toEqual(["福島", "函館", "福島"]); // 前提: 離れた同名が 2 組
    const tree = renderScreen(model, noopActions);
    const texts = toggles(tree).map(textOf);
    expect(texts[0]).toBe(texts[2]); // 前提: 見出しの文字は同じ
    const dataKeys = toggles(tree).map((b) => b.attrs?.["data-key"]);
    expect(new Set(dataKeys).size).toBe(3);
    // 「文字が同じ 2 つのボタン」の木は、data-key の違いだけで JSON が異なる
    const [a, , c] = toggles(tree);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  // Issue #186 段階1(#184 の【記録】1・3): 板の取得中は「更新」を押せない/板だけが失敗したら、そのことが分かる注記を出す。
  it("板だけを取得中(一覧は取得済み)でも「更新」は disabled で「読み込み中…」。取得中でなければ押せる", () => {
    const refresh = (tree: VNode) => findAll(tree, (n) => n.tag === "button" && n.attrs?.["class"] === "refresh")[0]!;
    const idle = refresh(renderScreen(buildListModel(listInput()), noopActions));
    expect(textOf(idle)).toBe("更新"); // 前提: 取得中でなければ「更新」で押せる
    expect(idle.attrs?.["disabled"]).toBe(false);
    const boardLoading = refresh(renderScreen(buildListModel(listInput({ boardLoading: true })), noopActions));
    expect(textOf(boardLoading)).toBe("読み込み中…");
    expect(boardLoading.attrs?.["disabled"]).toBe(true);
  });

  it("板の取得に失敗したときは、「実行状態(バッジ)を取得できない」ことを示す注記が出る。一覧のレースは出たまま。板が取れているときは出ない", () => {
    const notices = (tree: VNode) => byClass(tree, "notice").map(textOf);
    const failed = renderScreen(buildListModel(listInput({ board: { kind: "error", message: "通信に失敗しました。" } })), noopActions);
    expect(raceLinks(failed)).toHaveLength(0); // 既定は全部閉(前提: 一覧は描画されている=見出しが 2 つある)
    expect(toggles(failed)).toHaveLength(2);
    expect(notices(failed)).toHaveLength(1);
    expect(notices(failed)[0]).toContain("実行状態");
    expect(notices(failed)[0]).toContain("通信に失敗しました。");
    expect(notices(renderScreen(buildListModel(listInput({ board: { kind: "ready", rows: [] } })), noopActions))).toEqual([]);
    expect(notices(renderScreen(buildListModel(listInput()), noopActions))).toEqual([]);
  });

  it("タップは onToggleGroup(その場のキー, 反転した次の値)に繋がる(閉→開・開→閉)", () => {
    const calls: [string, boolean][] = [];
    const actions: ViewActions = { ...noopActions, onToggleGroup: (key, open) => void calls.push([key, open]) };
    const model = buildListModel(listInput());
    const closed = renderScreen(model, actions);
    toggles(closed)[1]!.on!.click!();
    expect(calls).toEqual([[model.groups[1]!.key, true]]);
    const open = renderScreen(buildListModel(listInput({ choices: new Map([[model.groups[0]!.key, true]]) })), actions);
    toggles(open)[0]!.on!.click!();
    expect(calls[1]).toEqual([model.groups[0]!.key, false]);
  });

  it("外から来た会場名は、見出しのボタンの中でもテキストノードだけ(許可リストの要素・属性で組み立てられる)", () => {
    const evil = `<img src=x onerror=alert(1)>`;
    const tree = renderScreen(buildListModel(listInput({ list: { kind: "ready", races: [rr("202603020211", evil), rr("202602010101", "函館")] } })), noopActions);
    const { tags, texts } = mountAll(tree);
    expect(tags.filter((t) => ["img", "script", "iframe", "style", "details", "summary"].includes(t))).toEqual([]);
    expect(texts.some((t) => t.includes(evil))).toBe(true);
    expect(tags).toContain("button");
  });
});

/**
 * Issue #191: カードの説明の VNode。各カードに `p.card-desc` が1つ。子は文字列1つ(アダプタがテキストノードにする=HTML として解釈されない)。
 */
describe("カードの説明の VNode(Issue #191)", () => {
  const sections = (tree: VNode): VNode[] => findAll(tree, (n) => n.tag === "section" && String(n.attrs?.["class"]) === "card");

  const cases: readonly [string, Parameters<typeof raceInput>[0]][] = [
    ["未実行", {}],
    ["実行中・失敗の注記つき", { status: { kind: "ready", rows: [row("morning", "failed", { error: "取得失敗" }), row("pre_race", "queued")], prior: null }, runs: new Map([["morning", { kind: "error", message: "x" }]]) }],
    ["発走前の結果つき", { status: { kind: "ready", rows: [row("pre_race", "done", { analysisId: 5 })], prior: null }, result: { kind: "ready", analysis: analysis({ id: 5 }) } }],
  ];
  for (const [name, over] of cases) {
    it(`${name}: カードごとに p.card-desc が1つあり、子はテキスト(文字列)1つだけ`, () => {
      const tree = renderScreen(buildRaceModel(raceInput(over)), noopActions);
      const cardNodes = sections(tree);
      expect(cardNodes, "前提: カードが 2 枚").toHaveLength(2);
      for (const card of cardNodes) {
        const descs = byClass(card, "card-desc");
        expect(descs).toHaveLength(1);
        expect(descs[0]!.tag).toBe("p");
        expect(descs[0]!.children).toHaveLength(1);
        expect(typeof descs[0]!.children![0]).toBe("string");
        expect((descs[0]!.children![0] as string).length).toBeGreaterThan(0);
      }
      // 朝のカードと発走前のカードで、説明が違う(取り違えない)
      const texts = cardNodes.map((c) => textOf(byClass(c, "card-desc")[0]!));
      expect(texts[0]).not.toBe(texts[1]);
    });
  }

  it("画面に出る説明の取り違えを検出する: 見出し「朝の準備」のカードの説明は戦績に、「発走前」のカードの説明は LLM に触れる(逆に引くと赤)", () => {
    const tree = renderScreen(buildRaceModel(raceInput()), noopActions);
    const byTitle = (title: string): VNode => sections(tree).find((c) => (c.children ?? []).some((k) => typeof k !== "string" && k.tag === "h2" && textOf(k) === title))!;
    const morning = textOf(byClass(byTitle("朝の準備"), "card-desc")[0]!);
    const preRace = textOf(byClass(byTitle("発走前"), "card-desc")[0]!);
    expect(morning).toContain("戦績");
    expect(morning).not.toContain("LLM");
    expect(preRace).toContain("LLM");
    expect(preRace).not.toContain("戦績");
  });

  it("説明は見出し(h2)の後・起動のボタンの前に出る(カードの中の並び)", () => {
    const tree = renderScreen(buildRaceModel(raceInput()), noopActions);
    for (const card of sections(tree)) {
      const kids = card.children ?? [];
      const at = (pred: (n: VNode) => boolean) => kids.findIndex((k) => typeof k !== "string" && pred(k));
      const h2 = at((n) => n.tag === "h2");
      const desc = at((n) => String(n.attrs?.["class"]) === "card-desc");
      const button = at((n) => n.tag === "button");
      expect(h2).toBeGreaterThanOrEqual(0);
      expect(desc).toBeGreaterThan(h2);
      expect(button).toBeGreaterThan(desc);
    }
  });

  it("状態を取得できていないときは、カードも説明も出ない", () => {
    expect(byClass(renderScreen(buildRaceModel(raceInput({ status: { kind: "loading" } })), noopActions), "card-desc")).toHaveLength(0);
  });
});

/**
 * Issue #195: LLM の結果の表示。結果画面(`#analysis=<id>`)と発走前のカードの中(`resultSections` を共有)の**両方**で同じ表示になること。
 * 補正後の3着内率・根拠は LLM が効いたとき(モデル ID があるとき)だけ。理由(`llmNote`)はモデルの有無に関係なく、null でなければ出す。
 */
describe("LLM の結果の表示(Issue #195。結果画面とカードの中の両方)", () => {
  const NO_KEY = "LLM の API キーが未登録のため、LLM を使わず統計のみで分析しました";
  const MARKS = "印の制約違反のため、印は付けていません(3着内率の補正は反映しています)";
  const llmHorses: AnalysisDetail["horses"] = [
    { umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.25, placeOddsMin: 1.8, ev: 1.35, isPositive: true, mark: "◎", reason: "調教の動きが良い", highlights: [], concerns: [] },
    { umaban: 2, name: "ブラボー", prior: 0.1, adjustedProb: 0.09, placeOddsMin: 3, ev: 0.27, isPositive: false, mark: null, reason: null, highlights: [], concerns: [] },
  ];
  const noLlmHorses: AnalysisDetail["horses"] = [
    { umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 0.36, isPositive: false, mark: null, reason: null, highlights: [], concerns: [] },
  ];
  const cardTree = (a: AnalysisDetail): VNode => {
    const rows = [row("morning", "done", { prior: true }), row("pre_race", "done", { analysisId: 7 })];
    return renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows, prior: null }, result: { kind: "ready", analysis: a } })), noopActions);
  };
  const screens: readonly [string, (a: AnalysisDetail) => VNode][] = [
    ["結果画面", resultTree],
    ["発走前のカードの中", cardTree],
  ];

  for (const [name, tree] of screens) {
    describe(name, () => {
      it("LLM が効いたとき: 馬のカードに「3着内率」と「AI補正後」の両方と、根拠の行(根拠のある馬だけ)。モデル ID を出す", () => {
        const t = tree(analysis({ model: "claude-sonnet-x", horses: llmHorses }));
        const cards = byClass(t, "horse");
        expect(cards).toHaveLength(2);
        expect(textOf(cards[0]!)).toContain("3着内率 20.0%");
        expect(textOf(cards[0]!)).toContain("AI補正後 25.0%");
        expect(byClass(cards[0]!, "horse-reason").map(textOf)).toEqual(["根拠 調教の動きが良い"]);
        expect(textOf(cards[1]!)).toContain("3着内率 10.0%");
        expect(textOf(cards[1]!)).toContain("AI補正後 9.0%");
        expect(byClass(cards[1]!, "horse-reason")).toHaveLength(0); // 根拠が null の馬は、根拠の行を出さない
        expect(textOf(t)).toContain("分析モデル: claude-sonnet-x");
        expect(textOf(t)).not.toContain("LLM 未使用");
      });

      it("LLM なし(モデル null): 「AI補正後」の行・根拠の行は、データに値があっても出ない。3着内率とモデル欄「LLM 未使用(統計のみ)」は出る", () => {
        const t = tree(analysis({ model: null, horses: [{ ...llmHorses[0]!, isPositive: false }, llmHorses[1]!] }));
        expect(llmHorses[0]!.adjustedProb, "前提: 補正後が prior と違う").not.toBe(llmHorses[0]!.prior);
        expect(byClass(t, "horse")).toHaveLength(2);
        expect(textOf(t)).not.toContain("AI補正後");
        expect(textOf(t)).not.toContain("25.0%");
        expect(byClass(t, "horse-reason")).toHaveLength(0);
        expect(textOf(t)).not.toContain("調教の動きが良い");
        expect(textOf(t)).toContain("3着内率 20.0%");
        expect(textOf(t)).toContain("分析モデル: LLM 未使用(統計のみ)");
      });

      it("理由(llmNote): LLM なし+理由、LLM あり+理由(印の制約違反)のどちらでも出る。理由なし(過去の分析・問題なく効いた)では注記の要素が出ない", () => {
        const noKey = byClass(tree(analysis({ model: null, llmNote: NO_KEY, horses: noLlmHorses })), "llm-note");
        expect(noKey.map(textOf)).toEqual([NO_KEY]);
        const marks = byClass(tree(analysis({ model: "claude-x", llmNote: MARKS, horses: llmHorses })), "llm-note");
        expect(marks.map(textOf)).toEqual([MARKS]);
        expect(byClass(tree(analysis({ model: null, llmNote: null, horses: noLlmHorses })), "llm-note")).toHaveLength(0);
        expect(byClass(tree(analysis({ model: "claude-x", llmNote: null, horses: llmHorses })), "llm-note")).toHaveLength(0);
      });

      it("理由の注記は「分析モデル」の行のあと、馬一覧の前にある(モデル欄の近く)", () => {
        const t = tree(analysis({ model: null, llmNote: NO_KEY, horses: noLlmHorses }));
        const all = textOf(t);
        expect(all.indexOf("分析モデル")).toBeGreaterThan(-1);
        expect(all.indexOf(NO_KEY)).toBeGreaterThan(all.indexOf("分析モデル"));
        expect(all.indexOf(NO_KEY)).toBeLessThan(all.indexOf("馬ごとの評価"));
      });

      it("印の凡例: 印が1頭でもあるときだけ、「印の付いた馬」の見出しの下に exe の凡例(MARK_LEGEND)を1行出す(馬ごとの評価の中には出さない)。印が無ければ出さない", () => {
        const withMark = byClass(tree(analysis({ model: "claude-x", horses: llmHorses })), "mark-legend");
        expect(withMark.map(textOf)).toEqual([MARK_LEGEND]);
        expect(byClass(byClass(tree(analysis({ model: "claude-x", horses: llmHorses })), "marked-horses")[0]!, "mark-legend")).toHaveLength(1);
        expect(byClass(tree(analysis({ model: "claude-x", horses: [llmHorses[1]!] })), "mark-legend")).toHaveLength(0);
      });

      it("悪意のある文字列(根拠・理由)は、解釈されずテキストになる(script・img などの要素を作らない)", () => {
        const PAYLOAD = "<img src=x onerror=alert(1)>";
        const a = analysis({ model: "claude-x", llmNote: PAYLOAD, horses: [{ ...llmHorses[0]!, reason: PAYLOAD }] });
        const { tags, texts } = mountAll(tree(a));
        expect(tags.filter((t) => ["img", "script", "svg", "iframe", "style"].includes(t))).toEqual([]);
        expect(texts.filter((t) => t.includes("<img")).length).toBeGreaterThanOrEqual(2); // 根拠・理由(モデル名なし。馬名は通常の文字)
      });
    });
  }
});

/**
 * Issue #198: 馬ごとの強調材料・懸念事項と、LLM の所要時間・usage。結果画面と発走前のカードの中(`resultSections`・`resultMeta` を共有)の**両方**で同じ表示になること。
 *  - 強調材料・懸念事項は、根拠の行の下。ラベルと箇条書き(`ul`/`li`)。LLM が効いたとき(モデル ID があるとき)だけ。空ならその塊ごと出さない
 *  - 所要時間・usage は、「分析モデル」の行の下(要約の1行。警告は該当するときだけ別の行)。理由(`llmNote`)より上
 *  - 外から来た文字列は、テキストノードだけ(要素を作らない)
 */
describe("強調材料・懸念事項・LLM の usage の表示(Issue #198。結果画面とカードの中の両方)", () => {
  const POINT_HORSES: AnalysisDetail["horses"] = [
    { umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.25, placeOddsMin: 1.8, ev: 1.35, isPositive: true, mark: "◎", reason: "調教の動きが良い", highlights: ["追い切り好時計", "内枠有利"], concerns: ["距離延長"] },
    { umaban: 2, name: "ブラボー", prior: 0.1, adjustedProb: 0.09, placeOddsMin: 3, ev: 0.27, isPositive: false, mark: null, reason: "特筆なし", highlights: [], concerns: ["外枠", "休み明け"] },
    { umaban: 3, name: "チャーリー", prior: 0.1, adjustedProb: 0.1, placeOddsMin: 4, ev: 0.4, isPositive: false, mark: null, reason: null, highlights: [], concerns: [] },
  ];
  const CALL = { ok: true, ms: 41_234, inputTokens: 15_001, outputTokens: 6_020, stopReason: "end_turn", model: "claude-sonnet-5-5", replayed: false, error: null } as const;
  const cardTree = (a: AnalysisDetail): VNode => {
    const rows = [row("morning", "done", { prior: true }), row("pre_race", "done", { analysisId: 7 })];
    return renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows, prior: null }, result: { kind: "ready", analysis: a } })), noopActions);
  };
  const screens: readonly [string, (a: AnalysisDetail) => VNode][] = [
    ["結果画面", resultTree],
    ["発走前のカードの中", cardTree],
  ];

  for (const [name, tree] of screens) {
    describe(name, () => {
      it("LLM が効いたとき: 根拠の行の下に、強調材料・懸念事項のラベルと箇条書き(ul > li)。順序のまま。取り違えない", () => {
        const cards = byClass(tree(analysis({ model: "claude-x", horses: POINT_HORSES })), "horse");
        expect(cards).toHaveLength(3);
        const first = cards[0]!;
        const highlights = byClass(first, "highlights");
        const concerns = byClass(first, "concerns");
        expect(highlights).toHaveLength(1);
        expect(concerns).toHaveLength(1);
        expect(byClass(highlights[0]!, "points-label").map(textOf)).toEqual(["強調材料"]);
        expect(byClass(concerns[0]!, "points-label").map(textOf)).toEqual(["懸念事項"]);
        // ul の直下が li(項目ごとに1つ。順序のまま)
        const hUl = findAll(highlights[0]!, (n) => n.tag === "ul");
        expect(hUl).toHaveLength(1);
        expect(hUl[0]!.children!.map((c) => (typeof c === "string" ? "text" : c.tag))).toEqual(["li", "li"]);
        expect(hUl[0]!.children!.map(textOf)).toEqual(["追い切り好時計", "内枠有利"]);
        const cUl = findAll(concerns[0]!, (n) => n.tag === "ul");
        expect(cUl[0]!.children!.map(textOf)).toEqual(["距離延長"]);
        // 根拠の行より下(馬のカードの中の並び)
        const text = textOf(first);
        expect(text.indexOf("根拠 調教の動きが良い")).toBeGreaterThan(-1);
        expect(text.indexOf("強調材料")).toBeGreaterThan(text.indexOf("根拠 調教の動きが良い"));
        expect(text.indexOf("懸念事項")).toBeGreaterThan(text.indexOf("強調材料"));
      });

      it("片方だけ空の馬は、空でない側だけ出す。両方空の馬は、塊を一切出さない(ラベルも出ない)", () => {
        const cards = byClass(tree(analysis({ model: "claude-x", horses: POINT_HORSES })), "horse");
        expect(byClass(cards[1]!, "highlights")).toHaveLength(0);
        expect(byClass(cards[1]!, "concerns")).toHaveLength(1);
        expect(textOf(cards[1]!)).not.toContain("強調材料");
        expect(findAll(cards[1]!, (n) => n.tag === "ul")[0]!.children!.map(textOf)).toEqual(["外枠", "休み明け"]);
        expect(byClass(cards[2]!, "horse-points")).toHaveLength(0);
        expect(textOf(cards[2]!)).not.toMatch(/強調材料|懸念事項/);
        expect(findAll(cards[2]!, (n) => n.tag === "ul")).toHaveLength(0);
      });

      it("LLM なし(モデル null)では、データに項目があっても塊は出ない(ラベルも項目の文字も)", () => {
        const t = tree(analysis({ model: null, horses: POINT_HORSES }));
        expect(POINT_HORSES[0]!.highlights.length, "前提: データに項目がある").toBeGreaterThan(0);
        expect(byClass(t, "horse")).toHaveLength(3);
        expect(byClass(t, "horse-points")).toHaveLength(0);
        expect(textOf(t)).not.toMatch(/強調材料|懸念事項|追い切り好時計|距離延長|外枠/);
      });

      it("悪意のある文字列(強調材料・懸念事項)は、解釈されずテキストになる(要素を作らない)", () => {
        const PAYLOAD = "<img src=x onerror=alert(1)>";
        const horses: AnalysisDetail["horses"] = [{ ...POINT_HORSES[0]!, highlights: [PAYLOAD], concerns: [PAYLOAD] }];
        const t = tree(analysis({ model: "claude-x", horses }));
        expect(byClass(t, "horse-points")).toHaveLength(2); // 前提: 塊が出ている
        const { tags, texts } = mountAll(t);
        expect(tags.filter((x) => ["img", "script", "svg", "iframe", "style"].includes(x))).toEqual([]);
        expect(texts.filter((x) => x === PAYLOAD)).toHaveLength(2);
      });

      it("LLM の usage: 記録があれば、分析モデルの行の下・理由の注記の上に、要約の1行。馬一覧より前", () => {
        const NOTE = "印の制約違反のため、印は付けていません(3着内率の補正は反映しています)";
        const t = tree(analysis({ model: "claude-x", llmNote: NOTE, llmCalls: [CALL], horses: POINT_HORSES }));
        const usage = byClass(t, "llm-usage");
        expect(usage.map(textOf)).toEqual(["LLM: 1回・41秒・入力 15,001・出力(思考を含む) 6,020 トークン"]);
        expect(byClass(t, "llm-usage-warn")).toHaveLength(0); // 警告なし(問題のない1回)
        const all = textOf(t);
        expect(all.indexOf("分析モデル")).toBeGreaterThan(-1);
        expect(all.indexOf("LLM: 1回")).toBeGreaterThan(all.indexOf("分析モデル"));
        expect(all.indexOf(NOTE)).toBeGreaterThan(all.indexOf("LLM: 1回"));
        expect(all.indexOf("LLM: 1回")).toBeLessThan(all.indexOf("馬ごとの評価"));
      });

      it("LLM の usage: 警告は該当する行だけ(切り詰め・失敗・再生)。要約とは別の要素で、1件ずつ", () => {
        const calls = [{ ...CALL, stopReason: "max_tokens", outputTokens: 16_000 }, { ok: false, ms: 5_000, inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: "種別=timeout" }, { ...CALL, replayed: true }];
        const t = tree(analysis({ model: "claude-x", llmCalls: calls }));
        expect(byClass(t, "llm-usage")).toHaveLength(1);
        expect(byClass(t, "llm-usage-warn").map(textOf)).toEqual([
          "出力の上限に達して途中で切れた呼び出しが 1 回ありました",
          "失敗した呼び出しが 1 回ありました",
          "うち 1 回は、前の実行で記録した応答を再生したものです(時間・トークン数は元の呼び出しの値)",
        ]);
      });

      it("LLM の usage: 記録なし(null・空配列)なら要素が出ない。モデルが null でも、記録があれば出る(全回が失敗したフォールバック)", () => {
        expect(byClass(tree(analysis({ model: "claude-x", llmCalls: null })), "llm-usage")).toHaveLength(0);
        expect(byClass(tree(analysis({ model: "claude-x", llmCalls: [] })), "llm-usage")).toHaveLength(0);
        const failed = { ok: false, ms: 180_001, inputTokens: null, outputTokens: null, stopReason: null, model: null, replayed: false, error: "種別=timeout" } as const;
        const t = tree(analysis({ model: null, llmCalls: [failed, failed] }));
        expect(byClass(t, "llm-usage").map(textOf)).toEqual(["LLM: 2回・6分00秒"]);
        expect(byClass(t, "llm-usage-warn").map(textOf)).toEqual(["失敗した呼び出しが 2 回ありました"]);
      });

      it("LLM の usage: 記録の外から来た文字列(stopReason・model・error)は画面のどこにも出ない", () => {
        const PAYLOAD = "<img src=x onerror=alert(1)>";
        const t = tree(analysis({ model: "claude-x", llmCalls: [{ ...CALL, stopReason: PAYLOAD, model: PAYLOAD, error: PAYLOAD }] }));
        expect(byClass(t, "llm-usage")).toHaveLength(1); // 前提: usage は出ている
        const { tags, texts } = mountAll(t);
        expect(tags.filter((x) => ["img", "script", "svg", "iframe", "style"].includes(x))).toEqual([]);
        expect(texts.filter((x) => x.includes("<img"))).toEqual([]);
      });
    });
  }
});

/**
 * Issue #211: 「印の付いた馬」の section(印・馬番・馬名だけ。数値は出さない)。結果画面(h2)と発走前のカードの中(開いたときだけ。h3)の**両方**で、
 * 「馬ごとの評価」より前に出る。凡例(`mark-legend`)は、この section の見出しの下に1回だけ(「馬ごとの評価」の中には出さない)。印が1頭も無ければ section ごと出さない。
 */
describe("印の付いた馬の section(Issue #211。結果画面とカードの中の両方)", () => {
  const H = (umaban: number, name: string | null, mark: string | null) =>
    ({ umaban, name, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.05, isPositive: false, mark, reason: null, highlights: [], concerns: [] }) as AnalysisDetail["horses"][number];
  const markedHorses: AnalysisDetail["horses"] = [H(5, "ゴー", null), H(3, "エートラックス", "◎"), H(2, null, "▲"), H(1, "アイ", "〇")];
  const noMarkHorses: AnalysisDetail["horses"] = [H(1, "アイ", null), H(2, "ウー", null)];
  const cardTree = (a: AnalysisDetail, resultOpen = true): VNode => {
    const rows = [row("morning", "done", { prior: true }), row("pre_race", "done", { analysisId: 7 })];
    return renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows, prior: null }, result: { kind: "ready", analysis: a }, resultOpen })), noopActions);
  };
  const screens: readonly [string, "h2" | "h3", (a: AnalysisDetail) => VNode][] = [
    ["結果画面", "h2", resultTree],
    ["発走前のカードの中", "h3", (a) => cardTree(a)],
  ];

  for (const [name, heading, tree] of screens) {
    describe(name, () => {
      it(`見出し「印の付いた馬」(${heading})の section が、「馬ごとの評価」の section より前にある`, () => {
        const t = tree(analysis({ model: "claude-x", horses: markedHorses }));
        const sections = byClass(t, "marked-horses");
        expect(sections).toHaveLength(1);
        expect(findAll(sections[0]!, (n) => n.tag === heading).map(textOf)).toEqual(["印の付いた馬"]);
        const all = findAll(t, (n) => n.tag === "section").map((n) => String(n.attrs?.["class"]));
        expect(all.indexOf("marked-horses")).toBeGreaterThan(-1);
        expect(all.indexOf("horses")).toBeGreaterThan(-1);
        expect(all.indexOf("marked-horses")).toBeLessThan(all.indexOf("horses"));
        expect(textOf(t).indexOf("印の付いた馬")).toBeLessThan(textOf(t).indexOf("馬ごとの評価"));
      });

      it("1行は印・馬番・馬名(馬名が無ければ印と馬番だけ)。印の順 → 馬番の昇順。数値(3着内率・EV)は出さない。馬のカード(horse)の数は変わらない", () => {
        const t = tree(analysis({ model: "claude-x", horses: markedHorses }));
        const items = byClass(byClass(t, "marked-horses")[0]!, "marked");
        expect(items.map(rawTextOf)).toEqual(["◎ 3 エートラックス", "〇 1 アイ", "▲ 2"]); // 実 DOM の textContent 相当。要素の間に空白のテキストノードが要る
        for (const li of items) {
          expect(li.tag).toBe("li");
          expect(textOf(li)).not.toMatch(/3着内率|EV|%|オッズ/);
        }
        expect(byClass(t, "horse")).toHaveLength(markedHorses.length); // 馬ごとの評価は全頭のまま
      });

      it("凡例は、この section の中に1回だけ(見出しの下、一覧の前)。「馬ごとの評価」の section の中には出さない", () => {
        const t = tree(analysis({ model: "claude-x", horses: markedHorses }));
        const legends = byClass(t, "mark-legend");
        expect(legends.map(textOf)).toEqual([MARK_LEGEND]);
        const section = byClass(t, "marked-horses")[0]!;
        expect(byClass(section, "mark-legend")).toHaveLength(1);
        expect(byClass(byClass(t, "horses")[0]!, "mark-legend")).toHaveLength(0);
        const kids = (section.children ?? []).map((k) => (typeof k === "string" ? "" : String(k.attrs?.["class"] ?? k.tag)));
        expect(kids.indexOf("meta mark-legend")).toBeGreaterThan(0); // 見出しの後
        expect(kids.indexOf("meta mark-legend")).toBeLessThan(kids.indexOf("horse-list"));
      });

      it("印が1頭も無い分析では、section ごと出さない(凡例も出さない)。馬ごとの評価は出る", () => {
        const t = tree(analysis({ model: "claude-x", horses: noMarkHorses }));
        expect(byClass(t, "marked-horses")).toHaveLength(0);
        expect(byClass(t, "mark-legend")).toHaveLength(0);
        expect(textOf(t)).not.toContain("印の付いた馬");
        expect(byClass(t, "horses")).toHaveLength(1);
      });

      it("LLM なし(モデル null)でも、印があれば出す(印の有無だけで決まる)", () => {
        const t = tree(analysis({ model: null, horses: markedHorses }));
        expect(byClass(byClass(t, "marked-horses")[0]!, "marked")).toHaveLength(3);
      });

      it("悪意のある文字列(印・馬名)は、解釈されずテキストになる(未知の印は落とさず出す)", () => {
        const PAYLOAD = "<img src=x onerror=alert(1)>";
        const t = tree(analysis({ horses: [H(1, PAYLOAD, PAYLOAD), H(2, "アイ", "◎")] }));
        expect(byClass(byClass(t, "marked-horses")[0]!, "marked").map(rawTextOf)).toEqual(["◎ 2 アイ", `${PAYLOAD} 1 ${PAYLOAD}`]);
        const { tags } = mountAll(t);
        expect(tags.filter((x) => ["img", "script", "svg", "iframe", "style"].includes(x))).toEqual([]);
      });
    });
  }

  it("カードを畳んでいるときは、section を描画しない。開いているときは出る(対照)", () => {
    const a = analysis({ model: "claude-x", horses: markedHorses });
    expect(byClass(cardTree(a, true), "marked-horses")).toHaveLength(1); // 前提: 開けば出る
    expect(byClass(cardTree(a, false), "marked-horses")).toHaveLength(0);
    expect(byClass(cardTree(a, false), "mark-legend")).toHaveLength(0);
  });

  it("結果画面とカードの中で、この section は同じ木(見出しの h2/h3 の違いだけ)", () => {
    const strip = (n: VNode | string): unknown => (typeof n === "string" ? n : { ...n, tag: n.tag === "h2" || n.tag === "h3" ? "h" : n.tag, children: (n.children ?? []).map(strip), on: undefined });
    const a = analysis({ id: 7, model: "claude-x", horses: markedHorses });
    const inScreen = byClass(resultTree(a), "marked-horses");
    const inCard = byClass(cardTree(a), "marked-horses");
    expect(inScreen).toHaveLength(1);
    expect(inCard).toHaveLength(1);
    expect(strip(inCard[0]!)).toEqual(strip(inScreen[0]!));
  });
});
