import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BabaFetchError, type BabaFetchOutcome } from "../src/baba-conditions";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { BABA_FETCH_SLOTS, BABA_META_ATTEMPTED, BABA_META_DONE, BABA_META_SLOT, type BabaFetcher, type BabaFinish, type BabaStore } from "../src/race-day-baba";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { openNodeSql, type NodeSql } from "./node-sql";
import { installFetchTrap } from "./fetch-trap";
import { sampleOutcome } from "./baba-sample";

/**
 * Issue #294: 日単位の DO(`RaceDayCore`)の中の、馬場の取得(Issue #478 で取得先を JRA のページに替えた。Issue #480 で、当日の値がそろうまで取り直す形にした)。
 * 前夜 21:00 の計画(中央の一覧あり)→ 翌朝 09:00 にアラームで取得 → 保存。そろわなければ 10 分おきに 12:00 まで取り直す。「1 枠 1 回」を、再起動・並行・再計画(救済)でも守る。
 * 計画の中央の場(見本の日の一覧は 06・09)が「そろった」の分母なので、取得口の見本もその 2 場で返す。
 * ゲート・保存先・取得口は偽(実 netkeiba にも JRA にも触れない)。ストレージは `node:sqlite`。
 */

installFetchTrap();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const DATE = "20261012";
const jst = (s: string): number => Date.parse(`${s}+09:00`);
const T_2100 = jst("2026-10-11T21:00:00");
const AT_0900 = jst("2026-10-12T09:00:00");
/** 枠 k の時刻(09:00 + 10 分 × k)。 */
const slotAt = (k: number): number => AT_0900 + k * 10 * 60_000;
/** 見本の日(2026-10-12)の計画の中央の場コード(一覧のフィクスチャの race_id から)。 */
const PLAN_VENUES = ["06", "09"] as const;
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
  readonly doneDates: Set<string>;
}
function fakeStore(): FakeStore {
  const store: FakeStore = {
    claimed: new Set(),
    claimCalls: { n: 0 },
    finishes: [],
    doneDates: new Set(),
    async claim(date, slot) {
      await Promise.resolve();
      store.claimCalls.n += 1;
      if (store.doneDates.has(date)) return "done";
      if (store.claimed.has(`${date}:${slot}`)) return "exists";
      store.claimed.add(`${date}:${slot}`);
      return "claimed";
    },
    async finish(date, finish) {
      await Promise.resolve();
      store.finishes.push({ date, finish });
      if (finish.complete) store.doneDates.add(date);
    },
  };
  return store;
}

/** 計画の中央の場(06・09)がそろった結果。見本(東京・京都・新潟)の 2 場の値を、その場コードに付け替えて作る。 */
function planOutcome(): BabaFetchOutcome {
  const base = sampleOutcome();
  const venues = PLAN_VENUES.map((code, i) => ({ ...base.venues[i]!, venueCode: code }));
  return { ...base, venues, listedVenueCodes: [...PLAN_VENUES] };
}
/** 当日の値がまだ載っていない回(2 本で止まる空振り)。 */
const notYet = (): BabaFetchOutcome => ({ result: "no-today-venues", venues: [], dropped: 2, droppedDetails: [], apiFetchedAt: null, listedVenueCodes: [...PLAN_VENUES] });

interface Api {
  calls: number;
  respond: () => Promise<BabaFetchOutcome> | BabaFetchOutcome;
  readonly fetcher: BabaFetcher;
}
function fakeApi(): Api {
  const api: Api = {
    calls: 0,
    respond: () => planOutcome(),
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

/**
 * 前夜 21:00 の計画を、翌朝の期限のアラームの手前まで進める。
 * 見本の日の最初の発走前の分析の期限は 09:00 ちょうどで、取得の最初の枠(09:00)と同じ(同じ起床で、馬場の取得が先、最初のレースの分析がその次)。
 * 取得より前の分析の挙動は、計画の行の期限を前へずらして別に確かめる。
 */
async function plan2100(h: Harness): Promise<void> {
  expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: true });
  await runDue(h, jst("2026-10-11T23:59:00"));
  // 前提(実測): 見本の日の最初の期限(中央・全体とも)は 09:00 ちょうど = 取得の最初の枠
  expect(firstPlannedDue(h)).toBe(AT_0900);
  expect(firstCentralDue(h)).toBe(AT_0900);
}

