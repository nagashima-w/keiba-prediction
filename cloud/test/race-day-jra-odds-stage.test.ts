import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { JraOddsRaceLinks, JraOddsVenueLink } from "../../packages/core/src/scraper/parse-jra-odds-index";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { AnalysisSaveExtra } from "../src/analysis-save-extra";
import type { JraOddsFetcher, JraOddsResult, JraOddsSession } from "../src/jra-odds-fetch";
import { jraLinksCacheKey, jraOddsCacheKey } from "../src/jra-odds-cache";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
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
 * Issue #675 段階 A: 発走前の取得の段の後・計算の段の前に、JRA のオッズの段階(別のアラーム)を挟む。
 * 偽の JRA の取得口(実際の JRA には出ない)・偽のゲート・`node:sqlite`。中央 16 頭の 202603020211(開催日 2026-06-28)。
 * 単勝複勝の頁は、見本(東京 8R・14 頭)の最後の馬の行を複製して 16 頭にしたもの(DO の出馬表と馬番の集合を合わせる)。組合せの頁は 14 頭の見本のまま(= 16 頭の出走馬と食い違う)。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jraHtml = (name: string): string => new TextDecoder("shift_jis").decode(new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name))));
const RACE = "202603020211";
const OTHER_RACE = "202603020210";
const DATE = "20260628";
const encoder = new TextEncoder();

/** 14 頭の単勝複勝の見本から、最後の馬(14 番)の行を複製して 15・16 番を足し、16 頭にする。 */
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
const PAGES = Object.keys(DIGIT);

const cnameOf = (raceId: string, page: string, date = DATE): string => `pw15${DIGIT[page]}ouS3${raceId.slice(4, 6)}${raceId.slice(0, 4)}${raceId.slice(6, 8)}${raceId.slice(8, 10)}${raceId.slice(10, 12)}${date}Z/AA`;
const linksOf = (raceId: string, date = DATE): JraOddsRaceLinks => ({
  raceId,
  race: raceId.slice(10, 12),
  cnames: Object.fromEntries(PAGES.map((p) => [p, cnameOf(raceId, p, date)])) as unknown as JraOddsRaceLinks["cnames"],
});
const VENUE: JraOddsVenueLink = { venueCode: "03", year: "2026", kai: "02", day: "02", date: DATE, racesCname: `pw15orl000320260202${DATE}/AA` };

interface FakeJra extends JraOddsFetcher {
  /** 起床(session)ごとの本数。 */
  readonly sessions: { listVenues: number; listRaces: number; fetchOdds: string[] }[];
  listVenuesResult: () => JraOddsResult<readonly JraOddsVenueLink[]>;
  /** 頁(cname の式別桁)→ その呼び出し回での結果の上書き。null なら見本の頁。 */
  oddsOverride: (page: string, nth: number) => JraOddsResult<string> | null;
  throwOnOpen: boolean;
}

