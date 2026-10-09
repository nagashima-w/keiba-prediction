import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client/api";
import { createApp, type App } from "../client/app";
import { createMounter, type DomDocument } from "../client/dom";
import type { PickedFile, VNode } from "../client/vnode";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { createFakeTimers } from "./client-fakes";
import { GOLDEN_TEXT } from "./migration-fixture";

/**
 * Issue #222(#167-B2): アプリ全体の中の移行画面(`#migration`)。画面の出入り・設定画面との分離・再読込・可視状態。
 * 守ること:
 *  - 移行画面は `GET /api/migration` だけを取る(一覧・板・設定・レース・分析は取らない)。設定画面は `/api/migration` を取らない
 *  - **設定フォームの入力は、移行の再描画・ポーリングで消えない**(移行画面は別の画面。設定画面にいる間は、移行のタイマー・取得・再描画が一切ない)
 *  - 画面を離れたら移行の状態を破棄する。遅れて届く応答は今の画面に反映しない
 */

type Resp = { status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Resp => ({ status: 200, json: async () => body });
const SERVER: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 500_000 };
// Windows のチェックアウトの CRLF は LF にそろえてある(`migration-fixture.ts`)。
const FIXTURE = GOLDEN_TEXT;

const STATUS = {
  ok: true,
  state: "idle",
  upload: null,
  analyses: { total: null, processed: 0, imported: 0, alreadyImported: 0, conflicts: 0 },
  results: { total: null, processed: 0 },
  resumeAt: null,
  failure: null,
  conflictSamples: [],
  attempts: 0,
  budget: { day: "20261009", usedRows: 0, limitRows: 60000 },
};

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));

class FakeText {
  constructor(readonly data: string) {}
}
class FakeElement {
  readonly children: unknown[] = [];
  constructor(readonly tag: string) {}
  setAttribute(): void {}
  appendChild(child: unknown): void {
    this.children.push(child);
  }
  addEventListener(): void {}
}

interface Harness {
  readonly app: App;
  readonly calls: string[];
  /** POST /api/settings で送られた設定。 */
  readonly saved: Record<string, unknown>[];
  readonly timers: ReturnType<typeof createFakeTimers>;
  /** DOM を置き換えた回数(`createMounter` が replaceChildren を呼んだ回数)。 */
  replaced(): number;
  hash: string;
  visible: boolean;
  status: Record<string, unknown>;
  tree(): VNode;
  go(hash: string): void;
}

function harness(initialHash: string): Harness {
  const calls: string[] = [];
  const saved: Record<string, unknown>[] = [];
  const timers = createFakeTimers();
  let replaced = 0;
  let latest: VNode | null = null;
  const doc: DomDocument = { createElement: (tag) => new FakeElement(tag) as never, createTextNode: (t) => new FakeText(t) };
  const mounter = createMounter(doc, { replaceChildren: () => void (replaced += 1) });
  const fetchLike: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url === "/api/migration") return ok(h.status);
    if (url === "/api/settings" && init.method === "GET") return ok({ ok: true, settings: SERVER, source: "d1" });
    if (url === "/api/settings" && init.method === "POST") {
      const settings = JSON.parse(init.body as string) as Record<string, unknown>;
      saved.push(settings);
      return ok({ ok: true, settings });
    }
    throw new Error(`想定外の取得: ${init.method} ${url}`);
  };
  const h: Harness = {
    app: undefined as never,
    calls,
    saved,
    timers,
    replaced: () => replaced,
    hash: initialHash,
    visible: true,
    status: STATUS,
    tree: () => latest!,
    go: (hash) => {
      h.hash = hash;
      h.app.onHashChange();
    },
  };
  (h as { app: App }).app = createApp({
    fetch: fetchLike,
    now: () => new Date("2026-06-28T00:00:00Z"),
    render: (tree, force) => {
      latest = tree;
      mounter(tree, force);
    },
    getHash: () => h.hash,
    setHash: () => {},
    timers: { set: timers.set, clear: timers.clear },
    isVisible: () => h.visible,
  });
  return h;
}

