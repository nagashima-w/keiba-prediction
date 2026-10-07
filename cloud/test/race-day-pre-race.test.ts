import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #178(#164-c): 日単位の DO の発走前の分析(`mode: "pre_race"`。LLM なし)。出馬表・オッズ・組合せ(設定が ON のときだけ)を取り直す → prior → EV → 配分 →
 * D1・R2 に保存(`AnalysisSink`)。ステップは2段(取得 → 計算・保存)。ゲート・保存先は偽。ストレージは `node:sqlite`。
 * AC: c1 同じレースを2回実行しても保存は1件 / c2 朝のキャッシュがあるとき発走前の取得は出馬表 1 + 単勝複勝 1(+ 組合せ ON なら 6)で戦績は取り直さない /
 * c3 取消馬を除く / c5 計算ステップで gate は0回 / c6 1回の呼び出しの合計 < 45。
 */

const DATE = "20260628";
const RACE = "202603020211";
const encoder = new TextEncoder();

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

interface FakeGate extends GateLike {
  readonly urls: string[];
  /** URL → 本文(null なら 404)。既定は 202603020211 のフィクスチャ。 */
  body: (url: string) => string | null;
}

function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    body: (url) => fixtureForUrl(url),
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const text = gate.body(url);
      if (text === null) {
        return { kind: "response", status: 404, contentType: "text/html; charset=UTF-8", body: bytes("not found"), queuedMs: 0, elapsedMs: 1 };
      }
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}

interface FakeSink extends AnalysisSink {
  readonly saved: AnalysisRecord[];
  readonly calls: string[];
  /** save をこの回数だけ「保存してから例外」にする(D1 へ書いた後、応答を受け取る前にクラッシュした状況の模擬)。 */
  crashAfterSave: number;
  /** save をこの回数だけ、保存せずに例外にする(D1・R2 の一時的な失敗)。 */
  failBeforeSave: number;
  childrenOverride: { horses: number; bets: number } | null;
}

function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    calls: [],
    crashAfterSave: 0,
    failBeforeSave: 0,
    childrenOverride: null,
    async save(record) {
      sink.calls.push("save");
      if (sink.failBeforeSave > 0) {
        sink.failBeforeSave -= 1;
        throw new Error("D1 の一時的な失敗");
      }
      sink.saved.push(record);
      if (sink.crashAfterSave > 0) {
        sink.crashAfterSave -= 1;
        throw new Error("保存後のクラッシュ");
      }
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt(raceId, analyzedAt) {
      sink.calls.push("find");
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async countChildren(id) {
      sink.calls.push("count");
      if (sink.childrenOverride !== null) return sink.childrenOverride;
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

const ALL_ON: CloudSettings = {
  ...DEFAULT_CLOUD_SETTINGS,
  bankroll: 1_000_000,
  perRaceCap: 100_000,
  kellyFraction: 0.5,
  includeComboOdds: true,
};

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
  readonly settingsLoads: number[];
  settings: CloudSettings;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(overrides: Partial<RaceDayDeps> = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const settingsLoads: number[] = [];
  const gate = fakeGate();
  const sink = fakeSink();
  const h = { sql, gate, sink, clock, alarm, warnings, settingsLoads, settings: ALL_ON } as Harness;
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => {
      settingsLoads.push(clock.now);
      return h.settings;
    },
    ...overrides,
  });
  (h as { core: RaceDayCore }).core = core;
  return h;
}

async function drive(h: Harness, max = 20): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < max; i++) {
    const at = h.alarm.at;
    if (at === null) return outcomes;
    h.clock.now = Math.max(h.clock.now, at);
    h.alarm.at = null;
    const outcome = await h.core.runNextStep();
    outcomes.push(outcome.kind === "idle" ? "idle" : `${outcome.mode}:${outcome.step}:${outcome.result}`);
    if (outcome.kind === "idle") return outcomes;
  }
  throw new Error("アラームが止まらない(上限超過)");
}

/** 朝の準備(取得 → 計算)を手動で2ステップ回す。`drive` は掃除専用のアラーム(26 時間後)まで進めてキャッシュを消すので、朝のキャッシュを残したいテストでは使わない。 */
async function runMorning(h: Harness): Promise<void> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
  await h.core.runNextStep();
  await h.core.runNextStep();
}

const urlsOf = (gate: FakeGate, from: number): string[] => gate.urls.slice(from);
const count = (urls: string[], fragment: string): number => urls.filter((u) => u.includes(fragment)).length;

