import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseId } from "../../src/scraper/ids.js";
import {
  parseShutuba,
  ShutubaParseError,
} from "../../src/scraper/parse-shutuba.js";
import type { Shutuba } from "../../src/scraper/types.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/**
 * 出馬表の1行(tr.HorseList)を組み立てる。
 * 各項目は省略可能で、省略時は妥当なデフォルト値を使う。
 * 個々の分岐(馬体重未発表・騎手リンク欠損など)を検証するための最小行。
 */
function buildRow(
  opts: {
    waku?: string;
    umaban?: string;
    weight?: string;
    jockeyCell?: string;
  } = {},
): string {
  const waku = opts.waku ?? "1";
  const umaban = opts.umaban ?? "1";
  const weight = opts.weight ?? "464(-8)";
  const jockeyCell =
    opts.jockeyCell ??
    `<td class="Jockey"><a href="https://db.netkeiba.com/jockey/result/recent/01043/" title="騎手">騎手</a></td>`;
  return `
    <tr class="HorseList">
      <td class="Waku${waku} Txt_C"><span>${waku}</span></td>
      <td class="Umaban${umaban} Txt_C">${umaban}</td>
      <td class="HorseInfo"><span class="HorseName"><a href="https://db.netkeiba.com/horse/2023103386" title="テスト馬">テスト馬</a></span></td>
      <td class="Barei Txt_C">牡3</td>
      <td class="Txt_C">55.0</td>
      ${jockeyCell}
      <td class="Trainer"><span class="Label1">美浦</span><a href="https://db.netkeiba.com/trainer/result/recent/01126/" title="調教師">調教師</a></td>
      <td class="Weight">${weight}</td>
    </tr>`;
}

/** 出馬表ページ全体を組み立てる(出走馬行は0行以上を任意に指定できる)。 */
function buildPage(rows: string[]): string {
  return `
    <div class="RaceList_Item02">
      <h1 class="RaceName">テストレース</h1>
      <div class="RaceData01">15:45発走 / 芝1800m / 天候:晴 / 馬場:良</div>
    </div>
    <table><tbody>${rows.join("")}</tbody></table>`;
}

const raceA: Shutuba = parseShutuba(loadFixture("shutuba_202603020211.html"));
const raceB: Shutuba = parseShutuba(loadFixture("shutuba_202602010607.html"));
const raceC: Shutuba = parseShutuba(loadFixture("shutuba_202602010601.html"));

describe("parseShutuba(出馬表のレース情報)", () => {
  it("芝重賞(202603020211)のレース情報を抽出すること", () => {
    expect(raceA.race.raceName).toBe("ラジオNIKKEI賞");
    expect(raceA.race.courseType).toBe("芝");
    expect(raceA.race.distance).toBe(1800);
    expect(raceA.race.startTime).toBe("15:45");
    expect(raceA.race.weather).toBe("晴");
    expect(raceA.race.trackCondition).toBe("良");
  });

  it("ダート戦(202602010607)を種別「ダ」・馬場「稍」として抽出すること", () => {
    expect(raceB.race.raceName).toBe("3歳以上1勝クラス");
    expect(raceB.race.courseType).toBe("ダ");
    expect(raceB.race.distance).toBe(1700);
    expect(raceB.race.weather).toBe("晴");
    expect(raceB.race.trackCondition).toBe("稍");
  });

  it("2歳戦(202602010601)のレース情報を抽出すること", () => {
    expect(raceC.race.raceName).toBe("2歳未勝利");
    expect(raceC.race.courseType).toBe("芝");
    expect(raceC.race.distance).toBe(1200);
  });
});

describe("parseShutuba(出走馬の頭数)", () => {
  it("各フィクスチャの頭数(16/10/8)と一致すること", () => {
    expect(raceA.horses).toHaveLength(16);
    expect(raceB.horses).toHaveLength(10);
    expect(raceC.horses).toHaveLength(8);
  });
});

