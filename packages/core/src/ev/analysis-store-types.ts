/**
 * 分析履歴ストア(`analysis-store.ts`)が入出力する型の定義(Issue #168・#163-a で切り出し)。
 *
 * **型だけのファイルで、better-sqlite3 に依存しない**(`import type` のみ。ビルドで消える)。
 * クラウド版(cloud/。Cloudflare Workers)の D1 実装(#169)が、exe(SQLite)の実装と同じ型を共有するために置く。
 * `analysis-store.ts` が再 export するので、既存の import 元(`./analysis-store.js`・バレル)は変わらない。
 * 各型の意味・保存先の列との対応は、各型の JSDoc と `analysis-store.ts` の CREATE TABLE のコメントを参照。
 */

import type { PredictionMark } from "../analyzer/parse-response.js";
import type { CourseType, RaceComboPayoutResult } from "../scraper/types.js";

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
  /**
   * 強調材料(Issue #197・#196-a。各最大3項目の短い句)。空配列・省略は「項目なし」で、DB には NULL で保存する
   * (既存呼び出し元との後方互換のため任意項目とする)。
   */
  readonly highlights?: readonly string[];
  /** 懸念事項(Issue #197・#196-a。仕様は highlights と同じ)。 */
  readonly concerns?: readonly string[];
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
   * 戦績を絞るのに使った基準日(YYYYMMDD。`kaisaiDate` と同じ形式。Issue #39)。
   * app 側の分析パイプラインが、先読みリーク遮断(基準日と同日以降・当該レース自身の走を
   * 材料から除く)に**実際に使った基準日**をそのまま渡す。`dateApproximate=true`(開催日が
   * 渡らず実行日で近似した)の分析でも、使った基準日(=実行日)を書く。
   * 省略・null は「遮断の記録なし=是正前の呼び出し元/旧行」で、DBには NULL として保存する。
   * 読み出しは `StoredAnalysis.historyCutoffDate`。verify での除外(`classifyLookaheadSuspicion`)は
   * Issue #152 で行う。
   */
  readonly historyCutoffDate?: string | null;
  /**
   * LLMプロンプト側の先読みリーク遮断(Issue #153: 当日傾向〈sameDayTrend〉は自レースより前のレース
   * 番号だけ・同レース過去10年結果傾向〈gradeWinnerTrend〉は当該回自身と基準日以降の回を除く)を
   * 通った分析であることの印。app 側の分析パイプラインが**新規の分析で常に true を渡す**
   * (LLM未使用の分析でも true。遮断を通る経路で作られたことを示す)。
   * `historyCutoffDate`(戦績の絞り込み〈#39〉の印)とは別の独立した印で、v1.14.x で保存された
   * LLM使用の分析は戦績は絞られているがプロンプト側のリークを含みうるため、この列で区別する。
   * DBには true→1・false→0 で保存する。省略・null は「遮断の記録なし=是正前の呼び出し元/旧行」で
   * NULL として保存する(0 にしない。「是正前」と「明示的に未遮断」を区別する)。
   * 読み出しは `StoredAnalysis.promptLookaheadGuarded`(1→true・0→false・NULL→null)。
   */
  readonly promptLookaheadGuarded?: boolean | null;
  /**
   * 使用したLLMモデル名(Issue#10 分析データのエクスポート、例: "claude-sonnet-5-5")。
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
  /**
   * 馬連を配分に使うか(Issue #118・#24-D3b-3で追加)。DB列(`include_quinella`)はNULLを許す
   * ため、書き込み型としては非nullable(新規保存は常に値ありとして扱う。呼び出し側
   * `allocation-record.ts`の`settingsColumnsOf`が必ず値を渡す)。
   */
  readonly includeQuinella: boolean;
  /**
   * 馬単を配分に使うか(Issue #126・#24-E3cで追加)。DB列(`include_exacta`)はNULLを許す
   * ため、書き込み型としては非nullable(新規保存は常に値ありとして扱う。呼び出し側
   * `allocation-record.ts`の`settingsColumnsOf`が必ず値を渡す。`includeQuinella`と同型)。
   */
  readonly includeExacta: boolean;
  /**
   * 三連単を配分に使うか(Issue #140・#25-E3cで追加)。DB列(`include_trifecta`)はNULLを許す
   * ため、書き込み型としては非nullable(新規保存は常に値ありとして扱う。呼び出し側
   * `allocation-record.ts`の`settingsColumnsOf`が必ず値を渡す。`includeQuinella`/`includeExacta`と
   * 同型)。
   */
  readonly includeTrifecta: boolean;
  /**
   * 枠連を配分に使うか(Issue #151・#26-E3cで追加)。DB列(`include_bracket_quinella`)はNULLを許す
   * ため、書き込み型としては非nullable(新規保存は常に値ありとして扱う。呼び出し側
   * `allocation-record.ts`の`settingsColumnsOf`が必ず値を渡す。`includeQuinella`/`includeExacta`/
   * `includeTrifecta`と同型)。
   */
  readonly includeBracketQuinella: boolean;
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
 * メタ行24列(主キー`analysis_id`を含む物理列数。AC2テスト等で使う数え方と同じ。
 * Issue #118〈#24-D3b-3〉でinclude_quinella列を追加し20→21列、Issue #126〈#24-E3c〉で
 * include_exacta列を追加し21→22列、Issue #140〈#25-E3c〉でinclude_trifecta列を追加し
 * 22→23列、Issue #151〈#26-E3c〉でinclude_bracket_quinella列を追加し23→24列)のうち、
 * boss裁定(2026-09-02)により以下の17列だけを読む(include_quinellaはIssue #118で、
 * include_exactaはIssue #126で、include_trifectaはIssue #140で、include_bracket_quinellaは
 * Issue #151で、それぞれ読む列に追加した)。
 * 残り7列のうち`analysis_id`は返り値のデータ列ではなく引数(検索キー)そのものであり、
 * 列挙の対象外とする。したがって実質的に「読まない列」として列挙するのは
 * 次の6列〈combo_odds_wide/combo_odds_trio/greedy_steps/candidate_cap/model_id/
 * model_approximate〉(利用者に意味の無い内部パラメータ、または表示予定が無いため意図的に
 * 読まない。#71の原則「誰も読まない列にコストを払わない」を踏襲する。AC2の対象もこの6列。
 * Issue #126・#140・#151で列が増えても読まない6列自体は変わらない):
 * route/unavailable_reason/fallback_reason/skip_reason_code/bankroll/per_race_cap/
 * kelly_fraction/ev_threshold/include_combo_odds/include_wide/include_trio/
 * include_quinella/include_exacta/include_trifecta/include_bracket_quinella/bet_unit/odds_status。
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
  /**
   * 馬連を配分に使うか(Issue #118・#24-D3b-3で追加)。列追加前(Issue #118より前)に保存された
   * 記録は null(「記録なし」。#31: OFFと断定しない。読み出し側の表示は「馬連: 記録なし」)。
   */
  readonly includeQuinella: boolean | null;
  /**
   * 馬単を配分に使うか(Issue #126・#24-E3cで追加)。列追加前(Issue #126より前)に保存された
   * 記録は null(「記録なし」。#31: OFFと断定しない。読み出し側の表示は「馬単: 記録なし」。
   * `includeQuinella`と同型)。
   */
  readonly includeExacta: boolean | null;
  /**
   * 三連単を配分に使うか(Issue #140・#25-E3cで追加)。列追加前(Issue #140より前)に保存された
   * 記録は null(「記録なし」。#31: OFFと断定しない。読み出し側の表示は「三連単: 記録なし」。
   * `includeQuinella`/`includeExacta`と同型)。
   */
  readonly includeTrifecta: boolean | null;
  /**
   * 枠連を配分に使うか(Issue #151・#26-E3cで追加)。列追加前(Issue #151より前=v1.13.0まで)に
   * 保存された記録は null(「記録なし」。#31: OFFと断定しない。買い目に枠連が入っている
   * 記録〈v1.13.0以降に保存されたもの〉でもONと推定しない。読み出し側の表示は「枠連: 記録なし」。
   * `includeQuinella`/`includeExacta`/`includeTrifecta`と同型)。
   */
  readonly includeBracketQuinella: boolean | null;
  /** 賭け金の最小単位(円)。coreの配分計算に到達していない経路(unset/yoso/unavailable)は null。 */
  readonly betUnit: number | null;
  /** オッズ発売状態(発売前/中間/確定)。app 側 OddsStatus の値をそのまま受け取る。 */
  readonly oddsStatus: string;
  /** stake>0 の明細のみ(#59 決定(a)を引き継ぐ)。 */
  readonly bets: readonly StoredAllocationBetDetail[];
}

/**
 * `getAllocationForVerify` が返す配分提案の最小表現(Issue #71・#54-B)。
 * メタ行24列(Issue #118でinclude_quinella列を追加し20→21列、Issue #126でinclude_exacta列を
 * 追加し21→22列、Issue #140でinclude_trifecta列を追加し22→23列、Issue #151で
 * include_bracket_quinella列を追加し23→24列)のうち
 * `route`/`skip_reason_code` の2列だけを持つ(残り22列は#71のスコープ外。
 * `getAllocationForVerify`自体はIssue #118・#126・#140・#151のいずれでも変更していない〈SELECT文が
 * route/skip_reason_codeしか読まないため無関係〉。下記`getAllocationForVerify` のJSDoc参照)。
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
  /**
   * 強調材料(Issue #197)。NULL・壊れた値・旧レコード(列追加前の保存)は `[]`(必須。空配列が「項目なし」)。
   */
  readonly highlights: readonly string[];
  /** 懸念事項(Issue #197。仕様は highlights と同じ)。 */
  readonly concerns: readonly string[];
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
  /**
   * 戦績を絞るのに使った基準日(YYYYMMDD。Issue #39 / #152)。旧レコード(列追加前の保存)・
   * 是正前の呼び出し元は null(遮断の記録なし)。`kaisaiDate` とは別物(開催日ではなく、遮断に
   * 実際に使った基準日)。
   */
  readonly historyCutoffDate: string | null;
  /**
   * LLMプロンプト側の先読みリーク遮断(Issue #153)を通った分析か(Issue #152)。DBの 1 は true、
   * 0 は false(明示的に未遮断)。NULL(列追加前の保存・是正前の呼び出し元)は null のまま返し、
   * false にしない(「記録なし」と「明示的に未遮断」を区別する)。
   */
  readonly promptLookaheadGuarded: boolean | null;
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
   * 単勝の確定払戻(100円あたりの円、Issue #100・#23-C)。placePayoutと同型・同じ由来
   * (`parsePayoutRow`の出力)。1着以外の馬・未取込(旧データ)は null。省略時もnull扱い
   * (placePayoutと同じ非破壊optional追加)。1着同着の場合は該当する複数馬がそれぞれ
   * 自分の払戻額を持つ(`parsePayoutRow`は件数を固定しない)。
   */
  readonly winPayout?: number | null;
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
  /** 馬単の確定払戻(Issue #106・#24-B)。umabansは着順順(1着→2着)。ソートしない。 */
  readonly exacta?: RaceComboPayoutResult;
  /**
   * 馬連の確定払戻(Issue #113・#24-D2)。ワイド・3連複と同じ順不同の組。
   *
   * **この追加自体は当初(#113時点)、取込の配線ではなく型を壊さないための最小追加だった**
   * (着手前ゲートで発見): `saveResult`内のループは`COMBO_BET_TYPES`(`Object.keys(COMBO_SIZE)`
   * 由来)を走査して`combo?.[betType]`を読むため、`ComboBetType`に`quinella`が追加されると、
   * このフィールドが無いままでは`combo?.[betType]`が`ComboBetType`の全メンバーを添字に
   * 取れず`pnpm typecheck`がTS7053で落ちる(#106でexactaを追加した際も同型の理由で
   * 追加されている)。#113時点では`result-import.ts`が`{wide, trio}`のみを渡していたため、
   * このフィールドを追加しても馬連の払戻行は実際には書かれなかった。
   *
   * ★**Issue #114・#24-F1で`result-import.ts`が`quinella: result.quinellaPayouts`も渡すように
   * なり、上記は過去の状態になった。現在は馬連の払戻行が実際に書かれる**
   * (`analysis-store.test.ts`「馬連の払戻」AC-6のJSDoc・`result-import.test.ts`
   * 「組合せ払戻(馬連、Issue #114・#24-F1)の素通し」describe参照)。
   */
  readonly quinella?: RaceComboPayoutResult;
  /**
   * 三連単の確定払戻(Issue #130・#25-D)。umabansは着順順(1着→2着→3着)。ソートしない。
   *
   * **本追加も#106・#113と同型の理由(型を壊さないための最小追加)**: `saveResult`内の
   * ループは`COMBO_BET_TYPES`(`Object.keys(COMBO_SIZE)`由来)を走査して`combo?.[betType]`を
   * 読むため、`ComboBetType`に`trifecta`が追加されると、このフィールドが無いままでは
   * `combo?.[betType]`が`ComboBetType`の全メンバーを添字に取れず`pnpm typecheck`がTS7053で
   * 落ちる。**払戻の取込の配線(`result-import.ts`が`trifecta: result.trifectaPayouts`を
   * 渡すようにすること)は#131のスコープであり、本Issue(#130)の時点ではこのフィールドを
   * 追加しても三連単の払戻行は実際には書かれない**(`combo?.trifecta`が常に`undefined`のため
   * `saveResult`の該当反復はcontinueするだけで、DBへの書き込み・削除は発生しない。
   * `analysis-store.test.ts`「三連単の払戻」AC-6相当のテストで直接固定済み)。
   */
  readonly trifecta?: RaceComboPayoutResult;
  /**
   * 枠連の確定払戻(Issue #143・#26-D)。umabansは**馬番ではなく枠番**(順不同・昇順に正規化。
   * 同枠〈[1,1]→"0101"〉あり)。
   *
   * **本追加も#106・#113・#130と同型の理由(型を壊さないための最小追加)**: `saveResult`内の
   * ループは`COMBO_BET_TYPES`(`Object.keys(COMBO_SIZE)`由来)を走査して`combo?.[betType]`を
   * 読むため、`ComboBetType`に`bracketQuinella`が追加されると、このフィールドが無いままでは
   * `pnpm typecheck`がTS7053で落ちる。#143の時点では、このフィールドを追加しても枠連の
   * 払戻行は実際には書かれなかった(`combo?.bracketQuinella`が常に`undefined`のため
   * 該当反復は`continue`するだけ。`analysis-store.test.ts`「枠連の払戻」で直接固定済み)。
   *
   * ★**Issue #145・#26-Fで`parseRaceResult`が`tr.Wakuren`を解析し(`bracketQuinellaPayouts`)、
   * `result-import.ts`が`bracketQuinella: result.bracketQuinellaPayouts`を渡すようになり、
   * 上記は過去の状態になった。現在は枠連の払戻行が実際に書かれる**
   * (`result-import.test.ts`「組合せ払戻(枠連、Issue #145・#26-F)の取込」参照)。
   */
  readonly bracketQuinella?: RaceComboPayoutResult;
}

/** `race_combo_payouts` の1行(読み出し専用の軽量表現。Issue #52・boss裁定R-6)。 */
export interface StoredComboPayout {
  /**
   * `buildComboOddsKeyFor(betType, umabans)` で得られる正規化キー(例: ワイド"0102"、
   * 馬単"1308")。復号(umabans配列への復元)は本Issueのスコープ外(不明点4。#54が表示で
   * 必要になった時点で追加する)。呼び出し側は `buildComboOddsKeyFor` で購入候補側を
   * 同じキーへ正規化して比較すればよい。
   *
   * **AC10改訂(Issue #106・#24-B裁定)**: 当初(Issue #52時点)は「着順が意味を持つ券種
   * (馬単・三連単)には`buildComboOddsKey`のキー生成規則を流用してはならず、列/テーブル
   * 自体を分離する必要がある」としていたが、これは過剰に強い主張だった。`combo_key`列は
   * ただの`TEXT`で、主キーが`(race_id, bet_type, combo_key)`であるため、**順序付きキー
   * (馬単。着順を保持したまま連結する。ソートしない)をそのまま同じ列・同じテーブルに
   * 保持できる**(列/テーブル分離は不要)。実際に必要だったのは「betTypeごとに
   * ソートするか否かを切り替えるキー生成関数」(`buildComboOddsKeyFor`。
   * `combo-odds-key.ts`の`COMBO_KEY_ORDER`参照)だけだった。
   * `buildComboOddsKey`(常にソート)を券種を見ずに直接使うことは引き続き禁止する
   * (例: 馬単「1着1・2着2」と「1着2・2着1」は別の買い目だが、`buildComboOddsKey([1,2])`
   * はどちらも同じ"0102"に潰してしまい区別できなくなる。実際に発生していた欠陥。
   * `analysis-store.test.ts`「馬単の払戻(順序付きキー」describe参照)。
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
