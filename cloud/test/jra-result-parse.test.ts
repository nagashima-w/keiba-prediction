import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeShiftJis } from "../src/jra-http";
import { parseResultPage, raceIdFromResultCname } from "../src/jra-result-parse";

/**
 * Issue #698: JRA の過去の結果の頁(`pw01sde10…`)から、頭数とブリンカー着用の馬を読む(純関数)。保存済みの本物の頁(Shift_JIS)に対して確かめる。実サイトには出ない。
 * 頭数・馬の ID は、フィクスチャを正規表現で別に数えた値(`td.place` の行数と、`td.horse` 内のリンクの 10 桁・`icon blinker` の有無)。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const page = (name: string): string => decodeShiftJis(new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name))));

const CASES: { file: string; head: number; blinkers: string[] }[] = [
  { file: "jra_695_result_nakayama01R_20210105.html", head: 16, blinkers: ["2018103271", "2018102803"] },
  { file: "jra_695_result_hanshin01R_20250405.html", head: 16, blinkers: ["2022103064", "2022102427"] },
  { file: "jra_695_result_tokyo09R_20230604.html", head: 9, blinkers: ["2019104455", "2018105237"] },
  { file: "jra_695_result_kyoto04R_20050501.html", head: 12, blinkers: ["2002100638"] },
  { file: "jra_695_result_tokyo01R_19860601.html", head: 12, blinkers: ["1983103933"] },
  // 除外 1 頭(表の最後の行。td.place が「除外」)も頭数に含む。印は 1 頭。
  { file: "jra_695_result_tokyo05R_20261004_josai.html", head: 12, blinkers: ["2024106528"] },
  // 取消 1 頭(td.place が「取消」)も頭数に含む。印は無い。
  { file: "jra_695_result_nakayama01R_20260927_torikeshi.html", head: 16, blinkers: [] },
];

describe("parseResultPage: 本物の結果の頁", () => {
  it.each(CASES)("$file: 頭数 $head・ブリンカーの馬 $blinkers", ({ file, head, blinkers }) => {
    const r = parseResultPage(page(file));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headCount).toBe(head);
    expect(r.blinkerHorseIds).toEqual(blinkers);
  });

  it("前提: 上の表は、印のあるレースと無いレース・数字でない着順のレースを含む(空振りでない)", () => {
    expect(CASES.some((c) => c.blinkers.length >= 2)).toBe(true);
    expect(CASES.some((c) => c.blinkers.length === 0)).toBe(true);
    // 取消・除外のレースでは、頭数が数字の着順の行数より多い(取消・除外を数えている)
    for (const f of ["jra_695_result_nakayama01R_20260927_torikeshi.html", "jra_695_result_tokyo05R_20261004_josai.html"]) {
      const places = [...page(f).matchAll(/<td class="place">([^<]*)<\/td>/g)].map((m) => m[1]!);
      const numeric = places.filter((p) => /^\d+$/.test(p)).length;
      expect(places.length, f).toBeGreaterThan(numeric);
      const r = parseResultPage(page(f));
      expect(r.ok && r.headCount, f).toBe(places.length);
    }
  });

  it("誤りの頁(タイトルがパラメータエラー)は param-error、結果の頁でない頁(場日の頁・月の頁)は読めない", () => {
    expect(parseResultPage("<html><head><title>パラメータエラー　JRA</title></head><body></body></html>")).toEqual({ ok: false, reason: "param-error" });
    for (const f of ["jra_695_srl_nakayama_20210105.html", "jra_695_skl_month_202101.html", "jra_698_skl_month_202611_skl10_error.html"]) {
      const r = parseResultPage(page(f));
      expect(r.ok, f).toBe(false);
    }
  });
});

/** 合成: 本物の頁の 1 行の形に合わせた最小の結果の頁。 */
const row = (place: string, id: string | null, blinker: boolean): string =>
  `<tr><td class="place">${place}</td><td class="num">1</td><td class="horse">` +
  (id === null ? "馬名" : blinker ? `<div class="horse"><a href="/JRADB/accessU.html?CNAME=pw01dud10${id}/AC">馬</a><div class="icon blinker"><img alt="ブリンカー着用" /></div></div>` : `<a href="/JRADB/accessU.html?CNAME=pw01dud10${id}/AC">馬</a>`) +
  `</td></tr>`;
const html = (rows: string[], title = "レース結果　JRA"): string => `<html><head><title>${title}</title></head><body><table><tbody>${rows.join("")}</tbody></table></body></html>`;

