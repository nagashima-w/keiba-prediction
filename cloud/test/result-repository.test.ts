import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildSaveResultStatements,
  D1ResultStore,
  jsonEachDeleteSql,
  jsonEachInsertSelectSql,
  LIST_UNIMPORTED_BY_DAY_SQL,
  LIST_UNIMPORTED_SQL,
  UNIMPORTED_MAX_LIMIT,
  type ResultDb,
} from "../src/result-repository";
import type { RaceComboPayoutsSaveInput, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import { importRaceResult } from "../../packages/core/src/ev/result-import";
import { parseRaceId } from "../../packages/core/src/scraper/ids";
import { parseRaceResult } from "../../packages/core/src/scraper/parse-race-result";
import { resultContractCases, type ResultTablesDump } from "./result-contract";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #207(#182-A): D1ResultStore(結果の保存・復元・未取込の列挙)を、ローカル(workerd)の D1 で確かめる。
 *
 * ★限界(本番との差): ローカルの D1 は「1回の呼び出しで 50 クエリ」を強制しない(bind 100 個は強制する)。このため文の数は、記録した値で直接 assert している。
 *   浮動小数の丸め・SQLite のビルド差は、本番の最初の実保存で確かめる。**まだ production からは呼ばれない**(呼び出しは #208)。
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

/** D1 への発行(bind された文の SQL と束縛値の数・batch の文の数)を記録して、本物に転送する窓口。 */
function recordingDb(real: D1Database): { db: ResultDb; statements: Array<{ sql: string; binds: number }>; batches: number[]; reset: () => void } {
  const statements: Array<{ sql: string; binds: number }> = [];
  const batches: number[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = real.prepare(sql);
      return {
        bind(...args: unknown[]) {
          statements.push({ sql, binds: args.length });
          return stmt.bind(...args);
        },
        all: () => {
          statements.push({ sql, binds: 0 });
          return stmt.all();
        },
        first: () => {
          statements.push({ sql, binds: 0 });
          return stmt.first();
        },
        run: () => {
          statements.push({ sql, binds: 0 });
          return stmt.run();
        },
      };
    },
    batch(list: D1PreparedStatement[]) {
      batches.push(list.length);
      return real.batch(list);
    },
  } as unknown as ResultDb;
  return {
    db,
    statements,
    batches,
    reset: () => {
      statements.length = 0;
      batches.length = 0;
    },
  };
}

const DUMP_SQL = {
  race_results: "SELECT race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f FROM race_results ORDER BY race_id, umaban",
  race_result_meta: "SELECT race_id, course_type FROM race_result_meta ORDER BY race_id",
  race_combo_payouts: "SELECT race_id, bet_type, combo_key, payout FROM race_combo_payouts ORDER BY race_id, bet_type, combo_key",
  race_combo_payout_imports: "SELECT race_id, bet_type FROM race_combo_payout_imports ORDER BY race_id, bet_type",
} as const;

async function dump(): Promise<ResultTablesDump> {
  const out: Record<string, unknown[]> = {};
  for (const [table, sql] of Object.entries(DUMP_SQL)) {
    out[table] = (await local.db.prepare(sql).all()).results as unknown[];
  }
  return out as unknown as ResultTablesDump;
}

async function insertRaw(raw: NonNullable<(typeof resultContractCases)[number]["raw"]>): Promise<void> {
  for (const r of raw.race_results) {
    await local.db
      .prepare("INSERT INTO race_results (race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(r.race_id, r.umaban, r.finish_position, r.place_payout, r.win_payout, r.passing_json, r.last3f)
      .run();
  }
  for (const m of raw.race_result_meta) {
    await local.db.prepare("INSERT INTO race_result_meta (race_id, course_type) VALUES (?, ?)").bind(m.race_id, m.course_type).run();
  }
}

const UNDETERMINED = {
  state: "undetermined",
  reason: { kind: "payoutTableAbsent", message: "m", observedGroupCount: null, observedPayoutCount: null, rawHtml: null },
} as const;

describe("AC-A3: 共有 golden(exe の AnalysisStore.saveResult の4表のダンプ)と、D1 のダンプが同じ", () => {
  it("前提(空振り防止): golden は7ケースで、18頭のケースと、再保存のケース(3回の保存)を含む", () => {
    expect(resultContractCases).toHaveLength(7);
    expect(resultContractCases.find((c) => c.name === "synthetic-18-heads-all-bet-types")!.steps[0]!.entries).toHaveLength(18);
    expect(resultContractCases.find((c) => c.name === "resave-delete-then-insert-undetermined-keeps")!.steps).toHaveLength(3);
  });

  it.each(resultContractCases.map((c) => [c.name, c] as const))("4表のダンプ: %s", async (_name, c) => {
    if (c.raw !== undefined) {
      await insertRaw(c.raw);
    }
    for (const s of c.steps) {
      await store().saveResult(s.raceId, s.entries, s.courseType, s.comboPayouts);
    }
    expect(await dump()).toStrictEqual(c.expected);
  });

  it("前提(空振り防止): 全ケースの期待値のうち、少なくとも1表が空でないケースが6つ以上ある(ダンプの比較が空同士にならない)", () => {
    const nonEmpty = resultContractCases.filter((c) => Object.values(c.expected).some((rows) => rows.length > 0));
    expect(nonEmpty.length).toBeGreaterThanOrEqual(6);
  });
});

describe("AC-A3: 1回の batch・文の数は定数・バインドの上限(1文100)を超えない", () => {
  const eighteen = resultContractCases.find((c) => c.name === "synthetic-18-heads-all-bet-types")!.steps[0]!;

  it("前提: 18頭 × 7列 = 126 は、1文のバインドの上限(100)を超える(馬を1行ずつ束縛する設計はここで破綻する)", () => {
    expect(eighteen.entries.length * 7).toBeGreaterThan(100);
  });

  it("18頭・全6券種: batch は1回で5文(馬・面・組合せの DELETE・INSERT・マーカー)。どの文のバインドも2個以内", async () => {
    const rec = recordingDb(local.db);
    await store(rec.db).saveResult(eighteen.raceId, eighteen.entries, eighteen.courseType, eighteen.comboPayouts);
    expect(rec.batches).toEqual([5]);
    expect(rec.statements).toHaveLength(5);
    expect(Math.max(...rec.statements.map((s) => s.binds))).toBeLessThanOrEqual(2);
    expect((await dump()).race_results).toHaveLength(18);
  });

  it("文の数は馬・払戻の行数に依らない: 1頭・各券種1組の保存も、18頭・全券種の保存と同じ5文", async () => {
    const rec = recordingDb(local.db);
    await store(rec.db).saveResult(
      "202603020211",
      [{ umaban: 1, finishPosition: 1 }],
      "芝",
      {
        wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 100 }] },
        trifecta: { state: "parsed", payouts: [{ umabans: [1, 2, 3], payout: 100 }] },
      },
    );
    expect(rec.batches).toEqual([5]);
  });

  it("面なし・組合せなし(最小): 馬の1文だけの batch。何も渡さない(馬も面も組合せも無い)ときは batch を呼ばない", async () => {
    const rec = recordingDb(local.db);
    await store(rec.db).saveResult("202603020211", [{ umaban: 1, finishPosition: 1 }]);
    expect(rec.batches).toEqual([1]);
    rec.reset();
    await store(rec.db).saveResult("202603020211", [], null, {});
    expect(rec.batches).toEqual([]);
    expect(rec.statements).toEqual([]);
  });

  it("面あり・組合せなし: 2文(馬・面)", async () => {
    const rec = recordingDb(local.db);
    await store(rec.db).saveResult("202603020211", [{ umaban: 1, finishPosition: 1 }], "ダ");
    expect(rec.batches).toEqual([2]);
  });

  it("払戻が全券種で0件(マーカーだけ): DELETE とマーカーの2文で、払戻の INSERT 文は発行しない", async () => {
    const rec = recordingDb(local.db);
    await store(rec.db).saveResult("202603020211", [{ umaban: 1, finishPosition: 1 }], null, {
      wide: { state: "parsed", payouts: [] },
      trio: { state: "parsed", payouts: [] },
    });
    expect(rec.batches).toEqual([3]); // 馬 + DELETE + マーカー
    expect(rec.statements.some((s) => /INSERT INTO race_combo_payouts/.test(s.sql))).toBe(false);
  });

  it("buildSaveResultStatements は D1 に何も発行しない(文を組み立てるだけ)", () => {
    const rec = recordingDb(local.db);
    const statements = buildSaveResultStatements(rec.db, eighteen.raceId, eighteen.entries, eighteen.courseType, eighteen.comboPayouts);
    expect(statements).toHaveLength(5);
    expect(rec.batches).toEqual([]);
  });
});

