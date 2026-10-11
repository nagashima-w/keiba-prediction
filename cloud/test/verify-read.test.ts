import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildVerifySource, countStartTimeGaps, VERIFY_READ_SQL, type VerifyAnalysisRow, type VerifyReadRows } from "../src/verify-read";

/**
 * Issue #219: 検証の読み取り(`VERIFY_READ_SQL` と `buildVerifySource`)。実際の D1 のスキーマ(migration 0001〜0009)を Node 組込みの SQLite に流して、
 * SQL が通ること・`start_time` の印の読み替え・行 → 読み取り口の変換を確かめる。exe の集計との一致は、ルートの `scripts/test/cloud-verify-parity.test.ts`
 * (cloud は better-sqlite3 を持たない)。
 */
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const FILES = ["0001_init.sql", "0002_d1.sql", "0003_r2_ops.sql", "0004_settings.sql", "0005_llm_note.sql", "0006_horse_items.sql", "0007_llm_calls.sql", "0008_migration_import.sql", "0009_start_time.sql"];

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of FILES) {
    db.exec(readFileSync(path.join(MIGRATIONS, file), "utf-8"));
  }
  return db;
}

function readRows(db: DatabaseSync): VerifyReadRows {
  const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
  return {
    analyses: all(VERIFY_READ_SQL.analyses),
    horses: all(VERIFY_READ_SQL.horses),
    allocationMeta: all(VERIFY_READ_SQL.allocationMeta),
    bets: all(VERIFY_READ_SQL.bets),
    results: all(VERIFY_READ_SQL.results),
    comboPayouts: all(VERIFY_READ_SQL.comboPayouts),
    comboImports: all(VERIFY_READ_SQL.comboImports),
  };
}

describe("VERIFY_READ_SQL: start_time の印の読み替え", () => {
  const cases: ReadonlyArray<readonly [string, string | null, unknown]> = [
    ["HH:MM(2桁)は時刻として渡す", "15:45", { race: { startTime: "15:45" } }],
    ["H:MM(1桁)も時刻として渡す(core の受理条件と同じ)", "9:05", { race: { startTime: "9:05" } }],
    ["NULL(未確認)はスナップショットなし", null, null],
    ["''(詳細に発走時刻が無い)はスナップショットなし", "", null],
    ["'?'(確認できなかった)はスナップショットなし", "?", null],
    ["時刻の形でない値は時刻として渡さない", "午後3時", null],
  ];
  it.each(cases)("%s", (_name, startTime, expectedSnapshot) => {
    const db = openDb();
    db.prepare("INSERT INTO analyses (race_id, analyzed_at, start_time) VALUES ('202606030811', '2026-07-05T00:00:00.000Z', ?)").run(startTime);
    const source = buildVerifySource(readRows(db));
    const analyses = source.listAnalyses();
    expect(analyses).toHaveLength(1);
    expect(analyses[0]!.raceSnapshot).toEqual(expectedSnapshot);
    db.close();
  });
});