describe("発走前の分析: 取得ステップ(AC-c2)", () => {
  it("朝のキャッシュがあるとき(出馬表の TTL 10 分は過ぎ、調教・戦績 24 時間の内側)、発走前の取得は 8 本: 出馬表 1 + 単勝複勝 1 + 組合せ 6。戦績は取り直さない", async () => {
    const h = harness();
    await runMorning(h); // 朝(mode 省略 = morning)
    expect(h.gate.urls).toHaveLength(19);
    h.clock.now += 20 * 60_000; // 20 分後
    const before = h.gate.urls.length;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    h.clock.now = h.alarm.at!;
    await h.core.runNextStep(); // 発走前の取得ステップ
    const fetched = urlsOf(h.gate, before);
    expect(fetched).toHaveLength(8);
    expect(count(fetched, "shutuba.html")).toBe(1);
    expect(count(fetched, "api_get_jra_odds")).toBe(7); // 単勝複勝(type=1)1 + 組合せ 6
    for (const type of [1, 3, 4, 5, 6, 7, 8]) {
      expect(count(fetched, `type=${type}`), `type=${type}`).toBe(1);
    }
    expect(count(fetched, "ajax_horse_results")).toBe(0); // 戦績は取り直さない
    expect(count(fetched, "oikiri.html")).toBe(0);
  });

  it("組合せオッズが OFF(既定)なら、発走前の取得は 2 本(出馬表 1 + 単勝複勝 1)", async () => {
    const h = harness();
    h.settings = { ...ALL_ON, includeComboOdds: false };
    await runMorning(h);
    h.clock.now += 20 * 60_000;
    const before = h.gate.urls.length;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    h.clock.now = h.alarm.at!;
    await h.core.runNextStep();
    expect(urlsOf(h.gate, before).sort()).toHaveLength(2);
    expect(count(urlsOf(h.gate, before), "type=1")).toBe(1);
  });

  it("オッズは、キャッシュの TTL(60 秒)の内側でも取り直す(発走前は常に最新): 朝の直後(30 秒後)でも、オッズ(と組合せ)は取得する", async () => {
    const h = harness();
    await runMorning(h);
    h.clock.now += 30_000;
    const before = h.gate.urls.length;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    h.clock.now = h.alarm.at!;
    await h.core.runNextStep();
    const fetched = urlsOf(h.gate, before);
    expect(count(fetched, "api_get_jra_odds")).toBe(7);
    expect(count(fetched, "shutuba.html")).toBe(0); // 出馬表は TTL(10 分)の内側なのでキャッシュ
  });

  it("朝の準備が無い(キャッシュなし)ときも動く: 冷えた状態では、取得は 25 本(出馬表 1・戦績 16・調教 1・単勝複勝 1・組合せ 6)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    expect(h.gate.urls).toHaveLength(25);
  });
});

describe("発走前の分析: 取得ステップの失敗と再試行", () => {
  it("戦績の一部が取れなかった(scrapeRace は警告にして続ける)ときは、取得ステップを成功にせず再試行する。再試行では取れなかった馬だけを取り直し、取れていた馬・出馬表はキャッシュから読む", async () => {
    const h = harness();
    let failures = 0;
    h.gate.body = (url) => {
      if (url.includes("ajax_horse_results") && failures < 2) {
        failures += 1;
        return null; // 404
      }
      return fixtureForUrl(url);
    };
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "retry" });
    const first = h.gate.urls.length;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    const second = urlsOf(h.gate, first);
    expect(count(second, "ajax_horse_results")).toBe(2); // 取れなかった2頭だけ
    expect(count(second, "shutuba.html")).toBe(0);
    expect(count(second, "oikiri.html")).toBe(0);
  });

  it("取得の再試行では、最初に読んだ設定のスナップショットを使う(再試行のたびに設定を読み直さない。途中で設定が変わっても、同じ設定で取得する)", async () => {
    const h = harness();
    let shutubaFailures = 0;
    h.gate.body = (url) => {
      if (url.includes("shutuba.html") && shutubaFailures < 1) {
        shutubaFailures += 1;
        return null;
      }
      return fixtureForUrl(url);
    };
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "retry" });
    h.settings = { ...ALL_ON, includeComboOdds: false }; // 1回目の取得のあとに設定が変わった
    const before = h.gate.urls.length;
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "ok" });
    expect(h.settingsLoads).toHaveLength(1);
    expect(count(urlsOf(h.gate, before), "type=8")).toBe(1); // 最初の設定(組合せ ON)で取得した(三連単のオッズを取っている)
  });
});

