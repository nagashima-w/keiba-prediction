import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PERIOD_ANALYSES_LIMIT, readPeriodRawFrom, readPeriodRowsFrom, READ_PERIOD_SQL } from "../src/daily-report-repository";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #615: 期間の集計(`READ_PERIOD_SQL`)は、6 文それぞれが同じ `latest` の CTE を作り直していた。
 * 1 文目(races)で分析 ID・レース ID を取り、残り 5 文はそれを `json_each` で引く 2 段階の batch にした。
 * このファイルは、書き換え前の 6 文(下の LEGACY_*)と新しい形を同じデータに流し、6 本の結果(行・並び)がすべて一致することと、`rows_read` が下がったことを固定する。
 */

const LATEST = `WITH latest AS (
  SELECT id, race_id, kaisai_date, model, prompt_version FROM (
    SELECT id, race_id, kaisai_date, model, prompt_version, ROW_NUMBER() OVER (PARTITION BY race_id ORDER BY analyzed_at DESC, id DESC) AS rn
    FROM analyses WHERE kaisai_date >= ? AND kaisai_date <= ?
  ) WHERE rn = 1 ORDER BY race_id LIMIT ?
)`;
const LEGACY = {
  races: `${LATEST} SELECT id AS analysisId, race_id AS raceId, kaisai_date AS kaisaiDate, model, prompt_version AS promptVersion FROM latest ORDER BY race_id`,
  bets: `${LATEST} SELECT b.analysis_id AS analysisId, b.bet_type AS betType, b.combo_key AS comboKey, b.stake, b.odds, b.ev
           FROM analysis_bets b JOIN latest l ON l.id = b.analysis_id ORDER BY b.analysis_id, b.bet_type, b.combo_key`,
  marks: `${LATEST} SELECT h.analysis_id AS analysisId, h.umaban, h.mark
           FROM analysis_horses h JOIN latest l ON l.id = h.analysis_id WHERE h.mark IS NOT NULL ORDER BY h.analysis_id, h.umaban`,
  results: `${LATEST} SELECT r.race_id AS raceId, r.umaban, r.finish_position AS finishPosition, r.win_payout AS winPayout, r.place_payout AS placePayout, r.scratched, r.wakuban
           FROM race_results r WHERE r.race_id IN (SELECT race_id FROM latest) ORDER BY r.race_id, r.umaban`,
  combos: `${LATEST} SELECT c.race_id AS raceId, c.bet_type AS betType, c.combo_key AS comboKey, c.payout
           FROM race_combo_payouts c WHERE c.race_id IN (SELECT race_id FROM latest) ORDER BY c.race_id, c.bet_type, c.combo_key`,
  imports: `${LATEST} SELECT i.race_id AS raceId, i.bet_type AS betType
           FROM race_combo_payout_imports i WHERE i.race_id IN (SELECT race_id FROM latest)`,
} as const;
const KEYS = ["races", "bets", "marks", "results", "combos", "imports"] as const;

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

async function legacyRead(from: string, to: string, limit: number): Promise<{ raw: Record<(typeof KEYS)[number], unknown[]>; rowsRead: number }> {
  const responses = await local.db.batch(KEYS.map((k) => local.db.prepare(LEGACY[k]).bind(from, to, limit + 1)));
  const raw = Object.fromEntries(KEYS.map((k, i) => [k, responses[i]?.results ?? []])) as Record<(typeof KEYS)[number], unknown[]>;
  return { raw, rowsRead: responses.reduce((n, r) => n + (r?.meta?.rows_read ?? 0), 0) };
}

let seq = 0;
async function addAnalysis(raceId: string, kaisaiDate: string | null, analyzedAt: string, model = "m"): Promise<number> {
  seq += 1;
  const r = await local.db
    .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date, model, prompt_version) VALUES (?, ?, 0, ?, ?, ?) RETURNING id")
    .bind(raceId, analyzedAt, kaisaiDate, model, `v${seq % 2}`)
    .first<{ id: number }>();
  return r!.id;
}
const addBet = (id: number, type: string, key: string, stake: number) =>
  local.db.prepare("INSERT INTO analysis_bets (analysis_id, bet_type, combo_key, stake, odds, ev) VALUES (?, ?, ?, ?, 3.5, 1.2)").bind(id, type, key, stake).run();
const addHorse = (id: number, umaban: number, mark: string | null) =>
  local.db.prepare("INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, is_positive, mark) VALUES (?, ?, 0.1, 0.1, 0, ?)").bind(id, umaban, mark).run();
const addResult = (raceId: string, umaban: number, finish: number | null, scratched: number | null) =>
  local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_payout, place_payout, scratched, wakuban) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(raceId, umaban, finish, finish === 1 ? 340 : null, finish !== null && finish <= 3 ? 130 : null, scratched, (umaban % 8) + 1).run();

