import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSaveResultStatements, buildWinOddsStatement, D1ResultStore, type ResultDb } from "../src/result-repository";
import type { RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import { toResultEntries } from "../../packages/core/src/ev/result-import";
import { parseRaceResult } from "../../packages/core/src/scraper/parse-race-result";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #259(前半): 確定の単勝オッズ・人気(`race_results.win_odds`・`ninki`。migration 0011。D1 専用の列)の保存。
 *  - 新規の取り込み(`saveResult`)は、UPSERT の後に **6 文目**(`UPDATE … FROM json_each`)でこの 2 列を埋める(オッズを持つ馬が 1 頭でもいるときだけ。無ければ従来の文の数のまま)
 *  - 過去分の補完(`saveWinOdds`)は、**この 1 文だけ**を発行する。他の列・組合せ払戻・面には触れない。NULL の列だけを埋めるので、2 回目は何も書かない
 */

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

const store = (db: ResultDb = local.db): D1ResultStore => new D1ResultStore({ db });
const loadFixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), "utf-8");

/** prepare → bind された文の SQL と束縛値の個数を、発行の順に記録する窓口(本物の D1 に転送する)。 */
function spyDb(): { db: ResultDb; calls: Array<{ sql: string; binds: number }> } {
  const calls: Array<{ sql: string; binds: number }> = [];
  const db: ResultDb = {
    prepare: (sql: string) => {
      const real = local.db.prepare(sql);
      return {
        bind: (...args: unknown[]) => {
          calls.push({ sql, binds: args.length });
          return real.bind(...args);
        },
      } as unknown as D1PreparedStatement;
    },
    batch: (stmts) => local.db.batch(stmts),
  };
  return { db, calls };
}

/** race_results の全列(新しい列を含む)。 */
async function rows(raceId?: string): Promise<Array<Record<string, unknown>>> {
  const sql = "SELECT * FROM race_results" + (raceId === undefined ? "" : " WHERE race_id = ?") + " ORDER BY race_id, umaban";
  const stmt = local.db.prepare(sql);
  return (await (raceId === undefined ? stmt : stmt.bind(raceId)).all()).results as Array<Record<string, unknown>>;
}

/** 4 表すべての全列のダンプ(補完が触らないことの比較用)。 */
async function dumpAllExceptOdds(): Promise<unknown> {
  const out: Record<string, unknown> = {};
  out["race_results"] = (
    await local.db.prepare("SELECT race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f FROM race_results ORDER BY race_id, umaban").all()
  ).results;
  for (const t of ["race_result_meta", "race_combo_payouts", "race_combo_payout_imports"]) {
    out[t] = (await local.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results;
  }
  return out;
}

const ENTRIES: RaceResultEntry[] = [
  { umaban: 1, finishPosition: 2, placePayout: 150, winPayout: null, passing: [2, 2], last3f: 34.1, winOdds: 4.5, ninki: 2 },
  { umaban: 2, finishPosition: 1, placePayout: 120, winPayout: 340, passing: [1, 1], last3f: 33.8, winOdds: 3.4, ninki: 1 },
  { umaban: 3, finishPosition: null, placePayout: null, winPayout: null, passing: [], last3f: null, winOdds: null, ninki: null }, // 除外
];

describe("migration 0011: race_results に D1 専用の列 win_odds・ninki", () => {
  it("win_odds は REAL・ninki は INTEGER で、どちらも NULL 可・既定値なし。既存の列は 7 つのまま", async () => {
    const cols = (await local.db.prepare("PRAGMA table_info(race_results)").all()).results as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
    expect(cols.map((c) => c.name)).toEqual(["race_id", "umaban", "finish_position", "place_payout", "win_payout", "passing_json", "last3f", "win_odds", "ninki"]);
    expect(cols.find((c) => c.name === "win_odds")).toMatchObject({ type: "REAL", notnull: 0, dflt_value: null, pk: 0 });
    expect(cols.find((c) => c.name === "ninki")).toMatchObject({ type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 });
  });

  it("既存の行(2 列を知らない書き方の INSERT)は NULL のまま(migration は既存の行を埋めない)", async () => {
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position) VALUES ('202603020211', 1, 1)").run();
    expect(await rows()).toEqual([expect.objectContaining({ win_odds: null, ninki: null })]);
  });
});

