/**
 * 月報(Issue #265・#279)の D1 の読み書き。
 *
 *  - {@link D1MonthlyStore}: `monthly_reports`(migration 0015)の保存・読み出し。1 か月 1 行で、通常の保存は同じ月を上書きしない(`INSERT OR IGNORE`)。上書きは作り直し(Issue #280)だけが、`REPLACE_MONTHLY_SQL` の 1 文の UPSERT で行う。
 *  - {@link D1MonthlySource}: 月の統計の再集計と、最終日 1 日分の状態の読み出し。
 *    - 月の統計は、日報の 28 日累計の「直前 27 日」と同じ 6 文の 1 回の batch(サブリクエスト 1。`readPeriodRowsFrom`)で行を読み、`buildMonthStats` で日ごと・版ごとの行つきの統計にする。
 *      読み取り行数は日報の期間の再集計と同じ(1 レースあたり約 100 行。月に 300〜1000 レースなら約 3 万〜10 万行。上限 `PERIOD_ANALYSES_LIMIT`〈3000〉レースを超えれば例外)。
 *    - 最終日の状態は軽い 1 問い合わせ({@link LAST_DAY_STATUS_SQL})。待ちのたびに大きな再集計を読み直さないために分けている。
 */
import type { LastDayStatus, MonthlyReportBody, MonthlyReportRecord, MonthlySource, MonthlyStore } from "./monthly-report-core";
import { readPeriodRowsFrom, type ReportDb } from "./daily-report-repository";
import { buildMonthStats, type MonthStats } from "./monthly-stats";

/** 一覧に出す件数の上限と既定(月報は 1 年 12 件。数年分を余裕で返せる)。 */
export const MONTHLY_LIST_DEFAULT_LIMIT = 36;
export const MONTHLY_LIST_MAX_LIMIT = 120;

export const INSERT_MONTHLY_SQL =
  "INSERT OR IGNORE INTO monthly_reports (month, created_at, model, race_count, total_stake, total_return, summary, body_json, llm_calls_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
/**
 * 作り直し(Issue #280)の上書き: 同じ月の月報を **1 文の UPSERT** で置き換える(途中の状態が無く、失敗すれば前の月報のまま)。日報の `REPLACE_REPORT_SQL` と同じ規則。
 * **WHERE**: 新しい記録に LLM の文章がある(`model` が非 NULL。文章か生の文章があるとき入る)か、前の月報に文章が無い(`model` が NULL)ときだけ置き換える。
 * 文章のある前の月報を、LLM が使えなかった作り直しの「文章なし」で潰さないため。偽なら何も変えず `meta.changes` が 0(= `kept`)。
 */
export const REPLACE_MONTHLY_SQL = `INSERT INTO monthly_reports (month, created_at, model, race_count, total_stake, total_return, summary, body_json, llm_calls_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(month) DO UPDATE SET created_at = excluded.created_at, model = excluded.model, race_count = excluded.race_count, total_stake = excluded.total_stake,
    total_return = excluded.total_return, summary = excluded.summary, body_json = excluded.body_json, llm_calls_json = excluded.llm_calls_json
  WHERE excluded.model IS NOT NULL OR monthly_reports.model IS NULL`;
const SELECT_MONTHLY_SQL =
  "SELECT month, created_at AS createdAt, model, race_count AS raceCount, total_stake AS totalStake, total_return AS totalReturn, summary, body_json AS bodyJson, llm_calls_json AS llmCallsJson FROM monthly_reports WHERE month = ?";
const LIST_MONTHLY_SQL =
  "SELECT month, created_at AS createdAt, model, race_count AS raceCount, total_stake AS totalStake, total_return AS totalReturn, summary FROM monthly_reports ORDER BY month DESC LIMIT ?";
const HAS_MONTHLY_SQL = "SELECT 1 AS present FROM monthly_reports WHERE month = ?";

/**
 * 最終日 1 日分の状態(束縛値は `[日, 日]`)。分析はレースごとに最新の 1 件(日報の `LIST_DAY_ANALYSES_SQL` と同じ規則)。
 * `raceCount`: 分析したレース数。`noResultRaceCount`: そのうち `race_results` に 1 行も無いレース数(日報の「結果なし」と同じ判定)。`hasDailyReport`: その日の日報があるか(0/1)。
 * 読み取りは最終日の分析の行(`idx_analyses_kaisai_date`)と、そのレースの結果の主キーの引きだけ(1 日 数十レース)。
 */
