import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BABA_PAST_R2_PREFIX,
  D1BabaPastStore,
  FILTER_DONE_SQL,
  INSERT_PAST_ROWS_SQL,
  LIST_PDFS_BY_YEAR_SQL,
  UPSERT_PDF_SQL,
  type BabaPastBucket,
  type BabaPastSaveInput,
} from "../src/baba-past-repository";
import { parseBabaPastPdf, type BabaPastRow } from "../src/jra-baba-past-pdf";
import { R2_FENCE_LIMITS, monthKey } from "../src/r2-fence";
import { installFetchTrap } from "./fetch-trap";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { pathFromMeta } from "./meta-path";

/**
 * Issue #769: 過去の馬場の保存(`D1BabaPastStore`。migration 0049 の `baba_past`・`baba_past_pdfs`)。ローカル(workerd)の D1・R2 で確かめる。本番には触れない。
 * 実物の PDF(`fixtures/jra_baba_past_2021_tokyo01.pdf`。12 行)を読んだ行を、そのまま保存する。
 */

installFetchTrap();

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
  for (const name of ["2021pdf/tokyo01.pdf", "2018pdf/sapporo01.pdf", "2021pdf/tokyo03.pdf"]) await local.r2.delete(`${BABA_PAST_R2_PREFIX}${name}`);
});

const FIXTURES = pathFromMeta("../../fixtures/", import.meta.url);
const pdfBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(`${FIXTURES}${name}`));
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

