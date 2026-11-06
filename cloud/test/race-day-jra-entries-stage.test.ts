import { afterEach, describe, expect, it } from "vitest";

import type { JraEntriesFetcher } from "../src/jra-entries-fetch";
import {
  JRA_ENTRIES_LAST_JST,
  JRA_ENTRIES_MAX_ATTEMPTS,
  JRA_ENTRIES_META_DONE,
  JRA_ENTRIES_META_LAST_MS,
  JRA_ENTRIES_META_STATE,
  JRA_ENTRIES_PAGES_PER_STEP,
  JRA_ENTRIES_RETRY_MS,
  JRA_ENTRIES_START_JST,
  JRA_ENTRIES_STEP_GAP_MS,
  JraEntriesStage,
  type JraEntriesFacts,
} from "../src/race-day-jra-entries";
import { JRA_GAP_MS } from "../src/jra-http";
import { fakeCname, fakeFetcher, fakeStore, world, type FakeStore, type World, type Trace } from "./jra-entries-fakes";
import { openNodeSql, type NodeSql } from "./node-sql";
import { installFetchTrap } from "./fetch-trap";

/**
 * Issue #639: 日単位の DO の中の、JRA の出馬表の取得の段(`JraEntriesStage`)の単体。いつ動けるか・1 起床 = 1 場(JRA への本数の上限)・
 * CNAME の使い回し・試みを先に永続化して 1 回に収めること・失敗しても例外にしないこと。
 * 取得口・保存先は偽。**実際の JRA には一切アクセスしない**。ストレージは `node:sqlite`(本物の SQLite)。
 */

installFetchTrap();

const DATE = "20261108";
const jst = (s: string): number => Date.parse(`${s}+09:00`);
const AT_0700 = jst("2026-11-08T07:00:00");
const MIN = 60_000;

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

const cnameOf = (venue: string, race: number): string => fakeCname(DATE, venue, race);

const GOOD_FACTS: JraEntriesFacts = { kaisaiDate: DATE, planFinalized: true, centralListed: true, venueCodes: ["05", "06", "09"] };

interface Harness {
  stage: JraEntriesStage;
  sql: NodeSql;
  store: FakeStore;
  clock: { now: number };
  facts: { -readonly [K in keyof JraEntriesFacts]: JraEntriesFacts[K] };
  warns: string[];
  infos: string[];
  w: World;
  trace: Trace;
  atFetch: { claimed: string[]; stateAttempts: string | null }[];
}

function harness(options: { facts?: Partial<JraEntriesFacts>; sql?: NodeSql; store?: FakeStore; now?: number; world?: World; noFetcher?: boolean; noStore?: boolean } = {}): Harness {
  const sql = options.sql ?? openNodeSql();
  if (options.sql === undefined) opened.push(sql);
  sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const store = options.store ?? fakeStore();
  const w = options.world ?? world({ "05": 12, "06": 12, "09": 12 });
  const { fetcher: inner, trace } = fakeFetcher(w);
  const clock = { now: options.now ?? AT_0700 };
  const facts = { ...GOOD_FACTS, ...options.facts };
  const atFetch: Harness["atFetch"] = [];
  const metaState = (): string | null => (sql.exec("SELECT value FROM race_day_meta WHERE key = ?", JRA_ENTRIES_META_STATE).toArray() as { value: string }[])[0]?.value ?? null;
  // 取得口が呼ばれた瞬間の永続化の状態(「試みた」が JRA に出る前に書かれているか)を記録する。
  const fetcher: JraEntriesFetcher = {
    open() {
      atFetch.push({ claimed: [...store.claimed], stateAttempts: metaState() });
      return inner.open();
    },
  };
  const warns: string[] = [];
  const infos: string[] = [];
  const stage = new JraEntriesStage({
    sql,
    now: () => clock.now,
    fetcher: options.noFetcher === true ? undefined : fetcher,
    store: options.noStore === true ? undefined : store,
    onWarn: (m) => warns.push(m),
    onInfo: (m) => infos.push(m),
    facts: () => facts,
  });
  return { stage, sql, store, clock, facts, warns, infos, w, trace, atFetch };
}

const meta = (h: Pick<Harness, "sql">, key: string): string | null => (h.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[])[0]?.value ?? null;

