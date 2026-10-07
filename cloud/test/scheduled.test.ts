import { afterEach, describe, expect, it, vi } from "vitest";

import type { RaceDayNamespaceLike, RaceDayStubLike } from "../src/handler";
import { RaceDayCore, type AnalysisSink, type RequestPlanResult } from "../src/race-day-core";
import { runScheduled, SCHEDULED_FAILURE_MESSAGE, SCHEDULED_RETRY_DELAYS_MS } from "../src/scheduled";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #206(#166-E): cron の `scheduled`(`runScheduled`)。薄い作り: `scheduledTime` から JST の開催日を決め、日単位の DO の `requestPlan` だけを呼ぶ。
 * netkeiba にも LLM にも直接は出ない。失敗は有界の再試行(即時・10 秒後・30 秒後)をしたうえで、分類だけをログに出し、固定文言のエラーを投げる。
 * 日単位の DO は偽物(呼び出しを記録する)。ただし再試行の効きめを見るテストだけは、本物の `RaceDayCore`(`node:sqlite`)を通す。
 */

const JST_0900_0628 = Date.parse("2026-06-28T00:00:00Z"); // UTC 0:00 = JST 9:00(2026-06-28)
const MIN = 60_000;

interface FakeNamespace {
  readonly names: string[];
  readonly requests: { readonly kaisaiDate: string }[];
  /** 呼び出しごとの挙動(先頭から消費。尽きたら accepted)。 */
  script: (() => Promise<RequestPlanResult>)[];
  readonly namespace: RaceDayNamespaceLike;
}

const NOT_CALLED = (): never => {
  throw new Error("scheduled は requestPlan 以外を呼ばない想定");
};

function fakeNamespace(): FakeNamespace {
  const f: FakeNamespace = {
    names: [],
    requests: [],
    script: [],
    namespace: undefined as never,
  };
  const stub: RaceDayStubLike = {
    schedule: NOT_CALLED,
    getBoard: NOT_CALLED,
    getMorningPrior: NOT_CALLED,
    getRaceList: NOT_CALLED,
    getPlanProgress: NOT_CALLED,
    getAutoRunResults: NOT_CALLED,
    getNotifications: NOT_CALLED,
    requestPlan: (input) => {
      f.requests.push(input);
      const next = f.script.shift();
      return next === undefined ? Promise.resolve({ accepted: true }) : next();
    },
  };
  (f as { namespace: RaceDayNamespaceLike }).namespace = {
    idFromName: (name: string) => {
      f.names.push(name);
      return name;
    },
    get: () => stub,
  };
  return f;
}

