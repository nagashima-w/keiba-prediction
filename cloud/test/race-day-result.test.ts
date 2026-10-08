import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { parseRaceId } from "../../packages/core/src/scraper/ids";
import { parseRaceResult } from "../../packages/core/src/scraper/parse-race-result";
import { raceResultUrl } from "../../packages/core/src/scraper/urls";
import type { RaceComboPayoutsSaveInput, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types";
import type { CourseType } from "../../packages/core/src/scraper/types";
import type { DiscordNotifier } from "../src/notify-send";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { nextAlarmAt, RaceDayCore, RETRY_DELAY_MS, type AlarmInputs, type AnalysisSink, type StepOutcome } from "../src/race-day-core";
import {
  MAX_RESULT_ATTEMPTS,
  MAX_RESULT_DEFERRALS,
  MAX_RESULT_RACES_PER_REQUEST,
  MAX_RESULT_ROWS_PER_DAY,
  RESULT_BUSY_DELAY_MS,
  RESULT_RETRY_DELAY_MS,
} from "../src/race-day-result";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #208(#182-B): 日単位の DO(`RaceDayCore`)の、結果の取り込み(`requestResultImport` と、アラームの中の 1 ステップ 1 レース)。
 * 取得は偽のゲート(結果ページはフィクスチャ)・保存は偽のストア(記録つき)・ストレージは `node:sqlite`(本物の SQLite)。実 netkeiba・実 D1 には触れない。
 * 取り込む日は 20260628、DO の時計の「今日」は 20260629(JST)。
 */

const DATE = "20260628";
const TODAY = "20260629";
const NOW = Date.parse("2026-06-29T09:00:00+09:00");
const MIN = 60_000;
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf-8");

/** 中央の実フィクスチャ(開催日の月日はレースIDに含まれないので、20260628 に使える)。 */
const R_A = "202603020211"; // 16 頭
const R_B = "202603020203"; // 5 頭
const R_C = "202602010605"; // 6 頭
const NAR_OK = { raceId: "202654071210", date: "20260712", file: "nar_result_202654071210.html" };
const NAR_PRESALE = { raceId: "202642071612", date: "20260716", file: "nar_result_presale_202642071612.html" };

/** 互いに違う、有効な中央のレースID(場コード 01〜10 × 1〜12R。最大 120 件)。 */
const manyIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `2026${String(1 + Math.floor(i / 12)).padStart(2, "0")}0609${String((i % 12) + 1).padStart(2, "0")}`);

const htmlOf: Record<string, string> = {
  [R_A]: fixture("result_202603020211.html"),
  [R_B]: fixture("result_202603020203.html"),
  [R_C]: fixture("result_202602010605.html"),
  [NAR_OK.raceId]: fixture(NAR_OK.file),
  [NAR_PRESALE.raceId]: fixture(NAR_PRESALE.file),
};

/** 払戻のテーブルを丸ごと消した HTML(審議中の暫定の着順を模す。実物のフィクスチャは無い)。 */
function withoutPayoutTables(html: string): string {
  return html.replace(/<table[^>]*class="[^"]*Payout_Detail_Table[^"]*"[\s\S]*?<\/table>/g, "");
}

const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
const okPage = (text: string): GateResult => ({ kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 });
const status500 = (): GateResult => ({ kind: "response", status: 500, contentType: "text/html; charset=UTF-8", body: bytes("error"), queuedMs: 0, elapsedMs: 1 });
const refused = (reason: "queue-full" | "blocked" | "disallowed-url" | "network-error", blockedUntil?: number): GateResult => ({
  kind: "refused",
  reason,
  message: "拒否(本文は状態に入れない)SECRET-MESSAGE",
  ...(blockedUntil === undefined ? {} : { blockedUntil }),
});
const refusedNoBlockedUntil = (): GateResult => ({ kind: "refused", reason: "blocked", message: "blocked" });

interface FakeGate extends GateLike {
  /** 取得した URL(順に)。 */
  readonly urls: string[];
  /** URL ごとの応答の上書き(先頭から 1 回ずつ消費)。無ければ、結果ページはレースIDで `htmlOf` を返し、それ以外は拒否(blocked)。 */
  readonly script: GateResult[];
  /** 取得の時点の呼び出し(行の状態の確認用)。 */
  onFetch: ((url: string) => void) | null;
}

function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    script: [],
    onFetch: null,
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      gate.onFetch?.(url);
      await Promise.resolve();
      const scripted = gate.script.shift();
      if (scripted !== undefined) {
        return scripted;
      }
      const m = /\/race\/result\.html\?race_id=(\d{12})$/.exec(url);
      const html = m === null ? undefined : htmlOf[m[1]!];
      return html === undefined ? refused("blocked") : okPage(html);
    },
  };
  return gate;
}

