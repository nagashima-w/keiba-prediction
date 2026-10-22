/**
 * 分析パイプラインの結果・進捗・レース一覧の共有型。
 *
 * クラウド版のサーバ(`cloud/src/pipeline.ts` など)・ブラウザ向けの束(`cloud/client/api-analysis.ts` が `import type` で参照する)と、
 * core の純関数(`analysis/`・`view/`)が参照する。ブラウザ向けの束の閉包に core のバレル(`index.ts`)やネイティブ依存を引き込まないよう、
 * **このファイルが import するのは、それ自身が import を持たない `common/prediction-marks.ts` の型 1 つだけ**(Issue #445。`import type` なので実行時には何も引き込まない。閉包の検査は `cloud/test/client-bundle.test.ts` の許可リストと `cloud/test/import-guard.test.ts`)。
 * core の型と同じ形の型は import せず複製している。構造の一致を型検査で固定しているのは一部の型だけで、`StoredAllocation`(`bets` の `StoredAllocationBetDetail` を含む)・`ComboOddsFetchOutcome`・
 * `ComboOddsScrapeOutcome` の 3 組(`packages/core/test/analysis/analysis-types-*-pin.test.ts`)と、`ImportResultOutcome`(`packages/core/test/ev/result-import-flow.test.ts`)である。ほかの複製は固定していない。
 * すべて JSON でシリアライズ可能なプレーンオブジェクト(ブランド型・関数を含まない)であることを不変条件とする。
 *
 * 旧 exe では main・preload・renderer が IPC で受け渡す型でもあった(exe は #287 で削除。最後に残っているコミットは 3c1664e)。
 * そのため、以下の JSDoc の「IPC越し」「main→renderer」は旧 exe での用途の説明で、exe 専用の型は exe の削除後も残っている。
 */

import type { PredictionMark } from "../common/prediction-marks.js";

/** 分析パイプラインの進捗段階(仕様「5. ui」の進捗表示要件)。 */
export type ProgressStage = "スクレイピング" | "スコアリング" | "LLM分析" | "保存";

/**
 * レースの開催区分(中央/地方)。core RaceIdVenueKind のプレーン写し(旧 exe では IPC越しの共有用)。
 * UI表記は「中央」「地方」とし、"NAR" という略語は画面に出さない(コード内は central/nar のまま)。
 */
export type RaceVenueKind = "central" | "nar";

/**
 * 検証レポートの母集団を開催区分で絞り込むフィルタ(core VerifyVenueFilter のプレーン写し。Task#32)。
 * "all" は絞り込みなし(既定・従来どおりの全体集計)。"central"/"nar" は RaceVenueKind と同じ意味。
 */
export type VerifyVenueFilter = "all" | RaceVenueKind;



/**
 * 予想印。◎本命/〇対抗/▲単穴/△連下/☆穴(勝ち目)/注 穴(3着)。印なし・LLM未使用時は null。
 * 定義は `common/prediction-marks.ts`(import を持たない純モジュール)の 1 か所だけで、ここは再エクスポート(Issue #445。以前は文字列リテラルのユニオンで二重に持っていた)。
 */
export type { PredictionMark };

/**
 * オッズの発売状態(core OddsSnapshot.oddsStatus のプレーン写し)。
 * - "result": 確定オッズ。
 * - "middle": 発売中の暫定オッズ。
 * - "yoso":   前売り前の予想オッズ(複勝未発売のためEV計算不可)。
 */
export type OddsStatus = "result" | "middle" | "yoso";

/**
 * 条件替わり(妙味材料)タグの種別(core ConditionChangeTagKind のプレーン写し)。
 * サーフェス替わり/距離延長・短縮/中央⇄地方替わりの3種。表示順(サーフェス→距離→開催)と対応する。
 */
export type ConditionChangeTagKind = "surface" | "distance" | "venue";

/**
 * 条件替わり(妙味材料)タグ1件(表示用。core ConditionChangeTag のプレーン写し)。
 * 例: {kind:"surface", label:"ダ替わり(前走芝)"}。
 */
export interface ConditionChangeTagView {
  /** タグ種別。 */
  readonly kind: ConditionChangeTagKind;
  /** 表示テキスト。 */
  readonly label: string;
}

/**
 * 組合せオッズ取得試行がunavailableだった理由(中央。core `ComboOddsUnavailableReason` の
 * プレーン写し。機能D-2c第1段・Issue #28)。
 */
export interface ComboOddsUnavailableReasonView {
  /** 応答の `status` 値(文字列として読めなかった場合は null)。 */
  readonly rawStatus: string | null;
  /** 応答ルートの `reason` フィールド(存在しない・文字列でない場合は null)。 */
  readonly rawReason: string | null;
  /** 構造のどの段が欠落/不正だったか。組合せが0件だった場合は null。 */
  readonly missingKey: string | null;
}

/**
 * 組合せオッズ取得試行がunavailableだった理由(地方。core `NarComboOddsUnavailableReason` の
 * プレーン写し。機能D-2c第1段・Issue #28)。
 */
export interface NarComboOddsUnavailableReasonView {
  /** `#odds_select`(投票カート件数)が見つかったか。 */
  readonly cartCountFound: boolean;
  /** `#odds_view_form`(本文ラッパー)が見つかったか。 */
  readonly viewFormWrapperFound: boolean;
  /** `td.Odds`の生の総数。 */
  readonly oddsCellCount: number;
}

/**
 * 組合せオッズ取得の1試行分の結末(core `ComboOddsFetchAttempt` のプレーン写し。
 * 機能D-2c第1段・Issue #28)。中央・地方ワイドは1件、地方3連複は軸数件。
 */
export type ComboOddsFetchAttemptView =
  | { readonly axis: number | null; readonly state: "available"; readonly comboCount: number }
  | {
      readonly axis: number | null;
      readonly state: "unavailable";
      readonly reason: ComboOddsUnavailableReasonView | NarComboOddsUnavailableReasonView;
    }
  | { readonly axis: number | null; readonly state: "fetchFailed"; readonly message: string }
  | { readonly axis: number | null; readonly state: "parseError"; readonly message: string };

/** 組合せオッズ1件分のセル(core `ComboOddsCell` のプレーン写し。機能D-2c第1段・Issue #28)。 */
export interface ComboOddsCellView {
  /** ワイド: オッズ下限。3連複: オッズ(単一値)。未確定・非数値は null。 */
  readonly oddsMin: number | null;
  /** ワイド: オッズ上限。3連複: 常に null。 */
  readonly oddsMax: number | null;
  /** 人気。取得できない場合は null。 */
  readonly ninki: number | null;
}

