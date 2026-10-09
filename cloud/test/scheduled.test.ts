import { afterEach, describe, expect, it, vi } from "vitest";

import type { RaceDayNamespaceLike, RaceDayStubLike } from "../src/handler";
import { RaceDayCore, type AnalysisSink, type RequestPlanResult, type RequestResultImportResult } from "../src/race-day-core";
import type { DispatchStore } from "../src/result-dispatch";
import type { ResultDb } from "../src/result-repository";
import { runScheduled, SCHEDULED_FAILURE_MESSAGE, SCHEDULED_RETRY_DELAYS_MS, type ScheduledEnv } from "../src/scheduled";
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
  /** requestPlan と requestResultImport の呼び出しの順(`plan:日` `result:日`)。 */
  readonly events: string[];
  readonly resultRequests: { readonly kaisaiDate: string; readonly raceIds: string[] }[];
  /** requestResultImport の呼び出しごとの挙動(先頭から消費。尽きたら、依頼した件数を積んだことにする)。 */
  resultScript: (() => Promise<RequestResultImportResult>)[];
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
    events: [],
    resultRequests: [],
    resultScript: [],
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
    getResultImportProgress: NOT_CALLED,
    requestResultImport: (input) => {
      f.events.push(`result:${input.kaisaiDate}`);
      f.resultRequests.push({ kaisaiDate: input.kaisaiDate, raceIds: [...input.raceIds] });
      const next = f.resultScript.shift();
      return next === undefined ? Promise.resolve({ accepted: input.raceIds.length, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } }) : next();
    },
    requestPlan: (input) => {
      f.events.push(`plan:${input.kaisaiDate}`);
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

/** 結果の依頼の列挙が空を返す D1(prepare → bind → all)。既存のテストは、結果の依頼を主題にしないので、空の D1 を渡す。 */
const emptyDb: ResultDb = {
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  batch: async () => [],
} as unknown as ResultDb;
const envOf = (f: FakeNamespace, db: ResultDb = emptyDb): ScheduledEnv => ({ RACE_DAY: f.namespace, DB: db });

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
      await runScheduled({ scheduledTime }, envOf(f), h.deps);
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
    await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), h.deps);
    expect(f.requests).toEqual([{ kaisaiDate: "20260628" }]);
  });

  it("scheduledTime が不正(NaN・無限大・年が4桁に収まらない)なら、DO を呼ばず、再試行もせず、固定文言のエラーを投げる。分類をログに残す", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e20]) {
      const f = fakeNamespace();
      const h = harness();
      await expect(runScheduled({ scheduledTime: bad }, envOf(f), h.deps)).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
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
    await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), h.deps);
    await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), h.deps);
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
    await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), h.deps);
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
    const error = await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), h.deps).catch((e: unknown) => e);
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
    await expect(runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), h.deps)).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
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
    await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), h.deps);
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

