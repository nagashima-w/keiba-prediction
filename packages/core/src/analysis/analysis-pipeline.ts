/**
 * 分析パイプライン(`runAnalysis`。クラウド版は `cloud/src/race-day-core.ts` から呼ぶ。旧 exe では main プロセスで動かした)。
 *
 * 1レース分の分析を次の順で実行し、途中経過を進捗コールバックで通知する:
 *   スクレイピング(scrapeRace) → 戦績の先読みリーク遮断(Issue #39。自レース・施行日以降の走を除く)
 *   → スコアリング(buildPriorInput × 全頭 → computeFieldPriors)
 *   → LLM分析(analyzeRace。未設定ならスキップし prior を採用) → EV計算(computeRaceEv)
 *   → 保存(deps.saveAnalysis。クラウド版は D1 への保存) → 結果を返す
 *
 * 構成(Issue #400 R-10a。親は #390): 約 600 行あった `runAnalysis` を、段ごとの関数に分けた。出力は分割の前後で同じ(`pipeline-golden.json` がバイト同一)。
 *  - `analysis-llm-materials.ts`: LLM に渡す材料の読み出し(当日傾向・重賞の過去傾向・当日の馬場)と `BuildPromptInput` の組み立て
 *  - `analysis-record.ts`: 結果行・保存レコード・結果オブジェクトの組み立て
 *  - `recompute-allocation.ts`: EV 計算と配分(#338)
 *  - このファイル: deps の型・スコアリング(`scoreField`)・LLM 段(`runLlmStage`)・段の呼び出し順(`runAnalysis`)
 *
 * テスト容易性の設計:
 * - 実IO(scrapeRace のフェッチャ・LLM・保存先)は AnalysisPipelineDeps として関数注入する。
 *   本番配線(fetcher/store/llm から deps を組む)は呼び出し側(クラウド版は cloud/src/race-day-core.ts。旧 exe では pipeline-deps.ts(#287 で削除。3c1664e まで))に分離し、この runAnalysis 自体は
 *   注入されたスタブだけで完結してユニットテストできる(実ネットワーク・実APIのテストは書かない)。
 * - core の名前は、バレル(better-sqlite3 を巻き込み、クラウド版のバンドルが失敗する)ではなく、狭い入口
 *   `../pipeline.js` から import する(経緯は `pipeline.ts` のヘッダ。閉包は `cloud/test/import-guard.test.ts` が固定する)。
 *
 * 推定EV(Task#25): 発売前(race.odds.oddsStatus === "yoso")は複勝オッズが常に空
 * (scraper/parse-odds.ts・parse-nar-odds.ts の仕様により odds.place = {})になるため、
 * 通常の computeRaceEv(確定EV)では全馬 ev=null になってしまう。そこで yoso のときだけ
 * core computeEstimatedRaceEv(単勝オッズから複勝下限を概算)を使い、EVプラス判定を含めた
 * 概算EVをレース単位で計算する。結果・保存レコードには evEstimated フラグ(レース単位、
 * oddsStatus=yoso と等価)を持たせ、確定EVと明確に区別できるようにする(UI表示・verify集計の
 * 両方でこのフラグを参照する)。中央・地方(NAR)いずれも odds.win に予想単勝オッズが入るため、
 * この分岐だけで両者に対応できる。
 *
 * 会場名・開催日・開催区分(中央/地方)の扱い:
 * - 会場名は scrapeRace のレース情報に含まれないため、レースIDの場コードから導出する(venue-codes。
 *   中央10場・地方(NAR)いずれにも対応する)。
 * - 開催区分(venueKind: "central" | "nar")もレースIDの場コードから venueKindOfRaceId で導出し、
 *   buildPriorInput の race.venueKind に渡す(NARでは競馬場適性・コース枠順バイアス・輸送滞在
 *   バイアスを対象外にする。詳細は core prior.ts の TodayRaceConditions.venueKind コメント参照)。
 * - 開催日(カレンダー日付)は出馬表・レース一覧のいずれからも取得できない(NARのレースIDには
 *   月日が直接埋め込まれているが、UI側で選択済みの日付と過不足なく一致する保証がないため、
 *   中央と同様に kaisaiDate をそのまま用いる方式で統一する)。UI 側で選択済みの開催日(kaisaiDate)を
 *   受け取り、これを race.date(季節分類・休み明け走目の起点)に用いる。
 *   万一 kaisaiDate が渡らなかった場合のみ、当日日付で近似し dateApproximate=true を結果に含める。
 */

import {
  buildPriorInput,
  classifyTrackWetness,
  computeFieldPriors,
  resolveClipVariant,
  selectJockeyStats,
  selectTrainerStats,
  venueKindOfRaceId,
  type AnalysisAllocationRecord,
  type AnalysisRecord,
  type AnalyzeRaceResult,
  type BuildPromptInput,
  type ClipVariantId,
  type EstimatedPlaceConfig,
  type EvConfig,
  type GradeWinnerConditions,
  type GradeWinnerTrendSummary,
  type HorsePrior,
  type KaisaiDate,
  type PriorInput,
  type RaceData,
  type RaceId,
  type RaceResultDetail,
  type ScorerConfig,
} from "../pipeline.js";

