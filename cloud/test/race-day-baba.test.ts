import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BabaFetchError } from "../src/baba-conditions";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { BABA_META_ATTEMPTED, type BabaFetcher, type BabaFinish, type BabaStore } from "../src/race-day-baba";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { openNodeSql, type NodeSql } from "./node-sql";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #294: 日単位の DO(`RaceDayCore`)の中の、馬場の API の取得(開催日の朝に 1 回だけ)。
 * 前夜 21:00 の計画(中央の一覧あり)→ 翌朝 08:00 にアラームで 1 回取得 → 保存。「1 日 1 回」を、再起動・並行・再計画(救済)でも守る。
 * ゲート・保存先・取得口は偽(実 netkeiba にも実 API にも触れない)。ストレージは `node:sqlite`。
 */

installFetchTrap();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const DATE = "20261012";
const jst = (s: string): number => Date.parse(`${s}+09:00`);
const T_2100 = jst("2026-10-11T21:00:00");
const AT_0800 = jst("2026-10-12T08:00:00");
const SAMPLE_TEXT = fixture("baba_latest_20261012.json");
const CENTRAL_HTML = fixture("race_list_sub_20260927.html");
const NAR_HTML = fixture("synthetic_nar_race_list_sub_20260927_jpn3.html");

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const ok = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const blocked = (): GateResult => ({ kind: "refused", reason: "blocked", message: "ブレーカーが開いています", blockedUntil: 1, retryAfterMs: 1 });

interface FakeGate extends GateLike {
  readonly failures: { central: GateResult[]; nar: GateResult[] };
}
function fakeGate(): FakeGate {
  const gate: FakeGate = {
    failures: { central: [], nar: [] },
    async fetchRaw(url): Promise<GateResult> {
      await Promise.resolve();
      if (url.startsWith("https://race.netkeiba.com/top/race_list_sub")) return gate.failures.central.shift() ?? ok(CENTRAL_HTML);
      if (url.startsWith("https://nar.netkeiba.com/top/race_list_sub")) return gate.failures.nar.shift() ?? ok(NAR_HTML);
      return blocked(); // 事前分析の取得は、このテストの主題ではないので、すぐ失敗にする
    },
  };
  return gate;
}

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

interface FakeStore extends BabaStore {
  readonly claimed: Set<string>;
  readonly claimCalls: { n: number };
  readonly finishes: { date: string; finish: BabaFinish }[];
}
function fakeStore(): FakeStore {
  const store: FakeStore = {
    claimed: new Set(),
    claimCalls: { n: 0 },
    finishes: [],
    async claim(date) {
      await Promise.resolve();
      store.claimCalls.n += 1;
      if (store.claimed.has(date)) return "exists";
      store.claimed.add(date);
      return "claimed";
    },
    async finish(date, finish) {
      await Promise.resolve();
      store.finishes.push({ date, finish });
    },
  };
  return store;
}

interface Api {
  calls: number;
  respond: () => Promise<string> | string;
  readonly fetcher: BabaFetcher;
}
function fakeApi(): Api {
  const api: Api = {
    calls: 0,
    respond: () => SAMPLE_TEXT,
    fetcher: async () => {
      api.calls += 1;
      return api.respond();
    },
  };
  return api;
}

interface Harness {
  core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly store: FakeStore;
  readonly api: Api;
  readonly warns: string[];
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function build(h: Pick<Harness, "sql" | "gate" | "clock" | "alarm" | "store" | "api" | "warns">, options: { baba: boolean }): RaceDayCore {
  return new RaceDayCore({
    sql: h.sql,
    now: () => h.clock.now,
    gate: h.gate,
    setAlarm: (at) => {
      h.alarm.at = at;
    },
    onWarn: (m) => h.warns.push(m),
    sink: unusedSink,
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
    ...(options.baba ? { fetchBaba: h.api.fetcher, babaStore: h.store } : {}),
  });
}

function harness(options: { baba?: boolean } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const base = { sql, gate: fakeGate(), clock: { now: T_2100 }, alarm: { at: null as number | null }, store: fakeStore(), api: fakeApi(), warns: [] as string[] };
  return { ...base, core: build(base, { baba: options.baba !== false }) };
}

/** DO の再起動: 同じ SQLite(DO の永続)・同じ保存先・同じ取得口で、新しい core を作る。 */
function restart(h: Harness): void {
  h.core = build(h, { baba: true });
}

const label = (o: StepOutcome): string => (o.kind === "idle" ? "idle" : `${o.raceId}:${o.mode}:${o.step}:${o.result}`);

async function tick(h: Harness): Promise<string> {
  const at = h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  return label(await h.core.runNextStep());
}

async function runDue(h: Harness, until: number, limit = 500): Promise<string[]> {
  const labels: string[] = [];
  while (h.alarm.at !== null && h.alarm.at <= until) {
    if (labels.length >= limit) throw new Error("ステップが終わらない");
    labels.push(await tick(h));
  }
  return labels;
}

const meta = (h: Harness, key: string): string | null =>
  (h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[])[0]?.value ?? null;
const firstCentralDue = (h: Harness): number =>
  (h.sql.exec("SELECT MIN(due_ms) AS at FROM race_day_plan WHERE venue = 'central'").toArray() as { at: number }[])[0]!.at;

/** 期限を待つ計画の行(中央・地方とも)のうち最も早い期限(計画の後に、取得の候補を除いて次に鳴るアラーム)。 */
const firstPlannedDue = (h: Harness): number =>
  (h.sql.exec("SELECT MIN(due_ms) AS at FROM race_day_plan WHERE state = 'planned'").toArray() as { at: number }[])[0]!.at;

/** 前夜 21:00 の計画を、翌朝の期限のアラームの手前まで進める。 */
async function plan2100(h: Harness): Promise<void> {
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: true });
  await runDue(h, jst("2026-10-11T23:59:00"));
}

