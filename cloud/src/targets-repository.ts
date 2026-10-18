/**
 * 「今日の狙い目」(Issue #336)の D1 の読み取り。**読み取り専用・R2 に触れない**(馬名は R2 のスナップショットにしか無いので出さない。◎は馬番だけ)。
 *
 * 1 日ぶんを、**最初に「レースごとに最新の分析」の id を 1 回だけ求め**(日報の期間の再集計 `PERIOD_LATEST_CTE` と同じ規則を単日に絞ったもの。`idx_analyses_kaisai_date` を使う)、
 * 続けて **その id を整数リテラルの列で渡して**、買い目の batch と再計算の batch を並べて流し、最後に◎の batch を流す。
 * 同じ副問い合わせを文ごとに繰り返さない(副問い合わせを各文に付けると、その分の読み取りが文の数だけ重なる)。id を `json_each` で束縛する形も、文ごとに余計な読み取りがかかる。{@link idList} の説明も参照。
 *  - ① 最新の分析(1 文の batch)。0 件なら、ここで終わる(以降の文を流さない)。
 *  - ② 買い目の batch(買い目の集計〈`stake > 0` の点数・合計・最大 EV〉): 失敗は握らず投げる(呼び出し側が 503 にする)。
 *  - ③ 再計算の batch(回の状態・回ごとの買い目の集計。Issue #338 の表): ②と並べて流す。**失敗(表が無い間を含む)は握って null にする**
 *    (migration の適用前に Worker が先に出た場合でも、分析時の提案で一覧を出せるように。`GET /api/analyses/{id}` の `getStoredClose` の扱いと同じ)。
 *  - ④ ◎の batch: **表示対象(分析時に買い目がある分析、または再計算の ok の回に買い目がある分析)の id だけ**を引く。馬の行は 1 分析に十数行あり、◎の探索が最も重いため、
 *    買い目のない分析(一覧に載らない)の馬は読まない。そのため買い目のない分析の `markUmaban` は常に null。失敗は握らず投げる。
 * 買い目・馬・再計算は主キーの先頭(analysis_id)で引く。
 *
 * 読み取り行数の予算は {@link TARGETS_ROWS_READ_BUDGET}(`test/targets-repository.test.ts` が、最悪の日〈72 レース全部が分析済み・買い目 10 点・再計算 2 回〉と現実的な日〈3 分の 1 が狙い目〉で実測して固定)。
 * 読み取り行数は買い目の行数にほぼ比例する(1 分析あたりの買い目が 10 点を大きく超える日は予算を超えうる)。
 */
import type { TargetsAnalysisRow, TargetsCloseRoundRow } from "./targets-view";
import {
  VERIFY_DAY_ANALYSES_SQL,
  verifyDayAllocationSql,
  verifyDayResultSql,
  type VerifyAnalysisRow,
  type VerifyBetRow,
  type VerifyAllocationMetaRow,
  type VerifyComboImportRow,
  type VerifyComboPayoutRow,
  type VerifyReadRows,
  type VerifyResultRow,
} from "./verify-read";

export type TargetsDb = Pick<D1Database, "prepare" | "batch">;

/** 1 日ぶんの読み取り行数の予算(`meta.rows_read` の合計がこれ未満)。Free の 1 日 500 万行に対して、1 回の取得を約 0.1% に抑える目安。 */
export const TARGETS_ROWS_READ_BUDGET = 5000;

/**
 * 収支の途中経過(Issue #361。{@link D1TargetsStore.readLedger})の読み取り行数の予算(`meta.rows_read` の合計がこれ未満)。**上の {@link TARGETS_ROWS_READ_BUDGET} とは別の読みで、1 回の取得では両方が流れる**
 * (合計は `TARGETS_ROWS_READ_BUDGET` + この値)。根拠は `test/targets-repository.test.ts` の最悪の日の実測(出力の `[targets-ledger]` 行)。
 */
export const TARGETS_LEDGER_ROWS_READ_BUDGET = 5000;

/** ◎の印(予想印の文字)。 */
const MARK_HONMEI = "◎";

/** レースごとに最新の 1 件(分析日時の降順、同時刻は id の降順)。束縛値は開催日。 */
export const TARGETS_ANALYSES_SQL = `SELECT id AS analysisId, race_id AS raceId, analyzed_at AS analyzedAt FROM (
    SELECT id, race_id, analyzed_at, ROW_NUMBER() OVER (PARTITION BY race_id ORDER BY analyzed_at DESC, id DESC) AS rn
    FROM analyses WHERE kaisai_date = ?
  ) WHERE rn = 1 ORDER BY race_id`;

/**
 * 以降の文の絞り込みは、最新の分析の id の**整数リテラルの列**(`analysis_id IN (1,2,…)`)にする。束縛(`json_each` の副問い合わせ)にすると、文ごとに余計な読み取りがかかり
 * (その分は `meta.rows_read` に載る)、D1 の束縛値の上限(1 文 100 個)にも縛られる。**値は D1 から読んだ整数だけ**(`idList` が整数でなければ投げる。利用者の入力は入らない)。
 */