function harness() {
  const logs: { line: string; level: string }[] = [];
  const sleeps: number[] = [];
  return {
    logs,
    sleeps,
    deps: {
      log: (line: string, level: "info" | "error") => logs.push({ line, level }),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
    text: () => logs.map((l) => l.line).join("\n"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runScheduled: 開催日は scheduledTime から JST の日付で決める", () => {
  const cases: [string, number, string][] = [
    ["UTC 0:00(cron の時刻 = JST 9:00)", Date.parse("2026-06-28T00:00:00Z"), "20260628"],
    ["UTC 0:00:00.999(同じ日)", Date.parse("2026-06-28T00:00:00.999Z"), "20260628"],
    ["UTC 14:59:59(JST 23:59:59。同じ日)", Date.parse("2026-06-28T14:59:59Z"), "20260628"],
    ["UTC 15:00:00(JST 翌日 0:00。cron を将来 0 15 * * * に変えた場合の足場)", Date.parse("2026-06-28T15:00:00Z"), "20260629"],
    ["月またぎ(UTC 6/30 15:00 = JST 7/1 0:00)", Date.parse("2026-06-30T15:00:00Z"), "20260701"],
  ];
  for (const [name, scheduledTime, expected] of cases) {
    it(`${name} → 開催日 ${expected} の DO の requestPlan だけを 1 回呼ぶ`, async () => {
      const f = fakeNamespace();
      const h = harness();
      await runScheduled({ scheduledTime }, { RACE_DAY: f.namespace }, h.deps);
      expect(f.names).toEqual([expected]);
      expect(f.requests).toEqual([{ kaisaiDate: expected }]);
      expect(h.sleeps).toEqual([]);
    });
  }

  it("遅延配信: 現在時刻が別の日(スケジュールの 15 時間後)でも、開催日は scheduledTime で決まる(Date.now を使わない)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JST_0900_0628 + 15 * 60 * MIN);
    // 前提: 今の時刻の JST の日付は scheduledTime の日付と違う(同じなら、この検査は何も区別しない)
    expect(new Date(Date.now() + 9 * 60 * MIN).getUTCDate()).not.toBe(new Date(JST_0900_0628 + 9 * 60 * MIN).getUTCDate());
    const f = fakeNamespace();
    const h = harness();
    await runScheduled({ scheduledTime: JST_0900_0628 }, { RACE_DAY: f.namespace }, h.deps);
    expect(f.requests).toEqual([{ kaisaiDate: "20260628" }]);
  });

  it("scheduledTime が不正(NaN・無限大・年が4桁に収まらない)なら、DO を呼ばず、再試行もせず、固定文言のエラーを投げる。分類をログに残す", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e20]) {
      const f = fakeNamespace();
      const h = harness();
      await expect(runScheduled({ scheduledTime: bad }, { RACE_DAY: f.namespace }, h.deps)).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
      expect(f.names, String(bad)).toEqual([]);
      expect(f.requests, String(bad)).toEqual([]);
      expect(h.sleeps, String(bad)).toEqual([]);
      expect(h.text(), String(bad)).toContain("bad-scheduled-time");
      expect(h.logs.every((l) => l.level === "error")).toBe(true);
    }
  });
});

describe("runScheduled: 重複配信・結果のログ", () => {
  it("重複配信(2 回目は already-planned)は例外にならない。ログに accepted の別を残す", async () => {
    const f = fakeNamespace();
    const h = harness();
    f.script = [async () => ({ accepted: true }), async () => ({ accepted: false, reason: "already-planned" })];
    await runScheduled({ scheduledTime: JST_0900_0628 }, { RACE_DAY: f.namespace }, h.deps);
    await runScheduled({ scheduledTime: JST_0900_0628 }, { RACE_DAY: f.namespace }, h.deps);
    expect(f.requests).toHaveLength(2);
    expect(h.sleeps).toEqual([]);
    const lines = h.logs.map((l) => l.line);
    expect(lines.some((l) => l.includes("date=20260628") && l.includes("accepted=true"))).toBe(true);
    expect(lines.some((l) => l.includes("date=20260628") && l.includes("already-planned"))).toBe(true);
    expect(h.logs.every((l) => l.level === "info")).toBe(true);
  });
});

