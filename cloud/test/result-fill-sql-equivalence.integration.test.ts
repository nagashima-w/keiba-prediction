import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildScratchedStatement, buildWinOddsStatement, buildWinPayoutStatement, FILL_SCRATCHED_SQL, FILL_WIN_ODDS_SQL, FILL_WIN_PAYOUT_SQL } from "../src/result-repository";
import type { RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import { finiteOrNull } from "../../packages/core/src/common/guards.js";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #615: 補完の UPDATE 3 文(`FILL_WIN_ODDS_SQL`・`FILL_SCRATCHED_SQL`・`FILL_WIN_PAYOUT_SQL`)を「馬番をキーにした JSON を束縛し `json_extract` で引く形」へ書き換えた。
 * 実行計画が「race_results を外側、json_each を内側」になり、馬の数の 2 乗で読んでいたため。書き込みの結果は変えない。
 * このファイルは、書き換え前の SQL(下の LEGACY_*)と新しい文を同じ初期状態に流し、書き換わる行・値・`rows_written` が一致することを固定する。
 */

const LEGACY_WIN_ODDS_SQL = `UPDATE race_results SET win_odds = COALESCE(race_results.win_odds, j.o), ninki = COALESCE(race_results.ninki, j.n)
           FROM (SELECT json_extract(value,'$[0]') AS u, json_extract(value,'$[1]') AS o, json_extract(value,'$[2]') AS n FROM json_each(?)) j
           WHERE race_results.race_id = ? AND race_results.umaban = j.u
             AND ((race_results.win_odds IS NULL AND j.o IS NOT NULL) OR (race_results.ninki IS NULL AND j.n IS NOT NULL))`;
const LEGACY_SCRATCHED_SQL = `UPDATE race_results SET scratched = j.s
           FROM (SELECT json_extract(value,'$[0]') AS u, json_extract(value,'$[1]') AS s FROM json_each(?)) j
           WHERE race_results.race_id = ? AND race_results.umaban = j.u
             AND race_results.scratched IS NULL AND race_results.finish_position IS NULL`;
const LEGACY_WIN_PAYOUT_SQL = `UPDATE race_results SET win_payout = j.p
           FROM (SELECT json_extract(value,'$[0]') AS u, json_extract(value,'$[1]') AS p FROM json_each(?)) j
           WHERE race_results.race_id = ? AND race_results.umaban = j.u
             AND race_results.win_payout IS NULL AND j.p IS NOT NULL`;

type Kind = "winOdds" | "scratched" | "winPayout";
type Builder = (db: D1Database, raceId: string, entries: readonly RaceResultEntry[]) => D1PreparedStatement | null;

/** 書き換え前の束縛値の作り方(各 build*Statement の旧版と同じ)。 */
function legacyStatement(kind: Kind, db: D1Database, raceId: string, results: readonly RaceResultEntry[]): D1PreparedStatement | null {
  if (kind === "winOdds") {
    const rows = results.map((r) => [r.umaban, finiteOrNull(r.winOdds), finiteOrNull(r.ninki)] as const).filter(([, o, n]) => o !== null || n !== null);
    return rows.length === 0 ? null : db.prepare(LEGACY_WIN_ODDS_SQL).bind(JSON.stringify(rows), raceId);
  }
  if (kind === "scratched") {
    return results.length === 0 ? null : db.prepare(LEGACY_SCRATCHED_SQL).bind(JSON.stringify(results.map((r) => [r.umaban, r.scratched === true ? 1 : 0])), raceId);
  }
  const rows = results.map((r) => [r.umaban, finiteOrNull(r.winPayout)] as const).filter(([, p]) => p !== null);
  return rows.length === 0 ? null : db.prepare(LEGACY_WIN_PAYOUT_SQL).bind(JSON.stringify(rows), raceId);
}
const BUILDERS: Record<Kind, Builder> = {
  winOdds: buildWinOddsStatement as Builder,
  scratched: buildScratchedStatement as Builder,
  winPayout: buildWinPayoutStatement as Builder,
};

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

interface SeedRow {
  readonly umaban: number;
  readonly finish: number | null;
  readonly odds?: number | null;
  readonly ninki?: number | null;
  readonly scratched?: number | null;
  readonly payout?: number | null;
}

async function seed(raceId: string, rows: readonly SeedRow[]): Promise<void> {
  for (const r of rows) {
    await local.db
      .prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_odds, ninki, scratched, win_payout) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(raceId, r.umaban, r.finish, r.odds ?? null, r.ninki ?? null, r.scratched ?? null, r.payout ?? null)
      .run();
  }
}
async function dump(raceId: string): Promise<unknown[]> {
  const res = await local.db.prepare("SELECT umaban, finish_position, win_odds, ninki, scratched, win_payout FROM race_results WHERE race_id = ? ORDER BY umaban").bind(raceId).all();
  return res.results;
}
const entry = (umaban: number, over: Partial<RaceResultEntry> = {}): RaceResultEntry => ({ umaban, finishPosition: null, ...over }) as unknown as RaceResultEntry;

