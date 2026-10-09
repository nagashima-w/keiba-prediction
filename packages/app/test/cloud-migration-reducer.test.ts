import { describe, expect, it } from "vitest";

import {
  buildCloudMigrationSummaryText,
  cloudMigrationReducer,
  createInitialCloudMigrationState,
  formatFileSize,
  isCloudMigrationBusy,
} from "../src/renderer/cloud-migration-reducer.js";

/**
 * 設定画面「クラウドへの移行」の状態遷移と表示文(Issue #215・#167-A AC4)。
 * 画面(CloudMigrationSection.tsx)は dispatch の橋渡しだけで、遷移と文面はここ(純関数)で固定する。
 */

const SAVED = {
  status: "saved",
  filePath: "C:\\Users\\me\\keiba-cloud-migration-20261009.ndjson.gz",
  analysisCount: 1234,
  resultRaceCount: 567,
  fileBytes: 12_582_912,
} as const;

describe("状態遷移", () => {
  it("初期状態は待機中で、ボタンは押せる", () => {
    const s = createInitialCloudMigrationState();
    expect(s).toEqual({ status: "idle", saved: null, message: null });
    expect(isCloudMigrationBusy(s)).toBe(false);
  });

  it("書き出し開始 → 書き出し中(ボタン無効)。前回の結果・エラーは消える", () => {
    const failed = cloudMigrationReducer(createInitialCloudMigrationState(), { type: "書き出し失敗", message: "x" });
    const s = cloudMigrationReducer(failed, { type: "書き出し開始" });
    expect(s).toEqual({ status: "exporting", saved: null, message: null });
    expect(isCloudMigrationBusy(s)).toBe(true);
  });

  it("成功 → 保存先・件数・大きさを保持する", () => {
    const s = cloudMigrationReducer({ status: "exporting", saved: null, message: null }, { type: "書き出し成功", outcome: SAVED });
    expect(s).toEqual({ status: "saved", saved: SAVED, message: null });
    expect(isCloudMigrationBusy(s)).toBe(false);
  });

  it("キャンセル → 何も出さない待機に近い状態(キャンセルしたと分かる)で、前回の成功表示は残さない", () => {
    const saved = cloudMigrationReducer(createInitialCloudMigrationState(), { type: "書き出し成功", outcome: SAVED });
    const s = cloudMigrationReducer(cloudMigrationReducer(saved, { type: "書き出し開始" }), { type: "書き出しキャンセル" });
    expect(s).toEqual({ status: "canceled", saved: null, message: null });
    expect(isCloudMigrationBusy(s)).toBe(false);
  });

  it("失敗 → メッセージを保持し、ボタンは再び押せる", () => {
    const s = cloudMigrationReducer({ status: "exporting", saved: null, message: null }, { type: "書き出し失敗", message: "analysis_horses (analysis_id=1, umaban=2) の列 prior: …" });
    expect(s).toEqual({ status: "error", saved: null, message: "analysis_horses (analysis_id=1, umaban=2) の列 prior: …" });
    expect(isCloudMigrationBusy(s)).toBe(false);
  });

  it("成功の通知に canceled の結果を渡しても保存済みにはならない(型の取り違えの防御)", () => {
    const s = cloudMigrationReducer({ status: "exporting", saved: null, message: null }, { type: "書き出し成功", outcome: { status: "canceled" } as never });
    expect(s.status).toBe("canceled");
    expect(s.saved).toBeNull();
  });
});

describe("ファイルの大きさの表示(1024 区切り)", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [1024 * 1024 - 1, "1.0 MB"], // 丸めると 1024.0 KB になる境界は次の単位に繰り上げる
    [1024 * 1024, "1.0 MB"],
    [12_582_912, "12.0 MB"],
    [1024 ** 3, "1.0 GB"],
    [5 * 1024 ** 3 + 512 * 1024 ** 2, "5.5 GB"],
  ])("%d バイト → %s", (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});

describe("完了時の表示文", () => {
  it("分析の件数・結果のレース数・ファイルの大きさ・保存先を含む(千区切り)", () => {
    const text = buildCloudMigrationSummaryText(SAVED);
    expect(text).toContain("分析 1,234 件");
    expect(text).toContain("結果 567 レース");
    expect(text).toContain("12.0 MB");
    expect(text).toContain(SAVED.filePath);
  });

  it("0 件でも崩れない", () => {
    const text = buildCloudMigrationSummaryText({ ...SAVED, analysisCount: 0, resultRaceCount: 0, fileBytes: 100 });
    expect(text).toContain("分析 0 件");
    expect(text).toContain("結果 0 レース");
    expect(text).toContain("100 B");
  });
});
