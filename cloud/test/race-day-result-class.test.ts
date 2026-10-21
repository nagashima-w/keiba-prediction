import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { RaceComboPayoutsSaveInput, RaceResultDetail, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types";
import type { CourseType } from "../../packages/core/src/scraper/types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #426(#389 の案 B): 日単位の DO の結果の取り込みが、結果ページの `RaceData02` のクラスを `saveRaceClass` で保存すること。
 * 偽のゲート(結果ページはフィクスチャ)・偽のストア(記録つき)・本物の SQLite(`node:sqlite`)。実 netkeiba・実 D1 には触れない。
 *
 * 設計(クラスは結果の副産物。**クラスの保存の失敗で結果の取り込みを失敗にしない**):
 *  - `saveRaceClass` は結果の保存(`saveResult`、補完モードでは `saveWinOdds`・`saveScratched`)が成功したあとに呼ぶ。結果の保存が失敗したときは呼ばない。
 *  - `saveRaceClass` が reject しても握って警告(固定の文言。例外の文面は出さない)にし、取り込みは成功(imported)にする。再試行(`save-failed`)にしない:
 *    結果は保存済みなので再取得は無駄で、再試行が尽きると『諦めた』と記録されて保存済みの結果と食い違う。クラスは NULL のまま残り、補完(#426-b)が後から埋める。
 */

const DATE = "20260628";
const NOW = Date.parse("2026-06-29T09:00:00+09:00");
const DAY_MS = 86_400_000;
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf-8");

const R_OPEN = "202603020211"; // オープン
const R_NEW = "202602010605"; // 新馬
const NAR_OK = { raceId: "202654071210", date: "20260712", file: "nar_result_202654071210.html" }; // C1

const htmlOf: Record<string, string> = {
  [R_OPEN]: fixture("result_202603020211.html"),
  [R_NEW]: fixture("result_202602010605.html"),
  [NAR_OK.raceId]: fixture(NAR_OK.file),
};

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const okPage = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });

interface FakeGate extends GateLike {
  readonly urls: string[];
}
function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const m = /\/race\/result\.html\?race_id=(\d{12})$/.exec(url);
      const html = m === null ? undefined : htmlOf[m[1]!];
      return html === undefined ? { kind: "refused", reason: "blocked", message: "blocked" } : okPage(html);
    },
  };
  return gate;
}

interface FakeStore {
  /** 呼び出しの名前の順(結果の保存とクラスの保存の前後関係を固定する)。 */
  readonly order: string[];
  readonly classCalls: Array<{ readonly raceId: string; readonly raceClass: string | null | undefined }>;
  /** 次の saveRaceClass を、この回数だけ失敗させる。 */
  classFailures: number;
  /** 次の saveResult を、この回数だけ失敗させる。 */
  resultFailures: number;
  saveResult(raceId: string, entries: readonly RaceResultEntry[], courseType?: CourseType | null, comboPayouts?: RaceComboPayoutsSaveInput): Promise<void>;
  saveWinOdds(raceId: string, entries: readonly RaceResultEntry[]): Promise<{ readonly rowsWritten: number }>;
  saveScratched(raceId: string, entries: readonly RaceResultEntry[]): Promise<{ readonly rowsWritten: number }>;
  saveRaceClass(raceId: string, raceClass: string | null | undefined): Promise<{ readonly rowsWritten: number }>;
  getRaceResultDetails(raceIds: readonly string[]): Promise<Map<string, RaceResultDetail>>;
}
function fakeStore(): FakeStore {
  const store: FakeStore = {
    order: [],
    classCalls: [],
    classFailures: 0,
    resultFailures: 0,
    async saveResult() {
      if (store.resultFailures > 0) {
        store.resultFailures -= 1;
        throw new Error("D1 の保存に失敗(SECRET-D1-RESULT)");
      }
      store.order.push("saveResult");
    },
    async saveWinOdds() {
      store.order.push("saveWinOdds");
      return { rowsWritten: 0 };
    },
    async saveScratched() {
      store.order.push("saveScratched");
      return { rowsWritten: 0 };
    },
    async saveRaceClass(raceId, raceClass) {
      if (store.classFailures > 0) {
        store.classFailures -= 1;
        throw new Error("D1 の保存に失敗(SECRET-D1-CLASS)");
      }
      store.classCalls.push({ raceId, raceClass });
      store.order.push("saveRaceClass");
      return { rowsWritten: 1 };
    },
    async getRaceResultDetails() {
      return new Map();
    },
  };
  return store;
}