export const LAST_DAY_STATUS_SQL = `WITH latest AS (
  SELECT race_id FROM (
    SELECT race_id, ROW_NUMBER() OVER (PARTITION BY race_id ORDER BY analyzed_at DESC, id DESC) AS rn
    FROM analyses WHERE kaisai_date = ?
  ) WHERE rn = 1
)
SELECT
  (SELECT COUNT(*) FROM latest) AS raceCount,
  (SELECT COUNT(*) FROM latest l WHERE NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = l.race_id)) AS noResultRaceCount,
  EXISTS (SELECT 1 FROM daily_reports d WHERE d.kaisai_date = ?) AS hasDailyReport`;

/** 一覧の 1 行(本文は含まない)。 */
export interface MonthlyListRow {
  readonly month: string;
  readonly createdAt: string;
  readonly model: string | null;
  readonly raceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly summary: string | null;
}

interface MonthlyRow extends MonthlyListRow {
  readonly bodyJson: string;
  readonly llmCallsJson: string | null;
}

export class D1MonthlyStore implements MonthlyStore {
  private readonly db: ReportDb;

  constructor(options: { readonly db: ReportDb }) {
    this.db = options.db;
  }

  async hasReport(month: string): Promise<boolean> {
    const row = await this.db.prepare(HAS_MONTHLY_SQL).bind(month).first<{ present: number }>();
    return row !== null && row !== undefined;
  }

  async saveReport(record: MonthlyReportRecord): Promise<"saved" | "exists"> {
    const result = await this.db
      .prepare(INSERT_MONTHLY_SQL)
      .bind(record.month, record.createdAt, record.model, record.raceCount, record.totalStake, record.totalReturn, record.summary, JSON.stringify(record.body), record.llmCallsJson)
      .run();
    return (result.meta.changes ?? 0) > 0 ? "saved" : "exists";
  }

  /** 作り直しの上書き(Issue #280。`REPLACE_MONTHLY_SQL` の説明)。前の月報が無ければ通常の保存と同じに作る。 */
  async replaceReport(record: MonthlyReportRecord): Promise<"replaced" | "kept"> {
    const result = await this.db
      .prepare(REPLACE_MONTHLY_SQL)
      .bind(record.month, record.createdAt, record.model, record.raceCount, record.totalStake, record.totalReturn, record.summary, JSON.stringify(record.body), record.llmCallsJson)
      .run();
    return (result.meta.changes ?? 0) > 0 ? "replaced" : "kept";
  }

  /** 月報 1 件(本文つき)。無い・本文が JSON として読めない行は null。 */
  async getReport(month: string): Promise<MonthlyReportRecord | null> {
    const row = await this.db.prepare(SELECT_MONTHLY_SQL).bind(month).first<MonthlyRow>();
    if (row === null || row === undefined) {
      return null;
    }
    let body: MonthlyReportBody;
    try {
      body = JSON.parse(row.bodyJson) as MonthlyReportBody;
    } catch {
      return null;
    }
    if (typeof body !== "object" || body === null) {
      return null;
    }
    return {
      month: row.month,
      createdAt: row.createdAt,
      model: row.model ?? null,
      raceCount: row.raceCount,
      totalStake: row.totalStake,
      totalReturn: row.totalReturn,
      summary: row.summary ?? null,
      body,
      llmCallsJson: row.llmCallsJson ?? null,
    };
  }

  /** 月の新しい順の一覧(本文は読まない)。 */
  async listReports(limit: number = MONTHLY_LIST_DEFAULT_LIMIT): Promise<MonthlyListRow[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MONTHLY_LIST_MAX_LIMIT) {
      throw new RangeError(`limit は 1〜${MONTHLY_LIST_MAX_LIMIT} の整数で指定してください`);
    }
    const { results } = await this.db.prepare(LIST_MONTHLY_SQL).bind(limit).all<MonthlyListRow>();
    return results.map((r) => ({ month: r.month, createdAt: r.createdAt, model: r.model ?? null, raceCount: r.raceCount, totalStake: r.totalStake, totalReturn: r.totalReturn, summary: r.summary ?? null }));
  }
}

export class D1MonthlySource implements MonthlySource {
  private readonly db: ReportDb;

  constructor(options: { readonly db: ReportDb }) {
    this.db = options.db;
  }

  async lastDayStatus(date: string): Promise<LastDayStatus> {
    const row = await this.db.prepare(LAST_DAY_STATUS_SQL).bind(date, date).first<{ raceCount: number; noResultRaceCount: number; hasDailyReport: number }>();
    return { raceCount: row?.raceCount ?? 0, noResultRaceCount: row?.noResultRaceCount ?? 0, hasDailyReport: (row?.hasDailyReport ?? 0) === 1 };
  }

  async readMonthStats(fromDate: string, toDate: string): Promise<MonthStats> {
    const { rows } = await readPeriodRowsFrom(this.db, fromDate, toDate);
    return buildMonthStats(rows, { fromDate, toDate });
  }
}