function idList(ids: readonly number[]): string {
  if (!ids.every((id) => Number.isSafeInteger(id))) {
    throw new TypeError("分析 id が整数ではありません");
  }
  return ids.join(",");
}

/** 主の batch の 2 文。`ids` は {@link idList} の出力(整数の列だけ)。 */
export function targetsSql(ids: string) {
  return {
    bets: `SELECT analysis_id AS analysisId, COUNT(*) AS betCount, SUM(stake) AS totalStake, MAX(ev) AS maxEv FROM analysis_bets WHERE stake > 0 AND analysis_id IN (${ids}) GROUP BY analysis_id`,
    /** 束縛値は ◎。 */
    marks: `SELECT analysis_id AS analysisId, MIN(umaban) AS umaban FROM analysis_horses WHERE analysis_id IN (${ids}) AND mark = ? GROUP BY analysis_id`,
  } as const;
}

/** 再計算の batch の 2 文。 */
export function targetsCloseSql(ids: string) {
  return {
    rounds: `SELECT analysis_id AS analysisId, round, status FROM analysis_close WHERE analysis_id IN (${ids}) ORDER BY analysis_id, round`,
    bets: `SELECT analysis_id AS analysisId, round, COUNT(*) AS betCount, SUM(stake) AS totalStake, MAX(ev) AS maxEv FROM analysis_close_bets WHERE stake > 0 AND analysis_id IN (${ids}) GROUP BY analysis_id, round`,
  } as const;
}

export interface TargetsDayRows {
  /** レースごとに最新の分析(race_id の昇順)。 */
  readonly analyses: readonly TargetsAnalysisRow[];
  /** 再計算の回(分析 id・回の昇順)。表が無い・読めなかったときは null。結果が 1 つも無い日は空の配列。 */
  readonly closeRounds: readonly TargetsCloseRoundRow[] | null;
  /** D1 が報告した `meta.rows_read` の合計(2 回の batch ぶん。実測・診断用)。 */
  readonly rowsRead: number;
}

interface AnalysisBase {
  analysisId: number;
  raceId: string;
  analyzedAt: string;
}
interface BetAgg {
  analysisId: number;
  betCount: number;
  totalStake: number;
  maxEv: number | null;
}
interface CloseBetAgg extends BetAgg {
  round: number;
}
interface RoundBase {
  analysisId: number;
  round: number;
  status: string;
}

const rowsOf = <T>(response: { results?: unknown[] } | undefined): T[] => (response?.results ?? []) as T[];
const rowsReadOf = (responses: readonly ({ meta?: { rows_read?: number } } | undefined)[]): number => responses.reduce((n, r) => n + (r?.meta?.rows_read ?? 0), 0);

export class D1TargetsStore {
  private readonly db: TargetsDb;

  constructor(options: { readonly db: TargetsDb }) {
    this.db = options.db;
  }

