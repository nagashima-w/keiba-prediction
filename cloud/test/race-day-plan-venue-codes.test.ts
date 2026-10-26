import { afterEach, describe, expect, it } from "vitest";

import { PlanStore } from "../src/race-day-plan";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #480: 計画の中央の行にある場コード(`PlanStore.centralVenueCodes`)。馬場の取得の「その日の全部の場」(そろった判定の分母)に使う。
 * 中央の行の race_id(年 4 桁 + 場コード 2 桁 + …)から場コードを取る。地方の行・場コードが JRA の 01〜10 でない行は入れない。
 */

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function store(): { plan: PlanStore; sql: NodeSql } {
  const sql = openNodeSql();
  opened.push(sql);
  sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return { plan: new PlanStore(sql), sql };
}

function insert(sql: NodeSql, raceId: string, venue: "central" | "nar"): void {
  sql.exec(
    "INSERT INTO race_day_plan (race_id, venue, offset_minutes, disposition, state, planned_at) VALUES (?, ?, 45, 'scheduled', 'planned', 1)",
    raceId,
    venue,
  );
}

describe("PlanStore.centralVenueCodes", () => {
  it("行が無ければ空", () => {
    expect(store().plan.centralVenueCodes()).toEqual([]);
  });

  it("中央の行の場コードを、重複なし・コード順で返す(同じ場の複数レースは 1 つ)", () => {
    const { plan, sql } = store();
    for (const id of ["202608030911", "202608030901", "202605040101", "202604030201", "202605040102"]) insert(sql, id, "central");
    expect(plan.centralVenueCodes()).toEqual(["04", "05", "08"]);
  });

  it("地方の行は入れない(地方の場コードは 30 以上で、同じ DO に入っても混ざらない)", () => {
    const { plan, sql } = store();
    insert(sql, "202605040101", "central");
    insert(sql, "202645100101", "nar");
    expect(plan.centralVenueCodes()).toEqual(["05"]);
  });

  it("中央の行でも、場コードが JRA の 01〜10 でないものは入れない(壊れた race_id を分母に入れて、永遠にそろわなくしない)", () => {
    const { plan, sql } = store();
    insert(sql, "202605040101", "central");
    insert(sql, "202611040101", "central"); // 11
    insert(sql, "202600040101", "central"); // 00
    insert(sql, "20260X040101", "central");
    expect(plan.centralVenueCodes()).toEqual(["05"]);
  });
});