describe("発走前の分析: 計算・保存ステップ(AC-c5・c1・c6)", () => {
  it("AC-c5: 計算ステップで gate は0回。保存は1回(prior・EV・配分入り)。LLM なし(promptVersion・model は null)。開催日・当日傾向なしで保存する", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep(); // fetch
    const afterFetch = h.gate.urls.length;
    const outcome = await h.core.runNextStep(); // compute
    expect(outcome).toMatchObject({ kind: "ran", mode: "pre_race", step: "compute", result: "ok" });
    expect(h.gate.urls).toHaveLength(afterFetch);
    expect(h.sink.saved).toHaveLength(1);
    const record = h.sink.saved[0]!;
    expect(record.raceId).toBe(RACE);
    expect(record.kaisaiDate).toBe(DATE);
    expect(record.promptVersion).toBeNull();
    expect(record.model).toBeNull();
    expect(record.horses).toHaveLength(16);
    expect(record.allocation?.bets.length ?? 0).toBeGreaterThan(1); // 設定 ON(資金あり・組合せあり): 配分は多点
    expect(record.analyzedAt).toBe(new Date(h.clock.now).toISOString());
    expect(h.core.getBoard().races.find((r) => r.mode === "pre_race")).toMatchObject({ status: "done", analysisId: 1, detail: "stored", childrenOk: true });
  });

  it("組合せの券種も配分に入る(設定が組合せ ON・各券種 ON): 買い目の券種が単勝・複勝だけでなく、ワイド・馬連など複数に及ぶ", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    await h.core.runNextStep();
    const types = new Set(h.sink.saved[0]!.allocation!.bets.map((b) => b.betType));
    expect(types.size).toBeGreaterThan(2);
    expect([...types].some((t) => t !== "win" && t !== "place")).toBe(true);
  });

  it("設定の券種のスイッチが配分に効く: 三連単だけ OFF にすると、買い目に三連単が無い(ON なら三連単がある)", async () => {
    const on = harness();
    await on.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await on.core.runNextStep();
    await on.core.runNextStep();
    expect(on.sink.saved[0]!.allocation!.bets.some((b) => b.betType === "trifecta")).toBe(true); // 前提: ON なら三連単が入る(空振りでない)
    const off = harness();
    off.settings = { ...ALL_ON, includeTrifectaInAllocation: false };
    await off.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await off.core.runNextStep();
    await off.core.runNextStep();
    expect(off.sink.saved[0]!.allocation!.bets.some((b) => b.betType === "trifecta")).toBe(false);
  });

  it("EV の閾値(設定)が効く: 閾値が極端に低いと EV プラスの馬がいて、極端に高いといない", async () => {
    const low = harness();
    low.settings = { ...ALL_ON, evThreshold: 0.0001, includeComboOdds: false };
    await low.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await low.core.runNextStep();
    await low.core.runNextStep();
    const high = harness();
    high.settings = { ...ALL_ON, evThreshold: 1000, includeComboOdds: false };
    await high.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await high.core.runNextStep();
    await high.core.runNextStep();
    expect(low.sink.saved[0]!.horses.filter((x) => x.isPositive).length).toBeGreaterThan(0);
    expect(high.sink.saved[0]!.horses.filter((x) => x.isPositive).length).toBe(0);
  });

  it("計算ステップはキャッシュだけを読む: 取得のあとでキャッシュの戦績が消えていたら、gate を呼ばずに失敗として記録し、保存はしない(戦績なしの分析を保存しない)", async () => {
    const h = harness();
    h.sink.failBeforeSave = 0;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    h.sql.exec("DELETE FROM fetch_cache WHERE key LIKE '%ajax_horse_results%'");
    const before = h.gate.urls.length;
    const outcome = await h.core.runNextStep();
    expect(outcome).toMatchObject({ step: "compute", result: "retry" });
    expect(h.gate.urls).toHaveLength(before);
    expect(h.sink.saved).toHaveLength(0);
    expect(h.core.getBoard().races[0]!.error).toMatch(/戦績/);
  });

  it("設定が exe の既定値(資金 0)のとき、配分の買い目は 0 件(配分提案を出さない opt-in)で、分析は保存される", async () => {
    const h = harness();
    h.settings = DEFAULT_CLOUD_SETTINGS;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    // 組合せオッズは取らない(既定 OFF): 冷えた状態で 19 本
    expect(h.gate.urls).toHaveLength(19);
    await h.core.runNextStep();
    expect(h.sink.saved).toHaveLength(1);
    expect(h.sink.saved[0]!.allocation?.bets.length ?? 0).toBe(0);
    expect(h.sink.saved[0]!.horses).toHaveLength(16);
  });

  it("設定は取得ステップで1回だけ読み、スナップショットを保存して計算ステップで使う(途中で設定が変わっても、取得したものと同じ設定で計算する)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    h.settings = { ...ALL_ON, bankroll: 0, includeComboOdds: false }; // 取得のあとに設定が変わった
    await h.core.runNextStep();
    expect(h.settingsLoads).toHaveLength(1);
    expect(h.sink.saved[0]!.allocation?.bets.length ?? 0).toBeGreaterThan(1); // 取得時の設定(資金あり・組合せあり)で計算した
  });

  it("AC-c6: 計算ステップの保存先への呼び出しは3回(重複の確認・保存・子の行の確認)で、設定の読み出しは0回、gate は0回", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    const gateBefore = h.gate.urls.length;
    h.sink.calls.length = 0;
    const loadsBefore = h.settingsLoads.length;
    await h.core.runNextStep();
    expect(h.sink.calls).toEqual(["find", "save", "count"]);
    expect(h.settingsLoads).toHaveLength(loadsBefore);
    expect(h.gate.urls).toHaveLength(gateBefore);
    expect(h.sink.calls.length).toBeLessThan(45);
  });

  describe("AC-c1: 同じレースを2回実行しても、保存は1件", () => {
    it("保存したあと(応答を受け取る前に)クラッシュして計算ステップが再実行されても、同じ分析時刻で重複を見つけ、2件目を保存しない", async () => {
      const h = harness();
      h.sink.crashAfterSave = 1;
      await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
      await h.core.runNextStep(); // fetch
      const first = await h.core.runNextStep(); // compute: 保存されたが例外
      expect(first).toMatchObject({ step: "compute", result: "retry" });
      expect(h.sink.saved).toHaveLength(1);
      h.clock.now = h.alarm.at!; // 再試行のアラーム(遅れて)
      const second = await h.core.runNextStep();
      expect(second).toMatchObject({ step: "compute", result: "ok" });
      expect(h.sink.saved).toHaveLength(1); // 2件目は保存されない
      expect(h.core.getBoard().races.find((r) => r.mode === "pre_race")).toMatchObject({ status: "done", analysisId: 1 });
    });

    it("再実行でも分析時刻(analyzedAt)は最初の実行のまま(重複の確認の鍵。時計が進んでも変わらない)", async () => {
      const h = harness();
      h.sink.failBeforeSave = 1;
      await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
      await h.core.runNextStep();
      const startedAt = h.clock.now;
      await h.core.runNextStep(); // 失敗(保存されない)
      h.clock.now = h.alarm.at!;
      expect(h.clock.now).toBeGreaterThan(startedAt);
      await h.core.runNextStep();
      expect(h.sink.saved).toHaveLength(1);
      expect(h.sink.saved[0]!.analyzedAt).toBe(new Date(startedAt).toISOString());
    });

    it("計算ステップが完了したあとの余分なアラーム(at-least-once)で、同じタスクを計算し直しても、保存は1件のまま", async () => {
      const h = harness();
      await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
      await h.core.runNextStep();
      await h.core.runNextStep();
      expect(h.sink.saved).toHaveLength(1);
      // 状態を「計算待ち」に戻す(アラームが重複して届き、状態の更新を見ずに再実行された状況)
      h.sql.exec("UPDATE race_day_tasks SET status = 'fetched' WHERE race_id = ? AND mode = 'pre_race'", RACE);
      await h.core.runNextStep();
      expect(h.sink.saved).toHaveLength(1);
      expect(h.core.getBoard().races.find((r) => r.mode === "pre_race")).toMatchObject({ status: "done", analysisId: 1 });
    });

    it("対照: 完了したあとで、あらためて発走前の分析を予約した(別の実行)なら、新しい分析として保存する(2件)", async () => {
      const h = harness();
      await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
      await drive(h);
      h.clock.now += 5 * 60_000;
      await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
      await drive(h);
      expect(h.sink.saved).toHaveLength(2);
      expect(h.sink.saved[0]!.analyzedAt).not.toBe(h.sink.saved[1]!.analyzedAt);
    });
  });

  describe("保存先の失敗と再試行", () => {
    it("D1・R2 の一時的な失敗は、計算ステップを再試行する(状態は fetched のまま・遅らせたアラーム)。成功すれば done", async () => {
      const h = harness();
      h.sink.failBeforeSave = 1;
      await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
      await h.core.runNextStep();
      const failed = await h.core.runNextStep();
      expect(failed).toMatchObject({ step: "compute", result: "retry" });
      const row = h.core.getBoard().races.find((r) => r.mode === "pre_race")!;
      expect(row).toMatchObject({ status: "fetched" });
      expect(row.error).toContain("D1 の一時的な失敗");
      expect(h.alarm.at! - h.clock.now).toBeGreaterThanOrEqual(30_000);
      h.clock.now = h.alarm.at!;
      expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
      expect(h.sink.saved).toHaveLength(1);
    });

    it("失敗が続けば、試行回数の上限(3)で failed になり、それ以上は再試行しない", async () => {
      const h = harness();
      h.sink.failBeforeSave = 99;
      await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
      await h.core.runNextStep();
      const outcomes = await drive(h);
      expect(outcomes.filter((o) => o === "pre_race:compute:retry")).toHaveLength(2);
      expect(outcomes.filter((o) => o === "pre_race:compute:failed")).toHaveLength(1);
      expect(h.core.getBoard().races.find((r) => r.mode === "pre_race")).toMatchObject({ status: "failed" });
      expect(h.sink.saved).toHaveLength(0);
    });
  });

  describe("保存後の子の行の確認(#175 の申し送り: max(id) の前提を、最初の実保存で確かめる)", () => {
    it("子の行(馬・買い目)の件数が、保存したレコードと一致すれば childrenOk: true。一致しなければ childrenOk: false にして、警告を出す(分析は保存済みなので done のまま)", async () => {
      const h = harness();
      h.sink.childrenOverride = { horses: 15, bets: 0 };
      await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
      await drive(h);
      const row = h.core.getBoard().races.find((r) => r.mode === "pre_race")!;
      expect(row).toMatchObject({ status: "done", analysisId: 1, childrenOk: false });
      expect(h.warnings.some((w) => w.includes("子の行") && w.includes("1"))).toBe(true);
    });
  });
});

