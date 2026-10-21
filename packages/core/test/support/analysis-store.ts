/**
 * 【Issue #287(#285 の段階B)でテスト用の補助として `packages/core/src/ev/` から移した】
 * 元は exe(Electron)の SQLite 保存だった。exe を削除したため、本番コードには使われない。web の検証の一致を守るテスト
 * (`scripts/test/cloud-verify-parity.test.ts`・`cloud-d1-schema.test.ts`、core の verify 系・契約テスト)が、
 * 「同じデータを入れたときの期待値」の oracle として使う。src とバレル(`@keiba/core`)からは外してある。
 */
/**
 * 分析結果のSQLite保存(verify基盤)。仕様「4. ev」:
 *   「全推定結果をSQLiteに保存し、レース後に実際の結果と突き合わせて回収率を記録するverify機能」。
 *
 * スキーマ設計(列の意味。旧 exe の DB ファイルを新しい列へ移行する処理は、exe の削除〈#285〉に伴い
 * Issue #400 R-12 で削除した。テストは新しい DB を作って使うだけなので、列はすべて CREATE TABLE が持つ):
 * - `analyses`(レース単位): id・race_id・analyzed_at。同一レースを複数回分析しうるため
 *   (発走前/直前オッズ再取得など)、race_id では一意にせず analyzed_at ごとに別行(別id)とする。
 *   - ev_estimated: 発売前(oddsStatus=yoso)の推定EVか。複勝オッズ有無はレース単位で決まるため馬単位ではない。
 *     推定EVは確定EVより誤差が大きく、verify では既定で除外する。NULL は false(確定EV)として読む。
 *   - prompt_version: buildPrompt が使う PROMPT_VERSION の値。LLM未使用の分析は NULL=版不明。
 *   - additional_instruction: 設定画面の自由記述欄の内容。PROMPT_VERSION とは別軸で、版別比較の解釈に使う。
 *   - kaisai_date: 選択済みの開催日(YYYYMMDD)。渡らなかったときは NULL(不確かな近似日付では埋めない)。
 *   - model・raw_response・race_snapshot_json: エクスポート用。LLM未使用なら model・raw_response は NULL。
 *   - history_cutoff_date・prompt_lookahead_guarded: 先読みリーク遮断の記録。NULL は「記録なし=是正前」で、
 *     0 や空文字で「是正済み」と読ませない。
 * - `analysis_horses`(馬単位): analysis_id(FK)・umaban・prior・adjusted_prob・place_odds_min・ev・
 *   is_positive・contributions_json・mark・reason・highlights_json・concerns_json。
 *   寄与度ログ(仕様L135)は構造が可変のため JSON 文字列で保持する。
 * - `race_results`(レース結果): race_id・umaban・finish_position・place_payout・win_payout・
 *   passing_json(通過順配列のJSON)・last3f。(race_id, umaban) を主キーとし再保存は上書き。
 *   非数値着順(中止・除外)は finish_position を NULL で保持する。
 * - `race_result_meta`(レース単位の面。course_type の芝/ダ/障): 面が取得できないレースは行を作らない
 *   (「行が無い=面不明」に統一する)。
 * - `race_combo_payouts`・`race_combo_payout_imports`(組合せ払戻とその取込マーカー。Issue #52)、
 *   `analysis_allocation_meta`・`analysis_bets`(配分提案。Issue #59)。
 * - saveResult は結果・面・組合せ払戻を単一の db.transaction 内で書く(例外で全ロールバック)。
 * - getRaceResultDetail は復元専用で、getResult(umaban/finishPosition/placePayout のみを返す verify 専用)
 *   は変更しない(verify のクエリ性能・出力契約を保つため)。
 *
 * 今後の拡張(LLM補正値・Discord送信履歴)は列/テーブル追加で対応する前提とし、今は必要列のみ持つ。
 * adjusted_prob 列は将来のLLM補正値の受け皿を兼ねる(現状は prior と同値)。
 */

import Database from "better-sqlite3";

