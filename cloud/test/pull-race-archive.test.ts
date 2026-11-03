import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildRaceRecord, type RaceRecord } from "../../packages/core/src/scraper/race-record.js";
import { assertReadOnlySql } from "../cf-readonly-client";
import { CATALOG_SQL, encodeNdjsonGz, parseExistingLines, pullRaceArchive, type CatalogRow, type PullClient } from "../pull-race-archive";
import { encodeRaceArchive } from "../src/race-archive-format";
import { R2_FENCE_LIMITS } from "../src/r2-fence";

/**
 * Issue #586: 過去の結果(R2 の `race-results/`・D1 の `race_archive`)を、読み取りだけで手元の NDJSON(1 行 1 レース)に並べる道具。
 * 実ネットワークには出ない(窓口は偽物)。実フィクスチャの `RaceRecord` を R2 の保存物の形に符号化して使う。
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const built = buildRaceRecord(readFileSync(path.join(FIXTURES, "history_central_result_202105040811.html"), "utf-8"), "202105040811", "central");
if (!built.ok) throw new Error("フィクスチャが読めない");
const BASE: RaceRecord = built.record;
const NOW = new Date("2026-11-05T00:00:00.000Z");

function record(raceId: string, date: string): RaceRecord {
  return { ...BASE, raceId, date };
}

interface World {
  readonly client: PullClient & { readonly gets: string[]; readonly queries: Array<{ sql: string; params: readonly unknown[] }> };
  catalog: CatalogRow[];
  objects: Map<string, Uint8Array | "boom">;
  classB: number;
}

function entry(raceId: string, date: string, over: Partial<CatalogRow> = {}): CatalogRow {
  return { raceId, kind: "central", raceDate: date, parserVersion: BASE.parserVersion, r2Key: `race-results/${raceId}.json.gz`, rawBytes: 1000, fetchedAt: "2026-11-04T01:00:00.000Z", ...over };
}

function world(rows: Array<[string, string]>): World {
  const w: World = {
    catalog: rows.map(([id, d]) => entry(id, d)),
    objects: new Map(),
    classB: 0,
    client: undefined as never,
  };
  for (const [id, d] of rows) {
    w.objects.set(`race-results/${id}.json.gz`, encodeRaceArchive({ record: record(id, d), html: "<html>HTML-NOT-IN-OUTPUT</html>", fetchedAt: "2026-11-04T01:00:00.000Z" }).body);
  }
  const gets: string[] = [];
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  (w as { client: unknown }).client = {
    gets, queries,
    async query(sql: string, params: readonly unknown[]) {
      assertReadOnlySql(sql);
      queries.push({ sql, params });
      if (sql.includes("FROM r2_ops")) return { results: [{ classB: w.classB }], meta: {} };
      const [kind, from, to] = params as [string | undefined, string | undefined, string | undefined];
      void kind; void from; void to;
      return { results: w.catalog, meta: { rows_read: w.catalog.length } };
    },
    async getObject(key: string) {
      gets.push(key);
      const o = w.objects.get(key);
      if (o === "boom") throw new Error("通信の失敗");
      return o ?? null;
    },
  };
  return w;
}

const raceIdsOf = (lines: readonly string[]): string[] => lines.map((l) => (JSON.parse(l) as { raceId: string }).raceId);

describe("pullRaceArchive: 全件取得", () => {
  it("目録の全レースを GET し、1 行 1 レースにする。行は RaceRecord + _archive で、元の HTML は含まない。並びは (date, raceId) 昇順", async () => {
    const w = world([["202105040812", "2021-11-07"], ["202105040811", "2021-11-07"], ["202205010101", "2022-01-05"]]);
    w.catalog.reverse();
    const r = await pullRaceArchive({ client: w.client, filter: {}, existingText: "", now: () => NOW });
    expect(r.error).toBeUndefined();
    expect(raceIdsOf(r.lines)).toEqual(["202105040811", "202105040812", "202205010101"]);
    expect(w.client.gets).toHaveLength(3);
    const first = JSON.parse(r.lines[0]!) as RaceRecord & { _archive: unknown; html?: unknown };
    expect(first.html).toBeUndefined();
    expect(r.lines.join("")).not.toContain("HTML-NOT-IN-OUTPUT");
    expect(first._archive).toEqual({ fetchedAt: "2026-11-04T01:00:00.000Z", rawBytes: 1000, parserVersion: BASE.parserVersion });
    const { _archive, ...rest } = first;
    void _archive;
    expect(rest).toEqual(JSON.parse(JSON.stringify(record("202105040811", "2021-11-07"))));
    expect(first.horses.length).toBeGreaterThan(5); // 中身が空でないこと(往復で馬が落ちていない)
    expect(r.stats).toMatchObject({ catalog: 3, skipped: 0, fetched: 3, missing: 0 });
  });

  it("目録の SELECT は、種別・期間を WHERE に入れて束縛する(指定しなければ WHERE に出ない)", async () => {
    const w = world([["202105040811", "2021-11-07"]]);
    await pullRaceArchive({ client: w.client, filter: { kind: "central", from: "2021-11-01", to: "2021-11-30" }, existingText: "", now: () => NOW });
    const q = w.client.queries.find((x) => x.sql.includes("FROM race_archive"))!;
    expect(q.sql).toContain("kind = ?");
    expect(q.sql).toContain("race_date >= ?");
    expect(q.sql).toContain("race_date <= ?");
    expect(q.params).toEqual(["central", "2021-11-01", "2021-11-30"]);
    const w2 = world([["202105040811", "2021-11-07"]]);
    await pullRaceArchive({ client: w2.client, filter: {}, existingText: "", now: () => NOW });
    const q2 = w2.client.queries.find((x) => x.sql.includes("FROM race_archive"))!;
    expect(q2.sql).not.toContain("?");
    expect(q2.params).toEqual([]);
    expect(CATALOG_SQL({})).toContain("ORDER BY race_date, race_id");
  });
});

describe("pullRaceArchive: 取り直しで手元にあるものを飛ばす", () => {
  async function firstPull(w: World): Promise<string> {
    const r = await pullRaceArchive({ client: w.client, filter: {}, existingText: "", now: () => NOW });
    return r.lines.map((l) => `${l}\n`).join("");
  }

  it("目録の fetchedAt・rawBytes・parserVersion がすべて同じ行は GET しない", async () => {
    const w = world([["202105040811", "2021-11-07"], ["202105040812", "2021-11-07"]]);
    const text = await firstPull(w);
    w.client.gets.length = 0;
    const r = await pullRaceArchive({ client: w.client, filter: {}, existingText: text, now: () => NOW });
    expect(w.client.gets).toEqual([]);
    expect(r.stats).toMatchObject({ catalog: 2, skipped: 2, fetched: 0 });
    expect(r.lines).toEqual(text.split("\n").filter((l) => l !== ""));
  });

  for (const [name, over] of [
    ["fetchedAt が違う", { fetchedAt: "2026-11-05T01:00:00.000Z" }],
    ["rawBytes が違う", { rawBytes: 1001 }],
    ["parserVersion が違う", { parserVersion: BASE.parserVersion + 1 }],
  ] as const) {
    it(`${name}行だけ取り直す(ほかは飛ばす)`, async () => {
      const w = world([["202105040811", "2021-11-07"], ["202105040812", "2021-11-07"]]);
      const text = await firstPull(w);
      w.client.gets.length = 0;
      w.catalog[1] = { ...w.catalog[1]!, ...over };
      if ("parserVersion" in over) {
        // 取り直した保存物の読み取りの版も、目録に合わせて新しくする。
        w.objects.set("race-results/202105040812.json.gz", encodeRaceArchive({ record: { ...record("202105040812", "2021-11-07"), parserVersion: over.parserVersion }, html: "", fetchedAt: "2026-11-05T01:00:00.000Z" }).body);
      }
      const r = await pullRaceArchive({ client: w.client, filter: {}, existingText: text, now: () => NOW });
      expect(w.client.gets).toEqual(["race-results/202105040812.json.gz"]);
      expect(r.stats).toMatchObject({ skipped: 1, fetched: 1 });
      const updated = JSON.parse(r.lines[1]!) as { _archive: Record<string, unknown> };
      expect(updated._archive).toMatchObject({ fetchedAt: w.catalog[1]!.fetchedAt, rawBytes: w.catalog[1]!.rawBytes, parserVersion: w.catalog[1]!.parserVersion });
    });
  }

  it("_archive の無い手元の行は取り直す", async () => {
    const w = world([["202105040811", "2021-11-07"]]);
    const text = `${JSON.stringify(record("202105040811", "2021-11-07"))}\n`;
    const r = await pullRaceArchive({ client: w.client, filter: {}, existingText: text, now: () => NOW });
    expect(w.client.gets).toHaveLength(1);
    expect(r.stats.fetched).toBe(1);
  });

  it("目録に無い(期間の外の)手元の行は捨てず、そのまま残す", async () => {
    const w = world([["202205010101", "2022-01-05"]]);
    const old = `${JSON.stringify({ ...record("202105040811", "2021-11-07"), _archive: { fetchedAt: "x", rawBytes: 1, parserVersion: 2 } })}\n`;
    const r = await pullRaceArchive({ client: w.client, filter: { from: "2022-01-01" }, existingText: old, now: () => NOW });
    expect(raceIdsOf(r.lines)).toEqual(["202105040811", "202205010101"]);
  });

  it("手元のファイルの壊れた行(JSON でない・raceId が無い)は例外にせず数えて捨てる", () => {
    const parsed = parseExistingLines(`not json\n${JSON.stringify({ a: 1 })}\n${JSON.stringify(record("202105040811", "2021-11-07"))}\n\n`);
    expect([...parsed.rows.keys()]).toEqual(["202105040811"]);
    expect(parsed.broken).toBe(2);
  });
});

describe("pullRaceArchive: 取れなかったとき", () => {
  it("R2 に無い・壊れている保存物は missing に数え、行にしない(ほかのレースは続ける)", async () => {
    const w = world([["202105040811", "2021-11-07"], ["202105040812", "2021-11-07"], ["202105040813", "2021-11-07"]]);
    w.objects.delete("race-results/202105040811.json.gz");
    w.objects.set("race-results/202105040812.json.gz", gzipSync(new TextEncoder().encode("{broken")));
    const r = await pullRaceArchive({ client: w.client, filter: {}, existingText: "", now: () => NOW });
    expect(raceIdsOf(r.lines)).toEqual(["202105040813"]);
    expect(r.stats).toMatchObject({ fetched: 1, missing: 2 });
    expect(r.missingIds).toEqual(["202105040811", "202105040812"]);
  });

  it("GET が例外になったら、そこまでの行を返して error を付ける(取れた分を失わない)", async () => {
    const w = world([["202105040811", "2021-11-07"], ["202105040812", "2021-11-07"], ["202105040813", "2021-11-07"]]);
    w.objects.set("race-results/202105040812.json.gz", "boom");
    const r = await pullRaceArchive({ client: w.client, filter: {}, existingText: "", now: () => NOW });
    expect(r.error?.message).toContain("通信の失敗");
    expect(raceIdsOf(r.lines)).toEqual(["202105040811"]);
    expect(w.client.gets).toHaveLength(2); // 失敗したところで止める
  });
});

describe("pullRaceArchive: R2 の Class B の柵", () => {
  it("今月の使用量 + 予定の GET 数が柵に届くなら、GET せずに例外。文言に使用量・予定・柵を出す", async () => {
    const w = world([["202105040811", "2021-11-07"], ["202105040812", "2021-11-07"]]);
    w.classB = R2_FENCE_LIMITS.classB - 2; // 2 件取ると柵ちょうど(届く)
    const err = await pullRaceArchive({ client: w.client, filter: {}, existingText: "", now: () => NOW }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(String(R2_FENCE_LIMITS.classB - 2));
    expect(message).toContain("2");
    expect(message).toContain(String(R2_FENCE_LIMITS.classB));
    expect(w.client.gets).toEqual([]);
    const q = w.client.queries.find((x) => x.sql.includes("r2_ops"))!;
    expect(q.params).toEqual([202611]); // NOW の月(UTC)
  });

  it("柵の 1 つ手前までは取る", async () => {
    const w = world([["202105040811", "2021-11-07"], ["202105040812", "2021-11-07"]]);
    w.classB = R2_FENCE_LIMITS.classB - 3;
    const r = await pullRaceArchive({ client: w.client, filter: {}, existingText: "", now: () => NOW });
    expect(r.stats.fetched).toBe(2);
  });

  it("飛ばした行は予定に数えない(取り直しが 0 件なら、柵に届いていても例外にならない)", async () => {
    const w = world([["202105040811", "2021-11-07"]]);
    const text = (await pullRaceArchive({ client: w.client, filter: {}, existingText: "", now: () => NOW })).lines.map((l) => `${l}\n`).join("");
    w.classB = R2_FENCE_LIMITS.classB;
    const r = await pullRaceArchive({ client: w.client, filter: {}, existingText: text, now: () => NOW });
    expect(r.stats.skipped).toBe(1);
  });
});

describe("pullRaceArchive: dryRun", () => {
  it("目録と手元を突き合わせた予定だけを返し、GET しない", async () => {
    const w = world([["202105040811", "2021-11-07"], ["202105040812", "2021-11-07"]]);
    const r = await pullRaceArchive({ client: w.client, filter: {}, existingText: "", now: () => NOW, dryRun: true });
    expect(w.client.gets).toEqual([]);
    expect(r.stats).toMatchObject({ catalog: 2, skipped: 0, fetched: 0, planned: 2 });
  });
});

describe("encodeNdjsonGz", () => {
  it("gzip で展開すると 1 行 1 レースの NDJSON(末尾改行つき)。空でも読める", () => {
    expect(new TextDecoder().decode(gunzipSync(encodeNdjsonGz(['{"a":1}', '{"b":2}'])))).toBe('{"a":1}\n{"b":2}\n');
    expect(gunzipSync(encodeNdjsonGz([])).length).toBe(0);
  });
});
