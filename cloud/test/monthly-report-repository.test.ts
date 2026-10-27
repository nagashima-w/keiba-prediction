import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isFitUnavailable, type AdjustmentFit } from "../src/adjustment-fit";
import { FIT_CANDIDATES_SQL, FIT_HORSES_SQL, FIT_RESULTS_SQL, FitTooManyError, readAdjustmentFitRows } from "../src/adjustment-fit-read";
import { D1AnalysisStore } from "../src/analysis-repository";
import { READ_PERIOD_SQL } from "../src/daily-report-repository";
import type { MonthlyReportRecord } from "../src/monthly-report-core";
import { D1MonthlySource, D1MonthlyStore, INSERT_MONTHLY_SQL, LAST_DAY_STATUS_SQL, MONTHLY_LIST_DEFAULT_LIMIT, MONTHLY_LIST_MAX_LIMIT, REPLACE_MONTHLY_SQL } from "../src/monthly-report-repository";
import { MONTHLY_PROMPT_VERSION } from "../src/monthly-report-prompt";
import { buildMonthStats } from "../src/monthly-stats";
import { D1ResultStore } from "../src/result-repository";
import type { AnalysisRecord, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import { buildVerifySource, VERIFY_READ_SQL, type VerifyReadRows } from "../src/verify-read";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, spyDb, type LocalBindings } from "./local-bindings";

/**
 * Issue #279(#265-A): 月報の D1 への保存・読み出し(`D1MonthlyStore`)と、月の統計・最終日の状態の読み出し(`D1MonthlySource`)を、ローカル(workerd)の D1 で確かめる。
 * migration 0015 は `wrangler d1 migrations apply --local`(CI と同じ実コマンド)で適用される。
 */

type AnalysisDbLike = ConstructorParameters<typeof D1MonthlySource>[0]["db"];

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


// ---- 補正の当たり具合(Issue #509)の標本 ----

interface FitHorseSeed {
  readonly umaban: number;
  readonly prior: number;
  readonly adjusted: number;
  readonly finish: number | null;
  readonly ninki?: number | null;
  readonly scratched?: boolean;
}
const DEFAULT_FIT_HORSES: readonly FitHorseSeed[] = [
  { umaban: 1, prior: 0.4, adjusted: 0.5, finish: 1, ninki: 1 }, // d +0.10(大きく上げた)・3 着内
  { umaban: 2, prior: 0.3, adjusted: 0.3, finish: 5, ninki: 2 }, // d 0(そのまま)・3 着外
  { umaban: 3, prior: 0.2, adjusted: 0.1, finish: 3, ninki: 8 }, // d −0.10(大きく下げた)・3 着内
];
interface FitRaceSeed {
  /** レース番号(レース ID の末尾 2 桁)。 */
  readonly raceNo: number;
  readonly kaisaiDate?: string;
  readonly analyzedAt?: string;
  readonly promptVersion?: string | null;
  /** 既定は LLM が効いた分析(model あり)。null で LLM 不使用。 */
  readonly model?: string | null;
  /** 既定は遮断済み(clean)。false で遮断の記録なし(発走時刻の写しが要る)。 */
  readonly guarded?: boolean;
  readonly evEstimated?: boolean;
  readonly withResult?: boolean;
  readonly horses?: readonly FitHorseSeed[];
}
const fitRaceId = (raceNo: number): string => `2026101008${String(raceNo).padStart(2, "0")}`;

