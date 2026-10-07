import { describe, expect, it } from "vitest";
import { buildHash, parseHash, type Route } from "../client/route";

/**
 * Issue #184(#165-b): スマホ画面の状態(URL のハッシュ)の解析と組み立て。純関数。
 * ハッシュは利用者(または他サイトのリンク)が自由に書き換えられる入力なので、値はすべて検証し、不正な項目は捨てて既定に落とす(例外にしない)。
 * 既定: 日付は「今日(JST)」・区分は central・race と analysis は null。
 */

const TODAY = "20261007";
const DEFAULT: Route = { date: TODAY, venue: "central", race: null, analysis: null };
const NAR_RACE = "202654071210";

describe("parseHash(正常な値)", () => {
  const cases: readonly [string, string, Route][] = [
    ["空のハッシュは既定", "", DEFAULT],
    ["# だけは既定", "#", DEFAULT],
    ["日付と区分(# 付き)", "#date=20261003&venue=nar", { date: "20261003", venue: "nar", race: null, analysis: null }],
    ["# が無くても読める", "date=20261003&venue=nar", { date: "20261003", venue: "nar", race: null, analysis: null }],
    ["区分だけなら日付は今日", "#venue=nar", { date: TODAY, venue: "nar", race: null, analysis: null }],
    ["日付だけなら区分は central", "#date=20260628", { date: "20260628", venue: "central", race: null, analysis: null }],
    ["race(日付と一緒)", `#date=20261003&venue=nar&race=${NAR_RACE}`, { date: "20261003", venue: "nar", race: NAR_RACE, analysis: null }],
    ["analysis", "#analysis=123", { date: TODAY, venue: "central", race: null, analysis: 123 }],
    ["analysis の上限(2147483647)", "#analysis=2147483647", { date: TODAY, venue: "central", race: null, analysis: 2147483647 }],
    ["未知のキーは無視する", "#date=20261003&foo=bar&venue=nar", { date: "20261003", venue: "nar", race: null, analysis: null }],
  ];
  for (const [name, hash, expected] of cases) {
    it(name, () => {
      expect(parseHash(hash, TODAY)).toEqual(expected);
    });
  }
});

describe("parseHash(不正な値は項目ごとに既定へ落ちる。例外にしない)", () => {
  const badDates = ["2026-10-03", "20261301", "20260230", "2026100", "202610033", "", "abc", "２０２６１００３", "<img src=x onerror=alert(1)>", "20261003%00"];
  for (const bad of badDates) {
    it(`date=${JSON.stringify(bad)} は今日になり、区分などは保たれる`, () => {
      const route = parseHash(`#date=${encodeURIComponent(bad)}&venue=nar`, TODAY);
      expect(route.date).toBe(TODAY);
      expect(route.venue).toBe("nar");
    });
  }

  const badVenues = ["NAR", "jra", "", "nar ", "central,nar", "<script>"];
  for (const bad of badVenues) {
    it(`venue=${JSON.stringify(bad)} は central になる`, () => {
      expect(parseHash(`#date=20261003&venue=${encodeURIComponent(bad)}`, TODAY).venue).toBe("central");
    });
  }

  const badRaces = ["20265407121", "2026540712100", "20265407121a", "", "<script>alert(1)</script>", " 202654071210"];
  for (const bad of badRaces) {
    it(`race=${JSON.stringify(bad)} は null になる`, () => {
      expect(parseHash(`#date=20261003&venue=nar&race=${encodeURIComponent(bad)}`, TODAY).race).toBeNull();
    });
  }

  const badAnalyses = ["0", "012", "-1", "1.5", "abc", "", "2147483648", "12345678901", "1e3", "+5"];
  for (const bad of badAnalyses) {
    it(`analysis=${JSON.stringify(bad)} は null になる`, () => {
      expect(parseHash(`#analysis=${encodeURIComponent(bad)}`, TODAY).analysis).toBeNull();
    });
  }

  it("日付が無い(または不正な)ときは、race を捨てる(中央のレースIDは日付を含まず、別の日の画面に取り違えるため)", () => {
    expect(parseHash(`#venue=nar&race=${NAR_RACE}`, TODAY).race).toBeNull();
    expect(parseHash(`#date=20261301&venue=nar&race=${NAR_RACE}`, TODAY).race).toBeNull();
    // 対照: 日付が正しければ残る(上の2つが「race を常に捨てる」実装で通らないことの確認)
    expect(parseHash(`#date=20261003&venue=nar&race=${NAR_RACE}`, TODAY).race).toBe(NAR_RACE);
  });

  it("同じキーが重複していたら、そのキーは不正として既定に落ちる(どちらを採るかを曖昧にしない)", () => {
    expect(parseHash("#date=20261003&date=20261004&venue=nar", TODAY)).toEqual({ date: TODAY, venue: "nar", race: null, analysis: null });
    expect(parseHash("#venue=nar&venue=central", TODAY).venue).toBe("central");
  });

  it("壊れたパーセントエンコードでも例外にならない", () => {
    expect(() => parseHash("#date=%E0%A4%A&venue=%", TODAY)).not.toThrow();
    expect(parseHash("#date=%E0%A4%A&venue=%", TODAY)).toEqual(DEFAULT);
  });
});

describe("buildHash", () => {
  it("日付と区分(race・analysis が無ければ付けない)", () => {
    expect(buildHash({ date: "20261003", venue: "nar" })).toBe("#date=20261003&venue=nar");
    expect(buildHash({ date: "20261003", venue: "nar", race: null, analysis: null })).toBe("#date=20261003&venue=nar");
  });
  it("race・analysis があれば付ける", () => {
    expect(buildHash({ date: "20261003", venue: "nar", race: NAR_RACE })).toBe(`#date=20261003&venue=nar&race=${NAR_RACE}`);
    expect(buildHash({ date: "20261003", venue: "central", analysis: 42 })).toBe("#date=20261003&venue=central&analysis=42");
  });
  it("往復: parseHash(buildHash(route)) は元の route に戻る(既定と異なる値で確かめる)", () => {
    const routes: Route[] = [
      { date: "20261003", venue: "nar", race: null, analysis: null },
      { date: "20260628", venue: "central", race: "202603020211", analysis: null },
      { date: "20261003", venue: "nar", race: NAR_RACE, analysis: 99 },
    ];
    for (const route of routes) {
      expect(route.date).not.toBe(TODAY); // 前提: 既定の日付に頼って通っていない
      expect(parseHash(buildHash(route), TODAY)).toEqual(route);
    }
  });
});
