import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildHash, MIGRATION_HASH, parseHash, screenOf, SETTINGS_HASH, VERIFY_HASH, type Route } from "../client/route";

/**
 * Issue #184(#165-b): スマホ画面の状態(URL のハッシュ)の解析と組み立て。純関数。
 * ハッシュは利用者(または他サイトのリンク)が自由に書き換えられる入力なので、値はすべて検証し、不正な項目は捨てて既定に落とす(例外にしない)。
 * 既定: 日付は「今日(JST)」・区分は central・race と analysis は null。
 */

const TODAY = "20261007";
const DEFAULT: Route = { date: TODAY, venue: "central", race: null, analysis: null, settings: false };
const NAR_RACE = "202654071210";

describe("parseHash(正常な値)", () => {
  const cases: readonly [string, string, Route][] = [
    ["空のハッシュは既定", "", DEFAULT],
    ["# だけは既定", "#", DEFAULT],
    ["日付と区分(# 付き)", "#date=20261003&venue=nar", { date: "20261003", venue: "nar", race: null, analysis: null, settings: false }],
    ["# が無くても読める", "date=20261003&venue=nar", { date: "20261003", venue: "nar", race: null, analysis: null, settings: false }],
    ["区分だけなら日付は今日", "#venue=nar", { date: TODAY, venue: "nar", race: null, analysis: null, settings: false }],
    ["日付だけなら区分は central", "#date=20260628", { date: "20260628", venue: "central", race: null, analysis: null, settings: false }],
    ["race(日付と一緒)", `#date=20261003&venue=nar&race=${NAR_RACE}`, { date: "20261003", venue: "nar", race: NAR_RACE, analysis: null, settings: false }],
    ["analysis", "#analysis=123", { date: TODAY, venue: "central", race: null, analysis: 123, settings: false }],
    ["analysis の上限(2147483647)", "#analysis=2147483647", { date: TODAY, venue: "central", race: null, analysis: 2147483647, settings: false }],
    ["未知のキーは無視する", "#date=20261003&foo=bar&venue=nar", { date: "20261003", venue: "nar", race: null, analysis: null, settings: false }],
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
    expect(parseHash("#date=20261003&date=20261004&venue=nar", TODAY)).toEqual({ date: TODAY, venue: "nar", race: null, analysis: null, settings: false });
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
      { date: "20261003", venue: "nar", race: null, analysis: null, settings: false },
      { date: "20260628", venue: "central", race: "202603020211", analysis: null, settings: false },
      { date: "20261003", venue: "nar", race: NAR_RACE, analysis: 99, settings: false },
    ];
    for (const route of routes) {
      expect(route.date).not.toBe(TODAY); // 前提: 既定の日付に頼って通っていない
      expect(parseHash(buildHash(route), TODAY)).toEqual(route);
    }
  });
});

/**
 * Issue #191(#188 の申し送り): 「今どの画面か」の判定を `screenOf(route)` の1か所にまとめる。
 * 優先順位は既存のとおり analysis(結果画面)> race(レース画面)> 一覧。
 */
describe("screenOf(今どの画面か)", () => {
  const cases: readonly [string, Route, "list" | "race" | "result" | "settings" | "migration"][] = [
    ["race も analysis も無ければ一覧", { date: TODAY, venue: "central", race: null, analysis: null, settings: false }, "list"],
    ["race があればレース画面", { date: TODAY, venue: "central", race: NAR_RACE, analysis: null, settings: false }, "race"],
    ["analysis があれば結果画面", { date: TODAY, venue: "central", race: null, analysis: 7, settings: false }, "result"],
    ["race と analysis の両方があれば結果画面(analysis が優先)", { date: TODAY, venue: "nar", race: NAR_RACE, analysis: 7, settings: false }, "result"],
  ];
  for (const [name, route, expected] of cases) {
    it(name, () => {
      expect(screenOf(route)).toBe(expected);
    });
  }

  it("Issue #189: settings が true なら設定画面(race・analysis があっても。ただし parseHash は #settings の完全一致でしか true にしない)", () => {
    expect(screenOf({ date: TODAY, venue: "central", race: null, analysis: null, settings: true })).toBe("settings");
    expect(screenOf({ date: TODAY, venue: "central", race: NAR_RACE, analysis: 7, settings: true })).toBe("settings");
    expect(screenOf(parseHash("#settings", TODAY))).toBe("settings");
  });

  it("ハッシュから導いた route でも同じ(日付だけ・race つき・analysis つき・両方)", () => {
    expect(screenOf(parseHash("#date=20261003&venue=nar", TODAY))).toBe("list");
    expect(screenOf(parseHash(`#date=20261003&venue=nar&race=${NAR_RACE}`, TODAY))).toBe("race");
    expect(screenOf(parseHash("#analysis=5", TODAY))).toBe("result");
    expect(screenOf(parseHash(`#date=20261003&race=${NAR_RACE}&analysis=5`, TODAY))).toBe("result");
    // 日付の無い race は捨てられる(別の日のレースと取り違えない)ので一覧
    expect(screenOf(parseHash(`#race=${NAR_RACE}`, TODAY))).toBe("list");
  });
});

