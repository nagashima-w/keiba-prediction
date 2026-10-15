import { describe, expect, it } from "vitest";
import type { MarkRepairReport } from "@keiba/core/llm";
import { MARK_VIOLATION_KINDS } from "../../packages/core/src/analyzer/parse-response";
import { markFromByUmaban, parseMarkRepair, serializeMarkRepair } from "../src/mark-repair";

/**
 * Issue #317: 印の補修の記録(`analyses.mark_repair_json`。migration 0018)の直列化と復元。純ロジック。
 * 保存するのは固定の語彙(違反の種類・既知の6種・「なし」「不明」)だけで、LLM の生の文字列は入らない。
 */

const REPORT: MarkRepairReport = {
  repaired: true,
  adoptedAttempt: 2,
  attempts: [
    { n: 1, kinds: ["over-◎"] },
    { n: 2, kinds: ["over-◎", "gap-〇"] },
  ],
  changes: [
    { umaban: 2, from: "◎", to: "〇" },
    { umaban: 5, from: "不明", to: null },
    { umaban: 7, from: "なし", to: "◎" },
  ],
};

describe("serializeMarkRepair / parseMarkRepair", () => {
  it("記録なし(null・undefined)は null(NULL で保存する)", () => {
    expect(serializeMarkRepair(null)).toBeNull();
    expect(serializeMarkRepair(undefined)).toBeNull();
  });

  it("往復: 直列化した文字列を復元すると、同じ内容(版 v:1 つき)になる", () => {
    const raw = serializeMarkRepair(REPORT)!;
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw).v).toBe(1);
    expect(parseMarkRepair(raw)).toEqual({ v: 1, repaired: true, adoptedAttempt: 2, attempts: REPORT.attempts, horses: REPORT.changes });
  });

  it("聞き直しで解消した記録(repaired:false・変更なし)も往復できる", () => {
    const report: MarkRepairReport = { repaired: false, adoptedAttempt: 2, attempts: [{ n: 1, kinds: ["missing-◎"] }], changes: [] };
    expect(parseMarkRepair(serializeMarkRepair(report))).toEqual({ v: 1, repaired: false, adoptedAttempt: 2, attempts: report.attempts, horses: [] });
  });

  it.each([[null], [undefined], [""], ["これはJSONではない"], ["[]"], ["null"], ["123"], ['{"v":2}'], ['{"v":1}'], ['{"v":1,"repaired":"yes","adoptedAttempt":1,"attempts":[],"horses":[]}']])(
    "復元は例外を投げず、読めない値(%s)は null",
    (raw) => {
      expect(parseMarkRepair(raw as string | null | undefined)).toBeNull();
    },
  );

  it("語彙の外の値は捨てる: 未知の違反の種類・未知の印・不正な馬番・不正な試行番号(LLM の生の文字列を画面に出さない)", () => {
    const raw = JSON.stringify({
      v: 1,
      repaired: true,
      adoptedAttempt: 1,
      attempts: [{ n: 1, kinds: ["over-◎", "ほげ", 3] }, { n: 9, kinds: ["gap-〇"] }, "x"],
      horses: [
        { umaban: 1, from: "◇", to: "〇" }, // 元の印が語彙の外
        { umaban: 2, from: "◎", to: "◇" }, // 今の印が語彙の外
        { umaban: 3.5, from: "◎", to: null }, // 馬番が整数でない
        { umaban: 4, from: "◎", to: "〇", extra: "余計" },
        { umaban: 5, from: "不明", to: null },
        null,
      ],
    });
    expect(parseMarkRepair(raw)).toEqual({
      v: 1,
      repaired: true,
      adoptedAttempt: 1,
      attempts: [{ n: 1, kinds: ["over-◎"] }],
      horses: [
        { umaban: 4, from: "◎", to: "〇" },
        { umaban: 5, from: "不明", to: null },
      ],
    });
  });

  it("10種の違反の種類は、すべて往復で残る(語彙の取りこぼしがない)", () => {
    const report: MarkRepairReport = { repaired: true, adoptedAttempt: 1, attempts: [{ n: 1, kinds: [...MARK_VIOLATION_KINDS] }], changes: [] };
    expect(MARK_VIOLATION_KINDS).toHaveLength(10);
    expect(parseMarkRepair(serializeMarkRepair(report))!.attempts[0]!.kinds).toEqual([...MARK_VIOLATION_KINDS]);
  });
});

describe("markFromByUmaban(補修した馬の、補修前の印)", () => {
  const CURRENT = new Map<number, string | null>([[2, "〇"], [5, null], [7, "◎"], [9, "▲"]]);

  it("repaired:true の記録から、馬番 → 補修前の印を作る(現在の印が補修後の印と一致する馬だけ)", () => {
    const m = markFromByUmaban(parseMarkRepair(serializeMarkRepair(REPORT)), CURRENT);
    expect([...m.entries()]).toEqual([[2, "◎"], [5, "不明"], [7, "なし"]]);
  });

  it("現在の印が補修後の印と食い違う馬・現在の馬に居ない馬は除く", () => {
    const m = markFromByUmaban(parseMarkRepair(serializeMarkRepair(REPORT)), new Map([[2, "▲"], [7, "◎"]]));
    expect([...m.entries()]).toEqual([[7, "なし"]]);
  });

  it("repaired:false(聞き直しで解消)・記録なしは、空(どの馬にも「直」を付けない)", () => {
    const resolved: MarkRepairReport = { repaired: false, adoptedAttempt: 2, attempts: [{ n: 1, kinds: ["over-◎"] }], changes: [] };
    expect(markFromByUmaban(parseMarkRepair(serializeMarkRepair(resolved)), CURRENT).size).toBe(0);
    expect(markFromByUmaban(null, CURRENT).size).toBe(0);
  });
});
