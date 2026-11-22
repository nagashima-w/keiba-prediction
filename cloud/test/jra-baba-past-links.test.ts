import { describe, expect, it } from "vitest";
import iconv from "iconv-lite";

import { babaPastPdfUrl, babaPastYearUrl } from "../src/jra-http";
import { parseBabaPastPdfPath, parseBabaPastYearPage } from "../src/jra-baba-past-links";
import { fixtureText } from "./jra-baba-samples";

/**
 * Issue #769(段 1): 過去の含水率・クッション値の「年の頁」から PDF の一覧を取る(純関数)。
 * 実物は `fixtures/jra_baba_past_year_2021.html`(2026-11-17 に取得。Shift_JIS)。期待値は `grep -o '2021pdf/[a-z]*' | sort | uniq -c` で数えた値
 * (札幌 2・函館 1・福島 2・新潟 5・東京 5・中山 5・中京 6・阪神 6・小倉 4 = 36。京都は 2021 年には無い)。
 */
const PAGE_2021 = fixtureText("jra_baba_past_year_2021.html");

const sjis = (html: string): string => iconv.decode(iconv.encode(html, "shift_jis"), "shift_jis");

const page = (year: number, hrefs: readonly string[]): string =>
  sjis(`<html><head><title>${year}年の含水率・クッション値（馬場情報）　JRA</title></head><body>${hrefs.map((h) => `<li><a href="${h}">第1回</a></li>`).join("")}</body></html>`);

describe("年の頁の URL", () => {
  it("年の頁と PDF の URL を組み立てる", () => {
    expect(babaPastYearUrl(2021)).toBe("https://www.jra.go.jp/keiba/baba/archive/2021.html");
    expect(babaPastPdfUrl("2021pdf/tokyo01.pdf")).toBe("https://www.jra.go.jp/keiba/baba/archive/2021pdf/tokyo01.pdf");
  });
});

describe("parseBabaPastYearPage(実物の 2021 年)", () => {
  const r = parseBabaPastYearPage(PAGE_2021, 2021);

  it("PDF が 36 本で、載っている順に並ぶ", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.links).toHaveLength(36);
    expect(r.skipped).toBe(0);
    expect(r.links[0]).toEqual({ path: "2021pdf/sapporo01.pdf", year: 2021, venueCode: "01", kai: 1 });
    expect(r.links[35]).toEqual({ path: "2021pdf/kokura04.pdf", year: 2021, venueCode: "10", kai: 4 });
  });

  it("場ごとの本数が実物の数と一致し、京都(08)は無い", () => {
    if (!r.ok) throw new Error("読めていない");
    const byVenue: Record<string, number> = {};
    for (const l of r.links) byVenue[l.venueCode] = (byVenue[l.venueCode] ?? 0) + 1;
    expect(byVenue).toEqual({ "01": 2, "02": 1, "03": 2, "04": 5, "05": 5, "06": 5, "07": 6, "09": 6, "10": 4 });
  });

  it("同じ PDF が重複しても 1 本に数える", () => {
    const dup = page(2021, ["/keiba/baba/archive/2021pdf/tokyo01.pdf", "/keiba/baba/archive/2021pdf/tokyo01.pdf"]);
    const d = parseBabaPastYearPage(dup, 2021);
    expect(d.ok && d.links.length).toBe(1);
  });
});

describe("parseBabaPastYearPage(境界・異常)", () => {
  it("題名の年が違う頁(別の年が返ったとき)は shape-mismatch", () => {
    const r = parseBabaPastYearPage(PAGE_2021, 2022);
    expect(r).toEqual({ ok: false, result: "shape-mismatch" });
  });

  it("題名の年が違う頁は、PDF の名前の年が合っていても shape-mismatch(題名で見分ける)", () => {
    const r = parseBabaPastYearPage(page(2022, ["/keiba/baba/archive/2021pdf/tokyo01.pdf"]), 2021);
    expect(r).toEqual({ ok: false, result: "shape-mismatch" });
  });

  it("PDF が 0 本なら shape-mismatch", () => {
    expect(parseBabaPastYearPage(page(2021, []), 2021)).toEqual({ ok: false, result: "shape-mismatch" });
  });

  it("知らない場の PDF は捨てて数える(読めた分は返す)", () => {
    const r = parseBabaPastYearPage(page(2021, ["/keiba/baba/archive/2021pdf/tokyo01.pdf", "/keiba/baba/archive/2021pdf/obihiro01.pdf"]), 2021);
    expect(r.ok && r.links.map((l) => l.path)).toEqual(["2021pdf/tokyo01.pdf"]);
    expect(r.ok && r.skipped).toBe(1);
  });

  it("別の年のディレクトリの PDF は捨てて数える", () => {
    const r = parseBabaPastYearPage(page(2021, ["/keiba/baba/archive/2021pdf/tokyo01.pdf", "/keiba/baba/archive/2020pdf/tokyo01.pdf"]), 2021);
    expect(r.ok && r.links).toHaveLength(1);
    expect(r.ok && r.skipped).toBe(1);
  });

  it("開催回が 0 の PDF は捨てて数える", () => {
    const r = parseBabaPastYearPage(page(2021, ["/keiba/baba/archive/2021pdf/tokyo00.pdf", "/keiba/baba/archive/2021pdf/tokyo02.pdf"]), 2021);
    expect(r.ok && r.links.map((l) => l.kai)).toEqual([2]);
    expect(r.ok && r.skipped).toBe(1);
  });

  it("読める PDF が 1 本も無い(全部が知らない場)なら shape-mismatch", () => {
    expect(parseBabaPastYearPage(page(2021, ["/keiba/baba/archive/2021pdf/obihiro01.pdf"]), 2021)).toEqual({ ok: false, result: "shape-mismatch" });
  });
});

describe("parseBabaPastPdfPath(Issue #789。記録済みの PDF の名前から、年・場・回を取る)", () => {
  it("年の頁の PDF の名前の形から、年・場コード・開催回を取る", () => {
    expect(parseBabaPastPdfPath("2021pdf/hanshin02.pdf")).toEqual({ path: "2021pdf/hanshin02.pdf", year: 2021, venueCode: "09", kai: 2 });
    expect(parseBabaPastPdfPath("2022pdf/nakayama05.pdf")).toEqual({ path: "2022pdf/nakayama05.pdf", year: 2022, venueCode: "06", kai: 5 });
  });
  it("知らない場・開催回 0・形の違う名前は null", () => {
    for (const p of ["2021pdf/unknown01.pdf", "2021pdf/tokyo00.pdf", "2021/tokyo01.pdf", "2021pdf/tokyo1.pdf", "../2021pdf/tokyo01.pdf", "2021pdf/tokyo01.pdf?x"]) expect(parseBabaPastPdfPath(p), p).toBeNull();
  });
});