describe("発走前の分析: 取消馬(AC-c3)", () => {
  it("出馬表で取消の印がある馬(実フィクスチャ 202606040901: 16頭中 1 頭が取消)は、出走馬から除かれ、保存される馬は15頭(取消馬の馬番 6 を含まない)", async () => {
    const racePath = (name: string): string => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", name);
    const shutuba = readFileSync(racePath("shutuba_202606040901.html"), "utf-8");
    const results = readFileSync(racePath("horse_results_2021105857.json"), "utf-8");
    const win: Record<string, [string, string, string]> = {};
    const place: Record<string, [string, string, string]> = {};
    for (let n = 1; n <= 16; n++) {
      const key = String(n).padStart(2, "0");
      win[key] = n === 6 ? ["---.-", "0.0", "9999"] : [`${5 + n}.0`, "0.0", String(n)];
      place[key] = n === 6 ? ["---.-", "---.-", "9999"] : ["2.0", "3.0", String(n)];
    }
    const odds = JSON.stringify({ status: "result", data: { official_datetime: "2026-09-27 09:50:00", odds: { "1": win, "2": place } } });
    const h = harness();
    h.settings = { ...ALL_ON, includeComboOdds: false };
    h.gate.body = (url) => {
      if (url.includes("shutuba.html")) return shutuba;
      if (url.includes("ajax_horse_results")) return results;
      if (url.includes("api_get_jra_odds")) return odds;
      return null; // 調教は 404(任意のデータ。警告になるだけ)
    };
    await h.core.schedule({ raceId: "202606040901", kaisaiDate: "20260927", mode: "pre_race" });
    await drive(h);
    expect(h.sink.saved).toHaveLength(1);
    const record = h.sink.saved[0]!;
    expect(record.horses).toHaveLength(15);
    expect(record.horses.map((x) => x.umaban)).not.toContain(6);
    // 取消馬の戦績は取りに行かない(出走馬 15 頭ぶん)
    expect(count(h.gate.urls, "ajax_horse_results")).toBe(15);
  });
});