describe("runScheduled: 結果の取り込みの依頼(Issue #208)。requestPlan のあとに、過去 7 日(今日を含めない)の未取込を、日ごとに依頼する", () => {
  /** 列挙(DispatchStore)の記録つきの偽物。 */
  function fakeStore(list: { raceId: string; kaisaiDate: string }[] = []): DispatchStore & { calls: unknown[]; failWith: Error | null } {
    const s = {
      calls: [] as unknown[],
      failWith: null as Error | null,
      async listUnimportedRacesByDay(options: unknown) {
        s.calls.push(options);
        if (s.failWith !== null) throw s.failWith;
        return list;
      },
    };
    return s;
  }

  it("窓は scheduledTime の JST の今日の前日までの 7 日(今日を含めない)。列挙の上限は 1 日 60・2 日・合計 120", async () => {
    const f = fakeNamespace();
    const h = harness();
    const store = fakeStore();
    await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), { ...h.deps, store });
    expect(store.calls).toEqual([{ from: "20260621", to: "20260627", perDay: 60, maxDays: 2, total: 120 }]);
    // 月・年をまたぐ窓、UTC 15:00 以降(JST の翌日)の窓
    const jan = fakeStore();
    await runScheduled({ scheduledTime: Date.parse("2026-01-05T00:00:00Z") }, envOf(f), { ...h.deps, store: jan });
    expect(jan.calls).toEqual([{ from: "20251229", to: "20260104", perDay: 60, maxDays: 2, total: 120 }]);
    const late = fakeStore();
    await runScheduled({ scheduledTime: Date.parse("2026-06-28T15:00:00Z") }, envOf(f), { ...h.deps, store: late });
    expect(late.calls).toEqual([{ from: "20260622", to: "20260628", perDay: 60, maxDays: 2, total: 120 }]);
  });

  it("requestPlan が先、結果の依頼があと。結果は日ごとに、その日の DO(idFromName(開催日))へ", async () => {
    const f = fakeNamespace();
    const h = harness();
    const store = fakeStore([
      { raceId: "202603020211", kaisaiDate: "20260627" },
      { raceId: "202603020111", kaisaiDate: "20260625" },
    ]);
    await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), { ...h.deps, store });
    expect(f.events).toEqual(["plan:20260628", "result:20260627", "result:20260625"]);
    expect(f.resultRequests).toEqual([
      { kaisaiDate: "20260627", raceIds: ["202603020211"] },
      { kaisaiDate: "20260625", raceIds: ["202603020111"] },
    ]);
    expect(f.names).toEqual(["20260628", "20260627", "20260625"]);
  });

  it("D1 の列挙が失敗しても、requestPlan は成功のまま(例外にしない)。分類だけをログに出し、メッセージ本文を出さない", async () => {
    const f = fakeNamespace();
    const h = harness();
    const store = fakeStore();
    store.failWith = new Error("D1 の詳細 SECRET-CANARY-D1");
    await expect(runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), { ...h.deps, store })).resolves.toBeUndefined();
    expect(f.requests).toEqual([{ kaisaiDate: "20260628" }]);
    expect(h.text()).toContain("result-list-failed");
    expect(h.text()).not.toContain("SECRET-CANARY");
  });

  it("結果の依頼の RPC が失敗しても、requestPlan は成功のまま。他の日の依頼は続く", async () => {
    const f = fakeNamespace();
    const h = harness();
    f.resultScript = [
      async () => {
        throw new Error("DO の詳細 SECRET-CANARY-DO");
      },
    ];
    const store = fakeStore([
      { raceId: "202603020211", kaisaiDate: "20260627" },
      { raceId: "202603020111", kaisaiDate: "20260626" },
    ]);
    await expect(runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), { ...h.deps, store })).resolves.toBeUndefined();
    expect(f.resultRequests.map((r) => r.kaisaiDate)).toEqual(["20260627", "20260626"]);
    expect(h.text()).toContain("result-request-failed");
    expect(h.text()).not.toContain("SECRET-CANARY");
  });

  it("結果の依頼の準備そのものが投げても(列挙の依存を作れない等)、requestPlan は成功のまま", async () => {
    const f = fakeNamespace();
    const h = harness();
    const brokenEnv = { RACE_DAY: f.namespace, get DB(): ResultDb { throw new Error("binding SECRET-CANARY-BINDING"); } } as ScheduledEnv;
    await expect(runScheduled({ scheduledTime: JST_0900_0628 }, brokenEnv, h.deps)).resolves.toBeUndefined();
    expect(f.requests).toEqual([{ kaisaiDate: "20260628" }]);
    expect(h.text()).toContain("result-dispatch-failed");
    expect(h.text()).not.toContain("SECRET-CANARY");
  });

  it("requestPlan が 3 回とも失敗しても、結果の依頼は走る。最後に、従来どおり固定文言のエラーを投げる(朝の計画の失敗は隠さない)", async () => {
    const f = fakeNamespace();
    const h = harness();
    const failing = async (): Promise<RequestPlanResult> => {
      throw new Error("plan failed");
    };
    f.script = [failing, failing, failing];
    const store = fakeStore([{ raceId: "202603020211", kaisaiDate: "20260627" }]);
    await expect(runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), { ...h.deps, store })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(f.events).toEqual(["plan:20260628", "plan:20260628", "plan:20260628", "result:20260627"]);
    expect(h.sleeps).toEqual([10_000, 30_000]);
    expect(h.text()).toContain("request-plan-failed");
  });

  it("重複配信: 同じ scheduledTime を 2 回呼ぶと、依頼も 2 回出る(冪等なのは DO 側。ここは同じ引数で同じ依頼になる)", async () => {
    const f = fakeNamespace();
    const h = harness();
    const store = fakeStore([{ raceId: "202603020211", kaisaiDate: "20260627" }]);
    await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), { ...h.deps, store });
    await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), { ...h.deps, store });
    expect(f.resultRequests).toHaveLength(2);
    expect(f.resultRequests[0]).toEqual(f.resultRequests[1]);
    expect(store.calls[0]).toEqual(store.calls[1]);
  });

  it("scheduledTime が不正なら、列挙も依頼もしない(従来どおり DO を呼ばない)", async () => {
    const f = fakeNamespace();
    const h = harness();
    const store = fakeStore();
    await expect(runScheduled({ scheduledTime: Number.NaN }, envOf(f), { ...h.deps, store })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(store.calls).toEqual([]);
    expect(f.events).toEqual([]);
  });

  it("本物の DO(RaceDayCore)・本物の D1 ではなく偽の D1 を渡した既定の経路(deps.store 省略): env.DB から D1ResultStore を作って列挙する(窓の引数が D1 まで届く)", async () => {
    const f = fakeNamespace();
    const h = harness();
    const binds: unknown[][] = [];
    const db = {
      prepare: () => ({
        bind: (...args: unknown[]) => {
          binds.push(args);
          return { all: async () => ({ results: [{ raceId: "202603020211", firstDate: "20260627" }] }) };
        },
      }),
      batch: async () => [],
    } as unknown as ResultDb;
    await runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f, db), h.deps);
    expect(binds).toEqual([["20260621", "20260627", 60, 2, 120]]);
    expect(f.resultRequests).toEqual([{ kaisaiDate: "20260627", raceIds: ["202603020211"] }]);
  });
});

