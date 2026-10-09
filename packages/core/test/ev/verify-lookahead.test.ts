import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  AnalysisStore,
  type AnalysisAllocationMetaRecord,
  type AnalysisRecord,
} from "../../src/ev/analysis-store.js";
import {
  computeVerifyReport,
  computeVerifyReportByPromptVersion,
  DEFAULT_VERIFY_CONFIG,
  type VerifyConfig,
  type VerifyReport,
} from "../../src/ev/verify.js";

/**
 * 先読みリーク疑いの除外(Issue #152 A)を、実 AnalysisStore(メモリ DB)と製品の
 * computeVerifyReport / computeVerifyReportByPromptVersion を通して検証する。
 *
 * 各行は「賭け金と払戻が出る EV プラス馬1頭(馬番1)」を持ち、分類が clean の行は的中(複勝 300円)、
 * それ以外は不的中にする。除外の有無で bet.totalStake・recoveryRate・calibration・
 * proposedBet.population が実際に動く。
 */

const ON: VerifyConfig = { ...DEFAULT_VERIFY_CONFIG, excludeLookaheadSuspects: true };
const OFF: VerifyConfig = DEFAULT_VERIFY_CONFIG;

/** 実在形式の中央 raceId(2026年・場コード06・回次03・日次 nn・11R)。 */
function centralId(nn: number): string {
  return `20260603${String(nn).padStart(2, "0")}11`;
}
/** 実在形式の地方 raceId(2026年・場コード44・月日 mmdd・rr R)。7〜10桁目が月日。 */
function narId(mmdd: string, rr: string): string {
  return `202644${mmdd}${rr}`;
}

function allocationMeta(): AnalysisAllocationMetaRecord {
  return {
    route: "place-only",
    unavailableReason: null,
    fallbackReason: null,
    skipReasonCode: null,
    comboOddsWide: null,
    comboOddsTrio: null,
    bankroll: 100000,
    perRaceCap: 10000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: false,
    includeWide: false,
    includeTrio: false,
    includeQuinella: false,
    includeExacta: false,
    includeTrifecta: false,
    includeBracketQuinella: false,
    betUnit: 100,
    greedySteps: 1000,
    candidateCap: 2000,
    modelId: "conditional-bernoulli",
    modelApproximate: false,
    oddsStatus: "result",
  };
}

/** 発走時刻つきスナップショット。startTime が null なら発走時刻なし(Task #34 より前の旧行を模す)。 */
function snapshot(startTime: string | null): unknown {
  return { race: { raceName: "テスト", startTime }, horses: [] };
}

type Expected = "clean" | "suspect" | "unknown";

interface Row {
  /** 表の行ラベル(失敗時にどの行か分かるようにする)。 */
  readonly label: string;
  readonly expected: Expected;
  readonly record: Partial<AnalysisRecord> & Pick<AnalysisRecord, "raceId" | "analyzedAt">;
  /** 結果を保存しない行(結果未保存のカウンタへ入る)。 */
  readonly noResult?: boolean;
  /** 同じレースの2件目以降は結果を保存し直さない。 */
  readonly skipSaveResult?: boolean;
}

const BOTH_MARKERS = { historyCutoffDate: "20260705", promptVersion: "v1", promptLookaheadGuarded: true } as const;