/**
 * 軸間の同一キー衝突1件分のエントリ(core `ComboOddsCellConflictEntry` のプレーン写し。
 * 機能D-2c第1段・Issue #28)。
 */
export interface ComboOddsCellConflictEntryView {
  /** 軸馬番。 */
  readonly axis: number;
  /**
   * その軸のセル(衝突に関与した全軸のセルを軸昇順で保持する。マージ後に採用されたセルを
   * 含む。必ずしも非採用側とは限らない。core `ComboOddsCellConflictEntry` のJSDoc・
   * `mergeAxisComboOddsMaps`〈combo-odds-key.ts〉参照。code-reviewer指摘・要修正2対応:
   * 「採用されなかった側のセル」という誤った限定を取り除いた)。
   */
  readonly cell: ComboOddsCellView;
}

/**
 * 軸間の同一キー衝突(core `ComboOddsCellConflict` のプレーン写し。機能D-2c第1段・Issue #28)。
 * 地方3連複の軸走査でのみ発生しうる(中央・地方ワイドは軸走査が無いため常に空配列)。
 */
export interface ComboOddsCellConflictView {
  /** 衝突したキー(例 "010203")。 */
  readonly key: string;
  /**
   * 衝突種別。"numeric" は数値同士の食い違い、"nullWin" は片方以上がnullで
   * null側が採用された衝突(core `ComboOddsCellConflictKind` のプレーン写し)。
   */
  readonly kind: "numeric" | "nullWin";
  /** 衝突に関与した全軸のセル(軸番号昇順)。 */
  readonly entries: readonly ComboOddsCellConflictEntryView[];
}

/**
 * 組合せオッズ取得の診断値(core `ComboOddsFetchDiagnostics` のプレーン写し。
 * 機能D-2c第1段・Issue #28)。
 */
export interface ComboOddsFetchDiagnosticsView {
  /**
   * 券種("wide" | "trio" | "exacta" | "quinella" | "trifecta" | "bracketQuinella")。core
   * `ComboBetType` に馬単(exacta)・馬連(quinella)・三連単(trifecta)・枠連(bracketQuinella)が
   * 追加されたことに伴うプレーン写し(Issue #106・#24-B、馬連はIssue #113・#24-D2、三連単は
   * Issue #130・#25-D、枠連はIssue #143・#26-D)。
   * `ComboOddsScrapeOutcomeView`自体は`wide?`/`trio?`/`quinella?`/`exacta?`/`trifecta?`/
   * `bracketQuinella?`を持つ(馬連はIssue #116・#24-D3b-1、馬単はIssue #122・#24-E2、三連単は
   * Issue #137・#25-E2、枠連はIssue #148・#26-E2でscrape-race.tsに配線した時点でそれぞれ追加)。
   * `ComboOddsFetchDiagnostics.betType`はcore側で`ComboBetType`型をそのまま参照する
   * 共有フィールドのため、この型だけはcore型と完全一致させる必要がある
   * (analysis-types-combo-odds-pin.test.tsが検知する)。
   */
  readonly betType: "wide" | "trio" | "exacta" | "quinella" | "trifecta" | "bracketQuinella";
  /** 発行したHTTPリクエスト数。 */
  readonly requestCount: number;
  /** 出走馬番から導出した期待組合せ数。 */
  readonly expectedComboCount: number;
  /** マージ後に実際に得られた組合せ数。 */
  readonly obtainedComboCount: number;
  /** expectedComboCount - obtainedComboCount(0未満にはならない)。 */
  readonly missingComboCount: number;
  /** 地方3連複の軸馬番配列(昇順)。中央・地方ワイドは空配列。 */
  readonly axisUmabans: readonly number[];
  /** 取得試行ごとの結末。 */
  readonly attempts: readonly ComboOddsFetchAttemptView[];
  /** 軸間の数値衝突件数。 */
  readonly numericConflictCount: number;
  /** 軸間のnull採用衝突件数。 */
  readonly nullWinConflictCount: number;
  /** 衝突サンプル(上限件数で打ち切り。正確な件数は上記2フィールド)。 */
  readonly conflictSamples: readonly ComboOddsCellConflictView[];
}

/**
 * 組合せオッズ1券種分の取得結果(core `ComboOddsFetchOutcome` のプレーン写し。
 * 機能D-2c第1段・Issue #28)。
 */
export interface ComboOddsFetchOutcomeView {
  /** 券種の最終状態("available" | "unavailable" | "failed")。 */
  readonly state: "available" | "unavailable" | "failed";
  /** 診断値(リクエスト数・期待/実取得組合せ数・軸ごとの結末・衝突件数等)。 */
  readonly diagnostics: ComboOddsFetchDiagnosticsView;
}

/**
 * 組合せオッズ(ワイド・3連複・馬連・馬単・三連単・枠連)取得結果のペア(core
 * `ComboOddsScrapeOutcome` のプレーン写し。機能D-2c第1段・Issue #28。馬連はIssue #116・
 * #24-D3b-1、馬単はIssue #122・#24-E2、三連単はIssue #137・#25-E2、枠連はIssue #148・#26-E2で
 * 追加)。core
 * `RaceDataMeta.comboOdds` と同じく、`options.includeComboOdds`がtrueのときのみ設定される。
 */
export interface ComboOddsScrapeOutcomeView {
  readonly wide?: ComboOddsFetchOutcomeView;
  readonly trio?: ComboOddsFetchOutcomeView;
  readonly quinella?: ComboOddsFetchOutcomeView;
  readonly exacta?: ComboOddsFetchOutcomeView;
  /**
   * 三連単の取得結果(Issue #137・#25-E2)。中央・地方とも`options.includeComboOdds`がtrueのとき
   * 設定される(地方は軸ごとの全軸取得。Issue #283・ユーザー判断2026-10-13。旧: 地方は取得しない)。
   * `AnalysisResult.trifectaCombo`のJSDoc参照。
   */
  readonly trifecta?: ComboOddsFetchOutcomeView;
  /**
   * 枠連の取得結果(Issue #148・#26-E2)。三連単と異なり**中央・地方とも**`includeComboOdds`が
   * trueのとき設定される(`AnalysisResult.bracketQuinellaCombo`のJSDoc参照)。
   */
  readonly bracketQuinella?: ComboOddsFetchOutcomeView;
}

