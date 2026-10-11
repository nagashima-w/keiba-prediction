/**
 * 休み明け実績の要約(Issue #212・#210-A)の純関数テスト。
 *
 * 目的: 「休み明け」をそれだけで不安材料にせず、その馬自身の過去の休み明けでの成績と照らして
 * LLM に判断させるための、中立な材料を作る。
 *
 * 休み明けの定義は scorer・プロンプトの「レース間隔」と同じ(前走から71日以上。
 * derive-features.ts の REST_MIN_DAYS。ユーザー確定 2026-10-09: 戦績から自前で判定する案B)。
 * 初戦(前走なし)は休み明けとして数えない(scorer の n1 は初戦を含むが、ここは本物の休み明けだけ)。
 * 着順の扱い(降着=確定着順・非数値は対象外)は scorer の isPlaced と揃える。
 */

import { describe, expect, it } from "vitest";
import { summarizeRestRecord } from "../../src/analyzer/rest-record.js";
import { REST_MIN_DAYS } from "../../src/scorer/derive-features.js";
import type { FinishPosition, HorseRaceResult } from "../../src/scraper/types.js";
import { makeResult, rank } from "../scorer/helpers.js";

/** 今回の開催日。 */
const TODAY = "2026/10/10";

/** YYYY/MM/DD に日数を足した日付文字列を返す(UTC基準・ゼロ埋め)。 */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("/").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}/${mm}/${dd}`;
}

/**
 * 「各走の前走からの間隔(日)」と着順から、新しい順の戦績を組み立てる。
 * gaps[i] は i 番目の走(新しい順)とその1つ前(古い方)の走との間隔。
 * 先頭要素の前走(=今回)との間隔は todayGap で指定する。
 * 最古の走の gaps は使わない(初戦)ので、長さは finishes と同じにして末尾は捨てる。
 */
function buildResults(
  todayGap: number,
  runs: ReadonlyArray<{ gapBefore: number; finish: FinishPosition | null }>,
): HorseRaceResult[] {
  let date = addDays(TODAY, -todayGap);
  const out: HorseRaceResult[] = [];
  for (const r of runs) {
    out.push(makeResult({ date, finishPosition: r.finish }));
    date = addDays(date, -r.gapBefore);
  }
  return out;
}

describe("summarizeRestRecord(休み明け実績の要約・純関数)", () => {
  describe("今回が休み明けでないとき(材料を出さない)", () => {
    it("戦績が空なら null を返すこと", () => {
      expect(summarizeRestRecord([], TODAY)).toBeNull();
    });

    it("前走から70日(REST_MIN_DAYS未満)なら null を返すこと", () => {
      expect(REST_MIN_DAYS).toBe(71);
      const results = buildResults(70, [
        { gapBefore: 100, finish: rank(1) },
        { gapBefore: 30, finish: rank(2) },
      ]);
      expect(summarizeRestRecord(results, TODAY)).toBeNull();
    });

    it("前走の日付が欠損(間隔不明)なら null を返すこと", () => {
      const results = [makeResult({ date: null, finishPosition: rank(1) })];
      expect(summarizeRestRecord(results, TODAY)).toBeNull();
    });
  });

  describe("境界: 今回の間隔が71日ちょうど", () => {
    it("前走から71日なら休み明けとして要約を返し、今回間隔日数が71であること", () => {
      const results = buildResults(71, [{ gapBefore: 30, finish: rank(2) }, { gapBefore: 30, finish: rank(3) }]);
      const s = summarizeRestRecord(results, TODAY);
      expect(s).not.toBeNull();
      expect(s!.今回間隔日数).toBe(71);
    });
  });

  describe("過去の休み明けの集計", () => {
    it("過去の休み明け3走(1着・3着・6着)を集計し、1着1・2着0・3着1・着外1・3着内2、新しい順の着順を持つこと", () => {
      // 新しい順: [前走(通常)=2着, 休み明け6着, 通常=1着, 休み明け3着, 通常, 休み明け1着(その前は初戦), 初戦]
      const results = buildResults(120, [
        { gapBefore: 20, finish: rank(2) }, // 前走(今回は120日あき)。前走自体は通常間隔。
        { gapBefore: 90, finish: rank(6) }, // 休み明け(前走から90日)
        { gapBefore: 20, finish: rank(1) },
        { gapBefore: 80, finish: rank(3) }, // 休み明け(80日)
        { gapBefore: 25, finish: rank(5) },
        { gapBefore: 100, finish: rank(1) }, // 休み明け(100日)
        { gapBefore: 0, finish: rank(4) }, // 初戦(前走なし。gapBeforeは使われない)
      ]);
      const s = summarizeRestRecord(results, TODAY)!;
      expect(s.今回間隔日数).toBe(120);
      expect(s.走数).toBe(3);
      expect(s.一着).toBe(1);
      expect(s.二着).toBe(0);
      expect(s.三着).toBe(1);
      expect(s.着外).toBe(1);
      expect(s.三着内).toBe(2);
      expect(s.着順).toEqual([6, 3, 1]);
      expect(s.サンプル不足).toBe(false);
      expect(s.一着 + s.二着 + s.三着 + s.着外).toBe(s.走数);
    });

    it("note に件数・3着内の内訳・定義(71日以上)・今回の間隔日数が含まれ、サンプル不足の語を含まないこと", () => {
      const results = buildResults(120, [
        { gapBefore: 90, finish: rank(6) },
        { gapBefore: 80, finish: rank(3) },
        { gapBefore: 0, finish: rank(4) },
      ]);
      const s = summarizeRestRecord(results, TODAY)!;
      // 先頭(前走)自体は今回との間隔が120日、その前走からの間隔90日 → 休み明け6着。
      // 2番目は前走から80日 → 休み明け3着。最古は初戦(数えない)。
      expect(s.走数).toBe(2);
      expect(s.note).toContain("今回は前走から120日の休み明け");
      expect(s.note).toContain("前走から71日以上");
      expect(s.note).toContain("2走");
      expect(s.note).toContain("3着内1/2");
      expect(s.note).toContain("6着・3着");
      expect(s.note).not.toContain("サンプル2走未満");
    });

    it("初戦(前走なし)は休み明けとして数えないこと(戦績1走だけなら休み明け実績0走)", () => {
      const results = buildResults(150, [{ gapBefore: 0, finish: rank(1) }]);
      const s = summarizeRestRecord(results, TODAY)!;
      expect(s.走数).toBe(0);
      expect(s.三着内).toBe(0);
      expect(s.着順).toEqual([]);
      expect(s.サンプル不足).toBe(true);
    });

    it("休み明けの間隔が70日の走は数えず、71日の走は数えること(境界)", () => {
      const results = buildResults(100, [
        { gapBefore: 70, finish: rank(1) }, // 前走から70日 → 通常(4〜9週)
        { gapBefore: 71, finish: rank(2) }, // 前走から71日 → 休み明け
        { gapBefore: 0, finish: rank(9) },
      ]);
      const s = summarizeRestRecord(results, TODAY)!;
      // 先頭の走は「その前走(2番目)から70日」→ 数えない。2番目の走は「その前走(初戦)から71日」→ 数える。
      expect(s.走数).toBe(1);
      expect(s.着順).toEqual([2]);
    });
  });

  describe("着順の扱い(scorer の isPlaced と揃える)", () => {
    it("降着(demoted)は確定着順(value)で数えること: 3着(降)は3着内、4着(降)は着外", () => {
      const results = buildResults(100, [
        { gapBefore: 90, finish: rank(3, true) }, // 休み明け・降着だが確定3着 → 3着内
        { gapBefore: 90, finish: rank(4, true) }, // 休み明け・降着で確定4着 → 着外
        { gapBefore: 0, finish: rank(1) },
      ]);
      const s = summarizeRestRecord(results, TODAY)!;
      expect(s.走数).toBe(2);
      expect(s.三着).toBe(1);
      expect(s.着外).toBe(1);
      expect(s.三着内).toBe(1);
    });

    it("非数値着順(中止)・着順欠損の休み明け走は走数に数えないこと", () => {
      const results = buildResults(100, [
        { gapBefore: 90, finish: { kind: "非数値", text: "中止" } },
        { gapBefore: 90, finish: null },
        { gapBefore: 90, finish: rank(2) },
        { gapBefore: 0, finish: rank(1) },
      ]);
      const s = summarizeRestRecord(results, TODAY)!;
      // 3つの休み明け走のうち、判定できるのは2着の1走のみ。
      expect(s.走数).toBe(1);
      expect(s.二着).toBe(1);
    });

    it("休み明けの走の日付が欠損(間隔不明)なら数えないこと", () => {
      const results: HorseRaceResult[] = [
        makeResult({ date: addDays(TODAY, -100), finishPosition: rank(1) }),
        makeResult({ date: null, finishPosition: rank(2) }),
        makeResult({ date: addDays(TODAY, -400), finishPosition: rank(3) }),
      ];
      const s = summarizeRestRecord(results, TODAY)!;
      // 先頭の走: 前走(日付欠損)との間隔が出せない → 数えない。日付欠損の走: 間隔不明 → 数えない。
      expect(s.走数).toBe(0);
    });
  });

  describe("サンプル不足(2走未満は中立に扱わせる合図)", () => {
    it("休み明けが1走だけのとき、サンプル不足=true で note に「サンプル2走未満」と着順が入ること", () => {
      const results = buildResults(100, [
        { gapBefore: 90, finish: rank(3) },
        { gapBefore: 0, finish: rank(1) },
      ]);
      const s = summarizeRestRecord(results, TODAY)!;
      expect(s.走数).toBe(1);
      expect(s.サンプル不足).toBe(true);
      expect(s.note).toContain("サンプル2走未満");
      expect(s.note).toContain("3着");
    });

    it("休み明けが0走のとき、サンプル不足=true で note に「出走なし」と「サンプル2走未満」が入ること", () => {
      const results = buildResults(100, [
        { gapBefore: 20, finish: rank(3) },
        { gapBefore: 0, finish: rank(1) },
      ]);
      const s = summarizeRestRecord(results, TODAY)!;
      expect(s.走数).toBe(0);
      expect(s.サンプル不足).toBe(true);
      expect(s.note).toContain("出走なし");
      expect(s.note).toContain("サンプル2走未満");
    });

    it("休み明けがちょうど2走のとき、サンプル不足=false であること(境界)", () => {
      const results = buildResults(100, [
        { gapBefore: 90, finish: rank(3) },
        { gapBefore: 90, finish: rank(1) },
        { gapBefore: 0, finish: rank(1) },
      ]);
      const s = summarizeRestRecord(results, TODAY)!;
      expect(s.走数).toBe(2);
      expect(s.サンプル不足).toBe(false);
    });
  });

  describe("着順の一覧は新しい順に最大5走まで", () => {
    it("休み明け7走のとき、集計は7走すべてを数え、着順は新しい5走だけを持つこと", () => {
      const runs = [
        { gapBefore: 90, finish: rank(1) },
        { gapBefore: 90, finish: rank(2) },
        { gapBefore: 90, finish: rank(3) },
        { gapBefore: 90, finish: rank(4) },
        { gapBefore: 90, finish: rank(5) },
        { gapBefore: 90, finish: rank(6) },
        { gapBefore: 90, finish: rank(7) },
        { gapBefore: 0, finish: rank(8) },
      ];
      const s = summarizeRestRecord(buildResults(100, runs), TODAY)!;
      expect(s.走数).toBe(7);
      expect(s.着順).toEqual([1, 2, 3, 4, 5]);
      expect(s.三着内).toBe(3);
    });
  });

  describe("評価語を出さない(中立な事実のみ)", () => {
    it("note に評価語(得意・苦手・不安・買い・期待等)を含まないこと", () => {
      const results = buildResults(100, [
        { gapBefore: 90, finish: rank(1) },
        { gapBefore: 90, finish: rank(1) },
        { gapBefore: 0, finish: rank(4) },
      ]);
      const s = summarizeRestRecord(results, TODAY)!;
      for (const word of ["得意", "苦手", "不安", "買い", "期待", "鉄砲", "叩き", "良化"]) {
        expect(s.note).not.toContain(word);
      }
    });
  });
});