describe("runScheduled: 失敗は有界の再試行(即時・10 秒後・30 秒後)をして、3 回とも失敗したら固定文言で投げる", () => {
  it("再試行の間隔は 10 秒・30 秒の 2 回(合計 3 回の試行)", () => {
    expect([...SCHEDULED_RETRY_DELAYS_MS]).toEqual([10_000, 30_000]);
  });

  it("1 回目が失敗し 2 回目で受理されれば、10 秒待って成功する(例外にしない)。ログの失敗は試行番号とエラーの name だけ", async () => {
    const f = fakeNamespace();
    const h = harness();
    f.script = [
      async () => {
        throw new TypeError("内部の詳細 SECRET-CANARY-1");
      },
    ];
    await runScheduled({ scheduledTime: JST_0900_0628 }, { RACE_DAY: f.namespace }, h.deps);
    expect(f.requests).toEqual([{ kaisaiDate: "20260628" }, { kaisaiDate: "20260628" }]);
    expect(h.sleeps).toEqual([10_000]);
    const text = h.text();
    expect(text).toContain("attempt=1");
    expect(text).toContain("TypeError");
    expect(text).not.toContain("SECRET-CANARY-1");
    expect(text).not.toContain("内部の詳細");
  });

  it("3 回とも失敗: 10 秒・30 秒待って 3 回呼び、固定文言のエラーを投げる。ログにも例外にもメッセージ本文(秘密)を出さない", async () => {
    const f = fakeNamespace();
    const h = harness();
    const failing = (n: number) => async (): Promise<RequestPlanResult> => {
      throw new Error(`https://discord.com/api/webhooks/1/SECRET-CANARY-${n}`);
    };
    f.script = [failing(1), failing(2), failing(3)];
    const error = await runScheduled({ scheduledTime: JST_0900_0628 }, { RACE_DAY: f.namespace }, h.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(SCHEDULED_FAILURE_MESSAGE);
    expect(f.requests).toHaveLength(3);
    expect(h.sleeps).toEqual([10_000, 30_000]);
    const text = h.text();
    expect(text).not.toContain("SECRET-CANARY");
    expect(text).not.toContain("discord.com");
    expect(text).toContain("date=20260628");
    expect(text).toContain("request-plan-failed");
    expect(h.logs.some((l) => l.level === "error")).toBe(true);
  });

  it("エラーの name が文字種の範囲外・Error でない値を投げられても、ログには固定の語だけを出す", async () => {
    const f = fakeNamespace();
    const h = harness();
    const weird = Object.assign(new Error("x"), { name: "https://discord.com/api/webhooks/SECRET-CANARY" });
    f.script = [
      async () => {
        throw weird;
      },
      async () => {
        throw "文字列を投げる SECRET-CANARY";
      },
      async () => {
        throw weird;
      },
    ];
    await expect(runScheduled({ scheduledTime: JST_0900_0628 }, { RACE_DAY: f.namespace }, h.deps)).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(h.text()).not.toContain("SECRET-CANARY");
    expect(h.text()).not.toContain("discord.com");
  });
});

describe("runScheduled と requestPlan の冪等性(本物の RaceDayCore): 1 回目が行を書いたあとに失敗しても、再試行がアラームを張って回復する", () => {
  const opened: NodeSql[] = [];
  afterEach(() => {
    for (const sql of opened.splice(0)) sql.close();
  });

  const unusedSink: AnalysisSink = {
    save: async () => {
      throw new Error("保存先は使わない");
    },
    findByAnalyzedAt: async () => {
      throw new Error("保存先は使わない");
    },
    findRecentByRace: async () => {
      throw new Error("保存先は使わない");
    },
    countChildren: async () => {
      throw new Error("保存先は使わない");
    },
  };

  it("1 回目: setAlarm が投げる(依頼の行は書かれる)→ 2 回目の試行: already-planned でアラームが張られる。runScheduled は成功で終わる", async () => {
    const sql = openNodeSql();
    opened.push(sql);
    let failNext = true;
    const alarms: number[] = [];
    const core = new RaceDayCore({
      sql,
      now: () => JST_0900_0628,
      gate: {
        fetchRaw: async () => {
          throw new Error("scheduled は取得しない");
        },
      },
      setAlarm: (at) => {
        if (failNext) {
          failNext = false;
          throw new Error("setAlarm の失敗");
        }
        alarms.push(at);
      },
      onWarn: () => undefined,
      sink: unusedSink,
      loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    });
    const results: RequestPlanResult[] = [];
    const f = fakeNamespace();
    f.script = [
      async () => core.requestPlan({ kaisaiDate: "20260628" }),
      async () => {
        const r = await core.requestPlan({ kaisaiDate: "20260628" });
        results.push(r);
        return r;
      },
    ];
    const h = harness();
    await runScheduled({ scheduledTime: JST_0900_0628 }, { RACE_DAY: f.namespace }, h.deps);
    expect(f.requests).toHaveLength(2);
    expect(h.sleeps).toEqual([10_000]);
    // 2 回目は already-planned(1 回目が依頼の行を書いていた)で、アラームが張られた
    expect(results).toEqual([{ accepted: false, reason: "already-planned" }]);
    expect(alarms).toEqual([JST_0900_0628]);
    const venues = sql.exec("SELECT venue, state FROM race_day_plan_venue ORDER BY venue").toArray();
    expect(venues).toEqual([
      { venue: "central", state: "pending" },
      { venue: "nar", state: "pending" },
    ]);
  });
});
