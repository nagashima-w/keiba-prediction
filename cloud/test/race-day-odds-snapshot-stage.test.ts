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
const UMAREN = html("jra_odds_umaren_202605050208.html"); // 14 頭・91 組。「10 時 37 分現在」
const WAKUREN = html("jra_odds_wakuren_202605050208.html"); // 34 組(1 頭だけの枠の同枠 2 組は空き)
const WIDE = html("jra_odds_wide_202605050208.html"); // 14 頭・91 組(値は下限と上限の幅)
const SANRENPUKU = html("jra_odds_sanrenpuku_202605050208.html"); // 14 頭・364 組
const UMATAN = html("jra_odds_umatan_202605050208.html"); // 14 頭・182 組(順序つき: キーは 1 着・2 着の順)
const SANRENTAN = html("jra_odds_sanrentan_202605050208.html"); // 14 頭・2184 組(うち「票数なし」83 組。順序つき)
const DATE = "20261115";
const RACE = "202605050208";
const RACE2 = "202605050209";
const START = Date.parse("2026-11-15T06:45:00Z"); // 15:45 JST
const DUE = START - ODDS_SNAPSHOT_LEAD_MS; // 5 分前
const DUE10 = START - ODDS_SNAPSHOT_EARLY_LEAD_MS;

const PAGES = ["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"];
const DIGIT: Record<string, string> = { tanpuku: "1", wakuren: "3", umaren: "4", wide: "5", umatan: "6", sanrenpuku: "7", sanrentan: "8" };
const cnameOf = (raceId: string, page: string): string => `pw15${DIGIT[page]}ouS3${raceId.slice(4, 6)}${raceId.slice(0, 4)}${raceId.slice(6, 8)}${raceId.slice(8, 10)}${raceId.slice(10, 12)}${DATE}Z/AA`;
const linksOf = (raceId: string, without: readonly string[] = []): JraOddsRaceLinks => ({
  raceId,
  race: raceId.slice(10, 12),
  cnames: Object.fromEntries(PAGES.filter((p) => !without.includes(p)).map((p) => [p, cnameOf(raceId, p)])) as unknown as JraOddsRaceLinks["cnames"],
});
const VENUE: JraOddsVenueLink = { venueCode: "05", year: "2026", kai: "05", day: "02", date: DATE, racesCname: `pw15orl000520260502${DATE}/AA` };

interface FakeJra extends JraOddsFetcher {
  opens: number;
  listVenues: number;
  fetchOdds: string[];
  /** n 回目(1 始まり)の頁の取得の結果。null なら見本の頁。 */
  oddsResult: (nth: number) => JraOddsResult<string> | null;
  /** 開催選択の結果(Issue #804)。null なら見本。 */
  venuesResult: () => JraOddsResult<JraOddsVenueLink[]> | null;
  throwOnOpen: boolean;
  /** Issue #817: 発売の無い式別(枠連が無いレースのレース選択を再現する)。RACE のリンクからこの式別を外す。 */
  notSold: string[];
}
function fakeJra(): FakeJra {
  const jra: FakeJra = {
    opens: 0,
    listVenues: 0,
    fetchOdds: [],
    oddsResult: () => null,
    venuesResult: () => null,
    throwOnOpen: false,
    notSold: [],
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
          return jra.venuesResult() ?? { status: "ok", value: [VENUE] };
        },
        async listRaces() {
          sent += 1;
          return { status: "ok", value: [linksOf(RACE, jra.notSold), linksOf(RACE2)] };
        },
        async fetchOdds(cname: string) {
          sent += 1;
          jra.fetchOdds.push(cname);
          const page = cname.startsWith(`pw15${DIGIT.umaren}`) ? UMAREN : cname.startsWith(`pw15${DIGIT.wakuren}`) ? WAKUREN : cname.startsWith(`pw15${DIGIT.wide}`) ? WIDE : cname.startsWith(`pw15${DIGIT.sanrenpuku}`) ? SANRENPUKU : cname.startsWith(`pw15${DIGIT.umatan}`) ? UMATAN : cname.startsWith(`pw15${DIGIT.sanrentan}`) ? SANRENTAN : TANPUKU;
          return jra.oddsResult(jra.fetchOdds.length) ?? { status: "ok", value: page };
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
  /** Issue #796: 保存後のフック(別の Worker への依頼)の呼び出しの記録。呼ばれた時点の行の状態も残す。 */
  readonly hookCalls: { raceId: string; leadMin: number; stateAtCall: string | undefined }[];
  hookThrows: boolean;
  /** Issue #804: 拠点(段に渡す関数の返り値)。 */
  colo: string | null;
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
  const h = { jra, saved, warns, cache, clock, store, saveFailures: 0, hookCalls: [], hookThrows: false, colo: null } as unknown as Harness;
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
    colo: () => h.colo,
    cache: { get: (k) => cache.get(k), set: (k, v) => void cache.set(k, { value: v, fetchedAt: clock.now }) },
    onSaved: async (raceId, leadMin) => {
      h.hookCalls.push({ raceId, leadMin, stateAtCall: store.rows().find((r) => r.race_id === raceId && r.lead_min === leadMin)?.state });
      if (h.hookThrows) {
        throw new Error("hook down");
      }
    },
  });
  Object.assign(h, { stage });
  return h;
}
const rowOf = (h: Harness, leadMin: 10 | 5 | -1 | -2, raceId = RACE) => h.store.rows().find((r) => r.race_id === raceId && r.lead_min === leadMin)!;
const registerAndRun = async (h: Harness, raceId = RACE, startMs = START) => {
  h.stage.register(raceId, DATE, startMs);
  const row = h.store.nextDue(h.clock.now);
  expect(row, "予定の時刻が来ている前提").not.toBeNull();
  return h.stage.runStep(row!);
};