  async readDay(kaisaiDate: string): Promise<TargetsDayRows> {
    const first = await this.db.batch([this.db.prepare(TARGETS_ANALYSES_SQL).bind(kaisaiDate)]);
    const base = rowsOf<AnalysisBase>(first[0]);
    let rowsRead = rowsReadOf(first);
    if (base.length === 0) {
      return { analyses: [], closeRounds: [], rowsRead };
    }
    const ids = idList(base.map((a) => a.analysisId));
    const main2 = targetsSql(ids);
    const close2 = targetsCloseSql(ids);
    // 再計算の batch は握る(失敗しても、買い目の batch の失敗を隠さず、買い目の結果を捨てない)。並べて流す。
    const closePromise = this.db.batch([this.db.prepare(close2.rounds), this.db.prepare(close2.bets)]).then(
      (close) => close,
      () => null,
    );
    const betsBatch = await this.db.batch([this.db.prepare(main2.bets)]).catch(async (error: unknown) => {
      await closePromise; // 流した再計算の batch を宙に浮かせない
      throw error;
    });
    const bets = new Map(rowsOf<BetAgg>(betsBatch[0]).map((b) => [b.analysisId, b] as const));
    rowsRead += rowsReadOf(betsBatch);
    const close = await closePromise;

    // ◎は表示対象(分析時に買い目がある、または再計算の ok の回に買い目がある)の分析だけ引く。
    const shown = new Set<number>(base.filter((a) => (bets.get(a.analysisId)?.betCount ?? 0) > 0).map((a) => a.analysisId));
    if (close !== null) {
      const okRounds = new Set(rowsOf<RoundBase>(close[0]).filter((r) => r.status === "ok").map((r) => `${r.analysisId}:${r.round}`));
      for (const b of rowsOf<CloseBetAgg>(close[1])) {
        if (b.betCount > 0 && okRounds.has(`${b.analysisId}:${b.round}`)) shown.add(b.analysisId);
      }
    }
    const marks = new Map<number, number>();
    if (shown.size > 0) {
      const marksBatch = await this.db.batch([this.db.prepare(targetsSql(idList([...shown])).marks).bind(MARK_HONMEI)]);
      for (const m of rowsOf<{ analysisId: number; umaban: number }>(marksBatch[0])) marks.set(m.analysisId, m.umaban);
      rowsRead += rowsReadOf(marksBatch);
    }
    const analyses: TargetsAnalysisRow[] = base.map((a) => ({
      analysisId: a.analysisId,
      raceId: a.raceId,
      analyzedAt: a.analyzedAt,
      betCount: bets.get(a.analysisId)?.betCount ?? 0,
      totalStake: bets.get(a.analysisId)?.totalStake ?? 0,
      maxEv: bets.get(a.analysisId)?.maxEv ?? null,
      markUmaban: marks.get(a.analysisId) ?? null,
    }));

    let closeRounds: TargetsCloseRoundRow[] | null = null; // 表が無い間(migration の適用前)・読み出しの失敗: 再計算なし(分析時の提案で出す)。例外の文面は持たない
    if (close !== null) {
      const closeBets = new Map(rowsOf<CloseBetAgg>(close[1]).map((b) => [`${b.analysisId}:${b.round}`, b] as const));
      closeRounds = rowsOf<RoundBase>(close[0]).map((r) => {
        const agg = closeBets.get(`${r.analysisId}:${r.round}`);
        return { analysisId: r.analysisId, round: r.round, status: r.status, betCount: agg?.betCount ?? 0, totalStake: agg?.totalStake ?? 0, maxEv: agg?.maxEv ?? null };
      });
      rowsRead += rowsReadOf(close);
    }
    return { analyses, closeRounds, rowsRead };
  }

  /**
   * 収支の途中経過(Issue #361)が使う行を読む。**検証画面の全件の読み(`VERIFY_READ_SQL`)と同じ列・同じ並びを、その日で絞ったもの**(`verify-read.ts` の `verifyDay*Sql`)。
   * 検証の最新の選択(先読みを除いた clean の中で最新)を再現するため、`readDay` と違って**最新だけでなく、その日の全分析**を読む。馬の行は読まない(判定に使わない)。
   *  - ① 分析(開催日で絞る。`idx_analyses_kaisai_date`)。0 件ならここで終わる。
   *  - ② 配分のメタと買い目(分析 id の整数リテラルの列で引く。主キーの先頭)。
   *  - ③ 結果・組合せ払戻・取込印: **買い目のあるレースだけ**(買い目が無いレースの結果は収支に影響しないので読まない)。買い目のあるレースが無ければ流さない。
   * 失敗は握らず投げる(呼び出し側が、収支なしで一覧を出す)。
   */
  async readLedger(kaisaiDate: string): Promise<{ readonly rows: VerifyReadRows; readonly rowsRead: number }> {
    const first = await this.db.batch([this.db.prepare(VERIFY_DAY_ANALYSES_SQL).bind(kaisaiDate)]);
    const analyses = rowsOf<VerifyAnalysisRow>(first[0]);
    let rowsRead = rowsReadOf(first);
    const empty = { analyses, horses: [], allocationMeta: [], bets: [], results: [], comboPayouts: [], comboImports: [] } satisfies VerifyReadRows;
    if (analyses.length === 0) return { rows: empty, rowsRead };

    const allocation = verifyDayAllocationSql(analyses.map((a) => a.id));
    const second = await this.db.batch([this.db.prepare(allocation.allocationMeta), this.db.prepare(allocation.bets)]);
    const allocationMeta = rowsOf<VerifyAllocationMetaRow>(second[0]);
    const bets = rowsOf<VerifyBetRow>(second[1]);
    rowsRead += rowsReadOf(second);

    const raceOfAnalysis = new Map(analyses.map((a) => [a.id, a.raceId] as const));
    const betRaceIds = [...new Set(bets.flatMap((b) => raceOfAnalysis.get(b.analysisId) ?? []))].sort();
    if (betRaceIds.length === 0) return { rows: { ...empty, allocationMeta, bets }, rowsRead };

    const result = verifyDayResultSql(betRaceIds);
    const third = await this.db.batch([this.db.prepare(result.results), this.db.prepare(result.comboPayouts), this.db.prepare(result.comboImports)]);
    rowsRead += rowsReadOf(third);
    return {
      rows: { analyses, horses: [], allocationMeta, bets, results: rowsOf<VerifyResultRow>(third[0]), comboPayouts: rowsOf<VerifyComboPayoutRow>(third[1]), comboImports: rowsOf<VerifyComboImportRow>(third[2]) },
      rowsRead,
    };
  }
}
