import { describe, expect, it } from "vitest";
import { MigrationTally, parseMigrationLine } from "../../packages/core/src/ev/cloud-migration-format.js";
import { MAX_SYNTHETIC_BETS, perturbDecimals, seededRandom, syntheticBetKeys, syntheticLines, syntheticRaceId } from "../measure-migration-import.js";

/**
 * Issue #216(#167-B1): 移行の取り込みの実測スクリプト(scripts/measure-migration-import.ts)の、合成ファイルの作り方の検査。
 * 測定そのもの(wrangler dev の起動・workerd の CPU 時間)は機械の速度と /proc(Linux)に依存するため、テストでは固定しない。
 * ここで守るのは、「合成ファイルが exe の書き出しと同じ形式で、取り込み側の検証(parseMigrationLine + MigrationTally)を通ること」と「同じ引数なら同じファイル」。
 */

const SMALL = { analyses: 6, results: 3, horses: 3, bets: 4, comboEvery: 2 } as const;

describe("syntheticLines(合成ファイル)", () => {
  it("形式の検証を通る(ヘッダ → 分析 6 → 結果 3 → フッタ。件数が一致する)", () => {
    const tally = new MigrationTally();
    const lines = [...syntheticLines(SMALL)].map((l) => parseMigrationLine(l));
    for (const line of lines) tally.accept(line);
    tally.assertComplete();
    expect(lines.filter((l) => l.type === "analysis")).toHaveLength(6);
    expect(lines.filter((l) => l.type === "result")).toHaveLength(3);
    const footer = lines[lines.length - 1]!;
    expect(footer.type).toBe("footer");
  });

  it("馬の頭数・買い目の件数の引数どおりに入る", () => {
    const analysis = [...syntheticLines(SMALL)].map((l) => parseMigrationLine(l)).find((l) => l.type === "analysis");
    expect(analysis?.type === "analysis" ? [analysis.horses.length, analysis.bets.length] : null).toEqual([3, 4]);
  });

  it("同じ引数なら同じファイル(固定の種)。引数が違えば違う", () => {
    expect([...syntheticLines(SMALL)]).toEqual([...syntheticLines(SMALL)]);
    expect([...syntheticLines({ ...SMALL, horses: 4 })]).not.toEqual([...syntheticLines(SMALL)]);
  });

  it("組合せ全部入りの snapshot は comboEvery 件に 1 件(それ以外は小さい)", () => {
    const sizes = [...syntheticLines(SMALL)].map((l) => parseMigrationLine(l)).flatMap((l) => (l.type === "analysis" ? [String(l.analysis["race_snapshot_json"]).length] : []));
    expect(sizes).toHaveLength(6);
    // i=2,4,6 が全部入り(大きい)、i=1,3,5 は組合せなし(小さい)
    expect(sizes[1]!).toBeGreaterThan(sizes[0]! * 5);
    expect(sizes[3]!).toBeGreaterThan(sizes[2]! * 5);
  });

  it("結果の行の raceId は昇順・重複なし、分析の raceId は結果のレースに含まれる", () => {
    const lines = [...syntheticLines(SMALL)].map((l) => parseMigrationLine(l));
    const resultIds = lines.flatMap((l) => (l.type === "result" ? [l.raceId] : []));
    expect(resultIds).toEqual([...resultIds].sort());
    expect(new Set(resultIds).size).toBe(resultIds.length);
    for (const l of lines) {
      if (l.type === "analysis") expect(resultIds).toContain(l.analysis["race_id"]);
    }
  });
});

describe("合成するレース ID・買い目は、Issue #308 の値の検証に適う(以前の 202500000000 + n や 8 桁のキーは拒否される形だった)", () => {
  it("syntheticRaceId: 容量いっぱい(4800)まで有効なレース ID で、文字列としても昇順・重複なし。範囲外は throw", () => {
    const ids = Array.from({ length: 4800 }, (_, i) => syntheticRaceId(i + 1));
    expect(ids).toHaveLength(4800);
    expect(new Set(ids).size).toBe(4800);
    expect(ids).toEqual([...ids].sort());
    const line = (raceId: string): string => JSON.stringify({ type: "result", raceId, results: [], meta: null, comboPayouts: [], comboPayoutImports: [] });
    for (const id of [ids[0]!, ids[11]!, ids[12]!, ids[479]!, ids[480]!, ids[4799]!]) {
      expect(() => parseMigrationLine(line(id)), id).not.toThrow();
    }
    expect(() => syntheticRaceId(0)).toThrow();
    expect(() => syntheticRaceId(4801)).toThrow();
  });

  it("syntheticBetKeys: 最大数(6342)まで重複なしで、すべて有効な買い目。上限を超えれば throw", () => {
    expect(MAX_SYNTHETIC_BETS).toBe(6342);
    const all = syntheticBetKeys(MAX_SYNTHETIC_BETS);
    expect(all).toHaveLength(6342);
    expect(new Set(all.map((b) => `${b.betType}/${b.key}`)).size).toBe(6342);
    expect(new Set(all.map((b) => b.betType)).size).toBe(6);
    expect(() => syntheticBetKeys(MAX_SYNTHETIC_BETS + 1)).toThrow();
  });

  it("最大規模(結果 300・馬 18・買い目 6342 件)でも、全行が検証と並びの集計を通る。馬が 19 頭なら throw", () => {
    const big = { analyses: 2, results: 300, horses: 18, bets: MAX_SYNTHETIC_BETS, comboEvery: 0 } as const;
    const tally = new MigrationTally();
    const lines = [...syntheticLines(big)].map((l) => parseMigrationLine(l));
    for (const line of lines) tally.accept(line);
    tally.assertComplete();
    const first = lines.find((l) => l.type === "analysis");
    expect(first?.type === "analysis" ? [first.horses.length, first.bets.length] : null).toEqual([18, 6342]);
    expect(lines.filter((l) => l.type === "result")).toHaveLength(300);
    expect(() => [...syntheticLines({ ...big, horses: 19 })]).toThrow(/18/);
  });
});

describe("perturbDecimals(小数の値を、同じ桁数の別の値にする)", () => {
  it("桁数は変えず、値は変わる。整数・文字列は触らない", () => {
    const text = '{"a":1.2345,"b":[0.5,12.25],"n":7,"s":"x"}';
    const out = perturbDecimals(text, seededRandom(1));
    expect(out).not.toBe(text);
    expect(out.replace(/\d+\.\d+/g, "N")).toBe(text.replace(/\d+\.\d+/g, "N"));
    expect([...out.matchAll(/\d+\.(\d+)/g)].map((m) => m[1]!.length)).toEqual([4, 1, 2]);
    expect(JSON.parse(out)).toMatchObject({ n: 7, s: "x" });
  });
});
