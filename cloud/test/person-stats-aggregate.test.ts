import { describe, expect, it } from "vitest";
import type { PersonRow, PersonYearRow } from "../src/person-stats-calc";
import { aggregatePersonYearsFor, type PersonAggregateStore } from "../src/person-stats-aggregate";
import type { PersonRowsCursor, PersonRowsPage } from "../src/person-stats-repository";

/**
 * Issue #729(段階 A): 触れた年の人の行を読んで、人 × 年の集計を置き換える `aggregatePersonYearsFor`。偽のストアで、読む範囲(年の 1 月 1 日から翌年の 1 月 1 日の手前まで)・
 * ページをまたぐ読み・壊れた行がある年は書かない・触れていない年は読まない、を固定する。D1 の上の動きは person-stats-repository.integration.test.ts。
 */

const rowOf = (raceId: string, raceDate: string, horses: PersonRow["horses"]): PersonRow => ({ raceId, raceDate, venueCode: "06", courseType: "芝", distance: 1600, horses });

class FakeStore implements PersonAggregateStore {
  rows: PersonRow[] = [];
  brokenByYear = new Map<number, number>();
  reads: Array<{ after: PersonRowsCursor; to: string; limit: number }> = [];
  writes: Array<{ years: PersonYearRow[]; computedOn: string }> = [];

  async readRowsPage(after: PersonRowsCursor, toExclusive: string, limit: number): Promise<PersonRowsPage> {
    this.reads.push({ after, to: toExclusive, limit });
    const sorted = this.rows
      .filter((r) => (r.raceDate === after.raceDate ? r.raceId > after.raceId : r.raceDate > after.raceDate) && r.raceDate < toExclusive)
      .sort((a, b) => (a.raceDate === b.raceDate ? (a.raceId < b.raceId ? -1 : 1) : a.raceDate < b.raceDate ? -1 : 1))
      .slice(0, limit);
    const last = sorted[sorted.length - 1];
    const year = Number(toExclusive.slice(0, 4)) - 1;
    return { rows: sorted, broken: this.brokenByYear.get(year) ?? 0, next: sorted.length >= limit && last !== undefined ? { raceDate: last.raceDate, raceId: last.raceId } : null };
  }

  async replaceYears(years: readonly PersonYearRow[], computedOn: string): Promise<{ rowsWritten: number }> {
    this.writes.push({ years: [...years], computedOn });
    return { rowsWritten: years.length };
  }
}

describe("aggregatePersonYearsFor", () => {
  it("指定した年だけを、年の 1 月 1 日から翌年の 1 月 1 日の手前まで読み、人 × 年の集計を today つきで書く。触れていない年は読まない・書かない", async () => {
    const store = new FakeStore();
    store.rows = [
      rowOf("a", "2024-12-28", [["J1", "T1", 1]]),
      rowOf("b", "2025-01-05", [["J1", "T1", 0], ["J2", "T1", 1]]),
      rowOf("c", "2025-06-01", [["J1", "T2", 1]]),
      rowOf("d", "2026-01-04", [["J1", "T1", 1]]),
    ];
    const result = await aggregatePersonYearsFor(store, [2025], "2026-11-20");
    expect(result).toMatchObject({ status: "written", years: [2025], rowsWritten: 4, races: 2, skippedYears: [] });
    expect(store.reads.every((r) => r.to === "2026-01-01" && r.after.raceDate >= "2025-01-01")).toBe(true);
    expect(store.reads).toHaveLength(1);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]!.computedOn).toBe("2026-11-20");
    const w = store.writes[0]!.years;
    expect(w.every((y) => y.year === 2025)).toBe(true); // 前提: 2024・2026 の行は入っていない
    expect(w.find((y) => y.personKind === "jockey" && y.personId === "J1")).toMatchObject({ starts: 2, placed: 1 });
    expect(w.find((y) => y.personKind === "trainer" && y.personId === "T1")).toMatchObject({ starts: 2, placed: 1 });
    expect(w).toHaveLength(4); // 騎手 J1・J2 と、調教師 T1・T2(2025 年に出た 4 人。2024 年の a・2026 年の d は入らない)
  });

  it("ページをまたいで読む(pageSize 2 で 5 行 → 3 回。カーソルは前のページの最後の行)。年が複数なら年ごとに 1 回ずつ書く", async () => {
    const store = new FakeStore();
    store.rows = Array.from({ length: 5 }, (_, i) => rowOf(`r${i}`, `2025-03-0${i + 1}`, [["J1", "T1", 1]]));
    store.rows.push(rowOf("z", "2024-03-01", [["J1", "T1", 0]]));
    const result = await aggregatePersonYearsFor(store, [2024, 2025], "2026-11-20", { pageSize: 2 });
    expect(result.status).toBe("written");
    expect(store.reads.filter((r) => r.to === "2026-01-01")).toHaveLength(3);
    expect(store.reads.filter((r) => r.to === "2025-01-01")).toHaveLength(1);
    expect(store.writes).toHaveLength(2);
    const y2025 = store.writes.find((w) => w.years[0]!.year === 2025)!;
    expect(y2025.years.find((y) => y.personKind === "jockey" && y.personId === "J1")).toMatchObject({ starts: 5, placed: 5 });
  });

  it("壊れた行(読めなかった行)がある年は書かない(数が少ないまま書かない)。その年を skippedYears に返し、ほかの年は書く", async () => {
    const store = new FakeStore();
    store.rows = [rowOf("a", "2024-03-01", [["J1", "T1", 1]]), rowOf("b", "2025-03-01", [["J1", "T1", 1]])];
    store.brokenByYear.set(2024, 1);
    const result = await aggregatePersonYearsFor(store, [2024, 2025], "2026-11-20");
    expect(result).toMatchObject({ status: "written", years: [2025], skippedYears: [2024] });
    expect(store.writes.map((w) => w.years[0]!.year)).toEqual([2025]);
  });

  it("人の行が 1 行もない年は何も書かない。年の指定が空なら何も読まない", async () => {
    const store = new FakeStore();
    expect(await aggregatePersonYearsFor(store, [], "2026-11-20")).toEqual({ status: "no-years" });
    expect(store.reads).toEqual([]);
    const result = await aggregatePersonYearsFor(store, [2025], "2026-11-20");
    expect(result).toMatchObject({ status: "written", years: [], rowsWritten: 0 });
    expect(store.writes).toEqual([]);
  });
});
