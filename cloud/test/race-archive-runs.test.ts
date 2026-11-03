import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HORSE_RUN_PARSER_VERSION, encodeHorseRun } from "../../packages/core/src/scraper/horse-run-record";
import { buildRaceRecord, type RaceRecord } from "../../packages/core/src/scraper/race-record.js";
import { RESULT_RUN_VERSION, raceRecordToRuns } from "../../packages/core/src/scraper/race-record-to-runs";
import { convertRaceArchives, type ConvertTarget, type RaceArchiveRunsDb } from "../src/race-archive-runs";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #588(#549-B3-1): 目録のレース(R2 の読み取り結果)を horse_runs に変換して書く部品 `convertRaceArchives`。
 * ローカル(workerd)の本物の D1 で確かめる。固定するもの: 書く行(出どころ・版・初見時刻・タプル)・戦績 API の行に触れないこと・
 * 版が古い結果ページ由来の行だけの書き直し・済み印(race_archive.runs_version)が同じ batch で付くこと・拒否の扱い・書き込み行数・失敗時の巻き戻し。
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const load = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf-8");
function mustRecord(html: string, raceId: string, kind: "central" | "nar"): RaceRecord {
  const r = buildRaceRecord(html, raceId, kind);
  if (!r.ok) throw new Error(`読めるはずのレースが読めなかった: ${r.category} ${r.detail}`);
  return r.record;
}
const CENTRAL = mustRecord(load("history_central_result_202105040811.html"), "202105040811", "central");
const NAR = mustRecord(load("history_nar_result_202146110310.html"), "202146110310", "nar");

const NOW = new Date("2026-11-05T01:30:00.000Z");
const RAW_BYTES = 123_456;

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});

/** 目録の行を入れて、変換の入力を作る(rawBytes は目録の行と同じ値)。 */
async function catalogTarget(record: RaceRecord, rawBytes = RAW_BYTES): Promise<ConvertTarget> {
  await local.db
    .prepare("INSERT INTO race_archive (race_id, kind, race_date, parser_version, r2_key, raw_bytes, fetched_at) VALUES (?, ?, ?, ?, ?, ?, '2026-11-01T01:02:03.456Z')")
    .bind(record.raceId, record.kind, record.date, record.parserVersion, `race-results/${record.raceId}.json.gz`, rawBytes)
    .run();
  return { raceId: record.raceId, rawBytes, parserVersion: record.parserVersion, record };
}
const runsOf = async (): Promise<Array<Record<string, unknown>>> => (await local.db.prepare("SELECT horse_id, race_key, parser_version, first_seen_at, data, source FROM horse_runs ORDER BY horse_id, race_key").all()).results as Array<Record<string, unknown>>;
const mark = async (raceId: string): Promise<number | null> => (await local.db.prepare("SELECT runs_version AS v FROM race_archive WHERE race_id = ?").bind(raceId).first<{ v: number | null }>())!.v;

function expectedRuns(record: RaceRecord) {
  const converted = raceRecordToRuns(record);
  if (!converted.ok) throw new Error("変換できるはずのレースが拒否された");
  return converted.runs;
}

