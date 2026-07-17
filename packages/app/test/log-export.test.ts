/**
 * ログエクスポート(main/log-export.ts)の純関数テスト。Task#36 ログ取り出し導線。
 *
 * 「最新ログをエクスポート」は現行ログ(main.log)とローテーション済みログ(main.old.log、
 * 存在すれば)を1ファイルに古い→新しいの順で集約する。集約ロジック自体は文字列のみを扱う
 * 純関数(aggregateLogContents)として切り出し、実ファイルアクセスは薄いIO層に分離する
 * (実FSアクセスはテンポラリディレクトリを使う。実サイトへのアクセスは発生しない)。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aggregateLogContents,
  buildDefaultLogExportFileName,
  collectLogExportContent,
  readLogFileIfExists,
  resolveLogExportPaths,
} from "../src/main/log-export.js";

describe("aggregateLogContents(ログ本文の集約)", () => {
  it("旧ログ・現行ログの両方が無ければ空文字を返す", () => {
    expect(aggregateLogContents(null, null)).toBe("");
  });

  it("現行ログのみあればそのまま返す", () => {
    expect(aggregateLogContents(null, "current-line")).toBe("current-line");
  });

  it("旧ログのみあればそのまま返す(通常は起こらないが安全側の挙動として)", () => {
    expect(aggregateLogContents("old-line", null)).toBe("old-line");
  });

  it("両方あれば古い→新しいの順(old が先)で連結する", () => {
    expect(aggregateLogContents("old-line", "current-line")).toBe(
      "old-line\ncurrent-line",
    );
  });

  it("空文字は「無い」として扱い、余分な区切りを作らない", () => {
    expect(aggregateLogContents("", "current-line")).toBe("current-line");
    expect(aggregateLogContents("old-line", "")).toBe("old-line");
  });
});

describe("resolveLogExportPaths(ログディレクトリ配下のファイルパス解決)", () => {
  it("main.log と main.old.log の絶対パスを組み立てる", () => {
    const { oldLogPath, currentLogPath } = resolveLogExportPaths("/tmp/logs");
    expect(currentLogPath).toBe(path.join("/tmp/logs", "main.log"));
    expect(oldLogPath).toBe(path.join("/tmp/logs", "main.old.log"));
  });
});

describe("readLogFileIfExists(存在すれば読み込む薄いIO層)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "keiba-log-export-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("存在するファイルの内容を返す", () => {
    const filePath = path.join(tempDir, "main.log");
    writeFileSync(filePath, "hello", "utf8");
    expect(readLogFileIfExists(filePath)).toBe("hello");
  });

  it("存在しないファイルは例外を投げず null を返す", () => {
    const filePath = path.join(tempDir, "does-not-exist.log");
    expect(readLogFileIfExists(filePath)).toBeNull();
  });
});

describe("collectLogExportContent(ログディレクトリから集約済みテキストを組み立てる)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "keiba-log-export-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("main.log のみ存在する場合はその内容をそのまま返す", () => {
    writeFileSync(path.join(tempDir, "main.log"), "current-line", "utf8");
    expect(collectLogExportContent(tempDir)).toBe("current-line");
  });

  it("main.log と main.old.log の両方が存在する場合は old→current の順で連結する", () => {
    writeFileSync(path.join(tempDir, "main.log"), "current-line", "utf8");
    writeFileSync(path.join(tempDir, "main.old.log"), "old-line", "utf8");
    expect(collectLogExportContent(tempDir)).toBe("old-line\ncurrent-line");
  });

  it("どちらも存在しない場合(ログ未生成)は空文字を返す", () => {
    expect(collectLogExportContent(tempDir)).toBe("");
  });
});

describe("buildDefaultLogExportFileName(既定ファイル名の組み立て)", () => {
  it("YYYYMMDD付きのファイル名を返す(例: keiba-ev-tool-logs-20260716.txt)", () => {
    expect(buildDefaultLogExportFileName(new Date(2026, 6, 16))).toBe(
      "keiba-ev-tool-logs-20260716.txt",
    );
  });

  it("月・日が1桁でも0埋めする", () => {
    expect(buildDefaultLogExportFileName(new Date(2026, 0, 5))).toBe(
      "keiba-ev-tool-logs-20260105.txt",
    );
  });
});
