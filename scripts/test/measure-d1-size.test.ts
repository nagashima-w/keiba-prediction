import { describe, expect, it } from "vitest";
import { D1_FREE_DB_BYTES, buildDetailText, seededRandom, syntheticItems, yearsUntilFull } from "../measure-d1-size.js";

/**
 * Issue #171(#169-a): 容量の測定スクリプト(scripts/measure-d1-size.ts)の純関数の検査。
 * 測定そのもの(フィクスチャ・SQLite への保存)は、zlib のバージョン差で gzip 後の大きさが変わりうるため、テストでは固定しない。
 * 結果の値と N は docs/current-spec.md に記録してあり、`pnpm tsx scripts/measure-d1-size.ts` で再現できる。
 */
describe("yearsUntilFull(上限が埋まるまでの年数)", () => {
  it("上限 ÷ 1分析のバイト数 ÷ 年間件数(手計算: 500e6 / 6644 / 3500 = 21.5)", () => {
    expect(D1_FREE_DB_BYTES).toBe(500e6);
    expect(yearsUntilFull(6644, D1_FREE_DB_BYTES, 3500)).toBeCloseTo(21.5, 1);
    expect(yearsUntilFull(6644, D1_FREE_DB_BYTES, 20000)).toBeCloseTo(3.8, 1);
    expect(yearsUntilFull(144957, D1_FREE_DB_BYTES, 3500)).toBeCloseTo(0.99, 2);
  });

  it("1分析が大きいほど、年間件数が多いほど、短くなる(単調)", () => {
    expect(yearsUntilFull(2000, 500e6, 1000)).toBeGreaterThan(yearsUntilFull(4000, 500e6, 1000));
    expect(yearsUntilFull(2000, 500e6, 1000)).toBeGreaterThan(yearsUntilFull(2000, 500e6, 2000));
  });
});

describe("seededRandom(固定の種の乱数)", () => {
  it("同じ種なら同じ列を返し、種が違えば違う列を返す。値は [0, 1)", () => {
    const a = seededRandom(1);
    const b = seededRandom(1);
    const c = seededRandom(2);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    const seqC = Array.from({ length: 5 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of [...seqA, ...seqC]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(seqA).size).toBe(5);
  });
});

describe("buildDetailText(R2 の詳細オブジェクトの JSON。Issue #174 の CPU 測定の入力)", () => {
  it("raceSnapshot・rawResponse・contributions(16頭。馬番 1〜16)を持つ JSON で、組合せ入りの大きさ(100KB 超)である", () => {
    const text = buildDetailText();
    const detail = JSON.parse(text) as { raceSnapshot: { horses: unknown[]; trifectaCombo: Record<string, unknown> }; rawResponse: unknown; contributions: Array<{ umaban: number; contributions: unknown }> };
    expect(Object.keys(detail).sort()).toEqual(["contributions", "raceSnapshot", "rawResponse"]);
    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(100_000);
    // 前提: 組合せが実際に入っている(三連単 3,360 キーが最大の部分。入っていないと大きさの見積もりが小さく出る)
    expect(Object.keys(detail.raceSnapshot.trifectaCombo).length).toBeGreaterThan(1000);
    expect(detail.raceSnapshot.horses).toHaveLength(16);
    expect(typeof detail.rawResponse).toBe("string");
    expect((detail.rawResponse as string).length).toBeGreaterThan(1000);
    expect(detail.contributions.map((c) => c.umaban)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    for (const c of detail.contributions) {
      expect(Array.isArray(c.contributions)).toBe(true);
      expect((c.contributions as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("同じ入力から同じ文字列を返す(乱数を使わない。CPU 測定の入力が実行ごとに変わらない)", () => {
    expect(buildDetailText()).toBe(buildDetailText());
  });
});

describe("syntheticItems(強調材料・懸念事項の合成。Issue #197。実データではなく、上限寄りの大きさの見積もり用)", () => {
  it("count 個の、ちょうど chars 文字(全角)の項目を返す。UTF-8 で 1 文字 3 バイトなので、1項目 = chars × 3 バイト", () => {
    const items = syntheticItems(3, 30, "h", 7);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect([...item]).toHaveLength(30);
      expect(Buffer.byteLength(item, "utf-8")).toBe(90);
    }
  });

  it("count が 0 なら空配列(項目なしの基準値。#197 より前の保存の大きさを再現する)", () => {
    expect(syntheticItems(0, 30, "h", 7)).toEqual([]);
  });

  it("同じ入力から同じ値(乱数を使わない)。種類(強調・懸念)と馬番が違えば、違う文字列になる", () => {
    expect(syntheticItems(3, 30, "h", 7)).toEqual(syntheticItems(3, 30, "h", 7));
    expect(syntheticItems(3, 30, "h", 7)).not.toEqual(syntheticItems(3, 30, "c", 7));
    expect(syntheticItems(3, 30, "h", 7)).not.toEqual(syntheticItems(3, 30, "h", 8));
    // 同じ列の中の項目どうしも別の文字列(重複した行を作らない)
    expect(new Set(syntheticItems(3, 30, "h", 7)).size).toBe(3);
  });
});
