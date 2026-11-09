import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeShiftJis } from "../src/jra-http";
import { parseHorseProfilePage } from "../src/jra-horse-parse";

/** Issue #697: JRA の馬ごとの頁(`accessU.html`)から、馬名・父・母・母の父・生産者を読むパーサ。見本は `fixtures/jra_695_horse_*`(Shift_JIS の原本)。 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const page = (name: string): string => decodeShiftJis(new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name))));

describe("parseHorseProfilePage(成功の頁)", () => {
  it("リンクのある日本の馬(ラストサムライ): 馬名・父・母・母の父・生産牧場。母の欄の「産駒」は混ざらない", () => {
    expect(parseHorseProfilePage(page("jra_695_horse_2018106541_retired2022.html"))).toEqual({
      ok: true,
      profile: { name: "ラストサムライ", sire: "クロフネ", dam: "ミラクルアイドル", damSire: "オレハマッテルゼ", breeder: "三嶋牧場" },
    });
  });

  it("リンクの無い欄(旧い馬。父・母・母の父が文字だけ)も読める。母の欄の「産駒」は除く", () => {
    expect(parseHorseProfilePage(page("jra_695_horse_1983107033_retired1987.html"))).toEqual({
      ok: true,
      profile: { name: "ハザマスワロー", sire: "マイスワロー", dam: "ハザマテンリユウ", damSire: "セルテイツクアツシユ", breeder: "中村 喜久造" },
    });
  });

  it("外国産馬(クロフネ): ラベルが「生産者」。馬名の前のマルガイの印の画像は馬名に混ざらない。名前の英名も混ざらない", () => {
    expect(parseHorseProfilePage(page("jra_695_horse_1998110135_foreign_sire.html"))).toEqual({
      ok: true,
      profile: { name: "クロフネ", sire: "French Deputy", dam: "Blue Avenue", damSire: "Classic Go Go", breeder: "Nicholas M. Lotz" },
    });
  });

  it("現役馬(放牧中の表示がある): 馬名に「放牧」が混ざらない", () => {
    const r = parseHorseProfilePage(page("jra_695_horse_2024100292_active.html"));
    expect(r).toEqual({
      ok: true,
      profile: { name: "マリノエスプレッソ", sire: "マテラスカイ", dam: "マリノエクスプレス", damSire: "フリオーソ", breeder: "クラウン日高牧場" },
    });
  });

  it("残りの 2 頭(マルカフレンドリー・ピースディオン)も読めて、どの欄にも「産駒」が混ざらない", () => {
    for (const f of ["jra_695_horse_2002100638_retired2005.html", "jra_695_horse_2017101230_retired2024.html"]) {
      const r = parseHorseProfilePage(page(f));
      expect(r.ok, f).toBe(true);
      if (r.ok) {
        for (const v of [r.profile.name, r.profile.sire, r.profile.dam, r.profile.damSire, r.profile.breeder]) {
          expect(v, f).not.toContain("産駒");
        }
      }
    }
  });
});

describe("parseHorseProfilePage(失敗の頁)", () => {
  it("パラメータエラーの頁は param-error", () => {
    expect(parseHorseProfilePage(page("jra_695_horse_param_error_nosymbol.html"))).toEqual({ ok: false, reason: "param-error" });
  });

  it("タイトルが「競走馬情報」でない頁(結果の頁)は not-profile", () => {
    expect(parseHorseProfilePage(page("jra_695_result_nakayama01R_20210105.html"))).toEqual({ ok: false, reason: "not-profile" });
    expect(parseHorseProfilePage("<html><head><title>JRA</title></head><body></body></html>")).toEqual({ ok: false, reason: "not-profile" });
  });

  it("タイトルは競走馬情報でも、馬名が読めない頁は unparsable", () => {
    expect(parseHorseProfilePage("<html><head><title>競走馬情報　JRA</title></head><body><div class=\"profile\"></div></body></html>")).toEqual({ ok: false, reason: "unparsable" });
  });

  it("馬名が空のとき(h1 が空)は unparsable。血統だけあっても保存しない", () => {
    const html =
      "<html><head><title>競走馬情報　JRA</title></head><body><h1><span class=\"inner\"><span class=\"txt\"><span class=\"opt\">競走馬情報</span></span></span></h1>" +
      "<div class=\"profile\"><div class=\"data\"><ul><li><dl><dt>父</dt><dd>A</dd></dl></li></ul></div></div></body></html>";
    expect(parseHorseProfilePage(html)).toEqual({ ok: false, reason: "unparsable" });
  });
});

describe("parseHorseProfilePage(欄の欠け)", () => {
  const body = (dls: string): string =>
    "<html><head><title>競走馬情報　JRA</title></head><body><h1><span class=\"inner\"><span class=\"txt\"><span class=\"opt\">競走馬情報</span>テスト馬<span class=\"name_en\">Test</span></span></span></h1>" +
    `<div class="profile"><div class="data"><ul>${dls}</ul></div></div></body></html>`;

  it("母の父・生産者の欄が無い、または空(&nbsp;)なら null。馬名は読める", () => {
    const r = parseHorseProfilePage(body("<li><dl><dt>父</dt><dd>父馬</dd></dl></li><li><dl><dt>母</dt><dd>&nbsp;</dd></dl></li>"));
    expect(r).toEqual({ ok: true, profile: { name: "テスト馬", sire: "父馬", dam: null, damSire: null, breeder: null } });
  });

  it("生産牧場と生産者の両方があれば生産牧場を使う", () => {
    const r = parseHorseProfilePage(body("<li><dl><dt>生産者</dt><dd>B</dd></dl></li><li><dl><dt>生産牧場</dt><dd>A牧場</dd></dl></li>"));
    expect(r.ok && r.profile.breeder).toBe("A牧場");
  });

  it("母の母の欄は読まない(母の欄と取り違えない)", () => {
    const r = parseHorseProfilePage(body("<li><dl><dt>母の母</dt><dd>母母<span class=\"sanku\">産駒</span></dd></dl></li>"));
    expect(r.ok && r.profile.dam).toBeNull();
  });
});
