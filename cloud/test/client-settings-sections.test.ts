import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import { buildSettingsModel, draftFromSettings, FIELD_ORDER, setDraftValue, WEIGHT_FIELD_ORDER, type FieldKey, type SettingsModelInput } from "../client/settings-form";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { noopActions } from "./client-fakes";

/**
 * Issue #581: 設定の項目を4つの節に分け、上級の設定などを初めは閉じる。
 * 守ること: 節の中身と並び / 初めの開閉 / 「変更あり N 件」/ 閉じた節の入力欄は木に出ない / 閉じていても保存には全項目が入る /
 * 保存の押下で誤りが見つかった閉じた節だけ開く(開いたあとは利用者が閉じられ、次の保存まで開き直さない)。
 */

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
const fieldKeys = (t: VNode): string[] => findAll(t, (n) => n.attrs?.["data-field"] !== undefined).map((n) => String(n.attrs?.["data-field"]));
const toggleOf = (t: VNode, id: string): VNode => findAll(t, (n) => n.attrs?.["data-section"] === id && String(n.attrs?.["class"]).includes("section-toggle"))[0]!;

const FUNDS: FieldKey[] = ["bankroll", "perRaceCap", "evThreshold", "minHitProb", "maxWinBetsPerRace", "maxPlaceBetsPerRace"];
const ODDS: FieldKey[] = ["includeComboOdds", "includeWideInAllocation", "includeQuinellaInAllocation", "includeBracketQuinellaInAllocation", "includeExactaInAllocation", "includeTrioInAllocation", "includeTrifectaInAllocation"];
const LLM: FieldKey[] = ["additionalInstruction", "clipVariant", "analysisModel"];
const ADVANCED: FieldKey[] = ["kellyFraction", "marketShrinkWeight", "preRaceOffsetMinutes", ...WEIGHT_FIELD_ORDER];

const input = (over: Partial<SettingsModelInput> = {}): SettingsModelInput => ({ load: { kind: "ready", source: "d1" }, draft: draftFromSettings(DEFAULT_CLOUD_SETTINGS), errors: {}, save: { kind: "idle" }, ...over });
const tree = (over: Partial<SettingsModelInput> = {}, actions: ViewActions = noopActions): VNode => renderScreen(buildSettingsModel(input(over)), actions);
const ALL_OPEN = { funds: true, odds: true, llm: true, advanced: true } as const;

describe("Issue #581: 節の表示用データ", () => {
  it("節は4つ。見出しと入る項目と初めの開閉は決めたとおり(資金と配分・オッズの取得と券種は開、LLM分析・上級の設定は閉)", () => {
    const m = buildSettingsModel(input());
    expect(m.sections.map((s) => [s.id, s.heading, s.open])).toEqual([
      ["funds", "資金と配分", true],
      ["odds", "オッズの取得と券種", true],
      ["llm", "LLM分析", false],
      ["advanced", "上級の設定", false],
    ]);
    expect(m.sections.map((s) => s.fields.map((f) => f.key))).toEqual([FUNDS, ODDS, LLM, ["kellyFraction", "marketShrinkWeight", "preRaceOffsetMinutes"]]);
    expect(m.sections.map((s) => s.hasWeights)).toEqual([false, false, false, true]);
  });

  it("19項目がどれもちょうど1つの節に入る(落ち・重複がない)", () => {
    const keys = buildSettingsModel(input()).sections.flatMap((s) => s.fields.map((f) => f.key));
    expect(keys.length).toBe(FIELD_ORDER.length);
    expect([...keys].sort()).toEqual([...FIELD_ORDER].sort());
  });

  it("利用者が決めた開閉が初めの値に優先する(開いていた節を閉じる・閉じていた節を開く)", () => {
    const m = buildSettingsModel(input({ sectionOpen: { funds: false, llm: true } }));
    expect(m.sections.map((s) => s.open)).toEqual([false, true, true, false]);
  });

  it("「変更あり N 件」: 既定から変えた項目を節ごとに数える(上級の設定は重みも数える)。0 件は文を出さない", () => {
    let d = draftFromSettings(DEFAULT_CLOUD_SETTINGS);
    d = setDraftValue(d, "bankroll", "300000");
    d = setDraftValue(d, "kellyFraction", "0.3");
    d = setDraftValue(d, "biasWeightVenue", "2");
    d = setDraftValue(d, "baseScoreWeightTrainer", "0.5");
    const s = buildSettingsModel(input({ draft: d })).sections;
    expect(s.map((x) => x.changedCount)).toEqual([1, 0, 0, 3]);
    expect(s.map((x) => x.changedText)).toEqual(["変更あり 1 件", null, null, "変更あり 3 件"]);
  });
});

