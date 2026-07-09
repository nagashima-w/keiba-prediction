import { describe, expect, it, vi } from "vitest";
import { parseRaceId, RaceResultParseError, type RaceResult } from "@keiba/core";
import {
  importRaceResult,
  summarizeImport,
  toResultEntries,
} from "../src/main/result-import.js";

/** テスト用のレース結果を最小構成で組み立てる。 */
function buildRaceResult(overrides: Partial<RaceResult> = {}): RaceResult {
  return {
    horses: [
      { umaban: 4, finishPosition: { kind: "順位", value: 1 }, horseName: "A" },
      { umaban: 2, finishPosition: { kind: "順位", value: 2 }, horseName: "B" },
      { umaban: 9, finishPosition: { kind: "順位", value: 3 }, horseName: "C" },
      { umaban: 5, finishPosition: { kind: "非数値", text: "中止" }, horseName: "D" },
    ],
    placePayouts: [
      { umaban: 4, payout: 210 },
      { umaban: 2, payout: 170 },
      { umaban: 9, payout: 1060 },
    ],
    winPayouts: [{ umaban: 4, payout: 670 }],
    ...overrides,
  };
}

describe("toResultEntries(結果→保存レコード変換)", () => {
  it("着順を数値化し、複勝圏内の馬に確定払戻を対応付けること", () => {
    const entries = toResultEntries(buildRaceResult());
    const byUmaban = new Map(entries.map((e) => [e.umaban, e]));
    expect(byUmaban.get(4)).toEqual({
      umaban: 4,
      finishPosition: 1,
      placePayout: 210,
    });
    expect(byUmaban.get(9)).toEqual({
      umaban: 9,
      finishPosition: 3,
      placePayout: 1060,
    });
  });

  it("非数値着順(中止など)は finishPosition=null にすること", () => {
    const entries = toResultEntries(buildRaceResult());
    const d = entries.find((e) => e.umaban === 5)!;
    expect(d.finishPosition).toBeNull();
  });

  it("複勝払戻の無い馬は placePayout=null にすること", () => {
    const entries = toResultEntries(buildRaceResult());
    const d = entries.find((e) => e.umaban === 5)!;
    expect(d.placePayout).toBeNull();
  });

  it("降着(demoted)でも確定着順(value)を採用すること", () => {
    const entries = toResultEntries(
      buildRaceResult({
        horses: [
          {
            umaban: 1,
            finishPosition: { kind: "順位", value: 5, demoted: true },
            horseName: "X",
          },
        ],
        placePayouts: [],
        winPayouts: [],
      }),
    );
    expect(entries[0]!.finishPosition).toBe(5);
  });
});

describe("summarizeImport(取込サマリ)", () => {
  it("頭数・複勝払戻点数・払戻有無を集計すること", () => {
    const outcome = summarizeImport("202602010607", buildRaceResult());
    expect(outcome).toEqual({
      raceId: "202602010607",
      horseCount: 4,
      placePayoutCount: 3,
      hasPayout: true,
    });
  });

  it("払戻テーブルが無い(未確定)場合は hasPayout=false になること", () => {
    const outcome = summarizeImport(
      "202602010607",
      buildRaceResult({ placePayouts: [], winPayouts: [] }),
    );
    expect(outcome.hasPayout).toBe(false);
    expect(outcome.placePayoutCount).toBe(0);
  });
});

describe("importRaceResult(取込フロー: 取得→パース→保存)", () => {
  const raceId = parseRaceId("202602010607");

  it("常にライブ取得する(bypassCache: true でフェッチする)", async () => {
    const fetchText = vi.fn().mockResolvedValue("<html>ok</html>");
    const saveResult = vi.fn();
    await importRaceResult(raceId, {
      fetchText,
      parse: () => buildRaceResult(),
      saveResult,
    });
    expect(fetchText).toHaveBeenCalledTimes(1);
    const [url, options] = fetchText.mock.calls[0]!;
    expect(url).toBe(
      "https://race.netkeiba.com/race/result.html?race_id=202602010607",
    );
    expect(options).toMatchObject({ bypassCache: true });
  });

  it("パース成功時は結果を保存し取込サマリを返す", async () => {
    const saveResult = vi.fn();
    const outcome = await importRaceResult(raceId, {
      fetchText: vi.fn().mockResolvedValue("<html>ok</html>"),
      parse: () => buildRaceResult(),
      saveResult,
    });
    expect(saveResult).toHaveBeenCalledTimes(1);
    const [savedRaceId, entries] = saveResult.mock.calls[0]!;
    expect(savedRaceId).toBe(raceId);
    expect(entries).toEqual(toResultEntries(buildRaceResult()));
    expect(outcome).toEqual({
      raceId: "202602010607",
      horseCount: 4,
      placePayoutCount: 3,
      hasPayout: true,
    });
  });

  it("結果テーブル欠落(パース失敗)時は保存せずエラーを伝播する(DBを汚さない)", async () => {
    const saveResult = vi.fn();
    await expect(
      importRaceResult(raceId, {
        fetchText: vi.fn().mockResolvedValue("<html>未確定</html>"),
        parse: () => {
          throw new RaceResultParseError("結果テーブルが見つかりませんでした");
        },
        saveResult,
      }),
    ).rejects.toBeInstanceOf(RaceResultParseError);
    expect(saveResult).not.toHaveBeenCalled();
  });
});
