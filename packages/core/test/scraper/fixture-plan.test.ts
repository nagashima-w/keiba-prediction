import { describe, expect, it } from "vitest";
import {
  InvalidIdError,
  parseHorseId,
  parseKaisaiDate,
  parseRaceId,
} from "../../src/scraper/ids.js";
import {
  parseFetchArgs,
  planFixtureTargets,
  type FixtureTarget,
} from "../../src/scraper/fixture-plan.js";

// テスト内で検証済み型を得るための薄いヘルパ(本体のパーサを利用する)。
function parse(d: string) {
  return parseKaisaiDate(d);
}
function race(r: string) {
  return parseRaceId(r);
}
function horse(h: string) {
  return parseHorseId(h);
}

describe("parseFetchArgs(取得スクリプトの引数パース)", () => {
  it("開催日・レースID(複数)・馬ID(複数)を検証済みで取り出せること", () => {
    const args = parseFetchArgs([
      "--date",
      "20260628",
      "--race",
      "202605020811",
      "--race",
      "202601020811",
      "--horse",
      "2019105219",
    ]);
    expect(args.date).toBe("20260628");
    expect(args.races).toEqual(["202605020811", "202601020811"]);
    expect(args.horses).toEqual(["2019105219"]);
  });

  it("引数なしのときは開催日なし・空配列を返すこと", () => {
    const args = parseFetchArgs([]);
    expect(args.date).toBeUndefined();
    expect(args.races).toEqual([]);
    expect(args.horses).toEqual([]);
  });

  it("不正なレースIDはInvalidIdErrorとして伝播すること", () => {
    expect(() => parseFetchArgs(["--race", "202611020811"])).toThrow(
      InvalidIdError,
    );
  });

  it("不正な開催日はInvalidIdErrorとして伝播すること", () => {
    expect(() => parseFetchArgs(["--date", "20260229"])).toThrow(InvalidIdError);
  });

  it("未知のフラグはエラーになること", () => {
    expect(() => parseFetchArgs(["--unknown", "x"])).toThrow(/未知/);
  });

  it("値を伴わないフラグはエラーになること", () => {
    expect(() => parseFetchArgs(["--date"])).toThrow(/値/);
  });

  it("--dateが複数回指定された場合はエラーになること", () => {
    expect(() =>
      parseFetchArgs(["--date", "20260628", "--date", "20260629"]),
    ).toThrow(/開催日/);
  });

  it("回次・日次(7〜10桁目)は範囲検証されず、回次99・日次99でも受理されること", () => {
    // 202605999911 = 2026(年) + 05(競馬場) + 99(回次) + 99(日次) + 11(レース番号)。
    // 回次・日次は範囲チェックしない仕様のため受理される(検証対象は競馬場・レース番号のみ)。
    const args = parseFetchArgs(["--race", "202605999911"]);
    expect(args.races).toEqual(["202605999911"]);
  });
});

describe("planFixtureTargets(取得対象とファイル名・URLの対応)", () => {
  const find = (targets: FixtureTarget[], filename: string): FixtureTarget => {
    const t = targets.find((x) => x.filename === filename);
    if (!t) {
      throw new Error(`ファイル名${filename}の取得対象が見つかりません`);
    }
    return t;
  };

  it("開催日からレース一覧サブHTMLの取得対象を生成すること", () => {
    const targets = planFixtureTargets({
      date: parse("20260628"),
      races: [],
      horses: [],
    });
    const t = find(targets, "race_list_sub_20260628.html");
    expect(t.url).toBe(
      "https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260628",
    );
    expect(t.encoding).toBeUndefined();
  });

  it("レースIDから競馬新聞・追い切り・厩舎コメントの3対象を生成すること", () => {
    const targets = planFixtureTargets({
      date: undefined,
      races: [race("202605020811")],
      horses: [],
    });
    expect(find(targets, "newspaper_202605020811.html").url).toBe(
      "https://race.netkeiba.com/race/newspaper.html?race_id=202605020811",
    );
    expect(find(targets, "oikiri_202605020811.html").url).toBe(
      "https://race.netkeiba.com/race/oikiri.html?race_id=202605020811",
    );
    expect(find(targets, "comment_202605020811.html").url).toBe(
      "https://race.netkeiba.com/race/comment.html?race_id=202605020811",
    );
  });

  it("馬IDから馬個別ページの取得対象を生成し、EUC-JPを指定すること", () => {
    const targets = planFixtureTargets({
      date: undefined,
      races: [],
      horses: [horse("2019105219")],
    });
    const t = find(targets, "horse_2019105219.html");
    expect(t.url).toBe("https://db.netkeiba.com/horse/2019105219/");
    expect(t.encoding).toBe("euc-jp");
  });

  it("複数の対象をまとめて計画できること(件数の確認)", () => {
    const targets = planFixtureTargets({
      date: parse("20260628"),
      races: [race("202605020811"), race("202601020811")],
      horses: [horse("2019105219")],
    });
    // 開催日1 + レース2×3 + 馬1 = 8対象
    expect(targets).toHaveLength(8);
  });

  it("開催日なし・レースなし・馬なしのときは空配列を返すこと", () => {
    const targets = planFixtureTargets({
      date: undefined,
      races: [],
      horses: [],
    });
    expect(targets).toEqual([]);
  });

  it("同一レースIDが重複指定されても同一URLは1回だけ計画すること", () => {
    const targets = planFixtureTargets({
      date: undefined,
      races: [race("202605020811"), race("202605020811")],
      horses: [],
    });
    // 重複を除けば新聞・追い切り・コメントの3対象のみ。
    expect(targets).toHaveLength(3);
    const urls = targets.map((t) => t.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("同一馬IDが重複指定されても同一URLは1回だけ計画すること", () => {
    const targets = planFixtureTargets({
      date: undefined,
      races: [],
      horses: [horse("2019105219"), horse("2019105219")],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.url).toBe("https://db.netkeiba.com/horse/2019105219/");
  });
});