describe("saveResult: 取り込みと同時に確定オッズ・人気を保存する(6 文目)", () => {
  it("オッズを持つ馬がいれば、馬の UPSERT の直後に UPDATE が 1 文足される(順序: UPSERT → オッズ UPDATE → 面)。どの文のバインドも 2 個以内。除外の馬は null のまま", async () => {
    const spy = spyDb();
    await store(spy.db).saveResult("202603020211", ENTRIES, "芝");
    expect(spy.calls.map((c) => /^\s*(INSERT INTO|UPDATE)\s+(\w+)/.exec(c.sql)!.slice(1, 3).join(" "))).toEqual(["INSERT INTO race_results", "UPDATE race_results", "INSERT INTO race_result_meta"]);
    expect(Math.max(...spy.calls.map((c) => c.binds))).toBeLessThanOrEqual(2);
    expect((await rows("202603020211")).map((r) => [r["umaban"], r["win_odds"], r["ninki"]])).toEqual([
      [1, 4.5, 2],
      [2, 3.4, 1],
      [3, null, null],
    ]);
  });

  it("全券種つきでも文は 6 文(組合せの DELETE・INSERT・マーカー + 馬 + オッズ + 面)。従来の 5 文に 1 文足しただけ", () => {
    const combos = {
      wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 300 }] },
    } as const;
    const withOdds = buildSaveResultStatements(local.db, "202603020211", ENTRIES, "芝", combos);
    const withoutOdds = buildSaveResultStatements(local.db, "202603020211", ENTRIES.map(({ winOdds: _o, ninki: _n, ...rest }) => rest), "芝", combos);
    expect(withoutOdds).toHaveLength(5);
    expect(withOdds).toHaveLength(6);
  });

  it("オッズを持つ馬がいない取り込み(旧い形・全頭が欠損)は、従来どおりオッズの文を発行しない", () => {
    const none = ENTRIES.map(({ winOdds: _o, ninki: _n, ...rest }) => rest);
    expect(buildSaveResultStatements(local.db, "202603020211", none, "芝")).toHaveLength(2);
    expect(buildSaveResultStatements(local.db, "202603020211", ENTRIES.map((e) => ({ ...e, winOdds: null, ninki: null })), "芝")).toHaveLength(2);
  });

  it("再取り込み(オッズなしの入力)で、保存済みのオッズ・人気は消えない。他の列は従来どおり上書きされる", async () => {
    await store().saveResult("202603020211", ENTRIES, "芝");
    const reimport = ENTRIES.map(({ winOdds: _o, ninki: _n, ...rest }) => ({ ...rest, last3f: 99 }));
    await store().saveResult("202603020211", reimport, "芝");
    const after = await rows("202603020211");
    expect(after.map((r) => [r["umaban"], r["win_odds"], r["ninki"], r["last3f"]])).toEqual([
      [1, 4.5, 2, 99],
      [2, 3.4, 1, 99],
      [3, null, null, 99],
    ]);
  });

  it("再取り込みで、NULL だった列だけが埋まる(既に値のある列は上書きしない)", async () => {
    await store().saveResult("202603020211", [{ umaban: 1, finishPosition: 1, winOdds: 5.0, ninki: null }], null);
    await store().saveResult("202603020211", [{ umaban: 1, finishPosition: 1, winOdds: 9.9, ninki: 3 }], null);
    expect((await rows("202603020211"))[0]).toMatchObject({ win_odds: 5.0, ninki: 3 });
  });

  it("実フィクスチャ(除外あり result_202605040205): パース → 変換 → 保存で、除外の馬(10)だけ NULL、勝ち馬(7)は 3.1 倍・2 番人気", async () => {
    const parsed = parseRaceResult(loadFixture("result_202605040205.html"));
    await store().saveResult("202605040205", toResultEntries(parsed), parsed.courseType ?? null);
    const saved = await rows("202605040205");
    expect(saved).toHaveLength(12);
    expect(saved.filter((r) => r["win_odds"] === null).map((r) => r["umaban"])).toEqual([10]);
    expect(saved.find((r) => r["umaban"] === 7)).toMatchObject({ win_odds: 3.1, ninki: 2, win_payout: 310 });
  });
});

