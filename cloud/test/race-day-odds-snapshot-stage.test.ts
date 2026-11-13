import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { JraOddsRaceLinks, JraOddsVenueLink } from "../../packages/core/src/scraper/parse-jra-odds-index";
import { jraOddsCacheKey } from "../src/jra-odds-cache";
import type { JraOddsFetcher, JraOddsResult, JraOddsSession } from "../src/jra-odds-fetch";
import type { OddsSnapshotSink } from "../src/odds-snapshot-repository";
import {
  ODDS_SNAPSHOT_EARLY_LEAD_MS,
  ODDS_SNAPSHOT_FETCH_MAX_ATTEMPTS,
  ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS,
  ODDS_SNAPSHOT_LEAD_MS,
  ODDS_SNAPSHOT_SAVE_MAX_ATTEMPTS,
  ODDS_SNAPSHOT_SAVE_RETRY_DELAY_MS,
  OddsSnapshotStore,
  parseOddsSnapshotPayload,
  type OddsSnapshotPayload,
} from "../src/race-day-odds-snapshot";
import { OddsSnapshotStage } from "../src/race-day-odds-snapshot-stage";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #732: 発走 10 分前・5 分前の単勝・複勝の全頭のオッズの記録の段。偽の JRA の取得口(実際の JRA には出ない)・偽の保存先・`node:sqlite`・手で進める時計。
 * 頁は見本(東京 8R・14 頭。「13 時 42 分現在」)。開催日は 2026-11-15 として読ませる(頁の時刻の日付はレースの日付から作る)。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = (name: string): string => new TextDecoder("shift_jis").decode(new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name))));
const TANPUKU = html("jra_odds_tanpuku_1342_202605050208.html");
const DATE = "20261115";
const RACE = "202605050208";
const RACE2 = "202605050209";
const START = Date.parse("2026-11-15T06:45:00Z"); // 15:45 JST
const DUE = START - ODDS_SNAPSHOT_LEAD_MS; // 5 分前
const DUE10 = START - ODDS_SNAPSHOT_EARLY_LEAD_MS;

const PAGES = ["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"];
const DIGIT: Record<string, string> = { tanpuku: "1", wakuren: "3", umaren: "4", wide: "5", umatan: "6", sanrenpuku: "7", sanrentan: "8" };
const cnameOf = (raceId: string, page: string): string => `pw15${DIGIT[page]}ouS3${raceId.slice(4, 6)}${raceId.slice(0, 4)}${raceId.slice(6, 8)}${raceId.slice(8, 10)}${raceId.slice(10, 12)}${DATE}Z/AA`;
const linksOf = (raceId: string): JraOddsRaceLinks => ({
  raceId,
  race: raceId.slice(10, 12),
  cnames: Object.fromEntries(PAGES.map((p) => [p, cnameOf(raceId, p)])) as unknown as JraOddsRaceLinks["cnames"],
});
const VENUE: JraOddsVenueLink = { venueCode: "05", year: "2026", kai: "05", day: "02", date: DATE, racesCname: `pw15orl000520260502${DATE}/AA` };

interface FakeJra extends JraOddsFetcher {
  opens: number;
  listVenues: number;
  fetchOdds: string[];
  /** n 回目(1 始まり)の頁の取得の結果。null なら見本の頁。 */
  oddsResult: (nth: number) => JraOddsResult<string> | null;
  throwOnOpen: boolean;
}
function fakeJra(): FakeJra {
  const jra: FakeJra = {
    opens: 0,
    listVenues: 0,
    fetchOdds: [],
    oddsResult: () => null,
    throwOnOpen: false,
    open(): JraOddsSession {
      jra.opens += 1;
      if (jra.throwOnOpen) throw new Error("secret https://example.invalid/x?cname=ABC");
      let sent = 0;
      return {
        get requestCount() {
          return sent;
        },
        async listVenues() {
          sent += 1;
          jra.listVenues += 1;
          return { status: "ok", value: [VENUE] };
        },
        async listRaces() {
          sent += 1;
          return { status: "ok", value: [linksOf(RACE), linksOf(RACE2)] };
        },
        async fetchOdds(cname: string) {
          sent += 1;
          jra.fetchOdds.push(cname);
          return jra.oddsResult(jra.fetchOdds.length) ?? { status: "ok", value: TANPUKU };
        },
      };
    },
  };
  return jra;
}

