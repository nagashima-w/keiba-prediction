import { describe, expect, it } from "vitest";
import { mount, type DomDocument } from "../client/dom";
import { buildListModel } from "../client/list";
import { buildSettingsModel, draftFromSettings, FIELD_ORDER, setDraftValue, type SettingsModelInput } from "../client/settings-form";
import { renderScreen, type ViewActions } from "../client/view";
import type { VNode } from "../client/vnode";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { noopActions } from "./client-fakes";

/**
 * Issue #189(段階2): 設定画面の VNode と、トップの入口。モデル(`settings-form.test.ts`)→ VNode の写し間違いと、許可リスト(`dom.ts`)を通ること、
 * 入力欄の `data-field`・変更の処理が項目名に繋がること。
 */

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
const inputs = (tree: VNode): VNode[] => findAll(tree, (n) => n.attrs?.["data-field"] !== undefined);

/** VNode を許可リストつきのアダプタで偽の document に組み立てる(許可リスト外の要素・属性があれば投げる)。 */
function mountAll(tree: VNode): void {
  const doc: DomDocument = {
    createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }),
    createTextNode: () => ({}),
  };
  mount(doc, { replaceChildren() {} }, tree);
}

const CUSTOM: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 500_000, perRaceCap: 50_000, includeComboOdds: true, includeTrioInAllocation: false, additionalInstruction: "1行目\n2行目", clipVariant: "wide15", preRaceOffsetMinutes: 90 };
const input = (over: Partial<SettingsModelInput> = {}): SettingsModelInput => ({ load: { kind: "ready", source: "d1" }, draft: draftFromSettings(CUSTOM), errors: {}, save: { kind: "idle" }, ...over });
const tree = (over: Partial<SettingsModelInput> = {}, actions: ViewActions = noopActions): VNode => renderScreen(buildSettingsModel(input(over)), actions);