/** 進捗イベント(旧 exe では main→renderer に webContents.send で通知した。クラウド版では `cloud/src/pipeline.ts` がこの型を使う)。 */
export interface AnalysisProgress {
  /** 現在の段階。 */
  readonly stage: ProgressStage;
  /** 段階内の進捗(n頭目)。頭数が定まらない段階では null。 */
  readonly current: number | null;
  /** 段階内の総数(N頭)。定まらない段階では null。 */
  readonly total: number | null;
  /** 画面表示用のメッセージ。 */
  readonly message: string;
}

/** 結果テーブルの1行(馬単位)。 */
export interface AnalysisRow {
  /** 馬番。 */
  readonly umaban: number;
  /** 枠番。 */
  readonly wakuban: number;
  /** 馬名。 */
  readonly horseName: string;
  /** scorer の prior(事前複勝確率)。 */
  readonly prior: number;
  /** 補正後複勝確率(LLM未使用時は prior と同値)。 */
  readonly adjustedProb: number;
  /** 使用した複勝オッズ下限。欠損なら null。 */
  readonly placeOddsMin: number | null;
  /**
   * 単勝オッズ(Issue #90・#23-B2)。`placeOddsMin`と同じ流儀で、値域外(0・1.0未満・非有限)
   * でも生値をそのまま保持しnullに潰さない(値域判定は消費側`isUsableOdds`の責務)。
   * オッズ未発売(`oddsStatus="yoso"`)でも予想オッズ値が入ることがある
   * (`analysis-pipeline.ts`のwinOdds解決ヘルパ参照)。欠損時はnull。
   */
  readonly winOdds: number | null;
  /**
   * 期待値(補正後確率 × 複勝下限)。オッズ欠損なら null。
   * TODO(将来改善): EV=null の行に対し、core HorseEv.excludedReason(「複勝オッズに該当馬番が無い」等)を
   * 行レベルでUI表示する。現状は null を一律「-」表示にしており、対象外の理由までは画面に出していない。
   */
  readonly ev: number | null;
  /** EVが閾値を上回るか(ハイライト対象)。 */
  readonly isPositive: boolean;
  /** LLMの補正根拠。LLM未使用・prior採用なら null(表示は「-」)。 */
  readonly reason: string | null;
  /**
   * LLM が挙げた強調材料(Issue #197。各最大3項目の短い句)。LLM 未使用・prior 採用・項目なしは `[]`。
   * 表示は #199(exe の表示とエクスポート)で行う。
   */
  readonly highlights: readonly string[];
  /** LLM が挙げた懸念事項(Issue #197。仕様は highlights と同じ)。 */
  readonly concerns: readonly string[];
  /**
   * この馬のキャリア走数(戦績 results.length)。0 は新馬相当(=判明した低データ)。
   * 戦績が取得できなかった(不明な)馬は null とし、低データ判定の集計から除外する
   * (取得失敗を新馬と混同しないため。スクレイピング警告は result.warnings に別途載る)。
   * レース妙味スコア(computeRaceOpportunity)の低データ判定に用いる。
   */
  readonly careerRunCount: number | null;
  /** 予想印(◎〇▲△☆注のいずれか。印なし・LLM未使用時は null)。Task#23。 */
  readonly mark: PredictionMark | null;
  /**
   * このEV(ev/placeOddsMin)が推定値(発売前・単勝オッズからの複勝下限概算)によるものか(Task#25)。
   * true のときは確定EVより誤差が大きい(±20〜30%程度)概算であり、UIで「(推定)」等の
   * 表記により確定EVと明確に区別する。レース単位(oddsStatus=yoso)で一律に決まるため、
   * 同一レース内の全行で同じ値になる。
   */
  readonly evEstimated: boolean;
  /**
   * 条件替わり(妙味材料)タグ(サーフェス→距離→開催の固定順)。該当なしは空配列。
   * core computeConditionChangeTags(analyzer/condition-change.ts)の算出結果をそのまま写す。
   * DBには保存しない(ライブ分析結果からのみ導出する派生表示データ)。
   */
  readonly conditionChangeTags: readonly ConditionChangeTagView[];
}