describe("取れたとき(ok)", () => {
  it("単勝・複勝の頁(必須)と、馬連・枠連・ワイド・3連複の頁を取り、全頭(14 頭)の単勝・人気・複勝の下限と上限、取った時刻・頁の時刻・発走の時刻を D1 の保存先へ渡す。状態は done", async () => {
    const h = harness();
    const outcome = await registerAndRun(h);
    expect(outcome).toEqual({ kind: "ran", raceId: RACE, leadMin: 5, mode: "odds-snapshot", step: "record", result: "ok", reason: null });
    expect(h.jra.fetchOdds).toEqual([linksOf(RACE).cnames.tanpuku, linksOf(RACE).cnames.umaren, linksOf(RACE).cnames.wakuren, linksOf(RACE).cnames.wide, linksOf(RACE).cnames.sanrenpuku, linksOf(RACE).cnames.umatan, linksOf(RACE).cnames.sanrentan]); // 取る順は 単勝・複勝 → 馬連 → 枠連 → ワイド → 3連複 → 馬単 → 三連単(三連単が最後。#794)
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
    expect(h.jra.fetchOdds.filter((c) => c.startsWith(`pw15${DIGIT.tanpuku}`))).toEqual([linksOf(RACE).cnames.tanpuku, linksOf(RACE2).cnames.tanpuku]);
    expect(h.jra.fetchOdds).toHaveLength(14); // 2 レース × 7 頁
    expect(h.saved.map((s) => s.raceId)).toEqual([RACE, RACE2]);
  });
});

