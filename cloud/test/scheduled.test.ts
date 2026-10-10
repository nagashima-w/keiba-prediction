import { afterEach, describe, expect, it, vi } from "vitest";

import type { RaceDayNamespaceLike, RaceDayStubLike } from "../src/handler";
import { DISCORD_COLORS } from "../src/palette";
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

const FIRST_0627_2100 = Date.parse("2026-06-27T12:00:00Z"); // UTC 12:00 = JST 21:00(2026-06-27)。計画する開催日は 20260628
const RETRY_0628_2300 = Date.parse("2026-06-28T14:00:00Z"); // UTC 14:00 = JST 23:00(2026-06-28)。計画する開催日は 20260629。結果の窓は 20260621〜20260627
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

describe("runScheduled: 計画する開催日は scheduledTime の JST の今日 + 1(Issue #249)", () => {
  const cases: [string, number, string][] = [
    ["21 時の cron(UTC 12:00 = JST 6/27 21:00)", Date.parse("2026-06-27T12:00:00Z"), "20260628"],
    ["23 時の cron(UTC 14:00 = JST 6/27 23:00。21 時と同じ開催日)", Date.parse("2026-06-27T14:00:00Z"), "20260628"],
    ["UTC 14:59:59(JST 23:59:59。まだ同じ日の翌日)", Date.parse("2026-06-27T14:59:59Z"), "20260628"],
    ["UTC 15:00:00(JST 翌日 0:00。日付が進む)", Date.parse("2026-06-27T15:00:00Z"), "20260629"],
    ["月末(UTC 6/30 12:00 = JST 6/30 21:00 → 7/1)", Date.parse("2026-06-30T12:00:00Z"), "20260701"],
    ["年末(UTC 12/31 14:00 = JST 12/31 23:00 → 翌年 1/1)", Date.parse("2026-12-31T14:00:00Z"), "20270101"],
  ];
  for (const [name, scheduledTime, expected] of cases) {
    it(`${name} → 開催日 ${expected} の DO の requestPlan だけを 1 回呼ぶ`, async () => {
      const f = fakeNamespace();
      const h = harness();
      await runScheduled({ scheduledTime }, envOf(f), h.deps);
      expect(f.names[0]).toBe(expected);
      expect(f.requests.map((r) => r.kaisaiDate)).toEqual([expected]);
      expect(h.sleeps).toEqual([]);
    });
  }

  it("遅延配信: 現在時刻が別の日(スケジュールの 15 時間後)でも、開催日は scheduledTime で決まる(Date.now を使わない)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIRST_0627_2100 + 15 * 60 * MIN);
    // 前提: 今の時刻の JST の日付は scheduledTime の日付と違う(同じなら、この検査は何も区別しない)
    expect(new Date(Date.now() + 9 * 60 * MIN).getUTCDate()).not.toBe(new Date(FIRST_0627_2100 + 9 * 60 * MIN).getUTCDate());
    const f = fakeNamespace();
    const h = harness();
    await runScheduled({ scheduledTime: FIRST_0627_2100 }, envOf(f), h.deps);
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
    await runScheduled({ scheduledTime: FIRST_0627_2100 }, envOf(f), h.deps);
    await runScheduled({ scheduledTime: FIRST_0627_2100 }, envOf(f), h.deps);
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
    await runScheduled({ scheduledTime: FIRST_0627_2100 }, envOf(f), h.deps);
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
    const error = await runScheduled({ scheduledTime: FIRST_0627_2100 }, envOf(f), h.deps).catch((e: unknown) => e);
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
    await expect(runScheduled({ scheduledTime: FIRST_0627_2100 }, envOf(f), h.deps)).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
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
      now: () => FIRST_0627_2100,
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
    await runScheduled({ scheduledTime: FIRST_0627_2100 }, envOf(f), h.deps);
    expect(f.requests).toHaveLength(2);
    expect(h.sleeps).toEqual([10_000]);
    // 2 回目は already-planned(1 回目が依頼の行を書いていた)で、アラームが張られた
    expect(results).toEqual([{ accepted: false, reason: "already-planned" }]);
    expect(alarms).toEqual([FIRST_0627_2100]);
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
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, envOf(f), { ...h.deps, store });
    expect(store.calls).toEqual([{ from: "20260621", to: "20260627", perDay: 60, maxDays: 2, total: 120 }]);
    // 月・年をまたぐ窓、日付が進んだ日(6/29 23:00)の窓
    const jan = fakeStore();
    await runScheduled({ scheduledTime: Date.parse("2026-01-05T14:00:00Z") }, envOf(f), { ...h.deps, store: jan });
    expect(jan.calls).toEqual([{ from: "20251229", to: "20260104", perDay: 60, maxDays: 2, total: 120 }]);
    const late = fakeStore();
    await runScheduled({ scheduledTime: Date.parse("2026-06-29T14:00:00Z") }, envOf(f), { ...h.deps, store: late });
    expect(late.calls).toEqual([{ from: "20260622", to: "20260628", perDay: 60, maxDays: 2, total: 120 }]);
  });

  it("requestPlan が先、結果の依頼があと。結果は日ごとに、その日の DO(idFromName(開催日))へ", async () => {
    const f = fakeNamespace();
    const h = harness();
    const store = fakeStore([
      { raceId: "202603020211", kaisaiDate: "20260627" },
      { raceId: "202603020111", kaisaiDate: "20260625" },
    ]);
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, envOf(f), { ...h.deps, store });
    expect(f.events).toEqual(["plan:20260629", "result:20260627", "result:20260625"]);
    expect(f.resultRequests).toEqual([
      { kaisaiDate: "20260627", raceIds: ["202603020211"] },
      { kaisaiDate: "20260625", raceIds: ["202603020111"] },
    ]);
    expect(f.names).toEqual(["20260629", "20260627", "20260625"]);
  });

  it("D1 の列挙が失敗しても、requestPlan は成功のまま(例外にしない)。分類だけをログに出し、メッセージ本文を出さない", async () => {
    const f = fakeNamespace();
    const h = harness();
    const store = fakeStore();
    store.failWith = new Error("D1 の詳細 SECRET-CANARY-D1");
    await expect(runScheduled({ scheduledTime: RETRY_0628_2300 }, envOf(f), { ...h.deps, store })).resolves.toBeUndefined();
    expect(f.requests).toEqual([{ kaisaiDate: "20260629", rescue: true }]);
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
    await expect(runScheduled({ scheduledTime: RETRY_0628_2300 }, envOf(f), { ...h.deps, store })).resolves.toBeUndefined();
    expect(f.resultRequests.map((r) => r.kaisaiDate)).toEqual(["20260627", "20260626"]);
    expect(h.text()).toContain("result-request-failed");
    expect(h.text()).not.toContain("SECRET-CANARY");
  });

  it("結果の依頼の準備そのものが投げても(列挙の依存を作れない等)、requestPlan は成功のまま", async () => {
    const f = fakeNamespace();
    const h = harness();
    const brokenEnv = { RACE_DAY: f.namespace, get DB(): ResultDb { throw new Error("binding SECRET-CANARY-BINDING"); } } as ScheduledEnv;
    await expect(runScheduled({ scheduledTime: RETRY_0628_2300 }, brokenEnv, h.deps)).resolves.toBeUndefined();
    expect(f.requests).toEqual([{ kaisaiDate: "20260629", rescue: true }]);
    expect(h.text()).toContain("result-dispatch-failed");
    expect(h.text()).not.toContain("SECRET-CANARY");
  });

  it("requestPlan が 3 回とも失敗しても、結果の依頼は走る。最後に、従来どおり固定文言のエラーを投げる(事前分析の計画の失敗は隠さない)", async () => {
    const f = fakeNamespace();
    const h = harness();
    const failing = async (): Promise<RequestPlanResult> => {
      throw new Error("plan failed");
    };
    f.script = [failing, failing, failing];
    const store = fakeStore([{ raceId: "202603020211", kaisaiDate: "20260627" }]);
    await expect(runScheduled({ scheduledTime: RETRY_0628_2300 }, envOf(f), { ...h.deps, store })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(f.events).toEqual(["plan:20260629", "plan:20260629", "plan:20260629", "result:20260627"]);
    expect(h.sleeps).toEqual([10_000, 30_000]);
    expect(h.text()).toContain("request-plan-failed");
  });

  it("重複配信: 同じ scheduledTime を 2 回呼ぶと、依頼も 2 回出る(冪等なのは DO 側。ここは同じ引数で同じ依頼になる)", async () => {
    const f = fakeNamespace();
    const h = harness();
    const store = fakeStore([{ raceId: "202603020211", kaisaiDate: "20260627" }]);
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, envOf(f), { ...h.deps, store });
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, envOf(f), { ...h.deps, store });
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
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, envOf(f, db), h.deps);
    expect(binds).toEqual([["20260621", "20260627", 60, 2, 120]]);
    expect(f.resultRequests).toEqual([{ kaisaiDate: "20260627", raceIds: ["202603020211"] }]);
  });
});

