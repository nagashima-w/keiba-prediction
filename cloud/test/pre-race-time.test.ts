import { describe, expect, it } from "vitest";
import { DEFAULT_PRE_RACE_OFFSET_MINUTES, preRaceAlarmAt, startTimeEpochMs } from "../src/pre-race-time";

/**
 * Issue #178(#164-c)AC-c4: 発走時刻(出馬表の `startTime` = JST の HH:MM)を UTC のエポックミリ秒に換算する。Worker・DO は UTC で動くので、
 * 9時間ずれると、発走前の分析が9時間早く/遅く走る。日付をまたぐ境界(JST 0:00〜8:59 は UTC の前日)・年またぎ・うるう日で固定する。
 * アラームの予約に使うのは #166。換算の関数とテストはここで作る。
 */
const iso = (ms: number): string => new Date(ms).toISOString();

describe("startTimeEpochMs(JST → UTC)", () => {
  it.each([
    ["通常(15:25 JST = 06:25 UTC)", "20260628", "15:25", "2026-06-28T06:25:00.000Z"],
    ["JST 9:00 ちょうど = UTC 0:00(同じ日)", "20260628", "09:00", "2026-06-28T00:00:00.000Z"],
    ["JST 8:59 = UTC の前日 23:59(境界の1分前)", "20260628", "08:59", "2026-06-27T23:59:00.000Z"],
    ["JST 0:00 = UTC の前日 15:00", "20260628", "00:00", "2026-06-27T15:00:00.000Z"],
    ["JST 23:59 = UTC 同日 14:59", "20260628", "23:59", "2026-06-28T14:59:00.000Z"],
    ["月またぎ(JST 3/1 0:10 = UTC 2/28 15:10。平年)", "20260301", "00:10", "2026-02-28T15:10:00.000Z"],
    ["うるう日(JST 2024/3/1 0:00 = UTC 2/29 15:00)", "20240301", "00:00", "2024-02-29T15:00:00.000Z"],
    ["年またぎ(JST 1/1 8:59 = UTC 前年 12/31 23:59)", "20260101", "08:59", "2025-12-31T23:59:00.000Z"],
  ])("%s", (_name, date, time, expected) => {
    expect(iso(startTimeEpochMs(date, time))).toBe(expected);
  });

  it("対照: UTC として読む(換算しない)と 9 時間ずれる。9 時間ずれる変異を殺すための固定(15:25 JST は UTC の 15:25 ではない)", () => {
    const naive = Date.UTC(2026, 5, 28, 15, 25);
    expect(startTimeEpochMs("20260628", "15:25")).toBe(naive - 9 * 3600_000);
    expect(startTimeEpochMs("20260628", "15:25")).not.toBe(naive);
    expect(startTimeEpochMs("20260628", "15:25")).not.toBe(naive + 9 * 3600_000);
  });

  it.each([["9:00"], ["09:0"], ["24:00"], ["12:60"], ["ab:cd"], [""], ["09:00:00"], ["0900"], [" 09:00"]])("無効な発走時刻 %j は拒否する", (time) => {
    expect(() => startTimeEpochMs("20260628", time)).toThrow(RangeError);
  });

  it.each([["2026-06-28"], ["20260230"], [""], ["2026062"]])("無効な開催日 %j は拒否する", (date) => {
    expect(() => startTimeEpochMs(date, "15:25")).toThrow(RangeError);
  });
});

describe("preRaceAlarmAt(発走の何分前か)", () => {
  it("既定は 30 分前(ユーザー判断 2026-10-06。設定で変えられるようにするのは #166)", () => {
    expect(DEFAULT_PRE_RACE_OFFSET_MINUTES).toBe(30);
    expect(iso(preRaceAlarmAt("20260628", "15:25"))).toBe("2026-06-28T05:55:00.000Z");
  });

  it("日付をまたぐ: JST 9:00 の発走の 30 分前は UTC の前日 23:30。JST 0:10 の 30 分前は UTC の前日 14:40", () => {
    expect(iso(preRaceAlarmAt("20260628", "09:00"))).toBe("2026-06-27T23:30:00.000Z");
    expect(iso(preRaceAlarmAt("20260628", "00:10"))).toBe("2026-06-27T14:40:00.000Z");
  });

  it("分前の指定を変えられる(0 分前 = 発走時刻。60 分前)。負・小数・非有限は拒否する", () => {
    expect(preRaceAlarmAt("20260628", "15:25", 0)).toBe(startTimeEpochMs("20260628", "15:25"));
    expect(iso(preRaceAlarmAt("20260628", "15:25", 60))).toBe("2026-06-28T05:25:00.000Z");
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => preRaceAlarmAt("20260628", "15:25", bad)).toThrow(RangeError);
    }
  });
});
