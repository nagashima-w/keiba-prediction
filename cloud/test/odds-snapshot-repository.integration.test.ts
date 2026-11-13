import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { D1OddsSnapshotStore, INSERT_ODDS_SNAPSHOT_SQL } from "../src/odds-snapshot-repository";
import type { OddsSnapshotPayload } from "../src/race-day-odds-snapshot";
import { installFetchTrap } from "./fetch-trap";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #732: 発走 5 分前のオッズの記録 `odds_snapshots` の書き込み(1 レース 1 行・先着・書き込みの行数)。
 * ローカル(workerd)の D1 に、`wrangler d1 migrations apply --local` で適用した表に対して確かめる。本番の D1 には触れない。
 */
installFetchTrap();

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

const ok: OddsSnapshotPayload = {
  raceId: "202605010101", leadMin: 5, kaisaiDate: "20261115", startMs: 1_000_000, dueMs: 700_000, takenAtMs: 712_345,
  officialDatetime: "2026-11-15 15:40:00", oddsStatus: "middle", status: "ok", reason: null, attempts: 2,
  horses: [[1, 2.1, 1, 1.2, 1.5, "2023101645"], [2, null, null, null, null, null]],
};
const rowsOf = async (): Promise<Record<string, unknown>[]> => (await local.db.prepare("SELECT * FROM odds_snapshots ORDER BY race_id").all()).results as Record<string, unknown>[];

describe("save(1 レース・1 時点で 1 行。追記だけ)", () => {
  it("ok の行: 全列が正しく入り、horses_json は馬ごとの配列(複勝の下限・上限の両方)", async () => {
    await new D1OddsSnapshotStore({ db: local.db }).save(ok);
    const rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      race_id: "202605010101", lead_min: 5, kaisai_date: "20261115", start_ms: 1_000_000, due_ms: 700_000, taken_at_ms: 712_345,
      official_datetime: "2026-11-15 15:40:00", odds_status: "middle", status: "ok", reason: null, attempts: 2,
    });
    expect(JSON.parse(rows[0]!["horses_json"] as string)).toEqual([[1, 2.1, 1, 1.2, 1.5, "2023101645"], [2, null, null, null, null, null]]);
  });
  it("skipped・failed の行: 理由と、取れなかった・取らないと決めた時刻が入り、頁の値・馬は NULL", async () => {
    const store = new D1OddsSnapshotStore({ db: local.db });
    await store.save({ ...ok, raceId: "202605010102", takenAtMs: 5_000, officialDatetime: null, oddsStatus: null, status: "skipped", reason: "too-late", attempts: 0, horses: null });
    await store.save({ ...ok, raceId: "202605010103", takenAtMs: 6_000, officialDatetime: null, oddsStatus: null, status: "failed", reason: "fetch-failed", attempts: 4, horses: null });
    const rows = await rowsOf();
    expect(rows.map((r) => [r["race_id"], r["status"], r["reason"], r["attempts"], r["taken_at_ms"], r["horses_json"]])).toEqual([
      ["202605010102", "skipped", "too-late", 0, 5_000, null],
      ["202605010103", "failed", "fetch-failed", 4, 6_000, null],
    ]);
  });
  it("同じレースの再保存は行を増やさず、先に入った値を変えない(changes = 0。書き込みの行を食わない)", async () => {
    const store = new D1OddsSnapshotStore({ db: local.db });
    await store.save(ok);
    const again = await local.db.prepare(INSERT_ODDS_SNAPSHOT_SQL).bind(ok.raceId, ok.leadMin, ok.kaisaiDate, ok.startMs, ok.dueMs, 1, null, null, "failed", "fetch-failed", 9, null).run();
    expect(again.meta.changes).toBe(0);
    await store.save({ ...ok, takenAtMs: 999 });
    const rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taken_at_ms: 712_345, status: "ok", attempts: 2 });
  });
  it("同じレースの 10 分前と 5 分前は別の行(主キーは (race_id, lead_min))。10 分前を先に入れても 5 分前は入る。同じ時点の再保存だけが何もしない", async () => {
    const store = new D1OddsSnapshotStore({ db: local.db });
    await store.save({ ...ok, leadMin: 10, dueMs: 400_000, takenAtMs: 410_000 });
    await store.save(ok);
    await store.save({ ...ok, leadMin: 10, takenAtMs: 999_999 });
    const rows = await rowsOf();
    expect(rows.map((r) => [r["lead_min"], r["taken_at_ms"], r["due_ms"]])).toEqual([[5, 712_345, 700_000], [10, 410_000, 400_000]]);
  });
  it("追記だけ: UPDATE・DELETE を流さず、INSERT の 1 文だけ(SQL の文面で固定)", () => {
    expect(INSERT_ODDS_SNAPSHOT_SQL).toMatch(/^INSERT INTO odds_snapshots /);
    expect(INSERT_ODDS_SNAPSHOT_SQL).toContain("ON CONFLICT (race_id, lead_min) DO NOTHING");
    expect(INSERT_ODDS_SNAPSHOT_SQL).not.toMatch(/\b(UPDATE|DELETE|REPLACE)\b/i);
  });
  it("1 レースの保存で書き込む行は 1 行(主キーだけの WITHOUT ROWID の表。副索引なし)", async () => {
    const result = await local.db.prepare(INSERT_ODDS_SNAPSHOT_SQL).bind(ok.raceId, ok.leadMin, ok.kaisaiDate, ok.startMs, ok.dueMs, ok.takenAtMs, ok.officialDatetime, ok.oddsStatus, ok.status, ok.reason, ok.attempts, JSON.stringify(ok.horses)).run();
    expect(result.meta.changes).toBe(1);
    expect(result.meta.rows_written).toBe(1);
  });
});