/** 動ける間、時計を期限まで進めて 1 ステップずつ実行する。ステップごとの結果と JRA への本数を返す。 */
async function runAll(h: Harness, limit = 30): Promise<{ result: string; requests: number }[]> {
  const out: { result: string; requests: number }[] = [];
  for (let i = 0; i < limit; i++) {
    const due = h.stage.dueAtMs();
    if (due === null) break;
    h.clock.now = Math.max(h.clock.now, due);
    if (!h.stage.runnable()) break;
    const before = h.trace.calls.length;
    const o = await h.stage.run();
    out.push({ result: o.result, requests: h.trace.calls.length - before });
  }
  return out;
}

describe("定数", () => {
  it("07:00 JST から 15:00 JST まで・1 起床の JRA への本数は 13 本(開催の選択 1 + 場ごとのレースの選択 ≤3 は別の回、詳細は 1 場 12 + レースの選択 1)", () => {
    expect(JRA_ENTRIES_START_JST).toBe("07:00");
    expect(JRA_ENTRIES_LAST_JST).toBe("15:00");
    expect(JRA_ENTRIES_PAGES_PER_STEP).toBe(13);
    expect(JRA_ENTRIES_MAX_ATTEMPTS).toBe(3);
    expect(JRA_ENTRIES_RETRY_MS).toBe(10 * MIN);
    expect(JRA_ENTRIES_STEP_GAP_MS).toBeGreaterThanOrEqual(JRA_GAP_MS);
  });
});

describe("期限(dueAtMs)と runnable", () => {
  it("開催日の 07:00 が最初の期限。前夜からでも、その日の朝でも 07:00(前夜は動かさない)", () => {
    for (const now of [jst("2026-11-07T21:30:00"), jst("2026-11-08T05:00:00"), AT_0700]) {
      const h = harness({ now });
      expect(h.stage.dueAtMs()).toBe(AT_0700);
    }
  });
  it("07:00 より前は runnable でない(前夜には JRA に出ない)。07:00 で runnable", () => {
    const h = harness({ now: jst("2026-11-08T06:59:59") });
    expect(h.stage.runnable()).toBe(false);
    h.clock.now = AT_0700;
    expect(h.stage.runnable()).toBe(true);
  });
  const none: { name: string; options: Parameters<typeof harness>[0] }[] = [
    { name: "計画が確定していない", options: { facts: { planFinalized: false } } },
    { name: "中央の一覧が無い(地方だけの日)", options: { facts: { centralListed: false } } },
    { name: "開催日が未確定", options: { facts: { kaisaiDate: null } } },
    { name: "取得口が無い(機能全体が止まる)", options: { noFetcher: true } },
    { name: "保存先が無い", options: { noStore: true } },
    { name: "開催日が過去(今日 JST が開催日より後)", options: { now: jst("2026-11-09T00:00:00") } },
    { name: "15:00 を過ぎた", options: { now: jst("2026-11-08T15:00:00") } },
  ];
  for (const c of none) {
    it(`${c.name} → null(アラームの候補にならず、runnable でもない)`, () => {
      const h = harness({ now: AT_0700, ...c.options });
      expect(h.stage.dueAtMs()).toBeNull();
      expect(h.stage.runnable()).toBe(false);
    });
  }
  it("動けないときの run は何もせず retry(JRA にも D1 にも出ない・印も書かない)", async () => {
    const h = harness({ now: jst("2026-11-08T06:00:00") });
    const o = await h.stage.run();
    expect(o).toMatchObject({ kind: "ran", mode: "jra-entries", result: "retry" });
    expect(h.trace.calls).toEqual([]);
    expect(h.store.claims).toEqual([]);
    expect(meta(h, JRA_ENTRIES_META_STATE)).toBeNull();
  });
});

