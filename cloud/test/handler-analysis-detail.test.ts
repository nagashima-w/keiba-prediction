import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildRaceSnapshot } from "../../packages/app/src/main/analysis-export";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { D1AnalysisStore, type AnalysisDb } from "../src/analysis-repository";
import { handle, type Env } from "../src/handler";
import { monthKey, R2_FENCE_LIMITS } from "../src/r2-fence";
import { contractCases } from "./fixtures-contract";
import { GOOD_ENV, localKeys, makeKey, NOW, signToken } from "./helpers";
import { openLocalBindings, spyBucket, type LocalBindings } from "./local-bindings";
import { scrapeFixtureRace } from "./pipeline-fixtures";

/**
 * Issue #183(#165-a): `GET /api/analyses/{id}`。分析1件を、馬名つき(R2 の詳細の raceSnapshot から)・配分つきで返す。
 * 入口の検証(400。D1・R2 に触れない)・404・503 は偽の D1/R2。**馬名つきの実体は、ローカル(workerd)の本物の D1・R2** に保存した分析を GET して確かめる
 * (R2 の柵の内側で読むこと・柵に達したら馬名なしで返すことは、偽の D1 では確かめられない)。
 */

const ORIGIN = "https://cloud.invalid";
const RAW_SECRET = "RAW-RESPONSE-SECRET-aaaa";
const CONTRIB_SECRET = "CONTRIB-SECRET-bbbb";
const JOCKEY_SECRET_FIELD = "jockeyName";

const NOT_CALLED = (): never => {
  throw new Error("呼ばれない想定");
};

function baseEnv(over: Partial<Env> = {}): Env {
  return {
    ...GOOD_ENV,
    NETKEIBA_GATE: { idFromName: NOT_CALLED, get: NOT_CALLED },
    DB: { prepare: NOT_CALLED, batch: NOT_CALLED } as unknown as Env["DB"],
    ANALYSIS_DETAIL: { get: NOT_CALLED, put: NOT_CALLED } as unknown as Env["ANALYSIS_DETAIL"],
    RACE_DAY: { idFromName: NOT_CALLED, get: NOT_CALLED },
    ...over,
  };
}

async function setup() {
  const key = await makeKey("k1");
  const deps = { keys: () => localKeys(key), now: () => NOW, log: () => {} };
  const token = await signToken(key);
  return { deps, token };
}

function get(path: string, init: { token?: string; method?: string } = {}): Request {
  const headers = new Headers();
  if (init.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", init.token);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers });
}

/** 偽の D1: 発行された文と batch の数を記録し、batch は指定の結果を返す(または throw)。 */
function fakeDb(batchImpl: () => Promise<unknown[]>) {
  const prepared: string[] = [];
  const batches: number[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return { bind: () => ({}) };
    },
    async batch(statements: unknown[]) {
      batches.push(statements.length);
      return batchImpl();
    },
  } as unknown as Env["DB"];
  return { db, prepared, batches };
}

