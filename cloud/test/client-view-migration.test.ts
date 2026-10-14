import { describe, expect, it } from "vitest";
import type { MigrationProgress } from "../client/api-migration";
import { mount, type DomDocument } from "../client/dom";
import { buildMigrationModel, type MigrationModelInput } from "../client/migration-model";
import { buildSettingsModel, draftFromSettings } from "../client/settings-form";
import { renderScreen, type ViewActions } from "../client/view";
import type { PickedFile, VNode } from "../client/vnode";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { noopActions } from "./client-fakes";

/**
 * Issue #222(#167-B2): 移行画面の VNode と、設定画面の「exe から移行」の節。モデル(`client-migration-model.test.ts`)→ VNode の写し間違い、
 * 許可リスト(`dom.ts`)を通ること、ボタン・ファイル選択が動作に繋がること(アクションが呼ばれる)。
 */

function findAll(node: VNode | string, pred: (n: VNode) => boolean): VNode[] {
  if (typeof node === "string") return [];
  return [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))];
}
const byClass = (tree: VNode, cls: string): VNode[] => findAll(tree, (n) => String(n.attrs?.["class"] ?? "").split(" ").includes(cls));
const byTag = (tree: VNode, tag: string): VNode[] => findAll(tree, (n) => n.tag === tag);
const textOf = (node: VNode | string): string => (typeof node === "string" ? node : (node.children ?? []).map(textOf).join(" "));

function mountAll(tree: VNode): void {
  const doc: DomDocument = {
    createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }),
    createTextNode: () => ({}),
  };
  mount(doc, { replaceChildren() {} }, tree);
}

