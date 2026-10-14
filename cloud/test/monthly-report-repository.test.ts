import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { READ_PERIOD_SQL } from "../src/daily-report-repository";
import type { MonthlyReportRecord } from "../src/monthly-report-core";
import { D1MonthlySource, D1MonthlyStore, INSERT_MONTHLY_SQL, LAST_DAY_STATUS_SQL, MONTHLY_LIST_DEFAULT_LIMIT, MONTHLY_LIST_MAX_LIMIT, REPLACE_MONTHLY_SQL } from "../src/monthly-report-repository";
import { MONTHLY_PROMPT_VERSION } from "../src/monthly-report-prompt";
import { buildMonthStats } from "../src/monthly-stats";
import { D1ResultStore } from "../src/result-repository";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #279(#265-A): 月報の D1 への保存・読み出し(`D1MonthlyStore`)と、月の統計・最終日の状態の読み出し(`D1MonthlySource`)を、ローカル(workerd)の D1 で確かめる。
 * migration 0015 は `wrangler d1 migrations apply --local`(CI と同じ実コマンド)で適用される。
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

const MONTH = "202610";

function record(over: Partial<MonthlyReportRecord> = {}): MonthlyReportRecord {
  return {
    month: MONTH,
    createdAt: "2026-10-31T13:00:00.000Z",
    model: null,
    raceCount: 3,
    totalStake: 300,
    totalReturn: 800,
    summary: null,
    body: {
      format: 1,
      month: MONTH,
      stats: buildMonthStats({ races: [], bets: [], marks: [], results: [], combos: [], imports: [] }, { fromDate: "20261001", toDate: "20261031" }),
      lastDayPending: false,
      narrative: null,
      narrativeRaw: null,
      note: "LLM を使えなかったため、統計だけの月報です",
      promptVersion: MONTHLY_PROMPT_VERSION,
    },
    llmCallsJson: null,
    ...over,
  };
}

/** LLM の文章がある記録。 */
function narrated(over: Partial<MonthlyReportRecord> = {}): MonthlyReportRecord {
  const base = record();
  return record({
    model: "claude-sonnet-5-5",
    summary: "10 月の総括",
    body: { ...base.body, narrative: { summary: "10 月の総括", good: ["良い点"], improve: ["改善点"], outlook: ["来月"] }, note: null },
    llmCallsJson: '[{"ok":true}]',
    ...over,
  });
}

describe("D1MonthlyStore", () => {
  const store = () => new D1MonthlyStore({ db: local.db });

  it("保存して読める: 本文(JSON)は往復で同じ。一覧には本文を含めない", async () => {
    const s = store();
    expect(await s.hasReport(MONTH)).toBe(false);
    expect(await s.saveReport(record())).toBe("saved");
    expect(await s.hasReport(MONTH)).toBe(true);
    expect(await s.getReport(MONTH)).toStrictEqual(record());
    const list = await s.listReports(10);
    expect(list).toStrictEqual([{ month: MONTH, createdAt: "2026-10-31T13:00:00.000Z", model: null, raceCount: 3, totalStake: 300, totalReturn: 800, summary: null }]);
    expect(JSON.stringify(list)).not.toContain("body");
  });

  it("同じ月が既にあれば上書きせず exists(1 か月 1 回で確定)", async () => {
    const s = store();
    await s.saveReport(record({ raceCount: 3 }));
    expect(await s.saveReport(record({ raceCount: 99, totalReturn: 1 }))).toBe("exists");
    expect((await s.getReport(MONTH))!.raceCount).toBe(3);
    expect((await s.getReport(MONTH))!.totalReturn).toBe(800);
  });

  it("無い月は null。本文が壊れた行(JSON でない)も null(画面を壊さない)", async () => {
    const s = store();
    expect(await s.getReport("202601")).toBeNull();
    await local.db.prepare("INSERT INTO monthly_reports (month, created_at, race_count, total_stake, total_return, body_json) VALUES ('202609', 'x', 1, 0, 0, 'これは JSON ではない')").run();
    expect(await s.getReport("202609")).toBeNull();
  });

  it("一覧は月の新しい順で、limit で切る。limit の範囲外は RangeError", async () => {
    const s = store();
    for (const m of ["202608", "202610", "202609"]) {
      await s.saveReport(record({ month: m, body: { ...record().body, month: m } }));
    }
    expect((await s.listReports(10)).map((r) => r.month)).toEqual(["202610", "202609", "202608"]);
    expect((await s.listReports(2)).map((r) => r.month)).toEqual(["202610", "202609"]);
    expect(MONTHLY_LIST_DEFAULT_LIMIT).toBeLessThanOrEqual(MONTHLY_LIST_MAX_LIMIT);
    await expect(s.listReports(0)).rejects.toThrow(RangeError);
    await expect(s.listReports(MONTHLY_LIST_MAX_LIMIT + 1)).rejects.toThrow(RangeError);
  });

  it("通常の保存の文は INSERT OR IGNORE のまま(上書きは作り直し専用の REPLACE_MONTHLY_SQL だけ)", () => {
    expect(INSERT_MONTHLY_SQL).toMatch(/^INSERT OR IGNORE INTO monthly_reports /);
    expect(INSERT_MONTHLY_SQL).not.toMatch(/ON CONFLICT|UPDATE|DELETE/i);
  });
});

