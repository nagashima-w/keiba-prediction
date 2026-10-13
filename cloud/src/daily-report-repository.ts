/**
 * 日報(Issue #235)の D1 の読み書き。
 *
 *  - {@link D1ReportStore}: `daily_reports`(migration 0010)の保存・読み出し・取り残しの列挙。1 日 1 行で、通常の保存は同じ日を上書きしない(`INSERT OR IGNORE`)。作り直し(Issue #268)だけが `replaceReport` で上書きする。
 *  - {@link D1ReportSource}: 日報の材料の読み出し。分析は既存の `D1AnalysisStore`(要約 + R2 の詳細)と `buildAnalysisView` を再利用し(馬名・レース情報・根拠・強調材料・懸念事項・配分)、
 *    結果(着順・払戻・組合せ払戻)は `race_id IN (json_each(?))` の 3 文を 1 回の batch で読む(束縛は JSON 1 つ。レース数に依らない)。
 *
 * ## サブリクエスト(Workers Free は 1 呼び出し 50)
 * `readRaces` が 1 回に読むのは {@link REPORT_READ_CHUNK}(8)レースまで。1 レースは分析の詳細の batch 1・R2 の get 1・読み出しの回数の記録 1・配分の batch 1 の計 4、
 * 結果の batch が 1 で、8 レースで 33(`test/daily-report-repository.test.ts` が数えて固定している)。
 */
import type { AnalysisDetailResult, AnalysisRepository } from "./analysis-repository";
import { buildAnalysisView } from "./analysis-view";
import type { ComboPayouts, RaceResultData, ResultHorse } from "./daily-report-bets";
import type { DayAnalysisRef, RaceInput, ReportBody, ReportRecord, ReportSource, ReportStore } from "./daily-report-core";
import { buildPeriodStats, type PeriodRows, type PeriodStats } from "./period-stats";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type ReportDb = Pick<D1Database, "prepare" | "batch">;

/** 一覧に出す件数の上限と既定。 */
export const REPORT_LIST_DEFAULT_LIMIT = 60;
export const REPORT_LIST_MAX_LIMIT = 200;

/** 1 日の分析の列挙の上限(1 日の分析は多くて数十件。手動の再実行が重なっても余裕のある値)。 */
export const DAY_ANALYSES_LIMIT = 1000;

const INSERT_REPORT_SQL =
  "INSERT OR IGNORE INTO daily_reports (kaisai_date, created_at, model, race_count, total_stake, total_return, summary, body_json, llm_calls_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
/**
 * 作り直し(Issue #268)の上書き。1 文の UPSERT で、途中の状態が無い。
 * **WHERE**: 新しい記録に LLM の文章がある(`model` が非 NULL。文章か生の文章があるとき `buildRecord` が入れる)か、前の日報に文章が無い(`model` が NULL)ときだけ置き換える。
 * 文章のある前の日報を、LLM が使えなかった作り直しの「文章なし」で潰さないため。偽なら何も変えず `meta.changes` が 0(= `kept`)。
 */
const REPLACE_REPORT_SQL = `INSERT INTO daily_reports (kaisai_date, created_at, model, race_count, total_stake, total_return, summary, body_json, llm_calls_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(kaisai_date) DO UPDATE SET created_at = excluded.created_at, model = excluded.model, race_count = excluded.race_count, total_stake = excluded.total_stake,
    total_return = excluded.total_return, summary = excluded.summary, body_json = excluded.body_json, llm_calls_json = excluded.llm_calls_json
  WHERE excluded.model IS NOT NULL OR daily_reports.model IS NULL`;
const SELECT_REPORT_SQL =
  "SELECT kaisai_date AS kaisaiDate, created_at AS createdAt, model, race_count AS raceCount, total_stake AS totalStake, total_return AS totalReturn, summary, body_json AS bodyJson, llm_calls_json AS llmCallsJson FROM daily_reports WHERE kaisai_date = ?";
const LIST_REPORTS_SQL =
  "SELECT kaisai_date AS kaisaiDate, created_at AS createdAt, model, race_count AS raceCount, total_stake AS totalStake, total_return AS totalReturn, summary FROM daily_reports ORDER BY kaisai_date DESC LIMIT ?";