const IDLE: MigrationProgress = {
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
const UPLOAD = { size: 15_000_000, uploadedAt: "2026-10-09T01:02:03.000Z", exportedAt: "2026-10-08T00:00:00.000Z", appVersion: "1.27.0" };
const WORKING: MigrationProgress = { ...IDLE, state: "importing", upload: UPLOAD, analyses: { total: 2225, processed: 1000, imported: 1000, alreadyImported: 0, conflicts: 0 }, results: { total: 1301, processed: 0 } };
const SUMMARY = { analyses: 2225, results: 1301, exportedAt: "2026-10-08T00:00:00.000Z", appVersion: "1.27.0", lines: 3528, inflatedBytes: 150_000_000 };
const input = (over: Partial<MigrationModelInput> = {}): MigrationModelInput => ({ load: { kind: "ready", progress: IDLE }, file: null, check: { kind: "idle" }, upload: { kind: "idle" }, pollStopped: false, ...over });
const tree = (over: Partial<MigrationModelInput> = {}, actions: ViewActions = noopActions): VNode => renderScreen(buildMigrationModel(input(over)), actions);
const FILE = { name: "keiba.ndjson.gz", size: 14_900_000 };

describe("移行画面の VNode", () => {
  it("許可リスト(dom.ts)の範囲で組める(状態ごと。progress・file input を含む)", () => {
    const cases: Partial<MigrationModelInput>[] = [
      {},
      { load: { kind: "loading" } },
      { load: { kind: "error", message: "失敗" } },
      { load: { kind: "ready", progress: WORKING } },
      { load: { kind: "ready", progress: { ...WORKING, state: "completed", analyses: { ...WORKING.analyses, conflicts: 3 }, conflictSamples: ["a", "b"] } } },
      { load: { kind: "ready", progress: { ...WORKING, state: "failed", failure: { phase: "import", message: "m" } } } },
      { file: FILE, check: { kind: "checking", percent: 10, lines: 5 } },
      { file: FILE, check: { kind: "ok", summary: SUMMARY } },
      { file: FILE, check: { kind: "invalid", message: "壊れている" } },
      { file: FILE, check: { kind: "ok", summary: SUMMARY }, upload: { kind: "sending" } },
      { upload: { kind: "error", message: "失敗" } },
      { upload: { kind: "sent" }, pollStopped: true },
    ];
    for (const c of cases) expect(() => mountAll(tree(c)), JSON.stringify(c)).not.toThrow();
  });

  it("見出し「exe から移行」・設定画面へ戻るリンク(#settings)・再読込ボタン・説明文(model.intro のすべて)を出す", () => {
    const t = tree();
    expect(textOf(byClass(t, "title")[0]!)).toBe("exe から移行");
    const back = byClass(t, "back")[0]!;
    expect(back.attrs?.["href"]).toBe("#settings");
    const intro = buildMigrationModel(input()).intro;
    for (const p of intro) expect(textOf(t)).toContain(p);
  });

  it("再読込ボタンは onRefresh に繋がり、取得中は無効", () => {
    let refreshed = 0;
    const t = tree({}, { ...noopActions, onRefresh: () => (refreshed += 1) });
    byClass(t, "refresh")[0]!.on!.click!();
    expect(refreshed).toBe(1);
    expect(byClass(tree({ load: { kind: "loading" } }), "refresh")[0]!.attrs?.["disabled"]).toBe(true);
  });

  it("ファイル選択は input type=file(accept 付き)で、選択が onMigrationFile に繋がる。選べない状態では出さない", () => {
    const got: unknown[] = [];
    const t = tree({}, { ...noopActions, onMigrationFile: (f) => got.push(f) });
    const picker = byTag(t, "input").filter((n) => n.attrs?.["type"] === "file");
    expect(picker).toHaveLength(1);
    expect(picker[0]!.attrs?.["accept"]).toBe(".gz,application/gzip,application/x-gzip");
    const file = { name: "a.gz" } as PickedFile;
    picker[0]!.on!.file!(file);
    expect(got).toEqual([file]);
    for (const over of [{ load: { kind: "ready", progress: WORKING } }, { load: { kind: "loading" } }, { file: FILE, check: { kind: "checking", percent: 1, lines: 1 } }] as Partial<MigrationModelInput>[]) {
      expect(byTag(tree(over), "input").filter((n) => n.attrs?.["type"] === "file"), JSON.stringify(over)).toHaveLength(0);
    }
  });

  it("取り込み中は、選べない理由(取り込み中)を出す", () => {
    expect(textOf(tree({ load: { kind: "ready", progress: WORKING } }))).toContain("取り込み中のため、ファイルは選べません");
  });

  it("進捗: 取り込み中は progress 要素(value=処理済み・max=全体)と件数の行を出す。全体が分からない間は progress を出さない", () => {
    const t = tree({ load: { kind: "ready", progress: WORKING } });
    const bars = byTag(t, "progress");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.attrs).toMatchObject({ value: "1000", max: "3526" });
    expect(textOf(t)).toContain("分析: 1,000 / 2,225 件");
    expect(byTag(tree(), "progress")).toHaveLength(0);
  });

  it("進捗: 予算待ちの再開時刻(JST)が見出しに出る", () => {
    const t = tree({ load: { kind: "ready", progress: { ...WORKING, state: "waiting-budget", resumeAt: "2026-10-10T00:05:00.000Z" } } });
    expect(textOf(t)).toContain("2026-10-10 09:05");
  });

  it("進捗: 完了+衝突は件数と例、失敗は理由と対処を出し、失敗は role=alert", () => {
    const done = tree({ load: { kind: "ready", progress: { ...WORKING, state: "completed", analyses: { total: 5, processed: 5, imported: 3, alreadyImported: 0, conflicts: 2 }, results: { total: 0, processed: 0 }, conflictSamples: ["analysis.id=7 の衝突"] } } });
    expect(textOf(done)).toContain("衝突 2 件");
    expect(textOf(done)).toContain("analysis.id=7 の衝突");
    const failed = tree({ load: { kind: "ready", progress: { ...WORKING, state: "failed", failure: { phase: "verify", message: "3 行目: 未知の列 x がある" } } } });
    expect(textOf(failed)).toContain("3 行目: 未知の列 x がある");
    expect(byTag(failed, "p").some((p) => p.attrs?.["role"] === "alert" && textOf(p).includes("3 行目"))).toBe(true);
  });

  it("検証: 検証中は progress と取り消しボタン(onMigrationCancelCheck)、成功は件数、失敗は理由(role=alert)", () => {
    let cancelled = 0;
    const checking = tree({ file: FILE, check: { kind: "checking", percent: 42, lines: 10 } }, { ...noopActions, onMigrationCancelCheck: () => (cancelled += 1) });
    expect(byTag(checking, "progress")[0]!.attrs).toMatchObject({ value: "42", max: "100" });
    const cancel = byClass(checking, "migration-cancel")[0]!;
    cancel.on!.click!();
    expect(cancelled).toBe(1);
    const ok = tree({ file: FILE, check: { kind: "ok", summary: SUMMARY } });
    expect(textOf(ok)).toContain("分析 2,225 件・結果 1,301 レース");
    expect(textOf(ok)).toContain("keiba.ndjson.gz");
    const bad = tree({ file: FILE, check: { kind: "invalid", message: "3 行目: JSON として読めない" } });
    expect(byTag(bad, "p").some((p) => p.attrs?.["role"] === "alert" && textOf(p).includes("3 行目: JSON として読めない"))).toBe(true);
  });

  it("開始ボタン: 検証成功で出て、押すと onMigrationStart。アップロード中は無効で「アップロード中…」。検証失敗・未選択では出ない", () => {
    let started = 0;
    const actions = { ...noopActions, onMigrationStart: () => (started += 1) };
    const ready = byClass(tree({ file: FILE, check: { kind: "ok", summary: SUMMARY } }, actions), "migration-start");
    expect(ready).toHaveLength(1);
    expect(ready[0]!.attrs?.["disabled"]).toBeFalsy();
    ready[0]!.on!.click!();
    expect(started).toBe(1);
    const sending = byClass(tree({ file: FILE, check: { kind: "ok", summary: SUMMARY }, upload: { kind: "sending" } }), "migration-start")[0]!;
    expect(sending.attrs?.["disabled"]).toBe(true);
    expect(textOf(sending)).toBe("アップロード中…");
    expect(byClass(tree({ file: FILE, check: { kind: "invalid", message: "x" } }), "migration-start")).toHaveLength(0);
    expect(byClass(tree(), "migration-start")).toHaveLength(0);
  });

  it("アップロードの通知: 失敗は role=alert、受け付けは通常の通知。自動更新の停止の注記も出る", () => {
    const err = tree({ upload: { kind: "error", message: "アップロードの失敗の文言" } });
    expect(byTag(err, "p").some((p) => p.attrs?.["role"] === "alert" && textOf(p).includes("アップロードの失敗の文言"))).toBe(true);
    expect(textOf(tree({ upload: { kind: "sent" } }))).toContain("アップロードしました");
    expect(textOf(tree({ load: { kind: "ready", progress: WORKING }, pollStopped: true }))).toContain("自動更新を止めました");
  });

  it("外から来た文字列(失敗の理由・衝突の例・ファイル名)はテキストノードとして入り、HTML として解釈される要素にならない", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const t = tree({
      load: { kind: "ready", progress: { ...WORKING, state: "failed", failure: { phase: "verify", message: evil }, conflictSamples: [evil] } },
      file: { name: evil, size: 10 },
    });
    expect(byTag(t, "img")).toHaveLength(0);
    expect(textOf(t)).toContain(evil);
  });
});