describe("parseShutuba(1頭目と最終馬の全項目一致)", () => {
  it("202603020211の1頭目(ルージュボヤージュ)の全項目が一致すること", () => {
    const h = raceA.horses[0]!;
    expect(h.wakuban).toBe(1);
    expect(h.umaban).toBe(1);
    expect(h.name).toBe("ルージュボヤージュ");
    expect(h.horseId).toBe("2023103386");
    expect(h.sex).toBe("牝");
    expect(h.age).toBe(3);
    expect(h.kinryo).toBe(52.0);
    expect(h.jockeyName).toBe("北村宏");
    expect(h.jockeyId).toBe("01043");
    expect(h.stableLocation).toBe("美浦");
    expect(h.trainerName).toBe("木村");
    expect(h.trainerId).toBe("01126");
    expect(h.bodyWeight).toEqual({ weight: 464, diff: -8 });
  });

  it("202603020211の最終馬(スペルーチェ)の全項目が一致すること", () => {
    const h = raceA.horses[15]!;
    expect(h.wakuban).toBe(8);
    expect(h.umaban).toBe(16);
    expect(h.name).toBe("スペルーチェ");
    expect(h.horseId).toBe("2023107352");
    expect(h.sex).toBe("牡");
    expect(h.age).toBe(3);
    expect(h.kinryo).toBe(55.0);
    expect(h.jockeyName).toBe("Ｍデムーロ");
    expect(h.jockeyId).toBe("05212");
    expect(h.stableLocation).toBe("美浦");
    expect(h.trainerName).toBe("宮田");
    expect(h.trainerId).toBe("01175");
    expect(h.bodyWeight).toEqual({ weight: 448, diff: -2 });
  });

  it("202602010607の1頭目(ウィンターガーデン)は栗東所属として抽出すること", () => {
    const h = raceB.horses[0]!;
    expect(h.umaban).toBe(1);
    expect(h.name).toBe("ウィンターガーデン");
    expect(h.horseId).toBe("2021105857");
    expect(h.sex).toBe("牝");
    expect(h.age).toBe(5);
    expect(h.stableLocation).toBe("栗東");
    expect(h.trainerId).toBe("01214");
  });
});

describe("parseShutuba(馬体重の分解)", () => {
  it("「464(-8)」を体重464・増減-8に分解すること", () => {
    expect(raceA.horses[0]!.bodyWeight).toEqual({ weight: 464, diff: -8 });
  });

  it("増減「(0)」を0として扱うこと", () => {
    // 202602010607 の馬番2(420(0))で増減0の分解を確認する。
    const h = raceB.horses.find((x) => x.umaban === 2)!;
    expect(h.bodyWeight).toEqual({ weight: 420, diff: 0 });
  });

  it("増減「(+2)」を正の値として扱うこと", () => {
    expect(raceB.horses[0]!.bodyWeight).toEqual({ weight: 496, diff: 2 });
  });
});

describe("parseShutuba(IDの妥当性)", () => {
  it("全馬のhorseIdがHorseId型として妥当(parseHorseIdを通る)であること", () => {
    for (const race of [raceA, raceB, raceC]) {
      for (const h of race.horses) {
        expect(() => parseHorseId(h.horseId)).not.toThrow();
      }
    }
  });
});

describe("parseShutuba(馬番・枠番の範囲検証)", () => {
  it("馬番19以上は不正データとしてShutubaParseErrorになること(上限18頭)", () => {
    expect(() =>
      parseShutuba(buildPage([buildRow({ waku: "8", umaban: "19" })])),
    ).toThrow(ShutubaParseError);
  });

  it("枠番9以上は不正データとしてShutubaParseErrorになること(枠は1〜8)", () => {
    expect(() =>
      parseShutuba(buildPage([buildRow({ waku: "9", umaban: "5" })])),
    ).toThrow(ShutubaParseError);
  });

  it("馬番1〜18・枠番1〜8の範囲内なら正常にパースできること", () => {
    const result = parseShutuba(buildPage([buildRow({ waku: "8", umaban: "18" })]));
    expect(result.horses).toHaveLength(1);
    expect(result.horses[0]!.umaban).toBe(18);
    expect(result.horses[0]!.wakuban).toBe(8);
  });
});