describe("saveWinOdds: 過去分の補完(オッズ・人気だけを、NULL の列に限って埋める)", () => {
  async function seedOldResult(): Promise<void> {
    // 補完の対象 = オッズの列を知らなかった頃に保存した結果(7 列 + 面 + 組合せ払戻 + 取込印)。
    await store().saveResult(
      "202603020211",
      [
        { umaban: 1, finishPosition: 2, placePayout: 150, winPayout: null, passing: [2, 2], last3f: 34.1 },
        { umaban: 2, finishPosition: 1, placePayout: 120, winPayout: 340, passing: [1, 1], last3f: 33.8 },
        { umaban: 3, finishPosition: null, placePayout: null, winPayout: null, passing: [], last3f: null },
      ],
      "芝",
      { wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 300 }] }, quinella: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 560 }] } },
    );
  }

  it("前提(空振り防止): 補完前のダンプは空でなく、組合せ払戻・取込印・面を含む", async () => {
    await seedOldResult();
    const before = (await dumpAllExceptOdds()) as Record<string, unknown[]>;
    expect(before["race_results"]).toHaveLength(3);
    expect(before["race_combo_payouts"]).toHaveLength(2);
    expect(before["race_combo_payout_imports"]).toHaveLength(2);
    expect(before["race_result_meta"]).toHaveLength(1);
    expect((await rows()).every((r) => r["win_odds"] === null && r["ninki"] === null)).toBe(true);
  });

  it("オッズ・人気だけが埋まる: 他の 7 列・面・組合せ払戻・取込印は 1 バイトも変わらない(入力の着順・払戻が違っていても上書きしない)", async () => {
    await seedOldResult();
    const before = await dumpAllExceptOdds();
    // 補完に渡す入力は、わざと保存済みと異なる着順・払戻・通過順にする(補完が UPSERT だと、ここで差が出る)。
    const hostile = ENTRIES.map((e) => ({ ...e, finishPosition: 99, placePayout: 9999, winPayout: 8888, passing: [9, 9, 9], last3f: 11.1 }));
    const outcome = await store().saveWinOdds("202603020211", hostile);
    expect(await dumpAllExceptOdds()).toStrictEqual(before);
    expect((await rows("202603020211")).map((r) => [r["umaban"], r["win_odds"], r["ninki"]])).toEqual([
      [1, 4.5, 2],
      [2, 3.4, 1],
      [3, null, null],
    ]);
    expect(outcome.rowsWritten).toBeGreaterThan(0);
  });

  it("2 回目(同じ入力・別の値の入力とも)は何も書かない: 行は変わらず、rows_written は 0", async () => {
    await seedOldResult();
    await store().saveWinOdds("202603020211", ENTRIES);
    const afterFirst = await rows();
    expect(afterFirst.filter((r) => r["win_odds"] !== null)).toHaveLength(2); // 前提: 1 回目で 2 頭が埋まった
    expect((await store().saveWinOdds("202603020211", ENTRIES)).rowsWritten).toBe(0);
    // 別の値(値のある馬 1・2 だけ。値の無かった馬 3 に値が来たときは埋まるのが正しい=下のテスト)を渡しても、上書きしない。
    const different = ENTRIES.slice(0, 2).map((e) => ({ ...e, winOdds: 77.7, ninki: 9 }));
    expect((await store().saveWinOdds("202603020211", different)).rowsWritten).toBe(0);
    expect(await rows()).toStrictEqual(afterFirst);
  });

  it("NULL だった馬(除外など)に、後から値が来たら埋まる(NULL の列を埋めるのが目的。値のある馬は変わらない)", async () => {
    await seedOldResult();
    await store().saveWinOdds("202603020211", ENTRIES);
    const late = await store().saveWinOdds("202603020211", [{ umaban: 3, finishPosition: null, winOdds: 12.3, ninki: 7 }]);
    expect(late.rowsWritten).toBeGreaterThan(0);
    expect((await rows("202603020211")).map((r) => [r["umaban"], r["win_odds"], r["ninki"]])).toEqual([
      [1, 4.5, 2],
      [2, 3.4, 1],
      [3, 12.3, 7],
    ]);
  });

  it("別のレースの行には触れない(race_id で絞る)。結果の行が無いレースを渡しても何も作らない", async () => {
    await seedOldResult();
    await store().saveResult("202603020212", [{ umaban: 1, finishPosition: 1 }], null);
    await store().saveWinOdds("202603020211", ENTRIES);
    expect((await rows("202603020212"))[0]).toMatchObject({ win_odds: null, ninki: null });
    const before = await rows();
    await store().saveWinOdds("202699999999", ENTRIES);
    expect(await rows()).toStrictEqual(before);
  });

  it("ページに無い馬(結果の行にある馬が入力に無い)は NULL のまま、結果の行に無い馬番の入力は行を作らない", async () => {
    await seedOldResult();
    await store().saveWinOdds("202603020211", [
      { umaban: 2, finishPosition: 1, winOdds: 3.4, ninki: 1 },
      { umaban: 18, finishPosition: 5, winOdds: 50.0, ninki: 12 },
    ]);
    expect((await rows("202603020211")).map((r) => [r["umaban"], r["win_odds"], r["ninki"]])).toEqual([
      [1, null, null],
      [2, 3.4, 1],
      [3, null, null],
    ]);
  });

  it("片方だけ取れた馬(オッズあり・人気なし)は、その列だけ埋まる。後から人気だけが取れたら、人気だけが足される", async () => {
    await seedOldResult();
    await store().saveWinOdds("202603020211", [{ umaban: 1, finishPosition: 2, winOdds: 4.5, ninki: null }]);
    expect((await rows("202603020211"))[0]).toMatchObject({ win_odds: 4.5, ninki: null });
    const second = await store().saveWinOdds("202603020211", [{ umaban: 1, finishPosition: 2, winOdds: 8.8, ninki: 2 }]);
    expect((await rows("202603020211"))[0]).toMatchObject({ win_odds: 4.5, ninki: 2 });
    expect(second.rowsWritten).toBeGreaterThan(0);
  });

  it("書くものが無い入力(オッズも人気も全馬 null / 空配列)は D1 に何も発行しない", async () => {
    const calls: string[] = [];
    const spy: ResultDb = {
      prepare: (sql: string) => {
        calls.push(sql);
        return local.db.prepare(sql);
      },
      batch: (async (stmts: D1PreparedStatement[]) => {
        calls.push(`batch:${stmts.length}`);
        return local.db.batch(stmts);
      }) as ResultDb["batch"],
    };
    expect(await store(spy).saveWinOdds("202603020211", [])).toEqual({ rowsWritten: 0 });
    expect(await store(spy).saveWinOdds("202603020211", [{ umaban: 1, finishPosition: 1, winOdds: null, ninki: null }, { umaban: 2, finishPosition: 2 }])).toEqual({ rowsWritten: 0 });
    expect(calls).toEqual([]);
    expect(buildWinOddsStatement(local.db, "202603020211", [])).toBeNull();
  });

  it("文は 1 つで、バインドは 2 個(JSON 1 つと race_id)。18 頭でも上限(100)に届かない(馬を 1 行ずつ束縛しない)", async () => {
    const eighteen: RaceResultEntry[] = Array.from({ length: 18 }, (_, i) => ({ umaban: i + 1, finishPosition: i + 1, winOdds: 2 + i, ninki: i + 1 }));
    await store().saveResult("202603020211", eighteen.map(({ winOdds: _o, ninki: _n, ...rest }) => rest), null);
    const spy = spyDb();
    await store(spy.db).saveWinOdds("202603020211", eighteen);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.binds).toBe(2);
    expect((await rows("202603020211")).filter((r) => r["win_odds"] !== null)).toHaveLength(18);
  });

  it("実フィクスチャ(3 着同着 result_202608040204): 補完で全 16 頭が埋まり、同着の 2 頭は別々の値を持つ", async () => {
    const parsed = parseRaceResult(loadFixture("result_202608040204.html"));
    // 旧い取り込み = オッズの列を知らない入力で保存する。
    const old = toResultEntries(parsed).map(({ winOdds: _o, ninki: _n, ...rest }) => rest);
    await store().saveResult("202608040204", old, parsed.courseType ?? null);
    expect((await rows("202608040204")).every((r) => r["win_odds"] === null)).toBe(true);
    await store().saveWinOdds("202608040204", toResultEntries(parsed));
    const saved = await rows("202608040204");
    expect(saved).toHaveLength(16);
    expect(saved.every((r) => r["win_odds"] !== null && r["ninki"] !== null)).toBe(true);
    expect(saved.filter((r) => r["finish_position"] === 3).map((r) => [r["umaban"], r["win_odds"], r["ninki"]])).toEqual([
      [3, 37.8, 9],
      [9, 21.3, 5],
    ]);
  });
});
