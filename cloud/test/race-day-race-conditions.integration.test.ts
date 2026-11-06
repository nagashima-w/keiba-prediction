import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { GateResult } from "../../cloud/src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { D1RaceConditionsStore } from "../src/race-conditions-repository";
import type { RaceConditionRecord, RaceConditionsStore } from "../src/race-conditions";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #421 段階 1: 日単位の DO の取得ステップ(朝 `morning`・発走前 `pre_race`)が、出馬表から読んだレースの条件(負担重量の種別・牝馬限定)を
 * `raceConditionsStore` に渡す。AC:
 *  c1 朝の取得ステップと発走前の取得ステップで 1 回ずつ(計算ステップでは呼ばない) / c2 渡す値は出馬表の実フィクスチャの値 /
 *  c3 保存が失敗しても取得ステップは止まらない(次のステップへ進む。再試行しない。警告に鍵の形を残さない) /
 *  c4 netkeiba への取得を増やさない / c5 条件の欄を読めなかった出馬表(キー無し。地方と同じ形)では保存先を呼ばない / c6 保存先なしは従来どおり /
 *  c7 実 D1 との結線。
 * ゲート・保存先は偽(c7 だけ実 D1)。ストレージは `node:sqlite`。
 */

const DATE = "20260628";
const RACE = "202603020211"; // ラジオNIKKEI賞: ハンデ・牝馬限定でない
const encoder = new TextEncoder();

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

interface FakeGate extends GateLike {
  readonly urls: string[];
}

/** `transform` で出馬表の HTML だけを書き換えられる偽ゲート(他の URL は実フィクスチャ)。 */
function fakeGate(transform: (url: string, text: string) => string = (_u, t) => t): FakeGate {
  const gate: FakeGate = {
    urls: [],
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const text = fixtureForUrl(url);
      if (text === null) {
        return { kind: "response", status: 404, contentType: "text/html; charset=UTF-8", body: bytes("not found"), queuedMs: 0, elapsedMs: 1 };
      }
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(transform(url, text)), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}

function fakeSink(): AnalysisSink & { readonly saved: AnalysisRecord[] } {
  const sink = {
    saved: [] as AnalysisRecord[],
    async save(record: AnalysisRecord) {
      sink.saved.push(record);
      return { id: sink.saved.length, detail: "stored" as const };
    },
    async findByAnalyzedAt(raceId: string, analyzedAt: string) {
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id: number) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

interface FakeStore extends RaceConditionsStore {
  readonly calls: RaceConditionRecord[];
  failWith: Error | null;
}

function fakeStore(): FakeStore {
  const store: FakeStore = {
    calls: [],
    failWith: null,
    async save(record) {
      store.calls.push(record);
      await Promise.resolve();
      if (store.failWith !== null) {
        throw store.failWith;
      }
    },
  };
  return store;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly gate: FakeGate;
  readonly clock: { now: number };
  readonly warnings: string[];
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(overrides: Partial<RaceDayDeps> = {}, gate: FakeGate = fakeGate()): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-27T12:00:00Z") };
  const warnings: string[] = [];
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: () => undefined,
    onWarn: (message) => warnings.push(message),
    sink: fakeSink(),
    loadSettings: async () => ({ ...DEFAULT_CLOUD_SETTINGS, baseScoreWeightTrainer: 0 }),
    ...overrides,
  });
  return { core, gate, clock, warnings };
}

/** 出馬表の RaceData02 を取り除く(条件の欄を読めない出馬表。地方と同じく条件のキーが付かない形)。 */
const withoutRaceData02 = (url: string, text: string): string =>
  url.includes("shutuba.html") ? text.replace(/<div class="RaceData02">[\s\S]*?<\/div>/, "") : text;

async function runAll(h: Harness, mode: "morning" | "pre_race"): Promise<void> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode });
  expect(await h.core.runNextStep()).toMatchObject({ mode, step: "fetch", result: "ok" });
  expect(await h.core.runNextStep()).toMatchObject({ mode, step: "compute", result: "ok" });
}

