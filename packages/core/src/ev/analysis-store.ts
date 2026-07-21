/**
 * 分析結果のSQLite保存(verify基盤)。仕様「4. ev」:
 *   「全推定結果をSQLiteに保存し、レース後に実際の結果と突き合わせて回収率を記録するverify機能」。
 *
 * スキーマ設計:
 * - `analyses`(レース単位): id・race_id・analyzed_at。同一レースを複数回分析しうるため
 *   (発走前/直前オッズ再取得など)、race_id では一意にせず analyzed_at ごとに別行(別id)とする。
 * - `analysis_horses`(馬単位): analysis_id(FK)・umaban・prior・adjusted_prob・place_odds_min・ev・
 *   is_positive・contributions_json・mark。Phase3(analyzer)まで adjusted_prob は prior と同値で保存する。
 *   寄与度ログ(仕様L135)は構造が可変のため JSON 文字列で保持する。
 * - `race_results`(レース結果): race_id・umaban・finish_position。(race_id, umaban) を主キーとし
 *   再保存は上書き。非数値着順(中止・除外)は finish_position を NULL で保持する。
 *
 * 今後の拡張(LLM補正値・Discord送信履歴)は列/テーブル追加で対応する前提とし、今は必要列のみ持つ。
 * adjusted_prob 列は将来のLLM補正値の受け皿を兼ねる(現状は prior と同値)。
 *
 * 予想印(mark)列(Task#23): analysis_horses に mark TEXT(nullable)を持つ。旧バージョンで
 * 作成済みのDBファイルにはこの列が無いため、起動時に PRAGMA table_info で存在確認し、
 * 無ければ ALTER TABLE ADD COLUMN で後付けする(既存行は NULL=印なしとして読める。後方互換)。
 *
 * 推定EVフラグ(ev_estimated)列(Task#25): analyses に ev_estimated INTEGER(nullable)を持つ。
 * 発売前(oddsStatus=yoso)は複勝オッズが無いため単勝オッズから推定した複勝下限でEVを概算するが、
 * この推定EVは確定EVより誤差が大きく、verify(回収率集計)では既定で除外する必要がある(仕様Task#25)。
 * 複勝オッズ有無は馬ごとではなくレース単位(オッズ発売状態)で決まるため、馬単位ではなく
 * analyses(レース単位)テーブルに1列だけ持たせれば足りる(analysis_horgesへの追加は不要)。
 * 旧バージョンで作成済みのDBにはこの列が無いため、mark列と同じ流儀でALTER TABLEにより後付けし、
 * 既存行は NULL→false(確定EV扱い)として読む(後方互換。旧データは本機能導入前の分析のため
 * すべて確定EV経路で計算されている)。
 *
 * DB共有: ScrapeCache と同じ better-sqlite3 Database インスタンスを注入して共有できる。
 * テーブル名を分離しているため互いに干渉しない(scrape_cache とは独立)。
 *
 * プロンプト版番号(prompt_version)列(Task#27): analyses に prompt_version TEXT(nullable)を持つ。
 * プロンプトを改善したときに版ごとの verify 成績を比較できるようにするための記録で、
 * buildPrompt が使う PROMPT_VERSION 定数(analyzer/build-prompt.ts)の値をそのまま保存する
 * (LLM未使用〈prior採用〉の分析ではプロンプト自体を使っていないため呼び出し側は null を渡す想定)。
 * 旧バージョンで作成済みのDBにはこの列が無いため、mark/ev_estimated列と同じ流儀でALTER TABLEに
 * より後付けし、既存行は NULL=版不明として読む(後方互換。旧データは版記録導入前の分析のため
 * どのプロンプト文面で分析したか特定できない)。
 *
 * 追加指示(additional_instruction)列(Task#28 プロンプト改善C): analyses に
 * additional_instruction TEXT(nullable)を持つ。設定画面の自由記述欄(analyzer/build-prompt.ts の
 * BuildPromptInput.additionalInstruction)の内容をそのまま保存する。追加指示は実質的にプロンプトを
 * 変えるため、PROMPT_VERSION(テンプレート本体の版)とは別軸でこの列を記録し、
 * 「同じ版でも追加指示が違えば別条件」であることをverifyの版別比較の解釈時に追えるようにする
 * (PROMPT_VERSION定数自体は追加指示では更新しない運用)。LLM未使用・設定が空の分析は null を渡す想定。
 * 旧バージョンで作成済みのDBにはこの列が無いため、他の列と同じ流儀でALTER TABLEにより後付けし、
 * 既存行は NULL=追加指示なしとして読む(後方互換)。
 *
 * 開催日(kaisai_date)列(Task#34 レース単位の予実ブレークダウン): analyses に
 * kaisai_date TEXT(nullable、YYYYMMDD)を持つ。検証画面でレース単位に予実を表示する際、
 * 見出しに開催日を出したいが、中央のレースIDは回次・日次のみを埋め込み開催日を復元できない
 * (packages/core/src/scraper/ids.ts のコメント参照)。app 側は分析実行時に選択済みの開催日
 * (kaisaiDate)を保持しているため、それをそのまま保存する経路をこの列で持たせる。
 * 選択済み開催日が渡らなかった場合(kaisaiDateがnull)は、この列もnull(日付不明)として保存する
 * (analysis-pipeline.ts の当日近似日付はUI表示専用の近似値であり、実際の開催日ではないため
 * kaisai_date列には保存しない=不確かな値で上書きしない)。
 * 旧バージョンで作成済みのDBにはこの列が無いため、他の列と同じ流儀でALTER TABLEにより後付けし、
 * 既存行は NULL=日付不明として読む(後方互換)。
 */