describe("AC-A4: undetermined は既存の行・マーカーに触れない。parsed で払戻0件はマーカーだけ", () => {
  const saved: RaceComboPayoutsSaveInput = {
    wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 300 }, { umabans: [1, 3], payout: 500 }] },
    trio: { state: "parsed", payouts: [{ umabans: [1, 2, 3], payout: 2100 }] },
  };

  it("undetermined の券種(wide・trio)で再保存しても、その券種の行もマーカーも変わらない(着順は上書きされる)", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 2 }], "芝", saved);
    const before = await dump();
    expect(before.race_combo_payouts).toHaveLength(3);
    expect(before.race_combo_payout_imports).toHaveLength(2);
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], "芝", { wide: UNDETERMINED, trio: UNDETERMINED });
    const after = await dump();
    expect(after.race_combo_payouts).toStrictEqual(before.race_combo_payouts);
    expect(after.race_combo_payout_imports).toStrictEqual(before.race_combo_payout_imports);
    expect(after.race_results[0]!.finish_position).toBe(1);
  });

  it("初回から undetermined なら、行もマーカーも作らない(not_imported のまま)", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, { wide: UNDETERMINED });
    const d = await dump();
    expect(d.race_results).toHaveLength(1);
    expect(d.race_combo_payouts).toEqual([]);
    expect(d.race_combo_payout_imports).toEqual([]);
  });

  it("parsed で payouts が空: 既存の行を消してマーカーだけを書く(未発売と未取込を区別する)。他の券種は無傷", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, saved);
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, { wide: { state: "parsed", payouts: [] } });
    const d = await dump();
    expect(d.race_combo_payouts.map((r) => r.bet_type)).toEqual(["trio"]);
    expect(d.race_combo_payout_imports.map((r) => r.bet_type)).toEqual(["trio", "wide"]);
  });

  it("parsed で payouts が空・初回: 行は無く、マーカーだけがある", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, { quinella: { state: "parsed", payouts: [] } });
    const d = await dump();
    expect(d.race_combo_payouts).toEqual([]);
    expect(d.race_combo_payout_imports).toEqual([{ race_id: "R1", bet_type: "quinella" }]);
  });

  it("券種の省略・comboPayouts の省略は、組合せ払戻に触れない", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, saved);
    const before = await dump();
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {});
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
    const after = await dump();
    expect(after.race_combo_payouts).toStrictEqual(before.race_combo_payouts);
    expect(after.race_combo_payout_imports).toStrictEqual(before.race_combo_payout_imports);
  });

  it("再保存で組数が減っても孤児行を残さない(delete-then-insert)。別レースの同じ券種は無傷", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, saved);
    await store().saveResult("R2", [{ umaban: 1, finishPosition: 1 }], null, saved);
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null, {
      wide: { state: "parsed", payouts: [{ umabans: [4, 5], payout: 999 }] },
    });
    const d = await dump();
    expect(d.race_combo_payouts.filter((r) => r.race_id === "R1" && r.bet_type === "wide")).toEqual([
      { race_id: "R1", bet_type: "wide", combo_key: "0405", payout: 999 },
    ]);
    expect(d.race_combo_payouts.filter((r) => r.race_id === "R2" && r.bet_type === "wide")).toHaveLength(2);
  });
});

