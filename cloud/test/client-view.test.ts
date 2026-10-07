import { describe, expect, it } from "vitest";
import type { AnalysisDetail } from "../client/api-analysis";
import { mount, type DomDocument } from "../client/dom";
import { buildListModel, type ListModelInput } from "../client/list";
import { buildRaceModel, type RaceModelInput } from "../client/race";
import { buildResultModel } from "../client/result";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";

/**
 * Issue #185: レース画面・結果画面の VNode。モデル(純関数。race.test・result.test が検証)→ VNode の写し間違い(出し忘れ・出しすぎ)と、XSS の守り(外から来た文字列はテキストノードだけ。
 * 要素・属性は #184 の許可リストのまま=偽の document に mount して、許可リストに投げられないことを確かめる)。
 * **この段階(#185)のレース画面に起動のボタンは無い**(#186)。
 */

const RACE_ID = "202603020211";
const noop: ViewActions = { onDateChange: () => {}, onRefresh: () => {}, onToggleGroup: () => {} };

function textOf(node: VNode | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join(" ");
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
  route: { date: "20260628", venue: "central", race: RACE_ID, analysis: null },
  status: { kind: "ready", rows: [], prior: null },
  past: { kind: "ready", analyses: [] },
  listRow: undefined,
  ...over,
});

const row = (mode: "morning" | "pre_race", status: "queued" | "fetched" | "done" | "failed", over: Record<string, unknown> = {}) =>
  ({ raceId: RACE_ID, mode, status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null, ...over }) as const;

