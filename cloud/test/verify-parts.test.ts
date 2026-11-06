import { describe, expect, it } from "vitest";
import { normalizeForCompare, assembleFromParts, buildDayParts, chunkBySize, compareAssembled, decodeDay, encodeDay, NO_DATE_DAY, PARTS_VERSION } from "../src/verify-parts";
import { buildVerifySource } from "../src/verify-read";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import { computePromptVersionSummaries } from "../src/verify-versions";
import { computeVerifyBreakdowns } from "../src/verify-breakdown";
import { buildConditionFactsIndex } from "../src/verify-race-conditions";
import { manyDayRows, rowsOfDay } from "./verify-parts-support";

/** Issue #628: 開催日ごとの部分(作る・保存の形に分ける・組み立て直す・合わせる)が、全件を 1 度に集計した値と同じになること。 */
const JSONIFY = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("日ごとの部分を合わせると、全件の集計と同じ値になる(開催日が NULL の日を含む)", () => {
  const rows = manyDayRows(5, 4);
  const days = [...new Set(rows.analyses.map((a) => a.kaisaiDate ?? null))];
  const parts = days.map((d) => buildDayParts(rowsOfDay(rows, d), null));
  const assembled = JSONIFY(assembleFromParts(parts));
  const source = buildVerifySource(rows);

  it("前提: 日は 6 つ(NULL の日を含む)で、集計の対象が空ではない", () => {
    expect(days).toHaveLength(6);
    expect(days).toContain(null);
    expect(assembled.reports.all.includedAnalysisCount).toBeGreaterThan(5);
    expect(assembled.reports.central.includedAnalysisCount).toBeGreaterThan(0);
    expect(assembled.reports.nar.includedAnalysisCount).toBeGreaterThan(0);
    expect(assembled.promptVersions.length).toBe(2);
  });

  it("3 区分のレポート・版別・内訳が、全件の集計と突き合わせて 0 件のずれ", () => {
    const full = JSONIFY({
      reports: { all: computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "all"), central: computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "central"), nar: computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, "nar") },
      promptVersions: computePromptVersionSummaries(source),
    });
    expect(compareAssembled(full.reports, assembled.reports)).toEqual([]);
    expect(compareAssembled(full.promptVersions, assembled.promptVersions)).toEqual([]);
    const bd = computeVerifyBreakdowns(source, rows.bets, buildConditionFactsIndex(rows.analyses));
    expect(compareAssembled(JSONIFY(bd.all?.sections ?? null), assembled.breakdownByVenue.all?.sections ?? null)).toEqual([]);
  });

  it("保存の形に分けて組み立て直しても、同じ(順序も保つ)", () => {
    const kv = new Map<string, unknown>();
    days.forEach((d, i) => {
      for (const [k, v] of encodeDay(d ?? NO_DATE_DAY, parts[i]!)) kv.set(k, JSON.parse(JSON.stringify(v)));
    });
    const decoded = days.map((d) => decodeDay(d ?? NO_DATE_DAY, (k) => kv.get(k)));
    expect(decoded.every((x) => x !== null)).toBe(true);
    expect(compareAssembled(assembled, JSONIFY(assembleFromParts(decoded as never)))).toEqual([]);
  });
});