describe("buildVerifySource", () => {
  it("D1 の実スキーマで全 SQL が通り、分析・馬・結果・組合せ払戻・配分が読み取り口から読める", () => {
    const db = openDb();
    db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, prompt_version, kaisai_date, history_cutoff_date, prompt_lookahead_guarded, start_time) VALUES ('202606030811', '2026-07-05T00:00:00.000Z', 1, 'v1', '20260705', '20260705', 1, '15:45')").run();
    db.prepare("INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, mark) VALUES (1, 2, 0.3, 0.35, 2.5, 1.2, 1, '◎'), (1, 1, 0.2, 0.2, NULL, NULL, 0, NULL)").run();
    db.prepare("INSERT INTO analysis_allocation_meta (analysis_id, route, skip_reason_code, bankroll, per_race_cap, kelly_fraction, ev_threshold, include_combo_odds, include_wide, include_trio, odds_status) VALUES (1, 'mixed', NULL, 10000, 2000, 0.25, 1, 0, 0, 0, 'result')").run();
    db.prepare("INSERT INTO analysis_bets (analysis_id, bet_type, combo_key, stake) VALUES (1, 'wide', '0102', 300), (1, 'place', '02', 100), (1, 'place', '01', 200)").run();
    db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, place_payout, win_payout) VALUES ('202606030811', 2, 1, 150, 320), ('202606030811', 1, NULL, NULL, NULL)").run();
    db.prepare("INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES ('202606030811', 'wide'), ('202606030811', 'trio')").run();
    db.prepare("INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES ('202606030811', 'wide', '0102', 450), ('202606030811', 'wide', '0001', 120)").run();
    const source = buildVerifySource(readRows(db));

    const [a] = source.listAnalyses();
    expect(a).toMatchObject({ id: 1, raceId: "202606030811", evEstimated: true, promptVersion: "v1", kaisaiDate: "20260705", historyCutoffDate: "20260705", promptLookaheadGuarded: true, rawResponse: null, model: null });
    expect(a!.horses.map((h) => [h.umaban, h.mark, h.placeOddsMin, h.isPositive])).toEqual([[1, null, null, false], [2, "◎", 2.5, true]]);
    expect(source.listAnalyses({ raceId: "999999999999" })).toEqual([]);
    expect(source.getResult("202606030811")).toEqual([
      { umaban: 1, finishPosition: null, placePayout: null, winPayout: null },
      { umaban: 2, finishPosition: 1, placePayout: 150, winPayout: 320 },
    ]);
    expect(source.getResult("202699999999")).toBeUndefined();
    expect(source.getComboPayouts("202606030811", "wide")).toEqual({ state: "imported", payouts: [{ comboKey: "0001", payout: 120 }, { comboKey: "0102", payout: 450 }] });
    // 取込印はあるが払戻の行が無い(未発売): imported で空配列。取込印が無い券種: not_imported
    expect(source.getComboPayouts("202606030811", "trio")).toEqual({ state: "imported", payouts: [] });
    expect(source.getComboPayouts("202606030811", "quinella")).toEqual({ state: "not_imported" });
    expect(source.getAllocationForVerify(1)).toEqual({
      route: "mixed",
      skipReasonCode: null,
      bets: [{ betType: "place", comboKey: "01", stake: 200 }, { betType: "place", comboKey: "02", stake: 100 }, { betType: "wide", comboKey: "0102", stake: 300 }],
    });
    expect(source.getAllocationForVerify(2)).toBeUndefined();
    db.close();
  });

  it("行が 1 つも無い D1 でも空の読み取り口になる(空振りでないよう、別の表の行だけがある場合も)", () => {
    const db = openDb();
    const empty = buildVerifySource(readRows(db));
    expect(empty.listAnalyses()).toEqual([]);
    expect(empty.getResult("x")).toBeUndefined();
    expect(empty.getAllocationForVerify(1)).toBeUndefined();
    db.close();
  });
});

describe("countStartTimeGaps(発走時刻を確認できなかった行のうち、判定に影響しうるもの)", () => {
  function row(over: Partial<VerifyAnalysisRow>): VerifyAnalysisRow {
    return {
      id: 1, raceId: "202606030811", analyzedAt: "2026-07-05T07:00:00.000Z", evEstimated: 0, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260705",
      model: null, rawResponse: null, raceSnapshotJson: null, historyCutoffDate: null, promptLookaheadGuarded: null, startTime: "?",
      ...over,
    };
  }
  it("'?' だけを数え、そのうち遮断済み(判定が時刻に依らない)の行は affecting に入れない", () => {
    const rows = [
      row({ id: 1 }), // 未遮断 → 影響しうる
      row({ id: 2, historyCutoffDate: "20260705", promptLookaheadGuarded: 1 }), // 遮断済み → 影響しない
      row({ id: 3, historyCutoffDate: "20260705", promptVersion: null }), // LLM 未使用で戦績側の印あり → 影響しない
      row({ id: 4, historyCutoffDate: "20260705", promptLookaheadGuarded: 0 }), // 明示的に未遮断 → 影響しうる
      row({ id: 5, startTime: "" }), // 詳細はあり、時刻が無いだけ → 数えない
      row({ id: 6, startTime: "15:45" }),
      row({ id: 7, startTime: null }),
    ];
    expect(countStartTimeGaps(rows)).toEqual({ lost: 4, affecting: 2 });
  });
  it("行が無いと 0", () => {
    expect(countStartTimeGaps([])).toEqual({ lost: 0, affecting: 0 });
  });
});