/** 分析 1 件(と、あれば結果)を D1 に入れ、分析の id を返す。 */
async function seedFitRace(seed: FitRaceSeed): Promise<number> {
  const horses = seed.horses ?? DEFAULT_FIT_HORSES;
  const guarded = seed.guarded ?? true;
  const raceId = fitRaceId(seed.raceNo);
  const record = {
    raceId,
    analyzedAt: seed.analyzedAt ?? "2026-10-10T00:00:00.000Z",
    kaisaiDate: seed.kaisaiDate ?? "20261010",
    promptVersion: seed.promptVersion === undefined ? "v1" : seed.promptVersion,
    model: seed.model === undefined ? "claude-sonnet-5-5" : seed.model,
    rawResponse: null,
    evEstimated: seed.evEstimated ?? false,
    historyCutoffDate: guarded ? "20261009" : null,
    promptLookaheadGuarded: guarded ? true : null,
    horses: horses.map((h) => ({ umaban: h.umaban, prior: h.prior, adjustedProb: h.adjusted, placeOddsMin: 1.5, ev: 1.1, isPositive: false, contributions: { umaban: h.umaban }, mark: null, reason: null })),
  } as unknown as AnalysisRecord;
  const { id } = await new D1AnalysisStore({ db: local.db, bucket: local.r2 }).saveAnalysis(record);
  if (seed.withResult !== false) {
    const entries: RaceResultEntry[] = horses.map((h) => ({ umaban: h.umaban, finishPosition: h.finish, placePayout: null, winPayout: null, ninki: h.ninki ?? null, ...(h.scratched === true ? { scratched: true } : {}) }));
    await new D1ResultStore({ db: local.db }).saveResult(raceId, entries, "芝", {});
  }
  return id;
}

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

  it("D1 への発行: 成績の再集計は 1 回の batch(6 文。期間の再集計と同じ SQL)。補正の当たり具合の候補が無いときは、それだけ(サブリクエスト 2: batch 1 + 候補 1 文)", async () => {
    const { db, prepared, batches } = spyDb(local.db);
    await new D1MonthlySource({ db }).readMonthStats("20261001", "20261031");
    expect(batches).toEqual([6]);
    expect(prepared).toHaveLength(7);
    expect(new Set(prepared.slice(0, 6))).toEqual(new Set(Object.values(READ_PERIOD_SQL)));
    expect(prepared[6]).toBe(FIT_CANDIDATES_SQL);
  });

  it("D1 への発行: 補正の当たり具合の標本があるときは、成績の batch 6 文 + 候補 1 文 + 馬と結果の batch 2 文(サブリクエスト 3)。どれも読み取り専用", async () => {
    await seedFitRace({ raceNo: 1 });
    const { db, prepared, batches } = spyDb(local.db);
    await new D1MonthlySource({ db }).readMonthStats("20261001", "20261031");
    expect(batches).toEqual([6, 2]);
    expect(prepared).toHaveLength(9);
    expect(prepared.slice(6)).toEqual([FIT_CANDIDATES_SQL, FIT_HORSES_SQL, FIT_RESULTS_SQL]);
    for (const sql of [FIT_CANDIDATES_SQL, FIT_HORSES_SQL, FIT_RESULTS_SQL]) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i);
    }
  });

  it("期間の SQL は分析のプロンプト版(prompt_version)を読む(月報の版別の行の材料)", () => {
    expect(READ_PERIOD_SQL.races).toContain("prompt_version");
  });
});

