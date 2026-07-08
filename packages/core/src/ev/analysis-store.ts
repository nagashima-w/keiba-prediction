/**
 * 分析結果のSQLite保存(verify基盤)。仕様「4. ev」:
 *   「全推定結果をSQLiteに保存し、レース後に実際の結果と突き合わせて回収率を記録するverify機能」。
 *
 * スキーマ設計:
 * - `analyses`(レース単位): id・race_id・analyzed_at。同一レースを複数回分析しうるため
 *   (発走前/直前オッズ再取得など)、race_id では一意にせず analyzed_at ごとに別行(別id)とする。
 * - `analysis_horses`(馬単位): analysis_id(FK)・umaban・prior・adjusted_prob・place_odds_min・ev・
 *   is_positive・contributions_json。Phase3(analyzer)まで adjusted_prob は prior と同値で保存する。
 *   寄与度ログ(仕様L135)は構造が可変のため JSON 文字列で保持する。
 * - `race_results`(レース結果): race_id・umaban・finish_position。(race_id, umaban) を主キーとし
 *   再保存は上書き。非数値着順(中止・除外)は finish_position を NULL で保持する。
 *
 * 今後の拡張(LLM補正値・Discord送信履歴)は列/テーブル追加で対応する前提とし、今は必要列のみ持つ。
 * adjusted_prob 列は将来のLLM補正値の受け皿を兼ねる(現状は prior と同値)。
 *
 * DB共有: ScrapeCache と同じ better-sqlite3 Database インスタンスを注入して共有できる。
 * テーブル名を分離しているため互いに干渉しない(scrape_cache とは独立)。
 */

import Database from "better-sqlite3";

const ANALYSES_TABLE = "analyses";
const ANALYSIS_HORSES_TABLE = "analysis_horses";
const RACE_RESULTS_TABLE = "race_results";

/** 保存する分析の1頭分。 */
export interface AnalysisHorseRecord {
  /** 馬番。 */
  readonly umaban: number;
  /** 事前複勝確率(prior)。 */
  readonly prior: number;
  /** 補正後複勝確率(Phase3まで prior と同値)。 */
  readonly adjustedProb: number;
  /** 使用した複勝オッズ下限。欠損時は null。 */
  readonly placeOddsMin: number | null;
  /** 期待値。オッズ欠損時は null。 */
  readonly ev: number | null;
  /** EVが閾値を上回ったか。 */
  readonly isPositive: boolean;
  /** 寄与度ログ(JSON化して保存)。無ければ null。 */
  readonly contributions: unknown;
}

/** 保存する分析(レース単位)。 */
export interface AnalysisRecord {
  /** レースID。 */
  readonly raceId: string;
  /** 分析日時(ISO文字列など、そのまま保持)。 */
  readonly analyzedAt: string;
  /** 各馬の推定結果。 */
  readonly horses: readonly AnalysisHorseRecord[];
}

/** 復元した分析の1頭分(contributions は JSON からパース済み)。 */
export interface StoredAnalysisHorse {
  readonly umaban: number;
  readonly prior: number;
  readonly adjustedProb: number;
  readonly placeOddsMin: number | null;
  readonly ev: number | null;
  readonly isPositive: boolean;
  readonly contributions: unknown;
}

/** 復元した分析(レース単位)。 */
export interface StoredAnalysis {
  /** 分析ID(採番)。 */
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly horses: StoredAnalysisHorse[];
}

/** レース結果の1頭分。 */
export interface RaceResultEntry {
  /** 馬番。 */
  readonly umaban: number;
  /** 実着順。非数値着順(中止・除外・着順不明)は null。 */
  readonly finishPosition: number | null;
}

/** listAnalyses の絞り込み条件。 */
export interface AnalysisFilter {
  /** レースIDで絞り込む。 */
  readonly raceId?: string;
}

/** AnalysisStore の構築オプション。 */
export interface AnalysisStoreOptions {
  /** SQLiteファイルパス。省略時は ":memory:"。`database` 指定時は無視。 */
  filename?: string;
  /** 既存の better-sqlite3 Database を注入(ScrapeCache との共有時に使用)。 */
  database?: Database.Database;
}

/** 分析馬行のDB表現。 */
interface HorseRow {
  umaban: number;
  prior: number;
  adjusted_prob: number;
  place_odds_min: number | null;
  ev: number | null;
  is_positive: number;
  contributions_json: string | null;
}

/**
 * 分析結果と実結果を保存するSQLiteストア。verify(回収率・キャリブレーション)の基盤。
 */
export class AnalysisStore {
  private readonly db: Database.Database;

  constructor(options: AnalysisStoreOptions = {}) {
    this.db = options.database ?? new Database(options.filename ?? ":memory:");
    this.initSchema();
  }

