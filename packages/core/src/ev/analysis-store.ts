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
 *
 * 通過順(passing_json)・上がり3F(last3f)列、面テーブル(race_result_meta)(タスク#27-A2):
 * #27-C(当日傾向のプロンプト反映)の土台として、結果取込の各馬に通過順・上がり3Fを、
 * レース単位に面(course_type、芝/ダ/障)を永続化・復元できるようにする。
 * - race_results に passing_json TEXT(通過順配列のJSON文字列)・last3f REAL を追加する。
 *   他の列(mark・ev_estimated 等)と同じ流儀で ALTER TABLE により後付けし、既存行は
 *   passing_json=NULL→復元時 passing=[]、last3f=NULLのまま読む(後方互換)。
 * - 面はレース単位の情報(馬ごとに変わらない)であり、馬単位の race_results に持たせると
 *   同一レース内の全行へ冗長に複製することになるため、正規化してレース単位の新テーブル
 *   race_result_meta(race_id PRIMARY KEY, course_type TEXT)に分離する。面が取得できない
 *   レース(courseType が null/未指定)は行そのものを作らない(読み出し側で
 *   「行が無い=面不明」と「行はあるが course_type が未知値=面不明」を区別する必要が無いよう、
 *   前者に統一する)。
 * - saveResult は race_results・race_result_meta の2テーブルを単一の db.transaction 内で書く
 *   (better-sqlite3 の transaction は例外で全ロールバックされるため、2テーブル書き込みの
 *   原子性を担保できる)。
 * - 復元専用の getRaceResultDetail(raceId) を新設する。既存の getResult(旧来の
 *   umaban/finishPosition/placePayoutのみを返す verify 専用メソッド)は一切変更しない
 *   (verify のクエリ性能・出力契約を保つため)。
 */

import Database from "better-sqlite3";

import type { PredictionMark } from "../analyzer/parse-response.js";
import { buildComboOddsKey, COMBO_SIZE, type ComboBetType } from "../scraper/combo-odds-key.js";
import type { CourseType, RaceComboPayoutResult } from "../scraper/types.js";

const ANALYSES_TABLE = "analyses";
const ANALYSIS_HORSES_TABLE = "analysis_horses";
const RACE_RESULTS_TABLE = "race_results";
const RACE_RESULT_META_TABLE = "race_result_meta";
const RACE_COMBO_PAYOUTS_TABLE = "race_combo_payouts";
const RACE_COMBO_PAYOUT_IMPORTS_TABLE = "race_combo_payout_imports";
const ANALYSIS_ALLOCATION_META_TABLE = "analysis_allocation_meta";
const ANALYSIS_BETS_TABLE = "analysis_bets";

/**
 * 組合せ払戻(ワイド・3連複)で扱う券種一覧(Issue #52)。
 * `COMBO_SIZE`(`combo-odds-key.ts`)のキーをそのまま使い、券種一覧を別の場所で
 * 二重に列挙しない(単一ソース。AC10)。
 */
const COMBO_BET_TYPES = Object.keys(COMBO_SIZE) as ComboBetType[];

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
  /**
   * LLMが返した和文根拠(Issue#10 分析データのエクスポート)。LLM未使用(prior採用)の分析は
   * null を渡す想定。省略時も null(既存呼び出し元との後方互換のため任意項目とする)。
   */
  readonly reason?: string | null;
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
  /**
   * 使用したLLMモデル名(Issue#10 分析データのエクスポート、例: "claude-sonnet-4-6")。
   * LLMを使わず prior をそのまま採用した分析(LLMスキップ)は null を渡す想定(偽値を混入させない)。
   * 省略時も null(既存呼び出し元との後方互換のため任意項目とする)。
   */
  readonly model?: string | null;
  /**
   * LLMの生応答テキスト(Issue#10)。LLMスキップ時は null を渡す想定。
   * 秘密安全性: これはLLMが返したモデル出力テキストのみで、プロンプト本文・apiKey等は含まない
   * (呼び出し側〈analysis-pipeline.ts〉が analyzeRace の結果からそのまま転送する)。
   * 省略時も null(既存呼び出し元との後方互換のため任意項目とする)。
   */
  readonly rawResponse?: string | null;
  /**
   * 取得したレース情報のスナップショット(Issue#10。エクスポート用、過去戦績は含めない)。
   * JSON化して保存する(contributions と同じ流儀)。LLM使用有無に関わらず、取得済みレース情報が
   * あれば保存してよい。省略時・undefinedは null(スナップショット無し)として保存する。
   * 型は analysis-store 側では意図的に unknown のまま扱う(スキーマは呼び出し側
   * 〈main/analysis-export.ts の RaceSnapshot〉が定義・検証する)。
   */
  readonly raceSnapshot?: unknown;
  /**
   * 配分提案(Issue #59)。省略時(undefined)は配分メタ行・明細行のいずれも保存しない
   * (呼び出し側が配分計算そのものを行わなかった=「未到達」であり、以前からの分析と区別が
   * つかない旧形式のまま。#59 AC4「旧分析(記録なし)」に対応する)。
   * 値を渡す場合は必ず meta を含める(全経路〈unset/yoso/unavailable/place-only/mixed/invalid〉で
   * 1行書くのが#59の核心の不変条件。呼び出し側〈main/allocation-record.ts〉が保証する)。
   */
  readonly allocation?: AnalysisAllocationRecord;
}

