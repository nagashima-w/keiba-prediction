import { describe, expect, it } from "vitest";

import { findUnreadHeaderItems, parseHeaderItems, summarizeHeaderUnread, type HeaderItem } from "../src/header-unread";
import type { ShutubaRaceInfo } from "../../packages/core/src/scraper/types";

/**
 * Issue #522: 出馬表の見出しから読めなかった項目の判定(純関数)。
 * 通知のきっかけは「馬場状態が読めない」か「芝で柵が読めない(null)」だけ。天候は、きっかけになったレースについて「天候も読めなかった」と添えるだけ。
 */

type Header = Pick<ShutubaRaceInfo, "courseType" | "weather" | "trackCondition" | "fence">;

describe("findUnreadHeaderItems(読めなかった項目。表駆動)", () => {
  const cases: readonly { name: string; header: Header; expected: readonly HeaderItem[] }[] = [
    { name: "芝: 天候・馬場状態・柵がすべて読めた → 何もなし", header: { courseType: "芝", weather: "晴", trackCondition: "良", fence: "A" }, expected: [] },
    { name: "ダート: 天候・馬場状態が読めた(柵は芝だけで undefined)→ 何もなし", header: { courseType: "ダ", weather: "曇", trackCondition: "稍" }, expected: [] },
    { name: "障害: 天候・馬場状態が読めた → 何もなし", header: { courseType: "障", weather: "晴", trackCondition: "良" }, expected: [] },
    { name: "芝: 馬場状態だけ読めない → 馬場状態", header: { courseType: "芝", weather: "晴", fence: "A" }, expected: ["馬場状態"] },
    { name: "ダート: 馬場状態だけ読めない → 馬場状態", header: { courseType: "ダ", weather: "晴" }, expected: ["馬場状態"] },
    { name: "障害: 馬場状態だけ読めない → 馬場状態", header: { courseType: "障", weather: "晴" }, expected: ["馬場状態"] },
    { name: "芝: 柵だけ読めない(null)→ 柵", header: { courseType: "芝", weather: "晴", trackCondition: "良", fence: null }, expected: ["柵"] },
    { name: "芝: 馬場状態も柵も読めない → 馬場状態・柵(この順)", header: { courseType: "芝", weather: "晴", fence: null }, expected: ["馬場状態", "柵"] },
    { name: "芝: 馬場状態が読めず、天候も読めない → 馬場状態・天候(天候は添えるだけ)", header: { courseType: "芝", fence: "A" }, expected: ["馬場状態", "天候"] },
    { name: "芝: 柵が読めず、天候も読めない → 柵・天候", header: { courseType: "芝", trackCondition: "良", fence: null }, expected: ["柵", "天候"] },
    { name: "芝: すべて読めない → 馬場状態・柵・天候(この順)", header: { courseType: "芝", fence: null }, expected: ["馬場状態", "柵", "天候"] },
    { name: "ダート: 馬場状態も天候も読めない → 馬場状態・天候", header: { courseType: "ダ" }, expected: ["馬場状態", "天候"] },
    { name: "天候だけ読めない(馬場状態・柵は読めた)→ きっかけにならない(未発表による偽の警告を減らす)", header: { courseType: "芝", trackCondition: "良", fence: "A" }, expected: [] },
    { name: "ダートで天候だけ読めない → きっかけにならない", header: { courseType: "ダ", trackCondition: "良" }, expected: [] },
    { name: "障害で天候だけ読めない → きっかけにならない", header: { courseType: "障", trackCondition: "良" }, expected: [] },
    { name: "ダート・障害の柵は undefined(概念が無い)。柵として数えない", header: { courseType: "ダ", weather: "晴", trackCondition: "良", fence: undefined }, expected: [] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(findUnreadHeaderItems(c.header)).toEqual(c.expected);
    });
  }

  it("対照(空振りでない): きっかけのある入力は空でなく、きっかけの無い入力は空である(両方の結果が実際に出る)", () => {
    const withTrigger = cases.filter((c) => c.expected.length > 0).length;
    const withoutTrigger = cases.filter((c) => c.expected.length === 0).length;
    expect(withTrigger).toBeGreaterThan(5);
    expect(withoutTrigger).toBeGreaterThan(3);
  });
});

describe("parseHeaderItems(表の文字列 → 項目)", () => {
  it("保存形式(読点区切り)を項目に戻す。知らない語は捨てる", () => {
    expect(parseHeaderItems("馬場状態,柵,天候")).toEqual(["馬場状態", "柵", "天候"]);
    expect(parseHeaderItems("柵")).toEqual(["柵"]);
    expect(parseHeaderItems("")).toEqual([]);
    expect(parseHeaderItems("馬場状態,未知の語")).toEqual(["馬場状態"]);
  });
});

describe("summarizeHeaderUnread(件数の集計)", () => {
  it("レース数と、項目ごとの件数を数える(天候は、きっかけのあったレースのうち天候も読めなかった数)", () => {
    const summary = summarizeHeaderUnread([{ missing: "馬場状態,天候" }, { missing: "馬場状態" }, { missing: "柵,天候" }, { missing: "馬場状態,柵" }]);
    expect(summary).toEqual({ races: 4, track: 3, fence: 2, weather: 2 });
    expect(summary.races).toBe(4); // 前提: 入力は 4 行
  });

  it("行が無ければ全部 0", () => {
    expect(summarizeHeaderUnread([])).toEqual({ races: 0, track: 0, fence: 0, weather: 0 });
  });
});