describe("Issue #581: 節の VNode", () => {
  it("初めは資金と配分・オッズの取得と券種の項目だけが木にある。閉じた節(LLM分析・上級の設定)の入力欄・重み・リセットは出ない", () => {
    const keys = fieldKeys(tree());
    expect(keys).toEqual([...FUNDS, ...ODDS]);
    expect(byClass(tree(), "weights-reset")).toEqual([]);
    expect(byClass(tree(), "weights")).toEqual([]);
  });

  it("すべて開くと34項目(19 + 重み15)が出て、重みの小見出し2つとリセットボタンは上級の設定の中にある", () => {
    const t = tree({ sectionOpen: ALL_OPEN });
    expect([...fieldKeys(t)].sort()).toEqual([...FIELD_ORDER, ...WEIGHT_FIELD_ORDER].sort());
    expect(fieldKeys(t).length).toBe(34);
    const advanced = byClass(t, "settings-section").find((n) => n.attrs?.["data-section"] === "advanced")!;
    expect(textOf(advanced)).toContain("環境・状態バイアス補正");
    expect(textOf(advanced)).toContain("基礎スコア");
    expect(byClass(advanced, "weights-reset").length).toBe(1);
    expect(fieldKeys(advanced)).toEqual(ADVANCED.slice(0, 3).concat(WEIGHT_FIELD_ORDER));
  });

  it("開閉ボタンは aria-expanded と data-open-after を持ち、押すと onSettingsSectionToggle(節, 今の逆)", () => {
    const calls: [string, boolean][] = [];
    const actions: ViewActions = { ...noopActions, onSettingsSectionToggle: (id, open) => void calls.push([id, open]) };
    const t = tree({}, actions);
    const funds = toggleOf(t, "funds");
    const llm = toggleOf(t, "llm");
    expect([funds.attrs?.["aria-expanded"], funds.attrs?.["data-open-after"]]).toEqual(["true", "false"]);
    expect([llm.attrs?.["aria-expanded"], llm.attrs?.["data-open-after"]]).toEqual(["false", "true"]);
    funds.on!.click!();
    llm.on!.click!();
    expect(calls).toEqual([["funds", false], ["llm", true]]);
  });

  it("見出しに「変更あり N 件」を文字で出す(閉じた節にも、開いた節にも)", () => {
    let d = draftFromSettings(DEFAULT_CLOUD_SETTINGS);
    d = setDraftValue(d, "kellyFraction", "0.3");
    d = setDraftValue(d, "bankroll", "1");
    const t = tree({ draft: d });
    expect(textOf(toggleOf(t, "advanced"))).toContain("変更あり 1 件"); // 閉じた節
    expect(textOf(toggleOf(t, "funds"))).toContain("変更あり 1 件"); // 開いた節
    expect(textOf(toggleOf(t, "llm"))).not.toContain("変更あり");
  });
});

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
async function setup() {
  const renders: VNode[] = [];
  const posts: Record<string, unknown>[] = [];
  let hash = "#settings";
  const fetchLike: FetchLike = async (url, init) => {
    if (url === "/api/settings" && init.method === "GET") return ok({ ok: true, settings: DEFAULT_CLOUD_SETTINGS satisfies CloudSettings, source: "d1" });
    if (url === "/api/settings" && init.method === "POST") {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      posts.push(body);
      return ok({ ok: true, settings: body });
    }
    throw new Error(`想定外: ${init.method} ${url}`);
  };
  const app: App = createApp({ role: "admin", fetch: fetchLike, now: () => new Date("2026-06-28T00:00:00Z"), render: (t) => void renders.push(t), patchText: () => {}, getHash: () => hash, setHash: () => {}, timers: { set: () => 0, clear: () => {} }, isVisible: () => true });
  app.start();
  await app.whenIdle();
  const tree = (): VNode => renders[renders.length - 1]!;
  const field = (k: string): VNode => findAll(tree(), (n) => n.attrs?.["data-field"] === k)[0]!;
  return {
    app, posts, tree,
    goTo: (h: string) => { hash = h; app.onHashChange(); },
    toggle: (id: string) => toggleOf(tree(), id).on!.click!(),
    isOpen: (id: string) => toggleOf(tree(), id).attrs?.["aria-expanded"] === "true",
    type: (k: string, v: string) => (field(k).on!.input ?? field(k).on!.change!)(v),
    save: () => findAll(tree(), (n) => n.attrs?.["class"] === "settings-save")[0]!.on!.click!(),
  };
}