interface SaveCall {
  readonly raceId: string;
  readonly entries: readonly RaceResultEntry[];
  readonly courseType: CourseType | null | undefined;
  readonly comboPayouts: RaceComboPayoutsSaveInput | undefined;
}
interface FakeStore {
  readonly calls: SaveCall[];
  /** 次の saveResult を、この回数だけ失敗させる。 */
  failures: number;
  saveResult(raceId: string, entries: readonly RaceResultEntry[], courseType?: CourseType | null, comboPayouts?: RaceComboPayoutsSaveInput): Promise<void>;
}
function fakeStore(): FakeStore {
  const store: FakeStore = {
    calls: [],
    failures: 0,
    async saveResult(raceId, entries, courseType, comboPayouts) {
      if (store.failures > 0) {
        store.failures -= 1;
        throw new Error("D1 の保存に失敗(SECRET-D1-MESSAGE)");
      }
      store.calls.push({ raceId, entries, courseType, comboPayouts });
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

function harness(options: { store?: boolean; notifier?: boolean; sink?: boolean } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: NOW };
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const gate = fakeGate();
  const store = fakeStore();
  const notifier: DiscordNotifier = { send: async () => undefined };
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (message) => warnings.push(message),
    ...(options.store === false ? {} : { resultStore: store }),
    ...(options.sink === false ? {} : { sink: noSink, loadSettings: async () => DEFAULT_CLOUD_SETTINGS }),
    ...(options.notifier === true ? { notifier } : {}),
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
async function drive(h: Harness, until = Number.POSITIVE_INFINITY, max = 120): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const at = h.alarm.at;
    if (at === null || at > until) return out;
    out.push(await tick(h));
  }
  throw new Error("アラームが止まらない(上限超過)");
}
interface ResultRow {
  race_id: string;
  state: string;
  attempts: number;
  deferrals: number;
  next_try_at: number;
  requested_on: string;
  last_class: string | null;
}
const rows = (h: Harness): ResultRow[] =>
  h.sql.exec("SELECT race_id, state, attempts, deferrals, next_try_at, requested_on, last_class FROM race_day_result ORDER BY race_id").toArray() as ResultRow[];
const rowOf = (h: Harness, raceId: string): ResultRow => {
  const r = rows(h).find((x) => x.race_id === raceId);
  if (r === undefined) throw new Error(`行が無い: ${raceId}`);
  return r;
};
const resultUrl = (raceId: string): string => raceResultUrl(parseRaceId(raceId));
const dumpAllTables = (h: Harness): string => {
  const tables = h.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray() as { name: string }[];
  return tables.map((t) => JSON.stringify(h.sql.exec(`SELECT * FROM ${t.name}`).toArray())).join("\n");
};

// ---------------------------------------------------------------------------

describe("定数(テストで固定する)", () => {
  it("1 回の依頼の試行は 3、再試行の間隔は 10 分、保留(gate の混雑・ブレーカー)は 5 回まで・60 秒後。1 日の行数と 1 回の依頼の件数の上限は 120", () => {
    expect(MAX_RESULT_ATTEMPTS).toBe(3);
    expect(RESULT_RETRY_DELAY_MS).toBe(10 * MIN);
    expect(MAX_RESULT_DEFERRALS).toBe(5);
    expect(RESULT_BUSY_DELAY_MS).toBe(60_000);
    expect(MAX_RESULT_ROWS_PER_DAY).toBe(120);
    expect(MAX_RESULT_RACES_PER_REQUEST).toBe(120);
  });
});

describe("AC-B5: requestResultImport(依頼の冪等・検証)", () => {
  it("新しいレースは queued で積む(requested_on は DO の時計の JST の今日)。アラームは now に張る。結果は件数だけ", async () => {
    const h = harness();
    const result = await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A, R_B] });
    expect(result).toEqual({ accepted: 2, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } });
    expect(rows(h)).toEqual([
      { race_id: R_B, state: "queued", attempts: 0, deferrals: 0, next_try_at: NOW, requested_on: TODAY, last_class: null },
      { race_id: R_A, state: "queued", attempts: 0, deferrals: 0, next_try_at: NOW, requested_on: TODAY, last_class: null },
    ].sort((a, b) => a.race_id.localeCompare(b.race_id)));
    expect(h.alarm.at).toBe(NOW);
    expect(h.gate.urls).toEqual([]); // 依頼だけをして戻る(取得はアラームの中)
    expect(h.store.calls).toEqual([]);
  });

  it("開催日を pin する(DO の開催日になる)。別の日で pin 済みなら拒否", async () => {
    const h = harness();
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    expect((h.sql.exec("SELECT value FROM race_day_meta WHERE key = 'kaisai_date'").toArray() as { value: string }[])[0]?.value).toBe(DATE);
    await expect(h.core.requestResultImport({ kaisaiDate: "20260627", raceIds: [R_A] })).rejects.toThrow(/専用/);
    // 同じ日の schedule も通る(pin と整合)
    await expect(h.core.schedule({ raceId: R_A, kaisaiDate: DATE })).resolves.toMatchObject({ accepted: true });
  });

  it("検証: 今日・未来の開催日、無効な日付・レースID、年の不一致、地方の月日の不一致、構成に結果ストアが無い、件数の上限超え → 拒否し、何も書かない・アラームも張らない", async () => {
    const h = harness();
    const before = dumpAllTables(h);
    const bad: [string, { kaisaiDate: string; raceIds: readonly string[] }][] = [
      ["今日", { kaisaiDate: TODAY, raceIds: [R_A] }],
      ["明日", { kaisaiDate: "20260630", raceIds: [R_A] }],
      ["無効な日付", { kaisaiDate: "20260230", raceIds: [R_A] }],
      ["無効なレースID", { kaisaiDate: DATE, raceIds: ["abc"] }],
      ["年の不一致", { kaisaiDate: DATE, raceIds: ["202503020211"] }],
      ["地方の月日の不一致", { kaisaiDate: DATE, raceIds: [NAR_OK.raceId] }],
      ["件数の上限超え", { kaisaiDate: DATE, raceIds: [...manyIds(MAX_RESULT_ROWS_PER_DAY), "202630062801"] }],
      ["レースIDが配列でない", { kaisaiDate: DATE, raceIds: "202603020211" as never }],
    ];
    for (const [name, input] of bad) {
      await expect(h.core.requestResultImport(input), name).rejects.toThrow();
    }
    expect(dumpAllTables(h)).toBe(before);
    expect(h.alarm.at).toBeNull();
    const noStore = harness({ store: false });
    await expect(noStore.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] })).rejects.toThrow(/結果/);
    expect(noStore.alarm.at).toBeNull();
  });

  it("境界: 前日(今日 − 1)は受理する。空の配列は何もしない(pin もアラームも無し)。同じレースIDの重複は 1 件", async () => {
    const h = harness();
    expect(await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [] })).toEqual({ accepted: 0, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } });
    expect(h.sql.exec("SELECT value FROM race_day_meta WHERE key = 'kaisai_date'").toArray()).toEqual([]);
    expect(h.alarm.at).toBeNull();
    expect(await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A, R_A] })).toMatchObject({ accepted: 1 });
    expect(rows(h)).toHaveLength(1);
  });

  it("1 日の行数の上限(120): 超える依頼は、1 件も積まずに拒否する(部分的に積まない)。既にある行の再依頼は数えない", async () => {
    const h = harness();
    const first = manyIds(MAX_RESULT_ROWS_PER_DAY);
    expect(new Set(first).size).toBe(MAX_RESULT_ROWS_PER_DAY); // 前提: 120 件が互いに違う
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: first });
    expect(rows(h)).toHaveLength(MAX_RESULT_ROWS_PER_DAY);
    await expect(h.core.requestResultImport({ kaisaiDate: DATE, raceIds: ["202630062801"] })).rejects.toThrow(/上限/);
    expect(rows(h)).toHaveLength(MAX_RESULT_ROWS_PER_DAY);
    // 既にある行の再依頼は、上限の対象外(新しい行を足さない)
    await expect(h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [first[0]!] })).resolves.toMatchObject({ accepted: 0, ignored: { inProgress: 1 } });
  });
});