describe("レース画面の VNode", () => {
  it("見出し・戻るリンク・2 枚のカード(朝の準備・発走前)・過去の分析。起動のボタンは無い(ボタンは「更新」だけ)", () => {
    const tree = renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("morning", "done", { prior: true })], prior: null } })), noop);
    expect(textOf(tree)).toContain(`レース ${RACE_ID}`);
    expect(hrefs(tree)).toContain("#date=20260628&venue=central");
    const cards = byClass(tree, "card");
    expect(cards).toHaveLength(2);
    expect(textOf(cards[0]!)).toContain("朝の準備");
    expect(textOf(cards[0]!)).toContain("完了");
    expect(textOf(cards[1]!)).toContain("発走前");
    expect(textOf(cards[1]!)).toContain("未実行");
    const buttons = findAll(tree, (n) => n.tag === "button");
    expect(buttons.map(textOf)).toEqual(["更新"]);
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
      noop,
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

  it("「結果を見る」は発走前が完了したときだけ、リンク(a)で出る(ボタン・自動遷移ではない)。リンク先は分析のハッシュ", () => {
    const done = renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("pre_race", "done", { analysisId: 12 })], prior: null } })), noop);
    const links = findAll(done, (n) => n.tag === "a" && textOf(n).includes("結果を見る"));
    expect(links).toHaveLength(1);
    expect(links[0]!.attrs?.["href"]).toBe("#date=20260628&venue=central&analysis=12");
    const queued = renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("pre_race", "queued")], prior: null } })), noop);
    expect(textOf(queued)).not.toContain("結果を見る");
  });

  it("失敗したカードは、エラー文(板の error)を出す。状態が失敗でなければ出さない", () => {
    const failed = renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("pre_race", "failed", { error: "ソケット接続に失敗しました" })], prior: null } })), noop);
    expect(textOf(byClass(failed, "card")[1]!)).toContain("ソケット接続に失敗しました");
    expect(textOf(byClass(failed, "card")[0]!)).not.toContain("ソケット");
  });

  it("状態の取得に失敗したら、カードを出さず(「未実行」と誤読させない)、注記(role=alert)を出す。過去の分析は出る", () => {
    const tree = renderScreen(
      buildRaceModel(raceInput({ status: { kind: "error", message: "状態を取得できません" }, past: { kind: "ready", analyses: [{ id: 5, analyzedAt: "2026-06-28T05:00:00.000Z", evEstimated: false, model: null }] } })),
      noop,
    );
    expect(byClass(tree, "card")).toHaveLength(0);
    const alerts = findAll(tree, (n) => n.attrs?.["role"] === "alert");
    expect(alerts.map(textOf)).toEqual(["状態を取得できません"]);
    expect(hrefs(tree)).toContain("#date=20260628&venue=central&analysis=5");
    expect(textOf(tree)).toContain("2026-06-28 14:00");
  });

  it("過去の分析の取得に失敗しても、カードは出る。取得中は「更新」が disabled", () => {
    const failed = renderScreen(buildRaceModel(raceInput({ past: { kind: "error", message: "一覧を取得できません" } })), noop);
    expect(byClass(failed, "card")).toHaveLength(2);
    expect(textOf(failed)).toContain("一覧を取得できません");
    const loading = renderScreen(buildRaceModel(raceInput({ status: { kind: "loading" } })), noop);
    const refresh = findAll(loading, (n) => n.tag === "button")[0]!;
    expect(refresh.attrs?.["disabled"]).toBe(true);
    expect(textOf(refresh)).toContain("読み込み中");
  });

  it("「更新」のクリックは onRefresh に繋がる", () => {
    let count = 0;
    const tree = renderScreen(buildRaceModel(raceInput()), { ...noop, onRefresh: () => (count += 1) });
    findAll(tree, (n) => n.tag === "button")[0]!.on!.click!();
    expect(count).toBe(1);
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
    race: { venueName: "福島", raceNumber: 11, raceName: "テストステークス" },
    horses: [
      { umaban: 1, name: "アルファ", prior: 0.2, adjustedProb: 0.18, placeOddsMin: 1.8, ev: 1.25, isPositive: true, mark: "◎", reason: null },
      { umaban: 2, name: "ブラボー", prior: 0.1, adjustedProb: 0.09, placeOddsMin: null, ev: null, isPositive: false, mark: null, reason: null },
    ],
    allocation: null,
    detail: "present",
    ...over,
  };
}
const route = { date: "20260628", venue: "central" as const, race: null, analysis: 7 };
const resultTree = (a: AnalysisDetail) => renderScreen(buildResultModel({ route, source: { kind: "ready", analysis: a } }), noop);

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

  it("印は mark があるときだけ要素を出す(null の馬に印の要素を出さない)。「AI補正後」は画面のどこにも出ない", () => {
    const tree = resultTree(analysis({ model: "claude-x" }));
    const marks = byClass(tree, "mark");
    expect(marks.map(textOf)).toEqual(["◎"]);
    expect(textOf(tree)).not.toContain("AI補正後");
    expect(textOf(tree)).not.toContain("18.0%"); // adjustedProb(0.18)は出さない
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
    const loading = renderScreen(buildResultModel({ route, source: { kind: "loading" } }), noop);
    expect(textOf(loading)).toContain("読み込み中");
    expect(findAll(loading, (n) => n.tag === "button")).toHaveLength(0);
    let count = 0;
    const failed = renderScreen(buildResultModel({ route, source: { kind: "error", message: "取得できません" } }), { ...noop, onRefresh: () => (count += 1) });
    expect(findAll(failed, (n) => n.attrs?.["role"] === "alert").map(textOf)).toEqual(["取得できません"]);
    const buttons = findAll(failed, (n) => n.tag === "button");
    expect(buttons.map(textOf)).toEqual(["更新"]);
    buttons[0]!.on!.click!();
    expect(count).toBe(1);
    expect(findAll(resultTree(analysis()), (n) => n.tag === "button")).toHaveLength(0);
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
      noop,
    );
    const { tags, texts } = mountAll(tree);
    expect(tags.filter((t) => ["img", "script", "svg", "iframe", "style"].includes(t))).toEqual([]);
    expect(texts.filter((t) => t.includes("<img")).length).toBeGreaterThanOrEqual(3); // 悪意の文字列は、そのまま(解釈されず)テキストに入っている
  });

  it("結果画面(馬名・レース名・モデル名・印)", () => {
    const a = analysis({
      model: PAYLOAD,
      race: { venueName: PAYLOAD, raceNumber: 11, raceName: PAYLOAD },
      horses: [{ umaban: 1, name: PAYLOAD, prior: 0.2, adjustedProb: 0.2, placeOddsMin: 1.8, ev: 1.2, isPositive: true, mark: PAYLOAD, reason: PAYLOAD }],
    });
    const { tags, texts } = mountAll(resultTree(a));
    expect(tags.filter((t) => ["img", "script", "svg", "iframe", "style"].includes(t))).toEqual([]);
    expect(texts.filter((t) => t.includes("<img")).length).toBeGreaterThanOrEqual(4);
  });

  it("href は # で始まるハッシュだけ(レース画面・結果画面のすべてのリンクが、許可リストを通る)", () => {
    const race = renderScreen(buildRaceModel(raceInput({ status: { kind: "ready", rows: [row("pre_race", "done", { analysisId: 3 })], prior: null }, past: { kind: "ready", analyses: [{ id: 1, analyzedAt: "2026-06-28T05:00:00Z", evEstimated: false, model: null }] } })), noop);
    for (const href of [...hrefs(race), ...hrefs(resultTree(analysis()))]) {
      expect(href.startsWith("#"), href).toBe(true);
    }
    expect(hrefs(race).length).toBeGreaterThanOrEqual(3);
    expect(() => mountAll(race)).not.toThrow();
    expect(() => mountAll(resultTree(analysis()))).not.toThrow();
  });
});

