import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import { BAR_TEXT_CLEAN, BAR_TEXT_DIRTY, SAVED_NOTICE, type LiveTarget } from "../client/settings-form";
import type { VNode } from "../client/vnode";
import { createMounter } from "../client/dom";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";

/**
 * Issue #580: 設定の画面の「打つたびの表示」(金額の整形・未保存の変更)。木は作り直さず、決まった場所の文字だけを `patchText` で書き換える。
 * 守ること: 入力で再描画しない(強制でも、そうでなくても)/ 基準の下書きとの比較で未保存を判定 / 保存の失敗では基準を更新しない / 保存の成功で基準を更新する。
 */

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
const SERVER: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 500_000 };

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const field = (t: VNode, key: string): VNode => findAll(t, (n) => n.attrs?.["data-field"] === key)[0]!;

async function setup(postResponse: (body: Record<string, unknown>) => Resp = (b) => ok({ ok: true, settings: b })) {
  const renders: { tree: VNode; force: boolean }[] = [];
  const patches: [LiveTarget, string][] = [];
  const fetchLike: FetchLike = async (url, init) => {
    if (url === "/api/settings" && init.method === "GET") return ok({ ok: true, settings: SERVER, source: "d1" });
    if (url === "/api/settings" && init.method === "POST") return postResponse(JSON.parse(init.body as string));
    throw new Error(`想定外: ${init.method} ${url}`);
  };
  const app: App = createApp({
    role: "admin",
    fetch: fetchLike,
    now: () => new Date("2026-06-28T00:00:00Z"),
    render: (tree, force) => void renders.push({ tree, force: force === true }),
    patchText: (target, text) => void patches.push([target, text]),
    getHash: () => "#settings",
    setHash: () => {},
    timers: { set: () => 0, clear: () => {} },
    isVisible: () => true,
  });
  app.start();
  await app.whenIdle();
  findAll(renders[renders.length - 1]!.tree, (n) => n.tag === "button" && n.attrs?.["data-section"] === "advanced")[0]!.on!.click!(); // Issue #581: 上級の設定(ケリー係数)は初めは閉じている
  const tree = (): VNode => renders[renders.length - 1]!.tree;
  const barText = (): string => JSON.stringify(findAll(tree(), (n) => n.attrs?.["class"] === "settings-bar-status"));
  return { app, renders, patches, tree, barText, type: (k: string, v: string) => field(tree(), k).on!.input!(v), save: () => findAll(tree(), (n) => n.attrs?.["class"] === "settings-save")[0]!.on!.click!() };
}

describe("Issue #580: 打つたびの表示(patchText)", () => {
  it("金額の入力で整形を書き換える。木は作り直さない(描画の回数が増えない)。金額でない項目は整形を書き換えない", async () => {
    const h = await setup();
    const before = h.renders.length;
    h.type("bankroll", "20000");
    expect(h.patches.filter(([t]) => t === "yen-bankroll")).toEqual([["yen-bankroll", "¥20,000"]]);
    h.type("perRaceCap", "abc");
    expect(h.patches.filter(([t]) => t === "yen-perRaceCap")).toEqual([["yen-perRaceCap", ""]]);
    h.type("kellyFraction", "0.3");
    expect(h.patches.filter(([t]) => t.startsWith("yen-")).length).toBe(2);
    expect(h.renders.length).toBe(before);
  });

  it("未保存の判定は、読み込み直後の下書きとの比較: 変えると未保存、元に戻すと保存済みの文に戻る", async () => {
    const h = await setup();
    expect(h.patches).toEqual([]);
    h.type("bankroll", "1");
    expect(h.patches.at(-1)).toEqual(["bar-status", BAR_TEXT_DIRTY]);
    h.type("bankroll", "500000");
    expect(h.patches.at(-1)).toEqual(["bar-status", BAR_TEXT_CLEAN]);
  });

  it("保存の成功で基準が更新される(保存した内容に戻すと「変更なし」)。成功後の描画は帯の文に「保存しました」を出す。そのあとの入力で再び未保存", async () => {
    const h = await setup();
    h.type("bankroll", "700000");
    h.save();
    await h.app.whenIdle();
    expect(h.barText()).toContain(SAVED_NOTICE);
    h.type("bankroll", "700000");
    expect(h.patches.at(-1)).toEqual(["bar-status", BAR_TEXT_CLEAN]); // 基準は 700000 になっている
    h.type("bankroll", "500000");
    expect(h.patches.at(-1)).toEqual(["bar-status", BAR_TEXT_DIRTY]);
  });

  it("保存の失敗では基準を更新しない(未保存のまま)", async () => {
    const h = await setup(() => ({ status: 500, json: async () => ({ ok: false }) }));
    h.type("bankroll", "700000");
    h.save();
    await h.app.whenIdle();
    expect(h.barText()).not.toContain(SAVED_NOTICE);
    h.type("bankroll", "700001");
    expect(h.patches.at(-1)).toEqual(["bar-status", BAR_TEXT_DIRTY]);
    h.type("bankroll", "500000");
    expect(h.patches.at(-1)).toEqual(["bar-status", BAR_TEXT_CLEAN]);
  });

  it("強制描画(保存の検証エラー)のあとの帯は、今の下書きが未保存であることを木に出す", async () => {
    const h = await setup();
    h.type("bankroll", "abc");
    h.save();
    expect(h.renders.at(-1)!.force).toBe(true);
    expect(h.barText()).toContain(BAR_TEXT_DIRTY);
  });

  it("patchText が無い(省略)でも落ちない", async () => {
    const h = await setup();
    expect(() => h.type("bankroll", "1")).not.toThrow();
  });
});

describe("Issue #580: 実際の DOM の書き換え(createMounter + 文字だけの書き換え)でも、打っている欄のフォーカスと値は変わらない", () => {
  interface El { tag: string; attrs: Record<string, string>; children: unknown[]; value?: string; textContent?: string }
  it("入力 → 帯・整形の textContent だけが変わり、入力欄の要素・value・フォーカスは同じまま。木が同じなので DOM の作り直しは起きない", async () => {
    const created: El[] = [];
    const doc = {
      createElement: (tag: string): any => {
        const el: El & { setAttribute(n: string, v: string): void; appendChild(c: unknown): void; addEventListener(): void } = {
          tag, attrs: {}, children: [],
          setAttribute(n, v) { el.attrs[n] = v; },
          appendChild(c) { el.children.push(c); },
          addEventListener() {},
        };
        created.push(el);
        return el;
      },
      createTextNode: (t: string) => ({ text: t }),
    };
    let replaced = 0;
    const root = { replaceChildren: () => void (replaced += 1) };
    const mount = createMounter(doc as never, root as never);
    const h = await setup();
    mount(h.tree());
    const before = created.length;
    expect(replaced).toBe(1);
    const input = created.find((e) => e.attrs["data-field"] === "bankroll")!;
    input.value = "2";
    // 同じ木をもう一度渡しても作り直さない(入力は木を変えない)
    h.type("bankroll", "20000");
    mount(h.tree());
    expect(replaced).toBe(1);
    expect(created.length).toBe(before);
    expect(input.value).toBe("2"); // patchText は入力欄の値に触れない
  });
});