import { type ComboBetType } from "../../src/scraper/combo-odds-key.js";
import type { CourseType } from "../../src/scraper/types.js";
import {
  ANALYSES_TABLE,
  ANALYSIS_ALLOCATION_META_TABLE,
  ANALYSIS_BETS_TABLE,
  ANALYSIS_HORSES_TABLE,
  buildChildParams,
  analysisParams,
  comboPayoutParams,
  DELETE_COMBO_PAYOUTS_SQL,
  INSERT_ALLOCATION_BET_SQL,
  INSERT_ALLOCATION_META_SQL,
  INSERT_ANALYSIS_HORSE_SQL,
  INSERT_ANALYSIS_SQL,
  INSERT_COMBO_PAYOUT_SQL,
  MARK_COMBO_IMPORTED_SQL,
  planComboWrites,
  RACE_COMBO_PAYOUT_IMPORTS_TABLE,
  RACE_COMBO_PAYOUTS_TABLE,
  RACE_RESULT_META_TABLE,
  RACE_RESULTS_TABLE,
  raceResultParams,
  SELECT_ALLOCATION_BETS_SQL,
  SELECT_ALLOCATION_META_SQL,
  SELECT_ANALYSES_BY_RACE_SQL,
  SELECT_ANALYSES_SQL,
  SELECT_ANALYSIS_HORSES_SQL,
  SELECT_RESULT_DETAIL_SQL,
  SELECT_RESULT_META_SQL,
  toRaceResultDetail,
  toStoredAllocation,
  toStoredAnalysis,
  UPSERT_RACE_RESULT_META_SQL,
  UPSERT_RACE_RESULT_SQL,
  type AllocationMetaRow,
  type AnalysisRow,
  type HorseRow,
  type ResultDetailRow,
} from "../../src/ev/analysis-store-codec.js";
import type {
  AnalysisFilter,
  AnalysisRecord,
  RaceComboPayoutsReadResult,
  RaceComboPayoutsSaveInput,
  RaceResultDetail,
  RaceResultEntry,
  StoredAllocation,
  StoredAllocationBet,
  StoredAllocationBetDetail,
  StoredAllocationSummary,
  StoredAnalysis,
  StoredComboPayout,
} from "../../src/ev/analysis-store-types.js";

// Issue #168(#163-a): 入出力の型は better-sqlite3 に依存しない analysis-store-types.ts へ切り出した。
// 既存の import 元(`./analysis-store.js`・バレル)を壊さないよう、ここから再 export する。
export type {
  AnalysisHorseRecord,
  AnalysisRecord,
  AnalysisAllocationRecord,
  AnalysisAllocationMetaRecord,
  StoredAllocationBet,
  StoredAllocationBetDetail,
  StoredAllocation,
  StoredAllocationSummary,
  AnalysisBetRecord,
  StoredAnalysisHorse,
  StoredAnalysis,
  RaceResultEntry,
  RaceComboPayoutsSaveInput,
  StoredComboPayout,
  RaceComboPayoutsReadResult,
  RaceResultDetailHorse,
  RaceResultDetail,
  AnalysisFilter,
} from "../../src/ev/analysis-store-types.js";

