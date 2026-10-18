import { describe, expect, it } from "vitest";
import { handle, type Env, type RaceDayStubLike } from "../src/handler";
import type { PlanProgress } from "../src/race-day-core";
import type { TargetsLedgerWire } from "../src/targets-ledger";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";

/**
 * Issue #336 段階 A: `GET /api/targets?kaisai_date=YYYYMMDD`(今日の狙い目)。D1 の集計(最新の分析・買い目・◎・再計算の回)と、日単位の DO の計画の行(発走時刻)を合わせて返す、読み取り専用の入口。
 * R2・netkeiba・LLM・Webhook には触れない。D1 と DO は偽物(呼び出しを記録する)。
 * 順序: メソッド(GET だけ)→ Sec-Fetch-Site(別サイトなら 403)→ クエリの検証(400。ここまでで D1・DO は呼ばない)→ D1(失敗は 503・文面なし)→ DO(分析が 1 件でもあるときだけ。失敗は時刻なしで 200)。
 */

const ORIGIN = "https://cloud.invalid";
const DATE = "20261017";
const R11 = "202605050811";
const R12 = "202605050812";

type Row = Record<string, unknown>;

interface FakeDb {
  readonly sqls: string[];
  readonly batches: number[];
  /** 文の SQL の部分文字列 → 返す行。 */
  rows: { analyses: Row[]; bets: Row[]; marks: Row[]; closeRounds: Row[]; closeBets: Row[] };
  failMain: boolean;
  failClose: boolean;
  db: Env["DB"];
}

function fakeDb(): FakeDb {
  const f: FakeDb = {
    sqls: [],
    batches: [],
    rows: {
      analyses: [{ analysisId: 11, raceId: R11, analyzedAt: "2026-10-17T02:00:00.000Z" }, { analysisId: 12, raceId: R12, analyzedAt: "2026-10-17T02:00:00.000Z" }],
      bets: [{ analysisId: 11, betCount: 5, totalStake: 1200, maxEv: 1.42 }, { analysisId: 12, betCount: 2, totalStake: 400, maxEv: 1.2 }],
      marks: [{ analysisId: 11, umaban: 7 }],
      closeRounds: [{ analysisId: 12, round: 1, status: "ok" }],
      closeBets: [{ analysisId: 12, round: 1, betCount: 0, totalStake: 0, maxEv: null }],
    },
    failMain: false,
    failClose: false,
    db: undefined as never,
  };
  const pick = (sql: string): Row[] => {
    if (sql.includes("FROM analysis_close_bets")) return f.rows.closeBets;
    if (sql.includes("FROM analysis_close")) return f.rows.closeRounds;
    if (sql.includes("FROM analysis_bets")) return f.rows.bets;
    if (sql.includes("FROM analysis_horses")) return f.rows.marks;
    if (sql.includes("FROM analyses")) return f.rows.analyses;
    throw new Error(`想定外の SQL: ${sql}`);
  };
  f.db = {
    prepare: (sql: string) => {
      f.sqls.push(sql);
      const statement = { sql, bind: () => statement };
      return statement;
    },
    batch: async (statements: { sql: string }[]) => {
      f.batches.push(statements.length);
      const isClose = statements.some((s) => s.sql.includes("analysis_close"));
      if (isClose ? f.failClose : f.failMain && !statements.some((s) => s.sql.includes("FROM analyses WHERE"))) throw new Error(`D1_ERROR: injected ${isClose ? "close" : "main"}`);
      return statements.map((s) => ({ results: pick(s.sql), meta: { rows_read: 10 } }));
    },
  } as unknown as Env["DB"];
  return f;
}

interface FakeDay {
  readonly names: string[];
  readonly calls: string[];
  /** `getTargetsLedger` に渡された引数(収支の計算は日単位の DO が行う。Issue #361)。 */
  readonly ledgerInputs: { kaisaiDate: string; nowMs: number }[];
  planImpl: () => Promise<PlanProgress>;
  ledgerImpl: () => Promise<TargetsLedgerWire | null>;
  readonly namespace: Env["RACE_DAY"];
}