const HAS_REPORT_SQL = "SELECT 1 AS present FROM daily_reports WHERE kaisai_date = ?";
/** 範囲 [from, to] の開催日のうち、分析があるのに日報が無い日(`idx_analyses_kaisai_date`)。束縛値は `[from, to]`。 */
export const NEEDING_REPORT_SQL = `SELECT DISTINCT a.kaisai_date AS kaisaiDate FROM analyses a
           WHERE a.kaisai_date >= ? AND a.kaisai_date <= ?
             AND NOT EXISTS (SELECT 1 FROM daily_reports d WHERE d.kaisai_date = a.kaisai_date)
           ORDER BY a.kaisai_date`;

/** 開催日の分析を、新しいものが先になる並びで読む(同じレースの最新を 1 件選ぶのは JS)。束縛値は `[kaisaiDate, limit]`。 */
export const LIST_DAY_ANALYSES_SQL = `SELECT id AS analysisId, race_id AS raceId FROM analyses WHERE kaisai_date = ?
           ORDER BY race_id, analyzed_at DESC, id DESC LIMIT ?`;

/** 結果の 3 文(束縛値はどれも JSON 配列 1 つ)。 */
export const READ_RESULTS_SQL = {
  results: `SELECT race_id AS raceId, umaban, finish_position AS finishPosition, win_payout AS winPayout, place_payout AS placePayout, scratched, wakuban
           FROM race_results WHERE race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id, umaban`,
  combos: `SELECT race_id AS raceId, bet_type AS betType, combo_key AS comboKey, payout
           FROM race_combo_payouts WHERE race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id, bet_type, combo_key`,
  imports: `SELECT race_id AS raceId, bet_type AS betType FROM race_combo_payout_imports WHERE race_id IN (SELECT value FROM json_each(?))`,
} as const;

/**
 * 期間の再集計(Issue #264)が対象にするレース数の上限。期間(日報では直前 27 日)に分析したレースの数がこれを超えたら、**黙って一部だけ集計せず例外にする**
 * (日報の段階の再試行に任せる。一部だけの累計を LLM に渡して「4 週」と呼ばせない)。1 日の上限(`DAY_ANALYSES_LIMIT` 1000)ではなく期間のものなので、その数倍。
 */
export const PERIOD_ANALYSES_LIMIT = 3000;

/** 期間の「レースごとに最新の 1 件」(日報の `LIST_DAY_ANALYSES_SQL` と同じ規則)。束縛値は `[from, to, 上限 + 1]`(上限を超えたかを見分けるため 1 つ多く取る)。 */
const PERIOD_LATEST_CTE = `WITH latest AS (
  SELECT id, race_id, kaisai_date, model, prompt_version FROM (
    SELECT id, race_id, kaisai_date, model, prompt_version, ROW_NUMBER() OVER (PARTITION BY race_id ORDER BY analyzed_at DESC, id DESC) AS rn
    FROM analyses WHERE kaisai_date >= ? AND kaisai_date <= ?
  ) WHERE rn = 1 ORDER BY race_id LIMIT ?
)`;

/**
 * 期間の再集計が読む 6 文(Issue #264)。**読み取り専用・R2 に触れない**。どれも束縛値は `[from, to, 上限 + 1]` の 3 つで、1 回の `db.batch`(サブリクエスト 1)で流す。
 * 日報の `readResults`(3 文)と同じ表・同じ列を、レース ID の JSON の代わりに「最新の分析の副問い合わせ」で絞って読む。
 * 並びは主キー順(`analysis_bets`・`analysis_horses`・`race_results` の主キーの先頭が id/race_id)。
 */