/** 取得(馬場)のステップが動いた時刻を、アラームを進めながら集める。 */
async function babaTimes(h: Harness, until: number, limit = 800): Promise<number[]> {
  const times: number[] = [];
  let n = 0;
  while (h.alarm.at !== null && h.alarm.at <= until) {
    if (n++ >= limit) throw new Error("ステップが終わらない");
    const l = await tick(h);
    if (l.includes(":baba:")) times.push(h.clock.now);
  }
  return times;
}

describe("開催日の朝に取得する", () => {
  it("計画の後のアラームは 09:00 JST。最初の発走前の分析の期限も 09:00 ちょうど(境界)なので、同じ起床で馬場の取得が先、最初のレースの分析がその次に動く", async () => {
    const h = harness();
    await plan2100(h);
    expect(firstCentralDue(h)).toBe(AT_0900);
    expect(firstPlannedDue(h)).toBe(AT_0900);
    expect(h.api.calls).toBe(0);
    expect(h.alarm.at).toBe(AT_0900);

    expect(await tick(h)).toBe(`${DATE}:baba:fetch:ok`); // 順序: 通知 → 馬場 → タスク。馬場が先
    expect(h.api.calls).toBe(1);
    expect(h.store.finishes).toHaveLength(1);
    expect(h.store.finishes[0]!.finish.venues.map((v) => v.venueCode)).toEqual([...PLAN_VENUES]);
    expect(h.store.finishes[0]!.finish.slot).toBe(0);
    expect(h.store.finishes[0]!.finish.complete).toBe(true); // 計画の中央の場(06・09)がそろった
    // 取得は保存まで済んでいて、最初のレースの分析はその後に動く(値を受け取れる境界)
    expect(h.alarm.at).toBe(AT_0900); // 期限 09:00 の分析がまだ残っている(即時)
    const second = await tick(h);
    expect(second).not.toContain(":baba:");
    expect(second).toMatch(/^\d+:(morning|pre_race):/);
    expect(h.store.finishes).toHaveLength(1);
    expect(h.api.calls).toBe(1);
  });

  // 取得の枠は、最初の発走前の分析の期限に左右されない(計画の行の期限をずらして確かめる)。
  const firstDueCases: { name: string; first: string }[] = [
    { name: "08:30(取得より前。この分析は値なしで進む)", first: "2026-10-12T08:30:00" },
    { name: "09:05", first: "2026-10-12T09:05:00" },
    { name: "09:20", first: "2026-10-12T09:20:00" },
    { name: "10:00", first: "2026-10-12T10:00:00" },
  ];
  for (const c of firstDueCases) {
    it(`最初の発走前の分析の期限が ${c.name} でも、取得は 09:00 の 1 回目の枠(08:59:59 までは 0 回)`, async () => {
      const h = harness();
      await plan2100(h);
      // 計画の行の期限を、最初の期限が c.first になるようにずらす(前提を無条件に固定する)
      const delta = jst(c.first) - firstCentralDue(h);
      expect(delta).not.toBe(0);
      h.sql.exec("UPDATE race_day_plan SET due_ms = due_ms + ?", delta);
      expect(firstCentralDue(h)).toBe(jst(c.first));

      h.clock.now = AT_0900 - 1000;
      for (let i = 0; i < 30; i++) {
        const outcome = await h.core.runNextStep();
        expect(label(outcome)).not.toContain(":baba:");
      }
      expect(h.api.calls).toBe(0);

      h.clock.now = AT_0900;
      const labels: string[] = [];
      for (let i = 0; i < 30 && h.api.calls === 0; i++) labels.push(label(await h.core.runNextStep()));
      expect(labels.filter((l) => l.includes(":baba:"))).toEqual([`${DATE}:baba:fetch:ok`]);
      expect(h.api.calls).toBe(1);
      expect(h.store.finishes[0]!.finish.finishedAt).toBe(AT_0900);
    });
  }

  it("前夜のうち(21:00〜23:59)は取得しない(取得口は 0 回)", async () => {
    const h = harness();
    await plan2100(h);
    h.clock.now = jst("2026-10-11T23:59:00");
    expect(h.api.calls).toBe(0);
    expect(h.store.claimCalls.n).toBe(0);
    expect(meta(h, BABA_META_ATTEMPTED)).toBeNull();
    expect(meta(h, BABA_META_SLOT)).toBeNull();
  });

  it("取得口が無い構成では、アラームの候補にならず、取得も印もない", async () => {
    const h = harness({ baba: false });
    await plan2100(h);
    expect(h.alarm.at).toBe(firstPlannedDue(h)); // 09:00 の取得の候補が無い(分析の期限と同じ時刻なので、馬場があっても同じ値になるが、取得は起こらない)
    h.clock.now = AT_0900 + 3600_000;
    await h.core.runNextStep();
    expect(h.api.calls).toBe(0);
    expect(meta(h, BABA_META_ATTEMPTED)).toBeNull();
  });
});