/** 1レース分の分析結果。 */
export interface AnalysisResult {
  /** レースID(12桁)。 */
  readonly raceId: string;
  /** 会場名(レースIDの場コードから導出)。 */
  readonly venueName: string;
  /** レース名。 */
  readonly raceName: string;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: string;
  /** 距離(m)。 */
  readonly distance: number;
  /** 開催日(YYYY/MM/DD)。分析に渡された開催日(`kaisaiDate`)そのもので、実行日による近似はしない(Issue #400 R-10b)。 */
  readonly date: string;
  /** LLM分析を実行したか(false ならAPIキー未設定などでスキップし prior を採用)。 */
  readonly llmUsed: boolean;
  /** LLMをスキップした理由(実行時は null)。 */
  readonly llmSkippedReason: string | null;
  /** LLM分析がフェイルセーフで prior にフォールバックしたか。 */
  readonly fallback: boolean;
  /**
   * フォールバックの理由(通常時・fallback:falseの場合は必ず null。不変条件)。
   * 秘密安全性のため、生のLLM例外メッセージ等は含まない固定分類文言のみが入る
   * (core analyzeRace の FALLBACK_REASON_TRUNCATED / FALLBACK_REASON_PARSE_ERROR /
   * FALLBACK_REASON_INVOCATION_ERROR のいずれか。論点C: 2026-07-19合意)。
   * DB(AnalysisRecord)には保存しない(live 専用。論点D)。
   * UI では、旧 exe の BatchAnalysisView(#287 で削除。3c1664e まで)が「LLM補正:」行のtooltip(title)に表示した。クラウド版の画面は、LLM が効かなかった理由の固定文言 `llmNote`(`cloud/client/result.ts`)を出す。
   */
  readonly fallbackReason: string | null;
  /**
   * 分析に使ったLLMモデルID(Issue #157。保存レコードの `analyses.model` と同じ値)。
   * analyzeRace が応答を得たモデル(自動選択の結果。固定モデルへ切り替わればそちら)を優先し、
   * 得られなければ静的な既定モデル名。LLMスキップ時は null。
   * optional なのは既存の AnalysisResult リテラルを使うテスト・旧データを無改変で通すため
   * (runAnalysis 自身は必ず string/null のいずれかを明示的に返す)。
   * 分析結果の画面に「分析モデル: …」として出す(view/format.ts の analysisModelText)。
   */
  readonly model?: string | null;
  /**
   * オッズの発売状態(確定/発売中/予想)。
   * "yoso" は複勝未発売のため全馬のEVが null になる(UIで注記表示)。
   */
  readonly oddsStatus: OddsStatus;
  /** 結果行(馬番昇順)。 */
  readonly rows: readonly AnalysisRow[];
  /** スクレイピング時の非致命的警告(戦績・調教の取得失敗など)。 */
  readonly warnings: readonly string[];
  /** 分析日時(ISO8601)。 */
  readonly analyzedAt: string;
  /**
   * ワイドオッズ(馬番の組の正規化キー〈例"0102"〉→オッズ下限。core
   * `OddsSnapshot.wideCombo` のプレーン写し。機能D-2c第1段・Issue #28)。
   *
   * **状態(キー有無・空/値の別)と原因は1対1に対応しない(boss差し戻し2026-08-11で訂正。
   * 修正前の記述は「判定不能」を「判定結果」に誤ラベルする、本リポジトリで繰り返している
   * 欠陥クラスそのものだった)**:
   * - このキー自体が無い(undefined): 「取得結果を持たない」ことは確かだが、原因は1つに
   *   絞れない。(a) `scrapeRace`の`includeComboOdds`が未指定・false(そもそも取得を
   *   試みていない。第1段は常にこの状態)、または (b) `includeComboOdds:true`でも
   *   ワイドの取得処理(`fetchComboBetTypeOdds`)が想定外の例外を投げ`scrape-race.ts`側で
   *   catchされた場合、のいずれもこの状態になる。**後者では`comboOdds`(下記)自体は
   *   〈3連複側の結果を伴って〉設定されうる。`wideCombo`のundefinedと`comboOdds`の
   *   undefinedは独立した別々の事象**であり、どちらか一方から他方を推測してはならない。
   * - 空オブジェクト(`{}`): 「1件も取得できなかった」ことは確かだが、これも原因は
   *   1つに絞れない。(a) `state==="unavailable"`(市場が首尾一貫して未発売/発売なし。
   *   状態②③)、(b) `state==="failed"`(全軸・全試行がHTTP失敗や構造異常で取得できず、
   *   ②③〈発売なし〉とは断定できない。状態④)、のいずれでも`{}`になり、値だけでは
   *   区別できない。
   * - 値を持つオブジェクト: `state==="available"`(1件以上取得できた。部分被覆を含む)。
   *
   * **原因を正しく判別する唯一の手段は `comboOdds.wide.state`**
   * (`"available" | "unavailable" | "failed"`。値・キー有無だけを見て「発売なし」等と
   * 断定しないこと)。core `comboOddsWarningMessage`(`scrape-race.ts`)が
   * 「発売なし/未発売〈状態②③〉とは異なる」とわざわざ明記して混同を防いでいるのと同じ
   * 区別であり、この`wideCombo`単体の値からは再現できない。
   *
   * **`Record`である理由(`ReadonlyMap`を載せない)**: `AnalysisResult`は(旧 exe ではIPC〈`webContents.send`/
   * `ipcMain.handle`の戻り値〉を、クラウド版ではJSON)を経由してシリアライズされる。`Map`をここに載せると`JSON.stringify`/IPC経由で
   * 静かに`{}`になる種を植える(#33 `OddsSnapshot.wideCombo`と同じ理由)。
   */
  readonly wideCombo?: Record<string, number | null>;
  /**
   * 3連複オッズ(馬番の組の正規化キー〈例"010203"〉→オッズ。単一値。core
   * `OddsSnapshot.trioCombo` のプレーン写し)。状態と原因が1対1に対応しないこと・
   * `Record`である理由は `wideCombo` と同じ(原因の判別は`comboOdds.trio.state`を見ること)。
   */
  readonly trioCombo?: Record<string, number | null>;
  /**
   * 馬連オッズ(馬番の組の正規化キー〈例"0102"〉→オッズ。単一値。core
   * `OddsSnapshot.quinellaCombo` のプレーン写し。Issue #116・#24-D3b-1)。
   * `Record`である理由・状態と原因が1対1に対応しないことは`wideCombo`と同じ
   * (原因の判別は`comboOdds.quinella.state`を見ること)。
   *
   * **配分・画面への配線はまだ無い**(このフィールドを保持・伝播するだけ。#24-D3b-1〈#116〉の
   * スコープ。配分の券種選択〈`resolveMixedBetTypes`〉に組み込むのは#117)。
   */
  readonly quinellaCombo?: Record<string, number | null>;
  /**
   * 馬単オッズ(馬番の組の正規化キー〈`buildOrderedComboOddsKey`形式。例"0102"。1着・2着の
   * 順序が意味を持つ。"0102"と"0201"は別の値〉→オッズ。単一値。core
   * `OddsSnapshot.exactaCombo` のプレーン写し。Issue #122・#24-E2)。`Record`である理由・
   * 状態と原因が1対1に対応しないことは`wideCombo`と同じ(原因の判別は
   * `comboOdds.exacta.state`を見ること)。
   *
   * **配分・画面への配線はまだ無い**(このフィールドを保持・伝播するだけ。#24-E2〈#122〉の
   * スコープ。配分の券種選択〈`resolveMixedBetTypes`〉への接続は#123)。
   */
  readonly exactaCombo?: Record<string, number | null>;
  /**
   * 三連単オッズ(馬番の組の正規化キー〈`buildOrderedComboOddsKey`形式。例"010203"〉→オッズ。
   * 1着・2着・3着の順序が意味を持つ(馬単`exactaCombo`と同じ性質)。単一値。core
   * `OddsSnapshot.trifectaCombo` のプレーン写し。Issue #137・#25-E2)。`Record`である理由・
   * 状態と原因が1対1に対応しないことは`wideCombo`と同じ(原因の判別は
   * `comboOdds.trifecta.state`を見ること)。
   *
   * **地方(NAR)も取得する**(Issue #283・ユーザー判断2026-10-13。軸=1着固定ごとに頭数ぶんのリクエスト。
   * 旧: ユーザー判断2026-09-27により地方の三連単は当面取得せず、`scrapeRace`が調教と同じ
   * `if (!isNar)`ガードで取得自体を試みなかった〈この間、地方では常に`undefined`〉)。
   *
   * 配分の券種選択(`resolveMixedBetTypes`)への接続はIssue #138(#25-E3a・
   * `includeTrifectaInAllocation`の配管)・Issue #139(#25-E3b・実際の接続)で完了した。
   */
  readonly trifectaCombo?: Record<string, number | null>;
  /**
   * 枠連オッズ(**枠番**の組の正規化キー〈2桁ゼロ埋め連結で枠は昇順・同枠可。例"0407"・"0101"〉→
   * オッズ。馬番ではなく枠番であり、順不同。単一値。core `OddsSnapshot.bracketQuinellaCombo` の
   * プレーン写し。Issue #148・#26-E2)。`Record`である理由・状態と原因が1対1に対応しないことは
   * `wideCombo`と同じ(原因の判別は`comboOdds.bracketQuinella.state`を見ること)。
   *
   * 三連単と異なり**中央・地方とも**取得する(9頭以上で発売。8頭以下は空Recordになる)。
   *
   * **#148の時点では、配分・画面への配線は無かった**(このフィールドを保持・伝播するだけだった)。
   * 配分の設定の配管は#149で完了し、Issue #150(#26-E3b)で配分に接続され(`resolveMixedBetTypes`)、
   * 画面(一括分析の配分内訳・検証画面・設定画面)にも表示されるようになった。
   */
  readonly bracketQuinellaCombo?: Record<string, number | null>;
  /**
   * 組合せオッズ(ワイド・3連複・馬連・馬単・三連単・枠連。三連単は Issue #283 から地方も取得する)の取得結果(core
   * `RaceDataMeta.comboOdds` のプレーン写し。機能D-2c第1段・Issue #28。馬連はIssue #116・
   * #24-D3b-1、馬単はIssue #122・#24-E2、三連単はIssue #137・#25-E2、枠連はIssue #148・#26-E2で
   * 追加)。このフィールド自身(外側の`comboOdds`オブジェクト)の有無は`wideCombo`/
   * `trioCombo`/`quinellaCombo`/`exactaCombo`/`trifectaCombo`/`bracketQuinellaCombo`とは異なり
   * `includeComboOdds`の指定と1対1で対応する(`scrapeRace`は`includeComboOdds:true`のとき、
   * いずれかの取得処理が例外で失敗しても`comboOdds`自体〈`wide`/`trio`/`quinella`/`exacta`/
   * `trifecta`/`bracketQuinella`がそれぞれoptionalなサブフィールド〉は必ず設定する)。
   *
   * **`comboOdds.trifecta`だけは例外的に、`includeComboOdds:true`でも地方(NAR)では常に
   * `undefined`になる**(ユーザー判断2026-09-27。`trifectaCombo`のJSDoc参照。三連単以外の
   * 5券種〈ワイド・3連複・馬連・馬単・枠連〉は中央・地方いずれも`includeComboOdds:true`なら
   * 必ず値が入る)。
   *
   * `wide`/`trio`/`quinella`/`exacta`/`trifecta`/`bracketQuinella`それぞれの`state`
   * (`"available" | "unavailable" | "failed"`)が、対応する`*Combo`が空(`{}`)になった原因
   * (発売なし/未発売なのか、取得失敗なのか)を判別する唯一の手段である(`wideCombo`のJSDoc参照)。
   */
  readonly comboOdds?: ComboOddsScrapeOutcomeView;
}




