import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildDetailPayload, contributionsOf, decodeDetail, detailKeyOf, encodeDetail } from "../src/analysis-detail";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { contractCases } from "./fixtures-contract";

/**
 * Issue #175(#172-b)AC-b10: R2 の詳細オブジェクトの符号化(純関数)。
 * 詳細 = 大きな列 3 つ(race_snapshot_json・raw_response・馬ごとの contributions)。gzip は `node:zlib` の level 1(#174 の CPU 測定で決定)。
 */

const jsonOf = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(gunzipSync(bytes)));

describe("detailKeyOf(R2 のキー)", () => {
  it("analyses/{id}.json.gz(D1 の detail_key の式と同じ形)", () => {
    expect(detailKeyOf(1)).toBe("analyses/1.json.gz");
    expect(detailKeyOf(12345)).toBe("analyses/12345.json.gz");
  });
});

describe("buildDetailPayload(保存する分析から、R2 に置く部分だけを取り出す)", () => {
  const rec = contractCases[0]!.record;

  it("format・raceId・raceSnapshot・rawResponse・馬番ごとの contributions だけを持つ。contributions が null の馬は含めない", () => {
    const payload = buildDetailPayload(rec);
    expect(Object.keys(payload).sort()).toEqual(["contributions", "format", "raceId", "raceSnapshot", "rawResponse"]);
    expect(payload.format).toBe(1);
    expect(payload.raceId).toBe(rec.raceId);
    expect(payload.raceSnapshot).toStrictEqual(rec.raceSnapshot);
    expect(payload.rawResponse).toBe(rec.rawResponse);
    // 前提: フィクスチャの3頭は、contributions が {…}・{}(空)・null の3通り
    expect(rec.horses.map((h) => h.contributions === null || h.contributions === undefined)).toEqual([false, false, true]);
    expect(Object.keys(payload.contributions).sort()).toEqual(["1", "2"]);
    // 空オブジェクトは null と区別して残す
    expect(payload.contributions["2"]).toStrictEqual({});
  });

  it("省略・null の rawResponse・raceSnapshot は null で持つ(undefined のキーを作らない)。空文字は空文字のまま", () => {
    const minimal = contractCases[1]!.record;
    const payload = buildDetailPayload(minimal);
    expect(payload.rawResponse).toBeNull();
    expect(payload.raceSnapshot).toBeNull();
    expect(payload.contributions).toStrictEqual({});
    const empty = buildDetailPayload({ ...minimal, rawResponse: "" });
    expect(empty.rawResponse).toBe("");
  });

  it("0・false・空文字の contributions は、null と区別して残す", () => {
    const base = contractCases[1]!.record;
    const horse = (umaban: number, contributions: unknown) => ({ ...base.horses[0]!, umaban, contributions });
    const payload = buildDetailPayload({ ...base, horses: [horse(1, 0), horse(2, false), horse(3, ""), horse(4, undefined), horse(5, null)] });
    expect(payload.contributions).toStrictEqual({ "1": 0, "2": false, "3": "" });
  });
});

