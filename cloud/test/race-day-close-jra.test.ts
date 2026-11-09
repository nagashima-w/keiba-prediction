import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { JraOddsPage, JraOddsRaceLinks, JraOddsVenueLink } from "../../packages/core/src/scraper/parse-jra-odds-index";
import { CLOSE_FINAL_LEAD_MS, CLOSE_FIRST_LEAD_MS, type CloseSavePayload } from "../src/analysis-close";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { JraOddsFetcher, JraOddsResult, JraOddsSession } from "../src/jra-odds-fetch";
import { jraOddsCacheKey } from "../src/jra-odds-cache";
import { CLOSE_FETCH_RETRY_DELAY_MS } from "../src/race-day-close";
import { CLOSE_JRA_STOP_BEFORE_MS } from "../src/race-day-close-stage";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps, type StepOutcome } from "../src/race-day-core";
import { JRA_TIMEOUT_MS } from "../src/jra-http";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { newspaperOnlyPostRaw } from "./newspaper-post";
import { openNodeSql, type NodeSql } from "./node-sql";
import { fixtureForUrl } from "./pipeline-fixtures";

// Issue #680: 差し込みの例外を DO の単位で起こすため、JRA のオッズの差し込みの作成だけ、フラグが立っているときに例外を投げるものに差し替える(ほかは本物)。
const overrideFault = vi.hoisted(() => ({ throwMessage: null as string | null }));
vi.mock("../src/jra-odds-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/jra-odds-cache")>();
  return {
    ...actual,
    createJraOddsOverride: (deps: Parameters<typeof actual.createJraOddsOverride>[0]) => {
      const real = actual.createJraOddsOverride(deps);
      return {
        ...real,
        winPlace: async () => {
          if (overrideFault.throwMessage !== null) throw new Error(overrideFault.throwMessage);
          return real.winPlace!();
        },
      };
    },
  };
});

/**
 * Issue #676(#668-E): 締切の直前の再計算(発走 5 分前・2 分前)が、中央のオッズを JRA の公式サイトから取る。
 * 偽の JRA の取得口(実際の JRA には出ない)・偽のゲート・`node:sqlite`。中央 16 頭の 202603020211(開催日 2026-06-28、発走 15:45 JST)。
 * 単勝複勝の頁は、見本(東京 8R・14 頭)の最後の馬の行を複製して 16 頭にしたもの。組合せの頁は 14 頭の見本のまま(= 16 頭の出走馬と食い違うので、netkeiba に戻る)。
 * 発走前の分析も JRA の取得口で行う(分析時の JSON が取得キャッシュに残る=再計算が古い JSON を誤って使わないかを確かめる前提)。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jraHtml = (name: string): string => new TextDecoder("shift_jis").decode(new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name))));
const RACE = "202603020211";
const OTHER_RACE = "202603020210";
const DATE = "20260628";
const START_MS = Date.parse("2026-06-28T06:45:00Z");
const DUE1 = START_MS - CLOSE_FIRST_LEAD_MS;
const DUE2 = START_MS - CLOSE_FINAL_LEAD_MS;
const JRA_TANPUKU_TIME = "2026-06-28 10:37:00"; // 見本の単勝複勝の頁の時刻
const encoder = new TextEncoder();

function tanpuku16(): string {
  const html = jraHtml("jra_odds_tanpuku_202605050208.html");
  const start = html.lastIndexOf("<tr>", html.indexOf('<td class="num">14</td>'));
  const end = html.indexOf("</tr>", start) + "</tr>".length;
  const row = html.slice(start, end);
  expect(row).toContain('<td class="num">14</td>'); // 前提: 14 番の行を切り出せている
  const clone = (n: number): string => row.replace('<td class="num">14</td>', `<td class="num">${n}</td>`);
  return html.slice(0, end) + clone(15) + clone(16) + html.slice(end);
}
const PAGE_HTML: Record<string, () => string> = {
  tanpuku: tanpuku16,
  wakuren: () => jraHtml("jra_odds_wakuren_202605050208.html"),
  umaren: () => jraHtml("jra_odds_umaren_202605050208.html"),
  wide: () => jraHtml("jra_odds_wide_202605050208.html"),
  umatan: () => jraHtml("jra_odds_umatan_202605050208.html"),
  sanrenpuku: () => jraHtml("jra_odds_sanrenpuku_202605050208.html"),
  sanrentan: () => jraHtml("jra_odds_sanrentan_202605050208.html"),
};
const DIGIT: Record<string, string> = { tanpuku: "1", wakuren: "3", umaren: "4", wide: "5", umatan: "6", sanrenpuku: "7", sanrentan: "8" };
const PAGES = Object.keys(DIGIT) as JraOddsPage[];
/** 頁 → 券種(oddsSources のキー)。 */
const BET_OF_PAGE: Record<string, string> = { wakuren: "bracketQuinella", umaren: "quinella", wide: "wide", umatan: "exacta", sanrenpuku: "trio", sanrentan: "trifecta" };