interface Harness {
  readonly stage: OddsSnapshotStage;
  readonly store: OddsSnapshotStore;
  readonly jra: FakeJra;
  readonly saved: OddsSnapshotPayload[];
  readonly warns: string[];
  readonly cache: Map<string, { value: string; fetchedAt: number }>;
  clock: { now: number };
  saveFailures: number;
}
let sql: NodeSql | null = null;
afterEach(() => {
  sql?.close();
  sql = null;
});
function harness(startNow = DUE): Harness {
  sql = openNodeSql();
  const store = new OddsSnapshotStore(sql);
  const jra = fakeJra();
  const clock = { now: startNow };
  const cache = new Map<string, { value: string; fetchedAt: number }>();
  const saved: OddsSnapshotPayload[] = [];
  const warns: string[] = [];
  const h = { jra, saved, warns, cache, clock, store, saveFailures: 0 } as Harness;
  const sink: OddsSnapshotSink = {
    async save(p) {
      if (h.saveFailures > 0) {
        h.saveFailures -= 1;
        throw new Error("D1 down");
      }
      saved.push(p);
    },
  };
  const stage = new OddsSnapshotStage({
    store,
    now: () => clock.now,
    onWarn: (m) => warns.push(m),
    sink,
    fetcher: jra,
    cache: { get: (k) => cache.get(k), set: (k, v) => void cache.set(k, { value: v, fetchedAt: clock.now }) },
  });
  Object.assign(h, { stage });
  return h;
}
const rowOf = (h: Harness, leadMin: 10 | 5, raceId = RACE) => h.store.rows().find((r) => r.race_id === raceId && r.lead_min === leadMin)!;
const registerAndRun = async (h: Harness, raceId = RACE, startMs = START) => {
  h.stage.register(raceId, DATE, startMs);
  const row = h.store.nextDue(h.clock.now);
  expect(row, "予定の時刻が来ている前提").not.toBeNull();
  return h.stage.runStep(row!);
};