import Database from "better-sqlite3";

import type { PredictionMark } from "../analyzer/parse-response.js";

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
  /** 予想印(◎〇▲△☆注のいずれか。印なしは null)。Task#23。 */
  readonly mark: PredictionMark | null;
}

/** 保存する分析(レース単位)。 */
export interface AnalysisRecord {
  /** レースID。 */
  readonly raceId: string;
  /** 分析日時(ISO文字列など、そのまま保持)。 */
  readonly analyzedAt: string;
  /** 各馬の推定結果。 */
  readonly horses: readonly AnalysisHorseRecord[];
  /**
   * この分析が推定EV(単勝オッズからの複勝下限概算)によるものか(Task#25)。
   * 省略時は false(確定EV。既存呼び出し元との後方互換のため任意項目とする)。
   * verify は既定でこのフラグが true の分析を回収率集計から除外する。
   */
  readonly evEstimated?: boolean;
  /**
   * プロンプト版番号(analyzer/build-prompt.ts の PROMPT_VERSION、Task#27)。
   * LLMを使わず prior をそのまま採用した分析(プロンプトを使っていない)は null を渡す。
   * 省略時も null(版不明。既存呼び出し元との後方互換のため任意項目とする)。
   */
  readonly promptVersion?: string | null;
  /**
   * 追加指示(analyzer/build-prompt.ts の BuildPromptInput.additionalInstruction、Task#28)。
   * 設定画面の自由記述欄が空、またはLLMを使わず prior をそのまま採用した分析(プロンプト自体を
   * 使っていない)は null を渡す。省略時も null(既存呼び出し元との後方互換のため任意項目とする)。
   */
  readonly additionalInstruction?: string | null;
  /**
   * 開催日(YYYYMMDD、Task#34)。app 側で選択済みの開催日(kaisaiDate)をそのまま渡す想定。
   * 選択済み開催日が渡らなかった(当日日付で近似した)場合は null を渡す。
   * 省略時も null(日付不明。既存呼び出し元との後方互換のため任意項目とする)。
   */
  readonly kaisaiDate?: string | null;
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
  /** 予想印(◎〇▲△☆注のいずれか。印なし・旧レコード(列追加前の保存)は null)。Task#23。 */
  readonly mark: PredictionMark | null;
}

