import { describe, expect, it } from "vitest";

import { BABA_DROPPED_DETAIL_LIMIT, BABA_MEASURED_TEXT_LIMIT, BABA_RAW_JSON_LIMIT, BabaFetchError, isVenueComplete } from "../src/baba-conditions";

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

describe("isVenueComplete(Issue #480。「そろった」= クッション値と含水率のどちらにも当日の値がある)", () => {
  const surface = (goal: number | null, corner4: number | null) => ({ condition: null, goalCondition: null, corner4Condition: null, goalMoisture: goal, corner4Moisture: corner4 });
  const venue = (cushion: number | null, turf: [number | null, number | null], dirt: [number | null, number | null]) => ({ cushion, turf: surface(...turf), dirt: surface(...dirt) });

  it("クッション値と含水率のどちらもある → そろった。含水率は 4 つのうち 1 つでもあればよい(4 つそれぞれで確かめる)", () => {
    expect(isVenueComplete(venue(9.5, [10, 11], [3, 4]))).toBe(true);
    expect(isVenueComplete(venue(9.5, [10, null], [null, null]))).toBe(true);
    expect(isVenueComplete(venue(9.5, [null, 11], [null, null]))).toBe(true);
    expect(isVenueComplete(venue(9.5, [null, null], [3, null]))).toBe(true);
    expect(isVenueComplete(venue(9.5, [null, null], [null, 4]))).toBe(true);
  });

  it("クッション値はあるが、含水率が 4 つとも null → そろっていない(含水率の側を見ている)", () => {
    expect(isVenueComplete(venue(9.5, [null, null], [null, null]))).toBe(false);
  });

  it("含水率はあるが、クッション値が null → そろっていない。どちらも無ければそろっていない", () => {
    expect(isVenueComplete(venue(null, [10, 11], [3, 4]))).toBe(false);
    expect(isVenueComplete(venue(null, [null, null], [null, null]))).toBe(false);
  });

  it("0 は値がある(null と区別する): クッション値 0・含水率 0 でもそろった", () => {
    expect(isVenueComplete(venue(0, [0, null], [null, null]))).toBe(true);
  });
});