describe("設定画面の「exe から移行」の節", () => {
  const settings = (load: "ready" | "error"): VNode =>
    renderScreen(
      buildSettingsModel(load === "ready" ? { load: { kind: "ready", source: "d1" }, draft: draftFromSettings(DEFAULT_CLOUD_SETTINGS), errors: {}, save: { kind: "idle" } } : { load: { kind: "error", message: "取得に失敗" }, draft: null, errors: {}, save: { kind: "idle" } }),
      noopActions,
    );

  it("見出し「exe から移行」・要点の説明・移行の画面へのリンク(#migration)がある。設定の取得に失敗していても出る", () => {
    for (const load of ["ready", "error"] as const) {
      const section = byClass(settings(load), "migration-section");
      expect(section, load).toHaveLength(1);
      const text = textOf(section[0]!);
      expect(text).toContain("exe から移行");
      expect(text).toContain("数日に分けて自動");
      expect(text).toContain("重複しません");
      const link = byTag(section[0]!, "a")[0]!;
      expect(link.attrs?.["href"]).toBe("#migration");
      expect(textOf(link)).toBe("移行の画面を開く");
    }
  });

  it("許可リストの範囲で組める", () => {
    expect(() => mountAll(settings("ready"))).not.toThrow();
    expect(() => mountAll(settings("error"))).not.toThrow();
  });
});