const PLAN: PlanProgress = {
  stage: "done",
  requestedAt: 1,
  finalizedAt: 2,
  offsetMinutes: 45,
  offsetSource: "settings",
  venues: [],
  rows: [
    { raceId: R11, venue: "central", venueName: "東京", raceNumber: 11, raceName: "テスト記念", grade: null, startTime: "15:40", dueMs: 3, disposition: "scheduled", skipReason: null, state: "promoted", morning: "done" },
    { raceId: R12, venue: "central", venueName: "東京", raceNumber: 12, raceName: "テスト特別", grade: null, startTime: "16:20", dueMs: 4, disposition: "scheduled", skipReason: null, state: "promoted", morning: "done" },
  ],
  morningAllTerminal: true,
};

function fakeDay(): FakeDay {
  const f: FakeDay = { names: [], calls: [], ledgerInputs: [], planImpl: async () => PLAN, ledgerImpl: async () => null, namespace: undefined as never };
  const forbid = (name: string) => () => {
    f.calls.push(`FORBIDDEN:${name}`);
    throw new Error(`${name} は呼ばれない想定`);
  };
  const stub: RaceDayStubLike = {
    schedule: forbid("schedule"),
    scheduleMany: forbid("scheduleMany"),
    getBoard: forbid("getBoard"),
    getMorningPrior: forbid("getMorningPrior"),
    getRaceList: forbid("getRaceList"),
    requestPlan: forbid("requestPlan"),
    requestResultImport: forbid("requestResultImport"),
    getResultImportProgress: forbid("getResultImportProgress"),
    getAutoRunResults: forbid("getAutoRunResults"),
    getNotifications: forbid("getNotifications"),
    getPlanProgress: () => {
      f.calls.push("getPlanProgress");
      return f.planImpl();
    },
    getTargetsLedger: (input) => {
      f.calls.push("getTargetsLedger");
      f.ledgerInputs.push(input);
      return f.ledgerImpl();
    },
  };
  (f as { namespace: Env["RACE_DAY"] }).namespace = {
    idFromName: (name: string) => {
      f.names.push(name);
      return name;
    },
    get: () => stub,
  };
  return f;
}

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

function envOf(db: FakeDb, day: FakeDay, overrides: Partial<Env> = {}): Env {
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: db.db,
    // R2 は触れない(触れたら例外)。
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: day.namespace,
    ...overrides,
  };
}

async function setup(now: Date = NOW) {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => now, log: () => {} };
  const exp = Math.floor(now.getTime() / 1000) + 3600; // 時計を進めたときも、トークンが期限切れにならない
  const token = await signToken(key, { exp });
  const viewer = await signToken(key, { email: "stranger@example.com", exp });
  return { deps, token, viewer };
}

function get(path: string, token?: string, init: { method?: string; headers?: Record<string, string> } = {}): Request {
  const headers = new Headers(init.headers);
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers });
}

const sortedKeys = (o: unknown): string[] => Object.keys(o as Record<string, unknown>).sort();

