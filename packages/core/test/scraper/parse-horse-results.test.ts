import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HorseResultsParseError,
  parseHorseResults,
} from "../../src/scraper/parse-horse-results.js";
import type { HorseRaceResult } from "../../src/scraper/types.js";

/** フィクスチャ(JSON文字列)を読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

const winter: HorseRaceResult[] = parseHorseResults(
  loadFixture("horse_results_2021105857.json"),
);
const rouge: HorseRaceResult[] = parseHorseResults(
  loadFixture("horse_results_2023103386.json"),
);
const chikaba: HorseRaceResult[] = parseHorseResults(
  loadFixture("horse_results_2024104976.json"),
);
// 地方交流・海外遠征を含む実フィクスチャ(フォーエバーヤング、15走)。
const forever: HorseRaceResult[] = parseHorseResults(
  loadFixture("horse_results_2021105727.json"),
);

describe("parseHorseResults(走数)", () => {
  it("各フィクスチャの走数(23/4/3)と一致すること", () => {
    // 注: フィクスチャは取得時点の全戦績。件数はフィクスチャ実体に合わせる。
    expect(winter).toHaveLength(23);
    expect(rouge).toHaveLength(4);
    expect(chikaba).toHaveLength(3);
  });
});

describe("parseHorseResults(実データ1走分の全項目)", () => {
  it("ウィンターガーデンの最新走(1函館6・ダ1700)の全項目が一致すること", () => {
    const r = winter[0]!;
    expect(r.date).toBe("2026/06/28");
    expect(r.venue).toEqual({
      round: 1,
      name: "函館",
      day: 6,
      raw: "1函館6",
    });
    expect(r.weather).toBe("晴");
    expect(r.raceNumber).toBe(7);
    expect(r.raceName).toBe("3歳以上1勝クラス");
    expect(r.raceId).toBe("202602010607");
    expect(r.entryCount).toBe(10);
    expect(r.wakuban).toBe(1);
    expect(r.umaban).toBe(1);
    expect(r.odds).toBe(34.1);
    expect(r.ninki).toBe(7);
    expect(r.finishPosition).toEqual({ kind: "順位", value: 7 });
    expect(r.jockeyName).toBe("舟山瑠泉");
    expect(r.jockeyId).toBe("01221");
    expect(r.kinryo).toBe(55);
    expect(r.courseType).toBe("ダ");
    expect(r.distance).toBe(1700);
    expect(r.trackCondition).toBe("稍");
    expect(r.time).toBe("1:46.0");
    expect(r.margin).toBe(1.1);
    expect(r.passing).toEqual([5, 4, 8, 6]);
    expect(r.pace).toBe("29.9-37.6");
    expect(r.last3f).toBe(38.0);
    expect(r.bodyWeight).toEqual({ weight: 496, diff: 2 });
    expect(r.winnerName).toBe("キャットテイル");
  });

  it("スプリント戦の通過順は2区間の配列になること(1200m: 6-5)", () => {
    // ウィンターガーデンの最終走(ダ1200)は通過が2区間。
    const last = winter[winter.length - 1]!;
    expect(last.distance).toBe(1200);
    expect(last.passing).toEqual([6, 5]);
  });

  it("勝ち馬は着差が負値になり得ること(-0.1)", () => {
    const won = winter.find(
      (r) => r.finishPosition?.kind === "順位" && r.finishPosition.value === 1,
    )!;
    expect(won.margin).toBeLessThan(0);
  });
});

describe("parseHorseResults(地方・海外走を含む実フィクスチャ: フォーエバーヤング)", () => {
  it("地方・海外走を含めて全15走を1行も捨てずにパースできること", () => {
    expect(forever).toHaveLength(15);
  });

  it("中央走(2歳新馬・2京都4)は raceId が RaceId 型・venueKind が中央になること", () => {
    const r = forever.find((x) => x.raceName === "2歳新馬")!;
    expect(r.venueKind).toBe("中央");
    expect(r.raceId).toBe("202308020404");
    expect(r.raceIdRaw).toBe("202308020404");
    // 中央走は通常の全項目が取得できる。
    expect(r.venue).toEqual({ round: 2, name: "京都", day: 4, raw: "2京都4" });
    expect(r.finishPosition).toEqual({ kind: "順位", value: 1 });
  });

  it("地方交流走(東京大賞典・大井)は raceId が null・raceIdRaw に生12桁ID・venueKind が地方になること", () => {
    const r = forever.find(
      (x) => x.raceName === "東京大賞典競走(GI)",
    )!;
    expect(r.venueKind).toBe("地方");
    // 中央の場コード範囲外(場コード44=大井)のため RaceId 型は入れない。
    expect(r.raceId).toBeNull();
    // ただし取得できた生の12桁IDは保持する(Phase2のローテーション集計で使う)。
    expect(r.raceIdRaw).toBe("202444122909");
    // 開催名(回次・日目なし)は round/day null。
    expect(r.venue).toEqual({ round: null, name: "大井", day: null, raw: "大井" });
    expect(r.finishPosition).toEqual({ kind: "順位", value: 1 });
  });

  it("海外走(ドバイワールドC・メイダン)は raceId/raceIdRaw が null・venueKind が海外になること", () => {
    // フィクスチャ先頭の海外走(2026 ドバイワールドC、メイダン)。
    const r = forever[0]!;
    expect(r.raceName).toBe("ドバイワールドC(GI)");
    expect(r.venueKind).toBe("海外");
    // レースIDリンクが別形式(英字混じり)で中央/地方の12桁数値IDとして取得不能。
    expect(r.raceId).toBeNull();
    expect(r.raceIdRaw).toBeNull();
    // 「メイダン」は回次・日目の数字がないため round/day null。
    expect(r.venue).toEqual({
      round: null,
      name: "メイダン",
      day: null,
      raw: "メイダン",
    });
    // 海外走の欠損項目: 枠番・タイム・通過・ペース・上り3F・馬体重(計不)。
    expect(r.wakuban).toBeNull();
    expect(r.time).toBeNull();
    expect(r.passing).toEqual([]);
    expect(r.pace).toBeNull();
    expect(r.last3f).toBeNull();
    expect(r.bodyWeight).toBeNull();
    // 注: このフィクスチャの当該行は頭数が空ではなく実データ上 9 が入る
    // (タスク記載の「頭数が空」はこの行には当てはまらない実測差異。報告参照)。
    expect(r.entryCount).toBe(9);
  });
});

describe("parseHorseResults(降着表記の順位保持)", () => {
  it("着順「5(降)」は順位5として保持し降着フラグを立てること", () => {
    const json = buildResultsJson([buildRow({ chakujun: "5(降)" })]);
    const r = parseHorseResults(json)[0]!;
    expect(r.finishPosition).toEqual({ kind: "順位", value: 5, demoted: true });
  });

  it("全角括弧の降着表記「3(降)」も順位3として保持すること", () => {
    const json = buildResultsJson([buildRow({ chakujun: "3(降)" })]);
    const r = parseHorseResults(json)[0]!;
    expect(r.finishPosition).toEqual({ kind: "順位", value: 3, demoted: true });
  });

  it("通常の順位には降着フラグが付かないこと", () => {
    const json = buildResultsJson([buildRow({ chakujun: "3" })]);
    const r = parseHorseResults(json)[0]!;
    expect(r.finishPosition).toEqual({ kind: "順位", value: 3 });
    expect((r.finishPosition as { demoted?: boolean }).demoted).toBeUndefined();
  });
});

describe("parseHorseResults(着順の判別可能な型)", () => {
  it("数値の着順は kind:順位 として value を持つこと", () => {
    const json = buildResultsJson([buildRow({ chakujun: "3" })]);
    const r = parseHorseResults(json)[0]!;
    expect(r.finishPosition).toEqual({ kind: "順位", value: 3 });
  });

  it.each([["中止"], ["除外"], ["取消"], ["失格"]])(
    "非数値の着順「%s」は kind:非数値 として text を持つこと",
    (text) => {
      const json = buildResultsJson([buildRow({ chakujun: text })]);
      const r = parseHorseResults(json)[0]!;
      expect(r.finishPosition).toEqual({ kind: "非数値", text });
    },
  );

  it("着順が空セルの場合は finishPosition が null になること", () => {
    const json = buildResultsJson([buildRow({ chakujun: "" })]);
    const r = parseHorseResults(json)[0]!;
    expect(r.finishPosition).toBeNull();
  });
});

describe("parseHorseResults(空セル・欠損のnull許容)", () => {
  it("タイム・通過・上がり・馬体重が空でも壊れず null / 空配列になること", () => {
    const json = buildResultsJson([
      buildRow({ time: "", passing: "", last3f: "", weight: "" }),
    ]);
    const r = parseHorseResults(json)[0]!;
    expect(r.time).toBeNull();
    expect(r.passing).toEqual([]);
    expect(r.last3f).toBeNull();
    expect(r.bodyWeight).toBeNull();
  });

  it("レース名リンクが無い行では raceId が null になること", () => {
    const json = buildResultsJson([buildRow({ raceLink: false })]);
    const r = parseHorseResults(json)[0]!;
    expect(r.raceId).toBeNull();
    expect(r.raceName).toBe("レース名");
  });
});

describe("parseHorseResults(中央場コードだが不正な12桁IDでも行を捨てない)", () => {
  it("場コード01〜10だがレース番号が範囲外(下2桁13)のIDは raceId null にフォールバックし行を保持すること", () => {
    // 202308020413: 場コード08(中央範囲)だがレース番号13(01〜12外)。
    // parseRaceId が InvalidIdError を投げるケースだが、行そのものは捨てず raceIdRaw に生値を残す。
    const raceCellHtml =
      '<a href="https://db.netkeiba.com/race/202308020413/">レース名</a>';
    const json = buildResultsJson([buildRow({ raceCellHtml })]);
    const r = parseHorseResults(json)[0]!;
    expect(r.venueKind).toBe("中央");
    expect(r.raceId).toBeNull();
    expect(r.raceIdRaw).toBe("202308020413");
    expect(r.raceName).toBe("レース名");
  });
});

describe("parseHorseResults(JSON・status検証)", () => {
  it("JSONとして解釈できない入力は HorseResultsParseError になること", () => {
    expect(() => parseHorseResults("これはJSONではない")).toThrow(
      HorseResultsParseError,
    );
  });

  it('status が "OK" でない(NG)場合は HorseResultsParseError になること', () => {
    expect(() =>
      parseHorseResults(JSON.stringify({ status: "NG", data: "" })),
    ).toThrow(HorseResultsParseError);
  });
});

describe("parseHorseResults(壊れた行はsilentに捨てない)", () => {
  it("セル数がヘッダ列数と一致しない行があれば HorseResultsParseError になること", () => {
    // 33列ヘッダに対して3セルしか無い壊れた行。取りこぼしを空配列で隠さず失敗させる。
    const brokenRow = "<tr><td>a</td><td>b</td><td>c</td></tr>";
    const json = buildResultsJson([brokenRow]);
    expect(() => parseHorseResults(json)).toThrow(HorseResultsParseError);
  });

  it("戦績テーブルが存在しないHTMLフラグメントは HorseResultsParseError になること", () => {
    const json = JSON.stringify({
      status: "OK",
      data: "<div>戦績テーブルなし</div>",
    });
    expect(() => parseHorseResults(json)).toThrow(HorseResultsParseError);
  });
});

/** 戦績テーブルのヘッダ33列。実データと同じ列構成を再現する。 */
const HEADER_LABELS = [
  "日付",
  "開催",
  "天気",
  "R",
  "レース名",
  "映像",
  "頭数",
  "枠番",
  "馬番",
  "オッズ",
  "人気",
  "着順",
  "騎手",
  "斤量",
  "距離",
  "水分量",
  "馬場",
  "馬場指数",
  "タイム",
  "着差",
  "指数",
  "指数M",
  "スタート",
  "追走",
  "上がり指数",
  "通過",
  "ペース",
  "上り",
  "馬体重",
  "厩舎コメント",
  "備考",
  "勝ち馬",
  "賞金",
];