export const READ_PERIOD_SQL = {
  races: `${PERIOD_LATEST_CTE} SELECT id AS analysisId, race_id AS raceId, kaisai_date AS kaisaiDate, model, prompt_version AS promptVersion FROM latest ORDER BY race_id`,
  bets: `${PERIOD_LATEST_CTE} SELECT b.analysis_id AS analysisId, b.bet_type AS betType, b.combo_key AS comboKey, b.stake, b.odds, b.ev
           FROM analysis_bets b JOIN latest l ON l.id = b.analysis_id ORDER BY b.analysis_id, b.bet_type, b.combo_key`,
  marks: `${PERIOD_LATEST_CTE} SELECT h.analysis_id AS analysisId, h.umaban, h.mark
           FROM analysis_horses h JOIN latest l ON l.id = h.analysis_id WHERE h.mark IS NOT NULL ORDER BY h.analysis_id, h.umaban`,
  results: `${PERIOD_LATEST_CTE} SELECT r.race_id AS raceId, r.umaban, r.finish_position AS finishPosition, r.win_payout AS winPayout, r.place_payout AS placePayout, r.scratched, r.wakuban
           FROM race_results r WHERE r.race_id IN (SELECT race_id FROM latest) ORDER BY r.race_id, r.umaban`,
  combos: `${PERIOD_LATEST_CTE} SELECT c.race_id AS raceId, c.bet_type AS betType, c.combo_key AS comboKey, c.payout
           FROM race_combo_payouts c WHERE c.race_id IN (SELECT race_id FROM latest) ORDER BY c.race_id, c.bet_type, c.combo_key`,
  imports: `${PERIOD_LATEST_CTE} SELECT i.race_id AS raceId, i.bet_type AS betType
           FROM race_combo_payout_imports i WHERE i.race_id IN (SELECT race_id FROM latest)`,
} as const;

/**
 * `race_results.scratched`(INTEGER。Issue #72)を `ResultHorse.scratched` に直す。1 → true、0 → false、NULL(未記録の旧い行)・未取得はキー自体を付けない
 * (未記録を false にしない。取消か中止か分からない着順なしは、判定が従来どおりはずれにする。`verify-read.ts` と同じ)。
 */
function scratchedField(value: number | null | undefined): { scratched?: boolean } {
  return value === null || value === undefined ? {} : { scratched: value === 1 };
}

/**
 * `race_results.wakuban`(INTEGER。Issue #269)を `ResultHorse.wakuban` に直す。値はそのまま、NULL(未記録の旧い行)・未取得はキー自体を付けない
 * (枠連の返還は、枠番が1頭でも未記録のレースを判定しない。`verify-read.ts` と同じ)。
 */
function wakubanField(value: number | null | undefined): { wakuban?: number } {
  return value === null || value === undefined ? {} : { wakuban: value };
}

/**
 * 期間 `[fromDate, toDate]` の、レースごとに最新の分析の行を読む(Issue #264)。1 回の batch(サブリクエスト 1)。`rowsRead` は D1 が報告した `meta.rows_read` の合計(実測用)。
 * 対象のレースが `limit` を超えたら例外(一部だけの集計を返さない)。日報の 28 日累計(`D1ReportSource`)と月報(`D1MonthlySource`。Issue #279)が共有する。
 */
export async function readPeriodRowsFrom(db: ReportDb, fromDate: string, toDate: string, limit: number = PERIOD_ANALYSES_LIMIT): Promise<{ readonly rows: PeriodRows; readonly rowsRead: number }> {
  const bind = (sql: string) => db.prepare(sql).bind(fromDate, toDate, limit + 1);
  const responses = await db.batch([
    bind(READ_PERIOD_SQL.races),
    bind(READ_PERIOD_SQL.bets),
    bind(READ_PERIOD_SQL.marks),
    bind(READ_PERIOD_SQL.results),
    bind(READ_PERIOD_SQL.combos),
    bind(READ_PERIOD_SQL.imports),
  ]);
  const [races, bets, marks, results, combos, imports] = responses.map((r) => (r?.results ?? []) as unknown[]);
  if ((races?.length ?? 0) > limit) {
    throw new RangeError(`期間 ${fromDate}〜${toDate} に分析したレースが上限(${limit} 件)を超えています。一部だけの集計は返しません`);
  }
  const rowsRead = responses.reduce((n, r) => n + (r?.meta?.rows_read ?? 0), 0);
  return {
    rows: {
      races: races as PeriodRows["races"],
      bets: bets as PeriodRows["bets"],
      marks: marks as PeriodRows["marks"],
      results: (results as Array<Omit<PeriodRows["results"][number], "scratched" | "wakuban"> & { scratched?: number | null; wakuban?: number | null }>).map(({ scratched, wakuban, ...r }) => ({
        ...r,
        finishPosition: r.finishPosition ?? null,
        winPayout: r.winPayout ?? null,
        placePayout: r.placePayout ?? null,
        ...scratchedField(scratched),
        ...wakubanField(wakuban),
      })),
      combos: combos as PeriodRows["combos"],
      imports: imports as PeriodRows["imports"],
    },
    rowsRead,
  };
}