describe("AC-B5: 判定表(行の状態 × 依頼の日)", () => {
  /** 行を直接書いて、状態を作る。 */
  function seed(h: Harness, raceId: string, state: "queued" | "imported" | "gave_up", requestedOn: string, attempts = 2): void {
    h.sql.exec(
      "INSERT INTO race_day_result (race_id, state, attempts, deferrals, next_try_at, requested_on, last_class, queued_at, updated_at) VALUES (?, ?, ?, 3, ?, ?, 'not-confirmed', 1, 1)",
      raceId,
      state,
      attempts,
      NOW + 99 * MIN,
      requestedOn,
    );
  }
  const YESTERDAY = "20260628";

  it("queued は、同じ日でも別の日でも積み直さない(進行中)", async () => {
    for (const requestedOn of [TODAY, YESTERDAY]) {
      const h = harness();
      seed(h, R_A, "queued", requestedOn);
      const r = await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
      expect(r).toEqual({ accepted: 0, ignored: { inProgress: 1, imported: 0, alreadyToday: 0 } });
      expect(rowOf(h, R_A)).toMatchObject({ state: "queued", attempts: 2, deferrals: 3, requested_on: requestedOn });
    }
  });

  it("imported: 同じ日の依頼は無視(取り込み完了後に来た古い列挙の重複)。前の日の依頼のものは積み直す(D1 を正とする: 呼び出し側は D1 に無いと判断している)", async () => {
    const same = harness();
    seed(same, R_A, "imported", TODAY);
    expect(await same.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] })).toEqual({ accepted: 0, ignored: { inProgress: 0, imported: 1, alreadyToday: 0 } });
    expect(rowOf(same, R_A)).toMatchObject({ state: "imported", attempts: 2 });
    expect(same.alarm.at).toBeNull();

    const later = harness();
    seed(later, R_A, "imported", YESTERDAY);
    expect(await later.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] })).toEqual({ accepted: 1, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } });
    expect(rowOf(later, R_A)).toEqual({ race_id: R_A, state: "queued", attempts: 0, deferrals: 0, next_try_at: NOW, requested_on: TODAY, last_class: null });
    expect(later.alarm.at).toBe(NOW);
  });

  it("gave_up: 同じ日の依頼は無視(1 日 1 回)。前の日の依頼のものは 1 回だけ積み直す(試行・保留を 0 に戻す)。積み直した同じ日の再依頼は、また無視", async () => {
    const same = harness();
    seed(same, R_A, "gave_up", TODAY, 3);
    expect(await same.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] })).toEqual({ accepted: 0, ignored: { inProgress: 0, imported: 0, alreadyToday: 1 } });
    expect(rowOf(same, R_A)).toMatchObject({ state: "gave_up", attempts: 3 });

    const later = harness();
    seed(later, R_A, "gave_up", YESTERDAY, 3);
    expect(await later.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] })).toMatchObject({ accepted: 1 });
    expect(rowOf(later, R_A)).toEqual({ race_id: R_A, state: "queued", attempts: 0, deferrals: 0, next_try_at: NOW, requested_on: TODAY, last_class: null });
    // 同じ日にもう一度(cron の重複配信): queued なので進行中として無視
    expect(await later.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] })).toMatchObject({ accepted: 0, ignored: { inProgress: 1 } });
  });

  it("1 回の依頼に、積む・無視が混ざっても、それぞれ正しく数える", async () => {
    const h = harness();
    seed(h, R_A, "queued", TODAY);
    seed(h, R_B, "gave_up", YESTERDAY, 3);
    const r = await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A, R_B, R_C] });
    expect(r).toEqual({ accepted: 2, ignored: { inProgress: 1, imported: 0, alreadyToday: 0 } });
    expect(rows(h).map((x) => [x.race_id, x.state])).toEqual([[R_C, "queued"], [R_B, "queued"], [R_A, "queued"]].sort((a, b) => a[0]!.localeCompare(b[0]!)));
  });
});