/** 復元した分析(レース単位)。 */
export interface StoredAnalysis {
  /** 分析ID(採番)。 */
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly horses: StoredAnalysisHorse[];
  /**
   * 推定EV(Task#25)による分析か。旧レコード(列追加前の保存)は false(確定EV扱い)として復元する。
   */
  readonly evEstimated: boolean;
  /**
   * プロンプト版番号(Task#27)。旧レコード(列追加前の保存)・LLM未使用の分析は null(版不明)。
   */
  readonly promptVersion: string | null;
  /**
   * 追加指示(Task#28)。旧レコード(列追加前の保存)・設定が空・LLM未使用の分析は null。
   */
  readonly additionalInstruction: string | null;
  /**
   * 開催日(YYYYMMDD、Task#34)。旧レコード(列追加前の保存)・選択済み開催日が渡らなかった分析は
   * null(日付不明)。
   */
  readonly kaisaiDate: string | null;
}

/** レース結果の1頭分。 */
export interface RaceResultEntry {
  /** 馬番。 */
  readonly umaban: number;
  /** 実着順。非数値着順(中止・除外・着順不明)は null。 */
  readonly finishPosition: number | null;
  /**
   * 複勝の確定払戻(100円あたりの円)。verifyで回収率を実配当ベースで算出するために用いる。
   * 複勝圏外の馬・未取込(旧データ)は null。省略時も null 扱い(後方互換)。
   */
  readonly placePayout?: number | null;
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
  mark: string | null;
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
        analyzed_at TEXT NOT NULL,
        ev_estimated INTEGER,
        prompt_version TEXT,
        additional_instruction TEXT,
        kaisai_date TEXT
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
        mark TEXT,
        PRIMARY KEY (analysis_id, umaban),
        FOREIGN KEY (analysis_id) REFERENCES ${ANALYSES_TABLE} (id)
      );
      CREATE TABLE IF NOT EXISTS ${RACE_RESULTS_TABLE} (
        race_id TEXT NOT NULL,
        umaban INTEGER NOT NULL,
        finish_position INTEGER,
        place_payout REAL,
        PRIMARY KEY (race_id, umaban)
      );
    `);
    this.migrateResultPayoutColumn();
    this.migrateMarkColumn();
    this.migrateEvEstimatedColumn();
    this.migratePromptVersionColumn();
    this.migrateAdditionalInstructionColumn();
    this.migrateKaisaiDateColumn();
  }

  /**
   * 開催日(kaisai_date)列を後付けするマイグレーション(Task#34)。
   * 旧バージョンで作成済みの analyses には kaisai_date 列が無いため、存在しなければ追加する
   * (既存行は NULL=日付不明となり、検証画面のレース単位ブレークダウンは「日付不明」表示に
   * フォールバックする=後方互換)。
   */
  private migrateKaisaiDateColumn(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${ANALYSES_TABLE})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "kaisai_date")) {
      this.db.exec(`ALTER TABLE ${ANALYSES_TABLE} ADD COLUMN kaisai_date TEXT`);
    }
  }

  /**
   * プロンプト版番号(prompt_version)列を後付けするマイグレーション(Task#27)。
   * 旧バージョンで作成済みの analyses には prompt_version 列が無いため、存在しなければ追加する
   * (既存行は NULL=版不明となり、verifyの版別集計では「版不明」1グループとして扱う=後方互換)。
   */
  private migratePromptVersionColumn(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${ANALYSES_TABLE})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "prompt_version")) {
      this.db.exec(`ALTER TABLE ${ANALYSES_TABLE} ADD COLUMN prompt_version TEXT`);
    }
  }

  /**
   * 追加指示(additional_instruction)列を後付けするマイグレーション(Task#28)。
   * 旧バージョンで作成済みの analyses には additional_instruction 列が無いため、存在しなければ追加する
   * (既存行は NULL=追加指示なしとして読める=後方互換)。
   */
  private migrateAdditionalInstructionColumn(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${ANALYSES_TABLE})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "additional_instruction")) {
      this.db.exec(
        `ALTER TABLE ${ANALYSES_TABLE} ADD COLUMN additional_instruction TEXT`,
      );
    }
  }

  /**
   * 推定EVフラグ(ev_estimated)列を後付けするマイグレーション(Task#25)。
   * 旧バージョンで作成済みの analyses には ev_estimated 列が無いため、存在しなければ追加する
   * (既存行は NULL=false=確定EV扱いとなり、verifyは従来どおり集計対象になる=後方互換)。
   */
  private migrateEvEstimatedColumn(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${ANALYSES_TABLE})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "ev_estimated")) {
      this.db.exec(`ALTER TABLE ${ANALYSES_TABLE} ADD COLUMN ev_estimated INTEGER`);
    }
  }

  /**
   * 予想印(mark)列を後付けするマイグレーション(Task#23)。
   * 旧バージョンで作成済みの analysis_horses には mark 列が無いため、存在しなければ追加する
   * (既存行は NULL=印なしとなり、UI・Discord通知は「印なし」表示にフォールバックする=後方互換)。
   */
  private migrateMarkColumn(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${ANALYSIS_HORSES_TABLE})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "mark")) {
      this.db.exec(`ALTER TABLE ${ANALYSIS_HORSES_TABLE} ADD COLUMN mark TEXT`);
    }
  }

  /**
   * 実配当列(place_payout)を後付けするマイグレーション。
   * 旧バージョンで作成済みの race_results には place_payout 列が無いため、存在しなければ追加する
   * (既存行は NULL=未取込となり、verifyは従来どおり近似にフォールバックする=後方互換)。
   */
  private migrateResultPayoutColumn(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${RACE_RESULTS_TABLE})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "place_payout")) {
      this.db.exec(
        `ALTER TABLE ${RACE_RESULTS_TABLE} ADD COLUMN place_payout REAL`,
      );
    }
  }

  /**
   * 分析結果を保存し、採番された分析IDを返す。レース行と馬行をトランザクションで一括保存する。
   * @param record レース単位の分析結果
   */
  saveAnalysis(record: AnalysisRecord): number {
    const insertAnalysis = this.db.prepare(
      `INSERT INTO ${ANALYSES_TABLE}
         (race_id, analyzed_at, ev_estimated, prompt_version, additional_instruction, kaisai_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertHorse = this.db.prepare(
      `INSERT INTO ${ANALYSIS_HORSES_TABLE}
         (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction((rec: AnalysisRecord): number => {
      const info = insertAnalysis.run(
        rec.raceId,
        rec.analyzedAt,
        rec.evEstimated ? 1 : 0,
        rec.promptVersion ?? null,
        rec.additionalInstruction ?? null,
        rec.kaisaiDate ?? null,
      );
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
          h.mark,
        );
      }
      return analysisId;
    });

    return tx(record);
  }

  /**
   * レース後の実着順(と複勝確定払戻)を保存する。(race_id, umaban) 主キーで再保存は上書きする。
   * placePayout を省略した場合は null で保存する(実配当未取込=verifyは近似にフォールバック)。
   * @param raceId レースID
   * @param results 馬番→着順・複勝払戻(非数値着順は finishPosition=null)
   */
  saveResult(raceId: string, results: readonly RaceResultEntry[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO ${RACE_RESULTS_TABLE} (race_id, umaban, finish_position, place_payout)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(race_id, umaban) DO UPDATE SET
         finish_position = excluded.finish_position,
         place_payout = excluded.place_payout`,
    );
    const tx = this.db.transaction((rows: readonly RaceResultEntry[]) => {
      for (const r of rows) {
        upsert.run(raceId, r.umaban, r.finishPosition, r.placePayout ?? null);
      }
    });
    tx(results);
  }

  /**
   * レースの実着順(と複勝確定払戻)を取得する。1件も保存されていなければ undefined を返す。
   * @param raceId レースID
   */
  getResult(raceId: string): RaceResultEntry[] | undefined {
    const rows = this.db
      .prepare(
        `SELECT umaban, finish_position AS finishPosition, place_payout AS placePayout
           FROM ${RACE_RESULTS_TABLE} WHERE race_id = ? ORDER BY umaban`,
      )
      .all(raceId) as Array<{
      umaban: number;
      finishPosition: number | null;
      placePayout: number | null;
    }>;
    if (rows.length === 0) {
      return undefined;
    }
    return rows.map((r) => ({
      umaban: r.umaban,
      finishPosition: r.finishPosition,
      placePayout: r.placePayout,
    }));
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
              `SELECT id, race_id AS raceId, analyzed_at AS analyzedAt, ev_estimated AS evEstimated,
                      prompt_version AS promptVersion, additional_instruction AS additionalInstruction,
                      kaisai_date AS kaisaiDate
                 FROM ${ANALYSES_TABLE} ORDER BY id`,
            )
            .all()
        : this.db
            .prepare(
              `SELECT id, race_id AS raceId, analyzed_at AS analyzedAt, ev_estimated AS evEstimated,
                      prompt_version AS promptVersion, additional_instruction AS additionalInstruction,
                      kaisai_date AS kaisaiDate
                 FROM ${ANALYSES_TABLE} WHERE race_id = ? ORDER BY id`,
            )
            .all(filter.raceId)
    ) as Array<{
      id: number;
      raceId: string;
      analyzedAt: string;
      evEstimated: number | null;
      promptVersion: string | null;
      additionalInstruction: string | null;
      kaisaiDate: string | null;
    }>;

    const horseStmt = this.db.prepare(
      `SELECT umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark
         FROM ${ANALYSIS_HORSES_TABLE} WHERE analysis_id = ? ORDER BY umaban`,
    );

    return analyses.map((a) => {
      const horseRows = horseStmt.all(a.id) as HorseRow[];
      return {
        id: a.id,
        raceId: a.raceId,
        analyzedAt: a.analyzedAt,
        horses: horseRows.map(toStoredHorse),
        // NULL(旧レコード・未指定保存)は false(確定EV扱い)として復元する。
        evEstimated: a.evEstimated === 1,
        // NULL(旧レコード・列追加前の保存・LLM未使用)は版不明としてnullのまま復元する。
        promptVersion: a.promptVersion,
        // NULL(旧レコード・列追加前の保存・設定が空・LLM未使用)は追加指示なしとしてnullのまま復元する。
        additionalInstruction: a.additionalInstruction,
        // NULL(旧レコード・列追加前の保存・選択済み開催日が渡らなかった分析)は日付不明としてnullのまま復元する。
        kaisaiDate: a.kaisaiDate,
      };
    });
  }

  /**
   * 分析済み(analyses に行がある)だが結果未取込(race_results に行が1件も無い)のレースIDを
   * レースID昇順で列挙する(Task#31 一括取込)。
   *
   * 判定は必ず `NOT EXISTS`(race_results 側に行そのものが存在するか)で行う。
   * `COUNT(finish_position)` 等の値の個数で判定してはならない: finish_position は
   * 中止・除外で NULL を許容する列であり、COUNTはNULLを数えないため、全馬が中止・除外で
   * finish_position が全行NULLのレース(=取込済み)を誤って未取込と判定してしまう
   * (「値の有無」と「行の有無」の混同。docs/handover-next-session.md 4章)。
   * DISTINCT により、同一レースを複数回分析していても1回だけ返す。
   */
  listUnimportedRaceIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT race_id AS raceId
           FROM ${ANALYSES_TABLE} a
           WHERE NOT EXISTS (
             SELECT 1 FROM ${RACE_RESULTS_TABLE} r WHERE r.race_id = a.race_id
           )
           ORDER BY race_id`,
      )
      .all() as Array<{ raceId: string }>;
    return rows.map((r) => r.raceId);
  }

  /**
   * 指定したプロンプト版(prompt_version)で分析済みのレースIDをレースID昇順で列挙する
   * (タスクB2b-1 期間バッチのdedup bulk query)。
   *
   * `listUnimportedRaceIds` と同じ流儀で DISTINCT により、同一レースを同じ版で複数回
   * 分析していても1回だけ返す。`prompt_version = ?` の等価比較は SQLite の NULL 比較の
   * 性質上 NULL 行(版不明・LLM未使用)にはマッチしないため、版不明のレースは列挙されない
   * (呼び出し側〈期間バッチのdedup〉は「別版のみ/null」を実行対象に含める前提のため、
   * この非マッチは意図した挙動)。
   */
  listAnalyzedRaceIdsByPromptVersion(version: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT race_id AS raceId
           FROM ${ANALYSES_TABLE}
           WHERE prompt_version = ?
           ORDER BY race_id`,
      )
      .all(version) as Array<{ raceId: string }>;
    return rows.map((r) => r.raceId);
  }

  /**
   * プロンプト版不明(prompt_version が null)の分析をまとめて削除する(Task#33)。
   *
   * 削除対象の母集団が持つ「二重の意味」(code-reviewer指摘対応): prompt_version IS NULL には
   * 由来の異なる2種類の分析が混在し、DB上はどちらか区別できない。
   *   (1) 版記録導入前(Task#27より前)に保存された旧データ。列追加前は promptVersion を
   *       保存する手段自体が無かった。
   *   (2) APIキー未設定でLLMを使わず prior をそのまま採用した現行の分析。この経路は
   *       プロンプト自体を使わないため、常に promptVersion=null で保存される(現行でも今後も
   *       発生し続ける。上のクラスコメント・StoredAnalysis.promptVersion のJSDoc参照)。
   * 削除してよい理由(ユーザー合意済み・PM決定): プロンプト文面は予想印導入等で実質変わっており、
   * 版不明(上記(1))は旧文面が混在しうるため版別比較の信頼性を損なう。検証画面の版別比較は
   * 従来からこの母集団((1)+(2))をまとめて「版不明」グループとして表示しており、ユーザーが
   * 合意した削除対象はこの表示グループ全体(=このメソッドが削除する範囲そのもの)である。
   * (2)のLLM未使用分析は再分析(通常の分析実行、または一括取込 Task#31)によって復元できるため、
   * 削除しても実質的な損失にならない。削除で減った件数は一括取込(Task#31)で埋め直せる。
   *
   * FK実装メモ(削除順序の根拠): analysis_horses の外部キー宣言
   * (`FOREIGN KEY (analysis_id) REFERENCES analyses (id)`)には ON DELETE 句が無く、
   * SQLite既定の NO ACTION になる。initSchema で foreign_keys=ON にしているため、
   * 子行(analysis_horses)を残したまま親行(analyses)だけを削除しようとすると
   * FOREIGN KEY constraint failed で失敗する。CASCADE化はテーブル再作成を要し既存DBファイルとの
   * 互換性を崩す恐れがあるためスキーマは変更せず、このメソッド側で明示的に
   * analysis_horses → analyses の順に削除することで対処する。
   *
   * race_results は削除しない: race_id は analyses への外部キーではない自由文字列であり、
   * 結果データ(実着順・複勝払戻)はプロンプト版と無関係に他の分析(取込済みの版あり分析等)からも
   * 再利用できるため、意図的に対象外とする。
   *
   * @returns 削除した分析(analyses行)の件数
   */
  deleteAnalysesWithUnknownPromptVersion(): number {
    const deleteHorses = this.db.prepare(
      `DELETE FROM ${ANALYSIS_HORSES_TABLE}
         WHERE analysis_id IN (
           SELECT id FROM ${ANALYSES_TABLE} WHERE prompt_version IS NULL
         )`,
    );
    const deleteAnalyses = this.db.prepare(
      `DELETE FROM ${ANALYSES_TABLE} WHERE prompt_version IS NULL`,
    );
    const tx = this.db.transaction((): number => {
      // 先に子行(analysis_horses)を消してから親行(analyses)を消す(FK制約違反を避けるため)。
      deleteHorses.run();
      const info = deleteAnalyses.run();
      return info.changes;
    });
    return tx();
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
    // DBには自前で書き込んだ値(またはNULL)のみが入るため、素通しでキャストする
    // (未知の文字列が紛れ込む経路は無い。念のため未知値でも「印なし扱い」にはせず型どおり通す)。
    mark: row.mark as PredictionMark | null,
  };
}