/** 境界の日・同じレースの複数の分析・結果の無いレース・取消のある馬・開催日 NULL・範囲外を含むデータ。 */
async function seedMixed(): Promise<void> {
  // 同じレースに分析が 3 つ(分析時刻が最新が採用される。古い 2 つの買い目・印は出てはならない)
  const a1 = await addAnalysis("R-A", "20261010", "2026-10-10T01:00:00.000Z");
  const a2 = await addAnalysis("R-A", "20261010", "2026-10-10T05:00:00.000Z");
  const a3 = await addAnalysis("R-A", "20261010", "2026-10-10T05:00:00.000Z"); // 同時刻 → id の大きい方
  for (const id of [a1, a2, a3]) {
    await addBet(id, "win", "01", 100 * id);
    await addBet(id, "place", "02", 50);
    await addHorse(id, 1, "◎");
    await addHorse(id, 2, null); // 印なしは marks に出ない
  }
  // 期間の境界: from の日・to の日は入り、前日・翌日は入らない
  const edgeFrom = await addAnalysis("R-FROM", "20261001", "2026-10-01T01:00:00.000Z");
  const edgeTo = await addAnalysis("R-TO", "20261031", "2026-10-31T01:00:00.000Z");
  const before = await addAnalysis("R-BEFORE", "20260930", "2026-09-30T01:00:00.000Z");
  const after = await addAnalysis("R-AFTER", "20261101", "2026-11-01T01:00:00.000Z");
  const nullDate = await addAnalysis("R-NULL", null, "2026-10-10T01:00:00.000Z");
  for (const id of [edgeFrom, edgeTo, before, after, nullDate]) {
    await addBet(id, "win", "03", 200);
    await addHorse(id, 3, "▲");
  }
  // 結果のあるレース(取消のある馬・scratched が NULL の旧い行・着順なし)と、結果の無いレース(R-FROM 以外)
  await addResult("R-A", 1, 1, 0);
  await addResult("R-A", 2, 2, 0);
  await addResult("R-A", 3, null, 1); // 取消
  await addResult("R-A", 4, null, null); // 取消か中止か不明(旧い行)
  await addResult("R-TO", 1, 1, 0);
  await addResult("R-BEFORE", 1, 1, 0); // 範囲外のレースの結果は出てはならない
  await addResult("R-ORPHAN", 1, 1, 0); // 分析の無いレース
  // 組合せの払戻と取込マーカー
  for (const raceId of ["R-A", "R-TO", "R-BEFORE", "R-ORPHAN"]) {
    await local.db.prepare("INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES (?, 'wide', '01-02', 560), (?, 'wide', '01-03', 880), (?, 'quinella', '01-02', 1200)").bind(raceId, raceId, raceId).run();
    await local.db.prepare("INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES (?, 'wide'), (?, 'quinella'), (?, 'trio')").bind(raceId, raceId, raceId).run();
  }
}