describe("convertRaceArchives: 書く行", () => {
  it("中央 1 レース: 走った馬ごとに 1 行が source='result'・版 RESULT_RUN_VERSION・初見時刻=now・タプル=変換の出力で入り、済み印が付く。書き込み行数は 走数 + 印 1", async () => {
    const target = await catalogTarget(CENTRAL);
    const runs = expectedRuns(CENTRAL);
    expect(runs.length).toBeGreaterThan(5); // 前提: 多頭のレース(1 頭だけの退化した入力ではない)
    const result = await convertRaceArchives(local.db, [target], NOW);
    expect(result.outcomes).toEqual([{ raceId: "202105040811", status: "converted", runs: runs.length, skippedNonStart: expect.any(Number), skippedNoHorseId: expect.any(Number) }]);
    const rows = await runsOf();
    expect(rows).toHaveLength(runs.length);
    for (const r of runs) {
      const row = rows.find((x) => x["horse_id"] === r.horseId);
      expect(row, r.horseId).toBeDefined();
      expect(row).toEqual({ horse_id: r.horseId, race_key: r.raceKey, parser_version: RESULT_RUN_VERSION, first_seen_at: NOW.getTime(), data: JSON.stringify(encodeHorseRun(r.run)), source: "result" });
    }
    expect(await mark("202105040811")).toBe(RESULT_RUN_VERSION);
    expect(result.rowsWritten).toBe(runs.length + 1);
    expect(result.markedRaces).toBe(1);
  });

  it("RESULT_RUN_VERSION は戦績 API の版と別の目盛り(前提の固定): 現行の組は [戦績 API 1, 結果ページ由来 1]", () => {
    expect([HORSE_RUN_PARSER_VERSION, RESULT_RUN_VERSION]).toEqual([1, 1]);
  });

  it("複数のレース(中央と地方)は D1 の batch 1 回で書く。両方の行と印が入る", async () => {
    const t1 = await catalogTarget(CENTRAL);
    const t2 = await catalogTarget(NAR, 99_999);
    let batches = 0;
    const db = { prepare: (sql: string) => local.db.prepare(sql), batch: (s: D1PreparedStatement[]) => { batches += 1; return local.db.batch(s); } } as unknown as RaceArchiveRunsDb;
    const result = await convertRaceArchives(db, [t1, t2], NOW);
    expect(batches).toBe(1);
    const n = expectedRuns(CENTRAL).length + expectedRuns(NAR).length;
    expect(await runsOf()).toHaveLength(n);
    expect(result.markedRaces).toBe(2);
    expect(result.rowsWritten).toBe(n + 1 + 1); // 行 + 印 2 行(印は 1 文で 2 行を更新)
    expect([await mark("202105040811"), await mark("202146110310")]).toEqual([RESULT_RUN_VERSION, RESULT_RUN_VERSION]);
  });

  it("対象が空なら D1 に何も発行しない", async () => {
    let touched = 0;
    const db = { prepare: () => { touched += 1; throw new Error("呼ばれない"); }, batch: () => { touched += 1; throw new Error("呼ばれない"); } };
    const result = await convertRaceArchives(db, [], NOW);
    expect(touched).toBe(0);
    expect(result).toEqual({ outcomes: [], rowsWritten: 0, markedRaces: 0, dbSizeBytes: null });
  });
});

