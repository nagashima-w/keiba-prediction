import { describe, expect, it } from "vitest";

import type { DailyReportNamespaceLike, RaceDayNamespaceLike } from "../src/handler";
import type { RequestReportResult } from "../src/daily-report-core";
import { NEEDING_REPORT_SQL } from "../src/daily-report-repository";
import type { ResultDb } from "../src/result-repository";
import { REPORT_CATCHUP_DAYS, runScheduled, SCHEDULED_FAILURE_MESSAGE, type ScheduledEnv } from "../src/scheduled";

/**
 * Issue #235: cron の `scheduled` の、日報の取り残しの補完。前日以前の最大 REPORT_CATCHUP_DAYS 日で、分析があるのに日報が無い日を、日報の DO に `catchup` で依頼する。
 * **今日は依頼しない**(今日は日単位の DO が「静かになった」ときに依頼する。cron の時刻・曜日には依存しない)。補完の失敗は朝の計画・結果の取り込みを止めない。
 */

const JST_2300 = Date.parse("2026-10-10T14:00:00Z"); // JST 2026-10-10 23:00(再実行。日報の補完はこの実行だけ。Issue #249)
const JST_2100 = Date.parse("2026-10-10T12:00:00Z"); // JST 2026-10-10 21:00(1 本目。補完しない)

interface Harness {
  readonly binds: unknown[][];
  readonly requests: Array<{ kaisaiDate: string; mode: string }>;
  readonly names: string[];
  readonly logs: string[];
  dates: string[];
  dbFails: boolean;
  requestImpl: (kaisaiDate: string) => Promise<RequestReportResult>;
  planFails: boolean;
  env(withReport?: boolean): ScheduledEnv;
}

function harness(): Harness {
  const h: Harness = {
    binds: [],
    requests: [],
    names: [],
    logs: [],
    dates: [],
    dbFails: false,
    requestImpl: async () => ({ accepted: true }),
    planFails: false,
    env: (withReport = true) => {
      const db = {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            all: async () => {
              if (sql === NEEDING_REPORT_SQL) {
                h.binds.push(args);
                if (h.dbFails) throw new Error("D1 の詳細 SECRET-D1");
                return { results: h.dates.map((kaisaiDate) => ({ kaisaiDate })) };
              }
              return { results: [] }; // 結果の依頼の列挙は空
            },
          }),
        }),
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
      const report: DailyReportNamespaceLike = {
        idFromName: (name: string) => {
          h.names.push(name);
          return name;
        },
        get: () => ({
          requestReport: async (input) => {
            h.requests.push({ kaisaiDate: input.kaisaiDate, mode: input.mode });
            return h.requestImpl(input.kaisaiDate);
          },
          getStatus: async () => null,
        }),
      };
      return { RACE_DAY: raceDay, DB: db, ...(withReport ? { DAILY_REPORT: report } : {}) };
    },
  };
  return h;
}

const deps = (h: Harness) => ({ log: (line: string) => void h.logs.push(line), sleep: async () => {}, });

describe("日報の取り残しの補完(cron)", () => {
  it(`今日の前日までの ${REPORT_CATCHUP_DAYS} 日(両端を含む)を D1 に問い合わせ、返った日を日報の DO(main)へ catchup で依頼する。今日は範囲に含めない`, async () => {
    const h = harness();
    h.dates = ["20261007", "20261009"];
    await runScheduled({ scheduledTime: JST_2300 }, h.env(), deps(h));
    expect(REPORT_CATCHUP_DAYS).toBe(3);
    expect(h.binds).toEqual([["20261007", "20261009"]]); // 今日 20261010 の 3 日前〜前日
    expect(h.requests).toEqual([
      { kaisaiDate: "20261007", mode: "catchup" },
      { kaisaiDate: "20261009", mode: "catchup" },
    ]);
    expect(h.names.every((n) => n === "main")).toBe(true);
  });

  it("Issue #249: 21 時の実行(1 本目)は、日報の補完をしない(D1 も引かない・依頼もしない)。補完は 23 時の再実行だけ", async () => {
    const h = harness();
    h.dates = ["20261009"];
    await runScheduled({ scheduledTime: JST_2100 }, h.env(), deps(h));
    expect(h.binds).toEqual([]);
    expect(h.requests).toEqual([]);
    // 対照: 同じ構成で 23 時の再実行なら補完する(上の検査が、補完の無い構成で自明に通っていない)
    await runScheduled({ scheduledTime: JST_2300 }, h.env(), deps(h));
    expect(h.requests).toEqual([{ kaisaiDate: "20261009", mode: "catchup" }]);
  });

  it("月またぎでも日付の計算が合う(10/2 23 時の cron → 9/29〜10/1)", async () => {
    const h = harness();
    await runScheduled({ scheduledTime: Date.parse("2026-10-02T14:00:00Z") }, h.env(), deps(h));
    expect(h.binds).toEqual([["20260929", "20261001"]]);
  });

  it("取り残しが無ければ依頼しない。作成済み・作成中の断り(accepted: false)は失敗として扱わない", async () => {
    const h = harness();
    await runScheduled({ scheduledTime: JST_2300 }, h.env(), deps(h));
    expect(h.requests).toEqual([]);
    h.dates = ["20261008", "20261009"];
    h.requestImpl = async (d) => (d === "20261008" ? { accepted: false, reason: "exists" } : { accepted: false, reason: "in-progress" });
    await expect(runScheduled({ scheduledTime: JST_2300 }, h.env(), deps(h))).resolves.toBeUndefined();
    expect(h.logs.join("\n")).not.toContain("class=");
  });

  it("日報の DO の binding が無い構成では、補完をしない(D1 も引かない)・落ちない", async () => {
    const h = harness();
    h.dates = ["20261009"];
    await runScheduled({ scheduledTime: JST_2300 }, h.env(false), deps(h));
    expect(h.binds).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  it("D1 の列挙が失敗しても、朝の計画を失敗させない(分類だけをログに出し、例外の文面は出さない)", async () => {
    const h = harness();
    h.dbFails = true;
    await expect(runScheduled({ scheduledTime: JST_2300 }, h.env(), deps(h))).resolves.toBeUndefined();
    expect(h.logs.join("\n")).toContain("class=report-catchup-failed");
    expect(h.logs.join("\n")).not.toContain("SECRET-D1");
  });

  it("1 日の依頼が失敗しても、残りの日の依頼を続け、朝の計画を失敗させない", async () => {
    const h = harness();
    h.dates = ["20261007", "20261008", "20261009"];
    h.requestImpl = async (d) => {
      if (d === "20261008") throw new Error("DO の詳細 SECRET-DO");
      return { accepted: true };
    };
    await expect(runScheduled({ scheduledTime: JST_2300 }, h.env(), deps(h))).resolves.toBeUndefined();
    expect(h.requests.map((r) => r.kaisaiDate)).toEqual(["20261007", "20261008", "20261009"]);
    expect(h.logs.join("\n")).toContain("class=report-catchup-failed");
    expect(h.logs.join("\n")).not.toContain("SECRET-DO");
  });

  it("朝の計画の依頼が失敗して例外になる日でも、日報の補完は走る(補完は計画の成否によらない)", async () => {
    const h = harness();
    h.dates = ["20261009"];
    h.planFails = true;
    await expect(runScheduled({ scheduledTime: JST_2300 }, h.env(), deps(h))).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(h.requests).toEqual([{ kaisaiDate: "20261009", mode: "catchup" }]);
  });
});