describe("保存の原子性・UPSERT の意味", () => {
  it("組合せ払戻に同じキーが2件あると PRIMARY KEY 違反で保存全体が失敗し、着順も書かれない(exe の db.transaction と同じ。既存の行は無傷)", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 3 }], "芝", { wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 300 }] } });
    const before = await dump();
    await expect(
      store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }, { umaban: 2, finishPosition: 2 }], "ダ", {
        wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 300 }, { umabans: [2, 1], payout: 400 }] },
      }),
    ).rejects.toThrow();
    expect(await dump()).toStrictEqual(before);
  });

  it("同じレースの再保存は馬ごとに上書きする(2回目に無い馬は据え置き。exe と同じ)。面も上書き", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1, placePayout: 120 }, { umaban: 2, finishPosition: 2 }], "芝");
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 2 }], "ダ");
    const d = await dump();
    expect(d.race_results.map((r) => [r.umaban, r.finish_position, r.place_payout])).toEqual([
      [1, 2, null],
      [2, 2, null],
    ]);
    expect(d.race_result_meta).toEqual([{ race_id: "R1", course_type: "ダ" }]);
  });

  it("同じ馬番が1回の入力に2回あれば、後のものが残る(exe の逐次 UPSERT と同じ)", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 5 }, { umaban: 1, finishPosition: 2 }]);
    expect((await dump()).race_results.map((r) => [r.umaban, r.finish_position])).toEqual([[1, 2]]);
  });

  it("面が null・省略なら race_result_meta に行を作らない。既にある行も消さない", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], "障");
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], null);
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }]);
    expect((await dump()).race_result_meta).toEqual([{ race_id: "R1", course_type: "障" }]);
  });

  it("値の型: 着順 NULL・0・小数・JSON の通過順が往復する(0 を NULL に潰さない)", async () => {
    const entries: RaceResultEntry[] = [
      { umaban: 1, finishPosition: null, placePayout: 0, winPayout: 0, passing: [1, 12, 18], last3f: 0 },
      { umaban: 2, finishPosition: 1, placePayout: 150, winPayout: 320.5, passing: [], last3f: 33.7 },
    ];
    await store().saveResult("R1", entries);
    expect((await dump()).race_results).toStrictEqual([
      { race_id: "R1", umaban: 1, finish_position: null, place_payout: 0, win_payout: 0, passing_json: "[1,12,18]", last3f: 0 },
      { race_id: "R1", umaban: 2, finish_position: 1, place_payout: 150, win_payout: 320.5, passing_json: "[]", last3f: 33.7 },
    ]);
  });

  it("既知の差分(記録): 浮動小数は JSON を経由して D1 に入る。実データの桁(小数1桁)と、17桁の値の往復をローカルの D1 で確かめる", async () => {
    // exe は JS の number を REAL で束縛し、D1 版は JSON 文字列 → SQLite の json_extract で REAL にする。実データ(上がり3Fは小数1桁)は一致する。
    // 17桁の値が一致しない環境があれば、ここが落ちて気づける(その場合は差分を JSDoc に記す)。
    const values = [33.7, 34.5, 0.1 + 0.2, 34.123456789012345, 1 / 3];
    await store().saveResult("R1", values.map((v, i) => ({ umaban: i + 1, finishPosition: i + 1, last3f: v })));
    const back = (await dump()).race_results.map((r) => r.last3f);
    expect(back).toStrictEqual(values);
  });
});