/** 検証画面: キャリブレーション帯(表示用。core CalibrationBin のプレーン写し)。 */
export interface CalibrationBinView {
  /** 帯の下限(含む)。 */
  readonly lowerBound: number;
  /** 帯の上限(含まない。最終帯のみ 1.0 を含む)。 */
  readonly upperBound: number;
  /** この帯の予測件数。 */
  readonly predictedCount: number;
  /** うち実際に複勝圏に入った件数。 */
  readonly placedCount: number;
  /** 実際の複勝率。予測0件なら null。 */
  readonly actualPlaceRate: number | null;
}

/**
 * 検証画面: 補正方向の分類(core AdjustmentDirection のプレーン写し。旧 exe では IPC越しの共有用)。
 * "raised"=上げ(adjustedProb>prior)/"lowered"=下げ/"unchanged"=据え置き。Task#26。
 */
export type AdjustmentDirection = "raised" | "lowered" | "unchanged";

/** 検証画面: 補正方向×結果の1群(表示用。core DirectionGroupStat のプレーン写し)。Task#26。 */
export interface DirectionGroupView {
  /** 補正方向の分類。 */
  readonly direction: AdjustmentDirection;
  /** この群に入った件数。 */
  readonly count: number;
  /** 実際の複勝率。件数0なら null。 */
  readonly actualPlaceRate: number | null;
  /** 平均補正幅(符号付き)。件数0なら null。 */
  readonly averageAdjustment: number | null;
}

/**
 * 検証画面: キャリブレーション帯の過信バイアス(表示用。core CalibrationBiasBin のプレーン写し)。
 * Task#26。
 */
export interface CalibrationBiasBinView {
  /** 帯の下限(含む)。 */
  readonly lowerBound: number;
  /** 帯の上限(含まない。最終帯のみ 1.0 を含む)。 */
  readonly upperBound: number;
  /** 代表予測値(帯の中央値)。 */
  readonly representativeProb: number;
  /** この帯の予測件数。 */
  readonly predictedCount: number;
  /** 実際の複勝率。予測0件なら null。 */
  readonly actualPlaceRate: number | null;
  /** 過信バイアス(代表予測値 − 実複勝率)。正なら過信、負なら過小評価。予測0件なら null。 */
  readonly overconfidenceGap: number | null;
}

/** 検証画面: 印別的中率の1群(表示用。core MarkStat のプレーン写し)。Task#26。 */
export interface MarkStatView {
  /** 予想印(◎〇▲△☆注のいずれか。印なしは null)。 */
  readonly mark: PredictionMark | null;
  /** この印が付いた件数。 */
  readonly count: number;
  /** 複勝率。件数0なら null。 */
  readonly placeRate: number | null;
  /** 勝率(finish=1)。件数0なら null。 */
  readonly winRate: number | null;
}

/** 検証画面: 補正傾向サマリ(表示用。core VerifyTrendReport のプレーン写し)。Task#26。 */
export interface VerifyTrendReportView {
  /** (1) 補正方向×結果。raised・lowered・unchanged の3群。 */
  readonly directionGroups: readonly DirectionGroupView[];
  /** (2) キャリブレーションの過信バイアス。 */
  readonly calibrationBias: readonly CalibrationBiasBinView[];
  /** (3) 印別的中率。 */
  readonly markStats: readonly MarkStatView[];
}

/** 検証画面: 回収率サマリ(表示用)。 */
export interface VerifyBetView {
  /** 購入点数(着順確定分のみ)。 */
  readonly betCount: number;
  /** 賭け金合計(円)。 */
  readonly totalStake: number;
  /** 払戻合計(円)。 */
  readonly totalReturn: number;
  /** 回収率。購入0点なら null。 */
  readonly recoveryRate: number | null;
  /** 実配当で払戻計上した点数。 */
  readonly actualPayoutCount: number;
  /** 近似(複勝下限)で払戻計上した点数。 */
  readonly approximatePayoutCount: number;
}

