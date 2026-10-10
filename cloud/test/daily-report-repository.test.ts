import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import type { ReportRecord } from "../src/daily-report-core";
import { buildDayStats } from "../src/daily-report-digest";
import { D1ReportSource, D1ReportStore, LIST_DAY_ANALYSES_SQL, READ_RESULTS_SQL } from "../src/daily-report-repository";
import { D1ResultStore } from "../src/result-repository";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, spyBucket, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #235: 日報の D1 への保存・読み出し(`D1ReportStore`)と、日報の材料の読み出し(`D1ReportSource`)を、ローカル(workerd)の D1・R2 で確かめる。
 * migration 0010 は `wrangler d1 migrations apply --local`(CI と同じ実コマンド)で適用される。
 */

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

const DATE = "20261010";
const raceIdOf = (n: number): string => `2026050308${String(n).padStart(2, "0")}`;

function record(over: Partial<ReportRecord> = {}): ReportRecord {
  return {
    kaisaiDate: DATE, createdAt: "2026-10-10T11:00:00.000Z", model: "claude-sonnet-5-5", raceCount: 2, totalStake: 400, totalReturn: 1400, summary: "総括",
    body: { format: 1, kaisaiDate: DATE, stats: buildDayStats([]), races: [], narrative: { summary: "総括", good: ["良い"], improve: ["悪い"], races: [] }, narrativeRaw: null, note: null },
    llmCallsJson: null,
    ...over,
  };
}

describe("D1ReportStore", () => {
  const store = () => new D1ReportStore({ db: local.db });

  it("保存して読める: 本文(JSON)は往復で同じ。一覧には本文を含めない", async () => {
    const s = store();
    expect(await s.hasReport(DATE)).toBe(false);
    expect(await s.saveReport(record())).toBe("saved");
    expect(await s.hasReport(DATE)).toBe(true);
    const got = await s.getReport(DATE);
    expect(got).toStrictEqual(record());
    const list = await s.listReports(10);
    expect(list).toStrictEqual([{ kaisaiDate: DATE, createdAt: "2026-10-10T11:00:00.000Z", model: "claude-sonnet-5-5", raceCount: 2, totalStake: 400, totalReturn: 1400, summary: "総括" }]);
    expect(JSON.stringify(list)).not.toContain("body");
  });

  it("同じ日が既にあれば上書きせず exists(1 日 1 回で確定)", async () => {
    const s = store();
    await s.saveReport(record({ summary: "最初" }));
    expect(await s.saveReport(record({ summary: "後から", totalReturn: 9 }))).toBe("exists");
    expect((await s.getReport(DATE))!.summary).toBe("最初");
    expect((await s.getReport(DATE))!.totalReturn).toBe(1400);
  });

  it("文章の無い日報(model・summary・llm_calls が NULL)も保存・読み出せる", async () => {
    const s = store();
    await s.saveReport(record({ model: null, summary: null, llmCallsJson: null }));
    const got = (await s.getReport(DATE))!;
    expect(got.model).toBeNull();
    expect(got.summary).toBeNull();
  });

  it("無い日は null。本文が壊れた行(JSON でない)も null(画面を壊さない)", async () => {
    const s = store();
    expect(await s.getReport("20200101")).toBeNull();
    await local.db.prepare("INSERT INTO daily_reports (kaisai_date, created_at, race_count, total_stake, total_return, body_json) VALUES ('20200102', 'x', 0, 0, 0, '{broken')").run();
    expect(await s.getReport("20200102")).toBeNull();
  });

  it("一覧は開催日の新しい順で、limit で切る", async () => {
    const s = store();
    for (const d of ["20261008", "20261010", "20261009"]) {
      await s.saveReport(record({ kaisaiDate: d, body: { ...record().body, kaisaiDate: d } }));
    }
    expect((await s.listReports(10)).map((r) => r.kaisaiDate)).toEqual(["20261010", "20261009", "20261008"]);
    expect((await s.listReports(2)).map((r) => r.kaisaiDate)).toEqual(["20261010", "20261009"]);
  });

  it("取り残しの列挙: 範囲内で、分析があるのに日報が無い日だけ(日報がある日・分析が無い日・範囲外・開催日 NULL は含まない)", async () => {
    const add = (raceId: string, kaisaiDate: string | null, i = 0) =>
      local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES (?, ?, 0, ?)").bind(raceId, `2026-10-06T00:00:${String(i).padStart(2, "0")}.000Z`, kaisaiDate).run();
    await add("A1", "20261007");
    await add("A2", "20261007", 1); // 同じ日に複数あっても 1 日
    await add("B1", "20261008"); // 日報あり
    await add("C1", "20261009");
    await add("OLD", "20261001"); // 範囲外
    await add("NODATE", null);
    const s = store();
    await s.saveReport(record({ kaisaiDate: "20261008", body: { ...record().body, kaisaiDate: "20261008" } }));
    expect(await s.listDatesNeedingReport("20261007", "20261009")).toEqual(["20261007", "20261009"]);
    expect(await s.listDatesNeedingReport("20261010", "20261012")).toEqual([]);
  });
});

