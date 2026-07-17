/**
 * ログ保存先パス計算(main/log-paths.ts)の純関数テスト。Task#35。
 *
 * userData配下にログを集約する(Task#36がログフォルダを開く・エクスポート導線を追加する前提のため、
 * パス計算をelectron非依存の純関数として切り出し、後続タスクから参照しやすくする)。
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { logDirectoryFromUserData } from "../src/main/log-paths.js";

// 期待値は node:path の join/sep で組み立てる(実装側もネイティブのセパレータで
// パスを返すため、期待値をPOSIX形式で固定するとWindows実行時に一致しなくなる)。
const userDataPath = path.join(path.sep, "home", "user", ".config", "keiba-ev-tool");

describe("logDirectoryFromUserData(userDataパスからログディレクトリを導出する)", () => {
  it("userDataパス配下の logs ディレクトリを返す", () => {
    expect(logDirectoryFromUserData(userDataPath)).toBe(path.join(userDataPath, "logs"));
  });

  it("末尾にセパレータが付いていても正しく結合する", () => {
    expect(logDirectoryFromUserData(`${userDataPath}${path.sep}`)).toBe(
      path.join(userDataPath, "logs"),
    );
  });

  it("空文字のuserDataパスでも例外を投げず logs を返す(境界値)", () => {
    expect(logDirectoryFromUserData("")).toBe("logs");
  });
});