describe("D1MonthlyStore.replaceReport(Issue #280: 作り直しの上書き)", () => {
  const store = () => new D1MonthlyStore({ db: local.db });

  it("前の月報を全列置き換える(LLM の文章がある同士)。本文・作成時刻・件数・集計・総括・LLM の記録のどれも新しい。行は増えない", async () => {
    const s = store();
    await s.saveReport(narrated());
    const next = narrated({ createdAt: "2026-11-02T01:00:00.000Z", model: "claude-opus-5", raceCount: 7, totalStake: 700, totalReturn: 2100, summary: "作り直した総括", llmCallsJson: '[{"n":2}]' });
    expect(await s.replaceReport(next)).toBe("replaced");
    expect(await s.getReport(MONTH)).toStrictEqual(next);
    expect((await s.listReports(10)).map((r) => r.month)).toEqual([MONTH]);
  });

  it("前が文章なし(LLM が失敗して統計だけで確定した月)なら、新しい記録が文章なしでも置き換える(最新の統計に更新される)", async () => {
    const s = store();
    await s.saveReport(record({ totalReturn: 100 }));
    const next = record({ createdAt: "2026-11-02T01:00:00.000Z", totalReturn: 999 });
    expect(await s.replaceReport(next)).toBe("replaced");
    expect((await s.getReport(MONTH))!.totalReturn).toBe(999);
    expect((await s.getReport(MONTH))!.createdAt).toBe("2026-11-02T01:00:00.000Z");
  });

  it("前が文章なしで、新しい記録に文章があれば置き換える(統計だけの月報を直すという本来の用途)", async () => {
    const s = store();
    await s.saveReport(record());
    const next = narrated({ createdAt: "2026-11-02T01:00:00.000Z" });
    expect(await s.replaceReport(next)).toBe("replaced");
    expect(await s.getReport(MONTH)).toStrictEqual(next);
  });

  it("前に文章があり、新しい記録に文章が無い(LLM が使えなかった作り直し)ときは置き換えない(kept)。前の月報は全列そのまま", async () => {
    const s = store();
    const before = narrated({ totalReturn: 1400 });
    await s.saveReport(before);
    expect(await s.replaceReport(record({ createdAt: "2026-11-02T01:00:00.000Z", totalReturn: 5, raceCount: 99 }))).toBe("kept");
    expect(await s.getReport(MONTH)).toStrictEqual(before);
  });

  it("生の文章(narrative なし・model あり)の記録は『文章あり』として扱う: 前が文章ありでも置き換える", async () => {
    const s = store();
    await s.saveReport(narrated());
    const raw = record({ createdAt: "2026-11-02T01:00:00.000Z", model: "claude-sonnet-5-5", summary: "生の文章の先頭", body: { ...record().body, narrative: null, narrativeRaw: "生の文章", note: "LLM の応答を構造として読めなかったため、生の文章を載せています" } });
    expect(await s.replaceReport(raw)).toBe("replaced");
    expect((await s.getReport(MONTH))!.body.narrativeRaw).toBe("生の文章");
  });

  it("前の月報が無い月でも落ちず、通常の保存と同じに作る", async () => {
    const s = store();
    expect(await s.replaceReport(record())).toBe("replaced");
    expect(await s.getReport(MONTH)).toStrictEqual(record());
  });

  it("他の月の月報には触れない", async () => {
    const s = store();
    const other = narrated({ month: "202609", body: { ...narrated().body, month: "202609" } });
    await s.saveReport(other);
    await s.saveReport(narrated());
    await s.replaceReport(narrated({ summary: "作り直し", createdAt: "2026-11-02T01:00:00.000Z" }));
    expect(await s.getReport("202609")).toStrictEqual(other);
  });

  it("対照: 通常の保存(saveReport)は、作り直しの導入後も上書きしない(INSERT OR IGNORE のまま)", async () => {
    const s = store();
    await s.saveReport(narrated({ summary: "最初" }));
    expect(await s.saveReport(narrated({ summary: "二度目", createdAt: "2026-11-02T01:00:00.000Z" }))).toBe("exists");
    expect((await s.getReport(MONTH))!.summary).toBe("最初");
  });

  it("上書きの文は 1 文の UPSERT で、文章のある前の月報を文章の無い記録で潰さない WHERE を持つ", () => {
    expect(REPLACE_MONTHLY_SQL).toMatch(/^INSERT INTO monthly_reports /);
    expect(REPLACE_MONTHLY_SQL).toContain("ON CONFLICT(month) DO UPDATE SET");
    expect(REPLACE_MONTHLY_SQL).toContain("WHERE excluded.model IS NOT NULL OR monthly_reports.model IS NULL");
    expect(REPLACE_MONTHLY_SQL).not.toMatch(/DELETE|DROP|ALTER/i);
  });
});

