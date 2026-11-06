import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { KaisaiDayRow } from "../../packages/core/src/analyzer/turf-wear";
import { D1KaisaiDaysStore, LOAD_SQL, RECORD_SQL } from "../src/kaisai-days-repository";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #519: 開催日ごとの記録 `kaisai_days` の書き込み(先着の柵・開催日を上書きしない)と読み出し(開催年とその前の年・開催日より前)。
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

const row = (over: Partial<KaisaiDayRow> = {}): KaisaiDayRow => ({ trackCode: "06", year: 2026, kai: 3, nichi: 2, kaisaiDate: "20260329", fence: "C", ...over });
const rowsOf = async (): Promise<unknown[]> => (await local.db.prepare("SELECT track_code, year, kai, nichi, kaisai_date, fence FROM kaisai_days ORDER BY track_code, year, kai, nichi").all()).results;
/** RECORD_SQL を直接流して、変更行数(rows_written の目安)を見る。 */
const changesOf = async (r: KaisaiDayRow): Promise<number> =>
  (await local.db.prepare(RECORD_SQL).bind(r.trackCode, r.year, r.kai, r.nichi, r.kaisaiDate, r.fence).run()).meta.changes;

describe("record(先着の柵。開催日は上書きしない)", () => {
  it("新しい行は 1 行入る。値が列に正しく入る", async () => {
    await new D1KaisaiDaysStore({ db: local.db }).record(row());
    expect(await rowsOf()).toEqual([{ track_code: "06", year: 2026, kai: 3, nichi: 2, kaisai_date: "20260329", fence: "C" }]);
  });

  it("同じ (場, 年, 回, 日次) を何度書いても 1 行。同じ値の再書き込みは行を書かない(changes = 0)", async () => {
    expect(await changesOf(row())).toBe(1);
    expect(await changesOf(row())).toBe(0);
    expect(await changesOf(row())).toBe(0);
    expect(await rowsOf()).toHaveLength(1);
  });

  it("柵が NULL の行は、後から来た柵で埋まる(changes = 1)。開催日は変わらない", async () => {
    expect(await changesOf(row({ fence: null }))).toBe(1);
    expect(await changesOf(row({ fence: "C", kaisaiDate: "20260330" }))).toBe(1);
    expect(await rowsOf()).toEqual([{ track_code: "06", year: 2026, kai: 3, nichi: 2, kaisai_date: "20260329", fence: "C" }]);
  });

  it("既に入っている柵は、別の柵でも NULL でも上書きしない・消さない(changes = 0)。開催日も変えない", async () => {
    expect(await changesOf(row({ fence: "C" }))).toBe(1);
    expect(await changesOf(row({ fence: "D", kaisaiDate: "20260330" }))).toBe(0);
    expect(await changesOf(row({ fence: null, kaisaiDate: "20260331" }))).toBe(0);
    expect(await rowsOf()).toEqual([{ track_code: "06", year: 2026, kai: 3, nichi: 2, kaisai_date: "20260329", fence: "C" }]);
  });

  it("NULL を NULL で書き直しても行は増えない・変わらない(changes = 0)", async () => {
    expect(await changesOf(row({ fence: null }))).toBe(1);
    expect(await changesOf(row({ fence: null }))).toBe(0);
    expect(await rowsOf()).toHaveLength(1);
  });

  it("場・年・回・日次のどれが違っても別の行になる", async () => {
    const store = new D1KaisaiDaysStore({ db: local.db });
    await store.record(row());
    await store.record(row({ trackCode: "05" }));
    await store.record(row({ year: 2025 }));
    await store.record(row({ kai: 4 }));
    await store.record(row({ nichi: 3 }));
    expect(await rowsOf()).toHaveLength(5);
  });
});

describe("load(開催年とその前の年・開催日より前・その場だけ)", () => {
  it("別の場・2 年前・開催日以降(今日を含む)の行は返さない。返す行は列の型に直す(柵なしは null)", async () => {
    const store = new D1KaisaiDaysStore({ db: local.db });
    const keep = [row({ nichi: 1, kaisaiDate: "20260328" }), row({ year: 2025, kai: 5, nichi: 8, kaisaiDate: "20251228", fence: null })];
    for (const r of [
      ...keep,
      row({ trackCode: "05", nichi: 1, kaisaiDate: "20260328" }), // 別の場
      row({ year: 2024, kai: 5, nichi: 8, kaisaiDate: "20241229" }), // 2 年前(開催年 − 1 より前)
      row({ nichi: 2, kaisaiDate: "20260329" }), // 今日
      row({ nichi: 3, kaisaiDate: "20260404" }), // 明日以降
    ]) {
      await store.record(r);
    }
    const got = [...(await store.load("06", "20260329"))].sort((a, b) => a.year - b.year);
    expect(got).toEqual([keep[1], keep[0]]);
  });

  it("日数の窓で切らない: 3回東京(5/30〜6/21)は、104 日あいた 4回東京の初日 10/3 でも全 8 日が返る(窓にすると 3回の初日が外れて、前の回がそろっているか判定できない)", async () => {
    const store = new D1KaisaiDaysStore({ db: local.db });
    const dates = ["20260530", "20260531", "20260606", "20260607", "20260613", "20260614", "20260620", "20260621"];
    for (const [i, d] of dates.entries()) {
      await store.record(row({ trackCode: "05", kai: 3, nichi: i + 1, kaisaiDate: d, fence: "A" }));
    }
    const got = await store.load("05", "20261003");
    expect(got.map((r) => r.kaisaiDate).sort()).toEqual(dates);
    // 前提(窓にしたときの穴): 10/3 の 120 日前は 6/5 で、3回の 1・2 日目は窓の外になる。
    const cutoff = new Date(Date.UTC(2026, 9, 3) - 120 * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
    expect(cutoff).toBe("20260605");
    expect(dates.filter((d) => d < cutoff)).toEqual(["20260530", "20260531"]);
  });

  it("行が無ければ空配列", async () => {
    expect(await new D1KaisaiDaysStore({ db: local.db }).load("06", "20260329")).toEqual([]);
  });
});

describe("計画", () => {
  it("読み出しは主キーの先頭(場コード・年)で絞る(全表走査・一時索引ではない)", async () => {
    const plan = (await local.db.prepare(`EXPLAIN QUERY PLAN ${LOAD_SQL}`).bind("06", 2025, "20260329").all<{ detail: string }>()).results.map((r) => r.detail);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatch(/SEARCH kaisai_days USING (PRIMARY KEY|INDEX sqlite_autoindex_kaisai_days_1) \(track_code=\? AND year>\?\)/);
  });
});
