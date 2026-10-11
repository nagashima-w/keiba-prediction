import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { AnalysisStore } from "../../src/ev/analysis-store.js";

/**
 * Issue #207(#182-A)AC-A1: exe の結果の保存・取得(saveResult・getRaceResultDetail)が発行する SQL 文の列を固定する(特性化テスト)。
 *
 * 目的: saveResult の SQL・束縛値の組み立て・`toStoredPassing`/`toStoredCourseType` を codec(analysis-store-codec.ts。D1 実装と共有)へ
 * 出しても、exe(better-sqlite3)が「同じ文を、同じ回数、同じ順序、同じ値で」発行することを保証する(exe の挙動・性能を変えない証拠)。
 * `analysis-store-sql-sequence.test.ts`(#168)が saveAnalysis 側で行ったのと同じ手法で、同ファイルは saveResult を対象にしていないため別ファイルにした。
 *
 * 期待値は **codec へ出す前の実装で実測した列**(better-sqlite3 の `verbose` が返す、束縛値を埋め込んだ実行時の SQL。空白は1つに畳む)。
 * 再現手順: `new Database(":memory:", { verbose })` を `AnalysisStore({ database })` に渡し、下の入力で saveResult・getRaceResultDetail を呼んで
 * `verbose`(実行)と `prepare`(文字列)の引数を集める。**このテストは切り出し前の実装に対しても全緑だった**(Red を持たない特性化テスト)。
 * 数値は REAL として束縛されるため `1.0` と表示される(better-sqlite3 は JS の number を REAL で束縛する)。
 */

const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();

function createRecordingStore(): { store: AnalysisStore; take: () => string[]; takePrepares: () => string[] } {
  const log: string[] = [];
  const prepares: string[] = [];
  let recording = false;
  const db = new Database(":memory:", {
    verbose: (sql?: unknown) => {
      if (recording) {
        log.push(normalize(String(sql)));
      }
    },
  });
  // prepare の呼び出しも記録する(verbose は「実行」しか拾わないので、行ごとの prepare し直しはこちらで検出する)。
  const originalPrepare = db.prepare.bind(db) as (sql: string) => unknown;
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (recording) {
      prepares.push(normalize(sql));
    }
    return originalPrepare(sql);
  };
  const store = new AnalysisStore({ database: db });
  recording = true;
  return { store, take: () => log.splice(0, log.length), takePrepares: () => prepares.splice(0, prepares.length) };
}

const RACE_ID = "202603020211";

const UPSERT_RESULT_PREPARED =
  "INSERT INTO race_results (race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id, umaban) DO UPDATE SET finish_position = excluded.finish_position, place_payout = excluded.place_payout, win_payout = excluded.win_payout, passing_json = excluded.passing_json, last3f = excluded.last3f";
const UPSERT_META_PREPARED =
  "INSERT INTO race_result_meta (race_id, course_type) VALUES (?, ?) ON CONFLICT(race_id) DO UPDATE SET course_type = excluded.course_type";
const DELETE_COMBO_PREPARED = "DELETE FROM race_combo_payouts WHERE race_id = ? AND bet_type = ?";
const INSERT_COMBO_PREPARED = "INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES (?, ?, ?, ?)";
const MARK_IMPORTED_PREPARED =
  "INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES (?, ?) ON CONFLICT(race_id, bet_type) DO NOTHING";
const SELECT_DETAIL_PREPARED =
  "SELECT umaban, finish_position AS finishPosition, passing_json AS passingJson, last3f FROM race_results WHERE race_id = ? ORDER BY umaban";
const SELECT_META_PREPARED = "SELECT course_type AS courseType FROM race_result_meta WHERE race_id = ?";

const UNDETERMINED = {
  state: "undetermined",
  reason: { kind: "payoutTableAbsent", message: "m", observedGroupCount: null, observedPayoutCount: null, rawHtml: null },
} as const;

function saveSample(store: AnalysisStore): void {
  store.saveResult(
    RACE_ID,
    [
      { umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 320, passing: [2, 2], last3f: 34.5 },
      { umaban: 2, finishPosition: null },
    ],
    "芝",
    {
      wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 500 }, { umabans: [1, 3], payout: 700 }] },
      trio: { state: "parsed", payouts: [] },
      exacta: { state: "parsed", payouts: [{ umabans: [13, 8], payout: 8360 }] },
      quinella: UNDETERMINED,
    },
  );
}