describe("GET /api/targets(Issue #336)", () => {
  it("認証なしは 403 で、D1 も DO も呼ばない", async () => {
    const { deps } = await setup();
    const db = fakeDb();
    const day = fakeDay();
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`), envOf(db, day), {}, deps);
    expect(response.status).toBe(403);
    expect(db.sqls).toEqual([]);
    expect(day.names).toEqual([]);
  });

  it("管理者でない人(閲覧者)にも 200 を返す(読み取り専用なので閲覧者に開く)", async () => {
    const { deps, viewer } = await setup();
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, viewer), envOf(fakeDb(), fakeDay()), {}, deps);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("200: 狙い目・見送りを、計画の発走時刻つきで返す。キャッシュしない。DO は読み取りの getPlanProgress だけ", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    const day = fakeDay();
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, token), envOf(db, day), {}, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(day.names).toEqual([DATE]);
    expect([...day.calls].sort()).toEqual(["getPlanProgress", "getTargetsLedger"]); // 収支は DO が作る(読み取り)。この日は発走前なので null
    const body = (await response.json()) as Record<string, unknown>;
    expect(sortedKeys(body)).toEqual(["kaisai_date", "ledger", "now_ms", "ok", "races", "summary"]);
    expect(body["ledger"]).toBeNull();
    expect(body["ok"]).toBe(true);
    expect(body["kaisai_date"]).toBe(DATE);
    expect(body["now_ms"]).toBe(NOW.getTime());
    expect(body["summary"]).toBe("分析済み 2 レース中、狙い目 1(見送り 1)");
    const races = body["races"] as Record<string, unknown>[];
    expect(races.map((r) => r["race_id"])).toEqual([R11, R12]);
    expect(races[0]).toMatchObject({ analysis_id: 11, place: "東京11R", pick: "◎7", start_time: "15:40", start_ms: Date.parse("2026-10-17T06:40:00Z"), source: "analysis", round: null, bet_count: 5, total_stake: 1200, max_ev: 1.42, skipped: false, detail: "5点 1,200円 EV 1.42・分析時" });
    expect(races[1]).toMatchObject({ analysis_id: 12, pick: null, source: "close", round: 1, skipped: true, detail: "見送り・発走5分前の再計算で0点" });
  });

  it("D1 は 4 回の batch(最新の分析 1 文・買い目 1 文・再計算 2 文・◎ 1 文)で読む", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    await handle(get(`/api/targets?kaisai_date=${DATE}`, token), envOf(db, fakeDay()), {}, deps);
    expect([...db.batches].sort()).toEqual([1, 1, 1, 2]);
  });

  it("表示対象が 1 つも無い日(買い目も再計算の買い目も無い): ◎の batch を流さない(馬の表を読まない)", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    db.rows.bets = [];
    db.rows.closeRounds = [];
    db.rows.closeBets = [];
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, token), envOf(db, fakeDay()), {}, deps);
    expect(response.status).toBe(200);
    expect([...db.batches].sort()).toEqual([1, 1, 2]);
    expect(db.sqls.some((sql) => sql.includes("FROM analysis_horses"))).toBe(false);
    expect(((await response.json()) as { races: unknown[] }).races).toEqual([]);
  });

  it("分析が 1 件も無い日: 200 で空。DO を呼ばない(日付を変えて DO を作らせない)", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    db.rows.analyses = [];
    const day = fakeDay();
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, token), envOf(db, day), {}, deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["races"]).toEqual([]);
    expect(body["summary"]).toBe("まだ分析されたレースがありません");
    expect(day.names).toEqual([]);
    expect(day.calls).toEqual([]);
  });

  it("DO の失敗は 503 にしない: 200 で、発走時刻なし(場・R は race_id から)", async () => {
    const { deps, token } = await setup();
    const day = fakeDay();
    day.planImpl = async () => {
      throw new Error("DO down");
    };
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, token), envOf(fakeDb(), day), {}, deps);
    expect(response.status).toBe(200);
    const races = ((await response.json()) as { races: Record<string, unknown>[] }).races;
    expect(races).toHaveLength(2);
    expect(races.every((r) => r["start_ms"] === null && r["start_time"] === null)).toBe(true);
    expect(races[0]!["place"]).toBe("東京11R");
  });

  it("再計算の表が無い(再計算の batch が失敗)でも 200: 分析時の提案で出す", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    db.failClose = true;
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, token), envOf(db, fakeDay()), {}, deps);
    expect(response.status).toBe(200);
    const races = ((await response.json()) as { races: Record<string, unknown>[] }).races;
    expect(races.map((r) => [r["race_id"], r["source"], r["skipped"]])).toEqual([
      [R11, "analysis", false],
      [R12, "analysis", false],
    ]);
  });

  it("D1 の主の読み取りが失敗したら 503(型だけ。例外の文面・SQL は出さない)", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    db.failMain = true;
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, token), envOf(db, fakeDay()), {}, deps);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "d1-error" } });
    expect(text).not.toContain("injected");
    expect(text).not.toContain("SELECT");
  });

  it("D1 の最初の読み取りが失敗したら 503", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    db.db = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => {
        throw new Error("D1_ERROR: down");
      },
    } as unknown as Env["DB"];
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, token), envOf(db, fakeDay()), {}, deps);
    expect(response.status).toBe(503);
    expect(JSON.parse(await response.text())).toEqual({ ok: false, error: { type: "d1-error" } });
  });

  it("GET だけ: HEAD・POST は 405(Allow に GET)で、D1・DO を呼ばない", async () => {
    const { deps, token } = await setup();
    for (const method of ["HEAD", "POST"]) {
      const db = fakeDb();
      const day = fakeDay();
      const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, token, { method }), envOf(db, day), {}, deps);
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow") ?? "", method).toContain("GET");
      expect(db.sqls, method).toEqual([]);
      expect(day.names, method).toEqual([]);
    }
  });

  it("別サイトからの GET(Sec-Fetch-Site: cross-site)は 403 origin-mismatch。同じオリジン・アドレスバー(none)・ヘッダなしは通る", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    const day = fakeDay();
    const cross = await handle(get(`/api/targets?kaisai_date=${DATE}`, token, { headers: { "sec-fetch-site": "cross-site" } }), envOf(db, day), {}, deps);
    expect(cross.status).toBe(403);
    expect(await cross.json()).toEqual({ ok: false, error: { type: "origin-mismatch" } });
    expect(db.sqls).toEqual([]);
    expect(day.names).toEqual([]);
    for (const site of ["same-origin", "none"]) {
      const ok = await handle(get(`/api/targets?kaisai_date=${DATE}`, token, { headers: { "sec-fetch-site": site } }), envOf(fakeDb(), fakeDay()), {}, deps);
      expect(ok.status, site).toBe(200);
    }
  });

  it.each([
    ["kaisai_date なし", "/api/targets"],
    ["不正な日付(桁が足りない)", "/api/targets?kaisai_date=2026101"],
    ["実在しない日付", "/api/targets?kaisai_date=20261340"],
    ["日付が文字", "/api/targets?kaisai_date=abcdefgh"],
    ["未知のキー", `/api/targets?kaisai_date=${DATE}&venue=central`],
    ["キーの重複", `/api/targets?kaisai_date=${DATE}&kaisai_date=${DATE}`],
    ["長すぎる日付", `/api/targets?kaisai_date=${"9".repeat(500)}`],
  ])("入力の検証: %s は 400。D1 も DO も呼ばない", async (_name, path) => {
    const { deps, token } = await setup();
    const db = fakeDb();
    const day = fakeDay();
    const response = await handle(get(path, token), envOf(db, day), {}, deps);
    expect(response.status).toBe(400);
    expect(db.sqls).toEqual([]);
    expect(day.names).toEqual([]);
  });

  it("応答のキーは固定(ホワイトリスト)。D1 の行・DO の返り値に余計なキー(秘密のカナリア)があっても、本文に出ない。R2 には触れない", async () => {
    const { deps, token } = await setup();
    const db = fakeDb();
    const CANARY = "CANARY-SECRET";
    db.rows.analyses = db.rows.analyses.map((r) => ({ ...r, secret: CANARY }));
    db.rows.bets = db.rows.bets.map((r) => ({ ...r, secret: CANARY }));
    const day = fakeDay();
    day.planImpl = async () => ({ ...PLAN, webhookUrl: CANARY, rows: PLAN.rows.map((r) => ({ ...r, token: CANARY })) }) as never;
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, token), envOf(db, day, { DISCORD_WEBHOOK_URL: CANARY }), {}, deps);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("CANARY");
    const races = (JSON.parse(text) as { races: unknown[] }).races;
    expect(races).toHaveLength(2); // 前提: 行がある(キーの検査が空振りしない)
    expect(sortedKeys(races[0])).toEqual(["analysis_id", "bet_count", "detail", "max_ev", "pick", "place", "race_id", "result", "result_state", "round", "skipped", "source", "start_ms", "start_time", "total_stake"]);
  });
});

/**
 * Issue #361: 収支の途中経過。**計算は日単位の DO の RPC `getTargetsLedger` が行う**(Worker Free の CPU 10ms に収まらないため)。Worker は、その結果(素の配列・数値)を
 * 応答の `ledger`・各行の `result` に載せるだけで、収支のために D1 は読まない。DO の失敗は収支だけ null にして一覧は 200 のまま。
 */
describe("GET /api/targets: 収支の途中経過(DO の RPC の結果を載せる。Issue #361)", () => {
  const AFTER = new Date("2026-10-17T07:30:00Z");
  const settled = (raceId: string, stake: number, payout: number) => ({ raceId, state: "settled" as const, stake, payout, refundedStake: 0, hit: payout > 0, reason: null });
  const pending = (raceId: string) => ({ raceId, state: "pending" as const, stake: 0, payout: 0, refundedStake: 0, hit: false, reason: null });
  const WIRE: TargetsLedgerWire = { races: [settled(R11, 300, 4500), pending(R12)], total: { raceCount: 1, stake: 300, payout: 4500, recoveryRate: 15 }, waitingCount: 1, noneCount: 0 };
  const run = async (db: FakeDb, day: FakeDay, now: Date = AFTER, asViewer = false) => {
    const { deps, token, viewer } = await setup(now);
    const response = await handle(get(`/api/targets?kaisai_date=${DATE}`, asViewer ? viewer : token), envOf(db, day), {}, deps);
    return { response, body: (await response.json()) as Record<string, any> };
  };

  it("DO の結果を、上部の合計と各行の結果に載せる。再計算を採った行(R12)には基準を明記しない(R12 は未確定)。サーバの時刻と開催日を DO に渡す", async () => {
    const day = fakeDay();
    day.ledgerImpl = async () => WIRE;
    const { response, body } = await run(fakeDb(), day);
    expect(response.status).toBe(200);
    expect(day.ledgerInputs).toEqual([{ kaisaiDate: DATE, nowMs: AFTER.getTime() }]);
    expect(body["ledger"]).toBe("確定 1R: 投資 300円 / 回収 4,500円 / 回収率 1500.0%(結果待ち 1R)");
    const races = body["races"] as Record<string, any>[];
    expect(races.map((r) => [r["race_id"], r["source"], r["result_state"], r["result"]])).toEqual([
      [R11, "analysis", "settled", "的中 +4,200円"],
      [R12, "close", "pending", "結果待ち"],
    ]);
  });

  it("Worker は収支のために D1 を読まない(分析・配分・買い目・結果・払戻の SQL を流さない)。読み取りの文は一覧のものだけ", async () => {
    const db = fakeDb();
    const day = fakeDay();
    day.ledgerImpl = async () => WIRE;
    await run(db, day);
    expect(db.sqls.some((sql) => sql.includes("race_results") || sql.includes("race_combo_payout") || sql.includes("analysis_allocation_meta") || sql.includes("history_cutoff_date"))).toBe(false);
    expect(db.sqls.length).toBeGreaterThan(0); // 前提: 一覧の読みは流れている(検査が空振りでない)
  });

  it("閲覧者にも同じ内容(ユーザーの決定)", async () => {
    const day = fakeDay();
    day.ledgerImpl = async () => WIRE;
    const admin = await run(fakeDb(), day);
    const viewer = await run(fakeDb(), day, AFTER, true);
    expect(viewer.response.status).toBe(200);
    expect(viewer.body).toEqual(admin.body);
    expect(admin.body["ledger"]).not.toBeNull(); // 前提
  });

  it("DO の RPC が null(発走前)なら、収支は null・各行の結果も null", async () => {
    const { body } = await run(fakeDb(), fakeDay());
    expect(body["ledger"]).toBeNull();
    const races = body["races"] as Record<string, any>[];
    expect(races).toHaveLength(2);
    expect(races.every((r) => r["result"] === null && r["result_state"] === null)).toBe(true);
  });

  it("DO の RPC が失敗(同期の例外も含む)しても一覧は 200 のまま。収支だけ null。例外の文面は出さない", async () => {
    for (const impl of [async () => { throw new Error("DO injected"); }, () => { throw new Error("DO sync injected"); }]) {
      const day = fakeDay();
      day.ledgerImpl = impl as never;
      const { response, body } = await run(fakeDb(), day);
      expect(response.status).toBe(200);
      expect(body["ledger"]).toBeNull();
      expect((body["races"] as unknown[]).length).toBe(2); // 前提: 一覧は出ている
      expect(JSON.stringify(body)).not.toContain("injected");
    }
  });

  it("計画の失敗(getPlanProgress)でも収支の RPC は流れる(DO が自分の計画で判断する)", async () => {
    const day = fakeDay();
    day.planImpl = async () => {
      throw new Error("DO down");
    };
    day.ledgerImpl = async () => WIRE;
    const { response, body } = await run(fakeDb(), day);
    expect(response.status).toBe(200);
    expect(body["ledger"]).toContain("確定 1R");
  });

  it("分析が 1 件も無い日は DO を呼ばない(収支の RPC も)", async () => {
    const db = fakeDb();
    db.rows.analyses = [];
    const day = fakeDay();
    const { body } = await run(db, day);
    expect(body["ledger"]).toBeNull();
    expect(day.calls).toEqual([]);
  });
});