describe("取れたとき(ok)", () => {
  it("単勝・複勝の頁を 1 本だけ取り、全頭(14 頭)の単勝・人気・複勝の下限と上限、取った時刻・頁の時刻・発走の時刻を D1 の保存先へ渡す。状態は done", async () => {
    const h = harness();
    const outcome = await registerAndRun(h);
    expect(outcome).toEqual({ kind: "ran", raceId: RACE, leadMin: 5, mode: "odds-snapshot", step: "record", result: "ok", reason: null });
    expect(h.jra.fetchOdds).toEqual([linksOf(RACE).cnames.tanpuku]); // 取った頁は 1 本(単勝・複勝)だけ
    expect(h.saved).toHaveLength(1);
    const p = h.saved[0]!;
    expect(p).toMatchObject({
      raceId: RACE, leadMin: 5, kaisaiDate: DATE, startMs: START, dueMs: DUE, takenAtMs: DUE, officialDatetime: "2026-11-15 13:42:00", oddsStatus: "middle", status: "ok", reason: null, attempts: 1,
    });
    expect(p.horses).toHaveLength(14);
    expect(p.horses![0]).toEqual([1, 66.2, 10, 9, 13.7, "2023101645"]); // 1 番: 単勝 66.2(10 番人気)・複勝 9.0〜13.7(下限と上限の両方)・馬の ID(頁のリンクの 10 桁)
    expect(p.horses!.every((h2) => typeof h2[5] === "string" && /^\d{10}$/.test(h2[5]))).toBe(true);
    expect(p.horses!.map((h2) => h2[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(rowOf(h, 5).state).toBe("done");
    expect(rowOf(h, 10).state, "10 分前の行はまだ pending(別の時点)").toBe("pending");
    expect(parseOddsSnapshotPayload(rowOf(h, 5).payload_json!)).toEqual(p); // 保存の前に DO にも結果を持つ
  });
  it("頁の時刻と取った時刻は別の値(取った時刻は時計、頁の時刻は JRA の頁から)", async () => {
    const h = harness(DUE + 12_000);
    await registerAndRun(h);
    expect(h.saved[0]!.takenAtMs).toBe(DUE + 12_000);
    expect(h.saved[0]!.officialDatetime).toBe("2026-11-15 13:42:00");
    expect(h.saved[0]!.takenAtMs).not.toBe(h.saved[0]!.dueMs);
  });
  it("同じ場の 2 つ目のレースは、場・レースのリンクを取得キャッシュから読み、開催選択を繰り返さない(開催選択は 1 回だけ)", async () => {
    const h = harness();
    await registerAndRun(h, RACE);
    await registerAndRun(h, RACE2);
    expect(h.jra.listVenues).toBe(1);
    expect(h.jra.fetchOdds).toEqual([linksOf(RACE).cnames.tanpuku, linksOf(RACE2).cnames.tanpuku]);
    expect(h.saved.map((s) => s.raceId)).toEqual([RACE, RACE2]);
  });
});

describe("取れなかったとき(再試行は発走前に限り 3 回まで)", () => {
  it("1 回目の失敗は retry: 15 秒後に再試行する(試行回数 1・保存はしない)。2〜3 回目の失敗も retry。4 回目(= 初回 + 再試行 3 回)の失敗で failed(fetch-failed)を保存する", async () => {
    expect(ODDS_SNAPSHOT_FETCH_MAX_ATTEMPTS).toBe(4);
    const h = harness();
    h.jra.oddsResult = () => ({ status: "timeout" } as unknown as JraOddsResult<string>);
    h.stage.register(RACE, DATE, START);
    for (let n = 1; n <= 3; n += 1) {
      const outcome = await h.stage.runStep(rowOf(h, 5));
      expect(outcome).toMatchObject({ result: "retry", reason: null });
      expect(rowOf(h, 5)).toMatchObject({ attempts: n, state: "pending", next_try_at: h.clock.now + ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS });
      expect(h.saved).toEqual([]);
      expect(h.store.nextDue(h.clock.now)?.lead_min, "5 分前は再試行の時刻まで起きない(10 分前の行は、5 分前の時刻を過ぎているので別に動ける)").toBe(10);
      h.clock.now += ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS;
    }
    const last = await h.stage.runStep(rowOf(h, 5));
    expect(last).toMatchObject({ result: "failed", reason: "fetch-failed" });
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ status: "failed", reason: "fetch-failed", attempts: 4, takenAtMs: DUE + 3 * ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS, officialDatetime: null, oddsStatus: null, horses: null, startMs: START }); // 取った時刻 = 最後の試行の時刻
    expect(rowOf(h, 5).state).toBe("done");
    expect(h.jra.fetchOdds).toHaveLength(4);
  });
  it("再試行の時刻が発走以降になるときは再試行せず、その回で failed(発走前に限る)", async () => {
    const h = harness(START - ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS); // 次の再試行は発走ちょうど
    h.jra.oddsResult = () => ({ status: "timeout" } as unknown as JraOddsResult<string>);
    const outcome = await registerAndRun(h);
    expect(outcome).toMatchObject({ result: "failed", reason: "fetch-failed" });
    expect(h.saved[0]).toMatchObject({ status: "failed", attempts: 1, takenAtMs: START - ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS });
    expect(h.jra.fetchOdds).toHaveLength(1);
  });
  it("失敗のあと成功したら ok(試行回数に失敗の分が入る)", async () => {
    const h = harness();
    h.jra.oddsResult = (n) => (n === 1 ? ({ status: "timeout" } as unknown as JraOddsResult<string>) : null);
    h.stage.register(RACE, DATE, START);
    expect(await h.stage.runStep(rowOf(h, 5))).toMatchObject({ result: "retry" });
    h.clock.now += ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS;
    expect(await h.stage.runStep(rowOf(h, 5))).toMatchObject({ result: "ok" });
    expect(h.saved[0]).toMatchObject({ status: "ok", attempts: 2, takenAtMs: h.clock.now });
  });
  it("頁が読めない(単勝・複勝の表が無い)ときも fetch-failed(取得キャッシュに JSON を置かない)", async () => {
    const h = harness(START - 1_000);
    h.jra.oddsResult = () => ({ status: "ok", value: "<html><title>x</title></html>" });
    const outcome = await registerAndRun(h);
    expect(outcome).toMatchObject({ result: "failed", reason: "fetch-failed" });
    expect(h.cache.has(jraOddsCacheKey(RACE, "tanpuku"))).toBe(false);
  });
  it("古い取得キャッシュの JSON(この起床より前に置かれたもの)は、取れなかった記録の代わりに使わない", async () => {
    const h = harness(START - 1_000);
    // 先に 1 回取って JSON を置く(別の起床。たとえば締切の再計算)
    h.clock.now = DUE - 100_000;
    const first = harness(DUE - 100_000);
    await registerAndRun(first);
    const stale = first.cache.get(jraOddsCacheKey(RACE, "tanpuku"))!;
    expect(stale.fetchedAt).toBe(DUE - 100_000); // 前提: 古い JSON がある
    h.clock.now = START - 1_000;
    h.cache.set(jraOddsCacheKey(RACE, "tanpuku"), stale);
    h.jra.oddsResult = () => ({ status: "timeout" } as unknown as JraOddsResult<string>);
    const outcome = await registerAndRun(h);
    expect(outcome).toMatchObject({ result: "failed", reason: "fetch-failed" });
    expect(h.saved[0]!.horses).toBeNull();
  });
  it("取得口が例外を投げても、段は投げず failed にし、警告に URL・cname・例外の文面を出さない", async () => {
    const h = harness(START - 1_000);
    h.jra.throwOnOpen = true;
    const outcome = await registerAndRun(h);
    expect(outcome).toMatchObject({ result: "failed", reason: "fetch-failed" });
    for (const w of h.warns) expect(w).not.toMatch(/secret|example\.invalid|cname/);
  });
});

describe("発走後に起きたとき(too-late)", () => {
  it("発走の時刻以降なら JRA に出ず、skipped(too-late)を保存して終える", async () => {
    const h = harness(START);
    h.stage.register(RACE, DATE, START + 1); // 積むときはまだ発走前(積んだあと時計だけが進んだ)
    h.clock.now = START + 5_000;
    const outcome = await h.stage.runStep(rowOf(h, 5));
    expect(outcome).toMatchObject({ result: "failed", reason: "too-late" });
    expect(h.jra.opens).toBe(0);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ status: "skipped", reason: "too-late", takenAtMs: START + 5_000, horses: null, attempts: 0, startMs: START + 1, leadMin: 5 });
    expect(rowOf(h, 5).state).toBe("done");
  });
  it("発走の 1 ミリ秒前なら取る(境界)", async () => {
    const h = harness(START - 1);
    const outcome = await registerAndRun(h);
    expect(outcome).toMatchObject({ result: "ok" });
    expect(h.jra.opens).toBe(1);
  });
});

