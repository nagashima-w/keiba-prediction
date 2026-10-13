import { afterEach, describe, expect, it } from "vitest";

import { NarTrifectaStore, NAR_TRIFECTA_AXES_PER_STEP } from "../src/race-day-nar-trifecta";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #283: 地方三連単の軸ごとの取得(別のアラームの段階)の進み具合の表 `race_day_nar_trifecta`。
 * 純粋な表の操作(取得そのものは `race-day-nar-trifecta-stage.test.ts`)。
 * キーは (race_id, instance=タスクの queued_at, axis)。state は pending → fetched | failed。
 */

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function store(): { readonly store: NarTrifectaStore; readonly sql: NodeSql } {
  const sql = openNodeSql();
  opened.push(sql);
  // 孤立の掃除が参照するタスクの表(RaceDayCore が作るものと同じ列のうち、使うものだけ)
  sql.exec("CREATE TABLE race_day_tasks (race_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, queued_at INTEGER NOT NULL, PRIMARY KEY (race_id, mode))");
  return { store: new NarTrifectaStore(sql), sql };
}

const RACE = "202654071210";
const ALL_12 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

describe("NAR_TRIFECTA_AXES_PER_STEP", () => {
  it("1アラームあたり 9 軸(Issue #283。18頭立てでも 2 アラームに収まり、どのプランの上限 50 も十分に下回る)", () => {
    expect(NAR_TRIFECTA_AXES_PER_STEP).toBe(9);
    expect(Math.ceil(18 / NAR_TRIFECTA_AXES_PER_STEP)).toBe(2);
  });
});

describe("NarTrifectaStore: 軸の登録と未取得の取り出し", () => {
  it("begin で全軸が pending になり、pendingAxes は昇順に、上限の件数だけ返す", () => {
    const { store: s } = store();
    s.begin(RACE, 100, [3, 1, 2, 12, 5]);
    expect(s.hasPending(RACE, 100)).toBe(true);
    expect(s.pendingAxes(RACE, 100, 3)).toEqual([1, 2, 3]);
    expect(s.pendingAxes(RACE, 100, 99)).toEqual([1, 2, 3, 5, 12]);
  });

  it("軸が 0 件(3頭未満)の begin は pending を作らない(段階を飛ばす)", () => {
    const { store: s } = store();
    s.begin(RACE, 100, []);
    expect(s.hasPending(RACE, 100)).toBe(false);
  });

  it("取得の結果(fetched・failed)を書いた軸は pending から外れ、再開時に取り直されない。pending が無くなれば hasPending は false", () => {
    const { store: s } = store();
    s.begin(RACE, 100, ALL_12);
    s.mark(RACE, 100, 1, "fetched");
    s.mark(RACE, 100, 2, "failed");
    expect(s.pendingAxes(RACE, 100, 99)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const axis of ALL_12) s.mark(RACE, 100, axis, "fetched");
    expect(s.hasPending(RACE, 100)).toBe(false);
  });

  it("failAllPending: 残りの pending を failed にする(ブレーカーが開いたときの打ち切り)。すでに fetched の軸は変えない", () => {
    const { store: s } = store();
    s.begin(RACE, 100, [1, 2, 3, 4]);
    s.mark(RACE, 100, 1, "fetched");
    const changed = s.failAllPending(RACE, 100);
    expect(changed).toBe(3);
    expect(s.hasPending(RACE, 100)).toBe(false);
    expect(s.counts(RACE, 100)).toEqual({ pending: 0, fetched: 1, failed: 3 });
  });
});

describe("NarTrifectaStore: インスタンス(queued_at)での分離", () => {
  it("別のインスタンス(再予約された別の実行)の行は読まない。begin は同じレースの古い行を消す", () => {
    const { store: s } = store();
    s.begin(RACE, 100, [1, 2, 3]);
    expect(s.hasPending(RACE, 200)).toBe(false); // 別のインスタンスからは見えない
    s.begin(RACE, 200, [4, 5, 6]); // 新しい実行
    expect(s.hasPending(RACE, 100)).toBe(false); // 古い行は消えている
    expect(s.pendingAxes(RACE, 200, 99)).toEqual([4, 5, 6]);
  });

  it("別のレースの行には触らない", () => {
    const { store: s } = store();
    s.begin(RACE, 100, [1, 2, 3]);
    s.begin("202654071211", 100, [1, 2, 3]);
    s.clear(RACE);
    expect(s.hasPending(RACE, 100)).toBe(false);
    expect(s.hasPending("202654071211", 100)).toBe(true);
  });
});

describe("NarTrifectaStore: 孤立した行の掃除", () => {
  it("進行中(queued・fetched)の pre_race のタスクが無い・インスタンスが違う行は消し、一致する進行中の行は残す", () => {
    const { store: s, sql } = store();
    sql.exec("INSERT INTO race_day_tasks VALUES (?, 'pre_race', 'fetched', 100)", RACE); // 進行中・インスタンス 100
    sql.exec("INSERT INTO race_day_tasks VALUES (?, 'pre_race', 'done', 100)", "202654071211"); // 終わっている
    s.begin(RACE, 100, [1, 2]); // 一致 → 残る
    s.begin("202654071211", 100, [1, 2]); // 終わったタスク → 孤立
    s.begin("202654071212", 100, [1, 2]); // タスクが無い → 孤立
    s.clearOrphans();
    expect(s.hasPending(RACE, 100)).toBe(true);
    expect(s.hasPending("202654071211", 100)).toBe(false);
    expect(s.hasPending("202654071212", 100)).toBe(false);
  });

  it("タスクのインスタンス(queued_at)が違えば孤立(再予約された別の実行の行は残らない)", () => {
    const { store: s, sql } = store();
    sql.exec("INSERT INTO race_day_tasks VALUES (?, 'pre_race', 'queued', 300)", RACE);
    s.begin(RACE, 100, [1, 2]);
    s.clearOrphans();
    expect(s.hasPending(RACE, 100)).toBe(false);
  });
});
