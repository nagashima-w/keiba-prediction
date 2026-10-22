import { describe, expect, it } from "vitest";

import { PlanStore, type PlanRowRecord } from "../src/race-day-plan";
import { PromoteStage } from "../src/race-day-promote-stage";
import { openNodeSql } from "./node-sql";

/**
 * 計画の昇格の段階(`PromoteStage`)そのものの単体テスト(Issue #446)。段階を `RaceDayCore` なしで組み立て、
 * **警告の出口に、鍵を伏せる包みを通さない素の関数を渡す**。本体(`RaceDayCore`)は段階に包み済みの `onWarn` を渡すので、
 * 本体を通したテストでは「段階が自分でも鍵の形を伏せる」ことが見えない(本体の包みだけで伏せたようにも見える)。
 * 段階の警告の文面は、出口がどんなものでも鍵の形を含まない、という段階の契約をここで固定する。
 */

const NOW = Date.parse("2026-09-27T00:15:00Z");
const RACE = "202606040901";
const SECRET = "sk-ant-api03-ZZZZsecretkey123456";

function plannedRow(): PlanRowRecord {
  return {
    race_id: RACE,
    venue: "central",
    venue_name: "東京",
    race_number: 1,
    race_name: "テスト",
    grade: null,
    start_time: "10:00",
    start_ms: NOW + 45 * 60_000,
    due_ms: NOW,
    offset_minutes: 45,
    disposition: "scheduled",
    skip_reason: null,
    state: "planned",
    planned_at: NOW - 60 * 60_000,
    promoted_at: null,
  };
}

describe("PromoteStage: 手動の分析の確認の失敗の警告は、出口が素の関数でも鍵の形を伏せる", () => {
  it("D1 の例外の文面にある sk-ant-… は、段階が自分で伏せる(伏せ字は 1 回分。本体の包みに頼らない)", async () => {
    const sql = openNodeSql();
    sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); // 本体が作る表(`PlanStore` が meta に確定の印を書く)
    const plan = new PlanStore(sql);
    plan.insertPlanRow(plannedRow());
    plan.markFinalized(NOW - 1000);
    expect(plan.dueRows(NOW)).toHaveLength(1); // 前提: 昇格の対象の行がある
    const warnings: string[] = [];
    const enqueued: string[] = [];
    const stage = new PromoteStage({
      plan,
      sink: {
        async findRecentByRace() {
          throw new Error(`D1 が落ちた ${SECRET}`);
        },
      },
      loadSettings: undefined,
      now: () => NOW,
      onWarn: (message) => warnings.push(message), // 本体の包みを通さない素の出口
      task: () => ({ status: "done", queued_at: NOW - 10 * 60_000 }), // 既存の pre_race(done)があるので、D1 に聞きに行く
      taskCount: () => 1,
      enqueueTask: (raceId) => enqueued.push(raceId),
      maxTasksPerDay: 100,
      manualDuplicateWindowMs: 15 * 60_000,
    });

    await stage.promoteDue();

    expect(warnings).toHaveLength(1); // 前提: 確認の失敗の警告が 1 件出ている
    expect(warnings[0]).toContain("D1 が落ちた sk-ant-***");
    expect(warnings[0]).not.toContain("ZZZZsecretkey");
    expect(enqueued).toEqual([RACE]); // 失敗は重複なしとして続け、昇格する
  });
});