describe("convertRaceArchives: 戦績 API の行・既存の結果ページ由来の行", () => {
  it("同じ (馬, レース) に戦績 API の行があれば触れない(内容・出どころ・初見時刻・版が同じ)。ほかの馬の行は入る。書き込み行数は 走数 − 1 + 印 1", async () => {
    const target = await catalogTarget(CENTRAL);
    const runs = expectedRuns(CENTRAL);
    const api = runs[0]!;
    await local.db.prepare("INSERT INTO horse_runs (horse_id, race_key, parser_version, first_seen_at, data, source) VALUES (?, ?, 1, 1000, '[\"戦績API\"]', NULL)").bind(api.horseId, api.raceKey).run();
    const result = await convertRaceArchives(local.db, [target], NOW);
    const rows = await runsOf();
    expect(rows).toHaveLength(runs.length);
    expect(rows.find((r) => r["horse_id"] === api.horseId)).toEqual({ horse_id: api.horseId, race_key: api.raceKey, parser_version: 1, first_seen_at: 1000, data: '["戦績API"]', source: null });
    expect(rows.filter((r) => r["source"] === "result")).toHaveLength(runs.length - 1);
    expect(result.rowsWritten).toBe(runs.length - 1 + 1);
    expect(await mark("202105040811")).toBe(RESULT_RUN_VERSION);
  });

  it("結果ページ由来の古い版の行だけを書き直す(data と版だけ更新。初見時刻と出どころは変えない)。同じ版以上の結果ページ由来の行は書き直さない", async () => {
    const target = await catalogTarget(CENTRAL);
    const runs = expectedRuns(CENTRAL);
    const [old, same, newer] = [runs[0]!, runs[1]!, runs[2]!];
    const put = (r: (typeof runs)[number], version: number, data: string) =>
      local.db.prepare("INSERT INTO horse_runs (horse_id, race_key, parser_version, first_seen_at, data, source) VALUES (?, ?, ?, 2000, ?, 'result')").bind(r.horseId, r.raceKey, version, data).run();
    await put(old, RESULT_RUN_VERSION - 1, '["古い"]');
    await put(same, RESULT_RUN_VERSION, '["同じ版"]');
    await put(newer, RESULT_RUN_VERSION + 1, '["新しい版"]');
    await convertRaceArchives(local.db, [target], NOW);
    const rows = await runsOf();
    const byId = (id: string) => rows.find((r) => r["horse_id"] === id)!;
    expect(byId(old.horseId)).toEqual({ horse_id: old.horseId, race_key: old.raceKey, parser_version: RESULT_RUN_VERSION, first_seen_at: 2000, data: JSON.stringify(encodeHorseRun(old.run)), source: "result" });
    expect(byId(same.horseId)["data"]).toBe('["同じ版"]');
    expect(byId(newer.horseId)["data"]).toBe('["新しい版"]');
    expect(byId(newer.horseId)["parser_version"]).toBe(RESULT_RUN_VERSION + 1);
    expect(rows).toHaveLength(runs.length); // 書き直しは行を増やさない
  });

  it("冪等: 変換済みのレースをもう一度変換しても行は変わらず、horse_runs の書き込みは 0(印の更新 1 行だけ)", async () => {
    const target = await catalogTarget(CENTRAL);
    await convertRaceArchives(local.db, [target], NOW);
    const before = await runsOf();
    const again = await convertRaceArchives(local.db, [target], new Date(NOW.getTime() + 86_400_000));
    expect(await runsOf()).toEqual(before); // 初見時刻も含めて 1 バイトも変わらない
    expect(again.rowsWritten).toBe(1);
  });
});