describe("runScheduled: 結果の補完の起動(Issue #217)。毎日 1 回、補完の DO の kick を呼ぶ。失敗しても事前分析の計画・既存の結果の取り込みを失敗させない", () => {
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
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, { ...envOf(f), RESULT_BACKFILL: b.namespace }, { ...h.deps, store });
    expect(f.events).toEqual(["plan:20260629", "result:20260627", "kick"]);
    expect(b.names).toEqual(["main"]);
    expect(b.kicks()).toBe(1);
  });

  it("kick が失敗(同期の例外・非同期の reject)しても、事前分析の計画は成功のまま・結果の依頼は済んでいる。分類だけをログに出し、例外の文面を出さない", async () => {
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
      await expect(runScheduled({ scheduledTime: RETRY_0628_2300 }, { ...envOf(f), RESULT_BACKFILL: b.namespace }, { ...h.deps, store })).resolves.toBeUndefined();
      expect(f.requests).toEqual([{ kaisaiDate: "20260629", rescue: true }]);
      expect(f.resultRequests).toHaveLength(1);
      expect(b.kicks()).toBe(1);
      expect(h.text()).toContain("backfill-kick-failed");
      expect(h.text()).not.toContain("SECRET-CANARY");
    }
  });

  it("スタブの取得そのもの(idFromName・get)が投げても、事前分析の計画は成功のまま", async () => {
    const f = fakeNamespace();
    const h = harness();
    const broken = {
      idFromName: () => {
        throw new Error("binding SECRET-CANARY-BIND");
      },
      get: NOT_CALLED,
    };
    await expect(runScheduled({ scheduledTime: RETRY_0628_2300 }, { ...envOf(f), RESULT_BACKFILL: broken as never }, { ...h.deps, store: emptyStore })).resolves.toBeUndefined();
    expect(f.requests).toEqual([{ kaisaiDate: "20260629", rescue: true }]);
    expect(h.text()).toContain("backfill-kick-failed");
    expect(h.text()).not.toContain("SECRET-CANARY");
  });

  it("requestPlan が 3 回とも失敗しても kick は呼ぶ(補完は事前分析の計画に依らない)。最後は従来どおり固定文言で投げる", async () => {
    const f = fakeNamespace();
    const h = harness();
    f.script = [() => Promise.reject(new Error("x")), () => Promise.reject(new Error("x")), () => Promise.reject(new Error("x"))];
    const b = fakeBackfill(f.events);
    await expect(runScheduled({ scheduledTime: RETRY_0628_2300 }, { ...envOf(f), RESULT_BACKFILL: b.namespace }, { ...h.deps, store: emptyStore })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
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
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, { ...envOf(f), RESULT_BACKFILL: b.namespace }, { ...h.deps, store });
    expect(b.kicks()).toBe(1);
  });

  it("binding が無い構成(RESULT_BACKFILL 省略)は、kick せずに従来どおり動く", async () => {
    const f = fakeNamespace();
    const h = harness();
    await expect(runScheduled({ scheduledTime: RETRY_0628_2300 }, envOf(f), { ...h.deps, store: emptyStore })).resolves.toBeUndefined();
    expect(f.requests).toEqual([{ kaisaiDate: "20260629", rescue: true }]);
  });

  it("scheduledTime が不正なら kick も呼ばない(従来どおり何も呼ばない)", async () => {
    const f = fakeNamespace();
    const h = harness();
    const b = fakeBackfill(f.events);
    await expect(runScheduled({ scheduledTime: Number.NaN }, { ...envOf(f), RESULT_BACKFILL: b.namespace }, { ...h.deps, store: emptyStore })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(b.kicks()).toBe(0);
  });
});