describe("parseShutuba(馬体重の未発表はnull)", () => {
  // 「計不(計量不能)」「--」「空」など、正規表現に一致しない表記は
  // 体重情報なし(null)として扱う(誤って数値に変換しない)。
  it.each([
    ["計不", "計量不能表記"],
    ["--", "ハイフン表記"],
    ["", "空文字"],
  ])("td.Weightが「%s」(%s)のときbodyWeightがnullになること", (weight) => {
    const result = parseShutuba(buildPage([buildRow({ weight })]));
    expect(result.horses[0]!.bodyWeight).toBeNull();
  });
});

describe("parseShutuba(出走馬0頭は失敗)", () => {
  it("出走馬行(td.HorseInfo)が1件も無いHTMLはShutubaParseErrorになること", () => {
    // 取りこぼしをsilentに空配列で隠さず、構造異常として失敗させる。
    expect(() => parseShutuba(buildPage([]))).toThrow(ShutubaParseError);
  });
});

describe("parseShutuba(出走馬は馬番昇順にソートされる)", () => {
  it("HTML上の行順が馬番の逆順でも、結果は馬番昇順になること", () => {
    const html = buildPage([
      buildRow({ waku: "3", umaban: "5" }),
      buildRow({ waku: "2", umaban: "3" }),
      buildRow({ waku: "1", umaban: "1" }),
    ]);
    const result = parseShutuba(html);
    expect(result.horses.map((h) => h.umaban)).toEqual([1, 3, 5]);
  });
});

describe("parseShutuba(騎手・調教師IDの欠損はnull)", () => {
  it("騎手リンクが無い行ではjockeyIdがnullになること", () => {
    const html = buildPage([
      buildRow({ jockeyCell: `<td class="Jockey">(未定)</td>` }),
    ]);
    const result = parseShutuba(html);
    expect(result.horses[0]!.jockeyId).toBeNull();
  });
});

describe("parseShutuba(地方(NAR)フィクスチャの互換性)", () => {
  const raceNar1: Shutuba = parseShutuba(
    loadFixture("nar_shutuba_202654071210.html"),
  );
  const raceNar2: Shutuba = parseShutuba(
    loadFixture("nar_shutuba_202642071301.html"),
  );

  it("高知10R(202654071210・終了後・12頭)を頭数12でパースできること", () => {
    expect(raceNar1.horses).toHaveLength(12);
    expect(raceNar1.race.courseType).toBe("ダ");
    expect(raceNar1.race.distance).toBe(1400);
  });

  it("浦和1R(202642071301・発走前・10頭)を頭数10でパースできること", () => {
    expect(raceNar2.horses).toHaveLength(10);
  });

  it("性齢(td.Barei classが無くspan.Ageで入る)を正しく分解すること", () => {
    // 高知10R1頭目: ジャスタースパーク 牡6。
    const h = raceNar1.horses.find((x) => x.umaban === 1)!;
    expect(h.name).toBe("ジャスタースパーク");
    expect(h.sex).toBe("牡");
    expect(h.age).toBe(6);
  });

  it("斤量(性齢セルの次列、位置ベース)を正しく抽出すること", () => {
    const h = raceNar1.horses.find((x) => x.umaban === 1)!;
    expect(h.kinryo).toBe(57.0);
  });

  it("厩舎所在地(span.LabelGrayに会場名が入る)を生の地名として保持すること", () => {
    const h = raceNar1.horses.find((x) => x.umaban === 1)!;
    expect(h.stableLocation).toBe("高知");
  });

  it("騎手ID・調教師IDが英数字混じり(例: a01bb)でも抽出できること", () => {
    const h = raceNar1.horses.find((x) => x.umaban === 1)!;
    expect(h.jockeyId).toBe("a01bb");
    expect(h.trainerId).toBe("a030b");
  });

  it("馬体重(増減)が正しく分解できること", () => {
    const h = raceNar1.horses.find((x) => x.umaban === 1)!;
    expect(h.bodyWeight).toEqual({ weight: 467, diff: 3 });
  });

  it("発走前(浦和1R)の厩舎所在地も生の地名として保持すること", () => {
    const h = raceNar2.horses.find((x) => x.umaban === 1)!;
    expect(h.stableLocation).toBe("浦和");
  });
});