describe("AC-B1: 取り込み(アラームの 1 ステップにつき 1 レース・キャッシュを通さない)", () => {
  it("1 ステップで 1 レースだけを取得・保存する。2 レースなら 2 ステップ。取得は結果ページの URL(gate 経由)", async () => {
    const h = harness();
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A, R_B] });
    const first = await tick(h);
    expect(first).toMatch(/:result:import:ok$/);
    expect(h.gate.urls).toHaveLength(1);
    expect(h.store.calls).toHaveLength(1);
    expect(rows(h).filter((r) => r.state === "imported")).toHaveLength(1);
    expect(h.alarm.at).toBe(NOW); // 続きがあるので now
    const second = await tick(h);
    expect(second).toMatch(/:result:import:ok$/);
    expect([...h.gate.urls].sort()).toEqual([resultUrl(R_A), resultUrl(R_B)].sort());
    expect(h.store.calls.map((c) => c.raceId).sort()).toEqual([R_A, R_B].sort());
    expect(rows(h).every((r) => r.state === "imported" && r.last_class === "imported")).toBe(true);
  });

  it("保存の引数は exe と同じ: 馬ごとの着順・払戻(16 頭)・面・全券種の組合せ払戻(core の importRaceResult が素通し)。courseType は芝", async () => {
    const h = harness();
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    await tick(h);
    const call = h.store.calls[0]!;
    const parsed = parseRaceResult(htmlOf[R_A]!);
    expect(call.entries).toHaveLength(parsed.horses.length);
    expect(call.entries).toHaveLength(16);
    expect(call.entries.filter((e) => e.winPayout !== null && e.winPayout !== undefined)).toHaveLength(1);
    expect(call.courseType).toBe("芝");
    expect(call.comboPayouts).toMatchObject({ wide: { state: "parsed" }, trio: { state: "parsed" }, quinella: { state: "parsed" } });
    expect(Object.keys(call.comboPayouts ?? {}).sort()).toEqual(["bracketQuinella", "exacta", "quinella", "trifecta", "trio", "wide"]);
  });

  it("結果ページをキャッシュ(fetch_cache)に書かない: 取り込んだあと、キャッシュの表は空", async () => {
    const h = harness();
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    await tick(h);
    expect(h.gate.urls).toHaveLength(1); // 前提: 取得は実際に行われた
    expect(h.sql.exec("SELECT count(*) AS n FROM fetch_cache").toArray()).toEqual([{ n: 0 }]);
  });

  it("地方のレースは地方のホスト(nar.netkeiba.com)の結果ページを取る", async () => {
    const h = harness();
    h.clock.now = Date.parse("2026-07-20T09:00:00+09:00"); // 地方のフィクスチャの開催日(7/12・7/16)より後の日
    await h.core.requestResultImport({ kaisaiDate: NAR_OK.date, raceIds: [NAR_OK.raceId] });
    await tick(h);
    expect(h.gate.urls).toEqual([`https://nar.netkeiba.com/race/result.html?race_id=${NAR_OK.raceId}`]);
    expect(h.store.calls.map((c) => c.raceId)).toEqual([NAR_OK.raceId]);
  });

  it("試行回数は取得の前に永続化する(取得の時点で、行の attempts が既に 1)", async () => {
    const h = harness();
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    let seen: number | null = null;
    h.gate.onFetch = () => {
      seen = rowOf(h, R_A).attempts;
    };
    await tick(h);
    expect(seen).toBe(1);
  });

  it("取り込み後は、結果のためのアラームは無い(掃除の予約だけ)。次に起きたとき仕事は無く、状態は変わらない", async () => {
    const h = harness();
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    await tick(h);
    const before = dumpAllTables(h);
    const at = h.alarm.at;
    expect(at).not.toBeNull();
    expect(at! > NOW + 10 * MIN).toBe(true); // 掃除(保持期間のあと)。結果の再試行の時刻ではない
    expect(rows(h).filter((r) => r.state === "queued")).toEqual([]);
    expect(dumpAllTables(h)).toBe(before);
  });
});