describe("convertRaceArchives: 拒否・失敗・ガード", () => {
  it("頭数の宣言と行数が合わないレースは拒否: 行を書かず、拒否の版で印を付ける(同じ版では再試行しない)。理由を返す。ほかのレースの変換は妨げない", async () => {
    const bad: RaceRecord = { ...NAR, horses: NAR.horses.slice(0, 2) }; // 宣言の頭数と合わない
    expect(raceRecordToRuns(bad).ok).toBe(false); // 前提: 実際に拒否される(拒否でなければ下の検査が空振りする)
    const t1 = await catalogTarget(bad, 111);
    const t2 = await catalogTarget(CENTRAL);
    const result = await convertRaceArchives(local.db, [t1, t2], NOW);
    expect(result.outcomes[0]).toMatchObject({ raceId: bad.raceId, status: "rejected" });
    expect((result.outcomes[0] as { reason: string }).reason).toContain("頭数");
    expect(result.outcomes[1]).toMatchObject({ raceId: "202105040811", status: "converted" });
    expect((await runsOf()).every((r) => String(r["race_key"]) === "202105040811")).toBe(true);
    expect(await mark(bad.raceId)).toBe(RESULT_RUN_VERSION);
    expect(result.markedRaces).toBe(2);
  });

  it("目録の行が変わっていたら(raw_bytes か parser_version が食い違う)印を付けない。印を付けないので次の周で読み直される", async () => {
    const stale = await catalogTarget(CENTRAL);
    await local.db.prepare("UPDATE race_archive SET raw_bytes = raw_bytes + 1 WHERE race_id = ?").bind(CENTRAL.raceId).run(); // 変換の途中で目録が更新された
    const r1 = await convertRaceArchives(local.db, [stale], NOW);
    expect(r1.markedRaces).toBe(0);
    expect(await mark(CENTRAL.raceId)).toBeNull();
    await local.db.prepare("UPDATE race_archive SET raw_bytes = ?, parser_version = parser_version + 1 WHERE race_id = ?").bind(RAW_BYTES, CENTRAL.raceId).run();
    expect((await convertRaceArchives(local.db, [stale], NOW)).markedRaces).toBe(0); // 版の食い違いでも付けない
    await local.db.prepare("UPDATE race_archive SET parser_version = ? WHERE race_id = ?").bind(CENTRAL.parserVersion, CENTRAL.raceId).run();
    expect((await convertRaceArchives(local.db, [stale], NOW)).markedRaces).toBe(1); // 対照: 揃っていれば付く
  });

  it("印を付ける文は目録の全件走査にならない: 300 件の目録でも 1 レースの印の更新の rows_read は 10 件以内", async () => {
    for (let i = 0; i < 300; i += 1) {
      await local.db.prepare("INSERT INTO race_archive (race_id, kind, race_date, parser_version, r2_key, raw_bytes, fetched_at) VALUES (?, 'central', '2021-11-01', 2, 'k', 1, 'x')").bind(`2022010${String(10000 + i)}`).run();
    }
    const target = await catalogTarget(CENTRAL);
    const reads: number[] = [];
    const db = {
      prepare: (sql: string) => local.db.prepare(sql),
      batch: async (s: D1PreparedStatement[]) => {
        const res = await local.db.batch(s);
        reads.push(...res.map((r) => r.meta.rows_read));
        return res;
      },
    } as unknown as RaceArchiveRunsDb;
    await convertRaceArchives(db, [target], NOW);
    expect(reads.length).toBeGreaterThanOrEqual(2); // 前提: 書き込みの文と印の文が実際に走った
    expect(Math.max(...reads)).toBeLessThan(100); // どの文も、300 件の全件走査(300 以上)にならない。書き込みの文は馬ごとの鍵の照合で数十行読む
    expect(reads[reads.length - 1]!).toBeLessThanOrEqual(10);
  });

  it("batch が失敗したら例外で、horse_runs の行も済み印も残らない(一緒に落ちる)", async () => {
    const target = await catalogTarget(CENTRAL);
    const db = { prepare: (sql: string) => local.db.prepare(sql), batch: async () => { throw new Error("D1_ERROR: injected"); } } as unknown as RaceArchiveRunsDb;
    await expect(convertRaceArchives(db, [target], NOW)).rejects.toThrow(/injected/);
    expect(await runsOf()).toEqual([]);
    expect(await mark(CENTRAL.raceId)).toBeNull();
  });

  it("実際の D1 の batch の途中の文が失敗したときも巻き戻る(印の文だけが失敗する状況: race_archive.runs_version 列が無い DB の模擬)", async () => {
    const target = await catalogTarget(CENTRAL);
    let batchCalled = 0;
    const db = {
      prepare: (sql: string) => local.db.prepare(sql.startsWith("UPDATE race_archive") ? "UPDATE race_archive SET no_such_column = 1" : sql),
      batch: (s: D1PreparedStatement[]) => {
        batchCalled += 1;
        return local.db.batch(s);
      },
    } as unknown as RaceArchiveRunsDb;
    await expect(convertRaceArchives(db, [target], NOW)).rejects.toThrow();
    expect(batchCalled).toBe(1); // 前提: 失敗は batch の実行中(文の用意の段階で落ちたのではない)
    expect(await runsOf()).toEqual([]); // 先に書いた horse_runs の行も巻き戻っている
    expect(await mark(CENTRAL.raceId)).toBeNull();
  });

  it("入力の検査: race_id と record.raceId が食い違う・同じレースが重複・race_id が 12 桁でない、は RangeError で D1 に触れない", async () => {
    const target = await catalogTarget(CENTRAL);
    let touched = 0;
    const db = { prepare: () => { touched += 1; throw new Error("呼ばれない"); }, batch: () => { touched += 1; throw new Error("呼ばれない"); } };
    await expect(convertRaceArchives(db, [{ ...target, raceId: "202146110310" }], NOW)).rejects.toThrow(RangeError);
    await expect(convertRaceArchives(db, [target, target], NOW)).rejects.toThrow(RangeError);
    await expect(convertRaceArchives(db, [{ ...target, raceId: "x", record: { ...CENTRAL, raceId: "x" } }], NOW)).rejects.toThrow(RangeError);
    expect(touched).toBe(0);
  });
});