describe("parseResultPage: 合成の頁", () => {
  it("合成: 取消の馬にも印があれば保存する対象にし、頭数にも数える(取消・除外に印が出るかは本物の頁で未観測)", () => {
    const r = parseResultPage(html([row("1", "2020100001", false), row("取消", "2020100002", true), row("除外", "2020100003", false)]));
    expect(r).toEqual({ ok: true, headCount: 3, blinkerHorseIds: ["2020100002"] });
  });

  it("合成: 中止・失格・降着(未観測の着順の文字)でも落ちず、頭数に数える", () => {
    const r = parseResultPage(html([row("1", "2020100001", false), row("中止", "2020100002", true), row("失格", "2020100003", false), row("降着", "2020100004", false), row("", "2020100005", false)]));
    expect(r).toEqual({ ok: true, headCount: 5, blinkerHorseIds: ["2020100002"] });
  });

  it("合成: 馬の ID が取れない行が 1 つでもあれば、頁ごと読めない(unparsable)。黙って頭数だけ数えると「表に行が無い = 着けていない」が崩れる", () => {
    expect(parseResultPage(html([row("1", "2020100001", false), row("2", null, false)]))).toEqual({ ok: false, reason: "unparsable" });
    // ID が 10 桁でないリンクも取れない行として扱う
    const bad = html([row("1", "2020100001", false)]).replace("pw01dud102020100001", "pw01dud1020201");
    expect(parseResultPage(bad)).toEqual({ ok: false, reason: "unparsable" });
  });

  it("合成: 行が 1 つも無い頁(結果の頁の題で中身が空)は unparsable。ブリンカーの印の置き場は td.horse の中だけ(ほかの場所の icon blinker は数えない)", () => {
    expect(parseResultPage(html([]))).toEqual({ ok: false, reason: "unparsable" });
    const stray = html([row("1", "2020100001", false)]).replace("<table>", `<div class="icon blinker"></div><table>`);
    expect(parseResultPage(stray)).toEqual({ ok: true, headCount: 1, blinkerHorseIds: [] });
  });

  it("合成: 結果の頁の題でない頁(馬ごとの頁など)は、td.place の行が似ていても読まない(unparsable)", () => {
    expect(parseResultPage(html([row("1", "2020100001", false)], "競走馬情報　JRA"))).toEqual({ ok: false, reason: "unparsable" });
  });

  it("合成: 出馬表の形の印(span.horse_icon.blinker)は数えない(結果の頁の印は div.icon.blinker)", () => {
    const r = html([`<tr><td class="place">1</td><td class="horse"><a href="/JRADB/accessU.html?CNAME=pw01dud102020100001/AC">馬</a><span class="horse_icon blinker"></span></td></tr>`]);
    expect(parseResultPage(r)).toEqual({ ok: true, headCount: 1, blinkerHorseIds: [] });
  });
});

describe("raceIdFromResultCname: 結果の頁の cname から netkeiba の race_id(年4・場2・回2・日2・R2)を組む", () => {
  it("既知の対応: 2026-09-27 中山 1R の cname は、netkeiba の 202606040901(fixtures/result_202606040901.html と同じレース)", () => {
    expect(raceIdFromResultCname("pw01sde1006202604090120260927/AB")).toEqual({ raceId: "202606040901", date: "20260927" });
    // 同じ頁のフィクスチャが netkeiba 側にあり、取消の馬(ニシノドリーマー)が出ていることで突き合わせ済み(調査 §2)
    expect(page("jra_695_result_nakayama01R_20260927_torikeshi.html")).toContain("ニシノドリーマー");
    expect(readFileSync(path.join(ROOT, "fixtures", "result_202606040901.html"), "utf8")).toContain("ニシノドリーマー");
  });

  it("2021-01-05 中山 1R は 202106010101(場日の頁のフィクスチャの cname)", () => {
    expect(raceIdFromResultCname("pw01sde1006202101010120210105/4F")).toEqual({ raceId: "202106010101", date: "20210105" });
    expect(raceIdFromResultCname("pw01sde1006202101011220210105/56")).toEqual({ raceId: "202106010112", date: "20210105" });
  });

  it("形が違う cname は null(結果以外の頁・桁の過不足・場コードが 01〜10 でない・符号が 16 進 2 桁でない)", () => {
    for (const c of ["pw01srl10062021010120210105/C6", "pw01sde100620210101012021010/4F", "pw01sde1011202101010120210105/4F", "pw01sde1006202101010120210105/4", "pw01sde1006202101010120210105/ZZ", "", "pw01sde1006202101010120210105/4F/x"]) {
      expect(raceIdFromResultCname(c), c).toBeNull();
    }
  });
});