describe("GET /api/analyses/{id}: 入口(Issue #183。D1・R2 に触れない)", () => {
  it.each([
    ["0", "0"],
    ["負", "-1"],
    ["小数", "1.5"],
    ["英字", "abc"],
    ["先頭の 0", "01"],
    ["先頭の 0(複数)", "007"],
    ["上限 + 1", "2147483648"],
    ["11 桁", "12345678901"],
    ["指数表記", "1e3"],
    ["パーセントエンコードの数字", "%31"],
    ["空白つき", "%201"],
  ])("id が %s(%s)は 400 で、D1 にも R2 にも触れない", async (_name, id) => {
    const { deps, token } = await setup();
    const fake = fakeDb(async () => {
      throw new Error("呼ばれない想定");
    });
    const response = await handle(get(`/api/analyses/${id}`, { token }), baseEnv({ DB: fake.db }), {}, deps);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { type: string } }).error.type).toBe("bad-request");
    expect(fake.prepared).toEqual([]);
    expect(fake.batches).toEqual([]);
  });

  it("クエリは受け付けない(付いていれば 400。D1 に触れない)。付いていない `?` だけは通る", async () => {
    const { deps, token } = await setup();
    const fake = fakeDb(async () => [{ results: [] }, { results: [] }, { results: [] }]);
    for (const query of ["?x=1", "?id=1", "?limit=5"]) {
      expect((await handle(get(`/api/analyses/1${query}`, { token }), baseEnv({ DB: fake.db }), {}, deps)).status, query).toBe(400);
    }
    expect(fake.batches).toEqual([]);
    expect((await handle(get("/api/analyses/1?", { token }), baseEnv({ DB: fake.db }), {}, deps)).status).toBe(404);
    expect(fake.batches).toEqual([3]);
  });

  it("id の境界: 1 と 2147483647 は検証を通り(D1 を引く。無ければ 404)、無い id は 404 で、配分は引かない(batch は詳細の1回だけ)", async () => {
    const { deps, token } = await setup();
    for (const id of ["1", "2147483647", "123456"]) {
      const fake = fakeDb(async () => [{ results: [] }, { results: [] }, { results: [] }]);
      const response = await handle(get(`/api/analyses/${id}`, { token }), baseEnv({ DB: fake.db }), {}, deps);
      expect(response.status, id).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: { type: "not-found" } });
      expect(fake.batches, id).toEqual([3]);
    }
  });

  it("認証できなければ 403 で、D1 に触れない", async () => {
    const { deps } = await setup();
    const fake = fakeDb(async () => [{ results: [] }, { results: [] }, { results: [] }]);
    const response = await handle(get("/api/analyses/1"), baseEnv({ DB: fake.db }), {}, deps);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
    expect(fake.batches).toEqual([]);
  });

  it("GET だけ(HEAD・POST は 405。D1 を引かない)。末尾スラッシュ・下位パスは 404", async () => {
    const { deps, token } = await setup();
    const fake = fakeDb(async () => [{ results: [] }, { results: [] }, { results: [] }]);
    const head = await handle(get("/api/analyses/1", { token, method: "HEAD" }), baseEnv({ DB: fake.db }), {}, deps);
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");
    expect((await handle(get("/api/analyses/1", { token, method: "POST" }), baseEnv({ DB: fake.db }), {}, deps)).status).toBe(405);
    for (const path of ["/api/analyses/1/", "/api/analyses/1/x", "/api/analyses//1"]) {
      expect((await handle(get(path, { token }), baseEnv({ DB: fake.db }), {}, deps)).status, path).toBe(404);
    }
    expect(fake.batches).toEqual([]);
  });

  it("ルーティングの衝突なし: /api/analyses/status は状態(id として 400 にならない)・/api/analyses/run の GET は 405(Allow: POST)", async () => {
    const { deps, token } = await setup();
    const fake = fakeDb(async () => {
      throw new Error("呼ばれない想定");
    });
    const status = await handle(get("/api/analyses/status", { token }), baseEnv({ DB: fake.db }), {}, deps);
    expect(status.status).toBe(400);
    expect(JSON.stringify(await status.json())).toContain("kaisai_date"); // status の検証メッセージ(id の検証ではない)
    const run = await handle(get("/api/analyses/run", { token }), baseEnv({ DB: fake.db }), {}, deps);
    expect(run.status).toBe(405);
    expect(run.headers.get("allow")).toBe("POST");
    expect(fake.batches).toEqual([]);
  });

  it("D1 が失敗したら 503 d1-error(例外の文面を返さない)", async () => {
    const { deps, token } = await setup();
    const fake = fakeDb(async () => {
      throw new Error("D1_ERROR: SECRET-sql-detail");
    });
    const response = await handle(get("/api/analyses/5", { token }), baseEnv({ DB: fake.db }), {}, deps);
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "d1-error" } });
    expect(text).not.toContain("SECRET");
  });
});

let local: LocalBindings;
beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
});

const RACE_ID = "202603020211";

async function record(over: Partial<AnalysisRecord> = {}): Promise<AnalysisRecord> {
  const { race } = await scrapeFixtureRace();
  const meta = contractCases[0]!.record.allocation!.meta;
  return {
    raceId: RACE_ID,
    analyzedAt: "2026-06-28T05:00:00.000Z",
    kaisaiDate: "20260628",
    promptVersion: "v-test",
    rawResponse: RAW_SECRET,
    raceSnapshot: JSON.parse(JSON.stringify(buildRaceSnapshot(race))),
    horses: race.horses.map((h) => ({
      umaban: h.shutuba.umaban,
      prior: 0.1,
      adjustedProb: 0.1,
      placeOddsMin: 2,
      ev: 1.1,
      isPositive: true,
      contributions: { secret: CONTRIB_SECRET },
      mark: null,
      reason: null,
    })),
    allocation: {
      meta,
      bets: [
        { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
        { betType: "wide", comboKey: "0102", stake: 200, odds: 5.5, ev: 1.3 },
      ],
    },
    ...over,
  };
}

interface View {
  id: number;
  raceId: string;
  detail: string;
  race: Record<string, unknown>;
  horses: { umaban: number; name: string | null; highlights: string[]; concerns: string[] }[];
  allocation: { bets: unknown[] } | null;
  [key: string]: unknown;
}

async function getView(id: number, bucket: Env["ANALYSIS_DETAIL"], db: AnalysisDb = local.db) {
  const { deps, token } = await setup();
  const response = await handle(get(`/api/analyses/${id}`, { token }), baseEnv({ DB: db as Env["DB"], ANALYSIS_DETAIL: bucket }), {}, deps);
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as { ok: boolean; analysis: View } };
}