describe("期間の集計: 旧い 6 文との同値", () => {
  it("6 本すべての結果(行・並び)が一致する(最新の分析・境界の日・結果なし・取消・開催日 NULL・範囲外を含む)", async () => {
    await seedMixed();
    const old = await legacyRead("20261001", "20261031", PERIOD_ANALYSES_LIMIT);
    const neu = await readPeriodRawFrom(local.db, "20261001", "20261031", PERIOD_ANALYSES_LIMIT);
    // 前提(空振り防止): 6 本とも空でなく、しかも範囲外・古い分析を除いたことで結果が絞られている
    for (const k of KEYS) {
      expect(old.raw[k].length, k).toBeGreaterThan(0);
    }
    expect((old.raw.races as Array<{ raceId: string }>).map((r) => r.raceId)).toEqual(["R-A", "R-FROM", "R-TO"]);
    expect((old.raw.results as Array<{ raceId: string }>).some((r) => r.raceId === "R-BEFORE" || r.raceId === "R-ORPHAN")).toBe(false);
    expect((old.raw.bets as unknown[]).length).toBe(2 + 1 + 1); // R-A は最新(a3)の 2 本 + R-FROM + R-TO
    for (const k of KEYS) {
      expect(neu[k], k).toEqual(old.raw[k]);
    }
  });

  it("上限(limit)の判定は races の件数で行い、超えたら例外、ちょうどなら通る", async () => {
    for (let n = 1; n <= 3; n += 1) await addAnalysis(`L${n}`, "20261010", `2026-10-10T0${n}:00:00.000Z`);
    await expect(readPeriodRowsFrom(local.db, "20261001", "20261031", 2)).rejects.toThrow(/上限/);
    expect((await readPeriodRowsFrom(local.db, "20261001", "20261031", 3)).rows.races).toHaveLength(3);
  });

  it("該当のレースが無い期間でも、全部空で返る(2 段目の入力が空配列)", async () => {
    await seedMixed();
    const old = await legacyRead("20300101", "20300131", PERIOD_ANALYSES_LIMIT);
    const neu = await readPeriodRawFrom(local.db, "20300101", "20300131", PERIOD_ANALYSES_LIMIT);
    for (const k of KEYS) {
      expect(old.raw[k]).toEqual([]);
      expect(neu[k]).toEqual([]);
    }
  });

  it("発行: 1 段目が races の 1 文、2 段目が残り 5 文の batch(読み取り専用。束縛は 1 段目が 3 個、2 段目が JSON 1 個)。空の期間は 2 段目を発行しない", async () => {
    await seedMixed();
    const { db, batches } = spyDb(local.db);
    await readPeriodRowsFrom(db, "20261001", "20261031");
    expect(batches).toEqual([1, 5]);
    const spy2 = spyDb(local.db);
    await readPeriodRowsFrom(spy2.db, "20300101", "20300131");
    expect(spy2.batches).toEqual([1]);
    expect(READ_PERIOD_SQL.races.match(/\?/g)).toHaveLength(3);
    for (const k of ["bets", "marks", "results", "combos", "imports"] as const) {
      expect(READ_PERIOD_SQL[k].match(/\?/g), k).toHaveLength(1);
      expect(READ_PERIOD_SQL[k], k).toContain("json_each");
    }
    for (const sql of Object.values(READ_PERIOD_SQL)) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i);
    }
  });
});

describe("期間の集計: rows_read と束縛の大きさ", () => {
  it("rows_read が下がる(旧い 6 文より少ない)。行は同じ", async () => {
    // 40 レース × 14 頭・買い目 3 本・結果 14 行・組合せ 3 行
    for (let r = 0; r < 40; r += 1) {
      const raceId = `S${String(r).padStart(3, "0")}`;
      const id = await addAnalysis(raceId, "20261010", "2026-10-10T01:00:00.000Z");
      for (let b = 1; b <= 3; b += 1) await addBet(id, "win", String(b).padStart(2, "0"), 100);
      for (let u = 1; u <= 14; u += 1) {
        await addHorse(id, u, u <= 5 ? "○" : null);
        await addResult(raceId, u, u, 0);
      }
      await local.db.prepare("INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES (?, 'wide', '01-02', 1), (?, 'wide', '01-03', 2), (?, 'wide', '02-03', 3)").bind(raceId, raceId, raceId).run();
      await local.db.prepare("INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES (?, 'wide')").bind(raceId).run();
    }
    const old = await legacyRead("20261001", "20261031", PERIOD_ANALYSES_LIMIT);
    const neu = await readPeriodRowsFrom(local.db, "20261001", "20261031");
    expect(neu.rows.races.length).toBe(40);
    expect(neu.rowsRead).toBeLessThan(old.rowsRead);
    expect(neu.rowsRead).toBeLessThanOrEqual(old.rowsRead * 0.8); // 20% 以上の削減(Issue #615 の実測は約 32%)
  });

  it("上限の 3,000 レースでも、2 段目の JSON の束縛が D1 に通り、全行が返る", async () => {
    const N = PERIOD_ANALYSES_LIMIT;
    await local.db
      .prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) SELECT 'P' || printf('%06d', value), '2026-10-10T00:00:00.000Z', 0, '20261010' FROM generate_series(1, ?)")
      .bind(N)
      .run()
      .catch(async () => {
        // generate_series が無い場合は再帰 CTE で作る
        await local.db
          .prepare("WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ?) INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) SELECT 'P' || printf('%06d', n), '2026-10-10T00:00:00.000Z', 0, '20261010' FROM s")
          .bind(N)
          .run();
      });
    await local.db.prepare("INSERT INTO analysis_bets (analysis_id, bet_type, combo_key, stake) SELECT id, 'win', '01', 100 FROM analyses").run();
    await local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position) SELECT race_id, 1, 1 FROM analyses").run();
    await local.db.prepare("INSERT INTO race_combo_payout_imports (race_id, bet_type) SELECT race_id, 'wide' FROM analyses").run();
    const { rows } = await readPeriodRowsFrom(local.db, "20261001", "20261031");
    expect(rows.races).toHaveLength(N);
    expect(rows.bets).toHaveLength(N);
    expect(rows.results).toHaveLength(N);
    expect(rows.imports).toHaveLength(N);
  }, 120_000);
});