function analysisRecord(n: number, analyzedAt: string, over: Partial<AnalysisRecord> = {}): AnalysisRecord {
  const meta = contractCases[0]!.record.allocation!.meta;
  return {
    raceId: raceIdOf(n),
    analyzedAt,
    kaisaiDate: DATE,
    promptVersion: "v-test",
    rawResponse: "raw",
    horses: [1, 2, 3].map((umaban) => ({ umaban, prior: 0.3, adjustedProb: 0.3 + umaban / 100, placeOddsMin: 1.5, ev: 1.1, isPositive: umaban === 1, contributions: { umaban }, mark: umaban === 1 ? "◎" : null, reason: `根拠${umaban}` })),
    allocation: { meta, bets: [{ betType: "win", comboKey: "01", stake: 300, odds: 4.5, ev: 1.2 }, { betType: "wide", comboKey: "0102", stake: 200, odds: 6, ev: 1.1 }] },
    ...over,
  } as AnalysisRecord;
}

describe("D1ReportSource", () => {
  const analyses = () => new D1AnalysisStore({ db: local.db, bucket: local.r2 });
  const source = () => new D1ReportSource({ db: local.db, analyses: analyses() });

  it("listDayAnalyses: その開催日の分析を、レースごとに分析時刻が最新の 1 件に絞り、レース ID 昇順で返す(他の日・開催日 NULL は含まない)", async () => {
    const a = analyses();
    const old = await a.saveAnalysis(analysisRecord(2, "2026-10-10T01:00:00.000Z"));
    const latest = await a.saveAnalysis(analysisRecord(2, "2026-10-10T05:00:00.000Z"));
    const first = await a.saveAnalysis(analysisRecord(1, "2026-10-10T04:00:00.000Z"));
    await a.saveAnalysis(analysisRecord(3, "2026-10-10T04:00:00.000Z", { kaisaiDate: "20261009" }));
    await a.saveAnalysis(analysisRecord(4, "2026-10-10T04:00:00.000Z", { kaisaiDate: null }));
    expect(old.id).not.toBe(latest.id);
    const list = await source().listDayAnalyses(DATE);
    expect(list).toStrictEqual([
      { raceId: raceIdOf(1), analysisId: first.id },
      { raceId: raceIdOf(2), analysisId: latest.id },
    ]);
  });

  it("同じ分析時刻なら id の大きい方を採る", async () => {
    const a = analyses();
    await a.saveAnalysis(analysisRecord(1, "2026-10-10T04:00:00.000Z"));
    const second = await a.saveAnalysis(analysisRecord(1, "2026-10-10T04:00:00.000Z"));
    expect((await source().listDayAnalyses(DATE)).map((r) => r.analysisId)).toEqual([second.id]);
  });

  it("readRaces: 分析のビュー(印・根拠・配分)と結果(着順・払戻・組合せ払戻)を返し、結果の無いレースは result=undefined", async () => {
    const a = analyses();
    const r1 = await a.saveAnalysis(analysisRecord(1, "2026-10-10T04:00:00.000Z"));
    const r2 = await a.saveAnalysis(analysisRecord(2, "2026-10-10T04:30:00.000Z"));
    await new D1ResultStore({ db: local.db }).saveResult(
      raceIdOf(1),
      [
        { umaban: 1, finishPosition: 1, placePayout: 150, winPayout: 450 },
        { umaban: 2, finishPosition: 2, placePayout: 180, winPayout: null },
        { umaban: 3, finishPosition: 3, placePayout: 210, winPayout: null },
      ],
      "芝",
      { wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 900 }] } },
    );
    const [one, two] = await source().readRaces([
      { raceId: raceIdOf(1), analysisId: r1.id },
      { raceId: raceIdOf(2), analysisId: r2.id },
    ]);
    expect(one!.view.raceId).toBe(raceIdOf(1));
    expect(one!.view.horses.find((h) => h.umaban === 1)).toMatchObject({ mark: "◎", reason: "根拠1" });
    expect(one!.view.allocation!.bets.map((b) => b.betType)).toEqual(["win", "wide"].sort());
    expect(one!.result).toBeDefined();
    expect(one!.result!.horses.map((h) => [h.umaban, h.finishPosition, h.winPayout, h.placePayout])).toEqual([
      [1, 1, 450, 150],
      [2, 2, null, 180],
      [3, 3, null, 210],
    ]);
    expect(one!.result!.combos["wide"]).toStrictEqual({ imported: true, payouts: [{ comboKey: "0102", payout: 900 }] });
    expect(two!.result).toBeUndefined();
  });

  it("readRaces: 存在しない分析 id は null。空の入力は D1 を引かない", async () => {
    const { db, prepared } = spyDb(local.db);
    const s = new D1ReportSource({ db, analyses: new D1AnalysisStore({ db, bucket: local.r2 }) });
    expect(await s.readRaces([])).toStrictEqual([]);
    expect(prepared).toEqual([]);
    expect(await s.readRaces([{ raceId: raceIdOf(1), analysisId: 99999 }])).toStrictEqual([null]);
  });

  it("サブリクエストの予算: 8 レースの読み出しで、D1 の呼び出し(prepare/batch)と R2 の get の合計が 40 以下", async () => {
    const a = analyses();
    const items = [] as { raceId: string; analysisId: number }[];
    for (let n = 1; n <= 8; n += 1) {
      const saved = await a.saveAnalysis(analysisRecord(n, `2026-10-10T04:00:0${n}.000Z`));
      items.push({ raceId: raceIdOf(n), analysisId: saved.id });
    }
    const dbSpy = spyDb(local.db);
    const bucketSpy = spyBucket(local.r2);
    const s = new D1ReportSource({ db: dbSpy.db, analyses: new D1AnalysisStore({ db: dbSpy.db, bucket: bucketSpy.bucket }) });
    const out = await s.readRaces(items);
    expect(out.every((x) => x !== null)).toBe(true);
    expect(bucketSpy.calls.filter((c) => c.op === "get")).toHaveLength(8); // 前提: R2 の詳細を実際に読んでいる
    // D1 の呼び出し数 = batch の回数 + 単独の run/first の回数。prepared には batch に入れた文も数えられるので、batch の回数だけを数える。
    const d1Calls = dbSpy.batches.length + dbSpy.prepared.filter((sql) => /UPDATE r2_ops|INSERT INTO r2_ops/.test(sql)).length;
    const total = d1Calls + bucketSpy.calls.length;
    expect(total).toBeLessThanOrEqual(40);
    expect(total).toBeGreaterThanOrEqual(8 * 3); // 空振り防止: 1 レースあたり 3 以上(詳細の batch・R2 の get)を実際に数えている
  });

  it("結果の SQL は束縛 1 つ(JSON 配列)で、レース数に依らない", () => {
    expect(LIST_DAY_ANALYSES_SQL).toContain("kaisai_date = ?");
    expect(READ_RESULTS_SQL.results.match(/\?/g)).toHaveLength(1);
    expect(READ_RESULTS_SQL.combos.match(/\?/g)).toHaveLength(1);
    expect(READ_RESULTS_SQL.imports.match(/\?/g)).toHaveLength(1);
  });
});