describe("開催日の朝に 1 回だけ取得する", () => {
  it("計画の後のアラームは 08:00 JST(最初の発走前の分析の期限より前)。そこで取得して保存し、取得の候補は残らない", async () => {
    const h = harness();
    await plan2100(h);
    // 前提: 最初の発走前の分析の期限は 08:00 より後(取得が分析より前に済む。空振りでない)
    expect(firstCentralDue(h)).toBeGreaterThan(AT_0800);
    expect(firstPlannedDue(h)).toBeGreaterThan(AT_0800);
    expect(h.api.calls).toBe(0);
    expect(h.alarm.at).toBe(AT_0800);

    expect(await tick(h)).toBe(`${DATE}:baba:fetch:ok`);
    expect(h.api.calls).toBe(1);
    expect(h.store.finishes).toHaveLength(1);
    expect(h.store.finishes[0]!.finish.venues.map((v) => v.venueCode)).toEqual(["05", "08"]);
    // 次のアラームは 08:00 の取得の続きではなく、発走前の分析の期限(即時のアラームが続かない)
    expect(h.alarm.at).not.toBeNull();
    expect(h.alarm.at!).toBeGreaterThan(AT_0800);
    expect(h.alarm.at).toBe(firstPlannedDue(h));
  });

  it("前夜のうち(21:00〜23:59)は取得しない(取得口は 0 回)", async () => {
    const h = harness();
    await plan2100(h);
    h.clock.now = jst("2026-10-11T23:59:00");
    expect(h.api.calls).toBe(0);
    expect(h.store.claimCalls.n).toBe(0);
    expect(meta(h, BABA_META_ATTEMPTED)).toBeNull();
  });

  it("取得口が無い構成(secret 未登録)では、アラームの候補にならず、取得も印もない", async () => {
    const h = harness({ baba: false });
    await plan2100(h);
    expect(h.alarm.at).toBe(firstPlannedDue(h)); // 08:00 の候補が無い
    h.clock.now = AT_0800 + 3600_000;
    await h.core.runNextStep();
    expect(h.api.calls).toBe(0);
    expect(meta(h, BABA_META_ATTEMPTED)).toBeNull();
  });
});