describe("app.ts は、画面の判定を screenOf だけに任せる(Issue #191)", () => {
  const code = readFileSync(path.join(__dirname, "..", "client", "app.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("前提: コメントを除いた本文が読めている", () => {
    expect(code.length).toBeGreaterThan(5000);
  });

  it("route.analysis・route.race を null と直接比べない(分岐は screenOf の switch・比較は route.race の値の取り出しだけ)", () => {
    expect(code.match(/route\.(analysis|race)\s*[!=]==\s*null/g) ?? []).toEqual([]);
  });

  // Issue #238(契約変更): 旧「5 つの関数が screenOf(route) を使う」は、`screenOf` に役割(閲覧者は設定・移行・検証を admin-only にする)を足した `currentScreen()` を使う、に変わった。
  // 保証していたこと(画面の判定が 1 か所に集まり、画面を判定する 5 つの関数がそれを使う)は保つ。加えて、`screenOf(route)` を直接呼ぶのは `currentScreen` の中の 1 箇所だけであること(役割の判定を素通りしない)を固定する。
  it("currentScreen() を呼ぶ箇所が、画面を判定する 5 つの関数(render・onCompleted・syncLatestAnalysis・ensureLoaded・onRefresh)にあり、screenOf(route) を直接呼ぶのは currentScreen の中の 1 箇所だけ", () => {
    for (const fn of ["render", "onCompleted", "syncLatestAnalysis", "ensureLoaded", "onRefresh"]) {
      const body = new RegExp(`function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\}\\n`).exec(code)?.[1];
      expect(body, `前提: ${fn} の本体を取り出せる`).toBeDefined();
      expect(body, `${fn} が currentScreen() を使う`).toContain("currentScreen()");
      expect(body, `${fn} が screenOf(route) を直接使わない(役割の判定を素通りしない)`).not.toContain("screenOf(route)");
    }
    expect((code.match(/currentScreen\(\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((code.match(/screenOf\(route\)/g) ?? []).length).toBe(1);
    const definition = /function currentScreen\(\)[^{]*\{([\s\S]*?)\n  \}\n/.exec(code)?.[1];
    expect(definition, "前提: currentScreen の本体を取り出せる").toBeDefined();
    expect(definition).toContain("screenOf(route)");
    expect(definition).toContain("admin-only");
  });

  it("対照: 検出は、旧い直接比較を拾える(空振りでない)", () => {
    expect("if (route.analysis !== null) {".match(/route\.(analysis|race)\s*[!=]==\s*null/g)).toHaveLength(1);
  });
});

/** Issue #189: `#settings`(完全一致のときだけ設定画面)。 */
describe("設定画面のハッシュ(#settings)", () => {
  it("SETTINGS_HASH は `#settings`", () => {
    expect(SETTINGS_HASH).toBe("#settings");
  });

  it("`#settings` は設定画面の route(日付は今日・区分は central・race と analysis は null)", () => {
    expect(parseHash("#settings", TODAY)).toEqual({ date: TODAY, venue: "central", race: null, analysis: null, settings: true });
  });

  it.each([["#settings&date=20261003"], ["#settings=1"], ["#Settings"], ["#settings "], ["#settings/"], ["#date=20261003&settings"], ["settings"], ["#"], [""], ["#setting"]])(
    "完全一致でない %j は設定画面にしない(従来どおりの解析)",
    (hash) => {
      expect(parseHash(hash, TODAY).settings).toBe(false);
    },
  );

  it("一覧・レース・結果のハッシュでは settings は false", () => {
    for (const hash of ["", "#date=20261003&venue=nar", `#date=20261003&venue=nar&race=${NAR_RACE}`, "#analysis=5"]) {
      expect(parseHash(hash, TODAY).settings, hash).toBe(false);
    }
  });

  it("buildHash は settings を出さない(設定画面への入口は SETTINGS_HASH だけ)", () => {
    expect(buildHash({ date: "20261003", venue: "nar" })).not.toContain("settings");
  });
});

/** Issue #222(#167-B2): `#migration`(完全一致のときだけ移行画面)。設定画面の「exe から移行」の節のリンク先。 */
describe("移行画面のハッシュ(#migration)", () => {
  it("MIGRATION_HASH は `#migration`", () => {
    expect(MIGRATION_HASH).toBe("#migration");
  });

  it("`#migration` は移行画面の route(日付は今日・区分は central・race と analysis は null・settings は false)", () => {
    expect(parseHash("#migration", TODAY)).toEqual({ date: TODAY, venue: "central", race: null, analysis: null, settings: false, migration: true });
    expect(screenOf(parseHash("#migration", TODAY))).toBe("migration");
  });

  it.each([["#migration&date=20261003"], ["#migration=1"], ["#Migration"], ["#migration "], ["#migration/"], ["#date=20261003&migration"], ["migration"], ["#migrate"], ["#settings"], ["#"], [""]])(
    "完全一致でない %j は移行画面にしない(従来どおりの解析)",
    (hash) => {
      expect(parseHash(hash, TODAY).migration ?? false).toBe(false);
      expect(screenOf(parseHash(hash, TODAY))).not.toBe("migration");
    },
  );

  it("移行画面は、設定画面とは別の画面(`#settings` は移行画面にならず、`#migration` は設定画面にならない)", () => {
    expect(screenOf(parseHash("#settings", TODAY))).toBe("settings");
    expect(screenOf(parseHash("#migration", TODAY))).toBe("migration");
    expect(parseHash("#migration", TODAY).settings).toBe(false);
  });

  it("screenOf の優先順位: settings > migration > analysis > race > 一覧(migration が true なら race・analysis があっても移行画面)", () => {
    expect(screenOf({ date: TODAY, venue: "central", race: NAR_RACE, analysis: 7, settings: false, migration: true })).toBe("migration");
    expect(screenOf({ date: TODAY, venue: "central", race: null, analysis: null, settings: true, migration: true })).toBe("settings");
  });

  it("buildHash は migration を出さない(移行画面への入口は MIGRATION_HASH だけ)", () => {
    expect(buildHash({ date: "20261003", venue: "nar" })).not.toContain("migration");
  });
});

/** Issue #219: `#verify`(完全一致のときだけ検証画面)。一覧の入口のリンク先。 */
describe("検証画面のハッシュ(#verify)", () => {
  it("VERIFY_HASH は `#verify`", () => {
    expect(VERIFY_HASH).toBe("#verify");
  });

  it("`#verify` は検証画面の route(日付は今日・区分は central・race と analysis は null・settings は false)", () => {
    expect(parseHash("#verify", TODAY)).toEqual({ date: TODAY, venue: "central", race: null, analysis: null, settings: false, verify: true });
    expect(screenOf(parseHash("#verify", TODAY))).toBe("verify");
  });

  it.each([["#verify&date=20261003"], ["#verify=1"], ["#Verify"], ["#verify "], ["#verify/"], ["#date=20261003&verify"], ["verify"], ["#verifying"], ["#settings"], ["#migration"], ["#"], [""]])(
    "完全一致でないハッシュ %j は検証画面にならない",
    (hash) => {
      expect(parseHash(hash, TODAY).verify ?? false).toBe(false);
      expect(screenOf(parseHash(hash, TODAY))).not.toBe("verify");
    },
  );

  it("検証画面は、設定画面・移行画面とは別の画面", () => {
    expect(screenOf(parseHash("#settings", TODAY))).toBe("settings");
    expect(screenOf(parseHash("#migration", TODAY))).toBe("migration");
    expect(parseHash("#verify", TODAY).settings).toBe(false);
    expect(parseHash("#verify", TODAY).migration ?? false).toBe(false);
    expect(parseHash("#settings", TODAY).verify ?? false).toBe(false);
  });

  it("screenOf の優先順位: settings > migration > verify > analysis > race > 一覧", () => {
    const base = { date: TODAY, venue: "central", race: NAR_RACE, analysis: 7, settings: false } as const;
    expect(screenOf({ ...base, verify: true })).toBe("verify");
    expect(screenOf({ ...base, verify: true, migration: true })).toBe("migration");
    expect(screenOf({ ...base, verify: true, settings: true })).toBe("settings");
  });

  it("buildHash は verify を出さない(検証画面への入口は VERIFY_HASH だけ)", () => {
    expect(buildHash({ date: "20261003", venue: "nar" })).not.toContain("verify");
  });
});
