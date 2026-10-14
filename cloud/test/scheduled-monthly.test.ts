import { describe, expect, it } from "vitest";
import type { MonthlyReportNamespaceLike, RaceDayNamespaceLike } from "../src/handler";
import type { RequestMonthlyResult } from "../src/monthly-report-core";
import { jstMsOf } from "../src/monthly-month";
import type { ResultDb } from "../src/result-repository";
import { runScheduled, type ScheduledEnv } from "../src/scheduled";

/**
 * Issue #279(#265-A): cron の `scheduled` の、月報の依頼。新しい cron は足さない: 最終日の 21:00 の実行が「22:00 開始」の auto を依頼し、23:00 の実行は保険の auto と、月が明けて 3 日以内の前月の catchup を依頼する。
 * 月報の依頼の失敗は、事前分析の計画・結果の取り込み・日報の補完を止めない(分類だけをログに出す)。
 */

const at = (ymd: string, hour: number): number => jstMsOf(ymd, hour);

interface Harness {
  readonly requests: Array<{ month: string; mode: string; startAt?: number }>;
  readonly names: string[];
  readonly logs: string[];
  requestImpl: (month: string) => Promise<RequestMonthlyResult>;
  planFails: boolean;
  env(withMonthly?: boolean): ScheduledEnv;
}

function harness(): Harness {
  const h: Harness = {
    requests: [],
    names: [],
    logs: [],
    requestImpl: async () => ({ accepted: true }),
    planFails: false,
    env: (withMonthly = true) => {
      const db = {
        prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
        batch: async () => [],
      } as unknown as ResultDb;
      const raceDay = {
        idFromName: (n: string) => n,
        get: () => ({
          requestPlan: async () => {
            if (h.planFails) throw new Error("plan failed");
            return { accepted: true };
          },
        }),
      } as unknown as RaceDayNamespaceLike;
      const monthly: MonthlyReportNamespaceLike = {
        idFromName: (name: string) => {
          h.names.push(name);
          return name;
        },
        get: () => ({
          requestMonthlyReport: async (input) => {
            h.requests.push(input);
            return h.requestImpl(input.month);
          },
          getStatus: async () => null,
        }),
      };
      return { RACE_DAY: raceDay, DB: db, ...(withMonthly ? { MONTHLY_REPORT: monthly } : {}) };
    },
  };
  return h;
}

const deps = (h: Harness) => ({ log: (line: string) => void h.logs.push(line), sleep: async () => {} });

describe("月報の依頼(cron)", () => {
  it("最終日の 21:00 の実行(1 本目)は、当月を auto で、同日 22:00 JST 開始で依頼する。月報の DO の名前は main", async () => {
    const h = harness();
    await runScheduled({ scheduledTime: at("20261031", 21) }, h.env(), deps(h));
    expect(h.requests).toEqual([{ month: "202610", mode: "auto", startAt: at("20261031", 22) }]);
    expect(h.names).toEqual(["main"]);
  });

  it("最終日の 23:00 の実行(再実行)も同じ依頼を出す(21:00 の依頼が落ちたときの保険)", async () => {
    const h = harness();
    await runScheduled({ scheduledTime: at("20261031", 23) }, h.env(), deps(h));
    expect(h.requests).toEqual([{ month: "202610", mode: "auto", startAt: at("20261031", 22) }]);
  });

  it("月が明けて 1〜3 日の 23:00 の実行は前月を catchup で依頼する。21:00 の実行は依頼しない。4 日以降も依頼しない", async () => {
    const h = harness();
    await runScheduled({ scheduledTime: at("20261101", 23) }, h.env(), deps(h));
    await runScheduled({ scheduledTime: at("20261103", 23) }, h.env(), deps(h));
    expect(h.requests).toEqual([
      { month: "202610", mode: "catchup" },
      { month: "202610", mode: "catchup" },
    ]);
    const quiet = harness();
    await runScheduled({ scheduledTime: at("20261101", 21) }, quiet.env(), deps(quiet));
    await runScheduled({ scheduledTime: at("20261104", 23) }, quiet.env(), deps(quiet));
    await runScheduled({ scheduledTime: at("20261015", 23) }, quiet.env(), deps(quiet));
    expect(quiet.requests).toEqual([]);
  });

  it("月報の DO の binding が無い構成では依頼しない・落ちない", async () => {
    const h = harness();
    await expect(runScheduled({ scheduledTime: at("20261031", 21) }, h.env(false), deps(h))).resolves.toBeUndefined();
    expect(h.requests).toEqual([]);
  });

  it("作成済み・作成中の断り(accepted: false)は失敗として扱わない(ログは分類つきのエラーにならない)", async () => {
    const h = harness();
    h.requestImpl = async () => ({ accepted: false, reason: "exists" });
    await expect(runScheduled({ scheduledTime: at("20261031", 23) }, h.env(), deps(h))).resolves.toBeUndefined();
    expect(h.logs.join("\n")).toContain("monthly-report month=202610 mode=auto accepted=false reason=exists");
    expect(h.logs.join("\n")).not.toContain("class=");
  });

  it("依頼の失敗(DO の例外)は、事前分析の計画を失敗させない。分類だけをログに出し、例外の文面は出さない", async () => {
    const h = harness();
    h.requestImpl = async () => {
      throw new Error("DO の詳細 SECRET-DO");
    };
    await expect(runScheduled({ scheduledTime: at("20261031", 21) }, h.env(), deps(h))).resolves.toBeUndefined();
    const log = h.logs.join("\n");
    expect(log).toContain("class=monthly-report-failed");
    expect(log).toContain("month=202610");
    expect(log).not.toContain("SECRET-DO");
  });

  it("事前分析の計画が失敗しても、月報の依頼は出す(計画の失敗は投げるが、月報の依頼は先に済んでいる)", async () => {
    const h = harness();
    h.planFails = true;
    await expect(runScheduled({ scheduledTime: at("20261031", 21) }, h.env(), deps(h))).rejects.toThrow();
    expect(h.requests).toEqual([{ month: "202610", mode: "auto", startAt: at("20261031", 22) }]);
  });
});