/** 同じ初期状態を別々のレース ID に作り、旧い文と新しい文を流して、行の値と rows_written を比べる。 */
async function expectSame(kind: Kind, rows: readonly SeedRow[], entries: readonly RaceResultEntry[]): Promise<{ changed: number }> {
  await seed("LEGACY", rows);
  await seed("NEWFORM", rows);
  const before = JSON.stringify(await dump("NEWFORM"));
  const old = legacyStatement(kind, local.db, "LEGACY", entries);
  const neu = BUILDERS[kind](local.db, "NEWFORM", entries);
  expect(neu === null).toBe(old === null); // 入力が空のとき、今は D1 に何も発行しない(null)ことも同じ
  if (old === null || neu === null) {
    return { changed: 0 };
  }
  const [a] = await local.db.batch([old]);
  const [b] = await local.db.batch([neu]);
  expect(await dump("NEWFORM")).toEqual(await dump("LEGACY"));
  expect(b?.meta.rows_written).toBe(a?.meta.rows_written);
  const changed = JSON.stringify(await dump("NEWFORM")) === before ? 0 : 1;
  return { changed };
}

describe("補完の UPDATE: 旧い SQL との同値(書き換わる行・値・rows_written)", () => {
  it("単勝オッズ・人気: COALESCE で既存値を残す・入力に無い馬と DB に無い馬番は触らない・オッズだけ/人気だけ/両方 null/NaN", async () => {
    const rows: SeedRow[] = [
      { umaban: 1, finish: 1 }, // 両方 NULL → 両方埋まる
      { umaban: 2, finish: 2, odds: 9.9 }, // オッズは既存 → 残す。人気だけ埋まる
      { umaban: 3, finish: 3, ninki: 7 }, // 人気は既存 → 残す。オッズだけ埋まる
      { umaban: 4, finish: 4, odds: 5, ninki: 5 }, // 両方既存 → 行は書き換わらない
      { umaban: 5, finish: 5 }, // オッズだけ入力(人気なし)
      { umaban: 6, finish: 6 }, // 人気だけ入力(オッズなし)
      { umaban: 7, finish: 7 }, // 両方 null の入力 → 触らない
      { umaban: 8, finish: 8 }, // 入力に無い → 触らない
      { umaban: 9, finish: null }, // NaN の入力 → null 扱いで触らない
    ];
    const entries = [
      entry(1, { winOdds: 3.4, ninki: 1 }),
      entry(2, { winOdds: 1.1, ninki: 2 }),
      entry(3, { winOdds: 8.8, ninki: 3 }),
      entry(4, { winOdds: 1.5, ninki: 1 }),
      entry(5, { winOdds: 12.3 }),
      entry(6, { ninki: 4 }),
      entry(7, { winOdds: null, ninki: null }),
      entry(9, { winOdds: Number.NaN, ninki: Number.NaN }),
      entry(99, { winOdds: 2.2, ninki: 1 }), // DB に無い馬番 → 行を作らない
    ];
    const { changed } = await expectSame("winOdds", rows, entries);
    expect(changed).toBe(1); // 空振り防止: 実際に書き換わる行がある
    const after = (await dump("NEWFORM")) as Array<Record<string, unknown>>;
    expect(after.find((r) => r["umaban"] === 2)).toMatchObject({ win_odds: 9.9, ninki: 2 });
    expect(after.find((r) => r["umaban"] === 4)).toMatchObject({ win_odds: 5, ninki: 5 });
    expect(after.find((r) => r["umaban"] === 8)).toMatchObject({ win_odds: null, ninki: null });
    expect(after).toHaveLength(rows.length);
  });

  it("取消・除外: scratched IS NULL かつ finish_position IS NULL の行にだけ 0/1 を書く(記録済み・着順ありは据え置き、入力に無い馬は触らない)", async () => {
    const rows: SeedRow[] = [
      { umaban: 1, finish: null }, // 対象(取消 → 1)
      { umaban: 2, finish: null }, // 対象(印なし → 0)
      { umaban: 3, finish: null, scratched: 0 }, // 記録済み → 据え置き
      { umaban: 4, finish: 1 }, // 着順あり → 書かない
      { umaban: 5, finish: null }, // 入力に無い → 触らない
    ];
    const entries = [entry(1, { scratched: true }), entry(2), entry(3, { scratched: true }), entry(4, { scratched: true }), entry(99, { scratched: true })];
    const { changed } = await expectSame("scratched", rows, entries);
    expect(changed).toBe(1);
    const after = (await dump("NEWFORM")) as Array<Record<string, unknown>>;
    expect(after.map((r) => r["scratched"])).toEqual([1, 0, 0, null, null]);
  });

  it("単勝の払戻: win_payout が NULL の行に、入力の払戻が non-null のときだけ書く(既存は上書きしない・同着は別々の額・NaN は書かない)", async () => {
    const rows: SeedRow[] = [
      { umaban: 1, finish: 1 },
      { umaban: 2, finish: 1 }, // 同着
      { umaban: 3, finish: 3, payout: 120 }, // 既存 → 残す
      { umaban: 4, finish: 4 }, // 入力に払戻なし
      { umaban: 5, finish: 5 }, // NaN
      { umaban: 6, finish: 6 }, // 入力に無い
    ];
    const entries = [entry(1, { winPayout: 340 }), entry(2, { winPayout: 410 }), entry(3, { winPayout: 999 }), entry(4), entry(5, { winPayout: Number.NaN }), entry(99, { winPayout: 100 })];
    const { changed } = await expectSame("winPayout", rows, entries);
    expect(changed).toBe(1);
    const after = (await dump("NEWFORM")) as Array<Record<string, unknown>>;
    expect(after.map((r) => r["win_payout"])).toEqual([340, 410, 120, null, null, null]);
  });

  it.each(["winOdds", "scratched", "winPayout"] as const)("%s: 冪等(2 回目は書き込み 0 行)と、入力が空のとき null(D1 に何も発行しない)", async (kind) => {
    expect(BUILDERS[kind](local.db, "X", [])).toBeNull();
    const rows: SeedRow[] = [{ umaban: 1, finish: kind === "scratched" ? null : 1 }];
    await seed("NEWFORM", rows);
    const entries = [entry(1, { winOdds: 2, ninki: 1, scratched: true, winPayout: 200 })];
    const [first] = await local.db.batch([BUILDERS[kind](local.db, "NEWFORM", entries)!]);
    const [second] = await local.db.batch([BUILDERS[kind](local.db, "NEWFORM", entries)!]);
    expect(first?.meta.rows_written).toBe(1);
    expect(second?.meta.rows_written).toBe(0);
  });

  it("馬番が重複した入力(旧い SQL では不定。同値の対象外)。新しい形は後勝ち(最後の行)で書く", async () => {
    await seed("DUP", [{ umaban: 1, finish: 1 }]);
    const stmt = buildWinPayoutStatement(local.db, "DUP", [entry(1, { winPayout: 100 }), entry(1, { winPayout: 200 })])!;
    await local.db.batch([stmt]);
    expect(((await dump("DUP")) as Array<Record<string, unknown>>)[0]?.["win_payout"]).toBe(200);
  });
});