/** 一覧の 1 行(本文は含まない)。 */
export interface ReportListRow {
  readonly kaisaiDate: string;
  readonly createdAt: string;
  readonly model: string | null;
  readonly raceCount: number;
  readonly totalStake: number;
  readonly totalReturn: number;
  readonly summary: string | null;
}

interface ReportRow extends ReportListRow {
  readonly bodyJson: string;
  readonly llmCallsJson: string | null;
}

export class D1ReportStore implements ReportStore {
  private readonly db: ReportDb;

  constructor(options: { readonly db: ReportDb }) {
    this.db = options.db;
  }

  async hasReport(kaisaiDate: string): Promise<boolean> {
    const row = await this.db.prepare(HAS_REPORT_SQL).bind(kaisaiDate).first<{ present: number }>();
    return row !== null && row !== undefined;
  }

  async saveReport(record: ReportRecord): Promise<"saved" | "exists"> {
    const result = await this.db
      .prepare(INSERT_REPORT_SQL)
      .bind(record.kaisaiDate, record.createdAt, record.model, record.raceCount, record.totalStake, record.totalReturn, record.summary, JSON.stringify(record.body), record.llmCallsJson)
      .run();
    return (result.meta.changes ?? 0) > 0 ? "saved" : "exists";
  }

  /** 作り直しの上書き(Issue #268。`REPLACE_REPORT_SQL` の説明)。前の日報が無ければ通常の保存と同じに作る。 */
  async replaceReport(record: ReportRecord): Promise<"replaced" | "kept"> {
    const result = await this.db
      .prepare(REPLACE_REPORT_SQL)
      .bind(record.kaisaiDate, record.createdAt, record.model, record.raceCount, record.totalStake, record.totalReturn, record.summary, JSON.stringify(record.body), record.llmCallsJson)
      .run();
    return (result.meta.changes ?? 0) > 0 ? "replaced" : "kept";
  }

  /** 日報 1 件(本文つき)。無い・本文が JSON として読めない行は null。 */
  async getReport(kaisaiDate: string): Promise<ReportRecord | null> {
    const row = await this.db.prepare(SELECT_REPORT_SQL).bind(kaisaiDate).first<ReportRow>();
    if (row === null || row === undefined) {
      return null;
    }
    let body: ReportBody;
    try {
      body = JSON.parse(row.bodyJson) as ReportBody;
    } catch {
      return null;
    }
    if (typeof body !== "object" || body === null) {
      return null;
    }
    return {
      kaisaiDate: row.kaisaiDate,
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

  /** 開催日の新しい順の一覧(本文は読まない)。 */
  async listReports(limit: number = REPORT_LIST_DEFAULT_LIMIT): Promise<ReportListRow[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > REPORT_LIST_MAX_LIMIT) {
      throw new RangeError(`limit は 1〜${REPORT_LIST_MAX_LIMIT} の整数で指定してください`);
    }
    const { results } = await this.db.prepare(LIST_REPORTS_SQL).bind(limit).all<ReportListRow>();
    return results.map((r) => ({ kaisaiDate: r.kaisaiDate, createdAt: r.createdAt, model: r.model ?? null, raceCount: r.raceCount, totalStake: r.totalStake, totalReturn: r.totalReturn, summary: r.summary ?? null }));
  }

  /** 範囲 [from, to] の開催日のうち、分析があるのに日報が無い日(昇順)。取り残しの補完が使う。 */
  async listDatesNeedingReport(from: string, to: string): Promise<string[]> {
    const { results } = await this.db.prepare(NEEDING_REPORT_SQL).bind(from, to).all<{ kaisaiDate: string }>();
    return results.map((r) => r.kaisaiDate);
  }
}

export interface D1ReportSourceOptions {
  readonly db: ReportDb;
  readonly analyses: Pick<AnalysisRepository, "getAnalysisDetail" | "getStoredAllocation">;
}

export class D1ReportSource implements ReportSource {
  private readonly db: ReportDb;
  private readonly analyses: D1ReportSourceOptions["analyses"];

  constructor(options: D1ReportSourceOptions) {
    this.db = options.db;
    this.analyses = options.analyses;
  }

  async listDayAnalyses(kaisaiDate: string): Promise<readonly DayAnalysisRef[]> {
    const { results } = await this.db.prepare(LIST_DAY_ANALYSES_SQL).bind(kaisaiDate, DAY_ANALYSES_LIMIT).all<{ analysisId: number; raceId: string }>();
    // レース ID 昇順・分析時刻の新しい順に並んでいるので、レースごとの先頭が最新。
    const out: DayAnalysisRef[] = [];
    for (const row of results) {
      if (out.length === 0 || out[out.length - 1]!.raceId !== row.raceId) {
        out.push({ raceId: row.raceId, analysisId: row.analysisId });
      }
    }
    return out;
  }