describe("AC-A5: getRaceResultDetails は、exe の getRaceResultDetail を1件ずつ呼んだ結果と同じ値を返す(面・通過順の往復を含む)", () => {
  it.each(resultContractCases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    if (c.raw !== undefined) {
      await insertRaw(c.raw);
    }
    for (const s of c.steps) {
      await store().saveResult(s.raceId, s.entries, s.courseType, s.comboPayouts);
    }
    const ids = Object.keys(c.expectedDetails);
    const rec = recordingDb(local.db);
    const map = await store(rec.db).getRaceResultDetails(ids);
    for (const id of ids) {
      const expected = c.expectedDetails[id];
      if (expected === null) {
        expect(map.has(id), `${id} は結果なし(キーを持たない)`).toBe(false);
      } else {
        expect(map.get(id), id).toStrictEqual(expected);
      }
    }
    // 空振り防止: 結果のあるレースが1つ以上あり、結果なしのレースも1つ以上ある
    expect(ids.some((id) => c.expectedDetails[id] !== null)).toBe(true);
    expect(ids.some((id) => c.expectedDetails[id] === null)).toBe(true);
    expect(map.size).toBe(ids.filter((id) => c.expectedDetails[id] !== null).length);
    // レース数に依らず1回の batch(馬・面の2文)
    expect(rec.batches).toEqual([2]);
  });

  it("前提(空振り防止): 防御的復元のケースには、壊れた通過順(broken・NULL・文字列要素)と未知の面('turf')の行が実際に入っている", async () => {
    const c = resultContractCases.find((x) => x.name === "defensive-restore")!;
    await insertRaw(c.raw!);
    const rows = (await local.db.prepare("SELECT passing_json FROM race_results WHERE race_id = '202603020299' ORDER BY umaban").all()).results as Array<{ passing_json: string | null }>;
    expect(rows.map((r) => r.passing_json)).toEqual(["[1,2]", "broken", null, '["a"]', '[1,"2"]']);
    expect(((await local.db.prepare("SELECT course_type FROM race_result_meta WHERE race_id = '202603020299'").first()) as { course_type: string }).course_type).toBe("turf");
  });

  it("ids が空なら D1 に何も発行せず、空の Map を返す(1R の当日傾向は前のレースが無い)", async () => {
    const rec = recordingDb(local.db);
    const map = await store(rec.db).getRaceResultDetails([]);
    expect(map.size).toBe(0);
    expect(rec.batches).toEqual([]);
    expect(rec.statements).toEqual([]);
  });

  it("同じ id を重ねて渡しても1件として返す。ids の数が多くても(150件)バインドは1個で、batch は1回", async () => {
    await store().saveResult("R1", [{ umaban: 1, finishPosition: 1 }], "芝");
    const rec = recordingDb(local.db);
    const ids = ["R1", "R1", ...Array.from({ length: 148 }, (_, i) => `X${i}`)];
    const map = await store(rec.db).getRaceResultDetails(ids);
    expect([...map.keys()]).toEqual(["R1"]);
    expect(rec.batches).toEqual([2]);
    expect(Math.max(...rec.statements.map((s) => s.binds))).toBe(1);
  });

  it("面の行だけがあって結果の行が無いレースは、結果なし(exe の getRaceResultDetail が undefined を返すのと同じ)", async () => {
    await local.db.prepare("INSERT INTO race_result_meta (race_id, course_type) VALUES ('M1', '芝')").run();
    expect((await store().getRaceResultDetails(["M1"])).size).toBe(0);
  });
});