/** AnalysisStore の構築オプション。 */
export interface AnalysisStoreOptions {
  /** SQLiteファイルパス。省略時は ":memory:"。`database` 指定時は無視。 */
  filename?: string;
  /** 既存の better-sqlite3 Database を注入(生 SQL で列を読むテストが同じ接続を使う)。 */
  database?: Database.Database;
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
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${ANALYSES_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        race_id TEXT NOT NULL,
        analyzed_at TEXT NOT NULL,
        ev_estimated INTEGER,
        prompt_version TEXT,
        additional_instruction TEXT,
        kaisai_date TEXT,
        model TEXT,
        raw_response TEXT,
        race_snapshot_json TEXT,
        history_cutoff_date TEXT,
        prompt_lookahead_guarded INTEGER
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
        reason TEXT,
        highlights_json TEXT,
        concerns_json TEXT,
        PRIMARY KEY (analysis_id, umaban),
        FOREIGN KEY (analysis_id) REFERENCES ${ANALYSES_TABLE} (id)
      );
      CREATE TABLE IF NOT EXISTS ${RACE_RESULTS_TABLE} (
        race_id TEXT NOT NULL,
        umaban INTEGER NOT NULL,
        finish_position INTEGER,
        place_payout REAL,
        win_payout REAL,
        passing_json TEXT,
        last3f REAL,
        PRIMARY KEY (race_id, umaban)
      );
      CREATE TABLE IF NOT EXISTS ${RACE_RESULT_META_TABLE} (
        race_id TEXT PRIMARY KEY,
        course_type TEXT
      );
      -- 組合せ払戻(ワイド・3連複)の値テーブルとマーカーテーブル(Issue #52・AC12)。
      -- 2テーブルに分けた理由(R-4): 値テーブル(下記)だけでは
      -- 「未取込」と「取り込んだが該当券種の払戻が0件だった」を区別できない
      -- (行の個数ではなく行の有無〈マーカー行〉で判定する必要があるため)。
      --
      -- combo_key は buildComboOddsKeyFor(betType, umabans) による正規化キーであり、
      -- betTypeごとに順序方針(ソートする/しない)が異なる(ワイド・3連複は順不同、
      -- 馬単は着順ありのまま連結。COMBO_KEY_ORDER参照。Issue #106・#24-B裁定)。
      -- combo_keyはただのTEXTで、主キーが(race_id, bet_type, combo_key)であるため、
      -- 順序付きキー(馬単)もこの同じ列・同じテーブルに保持できる(列/テーブル分離は
      -- 不要。AC10改訂: Issue #52時点の「分離が必要」という記述は過剰に強かった)。
      -- 詳細: StoredComboPayout.comboKey のJSDoc。
      CREATE TABLE IF NOT EXISTS ${RACE_COMBO_PAYOUTS_TABLE} (
        race_id TEXT NOT NULL,
        bet_type TEXT NOT NULL,
        combo_key TEXT NOT NULL,
        payout INTEGER NOT NULL,
        PRIMARY KEY (race_id, bet_type, combo_key)
      );
      CREATE TABLE IF NOT EXISTS ${RACE_COMBO_PAYOUT_IMPORTS_TABLE} (
        race_id TEXT NOT NULL,
        bet_type TEXT NOT NULL,
        PRIMARY KEY (race_id, bet_type)
      );
      -- 配分提案(Issue #59)のレース単位メタ行。全経路(unset/yoso/unavailable/place-only/
      -- mixed/invalid)で必ず1行書く契約(#31: 判定不能と判定結果を混ぜない)。列一覧は
      -- boss着手前ゲート・#59で固定(Issue #118〈#24-D3b-3〉で include_quinella 列を追加し
      -- 20→21列、Issue #126〈#24-E3c〉で include_exacta 列を追加し21→22列、Issue #140〈#25-E3c〉で
      -- include_trifecta 列を追加し22→23列、Issue #151〈#26-E3c〉で include_bracket_quinella 列を
      -- 追加し23→24列。列を読む人〈過去分析の再表示「馬連/馬単/三連単/枠連: ON/OFF/記録なし」〉が
      -- 実在するに至ったため #59 の凍結を部分的に解除した4つの例外)。
      -- include_quinella・include_exacta・include_trifecta・include_bracket_quinella はいずれも
      -- NULL を許す(NOT NULL にしない・DEFAULT も付けない): 列追加前(それぞれIssue #118・#126・
      -- #140・#151より前)に保存された行は「馬連/馬単/三連単/枠連の設定を記録していない」のであって
      -- 「馬連/馬単/三連単/枠連を配分に使わなかった」のではないため、0で埋めるとOFFと断定する
      -- 誤りになる(#31の原則。着手前ゲート裁定)。枠連は v1.13.0(#150)から買い目行が保存されて
      -- いるため、v1.13.0で保存された行は「枠連の買い目はあるが設定列は NULL」になりうるが、
      -- 買い目行から ON と推定はしない。
      CREATE TABLE IF NOT EXISTS ${ANALYSIS_ALLOCATION_META_TABLE} (
        analysis_id INTEGER PRIMARY KEY,
        route TEXT NOT NULL,
        unavailable_reason TEXT,
        fallback_reason TEXT,
        skip_reason_code TEXT,
        combo_odds_wide TEXT,
        combo_odds_trio TEXT,
        bankroll REAL NOT NULL,
        per_race_cap REAL NOT NULL,
        kelly_fraction REAL NOT NULL,
        ev_threshold REAL NOT NULL,
        include_combo_odds INTEGER NOT NULL,
        include_wide INTEGER NOT NULL,
        include_trio INTEGER NOT NULL,
        include_quinella INTEGER,
        include_exacta INTEGER,
        include_trifecta INTEGER,
        include_bracket_quinella INTEGER,
        bet_unit INTEGER,
        greedy_steps INTEGER,
        candidate_cap INTEGER,
        model_id TEXT,
        model_approximate INTEGER,
        odds_status TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES ${ANALYSES_TABLE} (id)
      );
      -- 配分提案(Issue #59)の買い目明細(stake>0のみ、呼び出し側でフィルタ済み)。
      -- 複勝・ワイド・3連複を bet_type 列だけで共通化する(GeneralBetAllocation/BetAllocationの
      -- 両方が continuousFraction/scaledFraction/stake/droppedBelowMinimum を持つため、保存列は
      -- bet_type/combo_key/stake/odds/ev の5列〈+analysis_id〉に絞れる。#59決定(c))。
      CREATE TABLE IF NOT EXISTS ${ANALYSIS_BETS_TABLE} (
        analysis_id INTEGER NOT NULL,
        bet_type TEXT NOT NULL,
        combo_key TEXT NOT NULL,
        stake INTEGER NOT NULL,
        odds REAL,
        ev REAL,
        PRIMARY KEY (analysis_id, bet_type, combo_key),
        FOREIGN KEY (analysis_id) REFERENCES ${ANALYSES_TABLE} (id)
      );
    `);
  }

  /**
   * 分析結果を保存し、採番された分析IDを返す。レース行と馬行をトランザクションで一括保存する。
   * @param record レース単位の分析結果
   */
  saveAnalysis(record: AnalysisRecord): number {
    const insertAnalysis = this.db.prepare(INSERT_ANALYSIS_SQL);
    const insertHorse = this.db.prepare(INSERT_ANALYSIS_HORSE_SQL);
    // 配分提案(Issue #59)。record.allocation が渡されたときだけ書く(#59 AC4「旧分析(記録なし)」)。
    const insertAllocationMeta = this.db.prepare(INSERT_ALLOCATION_META_SQL);
    const insertAllocationBet = this.db.prepare(INSERT_ALLOCATION_BET_SQL);

    const tx = this.db.transaction((rec: AnalysisRecord): number => {
      const info = insertAnalysis.run(...analysisParams(rec));
      const analysisId = Number(info.lastInsertRowid);
      // 子の行の束縛値は codec(D1 実装と共有)が組み立てる。書く順序は 馬 → 配分メタ → 買い目。
      const child = buildChildParams(rec, analysisId);
      for (const params of child.horses) {
        insertHorse.run(...params);
      }
      if (child.allocationMeta !== null) {
        insertAllocationMeta.run(...child.allocationMeta);
        for (const params of child.allocationBets) {
          insertAllocationBet.run(...params);
        }
      }
      return analysisId;
    });

    return tx(record);
  }

  /**
   * レース後の実着順(通過順・上がり3F・複勝確定払戻・単勝確定払戻)と、レース単位の面
   * (course_type)を保存する。(race_id, umaban) 主キーで再保存は上書きする。
   * placePayout/winPayout/passing/last3f を省略した場合はそれぞれ null/null/空配列/null で
   * 保存する(未取込項目=後続の復元・verifyは欠損値として扱う)。winPayout は placePayout と
   * 同型の列(win_payout、Issue #100・#23-C)。
   *
   * race_results(馬単位)・race_result_meta(レース単位の面)・race_combo_payouts/
   * race_combo_payout_imports(組合せ払戻、Issue #52)は単一の db.transaction 内で書く
   * (better-sqlite3のtransactionは例外で全ロールバックされるため、複数テーブル書き込みの
   * 原子性を担保する。AC7)。courseType が null/未指定の場合は race_result_meta に行を
   * 作らない(面が取れないレースまで不確かな行を残さないため)。
   *
   * comboPayouts の各券種は、`state:"undetermined"`(構造異常・払戻未公開)なら
   * その券種のテーブルに一切触れない(boss裁定R-5・R-7: 一過性の構造異常での再取込が
   * 正しい過去データを破壊しないため)。`state:"parsed"` なら既存行を削除してから
   * 保存し直す(delete-then-insert。AC8: 再取込で組数が減っても孤児行を残さない)。
   * 券種キー省略・comboPayouts自体の省略は「触れない」と同義(courseTypeと同じ非破壊
   * optional。AC13)。
   *
   * **呼び出し側への警告(提案・boss メタレビュー対応)**: `payouts` に正規化後(`buildComboOddsKey`
   * 適用後)で同一になる組が2件以上含まれていると、`race_combo_payouts` の
   * PRIMARY KEY(race_id, bet_type, combo_key)違反で例外が飛び、この呼び出し全体が
   * ロールバックされる(=着順(`race_results`)まで巻き戻る。この関数自身は重複を検知して
   * 除外したりしない)。`parseRaceResult` は `duplicateCombo` を検出して
   * `state:"undetermined"` に倒すため通常この経路には来ないが、将来 `parseRaceResult` を
   * 経由しない呼び出し元(#53〜#55等)が増えたときは、呼び出し側が事前に重複を検証するか、
   * この関数側の防御を検討すること(`analysis-store.test.ts`「単一トランザクション」describe
   * に、この事故が発生した際に着順まで巻き戻ることを直接固定したテストがある)。
   * @param raceId レースID
   * @param results 馬番→着順・複勝払戻・通過順・上がり3F(非数値着順は finishPosition=null)
   * @param courseType レース単位の面(芝/ダ/障)。取得できない・省略時は race_result_meta を書かない
   * @param comboPayouts ワイド・3連複の確定払戻(Issue #52)。省略時は組合せ払戻テーブルに触れない
   */
  saveResult(
    raceId: string,
    results: readonly RaceResultEntry[],
    courseType?: CourseType | null,
    comboPayouts?: RaceComboPayoutsSaveInput,
  ): void {
    // SQL と束縛値の組み立ては codec(クラウド版の D1 実装と共有。Issue #207)。文の発行は従来と同じ(同じ文・同じ回数・同じ順序)。
    const upsertResult = this.db.prepare(UPSERT_RACE_RESULT_SQL);
    const upsertMeta = this.db.prepare(UPSERT_RACE_RESULT_META_SQL);
    const deleteCombo = this.db.prepare(DELETE_COMBO_PAYOUTS_SQL);
    const insertCombo = this.db.prepare(INSERT_COMBO_PAYOUT_SQL);
    const markComboImported = this.db.prepare(MARK_COMBO_IMPORTED_SQL);
    const tx = this.db.transaction(
      (
        rows: readonly RaceResultEntry[],
        meta: CourseType | null | undefined,
        combo: RaceComboPayoutsSaveInput | undefined,
      ) => {
        for (const r of rows) {
          upsertResult.run(...raceResultParams(raceId, r));
        }
        if (meta !== undefined && meta !== null) {
          upsertMeta.run(raceId, meta);
        }
        // R-5・R-7: 判定不能(undetermined)または未指定の券種は plan に含まれず、DBに判定結果として残さない
        // (再取込で一過性の異常が起きても、既存の正しい値を保持する)。キーは betType 別の順序方針(codec の comboPayoutParams)。
        for (const { betType, payouts } of planComboWrites(combo)) {
          deleteCombo.run(raceId, betType);
          for (const entry of payouts) {
            insertCombo.run(...comboPayoutParams(raceId, betType, entry));
          }
          markComboImported.run(raceId, betType);
        }
      },
    );
    tx(results, courseType, comboPayouts);
  }

  /**
   * ワイド・3連複の確定払戻を取得する(Issue #52。返り値契約は RaceComboPayoutsReadResult
   * のJSDoc参照)。
   *
   * 「未取込」の判定は race_combo_payout_imports のマーカー行の有無で行う
   * (race_results の行の有無を根拠にしてはならない。boss裁定R-4): 旧DB
   * (本機能より前に取り込んだレース)は race_results に行があるがこのマーカーが無いため、
   * 正しく not_imported と判定できる。marker が有る(=取込試行が成功した)場合のみ
   * race_combo_payouts を読み、0件でも imported として返す(未発売等と not_imported を
   * 混同しない)。
   *
   * 未知の bet_type 文字列が紛れ込んだ場合の防御(boss裁定R-6): この関数は呼び出し側が
   * 渡す型付きの betType(`ComboBetType`)で WHERE 句を等価比較するため、DBに万一未知の
   * bet_type 値が混入していても、そのレース・その betType の一致行以外は自動的に除外される
   * (toStoredCourseType のような追加の防御的フォールバック関数を別途持つ必要が無い)。
   * @param raceId レースID
   * @param betType 券種(`ComboBetType`)
   */
  getComboPayouts(raceId: string, betType: ComboBetType): RaceComboPayoutsReadResult {
    const marker = this.db
      .prepare(
        `SELECT 1 FROM ${RACE_COMBO_PAYOUT_IMPORTS_TABLE} WHERE race_id = ? AND bet_type = ?`,
      )
      .get(raceId, betType);
    if (marker === undefined) {
      return { state: "not_imported" };
    }
    const rows = this.db
      .prepare(
        `SELECT combo_key AS comboKey, payout FROM ${RACE_COMBO_PAYOUTS_TABLE}
           WHERE race_id = ? AND bet_type = ? ORDER BY combo_key`,
      )
      .all(raceId, betType) as StoredComboPayout[];
    return { state: "imported", payouts: rows };
  }

  /**
   * 配分提案(analysis_allocation_meta / analysis_bets、Issue #59)のうち、#71(#54-B。
   * 配分ベースの回収率 `proposedBet` 系)が読む最小列だけを取得する。メタ行が無ければ
   * undefined を返す(#59 より前に保存された旧分析=「記録なし」。`AnalysisRecord.allocation`
   * が渡されなかった保存はメタ行を作らない)。
   *
   * **意図的に読まない列(#71 着手前ゲート決定)**: メタ行の残り22列(`analysis_id`を含む。
   * Issue #118でinclude_quinella・#126でinclude_exacta・#140でinclude_trifecta・#151で
   * include_bracket_quinellaがそれぞれ実効設定の一員として加わり、物理列数の増加分
   * 〈20→21→22→23→24〉だけこの残り列数も増えている。実測: 物理24列のうち本メソッドが読むのは
   * `route`/`skip_reason_code`の2列だけなので、残りは24-2=22列)
   * (`unavailable_reason`/`fallback_reason`/`combo_odds_wide`/`combo_odds_trio`の4列、実効設定11列
   * 〈bankroll/per_race_cap/kelly_fraction/ev_threshold/include_combo_odds/include_wide/
   * include_trio/include_quinella/include_exacta/include_trifecta/include_bracket_quinella〉、
   * 実効値5列〈bet_unit/greedy_steps/candidate_cap/model_id/model_approximate〉、`odds_status`、
   * `analysis_id`。4+11+5+1+1=22)と、明細の `odds`/`ev` の2列は返さない。#71 が実際に使うのは
   * `route`・`skip_reason_code`(母集団の4分類)と `bet_type`/`combo_key`/`stake`
   * (実際の配分額そのものを賭け金とする。Q-C)の5列のみで、`odds`/`ev` を読むと
   * 「回収率」ではなく「提案時点の期待値の再計算」になってしまう(Q-Cに反する)。
   * 誰も読まない列にまで #59 の条件B(非衝突)のコストを払わない判断は #59 で8巡した
   * 失敗の再現を避けるため(#71 Issue本文)。#55(過去分析の再表示UI)で残り22列/odds/evが
   * 必要になった時点で別途追加する。
   *
   * **`odds`/`ev`を返り値の型に持たせないこと自体は「将来この関数が改修されても読まれない」
   * ことまでは保証しない**(#71メタレビュー指摘)。本当の保証は、消費側
   * `ev/verify.test.ts`「AC-B4: analysis_bets.oddsが異常値(+Infinity/NaN)でもproposedBetの
   * 集計結果が変わらないこと」が、`odds`/`ev`に極端な値(+Infinity・NaN)を入れた分析と
   * 通常値の分析で`computeVerifyReport(...).proposedBet`が完全一致することを実際に確認している
   * behavioralなテストの方(型は将来の追加を止めない)。
   * @param analysisId 分析ID
   */
  getAllocationForVerify(analysisId: number): StoredAllocationSummary | undefined {
    const metaRow = this.db
      .prepare(
        `SELECT route, skip_reason_code AS skipReasonCode
           FROM ${ANALYSIS_ALLOCATION_META_TABLE} WHERE analysis_id = ?`,
      )
      .get(analysisId) as { route: string; skipReasonCode: string | null } | undefined;
    if (metaRow === undefined) {
      return undefined;
    }
    const bets = this.db
      .prepare(
        `SELECT bet_type AS betType, combo_key AS comboKey, stake
           FROM ${ANALYSIS_BETS_TABLE} WHERE analysis_id = ? ORDER BY bet_type, combo_key`,
      )
      .all(analysisId) as StoredAllocationBet[];
    return { route: metaRow.route, skipReasonCode: metaRow.skipReasonCode, bets };
  }

  /**
   * 配分提案(analysis_allocation_meta / analysis_bets、Issue #59)のうち、#55(過去分析の
   * 再表示で配分提案を出す)が読む17列 + bets(betType/comboKey/stake/odds/ev)を取得する
   * (include_quinellaはIssue #118〈#24-D3b-3〉で13→14列、include_exactaはIssue #126〈#24-E3c〉で
   * 14→15列、include_trifectaはIssue #140〈#25-E3c〉で15→16列、include_bracket_quinellaは
   * Issue #151〈#26-E3c〉で16→17列、それぞれ読む列に追加した)。
   * メタ行が無ければ undefined を返す(#59より前の旧分析=「記録なし」)。
   *
   * **読まない6列(boss裁定2026-09-02)**: `combo_odds_wide`/`combo_odds_trio`/`greedy_steps`/
   * `candidate_cap`/`model_id`/`model_approximate`(メタ行の物理列数24から読む17列と
   * `analysis_id`〈検索キーであり返り値のデータ列ではないため列挙に含めない〉を除いた数。
   * Issue #118・#126・#140・#151で列が20→21→22→23→24列に増えても、読まない6列自体は変わらない)。
   * 前者2つは表示予定が無く(#55のスコープ外。必要になれば#16で追加)、後者4つは利用者に
   * 意味の無い内部パラメータ(`getAllocationForVerify`のJSDocと同じ判断)。詳細は
   * {@link StoredAllocation} のJSDoc参照。
   *
   * `include_quinella`/`include_exacta`/`include_trifecta`/`include_bracket_quinella`は、設定の
   * エコー列のうち`bankroll`/`per_race_cap`/`kelly_fraction`/`ev_threshold`/`include_combo_odds`/
   * `include_wide`/`include_trio`(いずれもNOT NULL)と異なりNULLを許す列のため
   * (`unavailable_reason`等のコード列も別の理由でNULLを許すが、それらは「該当なし」を表す)、
   * DB値が`null`のときはそれぞれ`includeQuinella: null`/
   * `includeExacta: null`/`includeTrifecta: null`/`includeBracketQuinella: null`(記録なし)として
   * そのまま返す(0/1のときのみ`!== 0`でboolean化する。
   * #31: 記録なしをfalseに丸めない)。
   * @param analysisId 分析ID
   */
  getStoredAllocation(analysisId: number): StoredAllocation | undefined {
    const metaRow = this.db.prepare(SELECT_ALLOCATION_META_SQL).get(analysisId) as
      | AllocationMetaRow
      | undefined;
    if (metaRow === undefined) {
      return undefined;
    }
    const bets = this.db
      .prepare(SELECT_ALLOCATION_BETS_SQL)
      .all(analysisId) as StoredAllocationBetDetail[];
    return toStoredAllocation(metaRow, bets);
  }

  /**
   * レースの実着順(と複勝確定払戻)を取得する。1件も保存されていなければ undefined を返す。
   * @param raceId レースID
   */
  getResult(raceId: string): RaceResultEntry[] | undefined {
    const rows = this.db
      .prepare(
        `SELECT umaban, finish_position AS finishPosition, place_payout AS placePayout,
                win_payout AS winPayout
           FROM ${RACE_RESULTS_TABLE} WHERE race_id = ? ORDER BY umaban`,
      )
      .all(raceId) as Array<{
      umaban: number;
      finishPosition: number | null;
      placePayout: number | null;
      winPayout: number | null;
    }>;
    if (rows.length === 0) {
      return undefined;
    }
    return rows.map((r) => ({
      umaban: r.umaban,
      finishPosition: r.finishPosition,
      placePayout: r.placePayout,
      winPayout: r.winPayout,
    }));
  }

  /**
   * レース結果の詳細(通過順・上がり3F・面)を取得する(タスク#27-A2)。
   * race_results(馬単位)・race_result_meta(レース単位の面)の2テーブルから復元する。
   * 1件も保存されていなければ undefined を返す(getResultと同じ流儀)。
   *
   * 防御的復元: passing_json が NULL・不正なJSON(配列でない/要素が数値でない)の場合は
   * passing=[] にフォールバックする(silentにthrowしない。旧データ・想定外の書き込みへの耐性)。
   * course_type が未知の文字列(想定外の値の混入)の場合も courseType=null にフォールバックする。
   * race_result_meta に行が無い(面が取れなかったレース)場合も同様に courseType=null。
   * @param raceId レースID
   */
  getRaceResultDetail(raceId: string): RaceResultDetail | undefined {
    const rows = this.db.prepare(SELECT_RESULT_DETAIL_SQL).all(raceId) as ResultDetailRow[];
    if (rows.length === 0) {
      return undefined;
    }
    const metaRow = this.db.prepare(SELECT_RESULT_META_SQL).get(raceId) as
      | { courseType: string | null }
      | undefined;
    // 行 → 結果詳細の復元(通過順・面の防御的復元を含む)は codec(D1 実装と共有)が担う。
    return toRaceResultDetail(rows, metaRow?.courseType ?? null);
  }

  /**
   * 保存済み分析を取得する。filter.raceId を与えるとそのレースのみに絞り込む。
   * 分析はID昇順(保存順)、馬は馬番昇順で返す。
   * @param filter 絞り込み条件(省略時は全件)
   */
  listAnalyses(filter: AnalysisFilter = {}): StoredAnalysis[] {
    const analyses = (
      filter.raceId === undefined
        ? this.db.prepare(SELECT_ANALYSES_SQL).all()
        : this.db.prepare(SELECT_ANALYSES_BY_RACE_SQL).all(filter.raceId)
    ) as AnalysisRow[];

    const horseStmt = this.db.prepare(SELECT_ANALYSIS_HORSES_SQL);

    // 行 → StoredAnalysis の復元(NULL・0/1・JSON)は codec(D1 実装と共有)が担う。
    return analyses.map((a) => toStoredAnalysis(a, horseStmt.all(a.id) as HorseRow[]));
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