describe("設定画面の VNode", () => {
  it("許可リスト(dom.ts)の範囲で組める(textarea・select・option・checked・inputmode・maxlength を含む)。保存中・エラー表示でも同じ", () => {
    expect(() => mountAll(tree())).not.toThrow();
    expect(() => mountAll(tree({ save: { kind: "saving" } }))).not.toThrow();
    expect(() => mountAll(tree({ errors: { bankroll: "エラー" }, save: { kind: "error", message: "失敗" } }))).not.toThrow();
    expect(() => mountAll(renderScreen(buildSettingsModel({ load: { kind: "loading" }, draft: null, errors: {}, save: { kind: "idle" } }), noopActions))).not.toThrow();
  });

  it("入力欄は 14 個で、すべて data-field に項目名を持つ(FIELD_ORDER の順)", () => {
    const fields = inputs(tree());
    expect(fields.length).toBe(14);
    expect(fields.map((n) => n.attrs?.["data-field"])).toEqual([...FIELD_ORDER]);
  });

  it("入力欄の要素と値: 数値は type=text(inputmode)・追加指示は textarea(maxlength=2000)・クリップ幅は select(value と option)・真偽は checkbox(checked)", () => {
    const byField = Object.fromEntries(inputs(tree()).map((n) => [String(n.attrs?.["data-field"]), n]));
    const bankroll = byField["bankroll"]!;
    expect([bankroll.tag, bankroll.attrs?.["type"], bankroll.attrs?.["value"], bankroll.attrs?.["inputmode"]]).toEqual(["input", "text", "500000", "numeric"]);
    expect(byField["kellyFraction"]!.attrs?.["inputmode"]).toBe("decimal");
    const area = byField["additionalInstruction"]!;
    expect([area.tag, area.attrs?.["value"], area.attrs?.["maxlength"]]).toEqual(["textarea", "1行目\n2行目", "2000"]);
    const select = byField["clipVariant"]!;
    expect([select.tag, select.attrs?.["value"]]).toEqual(["select", "wide15"]);
    expect((select.children ?? []).map((o) => (typeof o === "string" ? o : [o.tag, o.attrs?.["value"]]))).toEqual([["option", "default"], ["option", "wide15"]]);
    const combo = byField["includeComboOdds"]!;
    expect([combo.tag, combo.attrs?.["type"], combo.attrs?.["checked"]]).toEqual(["input", "checkbox", true]);
    expect(byField["includeTrioInAllocation"]!.attrs?.["checked"]).toBeFalsy();
    expect(byField["includeWideInAllocation"]!.attrs?.["checked"]).toBe(true);
  });

  it("変更の処理は、その項目名と入力の値で onSettingsInput を呼ぶ(data-field と同じ項目名)", () => {
    const calls: [string, string][] = [];
    const actions: ViewActions = { ...noopActions, onSettingsInput: (key, value) => void calls.push([key, value]) };
    const fields = inputs(tree({}, actions));
    for (const n of fields) {
      expect(n.on?.change, String(n.attrs?.["data-field"])).toBeDefined();
      n.on!.change!(`値:${String(n.attrs?.["data-field"])}`);
    }
    expect(calls).toEqual(FIELD_ORDER.map((k) => [k, `値:${k}`]));
  });

  it("Issue #189: 文字を打つ欄(数値の text・textarea)は、change に加えて input でも onSettingsInput を呼ぶ(入力中の値を、保存の直前に取りこぼさない)。checkbox・select は change だけ", () => {
    const calls: [string, string][] = [];
    const actions: ViewActions = { ...noopActions, onSettingsInput: (key, value) => void calls.push([key, value]) };
    const typed = new Set(["evThreshold", "bankroll", "perRaceCap", "kellyFraction", "additionalInstruction", "preRaceOffsetMinutes"]);
    const fields = inputs(tree({}, actions));
    for (const n of fields) {
      const key = String(n.attrs?.["data-field"]);
      expect(n.on?.change, `${key} の change`).toBeDefined();
      if (typed.has(key)) {
        expect(n.on?.input, `${key} の input`).toBeDefined();
        n.on!.input!(`入力:${key}`);
      } else {
        expect(n.on?.input, `${key} は input を持たない`).toBeUndefined();
      }
    }
    expect(calls).toEqual(FIELD_ORDER.filter((k) => typed.has(k)).map((k) => [k, `入力:${k}`]));
    expect(typed.size).toBe(6);
  });

  it("保存ボタン(class=settings-save。文言は「保存」)のクリックは onSettingsSave。保存中は disabled・文言「保存中…」。入力欄も disabled", () => {
    let saves = 0;
    const actions: ViewActions = { ...noopActions, onSettingsSave: () => void (saves += 1) };
    const save = byClass(tree({}, actions), "settings-save");
    expect(save.length).toBe(1);
    expect(textOf(save[0]!)).toBe("保存");
    expect(save[0]!.attrs?.["disabled"]).toBeFalsy();
    save[0]!.on!.click!();
    expect(saves).toBe(1);
    const saving = tree({ save: { kind: "saving" } });
    expect(byClass(saving, "settings-save")[0]!.attrs?.["disabled"]).toBe(true);
    expect(textOf(byClass(saving, "settings-save")[0]!)).toBe("保存中…");
    expect(inputs(saving).every((n) => n.attrs?.["disabled"] === true)).toBe(true);
    expect(inputs(tree()).every((n) => !n.attrs?.["disabled"])).toBe(true);
  });

  it("再読込(class=refresh)は onRefresh。読み込み中・保存中は disabled", () => {
    let refreshes = 0;
    const actions: ViewActions = { ...noopActions, onRefresh: () => void (refreshes += 1) };
    const refresh = byClass(tree({}, actions), "refresh");
    expect(refresh.length).toBe(1);
    expect(textOf(refresh[0]!)).toBe("再読込");
    refresh[0]!.on!.click!();
    expect(refreshes).toBe(1);
    expect(byClass(tree({ save: { kind: "saving" } }), "refresh")[0]!.attrs?.["disabled"]).toBe(true);
    const loading = renderScreen(buildSettingsModel({ load: { kind: "loading" }, draft: null, errors: {}, save: { kind: "idle" } }), noopActions);
    expect(byClass(loading, "refresh")[0]!.attrs?.["disabled"]).toBe(true);
  });

  it("戻るリンクは `#`(トップ)。見出しは「設定」", () => {
    const back = byClass(tree(), "back");
    expect(back.length).toBe(1);
    expect(back[0]!.attrs?.["href"]).toBe("#");
    expect(textOf(byClass(tree(), "title")[0]!)).toBe("設定");
  });

  it("読み込み中は「読み込み中…」だけ(入力欄・保存ボタンなし)。取得の失敗は role=alert の固定の文言で、入力欄・保存ボタンなし(再読込だけ)", () => {
    const loading = renderScreen(buildSettingsModel({ load: { kind: "loading" }, draft: null, errors: {}, save: { kind: "idle" } }), noopActions);
    expect(textOf(loading)).toContain("読み込み中…");
    expect(inputs(loading)).toEqual([]);
    expect(byClass(loading, "settings-save")).toEqual([]);
    const failed = renderScreen(buildSettingsModel({ load: { kind: "error", message: "取得に失敗" }, draft: null, errors: {}, save: { kind: "idle" } }), noopActions);
    const alerts = findAll(failed, (n) => n.attrs?.["role"] === "alert");
    expect(alerts.map(textOf)).toEqual(["取得に失敗"]);
    expect(inputs(failed)).toEqual([]);
    expect(byClass(failed, "settings-save")).toEqual([]);
    expect(byClass(failed, "refresh").length).toBe(1);
  });

  it("項目ごとのエラーは、その項目の近くに role=alert で出し、入力欄に aria-invalid=true を付ける。他の項目には付けない", () => {
    const t = tree({ errors: { bankroll: "資金のエラー", kellyFraction: "ケリーのエラー" } });
    const alerts = findAll(t, (n) => n.attrs?.["role"] === "alert").map(textOf);
    expect(alerts).toEqual(["資金のエラー", "ケリーのエラー"]);
    const invalid = inputs(t).filter((n) => n.attrs?.["aria-invalid"] === "true").map((n) => n.attrs?.["data-field"]);
    expect(invalid).toEqual(["kellyFraction", "bankroll"].sort((a, b) => FIELD_ORDER.indexOf(a as never) - FIELD_ORDER.indexOf(b as never)));
  });

  it("保存の結果: 成功は通知(role=alert でない)・失敗は role=alert。source の注記と、補助文(発走何分前の注記)が出る", () => {
    const ok = tree({ save: { kind: "saved" } });
    expect(textOf(ok)).toContain("保存しました");
    expect(findAll(ok, (n) => n.attrs?.["role"] === "alert")).toEqual([]);
    const failed = tree({ save: { kind: "error", message: "保存できませんでした(固定)" } });
    expect(findAll(failed, (n) => n.attrs?.["role"] === "alert").map(textOf)).toEqual(["保存できませんでした(固定)"]);
    expect(textOf(tree({ load: { kind: "ready", source: "default" } }))).toContain("まだ保存されていません");
    expect(textOf(tree())).toContain("定時の自動実行を入れるまで効きません");
  });

  it("外から来た文字列(追加指示の中身)は、テキストノードでなく value として入るだけ。HTML として解釈される経路を作らない(木にスクリプトの要素が無い)", () => {
    const evil = `</textarea><script>alert(1)</script>`;
    const t = tree({ draft: setDraftValue(draftFromSettings(CUSTOM), "additionalInstruction", evil) });
    expect(findAll(t, (n) => n.tag === "script")).toEqual([]);
    expect(inputs(t).find((n) => n.attrs?.["data-field"] === "additionalInstruction")!.attrs?.["value"]).toBe(evil);
    expect(textOf(t)).not.toContain("alert(1)");
  });

  it("2 つの下書きの木は、値が違えば JSON が違う(同じ木は DOM を触らないので、値の違いが木に出ていること)", () => {
    const a = JSON.stringify(tree());
    const b = JSON.stringify(tree({ draft: setDraftValue(draftFromSettings(CUSTOM), "bankroll", "1") }));
    const c = JSON.stringify(tree({ draft: setDraftValue(draftFromSettings(CUSTOM), "includeComboOdds", "false") }));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("トップ(一覧)の設定への入口", () => {
  const route = { date: "20260628", venue: "central", race: null, analysis: null, settings: false } as const;
  const list = (): VNode => renderScreen(buildListModel({ route, list: { kind: "ready", races: [] }, board: { kind: "none" } }), noopActions);

  it("モデルの settingsHref は `#settings`", () => {
    expect(buildListModel({ route, list: { kind: "loading" }, board: { kind: "none" } }).settingsHref).toBe("#settings");
  });

  it("一覧の画面に「設定」のリンク(class=settings-link・href=#settings)が1つある。一覧が読み込み中・失敗のときも出る", () => {
    const link = byClass(list(), "settings-link");
    expect(link.length).toBe(1);
    expect(link[0]!.tag).toBe("a");
    expect(link[0]!.attrs?.["href"]).toBe("#settings");
    expect(textOf(link[0]!)).toBe("設定");
    for (const source of [{ kind: "loading" }, { kind: "error", message: "x" }] as const) {
      expect(byClass(renderScreen(buildListModel({ route, list: source, board: { kind: "none" } }), noopActions), "settings-link").length).toBe(1);
    }
  });
});

describe("Issue #201: プロンプトのプレビュー(VNode)", () => {
  const toggle = (t: VNode): VNode[] => byClass(t, "preview-toggle");
  const refresh = (t: VNode): VNode[] => byClass(t, "preview-refresh");
  const body = (t: VNode): VNode[] => byClass(t, "prompt-preview");

  it("閉じているとき: 開閉ボタン(aria-expanded=false)だけ。注記・文面・反映ボタンは無い", () => {
    const t = tree();
    expect(toggle(t).length).toBe(1);
    expect(toggle(t)[0]!.tag).toBe("button");
    expect(toggle(t)[0]!.attrs?.["aria-expanded"]).toBe("false");
    expect(textOf(toggle(t)[0]!)).toBe("LLMへ送るプロンプトのプレビューを開く");
    expect(refresh(t)).toEqual([]);
    expect(body(t)).toEqual([]);
    expect(byClass(t, "preview-note")).toEqual([]);
  });

  it("開いているとき: 開閉ボタン(aria-expanded=true・「閉じる」)・反映ボタン・注記・文面が出る", () => {
    const t = tree({ previewOpen: true });
    expect(toggle(t)[0]!.attrs?.["aria-expanded"]).toBe("true");
    expect(textOf(toggle(t)[0]!)).toBe("LLMへ送るプロンプトのプレビューを閉じる");
    expect(refresh(t).length).toBe(1);
    expect(textOf(refresh(t)[0]!)).toBe("入力中の内容を反映");
    expect(byClass(t, "preview-note").length).toBeGreaterThan(2);
    expect(body(t).length).toBe(1);
  });

  it("文面は、改行を含むそのままの文字列 1 つをテキストノードとして入れる(div。許可リストに pre は無い)。モデルの文面と一致する", () => {
    const t = tree({ previewOpen: true });
    const model = buildSettingsModel(input({ previewOpen: true }));
    const node = body(t)[0]!;
    expect(node.tag).toBe("div");
    expect(node.children).toEqual([model.preview!.text!]);
    expect(model.preview!.text!).toContain("\n");
    expect(model.preview!.text!).toContain("1行目\n2行目"); // CUSTOM の追加指示が文面に入っている
  });

  it("外から来た文字列(追加指示)は、文面の中でもテキストノードのまま。HTML として解釈される要素を作らない", () => {
    const evil = `</div><script>alert(1)</script>`;
    const t = tree({ previewOpen: true, draft: setDraftValue(draftFromSettings(CUSTOM), "additionalInstruction", evil) });
    expect(findAll(t, (n) => n.tag === "script")).toEqual([]);
    expect(body(t)[0]!.children).toHaveLength(1);
    expect(String(body(t)[0]!.children![0])).toContain(evil);
  });

  it("開閉ボタンのクリックは onSettingsPreviewToggle(押したあとの状態=今の逆)。閉じているなら true、開いているなら false", () => {
    const calls: boolean[] = [];
    const actions: ViewActions = { ...noopActions, onSettingsPreviewToggle: (open) => void calls.push(open) };
    toggle(tree({}, actions))[0]!.on!.click!();
    toggle(tree({ previewOpen: true }, actions))[0]!.on!.click!();
    expect(calls).toEqual([true, false]);
  });

  it("開閉ボタンは、クリック処理に渡す値(押したあとの状態)を data-open-after にも出す(同じ木の DOM は触られないので、引数が木に出ていること)。値はクリックで渡す値と一致する", () => {
    const calls: boolean[] = [];
    const actions: ViewActions = { ...noopActions, onSettingsPreviewToggle: (open) => void calls.push(open) };
    const closed = toggle(tree({}, actions))[0]!;
    const opened = toggle(tree({ previewOpen: true }, actions))[0]!;
    expect([closed.attrs?.["data-open-after"], opened.attrs?.["data-open-after"]]).toEqual(["true", "false"]);
    closed.on!.click!();
    opened.on!.click!();
    expect(calls.map(String)).toEqual([closed.attrs?.["data-open-after"], opened.attrs?.["data-open-after"]]);
  });

  it("反映ボタンのクリックは onSettingsPreviewRefresh", () => {
    let n = 0;
    const actions: ViewActions = { ...noopActions, onSettingsPreviewRefresh: () => void (n += 1) };
    refresh(tree({ previewOpen: true }, actions))[0]!.on!.click!();
    expect(n).toBe(1);
  });

  it("保存中は開閉・反映のボタンも disabled。通常は disabled でない", () => {
    const saving = tree({ previewOpen: true, save: { kind: "saving" } });
    expect(toggle(saving)[0]!.attrs?.["disabled"]).toBe(true);
    expect(refresh(saving)[0]!.attrs?.["disabled"]).toBe(true);
    const normal = tree({ previewOpen: true });
    expect(toggle(normal)[0]!.attrs?.["disabled"]).toBeFalsy();
    expect(refresh(normal)[0]!.attrs?.["disabled"]).toBeFalsy();
  });

  it("プレビューは保存ボタンより後ろ(画面の末尾)にある。入力欄(data-field)は増えない(14 個のまま)", () => {
    const t = tree({ previewOpen: true });
    const top = t.children as VNode[];
    const saveIndex = top.findIndex((c) => typeof c !== "string" && (c.attrs?.["class"] === "settings-save"));
    const previewIndex = top.findIndex((c) => typeof c !== "string" && byClass(c, "preview-toggle").length > 0);
    expect(saveIndex).toBeGreaterThan(0);
    expect(previewIndex).toBeGreaterThan(saveIndex);
    expect(inputs(t).length).toBe(14);
  });

  it("読み込み中・取得の失敗では、プレビューのボタンも出ない", () => {
    for (const load of [{ kind: "loading" }, { kind: "error", message: "失敗" }] as const) {
      const t = renderScreen(buildSettingsModel({ load, draft: null, errors: {}, save: { kind: "idle" }, previewOpen: true }), noopActions);
      expect(toggle(t), load.kind).toEqual([]);
    }
  });

  it("許可リスト(dom.ts)の範囲で組める(開いているとき・閉じているとき)", () => {
    expect(() => mountAll(tree({ previewOpen: true }))).not.toThrow();
    expect(() => mountAll(tree({ previewOpen: false }))).not.toThrow();
  });

  it("開閉・文面の違いは木の JSON に出る(同じ木は DOM を触らないので、違いが木に出ていること)", () => {
    const closed = JSON.stringify(tree());
    const opened = JSON.stringify(tree({ previewOpen: true }));
    const other = JSON.stringify(tree({ previewOpen: true, draft: setDraftValue(draftFromSettings(CUSTOM), "additionalInstruction", "別の指示") }));
    expect(new Set([closed, opened, other]).size).toBe(3);
  });
});