describe("2 回目を送らない(再起動・並行・再計画)", () => {
  it("同じ日のうちに何度アラームを進めても、取得口は 1 回だけ", async () => {
    const h = harness();
    await plan2100(h);
    await runDue(h, jst("2026-10-12T23:59:00"));
    expect(h.api.calls).toBe(1);
  });

  it("取得が失敗した日(HTTP 500)も、再試行しない。DO の再起動の後も", async () => {
    const h = harness();
    h.api.respond = () => Promise.reject(new BabaFetchError("http-500"));
    await plan2100(h);
    expect(await tick(h)).toBe(`${DATE}:baba:fetch:failed`);
    expect(h.store.finishes[0]!.finish.result).toBe("http-500");
    restart(h);
    await h.core.requestPlan({ kaisaiDate: DATE }); // 再配信(already-planned。アラームを張り直す)
    await runDue(h, jst("2026-10-12T23:59:00"));
    expect(h.api.calls).toBe(1);
  });

  it("DO の再起動(新しい core・同じ SQLite)の後も 1 回のまま", async () => {
    const h = harness();
    await plan2100(h);
    await tick(h);
    restart(h);
    h.clock.now = AT_0800 + 3600_000;
    for (let i = 0; i < 5; i++) await h.core.runNextStep();
    expect(h.api.calls).toBe(1);
  });

  it("DO の印だけが無い状態(claim の後・印の前のクラッシュ)でも、D1 の claim が残っているので取得しない", async () => {
    const h = harness();
    await plan2100(h);
    await tick(h);
    h.sql.exec("DELETE FROM race_day_meta WHERE key = ?", BABA_META_ATTEMPTED);
    restart(h);
    h.clock.now = AT_0800 + 3600_000;
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(h.api.calls).toBe(1);
  });

  it("並行して runNextStep を呼んでも、取得口は 1 回だけ", async () => {
    const h = harness();
    await plan2100(h);
    h.clock.now = AT_0800;
    h.alarm.at = null;
    const outcomes = await Promise.all([h.core.runNextStep(), h.core.runNextStep()]);
    expect(h.api.calls).toBe(1);
    expect(outcomes.map(label).filter((l) => l.includes(":baba:"))).toHaveLength(1);
  });

  it("取得の後の再計画(救済 rescue・再配信)でも、取得しない", async () => {
    const h = harness();
    await plan2100(h);
    await tick(h);
    expect(h.api.calls).toBe(1);
    h.clock.now = AT_0800 + 60_000;
    expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: true })).toEqual({ accepted: false, reason: "already-planned" });
    expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: false, reason: "already-planned" });
    await runDue(h, jst("2026-10-12T23:59:00"));
    expect(h.api.calls).toBe(1);
  });

  it("中央の一覧が取れなかった日は取得せず、再計画(救済)で中央の一覧が取れて確定したその時点で 1 回だけ取得する。以後の救済・再配信では送らない", async () => {
    const h = harness();
    h.gate.failures.central = [blocked()];
    await plan2100(h);
    // 前提: 中央は失敗(中央の行が無い)で、08:00 を過ぎても取得しない
    expect((h.sql.exec("SELECT state FROM race_day_plan_venue WHERE venue = 'central'").toArray() as { state: string }[])[0]?.state).toBe("failed");
    await runDue(h, jst("2026-10-12T08:30:00"));
    h.clock.now = jst("2026-10-12T08:30:00");
    await h.core.runNextStep();
    expect(h.api.calls).toBe(0);
    expect(h.store.claimCalls.n).toBe(0);

    expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: true })).toEqual({ accepted: false, reason: "already-planned" });
    const labels = await runDue(h, jst("2026-10-12T08:59:00"));
    expect(labels.filter((l) => l.includes(":baba:"))).toEqual([`${DATE}:baba:fetch:ok`]);
    expect(h.api.calls).toBe(1);

    await h.core.requestPlan({ kaisaiDate: DATE, rescue: true });
    restart(h);
    await h.core.requestPlan({ kaisaiDate: DATE });
    await runDue(h, jst("2026-10-12T23:59:00"));
    expect(h.api.calls).toBe(1);
  });
});

describe("分析を止めない・遅らせない", () => {
  it("取得口が失敗しても、同じ起床の次のステップでタスクが進む(取得は最初の 1 ステップだけ)", async () => {
    const h = harness();
    h.api.respond = () => Promise.reject(new BabaFetchError("timeout"));
    await plan2100(h);
    h.clock.now = AT_0800;
    const raceId = (h.sql.exec("SELECT race_id FROM race_day_plan WHERE venue = 'central' ORDER BY race_id LIMIT 1").toArray() as { race_id: string }[])[0]!.race_id;
    expect(await h.core.schedule({ raceId, kaisaiDate: DATE })).toMatchObject({ accepted: true });
    h.alarm.at = null;
    expect(label(await h.core.runNextStep())).toBe(`${DATE}:baba:fetch:failed`); // 先に 1 ステップだけ
    expect(label(await h.core.runNextStep())).toBe(`${raceId}:morning:fetch:failed`); // タスクはそのまま進む(ゲートは偽でブレーカー拒否)
    expect(h.api.calls).toBe(1);
  });

  it("取得口が想定外の例外を投げても、runNextStep は例外にしない(DO のアラームの再実行を起こさない)", async () => {
    const h = harness();
    h.api.respond = () => {
      throw new TypeError("想定外 https://secret.test.invalid/x");
    };
    await plan2100(h);
    h.clock.now = AT_0800;
    h.alarm.at = null;
    await expect(h.core.runNextStep()).resolves.toMatchObject({ mode: "baba", result: "failed" });
    expect(h.warns.join("\n")).not.toContain("secret.test.invalid");
  });
});