describe("AC-B2: 払戻のテーブルが出てから保存する。未確定・構造の異常・取得の失敗は保存せず、再試行して、上限で諦める", () => {
  it("前提: 払戻を消した HTML は、着順の行はあるのに単勝の払戻が 0 件(審議中の暫定の着順を模せている)", () => {
    const parsed = parseRaceResult(withoutPayoutTables(htmlOf[R_A]!));
    expect(parsed.horses.length).toBe(16);
    expect(parsed.winPayouts).toHaveLength(0);
    expect(parseRaceResult(htmlOf[R_A]!).winPayouts.length).toBeGreaterThan(0);
  });

  it("着順はあるが払戻が無い(審議中) → 保存せず(no-payout)、10 分後に再試行する", async () => {
    const h = harness();
    h.gate.script.push(okPage(withoutPayoutTables(htmlOf[R_A]!)));
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    expect(await tick(h)).toBe(`${R_A}:result:import:retry`);
    expect(h.store.calls).toEqual([]);
    expect(rowOf(h, R_A)).toMatchObject({ state: "queued", attempts: 1, last_class: "no-payout", next_try_at: NOW + RESULT_RETRY_DELAY_MS });
    expect(h.alarm.at).toBe(NOW + RESULT_RETRY_DELAY_MS);
    // 10 分後、払戻が出ていれば保存する
    expect(await tick(h)).toBe(`${R_A}:result:import:ok`);
    expect(h.store.calls.map((c) => c.raceId)).toEqual([R_A]);
    expect(rowOf(h, R_A)).toMatchObject({ state: "imported", attempts: 2, last_class: "imported" });
  });

  it("未確定(結果の行が無い。地方の発売前のフィクスチャ) → 保存せず(not-confirmed)、再試行", async () => {
    const h = harness();
    h.clock.now = Date.parse("2026-07-20T09:00:00+09:00");
    await h.core.requestResultImport({ kaisaiDate: NAR_PRESALE.date, raceIds: [NAR_PRESALE.raceId] });
    expect(await tick(h)).toBe(`${NAR_PRESALE.raceId}:result:import:retry`);
    expect(h.store.calls).toEqual([]);
    expect(rowOf(h, NAR_PRESALE.raceId)).toMatchObject({ state: "queued", attempts: 1, last_class: "not-confirmed" });
  });

  it("構造の異常(結果テーブルが無い) → 保存せず(parse-error)、再試行", async () => {
    const h = harness();
    h.gate.script.push(okPage("<html><body><p>変な HTML</p></body></html>"));
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    expect(await tick(h)).toBe(`${R_A}:result:import:retry`);
    expect(h.store.calls).toEqual([]);
    expect(rowOf(h, R_A)).toMatchObject({ state: "queued", attempts: 1, last_class: "parse-error" });
  });

  it("取得の失敗(HTTP 500・通信の失敗) → fetch-failed で再試行", async () => {
    const h = harness();
    h.gate.script.push(status500(), refused("network-error"));
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    expect(await tick(h)).toBe(`${R_A}:result:import:retry`);
    expect(rowOf(h, R_A)).toMatchObject({ attempts: 1, last_class: "fetch-failed" });
    expect(await tick(h)).toBe(`${R_A}:result:import:retry`);
    expect(rowOf(h, R_A)).toMatchObject({ attempts: 2, last_class: "fetch-failed" });
    expect(h.store.calls).toEqual([]);
  });

  it("保存(D1)の失敗 → save-failed で再試行。取得したページは捨て、次の試行でまた取る。成功すれば imported", async () => {
    const h = harness();
    h.store.failures = 1;
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    expect(await tick(h)).toBe(`${R_A}:result:import:retry`);
    expect(rowOf(h, R_A)).toMatchObject({ state: "queued", attempts: 1, last_class: "save-failed" });
    expect(await tick(h)).toBe(`${R_A}:result:import:ok`);
    expect(h.gate.urls).toHaveLength(2);
    expect(rowOf(h, R_A)).toMatchObject({ state: "imported", attempts: 2 });
  });

  it("3 試行で諦める(gave_up)。諦めるステップの結果は failed。それ以降は結果のアラームも取得も無い。警告は分類だけ(メッセージ・例外の文面を含まない)", async () => {
    const h = harness();
    h.store.failures = 99;
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    const outcomes = await drive(h, NOW + 60 * MIN);
    expect(outcomes).toEqual([`${R_A}:result:import:retry`, `${R_A}:result:import:retry`, `${R_A}:result:import:failed`]);
    expect(h.gate.urls).toHaveLength(MAX_RESULT_ATTEMPTS);
    expect(rowOf(h, R_A)).toMatchObject({ state: "gave_up", attempts: MAX_RESULT_ATTEMPTS, last_class: "save-failed" });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain(R_A);
    expect(h.warnings[0]).toContain("save-failed");
    expect(h.warnings.join("\n")).not.toContain("SECRET");
    expect(dumpAllTables(h)).not.toContain("SECRET");
    // 諦めたあとは、結果のために起きない
    const before = h.gate.urls.length;
    await drive(h, NOW + 24 * 60 * MIN);
    expect(h.gate.urls).toHaveLength(before);
  });

  it("3 試行の間隔は 10 分(2 回目は 1 回目の 10 分後、3 回目はその 10 分後)", async () => {
    const h = harness();
    h.gate.script.push(status500(), status500(), status500());
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    const times: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await tick(h);
      times.push(h.clock.now);
    }
    expect(times).toEqual([NOW, NOW + RESULT_RETRY_DELAY_MS, NOW + 2 * RESULT_RETRY_DELAY_MS]);
  });
});

