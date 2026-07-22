import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseRaceResult,
  RaceResultNotConfirmedError,
  RaceResultParseError,
} from "../../src/scraper/parse-race-result.js";
import type { RaceResult } from "../../src/scraper/types.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/**
 * 全着順テーブル(#All_Result_Table)の1行を組み立てる。
 * 着順・枠・馬番・馬名を差し替えられる最小行(非数値着順などの分岐検証用)。
 */
function buildResultRow(
  opts: { rank?: string; waku?: string; umaban?: string; name?: string } = {},
): string {
  const rank = opts.rank ?? "1";
  const waku = opts.waku ?? "1";
  const umaban = opts.umaban ?? "1";
  const name = opts.name ?? "テスト馬";
  return `
    <tr class="HorseList">
      <td class="Result_Num"><div class="Rank">${rank}</div></td>
      <td class="Num Waku${waku}"><div>${waku}</div></td>
      <td class="Num Txt_C"><div>${umaban}</div></td>
      <td class="Horse_Info">
        <span class="Horse_Name">
          <a href="https://db.netkeiba.com/horse/2022101678" title="${name}">
            <span class="HorseNameSpan">${name}</span>
          </a>
        </span>
      </td>
    </tr>`;
}

/** 結果テーブルのみを持つ最小HTML(払戻テーブルは任意で付与)。 */
function buildResultHtml(rows: string[], payoutTables = ""): string {
  return `<html><body>
    <table id="All_Result_Table"><tbody>${rows.join("")}</tbody></table>
    ${payoutTables}
    <table id="lap_summary"><tbody>
      <tr class="HorseList"><td class="Result_Num Sticky">1</td></tr>
    </tbody></table>
  </body></html>`;
}

/**
 * 結果テーブルのヘッダ行(実データ相当の完全版)。
 * 後3F・コーナー通過順のヘッダテキストを含み、列インデックス解決の対象になる。
 * includePassing=false でコーナー通過順の見出し自体を落とし、NARのような列欠落を再現する。
 */
function buildFullHeaderRow(includePassing = true): string {
  return `
    <tr class="Header">
      <th class="Result_Num">着<br>順</th>
      <th class="Waku">枠</th>
      <th class="Num">馬<br>番</th>
      <th class="Horse_Info"><div class="Horse_Name">馬名</div></th>
      <th>性齢</th>
      <th>斤量</th>
      <th>騎手</th>
      <th class="Time">タイム</th>
      <th>着差</th>
      <th>人<br>気</th>
      <th class="Odds">単勝<br>オッズ</th>
      <th>後3F</th>
      ${includePassing ? "<th>コーナー<br>通過順</th>" : ""}
      <th>厩舎</th>
      <th class="Weight">馬体重<br/><small>(増減)</small></th>
    </tr>`;
}

/**
 * ヘッダ(buildFullHeaderRow)の列位置に対応する結果行を構築する。
 * 後3F・コーナー通過順・枠のセル内容を個別に指定でき、異常系(空・非数値)を検証できる。
 * last3f/passingText を null にするとそのセル自体を省略する(セル欠損の再現)。
 */
function buildFullResultRow(
  opts: {
    rank?: string;
    wakuClass?: string;
    wakuText?: string;
    umaban?: string;
    name?: string;
    last3fText?: string | null;
    passingText?: string | null;
    includePassing?: boolean;
  } = {},
): string {
  const rank = opts.rank ?? "1";
  const wakuClass = opts.wakuClass ?? "1";
  const wakuText = opts.wakuText ?? wakuClass;
  const umaban = opts.umaban ?? "1";
  const name = opts.name ?? "テスト馬";
  const includePassing = opts.includePassing ?? true;
  const last3fCell =
    opts.last3fText === null
      ? ""
      : `<td class="Time">${opts.last3fText ?? "37.0"}</td>`;
  const passingCell =
    !includePassing || opts.passingText === null
      ? ""
      : `<td class="PassageRate">${opts.passingText ?? "2-2-2-2"}</td>`;
  return `
    <tr class="HorseList">
      <td class="Result_Num"><div class="Rank">${rank}</div></td>
      <td class="Num Waku${wakuClass}"><div>${wakuText}</div></td>
      <td class="Num Txt_C"><div>${umaban}</div></td>
      <td class="Horse_Info">
        <span class="Horse_Name">
          <a href="https://db.netkeiba.com/horse/2022101678" title="${name}">
            <span class="HorseNameSpan">${name}</span>
          </a>
        </span>
      </td>
      <td>牝4</td>
      <td>52.0</td>
      <td>騎手</td>
      <td>1:44.9</td>
      <td></td>
      <td>1</td>
      <td>1.0</td>
      ${last3fCell}
      ${passingCell}
      <td>栗東</td>
      <td>480(+2)</td>
    </tr>`;
}

/** ヘッダ付きの結果テーブルHTMLを構築する。 */
function buildFullResultHtml(headerRow: string, rows: string[]): string {
  return `<html><body>
    <table id="All_Result_Table">
      <thead>${headerRow}</thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  </body></html>`;
}

describe("parseRaceResult(レース結果パーサー)", () => {
  describe("フィクスチャ(函館7R・10頭)の実データ検証", () => {
    let result: RaceResult;
    it("パースが成功すること", () => {
      result = parseRaceResult(loadFixture("result_202602010607.html"));
      expect(result).toBeDefined();
    });

    it("全着順テーブルの10頭のみを返し、ラップ表など余分なHorseList行は含めないこと", () => {
      // 文書全体には tr.HorseList が13行あるが、結果は #All_Result_Table 内の10行のみ。
      expect(result.horses).toHaveLength(10);
    });

    it("各行の馬番・着順・馬名が正しく対応すること(枠番と馬番の取り違えがないこと)", () => {
      const byUmaban = new Map(result.horses.map((h) => [h.umaban, h]));
      // 1着=馬番4 キャットテイル。
      const first = byUmaban.get(4)!;
      expect(first.finishPosition).toEqual({ kind: "順位", value: 1 });
      expect(first.horseName).toBe("キャットテイル");
      // 3着=馬番9 ゴールドヴィーナス(枠8。枠と馬番が異なる行)。
      const third = byUmaban.get(9)!;
      expect(third.finishPosition).toEqual({ kind: "順位", value: 3 });
      expect(third.horseName).toBe("ゴールドヴィーナス");
      // 10着=馬番6 ガーネットフレア。
      const last = byUmaban.get(6)!;
      expect(last.finishPosition).toEqual({ kind: "順位", value: 10 });
      expect(last.horseName).toBe("ガーネットフレア");
    });

    it("複勝の確定払戻(馬番4:210円, 馬番2:170円, 馬番9:1060円)を返すこと", () => {
      expect(result.placePayouts).toEqual([
        { umaban: 4, payout: 210 },
        { umaban: 2, payout: 170 },
        { umaban: 9, payout: 1060 },
      ]);
    });

    it("単勝の確定払戻(馬番4:670円)を返すこと", () => {
      expect(result.winPayouts).toEqual([{ umaban: 4, payout: 670 }]);
    });

    it("各馬の通過順・後3F・枠が正しく取れること(ハイライト行でもクラスに依存せず後3Fを数値化すること)", () => {
      const byUmaban = new Map(result.horses.map((h) => [h.umaban, h]));
      // 1着(後3Fセルに BgBlue02 が付く)=馬番4。
      const first = byUmaban.get(4)!;
      expect(first.passing).toEqual([2, 2, 4, 2]);
      expect(first.last3f).toBe(37.2);
      expect(first.wakuban).toBe(4);
      // 2着(後3Fセルに BgYellow が付く)=馬番2。
      const second = byUmaban.get(2)!;
      expect(second.passing).toEqual([9, 9, 8, 6]);
      expect(second.last3f).toBe(36.8);
      expect(second.wakuban).toBe(2);
      // 3着(後3Fセルに BgOrange が付く・枠8≠馬番9)=馬番9。
      const third = byUmaban.get(9)!;
      expect(third.passing).toEqual([1, 1, 1, 1]);
      expect(third.last3f).toBe(37.8);
      expect(third.wakuban).toBe(8);
      // 10着(ハイライト無し)=馬番6。
      const last = byUmaban.get(6)!;
      expect(last.passing).toEqual([2, 2, 2, 4]);
      expect(last.last3f).toBe(40);
      expect(last.wakuban).toBe(6);
    });

    it("全10頭で通過順・後3F・枠がすべて欠損なく取れること", () => {
      for (const h of result.horses) {
        expect(h.passing.length).toBeGreaterThan(0);
        expect(h.last3f).not.toBeNull();
        expect(h.wakuban).not.toBeNull();
      }
    });
  });

  describe("着順の非数値(中止・除外など)", () => {
    it("非数値の着順は既存FinishPosition流儀で {kind:'非数値'} を返すこと", () => {
      const result = parseRaceResult(
        buildResultHtml([buildResultRow({ rank: "中止", umaban: "3" })]),
      );
      expect(result.horses[0]!.finishPosition).toEqual({
        kind: "非数値",
        text: "中止",
      });
    });

    it("着順表示が空の行は finishPosition=null を返すこと", () => {
      const result = parseRaceResult(
        buildResultHtml([buildResultRow({ rank: "", umaban: "3" })]),
      );
      expect(result.horses[0]!.finishPosition).toBeNull();
    });
  });

  describe("払戻テーブル欠損(未確定レース)への耐性", () => {
    it("払戻テーブルが無い場合は複勝・単勝払戻を空配列で返すこと", () => {
      const result = parseRaceResult(
        buildResultHtml([buildResultRow({ umaban: "1" })]),
      );
      expect(result.placePayouts).toEqual([]);
      expect(result.winPayouts).toEqual([]);
      expect(result.horses).toHaveLength(1);
    });
  });

  describe("構造異常は silent に隠さず失敗させる", () => {
    it("結果テーブル(#All_Result_Table)が無い場合は例外を投げること", () => {
      expect(() => parseRaceResult("<html><body>なし</body></html>")).toThrow(
        RaceResultParseError,
      );
    });

    it("複勝の的中馬番数と払戻件数が一致しない場合は例外を投げること", () => {
      const brokenPayout = `
        <table class="Payout_Detail_Table"><tbody>
          <tr class="Fukusho"><th>複勝</th>
            <td class="Result"><div><span>4</span></div><div><span>2</span></div></td>
            <td class="Payout"><span>210円</span></td>
            <td class="Ninki"><span>1人気</span></td>
          </tr>
        </tbody></table>`;
      expect(() =>
        parseRaceResult(
          buildResultHtml([buildResultRow({ umaban: "1" })], brokenPayout),
        ),
      ).toThrow(RaceResultParseError);
    });

    it("馬番セル(td.Num)が想定形(2セル・うち1つがWaku)でない場合は例外を投げること", () => {
      // 枠セルの Waku クラスが落ちた行(td.Num が2つとも非Waku)。
      // 枠番を馬番として silent 採用せず、loud に失敗させる。
      const brokenRow = `
        <tr class="HorseList">
          <td class="Result_Num"><div class="Rank">1</div></td>
          <td class="Num"><div>3</div></td>
          <td class="Num Txt_C"><div>7</div></td>
          <td class="Horse_Info">
            <span class="Horse_Name">
              <a href="https://db.netkeiba.com/horse/2022101678" title="X">X</a>
            </span>
          </td>
        </tr>`;
      expect(() => parseRaceResult(buildResultHtml([brokenRow]))).toThrow(
        RaceResultParseError,
      );
    });
  });

  describe("未確定レース(発走前・確定前)は構造異常と区別すること", () => {
    it("結果テーブル(#All_Result_Table)は存在するが結果行が0件の場合はRaceResultNotConfirmedErrorを投げること(構造異常のRaceResultParseErrorとは区別する)", () => {
      expect(() => parseRaceResult(buildResultHtml([]))).toThrow(
        RaceResultNotConfirmedError,
      );
    });

    it("結果テーブル(#All_Result_Table)が無い場合はRaceResultNotConfirmedErrorにはならないこと(従来どおりRaceResultParseError)", () => {
      let caught: unknown;
      try {
        parseRaceResult("<html><body>なし</body></html>");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RaceResultParseError);
      expect(caught).not.toBeInstanceOf(RaceResultNotConfirmedError);
    });

    it("実データ(発走前NARレース・#All_Result_Table あり/tbody空/払戻テーブルなし)でRaceResultNotConfirmedErrorを投げること", () => {
      expect(() =>
        parseRaceResult(
          loadFixture("nar_result_presale_202642071612.html"),
        ),
      ).toThrow(RaceResultNotConfirmedError);
    });
  });
});

describe("通過順・後3F・枠の異常系(空/非数値/列欠落)は例外を投げずフォールバックすること", () => {
  it("後3Fセルが空文字の場合は null になること", () => {
    const html = buildFullResultHtml(buildFullHeaderRow(), [
      buildFullResultRow({ last3fText: "" }),
    ]);
    expect(parseRaceResult(html).horses[0]!.last3f).toBeNull();
  });

  it("後3Fセルが非数値の場合は null になること", () => {
    const html = buildFullResultHtml(buildFullHeaderRow(), [
      buildFullResultRow({ last3fText: "計不" }),
    ]);
    expect(parseRaceResult(html).horses[0]!.last3f).toBeNull();
  });

  it("後3Fの見出し列が無い場合は null になること(ヘッダから列を解決できない)", () => {
    // buildFullHeaderRow をベースに「後3F」見出しを含まない特別なヘッダを組み立てる。
    const headerWithoutLast3f = `
      <tr class="Header">
        <th class="Result_Num">着<br>順</th>
        <th class="Waku">枠</th>
        <th class="Num">馬<br>番</th>
        <th class="Horse_Info"><div class="Horse_Name">馬名</div></th>
        <th class="Weight">馬体重<br/><small>(増減)</small></th>
      </tr>`;
    const row = `
      <tr class="HorseList">
        <td class="Result_Num"><div class="Rank">1</div></td>
        <td class="Num Waku1"><div>1</div></td>
        <td class="Num Txt_C"><div>1</div></td>
        <td class="Horse_Info">
          <span class="Horse_Name">
            <a href="https://db.netkeiba.com/horse/2022101678" title="テスト馬">
              <span class="HorseNameSpan">テスト馬</span>
            </a>
          </span>
        </td>
        <td>480(+2)</td>
      </tr>`;
    const html = buildFullResultHtml(headerWithoutLast3f, [row]);
    expect(parseRaceResult(html).horses[0]!.last3f).toBeNull();
  });

  it("通過順セルが空文字の場合は空配列になること", () => {
    const html = buildFullResultHtml(buildFullHeaderRow(), [
      buildFullResultRow({ passingText: "" }),
    ]);
    expect(parseRaceResult(html).horses[0]!.passing).toEqual([]);
  });

  it("通過順セルが非数値(例: 取消)の場合は空配列になること", () => {
    const html = buildFullResultHtml(buildFullHeaderRow(), [
      buildFullResultRow({ passingText: "取消" }),
    ]);
    expect(parseRaceResult(html).horses[0]!.passing).toEqual([]);
  });

  it("枠セルが空文字の場合は null になること", () => {
    const html = buildFullResultHtml(buildFullHeaderRow(), [
      buildFullResultRow({ wakuText: "" }),
    ]);
    expect(parseRaceResult(html).horses[0]!.wakuban).toBeNull();
  });

  it("枠セルが非数値の場合は null になること", () => {
    const html = buildFullResultHtml(buildFullHeaderRow(), [
      buildFullResultRow({ wakuText: "X" }),
    ]);
    expect(parseRaceResult(html).horses[0]!.wakuban).toBeNull();
  });

  it("ヘッダはあるが結果行のセル数が短い(欠損している)場合は後3F=null・通過順=空配列になること", () => {
    // 既存の最小行ビルダー(4セルのみ)をヘッダ付きテーブルに差し込み、セル欠損を再現する。
    const html = buildFullResultHtml(buildFullHeaderRow(), [
      buildResultRow({ umaban: "1" }),
    ]);
    const horse = parseRaceResult(html).horses[0]!;
    expect(horse.last3f).toBeNull();
    expect(horse.passing).toEqual([]);
  });

  it("行の途中のセルが欠けて後続列がズレている場合、ズレた別列の値を後3F・通過順としてsilentに拾わないこと(列インデックスは合っていても行のセル数がヘッダ列数と不一致なら読まない)", () => {
    // ヘッダは15列(着差列を含む)だが、この行だけ「着差」セルが丸ごと欠落し14セルになっている
    // (取消・除外等で中間セルが抜けるケースを想定)。素朴に列インデックス(後3F=11, 通過順=12)
    // だけで読むと、後続列が1つずつ前へズレて別の値(かつ数値/ハイフン区切りとして"もっともらしい"
    // 値)を誤って拾ってしまう。それを防ぎ、この行は後3F=null・通過順=空配列になることを確認する。
    const misalignedRow = `
      <tr class="HorseList">
        <td class="Result_Num"><div class="Rank">4</div></td>
        <td class="Num Waku2"><div>2</div></td>
        <td class="Num Txt_C"><div>7</div></td>
        <td class="Horse_Info">
          <span class="Horse_Name">
            <a href="https://db.netkeiba.com/horse/2022101678" title="ズレ馬">
              <span class="HorseNameSpan">ズレ馬</span>
            </a>
          </span>
        </td>
        <td>牡5</td>
        <td>55.0</td>
        <td>騎手</td>
        <td>1:45.0</td>
        <td>4</td>
        <td>6.7</td>
        <td>1.5</td>
        <td>42.5</td>
        <td>3-2-1-4</td>
        <td>480(+2)</td>
      </tr>`;
    const html = buildFullResultHtml(buildFullHeaderRow(), [
      misalignedRow,
      buildFullResultRow({ umaban: "1" }),
    ]);
    const horses = parseRaceResult(html).horses;
    const byUmaban = new Map(horses.map((h) => [h.umaban, h]));

    // セル数がズレた行(馬番7): インデックス11には本来コーナー通過順欄だった "42.5" が、
    // インデックス12には本来厩舎欄だった "3-2-1-4" が来てしまうが、これらを拾わない。
    const misaligned = byUmaban.get(7)!;
    expect(misaligned.last3f).toBeNull();
    expect(misaligned.passing).toEqual([]);

    // 同一テーブル内の正常行(馬番1・15セル)は従来どおり値が取れること。
    const normal = byUmaban.get(1)!;
    expect(normal.last3f).toBe(37);
    expect(normal.passing).toEqual([2, 2, 2, 2]);
  });

  it("中止・除外・降着など非数値着順の行でも通過順・後3F・枠の抽出でthrowしないこと", () => {
    const html = buildFullResultHtml(buildFullHeaderRow(), [
      buildFullResultRow({ rank: "中止", last3fText: "36.5", passingText: "3-3-3-3" }),
    ]);
    const horse = parseRaceResult(html).horses[0]!;
    expect(horse.finishPosition).toEqual({ kind: "非数値", text: "中止" });
    expect(horse.last3f).toBe(36.5);
    expect(horse.passing).toEqual([3, 3, 3, 3]);
  });
});

describe("parseRaceResult(地方(NAR)フィクスチャの互換性)", () => {
  // 高知1R(202654071201): 結果行に class="HorseList" が付かない(<tr >のみ)構造差分がある。
  let result: RaceResult;
  it("パースが成功すること(行に class が無くてもtbody直下のtrとして拾えること)", () => {
    result = parseRaceResult(loadFixture("nar_result_202654071201.html"));
    expect(result).toBeDefined();
    expect(result.horses).toHaveLength(10);
  });

  it("1着馬(馬番3・ライゾマティクス)の着順・馬名が正しく対応すること", () => {
    const byUmaban = new Map(result.horses.map((h) => [h.umaban, h]));
    const first = byUmaban.get(3)!;
    expect(first.finishPosition).toEqual({ kind: "順位", value: 1 });
    expect(first.horseName).toBe("ライゾマティクス");
  });

  it("単勝の確定払戻(馬番3:150円)を返すこと", () => {
    expect(result.winPayouts).toEqual([{ umaban: 3, payout: 150 }]);
  });

  it("複勝の確定払戻(馬番3:100円, 馬番4:110円, 馬番8:170円)を返すこと", () => {
    expect(result.placePayouts).toEqual([
      { umaban: 3, payout: 100 },
      { umaban: 4, payout: 110 },
      { umaban: 8, payout: 170 },
    ]);
  });

  it("コーナー通過順の見出し列が無いため、全頭とも通過順は空配列になること(throwしない)", () => {
    for (const h of result.horses) {
      expect(h.passing).toEqual([]);
    }
  });

  it("コーナー通過順が無い構造でも後3F・枠は取得できること(1着=馬番3: 後3F 38.8・枠3)", () => {
    const byUmaban = new Map(result.horses.map((h) => [h.umaban, h]));
    const first = byUmaban.get(3)!;
    expect(first.last3f).toBe(38.8);
    expect(first.wakuban).toBe(3);
  });

  it("枠と馬番が異なる行でも取り違えないこと(3着=馬番8・枠7)", () => {
    const byUmaban = new Map(result.horses.map((h) => [h.umaban, h]));
    const third = byUmaban.get(8)!;
    expect(third.finishPosition).toEqual({ kind: "順位", value: 3 });
    expect(third.wakuban).toBe(7);
  });
});

describe("公開API(index.tsからの再エクスポート)", () => {
  it("parseRaceResult / RaceResultParseError / RaceResultNotConfirmedError がindexから再エクスポートされていること", async () => {
    const mod = await import("../../src/index.js");
    expect(mod.parseRaceResult).toBe(parseRaceResult);
    expect(mod.RaceResultParseError).toBe(RaceResultParseError);
    expect(mod.RaceResultNotConfirmedError).toBe(RaceResultNotConfirmedError);
  });
});
