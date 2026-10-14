import { describe, expect, it } from "vitest";
import { MigrationTally, parseMigrationLine } from "../../packages/core/src/ev/cloud-migration-format.js";
import { perturbDecimals, seededRandom, syntheticLines } from "../measure-migration-import.js";

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