import type {
  AnalysisProgress,
  AnalysisResult,
} from "./analysis-types.js";
import { buildAllocationForRows, computeEvForProbs } from "./recompute-allocation.js";
import type { AnalysisAllocationSettings } from "./allocation-record.js";
import {
  excludeOwnRaceResults,
  filterRaceDataBefore,
} from "../scorer/snapshot-filter.js";
import type { ComboStats } from "./combo-stats.js";
import type { RaceIdVenueKind } from "../scraper/ids.js";
import type { PriorResult } from "../scorer/prior.js";
import type { DayBaba } from "../analyzer/day-baba.js";
import { venueNameFromRaceId } from "./venue-codes.js";
import {
  buildPromptInput,
  loadDayBaba,
  loadGradeWinnerTrend,
  loadSameDayTrend,
} from "./analysis-llm-materials.js";
import {
  buildAnalysisRecord,
  buildAnalysisResult,
  buildAnalysisRows,
  type AdjustedHorse,
} from "./analysis-record.js";

/** runAnalysis に注入する依存。すべて関数注入でモック可能。 */
export interface AnalysisPipelineDeps {
  /** レースデータ取得(通常は core scrapeRace を fetcher で束縛したもの)。 */
  readonly scrape: (raceId: RaceId) => Promise<RaceData>;
  /**
   * LLM分析関数(通常は core analyzeRace を LlmClient で束縛したもの)。
   * null のときは LLM分析をスキップし、prior をそのまま補正後確率として採用する。
   */
  readonly analyze:
    | ((input: BuildPromptInput) => Promise<AnalyzeRaceResult>)
    | null;
  /**
   * 分析結果の保存(旧 exe は AnalysisStore.saveAnalysis〈同期。採番IDを返す〉(#287 で削除。3c1664e まで)、クラウド版は D1 への保存〈非同期〉)。
   * 戻り値は runAnalysis では使わないので `unknown`。Promise が返れば `await` して完了を待ち、reject は runAnalysis の
   * reject として伝える(Issue #176。同期の throw は従来どおり)。
   */
  readonly saveAnalysis: (record: AnalysisRecord) => unknown;
  /**
   * 配分提案(Issue #59)を計算するための設定(10項目。`evThreshold`を含まない——EV閾値は
   * `evConfig ?? DEFAULT_EV_CONFIG`から導出し二重ソースを作らない。#59 3節)。
   * `null`は「この呼び出しでは配分計算をしない」という明示的な選択を表す(required-nullable。
   * optionalにしないことで、構築側〈クラウド版は cloud/src/race-day-core.ts。旧 exe では pipeline-deps.ts(#287 で削除。3c1664e まで)〉に選択を強制する。#59着手前ゲート)。
   * 非nullのときのみ `AnalysisRecord.allocation` を計算して積む(nullなら行を書かない=
   * 旧分析と区別できない「未到達」のまま。#59 AC4)。
   */
  readonly allocationSettings: AnalysisAllocationSettings | null;
  /** 現在時刻(analyzedAt・当日近似日付に使う)。既定 () => new Date()。 */
  readonly now?: () => Date;
  /** EV設定(閾値)。省略時は既定(閾値1.0)。 */
  readonly evConfig?: EvConfig;
  /**
   * 推定複勝下限の換算係数(Task#25)。省略時は既定(coef=0.2)。
   * oddsStatus="yoso"(発売前)のときだけ使われる。
   */
  readonly estimatedPlaceConfig?: EstimatedPlaceConfig;
  /** scorer設定。省略時は core の既定。 */
  readonly scorerConfig?: ScorerConfig;
  /** LLMスキップ理由(analyze=null のとき結果メタに載せる文言)。 */
  readonly llmSkipReason?: string;
  /**
   * 使用するLLMモデル名(Issue#10 分析データのエクスポート。例: "claude-sonnet-5-5")。
   * Issue #157 以降は、analyzeRace の modelUsed(実際に応答したモデル。自動選択の結果)を優先し、
   * この値は modelUsed が無いとき(応答を得られなかった場合・旧モック)の代用にだけ使う。
   * LLM使用時(deps.analyze!==null)のみ保存レコードの model 列に記録する。LLMスキップ時は
   * この値が設定されていても保存レコードの model は null にする(偽値混入を避けるため。
   * 旧 exe の pipeline-deps.ts(#287 で削除。3c1664e まで)は useLlm===true のときだけこの値を注入する想定だった。クラウド版の cloud/src は注入していない)。
   */
  readonly modelName?: string;
  /**
   * プロンプト追加指示(設定画面、Task#28 プロンプト改善C)。省略時・空文字・空白のみは
   * 何も注入しない(undefinedとしてBuildPromptInputへ渡す)。トリムした値を
   * BuildPromptInput.additionalInstruction に渡し、LLM使用時のみ分析レコードにも保存する
   * (LLMスキップ時はプロンプト自体を使っていないため null を保存する。promptVersionと同じ方針)。
   */
  readonly additionalInstruction?: string | null;
  /**
   * クリップ幅の版ID(タスクD-2: ±10%↔±15%のA/B・新版並走・2026-07-21 boss着手前ゲート合意)。
   * 省略時・不正値は対照("default"、±10%)へフォールバックする(core resolveClipVariant に委譲)。
   * この値を BuildPromptInput.clipVariant としてそのまま buildPrompt へ渡し(文面の許容幅表記に反映)、
   * 保存する promptVersion もこの値から解決した ClipVariant.promptVersion を使う(単一ソース。D-3)。
   * 呼び出し側(クラウド版は cloud/src/race-day-core.ts。旧 exe では main/pipeline-deps.ts(#287 で削除。3c1664e まで))は、parseAnalyzerResponse へ渡す
   * AnalyzeRaceDeps.maxAdjust も同じ版から解決した値を deps.analyze の束縛時に渡す必要がある
   * (文面とクリップ幅の食い違いを防ぐため、両者は同じ CLIP_VARIANTS エントリに由来させること)。
   */
  readonly clipVariant?: ClipVariantId;
  /**
   * 確定済みレース結果詳細の取得(タスク#27-C: 当日の同一場・同一面傾向をプロンプトに反映する配線)。
   * 通常は AnalysisStore.getRaceResultDetail を束縛したもの(旧 exe の pipeline-deps.ts(#287 で削除。3c1664e まで)が
   * store.getRaceResultDetail をそのまま渡していた。クラウド版は非同期のバッチ版 getRaceResultDetails を使う)。省略時は当日傾向を算出せず、既存のプロンプト文面・
   * 既存テストを非破壊のまま保つ(機能オフ)。LLM分析をスキップする経路(deps.analyze===null)では、
   * この依存が注入されていても当日傾向を算出しない(prior採用経路で無駄なDB読み出しを増やさないため)。
   */
  readonly getRaceResultDetail?: (raceId: RaceId) => RaceResultDetail | undefined;
  /**
   * 確定済みレース結果詳細のバッチ読み出し(Issue #176〈#164-a〉。クラウド版は D1 が非同期で、1呼び出しあたりのクエリ数に
   * 上限があるため、前のレース分をまとめて1回で引く)。**`getRaceResultDetail` と両方が渡されたらこちらを使い、
   * 単発の方は呼ばない。** 渡る ID は `precedingRaceIdsSameDay(raceId)`(自レースより前のレース番号だけ。#153)で、
   * 呼び出しは1回。返す Map に無い ID は結果なし(undefined)として扱う。
   * `getRaceResultDetail` と同じく、LLM をスキップする経路(`analyze === null`)では呼ばない。
   */
  readonly getRaceResultDetails?: (
    raceIds: readonly RaceId[],
  ) =>
    | ReadonlyMap<string, RaceResultDetail | undefined>
    | Promise<ReadonlyMap<string, RaceResultDetail | undefined>>;
  /**
   * 同レース(重賞)の過去10年結果傾向の取得+集計(タスク機能B。通常は core
   * collectGradeWinnerTrend に fetcher を束縛したもの。クラウド版は cloud/src/race-day-core.ts、旧 exe では pipeline-deps.ts(#287 で削除。3c1664e まで)が束縛した)。
   * 省略時は算出せず、既存のプロンプト文面・既存テストを非破壊のまま保つ(機能オフ)。
   * 中央・地方(NAR)いずれのレースでも呼び出す(2026-07-28実測訂正: 地方専用ホストで同一APIが
   * 取得できるため、venueKindによる事前フィルタは行わない。ホスト選択は core の scraper/fetch-grade-winner.ts が race_id から行う〈束縛側は fetcher を渡すだけ〉)。
   *
   * 呼び出しゲート(要修正2・2026-07-28 boss裁定): 出馬表のレース名見出しに重賞グレードバッジ
   * (parse-shutuba.ts の hasGradeBadge)が無いと判定できた場合のみ、この依存が注入されていても
   * 呼び出さない(非重賞への無駄なPOSTを避ける。期間バッチで無視できない件数になるため)。
   * hasGradeBadge が undefined(判定不能・旧フィクスチャ等)のときは fail-open で必ず呼ぶ
   * (取りこぼしゼロを優先。詳細は types.ts ShutubaRaceInfo.hasGradeBadge のコメント参照)。
   * LLM分析をスキップする経路(deps.analyze===null)では、この依存が注入されていても呼び出さない
   * (無駄なリクエストを増やさない、sameDayTrend等と同じ方針)。
   *
   * 呼び出しは1回のネットワークI/Oを伴う「補助材料」であり、失敗(ネットワークエラー・
   * 応答構造の異常等)してもLLM本体の分析結果には一切影響させず、null にフォールバックして
   * 分析全体を完了させる(呼び出し側のrunAnalysisが try/catch でこれを保証する)。ただし
   * 例外送出時は onGradeWinnerTrendError で警告として残す(要修正10。詳細は同フィールド参照)。
   *
   * 第3引数 `cutoffDate`(Issue #153: 先読みリークの遮断)は分析日(`analysisDate`。戦績の絞り込み
   * 〈#39〉の基準日と同じ値。YYYY/MM/DD)。取得した過去回のうち、当該回自身・基準日と同日以降の回は
   * 集計から除かれる(core の excludeLookaheadEntries)。過去のレースを後から分析すると、地方の応答は
   * (実測した大井のシリーズでは)race_id に依らない同じ応答で、当該回と後の回を含むため。当日運用では何も除かれない。
   */
  readonly getGradeWinnerTrend?: (
    raceId: RaceId,
    conditions: GradeWinnerConditions,
    cutoffDate: string,
  ) => Promise<GradeWinnerTrendSummary | null>;
  /**
   * `getRaceResultDetails`(バッチ)が失敗したときに呼ばれる警告用フック(Issue #177)。失敗しても分析は止めず、当日傾向なし(null)で続ける。
   * 省略時は黙って null にする。単発の `getRaceResultDetail` の失敗にはこのフックは使わない(従来どおり runAnalysis が reject する)。
   */
  readonly onSameDayTrendError?: (info: {
    readonly raceId: RaceId;
    readonly message: string;
  }) => void;
  /**
   * getGradeWinnerTrend が例外を投げたときに呼ばれる診断ログ用フック(要修正10・2026-07-28
   * boss裁定)。事前にグレードバッジ判定で呼び出しをゲートしているため、それでも呼び出しが
   * 例外を投げるのは「重賞と判定したのに取得・パースが失敗した」という本物の異常
   * (ネットワーク障害・netkeiba側のAPI仕様変更等)のみを意味する。
   *
   * 対して、非重賞判定(status:NG)・条件一致3回未満のような正常系の null 返却は例外を
   * 投げないため、このフックは呼ばれない(無音のまま=既存どおり)。「非重賞NG(正常・無音)」と
   * 「構造破壊・API仕様変更(異常・警告ログ)」を区別し、後者だけを無音で握りつぶさないための
   * フックであり、onFallback(LLM関連の診断ログ)と役割・呼び出し条件が異なるため独立して持つ。
   * 省略時は診断ログを残さない(黙って null にフォールバックするのみ。挙動は従来どおり)。
   */
  readonly onGradeWinnerTrendError?: (info: {
    readonly raceId: RaceId;
    readonly message: string;
  }) => void;
  /**
   * 当日の馬場の値(クッション値・含水率・使用コース・芝の状態の文章)の読み出し(Issue #295〈#293-B〉。クラウド版は D1 の `baba_conditions`)。
   * 引数は JRA の場コード(2桁。レースIDの5〜6桁目)と開催日(YYYYMMDD)。値が無い(地方・計測が無い日・取得の前)は null。
   * **呼ぶのは、LLM を使う中央のレースで、開催日が渡っているときだけ**(地方・LLM スキップ・近似日では呼ばない。LLM が見ていない値を記録しないため)。
   * 返った値は正規化し(normalizeDayBaba)、コース種別で絞って(selectDayBabaForCourse)から、プロンプトとスナップショット(`raceSnapshot.baba`)の両方に同じものを渡す。
   * 省略時は何もしない(機能オフ。既存のプロンプト・保存内容はバイト不変)。失敗(throw・reject)は握って値なしで続け、`onBabaError` に渡す。
   */
  readonly getBabaConditions?: (venueCode: string, kaisaiDate: string) => DayBaba | null | Promise<DayBaba | null>;
  /** `getBabaConditions` が失敗したときの警告用フック(Issue #295)。失敗しても分析は止めず、値なしで続ける。省略時は黙って値なしにする。 */
  readonly onBabaError?: (info: { readonly raceId: RaceId; readonly message: string }) => void;
  /**
   * fallback:true(LLMがフェイルセーフでpriorに復帰)発生時に呼ばれる任意の診断ログ用フック
   * (論点E: #35ログ基盤との連携・2026-07-19合意)。fallback:false(印の補修〈Issue #317〉を含む)では
   * 呼ばない。
   *
   * 秘密安全性: context に相当する raceId・stopReason は構造化情報のみで apiKey・Webhook等は
   * 一切積まない。diagnosticMessage は LLM呼び出し例外・JSONパース失敗時の生の詳細を含みうる
   * ため、UI(AnalysisResult.fallbackReason)・DB(AnalysisRecord)には絶対に渡さず、
   * このフック経由でのみ(旧 exe では main/logger.ts の logWarn〈既存の秘密マスキング exe の shared/log-formatter.ts を通す〉へ、
   * 呼び出し側 exe の pipeline-deps.ts/ipc.ts が配線していた。#287 で削除。3c1664e まで)ログ等へ配線すること。
   */
  readonly onFallback?: (info: {
    readonly raceId: RaceId;
    readonly stopReason: string | null;
    readonly diagnosticMessage: string;
  }) => void;
}