describe("AC-b10: encodeDetail / decodeDetail の往復で値が変わらない", () => {
  it.each(contractCases.map((c) => [c.name, c.record] as const))("%s", (_name, rec) => {
    const bytes = encodeDetail(rec);
    const decoded = decodeDetail(bytes);
    expect(decoded).not.toBeNull();
    expect(decoded).toStrictEqual(buildDetailPayload(rec));
  });

  it("gzip(先頭 1f 8b)で、level 1(gzip ヘッダの XFL = 4。level 6 の既定は 0)。中身は JSON", () => {
    const bytes = encodeDetail(contractCases[0]!.record);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(bytes[8], "XFL(圧縮レベルの目印): 4 = 最速(level 1)").toBe(4);
    // 対照: 既定のレベルで圧縮すると XFL は 4 にならない(この検査が level を見分けられる)
    expect(gzipSync(Buffer.from("x".repeat(500)))[8]).not.toBe(4);
    expect(jsonOf(bytes)).toStrictEqual(JSON.parse(JSON.stringify(buildDetailPayload(contractCases[0]!.record))));
  });

  it("大きな入力(組合せ入りのスナップショット相当の約 100KB)でも往復する。圧縮されて小さくなる", () => {
    const big: AnalysisRecord = { ...contractCases[0]!.record, raceSnapshot: { combos: Object.fromEntries(Array.from({ length: 3360 }, (_, i) => [`${i}-${i + 1}-${i + 2}`, 10 + i / 7])) } };
    const plain = JSON.stringify(buildDetailPayload(big)).length;
    expect(plain).toBeGreaterThan(80_000);
    const bytes = encodeDetail(big);
    expect(bytes.length).toBeLessThan(plain / 2);
    expect(decodeDetail(bytes)).toStrictEqual(buildDetailPayload(big));
  });

  it("日本語・絵文字・引用符・改行・NUL を含む文字列が壊れない(JSON 経由。孤立サロゲートは対象外)", () => {
    const text = "根拠「日本語」 \"引用\" \\ \n\t 😀 𠮷 \u0000 end";
    const rec: AnalysisRecord = { ...contractCases[1]!.record, rawResponse: text, raceSnapshot: { text } };
    const decoded = decodeDetail(encodeDetail(rec))!;
    expect(decoded.rawResponse).toBe(text);
    expect(decoded.raceSnapshot).toStrictEqual({ text });
  });

  it("有限の double はビット一致で戻る(JSON の往復)", () => {
    const values = [0.1 + 0.2, 1 / 3, 5e-324, 1.7976931348623157e308, 123456789.123456789, 2 ** -1074, -1e-7];
    const rec: AnalysisRecord = { ...contractCases[1]!.record, raceSnapshot: { values } };
    const back = (decodeDetail(encodeDetail(rec))!.raceSnapshot as { values: number[] }).values;
    expect(back).toHaveLength(values.length);
    values.forEach((v, i) => expect(Object.is(back[i], v), `${v}`).toBe(true));
  });
});

describe("decodeDetail(壊れた入力・想定外の形は、例外を投げず null)", () => {
  const good = (): Uint8Array => encodeDetail(contractCases[0]!.record);
  const gz = (value: unknown): Uint8Array => gzipSync(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));

  it("正常な入力は null でない(以降の null が、常に null を返す実装でも通る検査でないことの前提)", () => {
    expect(decodeDetail(good())).not.toBeNull();
  });

  it.each([
    ["空のバイト列", new Uint8Array(0)],
    ["gzip でないバイト列", new TextEncoder().encode('{"format":1}')],
    ["gzip の途中で切れている", good().slice(0, 20)],
    ["JSON でない中身", gz("not json {")],
    ["JSON だが object でない(配列)", gz([])],
    ["JSON だが object でない(null)", gz("null")],
    ["format が違う(2)", gz({ format: 2, raceId: "x", raceSnapshot: null, rawResponse: null, contributions: {} })],
    ["format が無い", gz({ raceId: "x", raceSnapshot: null, rawResponse: null, contributions: {} })],
    ["raceId が無い", gz({ format: 1, raceSnapshot: null, rawResponse: null, contributions: {} })],
    ["rawResponse が文字列・null でない", gz({ format: 1, raceId: "x", raceSnapshot: null, rawResponse: 1, contributions: {} })],
    ["contributions が object でない", gz({ format: 1, raceId: "x", raceSnapshot: null, rawResponse: null, contributions: [] })],
    ["contributions が無い", gz({ format: 1, raceId: "x", raceSnapshot: null, rawResponse: null })],
  ])("%s", (_name, bytes) => {
    expect(() => decodeDetail(bytes)).not.toThrow();
    expect(decodeDetail(bytes)).toBeNull();
  });
});

describe("contributionsOf(馬番から contributions を引く)", () => {
  it("あれば値(空オブジェクト・0 も)、無ければ null", () => {
    const payload = buildDetailPayload(contractCases[0]!.record);
    expect(contributionsOf(payload, 1)).toStrictEqual({ pace: 0.01, nested: { x: [1, 2] } });
    expect(contributionsOf(payload, 2)).toStrictEqual({});
    expect(contributionsOf(payload, 10)).toBeNull();
    expect(contributionsOf(payload, 99)).toBeNull();
    // prototype の名前で引いても、継承されたプロパティを返さない
    expect(contributionsOf(payload, "constructor" as unknown as number)).toBeNull();
  });
});