/**
 * 配分提案(Issue #59)のレース単位メタ + 明細行。
 *
 * route・betType・各種理由コードは呼び出し側(app shared/ の AllocationRouteCode 等)が
 * 定義する文字列をそのまま受け取り、core はその意味を解釈しない(raceSnapshot: unknown と
 * 同じ流儀。shared/ の型を core へ複製しない)。
 */
export interface AnalysisAllocationRecord {
  readonly meta: AnalysisAllocationMetaRecord;
  /** stake>0 の明細のみ(呼び出し側でフィルタ済みの前提。#59 決定(a))。 */
  readonly bets: readonly AnalysisBetRecord[];
}

/** 配分提案のレース単位メタ行(#59 スキーマ。列一覧は固定。増減は停止条件)。 */
export interface AnalysisAllocationMetaRecord {
  /** 到達状態(層1)。app 側 AllocationRouteCode の値をそのまま受け取る。 */
  readonly route: string;
  /** app 側 PlaceBetUnavailableReason。route!=="unavailable" のときは null(未到達)。 */
  readonly unavailableReason: string | null;
  /** app 側 PlaceOnlyFallbackReason。D-2フォールバックを通っていないときは null(未到達)。 */
  readonly fallbackReason: string | null;
  /** app 側 SkipReasonCode。coreの配分計算に未到達、または非skipのときは null。 */
  readonly skipReasonCode: string | null;
  /** app 側 ComboOddsAvailabilityCode(ワイド)。診断値を算出していなければ null(未到達)。 */
  readonly comboOddsWide: string | null;
  /** app 側 ComboOddsAvailabilityCode(3連複)。診断値を算出していなければ null(未到達)。 */
  readonly comboOddsTrio: string | null;
  /** 実効設定(実行時の値をそのまま記録。#59 決定(a): 復元不能な実効値)。 */
  readonly bankroll: number;
  readonly perRaceCap: number;
  readonly kellyFraction: number;
  readonly evThreshold: number;
  readonly includeComboOdds: boolean;
  readonly includeWide: boolean;
  readonly includeTrio: boolean;
  /** 賭け金の最小単位(円)。coreの配分計算に到達していない経路(unset/yoso/unavailable)は null。 */
  readonly betUnit: number | null;
  /** 貪欲逐次配分の分割数。betUnit と同じ到達条件。 */
  readonly greedySteps: number | null;
  /** 候補cap(組合せ券種のみに存在する暴走ガード)。複勝のみの経路〈place-only〉には無いため null。 */
  readonly candidateCap: number | null;
  /** 配分結果の同時分布モデルID。配分結果(BetAllocationResult/GeneralBetAllocationResult)を
   * 実際に得られた経路〈place-only/mixed〉のみ非null。 */
  readonly modelId: string | null;
  /** 上記モデルが近似か。modelId と同じ到達条件。 */
  readonly modelApproximate: boolean | null;
  /** オッズ発売状態(発売前/中間/確定)。app 側 OddsStatus の値をそのまま受け取る。 */
  readonly oddsStatus: string;
}

/**
 * `getAllocationForVerify` が返す配分提案の1買い目分(Issue #71・#54-B)。
 * `AnalysisBetRecord` の5列のうち `odds`/`ev` を持たない(#71のスコープ外。下記
 * `getAllocationForVerify` のJSDoc参照)。
 */
export interface StoredAllocationBet {
  /** 券種。app 側の "place" | "wide" | "trio"。 */
  readonly betType: string;
  /** buildComboOddsKey による正規化キー。複勝は2桁ゼロ埋め1個のみ。 */
  readonly comboKey: string;
  /** 実際の配分額(円)。stake>0 の行のみ(#59 決定(a))。 */
  readonly stake: number;
}

/**
 * `getStoredAllocation` が返す配分提案の1買い目分(Issue #55)。`StoredAllocationBet`
 * (`getAllocationForVerify` 用。odds/evを持たない)とは別に、過去分析の再表示(検証タブ
 * 「レース一覧」)が必要とする odds/ev を含む完全な表示用行として持つ。
 */
export interface StoredAllocationBetDetail {
  /** 券種。app 側の "place" | "wide" | "trio"。未知の値が混入していてもそのまま返す(throwしない)。 */
  readonly betType: string;
  /** buildComboOddsKey による正規化キー。複勝は2桁ゼロ埋め1個のみ。 */
  readonly comboKey: string;
  /** 実際の配分額(円)。stake>0 の行のみ(#59 決定(a))。 */
  readonly stake: number;
  /** 分析時点で採用したオッズ。欠損・未確定なら null。 */
  readonly odds: number | null;
  /** 分析時点の期待値。欠損・未確定なら null。 */
  readonly ev: number | null;
}

