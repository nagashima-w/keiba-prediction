import { describe, expect, it } from "vitest";

import {
  COMBO_BET_TYPES,
  DELETE_COMBO_PAYOUTS_SQL,
  INSERT_COMBO_PAYOUT_SQL,
  MARK_COMBO_IMPORTED_SQL,
  SELECT_RESULT_DETAIL_SQL,
  SELECT_RESULT_META_SQL,
  UPSERT_RACE_RESULT_META_SQL,
  UPSERT_RACE_RESULT_SQL,
  comboPayoutParams,
  planComboWrites,
  raceResultParams,
  toRaceResultDetail,
  toStoredCourseType,
  toStoredPassing,
} from "../../src/ev/analysis-store-codec.js";
import { COMBO_SIZE } from "../../src/scraper/combo-odds-key.js";
import type { RaceComboPayoutsSaveInput } from "../../src/ev/analysis-store-types.js";

/**
 * Issue #207(#182-A)AC-A1: 結果の保存・取得の変換(codec。better-sqlite3 に依存しない純関数)の単体テスト。
 *
 * exe の AnalysisStore.saveResult と、クラウド版(D1。cloud/src/result-repository.ts)が**同じ SQL・同じ束縛値の変換・同じ復元**を共有する。
 * 2実装で変換が食い違うと、同じ結果が実装によって違う値で保存・復元される(#168 の codec と同じ理由)。
 * exe 側の SQL の発行列は `analysis-store-result-sql-sequence.test.ts`(特性化テスト)が固定している。
 */

const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();

describe("SQL 文(テーブル名・列の順序の唯一のソース。切り出し前の文字列と一致)", () => {
  it.each([
    [
      "馬ごとの UPSERT",
      UPSERT_RACE_RESULT_SQL,
      "INSERT INTO race_results (race_id, umaban, finish_position, place_payout, win_payout, passing_json, last3f) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(race_id, umaban) DO UPDATE SET finish_position = excluded.finish_position, place_payout = excluded.place_payout, win_payout = excluded.win_payout, passing_json = excluded.passing_json, last3f = excluded.last3f",
    ],
    [
      "面の UPSERT",
      UPSERT_RACE_RESULT_META_SQL,
      "INSERT INTO race_result_meta (race_id, course_type) VALUES (?, ?) ON CONFLICT(race_id) DO UPDATE SET course_type = excluded.course_type",
    ],
    ["組合せ払戻の DELETE", DELETE_COMBO_PAYOUTS_SQL, "DELETE FROM race_combo_payouts WHERE race_id = ? AND bet_type = ?"],
    [
      "組合せ払戻の INSERT",
      INSERT_COMBO_PAYOUT_SQL,
      "INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES (?, ?, ?, ?)",
    ],
    [
      "取込マーカー",
      MARK_COMBO_IMPORTED_SQL,
      "INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES (?, ?) ON CONFLICT(race_id, bet_type) DO NOTHING",
    ],
    [
      "結果の復元(馬)",
      SELECT_RESULT_DETAIL_SQL,
      "SELECT umaban, finish_position AS finishPosition, passing_json AS passingJson, last3f FROM race_results WHERE race_id = ? ORDER BY umaban",
    ],
    ["結果の復元(面)", SELECT_RESULT_META_SQL, "SELECT course_type AS courseType FROM race_result_meta WHERE race_id = ?"],
  ])("%s", (_name, sql, expected) => {
    expect(normalize(sql)).toBe(expected);
  });
});

describe("COMBO_BET_TYPES(券種一覧の単一ソース)", () => {
  it("COMBO_SIZE のキーと同じ6券種を、同じ順で持つ", () => {
    expect(COMBO_BET_TYPES).toEqual(Object.keys(COMBO_SIZE));
    expect(COMBO_BET_TYPES).toHaveLength(6);
  });
});

describe("raceResultParams(馬ごとの束縛値。SQL の ? の順)", () => {
  it("全項目あり: race_id・umaban・着順・複勝・単勝・通過順の JSON・上がり3F の順", () => {
    expect(
      raceResultParams("R1", { umaban: 3, finishPosition: 2, placePayout: 150, winPayout: 320, passing: [2, 3, 4, 3], last3f: 34.5 }),
    ).toEqual(["R1", 3, 2, 150, 320, "[2,3,4,3]", 34.5]);
  });

  it("省略した項目は null(passing は空配列の JSON)。着順 null(非数値着順)は null のまま", () => {
    expect(raceResultParams("R1", { umaban: 4, finishPosition: null })).toEqual(["R1", 4, null, null, null, "[]", null]);
  });

  it("0 は 0 のまま保たれる(null に潰さない)", () => {
    expect(raceResultParams("R1", { umaban: 5, finishPosition: 0, placePayout: 0, winPayout: 0, last3f: 0 })).toEqual([
      "R1",
      5,
      0,
      0,
      0,
      "[]",
      0,
    ]);
  });

  it("列の数は UPSERT 文の ? の数と一致する", () => {
    const placeholders = (UPSERT_RACE_RESULT_SQL.match(/\?/g) ?? []).length;
    expect(raceResultParams("R1", { umaban: 1, finishPosition: 1 })).toHaveLength(placeholders);
    expect(placeholders).toBe(7);
  });
});

