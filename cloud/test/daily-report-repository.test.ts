import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import type { ReportRecord } from "../src/daily-report-core";
import { buildDayStats, buildRaceDigest } from "../src/daily-report-digest";
import { D1ReportSource, D1ReportStore, LIST_DAY_ANALYSES_SQL, PERIOD_ANALYSES_LIMIT, READ_PERIOD_SQL, READ_RESULTS_SQL } from "../src/daily-report-repository";
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

  it("Issue #246 P9: readRaces は配分を、そのレースの分析から読む(別の分析の配分を読まない)。配分が互いに異なる 3 つの分析で、渡した順にも依らない", async () => {
    const a = analyses();
    const meta = contractCases[0]!.record.allocation!.meta;
    const withBets = (n: number, bets: Array<[string, string, number]>) =>
      analysisRecord(n, `2026-10-10T04:0${n}:00.000Z`, { allocation: { meta, bets: bets.map(([betType, comboKey, stake]) => ({ betType, comboKey, stake, odds: 4, ev: 1.2 })) } } as Partial<AnalysisRecord>);
    const s1 = await a.saveAnalysis(withBets(1, [["win", "01", 100]]));
    const s2 = await a.saveAnalysis(withBets(2, [["place", "02", 200], ["wide", "0203", 300]]));
    const s3 = await a.saveAnalysis(withBets(3, [["trio", "010203", 400]]));
    const shape = (r: { view: { allocation: { bets: ReadonlyArray<{ betType: string; comboKey: string; stake: number }> } | null } } | null) => r!.view.allocation!.bets.map((b) => `${b.betType}:${b.comboKey}:${b.stake}`).sort();
    const forward = await source().readRaces([
      { raceId: raceIdOf(1), analysisId: s1.id },
      { raceId: raceIdOf(2), analysisId: s2.id },
      { raceId: raceIdOf(3), analysisId: s3.id },
    ]);
    // 前提: 3 つの配分は互いに異なる(取り違えると結果が変わる)
    expect(new Set(forward.map((r) => shape(r).join(","))).size).toBe(3);
    expect(forward.map(shape)).toEqual([["win:01:100"], ["place:02:200", "wide:0203:300"], ["trio:010203:400"]]);
    const reversed = await source().readRaces([
      { raceId: raceIdOf(3), analysisId: s3.id },
      { raceId: raceIdOf(1), analysisId: s1.id },
    ]);
    expect(reversed.map(shape)).toEqual([["trio:010203:400"], ["win:01:100"]]);
    expect(reversed.map((r) => r!.view.raceId)).toEqual([raceIdOf(3), raceIdOf(1)]);
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


// ---- Issue #264: 期間の再集計(直前 27 日) ----

describe("D1ReportSource.readPeriodStats(Issue #264)", () => {
  const analyses = () => new D1AnalysisStore({ db: local.db, bucket: local.r2 });
  const source = () => new D1ReportSource({ db: local.db, analyses: analyses() });
  const meta = contractCases[0]!.record.allocation!.meta;

  /** 1 レース分の分析(馬 3 頭・◎が 1 番・買い目は引数)。 */
  function rec(n: number, kaisaiDate: string | null, analyzedAt: string, bets: Array<[string, string, number, number, number]>, model: string | null = "claude-sonnet-5-5"): AnalysisRecord {
    return analysisRecord(n, analyzedAt, {
      kaisaiDate,
      ...(model === null ? {} : { model }),
      allocation: { meta, bets: bets.map(([betType, comboKey, stake, odds, ev]) => ({ betType, comboKey, stake, odds, ev })) },
    } as Partial<AnalysisRecord>);
  }
  const horsesOf = (rows: Array<[number, number, number | null, number | null]>) => rows.map(([umaban, finishPosition, winPayout, placePayout]) => ({ umaban, finishPosition, winPayout, placePayout }));

  it("同じ 1 日について、日報の経路(列挙→読み出し→ダイジェスト→1 日の統計)と、期間の再集計が同じ統計を返す", async () => {
    const a = analyses();
    const r1 = await a.saveAnalysis(rec(1, DATE, "2026-10-10T04:00:00.000Z", [["win", "01", 300, 4, 1.2], ["place", "02", 200, 2, 1.0], ["wide", "0102", 100, 6, 1.1]]));
    const r2 = await a.saveAnalysis(rec(2, DATE, "2026-10-10T04:30:00.000Z", [["win", "02", 400, 5, 1.5]])); // 結果なし
    const r3 = await a.saveAnalysis(rec(3, DATE, "2026-10-10T05:00:00.000Z", [["win", "03", 100, 8, 1.6], ["place", "03", 100, 3, 0.9]], null)); // model なし
    const results = new D1ResultStore({ db: local.db });
    await results.saveResult(raceIdOf(1), horsesOf([[1, 1, 450, 150], [2, 5, null, null], [3, 3, null, 210]]), "芝", { wide: { state: "parsed", payouts: [{ umabans: [1, 2], payout: 900 }] } });
    await results.saveResult(raceIdOf(3), horsesOf([[1, 2, null, 130], [2, 1, 600, 140], [3, 4, null, null]]), "ダ", {});
    const refs = [r1, r2, r3].map((x, i) => ({ raceId: raceIdOf(i + 1), analysisId: x.id }));

    const inputs = await source().readRaces(refs);
    const day = buildDayStats(inputs.map((i) => buildRaceDigest(i!.view, i!.result)));
    const period = await source().readPeriodStats(DATE, DATE);

    // 前提(空振り防止): 的中・はずれ・判定不能・組合せ・結果なし・model なし・印別のどれもが実際に数えられている
    expect(day.hitBetCount).toBeGreaterThan(0);
    expect(day.judgedBetCount - day.hitBetCount).toBeGreaterThan(0);
    expect(day.unjudgedBetCount).toBeGreaterThan(0);
    expect(day.byBetType["wide"]?.hitCount).toBe(1);
    expect(day.noResultRaceCount).toBe(1);
    expect(day.llmUsedRaceCount).toBe(2);
    expect(day.byMark.length).toBeGreaterThan(0);
    expect(day.expectedBetCount).toBe(day.judgedBetCount);

    const { dayCount, fromDate, toDate, expectedHits, byBetType, ...rest } = period;
    expect([dayCount, fromDate, toDate]).toEqual([1, DATE, DATE]);
    const { expectedHits: dayHits, byBetType: dayTypes, ...dayRest } = day;
    expect(rest).toStrictEqual(dayRest);
    expect(expectedHits).toBeCloseTo(dayHits, 12);
    expect(Object.keys(byBetType).sort()).toEqual(Object.keys(dayTypes).sort());
    for (const [type, t] of Object.entries(dayTypes)) {
      const { expectedHits: h, ...r } = byBetType[type]!;
      expect(r).toStrictEqual({ betCount: t.betCount, hitCount: t.hitCount, stake: t.stake, payout: t.payout, refundCount: t.refundCount, expectedBetCount: t.expectedBetCount, expectedBaseHits: t.expectedBaseHits });
      expect(h).toBeCloseTo(t.expectedHits, 12);
    }
  });

  it("Issue #278 返還: race_results.scratched を、日報の経路(readRaces)も期間の再集計(readPeriodRows)も読み、同じ統計(返還を含む)を返す。NULL(旧い行)は返還にしない", async () => {
    const a = analyses();
    // R1: 2 番が取消(scratched=1)。単勝 02・ワイド 0102 は返還、単勝 01 は的中。
    const r1 = await a.saveAnalysis(rec(1, DATE, "2026-10-10T04:00:00.000Z", [["win", "01", 300, 4, 1.2], ["win", "02", 200, 5, 1.1], ["wide", "0102", 100, 6, 1.1]]));
    // R2: 2 番は着順なしだが scratched が NULL(旧い行)。単勝 02 は従来どおりはずれ。
    const r2 = await a.saveAnalysis(rec(2, DATE, "2026-10-10T04:30:00.000Z", [["win", "02", 400, 5, 1.5]]));
    const results = new D1ResultStore({ db: local.db });
    const entries = (rows: Array<[number, number | null, number | null, number | null, boolean?]>) =>
      rows.map(([umaban, finishPosition, winPayout, placePayout, scratched]) => ({ umaban, finishPosition, winPayout, placePayout, ...(scratched === true ? { scratched: true } : {}) }));
    await results.saveResult(raceIdOf(1), entries([[1, 1, 450, 150], [2, null, null, null, true], [3, 3, null, 210]]), "芝", { wide: { state: "parsed", payouts: [{ umabans: [1, 3], payout: 900 }] } });
    await results.saveResult(raceIdOf(2), entries([[1, 1, 450, 150], [2, null, null, null], [3, 3, null, 210]]), "芝", {});
    await local.db.prepare("UPDATE race_results SET scratched = NULL WHERE race_id = ?").bind(raceIdOf(2)).run(); // 旧い行(migration 0013 より前に保存)
    const col = await local.db.prepare("SELECT race_id AS raceId, umaban, scratched FROM race_results WHERE umaban = 2 ORDER BY race_id").all<{ raceId: string; umaban: number; scratched: number | null }>();
    expect(col.results.map((r) => r.scratched)).toEqual([1, null]); // 前提: 取消(1)と未記録(NULL)の両方が D1 にある

    const refs = [r1, r2].map((x, i) => ({ raceId: raceIdOf(i + 1), analysisId: x.id }));
    const inputs = await source().readRaces(refs);
    expect(inputs[0]!.result!.horses.find((h) => h.umaban === 2)!.scratched).toBe(true);
    expect(inputs[0]!.result!.horses.find((h) => h.umaban === 1)!.scratched).toBe(false);
    expect("scratched" in inputs[1]!.result!.horses.find((h) => h.umaban === 2)!).toBe(false); // NULL はキーを付けない
    const day = buildDayStats(inputs.map((i) => buildRaceDigest(i!.view, i!.result)));
    expect(day.refundedBetCount).toBe(2);
    expect(day.refundedStake).toBe(300);
    expect(day.judgedBetCount).toBe(4);
    expect(day.totalStake).toBe(300 + 200 + 100 + 400);
    expect(day.totalReturn).toBe(1350 + 200 + 100); // 的中 450×3 + 返還 200 + 返還 100(R2 の単勝 02 は旧い行なのではずれ)

    const { rows } = await source().readPeriodRows(DATE, DATE);
    expect(rows.results.filter((r) => r.umaban === 2).map((r) => r.scratched)).toEqual([true, undefined]);
    const period = await source().readPeriodStats(DATE, DATE);
    expect(period.refundedBetCount).toBe(day.refundedBetCount);
    expect(period.refundedStake).toBe(day.refundedStake);
    expect(period.totalStake).toBe(day.totalStake);
    expect(period.totalReturn).toBe(day.totalReturn);
    expect(period.byBetType["win"]!.refundCount).toBe(1);
    expect(period.byBetType["wide"]!.refundCount).toBe(1);
  });

  it("範囲は両端を含む開催日。範囲外の日・開催日 NULL の分析は入らない。開催の無い日は dayCount に数えない", async () => {
    const a = analyses();
    const bet: Array<[string, string, number, number, number]> = [["win", "01", 100, 4, 1.2]];
    await a.saveAnalysis(rec(1, "20260913", "2026-09-13T04:00:00.000Z", bet)); // 1 日手前
    await a.saveAnalysis(rec(2, "20260914", "2026-09-14T04:00:00.000Z", bet)); // from(含む)
    await a.saveAnalysis(rec(3, "20260930", "2026-09-30T04:00:00.000Z", bet));
    await a.saveAnalysis(rec(4, "20261010", "2026-10-10T04:00:00.000Z", bet)); // to(含む)
    await a.saveAnalysis(rec(5, "20261011", "2026-10-11T04:00:00.000Z", bet)); // 1 日後
    await a.saveAnalysis(rec(6, null, "2026-10-01T04:00:00.000Z", bet));
    const s = await source().readPeriodStats("20260914", "20261010");
    expect(s.raceCount).toBe(3);
    expect(s.dayCount).toBe(3);
    expect(s.unjudgedBetCount).toBe(3); // 結果が無いので全部判定不能(買い目は読めている)
    expect(s.unjudgedStake).toBe(300);
  });

  it("同じレースの分析が複数あれば、分析時刻が最新の 1 件の買い目だけを数える(日報と同じ規則。同時刻は id の大きい方)", async () => {
    const a = analyses();
    await a.saveAnalysis(rec(1, DATE, "2026-10-10T01:00:00.000Z", [["win", "01", 900, 4, 1.2]]));
    await a.saveAnalysis(rec(1, DATE, "2026-10-10T05:00:00.000Z", [["win", "01", 100, 4, 1.2]])); // 最新
    await a.saveAnalysis(rec(2, DATE, "2026-10-10T04:00:00.000Z", [["win", "01", 200, 4, 1.2]]));
    await a.saveAnalysis(rec(2, DATE, "2026-10-10T04:00:00.000Z", [["win", "01", 300, 4, 1.2]])); // 同時刻 → id が大きい方
    const s = await source().readPeriodStats(DATE, DATE);
    expect(s.raceCount).toBe(2);
    expect(s.unjudgedStake).toBe(400); // 100 + 300(古い 900 と 200 は入らない)
  });

  it("D1 への発行は 1 回の batch だけ(サブリクエスト 1)。SQL は 6 文で、どれも束縛は (from, to, 上限+1) の 3 つ", async () => {
    const { db, prepared, batches } = spyDb(local.db);
    const s = new D1ReportSource({ db, analyses: new D1AnalysisStore({ db, bucket: local.r2 }) });
    await s.readPeriodStats("20260914", "20261010");
    expect(batches).toEqual([6]);
    expect(prepared).toHaveLength(6);
    expect(new Set(prepared).size).toBe(6);
    for (const sql of Object.values(READ_PERIOD_SQL)) {
      expect(sql.match(/\?/g)).toHaveLength(3);
    }
    expect(Object.keys(READ_PERIOD_SQL)).toHaveLength(6);
  });

  it("読み出しは読み取り専用(INSERT・UPDATE・DELETE を含まない)", () => {
    for (const sql of Object.values(READ_PERIOD_SQL)) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i);
    }
  });

  it("上限: 対象のレースが上限を超えるときは、黙って一部だけ集計せず例外にする(日報の段階の再試行に任せる)", async () => {
    const a = analyses();
    for (let n = 1; n <= 3; n += 1) {
      await a.saveAnalysis(rec(n, DATE, `2026-10-10T04:0${n}:00.000Z`, [["win", "01", 100, 4, 1.2]]));
    }
    await expect(source().readPeriodRows(DATE, DATE, 2)).rejects.toThrow(/上限/);
    const exactly = await source().readPeriodRows(DATE, DATE, 3); // ちょうど上限は通る(境界)
    expect(exactly.rows.races).toHaveLength(3);
    expect(PERIOD_ANALYSES_LIMIT).toBeGreaterThanOrEqual(1000);
  });

  it("買い目が 1 つも無い分析・印が無い分析でも落ちない(統計は 0 件の券種別・印別)", async () => {
    await analyses().saveAnalysis(analysisRecord(1, "2026-10-10T04:00:00.000Z", { allocation: undefined, horses: [{ umaban: 1, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 1.5, ev: 1.1, isPositive: false, contributions: {}, mark: null, reason: null }] } as Partial<AnalysisRecord>));
    const s = await source().readPeriodStats(DATE, DATE);
    expect(s).toMatchObject({ raceCount: 1, judgedBetCount: 0, byBetType: {}, byMark: [], dayCount: 1 });
  });

  describe("読み取り行数(D1 の `meta.rows_read`。Free は 1 日 500 万行)", () => {
    /** 1 レースあたり: 馬 14・買い目 5・結果 14・組合せ払戻 9・取込印 3 を、JSON から 1 文ずつ流し込む(実データに近い大きさ)。 */
    async function seed(races: number): Promise<void> {
      const mk = (from: number, to: number) => {
        const ana: unknown[] = [];
        const hor: unknown[] = [];
        const bet: unknown[] = [];
        const res: unknown[] = [];
        const cmb: unknown[] = [];
        const imp: unknown[] = [];
        for (let i = from; i < to; i += 1) {
          const raceId = `2026${String(i).padStart(8, "0")}`;
          const day = 20 + (i % 8); // 9/20〜9/27 の 8 開催日
          ana.push([i + 1, raceId, `2026-09-${day}T04:00:00.000Z`, `202609${day}`, "claude-sonnet-5-5"]);
          for (let u = 1; u <= 14; u += 1) hor.push([i + 1, u, u <= 6 ? "◎" : null]);
          for (const [t, k] of [["win", "01"], ["place", "02"], ["wide", "0102"], ["trio", "010203"], ["quinella", "0102"]] as const) bet.push([i + 1, t, k, 100, 4, 1.2]);
          for (let u = 1; u <= 14; u += 1) res.push([raceId, u, u, u === 1 ? 400 : null, u <= 3 ? 150 : null]);
          for (const t of ["wide", "trio", "quinella"]) {
            for (const k of ["0102", "0103", "0203"]) cmb.push([raceId, t, k, 500]);
            imp.push([raceId, t]);
          }
        }
        return [ana, hor, bet, res, cmb, imp].map((x) => JSON.stringify(x));
      };
      for (let from = 0; from < races; from += 100) {
        const [ana, hor, bet, res, cmb, imp] = mk(from, Math.min(from + 100, races)) as [string, string, string, string, string, string];
        await local.db.batch([
          local.db.prepare("INSERT INTO analyses (id, race_id, analyzed_at, ev_estimated, kaisai_date, model) SELECT value->>0, value->>1, value->>2, 0, value->>3, value->>4 FROM json_each(?)").bind(ana),
          local.db.prepare("INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, is_positive, mark) SELECT value->>0, value->>1, 0.3, 0.3, 0, value->>2 FROM json_each(?)").bind(hor),
          local.db.prepare("INSERT INTO analysis_bets (analysis_id, bet_type, combo_key, stake, odds, ev) SELECT value->>0, value->>1, value->>2, value->>3, value->>4, value->>5 FROM json_each(?)").bind(bet),
          local.db.prepare("INSERT INTO race_results (race_id, umaban, finish_position, win_payout, place_payout) SELECT value->>0, value->>1, value->>2, value->>3, value->>4 FROM json_each(?)").bind(res),
          local.db.prepare("INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) SELECT value->>0, value->>1, value->>2, value->>3 FROM json_each(?)").bind(cmb),
          local.db.prepare("INSERT INTO race_combo_payout_imports (race_id, bet_type) SELECT value->>0, value->>1 FROM json_each(?)").bind(imp),
        ]);
      }
    }

    it.each([{ races: 300 }, { races: 1000 }])("$races レース: 全行を取り込み(件数が合う)、rows_read が上限内", async ({ races }) => {
      await seed(races);
      const { rows, rowsRead } = await source().readPeriodRows("20260901", "20261010");
      // 前提(空振り防止): 行が実際に読めている(レース・買い目・印・結果・組合せ払戻・取込印)
      expect(rows.races).toHaveLength(races);
      expect(rows.bets).toHaveLength(races * 5);
      expect(rows.marks).toHaveLength(races * 6);
      expect(rows.results).toHaveLength(races * 14);
      expect(rows.combos).toHaveLength(races * 9);
      expect(rows.imports).toHaveLength(races * 3);
      // 実測(ローカルの workerd。このテストで再現できる): 300 レースで 30,001 行、1000 レースで 100,001 行 = 1 レースあたり約 100 行(レース数に比例。二乗では増えない)。
      // 内訳の目安: 返す行 38(レース 1・買い目 5・印 6・結果 14・組合せ払戻 9・取込印 3)+ 印の無い馬 8 + 最新の分析の選別と結合。本番の D1 の数え方がローカルと同じとは限らない。
      // Issue #278: 結果の SQL に scratched 列を足しても rows_read は変わらない(同じ行の列を足すだけ)。足す前も後も 300 レースで 30,001 行・1000 レースで 100,001 行(このテストの seed で測った)。
      // 1000 レース(上限の 1/3)でも約 10 万行 = Free の 1 日 500 万行の約 2%。日報は 1 日 1 回。
      expect(rowsRead).toBeGreaterThan(races * 40); // 計測が働いている(各表の行を実際に走査している)
      expect(rowsRead).toBeLessThanOrEqual(races * 120); // 実測 100 行/レースに 2 割の余裕。二乗に増える書き方(結合の取り違え)になれば超える
      const stats = await source().readPeriodStats("20260901", "20261010");
      expect(stats.raceCount).toBe(races);
      expect(stats.dayCount).toBe(8);
      expect(stats.judgedBetCount).toBe(races * 5);
    }, 120_000);
  });
});

