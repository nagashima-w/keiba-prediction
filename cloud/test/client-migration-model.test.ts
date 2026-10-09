import { describe, expect, it } from "vitest";
import type { MigrationProgress } from "../client/api-migration";
import { buildMigrationModel, MIGRATION_SETTINGS_SECTION, type MigrationModelInput } from "../client/migration-model";

/**
 * Issue #222(#167-B2): 移行画面の表示用データ(純関数)。状態ごとの文言・ボタンの有効/無効・JST の再開時刻・衝突・失敗の理由。
 * 守ること:
 *  - 説明文に、何を移すか・数日に分けて自動で取り込まれること・同じファイルを再度上げても重複しないことが入る(設定画面の節にも要点が入る)
 *  - 取り込み中(verifying・importing・waiting-*)は、ファイルを選ばせず・始められない。終端(idle・completed・failed)は選べる
 *  - サーバ由来の文(failure.message・conflictSamples)は長さを切り詰める
 */

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
const WORKING: MigrationProgress = {
  ...IDLE,
  state: "importing",
  upload: UPLOAD,
  analyses: { total: 2225, processed: 1000, imported: 900, alreadyImported: 90, conflicts: 10 },
  results: { total: 1301, processed: 0 },
  budget: { day: "20261009", usedRows: 12345, limitRows: 60000 },
};
const OK_SUMMARY = { analyses: 2225, results: 1301, exportedAt: "2026-10-08T00:00:00.000Z", appVersion: "1.27.0", lines: 3528, inflatedBytes: 150_000_000 };

function input(over: Partial<MigrationModelInput> = {}): MigrationModelInput {
  return { load: { kind: "ready", progress: IDLE }, file: null, check: { kind: "idle" }, upload: { kind: "idle" }, pollStopped: false, ...over };
}
const joined = (lines: readonly string[]): string => lines.join("\n");

describe("buildMigrationModel: 説明文", () => {
  it("何を移すか・数日に分けて自動で取り込まれること・同じファイルを再度上げても重複しないこと・サーバでの検証に落ちうることを書く", () => {
    const text = joined(buildMigrationModel(input()).intro);
    expect(text).toContain("分析");
    expect(text).toContain("結果");
    expect(text).toContain("数日");
    expect(text).toContain("自動");
    expect(text).toContain("重複しません");
    expect(text).toContain("サーバ");
  });

  it("設定画面の節は、見出し・要点(移すもの・数日に分けて自動・重複しない)・移行の画面へのリンク(#migration)を持つ", () => {
    expect(MIGRATION_SETTINGS_SECTION.heading).toBe("exe から移行");
    const text = joined(MIGRATION_SETTINGS_SECTION.lines);
    expect(text).toContain("分析");
    expect(text).toContain("数日");
    expect(text).toContain("重複しません");
    expect(MIGRATION_SETTINGS_SECTION.href).toBe("#migration");
    expect(MIGRATION_SETTINGS_SECTION.linkLabel.length).toBeGreaterThan(0);
  });
});

describe("buildMigrationModel: 進捗の取得の状態", () => {
  it("取得中は loading で、ファイルを選ばせない・始められない", () => {
    const m = buildMigrationModel(input({ load: { kind: "loading" } }));
    expect(m.loading).toBe(true);
    expect(m.progress).toBeNull();
    expect(m.canPick).toBe(false);
    expect(m.reloadDisabled).toBe(true);
  });

  it("取得に失敗したら、理由(固定の文言)を出し、ファイルを選ばせない(状態が分からない間は始めさせない)。再読込はできる", () => {
    const m = buildMigrationModel(input({ load: { kind: "error", message: "進捗を取得できませんでした。" } }));
    expect(m.error).toBe("進捗を取得できませんでした。");
    expect(m.canPick).toBe(false);
    expect(m.reloadDisabled).toBe(false);
  });

  it("自動更新を止めたときは、その旨と「再読込」の案内を出す", () => {
    const m = buildMigrationModel(input({ load: { kind: "ready", progress: WORKING }, pollStopped: true }));
    expect(m.pollNotice).toContain("再読込");
    expect(buildMigrationModel(input({ load: { kind: "ready", progress: WORKING } })).pollNotice).toBeNull();
  });
});