function analysisRecord(n: number, kaisaiDate: string | null, analyzedAt: string, promptVersion: string, stake: number): AnalysisRecord {
  const meta = contractCases[0]!.record.allocation!.meta;
  return {
    raceId: `2026050308${String(n).padStart(2, "0")}`,
    analyzedAt,
    kaisaiDate,
    promptVersion,
    model: "claude-sonnet-5-5",
    rawResponse: "raw",
    horses: [1, 2, 3].map((umaban) => ({ umaban, prior: 0.3, adjustedProb: 0.3 + umaban / 100, placeOddsMin: 1.5, ev: 1.1, isPositive: umaban === 1, contributions: { umaban }, mark: umaban === 1 ? "◎" : null, reason: `根拠${umaban}` })),
    allocation: { meta, bets: [{ betType: "win", comboKey: "01", stake, odds: 4, ev: 1.2 }] },
  } as AnalysisRecord;
}
const raceIdOf = (n: number): string => `2026050308${String(n).padStart(2, "0")}`;
const horsesOf = (rows: Array<[number, number, number | null, number | null]>) => rows.map(([umaban, finishPosition, winPayout, placePayout]) => ({ umaban, finishPosition, winPayout, placePayout }));

describe("D1MonthlySource.readMonthStats", () => {
  const analyses = () => new D1AnalysisStore({ db: local.db, bucket: local.r2 });
  const source = () => new D1MonthlySource({ db: local.db });

  it("月の範囲(月初〜月末を含む)の分析だけを、日ごと・版ごとの行つきで集計する。前月末・翌月初・開催日 NULL は入らない", async () => {
    const a = analyses();
    await a.saveAnalysis(analysisRecord(1, "20260930", "2026-09-30T04:00:00.000Z", "v1", 100)); // 前月末
    await a.saveAnalysis(analysisRecord(2, "20261001", "2026-10-01T04:00:00.000Z", "v1", 200)); // 月初(含む)
    await a.saveAnalysis(analysisRecord(3, "20261031", "2026-10-31T04:00:00.000Z", "v2", 300)); // 月末(含む)
    await a.saveAnalysis(analysisRecord(4, "20261101", "2026-11-01T04:00:00.000Z", "v2", 400)); // 翌月初
    await a.saveAnalysis(analysisRecord(5, null, "2026-10-15T04:00:00.000Z", "v2", 500)); // 開催日 NULL
    const results = new D1ResultStore({ db: local.db });
    await results.saveResult(raceIdOf(2), horsesOf([[1, 1, 450, 150], [2, 2, null, 120], [3, 3, null, 130]]), "芝", {});
    await results.saveResult(raceIdOf(3), horsesOf([[1, 2, null, 150], [2, 1, 600, 120], [3, 3, null, 130]]), "芝", {});

    const s = await source().readMonthStats("20261001", "20261031");
    expect(s.raceCount).toBe(2);
    expect(s.dayCount).toBe(2);
    expect(s.days.map((d) => d.date)).toEqual(["20261001", "20261031"]);
    expect(s.byVersion.map((v) => v.promptVersion)).toEqual(["v1", "v2"]);
    // 10/01 の単勝 200 円は 1 着(払戻 450 円 → 900)、10/31 の 300 円は 2 着ではずれ。前提として両方が判定できている
    expect(s.days[0]).toMatchObject({ judgedBetCount: 1, hitBetCount: 1, totalStake: 200, totalReturn: 900 });
    expect(s.days[1]).toMatchObject({ judgedBetCount: 1, hitBetCount: 0, totalStake: 300, totalReturn: 0 });
    expect(s.byVersion[0]).toMatchObject({ promptVersion: "v1", raceCount: 1, totalStake: 200, totalReturn: 900 });
    expect(s.byVersion[1]).toMatchObject({ promptVersion: "v2", raceCount: 1, totalStake: 300, totalReturn: 0 });
    expect(s.fromDate).toBe("20261001");
    expect(s.toDate).toBe("20261031");
  });

  it("同じレースの分析が複数あれば最新の 1 件の版・買い目で数える(日報と同じ規則)", async () => {
    const a = analyses();
    await a.saveAnalysis(analysisRecord(1, "20261010", "2026-10-10T01:00:00.000Z", "v-old", 900));
    await a.saveAnalysis(analysisRecord(1, "20261010", "2026-10-10T05:00:00.000Z", "v-new", 100)); // 最新
    const s = await source().readMonthStats("20261001", "20261031");
    expect(s.raceCount).toBe(1);
    expect(s.byVersion.map((v) => v.promptVersion)).toEqual(["v-new"]);
    expect(s.unjudgedStake).toBe(100);
  });

  it("D1 への発行は 1 回の batch だけ(サブリクエスト 1)。SQL は期間の再集計と同じ 6 文", async () => {
    const { db, prepared, batches } = spyDb(local.db);
    await new D1MonthlySource({ db }).readMonthStats("20261001", "20261031");
    expect(batches).toEqual([6]);
    expect(prepared).toHaveLength(6);
    expect(new Set(prepared)).toEqual(new Set(Object.values(READ_PERIOD_SQL)));
  });

  it("期間の SQL は分析のプロンプト版(prompt_version)を読む(月報の版別の行の材料)", () => {
    expect(READ_PERIOD_SQL.races).toContain("prompt_version");
  });
});