describe("前回の組合せオッズがキャッシュに残っていても、今回の分析には使わない(レビュー指摘。Issue #178)", () => {
  const COMBO_TYPES = [3, 4, 5, 6, 7, 8];
  const isComboUrl = (url: string, types: number[] = COMBO_TYPES): boolean => url.includes("api_get_jra_odds") && types.some((t) => url.includes(`type=${t}&`));
  const comboBetTypes = (record: AnalysisRecord): string[] => [...new Set(record.allocation!.bets.map((b) => b.betType))].filter((t) => t !== "win" && t !== "place").sort();

  async function firstRunThenSecondScheduled(h: Harness): Promise<void> {
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(h.sink.saved).toHaveLength(1);
    expect(comboBetTypes(h.sink.saved[0]!).length).toBeGreaterThan(2); // 前提: 1回目は組合せの券種が入っている(空振りでない)
    h.clock.now += 60 * 60_000; // 1 時間後に、あらためて発走前の分析(キャッシュには前回の組合せオッズが 26 時間残る)
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  }

  it("今回の組合せオッズの取得がすべて失敗しても、前回のオッズ(キャッシュに残っている)は使わない: 組合せの券種は買い目に入らず、警告が出る。分析は単勝・複勝だけで保存・done", async () => {
    const h = harness();
    await firstRunThenSecondScheduled(h);
    h.gate.body = (url) => (isComboUrl(url) ? null : fixtureForUrl(url)); // 今回は組合せが 404
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "ok" }); // 組合せの失敗は取得ステップの失敗にしない(未発売の券種で永久に失敗し続けるため)
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(h.sink.saved).toHaveLength(2);
    expect(comboBetTypes(h.sink.saved[1]!)).toEqual([]);
    expect(h.sink.saved[1]!.allocation!.bets.length).toBeGreaterThan(0); // 単勝・複勝の買い目は残る
    expect(h.warnings.some((w) => w.includes("組合せ"))).toBe(true);
    expect(h.core.getBoard().races.find((r) => r.mode === "pre_race")).toMatchObject({ status: "done" });
  });

  it("券種ごとに判断する: 三連単だけが今回失敗なら、三連単の買い目だけが入らず、今回取れたほかの組合せの券種は入る", async () => {
    const h = harness();
    await firstRunThenSecondScheduled(h);
    const firstTypes = comboBetTypes(h.sink.saved[0]!);
    expect(firstTypes).toContain("trifecta");
    h.gate.body = (url) => (isComboUrl(url, [8]) ? null : fixtureForUrl(url));
    await h.core.runNextStep();
    await h.core.runNextStep();
    const types = comboBetTypes(h.sink.saved[1]!);
    expect(types).not.toContain("trifecta");
    expect(types.length).toBeGreaterThan(1);
    expect(types).toEqual(firstTypes.filter((t) => t !== "trifecta"));
    expect(h.warnings.some((w) => w.includes("組合せ"))).toBe(true);
  });

  it("対照: 今回の組合せの取得が成功すれば、前回と同じ券種がすべて入り、組合せの警告は出ない", async () => {
    const h = harness();
    await firstRunThenSecondScheduled(h);
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(comboBetTypes(h.sink.saved[1]!)).toEqual(comboBetTypes(h.sink.saved[0]!));
    expect(h.warnings.filter((w) => w.includes("組合せ"))).toEqual([]);
  });

  it("取得の再試行(2回目)でも基準は最初の試行の開始時刻: 1回目で取れた組合せは、2回目の組合せ取得が失敗しても捨てずに使う", async () => {
    const h = harness();
    h.settings = ALL_ON;
    let resultFailures = 0;
    h.gate.body = (url) => {
      if (url.includes("ajax_horse_results") && resultFailures < 2) {
        resultFailures += 1;
        return null; // 1回目は戦績が2頭ぶん取れず、取得ステップは再試行になる(組合せは1回目に取れている)
      }
      return fixtureForUrl(url);
    };
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "retry" });
    h.clock.now += 61_000; // 再試行のアラーム(遅らせる)
    h.gate.body = (url) => (isComboUrl(url) ? null : fixtureForUrl(url)); // 2回目は組合せの取得が全部失敗
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "ok" });
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(comboBetTypes(h.sink.saved[0]!).length).toBeGreaterThan(2); // 1回目の組合せ(基準時刻より後に取得)を使っている
  });

  it("単勝・複勝のオッズ(必須のデータ)が基準時刻より古いときは、古いオッズで分析せず、計算ステップを失敗(再試行)にする。保存しない", async () => {
    const h = harness();
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    await h.core.runNextStep();
    // キャッシュのオッズより後に、基準の開始時刻があった状況(取得ステップのオッズの取得が、実際には今回のものではなかった)
    h.sql.exec("UPDATE race_day_tasks SET fetch_started_at = ? WHERE mode = 'pre_race'", h.clock.now + 1000);
    const outcome = await h.core.runNextStep();
    expect(outcome).toMatchObject({ step: "compute", result: "retry" });
    expect(h.sink.saved).toHaveLength(0);
    expect(h.core.getBoard().races.find((r) => r.mode === "pre_race")!.error).toMatch(/オッズ/);
  });

  it("取得の再試行でも、基準の開始時刻は最初の試行のまま(再試行のたびに進めない)", async () => {
    const h = harness();
    h.gate.body = (url) => (url.includes("shutuba.html") && h.gate.urls.filter((u) => u.includes("shutuba.html")).length <= 1 ? null : fixtureForUrl(url));
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    const startedAt = h.clock.now;
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "retry" });
    h.clock.now += 61_000;
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "ok" });
    const row = h.sql.exec("SELECT fetch_started_at FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { fetch_started_at: number }[];
    expect(row[0]!.fetch_started_at).toBe(startedAt);
  });

  it("あらためて予約した別の実行では、基準の開始時刻も新しくなる(前の実行の取得を、今回の取得として扱わない)", async () => {
    const h = harness();
    await firstRunThenSecondScheduled(h);
    const row = (): number | null => (h.sql.exec("SELECT fetch_started_at FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { fetch_started_at: number | null }[])[0]!.fetch_started_at;
    expect(row()).toBeNull(); // 再予約で消えている
    await h.core.runNextStep();
    expect(row()).toBe(h.clock.now);
  });
});