async function all(sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  return (await local.db.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;
}

async function tokyo01(): Promise<BabaPastSaveInput> {
  const bytes = pdfBytes("jra_baba_past_2021_tokyo01.pdf");
  const parsed = await parseBabaPastPdf(bytes);
  if (!parsed.ok) throw new Error("fixture が読めない");
  return { path: "2021pdf/tokyo01.pdf", year: 2021, venueCode: "05", kai: 1, result: "ok", rows: parsed.rows, pdf: bytes, nowMs: NOW };
}

const store = (bucket: BabaPastBucket = local.r2): D1BabaPastStore => new D1BabaPastStore({ db: local.db, bucket });

describe("savePdf(読めた PDF)", () => {
  it("12 行・PDF の記録・R2 の PDF・r2_ops の Class A を書く。書いた行数は 12 + 1 + 1 = 14(実測)", async () => {
    const input = await tokyo01();
    expect(input.rows).toHaveLength(12); // 前提: 12 行
    const r = await store().savePdf(input);
    expect(r).toEqual({ written: 14, r2Key: `${BABA_PAST_R2_PREFIX}2021pdf/tokyo01.pdf` });
    const rows = await all("SELECT * FROM baba_past ORDER BY kaisai_date");
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({
      kaisai_date: "20210129", venue_code: "05", weekday: "金", cushion: 8.4, turf_goal_moisture: 18.6, turf_corner4_moisture: 18.8,
      dirt_goal_moisture: 12.8, dirt_corner4_moisture: 12.7, source_pdf: "2021pdf/tokyo01.pdf", fetched_at: NOW,
    });
    expect(await all("SELECT * FROM baba_past_pdfs")).toEqual([
      { source_pdf: "2021pdf/tokyo01.pdf", year: 2021, venue_code: "05", kai: 1, result: "ok", rows_saved: 12, r2_key: `${BABA_PAST_R2_PREFIX}2021pdf/tokyo01.pdf`, fetched_at: NOW },
    ]);
    const obj = await local.r2.get(`${BABA_PAST_R2_PREFIX}2021pdf/tokyo01.pdf`);
    expect(obj).not.toBeNull();
    expect((await obj!.arrayBuffer()).byteLength).toBe(input.pdf!.byteLength);
    expect(await all("SELECT ym, class_a, class_b FROM r2_ops")).toEqual([{ ym: monthKey(new Date(NOW)), class_a: 1, class_b: 0 }]);
  });

  it("cushion が無い行(2018)は NULL のまま入る(0 にしない)", async () => {
    const bytes = pdfBytes("jra_baba_past_2018_sapporo01.pdf");
    const parsed = await parseBabaPastPdf(bytes);
    if (!parsed.ok) throw new Error("fixture が読めない");
    await store().savePdf({ path: "2018pdf/sapporo01.pdf", year: 2018, venueCode: "01", kai: 1, result: "ok", rows: parsed.rows, pdf: bytes, nowMs: NOW });
    expect(await all("SELECT DISTINCT cushion FROM baba_past")).toEqual([{ cushion: null }]);
  });

  it("もう一度保存しても行は増えず、値と記録の時刻は新しくなる(読み直しで直せる)。書いた行数は同じ 14", async () => {
    const input = await tokyo01();
    await store().savePdf(input);
    const changed: BabaPastRow[] = input.rows.map((r, i) => (i === 0 ? { ...r, cushion: 7.7 } : r));
    const again = await store().savePdf({ ...input, rows: changed, nowMs: NOW + 1000 });
    expect(again.written).toBe(14);
    expect(await all("SELECT COUNT(*) AS n FROM baba_past")).toEqual([{ n: 12 }]);
    expect(await all("SELECT cushion, fetched_at FROM baba_past WHERE kaisai_date = '20210129'")).toEqual([{ cushion: 7.7, fetched_at: NOW + 1000 }]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_past_pdfs")).toEqual([{ n: 1 }]);
  });
});

describe("R2 のキーを忘れない", () => {
  it("R2 に置いたあと、PDF なしで保存し直しても(r2_key が NULL で来ても)、前の r2_key を残す。新しいキーが来れば置き換える", async () => {
    const input = await tokyo01();
    await store().savePdf(input);
    await store().savePdf({ ...input, result: "shape-mismatch", rows: [], pdf: null });
    expect(await all("SELECT result, r2_key FROM baba_past_pdfs")).toEqual([{ result: "shape-mismatch", r2_key: `${BABA_PAST_R2_PREFIX}2021pdf/tokyo01.pdf` }]);
  });
});

describe("savePdf(読めなかった・取れなかった PDF。分類だけを残す)", () => {
  it("読めなかった PDF: 行は書かず、分類と R2 の控えだけ。書いた行数は 1 + 1 = 2", async () => {
    const input = await tokyo01();
    const r = await store().savePdf({ ...input, result: "shape-mismatch", rows: [] });
    expect(r.written).toBe(2);
    expect(await all("SELECT COUNT(*) AS n FROM baba_past")).toEqual([{ n: 0 }]);
    expect(await all("SELECT result, rows_saved, r2_key FROM baba_past_pdfs")).toEqual([{ result: "shape-mismatch", rows_saved: 0, r2_key: `${BABA_PAST_R2_PREFIX}2021pdf/tokyo01.pdf` }]);
  });

  it("PDF を取れなかった(pdf が null。例 http-404): R2 には触れず、r2_ops も増えない。書いた行数は 1", async () => {
    const input = await tokyo01();
    const r = await store().savePdf({ ...input, result: "http-404", rows: [], pdf: null });
    expect(r).toEqual({ written: 1, r2Key: null });
    expect(await all("SELECT result, r2_key FROM baba_past_pdfs")).toEqual([{ result: "http-404", r2_key: null }]);
    expect(await all("SELECT COUNT(*) AS n FROM r2_ops")).toEqual([{ n: 0 }]);
  });
});

describe("R2 に置けないとき(D1 は書く)", () => {
  it("今月の Class A が柵に達していれば R2 に置かず、r2_key は NULL、r2_ops は増えない。行は書く(12 + 1 = 13)", async () => {
    const ym = monthKey(new Date(NOW));
    await local.db.prepare("INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, 0)").bind(ym, R2_FENCE_LIMITS.classA).run();
    const input = await tokyo01();
    const r = await store().savePdf(input);
    expect(r).toEqual({ written: 13, r2Key: null });
    expect(await local.r2.get(`${BABA_PAST_R2_PREFIX}2021pdf/tokyo01.pdf`)).toBeNull();
    expect(await all("SELECT class_a FROM r2_ops")).toEqual([{ class_a: R2_FENCE_LIMITS.classA }]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_past")).toEqual([{ n: 12 }]);
  });

  it("柵の 1 つ手前(上限 − 1)ならまだ置く", async () => {
    const ym = monthKey(new Date(NOW));
    await local.db.prepare("INSERT INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, 0)").bind(ym, R2_FENCE_LIMITS.classA - 1).run();
    const r = await store().savePdf(await tokyo01());
    expect(r.r2Key).not.toBeNull();
    expect(await all("SELECT class_a FROM r2_ops")).toEqual([{ class_a: R2_FENCE_LIMITS.classA }]);
  });

  it("R2 の put が失敗しても、D1 は書く(r2_key NULL。失敗した put は数えない)", async () => {
    const broken: BabaPastBucket = { get: local.r2.get.bind(local.r2), put: () => Promise.reject(new Error("r2 down")) as never };
    const r = await store(broken).savePdf(await tokyo01());
    expect(r).toEqual({ written: 13, r2Key: null });
    expect(await all("SELECT r2_key FROM baba_past_pdfs")).toEqual([{ r2_key: null }]);
    expect(await all("SELECT COUNT(*) AS n FROM r2_ops")).toEqual([{ n: 0 }]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_past")).toEqual([{ n: 12 }]);
  });
});

describe("batch は 1 つのトランザクション", () => {
  it("行の書き込みが失敗したら、PDF の記録(取り終えの印)も残らない", async () => {
    const input = await tokyo01();
    const bad = [{ ...input.rows[0]!, turfGoalMoisture: null as unknown as number }];
    await expect(store().savePdf({ ...input, rows: bad })).rejects.toThrow();
    expect(await all("SELECT COUNT(*) AS n FROM baba_past_pdfs")).toEqual([{ n: 0 }]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_past")).toEqual([{ n: 0 }]);
  });
});

describe("filterDone・listPdfsByYear", () => {
  it("記録のある PDF の名前だけを、渡した順で返す。空は空", async () => {
    const input = await tokyo01();
    await store().savePdf(input);
    await store().savePdf({ ...input, path: "2021pdf/tokyo03.pdf", kai: 3, result: "no-text", rows: [], pdf: null });
    expect(await store().filterDone(["2021pdf/tokyo02.pdf", "2021pdf/tokyo03.pdf", "2021pdf/tokyo01.pdf"])).toEqual(["2021pdf/tokyo03.pdf", "2021pdf/tokyo01.pdf"]);
    expect(await store().filterDone([])).toEqual([]);
  });

  it("年ごとの記録の一覧(管理者の読み取り)は、その年の PDF だけを名前の順で返す", async () => {
    const input = await tokyo01();
    await store().savePdf(input);
    await store().savePdf({ ...input, path: "2022pdf/tokyo01.pdf", year: 2022, result: "no-text", rows: [], pdf: null });
    expect(await store().listPdfsByYear(2021)).toEqual([{ sourcePdf: "2021pdf/tokyo01.pdf", result: "ok", rowsSaved: 12, r2Key: "baba-past/2021pdf/tokyo01.pdf" }]);
    expect(await store().listPdfsByYear(2022)).toEqual([{ sourcePdf: "2022pdf/tokyo01.pdf", result: "no-text", rowsSaved: 0, r2Key: null }]);
    expect(await store().listPdfsByYear(2023)).toEqual([]);
  });
});

describe("getPdf・読み直し(Issue #789)", () => {
  it("R2 に置いた PDF をそのまま読む。無ければ null", async () => {
    const input = await tokyo01();
    await store().savePdf(input);
    const got = await store().getPdf("2021pdf/tokyo01.pdf");
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual(Array.from(input.pdf!));
    expect(await store().getPdf("2021pdf/tokyo99.pdf")).toBeNull();
  });

  it("読み直しの書き込み(pdf: null)は、R2 に置かず(r2_ops を足さず)、r2_key を保ち、行・結果を書き直す(shape-mismatch → ok)", async () => {
    const input = await tokyo01();
    await store().savePdf({ ...input, result: "shape-mismatch", rows: [] });
    expect(await all("SELECT result, rows_saved, r2_key FROM baba_past_pdfs")).toEqual([{ result: "shape-mismatch", rows_saved: 0, r2_key: "baba-past/2021pdf/tokyo01.pdf" }]);
    const before = await all("SELECT class_a FROM r2_ops");
    const r = await store().savePdf({ ...input, pdf: null });
    expect(r.r2Key).toBeNull();
    expect(await all("SELECT result, rows_saved, r2_key FROM baba_past_pdfs")).toEqual([{ result: "ok", rows_saved: 12, r2_key: "baba-past/2021pdf/tokyo01.pdf" }]);
    expect(await all("SELECT COUNT(*) AS n FROM baba_past")).toEqual([{ n: 12 }]);
    expect(await all("SELECT class_a FROM r2_ops")).toEqual(before);
  });

  it("取り直しの書き込み(http-403 の記録 → ok)は、R2 に控えを置き、r2_key が入る", async () => {
    const input = await tokyo01();
    await store().savePdf({ ...input, result: "http-403", rows: [], pdf: null });
    expect(await all("SELECT result, r2_key FROM baba_past_pdfs")).toEqual([{ result: "http-403", r2_key: null }]);
    await store().savePdf(input);
    expect(await all("SELECT result, rows_saved, r2_key FROM baba_past_pdfs")).toEqual([{ result: "ok", rows_saved: 12, r2_key: "baba-past/2021pdf/tokyo01.pdf" }]);
  });
});

describe("実行計画(全走査をしない)", () => {
  async function plan(sql: string, ...binds: unknown[]): Promise<string[]> {
    return (await all(`EXPLAIN QUERY PLAN ${sql}`, ...binds)).map((r) => String(r["detail"]));
  }
  it("filterDone は baba_past_pdfs の主キーの引き", async () => {
    const d = await plan(FILTER_DONE_SQL, '["2021pdf/tokyo01.pdf"]');
    expect(d.some((x) => /SEARCH p EXISTS USING PRIMARY KEY \(source_pdf=\?\)/.test(x)), d.join(" / ")).toBe(true);
    expect(d.filter((x) => /SCAN (p|baba_past_pdfs)\b/.test(x)), d.join(" / ")).toEqual([]);
  });
  it("年ごとの一覧は主キーの範囲読み(SCAN が無い)", async () => {
    const d = await plan(LIST_PDFS_BY_YEAR_SQL, "2021pdf/", "2021pdf0");
    expect(d.filter((x) => /SCAN baba_past_pdfs/.test(x)), d.join(" / ")).toEqual([]);
  });
  it("2 つの INSERT は json_each の読みだけで、既存の表の全走査が無い", async () => {
    for (const [sql, binds] of [[INSERT_PAST_ROWS_SQL, ["[]", "05", "2021pdf/tokyo01.pdf", 1]], [UPSERT_PDF_SQL, ["2021pdf/tokyo01.pdf", 2021, "05", 1, "ok", 0, null, 1]]] as const) {
      const d = await plan(sql, ...binds);
      expect(d.filter((x) => /SCAN (baba_past|baba_past_pdfs)\b/.test(x)), d.join(" / ")).toEqual([]);
    }
  });
});