describe("D1MonthlySource.readMonthStats: 補正の当たり具合(Issue #509)", () => {
  const source = (options: { readonly db?: AnalysisDbLike; readonly onWarn?: (m: string) => void; readonly fitCandidateLimit?: number } = {}) =>
    new D1MonthlySource({ db: options.db ?? local.db, ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }), ...(options.fitCandidateLimit === undefined ? {} : { fitCandidateLimit: options.fitCandidateLimit }) });
  const fitOf = async (...args: Parameters<D1MonthlySource["readMonthStats"]>): Promise<AdjustmentFit> => {
    const fit = (await source().readMonthStats(...args)).adjustmentFit;
    if (fit === undefined || isFitUnavailable(fit)) throw new Error("補正の当たり具合が読めていません");
    return fit;
  };

  it("母集団: 月の範囲・結果あり・LLM が効いた・clean・最新の 1 件だけ。除いたレースは内訳に数える", async () => {
    await seedFitRace({ raceNo: 1 }); // 採用(3 頭)
    await seedFitRace({ raceNo: 2, analyzedAt: "2026-10-09T00:00:00.000Z", promptVersion: "v-old" }); // R2 の古い分析
    await seedFitRace({ raceNo: 2, promptVersion: "v1" }); // R2 の最新(採用。版は v1)
    await seedFitRace({ raceNo: 3, withResult: false }); // 結果なし(候補の段階で除く)
    await seedFitRace({ raceNo: 4, model: null, promptVersion: null }); // LLM 不使用
    await seedFitRace({ raceNo: 5, guarded: false }); // 遮断なしで発走時刻が NULL(補完待ち)
    await seedFitRace({ raceNo: 6, evEstimated: true }); // 推定 EV
    await seedFitRace({ raceNo: 7, kaisaiDate: "20260930" }); // 前月
    await seedFitRace({ raceNo: 8, kaisaiDate: "20261101" }); // 翌月
    const fit = await fitOf("20261001", "20261031");
    expect(fit.all.raceCount).toBe(2);
    expect(fit.all.horseCount).toBe(6);
    expect(fit.excluded).toEqual({ suspect: 0, unknown: 0, uncheckedRaces: 1, estimated: 1, notLlm: 1 });
    expect(fit.byVersion).toEqual([]); // 2 レースしかない版は出さない
    expect(fit.hiddenVersionCount).toBe(1);
  });

  it("値: 向き別・人気別・Brier・k が、入れた標本の手計算と一致する(取消の馬・着順なしの馬は評価しない)", async () => {
    await seedFitRace({
      raceNo: 1,
      horses: [...DEFAULT_FIT_HORSES, { umaban: 4, prior: 0.1, adjusted: 0.2, finish: 2, ninki: 3, scratched: true }, { umaban: 5, prior: 0.1, adjusted: 0.2, finish: null, ninki: 4 }],
    });
    const fit = await fitOf("20261001", "20261031");
    expect(fit.all.horseCount).toBe(3);
    const dir = Object.fromEntries(fit.all.byDirection.map((b) => [b.key, b.count]));
    expect(dir).toEqual({ bigUp: 1, up: 0, same: 1, down: 0, bigDown: 1 });
    expect(fit.all.byPopularity.map((b) => [b.key, b.count])).toEqual([["1", 1], ["2-3", 1], ["4-6", 0], ["7+", 1]]);
    // d = +0.1, 0, −0.1。y = 1, 0, 1。Σd² = 0.02。Σd(y−prior) = 0.1×0.6 + 0 + (−0.1)×0.8 = −0.02。k = −1
    expect(fit.all.optimalK).toBeCloseTo(-1, 9);
    // prior の Brier = (0.6² + 0.3² + 0.8²)/3、補正後 = (0.5² + 0.3² + 0.9²)/3
    expect(fit.all.brier.prior).toBeCloseTo((0.36 + 0.09 + 0.64) / 3, 9);
    expect(fit.all.brier.adjusted).toBeCloseTo((0.25 + 0.09 + 0.81) / 3, 9);
  });

  it("検証画面(computeVerifyReport。D1 から VERIFY_READ_SQL で読んだ行)と、採用件数・評価した馬の数・Brier が一致する(LLM 不使用の分析を含まない月)", async () => {
    await seedFitRace({ raceNo: 1 });
    await seedFitRace({ raceNo: 2, analyzedAt: "2026-10-09T00:00:00.000Z", horses: [{ umaban: 1, prior: 0.9, adjusted: 0.1, finish: 9, ninki: 1 }] }); // 古い分析(最新に取って代わられる)
    await seedFitRace({ raceNo: 2, horses: [{ umaban: 1, prior: 0.3, adjusted: 0.35, finish: 2, ninki: 2 }, { umaban: 2, prior: 0.2, adjusted: 0.15, finish: 7, ninki: 6 }] });
    const suspect = await seedFitRace({ raceNo: 3, guarded: false, analyzedAt: "2026-10-10T08:00:00.000Z" }); // 発走後に分析(先読みの疑い)
    await local.db.prepare("UPDATE analyses SET start_time = '15:45' WHERE id = ?").bind(suspect).run();
    const clean = await seedFitRace({ raceNo: 4, guarded: false, analyzedAt: "2026-10-10T00:00:00.000Z" }); // 遮断なしで発走前(clean)
    await local.db.prepare("UPDATE analyses SET start_time = '15:45' WHERE id = ?").bind(clean).run();
    await seedFitRace({ raceNo: 5, evEstimated: true }); // 推定 EV
    await seedFitRace({ raceNo: 6, withResult: false }); // 結果なし
    await seedFitRace({ raceNo: 7, promptVersion: "v2", horses: [{ umaban: 1, prior: 0.25, adjusted: 0.3, finish: 1, ninki: 3 }] });

    const read = async <T>(sql: string): Promise<T[]> => (await local.db.prepare(sql).all<T>()).results;
    const rows: VerifyReadRows = {
      analyses: await read(VERIFY_READ_SQL.analyses),
      horses: await read(VERIFY_READ_SQL.horses),
      allocationMeta: await read(VERIFY_READ_SQL.allocationMeta),
      bets: await read(VERIFY_READ_SQL.bets),
      results: await read(VERIFY_READ_SQL.results),
      comboPayouts: await read(VERIFY_READ_SQL.comboPayouts),
      comboImports: await read(VERIFY_READ_SQL.comboImports),
    };
    const report = computeVerifyReport(buildVerifySource(rows), PRODUCTION_VERIFY_CONFIG);
    const fit = await fitOf("20261001", "20261031");

    expect(report.includedAnalysisCount).toBe(4); // 前提: R1・R2(最新)・R4・R7 の 4 件(R3 は先読みの疑い・R5 は推定 EV・R6 は結果なしで除かれる)。空振りでないことの固定
    expect(report.excludedLookaheadSuspectCount).toBe(1); // 前提: 先読みの疑いが実際に除かれている
    expect(report.excludedEstimatedCount).toBe(1);
    expect(fit.all.raceCount).toBe(report.includedAnalysisCount);
    expect(fit.all.horseCount).toBe(report.quality.evaluatedCount);
    expect(fit.all.brier.prior).toBeCloseTo(report.quality.priorBrier!, 12);
    expect(fit.all.brier.adjusted).toBeCloseTo(report.quality.adjustedBrier!, 12);
    expect(fit.excluded.suspect).toBe(report.excludedLookaheadSuspectCount);
    expect(fit.excluded.estimated).toBe(report.excludedEstimatedCount);
  });

  it("読み出しの実行計画: 候補は開催日の索引、馬と結果は主キーの索引を引く(全件走査にならない)", async () => {
    const plan = async (sql: string, ...binds: unknown[]): Promise<string> => {
      const { results } = await local.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      return results.map((r) => r.detail).join("\n");
    };
    const candidates = await plan(FIT_CANDIDATES_SQL, "20261001", "20261031", 10);
    expect(candidates).toMatch(/idx_analyses_kaisai_date/);
    const horses = await plan(FIT_HORSES_SQL, "[1,2]");
    expect(horses).not.toMatch(/SCAN analysis_horses/);
    const results = await plan(FIT_RESULTS_SQL, '["R1"]');
    expect(results).not.toMatch(/SCAN race_results/);
  });

  it("D1 の読み取り行数(meta.rows_read)を返す: 標本の行数以上で、範囲外の月の分析・結果を増やしても、ほとんど増えない(全件走査でない)", async () => {
    for (let i = 1; i <= 10; i += 1) await seedFitRace({ raceNo: i });
    const before = await readAdjustmentFitRows(local.db, "20261001", "20261031");
    expect(before.horses).toHaveLength(30);
    expect(before.results).toHaveLength(30);
    expect(before.rowsRead).toBeGreaterThanOrEqual(10 + 30 + 30); // 候補 10 + 馬 30 + 結果 30 が最低ライン
    for (let i = 21; i <= 30; i += 1) await seedFitRace({ raceNo: i, kaisaiDate: "20260901" }); // 9 月の分析と結果(10 月の範囲外)
    const after = await readAdjustmentFitRows(local.db, "20261001", "20261031");
    expect(after.horses).toHaveLength(30); // 前提: 範囲外の標本は読んでいない
    // 範囲外に足した行は 70(分析 10 + 馬 30 + 結果 30)。読み取りは索引の境目の数行しか増えない(全件走査なら 70 以上増える)
    expect(after.rowsRead - before.rowsRead).toBeLessThan(10);
  });

  describe("失敗の扱い(新しい節の失敗で、月報そのものを failed にしない)", () => {
    /** 候補の文の `all()` を、最初の `failures` 回だけ例外にする db。 */
    function flakyDb(failures: number): { db: AnalysisDbLike; attempts: () => number } {
      let attempts = 0;
      const db = {
        prepare(sql: string) {
          const statement = local.db.prepare(sql);
          if (sql !== FIT_CANDIDATES_SQL) return statement;
          return {
            bind: (...args: unknown[]) => ({
              all: async () => {
                attempts += 1;
                if (attempts <= failures) throw new Error("内部の詳細: secret-token-xyz");
                return statement.bind(...args).all();
              },
            }),
          };
        },
        batch: (statements: D1PreparedStatement[]) => local.db.batch(statements),
      } as unknown as AnalysisDbLike;
      return { db, attempts: () => attempts };
    }

    it("一時的な失敗は 1 度取り直す: 1 回目が失敗しても 2 回目で読めれば、節は付く", async () => {
      await seedFitRace({ raceNo: 1 });
      const flaky = flakyDb(1);
      const stats = await source({ db: flaky.db }).readMonthStats("20261001", "20261031");
      expect(flaky.attempts()).toBe(2);
      expect(stats.adjustmentFit).toBeDefined();
      expect(isFitUnavailable(stats.adjustmentFit!)).toBe(false);
    });

    it("2 回続けて失敗したら、月報は作り続け、節は『読めなかった』の印(read-failed)にする。警告に例外の本文を含めない", async () => {
      await seedFitRace({ raceNo: 1 });
      const flaky = flakyDb(2);
      const warns: string[] = [];
      const stats = await source({ db: flaky.db, onWarn: (m) => warns.push(m) }).readMonthStats("20261001", "20261031");
      expect(flaky.attempts()).toBe(2);
      expect(stats.adjustmentFit).toEqual({ unavailable: "read-failed" });
      expect(stats.raceCount).toBe(1); // 成績の統計は今までどおり読めている
      expect(warns).toHaveLength(1);
      expect(warns[0]).not.toContain("secret-token-xyz");
    });

    it("候補が上限を超えたら、取り直さずに印(too-many)にする。一部だけの集計は返さない", async () => {
      for (let i = 1; i <= 3; i += 1) await seedFitRace({ raceNo: i });
      const warns: string[] = [];
      const stats = await source({ onWarn: (m) => warns.push(m), fitCandidateLimit: 2 }).readMonthStats("20261001", "20261031");
      expect(stats.adjustmentFit).toEqual({ unavailable: "too-many" });
      expect(warns).toHaveLength(1);
      await expect(readAdjustmentFitRows(local.db, "20261001", "20261031", 2)).rejects.toBeInstanceOf(FitTooManyError);
      // 上限ちょうどは通る(境目)
      const exact = await readAdjustmentFitRows(local.db, "20261001", "20261031", 3);
      expect(exact.selection.chosen).toHaveLength(3);
    });

    it("計算の失敗(compute-failed)でも月報は作り続ける。成績の読み出しの失敗は今までどおり例外(段階の再試行に任せる)", async () => {
      await seedFitRace({ raceNo: 1 });
      const throwing = new D1MonthlySource({
        db: local.db,
        computeFit: () => {
          throw new Error("計算の失敗");
        },
      });
      expect((await throwing.readMonthStats("20261001", "20261031")).adjustmentFit).toEqual({ unavailable: "compute-failed" });
      const failingMain = { prepare: () => { throw new Error("D1 が落ちた"); }, batch: () => { throw new Error("D1 が落ちた"); } } as unknown as AnalysisDbLike;
      await expect(new D1MonthlySource({ db: failingMain }).readMonthStats("20261001", "20261031")).rejects.toThrow("D1 が落ちた");
    });
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