describe("AC-B2(補足): gate の拒否は試行を消費しない保留にする(混雑・ブレーカー)。許可リスト外は即座に諦める", () => {
  it("queue-full: 試行を消費せず(attempts は 0 のまま)、保留 1 回・60 秒後に再試行。分類 busy", async () => {
    const h = harness();
    h.gate.script.push(refused("queue-full"));
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    expect(await tick(h)).toBe(`${R_A}:result:import:retry`);
    expect(rowOf(h, R_A)).toMatchObject({ state: "queued", attempts: 0, deferrals: 1, last_class: "busy", next_try_at: NOW + RESULT_BUSY_DELAY_MS });
    expect(h.alarm.at).toBe(NOW + RESULT_BUSY_DELAY_MS);
    expect(await tick(h)).toBe(`${R_A}:result:import:ok`);
    expect(rowOf(h, R_A)).toMatchObject({ state: "imported", attempts: 1, deferrals: 1 });
  });

  it("blocked(ブレーカー): 試行を消費せず、blockedUntil の 1 秒後まで待つ(blockedUntil が分からなければ 60 秒後)。分類 blocked", async () => {
    const h = harness();
    const until = NOW + 25 * MIN;
    h.gate.script.push(refused("blocked", until));
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A, R_B] });
    await tick(h);
    const first = rows(h).find((r) => r.deferrals === 1)!;
    expect(first).toMatchObject({ state: "queued", attempts: 0, last_class: "blocked", next_try_at: until + 1000 });

    const h2 = harness();
    h2.gate.script.push(refusedNoBlockedUntil());
    await h2.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    await tick(h2);
    expect(rowOf(h2, R_A)).toMatchObject({ attempts: 0, deferrals: 1, next_try_at: NOW + RESULT_BUSY_DELAY_MS });
  });

  it("blocked の待ちは最大 60 分（解除時刻が遠い未来や壊れた値でも、延々と先送りしない）。解除時刻が過去なら 60 秒後", async () => {
    const far = harness();
    far.gate.script.push(refused("blocked", NOW + 5 * 60 * MIN));
    await far.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    await tick(far);
    expect(rowOf(far, R_A)).toMatchObject({ attempts: 0, deferrals: 1, last_class: "blocked", next_try_at: NOW + 60 * MIN });

    const stale = harness();
    stale.gate.script.push(refused("blocked", NOW - 10 * MIN));
    await stale.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    await tick(stale);
    expect(rowOf(stale, R_A)).toMatchObject({ attempts: 0, deferrals: 1, next_try_at: NOW + RESULT_BUSY_DELAY_MS });
  });

  it("保留は 5 回まで。6 回目で諦める(gave_up。分類は直近のもの)。取得を試みた回数は 6 回", async () => {
    const h = harness();
    h.gate.script.push(...Array.from({ length: MAX_RESULT_DEFERRALS + 1 }, () => refused("queue-full")));
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    const outcomes = await drive(h, NOW + 60 * MIN);
    expect(outcomes).toHaveLength(MAX_RESULT_DEFERRALS + 1);
    expect(outcomes.slice(0, -1).every((o) => o.endsWith(":retry"))).toBe(true);
    expect(outcomes[outcomes.length - 1]).toBe(`${R_A}:result:import:failed`);
    expect(rowOf(h, R_A)).toMatchObject({ state: "gave_up", attempts: 0, deferrals: MAX_RESULT_DEFERRALS + 1, last_class: "busy" });
    expect(h.gate.urls).toHaveLength(MAX_RESULT_DEFERRALS + 1);
  });

  it("許可リスト外(disallowed-url)は、試行を数えずに即座に諦める(再試行しても直らない)", async () => {
    const h = harness();
    h.gate.script.push(refused("disallowed-url"));
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    expect(await tick(h)).toBe(`${R_A}:result:import:failed`);
    expect(rowOf(h, R_A)).toMatchObject({ state: "gave_up", attempts: 1, last_class: "blocked" });
    expect(h.gate.urls).toHaveLength(1);
  });

  it("保留・試行・諦めのどれでも、1 ステップは状態を必ず変える(即時ループしない): 次のアラームは、行の next_try_at より前にならない", async () => {
    const h = harness();
    h.gate.script.push(refused("queue-full"), status500(), refused("blocked", NOW + 5 * MIN));
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A, R_B, R_C] });
    for (let i = 0; i < 3; i += 1) {
      const before = dumpAllTables(h);
      await tick(h);
      expect(dumpAllTables(h)).not.toBe(before);
    }
  });
});