const noSink: AnalysisSink = {
  save: async () => ({ id: 1, detail: "stored" }),
  findByAnalyzedAt: async () => null,
  findRecentByRace: async () => [],
  countChildren: async () => ({ horses: 0, bets: 0 }),
};

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly store: FakeStore;
  readonly clock: { now: number };
  readonly alarm: { at: number | null };
  readonly warnings: string[];
}
const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

/** `withoutClassMethod` が true なら、結果ストアは `saveRaceClass` を持たない(従来の構成。クラスの保存は黙って省く)。 */
function harness(options: { withoutClassMethod?: boolean } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: NOW };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const gate = fakeGate();
  const store = fakeStore();
  const resultStore =
    options.withoutClassMethod === true
      ? { saveResult: store.saveResult, saveWinOdds: store.saveWinOdds, saveScratched: store.saveScratched, getRaceResultDetails: store.getRaceResultDetails }
      : store;
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    resultStore,
    sink: noSink,
    loadSettings: async () => DEFAULT_CLOUD_SETTINGS,
  });
  return { core, sql, gate, store, clock, alarm, warnings };
}

const label = (o: StepOutcome): string => (o.kind === "idle" ? "idle" : `${o.raceId}:${o.mode}:${o.step}:${o.result}`);
async function tick(h: Harness): Promise<string> {
  const at = h.alarm.at;
  if (at === null) throw new Error("アラームが無い");
  h.clock.now = Math.max(h.clock.now, at);
  h.alarm.at = null;
  return label(await h.core.runNextStep());
}
interface ResultRow {
  race_id: string;
  state: string;
  attempts: number;
  last_class: string | null;
}
const rowOf = (h: Harness, raceId: string): ResultRow =>
  (h.sql.exec("SELECT race_id, state, attempts, last_class FROM race_day_result WHERE race_id = ?", raceId).toArray() as ResultRow[])[0]!;