/**
 * `getStoredAllocation` が返す配分提案(Issue #55: 過去分析の再表示で配分提案を出す)。
 *
 * メタ行20列(主キー`analysis_id`を含む物理列数。AC2テスト等で使う数え方と同じ)のうち、
 * boss裁定(2026-09-02)により以下の13列だけを読む。残り7列のうち`analysis_id`は返り値の
 * データ列ではなく引数(検索キー)そのものであり、列挙の対象外とする。したがって
 * 実質的に「読まない列」として列挙するのは次の6列〈combo_odds_wide/combo_odds_trio/
 * greedy_steps/candidate_cap/model_id/model_approximate〉(利用者に意味の無い内部パラメータ、
 * または表示予定が無いため意図的に読まない。#71の原則「誰も読まない列にコストを払わない」を
 * 踏襲する。AC2の対象もこの6列):
 * route/unavailable_reason/fallback_reason/skip_reason_code/bankroll/per_race_cap/
 * kelly_fraction/ev_threshold/include_combo_odds/include_wide/include_trio/bet_unit/
 * odds_status。
 *
 * `getAllocationForVerify`(#71。route/skip_reason_codeとbets 3列のみ)とは読む列の範囲が
 * 異なる**別のクエリ**であり、互いに変更の影響を与えない(#71 AC-B4の論拠を壊さないための
 * 意図的な分離)。
 */
export interface StoredAllocation {
  /** 到達状態(層1)。app 側 AllocationRouteCode の値をそのまま。未知の値でもそのまま返す。 */
  readonly route: string;
  /** app 側 PlaceBetUnavailableReason。route!=="unavailable" のときは null(未到達)。 */
  readonly unavailableReason: string | null;
  /**
   * app 側 PlaceOnlyFallbackReason。D-2フォールバックを通っていないときは null(未到達)。
   * `route==="unavailable"` でも非nullになりうる(D-2フォールバックが頭数不可で
   * `kind:"unavailable"` になった場合。`shared/mixed-race-allocation.ts` の
   * `AllocationOutcomeCodes` JSDoc参照)。
   */
  readonly fallbackReason: string | null;
  /** app 側 SkipReasonCode。coreの配分計算に未到達、または非skipのときは null。 */
  readonly skipReasonCode: string | null;
  /** 実効設定(実行時の値をそのまま記録)。 */
  readonly bankroll: number;
  readonly perRaceCap: number;
  readonly kellyFraction: number;
  readonly evThreshold: number;
  readonly includeComboOdds: boolean;
  readonly includeWide: boolean;
  readonly includeTrio: boolean;
  /** 賭け金の最小単位(円)。coreの配分計算に到達していない経路(unset/yoso/unavailable)は null。 */
  readonly betUnit: number | null;
  /** オッズ発売状態(発売前/中間/確定)。app 側 OddsStatus の値をそのまま受け取る。 */
  readonly oddsStatus: string;
  /** stake>0 の明細のみ(#59 決定(a)を引き継ぐ)。 */
  readonly bets: readonly StoredAllocationBetDetail[];
}

/**
 * `getAllocationForVerify` が返す配分提案の最小表現(Issue #71・#54-B)。
 * メタ行20列のうち `route`/`skip_reason_code` の2列だけを持つ(残り18列は#71のスコープ外。
 * 下記 `getAllocationForVerify` のJSDoc参照)。
 */
export interface StoredAllocationSummary {
  /** 到達状態(層1)。app 側 AllocationRouteCode の値をそのまま。 */
  readonly route: string;
  /** 見送り理由(層2)。coreの配分計算に未到達、または非skipのときは null。 */
  readonly skipReasonCode: string | null;
  /** stake>0 の明細のみ(#59 決定(a)を引き継ぐ)。 */
  readonly bets: readonly StoredAllocationBet[];
}

/** 配分提案の1買い目分の明細行(#59。複勝・ワイド・3連複を共通の形に統合)。 */
export interface AnalysisBetRecord {
  /** 券種。app 側の "place" | "wide" | "trio"。 */
  readonly betType: string;
  /** buildComboOddsKey(app 側が呼び出し済み)による正規化キー。複勝は2桁ゼロ埋め1個のみ。 */
  readonly comboKey: string;
  /** 実際の配分額(円)。stake>0 の行のみを渡す前提(#59 決定(a))。 */
  readonly stake: number;
  /** 採用したオッズ。複勝は候補外ならありえないが、断定せずそのまま写す(null許容)。 */
  readonly odds: number | null;
  /** 期待値。odds と同じくそのまま写す。 */
  readonly ev: number | null;
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
  /**
   * LLMが返した和文根拠(Issue#10)。LLM未使用・旧レコード(列追加前の保存)は null。
   */
  readonly reason: string | null;
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
  /**
   * 使用したLLMモデル名(Issue#10)。LLMスキップ・旧レコード(列追加前の保存)は null。
   */
  readonly model: string | null;
  /**
   * LLMの生応答テキスト(Issue#10)。LLMスキップ・旧レコード(列追加前の保存)は null。
   */
  readonly rawResponse: string | null;
  /**
   * 取得したレース情報のスナップショット(Issue#10。JSONからパース済み)。未保存・
   * 旧レコード(列追加前の保存)・破損JSONは null(防御的復元。getRaceResultDetailと同方針)。
   */
  readonly raceSnapshot: unknown;
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
  /**
   * 通過順位(例: [2,3,4,3]、タスク#27-A2)。取得できない場合は空配列。
   * 省略時は空配列として保存する(placePayoutと同方針の非破壊optional追加)。
   */
  readonly passing?: number[];
  /**
   * 上がり3F(タスク#27-A2)。取得できない場合は null。省略時もnull扱い(後方互換)。
   */
  readonly last3f?: number | null;
}

