import { describe, expect, it } from "vitest";
import type { RaceDayNamespaceLike, VerifyNamespaceLike } from "../src/handler";
import { jstMsOf } from "../src/monthly-month";
import type { ResultDb } from "../src/result-repository";
import { runScheduled, type ScheduledEnv } from "../src/scheduled";

/** Issue #723: cron の `scheduled` が、検証の DO に週 1 回の突き合わせの依頼(`requestWeeklyCheck`)を出す。21 時・23 時のどちらでも呼び(判断は DO)、失敗は握る。新しい cron は足さない。 */

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

describe("検証の週 1 回の突き合わせの依頼", () => {
  it("21 時・23 時のどちらの実行でも、固定名 main の検証の DO に 1 回ずつ依頼する。計画が失敗した日も依頼する", async () => {
    for (const hour of [21, 23]) {
      for (const planFails of [false, true]) {
        const names: string[] = [];
        let calls = 0;
        const ns = {
          idFromName: (n: string) => {
            names.push(n);
            return n;
          },
          get: () => ({
            requestWeeklyCheck: async () => {
              calls += 1;
            },
          }),
        } as unknown as VerifyNamespaceLike;
        const run = runScheduled({ scheduledTime: jstMsOf("20261110", hour) }, { ...baseEnv(planFails), VERIFY_REPORT: ns }, { log: () => undefined, sleep: async () => {} });
        await (planFails ? run.catch(() => undefined) : run);
        expect(calls, `hour=${hour} planFails=${String(planFails)}`).toBe(1);
        expect(names).toEqual(["main"]);
      }
    }
  });

  it("依頼が失敗しても握る(例外を投げない)。ログは固定の分類だけで、例外のメッセージを含まない。binding が無い構成では何もしない", async () => {
    const logs: string[] = [];
    const ns = {
      idFromName: (n: string) => n,
      get: () => ({
        requestWeeklyCheck: async () => {
          throw new Error("secret-detail");
        },
      }),
    } as unknown as VerifyNamespaceLike;
    await runScheduled({ scheduledTime: jstMsOf("20261110", 21) }, { ...baseEnv(false), VERIFY_REPORT: ns }, { log: (l: string) => void logs.push(l), sleep: async () => {} });
    const line = logs.find((l) => l.includes("verify-weekly-check-failed"));
    expect(line).toBeDefined();
    expect(line).not.toContain("secret-detail");
    await expect(runScheduled({ scheduledTime: jstMsOf("20261110", 21) }, baseEnv(false), { log: () => undefined, sleep: async () => {} })).resolves.not.toThrow();
  });
});