const cnameOf = (raceId: string, page: string): string => `pw15${DIGIT[page]}ouS3${raceId.slice(4, 6)}${raceId.slice(0, 4)}${raceId.slice(6, 8)}${raceId.slice(8, 10)}${raceId.slice(10, 12)}${DATE}Z/AA`;
const linksOf = (raceId: string): JraOddsRaceLinks => ({
  raceId,
  race: raceId.slice(10, 12),
  cnames: Object.fromEntries(PAGES.map((p) => [p, cnameOf(raceId, p)])) as unknown as JraOddsRaceLinks["cnames"],
});
const VENUE: JraOddsVenueLink = { venueCode: "03", year: "2026", kai: "02", day: "02", date: DATE, racesCname: `pw15orl000320260202${DATE}/AA` };

interface FakeJra extends JraOddsFetcher {
  readonly sessions: { listVenues: number; listRaces: number; fetchOdds: string[] }[];
  listVenuesResult: () => JraOddsResult<readonly JraOddsVenueLink[]>;
  /** 頁 → その呼び出し回での結果の上書き。null なら見本の頁。 */
  oddsOverride: (page: string, nth: number) => JraOddsResult<string> | null;
  throwOnOpen: boolean;
  /** 1 本送るごとに進める時計(ミリ秒。JRA への間隔と往復の想定)。 */
  advanceMsPerRequest: number;
  /** 動きの列(同時に 2 本以上が出ていないか・取る → 次の順を見る)。 */
  readonly events: string[];
  inFlight: number;
  maxInFlight: number;
}