/**
 * 検証画面: proposedBet系の券種別・合算サマリ(表示用。Issue #71 #54-B)。
 * core `ProposedBetTypeSummary` のプレーン写し。既存 `VerifyBetView`(複勝一律・Q-B)とは
 * 賭け金の仮定が異なるため合算しない(型としても足し合わせる先を作らない。AC-B5)。
 */
export interface ProposedBetTypeSummaryView {
  /** 判定できた(的中・不的中を問わない)買い目の点数。 */
  readonly betCount: number;
  /** 賭け金合計(円。分析時点で実際に提案した配分額そのもの)。 */
  readonly totalStake: number;
  /** 払戻合計(円。実配当のみ)。 */
  readonly totalReturn: number;
  /** 回収率。totalStake===0ならnull。 */
  readonly recoveryRate: number | null;
  /** 規則Uにより判定不能とした買い目の点数(買い目行単位)。 */
  readonly unjudgedCount: number;
}

/**
 * 検証画面: 未知の券種コードの内訳(表示用。Issue #76。core `ProposedBetUnknownBetType` のプレーン写し)。
 * 規則U(判定不能)とは原因が異なるため`overall`には合算しない。未知券種行が1件も無い通常時は
 * `{ count: 0, totalStake: 0, betTypes: [] }`(このフィールド自体が省略されることはない)。
 */
export interface ProposedBetUnknownBetTypeView {
  /** 該当した買い目行の点数。 */
  readonly count: number;
  /** 該当行のstake合計(円)。どの券種のtotalStakeにも含まれない。 */
  readonly totalStake: number;
  /** 実際に現れた券種コード(昇順・重複なし)。 */
  readonly betTypes: readonly string[];
}

/** 検証画面: proposedBet系の母集団4分類(表示用。Issue #71 #54-B)。 */
export interface ProposedBetPopulationView {
  /** 配分あり(賭け金>0)。 */
  readonly allocated: number;
  /** 見送り(計算した上で賭けない判定結果)。 */
  readonly skipped: number;
  /** 未到達(coreの配分計算に到達していない判定不能)。 */
  readonly unreached: number;
  /** 記録なし(#59より前の旧分析)。 */
  readonly noRecord: number;
}

/**
 * 検証画面: 配分ベースの回収率(表示用。Issue #71 #54-B。core `ProposedBetReport` のプレーン写し)。
 * `overall` は複勝・単勝・ワイド・3連複・馬連・馬単・三連単・枠連の8券種の合算(同一の賭け金仮定を
 * 共有するポートフォリオとしての合計。core側JSDoc参照)。単勝はIssue #100・#23-Cで、馬連は
 * Issue #114・#24-F1で、馬単はIssue #121・#24-F2で、三連単はIssue #131・#25-Fで、枠連は
 * Issue #145・#26-Fで追加。
 *
 * 「検証画面」は、現在はクラウド版(`cloud/client/verify-format.ts` の `PROPOSED_BET_LABELS` が8券種の内訳の並びを持つ)。
 * 旧 exe では `VerifyView.tsx`(#287 で削除。3c1664e まで)で、以下の「画面」はそのときの経緯を含む。
 *
 * ★`quinella`フィールドはIssue #117(#24-D3b-2)で配分提案への組み込みが完了し
 * 買い目が実際に発生するようになったため、検証画面にも馬連の行を出す
 * (#116までは買い目が構造的に0件だったため、#112「馬連 ¥0 0点」の事故と同型を避けるため
 * あえて表示しない設計だった。Issue #114 AC-6・着手前ゲートの合意)。
 *
 * ★`exacta`フィールドはIssue #121・#24-F2で追加した。当時は配分が馬単の買い目をまだ作らず
 * `betCount`は構造的に常に0であり、quinellaと同じ理由で画面への表示は#123へ申し送った
 * (core `ProposedBetReport` JSDoc参照)。その後Issue #125(#24-E3b)で配分が馬単の買い目を作るようになり、
 * `betCount`は実際の買い目の数になった。
 *
 * ★`trifecta`フィールドはIssue #131・#25-Fで追加した。本インターフェースは「coreの型の
 * プレーン写し」を設計原則としており(この段落自体がその原則の記述)、画面表示の有無に
 * かかわらず core `ProposedBetReport` に追加されたフィールドは即座に写す(#121〈exacta〉と
 * 同じ扱い)。当時は画面への表示を#132へ申し送った(exactaと同じ理由。配分が三連単の
 * 買い目をまだ作らないため`betCount`は構造的に常に0)。その後Issue #139(#25-E3b)で
 * 配分が三連単の買い目を作るようになった。
 *
 * ★`bracketQuinella`フィールドはIssue #145・#26-Fで追加した(trifectaと同じ扱い。上記の
 * 「プレーン写し」の原則により即座に写す)。#145の時点では画面への表示を#146へ申し送り、
 * 配分が枠連の買い目をまだ作らないため`betCount`は構造的に常に0だった。**Issue #150(#26-E3b)で配分が
 * 枠連の買い目を作るようになり、検証画面の内訳にも表示している。**
 */