/** 行の表(brief の表1〜13+推定EVとの交差)。raceId は実在形式。 */
const ROWS: readonly Row[] = [
  {
    label: "1 発走前・マーカーNULL",
    expected: "clean",
    record: { raceId: centralId(1), kaisaiDate: "20260705", analyzedAt: "2026-07-05T05:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" },
  },
  {
    label: "2 発走後・両マーカーあり・LLM使用",
    expected: "clean",
    record: { raceId: centralId(2), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), ...BOTH_MARKERS },
  },
  {
    label: "3 発走後・マーカーNULL",
    expected: "suspect",
    record: { raceId: centralId(3), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" },
  },
  {
    label: "4 発走後・history あり・LLM使用・lookahead NULL",
    expected: "suspect",
    record: { raceId: centralId(4), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1", historyCutoffDate: "20260705" },
  },
  {
    label: "5 発走後・history あり・LLM未使用・lookahead NULL",
    expected: "clean",
    record: { raceId: centralId(5), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: null, historyCutoffDate: "20260705" },
  },
  {
    label: "6 中央・kaisai null・マーカーNULL・時刻なし",
    expected: "unknown",
    record: { raceId: centralId(6), kaisaiDate: null, analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot(null), promptVersion: "v1" },
  },
  {
    label: "7 地方・kaisai null・発走後",
    expected: "suspect",
    record: { raceId: narId("0714", "07"), kaisaiDate: null, analyzedAt: "2026-07-14T12:00:00.000Z", raceSnapshot: snapshot("20:50"), promptVersion: "v1" },
  },
  {
    label: "8 地方・kaisai null・前日",
    expected: "clean",
    record: { raceId: narId("0715", "08"), kaisaiDate: null, analyzedAt: "2026-07-14T10:00:00.000Z", raceSnapshot: snapshot(null), promptVersion: "v1" },
  },
  {
    label: "9a 同日・時刻なし",
    expected: "unknown",
    record: { raceId: centralId(9), kaisaiDate: "20260705", analyzedAt: "2026-07-05T03:00:00.000Z", raceSnapshot: snapshot(null), promptVersion: "v1" },
  },
  {
    label: "9b 前日・時刻なし",
    expected: "clean",
    record: { raceId: centralId(10), kaisaiDate: "20260705", analyzedAt: "2026-07-04T10:00:00.000Z", raceSnapshot: snapshot(null), promptVersion: "v1" },
  },
  {
    label: "9c 翌日・時刻なし",
    expected: "suspect",
    record: { raceId: centralId(11), kaisaiDate: "20260705", analyzedAt: "2026-07-06T00:00:00.000Z", raceSnapshot: snapshot(null), promptVersion: "v1" },
  },
  {
    label: "10a 地方 20:50 JST の1秒前(11:49:59Z)",
    expected: "clean",
    record: { raceId: narId("0714", "10"), kaisaiDate: null, analyzedAt: "2026-07-14T11:49:59.000Z", raceSnapshot: snapshot("20:50"), promptVersion: "v1" },
  },
  {
    label: "10b 地方 20:50 JST ちょうど(11:50:00Z)",
    expected: "suspect",
    record: { raceId: narId("0714", "12"), kaisaiDate: null, analyzedAt: "2026-07-14T11:50:00.000Z", raceSnapshot: snapshot("20:50"), promptVersion: "v1" },
  },
  {
    label: "11-old 同一レースの古い clean(発走前)",
    expected: "clean",
    record: { raceId: centralId(12), kaisaiDate: "20260705", analyzedAt: "2026-07-05T05:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" },
  },
  {
    label: "11-new 同一レースの新しい suspect(発走後)",
    expected: "suspect",
    record: { raceId: centralId(12), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" },
    skipSaveResult: true,
  },
  {
    label: "12 promptLookaheadGuarded: false",
    expected: "suspect",
    record: { raceId: centralId(13), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1", historyCutoffDate: "20260705", promptLookaheadGuarded: false },
  },
  {
    label: "13 suspect かつ結果なし",
    expected: "suspect",
    record: { raceId: centralId(14), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" },
    noResult: true,
  },
  {
    label: "15 clean かつ推定EV",
    expected: "clean",
    record: { raceId: centralId(15), kaisaiDate: "20260705", analyzedAt: "2026-07-05T05:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1", evEstimated: true },
  },
  {
    label: "16 suspect かつ推定EV",
    expected: "suspect",
    record: { raceId: centralId(16), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1", evEstimated: true },
  },
];

/** 行を保存する。clean のレースは的中(馬番1が1着・複勝300円)、それ以外は不的中(馬番2が1着・複勝150円)。 */
function seed(store: AnalysisStore, rows: readonly Row[]): void {
  const hitRaceIds = new Set(rows.filter((r) => r.expected === "clean").map((r) => r.record.raceId));
  for (const row of rows) {
    store.saveAnalysis({
      horses: [
        { umaban: 1, prior: 0.5, adjustedProb: 0.5, placeOddsMin: 2.0, ev: 1.0, isPositive: true, contributions: null, mark: null },
      ],
      allocation: {
        meta: allocationMeta(),
        bets: [{ betType: "place", comboKey: "01", stake: 100, odds: 2.0, ev: 1.0 }],
      },
      ...row.record,
    });
    if (row.noResult === true || row.skipSaveResult === true) {
      continue;
    }
    const hit = hitRaceIds.has(row.record.raceId);
    store.saveResult(
      row.record.raceId,
      hit
        ? [
            { umaban: 1, finishPosition: 1, placePayout: 300 },
            { umaban: 2, finishPosition: 2, placePayout: 150 },
          ]
        : [
            { umaban: 1, finishPosition: 5 },
            { umaban: 2, finishPosition: 1, placePayout: 150 },
          ],
    );
  }
}

/** 全カウンタの和(= 分析総数になるべき)。 */
function counterSum(r: VerifyReport): number {
  return (
    r.includedAnalysisCount +
    r.excludedAnalysisCount +
    r.supersededAnalysisCount +
    r.excludedEstimatedCount +
    r.excludedLookaheadSuspectCount +
    r.excludedLookaheadUnknownCount
  );
}

describe("verify の先読みリーク疑い除外(Issue #152 A)", () => {
  describe("分類表(実 AnalysisStore と classifyLookaheadSuspicion を通した各行の扱い)", () => {
    it("前提: 表は clean/suspect/unknown をそれぞれ含み、行数は19(カウンタの和の検算に使う)", () => {
      expect(ROWS).toHaveLength(19);
      expect(ROWS.filter((r) => r.expected === "clean")).toHaveLength(8);
      expect(ROWS.filter((r) => r.expected === "suspect")).toHaveLength(9);
      expect(ROWS.filter((r) => r.expected === "unknown")).toHaveLength(2);
    });

    it("flag ON: clean だけが集計され、suspect/unknown は別カウンタに入り、全カウンタの和が分析総数に一致する", () => {
      const store = new AnalysisStore();
      seed(store, ROWS);
      const report = computeVerifyReport(store, ON);

      // clean(結果あり・非推定・最新)は 1,2,5,8,9b,10a,11-old の7件。
      expect(report.includedAnalysisCount).toBe(7);
      // suspect で結果ありは 3,4,7,9c,10b,11-new,12,16 の8件。unknown は 6,9a の2件。
      expect(report.excludedLookaheadSuspectCount).toBe(8);
      expect(report.excludedLookaheadUnknownCount).toBe(2);
      // 13(suspect かつ結果なし)は結果未保存のカウンタが先に受ける(結果未保存→リーク疑いの順)。
      expect(report.excludedAnalysisCount).toBe(1);
      // 11-old(clean)は 11-new(suspect)に取って代わられない(分類してから最新を選ぶ)。
      expect(report.supersededAnalysisCount).toBe(0);
      // 15(clean かつ推定EV)は推定EVのカウンタ。16(suspect かつ推定EV)は suspect が先に受ける。
      expect(report.excludedEstimatedCount).toBe(1);
      expect(counterSum(report)).toBe(ROWS.length);
      store.close();
    });

    it("flag OFF: どちらの除外カウンタも 0 で、既存の母集団(結果あり・最新・非推定)がそのまま集計される", () => {
      const store = new AnalysisStore();
      seed(store, ROWS);
      const report = computeVerifyReport(store, OFF);

      expect(report.excludedLookaheadSuspectCount).toBe(0);
      expect(report.excludedLookaheadUnknownCount).toBe(0);
      // 13 のみ結果なし。11-old は 11-new に取って代わられる。15・16 は推定EV。
      expect(report.excludedAnalysisCount).toBe(1);
      expect(report.supersededAnalysisCount).toBe(1);
      expect(report.excludedEstimatedCount).toBe(2);
      expect(report.includedAnalysisCount).toBe(15);
      expect(counterSum(report)).toBe(ROWS.length);
      store.close();
    });

    it("DEFAULT_VERIFY_CONFIG は excludeLookaheadSuspects=false(既定では既存の集計を変えない)", () => {
      expect(DEFAULT_VERIFY_CONFIG.excludeLookaheadSuspects).toBe(false);
      const store = new AnalysisStore();
      seed(store, ROWS);
      // 引数を省略した呼び出しは flag OFF と同じ。
      expect(computeVerifyReport(store)).toEqual(computeVerifyReport(store, OFF));
      store.close();
    });

    it("除外の有無で回収率・賭け金・キャリブレーション・配分ベースの母集団が実際に動く(前提を無条件に固定する)", () => {
      const store = new AnalysisStore();
      seed(store, ROWS);
      const on = computeVerifyReport(store, ON);
      const off = computeVerifyReport(store, OFF);

      // ON: 7件×100円・的中7件×300円 → 回収率 3.0。
      expect(on.bet.totalStake).toBe(700);
      expect(on.bet.totalReturn).toBe(2100);
      expect(on.bet.recoveryRate).toBe(3);
      // OFF: 15件×100円。的中は 1,2,5,8,9b,10a と 11-new のレース(clean の 11-old と同じ結果)の7件。
      expect(off.bet.totalStake).toBe(1500);
      expect(off.bet.totalReturn).toBe(2100);
      expect(off.bet.recoveryRate).toBeCloseTo(1.4, 12);
      // 前提: ON と OFF で回収率が実際に異なる(同じなら除外の効果をこのテストで検出できない)。
      expect(on.bet.recoveryRate).not.toBe(off.bet.recoveryRate);

      // キャリブレーション: 予測 0.5 は帯10(50-55%。20帯)。ON は 7件中7件的中、OFF は 15件中7件的中。
      expect(on.calibration[10]!.predictedCount).toBe(7);
      expect(on.calibration[10]!.placedCount).toBe(7);
      expect(off.calibration[10]!.predictedCount).toBe(15);
      expect(off.calibration[10]!.placedCount).toBe(7);

      // 配分ベース: 母集団(allocated)と賭け金・払戻が同じ母集団に追随する。
      expect(on.proposedBet.population.allocated).toBe(7);
      expect(off.proposedBet.population.allocated).toBe(15);
      expect(on.proposedBet.overall.totalStake).toBe(700);
      expect(off.proposedBet.overall.totalStake).toBe(1500);
      store.close();
    });

    it("includeAllAnalyses:true(全件モード)でも flag ON なら suspect/unknown を除く(最新選択がないので 11-old は clean として残る)", () => {
      const store = new AnalysisStore();
      seed(store, ROWS);
      const report = computeVerifyReport(store, { ...ON, includeAllAnalyses: true });
      expect(report.supersededAnalysisCount).toBe(0);
      expect(report.excludedLookaheadSuspectCount).toBe(8);
      expect(report.excludedLookaheadUnknownCount).toBe(2);
      expect(report.includedAnalysisCount).toBe(7);
      expect(counterSum(report)).toBe(ROWS.length);
      store.close();
    });

    it("開催区分フィルタ(central/nar)でも除外が効き、中央+地方の件数が全体に一致する", () => {
      const store = new AnalysisStore();
      seed(store, ROWS);
      const all = computeVerifyReport(store, ON, "all");
      const central = computeVerifyReport(store, ON, "central");
      const nar = computeVerifyReport(store, ON, "nar");
      // 前提: 地方の行(7,8,10a,10b の4件)が実際に地方側へ入っている。
      expect(counterSum(nar)).toBe(4);
      expect(counterSum(central)).toBe(ROWS.length - 4);
      expect(central.excludedLookaheadSuspectCount + nar.excludedLookaheadSuspectCount).toBe(
        all.excludedLookaheadSuspectCount,
      );
      expect(central.excludedLookaheadUnknownCount + nar.excludedLookaheadUnknownCount).toBe(
        all.excludedLookaheadUnknownCount,
      );
      expect(central.includedAnalysisCount + nar.includedAnalysisCount).toBe(all.includedAnalysisCount);
      store.close();
    });
  });

  describe("プロンプト版別集計(computeVerifyReportByPromptVersion)", () => {
    function seedTwoVersions(store: AnalysisStore): void {
      seed(store, [
        // v1: clean 1件・suspect 1件(別レース)・同一レースで古い clean と新しい suspect。
        { label: "v1-clean", expected: "clean", record: { raceId: centralId(1), kaisaiDate: "20260705", analyzedAt: "2026-07-05T05:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" } },
        { label: "v1-suspect", expected: "suspect", record: { raceId: centralId(2), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" } },
        { label: "v1-old-clean", expected: "clean", record: { raceId: centralId(3), kaisaiDate: "20260705", analyzedAt: "2026-07-05T05:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" } },
        { label: "v1-new-suspect", expected: "suspect", record: { raceId: centralId(3), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v1" }, skipSaveResult: true },
        // v2: suspect のみ。
        { label: "v2-suspect", expected: "suspect", record: { raceId: centralId(4), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: "v2" } },
        // 版不明(LLM未使用)・戦績が絞られている → clean。unknown は版不明グループに入る。
        { label: "null-clean", expected: "clean", record: { raceId: centralId(5), kaisaiDate: "20260705", analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot("15:45"), promptVersion: null, historyCutoffDate: "20260705" } },
        { label: "null-unknown", expected: "unknown", record: { raceId: centralId(6), kaisaiDate: null, analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot(null), promptVersion: null } },
      ]);
    }

    it("flag ON: 各版グループにも同じ除外が効き、グループごとの和が分析数に一致する", () => {
      const store = new AnalysisStore();
      seedTwoVersions(store);
      const groups = computeVerifyReportByPromptVersion(store, ON);
      expect(groups.map((g) => g.promptVersion)).toEqual(["v1", "v2", null]);

      const [v1, v2, none] = groups.map((g) => g.report);
      // v1: 4件(2レース分の clean と、別レース・同一レースの suspect)中 included 2(v1-clean・v1-old-clean)、suspect 2(v1-suspect・v1-new-suspect)。同一レースで clean が残る。
      expect(v1!.includedAnalysisCount).toBe(2);
      expect(v1!.excludedLookaheadSuspectCount).toBe(2);
      expect(v1!.supersededAnalysisCount).toBe(0);
      expect(counterSum(v1!)).toBe(4);
      // v2: suspect のみ。
      expect(v2!.includedAnalysisCount).toBe(0);
      expect(v2!.excludedLookaheadSuspectCount).toBe(1);
      expect(counterSum(v2!)).toBe(1);
      // 版不明: clean 1・unknown 1。
      expect(none!.includedAnalysisCount).toBe(1);
      expect(none!.excludedLookaheadUnknownCount).toBe(1);
      expect(counterSum(none!)).toBe(2);
      store.close();
    });

    it("flag OFF: どの版グループも除外カウンタは 0(既存の集計のまま)", () => {
      const store = new AnalysisStore();
      seedTwoVersions(store);
      const groups = computeVerifyReportByPromptVersion(store, OFF);
      for (const g of groups) {
        expect(g.report.excludedLookaheadSuspectCount).toBe(0);
        expect(g.report.excludedLookaheadUnknownCount).toBe(0);
      }
      // 前提: OFF では v1 の同一レースの旧分析が superseded になる(ON では 0)。
      expect(groups[0]!.report.supersededAnalysisCount).toBe(1);
      store.close();
    });
  });

  describe("旧スキーマのDB(2列が無い)から開いて集計する", () => {
    it("JSON スナップショット入りの旧行を開いて集計すると、発走前後が判定できる行は suspect・できない行は unknown に分類され、移行後の listAnalyses は null を返す", () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE analyses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          race_id TEXT NOT NULL,
          analyzed_at TEXT NOT NULL,
          ev_estimated INTEGER,
          prompt_version TEXT,
          additional_instruction TEXT,
          kaisai_date TEXT,
          model TEXT,
          raw_response TEXT,
          race_snapshot_json TEXT
        );
        CREATE TABLE analysis_horses (
          analysis_id INTEGER NOT NULL,
          umaban INTEGER NOT NULL,
          prior REAL NOT NULL,
          adjusted_prob REAL NOT NULL,
          place_odds_min REAL,
          ev REAL,
          is_positive INTEGER NOT NULL,
          contributions_json TEXT,
          mark TEXT,
          reason TEXT,
          PRIMARY KEY (analysis_id, umaban),
          FOREIGN KEY (analysis_id) REFERENCES analyses (id)
        );
      `);
      const insertAnalysis = db.prepare(
        `INSERT INTO analyses (race_id, analyzed_at, ev_estimated, prompt_version, kaisai_date, race_snapshot_json)
         VALUES (?, ?, 0, 'v1', ?, ?)`,
      );
      const insertHorse = db.prepare(
        `INSERT INTO analysis_horses (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark, reason)
         VALUES (?, 1, 0.5, 0.5, 2.0, 1.0, 1, NULL, NULL, NULL)`,
      );
      // 旧行A: 開催日あり・発走後の分析 → suspect(両マーカーが NULL のため)。
      const a = Number(
        insertAnalysis.run(centralId(1), "2026-07-05T07:00:00.000Z", "20260705", JSON.stringify(snapshot("15:45"))).lastInsertRowid,
      );
      // 旧行B: 中央・開催日なし(Task #34 より前) → unknown。
      const b = Number(
        insertAnalysis.run(centralId(2), "2026-07-05T07:00:00.000Z", null, JSON.stringify(snapshot(null))).lastInsertRowid,
      );
      insertHorse.run(a);
      insertHorse.run(b);

      const store = new AnalysisStore({ database: db });
      store.saveResult(centralId(1), [{ umaban: 1, finishPosition: 1, placePayout: 300 }]);
      store.saveResult(centralId(2), [{ umaban: 1, finishPosition: 1, placePayout: 300 }]);

      const stored = store.listAnalyses();
      expect(stored.map((s) => [s.historyCutoffDate, s.promptLookaheadGuarded])).toEqual([
        [null, null],
        [null, null],
      ]);

      const on = computeVerifyReport(store, ON);
      expect(on.excludedLookaheadSuspectCount).toBe(1);
      expect(on.excludedLookaheadUnknownCount).toBe(1);
      expect(on.includedAnalysisCount).toBe(0);
      expect(counterSum(on)).toBe(2);

      // flag OFF では従来どおり2件とも集計される(既存の数値は変わらない)。
      const off = computeVerifyReport(store, OFF);
      expect(off.includedAnalysisCount).toBe(2);
      expect(off.excludedLookaheadSuspectCount).toBe(0);
      expect(off.excludedLookaheadUnknownCount).toBe(0);
      store.close();
    });
  });
});