describe("AC-A6: listUnimportedRaces(分析済み・結果未取込のレース。NOT EXISTS で判定)", () => {
  async function addAnalysis(raceId: string, kaisaiDate: string | null, i = 0): Promise<void> {
    await local.db
      .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES (?, ?, 0, ?)")
      .bind(raceId, `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`, kaisaiDate)
      .run();
  }

  it("窓は kaisai_date の [from, to](両端を含む)。窓の外・開催日が NULL の分析は含めない。並びは (開催日, レースID) の昇順", async () => {
    await addAnalysis("B2", "20261003");
    await addAnalysis("A2", "20261003");
    await addAnalysis("C1", "20261004");
    await addAnalysis("OLD", "20261002"); // from の前日
    await addAnalysis("NEW", "20261005"); // to の翌日
    await addAnalysis("NULLDATE", null);
    const list = await store().listUnimportedRaces({ from: "20261003", to: "20261004", limit: 50 });
    expect(list).toStrictEqual([
      { raceId: "A2", kaisaiDate: "20261003" },
      { raceId: "B2", kaisaiDate: "20261003" },
      { raceId: "C1", kaisaiDate: "20261004" },
    ]);
    // 空振り防止: 窓の外・NULL の分析も実際に D1 にある
    expect((await local.db.prepare("SELECT count(*) AS c FROM analyses").first<{ c: number }>())!.c).toBe(6);
  });

  it("結果の行が1件でもあるレースは含めない。全頭が中止・除外(着順が全て NULL)のレースも『取り込み済み』として含めない(行の有無で判定する)", async () => {
    await addAnalysis("DONE", "20261003");
    await addAnalysis("ALLNULL", "20261003");
    await addAnalysis("TODO", "20261003");
    await store().saveResult("DONE", [{ umaban: 1, finishPosition: 1 }]);
    await store().saveResult("ALLNULL", [{ umaban: 1, finishPosition: null }, { umaban: 2, finishPosition: null }]);
    // 前提: ALLNULL は行があるのに着順の値は1つも無い
    const row = await local.db.prepare("SELECT count(*) AS rows, count(finish_position) AS vals FROM race_results WHERE race_id = 'ALLNULL'").first<{ rows: number; vals: number }>();
    expect(row).toEqual({ rows: 2, vals: 0 });
    const list = await store().listUnimportedRaces({ from: "20261003", to: "20261003", limit: 50 });
    expect(list.map((r) => r.raceId)).toEqual(["TODO"]);
  });

  it("面の行(race_result_meta)だけがあって結果の行が無いレースは、未取込として含める", async () => {
    await addAnalysis("METAONLY", "20261003");
    await local.db.prepare("INSERT INTO race_result_meta (race_id, course_type) VALUES ('METAONLY', '芝')").run();
    expect((await store().listUnimportedRaces({ from: "20261003", to: "20261003", limit: 5 })).map((r) => r.raceId)).toEqual(["METAONLY"]);
  });

  it("同じレースを複数回分析していても1件(DISTINCT)", async () => {
    await addAnalysis("TWICE", "20261003", 1);
    await addAnalysis("TWICE", "20261003", 2);
    await addAnalysis("TWICE", "20261003", 3);
    expect(await store().listUnimportedRaces({ from: "20261003", to: "20261003", limit: 50 })).toStrictEqual([{ raceId: "TWICE", kaisaiDate: "20261003" }]);
  });

  it("limit: 並びの先頭から limit 件だけ返す(古い開催日から順に消化できる)", async () => {
    for (let i = 0; i < 7; i += 1) {
      await addAnalysis(`R${i}`, `2026100${(i % 3) + 1}`);
    }
    const all = await store().listUnimportedRaces({ from: "20261001", to: "20261003", limit: 50 });
    expect(all).toHaveLength(7); // 前提: limit より多く存在する
    const firstThree = await store().listUnimportedRaces({ from: "20261001", to: "20261003", limit: 3 });
    expect(firstThree).toStrictEqual(all.slice(0, 3));
    expect(firstThree.map((r) => r.kaisaiDate)).toEqual(["20261001", "20261001", "20261001"]);
    // 結果を取り込んだレースは次の呼び出しから外れる(取り込みが進めば先頭が進む)
    await store().saveResult(firstThree[0]!.raceId, [{ umaban: 1, finishPosition: 1 }]);
    const next = await store().listUnimportedRaces({ from: "20261001", to: "20261003", limit: 3 });
    expect(next[0]).toStrictEqual(all[1]);
  });

  it("入力の検証: from・to は YYYYMMDD の8桁で from ≤ to、limit は 1〜200 の整数(違反は RangeError。D1 に発行しない)", async () => {
    const rec = recordingDb(local.db);
    const s = store(rec.db);
    const ok = { from: "20261001", to: "20261003", limit: 10 };
    for (const bad of [
      { ...ok, from: "2026-10-01" },
      { ...ok, to: "20261" },
      { ...ok, from: "20261004" }, // from > to
      { ...ok, limit: 0 },
      { ...ok, limit: -1 },
      { ...ok, limit: 1.5 },
      { ...ok, limit: UNIMPORTED_MAX_LIMIT + 1 },
      { ...ok, limit: Number.NaN },
    ]) {
      await expect(s.listUnimportedRaces(bad)).rejects.toBeInstanceOf(RangeError);
    }
    expect(rec.statements).toEqual([]);
    expect(UNIMPORTED_MAX_LIMIT).toBe(200);
    await expect(s.listUnimportedRaces({ from: "20261003", to: "20261003", limit: UNIMPORTED_MAX_LIMIT })).resolves.toEqual([]); // 境界(from = to・limit 上限)は通る
  });

  it("クエリプラン: 開催日の索引(idx_analyses_kaisai_date)と、結果の主キーの索引(NOT EXISTS の探索)を使い、analyses を全走査しない", async () => {
    const plan = (await local.db.prepare(`EXPLAIN QUERY PLAN ${LIST_UNIMPORTED_SQL}`).bind("20261001", "20261003", 10).all()).results as Array<{ detail: string }>;
    const text = plan.map((p) => p.detail).join("\n");
    expect(text).toContain("idx_analyses_kaisai_date");
    expect(text).toMatch(/SEARCH r USING (COVERING )?INDEX sqlite_autoindex_race_results_1 \(race_id=\?\)/);
    expect(text).not.toMatch(/SCAN a\b/);
  });
});