export interface ProposedBetReportView {
  /** 母集団4分類の件数。 */
  readonly population: ProposedBetPopulationView;
  /** 複勝・単勝・ワイド・3連複・馬連・馬単・三連単・枠連の合算。 */
  readonly overall: ProposedBetTypeSummaryView;
  /** 複勝の内訳。 */
  readonly place: ProposedBetTypeSummaryView;
  /** 単勝の内訳(Issue #100・#23-C)。 */
  readonly win: ProposedBetTypeSummaryView;
  /** ワイドの内訳。 */
  readonly wide: ProposedBetTypeSummaryView;
  /** 3連複の内訳。 */
  readonly trio: ProposedBetTypeSummaryView;
  /**
   * 馬連の内訳(Issue #114・#24-F1)。Issue #117(#24-D3b-2)以降、検証画面はこの値を
   * 表示する(このJSDoc冒頭の注意参照)。
   */
  readonly quinella: ProposedBetTypeSummaryView;
  /**
   * 馬単の内訳(Issue #121・#24-F2)。#121の時点では配分が馬単の買い目をまだ作らず`betCount`は
   * 常に0だったが、Issue #125(#24-E3b)で配分が馬単の買い目を作るようになり、`betCount`は実際の
   * 買い目の数になった(このJSDoc冒頭の注意参照)。画面への表示は#123へ申し送られていた(現在の検証画面は8券種を表示する)。
   */
  readonly exacta: ProposedBetTypeSummaryView;
  /**
   * 三連単の内訳(Issue #131・#25-F)。#131の時点では配分が三連単の買い目をまだ作らず`betCount`は
   * 常に0だったが、Issue #139(#25-E3b)で配分が三連単の買い目を作るようになり、`betCount`は実際の
   * 買い目の数になった(このJSDoc冒頭の注意参照)。画面への表示は#132へ申し送られていた(現在の検証画面は8券種を表示する)。
   */
  readonly trifecta: ProposedBetTypeSummaryView;
  /**
   * 枠連の内訳(Issue #145・#26-F)。#145の時点では配分が枠連の買い目をまだ作らず`betCount`は
   * 常に0だったが、Issue #150(#26-E3b)で配分が枠連の買い目を作るようになり、`betCount`は実際の
   * 買い目の数になった。検証画面の内訳にも表示している(#150)。
   */
  readonly bracketQuinella: ProposedBetTypeSummaryView;
  /** 未知の券種コードの内訳(Issue #76。`overall`には合算しない)。 */
  readonly unknownBetType: ProposedBetUnknownBetTypeView;
}

/**
 * 検証画面: 検証レポート(表示用)。
 * core の VerifyReport は既にプレーン構造なので、旧 exe では main がそれを構造的にこの型として返した。クラウド版の画面は、同名の自前の型(`cloud/client/api-verify.ts` の `VerifyReportView`)で読む。
 */
export interface VerifyReportView {
  /** 集計に含めた分析件数。 */
  readonly includedAnalysisCount: number;
  /** 結果未取込で除外した分析件数。 */
  readonly excludedAnalysisCount: number;
  /** 同一レースの新しい分析に取って代わられ集計しなかった件数。 */
  readonly supersededAnalysisCount: number;
  /** 推定EV(発売前の概算)のため集計から除外した分析件数(Task#25)。 */
  readonly excludedEstimatedCount: number;
  /**
   * 先読みリーク疑い(発走以降に分析され、遮断の印が無い行)のため集計から除外した分析件数
   * (Issue #152)。検証画面の集計(全体・版別)では常に除外が有効。
   */
  readonly excludedLookaheadSuspectCount: number;
  /**
   * 発走の前後を判定できず(同日分析で発走時刻が無い・開催日が決まらない等)集計から除外した
   * 分析件数(Issue #152)。「リーク疑い」とは別の件数として扱う。
   *
   * 不変条件: 集計・結果未取込・旧分析・推定EV・リーク疑い・発走前後判定不可の6件数の和が分析総数。
   */
  readonly excludedLookaheadUnknownCount: number;
  /** 累積回収率サマリ。 */
  readonly bet: VerifyBetView;
  /** 推定確率帯ごとのキャリブレーション表。 */
  readonly calibration: readonly CalibrationBinView[];
  /** 補正傾向サマリ(Task#26)。 */
  readonly trend: VerifyTrendReportView;
  /** 配分ベースの回収率(Issue #71 #54-B)。 */
  readonly proposedBet: ProposedBetReportView;
}

/**
 * 結果取込の結果(1レース分)。status で確定/未確定を判別する判別共用体。
 *
 * - "imported": 結果が確定していて着順を保存した(複勝払戻は無いこともある。hasPayout で判別)。
 * - "not_confirmed": まだ発走前・結果確定前で着順を取得できなかった(何も保存していない)。
 *   例外ではなく正常応答として返すことで、一括取込側が自動スキップしやすくする(Task#31)。
 */
export type ImportResultOutcome =
  | {
      /** 結果を確定・取込済み。 */
      readonly status: "imported";
      /** レースID(12桁)。 */
      readonly raceId: string;
      /** 取り込んだ着順の頭数。 */
      readonly horseCount: number;
      /** 取り込んだ複勝払戻の点数。 */
      readonly placePayoutCount: number;
      /** 複勝の払戻テーブルが取得できたか(着順は取れたが払戻未確定なら false)。 */
      readonly hasPayout: boolean;
    }
  | {
      /** まだ結果が確定していない(発走前・確定前)。何も保存していない。 */
      readonly status: "not_confirmed";
      /** レースID(12桁)。 */
      readonly raceId: string;
    };






/**
 * 検証画面: レース単体の予実ブレークダウンの1頭分(表示用。core RaceBreakdownHorse の
 * プレーン写し)。Task#34。
 */
export interface RaceBreakdownHorseView {
  /** 馬番。 */
  readonly umaban: number;
  /** 予想印(◎〇▲△☆注のいずれか。印なし・LLM未使用時は null)。 */
  readonly mark: PredictionMark | null;
  /** 補正後複勝確率(AI補正後3着内率)。 */
  readonly adjustedProb: number;
  /** 使用した複勝オッズ下限。欠損なら null。 */
  readonly placeOddsMin: number | null;
  /** 期待値。オッズ欠損なら null。 */
  readonly ev: number | null;
  /** EVが閾値を上回るか(EVプラス馬の判定)。 */
  readonly isPositive: boolean;
  /** 実着順。非数値着順(中止・除外)・結果に馬番が無い場合は null(着順不明)。 */
  readonly finishPosition: number | null;
  /** 複勝的中の有無。finishPosition が null(着順不明)なら判定不能のため null。 */
  readonly isPlaced: boolean | null;
  /** この馬に賭けた金額(円)。賭けていない・着順不明なら0。 */
  readonly stake: number;
  /** この馬の払戻(円)。的中でなければ0。 */
  readonly payout: number;
  /** payout の算出根拠。的中かつ賭けた馬のみ非null。 */
  readonly payoutSource: "actual" | "approximate" | null;
}

/**
 * 配分提案の1買い目分(表示用。core StoredAllocationBetDetail のプレーン写し。Issue #55)。
 * `RaceBreakdownHorseView` と同じ慣行(core側の型をこのファイルに構造的に複製する)に倣う。
 * このファイルは core の型を import しない規約(ファイル先頭コメント参照。例外は、自身が import を持たない `common/prediction-marks.ts` の型 1 つだけ)を保つため、型を import せず
 * 手動で複製する。構造一致は `packages/core/test/analysis/analysis-types-allocation-pin.test.ts` がコンパイル時に固定する。
 */