/**
 * saveResult に渡す組合せ払戻(ワイド・3連複)の入力(Issue #52・boss裁定R-7)。
 *
 * 各券種の値は `parseRaceResult` が返す判別共用体(`RaceComboPayoutResult`)をそのまま渡す
 * 設計にし、「構造異常なのに空配列として渡してしまう」ことを型として表現不能にする
 * (呼び出し側〈result-import.ts〉に判断を持たせない。R-7の要点)。
 *
 * - `state:"undetermined"`: その券種の `race_combo_payouts`/`race_combo_payout_imports` に
 *   一切触れない(既存値があれば保持する。R-5)。一過性の構造異常・払戻未公開の再取込で
 *   正しい過去データを破壊しないための設計。
 * - `state:"parsed"`: 既存行を DELETE してから保存し直す(`payouts:[]` なら明示的に空へ
 *   クリアする。AC8)。
 * - 券種キー省略・`comboPayouts` 自体の省略: 触れない(`courseType` と同じ非破壊 optional。
 *   AC13。既存呼び出しは無改変で通る)。
 */
export interface RaceComboPayoutsSaveInput {
  readonly wide?: RaceComboPayoutResult;
  readonly trio?: RaceComboPayoutResult;
}

/** `race_combo_payouts` の1行(読み出し専用の軽量表現。Issue #52・boss裁定R-6)。 */
export interface StoredComboPayout {
  /**
   * `buildComboOddsKey` で得られる正規化キー(例: ワイド"0102")。復号(umabans配列への
   * 復元)は本Issueのスコープ外(不明点4。#54が表示で必要になった時点で追加する)。
   * 呼び出し側は `buildComboOddsKey` で購入候補側を同じキーへ正規化して比較すればよい。
   *
   * **AC10(流用禁止)**: `buildComboOddsKey` は馬番を**昇順に正規化してから**連結するため、
   * 順不同の組(ワイド・3連複)でしか意味を持たない。**着順が意味を持つ券種(馬単・三連単)には
   * このキー生成規則を流用してはならない**(例: 馬単「1着1・2着2」と「1着2・2着1」は別の
   * 買い目だが、`buildComboOddsKey([1,2])` はどちらも同じ"0102"に潰してしまい区別できなくなる)。
   * `race_combo_payouts.bet_type` 列は将来の券種追加を「行追加だけで足りる」形にしてあるが、
   * それは**順不同の組(ワイド系)に限った話**であり、馬単・三連単を同じ `combo_key` 列に
   * 追加する場合は、着順を保持できるキー生成規則へ分岐させる(または列/テーブル自体を
   * 分離する)必要がある。
   */
  readonly comboKey: string;
  /** 100円あたりの払戻額(円)。 */
  readonly payout: number;
}

/**
 * `getComboPayouts` の返り値(判別共用体。Issue #52 AC9・boss裁定R-4〜R-6)。
 *
 * 現実の事象と state の対応(#54 が読む契約。曖昧さを残さないためここに列挙する):
 * - `"not_imported"`: 次のいずれか。(a) このレース・券種を一度も取り込んでいない。
 *   (b) 本機能(Issue #52)より前に取り込んだ旧DB(`race_combo_payout_imports` にマーカー行が
 *   無い。`race_results` には行があってもこの判定には使わない。R-4)。(c) 直近の取込で
 *   この券種が構造異常・払戻未公開だった(`RaceComboPayoutResult` の `state:"undetermined"`。
 *   `saveResult` はこの場合DBに一切触れないため、初回なら `not_imported` のまま、
 *   再取込なら前回の正しい値が保持される)。
 *   → #54はこの状態を**分母から除外する(判定不能)**。
 * - `"imported"` かつ `payouts` が空配列: 払戻テーブルは取れたがこの券種の行が無かった
 *   (未発売等)。
 *   → #54はこの状態を**「払戻0円」ではなく「この券種は成立していない」ものとして扱う**
 *   (具体的な集計方法自体は#54が決める)。
 * - `"imported"` かつ `payouts.length >= 1`: 確定払戻。
 */
export type RaceComboPayoutsReadResult =
  | { readonly state: "not_imported" }
  | { readonly state: "imported"; readonly payouts: readonly StoredComboPayout[] };

/** 復元したレース結果詳細の1頭分(getRaceResultDetail、タスク#27-A2)。 */
export interface RaceResultDetailHorse {
  /** 馬番。 */
  readonly umaban: number;
  /** 実着順。非数値着順(中止・除外・着順不明)は null。 */
  readonly finishPosition: number | null;
  /** 通過順位。未保存・復元不能(JSON破損等)は空配列。 */
  readonly passing: number[];
  /** 上がり3F。未保存は null。 */
  readonly last3f: number | null;
}

/**
 * 復元したレース結果詳細(getRaceResultDetail、タスク#27-A2)。
 * #27-C(当日傾向のプロンプト反映)が消費する最小フィールドに絞った契約型。
 * horseName・wakuban 等、race_resultsに保存していない項目は含めない
 * (未保存の値に偽の値を混入させないため)。
 */
