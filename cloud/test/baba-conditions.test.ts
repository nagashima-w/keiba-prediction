import { describe, expect, it } from "vitest";

import { BABA_DROPPED_DETAIL_LIMIT, BABA_MEASURED_TEXT_LIMIT, BABA_RAW_JSON_LIMIT, BabaFetchError } from "../src/baba-conditions";

/**
 * Issue #294・#478: 馬場の取得の失敗の分類(`BabaFetchError`)と、保存する値の上限の定数。
 * JRA のページの読み取りは `jra-baba-parse.test.ts`、取得の流れは `jra-baba-fetch.test.ts`。
 * 【Issue #478で改訂】旧: 外部の API の応答の解析(`parseBabaResponse`)の表駆動のテスト。その保証の引き継ぎ先は、コミットメッセージの対応表を参照。
 */
describe("BabaFetchError", () => {
  it("メッセージは固定の語(分類)だけで、元の例外・URL を持たない", () => {
    const e = new BabaFetchError("http-503");
    expect(e.result).toBe("http-503");
    expect(e.message).toContain("http-503");
    expect(e.name).toBe("BabaFetchError");
    expect(e.cause).toBeUndefined();
  });
});

describe("上限の定数(保存先・診断の読み出しが共有する)", () => {
  it("rawJson は 4096 字・捨てた詳細は 20 件・計測日時の文字列は 40 字", () => {
    expect(BABA_RAW_JSON_LIMIT).toBe(4096);
    expect(BABA_DROPPED_DETAIL_LIMIT).toBe(20);
    expect(BABA_MEASURED_TEXT_LIMIT).toBe(40);
  });
});