describe("当日の値がそろうまで取り直す(Issue #480)", () => {
  it("値が載るまで 10 分おきに取り直し、そろった枠で止まる(10:10 に載る → 09:00・09:10・…・10:10 の 8 回。以後は 12:30 まで 0 回)", async () => {
    const h = harness();
    h.api.respond = () => (h.clock.now >= slotAt(7) ? planOutcome() : notYet());
    await plan2100(h);
    const times = await babaTimes(h, jst("2026-10-12T12:30:00"));
    expect(times).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(slotAt)); // 09:00 〜 10:10 の 10 分おき
    expect(h.api.calls).toBe(8);
    expect(slotAt(7)).toBe(jst("2026-10-12T10:10:00"));
    expect(h.store.finishes.map((f) => [f.finish.slot, f.finish.complete])).toEqual([[0, false], [1, false], [2, false], [3, false], [4, false], [5, false], [6, false], [7, true]]);
    expect(meta(h, BABA_META_DONE)).toBe("1");
  });

  it("最後まで載らない日は、12:00 の枠までの 19 回で打ち切り。それ以降は 0 回(最大 19 回)", async () => {
    const h = harness();
    h.api.respond = () => notYet();
    await plan2100(h);
    const times = await babaTimes(h, jst("2026-10-12T23:59:00"));
    expect(times).toEqual(Array.from({ length: BABA_FETCH_SLOTS }, (_, k) => slotAt(k)));
    expect(times.at(-1)).toBe(jst("2026-10-12T12:00:00"));
    expect(h.api.calls).toBe(BABA_FETCH_SLOTS);
    expect(h.store.claimed.size).toBe(BABA_FETCH_SLOTS); // 枠ごとに 1 回の claim
  });

  it("計画の場の一部だけ載った回は、載った場を先に保存し、残りの場が載るまで取り直す。載った場は保存し直さない(分母は計画の場)", async () => {
    const h = harness();
    h.api.respond = () => {
      const full = planOutcome();
      return h.clock.now >= slotAt(2) ? full : { ...full, venues: full.venues.slice(0, 1) }; // 06 だけ先に載る → 09:20 に 09 も載る
    };
    await plan2100(h);
    const times = await babaTimes(h, jst("2026-10-12T12:30:00"));
    expect(times).toEqual([0, 1, 2].map(slotAt));
    expect(h.store.finishes.map((f) => [f.finish.slot, f.finish.venues.map((v) => v.venueCode), f.finish.complete])).toEqual([
      [0, ["06"], false],
      [1, ["06"], false],
      [2, ["06", "09"], true],
    ]);
  });

  it("DO が眠っていても、アラームは次の枠の時刻に張られている(取得の直後のアラーム = 次の枠 09:10)", async () => {
    const h = harness();
    h.api.respond = () => notYet();
    await plan2100(h);
    // 分析のタスクに邪魔されないよう、計画の行を落とす(アラームの候補を馬場だけにする)
    h.sql.exec("DELETE FROM race_day_plan");
    h.sql.exec("DELETE FROM race_day_tasks");
    h.clock.now = AT_0900;
    h.alarm.at = null;
    expect(label(await h.core.runNextStep())).toBe(`${DATE}:baba:fetch:failed`);
    expect(h.alarm.at).toBe(slotAt(1));
  });

  it("最後の枠の後・12:10 以降に起きても取得しない。アラームの候補も張らない(日を越えても何もしない)", async () => {
    const h = harness();
    h.api.respond = () => notYet();
    await plan2100(h);
    h.sql.exec("DELETE FROM race_day_plan");
    h.sql.exec("DELETE FROM race_day_tasks");
    // 計画の確定が遅い日: 12:10 に初めて起きる → 未実行の枠があっても動かない
    h.clock.now = jst("2026-10-12T12:10:00");
    h.alarm.at = null;
    await h.core.runNextStep();
    expect(h.api.calls).toBe(0);
    expect(meta(h, BABA_META_SLOT)).toBeNull();
    h.clock.now = jst("2026-10-13T09:00:00"); // 日を越えた
    h.alarm.at = null;
    await h.core.runNextStep();
    expect(h.api.calls).toBe(0);
  });
});