function fakeJra(clock: { now: number }): FakeJra {
  const seen: Record<string, number> = {};
  const jra: FakeJra = {
    sessions: [],
    listVenuesResult: () => ({ status: "ok", value: [VENUE] }),
    oddsOverride: () => null,
    throwOnOpen: false,
    advanceMsPerRequest: 0,
    events: [],
    inFlight: 0,
    maxInFlight: 0,
    open(): JraOddsSession {
      if (jra.throwOnOpen) throw new Error("secret-url https://example.invalid/x?cname=ABC");
      const record = { listVenues: 0, listRaces: 0, fetchOdds: [] as string[] };
      jra.sessions.push(record);
      let sent = 0;
      const enter = async <T>(label: string, body: () => T): Promise<T> => {
        jra.inFlight += 1;
        jra.maxInFlight = Math.max(jra.maxInFlight, jra.inFlight);
        jra.events.push(label);
        await Promise.resolve();
        clock.now += jra.advanceMsPerRequest;
        const value = body();
        jra.inFlight -= 1;
        return value;
      };
      return {
        get requestCount() {
          return sent;
        },
        listVenues() {
          sent += 1;
          return enter("listVenues", () => {
            record.listVenues += 1;
            return jra.listVenuesResult();
          });
        },
        listRaces() {
          sent += 1;
          return enter("listRaces", () => {
            record.listRaces += 1;
            return { status: "ok", value: [linksOf(OTHER_RACE), linksOf(RACE)] } as JraOddsResult<readonly JraOddsRaceLinks[]>;
          });
        },
        fetchOdds(cname) {
          sent += 1;
          const page = PAGES.find((p) => cname.startsWith(`pw15${DIGIT[p]}`))!;
          return enter(`fetch:${page}`, () => {
            record.fetchOdds.push(page);
            seen[page] = (seen[page] ?? 0) + 1;
            return jra.oddsOverride(page, seen[page]!) ?? { status: "ok", value: PAGE_HTML[page]!() };
          });
        },
      };
    },
  };
  return jra;
}

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}
interface FakeGate extends GateLike {
  readonly urls: string[];
  body: (url: string) => string | null;
}
function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    body: (url) => fixtureForUrl(url),
    postRaw: newspaperOnlyPostRaw,
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
  readonly closes: { readonly analysisId: number; readonly payload: CloseSavePayload }[];
}
function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    closes: [],
    async save(record) {
      sink.saved.push(record);
      return { id: sink.saved.length, detail: "stored" };
    },
    async findByAnalyzedAt(raceId, analyzedAt) {
      const i = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return i < 0 ? null : i + 1;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
    async saveClose(analysisId, payload) {
      sink.closes.push({ analysisId, payload });
    },
  };
  return sink;
}

const BASE: CloudSettings = {
  ...DEFAULT_CLOUD_SETTINGS,
  bankroll: 1_000_000,
  perRaceCap: 100_000,
  kellyFraction: 0.5,
  minHitProb: 0,
  maxWinBetsPerRace: 0,
  maxPlaceBetsPerRace: 0,
  marketShrinkWeight: 1,
  baseScoreWeightJockey: 0,
  baseScoreWeightTrainer: 0,
  includeComboOdds: false,
};
const COMBO_ON: CloudSettings = { ...BASE, includeComboOdds: true };

interface Harness {
  readonly core: RaceDayCore;
  readonly sql: NodeSql;
  readonly gate: FakeGate;
  readonly sink: FakeSink;
  readonly jra: FakeJra;
  readonly clock: { now: number };
  readonly warnings: string[];
  readonly infos: string[];
  settings: CloudSettings;
}
const opened: NodeSql[] = [];
afterEach(() => {
  overrideFault.throwMessage = null;
  for (const sql of opened.splice(0)) sql.close();
});
function harness(opts: { withJra?: boolean; settings?: CloudSettings } = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-28T00:00:00Z") };
  const warnings: string[] = [];
  const infos: string[] = [];
  const gate = fakeGate();
  const sink = fakeSink();
  const jra = fakeJra(clock);
  const h = { sql, gate, sink, jra, clock, warnings, infos, settings: opts.settings ?? BASE } as Harness;
  const deps: RaceDayDeps = {
    sql,
    now: () => clock.now,
    gate,
    setAlarm: () => {},
    onWarn: (m) => warnings.push(m),
    onInfo: (m) => infos.push(m),
    sink,
    loadSettings: async () => h.settings,
    ...(opts.withJra === false ? {} : { fetchJraOdds: jra }),
  };
  (h as { core: RaceDayCore }).core = new RaceDayCore(deps);
  return h;
}

/** 発走前の分析(手動の予約)を、計算の完了まで回す。 */
async function analyze(h: Harness): Promise<void> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
  for (let i = 0; i < 8; i++) {
    const outcome = await h.core.runNextStep();
    if (outcome.kind === "ran" && outcome.mode === "pre_race" && outcome.step === "compute") {
      expect(outcome.result).toBe("ok");
      return;
    }
  }
  throw new Error("分析が終わらない");
}

type CloseOutcome = Extract<StepOutcome, { mode: "close" }>;
async function fire(h: Harness, at: number): Promise<CloseOutcome> {
  h.clock.now = at;
  const outcome = await h.core.runNextStep();
  expect(outcome).toMatchObject({ kind: "ran", mode: "close", step: "recompute" });
  return outcome as CloseOutcome;
}