// ---- Issue #217(#167-C): 結果の補完の 1 行 ----

describe("移行画面の VNode: 結果の補完(Issue #217)", () => {
  const COMPLETED: MigrationProgress = { ...WORKING, state: "completed" };
  const BACKFILL = { state: "ready", remaining: 321, undated: 0, imported: 100, abandoned: 4 } as const;
  const withBackfill = (backfill: Parameters<typeof buildMigrationModel>[0]["backfill"], progress: MigrationProgress = COMPLETED): VNode => tree({ load: { kind: "ready", progress }, backfill });

  it("移行が完了していて補完の進捗があれば、進捗の下に 1 つの節(notice)で出す。モデルの文言そのまま", () => {
    const t = withBackfill(BACKFILL);
    const sections = byClass(t, "migration-backfill");
    expect(sections).toHaveLength(1);
    const model = buildMigrationModel(input({ load: { kind: "ready", progress: COMPLETED }, backfill: BACKFILL }));
    expect(model.backfill).not.toBeNull();
    expect(textOf(sections[0]!)).toContain(model.backfill!.text);
    expect(textOf(sections[0]!)).toContain("残り 321 レース");
    // 進捗の節より後ろ
    expect(textOf(t).indexOf("取り込みの進捗")).toBeLessThan(textOf(t).indexOf("結果の補完"));
  });

  it("出さない: 補完の進捗が無い・移行が完了していない", () => {
    expect(byClass(withBackfill(null), "migration-backfill")).toHaveLength(0);
    expect(byClass(withBackfill(BACKFILL, WORKING), "migration-backfill")).toHaveLength(0);
    expect(byClass(tree(), "migration-backfill")).toHaveLength(0);
  });

  it("開催日不明の注記は、あるときだけ補足(meta)として足す。状態 paused は wait の通知", () => {
    expect(byClass(withBackfill({ ...BACKFILL, undated: 12 }), "migration-backfill")[0]!.children).toHaveLength(2);
    expect(textOf(byClass(withBackfill({ ...BACKFILL, undated: 12 }), "migration-backfill")[0]!)).toContain("12 件");
    expect(byClass(withBackfill(BACKFILL), "migration-backfill")[0]!.children).toHaveLength(1);
    const paused = byClass(withBackfill({ ...BACKFILL, state: "paused" }), "migration-backfill")[0]!;
    expect(textOf(paused)).toContain("一時停止");
    expect(byClass(paused, "wait").length + byClass(paused, "notice").length).toBeGreaterThan(0);
  });

  it("許可リスト(dom.ts)の範囲で組める(補完の全 6 状態 + 開催日不明の注記)", () => {
    const states = ["disabled", "ready", "running", "paused", "waiting-window", "done"] as const;
    expect(states).toHaveLength(6);
    for (const state of states) expect(() => mountAll(withBackfill({ ...BACKFILL, state, undated: 3 })), state).not.toThrow();
  });
});
