/**
 * ログ保存先パス計算(main/log-paths.ts)の純関数テスト。Task#35。
 *
 * userData配下にログを集約する(Task#36がログフォルダを開く・エクスポート導線を追加する前提のため、
 * パス計算をelectron非依存の純関数として切り出し、後続タスクから参照しやすくする)。
 */

import { describe, expect, it } from "vitest";

import { logDirectoryFromUserData } from "../src/main/log-paths.js";

describe("logDirectoryFromUserData(userDataパスからログディレクトリを導出する)", () => {
  it("userDataパス配下の logs ディレクトリを返す", () => {
    expect(logDirectoryFromUserData("/home/user/.config/keiba-ev-tool")).toBe(
      "/home/user/.config/keiba-ev-tool/logs",
    );
  });

  it("末尾にセパレータが付いていても正しく結合する", () => {
    expect(logDirectoryFromUserData("/home/user/.config/keiba-ev-tool/")).toBe(
      "/home/user/.config/keiba-ev-tool/logs",
    );
  });

  it("空文字のuserDataパスでも例外を投げず logs を返す(境界値)", () => {
    expect(logDirectoryFromUserData("")).toBe("logs");
  });
});