describe("D1MonthlySource.lastDayStatus(最終日 1 日分の軽い問い合わせ)", () => {
  const source = () => new D1MonthlySource({ db: local.db });
  const LAST = "20261031";
  const addAnalysis = (raceId: string, kaisaiDate: string | null, analyzedAt: string) =>
    local.db.prepare("INSERT INTO analyses (race_id, analyzed_at, ev_estimated, kaisai_date) VALUES (?, ?, 0, ?)").bind(raceId, analyzedAt, kaisaiDate).run();
  const addResult = (raceId: string) => local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_payout, place_payout) VALUES (?, 1, 1, 400, 150)").bind(raceId).run();
  const addDaily = (date: string) =>
    local.db.prepare("INSERT INTO daily_reports (kaisai_date, created_at, race_count, total_stake, total_return, body_json) VALUES (?, 'x', 1, 0, 0, '{}')").bind(date).run();

  it("最終日の分析のレース数(レースごとに最新の 1 件)と、結果が 1 行も無いレース数と、その日の日報の有無を返す", async () => {
    await addAnalysis("R1", LAST, "2026-10-31T01:00:00.000Z");
    await addAnalysis("R1", LAST, "2026-10-31T05:00:00.000Z"); // 同じレースの再分析は 1 レース
    await addAnalysis("R2", LAST, "2026-10-31T02:00:00.000Z");
    await addAnalysis("R3", LAST, "2026-10-31T03:00:00.000Z");
    await addAnalysis("R9", "20261030", "2026-10-30T03:00:00.000Z"); // 他の日
    await addAnalysis("RNULL", null, "2026-10-31T03:00:00.000Z"); // 開催日 NULL
    await addResult("R1");
    await addResult("R9"); // 他の日の結果は数えない
    expect(await source().lastDayStatus(LAST)).toStrictEqual({ raceCount: 3, noResultRaceCount: 2, hasDailyReport: false });
    await addDaily("20261030"); // 他の日の日報は最終日の日報ではない
    expect((await source().lastDayStatus(LAST)).hasDailyReport).toBe(false);
    await addDaily(LAST);
    expect(await source().lastDayStatus(LAST)).toStrictEqual({ raceCount: 3, noResultRaceCount: 2, hasDailyReport: true });
    await addResult("R2");
    await addResult("R3");
    expect(await source().lastDayStatus(LAST)).toStrictEqual({ raceCount: 3, noResultRaceCount: 0, hasDailyReport: true });
  });

  it("分析が無い日は 0 件・日報なし", async () => {
    expect(await source().lastDayStatus(LAST)).toStrictEqual({ raceCount: 0, noResultRaceCount: 0, hasDailyReport: false });
  });

  it("D1 への発行は 1 文(first)だけで、読み取り専用。束縛は (日, 日) の 2 つ", async () => {
    const { db, prepared, batches } = spyDb(local.db);
    await new D1MonthlySource({ db }).lastDayStatus(LAST);
    expect(prepared).toEqual([LAST_DAY_STATUS_SQL]);
    expect(batches).toEqual([]);
    expect(LAST_DAY_STATUS_SQL.match(/\?/g)).toHaveLength(2);
    expect(LAST_DAY_STATUS_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i);
  });
});
