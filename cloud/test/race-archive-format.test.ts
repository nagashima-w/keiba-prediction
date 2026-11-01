import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildRaceRecord, type RaceRecord } from "../../packages/core/src/scraper/race-record.js";
import { decodeRaceArchive, encodeRaceArchive, RACE_ARCHIVE_FORMAT, raceArchiveKeyOf } from "../src/race-archive-format";

/**
 * Issue #551(#549-A2): R2 に置く「1 レースの保存物」の符号化(純関数)。
 * 実フィクスチャ(中央・地方の結果ページ)を `buildRaceRecord` で読んだ実物のレコードで、JSON と gzip の往復が値を変えないことを確かめる。
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const load = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf-8");

function mustRecord(html: string, raceId: string, kind: "central" | "nar"): RaceRecord {
  const r = buildRaceRecord(html, raceId, kind);
  if (!r.ok) {
    throw new Error(`読めるはずのレースが読めなかった: ${r.category} ${r.detail}`);
  }
  return r.record;
}

const CENTRAL_HTML = load("history_central_result_202105040811.html");
const NAR_HTML = load("history_nar_result_202146110310.html");
const CENTRAL = mustRecord(CENTRAL_HTML, "202105040811", "central");
const NAR = mustRecord(NAR_HTML, "202146110310", "nar");
const FETCHED_AT = "2026-11-01T01:02:03.456Z";

describe("raceArchiveKeyOf: R2 のキー", () => {
  it("race-results/{raceId}.json.gz。12 桁の数字だけを受け付ける(キーの注入・取り違えの防御)", () => {
    expect(raceArchiveKeyOf("202105040811")).toBe("race-results/202105040811.json.gz");
    for (const bad of ["", "2021050408", "2021050408111", "20210504081a", "../202105040811", "202105040811/x", " 202105040811"]) {
      expect(() => raceArchiveKeyOf(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});

describe("encodeRaceArchive / decodeRaceArchive: 実フィクスチャの往復", () => {
  it("前提: 実物のレコードは頭数が複数あり、HTML は 10 万文字を超える(空に近い入力での自明な一致ではない)", () => {
    expect(CENTRAL.horses.length).toBeGreaterThan(5);
    expect(NAR.horses.length).toBeGreaterThan(5);
    expect(CENTRAL_HTML.length).toBeGreaterThan(50_000);
    expect(CENTRAL.parserVersion).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["中央", CENTRAL, CENTRAL_HTML],
    ["地方", NAR, NAR_HTML],
  ] as const)("%s: レコード・HTML・読み取りの版・取得時刻が、1 バイト・1 項目も変わらずに戻る(undefined の項目も無い)", (_label, record, html) => {
    const bytes = encodeRaceArchive({ record, html, fetchedAt: FETCHED_AT });
    const decoded = decodeRaceArchive(bytes.body);
    expect(decoded).not.toBeNull();
    expect(decoded!.format).toBe(RACE_ARCHIVE_FORMAT);
    expect(decoded!.parserVersion).toBe(record.parserVersion);
    expect(decoded!.fetchedAt).toBe(FETCHED_AT);
    expect(decoded!.html).toBe(html);
    expect(decoded!.record).toStrictEqual(record);
  });

  it("gzip である(先頭 2 バイトが 1f 8b)。展開した JSON のキーは format・parserVersion・fetchedAt・record・html だけ", () => {
    const { body } = encodeRaceArchive({ record: CENTRAL, html: CENTRAL_HTML, fetchedAt: FETCHED_AT });
    expect([body[0], body[1]]).toEqual([0x1f, 0x8b]);
    const json = JSON.parse(gunzipSync(body).toString("utf-8")) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["fetchedAt", "format", "html", "parserVersion", "record"]);
  });

  it("圧縮される(gzip 後は HTML の 4 分の 1 未満。実物の HTML は約 130KB で、level 1 の gzip は約 37KB)", () => {
    const { body, rawBytes } = encodeRaceArchive({ record: CENTRAL, html: CENTRAL_HTML, fetchedAt: FETCHED_AT });
    expect(rawBytes).toBeGreaterThan(CENTRAL_HTML.length); // 前提: JSON は HTML より大きい(レコードを含む)
    expect(body.length).toBeLessThan(CENTRAL_HTML.length / 3);
  });

  it("rawBytes は gzip 前の JSON の UTF-8 バイト数。取得時刻だけが違う(長さは同じ ISO 形式)保存では同じ値になる", () => {
    const a = encodeRaceArchive({ record: CENTRAL, html: CENTRAL_HTML, fetchedAt: "2026-11-01T01:02:03.456Z" });
    const b = encodeRaceArchive({ record: CENTRAL, html: CENTRAL_HTML, fetchedAt: "2027-12-31T23:59:59.999Z" });
    expect(a.rawBytes).toBe(gunzipSync(a.body).length);
    expect(a.rawBytes).toBe(b.rawBytes);
    expect(a.body.length).toBeGreaterThan(0);
    // 対照: HTML が 1 文字長ければ変わる
    const c = encodeRaceArchive({ record: CENTRAL, html: `${CENTRAL_HTML}x`, fetchedAt: FETCHED_AT });
    expect(c.rawBytes).toBe(a.rawBytes + 1);
  });

  it("JSON にできない値(BigInt)が入っていれば例外(呼び出し側は、R2・D1 に書く前に呼ぶ)", () => {
    const bad = { ...CENTRAL, raceNumber: 1n as unknown as number };
    expect(() => encodeRaceArchive({ record: bad, html: "x", fetchedAt: FETCHED_AT })).toThrow();
  });

  it("fetchedAt が ISO 形式(ミリ秒つきの UTC・24 文字)でなければ例外(長さが変わると rawBytes が不安定になる)", () => {
    for (const bad of ["2026-11-01", "2026-11-01T01:02:03Z", "2026-11-01 01:02:03.456", ""]) {
      expect(() => encodeRaceArchive({ record: CENTRAL, html: "x", fetchedAt: bad }), bad).toThrow(RangeError);
    }
  });
});

describe("decodeRaceArchive: 壊れた入力は例外でなく null", () => {
  const good = JSON.parse(gunzipSync(encodeRaceArchive({ record: CENTRAL, html: "h", fetchedAt: FETCHED_AT }).body).toString("utf-8")) as Record<string, unknown>;
  const gz = (value: unknown): Uint8Array => gzipSync(new TextEncoder().encode(JSON.stringify(value)));

  it("前提: 手で組み直した正常な入力は読める", () => {
    expect(decodeRaceArchive(gz(good))).not.toBeNull();
  });

  it("gzip でないバイト列・空・JSON でない中身は null", () => {
    expect(decodeRaceArchive(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodeRaceArchive(new Uint8Array())).toBeNull();
    expect(decodeRaceArchive(gzipSync(new TextEncoder().encode("{not json")))).toBeNull();
    expect(decodeRaceArchive(gz("文字列"))).toBeNull();
    expect(decodeRaceArchive(gz(null))).toBeNull();
    expect(decodeRaceArchive(gz([]))).toBeNull();
  });

  it.each([
    ["format が違う(読めない版)", { ...good, format: 2 }],
    ["format が無い", { ...good, format: undefined }],
    ["parserVersion が数でない", { ...good, parserVersion: "2" }],
    ["parserVersion が record.parserVersion と食い違う", { ...good, parserVersion: 1 }],
    ["fetchedAt が文字列でない", { ...good, fetchedAt: 0 }],
    ["html が文字列でない", { ...good, html: null }],
    ["record が無い", { ...good, record: undefined }],
    ["record が配列", { ...good, record: [] }],
    ["record.raceId が文字列でない", { ...good, record: { ...(good["record"] as object), raceId: 5 } }],
  ])("形が違う: %s は null", (_label, value) => {
    expect(decodeRaceArchive(gz(value))).toBeNull();
  });
});