/** Issue #187: 一覧の場ごとの見出し(開閉のボタン)。開閉・aria-expanded・要約の表示と、閉じた場の行を描画しないこと。 */
describe("一覧の場の見出し(開閉ボタン)", () => {
  const rr = (raceId: string, venueName: string, over: Record<string, unknown> = {}) =>
    ({ raceId, venueName, raceNumber: Number(raceId.slice(-2)), raceName: `レース${raceId.slice(-2)}`, courseType: "芝", distance: 1800, entryCount: 16, grade: null, ...over }) as const;
  const FUKU = [rr("202603020211", "福島"), rr("202603020212", "福島")];
  const HAKO = [rr("202602010101", "函館"), rr("202602010102", "函館")];
  const brow = (raceId: string, mode: "morning" | "pre_race", status: "queued" | "fetched" | "done" | "failed") =>
    ({ raceId, mode, status, attempts: 0, error: null, queuedAt: 1, updatedAt: 2, prior: false, analysisId: null }) as const;
  const listInput = (over: Partial<ListModelInput> = {}): ListModelInput => ({
    route: { date: "20260628", venue: "central", race: null, analysis: null },
    list: { kind: "ready", races: [...FUKU, ...HAKO] },
    board: { kind: "none" },
    ...over,
  });
  const toggles = (tree: VNode): VNode[] => byClass(tree, "venue-toggle");
  const raceLinks = (tree: VNode): VNode[] => byClass(tree, "race");

  it("見出しは h2 の中のボタン。aria-expanded は開閉の実際の状態と一致し、開閉が文字(▾/▸)でも分かる", () => {
    const keysAll = buildListModel(listInput()).groups.map((g) => g.key);
    const tree = renderScreen(buildListModel(listInput({ choices: new Map([[keysAll[1]!, true]]) })), noop);
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

  it("閉じた場のレースの行(a.race と ul.races)は描画しない。開いた場の行だけが出る", () => {
    const keys = buildListModel(listInput()).groups.map((g) => g.key);
    const allClosed = renderScreen(buildListModel(listInput()), noop);
    expect(raceLinks(allClosed)).toHaveLength(0);
    expect(byClass(allClosed, "races")).toHaveLength(0);
    const oneOpen = renderScreen(buildListModel(listInput({ choices: new Map([[keys[1]!, true]]) })), noop);
    expect(raceLinks(oneOpen)).toHaveLength(2);
    expect(raceLinks(oneOpen).map((a) => a.attrs?.["href"])).toEqual(["#date=20260628&venue=central&race=202603020211", "#date=20260628&venue=central&race=202603020212"]);
    expect(byClass(oneOpen, "races")).toHaveLength(1);
  });

  it("見出しのボタンには場名・レース数が出る。閉じていても出る", () => {
    const tree = renderScreen(buildListModel(listInput()), noop);
    const texts = toggles(tree).map(textOf);
    expect(texts[0]).toContain("函館");
    expect(texts[0]).toContain("2R");
    expect(texts[1]).toContain("福島");
    expect(texts[1]).toContain("2R");
  });

  it("要約: 実行中・失敗の数を見出しに出す。0 の項目は出さない。板が無ければ件数だけ", () => {
    const board = [brow("202603020211", "morning", "queued"), brow("202603020212", "pre_race", "fetched"), brow("202603020212", "morning", "failed"), brow("202602010101", "morning", "done")];
    const tree = renderScreen(buildListModel(listInput({ board: { kind: "ready", rows: board } })), noop);
    const [hako, fuku] = toggles(tree).map(textOf);
    // 函館: 完了だけ → 実行中・失敗とも 0 で、どちらの語も出ない
    expect(hako).not.toContain("実行中");
    expect(hako).not.toContain("失敗");
    // 福島: 2 レースとも実行中(1 つは失敗も)。失敗 1
    expect(fuku).toContain("実行中 2");
    expect(fuku).toContain("失敗 1");
    const noBoard = toggles(renderScreen(buildListModel(listInput()), noop)).map(textOf);
    expect(noBoard.join(" ")).not.toContain("実行中");
    expect(noBoard.join(" ")).not.toContain("失敗");
  });

  it("失敗だけ・実行中だけのとき、出すのはその語だけ", () => {
    const failedOnly = toggles(renderScreen(buildListModel(listInput({ board: { kind: "ready", rows: [brow("202603020211", "morning", "failed")] } })), noop)).map(textOf);
    expect(failedOnly[1]).toContain("失敗 1");
    expect(failedOnly[1]).not.toContain("実行中");
    const runningOnly = toggles(renderScreen(buildListModel(listInput({ board: { kind: "ready", rows: [brow("202603020211", "morning", "queued")] } })), noop)).map(textOf);
    expect(runningOnly[1]).toContain("実行中 1");
    expect(runningOnly[1]).not.toContain("失敗");
  });

  it("タップは onToggleGroup(その場のキー, 反転した次の値)に繋がる(閉→開・開→閉)", () => {
    const calls: [string, boolean][] = [];
    const actions: ViewActions = { ...noop, onToggleGroup: (key, open) => void calls.push([key, open]) };
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
    const tree = renderScreen(buildListModel(listInput({ list: { kind: "ready", races: [rr("202603020211", evil), rr("202602010101", "函館")] } })), noop);
    const { tags, texts } = mountAll(tree);
    expect(tags.filter((t) => ["img", "script", "iframe", "style", "details", "summary"].includes(t))).toEqual([]);
    expect(texts.some((t) => t.includes(evil))).toBe(true);
    expect(tags).toContain("button");
  });
});
