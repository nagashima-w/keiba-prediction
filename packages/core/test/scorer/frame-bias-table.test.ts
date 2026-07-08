import { describe, expect, it } from "vitest";
import {
  COURSE_FRAME_BIAS_TABLE,
  courseFrameBiasValue,
} from "../../src/scorer/frame-bias-table.js";

describe("courseFrameBiasValue(コースレベル枠順バイアス定数テーブル)", () => {
  it("テーブルにない競馬場は全ゾーン0になること", () => {
    // 東京はテーブル未登録(概算で顕著な場のみ登録・デフォルト0の方針)。
    expect(courseFrameBiasValue("東京", "芝", "内")).toBe(0);
    expect(courseFrameBiasValue("東京", "芝", "中")).toBe(0);
    expect(courseFrameBiasValue("東京", "芝", "外")).toBe(0);
  });

  it("中央10場でない会場も0になること", () => {
    expect(courseFrameBiasValue("大井", "ダ", "内")).toBe(0);
  });

  it("小回り内枠有利の場(中山・芝)は内がプラス・外がマイナスになること", () => {
    const inner = courseFrameBiasValue("中山", "芝", "内");
    const outer = courseFrameBiasValue("中山", "芝", "外");
    expect(inner).toBeGreaterThan(0);
    expect(outer).toBeLessThan(0);
    // 中枠はほぼ中立。
    expect(courseFrameBiasValue("中山", "芝", "中")).toBe(0);
  });

  it("同一場でもコース種別が違えば別の値を引くこと", () => {
    // 中山ダートは登録済み(芝とは別値)。障害は未登録なので0。
    expect(courseFrameBiasValue("中山", "ダ", "内")).toBeGreaterThan(0);
    expect(courseFrameBiasValue("中山", "障", "内")).toBe(0);
  });

  it("テーブル値は概算(絶対値が控えめ)であること", () => {
    for (const rows of Object.values(COURSE_FRAME_BIAS_TABLE)) {
      for (const row of Object.values(rows)) {
        if (row === undefined) continue;
        for (const v of Object.values(row)) {
          expect(Math.abs(v)).toBeLessThanOrEqual(0.1);
        }
      }
    }
  });
});