describe("同じ枠を二度送らない(再起動・並行・再計画)", () => {
  it("同じ日のうちに何度アラームを進めても、そろえば取得口は 1 回だけ", async () => {
    const h = harness();
    await plan2100(h);
    await runDue(h, jst("2026-10-12T23:59:00"));
    expect(h.api.calls).toBe(1);
  });

  it("取得が失敗し続ける日(HTTP 500)も、同じ枠は再試行しない(1 枠 1 回)。DO の再起動の後も 19 回を超えない", async () => {
    const h = harness();
    h.api.respond = () => Promise.reject(new BabaFetchError("http-500"));
    await plan2100(h);
    expect(await tick(h)).toBe(`${DATE}:baba:fetch:failed`);
    expect(h.store.finishes[0]!.finish.result).toBe("http-500");
    restart(h);
    await h.core.requestPlan({ kaisaiDate: DATE }); // 再配信(already-planned。アラームを張り直す)
    const times = await babaTimes(h, jst("2026-10-12T23:59:00"));
    expect(times).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(slotAt)); // 枠 0 は済み。次の枠から取り直す(各枠 1 回)
    expect(h.api.calls).toBe(BABA_FETCH_SLOTS);
  });

  it("DO の再起動(新しい core・同じ SQLite)の後も、そろった日は 1 回のまま", async () => {
    const h = harness();
    await plan2100(h);
    await tick(h);
    restart(h);
    h.clock.now = AT_0900 + 3600_000;
    for (let i = 0; i < 5; i++) await h.core.runNextStep();
    expect(h.api.calls).toBe(1);
  });

  it("DO の印だけが無い状態(claim の後・印の前のクラッシュ)でも、D1 が持つ状態(そろった/枠の claim)で取得しない", async () => {
    const h = harness();
    await plan2100(h);
    await tick(h); // そろう → D1 は done
    h.sql.exec("DELETE FROM race_day_meta WHERE key IN (?, ?, ?)", BABA_META_ATTEMPTED, BABA_META_SLOT, BABA_META_DONE);
    restart(h);
    h.clock.now = AT_0900 + 3600_000;
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(h.api.calls).toBe(1);
    expect(meta(h, BABA_META_DONE)).toBe("1"); // 完了の印は書き直される
  });

  it("並行して runNextStep を呼んでも、取得口は 1 回だけ", async () => {
    const h = harness();
    await plan2100(h);
    h.clock.now = AT_0900;
    h.alarm.at = null;
    const outcomes = await Promise.all([h.core.runNextStep(), h.core.runNextStep()]);
    expect(h.api.calls).toBe(1);
    expect(outcomes.map(label).filter((l) => l.includes(":baba:"))).toHaveLength(1);
  });

  it("そろった後の再計画(救済 rescue・再配信)でも、取得しない", async () => {
    const h = harness();
    await plan2100(h);
    await tick(h);
    expect(h.api.calls).toBe(1);
    h.clock.now = AT_0900 + 60_000;
    expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: true })).toEqual({ accepted: false, reason: "already-planned" });
    expect(await h.core.requestPlan({ kaisaiDate: DATE })).toEqual({ accepted: false, reason: "already-planned" });
    await runDue(h, jst("2026-10-12T23:59:00"));
    expect(h.api.calls).toBe(1);
  });

  it("中央の一覧が取れなかった日は取得せず、再計画(救済)で中央の一覧が取れて確定したその時点で、いまの枠を 1 回取得する。そろえば以後の救済・再配信では送らない", async () => {
    const h = harness();
    h.gate.failures.central = [blocked()];
    await h.core.requestPlan({ kaisaiDate: DATE });
    await runDue(h, jst("2026-10-11T23:59:00")); // 中央の行が無いので、最初の期限(09:00)の行も無い
    // 前提: 中央は失敗(中央の行が無い)で、09:30 を過ぎても取得しない
    expect((h.sql.exec("SELECT state FROM race_day_plan_venue WHERE venue = 'central'").toArray() as { state: string }[])[0]?.state).toBe("failed");
    await runDue(h, jst("2026-10-12T09:30:00"));
    h.clock.now = jst("2026-10-12T09:30:00");
    await h.core.runNextStep();
    expect(h.api.calls).toBe(0);
    expect(h.store.claimCalls.n).toBe(0);

    expect(await h.core.requestPlan({ kaisaiDate: DATE, rescue: true })).toEqual({ accepted: false, reason: "already-planned" });
    const labels = await runDue(h, jst("2026-10-12T09:59:00"));
    expect(labels.filter((l) => l.includes(":baba:"))).toEqual([`${DATE}:baba:fetch:ok`]);
    expect(h.api.calls).toBe(1);
    expect(h.store.finishes[0]!.finish.slot).toBe(3); // 09:30 = 枠 3(遅れて起きた枠を埋めず、いまの枠だけ)

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
    h.clock.now = AT_0900;
    const raceId = (h.sql.exec("SELECT race_id FROM race_day_plan WHERE venue = 'central' ORDER BY race_id LIMIT 1").toArray() as { race_id: string }[])[0]!.race_id;
    expect(await h.core.schedule({ raceId, kaisaiDate: DATE })).toMatchObject({ accepted: true });
    // 09:00 は最初の発走前の分析の期限でもある。そのままだと、期限の来た発走前の分析(計画の行の昇格)が手動の予約の morning より先に動いてしまうので、
    // 計画の行の期限を 1 時間後へずらして、割り込みの無い状態にする(馬場のステップの前に。昇格は runNextStep の先頭で行われるため、後からずらしても効かない)。
    h.sql.exec("UPDATE race_day_plan SET due_ms = due_ms + 3600000 WHERE state = 'planned'");
    h.alarm.at = null;
    expect(label(await h.core.runNextStep())).toBe(`${DATE}:baba:fetch:failed`); // 先に 1 ステップだけ
    // 同じ起床の次のステップは、すぐ手動の予約の morning(厳密。ゲートは偽でブレーカー拒否)。起床を無駄にしない
    expect(label(await h.core.runNextStep())).toBe(`${raceId}:morning:fetch:failed`);
    // 続きのステップでも、次の枠(09:10)より前には取得しない(同じ枠は 1 回)
    const following: string[] = [];
    for (let i = 0; i < 5 && h.alarm.at !== null && h.alarm.at < slotAt(1); i++) following.push(await tick(h));
    expect(following.filter((l) => l.includes(":baba:"))).toEqual([]);
    expect(h.api.calls).toBe(1);
  });

  it("取得口が想定外の例外を投げても、runNextStep は例外にしない(DO のアラームの再実行を起こさない)", async () => {
    const h = harness();
    h.api.respond = () => {
      throw new TypeError("想定外 https://secret.test.invalid/x");
    };
    await plan2100(h);
    h.clock.now = AT_0900;
    h.alarm.at = null;
    await expect(h.core.runNextStep()).resolves.toMatchObject({ mode: "baba", result: "failed" });
    expect(h.warns.join("\n")).not.toContain("secret.test.invalid");
  });
});