describe("AnalysisStore が発行する SQL 文の列(結果の保存・取得。#207 AC-A1。codec への切り出し前後で不変)", () => {
  it("saveResult: BEGIN → 馬ごとの UPSERT → 面 → 券種ごと〈DELETE → INSERT → マーカー。undetermined は何も発行しない〉→ COMMIT で、値の写しも固定", () => {
    const { store, take } = createRecordingStore();
    saveSample(store);
    expect(take()).toEqual([
      "BEGIN",
      `INSERT INTO race_results (race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f) VALUES ('${RACE_ID}', 1.0, 1.0, 150.0, 320.0, '[2,2]', 34.5) ON CONFLICT(race_id, umaban) DO UPDATE SET finish_position = excluded.finish_position, place_payout = excluded.place_payout, win_payout = excluded.win_payout, passing_json = excluded.passing_json, last3f = excluded.last3f`,
      `INSERT INTO race_results (race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f) VALUES ('${RACE_ID}', 2.0, NULL, NULL, NULL, '[]', NULL) ON CONFLICT(race_id, umaban) DO UPDATE SET finish_position = excluded.finish_position, place_payout = excluded.place_payout, win_payout = excluded.win_payout, passing_json = excluded.passing_json, last3f = excluded.last3f`,
      `INSERT INTO race_result_meta (race_id, course_type) VALUES ('${RACE_ID}', '芝') ON CONFLICT(race_id) DO UPDATE SET course_type = excluded.course_type`,
      `DELETE FROM race_combo_payouts WHERE race_id = '${RACE_ID}' AND bet_type = 'wide'`,
      `INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES ('${RACE_ID}', 'wide', '0102', 500.0)`,
      `INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES ('${RACE_ID}', 'wide', '0103', 700.0)`,
      `INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES ('${RACE_ID}', 'wide') ON CONFLICT(race_id, bet_type) DO NOTHING`,
      `DELETE FROM race_combo_payouts WHERE race_id = '${RACE_ID}' AND bet_type = 'trio'`,
      `INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES ('${RACE_ID}', 'trio') ON CONFLICT(race_id, bet_type) DO NOTHING`,
      `DELETE FROM race_combo_payouts WHERE race_id = '${RACE_ID}' AND bet_type = 'exacta'`,
      `INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES ('${RACE_ID}', 'exacta', '1308', 8360.0)`,
      `INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES ('${RACE_ID}', 'exacta') ON CONFLICT(race_id, bet_type) DO NOTHING`,
      "COMMIT",
    ]);
  });

  it("saveResult の prepare は5回(馬・面・DELETE・INSERT・マーカー)で、馬・券種・払戻の行数に依らない(行ごとに prepare し直さない)", () => {
    const { store, takePrepares } = createRecordingStore();
    saveSample(store);
    expect(takePrepares()).toEqual([
      UPSERT_RESULT_PREPARED,
      UPSERT_META_PREPARED,
      DELETE_COMBO_PREPARED,
      INSERT_COMBO_PREPARED,
      MARK_IMPORTED_PREPARED,
    ]);
  });

  it("saveResult(面・組合せ払戻とも省略): BEGIN → 馬 → COMMIT だけ(面の行も組合せの DELETE・マーカーも発行しない)", () => {
    const { store, take } = createRecordingStore();
    store.saveResult(RACE_ID, [{ umaban: 3, finishPosition: 2 }]);
    expect(take()).toEqual([
      "BEGIN",
      `INSERT INTO race_results (race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f) VALUES ('${RACE_ID}', 3.0, 2.0, NULL, NULL, '[]', NULL) ON CONFLICT(race_id, umaban) DO UPDATE SET finish_position = excluded.finish_position, place_payout = excluded.place_payout, win_payout = excluded.win_payout, passing_json = excluded.passing_json, last3f = excluded.last3f`,
      "COMMIT",
    ]);
  });

  it("getRaceResultDetail(結果あり): 馬の SELECT → 面の SELECT の2文で、prepare も同じ2回", () => {
    const { store, take, takePrepares } = createRecordingStore();
    saveSample(store);
    take();
    takePrepares();
    store.getRaceResultDetail(RACE_ID);
    expect(take()).toEqual([
      `SELECT umaban, finish_position AS finishPosition, passing_json AS passingJson, last3f FROM race_results WHERE race_id = '${RACE_ID}' ORDER BY umaban`,
      `SELECT course_type AS courseType FROM race_result_meta WHERE race_id = '${RACE_ID}'`,
    ]);
    expect(takePrepares()).toEqual([SELECT_DETAIL_PREPARED, SELECT_META_PREPARED]);
  });

  it("getRaceResultDetail(結果なし): 馬の SELECT 1文だけ(結果が無ければ面の SELECT は発行しない)", () => {
    const { store, take, takePrepares } = createRecordingStore();
    expect(store.getRaceResultDetail("nothing")).toBeUndefined();
    expect(take()).toEqual([
      "SELECT umaban, finish_position AS finishPosition, passing_json AS passingJson, last3f FROM race_results WHERE race_id = 'nothing' ORDER BY umaban",
    ]);
    expect(takePrepares()).toEqual([SELECT_DETAIL_PREPARED]);
  });
});
