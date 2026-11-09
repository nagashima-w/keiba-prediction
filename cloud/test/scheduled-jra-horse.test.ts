import { describe, expect, it } from "vitest";
import type { JraHorseBackfillNamespaceLike, RaceDayNamespaceLike } from "../src/handler";
import { jstMsOf } from "../src/monthly-month";
import type { ResultDb } from "../src/result-repository";
import { runScheduled, type ScheduledEnv } from "../src/scheduled";

/** Issue #697: cron の `scheduled` が、馬ごとの頁の埋め戻しの DO を kick する(21 時・23 時のどちらでも)。失敗しても握り、固定の分類だけをログに出す。新しい cron は足さない。 */

function baseEnv(planFails: boolean): ScheduledEnv {
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }), batch: async () => [] } as unknown as ResultDb;
  const raceDay = {
    idFromName: (n: string) => n,
    get: () => ({
      requestPlan: async () => {
        if (planFails) throw new Error("plan failed");
        return { accepted: true };
      },
    }),
  } as unknown as RaceDayNamespaceLike;
  return { RACE_DAY: raceDay, DB: db };
}

describe("馬ごとの頁の埋め戻しの kick", () => {
  it("21 時・23 時のどちらの実行でも、固定名 main の DO を 1 回ずつ kick する。計画が失敗した日も kick する", async () => {
    for (const hour of [21, 23]) {
      for (const planFails of [false, true]) {
        const names: string[] = [];
        let kicks = 0;
        const ns: JraHorseBackfillNamespaceLike = {
          idFromName: (n: string) => {
            names.push(n);
            return n;
          },
          get: () => ({
            kick: async () => {
              kicks += 1;
            },
          }),
        };
        const run = runScheduled({ scheduledTime: jstMsOf("20261110", hour) }, { ...baseEnv(planFails), JRA_HORSE_BACKFILL: ns }, { log: () => undefined, sleep: async () => {} });
        await (planFails ? run.catch(() => undefined) : run);
        expect(kicks, `hour=${hour} planFails=${String(planFails)}`).toBe(1);
        expect(names).toEqual(["main"]);
      }
    }
  });

  it("kick が失敗しても握る(例外を投げない)。ログは固定の分類だけで、例外のメッセージを含まない。binding が無い構成では何もしない", async () => {
    const logs: string[] = [];
    const ns: JraHorseBackfillNamespaceLike = {
      idFromName: (n: string) => n,
      get: () => ({
        kick: async () => {
          throw new Error("secret-detail");
        },
      }),
    };
    await runScheduled({ scheduledTime: jstMsOf("20261110", 21) }, { ...baseEnv(false), JRA_HORSE_BACKFILL: ns }, { log: (l: string) => void logs.push(l), sleep: async () => {} });
    const line = logs.find((l) => l.includes("jra-horse-backfill-kick-failed"));
    expect(line).toBeDefined();
    expect(line).not.toContain("secret-detail");
    await expect(runScheduled({ scheduledTime: jstMsOf("20261110", 21) }, baseEnv(false), { log: () => undefined, sleep: async () => {} })).resolves.not.toThrow();
  });
});
