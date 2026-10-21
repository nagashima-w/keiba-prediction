import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadFixture } from "./fixtures.js";

/**
 * Issue #400 R-12b: テスト共通の `loadFixture`(リポジトリ直下の `fixtures/` を UTF-8 で読む)の単体テスト。
 * 以前は多数のテストファイルが同じ本文の関数を各自で定義していた。置き場所を1つにまとめたので、読む先がずれていないことを固定する。
 */
describe("loadFixture(fixtures/ 配下を UTF-8 テキストで読む)", () => {
  // fixtures/ の場所はこのファイルの位置(packages/core/test/support)から4つ上。test ごとの位置に依らないことの確認として、
  // 実在するファイルを別の経路(import.meta.url から組み立てた絶対パス)でも読み、内容が一致することを見る。
  const FIXTURES_DIR = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));

  it("前提: fixtures/ に HTML のフィクスチャが実在する(空振り防止)", () => {
    expect(readdirSync(FIXTURES_DIR)).toContain("result_202603020211.html");
  });

  it("fixtures/ 直下のファイルの内容をそのまま文字列で返す", () => {
    const expected = readFileSync(`${FIXTURES_DIR}result_202603020211.html`, "utf-8");
    expect(expected.length).toBeGreaterThan(0);
    expect(loadFixture("result_202603020211.html")).toBe(expected);
  });

  it("存在しないファイルは例外を投げる(空文字で黙らない)", () => {
    expect(() => loadFixture("no_such_fixture_for_r12b.html")).toThrow(/ENOENT/);
  });
});
