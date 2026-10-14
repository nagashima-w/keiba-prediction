import { describe, expect, it } from "vitest";
import { checkRaceDate } from "../src/race-date";

/**
 * Issue #180(#164-e)・#177 の申し送り: レースIDと開催日の整合。年はどのレースでも一致が必要。地方(場コード30〜64)の raceId には月日も入っているので、
 * 開催日の月日とも一致が必要(中央の7〜10桁目は回次・日次で日付ではないので、年だけ)。
 */
describe("checkRaceDate", () => {
  it.each([
    ["中央: 年が同じ(月日は見ない。回次・日次であって日付ではない)", "202603020211", "20260628", true],
    ["中央: 別の月日でも年が同じなら通る", "202603020211", "20261231", true],
    ["中央: 年が違う", "202603020211", "20250628", false],
    ["地方: 年・月日が一致する(7〜10桁目 0712 = 7月12日)", "202654071210", "20260712", true],
    ["地方: 月日が違う(日)", "202654071210", "20260713", false],
    ["地方: 月日が違う(月)", "202654071210", "20260812", false],
    ["地方: 年が違う", "202654071210", "20250712", false],
  ])("%s", (_name, raceId, kaisaiDate, ok) => {
    const result = checkRaceDate(raceId, kaisaiDate);
    expect(result.ok).toBe(ok);
    if (!ok) {
      expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/年|月日/) });
    }
  });

  it("地方の不一致の理由に、レースIDから導いた開催日が入る(利用者が直せる)", () => {
    expect(checkRaceDate("202654071210", "20260713")).toMatchObject({ ok: false, message: expect.stringContaining("20260712") });
  });

  it("無効なレースID・開催日は、理由つきで拒否する(例外を投げない)", () => {
    for (const [raceId, kaisaiDate] of [["abc", "20260628"], ["202603020211", "2026-06-28"], ["202603020211", "20260230"], ["", ""]] as const) {
      expect(checkRaceDate(raceId, kaisaiDate)).toMatchObject({ ok: false });
    }
  });
});