describe("結果の取り込みがクラスを保存する(通常の取り込み)", () => {
  it("中央(ラジオNIKKEI賞): 結果の保存のあとに saveRaceClass(オープン)を 1 回呼ぶ。取り込みは成功", async () => {
    const h = harness();
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_OPEN] });
    expect(await tick(h)).toBe(`${R_OPEN}:result:import:ok`);
    expect(h.store.classCalls).toEqual([{ raceId: R_OPEN, raceClass: "オープン" }]);
    expect(h.store.order).toEqual(["saveResult", "saveRaceClass"]);
    expect(rowOf(h, R_OPEN)).toMatchObject({ state: "imported", attempts: 1, last_class: "imported" });
  });

  it("中央(新馬)でも、そのクラスを渡す", async () => {
    const h = harness();
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_NEW] });
    expect(await tick(h)).toBe(`${R_NEW}:result:import:ok`);
    expect(h.store.classCalls).toEqual([{ raceId: R_NEW, raceClass: "新馬" }]);
  });

  it("地方(高知 C1)は、生の区分のトークン(C1)を渡す", async () => {
    const h = harness();
    h.clock.now = Date.parse("2026-07-13T09:00:00+09:00"); // 開催日(20260712)の翌日
    await h.core.requestResultImport({ kaisaiDate: NAR_OK.date, raceIds: [NAR_OK.raceId] });
    expect(await tick(h)).toBe(`${NAR_OK.raceId}:result:import:ok`);
    expect(h.store.classCalls).toEqual([{ raceId: NAR_OK.raceId, raceClass: "C1" }]);
  });

  it("クラスが読めないページ(クラスの span が無い)では saveRaceClass を呼ばず、取り込みは成功する", async () => {
    const h = harness();
    const original = htmlOf[R_OPEN]!;
    htmlOf[R_OPEN] = original.replace("<span>オープン</span>", "");
    try {
      expect(htmlOf[R_OPEN]).not.toBe(original); // 前提: 実際に span を消した
      await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_OPEN] });
      expect(await tick(h)).toBe(`${R_OPEN}:result:import:ok`);
      expect(h.store.classCalls).toEqual([]);
      expect(h.store.order).toEqual(["saveResult"]);
    } finally {
      htmlOf[R_OPEN] = original;
    }
  });

  it("結果の保存が失敗したときは saveRaceClass を呼ばない。再試行で結果が保存できたあとに 1 回だけ呼ぶ", async () => {
    const h = harness();
    h.store.resultFailures = 1;
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_OPEN] });
    expect(await tick(h)).toBe(`${R_OPEN}:result:import:retry`);
    expect(h.store.classCalls).toEqual([]);
    expect(await tick(h)).toBe(`${R_OPEN}:result:import:ok`);
    expect(h.store.classCalls).toEqual([{ raceId: R_OPEN, raceClass: "オープン" }]);
  });

  it("★saveRaceClass が失敗しても結果の取り込みは成功(imported)。再試行にせず(取得は 1 回・試行 1 回)、警告は固定の文言で例外の文面を含まない", async () => {
    const h = harness();
    h.store.classFailures = 1;
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_OPEN] });
    expect(await tick(h)).toBe(`${R_OPEN}:result:import:ok`);
    expect(h.gate.urls).toHaveLength(1); // 結果ページの取り直しをしない
    expect(h.store.order).toEqual(["saveResult"]); // 結果は保存済み(クラスの保存だけが落ちた)
    expect(rowOf(h, R_OPEN)).toMatchObject({ state: "imported", attempts: 1, last_class: "imported" });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain(R_OPEN);
    expect(h.warnings[0]).not.toContain("SECRET");
  });

  it("結果ストアが saveRaceClass を持たない構成(従来)では、クラスの保存を省いて取り込みは成功する。警告も出ない", async () => {
    const h = harness({ withoutClassMethod: true });
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_OPEN] });
    expect(await tick(h)).toBe(`${R_OPEN}:result:import:ok`);
    expect(h.warnings).toEqual([]);
  });
});

describe("補完モード(winOddsOnly)でもクラスを保存する", () => {
  /** R_OPEN を通常の取り込みで imported にしてから、翌日の時計で winOddsOnly の依頼を出す。 */
  async function importThenFill(h: Harness): Promise<void> {
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_OPEN] });
    expect(await tick(h)).toBe(`${R_OPEN}:result:import:ok`);
    h.clock.now += DAY_MS;
    h.store.order.length = 0;
    h.store.classCalls.length = 0;
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_OPEN], winOddsOnly: true });
  }

  it("saveWinOdds・saveScratched のあとに saveRaceClass を呼ぶ(saveResult は呼ばない)", async () => {
    const h = harness();
    await importThenFill(h);
    expect(await tick(h)).toBe(`${R_OPEN}:result:import:ok`);
    expect(h.store.order).toEqual(["saveWinOdds", "saveScratched", "saveRaceClass"]);
    expect(h.store.classCalls).toEqual([{ raceId: R_OPEN, raceClass: "オープン" }]);
  });

  it("★補完モードでも、saveRaceClass の失敗で取り込みを失敗にしない(オッズ・scratched は保存済み)", async () => {
    const h = harness();
    await importThenFill(h);
    h.store.classFailures = 1;
    expect(await tick(h)).toBe(`${R_OPEN}:result:import:ok`);
    expect(h.store.order).toEqual(["saveWinOdds", "saveScratched"]);
    expect(rowOf(h, R_OPEN)).toMatchObject({ state: "imported", last_class: "imported" });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).not.toContain("SECRET");
  });
});