describe("#787: 前日の夜(-1)・当日の朝(-2)の行(単勝・複勝だけ)", () => {
  const EVENING = Date.parse("2026-11-14T21:10:00+09:00");
  const MORNING = Date.parse("2026-11-15T09:31:00+09:00");
  it("前日の夜(-1): 単勝・複勝の頁 1 本だけ取り(組合せは取らない)、combos は null。取った時刻は実際の時計、due は前日 21:00 JST、14 頭を残す", async () => {
    const h = harness(EVENING);
    h.stage.register(RACE, DATE, START);
    const row = h.store.nextDue(EVENING);
    expect(row).toMatchObject({ lead_min: -1 });
    const outcome = await h.stage.runStep(row!);
    expect(outcome).toEqual({ kind: "ran", raceId: RACE, leadMin: -1, mode: "odds-snapshot", step: "record", result: "ok", reason: null });
    expect(h.jra.fetchOdds).toEqual([linksOf(RACE).cnames.tanpuku]); // 1 本だけ
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ leadMin: -1, status: "ok", combos: null, takenAtMs: EVENING, dueMs: Date.parse("2026-11-14T21:00:00+09:00"), startMs: START, attempts: 1 });
    expect(h.saved[0]!.horses).toHaveLength(14);
    expect(rowOf(h, -1).state).toBe("done");
    expect(parseOddsSnapshotPayload(rowOf(h, -1).payload_json!)).toEqual(h.saved[0]);
  });
  it("当日の朝(-2): 単勝・複勝の頁 1 本だけ、combos は null。takenAtMs は予定(09:30)ではなく実際の時刻", async () => {
    const h = harness(MORNING);
    h.stage.register(RACE, DATE, START);
    const row = h.store.nextDue(MORNING);
    expect(row).toMatchObject({ lead_min: -2 });
    expect(await h.stage.runStep(row!)).toMatchObject({ leadMin: -2, result: "ok" });
    expect(h.jra.fetchOdds).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ leadMin: -2, combos: null, takenAtMs: MORNING, dueMs: Date.parse("2026-11-15T09:30:00+09:00") });
    expect(h.saved[0]!.takenAtMs).not.toBe(h.saved[0]!.dueMs);
  });
  it("10・5 分前の行は今までどおり組合せまで取る(-1・-2 の変更が波及しない。5 分前は頁 7 本)", async () => {
    const h = harness();
    await registerAndRun(h);
    expect(h.jra.fetchOdds).toHaveLength(7);
    expect(h.saved[0]!.combos).not.toBeNull();
  });
  it("前日の夜は開催日 05:00 JST ちょうどで too-late(skipped。JRA に出ない)。その 1 ミリ秒前は取る", async () => {
    const five = Date.parse("2026-11-15T05:00:00+09:00");
    const late = harness(five);
    late.store.register({ raceId: RACE, kaisaiDate: DATE, startMs: START, now: EVENING });
    const out = await late.stage.runStep(rowOf(late, -1));
    expect(out).toMatchObject({ result: "failed", reason: "too-late", leadMin: -1 });
    expect(late.jra.fetchOdds).toEqual([]);
    expect(late.saved[0]).toMatchObject({ status: "skipped", reason: "too-late", horses: null, combos: null });
    sql?.close();
    sql = null;
    const early = harness(five - 1);
    early.store.register({ raceId: RACE, kaisaiDate: DATE, startMs: START, now: EVENING });
    expect(await early.stage.runStep(rowOf(early, -1))).toMatchObject({ result: "ok" });
  });
  it("当日の朝は、そのレースの発走の 10 分前ちょうどで too-late(skipped)。1 ミリ秒前は取る", async () => {
    const late = harness(DUE10);
    late.store.register({ raceId: RACE, kaisaiDate: DATE, startMs: START, now: MORNING });
    expect(await late.stage.runStep(rowOf(late, -2))).toMatchObject({ result: "failed", reason: "too-late", leadMin: -2 });
    expect(late.jra.fetchOdds).toEqual([]);
    sql?.close();
    sql = null;
    const early = harness(DUE10 - 1);
    early.store.register({ raceId: RACE, kaisaiDate: DATE, startMs: START, now: MORNING });
    expect(await early.stage.runStep(rowOf(early, -2))).toMatchObject({ result: "ok" });
  });
  it("前日の夜に頁の値が空(発売前など)なら、既存どおり fetch-failed(再試行の時刻が最後の時刻より前なら retry)。組合せには出ない", async () => {
    const h = harness(EVENING);
    h.jra.oddsResult = () => ({ status: "ok", value: "<html><title>x</title></html>" });
    h.stage.register(RACE, DATE, START);
    expect(await h.stage.runStep(rowOf(h, -1))).toMatchObject({ result: "retry", leadMin: -1 });
    expect(h.jra.fetchOdds).toHaveLength(1);
    expect(rowOf(h, -1)).toMatchObject({ attempts: 1, state: "pending", next_try_at: EVENING + ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS });
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
    expect(h.jra.fetchOdds).toHaveLength(7); // 取り直していない(1 回の取得の 7 頁だけ)
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
    expect(h.jra.fetchOdds).toHaveLength(7);
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

describe("馬連・枠連・ワイド・3連複の全組の記録(#751)", () => {
  const combosOf = (h: Harness) => h.saved[0]!.combos!;
  type Page = { t: number; dt: string | null; st: string | null; o: Record<string, unknown> };
  const TIMEOUT = { status: "timeout" } as unknown as JraOddsResult<string>;
  const ERR4 = { umaren: { err: "fetch-failed" }, wakuren: { err: "fetch-failed" }, wide: { err: "fetch-failed" }, sanrenpuku: { err: "fetch-failed" } };
  const ERR6 = { ...ERR4, umatan: { err: "fetch-failed" }, sanrentan: { err: "fetch-failed" } }; // 5 分前の行(#794)
  const ERR5 = { ...ERR4, umatan: { err: "fetch-failed" } }; // 10 分前の行(三連単は取らないので sanrentan のキーが無い。#794)
  it("取れたら、頁ごとに 取った時刻 t・頁の時刻 dt・頁の状態 st・組ごとの値 o を持つ。キーは小さい番号を先にした連結(馬連・枠連・ワイドは 2 桁、3連複は 3 頭の 6 桁)。単勝・複勝の値は変わらない", async () => {
    const h = harness(DUE + 3_000);
    await registerAndRun(h);
    const c = combosOf(h);
    expect(Object.keys(c)).toEqual(["umaren", "wakuren", "wide", "sanrenpuku", "umatan", "sanrentan"]); // 頁の順(小さい頁から。三連単が最後)
    const u = c.umaren as unknown as Page;
    const w = c.wakuren as unknown as Page;
    const wd = c.wide as unknown as Page;
    const t3 = c.sanrenpuku as unknown as Page;
    expect(Object.keys(u.o)).toHaveLength(91);
    expect(Object.keys(w.o)).toHaveLength(34);
    expect(Object.keys(wd.o)).toHaveLength(91);
    expect(Object.keys(t3.o)).toHaveLength(364);
    expect(u).toMatchObject({ t: DUE + 3_000, dt: "2026-11-15 10:37:00", st: "middle" });
    expect(w).toMatchObject({ t: DUE + 3_000, st: "middle" });
    expect(wd).toMatchObject({ t: DUE + 3_000, dt: "2026-11-15 10:37:00", st: "middle" });
    expect(t3).toMatchObject({ t: DUE + 3_000, dt: "2026-11-15 10:37:00", st: "middle" });
    expect(u.o["0102"]).toBe(137.5);
    expect(w.o["0102"]).toBe(73.4);
    expect("0303" in w.o).toBe(true);
    expect("0101" in w.o, "1 頭だけの枠の同枠は JRA の頁が空きなのでキーを作らない").toBe(false);
    expect(t3.o["010203"]).toBe(1058.5);
    expect(Object.keys(t3.o).every((k) => /^\d{6}$/.test(k))).toBe(true);
    expect(h.saved[0]!.horses).toHaveLength(14);
    expect(parseOddsSnapshotPayload(rowOf(h, 5).payload_json!)).toEqual(h.saved[0]); // DO にも持つ
  });
  it("ワイドは値が幅: o の値は [下限, 上限] の配列(下限だけを単一値にしない)。上限は下限以上で、馬連のような単一値の形ではない", async () => {
    const h = harness();
    await registerAndRun(h);
    const wd = combosOf(h).wide as unknown as Page;
    expect(wd.o["0102"]).toEqual([32.6, 35.2]);
    expect(wd.o["0103"]).toEqual([211.5, 213.5]);
    const pairs = Object.values(wd.o) as [number, number][];
    expect(pairs.every((v) => Array.isArray(v) && v.length === 2)).toBe(true);
    expect(pairs.some(([lo, hi]) => hi > lo), "幅が 0 でない組がある(下限と上限を取り違えても通らない)").toBe(true);
    expect(pairs.every(([lo, hi]) => hi >= lo)).toBe(true);
    // 馬連・3連複は単一値のまま
    expect(typeof (combosOf(h).umaren as unknown as Page).o["0102"]).toBe("number");
    expect(typeof (combosOf(h).sanrenpuku as unknown as Page).o["010203"]).toBe("number");
  });
  it("頁ごとの t は、その頁を取って取得キャッシュに置いた実際の時刻(頁ごとに違いうる)", async () => {
    const h = harness(DUE);
    const origFetch = h.jra.open.bind(h.jra);
    h.jra.open = () => {
      const s = origFetch();
      return { ...s, requestCount: 0, listVenues: s.listVenues, listRaces: s.listRaces, fetchOdds: async (cname: string) => { h.clock.now += 1_500; return s.fetchOdds(cname); } } as JraOddsSession;
    };
    await registerAndRun(h);
    const c = combosOf(h) as unknown as Record<string, { t: number }>;
    expect(h.saved[0]!.takenAtMs).toBe(DUE + 1_500);
    expect(c.umaren!.t).toBe(DUE + 3_000);
    expect(c.wakuren!.t).toBe(DUE + 4_500);
    expect(c.wide!.t).toBe(DUE + 6_000);
    expect(c.sanrenpuku!.t).toBe(DUE + 7_500);
    expect(c.umatan!.t).toBe(DUE + 9_000);
    expect(c.sanrentan!.t).toBe(DUE + 10_500);
  });
  it("馬連の頁が失敗しても、単勝・複勝は ok で書き、馬連は {err:fetch-failed}、枠連・ワイド・3連複は取る(組合せの再試行はしない)", async () => {
    const h = harness();
    h.jra.oddsResult = (n) => (n === 2 ? TIMEOUT : null);
    const outcome = await registerAndRun(h);
    expect(outcome).toMatchObject({ result: "ok" });
    expect(h.saved[0]).toMatchObject({ status: "ok", attempts: 1 });
    expect(h.saved[0]!.horses).toHaveLength(14);
    expect(combosOf(h).umaren).toEqual({ err: "fetch-failed" });
    expect("o" in combosOf(h).wakuren!).toBe(true);
    expect("o" in combosOf(h).wide!).toBe(true);
    expect("o" in combosOf(h).sanrenpuku!).toBe(true);
    expect(h.jra.fetchOdds).toHaveLength(7); // 再試行していない
  });
  it("枠連の頁だけが失敗しても同じ(馬連は残る)。頁が読めない(表が無い)ときは err = unavailable", async () => {
    const h = harness();
    h.jra.oddsResult = (n) => (n === 3 ? ({ status: "ok", value: TANPUKU }) : null);
    await registerAndRun(h);
    expect("o" in combosOf(h).umaren!).toBe(true);
    expect(combosOf(h).wakuren).toEqual({ err: "unavailable" });
    expect("o" in combosOf(h).wide!).toBe(true);
    expect("o" in combosOf(h).sanrenpuku!).toBe(true);
    expect(h.saved[0]!.status).toBe("ok");
  });
  it("ワイドの頁が失敗(取得 4 本目)しても、単勝・複勝・馬連・枠連は残り、3連複は取る。ワイドは err", async () => {
    const h = harness();
    h.jra.oddsResult = (n) => (n === 4 ? TIMEOUT : null);
    expect(await registerAndRun(h)).toMatchObject({ result: "ok" });
    expect(h.saved[0]!.horses).toHaveLength(14);
    expect(combosOf(h).wide).toEqual({ err: "fetch-failed" });
    expect("o" in combosOf(h).umaren!).toBe(true);
    expect("o" in combosOf(h).wakuren!).toBe(true);
    expect("o" in combosOf(h).sanrenpuku!).toBe(true);
    expect(h.jra.fetchOdds).toHaveLength(7);
  });
  it("3連複の頁が失敗(5 本目)しても、単勝・複勝・馬連・枠連・ワイドは残る。3連複は err。表が読めなければ unavailable", async () => {
    const h = harness();
    h.jra.oddsResult = (n) => (n === 5 ? TIMEOUT : null);
    expect(await registerAndRun(h)).toMatchObject({ result: "ok" });
    expect(h.saved[0]!.horses).toHaveLength(14);
    expect(combosOf(h).sanrenpuku).toEqual({ err: "fetch-failed" });
    expect("o" in combosOf(h).wide!).toBe(true);
    const h2 = harness();
    h2.jra.oddsResult = (n) => (n === 5 ? { status: "ok", value: TANPUKU } : null);
    await registerAndRun(h2);
    expect(h2.saved[0]!.combos!.sanrenpuku).toEqual({ err: "unavailable" });
    expect("o" in h2.saved[0]!.combos!.wide!).toBe(true);
  });
  it("組合せが 4 つとも取れなくても単勝・複勝は ok。4 つとも {err}。", async () => {
    const h = harness();
    h.jra.oddsResult = (n) => (n >= 2 ? TIMEOUT : null);
    expect(await registerAndRun(h)).toMatchObject({ result: "ok" });
    expect(combosOf(h)).toEqual(ERR6);
  });
  it("古い取得キャッシュの馬連・ワイド・3連複(この起床より前)は、取れなかった記録の代わりに使わない(err になる)", async () => {
    const h = harness(DUE);
    const old = (page: string, key: string) => ({ value: JSON.stringify({ v: 1, page, officialDatetime: null, oddsStatus: "middle", cells: [[key, { oddsMin: 1, oddsMax: 2, ninki: null }]] }), fetchedAt: DUE - 60_000 });
    h.cache.set(jraOddsCacheKey(RACE, "umaren"), old("umaren", "0102"));
    h.cache.set(jraOddsCacheKey(RACE, "wide"), old("wide", "0102"));
    h.cache.set(jraOddsCacheKey(RACE, "sanrenpuku"), old("sanrenpuku", "010203"));
    h.jra.oddsResult = (n) => (n === 2 || n === 4 || n === 5 ? TIMEOUT : null);
    await registerAndRun(h);
    expect(combosOf(h).umaren).toEqual({ err: "fetch-failed" });
    expect(combosOf(h).wide).toEqual({ err: "fetch-failed" });
    expect(combosOf(h).sanrenpuku).toEqual({ err: "fetch-failed" });
  });
  it("単勝・複勝が取れないときは、組合せの頁には出ず(取る頁は単勝・複勝の 1 本だけ)、従来どおり再試行する。failed の行の combos は null", async () => {
    const h = harness(START - 1_000);
    h.jra.oddsResult = () => TIMEOUT;
    await registerAndRun(h);
    expect(h.jra.fetchOdds).toEqual([linksOf(RACE).cnames.tanpuku]);
    expect(h.saved[0]).toMatchObject({ status: "failed", combos: null });
  });
  it("10 分前の行も同じ。発走の 5 分前の時刻で打ち切られるときは、組合せの頁は送らず err を書く(単勝・複勝は書く)", async () => {
    const h = harness(DUE10);
    h.stage.register(RACE, DATE, START);
    let first = true;
    const open = h.jra.open.bind(h.jra);
    h.jra.open = () => {
      const s = open();
      return { ...s, requestCount: 0, listVenues: s.listVenues, listRaces: s.listRaces, fetchOdds: async (c: string) => { const r = await s.fetchOdds(c); if (first) { first = false; h.clock.now = DUE; } return r; } } as JraOddsSession;
    };
    await h.stage.runStep(rowOf(h, 10));
    expect(h.saved[0]).toMatchObject({ leadMin: 10, status: "ok" });
    expect(combosOf(h)).toEqual(ERR5);
    expect(h.jra.fetchOdds).toEqual([linksOf(RACE).cnames.tanpuku]);
  });
});

describe("枠連が発売されないレース(8 頭以下。Issue #817)", () => {
  it("5 分前: 枠連はリンクが無く、JRA に取りに行かない。単勝・複勝と、ほかの組合せは取れて ok。combos の枠連は {err:\"not-sold\"}(キーは残し、fetch-failed とは別の語)", async () => {
    const h = harness(DUE + 3_000);
    h.jra.notSold = ["wakuren"];
    await registerAndRun(h);
    const saved = h.saved[0]!;
    expect(saved.status).toBe("ok");
    expect(saved.horses).toHaveLength(14);
    const c = saved.combos!;
    expect(Object.keys(c)).toEqual(["umaren", "wakuren", "wide", "sanrenpuku", "umatan", "sanrentan"]); // 形は変えない(キーは 6 つのまま)
    expect(c.wakuren).toEqual({ err: "not-sold" });
    for (const k of ["umaren", "wide", "sanrenpuku", "umatan", "sanrentan"] as const) expect("err" in c[k]!, k).toBe(false);
    expect(h.jra.fetchOdds).toHaveLength(6);
    expect(h.jra.fetchOdds.some((x) => x.startsWith(`pw15${DIGIT.wakuren}`))).toBe(false);
    expect(h.warns.join("\n")).not.toMatch(/wakuren/);
    expect(parseOddsSnapshotPayload(rowOf(h, 5).payload_json!)).toEqual(saved); // DO に持った形も読み戻せる
  });

  it("10 分前も同じ(枠連 not-sold・頁 5 本)", async () => {
    const h = harness(DUE10 + 3_000);
    h.jra.notSold = ["wakuren"];
    await registerAndRun(h);
    expect(h.saved[0]!.status).toBe("ok");
    expect(h.saved[0]!.combos!.wakuren).toEqual({ err: "not-sold" });
    expect(h.jra.fetchOdds).toHaveLength(5);
  });

  it("単複が無いレース(リンクに tanpuku が無い)は今までどおり取れず failed(fetch-failed)", async () => {
    const h = harness(DUE + 3_000);
    h.jra.notSold = ["tanpuku"];
    await registerAndRun(h);
    expect(h.saved).toHaveLength(0);
    expect(rowOf(h, 5).state).toBe("pending"); // 再試行待ち
  });
});

describe("馬単・三連単の全組の記録(#794)", () => {
  const combosOf = (h: Harness) => h.saved[0]!.combos!;
  type Page = { t: number; dt: string | null; st: string | null; o: Record<string, number | null> };
  const TIMEOUT = { status: "timeout" } as unknown as JraOddsResult<string>;
  it("5 分前: 馬単は 182 組、三連単は 2184 組。キーは順序つき(1 着・2 着〔・3 着〕の順の 2 桁連結。小さい番号を先にしない)で、票数なしは null のまま残す", async () => {
    const h = harness(DUE);
    await registerAndRun(h);
    const um = combosOf(h).umatan as unknown as Page;
    const st = combosOf(h).sanrentan as unknown as Page;
    expect(Object.keys(um.o)).toHaveLength(182);
    expect(Object.keys(st.o)).toHaveLength(2184);
    expect(um).toMatchObject({ dt: "2026-11-15 10:37:00", st: "middle" });
    expect(st).toMatchObject({ dt: "2026-11-15 10:37:00", st: "middle" });
    expect(um.o["0102"], "1 着 01・2 着 02").toBe(485.1);
    expect(um.o["0201"], "1 着 02・2 着 01(0102 とは別の組)").toBe(246.2);
    expect(um.o["0101"], "自分自身との組は空き(キーを作らない)").toBeUndefined();
    expect(st.o["010203"]).toBe(2949);
    expect(st.o["030201"], "1 着 03・2 着 02・3 着 01(010203 とは別の組)").toBe(9215.8);
    expect(Object.keys(st.o).every((k) => /^\d{6}$/.test(k))).toBe(true);
    expect(Object.values(st.o).filter((v) => v === null), "票数なし(発売中の見本の 83 組)").toHaveLength(83);
    expect(st.o["100809"]).toBeNull();
    expect(Object.values(um.o).every((v) => typeof v === "number")).toBe(true);
    expect(parseOddsSnapshotPayload(rowOf(h, 5).payload_json!)).toEqual(h.saved[0]); // DO にも持つ(検査を通る)
  });
  it("10 分前: 馬単は取るが三連単は取らない(頁 6 本。sanrentan のキーが無い。三連単の頁の cname に出ない)", async () => {
    const h = harness(DUE10);
    h.stage.register(RACE, DATE, START);
    const row = h.store.nextDue(h.clock.now)!;
    expect(row.lead_min).toBe(10);
    await h.stage.runStep(row);
    expect(h.jra.fetchOdds).toEqual([
      linksOf(RACE).cnames.tanpuku, linksOf(RACE).cnames.umaren, linksOf(RACE).cnames.wakuren, linksOf(RACE).cnames.wide, linksOf(RACE).cnames.sanrenpuku, linksOf(RACE).cnames.umatan,
    ]);
    expect(Object.keys(combosOf(h))).toEqual(["umaren", "wakuren", "wide", "sanrenpuku", "umatan"]);
    expect(Object.keys((combosOf(h).umatan as unknown as Page).o)).toHaveLength(182);
    expect(parseOddsSnapshotPayload(rowOf(h, 10).payload_json!)).toEqual(h.saved[0]);
  });
  it("三連単の頁(7 本目)が失敗しても、単勝・複勝と、馬連・枠連・ワイド・3連複・馬単は残る。三連単だけ err。読めなければ unavailable", async () => {
    const h = harness();
    h.jra.oddsResult = (n) => (n === 7 ? TIMEOUT : null);
    expect(await registerAndRun(h)).toMatchObject({ result: "ok" });
    expect(h.saved[0]!.horses).toHaveLength(14);
    expect(combosOf(h).sanrentan).toEqual({ err: "fetch-failed" });
    for (const k of ["umaren", "wakuren", "wide", "sanrenpuku", "umatan"] as const) expect("o" in combosOf(h)[k]!, k).toBe(true);
    expect(h.jra.fetchOdds, "再試行していない").toHaveLength(7);
    const h2 = harness();
    h2.jra.oddsResult = (n) => (n === 7 ? { status: "ok", value: TANPUKU } : null);
    await registerAndRun(h2);
    expect(h2.saved[0]!.combos!.sanrentan).toEqual({ err: "unavailable" });
    expect("o" in h2.saved[0]!.combos!.umatan!).toBe(true);
  });
  it("馬単の頁(6 本目)が失敗しても、三連単は取る。馬単だけ err", async () => {
    const h = harness();
    h.jra.oddsResult = (n) => (n === 6 ? TIMEOUT : null);
    expect(await registerAndRun(h)).toMatchObject({ result: "ok" });
    expect(combosOf(h).umatan).toEqual({ err: "fetch-failed" });
    expect("o" in combosOf(h).sanrentan!).toBe(true);
    expect("o" in combosOf(h).sanrenpuku!).toBe(true);
  });
  it("古い取得キャッシュの馬単・三連単(この起床より前)は、取れなかった記録の代わりに使わない(err になる)", async () => {
    const h = harness(DUE);
    const old = (page: string, key: string) => ({ value: JSON.stringify({ v: 1, page, officialDatetime: null, oddsStatus: "middle", cells: [[key, { oddsMin: 1, oddsMax: null, ninki: null }]] }), fetchedAt: DUE - 60_000 });
    h.cache.set(jraOddsCacheKey(RACE, "umatan"), old("umatan", "0102"));
    h.cache.set(jraOddsCacheKey(RACE, "sanrentan"), old("sanrentan", "010203"));
    h.jra.oddsResult = (n) => (n === 6 || n === 7 ? TIMEOUT : null);
    await registerAndRun(h);
    expect(combosOf(h).umatan).toEqual({ err: "fetch-failed" });
    expect(combosOf(h).sanrentan).toEqual({ err: "fetch-failed" });
  });
  it("前日の夜(-1)・当日の朝(-2)は馬単・三連単を取らない(単勝・複勝 1 本のまま)", async () => {
    const h = harness(Date.parse("2026-11-14T21:05:00+09:00"));
    h.stage.register(RACE, DATE, START);
    await h.stage.runStep(rowOf(h, -1));
    expect(h.jra.fetchOdds).toEqual([linksOf(RACE).cnames.tanpuku]);
    expect(h.saved[0]!.combos).toBeNull();
  });
});

describe("保存後のフック(別の Worker への依頼。Issue #796)", () => {
  it("5 分前・10 分前が ok で保存できたあと、markDone の後に 1 回だけ呼ぶ(呼ばれた時点で行は done)", async () => {
    const h = harness();
    await registerAndRun(h); // 5 分前
    expect(h.hookCalls).toEqual([{ raceId: RACE, leadMin: 5, stateAtCall: "done" }]);
    h.clock.now = DUE - 5 * 60_000; // 10 分前の時刻
    const early = h.store.nextDue(h.clock.now);
    expect(early?.lead_min, "前提: 10 分前の行が出る").toBe(10);
    await h.stage.runStep(early!);
    expect(h.hookCalls.map((c) => c.leadMin)).toEqual([5, 10]);
    expect(h.hookCalls[1]!.stateAtCall).toBe("done");
  });

  it("サブリクエストの数(5 分前の 1 回のアラーム): JRA の頁 + D1 の保存 1 + 依頼 1 の合計は 50 未満(開催選択・レース選択の 2 本を足しても)", async () => {
    const h = harness();
    await registerAndRun(h);
    const total = h.jra.fetchOdds.length + h.saved.length + h.hookCalls.length;
    expect(h.hookCalls).toHaveLength(1);
    expect(total + 2).toBeLessThan(50);
    console.log(`#796 オッズのアラーム(5 分前): JRA の頁 ${h.jra.fetchOdds.length}(+リンクが無い最初のレースだけ 2)・D1 の保存 ${h.saved.length}・MODEL ${h.hookCalls.length}・合計 ${total}(リンク込み ${total + 2})`);
  });

  it("前日の夜(-1)・当日の朝(-2)では呼ばない", async () => {
    for (const [at, lead] of [[Date.parse("2026-11-14T21:10:00+09:00"), -1], [Date.parse("2026-11-15T09:31:00+09:00"), -2]] as const) {
      const h = harness(at);
      h.stage.register(RACE, DATE, START);
      const row = h.store.nextDue(at);
      expect(row, "前提: その時点の行が出る").toMatchObject({ lead_min: lead });
      await h.stage.runStep(row!);
      expect(h.saved).toHaveLength(1);
      expect(h.saved[0]).toMatchObject({ leadMin: lead, status: "ok" });
      expect(h.hookCalls).toEqual([]);
      sql?.close();
      sql = null;
    }
  });

  it("取らなかった(skipped)記録では呼ばない(オッズが無い)", async () => {
    const h = harness();
    h.stage.register(RACE, DATE, START);
    h.clock.now = START + 1; // 発走を過ぎてから動いた = どちらの行も too-late
    for (let i = 0; i < 2; i++) {
      const row = h.store.nextDue(h.clock.now);
      expect(row, "前提: 行が残っている").not.toBeNull();
      await h.stage.runStep(row!);
    }
    expect(h.saved.map((p) => [p.leadMin, p.status, p.reason]).sort()).toEqual([[10, "skipped", "too-late"], [5, "skipped", "too-late"]]);
    expect(h.hookCalls).toEqual([]);
  });

  it("保存に失敗したときは呼ばない(再試行のあとの成功で 1 回だけ)", async () => {
    const h = harness();
    h.saveFailures = 1;
    const first = await registerAndRun(h);
    expect(first.result).toBe("retry");
    expect(h.hookCalls).toEqual([]);
    h.clock.now += ODDS_SNAPSHOT_SAVE_RETRY_DELAY_MS;
    await h.stage.runStep(h.store.nextDue(h.clock.now)!);
    expect(h.hookCalls).toHaveLength(1);
  });

  it("フックが投げても、結果(ok)・行の状態(done)・警告は変わらない(再試行も起きない)", async () => {
    const h = harness();
    h.hookThrows = true;
    const outcome = await registerAndRun(h);
    expect(outcome).toMatchObject({ result: "ok", reason: null });
    expect(rowOf(h, 5).state).toBe("done");
    expect(h.saved).toHaveLength(1);
    expect(h.hookCalls).toHaveLength(1);
  });
});


describe("Issue #804: 失敗の行の詳細(fail_detail の元。payload.failDetail)", () => {
  const detailOf = (h: Harness): string | null | undefined => h.saved[0]!.failDetail;
  const failing = (info: { kind: string; http: number | null }, status = "network"): JraOddsResult<string> => ({ status, failInfo: info } as unknown as JraOddsResult<string>);

  it("単勝・複勝の頁が HTTP 403(配信の防御の形)で failed: 頁・種類・HTTP の状態・拠点を JSON で残す。status・reason は変えない", async () => {
    const h = harness(START - 1_000);
    h.colo = "NRT";
    h.jra.oddsResult = () => failing({ kind: "blocked", http: 403 }, "http-403");
    await registerAndRun(h);
    expect(h.saved[0]).toMatchObject({ status: "failed", reason: "fetch-failed" });
    expect(detailOf(h)).toBe('{"p":"tanpuku","k":"blocked","h":403,"c":"NRT"}');
  });
  it("拠点が取れていない(null)ときは c を出さない。応答が来ない失敗は h も出さない", async () => {
    const h = harness(START - 1_000);
    h.jra.oddsResult = () => failing({ kind: "dns", http: null });
    await registerAndRun(h);
    expect(detailOf(h)).toBe('{"p":"tanpuku","k":"dns"}');
  });
  it("試行を重ねたときは最後の試行の詳細(4 回目)。1〜3 回目の詳細は残さない", async () => {
    const h = harness();
    const kinds = ["timeout", "reset", "dns", "blocked"];
    h.jra.oddsResult = (n) => failing({ kind: kinds[n - 1]!, http: n === 4 ? 403 : null }, n === 4 ? "http-403" : "network");
    h.stage.register(RACE, DATE, START);
    for (let n = 1; n <= 3; n += 1) {
      await h.stage.runStep(rowOf(h, 5));
      h.clock.now += ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS;
    }
    await h.stage.runStep(rowOf(h, 5));
    expect(detailOf(h)).toBe('{"p":"tanpuku","k":"blocked","h":403}');
  });
  it("開催選択の失敗(場・レースのリンクが無い最初のレース)も詳細が届く。頁の語は discover", async () => {
    const h = harness(START - 1_000);
    h.jra.venuesResult = () => ({ status: "network", failInfo: { kind: "reset", http: null } });
    await registerAndRun(h);
    expect(h.saved[0]).toMatchObject({ status: "failed", reason: "fetch-failed" });
    expect(detailOf(h)).toBe('{"p":"discover","k":"reset"}');
    expect(h.jra.fetchOdds).toEqual([]); // 前提: 頁は 1 本も送っていない
  });
  it("詳細の無い失敗(頁が読めない)は種類 unknown。HTTP の状態は出さない", async () => {
    const h = harness(START - 1_000);
    h.jra.oddsResult = () => ({ status: "ok", value: "<html><title>x</title></html>" });
    await registerAndRun(h);
    expect(detailOf(h)).toBe('{"p":"tanpuku","k":"unknown"}');
  });
  it("取得口が例外を投げた(段が握る)ときは unknown。例外の文面は入らない", async () => {
    const h = harness(START - 1_000);
    h.jra.throwOnOpen = true;
    await registerAndRun(h);
    expect(detailOf(h)).toBe('{"p":"tanpuku","k":"unknown"}');
    expect(JSON.stringify(h.saved[0])).not.toMatch(/secret|example\.invalid|cname/);
  });
  it("取れた(ok)行と、取らなかった(skipped・too-late)行には詳細を付けない", async () => {
    const ok = harness();
    await registerAndRun(ok);
    expect(ok.saved[0]!.status).toBe("ok");
    expect(detailOf(ok)).toBeUndefined();
    const five = Date.parse("2026-11-15T05:00:00+09:00");
    const late = harness(five);
    late.store.register({ raceId: RACE, kaisaiDate: DATE, startMs: START, now: Date.parse("2026-11-14T21:10:00+09:00") });
    await late.stage.runStep(rowOf(late, -1));
    expect(late.saved).toHaveLength(1);
    expect(late.saved[0]).toMatchObject({ status: "skipped", reason: "too-late" });
    expect(late.saved[0]!.failDetail).toBeUndefined();
  });
  it("単勝・複勝が取れて組合せの頁だけ失敗しても、ok の行に詳細は付かない(組合せの失敗は combos の {err} に残る)", async () => {
    const h = harness();
    h.jra.oddsResult = (n) => (n >= 2 ? failing({ kind: "blocked", http: 403 }, "http-403") : null);
    await registerAndRun(h);
    expect(h.saved[0]).toMatchObject({ status: "ok" });
    expect(detailOf(h)).toBeUndefined();
  });
  it("D1 に保存する形(DO の payload_json)にも詳細が残り、読み戻せる", async () => {
    const h = harness(START - 1_000);
    h.jra.oddsResult = () => failing({ kind: "timeout", http: null }, "timeout");
    await registerAndRun(h);
    expect(parseOddsSnapshotPayload(rowOf(h, 5).payload_json!)?.failDetail).toBe('{"p":"tanpuku","k":"timeout"}');
  });
});
