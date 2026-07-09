import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseRaceResult,
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
});

describe("公開API(index.tsからの再エクスポート)", () => {
  it("parseRaceResult / RaceResultParseError がindexから再エクスポートされていること", async () => {
    const mod = await import("../../src/index.js");
    expect(mod.parseRaceResult).toBe(parseRaceResult);
    expect(mod.RaceResultParseError).toBe(RaceResultParseError);
  });
});
