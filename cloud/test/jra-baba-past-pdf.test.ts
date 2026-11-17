import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseBabaPastPdf, type BabaPastRow } from "../src/jra-baba-past-pdf";
import { pathFromMeta } from "./meta-path";
import { PAST_EXPECTED } from "./jra-baba-past-samples";
import { buildPdf, layoutLines, type SynthBlock } from "./jra-baba-past-synth";

/**
 * Issue #769(段 1): 過去の馬場の PDF の読み取り(純関数)。
 * 実物(`fixtures/jra_baba_past_*.pdf`。書式ごと: 2018 札幌1回〈含水率のみ・日付が別行〉・2020 中山4回〈クッション値が後・月曜の列〉・2021 東京1回・2022 阪神3回・
 * 2023 京都2回〈月曜の列〉・2024 東京1回〈Linearized・content stream が 8 本・ObjStm〉)の期待値は、`pdftotext` の出力を別の方法(python)で読んだ値。
 * 合成の PDF(`jra-baba-past-synth.ts`)で、境界・欠落・壊れた入力を確かめる。
 */

const fmt = (n: number | null): string => (n === null ? "-" : n.toFixed(1));
const dump = (rows: readonly BabaPastRow[]): string =>
  rows.map((r) => `${r.kaisaiDate} ${r.weekday} ${[r.cushion, r.turfGoalMoisture, r.turfCorner4Moisture, r.dirtGoalMoisture, r.dirtCorner4Moisture].map(fmt).join(" ")}`).join("\n");
const FIXTURES = pathFromMeta("../../fixtures/", import.meta.url);
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(`${FIXTURES}${name}`));

const BLOCK_FRI: SynthBlock = {
  dateText: "（2021年1月29日～31日）",
  weekdays: ["金", "土", "日"],
  cushion: ["8.4", "8.8", "9.3"],
  turfGoal: ["18.6", "16.2", "14.6"],
  turfCorner4: ["18.8", "16.8", "14.5"],
  dirtGoal: ["12.8", "11.1", "10.2"],
  dirtCorner4: ["12.7", "11.1", "10.6"],
};
const TITLE = "2021年第1回東京競馬含水率・クッション値";

async function parseOk(bytes: Uint8Array) {
  const r = await parseBabaPastPdf(bytes);
  if (!r.ok) throw new Error(`読めない: ${r.result}`);
  return r;
}

describe("実物の PDF(書式ごと)", () => {
  for (const e of PAST_EXPECTED) {
    it(`${e.file}: 年・回・場・全部の行が pdftotext の値と一致する`, async () => {
      const r = await parseOk(fixture(e.file));
      expect(r.year).toBe(e.year);
      expect(r.kai).toBe(e.kai);
      expect(r.venueName).toBe(e.venue);
      expect(r.rows.length).toBeGreaterThan(0);
      expect(dump(r.rows)).toBe(e.table);
    });
  }

  it("実物の行数: 2018=9・2020=13・2021=12・2022=6・2023=13・2024=12(合計 65。期待値の表の行数と一致)", async () => {
    const counts: Record<string, number> = {};
    for (const e of PAST_EXPECTED) counts[e.file] = (await parseOk(fixture(e.file))).rows.length;
    expect(Object.values(counts)).toEqual([9, 13, 12, 6, 13, 12]);
    expect(PAST_EXPECTED.reduce((n, e) => n + e.table.split("\n").length, 0)).toBe(65);
  });

  it("場コードは見出しの場名から決める(東京 05・中山 06・阪神 09・京都 08・札幌 01)", async () => {
    const codes: string[] = [];
    for (const e of PAST_EXPECTED) codes.push((await parseOk(fixture(e.file))).venueCode);
    expect(codes).toEqual(["01", "06", "05", "09", "08", "05"]);
  });

  it("2018 は、クッション値の節が無いので全部の行の cushion が null", async () => {
    const r = await parseOk(fixture("jra_baba_past_2018_sapporo01.pdf"));
    expect(r.rows.every((x) => x.cushion === null)).toBe(true);
    expect(r.rows.every((x) => x.turfGoalMoisture !== null && x.dirtCorner4Moisture !== null)).toBe(true);
  });

  it("2020 は月曜の列(4 列)を持つ塊を、月曜の日付つきで読む", async () => {
    const r = await parseOk(fixture("jra_baba_past_2020_nakayama04.pdf"));
    const mon = r.rows.filter((x) => x.weekday === "月");
    expect(mon.map((x) => x.kaisaiDate)).toEqual(["20200921"]);
    expect(mon[0]).toMatchObject({ cushion: 9.7, turfGoalMoisture: 11.4, turfCorner4Moisture: 10.8, dirtGoalMoisture: 4.7, dirtCorner4Moisture: 4.3 });
  });
});