describe("Issue #581: 画面の制御(開閉・保存)", () => {
  it("開閉ボタンで節が開閉し、開いた節の入力欄が出る。閉じても入力した下書きは残る(開き直すと打った値が見える)", async () => {
    const h = await setup();
    expect(h.isOpen("advanced")).toBe(false);
    expect(fieldKeys(h.tree())).not.toContain("kellyFraction");
    h.toggle("advanced");
    expect(h.isOpen("advanced")).toBe(true);
    expect(fieldKeys(h.tree())).toContain("kellyFraction");
    h.type("kellyFraction", "0.3");
    h.toggle("advanced"); // 閉じる(下書きは残る)
    expect(fieldKeys(h.tree())).not.toContain("kellyFraction");
    h.toggle("advanced");
    expect(String(findAll(h.tree(), (n) => n.attrs?.["data-field"] === "kellyFraction")[0]!.attrs?.["value"])).toBe("0.3");
  });

  it("閉じた節の項目も保存に含まれる: 開いて値を変え、閉じてから保存すると、POST は全34項目を持ち、変えた値が入っている", async () => {
    const h = await setup();
    h.toggle("advanced");
    h.type("kellyFraction", "0.3");
    h.type("biasWeightVenue", "2");
    h.toggle("advanced");
    expect(fieldKeys(h.tree())).not.toContain("kellyFraction"); // 前提: 閉じている
    h.save();
    await h.app.whenIdle();
    expect(h.posts.length).toBe(1);
    expect(Object.keys(h.posts[0]!).sort()).toEqual([...FIELD_ORDER, ...WEIGHT_FIELD_ORDER].sort());
    expect(h.posts[0]!["kellyFraction"]).toBe(0.3);
    expect(h.posts[0]!["biasWeightVenue"]).toBe(2);
  });

  it("保存の押下で閉じた節に誤りが見つかったら、その節だけが開く(誤りのない閉じた節は閉じたまま)。開いたあとは利用者が閉じられ、次の保存を押すまで開き直さない", async () => {
    const h = await setup();
    h.toggle("llm");
    h.type("clipVariant", "zzz"); // LLM分析の節の誤り
    h.toggle("llm"); // 閉じる
    expect([h.isOpen("llm"), h.isOpen("advanced")]).toEqual([false, false]);
    h.save();
    expect(h.posts.length).toBe(0); // 前提: 検証で止まった
    expect(h.isOpen("llm")).toBe(true);
    expect(h.isOpen("advanced")).toBe(false);
    expect(findAll(h.tree(), (n) => n.attrs?.["class"] === "field-error").length).toBe(1);
    h.toggle("llm"); // 利用者が閉じる
    expect(h.isOpen("llm")).toBe(false);
    h.toggle("funds");
    h.toggle("funds"); // 別の描画が起きても開き直さない
    expect(h.isOpen("llm")).toBe(false);
    h.save(); // 次の保存の押下では、誤りが残っていれば開く
    expect(h.isOpen("llm")).toBe(true);
  });

  it("画面を離れると開閉が初めの状態に戻る(設定に入る → LLM 分析を開く → 別の画面へ → 戻る → LLM 分析は閉じている。Issue #626〈#581 の記録〉)", async () => {
    const h = await setup();
    h.toggle("llm");
    expect([h.isOpen("llm"), h.isOpen("funds")]).toEqual([true, true]); // 前提: 開いた(資金と配分は初めから開)
    h.toggle("funds"); // 初めの状態から変えたものがもう 1 つある
    expect(h.isOpen("funds")).toBe(false);
    h.goTo("#/");
    await h.app.whenIdle();
    expect(findAll(h.tree(), (n) => n.attrs?.["data-field"] !== undefined && n.attrs?.["data-field"] === "clipVariant")).toEqual([]); // 前提: 設定の画面を離れた
    h.goTo("#settings");
    await h.app.whenIdle();
    expect([h.isOpen("llm"), h.isOpen("funds")]).toEqual([false, true]);
  });

  it("上級の設定の重みの誤りでも、上級の設定が開く", async () => {
    const h = await setup();
    h.toggle("advanced");
    h.type("biasWeightSeason", "-1");
    h.toggle("advanced");
    h.save();
    expect(h.isOpen("advanced")).toBe(true);
  });
});