describe("D1ReportStore.replaceReport(Issue #268: 作り直しの上書き)", () => {
  const store = () => new D1ReportStore({ db: local.db });
  /** 文章の無い記録(LLM が使えなかった日報)。 */
  const plain = (over: Partial<ReportRecord> = {}): ReportRecord =>
    record({ model: null, summary: null, llmCallsJson: null, body: { ...record().body, narrative: null, note: "LLM を使えなかったため、統計だけの日報です" }, ...over });

  it("前の日報を全列置き換える(LLM の文章がある同士)。本文・作成時刻・件数・集計・総括・LLM の記録のどれも新しい", async () => {
    const s = store();
    await s.saveReport(record());
    const next = record({
      createdAt: "2026-10-11T01:00:00.000Z", model: "claude-opus-5", raceCount: 7, totalStake: 700, totalReturn: 2100, summary: "作り直した総括",
      body: { ...record().body, narrative: { summary: "作り直した総括", good: ["新しい良い点"], improve: [], races: [] } },
      llmCallsJson: '[{"n":1}]',
    });
    expect(await s.replaceReport(next)).toBe("replaced");
    expect(await s.getReport(DATE)).toStrictEqual(next);
    expect((await s.listReports(10)).map((r) => r.kaisaiDate)).toEqual([DATE]); // 行が増えない
  });

  it("前が文章なし(本来の用途: LLM が失敗して統計だけで確定した日)なら、新しい記録が文章なしでも置き換える(最新の統計に更新される)", async () => {
    const s = store();
    await s.saveReport(plain({ totalReturn: 100 }));
    const next = plain({ createdAt: "2026-10-11T01:00:00.000Z", totalReturn: 999 });
    expect(await s.replaceReport(next)).toBe("replaced");
    expect((await s.getReport(DATE))!.totalReturn).toBe(999);
    expect((await s.getReport(DATE))!.createdAt).toBe("2026-10-11T01:00:00.000Z");
  });

  it("前が文章なしで、新しい記録に文章があれば置き換える(統計だけの日報を直すという本来の用途)", async () => {
    const s = store();
    await s.saveReport(plain());
    const next = record({ createdAt: "2026-10-11T01:00:00.000Z" });
    expect(await s.replaceReport(next)).toBe("replaced");
    expect(await s.getReport(DATE)).toStrictEqual(next);
  });

  it("前に文章があり、新しい記録に文章が無い(LLM が使えなかった作り直し)ときは置き換えない(kept)。前の日報は全列そのまま", async () => {
    const s = store();
    const before = record({ summary: "前の総括", totalReturn: 1400 });
    await s.saveReport(before);
    expect(await s.replaceReport(plain({ createdAt: "2026-10-11T01:00:00.000Z", totalReturn: 5, raceCount: 99 }))).toBe("kept");
    expect(await s.getReport(DATE)).toStrictEqual(before);
  });

  it("文章が生の文章(narrative なし・model あり)の記録は『文章あり』として扱う: 前が文章ありでも置き換える", async () => {
    const s = store();
    await s.saveReport(record());
    const raw = record({ createdAt: "2026-10-11T01:00:00.000Z", model: "claude-sonnet-5-5", summary: "生の文章の先頭", body: { ...record().body, narrative: null, narrativeRaw: "生の文章", note: "LLM の応答を構造として読めなかったため、生の文章を載せています" } });
    expect(await s.replaceReport(raw)).toBe("replaced");
    expect((await s.getReport(DATE))!.body.narrativeRaw).toBe("生の文章");
  });

  it("前の日報が無い日でも落ちず、通常の保存と同じに作る(置き換え扱い)", async () => {
    const s = store();
    expect(await s.replaceReport(record())).toBe("replaced");
    expect(await s.getReport(DATE)).toStrictEqual(record());
  });

  it("他の日の日報には触れない", async () => {
    const s = store();
    const other = record({ kaisaiDate: "20261009", summary: "別の日", body: { ...record().body, kaisaiDate: "20261009" } });
    await s.saveReport(other);
    await s.saveReport(record());
    await s.replaceReport(record({ summary: "作り直し", createdAt: "2026-10-11T01:00:00.000Z" }));
    expect(await s.getReport("20261009")).toStrictEqual(other);
  });

  it("対照: 通常の保存(saveReport)は、作り直しの導入後も上書きしない(INSERT OR IGNORE のまま)", async () => {
    const s = store();
    await s.saveReport(record({ summary: "最初" }));
    expect(await s.saveReport(record({ summary: "後から" }))).toBe("exists");
    expect((await s.getReport(DATE))!.summary).toBe("最初");
  });
});