function fakeJra(): FakeJra {
  const seen: Record<string, number> = {};
  const jra: FakeJra = {
    sessions: [],
    listVenuesResult: () => ({ status: "ok", value: [VENUE] }),
    oddsOverride: () => null,
    throwOnOpen: false,
    open(): JraOddsSession {
      if (jra.throwOnOpen) throw new Error("secret-url https://example.invalid/x?cname=ABC");
      const record = { listVenues: 0, listRaces: 0, fetchOdds: [] as string[] };
      jra.sessions.push(record);
      let sent = 0;
      return {
        get requestCount() {
          return sent;
        },
        async listVenues() {
          sent += 1;
          record.listVenues += 1;
          return jra.listVenuesResult();
        },
        async listRaces() {
          sent += 1;
          record.listRaces += 1;
          return { status: "ok", value: [linksOf(OTHER_RACE), linksOf(RACE)] };
        },
        async fetchOdds(cname) {
          sent += 1;
          const page = PAGES.find((p) => cname.startsWith(`pw15${DIGIT[p]}`))!;
          record.fetchOdds.push(page);
          seen[page] = (seen[page] ?? 0) + 1;
          return jra.oddsOverride(page, seen[page]!) ?? { status: "ok", value: PAGE_HTML[page]!() };
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
  route: (url: string) => string;
}
function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    route: fixtureForUrl,
    postRaw: newspaperOnlyPostRaw,
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(gate.route(url)), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}
interface FakeSink extends AnalysisSink {
  readonly saved: AnalysisRecord[];
  readonly extras: (AnalysisSaveExtra | undefined)[];
}
function fakeSink(): FakeSink {
  const sink: FakeSink = {
    saved: [],
    extras: [],
    async save(record, extra) {
      sink.saved.push(record);
      sink.extras.push(extra);
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
  readonly alarm: { at: number | null };
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
  const alarm: { at: number | null } = { at: null };
  const warnings: string[] = [];
  const infos: string[] = [];
  const gate = fakeGate();
  const sink = fakeSink();
  const jra = fakeJra();
  const h = { sql, gate, sink, jra, clock, alarm, warnings, infos, settings: opts.settings ?? BASE } as Harness;
  const deps: RaceDayDeps = {
    sql,
    now: () => clock.now,
    gate,
    setAlarm: (at) => {
      alarm.at = at;
    },
    onWarn: (m) => warnings.push(m),
    onInfo: (m) => infos.push(m),
    sink,
    loadSettings: async () => h.settings,
    ...(opts.withJra === false ? {} : { fetchJraOdds: jra }),
  };
  (h as { core: RaceDayCore }).core = new RaceDayCore(deps);
  return h;
}
async function step(h: Harness): Promise<{ label: string; urls: string[] }> {
  const before = h.gate.urls.length;
  if (h.alarm.at !== null) h.clock.now = Math.max(h.clock.now, h.alarm.at);
  const outcome = await h.core.runNextStep();
  return { label: outcome.kind === "idle" ? "idle" : `${outcome.mode}:${outcome.step}:${outcome.result}`, urls: h.gate.urls.slice(before) };
}
async function runAll(h: Harness, max = 8): Promise<string[]> {
  const labels: string[] = [];
  for (let i = 0; i < max; i++) {
    const s = await step(h);
    labels.push(s.label);
    if (s.label === "pre_race:compute:ok" || s.label.endsWith(":failed") || s.label === "idle") return labels;
  }
  throw new Error("ステップが終わらない");
}
const schedule = async (h: Harness, raceId = RACE): Promise<void> => void (await h.core.schedule({ raceId, kaisaiDate: DATE, mode: "pre_race" }));
const taskStatus = (h: Harness): string => (h.sql.exec("SELECT status FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { status: string }[])[0]!.status;
const stageRows = (h: Harness): { page: string; state: string }[] => h.sql.exec("SELECT page, state FROM race_day_jra_odds ORDER BY page").toArray() as { page: string; state: string }[];
const totalRequests = (jra: FakeJra): number => jra.sessions.reduce((n, s) => n + s.listVenues + s.listRaces + s.fetchOdds.length, 0);

describe("JRA のオッズの段階: 順序・本数(組合せ OFF)", () => {
  it("取得 → JRA の段(開催選択 1・レース選択 1・単勝複勝 1 の 3 本。gate は 0 回) → 計算の順。段の間は status が fetched。単勝複勝は JRA のオッズで計算され、取得元が記録される", async () => {
    const h = harness();
    await schedule(h);
    const s1 = await step(h);
    expect(s1.label).toBe("pre_race:fetch:ok");
    expect(taskStatus(h)).toBe("fetched");
    expect(stageRows(h)).toEqual([{ page: "tanpuku", state: "pending" }]);
    expect(h.jra.sessions).toHaveLength(0); // 取得の段は JRA に出ない

    const s2 = await step(h);
    expect(s2.label).toBe("pre_race:fetch:ok");
    expect(s2.urls).toHaveLength(0); // JRA の段は netkeiba の窓口(gate)を通らない
    expect(h.jra.sessions).toHaveLength(1);
    expect(h.jra.sessions[0]).toEqual({ listVenues: 1, listRaces: 1, fetchOdds: ["tanpuku"] });
    expect(taskStatus(h)).toBe("fetched");
    expect(h.sink.saved).toHaveLength(0);

    const s3 = await step(h);
    expect(s3.label).toBe("pre_race:compute:ok");
    expect(s3.urls).toHaveLength(0);
    expect(h.sink.saved).toHaveLength(1);
    expect(taskStatus(h)).toBe("done");
    expect(stageRows(h)).toEqual([]); // 完了したら行は要らない
    const sources = h.sink.extras[0]?.oddsSources;
    expect(sources?.winPlace?.source).toBe("jra");
    expect(sources?.winPlace?.officialDatetime).toBe("2026-06-28 10:37:00");
    expect(Object.keys(sources ?? {})).toEqual(["winPlace"]); // 組合せ OFF なので単勝複勝だけ
  });

  it("JRA の段の所要時間を固定の語で onInfo に残す(URL・cname は含めない)", async () => {
    const h = harness();
    await schedule(h);
    await runAll(h);
    const line = h.infos.find((m) => m.includes("JRA オッズ"));
    expect(line).toBeDefined();
    expect(line).toMatch(/成功 1/);
    expect(line).toMatch(/\d+ms/);
    expect(line).not.toMatch(/jra\.go\.jp|cname|pw15/);
  });
});

describe("JRA のオッズの段階: 組合せ ON(7 頁。三連単は単独の起床)", () => {
  it("単勝複勝 + 5 式別が 1 起床(8 本)、三連単が次の起床(リンクを再利用して 1 本)。どの起床も 9 本以下。組合せは出走馬(16 頭)と食い違うので netkeiba のまま・理由が記録される", async () => {
    const h = harness({ settings: COMBO_ON });
    await schedule(h);
    const labels = await runAll(h);
    expect(labels).toEqual(["pre_race:fetch:ok", "pre_race:fetch:ok", "pre_race:fetch:ok", "pre_race:compute:ok"]);
    expect(h.jra.sessions).toHaveLength(2);
    expect(h.jra.sessions[0]!.fetchOdds).toEqual(["tanpuku", "wakuren", "umaren", "wide", "umatan", "sanrenpuku"]);
    expect(h.jra.sessions[0]!.listVenues + h.jra.sessions[0]!.listRaces + h.jra.sessions[0]!.fetchOdds.length).toBe(8);
    expect(h.jra.sessions[1]).toEqual({ listVenues: 0, listRaces: 0, fetchOdds: ["sanrentan"] }); // 場の全レースのリンクをキャッシュに置いたので、発見の 2 本は省ける
    expect(totalRequests(h.jra)).toBe(9);
    const sources = h.sink.extras[0]!.oddsSources!;
    expect(sources.winPlace?.source).toBe("jra");
    for (const bet of ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const) {
      expect(sources[bet], bet).toMatchObject({ source: "netkeiba", fallbackReason: "horse-set-mismatch" });
    }
    // 場の全レースのリンクを置いた(次のレースが発見を省ける)
    const keys = (h.sql.exec("SELECT key FROM fetch_cache WHERE key LIKE 'jra-odds-links:%' ORDER BY key").toArray() as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual([jraLinksCacheKey(OTHER_RACE), jraLinksCacheKey(RACE)].sort());
  });
});

describe("JRA のオッズの段階: 失敗は握る(分析は止めない)", () => {
  it("開催選択の失敗: 残りの頁を全部 failed にして、netkeiba のまま計算まで進む。警告は固定の語だけ(URL を含めない)", async () => {
    const h = harness({ settings: COMBO_ON });
    h.jra.listVenuesResult = () => ({ status: "network" });
    await schedule(h);
    const labels = await runAll(h);
    expect(labels).toEqual(["pre_race:fetch:ok", "pre_race:fetch:ok", "pre_race:compute:ok"]); // 三連単の起床も無い(全部 failed にした)
    expect(h.jra.sessions).toHaveLength(1);
    expect(totalRequests(h.jra)).toBe(1);
    expect(taskStatus(h)).toBe("done");
    const sources = h.sink.extras[0]!.oddsSources!;
    expect(sources.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-unavailable" });
    const warn = h.warnings.filter((w) => w.includes("JRA"));
    expect(warn.length).toBeGreaterThan(0);
    expect(warn.join("\n")).toContain("network");
    expect(warn.join("\n")).not.toMatch(/https?:|cname|pw15/);
  });

  it("ある頁の失敗はほかの頁を止めない: ワイドが http-500 でも、単勝複勝は JRA", async () => {
    const h = harness({ settings: COMBO_ON });
    h.jra.oddsOverride = (page) => (page === "wide" ? { status: "http-500" } : null);
    await schedule(h);
    await runAll(h);
    expect(h.sink.extras[0]!.oddsSources!.winPlace?.source).toBe("jra");
    expect(h.sink.extras[0]!.oddsSources!.wide).toMatchObject({ source: "netkeiba", fallbackReason: "override-unavailable" });
    expect(h.warnings.some((w) => w.includes("wide") && w.includes("http-500"))).toBe(true);
  });

  it("取得口が例外を投げても握る: タスクは failed にならず、計算まで進む。例外の文面(URL)は警告に出さない", async () => {
    const h = harness();
    h.jra.throwOnOpen = true;
    await schedule(h);
    const labels = await runAll(h);
    expect(labels).toEqual(["pre_race:fetch:ok", "pre_race:fetch:ok", "pre_race:compute:ok"]);
    expect(taskStatus(h)).toBe("done");
    expect(h.warnings.join("\n")).not.toMatch(/example\.invalid|secret-url|cname=ABC/);
    expect(h.warnings.some((w) => w.includes("JRA"))).toBe(true);
  });

  it("param-error は 1 回だけたどり直して取り直す(3 本 + たどり直し 2 本 + 取り直し 1 本 = 6 本)。2 回続けば failed", async () => {
    const h = harness();
    h.jra.oddsOverride = (page, nth) => (page === "tanpuku" && nth === 1 ? { status: "param-error" } : null);
    await schedule(h);
    await runAll(h);
    expect(totalRequests(h.jra)).toBe(1 + 1 + 1 + 2 + 1);
    expect(h.sink.extras[0]!.oddsSources!.winPlace?.source).toBe("jra");

    const h2 = harness();
    h2.jra.oddsOverride = (page) => (page === "tanpuku" ? { status: "param-error" } : null);
    await schedule(h2);
    await runAll(h2);
    expect(totalRequests(h2.jra)).toBe(1 + 1 + 1 + 2 + 1); // 取り直しも param-error でも、それ以上は撃たない
    expect(h2.sink.extras[0]!.oddsSources!.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-unavailable" });
  });
});

describe("JRA のオッズの段階: 発走済みのレースは取らない(failIfStarted。Issue #680)", () => {
  const START = Date.parse("2026-06-28T15:45:00+09:00");
  /** 取得ステップを終え(段の前)、計画の行(発走時刻)を足して、auto: 自動の印を付けるか。 */
  async function readyForJraStage(h: Harness, auto: boolean): Promise<void> {
    await schedule(h);
    expect((await step(h)).label).toBe("pre_race:fetch:ok"); // 取得ステップ(JRA の段の前)
    expect((h.sql.exec("SELECT status FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { status: string }[])[0]!.status).toBe("fetched"); // 前提: 次は JRA の段
    h.sql.exec(
      `INSERT INTO race_day_plan (race_id, venue, venue_name, race_number, race_name, grade, start_time, start_ms, due_ms, offset_minutes, disposition, skip_reason, state, planned_at, promoted_at)
       VALUES (?, 'central', '東京', 11, 'x', NULL, '15:45', ?, NULL, 45, 'scheduled', NULL, 'promoted', ?, NULL)`,
      RACE,
      START,
      h.clock.now,
    );
    if (auto) {
      const queuedAt = (h.sql.exec("SELECT queued_at FROM race_day_tasks WHERE mode = 'pre_race'").toArray() as { queued_at: number }[])[0]!.queued_at;
      h.sql.exec("INSERT INTO race_day_auto_pre_race (race_id, enqueued_at, fail_reason) VALUES (?, ?, NULL)", RACE, queuedAt);
    }
  }

  it("自動の発走前: 発走時刻に達していたら JRA に 1 本も出ず(取得口を開かない)、failed(理由 started)になり、段の行が消える", async () => {
    const h = harness();
    await readyForJraStage(h, true);
    expect(stageRows(h).length).toBeGreaterThan(0); // 前提: 段の行がある(消えたことを確かめられる)
    h.alarm.at = null;
    h.clock.now = START; // 発走ちょうど(now >= start)
    const outcome = await h.core.runNextStep();
    expect(outcome).toMatchObject({ kind: "ran", mode: "pre_race", step: "fetch", result: "failed" });
    expect(h.jra.sessions).toHaveLength(0);
    expect(taskStatus(h)).toBe("failed");
    expect(stageRows(h)).toEqual([]);
    expect((h.sql.exec("SELECT fail_reason FROM race_day_auto_pre_race WHERE race_id = ?", RACE).toArray() as { fail_reason: string }[])[0]!.fail_reason).toBe("started");
  });

  it("自動の発走前: 発走の 1 ミリ秒前なら守りは働かず、JRA の段が動く", async () => {
    const h = harness();
    await readyForJraStage(h, true);
    h.alarm.at = null;
    h.clock.now = START - 1;
    const outcome = await h.core.runNextStep();
    expect(outcome).toMatchObject({ kind: "ran", mode: "pre_race", step: "fetch", result: "ok" });
    expect(totalRequests(h.jra)).toBeGreaterThan(0);
  });

  it("手動の発走前(自動の印なし)は、発走後でも JRA の段が動く(守りは自動だけ)", async () => {
    const h = harness();
    await readyForJraStage(h, false);
    h.alarm.at = null;
    h.clock.now = START + 60_000;
    const outcome = await h.core.runNextStep();
    expect(outcome).toMatchObject({ kind: "ran", mode: "pre_race", step: "fetch", result: "ok" });
    expect(totalRequests(h.jra)).toBeGreaterThan(0);
  });
});

describe("JRA のオッズの段階: 差し込みの例外の中身(Issue #680)", () => {
  it("差し込みが例外を投げると、理由は固定の語 override-error のまま、例外の名前と文面はログ(onWarn)にだけ残る。保存される分析・取得元の記録には文面が入らない", async () => {
    const h = harness();
    overrideFault.throwMessage = "SECRETMSG https://example.invalid/x?cname=ABC";
    await schedule(h);
    await runAll(h);
    expect(taskStatus(h)).toBe("done");
    expect(h.sink.extras[0]!.oddsSources!.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-error" });
    const logged = h.warnings.filter((w) => w.includes("JRA のオッズを使えませんでした"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`${RACE}) ・winPlace`.replace(") ・", ")・"));
    expect(logged[0]).toContain("Error: SECRETMSG");
    // 保存されるもの(分析の記録と付帯情報)にも、画面向けの警告にも、文面は入らない
    expect(JSON.stringify(h.sink.saved)).not.toContain("SECRETMSG");
    expect(JSON.stringify(h.sink.extras)).not.toContain("SECRETMSG");
  });

  it("ログの 1 行は 300 字に切り詰める", async () => {
    const h = harness();
    overrideFault.throwMessage = "x".repeat(2000);
    await schedule(h);
    await runAll(h);
    const logged = h.warnings.filter((w) => w.includes("JRA のオッズを使えませんでした"));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.length).toBe(301);
  });
});

describe("JRA のオッズの段階: param-error のたどり直しは 1 起床に 1 回", () => {
  it("全頁が param-error でも、たどり直しは起床の中で 1 回だけ(発見 2 + 単勝複勝 1 + たどり直し 2 + 取り直し 1 + 残り 5 頁 1 本ずつ = 11 本)", async () => {
    const h = harness({ settings: COMBO_ON });
    h.jra.oddsOverride = () => ({ status: "param-error" });
    await schedule(h);
    await runAll(h);
    const first = h.jra.sessions[0]!;
    expect(first.listVenues + first.listRaces + first.fetchOdds.length).toBe(2 + 1 + 2 + 1 + 5);
    expect(first.listVenues).toBe(2); // 発見(1 回目)とたどり直し(1 回)で 2 回。頁ごとには繰り返さない
    expect(h.sink.extras[0]!.oddsSources!.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-unavailable" });
  });
});

describe("JRA のオッズの段階: 使わない場合・古い JSON・リンクの検査", () => {
  it("取得口を渡さない(JRA 無効): 段に入らず、oddsSources も付かない(従来と同じ)", async () => {
    const h = harness({ withJra: false });
    await schedule(h);
    const labels = await runAll(h);
    expect(labels).toEqual(["pre_race:fetch:ok", "pre_race:compute:ok"]);
    expect(stageRows(h)).toEqual([]);
    expect(h.sink.extras[0]!.oddsSources).toBeUndefined(); // 記録なしはキー自体を渡さない(従来の保存の引数と同じ)
  });

  it("取得ステップの開始より古い JSON は使わない: 前回の実行で置かれた JSON は、段が失敗したとき計算に使われず netkeiba のまま", async () => {
    const h = harness();
    // 前回の実行の残り(取得ステップの開始より前に置かれた JSON。本物の頁をパースしたもの)
    const { parseJraOddsPage } = await import("../src/jra-odds-cache");
    const parsed = parseJraOddsPage("tanpuku", tanpuku16(), "2026-06-28");
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    h.sql.exec("INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ?, ?)", jraOddsCacheKey(RACE, "tanpuku"), parsed.json, h.clock.now - 60_000);
    h.jra.listVenuesResult = () => ({ status: "network" });
    await schedule(h);
    await runAll(h);
    expect(h.sink.extras[0]!.oddsSources!.winPlace).toMatchObject({ source: "netkeiba", fallbackReason: "override-unavailable" });
  });

  it("キャッシュのリンクの raceId・日付が一致しなければ使わず、発見からやり直す。一致していれば発見を省く", async () => {
    const wrong = harness();
    wrong.sql.exec("INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ?, ?)", jraLinksCacheKey(RACE), JSON.stringify(linksOf(OTHER_RACE)), wrong.clock.now);
    await schedule(wrong);
    await runAll(wrong);
    expect(wrong.jra.sessions[0]).toEqual({ listVenues: 1, listRaces: 1, fetchOdds: ["tanpuku"] });

    const wrongDate = harness();
    wrongDate.sql.exec("INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ?, ?)", jraLinksCacheKey(RACE), JSON.stringify(linksOf(RACE, "20260627")), wrongDate.clock.now);
    await schedule(wrongDate);
    await runAll(wrongDate);
    expect(wrongDate.jra.sessions[0]).toEqual({ listVenues: 1, listRaces: 1, fetchOdds: ["tanpuku"] });

    const right = harness();
    right.sql.exec("INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ?, ?)", jraLinksCacheKey(RACE), JSON.stringify(linksOf(RACE)), right.clock.now);
    await schedule(right);
    await runAll(right);
    expect(right.jra.sessions[0]).toEqual({ listVenues: 0, listRaces: 0, fetchOdds: ["tanpuku"] });
  });

  it("地方のレースは段に入らない(JRA の取得口を一度も開かない)", async () => {
    const h = harness();
    const fx = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
    h.gate.route = (url) => {
      if (url.includes("shutuba.html")) return fx("nar_shutuba_202654071210.html");
      if (url.includes("ajax_horse_results")) return fx("horse_results_2021104387.json");
      if (url.includes("type=b1&")) return fx("nar_odds_b1_202654071210.html");
      throw new Error(`未知のURL(NAR): ${url}`);
    };
    await h.core.schedule({ raceId: "202654071210", kaisaiDate: "20260712", mode: "pre_race" });
    const labels = await runAll(h);
    expect(labels).toEqual(["pre_race:fetch:ok", "pre_race:compute:ok"]); // 段に入らない
    expect(stageRows(h)).toEqual([]);
    expect(h.jra.sessions).toHaveLength(0);
    expect(h.sink.extras[0]!.oddsSources).toBeUndefined(); // 記録なしはキー自体を渡さない(従来の保存の引数と同じ)
  });
});
