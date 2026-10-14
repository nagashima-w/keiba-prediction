import { describe, expect, it } from "vitest";

import { parseRaceId } from "../../packages/core/src/scraper/ids";
import type { RaceListEntry } from "../../packages/core/src/scraper/types";
import { holdHeadOf, isHoldSettled, lastStartMsOfHead, parseReportHold, reportHoldAtMs, withHoldFailure } from "../src/report-hold";

/**
 * Issue #291: 日報の時刻の下限の、meta の値の読み書きと、一覧からの発走時刻の取り出し(純関数)。配線は `race-day-report-hold.test.ts`。
 */

const DATE = "20261013";
const jst = (time: string): number => Date.parse(`2026-10-13T${time}:00+09:00`);
const entry = (raceId: string, startTime?: string): RaceListEntry => ({
  raceId: parseRaceId(raceId),
  name: "x",
  courseType: "ダ",
  distance: 1200,
  entryCount: 12,
  raceNumber: Number(raceId.slice(10)),
  ...(startTime !== undefined ? { startTime } : {}),
});

describe("holdHeadOf: 開催のキーは race_id の先頭 10 桁", () => {
  it("中央(年+場+回次+日次)も地方(年+場+月日)も先頭 10 桁", () => {
    expect(holdHeadOf("202603020211")).toBe("2026030202");
    expect(holdHeadOf("202645101312")).toBe("2026451013");
  });
});

describe("parseReportHold: 壊れた値は空として扱い、例外を投げない", () => {
  it.each([
    ["null(キーが無い)", null],
    ["JSON として壊れている", "{"],
    ["配列", "[1]"],
    ["文字列", '"x"'],
    ["null の JSON", "null"],
  ] as const)("%s → 空", (_name, raw) => {
    expect(parseReportHold(raw)).toEqual({});
  });

  it("正しい値はそのまま読む。想定外の値の開催だけ落とす(有限でない・負・小数の回数・配列・文字列)", () => {
    const raw = JSON.stringify({ a: 100, b: { failures: 2 }, c: "x", d: { failures: -1 }, e: { failures: 1.5 }, f: [1], g: null, h: { failures: "2" } });
    expect(parseReportHold(raw)).toEqual({ a: 100, b: { failures: 2 } });
  });
});

describe("reportHoldAtMs / isHoldSettled / withHoldFailure", () => {
  it("下限は記録できた開催の最大(失敗の回数だけの開催は数えない)。無ければ null", () => {
    expect(reportHoldAtMs({})).toBeNull();
    expect(reportHoldAtMs({ a: { failures: 3 } })).toBeNull();
    expect(reportHoldAtMs({ a: 100, b: 300, c: { failures: 1 }, d: 200 })).toBe(300);
  });

  it("もう引かない: 記録できた開催、または失敗が上限に達した開催(上限未満・未記録は引く)", () => {
    expect(isHoldSettled({}, "a", 3)).toBe(false);
    expect(isHoldSettled({ a: { failures: 2 } }, "a", 3)).toBe(false);
    expect(isHoldSettled({ a: { failures: 3 } }, "a", 3)).toBe(true);
    expect(isHoldSettled({ a: 100 }, "a", 3)).toBe(true);
    expect(isHoldSettled({ b: 100 }, "a", 3)).toBe(false);
  });

  it("失敗の回数を 1 増やす(元は変えない。他の開催は触らない)", () => {
    const base = { a: { failures: 1 }, b: 100 };
    expect(withHoldFailure(base, "a")).toEqual({ a: { failures: 2 }, b: 100 });
    expect(withHoldFailure(base, "c")).toEqual({ a: { failures: 1 }, b: 100, c: { failures: 1 } });
    expect(base).toEqual({ a: { failures: 1 }, b: 100 });
  });
});

describe("lastStartMsOfHead: 同じ開催の行の、読める発走時刻の最大", () => {
  const rows = [
    entry("202645101310", "19:40"),
    entry("202645101312", "20:50"),
    entry("202645101311", "20:15"),
    entry("202644101312", "21:30"), // 別の開催(大井)は数えない
  ];

  it("行の並びによらず最大(レース番号の順ではなく時刻の最大)。別の開催の行は数えない", () => {
    expect(lastStartMsOfHead(rows, "2026451013", DATE)).toBe(jst("20:50"));
    expect(lastStartMsOfHead([...rows].reverse(), "2026451013", DATE)).toBe(jst("20:50"));
    expect(lastStartMsOfHead(rows, "2026441013", DATE)).toBe(jst("21:30"));
  });

  it("12R まで無い開催(9R まで)も最大の時刻を取る", () => {
    expect(lastStartMsOfHead([entry("202655092709", "20:40"), entry("202655092708", "20:10")], "2026550927", "20260927")).toBe(Date.parse("2026-09-27T20:40:00+09:00"));
  });

  it("時刻が無い行は無視する。最大番号の行が読めないと、読める行の最大(下限は本当の最終レースより早まる)", () => {
    const partial = [entry("202645101310", "19:40"), entry("202645101311", "20:15"), entry("202645101312")];
    expect(lastStartMsOfHead(partial, "2026451013", DATE)).toBe(jst("20:15"));
  });

  it("該当の開催の行が無い・読める時刻の行が無い → null", () => {
    expect(lastStartMsOfHead(rows, "2026999999", DATE)).toBeNull();
    expect(lastStartMsOfHead([entry("202645101310"), entry("202645101312")], "2026451013", DATE)).toBeNull();
    expect(lastStartMsOfHead([], "2026451013", DATE)).toBeNull();
  });

  it("開催日が壊れていて時刻に換算できないときは、投げずに null", () => {
    expect(lastStartMsOfHead(rows, "2026451013", "2026ABCD")).toBeNull();
  });
});