export interface StoredAllocationBetView {
  /** 券種。core の `AllocationBetType`(`ev/combo-bet-allocation.ts`)の値。未知の値でもそのまま(throwしない)。 */
  readonly betType: string;
  /** buildComboOddsKey による正規化キー。複勝は2桁ゼロ埋め1個のみ。 */
  readonly comboKey: string;
  /** 実際の配分額(円)。stake>0 の行のみ。 */
  readonly stake: number;
  /** 分析時点で採用したオッズ。欠損・未確定なら null。 */
  readonly odds: number | null;
  /** 分析時点の期待値。欠損・未確定なら null。 */
  readonly ev: number | null;
}

/**
 * 配分提案(表示用。core StoredAllocation のプレーン写し。Issue #55)。
 * メタ17列(route/unavailableReason/fallbackReason/skipReasonCode/実効設定11項目/betUnit/
 * oddsStatus。実効設定8項目目のincludeQuinellaはIssue #118〈#24-D3b-3〉で、9項目目の
 * includeExactaはIssue #126〈#24-E3c〉で、10項目目のincludeTrifectaはIssue #140〈#25-E3c〉で、
 * 11項目目のincludeBracketQuinellaはIssue #151〈#26-E3c〉で、それぞれ追加)+ bets。
 * core `getStoredAllocation` が意図的に読まない6列
 * (combo_odds_wide/combo_odds_trio/greedy_steps/candidate_cap/model_id/model_approximate。
 * メタ行の物理列数24から読む17列と`analysis_id`〈検索キーでありデータ列ではない〉を除いた数。
 * Issue #118・#126・#140・#151でinclude_quinella・include_exacta・include_trifecta・
 * include_bracket_quinella列が追加され20→21→22→23→24列になったが、読まない6列自体は
 * 変わらない)はこの型にも持たせない(#71の原則。
 * 読まない列は表示型にも持ち込まない)。
 */
export interface StoredAllocationView {
  readonly route: string;
  readonly unavailableReason: string | null;
  readonly fallbackReason: string | null;
  readonly skipReasonCode: string | null;
  readonly bankroll: number;
  readonly perRaceCap: number;
  readonly kellyFraction: number;
  readonly evThreshold: number;
  readonly includeComboOdds: boolean;
  readonly includeWide: boolean;
  readonly includeTrio: boolean;
  /**
   * 馬連を配分に使うか(Issue #118・#24-D3b-3で追加)。列追加前(Issue #118より前)に保存された
   * 記録は null(「記録なし」。#31: OFFと断定しない。表示は「馬連: 記録なし」)。
   */
  readonly includeQuinella: boolean | null;
  /**
   * 馬単を配分に使うか(Issue #126・#24-E3cで追加)。列追加前(Issue #126より前)に保存された
   * 記録は null(「記録なし」。#31: OFFと断定しない。表示は「馬単: 記録なし」。`includeQuinella`と
   * 同型)。
   */
  readonly includeExacta: boolean | null;
  /**
   * 三連単を配分に使うか(Issue #140・#25-E3cで追加)。列追加前(Issue #140より前)に保存された
   * 記録は null(「記録なし」。#31: OFFと断定しない。表示は「三連単: 記録なし」。
   * `includeQuinella`/`includeExacta`と同型)。
   */
  readonly includeTrifecta: boolean | null;
  /**
   * 枠連を配分に使うか(Issue #151・#26-E3cで追加)。列追加前(Issue #151より前=v1.13.0まで)に
   * 保存された記録は null(「記録なし」。#31: OFFと断定しない。買い目に枠連が入っている記録でも
   * ONと推定しない。表示は「枠連: 記録なし」。`includeQuinella`/`includeExacta`/`includeTrifecta`と
   * 同型)。
   */
  readonly includeBracketQuinella: boolean | null;
  readonly betUnit: number | null;
  readonly oddsStatus: string;
  readonly bets: readonly StoredAllocationBetView[];
}

/**
 * 検証画面: レース単位の統合リストの1件(表示用。core RaceLedgerEntry に会場名・レース番号を
 * 加えたもの。検証画面UI統合)。
 *
 * 旧「分析履歴」テーブル(分析単位・未取込含む)と旧「レース別予実」セクション(レース単位・
 * 結果取込済みのみ)を、レースID単位(latest統合)の折りたたみリスト1つに統合するための型。
 * 旧セクションと異なり、母集団は「分析済みの全レース」(結果取込の有無を問わない)。
 * hasResult=false のときは horses の finishPosition・isPlaced が全馬 null、
 * totalStake・totalReturn・betCount は 0、recoveryRate は null になる(予測側のみ有効)。
 */
export interface RaceLedgerView {
  /** レースID(12桁)。 */
  readonly raceId: string;
  /** 会場名(レースIDの場コードから導出)。 */
  readonly venueName: string;
  /** レース番号(1〜12。レースIDの末尾2桁から導出)。 */
  readonly raceNumber: number;
  /**
   * 開催日(YYYYMMDD)。旧データ・選択済み開催日が渡らなかった分析は null(日付不明。地方レースは
   * raceIdから補完済み。race-ledger-view.ts 参照)。
   */
  readonly kaisaiDate: string | null;
  /** この統合エントリの元になった分析ID(latest統合後の1件)。 */
  readonly analysisId: number;
  /** 分析日時(ISO8601)。 */
  readonly analyzedAt: string;
  /** プロンプト版番号。版不明(旧データ・LLM未使用)は null。 */
  readonly promptVersion: string | null;
  /** このレースの実結果(実着順)が取込済みか。 */
  readonly hasResult: boolean;
  /**
   * このレースの複勝確定払戻が取込済みか。着順のみ取込(確定直前など払戻テーブル欠損)では
   * hasResult=true でも hasPayout=false になる。
   */
  readonly hasPayout: boolean;
  /** 各馬の予測・結果(馬番昇順)。結果未取込なら finishPosition・isPlaced は全馬 null。 */
  readonly horses: readonly RaceBreakdownHorseView[];
  /** このレースの賭け金合計(円)。結果未取込なら0。 */
  readonly totalStake: number;
  /** このレースの払戻合計(円)。結果未取込なら0。 */
  readonly totalReturn: number;
  /** このレースの回収率。賭け0点(結果未取込を含む)なら null。 */
  readonly recoveryRate: number | null;
  /** このレースで賭けた点数。結果未取込なら0。 */
  readonly betCount: number;
  /**
   * この分析時点の配分提案(Issue #55)。#59より前に保存された旧分析(配分メタ行が無い)は
   * null(「記録なし」。allocation-proposal-view.tsの判別状態の1つ)。
   */
  readonly allocation: StoredAllocationView | null;
}
