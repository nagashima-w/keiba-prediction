import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHorseId } from "../../src/scraper/ids.js";
import {
  OikiriParseError,
  parseOikiri,
} from "../../src/scraper/parse-oikiri.js";
import type { OikiriResult } from "../../src/scraper/types.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

const oikiri: OikiriResult = parseOikiri(
  loadFixture("oikiri_202603020211.html"),
);

describe("parseOikiri(実データの抽出)", () => {
  it("16頭分を抽出し、スキップは0件であること", () => {
    expect(oikiri.entries).toHaveLength(16);
    expect(oikiri.skippedRowCount).toBe(0);
    expect(oikiri.skipped).toEqual([]);
  });

  it("馬番1(ルージュボヤージュ)の全項目が一致すること", () => {
    const e = oikiri.entries[0]!;
    expect(e.umaban).toBe(1);
    expect(e.horseId).toBe("2023103386");
    expect(e.horseName).toBe("ルージュボヤージュ");
    expect(e.critic).toBe("動き良化");
    expect(e.rank).toBe("B");
  });

  it("評価ランクA(馬番5・リッツパーティー)を抽出すること", () => {
    const e = oikiri.entries.find((x) => x.umaban === 5)!;
    expect(e.horseName).toBe("リッツパーティー");
    expect(e.critic).toBe("気配抜群");
    expect(e.rank).toBe("A");
  });

  it("全馬の horseId が HorseId 型として妥当であること", () => {
    for (const e of oikiri.entries) {
      expect(() => parseHorseId(e.horseId)).not.toThrow();
    }
  });
});

describe("parseOikiri(評価空のnull許容)", () => {
  it("評価テキストが空の馬は critic が null になること", () => {
    const html = buildOikiriPage([buildRow({ umaban: "1", critic: "" })]);
    const e = parseOikiri(html).entries[0]!;
    expect(e.critic).toBeNull();
  });

  it("評価ランクセルが無い馬は rank が null になること", () => {
    const html = buildOikiriPage([buildRow({ umaban: "1", includeRank: false })]);
    const e = parseOikiri(html).entries[0]!;
    expect(e.rank).toBeNull();
  });
});

describe("parseOikiri(異常行はスキップして正常行は返す)", () => {
  it("馬番範囲外・馬IDリンク欠損の異常行はスキップし、正常行のみ返すこと", () => {
    // 正常(1)・馬番範囲外(19)・馬IDリンク欠損・正常(2) の4行を混在させる。
    const html = buildOikiriPage([
      buildRow({ umaban: "1" }),
      buildRow({ umaban: "19" }),
      buildRow({ umaban: "3", horseLink: false }),
      buildRow({ umaban: "2" }),
    ]);
    const result = parseOikiri(html);
    // 正常な2頭のみ返る。
    expect(result.entries.map((e) => e.umaban)).toEqual([1, 2]);
    // スキップは silent にせず件数と理由を記録する。
    expect(result.skippedRowCount).toBe(2);
    expect(result.skipped).toHaveLength(2);
    // 各スキップに理由テキストが入っていること。
    for (const s of result.skipped) {
      expect(typeof s.reason).toBe("string");
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });

  it("馬番が範囲外の行1件だけでも全体は失敗せず、その行だけスキップされること", () => {
    const html = buildOikiriPage([
      buildRow({ umaban: "1" }),
      buildRow({ umaban: "0" }),
    ]);
    const result = parseOikiri(html);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.umaban).toBe(1);
    expect(result.skippedRowCount).toBe(1);
  });
});

describe("parseOikiri(構造異常は失敗)", () => {
  it("OikiriTable が無いHTMLは OikiriParseError になること", () => {
    expect(() => parseOikiri("<html><body>調教表なし</body></html>")).toThrow(
      OikiriParseError,
    );
  });

  it("調教行(tr.HorseList)が1件も無いHTMLは OikiriParseError になること", () => {
    const html = `<table class="OikiriTable"><tr><th>枠</th></tr></table>`;
    expect(() => parseOikiri(html)).toThrow(OikiriParseError);
  });
});

/** 調教1頭分の行を組み立てる(評価空・ランク欠損・異常行の検証用)。 */
function buildRow(
  opts: {
    umaban?: string;
    critic?: string;
    includeRank?: boolean;
    horseLink?: boolean;
  } = {},
): string {
  const umaban = opts.umaban ?? "1";
  const critic = opts.critic ?? "動き良化";
  const includeRank = opts.includeRank ?? true;
  const horseLink = opts.horseLink ?? true;
  const rankCell = includeRank
    ? `<td class="Rank_動き良化">B</td>`
    : `<td>&nbsp;</td>`;
  const horseNameCell = horseLink
    ? `<div class="Horse_Name"><a href="https://db.netkeiba.com/horse/2023103386" target="_blank">テスト馬</a></div>`
    : `<div class="Horse_Name">テスト馬</div>`;
  return `
    <tr class="OikiriDataHead1 HorseList">
      <td class="Waku1"><span>1</span></td>
      <td class="Umaban">${umaban}</td>
      <td class="CheckMark Horse_Select"></td>
      <td class="Horse_Info fc">
        ${horseNameCell}
      </td>
      <td class="Training_Critic">${critic}</td>
      ${rankCell}
      <td><a href="#">映像</a></td>
    </tr>`;
}

/** 調教ページ全体を組み立てる。 */
function buildOikiriPage(rows: string[]): string {
  return `
    <table class="race_table_01 nk_tb_common OikiriTable OikiriType2 Stable_Time">
      <tr align="center"><th>枠</th><th>馬番</th><th>印</th><th>馬名</th><th colspan="2">評価</th><th>映像</th></tr>
      ${rows.join("")}
    </table>`;
}