export interface RaceResultDetail {
  /** レース単位の面(芝/ダ/障)。未取得・未保存(race_result_metaに行が無い)は null。 */
  readonly courseType: CourseType | null;
  /** 各馬の着順・通過順・上がり3F(馬番昇順)。 */
  readonly horses: readonly RaceResultDetailHorse[];
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
  reason: string | null;
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
        kaisai_date TEXT,
        model TEXT,
        raw_response TEXT,
        race_snapshot_json TEXT
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
      CREATE TABLE IF NOT EXISTS ${RACE_RESULT_META_TABLE} (
        race_id TEXT PRIMARY KEY,
        course_type TEXT
      );
      -- 組合せ払戻(ワイド・3連複)の値テーブルとマーカーテーブル(Issue #52・AC12)。
      -- race_result_meta(タスク#27-A2)と同じ理由・同じ流儀で CREATE TABLE IF NOT EXISTS
      -- を使う(ALTER TABLE ADD COLUMN ではない): これらは既存テーブルへの列追加ではなく
      -- 新規テーブルの追加であり、旧DBを開いた際に無ければ作成されるだけで既存データには
      -- 触れない(冪等・非破壊)。2テーブルに分けた理由(R-4): 値テーブル(下記)だけでは
      -- 「未取込」と「取り込んだが該当券種の払戻が0件だった」を区別できない
      -- (行の個数ではなく行の有無で判定する必要があるため。listUnimportedRaceIdsが
      -- race_resultsの行の有無でNOT EXISTS判定する既存流儀と同じ)。
      --
      -- combo_key は buildComboOddsKey による「馬番昇順正規化キー」であり、順不同の組
      -- (ワイド・3連複)でしか意味を持たない(AC10)。着順を持つ券種(馬単・三連単)には
      -- このキー生成規則を流用できない(1着1・2着2 と 1着2・2着1 が同じキーに潰れて
      -- 区別できなくなるため)。bet_type列を増やすだけで足りるのはワイド系(順不同の組)に
      -- 限られ、馬単・三連単を追加する際はキー生成規則を分岐させるか、combo_key列/
      -- テーブル自体を分離する必要がある。詳細: StoredComboPayout.comboKey のJSDoc。
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
      -- boss着手前ゲート・#59で固定。race_combo_payouts と同じ理由・同じ流儀で
      -- CREATE TABLE IF NOT EXISTS を使う(新規テーブル追加であり既存データには触れない)。
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
    this.migrateResultPayoutColumn();
    this.migrateMarkColumn();
    this.migrateEvEstimatedColumn();
    this.migratePromptVersionColumn();
    this.migrateAdditionalInstructionColumn();
    this.migrateKaisaiDateColumn();
    this.migrateResultDetailColumns();
    this.migrateAnalysisExportColumns();
    this.migrateHorseReasonColumn();
  }

  /**
   * エクスポート用列(model・raw_response・race_snapshot_json)を後付けするマイグレーション
   * (Issue#10 分析データのエクスポート)。
   * 旧バージョンで作成済みの analyses にはこれらの列が無いため、存在しなければ追加する
   * (既存行は全列NULL=LLM未使用・スナップショット未保存として読める=後方互換)。
   */
  private migrateAnalysisExportColumns(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${ANALYSES_TABLE})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "model")) {
      this.db.exec(`ALTER TABLE ${ANALYSES_TABLE} ADD COLUMN model TEXT`);
    }
    if (!columns.some((c) => c.name === "raw_response")) {
      this.db.exec(`ALTER TABLE ${ANALYSES_TABLE} ADD COLUMN raw_response TEXT`);
    }
    if (!columns.some((c) => c.name === "race_snapshot_json")) {
      this.db.exec(
        `ALTER TABLE ${ANALYSES_TABLE} ADD COLUMN race_snapshot_json TEXT`,
      );
    }
  }

  /**
   * LLM根拠(reason)列を後付けするマイグレーション(Issue#10)。
   * 旧バージョンで作成済みの analysis_horses には reason 列が無いため、存在しなければ追加する
   * (既存行は NULL=根拠なしとして読める=後方互換)。
   */
  private migrateHorseReasonColumn(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${ANALYSIS_HORSES_TABLE})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "reason")) {
      this.db.exec(`ALTER TABLE ${ANALYSIS_HORSES_TABLE} ADD COLUMN reason TEXT`);
    }
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
   * 通過順(passing_json)・上がり3F(last3f)列を後付けするマイグレーション(タスク#27-A2)。
   * 旧バージョンで作成済みの race_results にはこれらの列が無いため、存在しなければ追加する
   * (既存行は passing_json=NULL→復元時 passing=[]、last3f=NULLのまま読める=後方互換)。
   */
  private migrateResultDetailColumns(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${RACE_RESULTS_TABLE})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "passing_json")) {
      this.db.exec(
        `ALTER TABLE ${RACE_RESULTS_TABLE} ADD COLUMN passing_json TEXT`,
      );
    }
    if (!columns.some((c) => c.name === "last3f")) {
      this.db.exec(`ALTER TABLE ${RACE_RESULTS_TABLE} ADD COLUMN last3f REAL`);
    }
  }

  /**
   * 分析結果を保存し、採番された分析IDを返す。レース行と馬行をトランザクションで一括保存する。
   * @param record レース単位の分析結果
   */
  saveAnalysis(record: AnalysisRecord): number {
    const insertAnalysis = this.db.prepare(
      `INSERT INTO ${ANALYSES_TABLE}
         (race_id, analyzed_at, ev_estimated, prompt_version, additional_instruction, kaisai_date,
          model, raw_response, race_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertHorse = this.db.prepare(
      `INSERT INTO ${ANALYSIS_HORSES_TABLE}
         (analysis_id, umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // 配分提案(Issue #59)。record.allocation が渡されたときだけ書く(#59 AC4「旧分析(記録なし)」)。
    const insertAllocationMeta = this.db.prepare(
      `INSERT INTO ${ANALYSIS_ALLOCATION_META_TABLE}
         (analysis_id, route, unavailable_reason, fallback_reason, skip_reason_code,
          combo_odds_wide, combo_odds_trio, bankroll, per_race_cap, kelly_fraction, ev_threshold,
          include_combo_odds, include_wide, include_trio, bet_unit, greedy_steps, candidate_cap,
          model_id, model_approximate, odds_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAllocationBet = this.db.prepare(
      `INSERT INTO ${ANALYSIS_BETS_TABLE}
         (analysis_id, bet_type, combo_key, stake, odds, ev)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction((rec: AnalysisRecord): number => {
      const info = insertAnalysis.run(
        rec.raceId,
        rec.analyzedAt,
        rec.evEstimated ? 1 : 0,
        rec.promptVersion ?? null,
        rec.additionalInstruction ?? null,
        rec.kaisaiDate ?? null,
        rec.model ?? null,
        rec.rawResponse ?? null,
        rec.raceSnapshot === undefined || rec.raceSnapshot === null
          ? null
          : JSON.stringify(rec.raceSnapshot),
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
          h.reason ?? null,
        );
      }
      if (rec.allocation !== undefined) {
        const m = rec.allocation.meta;
        insertAllocationMeta.run(
          analysisId,
          m.route,
          m.unavailableReason,
          m.fallbackReason,
          m.skipReasonCode,
          m.comboOddsWide,
          m.comboOddsTrio,
          m.bankroll,
          m.perRaceCap,
          m.kellyFraction,
          m.evThreshold,
          m.includeComboOdds ? 1 : 0,
          m.includeWide ? 1 : 0,
          m.includeTrio ? 1 : 0,
          m.betUnit,
          m.greedySteps,
          m.candidateCap,
          m.modelId,
          m.modelApproximate === null ? null : m.modelApproximate ? 1 : 0,
          m.oddsStatus,
        );
        for (const b of rec.allocation.bets) {
          insertAllocationBet.run(
            analysisId,
            b.betType,
            b.comboKey,
            b.stake,
            b.odds,
            b.ev,
          );
        }
      }
      return analysisId;
    });

    return tx(record);
  }

  /**
   * レース後の実着順(通過順・上がり3F・複勝確定払戻)と、レース単位の面(course_type)を保存する。
   * (race_id, umaban) 主キーで再保存は上書きする。
   * placePayout/passing/last3f を省略した場合はそれぞれ null/空配列/null で保存する
   * (未取込項目=後続の復元・verifyは欠損値として扱う)。
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
    const upsertResult = this.db.prepare(
      `INSERT INTO ${RACE_RESULTS_TABLE}
         (race_id, umaban, finish_position, place_payout, passing_json, last3f)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(race_id, umaban) DO UPDATE SET
         finish_position = excluded.finish_position,
         place_payout = excluded.place_payout,
         passing_json = excluded.passing_json,
         last3f = excluded.last3f`,
    );
    const upsertMeta = this.db.prepare(
      `INSERT INTO ${RACE_RESULT_META_TABLE} (race_id, course_type)
       VALUES (?, ?)
       ON CONFLICT(race_id) DO UPDATE SET course_type = excluded.course_type`,
    );
    const deleteCombo = this.db.prepare(
      `DELETE FROM ${RACE_COMBO_PAYOUTS_TABLE} WHERE race_id = ? AND bet_type = ?`,
    );
    const insertCombo = this.db.prepare(
      `INSERT INTO ${RACE_COMBO_PAYOUTS_TABLE} (race_id, bet_type, combo_key, payout)
       VALUES (?, ?, ?, ?)`,
    );
    const markComboImported = this.db.prepare(
      `INSERT INTO ${RACE_COMBO_PAYOUT_IMPORTS_TABLE} (race_id, bet_type)
       VALUES (?, ?)
       ON CONFLICT(race_id, bet_type) DO NOTHING`,
    );
    const tx = this.db.transaction(
      (
        rows: readonly RaceResultEntry[],
        meta: CourseType | null | undefined,
        combo: RaceComboPayoutsSaveInput | undefined,
      ) => {
        for (const r of rows) {
          upsertResult.run(
            raceId,
            r.umaban,
            r.finishPosition,
            r.placePayout ?? null,
            JSON.stringify(r.passing ?? []),
            r.last3f ?? null,
          );
        }
        if (meta !== undefined && meta !== null) {
          upsertMeta.run(raceId, meta);
        }
        for (const betType of COMBO_BET_TYPES) {
          const result = combo?.[betType];
          if (result === undefined || result.state === "undetermined") {
            // R-5・R-7: 判定不能(構造異常・払戻未公開)または未指定はDBに判定結果として
            // 残さない。再取込で一過性の異常が起きても、既存の正しい値を保持する。
            continue;
          }
          deleteCombo.run(raceId, betType);
          for (const entry of result.payouts) {
            insertCombo.run(
              raceId,
              betType,
              buildComboOddsKey(entry.umabans),
              entry.payout,
            );
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
   * 渡す型付きの betType("wide"|"trio")で WHERE 句を等価比較するため、DBに万一未知の
   * bet_type 値が混入していても、そのレース・その betType の一致行以外は自動的に除外される
   * (toStoredCourseType のような追加の防御的フォールバック関数を別途持つ必要が無い)。
   * @param raceId レースID
   * @param betType 券種("wide"|"trio")
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
   * **意図的に読まない列(#71 着手前ゲート決定)**: メタ行の残り18列
   * (`unavailable_reason`/`fallback_reason`/`combo_odds_wide`/`combo_odds_trio`/実効設定7列/
   * 実効値4列/`odds_status`)と、明細の `odds`/`ev` の2列は返さない。#71 が実際に使うのは
   * `route`・`skip_reason_code`(母集団の4分類)と `bet_type`/`combo_key`/`stake`
   * (実際の配分額そのものを賭け金とする。Q-C)の5列のみで、`odds`/`ev` を読むと
   * 「回収率」ではなく「提案時点の期待値の再計算」になってしまう(Q-Cに反する)。
   * 誰も読まない列にまで #59 の条件B(非衝突)のコストを払わない判断は #59 で8巡した
   * 失敗の再現を避けるため(#71 Issue本文)。#55(過去分析の再表示UI)で残り18列/odds/evが
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
   * 再表示で配分提案を出す)が読む13列 + bets(betType/comboKey/stake/odds/ev)を取得する。
   * メタ行が無ければ undefined を返す(#59より前の旧分析=「記録なし」)。
   *
   * **読まない6列(boss裁定2026-09-02)**: `combo_odds_wide`/`combo_odds_trio`/`greedy_steps`/
   * `candidate_cap`/`model_id`/`model_approximate`(メタ行の物理列数20から読む13列と
   * `analysis_id`〈検索キーであり返り値のデータ列ではないため列挙に含めない〉を除いた数)。
   * 前者2つは表示予定が無く(#55のスコープ外。必要になれば#16で追加)、後者4つは利用者に
   * 意味の無い内部パラメータ(`getAllocationForVerify`のJSDocと同じ判断)。詳細は
   * {@link StoredAllocation} のJSDoc参照。
   * @param analysisId 分析ID
   */
  getStoredAllocation(analysisId: number): StoredAllocation | undefined {
    const metaRow = this.db
      .prepare(
        `SELECT route, unavailable_reason AS unavailableReason, fallback_reason AS fallbackReason,
                skip_reason_code AS skipReasonCode, bankroll, per_race_cap AS perRaceCap,
                kelly_fraction AS kellyFraction, ev_threshold AS evThreshold,
                include_combo_odds AS includeComboOdds, include_wide AS includeWide,
                include_trio AS includeTrio, bet_unit AS betUnit, odds_status AS oddsStatus
           FROM ${ANALYSIS_ALLOCATION_META_TABLE} WHERE analysis_id = ?`,
      )
      .get(analysisId) as
      | {
          route: string;
          unavailableReason: string | null;
          fallbackReason: string | null;
          skipReasonCode: string | null;
          bankroll: number;
          perRaceCap: number;
          kellyFraction: number;
          evThreshold: number;
          includeComboOdds: number;
          includeWide: number;
          includeTrio: number;
          betUnit: number | null;
          oddsStatus: string;
        }
      | undefined;
    if (metaRow === undefined) {
      return undefined;
    }
    const bets = this.db
      .prepare(
        `SELECT bet_type AS betType, combo_key AS comboKey, stake, odds, ev
           FROM ${ANALYSIS_BETS_TABLE} WHERE analysis_id = ? ORDER BY bet_type, combo_key`,
      )
      .all(analysisId) as StoredAllocationBetDetail[];
    return {
      route: metaRow.route,
      unavailableReason: metaRow.unavailableReason,
      fallbackReason: metaRow.fallbackReason,
      skipReasonCode: metaRow.skipReasonCode,
      bankroll: metaRow.bankroll,
      perRaceCap: metaRow.perRaceCap,
      kellyFraction: metaRow.kellyFraction,
      evThreshold: metaRow.evThreshold,
      includeComboOdds: metaRow.includeComboOdds !== 0,
      includeWide: metaRow.includeWide !== 0,
      includeTrio: metaRow.includeTrio !== 0,
      betUnit: metaRow.betUnit,
      oddsStatus: metaRow.oddsStatus,
      bets,
    };
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
    const rows = this.db
      .prepare(
        `SELECT umaban, finish_position AS finishPosition, passing_json AS passingJson, last3f
           FROM ${RACE_RESULTS_TABLE} WHERE race_id = ? ORDER BY umaban`,
      )
      .all(raceId) as Array<{
      umaban: number;
      finishPosition: number | null;
      passingJson: string | null;
      last3f: number | null;
    }>;
    if (rows.length === 0) {
      return undefined;
    }
    const metaRow = this.db
      .prepare(
        `SELECT course_type AS courseType FROM ${RACE_RESULT_META_TABLE} WHERE race_id = ?`,
      )
      .get(raceId) as { courseType: string | null } | undefined;
    return {
      courseType: toStoredCourseType(metaRow?.courseType ?? null),
      horses: rows.map((r) => ({
        umaban: r.umaban,
        finishPosition: r.finishPosition,
        passing: toStoredPassing(r.passingJson),
        last3f: r.last3f,
      })),
    };
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
                      kaisai_date AS kaisaiDate, model, raw_response AS rawResponse,
                      race_snapshot_json AS raceSnapshotJson
                 FROM ${ANALYSES_TABLE} ORDER BY id`,
            )
            .all()
        : this.db
            .prepare(
              `SELECT id, race_id AS raceId, analyzed_at AS analyzedAt, ev_estimated AS evEstimated,
                      prompt_version AS promptVersion, additional_instruction AS additionalInstruction,
                      kaisai_date AS kaisaiDate, model, raw_response AS rawResponse,
                      race_snapshot_json AS raceSnapshotJson
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
      model: string | null;
      rawResponse: string | null;
      raceSnapshotJson: string | null;
    }>;

    const horseStmt = this.db.prepare(
      `SELECT umaban, prior, adjusted_prob, place_odds_min, ev, is_positive, contributions_json, mark, reason
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
        // NULL(旧レコード・列追加前の保存・LLM未使用)はモデル不明としてnullのまま復元する(Issue#10)。
        model: a.model,
        // NULL(旧レコード・列追加前の保存・LLM未使用)は応答なしとしてnullのまま復元する(Issue#10)。
        rawResponse: a.rawResponse,
        // NULL・破損JSON(旧レコード・未保存)はスナップショットなしとしてnullで復元する(Issue#10。
        // 防御的復元。getRaceResultDetailと同方針)。
        raceSnapshot: toStoredRaceSnapshot(a.raceSnapshotJson),
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
    // 配分提案(Issue #59・analysis_allocation_meta/analysis_bets)も analyses(id) を
    // 参照するFK(NO ACTION)を持つため、analysis_horsesと同様に親行より先に削除しないと
    // FOREIGN KEY constraint failed で失敗する(#59 AC5-2。事前にこの経路の存在を実測確認済み)。
    const deleteBets = this.db.prepare(
      `DELETE FROM ${ANALYSIS_BETS_TABLE}
         WHERE analysis_id IN (
           SELECT id FROM ${ANALYSES_TABLE} WHERE prompt_version IS NULL
         )`,
    );
    const deleteAllocationMeta = this.db.prepare(
      `DELETE FROM ${ANALYSIS_ALLOCATION_META_TABLE}
         WHERE analysis_id IN (
           SELECT id FROM ${ANALYSES_TABLE} WHERE prompt_version IS NULL
         )`,
    );
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
      // 先に子行(analysis_bets → analysis_allocation_meta → analysis_horses)を消してから
      // 親行(analyses)を消す(FK制約違反を避けるため)。bets/meta と horses の間に順序制約は
      // 無い(互いを参照しない兄弟テーブル)が、いずれも analyses より先である必要がある。
      deleteBets.run();
      deleteAllocationMeta.run();
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

/**
 * race_results.passing_json(JSON文字列)を数値配列へ復元する(タスク#27-A2)。
 * NULL・JSON parseの失敗・配列でない・要素が数値でない(想定外の書き込み混入)は、
 * silentにthrowせず空配列にフォールバックする(getRaceResultDetailの防御的復元方針)。
 */
function toStoredPassing(raw: string | null): number[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((n) => typeof n === "number")
      ? (parsed as number[])
      : [];
  } catch {
    return [];
  }
}

/**
 * race_result_meta.course_type(TEXT)をドメイン型へ復元する(タスク#27-A2)。
 * NULL(面行が無い=面不明)・未知の文字列(想定外の書き込み混入)は null にフォールバックする
 * (getRaceResultDetailの防御的復元方針。parse-race-resultのtoCourseTypeOrNullと同流儀)。
 */
function toStoredCourseType(raw: string | null): CourseType | null {
  switch (raw) {
    case "芝":
    case "ダ":
    case "障":
      return raw;
    default:
      return null;
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
    reason: row.reason,
  };
}

/**
 * analyses.race_snapshot_json(JSON文字列)をレース情報スナップショットへ復元する(Issue#10)。
 * NULL(未保存・旧レコード)・JSON parseの失敗は、silentにthrowせず null にフォールバックする
 * (getRaceResultDetail/toStoredPassingと同じ防御的復元方針)。スキーマの妥当性検証は行わない
 * (呼び出し側〈main/analysis-export.ts〉が必要に応じて構造を検証する)。
 */
function toStoredRaceSnapshot(raw: string | null): unknown {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