describe("合成の PDF(読める形)", () => {
  it("実物と同じ並びの 1 塊を読み、日付・曜日・5 つの値を取る", async () => {
    const r = await parseOk(buildPdf(layoutLines(TITLE, [BLOCK_FRI])));
    expect(r.venueCode).toBe("05");
    expect(dump(r.rows)).toBe(["20210129 金 8.4 18.6 18.8 12.8 12.7", "20210130 土 8.8 16.2 16.8 11.1 11.1", "20210131 日 9.3 14.6 14.5 10.2 10.6"].join("\n"));
  });

  it("終わりの日に月があるとき(4月30日～5月2日)は月をまたいで日付を決める", async () => {
    const b: SynthBlock = { ...BLOCK_FRI, dateText: "（2021年4月30日～5月2日）" };
    const r = await parseOk(buildPdf(layoutLines(TITLE, [b])));
    expect(r.rows.map((x) => x.kaisaiDate)).toEqual(["20210430", "20210501", "20210502"]);
  });

  it("終わりの月が小さいとき(12月31日～1月2日)は年をまたぐ", async () => {
    const b: SynthBlock = { ...BLOCK_FRI, dateText: "（2021年12月31日～1月2日）" };
    const r = await parseOk(buildPdf(layoutLines(TITLE, [b])));
    expect(r.rows.map((x) => x.kaisaiDate)).toEqual(["20211231", "20220101", "20220102"]);
  });

  it("見出しに空白(実物は `2021年 第1回 東京競馬` のように空白の字を含む)があっても年・回・場を読む", async () => {
    const r = await parseOk(buildPdf(layoutLines("2021年 第1回 東京競馬 含水率・クッション値", [BLOCK_FRI])));
    expect([r.year, r.kai, r.venueName]).toEqual([2021, 1, "東京"]);
  });

  it("2018 の書式(「から」と曜日つきの日付の別行)を読む", async () => {
    const b: SynthBlock = { ...BLOCK_FRI, dateText: "2018年7月27日（金）から29日（日）", cushion: undefined };
    const r = await parseOk(buildPdf(layoutLines("2018年第1回札幌競馬含水率", [b])));
    expect(r.rows.map((x) => [x.kaisaiDate, x.cushion])).toEqual([["20180727", null], ["20180728", null], ["20180729", null]]);
  });

  it("クッション値の節が無い塊は cushion が null、ほかの値は入る", async () => {
    const r = await parseOk(buildPdf(layoutLines(TITLE, [{ ...BLOCK_FRI, cushion: undefined }])));
    expect(r.rows.map((x) => x.cushion)).toEqual([null, null, null]);
    expect(r.rows[0]!.turfGoalMoisture).toBe(18.6);
  });

  it("含水率が 0.0 と 100.0 の境界は受け入れる(0 は null にしない)", async () => {
    const b: SynthBlock = { ...BLOCK_FRI, turfGoal: ["0.0", "100.0", "5.5"], cushion: ["0.0", "20.0", "9.9"] };
    const r = await parseOk(buildPdf(layoutLines(TITLE, [b])));
    expect(r.rows.map((x) => [x.cushion, x.turfGoalMoisture])).toEqual([[0, 0], [20, 100], [9.9, 5.5]]);
  });

  it("同じ塊が複数あっても、塊ごとに日付が決まる(2 塊 = 6 行)", async () => {
    const b2: SynthBlock = { ...BLOCK_FRI, dateText: "（2021年2月5日～7日）" };
    const r = await parseOk(buildPdf(layoutLines(TITLE, [BLOCK_FRI, b2])));
    expect(r.rows.map((x) => x.kaisaiDate)).toEqual(["20210129", "20210130", "20210131", "20210205", "20210206", "20210207"]);
  });
});

