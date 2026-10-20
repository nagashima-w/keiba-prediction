import { describe, expect, it } from "vitest";
import { JST_OFFSET_HOURS, JST_OFFSET_MS, jstEpochMs, jstHm, jstHour, jstIsoDate, nextJstMidnight } from "../../src/common/jst.js";

/**
 * Issue #397(R-5): JST(UTC+9。夏時間なし)の時刻計算の共通部品。
 * 11 か所に独立して定義されていた `JST_OFFSET_*` と、同一だった関数(`jstDay`〈YYYY-MM-DD〉・`nextJstMidnight`・時・`HH:mm`・JST の暦日時刻→ms)を 1 本にした。
 * 期待値は手で組み立てた UTC の瞬間(`Date.UTC`)から取った。旧実装との一致は、置換の前に旧実装と新実装を同じ入力で比べて確かめた。
 */

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number => Date.UTC(y, mo - 1, d, h, mi, s, ms);

describe("定数", () => {
  it("JST は UTC+9 で、ミリ秒は 32,400,000(時と ms の 2 つが食い違わない)", () => {
    expect(JST_OFFSET_HOURS).toBe(9);
    expect(JST_OFFSET_MS).toBe(32_400_000);
    expect(JST_OFFSET_MS).toBe(JST_OFFSET_HOURS * 60 * 60 * 1000);
  });
});

describe("jstEpochMs: JST の暦日時刻 → エポックミリ秒", () => {
  const cases: ReadonlyArray<readonly [string, [number, number, number, number, number], number]> = [
    ["JST 9:00 は同じ日の UTC 0:00", [2026, 10, 19, 9, 0], utc(2026, 10, 19, 0, 0)],
    ["JST 0:00 は UTC の前日 15:00", [2026, 10, 19, 0, 0], utc(2026, 10, 18, 15, 0)],
    ["月またぎ: 11/1 JST 0:00 は UTC の 10/31 15:00", [2026, 11, 1, 0, 0], utc(2026, 10, 31, 15, 0)],
    ["年またぎ: 1/1 JST 0:00 は UTC の前年 12/31 15:00", [2026, 1, 1, 0, 0], utc(2025, 12, 31, 15, 0)],
    ["うるう日: 2028/3/1 JST 0:00 は UTC の 2/29 15:00", [2028, 3, 1, 0, 0], utc(2028, 2, 29, 15, 0)],
    ["時 24 は翌日 0:00 JST(Date.UTC の桁上がり)", [2026, 10, 19, 24, 0], utc(2026, 10, 19, 15, 0)],
    ["分を含む", [2026, 10, 19, 15, 45], utc(2026, 10, 19, 6, 45)],
  ];
  for (const [name, [y, mo, d, h, mi], expected] of cases) {
    it(name, () => {
      expect(jstEpochMs(y, mo, d, h, mi)).toBe(expected);
    });
  }

  it("時・分を省くと 0:00 JST", () => {
    expect(jstEpochMs(2026, 1, 1)).toBe(utc(2025, 12, 31, 15, 0));
  });
});

describe("jstIsoDate: JST の暦日(YYYY-MM-DD)", () => {
  const cases: ReadonlyArray<readonly [string, number, string]> = [
    ["UTC 14:59:59.999 はまだ同じ日", utc(2026, 10, 19, 14, 59, 59, 999), "2026-10-19"],
    ["UTC 15:00:00.000 から JST の翌日", utc(2026, 10, 19, 15, 0), "2026-10-20"],
    ["UTC 0:00 は JST 9:00 で同じ日", utc(2026, 10, 19, 0, 0), "2026-10-19"],
    ["年末: UTC 12/31 15:00 は JST の翌年 1/1", utc(2026, 12, 31, 15, 0), "2027-01-01"],
    ["うるう日: UTC 2/28 15:00 は JST の 2/29", utc(2028, 2, 28, 15, 0), "2028-02-29"],
    ["平年の月末: UTC 2/28 15:00 は JST の 3/1", utc(2026, 2, 28, 15, 0), "2026-03-01"],
  ];
  for (const [name, ms, expected] of cases) {
    it(name, () => {
      expect(jstIsoDate(ms)).toBe(expected);
    });
  }
});

describe("nextJstMidnight: 次の JST 0:00(UTC 15:00)", () => {
  const cases: ReadonlyArray<readonly [string, number, number]> = [
    ["JST 0:00 の 1ms 前 → その瞬間", utc(2026, 10, 19, 14, 59, 59, 999), utc(2026, 10, 19, 15, 0)],
    ["ちょうど JST 0:00 → 次の日(厳密に未来)", utc(2026, 10, 19, 15, 0), utc(2026, 10, 20, 15, 0)],
    ["日中(UTC 3:00)", utc(2026, 10, 19, 3, 0), utc(2026, 10, 19, 15, 0)],
    ["年末", utc(2026, 12, 31, 20, 0), utc(2027, 1, 1, 15, 0)],
    ["うるう日をまたぐ", utc(2028, 2, 28, 15, 0), utc(2028, 2, 29, 15, 0)],
  ];
  for (const [name, ms, expected] of cases) {
    it(name, () => {
      expect(nextJstMidnight(ms)).toBe(expected);
    });
  }

  it("返り値は常に入力より大きく、24 時間以内", () => {
    for (let ms = utc(2026, 10, 19, 0, 0); ms < utc(2026, 10, 21, 0, 0); ms += 37 * 60_000) {
      const next = nextJstMidnight(ms);
      expect(next).toBeGreaterThan(ms);
      expect(next - ms).toBeLessThanOrEqual(24 * 60 * 60_000);
      expect(jstHm(next)).toBe("00:00");
    }
  });
});

describe("jstHour / jstHm: JST の時、HH:mm", () => {
  const cases: ReadonlyArray<readonly [string, number, number, string]> = [
    ["UTC 14:59 → JST 23:59", utc(2026, 10, 19, 14, 59), 23, "23:59"],
    ["UTC 15:00 → JST 0:00", utc(2026, 10, 19, 15, 0), 0, "00:00"],
    ["UTC 0:05 → JST 9:05(時は 0 埋め)", utc(2026, 10, 19, 0, 5), 9, "09:05"],
    ["UTC 12:00 → JST 21:00(定時の自動実行 1 本目)", utc(2026, 10, 19, 12, 0), 21, "21:00"],
    ["UTC 14:00 → JST 23:00(2 本目)", utc(2026, 10, 19, 14, 0), 23, "23:00"],
    ["UTC 13:00 → JST 22:00", utc(2026, 10, 19, 13, 0), 22, "22:00"],
  ];
  for (const [name, ms, hour, hm] of cases) {
    it(name, () => {
      expect(jstHour(ms)).toBe(hour);
      expect(jstHm(ms)).toBe(hm);
    });
  }
});