describe("Issue #208 AC-C: listUnimportedRacesByDay(窓の中の未取込を、日ごとの上限・日数の上限・合計の上限つきで 1 クエリで列挙する。新しい日が先)", () => {
  async function addAnalysis(raceId: string, kaisaiDate: string | null, i = 0): Promise<void> {
    await local.db
      .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES (?, ?, 0, ?)")
      .bind(raceId, `2026-10-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`, kaisaiDate)
      .run();
  }
  const opts = { from: "20261001", to: "20261007", perDay: 60, maxDays: 3, total: 120 };

  it("窓は kaisai_date の [from, to](両端を含む)。窓の外・開催日が NULL・結果がある(全頭中止の行だけのものも)レースは含めない。並びは新しい日が先、同じ日は レースID 昇順", async () => {
    await addAnalysis("B2", "20261003");
    await addAnalysis("A2", "20261003");
    await addAnalysis("C1", "20261004");
    await addAnalysis("FROM", "20261001"); // 窓の下端(含む)
    await addAnalysis("TO", "20261007"); // 窓の上端(含む)
    await addAnalysis("OLD", "20260930"); // from の前日
    await addAnalysis("NEW", "20261008"); // to の翌日
    await addAnalysis("NULLDATE", null);
    await addAnalysis("DONE", "20261004");
    await addAnalysis("ALLNULL", "20261004");
    await store().saveResult("DONE", [{ umaban: 1, finishPosition: 1 }]);
    await store().saveResult("ALLNULL", [{ umaban: 1, finishPosition: null }]);
    const list = await store().listUnimportedRacesByDay({ ...opts, maxDays: 31 });
    expect(list).toStrictEqual([
      { raceId: "TO", kaisaiDate: "20261007" },
      { raceId: "C1", kaisaiDate: "20261004" },
      { raceId: "A2", kaisaiDate: "20261003" },
      { raceId: "B2", kaisaiDate: "20261003" },
      { raceId: "FROM", kaisaiDate: "20261001" },
    ]);
    // 空振り防止: 除外したものも実際に D1 にある
    expect((await local.db.prepare("SELECT count(*) AS c FROM analyses").first<{ c: number }>())!.c).toBe(10);
  });

  it("日数の上限: 未取込のある日だけを数え、新しい日から maxDays 日ぶん。未取込の無い日(開催なし・全件取り込み済み)は数えない", async () => {
    await addAnalysis("D7", "20261007");
    await addAnalysis("D6DONE", "20261006"); // 取り込み済みの日(列挙に出ず、日数にも数えない)
    await store().saveResult("D6DONE", [{ umaban: 1, finishPosition: 1 }]);
    await addAnalysis("D4", "20261004");
    await addAnalysis("D3", "20261003");
    await addAnalysis("D2", "20261002");
    // 前提: 未取込のある日は 4 日(maxDays = 3 より多い)
    const everything = await store().listUnimportedRacesByDay({ ...opts, maxDays: 31 });
    expect([...new Set(everything.map((r) => r.kaisaiDate))]).toEqual(["20261007", "20261004", "20261003", "20261002"]);
    const limited = await store().listUnimportedRacesByDay({ ...opts, maxDays: 3 });
    expect(limited.map((r) => r.raceId)).toEqual(["D7", "D4", "D3"]);
    const two = await store().listUnimportedRacesByDay({ ...opts, maxDays: 2 });
    expect(two.map((r) => r.raceId)).toEqual(["D7", "D4"]);
  });

  it("日ごとの上限: 1 日の未取込が多くても perDay 件まで(その日の レースID 昇順の先頭)。古い日が新しい日を押しのけない", async () => {
    for (let i = 1; i <= 5; i += 1) {
      await addAnalysis(`OLD${i}`, "20261002");
    }
    for (let i = 1; i <= 5; i += 1) {
      await addAnalysis(`NEW${i}`, "20261006");
    }
    const list = await store().listUnimportedRacesByDay({ ...opts, perDay: 2, total: 120 });
    expect(list.map((r) => r.raceId)).toEqual(["NEW1", "NEW2", "OLD1", "OLD2"]);
  });

  it("合計の上限: 新しい日から順に total 件で打ち切る(古い日が切られる)", async () => {
    for (let i = 1; i <= 4; i += 1) {
      await addAnalysis(`N${i}`, "20261006");
    }
    for (let i = 1; i <= 4; i += 1) {
      await addAnalysis(`O${i}`, "20261003");
    }
    const all = await store().listUnimportedRacesByDay({ ...opts, total: 120 });
    expect(all).toHaveLength(8); // 前提: total より多く存在する
    const cut = await store().listUnimportedRacesByDay({ ...opts, total: 5 });
    expect(cut).toStrictEqual(all.slice(0, 5));
    expect(cut.map((r) => r.raceId)).toEqual(["N1", "N2", "N3", "N4", "O1"]);
  });

  it("日ごとの列挙(listUnimportedRaces を日ごとに呼んだもの)と、判定が一致する: 同じレースを複数日に分析した場合(最小の開催日に寄せる)・同じ日の複数回の分析を含む", async () => {
    await addAnalysis("TWICE", "20261003", 1);
    await addAnalysis("TWICE", "20261003", 2);
    await addAnalysis("SPLIT", "20261003", 3); // 2 つの開催日で分析された
    await addAnalysis("SPLIT", "20261004", 4);
    await addAnalysis("SOLO", "20261004", 5);
    await addAnalysis("DONE", "20261004", 6);
    await store().saveResult("DONE", [{ umaban: 1, finishPosition: 1 }]);
    const byDay = await store().listUnimportedRacesByDay({ ...opts, maxDays: 31 });
    // 前提: 日ごとの列挙は(窓を 1 日に絞った)別の判定の経路
    const perDay = [
      ...(await store().listUnimportedRaces({ from: "20261004", to: "20261004", limit: 50 })),
      ...(await store().listUnimportedRaces({ from: "20261003", to: "20261003", limit: 50 })),
    ];
    expect(perDay.length).toBeGreaterThan(0);
    // 窓を広げた 1 クエリ版は、SPLIT を最小の開催日(20261003)に寄せる。日ごとの列挙は SPLIT を両日に出す(別の定義)
    expect(byDay.map((r) => `${r.kaisaiDate}:${r.raceId}`)).toEqual(["20261004:SOLO", "20261003:SPLIT", "20261003:TWICE"]);
    expect(perDay.filter((r) => r.raceId === "SPLIT")).toHaveLength(2);
    // 日ごとの列挙の和集合(raceId の重複を除く)は、1 クエリ版のレースの集合と等しい
    expect([...new Set(perDay.map((r) => r.raceId))].sort()).toEqual(byDay.map((r) => r.raceId).sort());
  });

  it("発行は 1 クエリだけ(束縛は from・to・perDay・maxDays・total の 5 個)", async () => {
    await addAnalysis("A", "20261003");
    const rec = recordingDb(local.db);
    await store(rec.db).listUnimportedRacesByDay(opts);
    expect(rec.statements).toHaveLength(1);
    expect(rec.statements[0]!.binds).toBe(5);
    expect(rec.batches).toEqual([]);
  });

  it("入力の検証: from・to は YYYYMMDD の 8 桁で from ≤ to、perDay・total は 1〜200、maxDays は 1〜31 の整数(違反は RangeError。D1 に発行しない)", async () => {
    const rec = recordingDb(local.db);
    const s = store(rec.db);
    for (const bad of [
      { ...opts, from: "2026-10-01" },
      { ...opts, to: "20261" },
      { ...opts, from: "20261008" },
      { ...opts, perDay: 0 },
      { ...opts, perDay: UNIMPORTED_MAX_LIMIT + 1 },
      { ...opts, perDay: 1.5 },
      { ...opts, maxDays: 0 },
      { ...opts, maxDays: 32 },
      { ...opts, total: 0 },
      { ...opts, total: UNIMPORTED_MAX_LIMIT + 1 },
      { ...opts, total: Number.NaN },
    ]) {
      await expect(s.listUnimportedRacesByDay(bad)).rejects.toBeInstanceOf(RangeError);
    }
    expect(rec.statements).toEqual([]);
    // 境界は通る
    await expect(s.listUnimportedRacesByDay({ from: "20261003", to: "20261003", perDay: 1, maxDays: 1, total: 1 })).resolves.toEqual([]);
    await expect(s.listUnimportedRacesByDay({ ...opts, perDay: UNIMPORTED_MAX_LIMIT, maxDays: 31, total: UNIMPORTED_MAX_LIMIT })).resolves.toEqual([]);
  });

  it("クエリプラン: 開催日の索引(idx_analyses_kaisai_date)と結果の主キーの索引(NOT EXISTS の探索)を使い、analyses を全走査しない", async () => {
    const plan = (await local.db.prepare(`EXPLAIN QUERY PLAN ${LIST_UNIMPORTED_BY_DAY_SQL}`).bind("20261001", "20261007", 60, 3, 120).all()).results as Array<{ detail: string }>;
    const text = plan.map((p) => p.detail).join("\n");
    expect(text).toContain("idx_analyses_kaisai_date");
    expect(text).toMatch(/SEARCH r USING (COVERING )?INDEX sqlite_autoindex_race_results_1 \(race_id=\?\)/);
    expect(text).not.toMatch(/SCAN a\b/);
  });
});