describe("comboPayoutParams(組合せ払戻の束縛値。betType 別の順序方針でキー化)", () => {
  it.each([
    ["wide", [3, 1], "0103"],
    ["trio", [5, 1, 3], "010305"],
    ["quinella", [8, 2], "0208"],
    ["bracketQuinella", [1, 1], "0101"],
    ["exacta", [13, 8], "1308"],
    ["trifecta", [5, 7, 1], "050701"],
  ] as const)("%s %j → キー %s(順不同の券種はソート、馬単・三連単は着順のまま)", (betType, umabans, key) => {
    expect(comboPayoutParams("R1", betType, { umabans, payout: 1230 })).toEqual(["R1", betType, key, 1230]);
  });

  it("馬単の逆順2組(13→8 と 8→13)は別のキーになる(ソートして潰さない)", () => {
    const a = comboPayoutParams("R1", "exacta", { umabans: [13, 8], payout: 1 })[2];
    const b = comboPayoutParams("R1", "exacta", { umabans: [8, 13], payout: 2 })[2];
    expect(a).not.toBe(b);
  });

  it("列の数は INSERT 文の ? の数と一致する", () => {
    expect(comboPayoutParams("R1", "wide", { umabans: [1, 2], payout: 100 })).toHaveLength(
      (INSERT_COMBO_PAYOUT_SQL.match(/\?/g) ?? []).length,
    );
  });
});

describe("planComboWrites(どの券種を書くか。undetermined・省略は触れない)", () => {
  const undetermined = {
    state: "undetermined",
    reason: { kind: "payoutTableAbsent", message: "m", observedGroupCount: null, observedPayoutCount: null, rawHtml: null },
  } as const;

  it("省略・undefined は空", () => {
    expect(planComboWrites(undefined)).toEqual([]);
    expect(planComboWrites({})).toEqual([]);
  });

  it("undetermined の券種は含めない(既存の行・マーカーに触れない)", () => {
    const input: RaceComboPayoutsSaveInput = { wide: undetermined, trio: undetermined };
    expect(planComboWrites(input)).toEqual([]);
  });

  it("parsed は含める。payouts が空でも含める(マーカーだけを書くため)。並びは COMBO_BET_TYPES の順で、入力のキーの順に依らない", () => {
    const input: RaceComboPayoutsSaveInput = {
      trifecta: { state: "parsed", payouts: [{ umabans: [1, 2, 3], payout: 9000 }] },
      wide: { state: "parsed", payouts: [] },
      quinella: undetermined,
      exacta: { state: "parsed", payouts: [{ umabans: [2, 1], payout: 500 }] },
    };
    const plan = planComboWrites(input);
    expect(plan.map((p) => p.betType)).toEqual(["wide", "exacta", "trifecta"]);
    expect(plan[0]!.payouts).toEqual([]);
    expect(plan[1]!.payouts).toEqual([{ umabans: [2, 1], payout: 500 }]);
  });
});

describe("toStoredPassing(通過順の防御的復元)", () => {
  it.each([
    ["null(未保存)", null, []],
    ["正常", "[2,3,4,3]", [2, 3, 4, 3]],
    ["空配列", "[]", []],
    ["壊れた JSON", "[2,", []],
    ["配列でない", '{"a":1}', []],
    ["数値でない要素が混ざる", '[1,"2"]', []],
    ["null 要素が混ざる", "[1,null]", []],
  ] as const)("%s", (_name, raw, expected) => {
    expect(toStoredPassing(raw)).toEqual(expected);
  });
});

describe("toStoredCourseType(面の防御的復元)", () => {
  it.each([
    ["芝", "芝"],
    ["ダ", "ダ"],
    ["障", "障"],
    [null, null],
    ["", null],
    ["ダート", null],
    ["turf", null],
  ] as const)("%j → %j", (raw, expected) => {
    expect(toStoredCourseType(raw)).toBe(expected);
  });
});

describe("toRaceResultDetail(行 → 結果詳細)", () => {
  it("馬の行をそのままの順で写し、通過順・面を防御的に復元する", () => {
    expect(
      toRaceResultDetail(
        [
          { umaban: 1, finishPosition: 1, passingJson: "[2,2]", last3f: 34.5 },
          { umaban: 2, finishPosition: null, passingJson: null, last3f: null },
          { umaban: 3, finishPosition: 3, passingJson: "broken", last3f: 0 },
        ],
        "ダ",
      ),
    ).toEqual({
      courseType: "ダ",
      horses: [
        { umaban: 1, finishPosition: 1, passing: [2, 2], last3f: 34.5 },
        { umaban: 2, finishPosition: null, passing: [], last3f: null },
        { umaban: 3, finishPosition: 3, passing: [], last3f: 0 },
      ],
    });
  });

  it("面の行が無い(null)・未知の文字列は courseType null", () => {
    const rows = [{ umaban: 1, finishPosition: 1, passingJson: "[]", last3f: null }];
    expect(toRaceResultDetail(rows, null).courseType).toBeNull();
    expect(toRaceResultDetail(rows, "謎").courseType).toBeNull();
  });
});