describe("chunkBySize / encodeDay(1 値の大きさを上限以下に保つ)", () => {
  it("項目の順を保って区切り、どの塊も上限以下。連結すると元に戻る。空は塊 0 個", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ i, pad: "あ".repeat(100) }));
    const chunks = chunkBySize(items, 1000);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThanOrEqual(1000);
    expect(chunks.flat()).toEqual(items);
    expect(chunkBySize([], 1000)).toEqual([]);
  });
  it("1 項目で上限を超えるときは、その項目だけの塊にする(落とさない)", () => {
    const chunks = chunkBySize([{ a: 1 }, { pad: "x".repeat(500) }, { b: 2 }], 100);
    expect(chunks).toEqual([[{ a: 1 }], [{ pad: "x".repeat(500) }], [{ b: 2 }]]);
  });
  it("先頭の項目が上限を超えるときも、空の塊を作らない", () => {
    expect(chunkBySize([{ pad: "x".repeat(500) }, { a: 1 }], 100)).toEqual([[{ pad: "x".repeat(500) }], [{ a: 1 }]]);
  });
  it("encodeDay: 上限を小さくすると 1 種類が複数のキーに分かれ、decodeDay で元に戻る。キーの値はどれも上限以下", () => {
    const rows = manyDayRows(1, 12);
    const day = rows.analyses[0]!.kaisaiDate!;
    const parts = buildDayParts(rowsOfDay(rows, day), null);
    const limit = 3000;
    const encoded = encodeDay(day, parts, limit);
    const chunkKeys = [...encoded.keys()].filter((k) => !k.endsWith(":m"));
    expect(chunkKeys.filter((k) => k.includes(":all:")).length).toBeGreaterThan(1); // 前提: 実際に分かれた
    for (const k of chunkKeys) expect(new TextEncoder().encode(JSON.stringify(encoded.get(k))).length, k).toBeLessThanOrEqual(limit);
    const decoded = decodeDay(day, (k) => JSON.parse(JSON.stringify(encoded.get(k) ?? null)) ?? undefined);
    expect(JSONIFY(decoded)).toEqual(JSONIFY(parts));
  });
  it("decodeDay: メタが無い・部分の形の版が違う・塊が欠けているときは null(作り直しの対象)", () => {
    const rows = manyDayRows(1, 4);
    const day = rows.analyses[0]!.kaisaiDate!;
    const encoded = encodeDay(day, buildDayParts(rowsOfDay(rows, day), null));
    expect(decodeDay(day, () => undefined)).toBeNull();
    expect(decodeDay(day, (k) => (k.endsWith(":m") ? { ...(encoded.get(k) as object), v: PARTS_VERSION + 1 } : encoded.get(k)))).toBeNull();
    expect(decodeDay(day, (k) => (k.includes(":all:0") ? undefined : encoded.get(k)))).toBeNull();
  });
});

describe("compareAssembled(件数・金額・集合・区間の端は完全一致、小数は相対 1e-12)", () => {
  it.each([
    ["同じ", { a: 1, b: [1, 2], c: "x" }, { a: 1, b: [1, 2], c: "x" }, []],
    ["整数の違いは許さない", { a: 100 }, { a: 101 }, ["a"]],
    ["大きな整数の 1 の違いも許さない(相対では 1e-12 以内でも、整数は完全一致)", { a: 1e15 }, { a: 1e15 + 1 }, ["a"]],
    ["小数は相対 1e-12 以内なら同じ", { a: 0.1234567890123 }, { a: 0.1234567890123 * (1 + 5e-13) }, []],
    ["小数は相対 1e-12 を超えるとずれ", { a: 0.1234567890123 }, { a: 0.1234567890123 * (1 + 3e-12) }, ["a"]],
    ["区間の端(キー名に bound)は小数でも完全一致", { lowerBound: 0.5 }, { lowerBound: 0.5 * (1 + 1e-14) }, ["lowerBound"]],
    ["配列の長さの違い", { b: [1] }, { b: [1, 2] }, ["b"]],
    ["キーの欠落", { a: 1 }, { a: 1, z: 2 }, [""]],
    ["null と値", { a: null }, { a: 0 }, ["a"]],
    ["文字列", { s: "a" }, { s: "b" }, ["s"]],
  ] as const)("%s", (_name, x, y, expected) => {
    expect(compareAssembled(x, y)).toEqual(expected);
  });
  it("上限の件数で打ち切る", () => {
    const x = { a: Array.from({ length: 50 }, () => 1) };
    const y = { a: Array.from({ length: 50 }, () => 2) };
    expect(compareAssembled(x, y, 5)).toHaveLength(5);
  });
});

describe("normalizeForCompare(Issue #628。structured clone の値と JSON の値を同じ形にそろえる)", () => {
  it("undefined のキーは消え、NaN は null になる。正規化しないと、同じ内容でもずれと判定される", () => {
    const fromKv = { a: undefined, b: NaN, c: [1, undefined] as unknown[] };
    const fromJson = { b: null, c: [1, null] as unknown[] };
    expect(compareAssembled(fromKv, fromJson).length).toBeGreaterThan(0); // 前提: そろえないとずれる
    expect(compareAssembled(normalizeForCompare(fromKv), normalizeForCompare(fromJson))).toEqual([]);
  });
});