describe("D1 への保存の失敗", () => {
  it("保存に失敗したら、取り直さずに 20 秒後に保存だけ再試行する(DO に持つ結果を使う)。成功したら done", async () => {
    const h = harness();
    h.saveFailures = 1;
    const first = await registerAndRun(h);
    expect(first).toMatchObject({ result: "retry" });
    expect(rowOf(h, 5)).toMatchObject({ state: "pending", save_attempts: 1, next_try_at: h.clock.now + ODDS_SNAPSHOT_SAVE_RETRY_DELAY_MS });
    expect(rowOf(h, 5).payload_json).not.toBeNull();
    h.clock.now += ODDS_SNAPSHOT_SAVE_RETRY_DELAY_MS;
    const second = await h.stage.runStep(rowOf(h, 5));
    expect(second).toMatchObject({ result: "ok" });
    expect(h.jra.fetchOdds).toHaveLength(1); // 取り直していない
    expect(h.saved).toHaveLength(1);
    expect(rowOf(h, 5).state).toBe("done");
    for (const w of h.warns) expect(w).not.toMatch(/secret|example\.invalid/);
  });
  it("保存の試行が上限(3 回)に尽きたら abandoned にして警告を残す(取り直さない)", async () => {
    expect(ODDS_SNAPSHOT_SAVE_MAX_ATTEMPTS).toBe(3);
    const h = harness();
    h.saveFailures = 99;
    h.stage.register(RACE, DATE, START);
    const results: string[] = [];
    for (let n = 0; n < ODDS_SNAPSHOT_SAVE_MAX_ATTEMPTS; n += 1) {
      results.push((await h.stage.runStep(rowOf(h, 5))).result);
      h.clock.now += ODDS_SNAPSHOT_SAVE_RETRY_DELAY_MS;
    }
    expect(results).toEqual(["retry", "retry", "failed"]);
    expect(rowOf(h, 5)).toMatchObject({ state: "abandoned", save_attempts: 3 });
    expect(h.saved).toEqual([]);
    expect(h.jra.fetchOdds).toHaveLength(1);
    expect(h.warns.some((w) => w.includes("諦めました"))).toBe(true);
    for (const w of h.warns) expect(w).not.toMatch(/secret|example\.invalid/);
  });
});