describe("SQL の導出(codec の文から D1 用の文を作る。形が変わったら読み込み時に落ちる)", () => {
  it("jsonEachInsertSelectSql: 先頭の列は定数の ?、残りは JSON の配列の要素。ON CONFLICT の句を保つ", () => {
    const sql = jsonEachInsertSelectSql("INSERT INTO t (a, b, c) VALUES (?, ?, ?) ON CONFLICT(a, b) DO UPDATE SET c = excluded.c");
    expect(sql.replace(/\s+/g, " ")).toBe(
      "INSERT INTO t (a, b, c) SELECT ?, json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?) WHERE true ON CONFLICT(a, b) DO UPDATE SET c = excluded.c",
    );
  });

  it("jsonEachInsertSelectSql: 句の無い INSERT でも導ける。列と ? の数が合わない・INSERT でない文は例外", () => {
    expect(jsonEachInsertSelectSql("INSERT INTO t (a, b) VALUES (?, ?)")).toContain("SELECT ?, json_extract(value,'$[0]') FROM json_each(?) WHERE true");
    expect(() => jsonEachInsertSelectSql("INSERT INTO t (a, b) VALUES (?, ?, ?)")).toThrow();
    expect(() => jsonEachInsertSelectSql("UPDATE t SET a = 1")).toThrow();
  });

  it("jsonEachDeleteSql: bet_type = ? を json_each の IN に置き換える。置き換え対象が無ければ例外", () => {
    expect(jsonEachDeleteSql("DELETE FROM t WHERE race_id = ? AND bet_type = ?")).toBe(
      "DELETE FROM t WHERE race_id = ? AND bet_type IN (SELECT value FROM json_each(?))",
    );
    expect(() => jsonEachDeleteSql("DELETE FROM t WHERE race_id = ?")).toThrow();
  });
});