  async readRaces(items: readonly DayAnalysisRef[]): Promise<ReadonlyArray<RaceInput | null>> {
    if (items.length === 0) {
      return [];
    }
    const results = await this.readResults([...new Set(items.map((i) => i.raceId))]);
    const out: Array<RaceInput | null> = [];
    for (const item of items) {
      const detail: AnalysisDetailResult | undefined = await this.analyses.getAnalysisDetail(item.analysisId);
      if (detail === undefined) {
        out.push(null);
        continue;
      }
      const allocation = await this.analyses.getStoredAllocation(item.analysisId);
      out.push({ view: buildAnalysisView(detail, allocation), result: results.get(item.raceId) });
    }
    return out;
  }

  /**
   * 期間 `[fromDate, toDate]` の、レースごとに最新の分析の行を読む(Issue #264)。1 回の batch。`rowsRead` は D1 が報告した `meta.rows_read` の合計(実測用)。
   * 対象のレースが `limit` を超えたら例外(一部だけの集計を返さない)。実体は {@link readPeriodRowsFrom}(月報〈Issue #279〉も同じ関数を使う)。
   */
  async readPeriodRows(fromDate: string, toDate: string, limit: number = PERIOD_ANALYSES_LIMIT): Promise<{ readonly rows: PeriodRows; readonly rowsRead: number }> {
    return readPeriodRowsFrom(this.db, fromDate, toDate, limit);
  }

  /** 期間 `[fromDate, toDate]` の統計(日報の 1 日の統計と同じ形・同じ集計)。 */
  async readPeriodStats(fromDate: string, toDate: string): Promise<PeriodStats> {
    const { rows } = await this.readPeriodRows(fromDate, toDate);
    return buildPeriodStats(rows, { fromDate, toDate });
  }

  /** 結果の 3 文を 1 回の batch で読み、レースごとにまとめる。結果の行(馬)が 1 件も無いレースは Map に入れない。 */
  private async readResults(raceIds: readonly string[]): Promise<Map<string, RaceResultData>> {
    const json = JSON.stringify(raceIds);
    const [horseRes, comboRes, importRes] = await this.db.batch([
      this.db.prepare(READ_RESULTS_SQL.results).bind(json),
      this.db.prepare(READ_RESULTS_SQL.combos).bind(json),
      this.db.prepare(READ_RESULTS_SQL.imports).bind(json),
    ]);
    const horses = new Map<string, ResultHorse[]>();
    for (const r of (horseRes?.results ?? []) as Array<Omit<ResultHorse, "scratched" | "wakuban"> & { raceId: string; scratched?: number | null; wakuban?: number | null }>) {
      const list = horses.get(r.raceId) ?? [];
      list.push({ umaban: r.umaban, finishPosition: r.finishPosition ?? null, winPayout: r.winPayout ?? null, placePayout: r.placePayout ?? null, ...scratchedField(r.scratched), ...wakubanField(r.wakuban) });
      horses.set(r.raceId, list);
    }
    const combos = new Map<string, Record<string, { imported: boolean; payouts: { comboKey: string; payout: number }[] }>>();
    const slot = (raceId: string, betType: string): { imported: boolean; payouts: { comboKey: string; payout: number }[] } => {
      const byType = combos.get(raceId) ?? {};
      combos.set(raceId, byType);
      return (byType[betType] ??= { imported: false, payouts: [] });
    };
    for (const r of (importRes?.results ?? []) as Array<{ raceId: string; betType: string }>) {
      slot(r.raceId, r.betType).imported = true;
    }
    for (const r of (comboRes?.results ?? []) as Array<{ raceId: string; betType: string; comboKey: string; payout: number }>) {
      slot(r.raceId, r.betType).payouts.push({ comboKey: r.comboKey, payout: r.payout });
    }
    const out = new Map<string, RaceResultData>();
    for (const [raceId, list] of horses) {
      out.set(raceId, { horses: list, combos: (combos.get(raceId) ?? {}) as Readonly<Record<string, ComboPayouts>> });
    }
    return out;
  }
}