describe("地方(NAR)でも、前回の組合せオッズがキャッシュに残っていても今回の分析には使わない(再レビュー指摘。Issue #178)", () => {
  const NAR_RACE = "202654071210";
  const NAR_UNAVAILABLE = `<div id="odds_view_form"></div>`;
  const narFixture = (name: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", name), "utf-8");
  /** 軸馬別(`odds_get_form.html?type=b7&...&jiku=N`)の最小限の合成オッズ。軸 N と、軸にならない 11・12 番の組(オッズは大きく、期待値が閾値を超えて買い目に入る値)。 */
  const narAxisHtml = (axis: number): string =>
    `<div id="odds_view_form"><table class="Odds_Table"><tr><td class="Odds" id="chk_x_b7_c0_${axis}_11_12">900.0</td></tr></table></div>`;
  /** 地方の組合せ: 馬連 b4・ワイド b5・馬単 b6 は `odds/index.html`(単発)、3連複 b7 は軸馬別の `odds/odds_get_form.html`。 */
  const isNarAxisUrl = (url: string): boolean => url.includes("odds_get_form.html");
  const isNarIndexComboUrl = (url: string): boolean => /odds\/index\.html\?type=b[3-8]&/.test(url);
  const narBody = (url: string): string => {
    if (url.includes("shutuba.html")) return narFixture("nar_shutuba_202654071210.html");
    if (url.includes("ajax_horse_results")) return narFixture("horse_results_2021104387.json");
    if (isNarAxisUrl(url)) return narAxisHtml(Number(/[?&]jiku=(\d+)/.exec(url)![1]));
    if (url.includes("type=b1&")) return narFixture("nar_odds_b1_202654071210.html");
    if (url.includes("type=b4&")) return narFixture("nar_odds_b4_202654071210.html");
    if (url.includes("type=b5&")) return narFixture("nar_odds_b5_202654071210.html");
    if (url.includes("type=b6&")) return narFixture("nar_odds_b6_202654071210.html");
    if (url.includes("type=b7&")) return narFixture("nar_odds_b7_202654071210.html");
    if (url.includes("type=b3&")) return NAR_UNAVAILABLE;
    throw new Error(`未知のURL(NAR): ${url}`);
  };
  const betTypes = (record: AnalysisRecord): string[] => [...new Set(record.allocation!.bets.map((b) => b.betType))].sort();

  async function narFirstRunThenSecondScheduled(h: Harness): Promise<void> {
    h.gate.body = narBody;
    await h.core.schedule({ raceId: NAR_RACE, kaisaiDate: "20260712", mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "ok" });
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(h.sink.saved).toHaveLength(1);
    h.clock.now += 60 * 60_000;
    await h.core.schedule({ raceId: NAR_RACE, kaisaiDate: "20260712", mode: "pre_race" });
  }

  it("前提: 1回目の取得で、軸馬別のURL(odds_get_form)も index.html 系の組合せのURLも取っていて、3連複・ワイド・馬連などが買い目に入る(空振りでない)", async () => {
    const h = harness();
    await narFirstRunThenSecondScheduled(h);
    expect(h.gate.urls.filter(isNarAxisUrl).length).toBeGreaterThan(5);
    expect(h.gate.urls.filter(isNarIndexComboUrl).length).toBeGreaterThan(2);
    const types = betTypes(h.sink.saved[0]!);
    expect(types).toContain("trio");
    expect(types).toContain("wide");
    expect(types).toContain("quinella");
  });

  it("今回、軸馬別のURLがすべて404のとき: 前回のキャッシュの3連複は使わず、3連複の買い目は入らない。index.html 系(ワイド・馬連ほか)は今回取れたぶんが入る", async () => {
    const h = harness();
    await narFirstRunThenSecondScheduled(h);
    const firstTypes = betTypes(h.sink.saved[0]!);
    h.gate.body = (url) => (isNarAxisUrl(url) ? null : narBody(url));
    expect(await h.core.runNextStep()).toMatchObject({ step: "fetch", result: "ok" });
    expect(await h.core.runNextStep()).toMatchObject({ step: "compute", result: "ok" });
    expect(h.sink.saved).toHaveLength(2);
    const types = betTypes(h.sink.saved[1]!);
    expect(firstTypes).toContain("trio"); // 前提: 1回目には入っていた
    expect(types).not.toContain("trio");
    expect(types).toEqual(expect.arrayContaining(["wide", "quinella", "exacta"])); // index.html 系は今回取れている
    expect(h.warnings.some((w) => w.includes("組合せ") && w.includes("3連複"))).toBe(true);
  });

  it("今回、index.html 系の組合せ(ワイド・馬連・馬単)がすべて404のとき: 前回のキャッシュは使わず、それらの買い目は入らない。軸馬別の3連複は今回取れたぶんが入る", async () => {
    const h = harness();
    await narFirstRunThenSecondScheduled(h);
    const firstTypes = betTypes(h.sink.saved[0]!);
    h.gate.body = (url) => (isNarIndexComboUrl(url) && !url.includes("type=b7&") ? null : narBody(url));
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(h.sink.saved).toHaveLength(2);
    const types = betTypes(h.sink.saved[1]!);
    expect(types).not.toContain("wide");
    expect(types).not.toContain("quinella");
    expect(types).not.toContain("exacta");
    expect(types).toContain("trio"); // 軸馬別は今回取れているので入る(買い目の配分は券種が減ると変わるので、単勝・複勝の有無までは比べない)
    expect(firstTypes).toEqual(expect.arrayContaining(["wide", "quinella", "exacta"])); // 前提: 1回目には入っていた券種
  });

  it("対照: 今回もすべて取れれば、前回と同じ券種が入り、組合せの警告は出ない", async () => {
    const h = harness();
    await narFirstRunThenSecondScheduled(h);
    await h.core.runNextStep();
    await h.core.runNextStep();
    expect(betTypes(h.sink.saved[1]!)).toEqual(betTypes(h.sink.saved[0]!));
    expect(h.warnings.filter((w) => w.includes("組合せ"))).toEqual([]);
  });
});

describe("朝と発走前の共存・入口(Issue #178)", () => {
  it("朝(morning)と発走前(pre_race)は別のタスク。同じレースで、片方が実行中でももう片方を予約でき、同じ種類の二重の予約だけが拒否される", async () => {
    const h = harness();
    expect(await h.core.schedule({ raceId: RACE, kaisaiDate: DATE })).toMatchObject({ accepted: true });
    expect(await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" })).toMatchObject({ accepted: true, mode: "pre_race" });
    expect(await h.core.schedule({ raceId: RACE, kaisaiDate: DATE })).toMatchObject({ accepted: false, mode: "morning" });
    expect(await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" })).toMatchObject({ accepted: false, mode: "pre_race" });
    expect(h.core.getBoard().races.map((r) => [r.raceId, r.mode])).toEqual([[RACE, "morning"], [RACE, "pre_race"]]);
  });

  it("朝のタスクだけのときは、保存先・設定を一切呼ばない(朝の prior は D1・R2 に書かない)", async () => {
    const throwing: AnalysisSink = {
      save: async () => {
        throw new Error("朝に保存先が呼ばれた");
      },
      findByAnalyzedAt: async () => {
        throw new Error("朝に保存先が呼ばれた");
      },
      countChildren: async () => {
        throw new Error("朝に保存先が呼ばれた");
      },
    };
    const h = harness({
      sink: throwing,
      loadSettings: async () => {
        throw new Error("朝に設定が読まれた");
      },
    });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
    await drive(h);
    expect(h.core.getBoard().races[0]).toMatchObject({ mode: "morning", status: "done" });
  });

  it("保存先・設定が無い構成では、発走前の予約を拒否する(予約もアラームも作らない)", async () => {
    const h = harness({ sink: undefined, loadSettings: undefined });
    await expect(h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" })).rejects.toThrow(/発走前/);
    expect(h.alarm.at).toBeNull();
    expect(h.core.getBoard().races).toEqual([]);
  });

  it("未知の mode は拒否する", async () => {
    const h = harness();
    await expect(h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "evening" as never })).rejects.toThrow(/mode/);
  });
});