const closeRows = (h: Harness): { round: number; state: string; fired_at: number | null; payload_json: string | null }[] =>
  h.sql.exec("SELECT round, state, fired_at, payload_json FROM race_day_close ORDER BY round").toArray() as { round: number; state: string; fired_at: number | null; payload_json: string | null }[];
const oddsGateUrls = (urls: string[]): string[] => urls.filter((u) => /api_get_jra_odds|\/odds\//.test(u));
const jraFetches = (jra: FakeJra, from: number): string[] => jra.sessions.slice(from).flatMap((s) => s.fetchOdds);
const jraRequests = (jra: FakeJra, from: number): number => jra.sessions.slice(from).reduce((n, s) => n + s.listVenues + s.listRaces + s.fetchOdds.length, 0);
const cacheFetchedAt = (h: Harness, key: string): number | undefined => (h.sql.exec("SELECT fetched_at FROM fetch_cache WHERE key = ?", key).toArray() as { fetched_at: number }[])[0]?.fetched_at;

describe("締切の再計算 × JRA のオッズ: 単勝複勝(組合せ OFF)", () => {
  it("回 1: 単勝複勝を JRA から取って採用する。netkeiba のオッズ(gate)には 1 本も出ない・頁の時刻が odds_official_datetime に入る・取得元が payload に残る(DO にも永続化される)", async () => {
    const h = harness();
    await analyze(h);
    // 前提: 分析時の JSON が残っている(古い JSON が居る状況で、再計算が新しい頁を使うことを確かめる)
    const analysisJsonAt = cacheFetchedAt(h, jraOddsCacheKey(RACE, "tanpuku"));
    expect(analysisJsonAt).toBeDefined();
    expect(analysisJsonAt!).toBeLessThan(DUE1);
    const sessionsBefore = h.jra.sessions.length;
    const gateBefore = h.gate.urls.length;
    const outcome = await fire(h, DUE1);
    expect(outcome).toMatchObject({ round: 1, result: "ok", reason: null });
    expect(jraFetches(h.jra, sessionsBefore)).toEqual(["tanpuku"]);
    expect(jraRequests(h.jra, sessionsBefore)).toBe(1); // リンクは分析の段がキャッシュに置いたので、発見の 2 本は省ける
    expect(oddsGateUrls(h.gate.urls.slice(gateBefore))).toEqual([]);
    const payload = h.sink.closes[0]!.payload;
    expect(payload.oddsOfficialDatetime).toBe(JRA_TANPUKU_TIME);
    expect(payload.oddsSources).toEqual({ winPlace: { source: "jra", officialDatetime: JRA_TANPUKU_TIME } });
    // 新しい頁の JSON が置かれた(取得時刻 = 回の起動時刻)。分析時の JSON ではない
    expect(cacheFetchedAt(h, jraOddsCacheKey(RACE, "tanpuku"))).toBe(DUE1);
    // 保存の再試行・再実行に備えて、取得元は DO の結果(payload_json)にも入っている
    const stored = JSON.parse(closeRows(h)[0]!.payload_json!) as CloseSavePayload;
    expect(stored.oddsSources).toEqual(payload.oddsSources);
  });

  it("回 2 は回 1 の JSON を使わず、自分の頁を取る(取得時刻が回 2 の起動時刻になる)。回 2 の取得が失敗したら、回 1 で置いた JSON が居ても netkeiba に戻る", async () => {
    const h = harness();
    await analyze(h);
    const s0 = h.jra.sessions.length;
    await fire(h, DUE1);
    expect(cacheFetchedAt(h, jraOddsCacheKey(RACE, "tanpuku"))).toBe(DUE1);
    const s1 = h.jra.sessions.length;
    await fire(h, DUE2);
    expect(jraFetches(h.jra, s0)).toEqual(["tanpuku", "tanpuku"]); // 回ごとに 1 本ずつ
    expect(jraFetches(h.jra, s1)).toEqual(["tanpuku"]);
    expect(cacheFetchedAt(h, jraOddsCacheKey(RACE, "tanpuku"))).toBe(DUE2);
    expect(h.sink.closes.map((c) => c.payload.oddsSources?.winPlace?.source)).toEqual(["jra", "jra"]);

    // 回 2 の取得が失敗する別の実行
    const g = harness();
    await analyze(g);
    await fire(g, DUE1);
    expect(cacheFetchedAt(g, jraOddsCacheKey(RACE, "tanpuku"))).toBe(DUE1); // 前提: 回 1 の JSON が居る(回 2 の起動時刻より古い)
    g.jra.oddsOverride = (page) => (page === "tanpuku" ? { status: "http-500" } : null);
    const gateBefore = g.gate.urls.length;
    expect(await fire(g, DUE2)).toMatchObject({ round: 2, result: "ok" });
    expect(oddsGateUrls(g.gate.urls.slice(gateBefore)).length).toBeGreaterThan(0); // netkeiba から取り直した
    const p2 = g.sink.closes[1]!.payload;
    expect(p2.oddsSources?.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-unavailable" });
    expect(p2.oddsOfficialDatetime).not.toBe(JRA_TANPUKU_TIME); // netkeiba のオッズの時刻
  });

  it("分析時の JSON(取得時刻が回の起動より前)は、JRA が全滅したとき使わない。netkeiba に戻り、配分は JRA を使わない構成と同じ", async () => {
    // JRA 取得口なしの構成(従来)
    const plain = harness({ withJra: false });
    await analyze(plain);
    await fire(plain, DUE1);
    // 取得口はあるが、開催選択が常に失敗する構成(分析も再計算も全滅)
    const h = harness();
    h.jra.listVenuesResult = () => ({ status: "network" });
    // 前提を作るため、分析時の JSON を置いておく(本物の頁をパースしたもの。取得時刻は回の起動より前)
    const { parseJraOddsPage } = await import("../src/jra-odds-cache");
    const parsed = parseJraOddsPage("tanpuku", tanpuku16(), "2026-06-28");
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    h.sql.exec("INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ?, ?)", jraOddsCacheKey(RACE, "tanpuku"), parsed.json, DUE1 - 60_000);
    await analyze(h);
    await fire(h, DUE1);
    expect(h.sink.closes[0]!.payload.oddsSources?.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-unavailable" });
    expect(h.sink.closes[0]!.payload.allocation).toEqual(plain.sink.closes[0]!.payload.allocation);
    expect(h.sink.closes[0]!.payload.oddsOfficialDatetime).toBe(plain.sink.closes[0]!.payload.oddsOfficialDatetime);
  });

  it("取得口を渡さない構成(JRA 無効)は従来と同じ: JRA に出ず、payload に oddsSources のキーが付かない", async () => {
    const h = harness({ withJra: false });
    await analyze(h);
    const outcome = await fire(h, DUE1);
    expect(outcome).toMatchObject({ round: 1, result: "ok" });
    expect(h.jra.sessions).toHaveLength(0);
    const payload = h.sink.closes[0]!.payload;
    expect("oddsSources" in payload).toBe(false);
    expect(oddsGateUrls(h.gate.urls).length).toBeGreaterThan(0);
  });

  it("取得口が例外を投げても握る: 再計算は netkeiba で完了し、警告に URL・cname を出さない", async () => {
    const h = harness();
    await analyze(h);
    h.jra.throwOnOpen = true;
    const outcome = await fire(h, DUE1);
    expect(outcome).toMatchObject({ round: 1, result: "ok" });
    expect(h.sink.closes[0]!.payload.oddsSources?.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-unavailable" });
    expect(h.warnings.join("\n")).not.toMatch(/example\.invalid|secret-url|cname=ABC/);
  });
});

describe("締切の再計算 × JRA のオッズ: 差し込みの例外の中身(Issue #680)", () => {
  it("再計算で差し込みが例外を投げても、理由は override-error のまま。例外の名前と文面はログにだけ残り、保存される payload には入らない", async () => {
    const h = harness();
    await analyze(h);
    overrideFault.throwMessage = "SECRETMSG https://example.invalid/x?cname=ABC";
    const outcome = await fire(h, DUE1);
    expect(outcome).toMatchObject({ round: 1, result: "ok" });
    expect(h.sink.closes[0]!.payload.oddsSources?.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-error" });
    const logged = h.warnings.filter((w) => w.includes("JRA のオッズを使えませんでした"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`${RACE}・winPlace`);
    expect(logged[0]).toContain("Error: SECRETMSG");
    expect(JSON.stringify(h.sink.closes)).not.toContain("SECRETMSG");
  });
});

describe("締切の再計算 × JRA のオッズ: 組合せ ON(7 頁を同じ起床で順に取る)", () => {
  it("単勝複勝 → 5 式別 → 三連単の順で 1 本ずつ取る(同時に 2 本出ない)。取る → 次の頁の順で、頁ごとに JSON を置いてから次へ進む。組合せは出走馬と食い違うので netkeiba に戻り、理由が残る", async () => {
    const h = harness({ settings: COMBO_ON });
    await analyze(h);
    const s0 = h.jra.sessions.length;
    h.jra.events.length = 0;
    h.jra.maxInFlight = 0;
    const outcome = await fire(h, DUE1);
    expect(outcome).toMatchObject({ round: 1, result: "ok" });
    expect(jraFetches(h.jra, s0)).toEqual(["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"]);
    expect(h.jra.maxInFlight).toBe(1);
    expect(h.jra.events.filter((e) => e.startsWith("fetch:")).length).toBe(7);
    const sources = h.sink.closes[0]!.payload.oddsSources!;
    expect(sources.winPlace?.source).toBe("jra");
    for (const bet of ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const) {
      expect(sources[bet], bet).toMatchObject({ source: "netkeiba", fallbackReason: "horse-set-mismatch" });
    }
    // 7 頁すべての JSON がこの回の時刻で置かれた
    for (const page of PAGES) {
      expect(cacheFetchedAt(h, jraOddsCacheKey(RACE, page)), page).toBe(DUE1);
    }
  });

  it("1 回の再計算の起床で出る本数の実数(リンクが居る場合・居ない場合)。JRA + netkeiba(gate) + D1 の保存 1 回 が Free のサブリクエスト 50 に収まる", async () => {
    const h = harness({ settings: COMBO_ON });
    await analyze(h);
    const s0 = h.jra.sessions.length;
    const g0 = h.gate.urls.length;
    await fire(h, DUE1);
    const jraN = jraRequests(h.jra, s0);
    const gateN = h.gate.urls.length - g0;
    expect(jraN).toBe(7); // リンクはキャッシュにある: 頁 7 本
    expect(gateN).toBeGreaterThan(0); // 前提: 組合せの食い違いで netkeiba へ戻る券種がある(空振りでない)
    const total = jraN + gateN + 1; // + saveClose の D1 batch 1 回
    expect(total).toBeLessThanOrEqual(50);
    // リンクが居ない(発見の 2 本が要る)場合
    const k = harness({ settings: COMBO_ON });
    await analyze(k);
    k.sql.exec("DELETE FROM fetch_cache WHERE key LIKE 'jra-odds-links:%'");
    const ks0 = k.jra.sessions.length;
    const kg0 = k.gate.urls.length;
    await fire(k, DUE1);
    expect(jraRequests(k.jra, ks0)).toBe(9);
    expect(jraRequests(k.jra, ks0) + (k.gate.urls.length - kg0) + 1).toBeLessThanOrEqual(50);
    // 最悪: リンクが無く、全頁が param-error(たどり直しは段全体で 1 回)で、JRA がすべて使えず netkeiba の取り直しに戻る(単勝複勝 1 + 組合せ 6)
    const w = harness({ settings: COMBO_ON });
    await analyze(w);
    w.sql.exec("DELETE FROM fetch_cache WHERE key LIKE 'jra-odds-links:%'");
    w.jra.oddsOverride = () => ({ status: "param-error" });
    const ws0 = w.jra.sessions.length;
    const wg0 = w.gate.urls.length;
    await fire(w, DUE1);
    const worstJra = jraRequests(w.jra, ws0);
    const worstGate = w.gate.urls.length - wg0;
    // 1 回目の run(三連単以外の 6 頁): 発見 2 + tanpuku 1 + たどり直し 2 + 取り直し 1 + 残りの 5 頁 = 11。2 回目の run(三連単。たどり直しは run ごとに 1 回): 三連単 1 + たどり直し 2 + 取り直し 1 = 4
    expect(worstJra).toBe(11 + 4);
    expect(worstGate).toBe(7);
    expect(worstJra + worstGate + 1).toBeLessThanOrEqual(50);
    console.info(`[実数] 最悪(リンクなし・全頁 param-error・netkeiba に全部戻る): JRA ${worstJra} + gate ${worstGate} + D1 1 = ${worstJra + worstGate + 1}`);
    console.info(`[実数] リンクあり: JRA ${jraN} + gate ${gateN} + D1 1 = ${total} / リンクなし: JRA ${jraRequests(k.jra, ks0)} + gate ${k.gate.urls.length - kg0} + D1 1 = ${jraRequests(k.jra, ks0) + (k.gate.urls.length - kg0) + 1}`);
  });

  it("取得の再試行(netkeiba の組合せの失敗 → 15 秒後)では、回の起動後に置いた JSON を再利用し、JRA へ取りに行き直さない(oddsSince は初回の起動時刻のまま)", async () => {
    const h = harness({ settings: COMBO_ON });
    await analyze(h);
    const s0 = h.jra.sessions.length;
    const ok = h.gate.body;
    h.gate.body = (url) => (/\/odds\/|api_get_jra_odds/.test(url) && /type=[3-8]/.test(url) ? null : ok(url)); // 組合せの取得が失敗する
    const first = await fire(h, DUE1);
    expect(first).toMatchObject({ round: 1, result: "retry" }); // 前提: 取得の再試行になった
    expect(jraFetches(h.jra, s0)).toHaveLength(7);
    h.gate.body = ok;
    const second = await fire(h, DUE1 + CLOSE_FETCH_RETRY_DELAY_MS);
    expect(second).toMatchObject({ round: 1, result: "ok" });
    expect(jraFetches(h.jra, s0)).toHaveLength(7); // 再試行で増えない
    expect(closeRows(h)[0]!.fired_at).toBe(DUE1); // oddsSince の根(初回の起動時刻)
    expect(h.sink.closes[0]!.payload.oddsSources?.winPlace?.source).toBe("jra");
  });
});

describe("締切の再計算 × JRA のオッズ: 時間の守り(回の期限の 20 秒前を過ぎそうな頁は取らない)", () => {
  it("定数: 守りの幅は 20 秒で、JRA の 1 本のタイムアウト(10 秒)より長い(始めた頁は期限の前に終わる)", () => {
    expect(CLOSE_JRA_STOP_BEFORE_MS).toBe(20_000);
    expect(CLOSE_JRA_STOP_BEFORE_MS).toBeGreaterThan(JRA_TIMEOUT_MS);
  });

  // 回 2 の期限は発走。起床は発走の 120 秒前。守りの時刻は発走の 20 秒前 = 起床から 100 秒後。
  // 1 本ごとに時計が advance ミリ秒進む(リンクは分析の段が置いたので、発見の 2 本は無い)。k 本目を始める時点の経過は (k-1)×advance。
  // その時点で now >= 守りの時刻なら、その頁と以降は取らない(境界は取らない側)。
  const ALL7 = ["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku", "sanrentan"];
  const cases: readonly { readonly advance: number; readonly fetched: readonly string[] }[] = [
    { advance: 0, fetched: ALL7 },
    { advance: 16_000, fetched: ALL7 }, // 7 本目の開始が 96 秒 < 100 秒
    { advance: 17_000, fetched: ALL7.slice(0, 6) }, // 7 本目の開始が 102 秒 >= 100 秒 → 三連単を取らない
    { advance: 24_000, fetched: ALL7.slice(0, 5) }, // 5 本目の開始が 96 秒(取る)、6 本目の開始が 120 秒(取らない)
    { advance: 25_000, fetched: ALL7.slice(0, 4) }, // 5 本目の開始がちょうど 100 秒(取らない側の境界)
    { advance: 100_000, fetched: ALL7.slice(0, 1) }, // 2 本目の開始がちょうど 100 秒 → 単勝複勝だけ
  ];
  for (const c of cases) {
    it(`回 2: 1 本ごとに ${c.advance / 1000} 秒かかると、取る頁は ${c.fetched.length} 本。取らなかった頁の券種は netkeiba に戻る`, async () => {
      const h = harness({ settings: COMBO_ON });
      await analyze(h);
      const s0 = h.jra.sessions.length;
      h.jra.advanceMsPerRequest = c.advance;
      expect(await fire(h, DUE2)).toMatchObject({ round: 1, reason: "too-late" }); // 回 1 は回 2 の時刻を過ぎているので動かない(JRA には出ない)
      expect(await fire(h, DUE2)).toMatchObject({ round: 2, result: "ok" });
      expect(jraFetches(h.jra, s0)).toEqual(c.fetched);
      const sources = h.sink.closes[1]!.payload.oddsSources!;
      for (const page of PAGES.filter((p) => p !== "tanpuku")) {
        const bet = BET_OF_PAGE[page]!;
        // 取った頁は出走馬と食い違うので horse-set-mismatch、取らなかった頁は(分析時の JSON は古いので)override-unavailable
        expect(sources[bet as keyof typeof sources]?.fallbackReason, `${page} (${c.advance})`).toBe(c.fetched.includes(page) ? "horse-set-mismatch" : "override-unavailable");
      }
      expect(sources.winPlace?.source).toBe("jra");
    });
  }

  it("回 1 の守りの基準は次の回(回 2)の時刻: 回 1 の起床から回 2 の 20 秒前まで 100 秒しか無い", async () => {
    const h = harness({ settings: COMBO_ON });
    await analyze(h);
    const s0 = h.jra.sessions.length;
    h.jra.advanceMsPerRequest = 100_000; // 回 1 の起床(発走の 300 秒前)から守りの時刻(回 2 の 20 秒前 = 発走の 140 秒前)まで 160 秒。2 本目の開始が 100 秒(取る)、3 本目が 200 秒(取らない)
    await fire(h, DUE1);
    expect(jraFetches(h.jra, s0)).toEqual(["tanpuku", "wakuren"]);
  });

  it("起床が守りの時刻より遅れていたら、JRA に 1 本も出ない(開催選択にも出ない)が、再計算は netkeiba で完了する", async () => {
    const h = harness({ settings: COMBO_ON });
    await analyze(h);
    const s0 = h.jra.sessions.length;
    const lateAt = START_MS - CLOSE_JRA_STOP_BEFORE_MS; // 発走の 20 秒前: 回 1 は期限(回 2 の時刻)を過ぎて too-late、回 2 は期限(発走)の前で動く
    expect(await fire(h, lateAt)).toMatchObject({ round: 1, result: "failed", reason: "too-late" });
    expect(await fire(h, lateAt)).toMatchObject({ round: 2, result: "ok" });
    expect(jraRequests(h.jra, s0)).toBe(0);
    expect(h.sink.closes[1]!.payload.status).toBe("ok");
    expect(h.sink.closes[1]!.payload.oddsSources?.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-unavailable" });
  });
});