describe("移行画面を開く", () => {
  it("#migration で始めると、GET /api/migration を 1 回だけ取る(一覧・板・設定・分析は取らない)。最初の描画は「読み込み中…」", async () => {
    const h = harness("#migration");
    h.app.start();
    expect(textOf(h.tree())).toContain("読み込み中…");
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/migration"]);
    expect(textOf(h.tree())).toContain("取り込みはまだ行われていません");
    expect(textOf(byClass(h.tree(), "title")[0]!)).toBe("exe から移行");
  });

  it("取り込み中の進捗が出て、10 秒ごとに更新される。画面を離れると止まる", async () => {
    const h = harness("#migration");
    h.status = { ...STATUS, state: "importing", upload: { size: 1, uploadedAt: "2026-10-09T01:02:03.000Z", exportedAt: null, appVersion: null }, analyses: { total: 10, processed: 4, imported: 4, alreadyImported: 0, conflicts: 0 }, results: { total: 2, processed: 0 } };
    h.app.start();
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("4 / 10");
    h.status = { ...(h.status as object), analyses: { total: 10, processed: 7, imported: 7, alreadyImported: 0, conflicts: 0 } } as Record<string, unknown>;
    await h.timers.advance(10_000);
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("7 / 10");
    expect(h.calls.length).toBe(2);
    h.go("#settings");
    await h.app.whenIdle();
    const callsAtLeave = h.calls.length;
    await h.timers.advance(300_000);
    expect(h.calls.filter((c) => c.includes("/api/migration")).length).toBe(2);
    expect(h.calls.length).toBe(callsAtLeave); // 設定画面の取得だけが増えた(移行は増えない)
  });

  it("「再読込」で取り直す(取得中は無視)", async () => {
    const h = harness("#migration");
    h.app.start();
    await h.app.whenIdle();
    byClass(h.tree(), "refresh")[0]!.on!.click!();
    byClass(h.tree(), "refresh")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/migration", "GET /api/migration"]);
  });

  it("表示が非表示になるとポーリングを止め、表示に戻ると即時に 1 回取る(app の onVisibilityChange が移行画面に届く)", async () => {
    const h = harness("#migration");
    h.status = { ...STATUS, state: "importing" };
    h.app.start();
    await h.app.whenIdle();
    h.visible = false;
    h.app.onVisibilityChange();
    await h.timers.advance(120_000);
    expect(h.calls.length).toBe(1);
    h.visible = true;
    h.app.onVisibilityChange();
    await h.app.whenIdle();
    expect(h.calls.length).toBe(2);
  });

  it("ファイルを選ぶと検証され、画面に件数が出る(file input の change が app を通って届く)", async () => {
    const h = harness("#migration");
    h.app.start();
    await h.app.whenIdle();
    const input = findAll(h.tree(), (n) => n.attrs?.["type"] === "file")[0]!;
    const file = Object.assign(new Blob([new Uint8Array(gzipSync(Buffer.from(FIXTURE)))]), { name: "m.ndjson.gz" }) as PickedFile;
    input.on!.file!(file);
    await h.app.whenIdle();
    expect(textOf(h.tree())).toContain("分析 5 件・結果 5 レース");
    expect(byClass(h.tree(), "migration-start")).toHaveLength(1);
  });
});

describe("設定画面との分離", () => {
  it("設定画面は /api/migration を取らず、「exe から移行」の節(リンク #migration)を出す", async () => {
    const h = harness("#settings");
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls).toEqual(["GET /api/settings"]);
    const section = byClass(h.tree(), "migration-section")[0]!;
    expect(findAll(section, (n) => n.tag === "a")[0]!.attrs?.["href"]).toBe("#migration");
  });

  it("設定画面で入力した下書きは、移行画面の裏の動き(ポーリング・可視状態の変化・遅れて届く応答)で消えない。DOM も置き換わらない", async () => {
    const h = harness("#migration");
    h.status = { ...STATUS, state: "importing" };
    h.app.start();
    await h.app.whenIdle();
    // 設定画面へ(移行の状態は破棄される)
    h.go("#settings");
    await h.app.whenIdle();
    const field = (key: string): VNode => findAll(h.tree(), (n) => n.attrs?.["data-field"] === key)[0]!;
    field("bankroll").on!.input!("123456");
    const replacedBefore = h.replaced();
    const callsBefore = h.calls.length;
    // 移行の裏の動き: 時間の経過(ポーリングのタイマー)・非表示/表示・同じハッシュの再通知
    await h.timers.advance(300_000);
    h.visible = false;
    h.app.onVisibilityChange();
    h.visible = true;
    h.app.onVisibilityChange();
    h.go("#settings");
    await h.app.whenIdle();
    expect(h.calls.length).toBe(callsBefore); // 移行の取得が一切起きていない
    expect(h.replaced()).toBe(replacedBefore); // DOM を置き換えていない(打っている欄が壊れない)
    // 保存すると、打った下書きの値が送られる(下書きが残っている)
    byClass(h.tree(), "settings-save")[0]!.on!.click!();
    await h.app.whenIdle();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!["bankroll"]).toBe(123456);
  });

  it("移行画面 → 設定画面 → 移行画面: 戻ると進捗を取り直す(離れている間の状態は持ち越さない)", async () => {
    const h = harness("#migration");
    h.app.start();
    await h.app.whenIdle();
    h.go("#settings");
    await h.app.whenIdle();
    h.status = { ...STATUS, state: "completed", upload: { size: 1, uploadedAt: "2026-10-09T01:02:03.000Z", exportedAt: null, appVersion: null } };
    h.go("#migration");
    await h.app.whenIdle();
    expect(h.calls.filter((c) => c === "GET /api/migration")).toHaveLength(2);
    expect(textOf(h.tree())).toContain("取り込みが完了しました");
  });

  it("一覧 → 移行画面でも、一覧・板を取らない", async () => {
    const h = harness("#migration");
    h.app.start();
    await h.app.whenIdle();
    expect(h.calls.every((c) => c === "GET /api/migration")).toBe(true);
  });
});