describe("AC-B4: 優先度(タスク・計画の仕事が無いときだけ動く)", () => {
  it("初回の取得待ち(queued)のタスクがあるあいだは結果を取らない。タスクが終わってから動く(結果の URL は、タスクの取得のあと)", async () => {
    const h = harness();
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    await h.core.schedule({ raceId: R_B, kaisaiDate: DATE }); // morning。一覧以外は拒否(blocked)で即失敗する
    const outcomes = await drive(h, NOW + 5 * MIN);
    expect(outcomes[0]).toBe(`${R_B}:morning:fetch:failed`); // タスクが先
    expect(outcomes.some((o) => o === `${R_A}:result:import:ok`)).toBe(true);
    const resultIndex = h.gate.urls.indexOf(resultUrl(R_A));
    const taskIndex = h.gate.urls.findIndex((u) => u.includes(R_B));
    expect(taskIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(taskIndex);
  });

  it("再試行待ち(試行済み)のタスクがあるあいだは、結果の候補でアラームを前倒ししない(再試行の間隔を無効にして、タスクを早く撃ち直さない)", async () => {
    const h = harness();
    await h.core.schedule({ raceId: R_B, kaisaiDate: DATE });
    // 取得を 1 回失敗させて再試行待ちにする(拒否ではなく HTTP 500)
    h.gate.script.push(status500());
    await tick(h);
    expect(h.alarm.at).toBe(NOW + RETRY_DELAY_MS);
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    expect(h.alarm.at).toBe(NOW + RETRY_DELAY_MS); // 結果の now ではなく、タスクの再試行の時刻のまま
    expect(h.gate.urls.filter((u) => u.includes(R_A))).toEqual([]);
  });

  it("計画の仕事(会場の一覧の再試行待ち・期限を待つ行)があるあいだは動かない。計画の仕事が無くなれば動く", async () => {
    const h = harness();
    h.clock.now = Date.parse("2026-06-28T08:00:00+09:00");
    await h.core.requestPlan({ kaisaiDate: DATE }); // pending の会場が 2 つ(next_try_at = 依頼の時刻)
    // 会場の一覧の取得は、これから 5 分後の再試行待ちにする(計画の仕事は残る。今は期限が来ていない)
    h.clock.now = NOW;
    h.sql.exec("UPDATE race_day_plan_venue SET next_try_at = ?", NOW + 5 * MIN);
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    expect(h.core.getPlanProgress().stage).toBe("pending");
    // 結果の候補(now)は入らず、アラームは計画の次の時刻(5 分後)
    expect(h.alarm.at).toBe(NOW + 5 * MIN);
    h.alarm.at = NOW; // 早く起きた
    expect(await h.core.runNextStep()).toEqual({ kind: "idle" });
    expect(h.gate.urls).toEqual([]); // 計画の仕事があるので、結果は取らない
    expect(rowOf(h, R_A)).toMatchObject({ state: "queued", attempts: 0 });
    // 計画の仕事が無くなる(会場の行を消す)と、結果が動く
    h.sql.exec("DELETE FROM race_day_plan_venue");
    h.alarm.at = NOW;
    expect(await h.core.runNextStep()).toMatchObject({ kind: "ran", mode: "result", step: "import", result: "ok" });
  });

  it("結果の行が期限前(再試行待ち)のときに早く起きても、何も取らず、状態を変えず、同じ時刻にアラームを張り直す(now ではない)", async () => {
    const h = harness();
    h.gate.script.push(status500());
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
    await tick(h);
    const due = NOW + RESULT_RETRY_DELAY_MS;
    expect(h.alarm.at).toBe(due);
    const before = dumpAllTables(h);
    h.clock.now = NOW + 3 * MIN; // 期限より前に起きた
    h.alarm.at = null;
    expect(await h.core.runNextStep()).toEqual({ kind: "idle" });
    expect(dumpAllTables(h)).toBe(before);
    expect(h.alarm.at).toBe(due);
  });

  it("Webhook が無効(notifier なし)でも、有効(notifier あり・送るものなし)でも、結果のアラームは動く", async () => {
    for (const notifier of [false, true]) {
      const h = harness({ notifier });
      await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] });
      expect(h.alarm.at).toBe(NOW);
      expect(await tick(h)).toBe(`${R_A}:result:import:ok`);
    }
  });

  it("発走前の分析の保存先(sink)が無い構成でも、結果の依頼は受けられる(結果ストアだけで足りる)", async () => {
    const h = harness({ sink: false });
    await expect(h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A] })).resolves.toMatchObject({ accepted: 1 });
    expect(await tick(h)).toBe(`${R_A}:result:import:ok`);
  });
});

describe("アラームの合成: nextAlarmAt の結果の候補", () => {
  const base: AlarmInputs = { nowMs: 1_000_000, retryDelayMs: RETRY_DELAY_MS, immediateWork: false, retryWork: false, planNextTryAtMs: null, planNextDueMs: null, purgeDueMs: null };

  it("結果の候補だけなら、その時刻(過去は now)。省略・null は候補なし", () => {
    expect(nextAlarmAt({ ...base, resultAtMs: 1_500_000 })).toBe(1_500_000);
    expect(nextAlarmAt({ ...base, resultAtMs: 500_000 })).toBe(1_000_000);
    expect(nextAlarmAt({ ...base, resultAtMs: null })).toBeNull();
    expect(nextAlarmAt(base)).toBeNull();
  });

  it("他の候補との最小を取る(max ではない)。掃除の期限より結果が早ければ結果、遅ければ掃除", () => {
    expect(nextAlarmAt({ ...base, resultAtMs: 1_200_000, purgeDueMs: 2_000_000 })).toBe(1_200_000);
    expect(nextAlarmAt({ ...base, resultAtMs: 3_000_000, purgeDueMs: 2_000_000 })).toBe(2_000_000);
    expect(nextAlarmAt({ ...base, resultAtMs: 3_000_000, planNextDueMs: 1_100_000 })).toBe(1_100_000);
  });
});

describe("getResultImportProgress(観測。状態は変えない。固定の語と数値だけ)", () => {
  it("件数と、各レースの状態・試行・保留・依頼日・次の試行・最後の分類を返す。メッセージ・例外の文面は含まない", async () => {
    const h = harness();
    expect(h.core.getResultImportProgress()).toEqual({ total: 0, queued: 0, imported: 0, gaveUp: 0, races: [] });
    h.gate.script.push(status500());
    await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: [R_A, R_B] });
    await tick(h); // 1 件目(レースID 昇順ではなく next_try_at・race_id の順)は失敗して再試行待ち
    await tick(h);
    const before = dumpAllTables(h);
    const progress = h.core.getResultImportProgress();
    expect(dumpAllTables(h)).toBe(before);
    expect(progress.total).toBe(2);
    expect(progress.queued + progress.imported + progress.gaveUp).toBe(2);
    expect(progress.queued).toBe(1);
    expect(progress.imported).toBe(1);
    const queued = progress.races.find((r) => r.state === "queued")!;
    expect(queued).toEqual({
      raceId: queued.raceId,
      state: "queued",
      attempts: 1,
      deferrals: 0,
      requestedOn: TODAY,
      nextTryAt: NOW + RESULT_RETRY_DELAY_MS,
      lastClass: "fetch-failed",
      updatedAt: NOW,
    });
    const imported = progress.races.find((r) => r.state === "imported")!;
    expect(imported.nextTryAt).toBeNull();
    expect(imported.lastClass).toBe("imported");
    expect(Object.keys(imported).sort()).toEqual(["attempts", "deferrals", "lastClass", "nextTryAt", "raceId", "requestedOn", "state", "updatedAt"]);
    expect(JSON.stringify(progress)).not.toContain("SECRET");
  });
});