describe("buildMigrationModel: 状態ごとの進捗の表示", () => {
  it("idle: 取り込みはまだ行われていない。件数は出さない", () => {
    const m = buildMigrationModel(input());
    expect(m.progress!.headline).toContain("まだ");
    expect(m.progress!.bar).toBeNull();
    expect(m.progress!.lines).toEqual([]);
  });

  it("verifying: サーバで検証中(件数の全体はまだ無い)", () => {
    const m = buildMigrationModel(input({ load: { kind: "ready", progress: { ...IDLE, state: "verifying", upload: UPLOAD } } }));
    expect(m.progress!.headline).toContain("検証");
    expect(m.progress!.bar).toBeNull();
  });

  it("importing: 取り込んだ分析/結果の件数と全体・新規/取り込み済み/衝突の内訳を出し、進捗バーは (分析+結果の処理済み) / (分析+結果の全体)", () => {
    const m = buildMigrationModel(input({ load: { kind: "ready", progress: WORKING } }));
    const text = joined(m.progress!.lines);
    expect(m.progress!.headline).toContain("取り込み中");
    expect(text).toContain("分析: 1,000 / 2,225 件");
    expect(text).toContain("新規 900");
    expect(text).toContain("取り込み済み 90");
    expect(text).toContain("衝突 10");
    expect(text).toContain("結果: 0 / 1,301 レース");
    expect(text).toContain("12,345 / 60,000");
    expect(m.progress!.bar).toEqual({ value: 1000, max: 3526 });
  });

  it("importing でエラーが続いている(attempts>0)ときは、自動で再試行する旨と回数", () => {
    const m = buildMigrationModel(input({ load: { kind: "ready", progress: { ...WORKING, attempts: 2 } } }));
    expect(joined(m.progress!.lines)).toContain("連続 2 回");
    expect(joined(buildMigrationModel(input({ load: { kind: "ready", progress: WORKING } })).progress!.lines)).not.toContain("連続");
  });

  it("waiting-budget: 再開時刻を JST で出す(UTC 2026-10-10 00:05 → JST 2026-10-10 09:05)", () => {
    const m = buildMigrationModel(input({ load: { kind: "ready", progress: { ...WORKING, state: "waiting-budget", resumeAt: "2026-10-10T00:05:00.000Z" } } }));
    expect(m.progress!.headline).toContain("上限");
    expect(m.progress!.headline).toContain("2026-10-10 09:05");
    expect(m.progress!.headline).toContain("JST");
    expect(m.progress!.headline).toContain("自動");
  });

  it("waiting-r2: R2 の上限のため止まっている旨と、再開時刻(JST)", () => {
    const m = buildMigrationModel(input({ load: { kind: "ready", progress: { ...WORKING, state: "waiting-r2", resumeAt: "2026-11-01T00:05:00.000Z" } } }));
    expect(m.progress!.headline).toContain("R2");
    expect(m.progress!.headline).toContain("2026-11-01 09:05");
  });

  it("waiting 系で再開時刻が無い(null)ときも壊れない(時刻を出さず、自動で再開する旨)", () => {
    const m = buildMigrationModel(input({ load: { kind: "ready", progress: { ...WORKING, state: "waiting-budget", resumeAt: null } } }));
    expect(m.progress!.headline).toContain("自動");
    expect(m.progress!.headline).not.toContain("JST");
  });

  it("completed: 完了。衝突が無ければ衝突の注記は出ない", () => {
    const done: MigrationProgress = { ...WORKING, state: "completed", analyses: { total: 2225, processed: 2225, imported: 2225, alreadyImported: 0, conflicts: 0 }, results: { total: 1301, processed: 1301 } };
    const m = buildMigrationModel(input({ load: { kind: "ready", progress: done } }));
    expect(m.progress!.headline).toContain("完了");
    expect(m.progress!.conflicts).toBeNull();
    expect(m.progress!.bar).toEqual({ value: 3526, max: 3526 });
  });

  it("全体が 0 件(分析も結果も無いファイル)の完了では、進捗バーを出さない(割合が定義できない)。処理済みが全体を超えて報告されても、バーは全体で頭打ち", () => {
    const empty: MigrationProgress = { ...IDLE, state: "completed", upload: UPLOAD, analyses: { total: 0, processed: 0, imported: 0, alreadyImported: 0, conflicts: 0 }, results: { total: 0, processed: 0 } };
    expect(buildMigrationModel(input({ load: { kind: "ready", progress: empty } })).progress!.bar).toBeNull();
    const over: MigrationProgress = { ...WORKING, analyses: { ...WORKING.analyses, processed: 3000 } };
    expect(buildMigrationModel(input({ load: { kind: "ready", progress: over } })).progress!.bar).toEqual({ value: 3000, max: 3526 });
    const overall: MigrationProgress = { ...WORKING, analyses: { ...WORKING.analyses, processed: 4000 } };
    expect(buildMigrationModel(input({ load: { kind: "ready", progress: overall } })).progress!.bar).toEqual({ value: 3526, max: 3526 });
  });

  it("completed で衝突があれば、件数と例(最大 5 件・各 120 文字まで)を出す", () => {
    const long = "x".repeat(500);
    const done: MigrationProgress = { ...WORKING, state: "completed", analyses: { total: 2225, processed: 2225, imported: 2200, alreadyImported: 15, conflicts: 10 }, conflictSamples: ["a1", "a2", long] };
    const c = buildMigrationModel(input({ load: { kind: "ready", progress: done } })).progress!.conflicts!;
    expect(c.text).toContain("10 件");
    expect(c.samples).toHaveLength(3);
    expect(c.samples[2]!.length).toBeLessThanOrEqual(121);
    expect(c.samples[2]!.endsWith("…")).toBe(true);
  });

  it("failed(検証): 何も取り込まれていない旨と、理由(サーバの固定の文言)を出す。理由は 300 文字までに切り詰める", () => {
    const failed: MigrationProgress = { ...IDLE, state: "failed", upload: UPLOAD, failure: { phase: "verify", message: `3 行目: ${"あ".repeat(600)}` } };
    const f = buildMigrationModel(input({ load: { kind: "ready", progress: failed } })).progress!.failure!;
    expect(f.heading).toContain("検証");
    expect(f.heading).toContain("何も");
    expect(f.reason.length).toBeLessThanOrEqual(301);
    expect(f.reason.startsWith("3 行目")).toBe(true);
    expect(f.reason.endsWith("…")).toBe(true);
  });

  it("failed(取り込み): 途中まで取り込まれていること・再度アップロードすると続きから進むことを出す", () => {
    const failed: MigrationProgress = { ...WORKING, state: "failed", failure: { phase: "import", message: "エラーが続いたため止めました(Error)。" } };
    const f = buildMigrationModel(input({ load: { kind: "ready", progress: failed } })).progress!.failure!;
    expect(f.heading).toContain("取り込み");
    expect(f.hint).toContain("続きから");
    expect(f.reason).toBe("エラーが続いたため止めました(Error)。");
  });

  it("アップロード日時・書き出し日時(JST)・exe の版を出す", () => {
    const text = joined(buildMigrationModel(input({ load: { kind: "ready", progress: WORKING } })).progress!.lines);
    expect(text).toContain("2026-10-09 10:02");
    expect(text).toContain("2026-10-08 09:00");
    expect(text).toContain("1.27.0");
  });
});

