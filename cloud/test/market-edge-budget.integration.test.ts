import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildRaceRecord, type RaceRecord } from "../../packages/core/src/scraper/race-record.js";
import { aggregateMarketEdges } from "../src/market-edge-aggregate";
import { RaceMarketEdgeCore } from "../src/market-edge-core";
import { D1MarketEdgeStore } from "../src/market-edge-repository";
import { D1RaceArchiveStore } from "../src/race-archive-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql } from "./node-sql";

/**
 * Issue #642: 騎手・調教師の指標の毎晩の計算を、本物のコア(`RaceMarketEdgeCore`)・本物の D1 と R2(ローカルの workerd)・実際の結果ページから作った記録で最後まで通し、
 * 書き込み行数(D1 の `meta.rows_written`)を固定する。コアが数える `night_rows` が、D1 の実測(各文の rows_written の合計 + Class B の計数 1 行ずつ)と合うことも確かめる。
 * 1 レースの取り込みの書き込みと、集計 1 回の書き込みの見積もり(docs/current-spec.md)は、ここの実測。
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const HTML = readFileSync(path.join(FIXTURES, "history_central_result_202105040811.html"), "utf-8");
const built = buildRaceRecord(HTML, "202105040811", "central");
if (!built.ok) throw new Error("読めるはずのレースが読めなかった");
const BASE: RaceRecord = built.record;

const MIN = 60_000;
const JST = 9 * 60 * MIN;
const NIGHT = Date.UTC(2026, 10, 7, 3, 0) - JST; // 2026-11-07 3:00 JST
const RACES = 30;
const idOf = (n: number): string => `2025010${String(10000 + n)}`;
/** i 番目の変種: 着順を馬のあいだで回して(同じレースの複製だと完全分離で収束しない)、騎手・調教師の組み合わせも変える。 */
function variant(i: number, date: string): RaceRecord {
  const n = BASE.horses.length;
  const finishes = BASE.horses.map((h) => ({ finish: h.finish, finishStatus: h.finishStatus, finishRaw: h.finishRaw }));
  const horses = BASE.horses.map((h, j) => ({ ...h, ...finishes[(j + i * 5) % n]!, jockeyId: BASE.horses[(j + i) % n]!.jockeyId, jockeyName: BASE.horses[(j + i) % n]!.jockeyName }));
  return { ...BASE, raceId: idOf(i), date, horses };
}

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
  const keys = (await local.r2.list()).objects.map((o) => o.key);
  if (keys.length > 0) await local.r2.delete(keys);
});

describe("毎晩の計算を最後まで通す", () => {
  it(`目録の ${RACES} レース(窓の中 ${RACES - 6}・窓より古い 6)を取り込み、集計して、書き込み行数が見積もりどおりになる。2 晩目は新しい行が無く、集計の置き換えだけ`, async () => {
    const archive = new D1RaceArchiveStore({ db: local.db, bucket: local.r2 as never, now: () => new Date("2026-11-01T00:00:00.000Z") });
    for (let i = 0; i < RACES; i++) {
      const date = i < 6 ? "2022-05-01" : "2025-06-01";
      const res = await archive.saveRaceArchive({ record: variant(i, date), html: HTML });
      expect(res.status).toBe("saved");
    }
    const store = new D1MarketEdgeStore(local.db);
    const sql = openNodeSql();
    let now = NIGHT;
    let alarm: number | null = null;
    let measured = 0; // コアの外から数える D1 の書き込み行数(取り込みと集計)
    const countingStore = {
      listPendingPage: (a: string, l: number) => store.listPendingPage(a, l),
      markSkipped: async (ids: readonly string[]) => {
        const r = await store.markSkipped(ids);
        measured += r.rowsWritten;
        return r;
      },
      saveRows: async (rows: Parameters<typeof store.saveRows>[0], done: readonly string[]) => {
        const r = await store.saveRows(rows, done);
        measured += r.rowsWritten + 1; // + Class B の計数 1 行(コアが足す分)
        return r;
      },
    };
    const core = new RaceMarketEdgeCore({
      sql,
      now: () => now,
      setAlarm: (t) => {
        alarm = t;
      },
      getAlarm: async () => alarm,
      store: countingStore,
      archive: { readRaceArchives: (ids) => archive.readRaceArchives(ids) },
      aggregate: async (today) => {
        const r = await aggregateMarketEdges(store, today);
        if (r.status === "written") measured += r.rowsWritten;
        return r;
      },
      log: () => undefined,
    });

    await core.kick();
    const runUntil = async (end: number): Promise<void> => {
      for (let i = 0; i < 200 && alarm !== null && alarm < end; i++) {
        now = Math.max(now, alarm);
        alarm = null;
        await core.runNextStep();
      }
    };
    await runUntil(NIGHT + 24 * 60 * MIN);

    const rowsOf = async (): Promise<number> => (await local.db.prepare("SELECT COUNT(*) AS n FROM race_market_rows").first<{ n: number }>())!.n;
    const marks = (await local.db.prepare("SELECT market_version AS v, COUNT(*) AS n FROM race_archive GROUP BY market_version ORDER BY v").all<{ v: number; n: number }>()).results;
    expect(await rowsOf()).toBe(RACES - 6);
    expect(marks).toEqual([{ v: -1, n: 6 }, { v: 1, n: RACES - 6 }]);

    const status1 = await core.getStatus();
    expect(status1.lastCalc).toMatchObject({ date: "2026-11-07", status: "written" });
    expect(status1.night.rows).toBe(measured); // コアの数えた行数 = コアの外から数えた D1 の実測
    // 取り込み: 窓の中 24 レース = 行 2 + 印 1 = 3 行ずつ、窓より古い 6 レース = 印だけ 1 行ずつ、ステップの Class B の計数 1 行(24 レース = 2 ステップ)
    const edges = await store.readEdges("jockey");
    const trainers = await store.readEdges("trainer");
    const meta = (await store.readMeta())!;
    expect(edges.length).toBeGreaterThan(0);
    expect(meta.races).toBe(RACES - 6);
    // 集計: 騎手 + 調教師 + 記録 1 行(最初の晩は削除なし)
    const importRows = (RACES - 6) * 3 + 6 * 1 + 2; // 2 ステップ(20 + 4 レース)の計数 1 行ずつ
    expect(status1.night.rows).toBe(importRows + edges.length + trainers.length + 1);
    expect(meta.converged).toBe(true);

    // 2 晩目: 取り込むものは無い。集計の置き換え(人数 + 記録 1 行)だけ。窓の開始日が進むが、行は窓の中のまま
    now = NIGHT + 24 * 60 * MIN;
    await core.kick();
    await runUntil(now + 24 * 60 * MIN);
    const status2 = await core.getStatus();
    expect(status2.night.date).toBe("2026-11-08");
    expect(status2.night.rows).toBe(edges.length + trainers.length + 1);
    expect((await store.readMeta())!.computedOn).toBe("2026-11-08");
    sql.close();
  }, 120_000);
});