describe("GET /api/analyses/{id}: ローカルの D1・R2 で保存した分析を読む(Issue #183)", () => {
  it("保存した分析を、馬名つき(raceSnapshot から)・配分つきで返す。rawResponse・contributions・騎手などは返さない。R2 の GET は1回", async () => {
    const rec = await record();
    const { race } = await scrapeFixtureRace();
    const saved = await new D1AnalysisStore({ db: local.db, bucket: local.r2 }).saveAnalysis(rec);
    expect(saved.detail).toBe("stored");
    const spy = spyBucket(local.r2);
    const { status, text, body } = await getView(saved.id, spy.bucket);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const view = body.analysis;
    expect(view).toMatchObject({ id: saved.id, raceId: RACE_ID, kaisaiDate: "20260628", detail: "present", race: { venueName: "福島", raceNumber: 11, raceName: race.race.raceName } });
    const expectedNames = view.horses.map((h) => race.horses.find((x) => x.shutuba.umaban === h.umaban)!.shutuba.name);
    expect(view.horses.map((h) => h.name)).toEqual(expectedNames);
    expect(view.horses.length).toBe(race.horses.length);
    expect(view.horses.every((h) => typeof h.name === "string" && h.name.length > 0)).toBe(true);
    expect(view.allocation!.bets).toEqual([
      { betType: "place", comboKey: "01", stake: 300, odds: 1.8, ev: 1.2 },
      { betType: "wide", comboKey: "0102", stake: 200, odds: 5.5, ev: 1.3 },
    ]);
    for (const secret of [RAW_SECRET, CONTRIB_SECRET, JOCKEY_SECRET_FIELD, "rawResponse", "contributions"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(spy.calls.filter((c) => c.op === "get")).toHaveLength(1);
    expect(spy.calls.filter((c) => c.op === "put")).toHaveLength(0);
  });

  it("単勝の想定・実際のオッズ(Issue #247): 実際は保存したスナップショットの winOdds(16頭ぶん)、想定は補正後の3着内率から(全馬が同じ 0.1 なら 16頭の均等 = 勝率 1/16 → 想定 12.8 倍)。oddsStatus も載る", async () => {
    const rec = await record();
    const { race } = await scrapeFixtureRace();
    const saved = await new D1AnalysisStore({ db: local.db, bucket: local.r2 }).saveAnalysis(rec);
    const view = (await getView(saved.id, spyBucket(local.r2).bucket)).body.analysis as unknown as {
      race: { oddsStatus: string | null };
      horses: { umaban: number; winProb: number | null; fairWinOdds: number | null; winOdds: number | null }[];
    };
    expect(view.horses).toHaveLength(16);
    expect(view.race.oddsStatus).toBe(race.odds.oddsStatus);
    for (const h of view.horses) {
      expect(h.winOdds, `馬番${h.umaban}`).toBe(race.odds.win[h.umaban]?.odds ?? null);
      expect(h.winProb!, `馬番${h.umaban}`).toBeCloseTo(1 / 16, 9);
      expect(h.fairWinOdds!, `馬番${h.umaban}`).toBeCloseTo(12.8, 6);
    }
    expect(view.horses.filter((h) => h.winOdds !== null).length, "前提: 実際のオッズが取れている馬がいる").toBeGreaterThan(8);
  });

  it("強調材料・懸念事項(Issue #197): 保存した馬ごとの highlights・concerns が応答の馬に載る。詳細(R2)の状態(present・missing・none)に依らない", async () => {
    const base = await record();
    const horses = base.horses.map((h, i) => (i === 0 ? { ...h, highlights: ["追い切り好時計", "内枠有利"], concerns: ["距離延長"] } : i === 1 ? { ...h, highlights: [], concerns: ["外枠"] } : h));
    expect(horses.length).toBeGreaterThan(2); // 前提: 3頭目以降(項目なし)がある
    const store = new D1AnalysisStore({ db: local.db, bucket: local.r2 });
    const present = await store.saveAnalysis({ ...base, horses });
    const view = (await getView(present.id, spyBucket(local.r2).bucket)).body.analysis;
    expect(view.detail).toBe("present");
    const items = (v: View) => v.horses.map((h) => [h.umaban, h.highlights, h.concerns] as const);
    const expected = horses.map((h) => [h.umaban, h.highlights ?? [], h.concerns ?? []] as const);
    expect(items(view)).toEqual(expected);
    // R2 の詳細が無い(none。Class A の柵で R2 に書かなかった)分析でも、同じ値が D1 から読める。
    await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, ?)").bind(monthKey(new Date()), R2_FENCE_LIMITS.classA, 0).run();
    const none = await store.saveAnalysis({ ...base, horses, analyzedAt: "2026-06-28T07:00:00.000Z" });
    expect(none.detail).toBe("skipped");
    const noneView = (await getView(none.id, spyBucket(local.r2).bucket)).body.analysis;
    expect(noneView.detail).toBe("none");
    expect(items(noneView)).toEqual(expected);
  });

  it("配分が無い分析は allocation: null(馬名は付く)", async () => {
    const rec = await record();
    const { allocation: _drop, ...noAllocation } = rec;
    const saved = await new D1AnalysisStore({ db: local.db, bucket: local.r2 }).saveAnalysis(noAllocation);
    const { body } = await getView(saved.id, spyBucket(local.r2).bucket);
    expect(body.analysis.allocation).toBeNull();
    expect(body.analysis.detail).toBe("present");
    expect(body.analysis.horses[0]!.name).not.toBeNull();
  });

  it("【R2 の柵】Class B が柵に達した月は、R2 を引かず(GET 0 回)、馬名なしの同じ形で返す(detail: missing)。D1 の要約・配分は残る", async () => {
    const saved = await new D1AnalysisStore({ db: local.db, bucket: local.r2 }).saveAnalysis(await record());
    await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, ?)").bind(monthKey(new Date()), 1, R2_FENCE_LIMITS.classB).run();
    const spy = spyBucket(local.r2);
    const { status, body } = await getView(saved.id, spy.bucket);
    expect(status).toBe(200);
    expect(spy.calls).toEqual([]);
    expect(body.analysis.detail).toBe("missing");
    expect(body.analysis.horses.length).toBeGreaterThan(0);
    expect(body.analysis.horses.every((h) => h.name === null)).toBe(true);
    expect(body.analysis.race["raceName"]).toBeNull();
    expect(body.analysis.race["venueName"]).toBe("福島");
    expect(body.analysis.allocation!.bets).toHaveLength(2);
  });

  it("R2 にオブジェクトが無い・R2 の get が失敗しても、200 で detail: missing(馬名なし)。クラッシュしない", async () => {
    const store = new D1AnalysisStore({ db: local.db, bucket: local.r2 });
    const saved = await store.saveAnalysis(await record());
    await local.r2.delete(`analyses/${saved.id}.json.gz`);
    const gone = await getView(saved.id, spyBucket(local.r2).bucket);
    expect(gone.status).toBe(200);
    expect(gone.body.analysis.detail).toBe("missing");
    expect(gone.body.analysis.horses.every((h) => h.name === null)).toBe(true);
    const saved2 = await store.saveAnalysis(await record({ analyzedAt: "2026-06-28T06:00:00.000Z" }));
    const failing = await getView(saved2.id, spyBucket(local.r2, { failGet: true }).bucket);
    expect(failing.status).toBe(200);
    expect(failing.body.analysis.detail).toBe("missing");
  });

  it("R2 に書かなかった分析(Class A の柵で skipped)は detail: none。R2 を引かず、馬名なしで返す", async () => {
    await local.db.prepare("INSERT OR REPLACE INTO r2_ops (ym, class_a, class_b) VALUES (?, ?, ?)").bind(monthKey(new Date()), R2_FENCE_LIMITS.classA, 0).run();
    const saved = await new D1AnalysisStore({ db: local.db, bucket: local.r2 }).saveAnalysis(await record());
    expect(saved.detail).toBe("skipped");
    const spy = spyBucket(local.r2);
    const { status, body } = await getView(saved.id, spy.bucket);
    expect(status).toBe(200);
    expect(body.analysis.detail).toBe("none");
    expect(spy.calls).toEqual([]);
    expect(body.analysis.horses.every((h) => h.name === null)).toBe(true);
  });

  it("無い id は 404(本物の D1)", async () => {
    const { status, body } = await getView(999999, spyBucket(local.r2).bucket);
    expect(status).toBe(404);
    expect(body).toEqual({ ok: false, error: { type: "not-found" } } as never);
  });

  it("配分の読み出し(2回目の D1)が失敗したら、配分だけ欠けた 200 にせず、全体を 503 d1-error にする(文面は返さない)", async () => {
    const saved = await new D1AnalysisStore({ db: local.db, bucket: local.r2 }).saveAnalysis(await record());
    let batchCount = 0;
    const flaky = {
      prepare: (sql: string) => local.db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        batchCount += 1;
        if (batchCount === 2) {
          throw new Error("D1_ERROR: SECRET-allocation-failure");
        }
        return local.db.batch(statements);
      },
    } as unknown as AnalysisDb;
    const { status, text } = await getView(saved.id, spyBucket(local.r2).bucket, flaky);
    expect(batchCount).toBe(2); // 前提: 配分の読み出しまで進んだ
    expect(status).toBe(503);
    expect(JSON.parse(text)).toEqual({ ok: false, error: { type: "d1-error" } });
    expect(text).not.toContain("SECRET");
  });
});
