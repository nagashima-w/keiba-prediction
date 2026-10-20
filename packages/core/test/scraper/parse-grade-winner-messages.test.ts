import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { GradeWinnerParseError, parseGradeWinnerResponse } from "../../src/scraper/parse-grade-winner.js";

/**
 * Issue #421 段階 1-b: 復号を `decode-race-api.ts` へ共有したあとも、`GradeWinnerParseError` の文言が変わらないことの固定
 * (特性化テスト。共有化の前の実装に対して書き、緑であることを確かめてから共有化した)。
 */

function okWith(data: unknown): string {
  return JSON.stringify({ status: "OK", reason: null, data });
}

function messageOf(raw: string): string {
  try {
    parseGradeWinnerResponse(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(GradeWinnerParseError);
    return (error as Error).message;
  }
  throw new Error("例外が投げられなかった");
}

describe("GradeWinnerParseError の文言(復号の共有化で変えない)", () => {
  it("データキーが無い", () => {
    expect(messageOf(okWith({ "x_last_dt": "a" }))).toBe(
      "同レース過去10年結果APIの応答からデータキー(_last_dtで終わらないキー)を特定できません",
    );
  });

  it("データがbase64文字列でない", () => {
    expect(messageOf(okWith({ k: 1 }))).toBe("同レース過去10年結果APIの応答データがbase64文字列ではありません");
  });

  it("zlib の展開に失敗", () => {
    const bad = Buffer.from("zlibではない", "utf-8").toString("base64");
    expect(messageOf(okWith({ k: bad }))).toMatch(/^同レース過去10年結果APIの応答の復号\(base64\/zlib\)に失敗しました: /);
  });

  it("展開後が JSON でない", () => {
    const bad = deflateSync(Buffer.from("{壊れた", "utf-8")).toString("base64");
    expect(messageOf(okWith({ k: bad }))).toMatch(/^復号後データのJSON解析に失敗しました: /);
  });

  it("展開後が配列でない", () => {
    const obj = deflateSync(Buffer.from('{"a":1}', "utf-8")).toString("base64");
    expect(messageOf(okWith({ k: obj }))).toBe("復号後データが配列ではありません");
  });
});
