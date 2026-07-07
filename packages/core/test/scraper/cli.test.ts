import { describe, expect, it } from "vitest";
import { InvalidIdError } from "../../src/scraper/ids.js";
import { DEFAULT_CACHE_DB, parseCliArgs } from "../../src/scraper/cli.js";

describe("parseCliArgs(JSONダンプCLIの引数パース)", () => {
  it("--race のみ指定でレースダンプコマンドになり、既定値が入ること", () => {
    const cmd = parseCliArgs(["--race", "202603020211"]);
    expect(cmd).toEqual({
      kind: "race",
      raceId: "202603020211",
      out: null,
      freshOdds: false,
      db: DEFAULT_CACHE_DB,
    });
  });

  it("--race に --out / --fresh-odds / --db を組み合わせられること", () => {
    const cmd = parseCliArgs([
      "--race",
      "202603020211",
      "--out",
      "out.json",
      "--fresh-odds",
      "--db",
      "my.sqlite",
    ]);
    expect(cmd).toEqual({
      kind: "race",
      raceId: "202603020211",
      out: "out.json",
      freshOdds: true,
      db: "my.sqlite",
    });
  });

  it("--date のみ指定でレース一覧ダンプコマンドになること", () => {
    const cmd = parseCliArgs(["--date", "20260628"]);
    expect(cmd).toEqual({
      kind: "date",
      date: "20260628",
      out: null,
      db: DEFAULT_CACHE_DB,
    });
  });

  it("--date に --out / --db を組み合わせられること", () => {
    const cmd = parseCliArgs([
      "--date",
      "20260628",
      "--out",
      "list.json",
      "--db",
      "my.sqlite",
    ]);
    expect(cmd).toEqual({
      kind: "date",
      date: "20260628",
      out: "list.json",
      db: "my.sqlite",
    });
  });

  it("--race と --date の同時指定はエラーになること", () => {
    expect(() =>
      parseCliArgs(["--race", "202603020211", "--date", "20260628"]),
    ).toThrow(/同時/);
  });

  it("--race も --date も無い場合はエラーになること", () => {
    expect(() => parseCliArgs([])).toThrow(/--race|--date/);
  });

  it("--fresh-odds を --date と併用するとエラーになること", () => {
    expect(() =>
      parseCliArgs(["--date", "20260628", "--fresh-odds"]),
    ).toThrow(/fresh-odds/);
  });

  it("未知のフラグはエラーになること", () => {
    expect(() => parseCliArgs(["--race", "202603020211", "--foo"])).toThrow(
      /未知/,
    );
  });

  it("値を伴わないフラグはエラーになること", () => {
    expect(() => parseCliArgs(["--race"])).toThrow(/値/);
  });

  it("不正なレースIDはInvalidIdErrorとして伝播すること", () => {
    expect(() => parseCliArgs(["--race", "202611020811"])).toThrow(
      InvalidIdError,
    );
  });

  it("不正な開催日はInvalidIdErrorとして伝播すること", () => {
    expect(() => parseCliArgs(["--date", "20260229"])).toThrow(InvalidIdError);
  });

  it("--race が重複指定された場合はエラーになること", () => {
    expect(() =>
      parseCliArgs(["--race", "202603020211", "--race", "202603020212"]),
    ).toThrow(/1回/);
  });

  it("--out が重複指定された場合はエラーになること", () => {
    expect(() =>
      parseCliArgs(["--race", "202603020211", "--out", "a.json", "--out", "b.json"]),
    ).toThrow(/1回/);
  });

  it("--db が重複指定された場合はエラーになること", () => {
    expect(() =>
      parseCliArgs(["--race", "202603020211", "--db", "a.sqlite", "--db", "b.sqlite"]),
    ).toThrow(/1回/);
  });
});