describe("c1・c2: 取得ステップで、出馬表から読んだレースの条件を保存先に渡す", () => {
  it("朝(morning): 取得ステップで 1 回だけ呼ばれ、計算ステップでは呼ばれない。値は実フィクスチャのもの(ハンデ・牝馬限定でない)", async () => {
    const store = fakeStore();
    const h = harness({ raceConditionsStore: store });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
    h.clock.now += 1000;
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "fetch", result: "ok" });
    expect(store.calls).toEqual([{ raceId: RACE, weightType: "ハンデ", filliesOnly: false, savedAt: h.clock.now }]);
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "compute", result: "ok" });
    expect(store.calls).toHaveLength(1);
  });

  it("発走前(pre_race): 取得ステップで 1 回だけ呼ばれ、計算ステップでは呼ばれない", async () => {
    const store = fakeStore();
    const h = harness({ raceConditionsStore: store });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    expect(store.calls).toEqual([{ raceId: RACE, weightType: "ハンデ", filliesOnly: false, savedAt: h.clock.now }]);
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "compute", result: "ok" });
    expect(store.calls).toHaveLength(1);
  });
});

describe("c3: 保存が失敗しても取得ステップは止まらない", () => {
  for (const mode of ["morning", "pre_race"] as const) {
    it(`${mode}: 保存が失敗(鍵の形を含む文面)しても取得ステップは ok で次へ進み、再試行せず、警告にレースを残して鍵の形を残さない`, async () => {
      const store = fakeStore();
      store.failWith = new Error("D1 の失敗 sk-ant-api03-ABCDEFGHIJKLMNOP");
      const h = harness({ raceConditionsStore: store });
      await runAll(h, mode); // fetch・compute とも ok
      expect(store.calls).toHaveLength(1); // 試行は 1 回(取得ステップを再試行していない)
      const warned = h.warnings.filter((w) => w.includes("レースの条件"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain(RACE);
      expect(warned.join("\n")).not.toContain("ABCDEFGHIJKLMNOP");
    });
  }
});

describe("c4・c5・c6", () => {
  it("c4: 保存先の有無で、取得ステップ・計算ステップの取得(ゲートへの URL の列)が完全に同じ", async () => {
    const without = harness();
    await runAll(without, "pre_race");
    const withStore = harness({ raceConditionsStore: fakeStore() });
    await runAll(withStore, "pre_race");
    expect(withStore.gate.urls.length).toBeGreaterThan(19); // 前提: 取得が実際に行われている
    expect(withStore.gate.urls).toStrictEqual(without.gate.urls);
  });

  it("c5: 条件の欄を読めなかった出馬表(RaceData02 無し。条件のキーが付かない)では、保存先を呼ばず、警告も出さずに ok", async () => {
    // 対照: 同じ出馬表でも RaceData02 があれば呼ばれる(c1)。ここでは書き換えた出馬表で、呼ばれないことを固定する。
    const control = fakeStore();
    await runAll(harness({ raceConditionsStore: control }), "morning");
    expect(control.calls).toHaveLength(1);

    const store = fakeStore();
    const h = harness({ raceConditionsStore: store }, fakeGate(withoutRaceData02));
    await runAll(h, "morning");
    expect(store.calls).toHaveLength(0);
    expect(h.warnings.filter((w) => w.includes("レースの条件"))).toEqual([]);
  });

  it("c6: 保存先なしの構成(raceConditionsStore を渡さない)は、警告なしで従来どおり完了する", async () => {
    const h = harness();
    await runAll(h, "morning");
    expect(h.core.getMorningPrior(RACE)).not.toBeNull();
    expect(h.warnings.filter((w) => w.includes("レースの条件"))).toEqual([]);
  });
});

describe("c7: 実 D1(ローカルの workerd)との結線", () => {
  let local: LocalBindings;
  beforeAll(async () => {
    local = await openLocalBindings();
  }, 180_000);
  afterAll(async () => {
    await local?.dispose();
  });

  it("朝の取得ステップ → race_conditions に 1 行(ハンデ・牝馬限定でない)。発走前の取得ステップで同じ値を書き直しても 1 行のまま", async () => {
    await local.reset();
    const store = new D1RaceConditionsStore({ db: local.db });
    const h = harness({ raceConditionsStore: store });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "morning", step: "fetch", result: "ok" });
    const read = async () => (await local.db.prepare("SELECT race_id, weight_type, fillies_only, saved_at FROM race_conditions").all()).results;
    expect(await read()).toEqual([{ race_id: RACE, weight_type: "ハンデ", fillies_only: 0, saved_at: h.clock.now }]);

    h.clock.now += 3_600_000;
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    while (true) {
      const outcome = await h.core.runNextStep();
      if (outcome.kind === "idle" || (outcome.kind === "ran" && outcome.mode === "pre_race" && outcome.step === "fetch")) break;
    }
    const rows = await read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ weight_type: "ハンデ", fillies_only: 0 });
    expect(rows[0]!["saved_at"]).toBeLessThan(h.clock.now); // 同じ値の再保存は更新しない(初回の時刻のまま)
  });
});