describe("積み方", () => {
  it("register は発走前だけ積む。積めたら true・過ぎていれば false。例外は握る(確定を止めない)", () => {
    const h = harness();
    expect(h.stage.register(RACE, DATE, START)).toBe(true);
    expect(h.stage.register(RACE2, DATE, DUE - 1)).toBe(false);
    expect(h.store.rows().map((r) => [r.race_id, r.lead_min])).toEqual([[RACE, 10], [RACE, 5]]); // 1 レースにつき 2 時点
    sql!.exec("DROP TABLE race_day_odds_snap");
    expect(h.stage.register("202605050210", DATE, START)).toBe(false);
    expect(h.warns.some((w) => w.includes("202605050210"))).toBe(true);
  });
});

describe("10 分前(比べるための記録。5 分前が必須)", () => {
  it("10 分前の時刻に取れたら、leadMin 10・予定の時刻と実際の時刻を別に残して保存する。5 分前の行は pending のまま", async () => {
    const h = harness(DUE10 + 7_000);
    h.stage.register(RACE, DATE, START);
    const outcome = await h.stage.runStep(h.store.nextDue(h.clock.now)!);
    expect(outcome).toMatchObject({ leadMin: 10, result: "ok" });
    expect(h.saved[0]).toMatchObject({ leadMin: 10, dueMs: DUE10, takenAtMs: DUE10 + 7_000, startMs: START, status: "ok" });
    expect(h.saved[0]!.takenAtMs).not.toBe(h.saved[0]!.dueMs); // 実際の時刻は予定の時刻ではない
    expect(rowOf(h, 10).state).toBe("done");
    expect(rowOf(h, 5).state).toBe("pending");
  });
  it("10 分前の取得が遅れて 5 分前の時刻にぶつかったら、5 分前を先に取り、10 分前は取らずに too-late で終える(JRA に出ない)", async () => {
    const h = harness(DUE);
    h.stage.register(RACE, DATE, START);
    const first = h.store.nextDue(h.clock.now)!;
    expect(first.lead_min).toBe(5); // 時刻の早い 10 分前より 5 分前が先
    expect(await h.stage.runStep(first)).toMatchObject({ leadMin: 5, result: "ok" });
    const opensAfterFive = h.jra.opens;
    const second = h.store.nextDue(h.clock.now)!;
    expect(second.lead_min).toBe(10);
    expect(await h.stage.runStep(second)).toMatchObject({ leadMin: 10, result: "failed", reason: "too-late" });
    expect(h.jra.opens).toBe(opensAfterFive); // 10 分前のために JRA に出ていない
    expect(h.saved.map((p) => [p.leadMin, p.status, p.reason])).toEqual([[5, "ok", null], [10, "skipped", "too-late"]]);
    expect(h.saved[1]!.takenAtMs).toBe(DUE);
  });
  it("10 分前の再試行は、5 分前の時刻より前に限る(5 分前の時刻にぶつかる再試行はせず、その回で failed)。時点ごとに試行回数を数える", async () => {
    const h = harness(DUE - ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS); // 次の再試行は 5 分前ちょうど
    h.jra.oddsResult = () => ({ status: "timeout" } as unknown as JraOddsResult<string>);
    h.stage.register(RACE, DATE, START);
    const outcome = await h.stage.runStep(rowOf(h, 10));
    expect(outcome).toMatchObject({ leadMin: 10, result: "failed", reason: "fetch-failed" });
    expect(rowOf(h, 10).attempts).toBe(1);
    expect(rowOf(h, 5).attempts).toBe(0);
  });
  it("10 分前の失敗は 5 分前の再試行の回数に数えない。10 分前で取れた JSON は、5 分前の取得の成功には使われない(5 分前は自分の取得が要る)", async () => {
    const h = harness(DUE10);
    h.stage.register(RACE, DATE, START);
    await h.stage.runStep(rowOf(h, 10)); // 10 分前は取れて、取得キャッシュに JSON が残る
    expect(h.cache.has(jraOddsCacheKey(RACE, "tanpuku"))).toBe(true);
    h.clock.now = DUE;
    h.jra.oddsResult = () => ({ status: "timeout" } as unknown as JraOddsResult<string>);
    await h.stage.runStep(rowOf(h, 5));
    expect(rowOf(h, 5).attempts).toBe(1);
    expect(rowOf(h, 5).state).toBe("pending"); // 失敗 → 再試行待ち。10 分前の JSON を 5 分前の値として使っていない
    expect(h.saved.map((p) => p.leadMin)).toEqual([10]);
  });
});