describe("runScheduled: 21 時(first)と 23 時(retry)の割り振り(Issue #249)", () => {
  const store = (calls: unknown[]): DispatchStore => ({
    listUnimportedRacesByDay: async (options) => {
      calls.push(options);
      return [{ raceId: "202603020211", kaisaiDate: "20260627" }];
    },
  });
  function backfill(events: string[]) {
    return {
      idFromName: (n: string) => n,
      get: () => ({
        kick: async () => {
          events.push("kick");
        },
        getStatus: NOT_CALLED,
      }),
    };
  }

  it("21 時(first): 翌日の requestPlan だけ。rescue は渡さない。結果の取り込み(列挙も依頼も)・kick は行わない", async () => {
    const f = fakeNamespace();
    const h = harness();
    const calls: unknown[] = [];
    await runScheduled({ scheduledTime: FIRST_0627_2100 }, { ...envOf(f), RESULT_BACKFILL: backfill(f.events) as never }, { ...h.deps, store: store(calls) });
    expect(f.events).toEqual(["plan:20260628"]);
    expect(f.requests).toEqual([{ kaisaiDate: "20260628" }]);
    expect(Object.keys(f.requests[0]!)).toEqual(["kaisaiDate"]); // rescue のキー自体が無い
    expect(calls).toEqual([]);
  });

  it("23 時(retry): 同じ翌日の requestPlan を rescue つきで呼び、結果の取り込み・kick を行う(順は plan → result → kick)", async () => {
    const f = fakeNamespace();
    const h = harness();
    const calls: unknown[] = [];
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, { ...envOf(f), RESULT_BACKFILL: backfill(f.events) as never }, { ...h.deps, store: store(calls) });
    expect(f.events).toEqual(["plan:20260629", "result:20260627", "kick"]);
    expect(f.requests).toEqual([{ kaisaiDate: "20260629", rescue: true }]);
    expect(calls).toHaveLength(1);
  });

  it("21 時と 23 時は同じ JST の日なので、計画する開催日は同じ(21 時: 6/28 21:00 と 23 時: 6/28 23:00 → どちらも 20260629)", async () => {
    const f = fakeNamespace();
    const h = harness();
    await runScheduled({ scheduledTime: Date.parse("2026-06-28T12:00:00Z") }, envOf(f), h.deps);
    await runScheduled({ scheduledTime: Date.parse("2026-06-28T14:00:00Z") }, envOf(f), h.deps);
    expect(f.requests.map((r) => r.kaisaiDate)).toEqual(["20260629", "20260629"]);
    expect(f.requests.map((r) => (r as { rescue?: boolean }).rescue)).toEqual([undefined, true]);
  });

  it("結果の取り込みの窓の基準は cron の JST の今日(翌日ではない): 23 時でも、窓の終わりは今日の前日", async () => {
    const f = fakeNamespace();
    const h = harness();
    const calls: unknown[] = [];
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, envOf(f), { ...h.deps, store: store(calls) });
    expect(calls).toEqual([{ from: "20260621", to: "20260627", perDay: 60, maxDays: 2, total: 120 }]);
  });

  it("1 日 2 回(21 時と 23 時)とも成功すれば、requestPlan の呼び出しは 1 回の実行につき 1 回(再試行は失敗したときだけ)", async () => {
    const f = fakeNamespace();
    const h = harness();
    await runScheduled({ scheduledTime: FIRST_0627_2100 }, envOf(f), h.deps);
    await runScheduled({ scheduledTime: Date.parse("2026-06-27T14:00:00Z") }, envOf(f), h.deps);
    expect(f.requests).toHaveLength(2);
    expect(h.sleeps).toEqual([]);
  });
});