/**
 * 戦績1走分の行(33セル)を組み立てる。境界値(非数値着順・空セル)検証用。
 */
function buildRow(
  opts: {
    chakujun?: string;
    time?: string;
    passing?: string;
    last3f?: string;
    weight?: string;
    raceLink?: boolean;
    raceCellHtml?: string;
  } = {},
): string {
  const chakujun = opts.chakujun ?? "1";
  const time = opts.time ?? "1:46.0";
  const passing = opts.passing ?? "5-4-8-6";
  const last3f = opts.last3f ?? "38.0";
  const weight = opts.weight ?? "496(+2)";
  const raceLink = opts.raceLink ?? true;
  // raceCellHtml が指定されればそれを最優先(不正IDリンク等の検証用)。
  const raceCell =
    opts.raceCellHtml ??
    (raceLink
      ? '<a href="https://db.netkeiba.com/race/202602010607/">レース名</a>'
      : "レース名");
  const cells = [
    '<a href="https://db.netkeiba.com/race/list/20260628/">2026/06/28</a>', // 日付
    "1函館6", // 開催
    "晴", // 天気
    "7", // R
    raceCell, // レース名
    "", // 映像
    "10", // 頭数
    "1", // 枠番
    "1", // 馬番
    "34.1", // オッズ
    "7", // 人気
    chakujun, // 着順
    '<a href="https://db.netkeiba.com/jockey/result/recent/01221/">舟山瑠泉</a>', // 騎手
    "55", // 斤量
    "ダ1700", // 距離
    "", // 水分量
    "稍", // 馬場
    "-24", // 馬場指数
    time, // タイム
    "1.1", // 着差
    "", // 指数
    "", // 指数M
    "", // スタート
    "", // 追走
    "", // 上がり指数
    passing, // 通過
    "29.9-37.6", // ペース
    last3f, // 上り
    weight, // 馬体重
    "", // 厩舎コメント
    "&nbsp;", // 備考
    '<a href="https://db.netkeiba.com/horse/2022101678/">キャットテイル</a>', // 勝ち馬
    "", // 賞金
  ];
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
}

/** 戦績テーブルを含むAPIレスポンス(JSON文字列)を組み立てる。 */
function buildResultsJson(dataRows: string[]): string {
  const header = `<tr>${HEADER_LABELS.map((l) => `<th>${l}</th>`).join("")}</tr>`;
  const data = `<table class="db_h_race_results nk_tb_common">${header}${dataRows.join("")}</table>`;
  return JSON.stringify({ status: "OK", data });
}