  /** テーブルを(存在しなければ)作成する。 */
  private initSchema(): void {
    // 外部キー制約を明示的に有効化する。SQLiteの外部キーは接続単位の設定で、ビルドによっては
    // 既定OFF(FK宣言が装飾扱い)になるため、環境に依存せず孤児行を弾けるよう接続時に必ずONにする。
    // これは接続単位の設定であり、同一接続を共有する ScrapeCache(FK不使用)には副作用がない。
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${ANALYSES_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        race_id TEXT NOT NULL,
        analyzed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${ANALYSES_TABLE}_race
        ON ${ANALYSES_TABLE} (race_id);
      CREATE TABLE IF NOT EXISTS ${ANALYSIS_HORSES_TABLE} (
        analysis_id INTEGER NOT NULL,
        umaban INTEGER NOT NULL,
        prior REAL NOT NULL,
        adjusted_prob REAL NOT NULL,
        place_odds_min REAL,
        ev REAL,
        is_positive INTEGER NOT NULL,
        contributions_json TEXT,
        PRIMARY KEY (analysis_id, umaban),
        FOREIGN KEY (analysis_id) REFERENCES ${ANALYSES_TABLE} (id)
      );
      CREATE TABLE IF NOT EXISTS ${RACE_RESULTS_TABLE} (
        race_id TEXT NOT NULL,
        umaban INTEGER NOT NULL,
        finish_position INTEGER,
        PRIMARY KEY (race_id, umaban)
      );
    `);
  }

  /**
   * 分析結果を保存し、採番された分析IDを返す。レース行と馬行をトランザクションで一括保存する。
   * @param record レース単位の分析結果
   */
  saveAnalysis(record: AnalysisRecord): number {
    const insertAnalysis = this.db.prepare(
      `INSERT INTO ${ANALYSES_TABLE} (race_id, analyzed_at) VALUES (?, ?)`,
    );
    const insertHorse = this.db.prepare(
      `INSERT INTO ${ANALYSIS_HORSES_TABLE}
         (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction((rec: AnalysisRecord): number => {
      const info = insertAnalysis.run(rec.raceId, rec.analyzedAt);
      const analysisId = Number(info.lastInsertRowid);
      for (const h of rec.horses) {
        insertHorse.run(
          analysisId,
          h.umaban,
          h.prior,
          h.adjustedProb,
          h.placeOddsMin,
          h.ev,
          h.isPositive ? 1 : 0,
          h.contributions === undefined || h.contributions === null
            ? null
            : JSON.stringify(h.contributions),
        );
      }
      return analysisId;
    });

    return tx(record);
  }

  /**
   * レース後の実着順を保存する。(race_id, umaban) 主キーで再保存は上書きする。
   * @param raceId レースID
   * @param results 馬番→着順(非数値着順は finishPosition=null)
   */
  saveResult(raceId: string, results: readonly RaceResultEntry[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO ${RACE_RESULTS_TABLE} (race_id, umaban, finish_position)
       VALUES (?, ?, ?)
       ON CONFLICT(race_id, umaban) DO UPDATE SET
         finish_position = excluded.finish_position`,
    );
    const tx = this.db.transaction((rows: readonly RaceResultEntry[]) => {
      for (const r of rows) {
        upsert.run(raceId, r.umaban, r.finishPosition);
      }
    });
    tx(results);
  }

  /**
   * レースの実着順を取得する。1件も保存されていなければ undefined を返す。
   * @param raceId レースID
   */
  getResult(raceId: string): RaceResultEntry[] | undefined {
    const rows = this.db
      .prepare(
        `SELECT umaban, finish_position AS finishPosition
           FROM ${RACE_RESULTS_TABLE} WHERE race_id = ? ORDER BY umaban`,
      )
      .all(raceId) as Array<{ umaban: number; finishPosition: number | null }>;
    if (rows.length === 0) {
      return undefined;
    }
    return rows.map((r) => ({ umaban: r.umaban, finishPosition: r.finishPosition }));
  }

  /**
   * 保存済み分析を取得する。filter.raceId を与えるとそのレースのみに絞り込む。
   * 分析はID昇順(保存順)、馬は馬番昇順で返す。
   * @param filter 絞り込み条件(省略時は全件)
   */
  listAnalyses(filter: AnalysisFilter = {}): StoredAnalysis[] {
    const analyses = (
      filter.raceId === undefined
        ? this.db
            .prepare(
              `SELECT id, race_id AS raceId, analyzed_at AS analyzedAt
                 FROM ${ANALYSES_TABLE} ORDER BY id`,
            )
            .all()
        : this.db
            .prepare(
              `SELECT id, race_id AS raceId, analyzed_at AS analyzedAt
                 FROM ${ANALYSES_TABLE} WHERE race_id = ? ORDER BY id`,
            )
            .all(filter.raceId)
    ) as Array<{ id: number; raceId: string; analyzedAt: string }>;

    const horseStmt = this.db.prepare(
      `SELECT umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json
         FROM ${ANALYSIS_HORSES_TABLE} WHERE analysis_id = ? ORDER BY umaban`,
    );

    return analyses.map((a) => {
      const horseRows = horseStmt.all(a.id) as HorseRow[];
      return {
        id: a.id,
        raceId: a.raceId,
        analyzedAt: a.analyzedAt,
        horses: horseRows.map(toStoredHorse),
      };
    });
  }

  /** 内部の better-sqlite3 Database への参照(検証・拡張用)。 */
  get rawDatabase(): Database.Database {
    return this.db;
  }

  /** データベース接続を閉じる。 */
  close(): void {
    this.db.close();
  }
}

/** DB行から復元済み馬レコードへ変換する(is_positive の 0/1、JSON の復元を含む)。 */
function toStoredHorse(row: HorseRow): StoredAnalysisHorse {
  return {
    umaban: row.umaban,
    prior: row.prior,
    adjustedProb: row.adjusted_prob,
    placeOddsMin: row.place_odds_min,
    ev: row.ev,
    isPositive: row.is_positive !== 0,
    contributions:
      row.contributions_json === null ? null : JSON.parse(row.contributions_json),
  };
}
