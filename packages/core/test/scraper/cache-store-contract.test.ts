import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScrapeCache } from "../../src/scraper/cache.js";

/**
 * Issue #177(#164-b)・#170 AC-c1: CacheStore の契約を、exe の実装(ScrapeCache。better-sqlite3)に当てる。
 * 同じ契約(`fixtures/cache-store-contract.json`)を、クラウド版の DoSqlCacheStore(cloud/test/do-cache-store.test.ts)も読む。
 * 両方が同じ期待値に一致することで、2つの実装の鮮度判定(境界・上書き・読み取り側の判定)が食い違わないことを保つ。
 */

type Step =
  | { op: "set"; key: string; value: string; at: number }
  | { op: "get"; key: string; at: number; maxAgeMs?: number; expect: { value: string; fetchedAt: number } | null };

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/cache-store-contract.json", import.meta.url)), "utf-8"),
) as { cases: { name: string; steps: Step[] }[] };

describe("ScrapeCache が CacheStore の契約を満たす(Issue #177 AC-b1)", () => {
  it("前提(空振り防止): 契約に複数のケースと、ヒット・ミス両方の期待がある", () => {
    expect(contract.cases.length).toBeGreaterThanOrEqual(8);
    const gets = contract.cases.flatMap((c) => c.steps).filter((s): s is Extract<Step, { op: "get" }> => s.op === "get");
    expect(gets.some((g) => g.expect === null)).toBe(true);
    expect(gets.some((g) => g.expect !== null)).toBe(true);
  });

  it.each(contract.cases.map((c) => [c.name, c] as const))("%s", (_name, testCase) => {
    let clock = 0;
    const cache = new ScrapeCache({ now: () => clock });
    for (const step of testCase.steps) {
      clock = step.at;
      if (step.op === "set") {
        cache.set(step.key, step.value);
        continue;
      }
      const actual = cache.get(step.key, step.maxAgeMs === undefined ? {} : { maxAgeMs: step.maxAgeMs });
      expect(actual === undefined ? null : actual).toEqual(step.expect);
    }
    cache.close();
  });
});