describe("runScheduled: 23 時の再実行で翌日の事前分析を依頼できなかったときの Discord 通知(Issue #249。利用者の決定)", () => {
  const VALID_URL = "https://discord.com/api/webhooks/123456789012345678/SECRET-CANARY-WEBHOOK-TOKEN";
  const failing = async (): Promise<RequestPlanResult> => {
    throw new Error("plan failed");
  };

  interface SentRequest {
    readonly url: string;
    readonly body: { embeds: { title: string; description: string; color: number }[] };
  }
  /** 送信の偽物。`fetch` に注入する。応答のステータスを指定できる。 */
  function fakeFetch(status = 204) {
    const sent: SentRequest[] = [];
    const fn = async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) as SentRequest["body"] });
      return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => "" };
    };
    return { sent, fn: fn as never };
  }
  /** url = null は secret 未登録(キー自体を持たない)。 */
  const env = (f: FakeNamespace, url: string | null = VALID_URL): ScheduledEnv => ({ ...envOf(f), ...(url === null ? {} : { DISCORD_WEBHOOK_URL: url }) });

  it("retry で requestPlan が 3 回とも失敗 → 固定文を 1 通だけ送り、そのあと従来どおり固定文言で投げる(帯は失敗色)", async () => {
    const f = fakeNamespace();
    f.script = [failing, failing, failing];
    const h = harness();
    const net = fakeFetch();
    await expect(runScheduled({ scheduledTime: RETRY_0628_2300 }, env(f), { ...h.deps, fetch: net.fn })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(f.requests).toHaveLength(3);
    expect(net.sent).toHaveLength(1);
    const embed = net.sent[0]!.body.embeds[0]!;
    expect(embed.description).toBe("【失敗】23 時の再実行で、翌日(2026/06/29(月)開催分)の事前分析を依頼できませんでした。画面から手動で実行してください。");
    expect(embed.color).toBe(DISCORD_COLORS.fail);
    expect(net.sent[0]!.url).toBe(VALID_URL);
  });

  it("first(21 時)で 3 回とも失敗 → 送らない(23 時に救済されるため)。従来どおり投げる", async () => {
    const f = fakeNamespace();
    f.script = [failing, failing, failing];
    const h = harness();
    const net = fakeFetch();
    await expect(runScheduled({ scheduledTime: FIRST_0627_2100 }, env(f), { ...h.deps, fetch: net.fn })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(net.sent).toEqual([]);
  });

  it("retry で成功(1 回失敗して 2 回目で受理も含む)→ 送らない", async () => {
    const f = fakeNamespace();
    const h = harness();
    const net = fakeFetch();
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, env(f), { ...h.deps, fetch: net.fn });
    f.script = [failing];
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, env(f), { ...h.deps, fetch: net.fn });
    expect(f.requests).toHaveLength(3); // 前提: 2 回目の実行は 1 回失敗して 2 回目で受理された
    expect(net.sent).toEqual([]);
  });

  it("scheduledTime が不正(retry か first か判別できない)なら、送らない(DO も呼ばない)", async () => {
    const f = fakeNamespace();
    const h = harness();
    const net = fakeFetch();
    await expect(runScheduled({ scheduledTime: Number.NaN }, env(f), { ...h.deps, fetch: net.fn })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(net.sent).toEqual([]);
  });

  it.each([
    ["未登録", null],
    ["空白だけ", "   "],
    ["形式不正(Discord の Webhook ではない)", "https://example.com/api/webhooks/1/SECRET-CANARY-BAD"],
  ])("Webhook が%s → 送らず、例外も増えない(従来の固定文言のエラーだけ)。URL の値をログに出さない", async (_name, url) => {
    const f = fakeNamespace();
    f.script = [failing, failing, failing];
    const h = harness();
    const net = fakeFetch();
    await expect(runScheduled({ scheduledTime: RETRY_0628_2300 }, env(f, url), { ...h.deps, fetch: net.fn })).rejects.toThrow(SCHEDULED_FAILURE_MESSAGE);
    expect(net.sent).toEqual([]);
    expect(h.text()).not.toContain("SECRET-CANARY");
    expect(h.text()).toContain("plan-failure-notice");
  });

  it("送信が失敗(HTTP 500・ネットワークエラー)しても握る: 従来の固定文言のエラーだけを投げ、ログは分類だけで URL・本文を出さない", async () => {
    for (const mode of ["http500", "throw"] as const) {
      const f = fakeNamespace();
      f.script = [failing, failing, failing];
      const h = harness();
      const sent: unknown[] = [];
      const fn = async () => {
        sent.push(1);
        if (mode === "throw") {
          throw new Error(`fetch failed ${VALID_URL}`);
        }
        return { status: 500, ok: false, headers: { get: () => null }, text: async () => `${VALID_URL} 本文` };
      };
      const error = await runScheduled({ scheduledTime: RETRY_0628_2300 }, env(f), { ...h.deps, fetch: fn as never }).catch((e: unknown) => e);
      expect((error as Error).message, mode).toBe(SCHEDULED_FAILURE_MESSAGE);
      expect(sent.length, mode).toBeGreaterThanOrEqual(1);
      expect(h.text(), mode).toContain("plan-failure-notice");
      expect(h.text(), mode).not.toContain("SECRET-CANARY");
      expect(h.text(), mode).not.toContain("discord.com");
      expect(h.text(), mode).not.toContain("本文");
    }
  });

  it("通知は結果の取り込み・kick・日報の補完のあとに送る(通知の送信待ちが、他の仕事を遅らせない)", async () => {
    const f = fakeNamespace();
    f.script = [failing, failing, failing];
    const h = harness();
    const order: string[] = [];
    const fn = async () => {
      order.push("discord");
      return { status: 204, ok: true, headers: { get: () => null }, text: async () => "" };
    };
    const backfill = {
      idFromName: (n: string) => n,
      get: () => ({
        kick: async () => {
          order.push("kick");
        },
        getStatus: NOT_CALLED,
      }),
    };
    await runScheduled({ scheduledTime: RETRY_0628_2300 }, { ...env(f), RESULT_BACKFILL: backfill as never }, { ...h.deps, fetch: fn as never }).catch(() => undefined);
    expect(order).toEqual(["kick", "discord"]);
  });
});