describe("実フィクスチャ(中央8・地方6): パース → core の importRaceResult → D1ResultStore(非同期の saveResult)", () => {
  const FIXTURES = [
    "result_202602010605.html",
    "result_202602010607.html",
    "result_202603020203.html",
    "result_202603020211.html",
    "result_202606040810.html",
    "result_202607020501.html",
    "result_202607020502.html",
    "result_202607020505.html",
    "nar_result_202630062407.html",
    "nar_result_202646071203.html",
    "nar_result_202654071201.html",
    "nar_result_202654071210.html",
    "nar_result_202654092706.html",
    "nar_result_202654092711.html",
  ];
  const load = (name: string): string => readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), "utf-8");

  it("前提: フィクスチャは14本で、全て実在する", () => {
    expect(FIXTURES).toHaveLength(14);
    for (const f of FIXTURES) {
      expect(load(f).length, f).toBeGreaterThan(1000);
    }
  });

  it.each(FIXTURES.map((f) => [f] as const))("%s: imported になり、着順の頭数・複勝払戻・組合せ払戻が D1 に往復する", async (fixture) => {
    const raceId = parseRaceId(/(\d{12})/.exec(fixture)![1]!);
    const html = load(fixture);
    const parsed = parseRaceResult(html);
    const s = store();
    const outcome = await importRaceResult(raceId, {
      fetchText: async () => html,
      parse: parseRaceResult,
      saveResult: (rid, entries, courseType, combo) => s.saveResult(rid, entries, courseType, combo),
    });
    expect(outcome.status).toBe("imported");
    const d = await dump();
    expect(d.race_results).toHaveLength(parsed.horses.length);
    expect(d.race_results.filter((r) => r.place_payout !== null)).toHaveLength(parsed.placePayouts.length);
    expect(d.race_results.filter((r) => r.win_payout !== null)).toHaveLength(parsed.winPayouts.length);
    // 組合せ: parsed の券種の払戻の総数と、マーカーの数が一致する
    const combos = [parsed.widePayouts, parsed.trioPayouts, parsed.quinellaPayouts, parsed.exactaPayouts, parsed.trifectaPayouts, parsed.bracketQuinellaPayouts];
    const parsedCombos = combos.filter((c) => c?.state === "parsed");
    expect(d.race_combo_payout_imports).toHaveLength(parsedCombos.length);
    expect(d.race_combo_payouts).toHaveLength(parsedCombos.reduce((n, c) => n + (c?.state === "parsed" ? c.payouts.length : 0), 0));
    // 復元: 頭数・面
    const detail = (await s.getRaceResultDetails([raceId])).get(raceId);
    expect(detail?.horses).toHaveLength(parsed.horses.length);
    expect(detail?.courseType).toBe(parsed.courseType ?? null);
  });

  it("全体の網羅(空振り防止): 14本のうち、馬連・馬単・三連単・枠連・ワイド・三連複のそれぞれが parsed でかつ払戻が1件以上あるフィクスチャが少なくとも1本ある", () => {
    const seen = new Set<string>();
    for (const f of FIXTURES) {
      const p = parseRaceResult(load(f));
      for (const [bet, c] of Object.entries({ wide: p.widePayouts, trio: p.trioPayouts, quinella: p.quinellaPayouts, exacta: p.exactaPayouts, trifecta: p.trifectaPayouts, bracketQuinella: p.bracketQuinellaPayouts })) {
        if (c?.state === "parsed" && c.payouts.length > 0) {
          seen.add(bet);
        }
      }
    }
    expect([...seen].sort()).toEqual(["bracketQuinella", "exacta", "quinella", "trifecta", "trio", "wide"]);
  });
});