describe("buildMigrationModel: ファイルの選択・検証・開始", () => {
  const file = { name: "keiba-cloud-migration.ndjson.gz", size: 14_900_000 };

  it("終端の状態(idle・completed・failed)では、ファイルを選べる。取り込み中の 4 状態では選べず、選べない理由を出す", () => {
    for (const state of ["idle", "completed", "failed"] as const) {
      expect(buildMigrationModel(input({ load: { kind: "ready", progress: { ...IDLE, state } } })).canPick, state).toBe(true);
    }
    for (const state of ["verifying", "importing", "waiting-budget", "waiting-r2"] as const) {
      const m = buildMigrationModel(input({ load: { kind: "ready", progress: { ...WORKING, state } } }));
      expect(m.canPick, state).toBe(false);
      expect(m.pickNote, state).toContain("取り込み中");
    }
  });

  it("ファイルを選んだら、名前と大きさ(MB)を出す", () => {
    const m = buildMigrationModel(input({ file }));
    expect(m.file).toEqual({ name: "keiba-cloud-migration.ndjson.gz", sizeText: "14.9 MB" });
  });

  it("検証中: 進捗(%)と読んだ行数を出し、取り消しボタンがあり、選び直し・開始はできない", () => {
    const m = buildMigrationModel(input({ file, check: { kind: "checking", percent: 42, lines: 1234 } }));
    expect(m.check!.tone).toBe("info");
    expect(joined(m.check!.lines)).toContain("検証中");
    expect(joined(m.check!.lines)).toContain("42%");
    expect(joined(m.check!.lines)).toContain("1,234");
    expect(m.check!.bar).toEqual({ value: 42, max: 100 });
    expect(m.canPick).toBe(false);
    expect(m.canCancelCheck).toBe(true);
    expect(m.start.visible).toBe(false);
  });

  it("検証に成功: 分析の件数・結果のレース数・書き出し日時を表示し、「取り込みを始める」が有効", () => {
    const m = buildMigrationModel(input({ file, check: { kind: "ok", summary: OK_SUMMARY } }));
    expect(m.check!.tone).toBe("ok");
    const text = joined(m.check!.lines);
    expect(text).toContain("分析 2,225 件");
    expect(text).toContain("結果 1,301 レース");
    expect(text).toContain("2026-10-08 09:00");
    expect(m.start).toEqual({ visible: true, enabled: true, label: "取り込みを始める" });
    expect(m.canPick).toBe(true);
  });

  it("検証に失敗: 理由を出し、アップロードしない旨。開始ボタンは出ない。選び直しはできる", () => {
    const m = buildMigrationModel(input({ file, check: { kind: "invalid", message: "3 行目: JSON として読めない" } }));
    expect(m.check!.tone).toBe("error");
    expect(joined(m.check!.lines)).toContain("3 行目: JSON として読めない");
    expect(joined(m.check!.lines)).toContain("アップロードしません");
    expect(m.start.visible).toBe(false);
    expect(m.canPick).toBe(true);
  });

  it("検証失敗の理由は 300 文字までに切り詰める", () => {
    const m = buildMigrationModel(input({ file, check: { kind: "invalid", message: "あ".repeat(900) } }));
    expect(joined(m.check!.lines).length).toBeLessThan(500);
  });

  it("検証に成功していても、サーバが取り込み中(別のタブからなど)なら開始は無効で、理由を出す", () => {
    const m = buildMigrationModel(input({ load: { kind: "ready", progress: WORKING }, file, check: { kind: "ok", summary: OK_SUMMARY } }));
    expect(m.start.visible).toBe(true);
    expect(m.start.enabled).toBe(false);
    expect(m.pickNote).toContain("取り込み中");
  });

  it("アップロード中: ボタンは「アップロード中…」で無効、ファイルは選べない", () => {
    const m = buildMigrationModel(input({ file, check: { kind: "ok", summary: OK_SUMMARY }, upload: { kind: "sending" } }));
    expect(m.start).toEqual({ visible: true, enabled: false, label: "アップロード中…" });
    expect(m.canPick).toBe(false);
  });

  it("アップロードの失敗は error の通知として出し、検証済みのファイルはそのまま再試行できる", () => {
    const m = buildMigrationModel(input({ file, check: { kind: "ok", summary: OK_SUMMARY }, upload: { kind: "error", message: "取り込み中のため…" } }));
    expect(m.uploadNotice).toEqual({ tone: "error", text: "取り込み中のため…" });
    expect(m.start.enabled).toBe(true);
  });

  it("アップロードを受け付けた(sent)ときの通知", () => {
    const m = buildMigrationModel(input({ upload: { kind: "sent" } }));
    expect(m.uploadNotice!.tone).toBe("ok");
    expect(m.uploadNotice!.text).toContain("アップロードしました");
  });
});