describe("runScheduled: 結果の補完の起動(Issue #217)。毎日 1 回、補完の DO の kick を呼ぶ。失敗しても朝の計画・既存の結果の取り込みを失敗させない", () => {
  /** 補完の DO の偽物。kick の呼び出しとその順を `events`(他の DO の呼び出しと共有)に記録する。 */
  function fakeBackfill(events: string[], behavior: () => Promise<void> = async () => undefined) {
    const names: string[] = [];
    let kicks = 0;
    return {
      names,
      kicks: () => kicks,
      namespace: {
        idFromName: (name: string) => {
          names.push(name);
          return name;
        },
        get: () => ({
          kick: async () => {
            kicks += 1;
            events.push("kick");
            await behavior();
          },
          getStatus: NOT_CALLED,
        }),
      },
    };
  }
  const emptyStore: DispatchStore = { listUnimportedRacesByDay: async () => [] };

  it("計画・結果の依頼のあとに、固定名 main の補完の DO の kick を 1 回呼ぶ", async () => {
    const f = fakeNamespace();
    const h = harness();
    const b = fakeBackfill(f.events);
    const store: DispatchStore = { listUnimportedRacesByDay: async () => [{ raceId: "202603020211", kaisaiDate: "20260627" }] };
    await runScheduled({ scheduledTime: JST_0900_0628 }, { ...envOf(f), RESULT_BACKFILL: b.namespace }, { ...h.deps, store });
    expect(f.events).toEqual(["plan:20260628", "result:20260627", "kick"]);
    expect(b.names).toEqual(["main"]);
    expect(b.kicks()).toBe(1);
  });

  it("kick が失敗(同期の例外・非同期の reject)しても、朝の計画は成功のまま・結果の依頼は済んでいる。分類だけをログに出し、例外の文面を出さない", async () => {
    for (const behavior of [
      async (): Promise<void> => {
        throw new Error("補完の詳細 SECRET-CANARY-KICK");
      },
      (): Promise<void> => {
        throw new Error("補完の詳細(同期) SECRET-CANARY-KICK");
      },
    ]) {
      const f = fakeNamespace();
      const h = harness();
      const b = fakeBackfill(f.events, behavior);
      const store: DispatchStore = { listUnimportedRacesByDay: async () => [{ raceId: "202603020211", kaisaiDate: "20260627" }] };
      await expect(runScheduled({ scheduledTime: JST_0900_0628 }, { ...envOf(f), RESULT_BACKFILL: b.namespace }, { ...h.deps, store })).resolves.toBeUndefined();
      expect(f.requests).toEqual([{ kaisaiDate: "20260628" }]);
      expect(f.resultRequests).toHaveLength(1);
      expect(b.kicks()).toBe(1);
      expect(h.text()).toContain("backfill-kick-failed");
      expect(h.text()).not.toContain("SECRET-CANARY");
    }
  });

  it("スタブの取得そのもの(idFromName・get)が投げても、朝の計画は成功のまま", async () => {
    const f = fakeNamespace();
    const h = harness();
    const broken = {
      idFromName: () => {
        throw new Error("binding SECRET-CANARY-BIND");
      },
      get: NOT_CALLED,
    };
    await expect(runScheduled({ scheduledTime: JST_0900_0628 }, { ...envOf(f), RESULT_BACKFILL: broken as never }, { ...h.deps, store: emptyStore })).resolves.toBeUndefined();
    expect(f.requests).toEqual([{ kaisaiDate: "20260628" }]);
    expect(h.text()).toContain("backfill-kick-failed");
    expect(h.text()).not.toContain("SECRET-CANARY");
  });

  it("requestPlan が 3 回とも失敗しても kick は呼ぶ(補完は朝の計画に依らない)。最後は従来どおり固定文言で投げる", async () => {
    const f = fakeNamespace();
    const h = harness();
    f.script = [() => Promise.reject(new Error("x")), () => Promise.reject(new Error("x")), () => Promise.reject(new Error("x"))];
    const b = fakeBackfill(f.events);
    await expect(runScheduled({ scheduledTime: JST_0900_0628 }, { ...envOf(f), RESULT_BACKFILL: b.namespace }, { ...h.deps, store: emptyStore })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(b.kicks()).toBe(1);
  });

  it("結果の依頼(列挙)が失敗しても kick は呼ぶ", async () => {
    const f = fakeNamespace();
    const h = harness();
    const b = fakeBackfill(f.events);
    const store: DispatchStore = {
      listUnimportedRacesByDay: async () => {
        throw new Error("D1");
      },
    };
    await runScheduled({ scheduledTime: JST_0900_0628 }, { ...envOf(f), RESULT_BACKFILL: b.namespace }, { ...h.deps, store });
    expect(b.kicks()).toBe(1);
  });

  it("binding が無い構成(RESULT_BACKFILL 省略)は、kick せずに従来どおり動く", async () => {
    const f = fakeNamespace();
    const h = harness();
    await expect(runScheduled({ scheduledTime: JST_0900_0628 }, envOf(f), { ...h.deps, store: emptyStore })).resolves.toBeUndefined();
    expect(f.requests).toEqual([{ kaisaiDate: "20260628" }]);
  });

  it("scheduledTime が不正なら kick も呼ばない(従来どおり何も呼ばない)", async () => {
    const f = fakeNamespace();
    const h = harness();
    const b = fakeBackfill(f.events);
    await expect(runScheduled({ scheduledTime: Number.NaN }, { ...envOf(f), RESULT_BACKFILL: b.namespace }, { ...h.deps, store: emptyStore })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(b.kicks()).toBe(0);
  });
});