describe("1 日の流れ(開催の選択 → 場ごとの詳細。1 起床 = 1 場)", () => {
  it("1 回目は開催の選択 + 場ごとのレースの選択(1 + 3 = 4 本)、続く 3 回は 1 場 12 本ずつ。合計 4 回・40 本(= 1 + 場の数 + レース数)で、どの回も 13 本以下", async () => {
    const h = harness();
    const steps = await runAll(h);
    expect(steps.map((s) => s.result)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(steps.map((s) => s.requests)).toEqual([4, 12, 12, 12]);
    expect(steps.every((s) => s.requests <= JRA_ENTRIES_PAGES_PER_STEP)).toBe(true);
    expect(steps.reduce((n, s) => n + s.requests, 0)).toBe(1 + 3 + 36);
    // 開催の選択・レースの選択は 1 回目だけ(CNAME は meta に置いて使い回す)
    expect(h.trace.calls.filter((c) => c.startsWith("venues:"))).toHaveLength(1);
    expect(h.trace.calls.filter((c) => c.startsWith("races:"))).toHaveLength(3);
    expect(h.trace.calls.filter((c) => c.startsWith("race:"))).toHaveLength(36);
    expect(h.trace.sessions).toHaveLength(4);
    expect(h.stage.dueAtMs()).toBeNull();
    expect(meta(h, JRA_ENTRIES_META_DONE)).toBe("1");
  });
  it("想定外に多いレース(1 場 20 レース)でも、1 起床の JRA への本数は上限の 13 本まで。残りは次の起床で取る(取り残しを失わない)", async () => {
    const h = harness({ world: world({ "05": 20 }), facts: { venueCodes: ["05"] } });
    const steps = await runAll(h);
    expect(steps.every((s) => s.requests <= JRA_ENTRIES_PAGES_PER_STEP)).toBe(true);
    expect(Math.max(...steps.map((s) => s.requests))).toBe(JRA_ENTRIES_PAGES_PER_STEP); // 空振りでない(上限まで使った回がある)
    expect(h.trace.calls.filter((c) => c.startsWith("race:"))).toHaveLength(20);
    expect(new Set(h.trace.calls.filter((c) => c.startsWith("race:"))).size).toBe(20); // 同じレースを二重に取らない
    expect(h.store.saves.reduce((n, s) => n + s.races.length, 0)).toBe(20);
    expect(h.stage.dueAtMs()).toBeNull();
  });
  it("保存: 12 レースぶんを場ごとに 1 回の saveRaces にまとめる(D1 の文を増やさない)。claim は (場, 試行) ごと・結果は complete", async () => {
    const h = harness();
    await runAll(h);
    expect(h.store.saves.map((s) => s.races.length)).toEqual([12, 12, 12]);
    expect(h.store.saves.every((s) => s.date === DATE)).toBe(true);
    expect(h.store.claims).toEqual([
      { venue: "00", attempt: 1 },
      { venue: "05", attempt: 1 },
      { venue: "06", attempt: 1 },
      { venue: "09", attempt: 1 },
    ]);
    expect(h.store.finishes.map((f) => [f.venue, f.finish.result, f.finish.complete, f.finish.racesTotal, f.finish.racesSaved])).toEqual([
      ["00", "ok", false, 3, 3],
      ["05", "ok", true, 12, 12],
      ["06", "ok", true, 12, 12],
      ["09", "ok", true, 12, 12],
    ]);
    expect(h.store.finishes.slice(1).every((f) => f.finish.requests === 12)).toBe(true);
  });
  it("次の回は前の回の STEP_GAP 後(JRA への取得を詰めない)", async () => {
    const h = harness();
    h.clock.now = AT_0700;
    await h.stage.run();
    expect(h.stage.runnable()).toBe(false);
    expect(h.stage.dueAtMs()).toBe(AT_0700 + JRA_ENTRIES_STEP_GAP_MS);
    h.clock.now = AT_0700 + JRA_ENTRIES_STEP_GAP_MS;
    expect(h.stage.runnable()).toBe(true);
  });
  it("計画の場(venueCodes)があれば、その場だけを取る(計画に無い場には出ない)。空なら開催の選択にある全部の場", async () => {
    const only = harness({ facts: { venueCodes: ["06"] } });
    await runAll(only);
    expect(only.trace.calls.filter((c) => c.startsWith("races:"))).toEqual(["races:06"]);
    expect(only.store.saves).toHaveLength(1);
    const all = harness({ facts: { venueCodes: [] } });
    await runAll(all);
    expect(all.trace.calls.filter((c) => c.startsWith("races:"))).toHaveLength(3);
  });
  it("試みを JRA に出る前に永続化する(取得口が開かれた時点で、claim と状態の meta が書かれている)", async () => {
    const h = harness();
    await runAll(h);
    expect(h.atFetch[0]!.claimed).toEqual([`${DATE}:00:1`]);
    expect(h.atFetch[1]!.claimed).toContain(`${DATE}:05:1`);
    const venues = (JSON.parse(h.atFetch[1]!.stateAttempts!) as { venues: { code: string; attempts: number }[] }).venues;
    expect(venues.find((v) => v.code === "05")?.attempts).toBe(1); // JRA に出る前に、その試みの回数が書かれている
    expect(venues.find((v) => v.code === "06")?.attempts).toBe(0);
  });
  it("1 起床の所要時間と結果を、固定の語のログ(onInfo)と meta に残す", async () => {
    const h = harness();
    h.clock.now = AT_0700;
    await h.stage.run();
    expect(h.infos).toHaveLength(1);
    expect(h.infos[0]).toMatch(/^JRA の出馬表の取得: 場=00 試行=1 結果=ok 本数=4 保存=3\/3 所要=\d+ms$/);
    expect(meta(h, JRA_ENTRIES_META_LAST_MS)).toMatch(/^\d+$/);
  });
});

describe("失敗の扱い(例外にしない・取れた分だけ保存・再試行)", () => {
  it("詳細の一部が失敗: 取れたレースだけ保存し(partial)、10 分後に失敗したレースだけを取り直す(開催の選択・レースの選択には出ない)", async () => {
    const h = harness({ facts: { venueCodes: ["05"] } });
    h.w.failRace.set(cnameOf("05", 3), ["timeout"]);
    h.w.failRace.set(cnameOf("05", 7), ["http-503"]);
    h.clock.now = AT_0700;
    await h.stage.run(); // 開催の選択
    h.clock.now += JRA_ENTRIES_STEP_GAP_MS;
    const o = await h.stage.run();
    expect(o.result).toBe("failed");
    expect(h.store.saves[0]!.races).toHaveLength(10);
    expect(h.store.finishes.at(-1)).toMatchObject({ venue: "05", attempt: 1, finish: { result: "partial", complete: false, racesTotal: 12, racesSaved: 10 } });
    expect(h.stage.runnable()).toBe(false);
    expect(h.stage.dueAtMs()).toBe(h.clock.now + JRA_ENTRIES_RETRY_MS);
    h.clock.now += JRA_ENTRIES_RETRY_MS;
    const before = h.trace.calls.length;
    const o2 = await h.stage.run();
    expect(o2.result).toBe("ok");
    expect(h.trace.calls.slice(before)).toEqual([`race:${cnameOf("05", 3)}`, `race:${cnameOf("05", 7)}`]);
    expect(h.store.saves[1]!.races).toHaveLength(2);
    expect(h.store.finishes.at(-1)).toMatchObject({ venue: "05", attempt: 2, finish: { result: "ok", complete: true, racesTotal: 2, racesSaved: 2 } });
    expect(h.stage.dueAtMs()).toBeNull();
  });
  it("場ごとに試行は MAX 回まで。尽きたらその場は諦め、他の場は続ける。全部が済めば以後動かない(警告は固定の語だけ)", async () => {
    const h = harness({ facts: { venueCodes: ["05", "06"] } });
    const bad = cnameOf("05", 1);
    h.w.failRace.set(bad, ["network", "network", "network", "network", "network"]);
    const steps = await runAll(h, 40);
    expect(h.store.finishes.filter((f) => f.venue === "05")).toHaveLength(JRA_ENTRIES_MAX_ATTEMPTS);
    expect(h.store.finishes.filter((f) => f.venue === "06").map((f) => f.finish.complete)).toEqual([true]);
    expect(steps.length).toBeLessThan(40);
    expect(h.stage.dueAtMs()).toBeNull();
    expect(meta(h, JRA_ENTRIES_META_DONE)).toBe("1");
    expect(h.warns.length).toBeGreaterThan(0);
    for (const m of h.warns) expect(m).not.toMatch(/https?:|secret|invalid/);
    expect(h.warns.some((m) => m.includes("network"))).toBe(true);
  });
  it("開催の選択が失敗: 10 分後に取り直す。MAX 回失敗したら諦める", async () => {
    const h = harness();
    h.w.failVenueList.push("http-500", "timeout", "network");
    h.clock.now = AT_0700;
    expect((await h.stage.run()).result).toBe("failed");
    expect(h.stage.dueAtMs()).toBe(AT_0700 + JRA_ENTRIES_RETRY_MS);
    await runAll(h);
    expect(h.store.finishes.map((f) => [f.venue, f.attempt, f.finish.result])).toEqual([
      ["00", 1, "http-500"],
      ["00", 2, "timeout"],
      ["00", 3, "network"],
    ]);
    expect(h.stage.dueAtMs()).toBeNull();
    expect(h.trace.calls.filter((c) => c.startsWith("race:"))).toEqual([]);
  });
  it("開催の選択にその日の場が無い(ページは読めた)は no-venues として扱い、取り直す", async () => {
    const h = harness({ world: world({}) });
    h.clock.now = AT_0700;
    expect((await h.stage.run()).result).toBe("failed");
    expect(h.store.finishes[0]).toMatchObject({ venue: "00", finish: { result: "no-venues", complete: false } });
  });
  it("場のレースの選択だけが失敗: その場は venue の回で取り直す(開催の選択はやり直さない)", async () => {
    const h = harness({ facts: { venueCodes: ["05", "06"] } });
    h.w.failRaceList.set("06", ["timeout"]);
    const steps = await runAll(h);
    expect(steps.map((s) => s.result)).toEqual(["ok", "ok", "ok"]);
    expect(h.trace.calls.filter((c) => c.startsWith("venues:"))).toHaveLength(1);
    expect(h.trace.calls.filter((c) => c === "races:06")).toHaveLength(2);
    expect(h.store.saves.map((s) => s.races.length)).toEqual([12, 12]);
    // 06 の回: レースの選択 1 + 詳細 12 = 13 本(上限ちょうど)
    expect(h.store.finishes.find((f) => f.venue === "06")?.finish.requests).toBe(13);
  });
  it("param-error(CNAME の符号が古い): 開催の選択からたどり直す(1 回だけ)。2 回目の param-error は諦める", async () => {
    const h = harness({ facts: { venueCodes: ["05"] } });
    h.w.failRace.set(cnameOf("05", 1), ["param-error", "param-error", "param-error", "param-error", "param-error"]);
    const steps = await runAll(h);
    expect(h.trace.calls.filter((c) => c.startsWith("venues:"))).toHaveLength(2);
    expect(steps.at(-1)).toBeDefined();
    expect(h.store.finishes.filter((f) => f.finish.result === "param-error").length).toBeGreaterThanOrEqual(1);
    expect(h.stage.dueAtMs()).toBeNull();
    expect(meta(h, JRA_ENTRIES_META_DONE)).toBe("1");
    expect(h.trace.calls.filter((c) => c.startsWith("venues:"))).toHaveLength(2); // 3 回目のたどり直しは無い
  });
  it("馬の ID が 10 桁でないなどで保存しなかった馬の数を、結果に残す", async () => {
    const h = harness({ facts: { venueCodes: ["05"] } });
    h.w.skippedPerRace = 1;
    await runAll(h);
    expect(h.store.finishes.at(-1)?.finish.horsesSkipped).toBe(12);
  });
  it("保存に失敗: 保存できなかったレースは取り直す(警告は固定の語。例外の文面・URL は残さない)", async () => {
    const h = harness({ facts: { venueCodes: ["05"] } });
    h.store.failSave = 1;
    const steps = await runAll(h);
    expect(h.store.saves).toHaveLength(1);
    expect(steps.map((s) => s.result)).toEqual(["ok", "failed", "ok"]);
    expect(h.store.finishes.filter((f) => f.venue === "05").map((f) => f.finish.result)).toEqual(["save-failed", "ok"]);
    for (const m of h.warns) expect(m).not.toMatch(/https?:|secret|invalid|D1 の保存に失敗/);
  });
  it("claim の失敗(D1 が応答しない): JRA に出ずに、その試みを使い切って再試行する", async () => {
    const h = harness({ facts: { venueCodes: ["05"] } });
    h.store.failClaim = 1;
    h.clock.now = AT_0700;
    const o = await h.stage.run();
    expect(o.result).toBe("retry");
    expect(h.trace.calls).toEqual([]);
    expect(h.stage.dueAtMs()).toBe(AT_0700 + JRA_ENTRIES_RETRY_MS);
    await runAll(h);
    expect(h.store.saves).toHaveLength(1);
  });
  it("結果の記録(finish)の失敗は、保存済みのまま続ける(同じ試みを取り直さない)", async () => {
    const h = harness({ facts: { venueCodes: ["05"] } });
    h.store.failFinish = true;
    const steps = await runAll(h);
    expect(h.store.saves).toHaveLength(1);
    expect(steps.length).toBe(2);
    expect(h.stage.dueAtMs()).toBeNull();
  });
});

describe("例外を投げない(分析を止めない)", () => {
  it("取得口・保存先・状態の meta が壊れていても、run は例外を投げない", async () => {
    const h = harness();
    h.w.throwOnOpen = true;
    h.clock.now = AT_0700;
    await expect(h.stage.run()).resolves.toMatchObject({ kind: "ran", mode: "jra-entries", result: "failed" });
    expect(h.warns.length).toBeGreaterThan(0);
    expect(h.warns.every((m) => !/https?:|secret|invalid/.test(m))).toBe(true);
    // 取得口が壊れても、試みの結果は D1 に固定の語(other)で残る(claim は済んでいる)
    expect(h.store.finishes.map((f) => [f.venue, f.attempt, f.finish.result, f.finish.complete])).toEqual([["00", 1, "other", false]]);

    const h2 = harness();
    h2.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?)", JRA_ENTRIES_META_STATE, "{ これは JSON ではない");
    h2.clock.now = AT_0700;
    await expect(h2.stage.run()).resolves.toMatchObject({ kind: "ran", mode: "jra-entries" });
    expect(h2.stage.dueAtMs()).not.toBeUndefined();

    const h3 = harness();
    h3.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?)", JRA_ENTRIES_META_STATE, JSON.stringify({ venues: [{ code: 5, races: "x" }] }));
    h3.clock.now = AT_0700;
    await expect(h3.stage.run()).resolves.toMatchObject({ kind: "ran" });
  });
  it("DO のストレージ(状態の meta)が書けなくても、run は例外を投げない(外側の握り)。警告は固定の語", async () => {
    const real = openNodeSql();
    opened.push(real);
    const failing = { writes: false };
    const sql: NodeSql = {
      ...real,
      exec(query: string, ...bindings: unknown[]) {
        if (failing.writes && query.startsWith("INSERT INTO race_day_meta")) throw new Error("SQLITE_FULL https://do.test.invalid/secret");
        return real.exec(query, ...bindings);
      },
    };
    const h = harness({ sql });
    h.clock.now = AT_0700;
    failing.writes = true;
    await expect(h.stage.run()).resolves.toMatchObject({ kind: "ran", mode: "jra-entries", result: "failed" });
    expect(h.warns.length).toBeGreaterThan(0);
    expect(h.warns.every((m) => !/https?:|secret|invalid|SQLITE/.test(m))).toBe(true);
  });
  it("実行中は二重に動かない", async () => {
    const h = harness();
    h.clock.now = AT_0700;
    const first = h.stage.run();
    expect(h.stage.runnable()).toBe(false);
    await first;
  });
});

describe("D1 に印が残っていて DO のストレージが消えた場合", () => {
  it("開催の選択の試行 1 が既にある(exists)なら、JRA に出ずにその試みを使い切り、次は試行 2 で取る", async () => {
    const store = fakeStore();
    store.claimed.add(`${DATE}:00:1`);
    const h = harness({ store });
    h.clock.now = AT_0700;
    const o = await h.stage.run();
    expect(o.result).toBe("failed");
    expect(h.trace.calls).toEqual([]);
    await runAll(h);
    expect(store.claims.filter((c) => c.venue === "00").map((c) => c.attempt)).toEqual([1, 2]);
    expect(store.saves).toHaveLength(3);
  });
  it("その場が D1 で complete(done)なら、JRA に出ずにその場を済みにする", async () => {
    const store = fakeStore();
    store.doneVenues.add("06");
    const h = harness({ store, facts: { venueCodes: ["05", "06"] } });
    await runAll(h);
    expect(h.trace.calls.filter((c) => c.startsWith("race:")).every((c) => c.includes("pw01dde0105"))).toBe(true);
    expect(store.saves).toHaveLength(1);
    expect(h.stage.dueAtMs()).toBeNull();
  });
});