describe("補完の UPDATE: 実行計画と読み取り行数", () => {
  const HORSES = 14;
  const rows: SeedRow[] = Array.from({ length: HORSES }, (_, i) => ({ umaban: i + 1, finish: null }));
  const entries = Array.from({ length: HORSES }, (_, i) => entry(i + 1, { winOdds: 2 + i, ninki: i + 1, scratched: true, winPayout: 100 + i }));


  it.each(["winOdds", "scratched", "winPayout"] as const)("%s: 旧い形は馬の数の 2 乗で読み、新しい形は race_id の索引で 1 レース分(馬の数)だけ読む", async (kind) => {
    await seed("LEGACY", rows);
    await seed("NEWFORM", rows);
    const [a] = await local.db.batch([legacyStatement(kind, local.db, "LEGACY", entries)!]);
    const [b] = await local.db.batch([BUILDERS[kind](local.db, "NEWFORM", entries)!]);
    const legacyRead = a?.meta.rows_read ?? 0;
    const newRead = b?.meta.rows_read ?? 0;
    // 前提(空振り防止): 旧い形が実際に 2 乗のぶん読んでいる
    expect(legacyRead).toBeGreaterThan(HORSES * HORSES);
    expect(newRead).toBeLessThan(legacyRead / 4);
    expect(newRead).toBeLessThanOrEqual(HORSES * 2 + 2); // 更新する馬の読み + 書き込みの検証の余裕
    expect(b?.meta.rows_written).toBe(a?.meta.rows_written);
  });
});

describe("補完の UPDATE: EXPLAIN QUERY PLAN", () => {
  it.each([
    ["FILL_WIN_ODDS_SQL", FILL_WIN_ODDS_SQL],
    ["FILL_SCRATCHED_SQL", FILL_SCRATCHED_SQL],
    ["FILL_WIN_PAYOUT_SQL", FILL_WIN_PAYOUT_SQL],
  ] as const)("%s: json_each との結合が無く、race_results を race_id の索引で引く", async (_name, sql) => {
    const plan = (await local.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind("{}", "R").all()).results as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail);
    expect(sql).not.toMatch(/json_each/);
    expect(details.some((d) => /json_each/i.test(d))).toBe(false);
    expect(details.some((d) => /SEARCH race_results USING (COVERING )?INDEX \S+ \(race_id=\?\)/.test(d))).toBe(true);
  });
});