describe("合成の PDF(読めない形は分類して返す。壊れた値を入れない)", () => {
  const expectFail = async (bytes: Uint8Array, result: string) => {
    expect(await parseBabaPastPdf(bytes)).toEqual({ ok: false, result });
  };

  it("PDF でないバイト列は not-pdf", async () => {
    await expectFail(new TextEncoder().encode("<html>404</html>"), "not-pdf");
    await expectFail(new Uint8Array(0), "not-pdf");
  });

  it("文字が 1 つも無い PDF は no-text", async () => {
    await expectFail(buildPdf([], { noText: true }), "no-text");
  });

  it("壊れた Flate の content stream は inflate-failed", async () => {
    await expectFail(buildPdf(layoutLines(TITLE, [BLOCK_FRI]), { corruptContent: true }), "inflate-failed");
  });

  it("展開すると上限を超える stream は too-large", async () => {
    await expectFail(buildPdf(layoutLines(TITLE, [BLOCK_FRI]), { addBomb: true }), "too-large");
  });

  it("ToUnicode の CMap が爆弾(`<0000> <FFFF> <0041>` を 2 万行。展開後 約 420KB)のときは、短い時間(1 秒未満)で too-large を返す(CPU を使い切らない)", async () => {
    const bomb = `/CIDInit /ProcSet findresource begin\nbegincmap\n1 beginbfrange\n${"<0000> <FFFF> <0041>\n".repeat(20_000)}endbfrange\nendcmap\nend\n`;
    expect(bomb.length).toBeGreaterThan(400_000);
    const bytes = buildPdf(layoutLines(TITLE, [BLOCK_FRI]), { extraCmap: bomb });
    const t0 = performance.now();
    const r = await parseBabaPastPdf(bytes);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r).toEqual({ ok: false, result: "too-large" });
  });

  it("CMap の項目数の上限: 実物の CMap(39〜43 項目・52〜59 文字)の 100 倍以内(5,000 項目・10,000 文字。実物の CMap の分を含めて)の手前は受け入れ、超えれば too-large", async () => {
    const entries = (n: number): string => `/CIDInit /ProcSet findresource begin\nbegincmap\n${n} beginbfchar\n${Array.from({ length: n }, (_, i) => `<${(0x8000 + i).toString(16)}> <0041>`).join("\n")}\nendbfchar\nendcmap\nend\n`;
    expect((await parseBabaPastPdf(buildPdf(layoutLines(TITLE, [BLOCK_FRI]), { extraCmap: entries(4_900) }))).ok).toBe(true);
    expect(await parseBabaPastPdf(buildPdf(layoutLines(TITLE, [BLOCK_FRI]), { extraCmap: entries(5_001) }))).toEqual({ ok: false, result: "too-large" });
    const wide = (n: number): string => `begincmap\n1 beginbfrange\n<8000> <${(0x8000 + n - 1).toString(16)}> <0041>\nendbfrange\nendcmap\n`;
    expect((await parseBabaPastPdf(buildPdf(layoutLines(TITLE, [BLOCK_FRI]), { extraCmap: wide(9_900) }))).ok).toBe(true);
    expect(await parseBabaPastPdf(buildPdf(layoutLines(TITLE, [BLOCK_FRI]), { extraCmap: wide(10_001) }))).toEqual({ ok: false, result: "too-large" });
  });

  it("見出しの年と日付の年が違う(見出し 2022・日付 2021)は shape-mismatch", async () => {
    await expectFail(buildPdf(layoutLines("2022年第1回東京競馬含水率・クッション値", [BLOCK_FRI])), "shape-mismatch");
  });

  it("入力が上限(1MB)を超えるときは too-large(展開する前に断る)", async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(new TextEncoder().encode("%PDF-1.5\n"));
    await expectFail(big, "too-large");
  });

  it("ToUnicode が無い(日本語を読めない)PDF は shape-mismatch(日付・場名が決められない)", async () => {
    await expectFail(buildPdf(layoutLines(TITLE, [BLOCK_FRI]), { omitCmap: true }), "shape-mismatch");
  });

  it("日付の曜日が列の曜日と合わない(2021-01-29 は金曜日なのに「土」)は shape-mismatch", async () => {
    await expectFail(buildPdf(layoutLines(TITLE, [{ ...BLOCK_FRI, weekdays: ["土", "日", "月"] }])), "shape-mismatch");
  });

  it("列の数と日付の幅が合わない(29日～31日は 3 日なのに 2 列)は shape-mismatch", async () => {
    const b: SynthBlock = { ...BLOCK_FRI, weekdays: ["金", "土"], cushion: ["8.4", "8.8"], turfGoal: ["1.0", "2.0"], turfCorner4: ["1.0", "2.0"], dirtGoal: ["1.0", "2.0"], dirtCorner4: ["1.0", "2.0"] };
    await expectFail(buildPdf(layoutLines(TITLE, [b])), "shape-mismatch");
  });

  it("行の値の数が列の数と合わない(欠けた値)は shape-mismatch", async () => {
    await expectFail(buildPdf(layoutLines(TITLE, [{ ...BLOCK_FRI, turfGoal: ["18.6", "16.2"] }])), "shape-mismatch");
    await expectFail(buildPdf(layoutLines(TITLE, [{ ...BLOCK_FRI, cushion: ["8.4", "8.8"] }])), "shape-mismatch");
  });

  it("範囲外の値は shape-mismatch(含水率 100.1・クッション値 20.1・負の値は書式外)", async () => {
    await expectFail(buildPdf(layoutLines(TITLE, [{ ...BLOCK_FRI, dirtGoal: ["12.8", "100.1", "10.2"] }])), "shape-mismatch");
    await expectFail(buildPdf(layoutLines(TITLE, [{ ...BLOCK_FRI, cushion: ["8.4", "20.1", "9.3"] }])), "shape-mismatch");
  });

  it("日付の無い PDF・値の行が 1 つも無い塊は shape-mismatch", async () => {
    await expectFail(buildPdf(layoutLines(TITLE, [])), "shape-mismatch");
    await expectFail(buildPdf(layoutLines(TITLE, [{ ...BLOCK_FRI, cushion: undefined, turfGoal: [], turfCorner4: [], dirtGoal: [], dirtCorner4: [] }])), "shape-mismatch");
  });

  it("場名が JRA の 10 場に無い見出しは shape-mismatch", async () => {
    await expectFail(buildPdf(layoutLines("2021年第1回帯広競馬含水率・クッション値", [BLOCK_FRI])), "shape-mismatch");
  });

  it("同じ日付が 2 つの塊に出るときは shape-mismatch(重複した行を作らない)", async () => {
    await expectFail(buildPdf(layoutLines(TITLE, [BLOCK_FRI, BLOCK_FRI])), "shape-mismatch");
  });

  it("開催回が 0 の見出し(第0回)は shape-mismatch", async () => {
    await expectFail(buildPdf(layoutLines("2021年第0回東京競馬含水率・クッション値", [BLOCK_FRI])), "shape-mismatch");
  });

  it("同じ行(芝のゴール前)が 1 つの塊に 2 回あるときは shape-mismatch(上書きしない)", async () => {
    const lines = layoutLines(TITLE, [BLOCK_FRI]);
    const turf = lines.find((l) => l.cells.some((c) => c.text === "芝コース含水率"))!;
    await expectFail(buildPdf([...lines, { ...turf, y: turf.y - 6 }]), "shape-mismatch");
  });

  it("日付の幅が 7 日を超える(8 日・8 列)ときは shape-mismatch", async () => {
    const days = ["金", "土", "日", "月", "火", "水", "木", "金"];
    const eight = days.map(() => "5.0");
    const b: SynthBlock = { dateText: "（2021年1月29日～2月5日）", weekdays: days, cushion: eight, turfGoal: eight, turfCorner4: eight, dirtGoal: eight, dirtCorner4: eight };
    await expectFail(buildPdf(layoutLines(TITLE, [b])), "shape-mismatch");
    // 同じ形で 7 日なら読める(8 日で落ちるのは日数の上限による)
    const seven: SynthBlock = { ...b, dateText: "（2021年1月29日～2月4日）", weekdays: days.slice(0, 7), cushion: eight.slice(0, 7), turfGoal: eight.slice(0, 7), turfCorner4: eight.slice(0, 7), dirtGoal: eight.slice(0, 7), dirtCorner4: eight.slice(0, 7) };
    expect((await parseOk(buildPdf(layoutLines(TITLE, [seven])))).rows).toHaveLength(7);
  });

  it("実物の PDF の途中を切った(content stream の途中。endstream が無い)ものは、投げずに no-text を返す", async () => {
    const full = fixture("jra_baba_past_2021_tokyo01.pdf");
    await expectFail(full.slice(0, 1500), "no-text");
  });
});