/** Date を YYYY/MM/DD に整形する(buildPriorInput の date 形式に合わせる)。 */
function toYmdSlash(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

/**
 * 分析に用いる開催日(YYYY/MM/DD)を解決する純関数。
 * kaisaiDate(YYYYMMDD)が渡ればそれを変換して用い、近似ではない(approximate=false)。
 * 渡らない(null / 8桁でない)場合のみ当日日付で近似する(approximate=true)。
 * @param kaisaiDate 選択済み開催日(YYYYMMDD)。渡らない場合は null。
 * @param now 現在時刻取得関数(近似フォールバック用)。
 */
export function resolveAnalysisDate(
  kaisaiDate: string | null,
  now: () => Date,
): { date: string; approximate: boolean } {
  if (kaisaiDate !== null && /^[0-9]{8}$/.test(kaisaiDate)) {
    const date = `${kaisaiDate.slice(0, 4)}/${kaisaiDate.slice(4, 6)}/${kaisaiDate.slice(6, 8)}`;
    return { date, approximate: false };
  }
  return { date: toYmdSlash(now()), approximate: true };
}


/**
 * 騎手の年度別成績(`RaceData.jockeyStats`)から、その騎手の記録を取り出す。取得していない・取得に失敗した・
 * 騎手IDが無い場合は undefined。**自前のプロパティだけを見る**(騎手IDは英数字で、`valueOf` のような
 * 名前が Object.prototype の関数を返さないように)。
 */
function jockeyRecordsOf(race: RaceData, jockeyId: string | null) {
  return personRecordsOf(race.jockeyStats, jockeyId);
}

/** 調教師の年度別成績(`RaceData.trainerStats`。Issue #354)から、その調教師の記録を取り出す。騎手と同じ規則。 */
function trainerRecordsOf(race: RaceData, trainerId: string | null) {
  return personRecordsOf(race.trainerStats, trainerId);
}

function personRecordsOf(
  stats: RaceData["jockeyStats"] | undefined,
  id: string | null,
) {
  if (id === null || stats === undefined) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(stats, id) ? stats[id] : undefined;
}

/** {@link scoreField} の入力。 */
interface ScoreFieldArgs {
  /** 先読み遮断済みのレースデータ。 */
  readonly race: RaceData;
  readonly venueName: string;
  readonly venueKind: RaceIdVenueKind;
  readonly isWet: boolean;
  /** 分析日(YYYY/MM/DD)。 */
  readonly analysisDate: string;
  /** 進捗の総数に使う頭数(scrape 直後の頭数。先読み遮断の前後で変わらない)。 */
  readonly horseCount: number;
  readonly now: () => Date;
  readonly deps: AnalysisPipelineDeps;
  readonly notify: (progress: AnalysisProgress) => void;
}

/**
 * (2) スコアリング。各馬の PriorInput を組み立て(進捗を頭ごとに通知)、頭数レベルで prior を合成して、
 * 馬番 → prior(寄与度ログを含む)の Map を返す。以降の突合に使う。
 * `now()` は馬ごとに 1 回ずつ呼ぶ(騎手成績の窓の選択。呼び出し回数と位置は分割の前後で同じ)。
 */
function scoreField(args: ScoreFieldArgs): Map<number, PriorResult> {
  const { race, venueName, venueKind, isWet, analysisDate, horseCount, now, deps, notify } = args;
  const priorInputs: PriorInput[] = race.horses.map((horseData, index) => {
    notify({
      stage: "スコアリング",
      current: index + 1,
      total: horseCount,
      message: `スコアリング中(${index + 1}/${horseCount}頭)`,
    });
    return buildPriorInput({
      horse: horseData.shutuba,
      raceResults: horseData.results ?? [],
      race: {
        courseType: race.race.courseType,
        distance: race.race.distance,
        venueName,
        isWet,
        date: analysisDate,
        venueKind,
      },
      fieldSize: horseCount,
      // 騎手の成績(Issue #226)。scrapeRace が `includeJockeyStats` で取った年度別成績(`race.jockeyStats`)から、
      // 分析日に応じた窓(ライブ=前年+当年・過去日=前々年+前年)で集計する。取得していない(キー自体が無い)・
      // 取得に失敗した・騎手IDが無い馬は undefined(scorer が「データなし」で補正なし)。
      jockeyCourseStats: selectJockeyStats(
        jockeyRecordsOf(race, horseData.shutuba.jockeyId),
        analysisDate,
        now(),
      ),
      // 調教師の成績(Issue #354)。`race.trainerStats` から、分析日の年の前2年(ライブも過去日も同じ)を足し合わせる。
      // 取得していない・取得に失敗した・調教師IDが無い馬は undefined(「データなし」)。地方・障害のレースは prior 側で対象外にする。
      trainerStats: selectTrainerStats(trainerRecordsOf(race, horseData.shutuba.trainerId), analysisDate),
      config: deps.scorerConfig,
    });
  });
  const priors = computeFieldPriors(priorInputs);
  // 馬番 → prior(寄与度ログを含む)。以降の突合に使う。
  const priorByUmaban = new Map(
    race.horses.map((h, i) => [h.shutuba.umaban, priors[i]!]),
  );
  return priorByUmaban;
}

/** 手順 (3) LLM 分析の結果。skip(prior 採用)でも同じ形で返す。 */
interface LlmStageOutcome {
  readonly llmUsed: boolean;
  readonly llmSkippedReason: string | null;
  readonly fallback: boolean;
  /** フォールバックの理由(固定分類文言。論点C)。不変条件: fallback:false の場合は必ず null。 */
  readonly fallbackReason: string | null;
  /** LLMの生応答テキスト(Issue#10 分析データのエクスポート)。LLMスキップ時は null。 */
  readonly rawResponse: string | null;
  /**
   * 実際に使ったLLMモデル(Issue #157)。analyzeRace の modelUsed(応答の model。自動選択の結果)を
   * 優先し、無ければ静的な deps.modelName。LLMスキップ時は null(偽値を混入させない)。
   */
  readonly modelUsed: string | null;
  readonly adjustedByUmaban: ReadonlyMap<number, AdjustedHorse>;
  /** 当日の馬場の値(Issue #295)。LLM に渡した値(絞った後)。LLM を使わない・地方・値なしは null(スナップショットに載せない)。 */
  readonly baba: DayBaba | null;
}

/** {@link runLlmStage} に渡す、runAnalysis が解決済みの文脈。 */
interface LlmStageContext {
  readonly raceId: RaceId;
  readonly kaisaiDate: KaisaiDate | null;
  /** 先読み遮断済みのレースデータ。 */
  readonly race: RaceData;
  readonly venueName: string;
  readonly venueKind: RaceIdVenueKind;
  readonly analysisDate: string;
  readonly priorByUmaban: ReadonlyMap<number, PriorResult>;
  readonly trimmedInstruction: string;
  readonly clipVariantId: ClipVariantId;
}

/** prior をそのまま補正後確率として採用する1頭分(LLM未使用・分析結果に含まれない馬)。 */
function priorAsAdjusted(prior: PriorResult): AdjustedHorse {
  return {
    adjustedProb: prior.prior,
    reason: null,
    highlights: [],
    concerns: [],
    mark: null,
  };
}

/** (3) LLM分析(未設定ならスキップして prior を採用)。 */
async function runLlmStage(
  ctx: LlmStageContext,
  deps: AnalysisPipelineDeps,
  notify: (progress: AnalysisProgress) => void,
): Promise<LlmStageOutcome> {
  const { raceId, race, priorByUmaban } = ctx;
  const adjustedByUmaban = new Map<number, AdjustedHorse>();

  if (deps.analyze === null) {
    const llmSkippedReason = deps.llmSkipReason ?? "LLM分析はスキップされました";
    notify({
      stage: "LLM分析",
      current: null,
      total: null,
      message: `LLM分析をスキップしました(${llmSkippedReason})`,
    });
    for (const h of race.horses) {
      adjustedByUmaban.set(h.shutuba.umaban, priorAsAdjusted(priorByUmaban.get(h.shutuba.umaban)!));
    }
    return {
      llmUsed: false,
      llmSkippedReason,
      fallback: false,
      fallbackReason: null,
      rawResponse: null,
      modelUsed: null,
      adjustedByUmaban,
      baba: null,
    };
  }

  notify({
    stage: "LLM分析",
    current: null,
    total: null,
    message: "LLMで複勝確率を補正しています…",
  });
  // LLM に渡す材料(当日傾向・重賞の過去傾向・当日の馬場)。この順に読む(analysis-llm-materials.ts)。
  const sameDayTrend = await loadSameDayTrend(raceId, race.race.courseType, deps);
  const gradeWinnerTrend = await loadGradeWinnerTrend(raceId, race.race, ctx.analysisDate, deps);
  const baba = await loadDayBaba(raceId, race.race.courseType, ctx.kaisaiDate, deps);

  const promptInput = buildPromptInput({
    race,
    raceId,
    venueName: ctx.venueName,
    venueKind: ctx.venueKind,
    analysisDate: ctx.analysisDate,
    priorByUmaban,
    sameDayTrend,
    gradeWinnerTrend,
    baba,
    trimmedInstruction: ctx.trimmedInstruction,
    clipVariantId: ctx.clipVariantId,
  });
  const analysis = await deps.analyze(promptInput);
  // fallbackReason は core 側が必ず不変条件(fallback:false ⇒ null)を守って返すため、
  // そのまま伝播する(固定分類文言のみ・秘密非混入。論点C)。
  // LLMの生応答テキスト(Issue#10)。core AnalyzeRaceResult.rawResponse は既存呼び出し元との
  // 互換のため optional(未設定時はtext未取得の失敗)なので、明示的にnullへ正規化する。
  // 使ったモデル(Issue #157)。応答の model を優先し、無ければ静的な modelName で代用する。
  const fallback = analysis.fallback;
  // フォールバック発生時のみ診断ログ用フックを呼ぶ(論点E)。生の診断詳細
  // (diagnosticMessage)はUI/DBへは渡さず、このフック経由でのみログ基盤へ渡す。
  if (fallback) {
    deps.onFallback?.({
      raceId,
      stopReason: analysis.stopReason ?? null,
      diagnosticMessage: analysis.diagnosticMessage ?? analysis.fallbackReason ?? "",
    });
  }
  for (const h of analysis.horses) {
    adjustedByUmaban.set(h.umaban, {
      adjustedProb: h.adjustedProb,
      reason: h.reason,
      highlights: h.highlights,
      concerns: h.concerns,
      mark: h.mark,
    });
  }
  // 分析結果に含まれない馬番(理論上は無いが安全側)は prior を採用する。
  for (const h of race.horses) {
    if (!adjustedByUmaban.has(h.shutuba.umaban)) {
      adjustedByUmaban.set(h.shutuba.umaban, priorAsAdjusted(priorByUmaban.get(h.shutuba.umaban)!));
    }
  }
  return {
    llmUsed: true,
    llmSkippedReason: null,
    fallback,
    fallbackReason: analysis.fallbackReason,
    rawResponse: analysis.rawResponse ?? null,
    modelUsed: analysis.modelUsed ?? deps.modelName ?? null,
    adjustedByUmaban,
    baba,
  };
}

/**
 * 1レースを分析する。
 * @param raceId 対象レースID(検証済み)
 * @param kaisaiDate 選択済み開催日(YYYYMMDD)。null の場合のみ当日日付で近似する。
 * @param deps 注入依存(scrape/analyze/saveAnalysis ほか)
 * @param onProgress 進捗コールバック(省略可)
 */
export async function runAnalysis(
  raceId: RaceId,
  kaisaiDate: KaisaiDate | null,
  deps: AnalysisPipelineDeps,
  onProgress?: (progress: AnalysisProgress) => void,
): Promise<AnalysisResult> {
  const now = deps.now ?? (() => new Date());
  const notify = (progress: AnalysisProgress): void => {
    onProgress?.(progress);
  };
  // プロンプト追加指示(Task#28): 空文字・空白のみ・未指定は「注入なし」として扱う。
  const trimmedInstruction = (deps.additionalInstruction ?? "").trim();
  // クリップ幅版(タスクD-2): 未指定・不正値は対照(default)へフォールバックする。
  // buildPrompt へ渡す clipVariant と、保存する promptVersion の両方をこの1回の解決結果から使う
  // (単一ソース。deps.clipVariant の文字列が不正でも resolveClipVariant が対照へ安全に丸める)。
  const clipVariant = resolveClipVariant(deps.clipVariant);

  // (1) スクレイピング。
  notify({
    stage: "スクレイピング",
    current: null,
    total: null,
    message: "レースデータを取得しています…",
  });
  const scrapedRace = await deps.scrape(raceId);
  const horseCount = scrapedRace.horses.length;
  notify({
    stage: "スクレイピング",
    current: horseCount,
    total: horseCount,
    message: `レースデータを取得しました(${horseCount}頭)`,
  });

  // 会場名・開催区分(中央/地方)はレースIDの場コードから、開催日は選択済み kaisaiDate から解決する。
  const venueName = venueNameFromRaceId(raceId);
  const venueKind = venueKindOfRaceId(raceId);
  const { date: analysisDate, approximate: dateApproximate } =
    resolveAnalysisDate(kaisaiDate, now);
  // (1b) 先読みリークの遮断(Issue #39)。netkeiba の馬ページの戦績は日付で絞られておらず、過去の
  // レースを分析すると、そのレース自身の走と施行日以降の走が戦績に含まれる(実測: 中央16頭で
  // 全114走のうち自レース16走・施行日より後5走。prior 上位3頭が実着順上位3頭と一致した)。
  // これらを prior・LLMプロンプト入力・結果行の材料から取り除くため、**ここで1回だけ**絞り、以降の
  // 戦績の消費箇所(buildPriorInput・runs・条件替わり・馬体重推移・人気着順乖離・乗り替わり・
  // 着差傾向・休養間隔・careerRunCount・条件替わりタグ)はすべて絞った `race` を使う。
  //  - 当該 raceId の走は日付に依らず除外する(`raceIdRaw` 比較。中央・地方とも効く)。開催日が渡らず
  //    実行日で近似(dateApproximate=true)した過去レースでも、自レースの走は日付だけでは残るため。
  //  - 基準日(analysisDate)と同日以降の走・日付欠損の走を除外する(未来の走を混ぜない保守側)。
  //    近似日のとき基準日は実行日になるため、施行日より後・実行日より前の走は残る(既知の限界。
  //    近似日はUIから到達しない。画面には「近似」と表示される)。
  //  - 当日の未施行レースでは自レース・施行日以降の走がそもそも存在せず、何も変わらない。
  // 日付での絞り込みは scraper ではしない(scrapeRace は分析日を知らない)。
  // 出走しなかった行(除外・取消)は日付に依らない事実なので、Issue #261 から scrapeRace が戦績の取得時点で除いている(上の絞りはその後の戦績に掛かる)。
  const race = filterRaceDataBefore(
    excludeOwnRaceResults(scrapedRace, raceId).raceData,
    analysisDate,
  ).raceData;
  // 絞りに使った基準日(YYYYMMDD)。保存レコードの history_cutoff_date に書き、是正前の分析
  // (この列が NULL)と区別できるようにする(dateApproximate=true でも使った基準日を書く)。
  const historyCutoffDate = analysisDate.replaceAll("/", "");
  const isWet =
    classifyTrackWetness(race.race.trackCondition ?? null, race.race.courseType)
      ?.isWet ?? false;

  // (2) スコアリング(各馬の PriorInput を組み立て、頭数レベルで prior を合成)。
  const priorByUmaban = scoreField({
    race,
    venueName,
    venueKind,
    isWet,
    analysisDate,
    horseCount,
    now,
    deps,
    notify,
  });

  // (3) LLM分析(未設定ならスキップして prior を採用)。
  const llm = await runLlmStage(
    {
      raceId,
      kaisaiDate,
      race,
      venueName,
      venueKind,
      analysisDate,
      priorByUmaban,
      trimmedInstruction,
      clipVariantId: clipVariant.id,
    },
    deps,
    notify,
  );
  const { llmUsed, adjustedByUmaban } = llm;

  // (4) EV計算(補正後確率 × 複勝オッズ下限)。
  // 発売前(yoso)は複勝オッズが常に空のため、単勝オッズからの推定EV(computeEstimatedRaceEv)に
  // 切り替える。それ以外(result/middle)は従来どおり確定EV(computeRaceEv)。
  const evPriors: HorsePrior[] = race.horses.map((h) => ({
    umaban: h.shutuba.umaban,
    placeProb: adjustedByUmaban.get(h.shutuba.umaban)!.adjustedProb,
  }));
  // 計算本体は recompute-allocation.ts に抽出した(Issue #338。クラウド版の締切の直前の再計算と共有する。出力は抽出の前後で同じ)。
  const { evEstimated, evResults } = computeEvForProbs(
    evPriors,
    race.odds,
    deps.evConfig,
    deps.estimatedPlaceConfig,
  );
  const evByUmaban = new Map(evResults.map((e) => [e.umaban, e]));

  // (5) 結果行の組み立て(馬番昇順)。
  const rows = buildAnalysisRows({
    race,
    venueKind,
    priorByUmaban,
    adjustedByUmaban,
    evByUmaban,
    evEstimated,
  });

  // (6) 配分提案(Issue #59)。deps.allocationSettings===null(この呼び出しでは配分計算を
  // 行わない選択)のときは何もしない(record.allocationを省略=「未到達」のまま。#59 AC4)。
  let allocation: AnalysisAllocationRecord | undefined;
  // 組合せの券種ごとの EV プラスの点数(Issue #296)。配分の候補を作った経路だけ非 null(R2 のスナップショットに残す)。
  let comboStats: ComboStats | null = null;
  if (deps.allocationSettings !== null) {
    // 配分の計算本体(組合せオッズの受け渡しの条件付き spread・EV 閾値の導出・例外時の無効の記録)は recompute-allocation.ts に抽出した
    // (Issue #338。クラウド版の締切の直前の再計算と共有する。出力は抽出の前後で同じ)。
    // 券種ごとの設定の配管の経緯(#116・#122・#137・#148 ほか)を書いていた抽出前のコメントは、`git show 9bd9967:packages/core/src/analysis/analysis-pipeline.ts` で読める。
    const computed = buildAllocationForRows({
      rows,
      raceId,
      odds: race.odds,
      comboOdds: race.meta.comboOdds,
      allocationSettings: deps.allocationSettings,
      evConfig: deps.evConfig,
    });
    allocation = computed.allocation;
    comboStats = computed.comboStats;
  }

  // (7) 保存。
  const analyzedAt = now().toISOString();
  notify({
    stage: "保存",
    current: null,
    total: null,
    message: "分析結果を保存しています…",
  });
  const record = buildAnalysisRecord({
    raceId,
    analyzedAt,
    evEstimated,
    llmUsed,
    promptVersion: clipVariant.promptVersion,
    trimmedInstruction,
    kaisaiDate,
    historyCutoffDate,
    modelUsed: llm.modelUsed,
    rawResponse: llm.rawResponse,
    race,
    baba: llm.baba,
    comboStats,
    priorByUmaban,
    adjustedByUmaban,
    evByUmaban,
    allocation,
  });
  await deps.saveAnalysis(record);

  return buildAnalysisResult({
    raceId,
    venueName,
    race,
    analysisDate,
    dateApproximate,
    llmUsed,
    llmSkippedReason: llm.llmSkippedReason,
    fallback: llm.fallback,
    fallbackReason: llm.fallbackReason,
    modelUsed: llm.modelUsed,
    rows,
    analyzedAt,
  });
}