// ---------------------------------------------------------------------------

describe("fuzz: 即時ループ・停止がない(結果の取り込み。種 60 通り)", () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it("60 通りの乱数(ページの種類・gate の拒否・保存の失敗・時計の飛び・依頼の再送・手動のタスクの割り込み)で、状態が変わらないのに now 以前へ張り直す起床が 0、止まった時点で queued が 0、タスクが残るあいだは結果を取らない", async () => {
    let wakes = 0;
    let resultSteps = 0;
    let interleavedTasks = 0;
    const finalStates = { queued: 0, imported: 0, gave_up: 0 };
    const classes = new Set<string>();
    const racesPool = [R_A, R_B, R_C];
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = rng(seed);
      const h = harness();
      const requested = racesPool.slice(0, 1 + Math.floor(random() * 3));
      h.gate.script.push(
        ...Array.from({ length: 30 }, (): GateResult => {
          const p = random();
          if (p < 0.15) return okPage(withoutPayoutTables(htmlOf[R_A]!));
          if (p < 0.2) return okPage(htmlOf[NAR_PRESALE.raceId]!);
          if (p < 0.25) return okPage("<html><body></body></html>");
          if (p < 0.4) return status500();
          if (p < 0.55) return refused("queue-full");
          if (p < 0.65) return refused("blocked", h.clock.now + Math.floor(random() * 40) * MIN);
          if (p < 0.68) return refused("disallowed-url");
          return okPage(htmlOf[R_A]!);
        }),
      );
      h.store.failures = Math.floor(random() * 3);
      await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: requested });
      for (let step = 0; step < 150; step += 1) {
        const at = h.alarm.at;
        if (at === null) break;
        if (at > NOW + 3 * 24 * 60 * MIN) break;
        if (random() < 0.15) {
          // 依頼の再送(cron の重複配信・翌日の依頼)
          if (random() < 0.3) h.clock.now += 24 * 60 * MIN;
          await h.core.requestResultImport({ kaisaiDate: DATE, raceIds: requested }).catch(() => undefined);
        }
        if (random() < 0.1) {
          // 手動のタスクの割り込み(結果より優先される)
          await h.core.schedule({ raceId: racesPool[Math.floor(random() * 3)]!, kaisaiDate: DATE }).catch(() => undefined);
          interleavedTasks += 1;
        }
        const before = dumpAllTables(h);
        const taskPending = (h.sql.exec("SELECT count(*) AS n FROM race_day_tasks WHERE status IN ('queued', 'fetched')").toArray() as { n: number }[])[0]!.n > 0;
        const urlsBefore = h.gate.urls.filter((u) => u.includes("/race/result.html")).length;
        h.clock.now = Math.max(h.clock.now, h.alarm.at ?? 0) + (random() < 0.2 ? Math.floor(random() * 30 * MIN) : 0);
        h.alarm.at = null;
        const outcome = await h.core.runNextStep();
        wakes += 1;
        if (outcome.kind === "ran" && outcome.mode === "result") resultSteps += 1;
        const after = dumpAllTables(h);
        if (taskPending) {
          // タスクが残っているあいだは、結果の取得が起きない
          expect(h.gate.urls.filter((u) => u.includes("/race/result.html")).length, `seed ${seed}: タスクが残っているのに結果を取った`).toBe(urlsBefore);
        }
        if (before === after && h.alarm.at !== null && h.alarm.at <= h.clock.now) {
          throw new Error(`seed ${seed}: 状態が変わらないのに now 以前へ張り直した`);
        }
      }
      if (h.alarm.at === null) {
        expect(rows(h).filter((r) => r.state === "queued"), `seed ${seed}: アラームが無いのに queued が残っている`).toEqual([]);
      }
      for (const r of rows(h)) {
        finalStates[r.state as keyof typeof finalStates] += 1;
        if (r.last_class !== null) classes.add(r.last_class);
        expect(["queued", "imported", "gave_up"], `seed ${seed}`).toContain(r.state);
        expect(r.attempts, `seed ${seed}: 試行の上限`).toBeLessThanOrEqual(MAX_RESULT_ATTEMPTS);
        expect(r.deferrals, `seed ${seed}: 保留の上限`).toBeLessThanOrEqual(MAX_RESULT_DEFERRALS + 1);
      }
      // 保存の呼び出しは、imported の行の数以上(imported に積み直されたものは複数回ありうる)で、保存したレースはすべて依頼したもの
      for (const c of h.store.calls) {
        expect(requested).toContain(c.raceId);
      }
    }
    expect(finalStates.imported).toBeGreaterThan(10); // 空振り防止: 取り込みで終わる経路を通った
    expect(finalStates.gave_up).toBeGreaterThan(10); // 空振り防止: 諦めで終わる経路を通った
    for (const c of ["no-payout", "not-confirmed", "parse-error", "fetch-failed", "save-failed", "blocked", "imported"]) {
      expect([...classes], `最後の分類に ${c} が現れる`).toContain(c);
    }
    expect(wakes).toBeGreaterThan(300); // 空振り防止: 十分な起床を観測した
    expect(resultSteps).toBeGreaterThan(100); // 空振り防止: 結果のステップを多数通った
    expect(interleavedTasks).toBeGreaterThan(10); // 空振り防止: タスクの割り込みを通った
  });
});
