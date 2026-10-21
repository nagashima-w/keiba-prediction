/**
 * 日単位の Durable Object `RaceDay` の中身(Issue #177〈#164-b〉)。**純ロジック**: `cloudflare:workers` を import しない。
 * ストレージ(`ctx.storage.sql`)・時計・ゲート・アラームの設定を引数で受けるので、Node の vitest で(本物の SQLite の意味論で)テストできる。
 * DO のラッパ(`race-day-do.ts`)は、これらを本物に配線するだけ。
 *
 * ## 用語(Issue #249)
 * 「事前分析」= mode `morning`(旧「朝の準備」)。画面・Discord・docs の表示名だけを変えた。内部の識別子(`morning`・D1・DO の状態・API の値)と、コメントの「朝の prior」「朝のタスク」は旧称のまま。
 * 事前分析は**前日の 21:00 JST**(cron の 1 本目)に、翌日の開催日の DO で始まる。23:00 JST(2 本目)の再実行は `requestPlan({ rescue: true })` で、失敗した分を 1 回だけ救済し({@link RaceDayCore.requestPlan})、
 * 救済の後も失敗が残れば Discord に通知する(`judgePlanRescue`・{@link RescueStage.judge})。
 *
 * ## 役割
 * 開催日(`idFromName(kaisaiDate)`)ごとに1つの DO が、その日の全レースの**事前分析**を直列に処理する(gate の待ち行列の上限 8 に当たらない)。
 *  - **ステップ1(取得 `fetch`)**: `scrapeRace`(変更なし。組合せオッズは取らない。単勝・複勝のオッズを1本取る)でキャッシュを埋める。中央16頭の
 *    冷えた状態で gate への取得は **19 本**(出馬表 1・戦績 16・調教 1・単勝複勝 1)。**騎手の重みが 0 より大きいとき(既定 0.15)は、騎手の年ごとの成績
 *    (Issue #226)も騎手 ID で一意にして取る**: まず保存先(`jockeyStore`。本番は D1。日をまたいで共有)から読み、取得日時から 7 日以内なら netkeiba に
 *    出ない(週に 1 回の更新)。保存先に無い・古い騎手だけを 1 人 1 本、その後ろに足す(16 頭・騎手 16 人で最大 35 本。保存先が空の最初の週と冷えた状態だけ)。
 *    1 回の取得の fetcher 呼び出しの合計は上限 40(`DEFAULT_JOCKEY_REQUEST_LIMIT`)で、届いたら残りの騎手は取らず補正なしで続ける。重みが 0 なら 19 本のまま。
 *    **調教師の年度別成績(Issue #354)も同じ流れ**で、騎手の後ろに調教師 ID で一意にして取る(調教師の重み `baseScoreWeightTrainer` が 0 より大きいとき。既定 0.77。中央のレースだけ)。
 *    保存先は D1 の `trainer_results`(`trainerStore`)で、取得日時が**レースの年の 1 月 1 日〈JST〉以降**なら netkeiba に出ない(前2年の行は確定値なので年に 1 回)。
 *    **上限 40 は騎手と調教師で共有**する(騎手の後ろの調教師から先に締め出される)ので、gate への最悪の呼び出しは下の 43 本のまま増えない。
 *    騎手が保存先にあれば 16 頭の調教師は全員取れる(19 + 16 = 35 本)。騎手も冷えていれば調教師は 5 人まで(19 + 16 + 5 = 40 本)で、残りは補正なし。
 *    発走前の取得ステップは、この `scrapeRace` のほかに、重賞の過去10年傾向(`prefetchGradeWinner`。LLM が有効で重賞のときだけ、最大 1 本)と、日報の時刻の下限のためのレース一覧(`ReportHoldStage.record`→`getRaceList`。最大 1 本・取得キャッシュにあれば 0 本)を引く。
 *    **前走の条件(Issue #421 段階 1-b)**: `scrapeRace` は新聞形式 API の POST を 1 本だけ足す(`includePrevConditions`。馬の数によらない。取得キャッシュに 6 時間あれば 0 本)。**騎手・調教師の上限 40 の外**(`deps.fetcher` を直接呼ぶ)ので、`scrapeRace` の呼び出しは最大 41 本になる。
 *    したがって gate への呼び出しは最大 (40 + 1) + 1 + 1 = 43 本で、Free の 50 に対して余裕は 7 本(再現: `grep -n "this.reportHold.record(\|this.prefetchGradeWinner(" cloud/src/race-day-core.ts` で、どちらも `runPreRaceFetch` の呼び出しが 1 箇所ずつ。新聞形式の POST は `grep -n "fetchNewspaperConditions(" packages/core/src/scraper/scrape-race.ts` の 1 箇所。一覧の取得は段階が注入された取得口 `getRaceList` を呼ぶ 1 箇所〈`grep -n "this.getRaceList(" cloud/src/race-day-report-hold-stage.ts`〉。
 *    `fetchText(` はそれぞれ `fetchGradeWinnerEntries` に 1 回、`listRaces`・`listNarRaces` に 1 回ずつ)。D1・R2 への呼び出しは数えていない。
 *    **レースの条件(Issue #421 段階 1)**: 朝・発走前のどちらの取得ステップも、`scrapeRace` が出馬表を読んだ直後に、負担重量の種別と牝馬限定を D1 の `race_conditions` へ渡す(`raceConditionsStore`。取得は増やさない・失敗は警告にして続ける・
 *    地方と条件の欄を読めなかったレースは渡さない)。前走との照合(段階 2)で、前走のレース ID から引くための記録。段階 1 では統計モデル・LLM・画面に使わない。
 *  - **ステップ2(計算 `compute`)**: **netkeiba には出ず**(gate は0回)、キャッシュだけで `runCloudAnalysis(analyze: null, allocationSettings: null)` を走らせ、
 *    朝の prior(`AnalysisResult`)を **DO のストレージにだけ**置く(**D1・R2 には書かない**。ユーザー判断 2026-10-06: 保存するのは発走前の分析だけ)。
 *    ただし**各馬の戦績**(キャッシュ済みの事実。Issue #256 段階A)は、prior の保存とタスクの完了の後に D1 の `horse_runs` へ貯める(`horseRunsStore`。取得は増やさない。
 *    失敗は警告にして分析を止めない)。保存は事前分析の計算ステップだけで、発走前の分析(pre_race)では貯めない=手動の発走前だけの分析の戦績は貯まらない(段階Aの限界)。
 *    取得のあとで TTL が切れても読めるよう、キャッシュの鮮度を実質無期限にして読む。キャッシュに戦績が無ければ(掃除された等)、netkeiba に出ず失敗にする
 *    (`scrapeRace` は戦績の失敗を警告にして続けるので、戦績なしの prior を黙って作らないよう検出する)。
 *  - 2つのステップは**別々のアラーム呼び出し**で動かす(1呼び出しの中のサブリクエスト数〈Free は 50〉を抑える・再試行でネットワークを撃ち直さない)。
 *    1回の `runNextStep` は1レースの1ステップだけを行い、続きがあればアラームを設定して戻る。
 *
 * ## 地方三連単の段階(Issue #283)
 * 発走前(pre_race)の取得ステップは、地方の三連単(軸=1着固定ごとに頭数ぶんのリクエスト)を取らない(`scrapeRace` の `deferNarTrifecta`)。組合せが ON の地方では、取得ステップが成功したあと、
 * 出走馬の全馬番を `race_day_nar_trifecta`(`race-day-nar-trifecta.ts`)に pending で登録し、タスクは `fetched` になる。`fetched` の発走前のタスクに pending の軸があれば、`runStep` は計算より先に
 * {@link RaceDayCore.runNarTrifectaStep}(**別のアラーム**。1回に最大 {@link NAR_TRIFECTA_AXES_PER_STEP} 軸を取って `fetch_cache` に積む)を呼ぶ。pending が尽きたら計算ステップ(ネットワークに出ない。キャッシュから三連単をインラインで読む)。
 * 1アラームあたりの gate への呼び出しは、取得ステップ ≤ 43(`scrapeRace` が ≤ 40〈騎手の上限〉+ 前走の条件 1 + 重賞の傾向 1 + 日報の下限の一覧 1)・段階 ≤ 9・計算 0。外から見える `status` は増やさない(段階の間も `fetched`)。失敗・打ち切りでも三連単なしで計算に進む。
 *
 * ## 予約(schedule)
 * 予約だけをして戻る(`setAlarm(now)`)。本処理はアラームの中(`runNextStep`)。同じレースが実行中(queued・fetched)なら受け付けない。
 * DO は1つの開催日だけを扱う(最初の予約の開催日に固定し、別の日・raceId の年と違う日は拒否する)。
 *
 * ## アラームの合成(Issue #203 段階1)
 * DO のアラームは1つだけ。**`setAlarm` を呼ぶのは {@link RaceDayCore.rearm} の1箇所だけ**で、起こしたい理由(今すぐの仕事・再試行待ち・計画・掃除)の最も早い時刻に張る({@link nextAlarmAt})。
 * 計画(段階2)の候補が入っても、掃除や一覧の取得が未来の予約を潰さない。`pickNext` は**発走前(pre_race)を朝(morning)より先**に処理する(再試行待ちは最後)。
 *
 * ## 事前分析の計画(Issue #203 段階2)
 * `requestPlan` → 計画の段階(会場の一覧)→ 確定(計画の表と morning の投入)→ 期限が来たら pre_race の投入。仕組みと冪等性の規則は {@link RaceDayCore.requestPlan}・{@link PlanStage.runFinalize}・{@link PromoteStage.promoteDue}、表は `race-day-plan.ts`。
 * ## 発走前の予約のガード(Issue #204 段階C)
 * 昇格は**確定済みの日だけ**。昇格の判定は {@link PromoteStage.promoteRow}(実行中の手動・時刻・手動の分析との重複・上限)、自動で積んだ pre_race は印(`race_day_auto_pre_race`)で手動と区別し、
 * 各ステップの直前に発走済みなら netkeiba にも LLM にも出ずに failed にする({@link RaceDayCore.failIfStarted})。結果は {@link RaceDayCore.getAutoRunResults} が状態から読む(`auto-run-result.ts`)。
 *
 * ## 通知(Issue #205 段階D)
 * Discord への通知は、コールバックではなく**状態から作る**(`planNotifications`〈`notify-plan.ts`。純関数〉が、`getAutoRunResults`・`getPlanProgress`・通知の表〈`race_day_notify`。`notify-store.ts`〉から、
 * 「いま送るもの」と「次にアラームを張る時刻」を同じ関数で返す)。送信は {@link NotifyStage.runStep}(**多くとも1回**: 送る前に `sending` の行を書く。落ちたものは再送しない)。処理の順は
 * 昇格 → 計画 → **通知** → タスク。completed の embed は、計算ステップの `saveAnalysis` コールバックの中で、保存する `record` から作って `analysis_id` の永続化より前に積む({@link NotifyStage.putAnalysisMaterial})。
 * **webhook が無効なら(`notifier` なし)、行も材料も積まず、通知のためのアラームも張らない。** URL は `notifier` のクロージャの中だけにあり、ここには渡らない。
 *
 * ## 結果の取り込み(Issue #208〈#182-B〉)
 * 過去の開催日の結果(着順・払戻)を、アラームの 1 ステップにつき **1 レース**だけ取り込む(`requestResultImport` で依頼 → {@link ResultStage.runStep})。状態は**専用の新しい表**(`race_day_result`。`race-day-result.ts`)。
 * 取得は gate 経由・キャッシュを通さない生の `HttpClient`(結果のページをキャッシュに溜めない)、保存は D1(`resultStore`)。**払戻のテーブルが出てから保存する**(審議中の暫定の着順を固めない)。
 * 優先度は最も低い: **タスク(queued・fetched)が無く、計画の段階〈会場の一覧・確定〉が終わっているときだけ**動く({@link RaceDayCore.resultsRunnable}。アラームの候補を入れるかと、動くかの両方がこれを使う)。通知は {@link RaceDayCore.runNextStep} の順序で、送るべきものがあれば先に出る。
 * **期限を待つ planned の行は止めない**ので、今日の DO でも、期限が来た行の昇格〈各ステップの先頭〉→ タスク → 結果の順で動く(Issue #209)。
 *
 * ## 当日中の結果の取り込みと当日傾向(Issue #209)
 * 計画の確定時に、発走時刻のある計画の行(skip の行も含む)ごとに結果の行を積む({@link PlanStage.runFinalize}。`requested_on` = 開催日。最初の試行は発走 + 15 分)。
 * 当日の行は、**全頭の着順がそろったページだけ**保存する(結果ページ自身の「N頭」と、着順が確定している行の数〈着順が空の行は数えない〉を比べる。地方では払戻が先に出て、全頭の着順が数分遅れて出ることを実測)。
 * 発走前の計算ステップは、保存済みの前のレースの結果(D1。gate は 0 回)から当日傾向を作る({@link RaceDayCore.runPreRaceCompute})。効くのは同じ場・同じ面で取り込み済みが 2 レース以上のときだけ(中央が中心: 地方の結果ページには通過順の列が無い)。
 *
 * ## 失敗と再試行
 * 取得ステップは、失敗(gate の拒否・通信の失敗・戦績の取りこぼし)なら試行回数 {@link MAX_ATTEMPTS} まで、{@link RETRY_DELAY_MS} 後に再試行する
 * (取れたぶんはキャッシュにあるので、取れなかったぶんだけを取り直す)。**ブレーカーが開いている(blocked)・許可リスト外**は再試行せず直ちに失敗にする
 * (30 分のブレーカーの間に撃ち直さない)。計算ステップの失敗は決定的なので、再試行しない。
 * アラームは少なくとも1回は実行される(失敗時は再実行される)ので、状態(status・attempts)は各ステップの前後に永続化する。
 *
 * ## 一覧(getRaceList。Issue #183〈#165-a〉)
 * 開催日のレース一覧(中央・地方)を、同じ gate 経由のキャッシュ(TTL 6 時間)で返す(`GET /api/races`)。タスクではなく、予約・アラームの仕事を持たない読み取り。
 * ただし取得した一覧の行を掃除するために、**掃除専用のアラームを、タスクのアラームを潰さずに共有する**(規則は {@link RaceDayCore.getRaceList})。開催日は pin しない。
 *
 * ## gate は同時に1本
 * {@link serializeGate} で、RaceDay から gate への呼び出しを直列にする(gate 自身も直列化するが、待ち行列の上限 8 に当たらないよう、呼び出し側でも1本にする)。
 *
 * ## 締切の直前の再計算(Issue #338〈#335-A1〉。`race-day-close.ts`・`analysis-close.ts`)
 * 発走前の分析(`pre_race`。自動・手動とも)が保存されたら、その同じ同期区間で再計算の入力(馬ごとの確率ほか)と回の行(発走の 5 分前・2 分前〈暫定〉)を積む({@link CloseStage.register})。
 * 時刻が来たら {@link CloseStage.runStep}(通知・馬場・タスクの前に 1 ステップ)が、**オッズだけ**を取り直し(出馬表・戦績・調教はキャッシュ専用、オッズだけ `bypassCache`)、確率は分析時のまま
 * 配分を作り直して(`recomputeAllocationFromProbs`。LLM は呼ばない)D1 に保存する。結果が決まったら保存の前に DO に書く=保存の再試行・再実行で取り直さない。中央・地方とも対象(Issue #379)。
 * 地方で組合せが ON のときは**部分的な取り直し**: 単勝・複勝(1 本)だけ取り直し、組合せは分析時のオッズ(取得キャッシュの、分析の取得〜保存の期間のエントリ)のまま配分を作り直す(読めなければ failed の `combo-missing`)。通知はしない。
 */
import { CachedFetcher, type TextFetcher } from "../../packages/core/src/scraper/cached-fetcher";
import { HttpError, type HttpClient } from "../../packages/core/src/scraper/http-client";
import { collectGradeWinnerTrend } from "../../packages/core/src/analyzer/grade-winner-trend";
import { fetchGradeWinnerEntries, gradeWinnerCacheKey } from "../../packages/core/src/scraper/fetch-grade-winner";
import { newspaperCacheKey } from "../../packages/core/src/scraper/fetch-newspaper";
import { GradeWinnerParseError } from "../../packages/core/src/scraper/parse-grade-winner";
import { DEFAULT_RESULTS_TTL_MS, listNarRaces, listRaces, scrapeRace, type RaceFetcher } from "../../packages/core/src/scraper/scrape-race";
import { parseKaisaiDate, parseRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids";
import { deriveNarTrifectaAxisUmabans } from "../../packages/core/src/scraper/nar-trifecta-axis";
import type { JockeyResultsStore } from "../../packages/core/src/scraper/jockey-results-store";
import type { TrainerResultsStore } from "../../packages/core/src/scraper/trainer-results-store";
import type { HorseRunsStore } from "./horse-runs";
import { toRaceConditionRecord, type RaceConditionsStore } from "./race-conditions";
import type { RaceData, ScrapeWarning } from "../../packages/core/src/scraper/scrape-race";
import type { RaceListEntry } from "../../packages/core/src/scraper/types";
import { narRaceListSubUrl, narTrifectaOddsAxisUrl, raceListSubUrl } from "../../packages/core/src/scraper/urls";
import { MAX_BULK_RACES } from "./bulk-limits";
import { checkRaceDate } from "./race-date";
import { jstKaisaiDate } from "./auto-run-plan";
import { isDayQuiet } from "./day-quiet";
import { AUTO_RUN_STARTED_ERROR, classifyAutoRun, type AutoFailReason, type AutoRunOutcome } from "./auto-run-result";
import { type NotificationPlan, type NotifyKind, type NotifyState } from "./notify-plan";
import type { DiscordNotifier } from "./notify-send";
import { NotifyStore } from "./notify-store";
import { startTimeEpochMs } from "./pre-race-time";
import {
  MAX_RESULT_RACES_PER_REQUEST,
  MAX_RESULT_ROWS_PER_DAY,
  MAX_SAME_DAY_RESULT_ROWS,
  ResultImportStore,
  SAME_DAY_RESULT_DELAY_MS,
  type ResultClass,
  type ResultState,
} from "./race-day-result";
import type { ResultRepository } from "./result-repository";
import { requireCacheKeyForPost } from "./post-cache-guard";
import { BabaStage, type BabaFetcher, type BabaReader, type BabaStepOutcome, type BabaStore } from "./race-day-baba";
import { NAR_TRIFECTA_AXES_PER_STEP, NarTrifectaStore } from "./race-day-nar-trifecta";
import { PlanStore, type PlanSkipReason, type PlanVenue } from "./race-day-plan";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { DoSqlCacheStore } from "./do-cache-store";
import { createGateHttpClient, GateRefusedError, type GateLike } from "./gate-fetch";
import { resolveClipVariant } from "@keiba/core/pipeline";
import type { AnalysisSaveExtra, RecentAnalysis } from "./analysis-save-extra";
export type { AnalysisSaveExtra, RecentAnalysis };
import { clampAdditionalInstruction, createCloudAnalyze, createCloudModelSelectors, LLM_NOTE_NO_KEY, outcomeOf, redactSecrets, type ModelSelectorFor } from "./llm-run";
import { SqlLlmResponseStore } from "./llm-response-store";
import type { CloudLlm } from "./llm-sender";
import { runCloudAnalysis, type CloudAnalysisResult } from "./pipeline";
import type { CloseSavePayload } from "./analysis-close";
import { CloseStore } from "./race-day-close";
import { CloseStage, type CloseStepOutcome } from "./race-day-close-stage";
import { NotifyStage, type NotifyStepOutcome } from "./race-day-notify-stage";
import { PlanStage, type PlanStepOutcome } from "./race-day-plan-stage";
import { RescueStage } from "./race-day-rescue-stage";
import { PromoteStage } from "./race-day-promote-stage";
import { ResultStage, type ResultStepOutcome } from "./race-day-result-stage";
import { REPORT_HOLD_KEY, REPORT_REQUESTED_KEY, ReportHoldStage } from "./race-day-report-hold-stage";
import { allocationSettingsOf, CACHE_MISS_HEAD, CACHE_ONLY_TTL, CacheMissError, errorMessage, isFatalFetchError, ODDS_URL_PATTERN } from "./race-day-support";

/** オッズの URL の分類(`race-day-support.ts` に移した。従来の import 先を保つため再 export する)。 */
export { ODDS_URL_PATTERN };
import { buildCloudScorerConfig } from "./scorer-config";
import { ADDITIONAL_INSTRUCTION_MAX_LENGTH, coerceCloudSettings, DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "./settings";
import type { SqlLike } from "./sql-like";

// 救済の後の失敗の判定の結果を永続化するキー(`plan_rescue_verdict`)は、段階 `race-day-rescue-stage.ts` にある(Issue #399〈R-9e の e3〉)。

// 日報の時刻の下限・依頼済み・判定済みの印のキー(`REPORT_HOLD_KEY`・`REPORT_REQUESTED_KEY`・判定済み)と警告の文言は、段階 `race-day-report-hold-stage.ts` にある(Issue #399〈R-9b〉)。
// `REPORT_HOLD_KEY` は従来の import 先を保つため再 export する。
export { REPORT_HOLD_KEY };

/** 掃除の時刻(エポックミリ秒)を永続化するキー。 */
const PURGE_DUE_KEY = "purge_due_at";

/**
 * 1日(1つの DO)に受け付けるレースの数の上限。中央は 1日 最大 36 レース(3場 × 12R)。地方を手動で足しても余裕のある値。
 * 手動起動の入口(#180)から、netkeiba への取得が際限なく積まれないための歯止め(すでにあるレースの再予約は数えない)。
 */
export const MAX_TASKS_PER_DAY = 100;

// 一括予約(`scheduleMany`。Issue #251)で 1 回に受け付けるレース数の上限は `bulk-limits.ts`(入口・DO・画面が共有する)。テストが DO のモジュールから読めるよう再 export する。
export { MAX_BULK_RACES };

/** 取得ステップの試行回数の上限。 */
export const MAX_ATTEMPTS = 3;
/**
 * 手動の分析との重複とみなす窓(Issue #204)。自動の期限の **15 分前から今まで**(両端を含む)に、現行の prompt_version で LLM が効いた手動の分析があれば、自動はスキップする。
 * それより前の手動の分析は無視して、自動で分析する(ユーザー判断 2026-10-07)。
 */
export const MANUAL_DUPLICATE_WINDOW_MS = 15 * 60_000;
/** 取得ステップの再試行までの間隔(ミリ秒)。 */
export const RETRY_DELAY_MS = 60_000;
/**
 * キャッシュ行の保持期間(ミリ秒)。使う鮮度の最長(戦績 24 時間)より長くする(短いと、まだヒットしうる行を消す)。
 * 仕事が無くなったら、`now + CACHE_RETENTION_MS + PURGE_MARGIN_MS` に**掃除専用のアラーム**を1回だけ設定し、そのアラームで、これを超えた行だけを消す。
 */
export const CACHE_RETENTION_MS = DEFAULT_RESULTS_TTL_MS + 2 * 60 * 60 * 1000;

/**
 * 掃除専用のアラームを、保持期間より少し後ろに置く余裕(ミリ秒)。最後のステップで入った行も、掃除の時刻には保持期間を**超えて**いる
 * (掃除は「経過が保持期間を超えた行」だけを消す。ちょうどは残るので、余裕が無いと最後の行が残る)。
 */
export const PURGE_MARGIN_MS = 60_000;

/**
 * アラームの合成の入力(Issue #203 段階1)。DO のアラームは**1つだけ**で、設定は上書き。だから、起こしたい理由(今すぐの仕事・再試行待ち・計画・掃除)の
 * **最も早い時刻**に1回だけ張る({@link nextAlarmAt})。理由ごとに別々に `setAlarm` すると、後から呼んだものが先の予約を潰す(#166 の調査で見つけた事故)。
 */
export interface AlarmInputs {
  readonly nowMs: number;
  /** 再試行の間隔(ミリ秒。{@link RETRY_DELAY_MS})。 */
  readonly retryDelayMs: number;
  /** 初回の取得・初回の計算の queued・fetched がある(すぐ動かす)。 */
  readonly immediateWork: boolean;
  /** queued・fetched はあるが、すべて再試行待ち(間隔を空ける)。 */
  readonly retryWork: boolean;
  /** 計画の段階で、次に一覧を取りに行く時刻の最小(未完の会場。段階2で入る)。 */
  readonly planNextTryAtMs: number | null;
  /** 計画の表で、次に期限が来る行の時刻の最小(state が planned の行。段階2で入る)。 */
  readonly planNextDueMs: number | null;
  /** 掃除専用のアラームの時刻(`purge_due_at`)。 */
  readonly purgeDueMs: number | null;
  /**
   * 通知(Discord。Issue #205)の次の時刻: 送るものがあれば送れる時刻(送信の間隔・失敗のクールダウンの時刻)、まとめの保険の時刻だけが残っていればその時刻({@link NotifyStage.plan} の `nextAtMs`)。
   * 計画の候補と同じ扱い(仕事の有無によらず候補。過去は now)。省略・null は候補なし(webhook が無効なとき・既存の呼び出し)。
   */
  readonly notifyAtMs?: number | null;
  /**
   * 結果の取り込み(Issue #208)の次の試行の時刻(`queued` の行の最小)。**動けるとき**({@link RaceDayCore.resultsRunnable}: タスクが無く、計画の段階〈会場の一覧・確定〉が終わっている。期限を待つ planned の行は止めない。Issue #209)だけ入れる。
   * 省略・null は候補なし。タスクがあるあいだに入れない理由: `pickNext` は再試行待ちのタスクを時刻を見ずに返すので、結果の候補で起きると、再試行の間隔を無効にして撃ち直してしまう。
   */
  readonly resultAtMs?: number | null;
  /**
   * 馬場の API の取得(Issue #294)の期限({@link BabaStage.dueAtMs})。**前夜のうちから**翌朝の期限で入る(過去は now)。取得の印があれば null(取得の後に候補が残って、即時のアラームが続かない)。
   * 省略・null は候補なし(取得口が無い構成・中央の開催日でない日・既存の呼び出し)。
   */
  readonly babaAtMs?: number | null;
  /**
   * 日報の時刻の下限(Issue #291)。**未来のときだけ**候補にする(下限の時刻に起きて、日報を依頼する)。過去・now・null・省略は候補なし
   * (他の候補と違い「過去は now」にしない: 下限を過ぎたあとに候補に残ると、即時のアラームのループになる)。
   */
  readonly reportHoldAtMs?: number | null;
  /**
   * 日報の時刻の下限を過ぎていて、その下限での判定がまだ行われていない(Issue #298)。真なら now を候補にする。下限の時刻の起床が、日報を判定しない分岐
   * (計画・通知・馬場・タスク)に消費されたあとでも、判定の機会が来るようにするため。判定を1回行うと印が付いて偽に戻るので、アラームの即時のループにならない
   * (印は判定の結果を問わず付く)。**呼び出し側は、タスク(queued・fetched)が無いときだけ真にする**: `pickNext` は再試行待ちのタスクを時刻を見ずに返し、タスクの分岐は
   * 印を付けないので、タスクがあるあいだに now を張ると再試行の間隔を無視した撃ち直しが続く({@link RaceDayCore.resultsRunnable} と同じ考え方)。省略・偽は候補なし。
   */
  readonly reportJudgePending?: boolean;
  /**
   * 締切の直前の再計算(Issue #338)の次の時刻(pending の行の、起こす時刻の最小)。計画の候補と同じ扱い(仕事の有無によらず候補。過去は now)。
   * 省略・null は候補なし(保存先が `saveClose` を持たない構成・既存の呼び出し・積んだ行が無い)。
   */
  readonly closeAtMs?: number | null;
}

/**
 * 次にアラームを張る時刻(UTC のエポックミリ秒)。候補のうち**最も早いもの**。候補が1つも無ければ null(アラームを設定しない)。
 *  - 即時の仕事 → now / 再試行待ちだけ → now + 間隔
 *  - 計画の次の試行・期限 → `max(それ, now)`(過去の時刻は now。仕事の有無によらず候補)
 *  - 結果の取り込みの次の試行 → `max(それ, now)`(呼び出し側が、動けるときだけ入れる)
 *  - 日報の時刻の下限 → **未来のときだけ**その時刻(過去は候補にしない。Issue #291)
 *  - 下限を過ぎて、その下限での判定が未了(`reportJudgePending`。Issue #298) → now(判定を1回行うと印が付いて消える。呼び出し側が、タスクが無いときだけ真にする)
 *  - 締切の直前の再計算の次の時刻(`closeAtMs`。Issue #338) → `max(それ, now)`(仕事の有無によらず候補。起きたら必ず状態が進む)
 *  - 掃除の期限 → `max(それ, now)`。**ただし、仕事(即時・再試行待ち)があるあいだは候補にしない**: 仕事が終われば `armAlarm` が掃除の期限を延ばして張り直す。
 *    古い掃除の期限を候補に入れると、再試行待ちの間隔を無効にして、すぐ起こしてしまう(今の `armAlarm` もそうしている)。
 */
export function nextAlarmAt(i: AlarmInputs): number | null {
  const candidates: number[] = [];
  if (i.immediateWork) {
    candidates.push(i.nowMs);
  }
  if (i.retryWork) {
    candidates.push(i.nowMs + i.retryDelayMs);
  }
  if (i.planNextTryAtMs !== null) {
    candidates.push(Math.max(i.planNextTryAtMs, i.nowMs));
  }
  if (i.planNextDueMs !== null) {
    candidates.push(Math.max(i.planNextDueMs, i.nowMs));
  }
  if (i.notifyAtMs !== undefined && i.notifyAtMs !== null) {
    candidates.push(Math.max(i.notifyAtMs, i.nowMs));
  }
  if (i.resultAtMs !== undefined && i.resultAtMs !== null) {
    candidates.push(Math.max(i.resultAtMs, i.nowMs));
  }
  if (i.babaAtMs !== undefined && i.babaAtMs !== null) {
    candidates.push(Math.max(i.babaAtMs, i.nowMs));
  }
  if (i.reportHoldAtMs !== undefined && i.reportHoldAtMs !== null && i.reportHoldAtMs > i.nowMs) {
    candidates.push(i.reportHoldAtMs);
  }
  if (i.reportJudgePending === true) {
    candidates.push(i.nowMs);
  }
  if (i.closeAtMs !== undefined && i.closeAtMs !== null) {
    candidates.push(Math.max(i.closeAtMs, i.nowMs));
  }
  if (i.purgeDueMs !== null && !i.immediateWork && !i.retryWork) {
    candidates.push(Math.max(i.purgeDueMs, i.nowMs));
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/**
 * 騎手の年度別成績(Issue #226)を取得するか。**騎手の重みが 0 より大きいときだけ**(0 なら、取得しても補正が 0 になるだけなので、
 * リクエストを増やさない)。取得ステップ・計算ステップ・発走前の取得が**同じ設定のスナップショット**から同じ結果を得る
 * (取得と計算で食い違うと、計算がキャッシュに無い騎手を探しにいく)。
 */
function wantsJockeyStats(settings: Pick<CloudSettings, "baseScoreWeightJockey">): boolean {
  return settings.baseScoreWeightJockey > 0;
}

/**
 * 調教師の年度別成績(Issue #354)を取得するか。**調教師の重みが 0 より大きいときだけ**({@link wantsJockeyStats} と同じ理由と、同じ設定のスナップショットの扱い)。
 * 中央のレースだけが対象(地方は `scrapeRace` が取得せずに対象外にする)。
 */
function wantsTrainerStats(settings: Pick<CloudSettings, "baseScoreWeightTrainer">): boolean {
  return settings.baseScoreWeightTrainer > 0;
}

export type TaskStatus = "queued" | "fetched" | "done" | "failed";

/** 朝の取得と prior(`morning`。D1・R2 には書かない)・発走前の分析(`pre_race`。LLM を使う〈Issue #194。キー未登録なら LLM なしで保存〉。D1・R2 に保存する。Issue #178)。 */
export type TaskMode = "morning" | "pre_race";

/**
 * 発走前の分析の保存先(D1・R2。DO のラッパが `D1AnalysisStore` で実装する)。**朝(morning)のタスクでは呼ばない。**
 *  - `findByAnalyzedAt`: 同じレース・同じ分析時刻の分析が保存済みなら、その id(無ければ null)。計算ステップの再実行(アラームは at-least-once)で、
 *    保存したあとにクラッシュした場合に、2件目を保存しないための確認(分析時刻はタスクに永続化した固定の値)。
 *  - `save`: 保存して、採番 id と R2 の詳細の状態を返す。
 *  - `countChildren`: 保存した分析の子の行(馬・買い目)の件数。子の行が正しい親 id に紐づいたかを、最初の実保存から確かめるため(#175 の `max(id)` の前提)。
 */
export interface AnalysisSink {
  /** `extra.llmNote`(発走前の計算ステップは常に渡す): LLM が使われなかった・一部しか使われなかった理由(固定文言。問題なく効いたときは null)。D1 の `analyses.llm_note` に保存される(Issue #194 b2)。`extra.llmCalls`: LLM を呼んだ1回ごとの記録(キー未登録は null)。D1 の `analyses.llm_calls_json` に保存される(Issue #197 段2)。`extra.markRepair`: 印を補修した・補修が要る違反があった記録(固定の語彙だけ。D1 の `analyses.mark_repair_json`。Issue #317)。 */
  save(record: AnalysisRecord, extra?: AnalysisSaveExtra): Promise<{ readonly id: number; readonly detail: "stored" | "failed" | "skipped" }>;
  findByAnalyzedAt(raceId: string, analyzedAt: string): Promise<number | null>;
  /**
   * 同じレースの、分析時刻が `[fromIso, toIso]`(両端を含む。ISO 8601 の UTC)の分析(id・分析時刻・prompt_version・model だけ)。**自動の昇格が、手動の分析との重複を確かめる**ために呼ぶ
   * (Issue #204。呼ぶのは、DO にそのレースの pre_race の行〈done・failed〉があるときだけ)。
   */
  findRecentByRace(raceId: string, fromIso: string, toIso: string): Promise<readonly RecentAnalysis[]>;
  countChildren(analysisId: number): Promise<{ readonly horses: number; readonly bets: number }>;
  /**
   * 締切の直前の再計算の 1 回ぶんの結果を保存する(Issue #338〈#335-A1〉。D1 の `analysis_close`・`analysis_close_bets`)。同じ (分析 id, 回) の再保存は上書き(冪等)。
   * **省略可**: 無い構成(この機能を持たない保存先)では、再計算の仕組み全体が無効(入力も行も積まず、アラームも張らない)。本番の保存先(`createAnalysisSink`)は常に持つ。
   */
  saveClose?(analysisId: number, payload: CloseSavePayload): Promise<void>;
}

/**
 * 結果の保存先のうち、日単位の DO が使う部分: 取り込みの保存(`saveResult`)と、発走前の分析の当日傾向の読み出し(`getRaceResultDetails`。Issue #209)。
 * `saveRaceClass`(Issue #426。結果ページから読んだレースのクラスを分析の行に書く)は**省略可**: 無い構成ではクラスの保存を黙って省く(結果の取り込みは変わらない)。本番の保存先(`D1ResultStore`)は常に持つ。
 */
export type ResultStoreDeps = Pick<ResultRepository, "saveResult" | "saveWinOdds" | "saveScratched" | "getRaceResultDetails"> & Partial<Pick<ResultRepository, "saveRaceClass">>;

export interface RaceDayDeps {
  readonly sql: SqlLike;
  readonly now: () => number;
  /** ゲート(NetkeibaGate の `fetchRaw`)。RaceDay の中で直列化する。 */
  readonly gate: GateLike;
  /** 次のアラームの時刻(エポックミリ秒)を設定する。単一のアラームなので、設定は上書き。 */
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly onWarn: (message: string) => void;
  /** 発走前の分析の保存先(D1・R2)。無ければ、発走前の予約を拒否する。朝のタスクでは呼ばない。 */
  readonly sink?: AnalysisSink;
  /** 設定(D1 の1行)の読み出し。発走前の取得ステップで1回だけ呼び、スナップショットをタスクに保存する。 */
  readonly loadSettings?: () => Promise<CloudSettings>;
  /**
   * 騎手の年ごとの成績の保存先(Issue #226。本番は D1 の `jockey_results`)。日をまたいで共有し、取得日時から 7 日以内なら netkeiba に出ない
   * (騎手の成績の更新は週に 1 回で十分。ユーザー決定 2026-10-11)。省略時は保存先なし(取得キャッシュだけ=同じ日の DO の中だけ)。
   * 取得ステップ・発走前の取得・計算ステップ(キャッシュだけ。許容鮮度は実質無期限)のすべてに同じものを渡す。
   */
  readonly jockeyStore?: JockeyResultsStore;
  /**
   * 調教師の年ごとの成績の保存先(Issue #354。本番は D1 の `trainer_results`)。日をまたいで共有し、取得日時が**レースの年の 1 月 1 日(JST)以降**なら
   * netkeiba に出ない(前2年の行は確定値なので、年に 1 回の取得で足りる)。省略時は保存先なしで、キャッシュ(DO の日単位)だけ。
   */
  readonly trainerStore?: TrainerResultsStore;
  /**
   * 各馬の戦績の蓄積先(Issue #256 段階A。本番は D1 の `horse_runs`・`horse_run_saves`〈migration 0014〉)。**事前分析(morning)の計算ステップの末尾だけ**で、
   * キャッシュ済みの出走馬全頭の戦績を渡す(取得は増やさない)。prior を保存してタスクを done にした**後**に呼び、失敗は握って警告にする(分析は止めない。再試行もしない)。
   * 発走前の分析(pre_race)では呼ばない(朝のキャッシュを使い回すので同じ戦績。手動の発走前だけの分析の戦績は貯まらない=段階Aの限界)。省略時は何もしない。
   */
  readonly horseRunsStore?: HorseRunsStore;
  /**
   * レースの条件(負担重量の種別・牝馬限定)の記録先(Issue #421 段階 1。本番は D1 の `race_conditions`〈migration 0022〉)。**取得ステップ**(朝の `runFetch`・発走前の `runPreRaceFetch`)で、
   * `scrapeRace` が出馬表を読んだ直後に 1 回渡す(netkeiba への取得は増やさない。計算ステップでは呼ばない)。条件の欄を読めなかったレース(地方・`RaceData02` 無し)は渡さない。
   * 失敗は握って警告にする(取得ステップを止めない・再試行しない)。同じ値の再保存は D1 側が行を書かない。省略時は何もしない。
   */
  readonly raceConditionsStore?: RaceConditionsStore;
  /**
   * LLM の依存(Issue #194〈#179-b〉。sender・モデル一覧。DO のラッパが、Worker の secret `ANTHROPIC_API_KEY` から作る)。**キーが無ければ渡さない**: 発走前の分析は LLM なしで保存し、
   * 理由(固定文言)を残す。朝のタスクでは使わない。`lister` が無ければ、モデルの自動選択をせず、固定モデルで送る。
   */
  readonly llm?: CloudLlm;
  /**
   * Discord への送信(Issue #205〈#166-D〉。DO のラッパが、Worker の secret `DISCORD_WEBHOOK_URL` から作る)。**URL そのものは持たない**(`send(payload)` だけ。URL が状態・ログに入る経路を作らない)。
   * **webhook が未登録・形式不正なら渡さない**: 通知の行も材料も積まず、通知のためのアラームも張らない。
   */
  readonly notifier?: DiscordNotifier;
  /**
   * 通知のリンクの基点(Issue #230。検証済みのオリジン。Worker の secret `APP_BASE_URL` を DO のラッパが {@link resolveAppBaseUrl} で検証して渡す)。**無ければ、リンクなしで通知する**。
   * **材料(`payload_json`)には入れず、送信の直前にだけ使う**(サイトの URL を DO の状態に残さない・後から登録しても、未送信の材料にリンクが付く)。値はログに出さない。
   */
  readonly appBaseUrl?: string;
  /**
   * 結果の保存先(Issue #208。DO のラッパが `D1ResultStore` で実装する)。**無ければ `requestResultImport` を拒否し、計画の確定でも結果の行を積まない**(結果の仕組み全体が無効)。発走前の分析の保存先(`sink`)とは独立。
   * 使うのは `saveResult`(取り込みのステップ)と `getRaceResultDetails`(Issue #209: 発走前の計算ステップが、前のレースの結果から当日傾向を作る。無い構成は当日傾向なし)。
   */
  readonly resultStore?: ResultStoreDeps;
  /**
   * 日報の作成の依頼(Issue #235。DO のラッパが、日報の DO〈`DailyReportDO`〉の `requestReport` を呼ぶ関数を渡す)。**無ければ依頼しない**。
   * その日が静かになった({@link isDayQuiet}: 計画が確定し、計画中のレースも発走前のタスクも結果の取り込み待ちも無く、**日報の時刻の下限〈手動で分析したレースの開催の最終レースの発走時刻。Issue #291〉を過ぎている**)とき、1 回だけ開催日を渡して呼ぶ。
   * 下限の時刻にはアラームで起きて判定する。下限の起床が別の仕事に消費されても、下限を過ぎた判定は(タスクが尽きたあとの起床で)1 回行われる(Issue #298。印は meta の `report_hold_judged`)。
   * 成功したら依頼済みの印を書く(以降は呼ばない)。失敗は固定の警告だけを残し、印を書かない(次の起床で再び依頼する)。
   */
  readonly requestReport?: (kaisaiDate: string) => Promise<void>;
  /**
   * 馬場の API の取得口(Issue #294〈#293-A〉。DO のラッパが、Worker の secret `BABA_API_URL` から作る)。**URL そのものは持たない**(本文を返す関数だけ。URL が状態・ログに入る経路を作らない)。
   * **未登録・形式不正なら渡さない**: 取得の段階全体が無効(印も書かず、アラームの候補にもしない)。`babaStore` と両方があるときだけ動く。
   */
  readonly fetchBaba?: BabaFetcher;
  /** 馬場の API の取得の試み・結果の保存先(本番は D1 の `baba_fetches`・`baba_conditions`〈migration 0017〉)。 */
  readonly babaStore?: BabaStore;
  /**
   * 貯めた当日の馬場の値の読み出し口(Issue #295。本番は `D1BabaStore.load`)。**発走前の計算ステップだけ**が、そのレースの開催日 × 場コードの値を読み、LLM のプロンプトとスナップショットに渡す
   * (中央のレースで、LLM を使うときだけ。netkeiba には出ない)。無い構成は読まない(従来どおり)。読み出しの失敗は握って値なしで続け、警告は固定の語だけ(例外の文面は出さない)。
   */
  readonly babaReader?: BabaReader;
}

export interface ScheduleInput {
  readonly raceId: string;
  readonly kaisaiDate: string;
  /** 省略時は `morning`。 */
  readonly mode?: TaskMode;
}

export type ScheduleResult =
  | { readonly accepted: true; readonly raceId: string; readonly mode: TaskMode; readonly status: "queued" }
  | { readonly accepted: false; readonly raceId: string; readonly mode: TaskMode; readonly status: TaskStatus };

/** 一括予約(Issue #251)の入力。`mode` は必須(省略時の既定を持たない=課金を伴う操作で、意図しない種類を積まない)。 */
export interface ScheduleManyInput {
  readonly kaisaiDate: string;
  readonly mode: TaskMode;
  /** 1〜{@link MAX_BULK_RACES} 件、重複なし。順序は結果に保つ。 */
  readonly raceIds: readonly string[];
}

/** 一括予約のレースごとの結果。実行中(queued・fetched)は積まず、いまの状態を返す。 */
export type ScheduleManyEntry =
  | { readonly raceId: string; readonly result: "accepted" }
  | { readonly raceId: string; readonly result: "already-running"; readonly status: "queued" | "fetched" };

export type ScheduleManyResult =
  | { readonly accepted: true; readonly mode: TaskMode; readonly results: readonly ScheduleManyEntry[] }
  /** 1 日の上限({@link MAX_TASKS_PER_DAY})を超えるので、**何も積まなかった**(全か無か)。`used` はいまの行数、`needed` は新しく必要な行数。 */
  | { readonly accepted: false; readonly reason: "day-cap"; readonly limit: number; readonly used: number; readonly needed: number };

export type StepOutcome =
  /** 実行する仕事が無かった。`purged` は、掃除専用のアラームで消したキャッシュの行数(掃除をしたときだけ)。 */
  | { readonly kind: "idle"; readonly purged?: number }
  | {
      readonly kind: "ran";
      readonly raceId: string;
      readonly mode: TaskMode;
      readonly step: "fetch" | "compute";
      readonly result: "ok" | "retry" | "failed";
    }
  /** 事前分析の計画の段階の1ステップ(Issue #203。`mode: "plan"`。形と各値の意味は {@link PlanStepOutcome})。 */
  | PlanStepOutcome
  /** 通知の送信(Issue #205。`mode: "notify"`。形と各値の意味は {@link NotifyStepOutcome})。 */
  | NotifyStepOutcome
  /** 結果の取り込みの 1 ステップ(Issue #208。`mode: "result"`。形と各値の意味は {@link ResultStepOutcome})。 */
  | ResultStepOutcome
  /** 締切の直前の再計算の 1 ステップ(Issue #338。`mode: "close"`。形と各値の意味は {@link CloseStepOutcome})。 */
  | CloseStepOutcome
  /** 馬場の API の取得(Issue #294。`mode: "baba"`)。`raceId` は開催日。`ok` は当日の競馬場の値を D1 に保存した、`retry` は試みの記録(D1)の失敗で再試行待ち、`failed` はこの日は取得しない(再試行しない)。 */
  | BabaStepOutcome;

/** 通知の1件の状態(状態から読める。失敗の分類だけで、URL・メッセージ・本文は持たない。`getNotifications`)。 */
export interface NotificationRecord {
  /** `race:<raceId>` か `summary`。 */
  readonly key: string;
  readonly kind: NotifyKind;
  readonly state: NotifyState;
  /** completed の通知の分析 id(それ以外は null)。 */
  readonly analysisId: number | null;
  /** 失敗の分類(`http-<status>`・`timeout`・`rate-limited`・`network`・`other`・`build`)。失敗でなければ null。 */
  readonly errorClass: string | null;
  readonly updatedAt: number;
}

/** 一覧を取る対象: 中央(race.netkeiba.com)・地方(nar.netkeiba.com)。 */
export type RaceListVenue = "central" | "nar";

/**
 * 一覧の取得の失敗の理由(gate の文面は載せない。Issue #183)。`blocked`: ブレーカーが開いている・許可リスト外(待つしかない)/
 * `busy`: gate の待ち行列が上限(少し待って再読み込み)/ `failed`: それ以外(通信の失敗・netkeiba のエラー応答・タイムアウト)。
 */
export type RaceListFailureReason = "blocked" | "busy" | "failed";

export type RaceListResult =
  | { readonly ok: true; readonly races: readonly RaceListEntry[] }
  | { readonly ok: false; readonly reason: RaceListFailureReason };

export interface BoardRace {
  readonly raceId: string;
  readonly mode: TaskMode;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly error: string | null;
  readonly queuedAt: number;
  readonly updatedAt: number;
  /** 朝の prior を計算した時刻(無ければ null。発走前のタスクは常に null)。 */
  readonly computedAt: number | null;
  /** 発走前の分析で保存した D1 の分析 id(未保存・朝のタスクは null)。 */
  readonly analysisId: number | null;
  /** R2 の詳細の状態(`stored`・`failed`・`skipped`。未保存・朝のタスクは null)。 */
  readonly detail: "stored" | "failed" | "skipped" | null;
  /** 保存した子の行(馬・買い目)の件数が、保存したレコードと一致したか(確認していなければ null)。 */
  readonly childrenOk: boolean | null;
}

export interface Board {
  readonly kaisaiDate: string | null;
  readonly races: readonly BoardRace[];
}

export interface MorningPrior {
  readonly computedAt: number;
  readonly result: CloudAnalysisResult;
}

/** 計画の依頼の結果。受理(`accepted: true`)か、すでに依頼済み(`already-planned`。cron の重複配信など)。 */
export type RequestPlanResult = { readonly accepted: true } | { readonly accepted: false; readonly reason: "already-planned" };

/** 事前分析のまとめ(#205)のための、計画の読み取り(状態は変えない)。 */
export interface PlanProgress {
  /** `none`: 依頼の前 / `pending`: 依頼後〜確定の前 / `done`: 確定済み。 */
  readonly stage: "none" | "pending" | "done";
  readonly requestedAt: number | null;
  readonly finalizedAt: number | null;
  /** 計画時点で決めた offset(分)。確定の前は null。 */
  readonly offsetMinutes: number | null;
  /** `default-fallback` は、設定を読めず既定値で計画したことを表す(事前分析のまとめに「既定値で計画した」と出すため)。 */
  readonly offsetSource: "settings" | "default-fallback" | null;
  readonly venues: readonly {
    readonly venue: PlanVenue;
    readonly state: "pending" | "ok" | "failed";
    readonly attempts: number;
    readonly reason: string | null;
    /** 一覧の件数(取れていなければ null)。 */
    readonly listed: number | null;
    /** 自動実行の対象になった件数(確定の前は null)。 */
    readonly targeted: number | null;
  }[];
  readonly rows: readonly {
    readonly raceId: string;
    readonly venue: PlanVenue;
    readonly venueName: string | null;
    readonly raceNumber: number | null;
    readonly raceName: string | null;
    readonly grade: string | null;
    readonly startTime: string | null;
    readonly dueMs: number | null;
    readonly disposition: "scheduled" | "immediate" | "skip";
    readonly skipReason: PlanSkipReason | null;
    readonly state: "planned" | "promoted" | "skipped";
    /** 同じレースの morning タスクの状態(積んでいなければ null)。 */
    readonly morning: TaskStatus | null;
  }[];
  /**
   * 事前分析がすべて終わったか: 確定済みで、計画の行に対する morning がすべて終端(done・failed)。**一部が failed でも true**。morning を積んでいない行(skipped)は数えない。
   * 確定の前は false。
   */
  readonly morningAllTerminal: boolean;
}

/**
 * 自動実行の各レースの結果(Issue #204 G-C2。#205 の通知が状態から作るための読み取り。状態は変えない)。`stage` が `done`(確定済み)でなければ `results` は空。
 * 結果の種類と理由は `auto-run-result.ts`({@link AutoRunOutcome})。通知に出すか・どう出すかは決めない(#205 の持ち分)。
 */
export interface AutoRunResults {
  readonly stage: "none" | "pending" | "done";
  readonly finalizedAt: number | null;
  readonly results: readonly {
    readonly raceId: string;
    readonly venue: PlanVenue;
    readonly venueName: string | null;
    readonly raceNumber: number | null;
    readonly raceName: string | null;
    readonly grade: string | null;
    readonly startTime: string | null;
    readonly dueMs: number | null;
    readonly outcome: AutoRunOutcome;
  }[];
}

/** 結果の取り込みの依頼(Issue #208)の結果。件数だけ(レースIDは返さない)。 */
export interface RequestResultImportResult {
  /** 積んだ(新しい行、または前の日の依頼の行の積み直し)レースの数。 */
  readonly accepted: number;
  readonly ignored: {
    /** 進行中(queued)のため積み直さなかった。 */
    readonly inProgress: number;
    /** 同じ日に取り込み済みのため積み直さなかった。 */
    readonly imported: number;
    /** 同じ日に諦めた(1 日 1 回)ため積み直さなかった。 */
    readonly alreadyToday: number;
  };
}

/** 結果の取り込みの観測(Issue #208。状態は変えない。固定の語と数値だけで、メッセージ・例外の文面は持たない)。 */
export interface ResultImportProgress {
  readonly total: number;
  readonly queued: number;
  readonly imported: number;
  readonly gaveUp: number;
  readonly races: readonly {
    readonly raceId: string;
    readonly state: ResultState;
    readonly attempts: number;
    readonly deferrals: number;
    /** 依頼を受けた日(JST の暦日 YYYYMMDD)。 */
    readonly requestedOn: string;
    /** 次に試みる時刻(`queued` のときだけ。それ以外は null)。 */
    readonly nextTryAt: number | null;
    readonly lastClass: ResultClass | null;
    readonly updatedAt: number;
  }[];
}

/**
 * gate への呼び出しを直列にする(FIFO。前の呼び出しが失敗しても次は進む)。**GET(`fetchRaw`)と POST(`postRaw`。Issue #181)は同じ連鎖**に通す
 * (POST だけが先に行かない)。元の gate に `postRaw` が無ければ、直列化した gate にも付けない(POST は未対応のまま)。
 */
export function serializeGate(gate: GateLike): GateLike {
  let tail: Promise<unknown> = Promise.resolve();
  const chain = <T>(call: () => Promise<T>): Promise<T> => {
    const run = tail.then(call);
    tail = run.catch(() => undefined);
    return run;
  };
  const inner = gate.postRaw?.bind(gate);
  return {
    fetchRaw: (url) => chain(() => gate.fetchRaw(url)),
    ...(inner === undefined ? {} : { postRaw: (request) => chain(() => inner(request)) }),
  };
}

/** 計算ステップで、オッズのキャッシュが今回の取得より古い(前回の実行の残り)ときに投げる。 */
class StaleOddsError extends Error {
  constructor(url: string) {
    super(`オッズのキャッシュが今回の取得より前のものです(使いません): ${url}`);
    this.name = "StaleOddsError";
  }
}

/** 計算ステップで前走の条件(Issue #421 段階 1-b)がキャッシュに無いときのログの文面。取得先の URL を含まない。画面向けの警告には出さない。 */
const PREV_CONDITIONS_MISSING_MESSAGE = "前走の条件は取得済みのキャッシュに無いため、記録に載せていません(取得ステップの失敗、またはキャッシュの期限切れ。分析の結果には影響しません)";

const cacheOnlyFetcher: TextFetcher = {
  fetchText: async (url) => {
    throw new CacheMissError(url);
  },
};

/**
 * 計算ステップが残す、取得時の警告の文面(Issue #375)。騎手・調教師の成績が計算ステップのキャッシュ・保存先に無かった警告は、`scrapeRace` の文面が「取得に失敗しました」だが、
 * 計算ステップは**取得ステップの結果を区別できない**(取得の失敗も、1 回の取得の呼び出しの上限〈騎手と調教師で共有〉で取らなかったのも、同じ `CacheMissError` になる)。
 * そこで、どちらともとれる文面に書き換える(URL は出さない)。取得ステップの警告そのものは変えない。ほかの警告はそのまま。
 */
function describeScrapeWarning(w: { readonly kind: string; readonly message: string; readonly jockeyId?: string; readonly trainerId?: string }): string {
  const id = w.kind === "騎手" ? w.jockeyId : w.kind === "調教師" ? w.trainerId : undefined;
  if (id === undefined || !w.message.includes(CACHE_MISS_HEAD)) {
    return w.message;
  }
  return `${w.kind}ID ${id} の成績は保存先に無いため補正なし(取得の失敗、または取得の上限で取らなかった。次回以降のレースの取得で取る)`;
}

/** 一覧の取得の失敗(`HttpError`)を、返す理由にまとめる(gate の文面は使わない)。 */
function raceListFailureReason(error: HttpError): RaceListFailureReason {
  if (error.cause instanceof GateRefusedError) {
    if (error.cause.reason === "blocked" || error.cause.reason === "disallowed-url") {
      return "blocked";
    }
    if (error.cause.reason === "queue-full") {
      return "busy";
    }
  }
  return "failed";
}

interface TaskRow {
  race_id: string;
  mode: TaskMode;
  status: TaskStatus;
  attempts: number;
  compute_attempts: number;
  queued_at: number;
  updated_at: number;
  error: string | null;
  analyzed_at: number | null;
  fetch_started_at: number | null;
  settings_json: string | null;
  analysis_id: number | null;
  detail: "stored" | "failed" | "skipped" | null;
  children_ok: number | null;
}

const TASK_MODES: readonly TaskMode[] = ["morning", "pre_race"];

export class RaceDayCore {
  private readonly sql: SqlLike;
  private readonly now: () => number;
  private readonly setAlarm: (at: number) => void | Promise<void>;
  private readonly onWarn: (message: string) => void;
  private readonly sink: AnalysisSink | undefined;
  private readonly loadSettings: (() => Promise<CloudSettings>) | undefined;
  private readonly jockeyStore: JockeyResultsStore | undefined;
  private readonly trainerStore: TrainerResultsStore | undefined;
  private readonly horseRunsStore: HorseRunsStore | undefined;
  private readonly raceConditionsStore: RaceConditionsStore | undefined;
  private readonly llm: CloudLlm | undefined;
  /** 分析モデルの選択(`analysisModel`)に応じたモデルの自動選択(系統ごとの取得結果・降格を、この DO の寿命の間だけ覚える。`llm.lister` が無ければ undefined。Issue #158)。 */
  private readonly modelSelectorFor: ModelSelectorFor | undefined;
  private readonly plan: PlanStore;
  /** 地方三連単の軸ごとの取得(別のアラームの段階)の進み具合の表(Issue #283。新しい表だけ。既存の表には ALTER しない)。 */
  private readonly narTrifecta: NarTrifectaStore;
  /** 締切の直前の再計算の表(Issue #338。新しい表だけ)。 */
  private readonly close: CloseStore;
  /** 締切の直前の再計算の段階(手順。表は `close`)。コンストラクタの最後に作る。 */
  private readonly closeStage: CloseStage;
  /** 日報の時刻の下限の段階(Issue #291・#298。Issue #399〈R-9b〉で切り出した。値は meta に持つ)。コンストラクタの最後に作る。 */
  private readonly reportHold: ReportHoldStage;
  /** 通知の表(Issue #205。新しい表だけ)。 */
  private readonly notifyStore: NotifyStore;
  /** Discord への通知の段階(Issue #205。Issue #399〈R-9c〉で切り出した。表は `notifyStore`)。コンストラクタの最後に作る。 */
  private readonly notifyStage: NotifyStage;
  /** 結果の取り込みの段階(Issue #208。Issue #399〈R-9d〉で切り出した。表は `results`)。コンストラクタの最後に作る。 */
  private readonly resultStage: ResultStage;
  /** 計画の昇格の段階(Issue #203・#204。Issue #399〈R-9e の e2〉で切り出した。表は `plan`)。コンストラクタの最後に作る。 */
  private readonly promoteStage: PromoteStage;
  /** 計画の一覧と確定の段階(Issue #203。Issue #399〈R-9e の e1〉で切り出した。表は `plan`)。コンストラクタの最後に作る。 */
  private readonly planStage: PlanStage;
  /** 救済(23 時の再実行)と、救済の後の失敗の判定の段階(Issue #249。Issue #399〈R-9e の e3〉で切り出した。表は `plan`・`notifyStore`)。コンストラクタの最後に作る。 */
  private readonly rescueStage: RescueStage;
  /** Discord への送信。無ければ(webhook が無効)通知の仕組み全体が無効。 */
  private readonly notifier: DiscordNotifier | undefined;
  private readonly appBaseUrl: string | undefined;
  /** 結果の取り込みの表(Issue #208。新しい表だけ)。 */
  private readonly results: ResultImportStore;
  private readonly baba: BabaStage;
  private readonly babaReader: BabaReader | undefined;
  /** 結果の保存先。無ければ結果の仕組み全体が無効。 */
  private readonly resultStore: ResultStoreDeps | undefined;
  /** 日報の作成の依頼(Issue #235)。無ければ依頼しない。 */
  private readonly requestReport: ((kaisaiDate: string) => Promise<void>) | undefined;
  /** gate 経由・キャッシュなしの取得(結果のページ用。`networkFetcher` と同じ直列化した gate を使う)。 */
  private readonly httpClient: HttpClient;
  private readonly cache: DoSqlCacheStore;
  private readonly networkFetcher: CachedFetcher;
  private readonly cacheOnly: CachedFetcher;
  /** 取得中の一覧(キーは venue と開催日)。同じ一覧の同時の呼び出しを1本の取得にまとめる(終わったら消す。失敗も保持しない)。 */
  private readonly listInFlight = new Map<string, Promise<readonly RaceListEntry[]>>();

  constructor(deps: RaceDayDeps) {
    this.sql = deps.sql;
    this.now = deps.now;
    this.setAlarm = deps.setAlarm;
    // ログ(onWarn)に出る文面は、すべて鍵の形(`sk-ant-`)を伏せてから渡す(Issue #255)。例外文をそのまま載せる警告が複数あり(`errorMessage(error)`)、
    // 個々の呼び出しで伏せ忘れないよう、ここで 1 箇所だけ包む。下位へ渡す onWarn(モデル選択・キャッシュ・ゲートの HTTP クライアント)も、この包んだ関数を使う。
    const onWarn = (message: string): void => deps.onWarn(redactSecrets(message));
    this.onWarn = onWarn;
    this.sink = deps.sink;
    this.loadSettings = deps.loadSettings;
    this.jockeyStore = deps.jockeyStore;
    this.trainerStore = deps.trainerStore;
    this.horseRunsStore = deps.horseRunsStore;
    this.raceConditionsStore = deps.raceConditionsStore;
    this.llm = deps.llm;
    this.modelSelectorFor = deps.llm === undefined ? undefined : createCloudModelSelectors(deps.llm, onWarn);
    // ⚠️ スキーマ変更の仕組みは無い: DO の SQLite の表は `CREATE TABLE IF NOT EXISTS` だけで作る(既存の表に列を足す処理は無い)。
    // 本番の RaceDay は未デプロイなので、今は列を足してよい。**最初の本番デプロイのあとに列を足すときは、`ALTER TABLE ... ADD COLUMN` を
    // ここに足すこと**(足さないと、既に作られた表に列が無いまま INSERT/SELECT が落ちる)。
    this.sql.exec("CREATE TABLE IF NOT EXISTS race_day_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // タスクは (race_id, mode) ごと。mode: morning(朝の取得と prior)・pre_race(発走前の分析。Issue #178)。
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_tasks (
         race_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'morning', status TEXT NOT NULL, attempts INTEGER NOT NULL,
         compute_attempts INTEGER NOT NULL DEFAULT 0, queued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT,
         analyzed_at INTEGER, fetch_started_at INTEGER, settings_json TEXT, analysis_id INTEGER, detail TEXT, children_ok INTEGER,
         PRIMARY KEY (race_id, mode))`,
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS race_day_morning_prior (race_id TEXT PRIMARY KEY, computed_at INTEGER NOT NULL, result_json TEXT NOT NULL)",
    );
    // 発走前の分析の LLM の応答の記録(Issue #194。新しい表なので ALTER は不要)。
    SqlLlmResponseStore.ensureTable(this.sql);
    // 事前分析の計画の表(Issue #203。新しい表だけ。既存の表には ALTER しない)。
    this.plan = new PlanStore(this.sql);
    // 地方三連単の段階の表(Issue #283。新しい表だけ。既存の表には ALTER しない)。
    this.narTrifecta = new NarTrifectaStore(this.sql);
    // 締切の直前の再計算の表(Issue #338。新しい表だけ。既存の表には ALTER しない)。
    this.close = new CloseStore(this.sql);
    // 通知の表(Issue #205。新しい表だけ。既存の表には ALTER しない)。
    this.notifyStore = new NotifyStore(this.sql);
    this.notifier = deps.notifier;
    this.appBaseUrl = deps.appBaseUrl;
    // 結果の取り込みの表(Issue #208。新しい表だけ。既存の表には ALTER しない)。
    this.results = new ResultImportStore(this.sql);
    this.resultStore = deps.resultStore;
    this.requestReport = deps.requestReport;
    // 馬場の API の取得(Issue #294)。メタは既存の race_day_meta(新しい表は無い)。取得口・保存先が無ければ段階全体が無効。
    this.babaReader = deps.babaReader;
    this.baba = new BabaStage({
      sql: this.sql,
      now: this.now,
      fetcher: deps.fetchBaba,
      store: deps.babaStore,
      onWarn,
      facts: () => ({
        kaisaiDate: this.metaGet("kaisai_date"),
        planFinalized: this.plan.finalizedAt() !== null,
        centralListed: this.plan.centralListed(),
      }),
      retryDelayMs: RETRY_DELAY_MS,
      maxClaimAttempts: MAX_ATTEMPTS,
    });
    this.cache = new DoSqlCacheStore({ sql: this.sql, now: this.now, onWarn: this.onWarn });
    // RaceDay から gate への呼び出しは直列(同時に1本)。HttpClient は間隔 0・再試行 0(間隔制御は gate だけが行う)。
    // 結果のページは同じ HttpClient(同じ直列化した gate)を、キャッシュを通さずに使う(DO の SQLite に結果のページを溜めない。Issue #208)。
    const httpClient = createGateHttpClient(serializeGate(deps.gate), { onWarn });
    this.httpClient = httpClient;
    this.networkFetcher = new CachedFetcher({ fetcher: httpClient, cache: this.cache });
    this.cacheOnly = new CachedFetcher({ fetcher: cacheOnlyFetcher, cache: this.cache });
    // 締切の直前の再計算の段階(Issue #399〈R-9a〉。表の作成は上の `CloseStore` だけ。ここでは SQL を出さない)。
    this.closeStage = new CloseStage({
      store: this.close,
      now: this.now,
      onWarn,
      sink: this.sink,
      kaisaiDate: () => this.metaGet("kaisai_date"),
      networkFetcher: this.networkFetcher,
      cacheOnly: this.cacheOnly,
      cache: this.cache,
    });
    // 日報の時刻の下限の段階(Issue #399〈R-9b〉。表は無く、`race_day_meta` の 3 キーだけ。ここでは SQL を出さない)。
    this.reportHold = new ReportHoldStage({
      sql: this.sql,
      now: this.now,
      onWarn,
      metaGet: (key) => this.metaGet(key),
      hasResultStore: this.resultStore !== undefined,
      hasRequestReport: this.requestReport !== undefined,
      getRaceList: (kaisaiDate, venue) => this.getRaceList(kaisaiDate, venue),
      maxAttempts: MAX_ATTEMPTS,
    });
    // Discord への通知の段階(Issue #399〈R-9c〉。表の作成は上の `NotifyStore` だけ。ここでは SQL を出さない)。
    this.notifyStage = new NotifyStage({
      store: this.notifyStore,
      notifier: this.notifier,
      appBaseUrl: this.appBaseUrl,
      now: this.now,
      onWarn,
      metaGet: (key) => this.metaGet(key),
      getAutoRunResults: () => this.getAutoRunResults(),
      getPlanProgress: () => this.getPlanProgress(),
      planRow: (raceId) => this.plan.planRow(raceId),
      isAutoTask: (task) => this.isAutoTask(task),
    });
    // 結果の取り込みの段階(Issue #399〈R-9d〉。表の作成は上の `ResultImportStore` だけ。ここでは SQL を出さない)。取得口は gate 経由・キャッシュなしの `httpClient` だけ(`cache` 系は渡さない)。
    this.resultStage = new ResultStage({
      results: this.results,
      resultStore: this.resultStore,
      httpClient: this.httpClient,
      now: this.now,
      onWarn,
      metaGet: (key) => this.metaGet(key),
    });
    // 計画の昇格の段階(Issue #399〈R-9e の e2〉。表の作成は上の `PlanStore` だけ。ここでは SQL を出さない)。D1 は手動の分析の確認(`findRecentByRace`)だけを渡し、`setAlarm` 系・取得口は渡さない。
    this.promoteStage = new PromoteStage({
      plan: this.plan,
      sink: this.sink,
      loadSettings: this.loadSettings,
      now: this.now,
      onWarn,
      task: (raceId, mode) => this.task(raceId, mode),
      taskCount: () => this.taskCount(),
      enqueueTask: (raceId, mode, now) => this.enqueueTask(raceId, mode, now),
      maxTasksPerDay: MAX_TASKS_PER_DAY,
      manualDuplicateWindowMs: MANUAL_DUPLICATE_WINDOW_MS,
    });
    // 計画の一覧と確定の段階(Issue #399〈R-9e の e1〉。表の作成は上の `PlanStore` だけ。ここでは SQL を出さない)。一覧の取得は本体の `getRaceList` だけを通し、gate・キャッシュ系・`setAlarm` 系は渡さない。
    this.planStage = new PlanStage({
      plan: this.plan,
      now: this.now,
      onWarn,
      metaGet: (key) => this.metaGet(key),
      getRaceList: (kaisaiDate, venue) => this.getRaceList(kaisaiDate, venue),
      loadSettings: this.loadSettings,
      task: (raceId, mode) => this.task(raceId, mode),
      taskCount: () => this.taskCount(),
      enqueueTask: (raceId, mode, now) => this.enqueueTask(raceId, mode, now),
      enqueueSameDayResults: (kaisaiDate, nowMs) => this.enqueueSameDayResults(kaisaiDate, nowMs),
      maxAttempts: MAX_ATTEMPTS,
      retryDelayMs: RETRY_DELAY_MS,
      maxTasksPerDay: MAX_TASKS_PER_DAY,
    });
    // 救済の段階(Issue #399〈R-9e の e3〉。表の作成は上の `PlanStore`・`NotifyStore` だけ)。通知は材料(`putReady`)を積むだけで、送信の口(`notifier`)は渡さず、有無だけを値で渡す。`setAlarm` 系・取得口・キャッシュ系も渡さない。
    this.rescueStage = new RescueStage({
      plan: this.plan,
      sql: this.sql,
      now: this.now,
      onWarn,
      metaGet: (key) => this.metaGet(key),
      notifierEnabled: this.notifier !== undefined,
      notifyStore: this.notifyStore,
      getPlanProgress: () => this.getPlanProgress(),
      enqueueTask: (raceId, mode, now) => this.enqueueTask(raceId, mode, now),
    });
  }

  // ---- 状態の読み書き ----

  private metaGet(key: string): string | null {
    const rows = this.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
    return rows[0]?.value ?? null;
  }

  private task(raceId: string, mode: TaskMode): TaskRow | null {
    const rows = this.sql.exec("SELECT * FROM race_day_tasks WHERE race_id = ? AND mode = ?", raceId, mode).toArray() as TaskRow[];
    return rows[0] ?? null;
  }

  private updateTask(task: Pick<TaskRow, "race_id" | "mode">, status: TaskStatus, attempts: number, error: string | null): void {
    this.sql.exec(
      "UPDATE race_day_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE race_id = ? AND mode = ?",
      status,
      attempts,
      error,
      this.now(),
      task.race_id,
      task.mode,
    );
  }

  /** タスクの追加の列(発走前の分析の状態)を更新する。列名は固定の集合だけ(呼び出し側のコードで決まる値)。 */
  private setTaskFields(task: Pick<TaskRow, "race_id" | "mode">, fields: Partial<Pick<TaskRow, "compute_attempts" | "analyzed_at" | "fetch_started_at" | "settings_json" | "analysis_id" | "detail" | "children_ok">>): void {
    for (const [column, value] of Object.entries(fields)) {
      this.sql.exec(`UPDATE race_day_tasks SET ${column} = ?, updated_at = ? WHERE race_id = ? AND mode = ?`, value ?? null, this.now(), task.race_id, task.mode);
    }
  }

  // ---- 公開(RPC)----

  /**
   * レースの事前分析(`morning`。既定)または発走前の分析(`pre_race`)を予約する。予約だけをして戻る(取得はしない)。
   * @throws 無効な raceId・開催日・mode、DO の開催日と違う日、raceId の年と開催日の年が違う(地方は月日も)、1日の上限、発走前の分析の保存先が無い構成
   */
  async schedule(input: ScheduleInput): Promise<ScheduleResult> {
    const { raceId, kaisaiDate, mode, pinned } = this.checkScheduleTarget(input.mode ?? "morning", input.raceId, input.kaisaiDate);
    if (pinned === null) {
      this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('kaisai_date', ?)", kaisaiDate);
    }
    const existing = this.task(raceId, mode);
    if (existing !== null && (existing.status === "queued" || existing.status === "fetched")) {
      return { accepted: false, raceId, mode, status: existing.status };
    }
    if (existing === null) {
      const count = this.taskCount();
      if (count >= MAX_TASKS_PER_DAY) {
        throw new Error(`この開催日に受け付けられるレース数の上限(${MAX_TASKS_PER_DAY})に達しています`);
      }
    }
    if (mode === "pre_race") {
      // 手動が pre_race を積み直す: 自動の印を消す(手動が所有権を取る。自動のガードを受けず、結果も自動のものとして読まれない)。
      this.plan.clearAuto(raceId);
    }
    this.enqueueTask(raceId, mode, this.now());
    await this.rearm();
    return { accepted: true, raceId, mode, status: "queued" };
  }

  /**
   * 一括予約(Issue #251。管理者の「競馬場ごとに一括実行」が `POST /api/analyses/run/bulk` 経由で呼ぶ)。同じ開催日の複数のレースに、同じ種類(`mode`)のタスクを積む。予約だけをして戻る(取得はアラームの中)。
   * レースごとの規則は {@link RaceDayCore.schedule} と同じ: 実行中(queued・fetched)は積まずに `already-running`(いまの状態つき)、完了済み・失敗・新規は queued で積む(作り直す)。
   * pre_race を積み直すレースは、自動の印を消す。
   * **1 日の上限は全か無か**: 新しく必要な行(その (レース, mode) の行がまだ無い、積むレース)の数 + いまの行数が {@link MAX_TASKS_PER_DAY} を超えるなら、**何も積まず** `day-cap` を返す。
   * **検証(件数・重複・各 ID・開催日・mode・保存先)は、何かを書く前にすべて行う**(途中の無効な ID で、手前のレースだけが積まれることがない)。アラームを張るのは最後に 1 回(`rearm`)。
   * @throws 空の一覧・{@link MAX_BULK_RACES} 超過・重複、`schedule` が拒否する入力(無効な raceId・開催日・mode、DO の開催日と違う日、年の不整合、pre_race の保存先が無い構成)
   */
  async scheduleMany(input: ScheduleManyInput): Promise<ScheduleManyResult> {
    const ids = input.raceIds;
    if (ids.length === 0) {
      throw new Error("race_ids は 1 件以上で指定してください");
    }
    if (ids.length > MAX_BULK_RACES) {
      throw new Error(`一括で受け付けるレース数は ${MAX_BULK_RACES} 件以下です(渡された件数: ${ids.length})`);
    }
    // 検証は書き込みの前に全件分。各レースの検証は schedule と同じ関数(mode・開催日・DO の固定日・年の整合・保存先)。
    const targets = ids.map((raw) => this.checkScheduleTarget(input.mode, raw, input.kaisaiDate));
    const { mode, kaisaiDate, pinned } = targets[0]!;
    const raceIds = targets.map((t) => t.raceId);
    if (new Set(raceIds).size !== raceIds.length) {
      throw new Error("race_ids に重複があります");
    }
    const existing = raceIds.map((raceId) => this.task(raceId, mode));
    const needed = existing.filter((row) => row === null).length;
    const used = this.taskCount();
    if (used + needed > MAX_TASKS_PER_DAY) {
      // 何も書かない(開催日の固定も)。
      return { accepted: false, reason: "day-cap", limit: MAX_TASKS_PER_DAY, used, needed };
    }
    if (pinned === null) {
      this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('kaisai_date', ?)", kaisaiDate);
    }
    const now = this.now();
    const results: ScheduleManyEntry[] = [];
    raceIds.forEach((raceId, i) => {
      const row = existing[i]!;
      if (row !== null && (row.status === "queued" || row.status === "fetched")) {
        results.push({ raceId, result: "already-running", status: row.status });
        return;
      }
      if (mode === "pre_race") {
        this.plan.clearAuto(raceId);
      }
      this.enqueueTask(raceId, mode, now);
      results.push({ raceId, result: "accepted" });
    });
    await this.rearm();
    return { accepted: true, mode, results };
  }

  /**
   * `schedule`・`scheduleMany` が共有する入力の検証(**何も書かない**)。mode → raceId → 開催日 → DO の固定された開催日との一致 → 年(地方は月日)の整合 → pre_race の保存先、の順。
   * 入口(handler.ts)でも確かめているが、RPC を直接呼ばれても守る。`pinned` は、固定済みの開催日(未固定なら null。固定は呼び出し側が検証のあとに行う)。
   */
  private checkScheduleTarget(mode: TaskMode, rawRaceId: string, rawKaisaiDate: string): { raceId: string; kaisaiDate: string; mode: TaskMode; pinned: string | null } {
    if (!TASK_MODES.includes(mode)) {
      throw new Error(`mode は morning か pre_race です(渡された値: ${String(mode).slice(0, 32)})`);
    }
    const raceId = parseRaceId(rawRaceId);
    const kaisaiDate = parseKaisaiDate(rawKaisaiDate);
    const pinned = this.metaGet("kaisai_date");
    if (pinned !== null && pinned !== kaisaiDate) {
      throw new Error(`この DO は開催日 ${pinned} 専用です(渡された開催日: ${kaisaiDate})`);
    }
    // 年(どのレースでも)・月日(地方のレースID。中央は日付を含まない)の整合。
    const consistent = checkRaceDate(raceId, kaisaiDate);
    if (!consistent.ok) {
      throw new Error(consistent.message);
    }
    if (mode === "pre_race" && (this.sink === undefined || this.loadSettings === undefined)) {
      throw new Error("発走前の分析の保存先(D1・R2)・設定が、この構成にはありません");
    }
    return { raceId, kaisaiDate, mode, pinned };
  }

  /**
   * タスクを queued で積む(新しい実行として作り直す)。**検証・上限・実行中の確認は呼び出し側**(`schedule`・計画の確定・期限の昇格)。アラームは張らない(呼び出し側が `rearm` する)。
   */
  private enqueueTask(raceId: string, mode: TaskMode, now: number): void {
    // 新しい実行: 前の実行の LLM の応答の記録も消す(新しい分析は、あらためて LLM に送る。前の記録を再生しない)。
    SqlLlmResponseStore.clear(this.sql, raceId, mode);
    if (mode === "pre_race") {
      // 新しい実行: 前の実行の締切の再計算(入力・回の行)も消す(古い分析に紐づく再計算を起こさない。新しい分析が保存されたときに積み直す。Issue #338)。
      this.close.clear(raceId);
    }
    // 新しい実行: 発走前の分析の状態(分析時刻・設定のスナップショット・保存結果)も作り直す(前の実行の保存結果を、新しい実行の結果として扱わない)。
    this.sql.exec(
      `INSERT INTO race_day_tasks (race_id, mode, status, attempts, compute_attempts, queued_at, updated_at, error, analyzed_at, fetch_started_at, settings_json, analysis_id, detail, children_ok)
       VALUES (?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(race_id, mode) DO UPDATE SET status = 'queued', attempts = 0, compute_attempts = 0, queued_at = excluded.queued_at, updated_at = excluded.updated_at,
         error = NULL, analyzed_at = NULL, fetch_started_at = NULL, settings_json = NULL, analysis_id = NULL, detail = NULL, children_ok = NULL`,
      raceId,
      mode,
      now,
      now,
    );
  }

  private taskCount(): number {
    return (this.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks").toArray() as { n: number }[])[0]?.n ?? 0;
  }

  /**
   * 事前分析の計画を依頼する(Issue #203 段階2。cron の `scheduled`〈scheduled.ts。#206〉から呼ぶ入口)。**依頼だけをして戻る**(一覧の取得・確定はアラームの中)。
   * 会場2つ(中央・地方)を pending で作り、アラームを張る。**2回目以降(cron の重複配信・scheduled の再試行)は受理せず、状態を変えない**(`already-planned`)。
   * ただし**アラームは状態から張り直す**(Issue #206 G-E2。1回目が行を書いたあと `setAlarm` で失敗した場合に、再配信でアラームが戻る)。
   * @throws 無効な開催日、DO の開催日と違う日、発走前の分析の保存先・設定が無い構成(pre_race を予約できない計画は作らない)
   */
  async requestPlan(input: { readonly kaisaiDate: string; readonly rescue?: boolean }): Promise<RequestPlanResult> {
    const kaisaiDate = parseKaisaiDate(input.kaisaiDate);
    const pinned = this.metaGet("kaisai_date");
    if (pinned !== null && pinned !== kaisaiDate) {
      throw new Error(`この DO は開催日 ${pinned} 専用です(渡された開催日: ${kaisaiDate})`);
    }
    if (this.sink === undefined || this.loadSettings === undefined) {
      throw new Error("発走前の分析の保存先(D1・R2)・設定が、この構成にはありません");
    }
    if (this.plan.requested()) {
      // Issue #249: 23 時の再実行(rescue)は、21 時に失敗した分を **1 回だけ** 救う。2 回目以降(cron の重複配信)・rescue を渡さない呼び出しは、何もしない(従来の冪等性のまま)。
      if (input.rescue === true) {
        this.rescueStage.rescue();
      }
      // Issue #206(G-E2。#203 の【記録】5): 依頼を書いたあとに `setAlarm` が失敗していると、アラームが無いまま止まる。cron の再配信(または再試行)が来たときに、
      // 状態からアラームを張り直す。`rearm` は状態を変えず、候補が無ければ何もしない(冪等)。
      await this.rearm();
      return { accepted: false, reason: "already-planned" };
    }
    if (pinned === null) {
      this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('kaisai_date', ?)", kaisaiDate);
    }
    this.plan.request(this.now());
    if (input.rescue === true) {
      // 21 時の依頼が全滅していて、23 時の再実行が最初の依頼になった場合。通常どおり受理し、救済の要求(失敗の判定の起点)も記録する。救済する失敗はまだ無い。
      this.plan.markRescueRequested(this.now());
    }
    await this.rearm();
    return { accepted: true };
  }

  /** 事前分析のまとめ(#205)のための、計画の読み取り(状態は変えない)。 */
  getPlanProgress(): PlanProgress {
    const requestedAt = this.plan.requestedAt();
    const finalizedAt = this.plan.finalizedAt();
    const offset = this.plan.offset();
    const rows = this.plan.rowsWithMorning().map((r) => ({
      raceId: r.race_id,
      venue: r.venue,
      venueName: r.venue_name,
      raceNumber: r.race_number,
      raceName: r.race_name,
      grade: r.grade,
      startTime: r.start_time,
      dueMs: r.due_ms,
      disposition: r.disposition,
      skipReason: r.skip_reason,
      state: r.state,
      morning: r.morning as TaskStatus | null,
    }));
    const morningAllTerminal =
      finalizedAt !== null && rows.every((r) => (r.morning === null ? r.state === "skipped" : r.morning === "done" || r.morning === "failed"));
    return {
      stage: requestedAt === null ? "none" : finalizedAt === null ? "pending" : "done",
      requestedAt,
      finalizedAt,
      offsetMinutes: offset === null ? null : offset.minutes,
      offsetSource: offset === null ? null : offset.source,
      venues: this.plan.venueRows().map((v) => ({ venue: v.venue, state: v.state, attempts: v.attempts, reason: v.reason, listed: v.listed, targeted: v.targeted })),
      rows,
      morningAllTerminal,
    };
  }

  /** 自動実行の各レースの結果(Issue #204 G-C2)。状態から読むだけで、何も変えない。 */
  getAutoRunResults(): AutoRunResults {
    const requestedAt = this.plan.requestedAt();
    const finalizedAt = this.plan.finalizedAt();
    const stage = requestedAt === null ? "none" : finalizedAt === null ? "pending" : "done";
    if (stage !== "done") {
      return { stage, finalizedAt, results: [] };
    }
    return {
      stage,
      finalizedAt,
      results: this.plan.rowsWithPreRace().map((r) => ({
        raceId: r.race_id,
        venue: r.venue,
        venueName: r.venue_name,
        raceNumber: r.race_number,
        raceName: r.race_name,
        grade: r.grade,
        startTime: r.start_time,
        dueMs: r.due_ms,
        outcome: classifyAutoRun({
          planState: r.state,
          skipReason: r.skip_reason,
          task:
            r.pre_status === null
              ? null
              : { status: r.pre_status, queuedAt: r.pre_queued_at!, analysisId: r.pre_analysis_id, detail: r.pre_detail, error: r.pre_error },
          marker: r.auto_enqueued_at === null ? null : { enqueuedAt: r.auto_enqueued_at, failReason: r.auto_fail_reason },
        }),
      })),
    };
  }

  /** 通知の一覧(Issue #205 AC-D2: 送信の失敗が状態から読める。状態は変えない。材料の embed・URL・例外の文面は返さない)。 */
  getNotifications(): NotificationRecord[] {
    return this.notifyStore.rows().map((r) => ({ key: r.key, kind: r.kind, state: r.state, analysisId: r.analysis_id, errorClass: r.error_class, updatedAt: r.updated_at }));
  }

  /**
   * 過去の開催日のレースの結果の取り込みを依頼する(Issue #208〈#182-B〉。呼ぶのは `dispatchResultImports`〈result-dispatch.ts。cron の `scheduled` と手動の `POST /api/results/import`〉だけ)。
   * **依頼だけをして戻る**(取得・保存はアラームの中。1 ステップにつき 1 レース)。冪等: 判定は `race-day-result.ts` の表のとおり(進行中・同じ日に取り込み済み・同じ日に諦めた、は積み直さない。
   * 前の日の依頼で諦めた・取り込み済みのレースは、1 日 1 回だけ積み直す)。依頼の日は**この DO の時計**の JST の暦日(cron の重複配信は同じ日になる)。
   * 受理しても拒否しても、アラームは状態から張り直す(`rearm`。冪等)。開催日を pin する(別の日で pin 済みなら拒否)。
   * `winOddsOnly: true`(Issue #259。結果の補完の段階 2): 積んだレースは、実行のとき保存済みの結果の **NULL の列だけ**を埋める。確定の単勝オッズ・人気(`saveWinOdds`)と、取消・除外の記録
   * (`saveScratched`。Issue #270)で、着順・払戻・組合せ払戻を上書きしない。名前は #259 のまま、意味を「NULL の列だけを埋める」に広げた(取得は 1 回のまま)。
   * 印は積んだレースにだけ、依頼のとおりに付け直す(無視されたレースは変えない)。それ以外の判定・上限・取得は通常の依頼と同じ。
   * @throws 結果ストアが無い構成、無効な開催日・レースID、**今日以降の開催日**(当日中の取り込みは対象外)、年・地方の月日の不整合、1 回の件数の上限、1 日の行数の上限(1 件も積まない)
   */
  async requestResultImport(input: { readonly kaisaiDate: string; readonly raceIds: readonly string[]; readonly winOddsOnly?: boolean }): Promise<RequestResultImportResult> {
    if (this.resultStore === undefined) {
      throw new Error("結果の保存先(D1)が、この構成にはありません");
    }
    const kaisaiDate = parseKaisaiDate(input.kaisaiDate);
    const today = jstKaisaiDate(this.now());
    if (kaisaiDate >= today) {
      throw new Error(`結果の取り込みは、今日(${today})より前の開催日だけです(渡された開催日: ${kaisaiDate})`);
    }
    if (!Array.isArray(input.raceIds)) {
      throw new Error("raceIds は配列です");
    }
    if (input.raceIds.length > MAX_RESULT_RACES_PER_REQUEST) {
      throw new Error(`1 回の依頼で受けられるレースの数の上限(${MAX_RESULT_RACES_PER_REQUEST})を超えています`);
    }
    const raceIds = [...new Set(input.raceIds.map((id) => parseRaceId(id)))];
    for (const raceId of raceIds) {
      const consistent = checkRaceDate(raceId, kaisaiDate);
      if (!consistent.ok) {
        throw new Error(consistent.message);
      }
    }
    const pinned = this.metaGet("kaisai_date");
    if (pinned !== null && pinned !== kaisaiDate) {
      throw new Error(`この DO は開催日 ${pinned} 専用です(渡された開催日: ${kaisaiDate})`);
    }
    if (raceIds.length === 0) {
      return { accepted: 0, ignored: { inProgress: 0, imported: 0, alreadyToday: 0 } };
    }
    // 1 日の行数の上限: 新しい行が増える分を先に数え、超えるなら 1 件も積まない(部分的に積まない)。
    const newRows = raceIds.filter((id) => this.results.row(id) === null).length;
    if (this.results.count() + newRows > MAX_RESULT_ROWS_PER_DAY) {
      throw new Error(`この開催日に受け付けられる結果の取り込みの数の上限(${MAX_RESULT_ROWS_PER_DAY})に達しています`);
    }
    if (pinned === null) {
      this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('kaisai_date', ?)", kaisaiDate);
    }
    const now = this.now();
    const ignored = { inProgress: 0, imported: 0, alreadyToday: 0 };
    let accepted = 0;
    for (const raceId of raceIds) {
      const decision = this.results.decide(raceId, today);
      if (decision === "accepted") {
        this.results.enqueue(raceId, today, now);
        this.results.setWinOddsOnly(raceId, input.winOddsOnly === true);
        accepted += 1;
      } else if (decision === "in-progress") {
        ignored.inProgress += 1;
      } else if (decision === "imported") {
        ignored.imported += 1;
      } else {
        ignored.alreadyToday += 1;
      }
    }
    await this.rearm();
    return { accepted, ignored };
  }

  /** 結果の取り込みの観測(Issue #208。`GET /api/plan`。状態は変えない。固定の語と数値だけ)。 */
  getResultImportProgress(): ResultImportProgress {
    const rows = this.results.rows();
    return {
      total: rows.length,
      queued: rows.filter((r) => r.state === "queued").length,
      imported: rows.filter((r) => r.state === "imported").length,
      gaveUp: rows.filter((r) => r.state === "gave_up").length,
      races: rows.map((r) => ({
        raceId: r.race_id,
        state: r.state,
        attempts: r.attempts,
        deferrals: r.deferrals,
        requestedOn: r.requested_on,
        nextTryAt: r.state === "queued" ? r.next_try_at : null,
        lastClass: r.last_class,
        updatedAt: r.updated_at,
      })),
    };
  }

  /** いま送る通知と、次にアラームを張る時刻(状態を変えない読み取り。`rearm` と送信のステップが読むものと同じ)。webhook が無効なら両方 null。 */
  peekNotifyPlan(): NotificationPlan {
    return this.notifyPlan();
  }

  /** その日のレースの状態の一覧(レースID 昇順、同じレースは morning → pre_race)。 */
  getBoard(): Board {
    const rows = this.sql
      .exec(
        `SELECT t.*, p.computed_at
           FROM race_day_tasks t LEFT JOIN race_day_morning_prior p ON p.race_id = t.race_id AND t.mode = 'morning' ORDER BY t.race_id, t.mode`,
      )
      .toArray() as (TaskRow & { computed_at: number | null })[];
    return {
      kaisaiDate: this.metaGet("kaisai_date"),
      races: rows.map((r) => ({
        raceId: r.race_id,
        mode: r.mode,
        status: r.status,
        attempts: r.attempts,
        error: r.error,
        queuedAt: r.queued_at,
        updatedAt: r.updated_at,
        computedAt: r.computed_at,
        analysisId: r.analysis_id,
        detail: r.detail,
        childrenOk: r.children_ok === null ? null : r.children_ok === 1,
      })),
    };
  }

  /**
   * 開催日のレース一覧(Issue #183〈#165-a〉)。取得は朝の取得と同じ gate 経由のキャッシュ(TTL は core の既定 6 時間)で、**同じ一覧の同時の呼び出しは1本にまとめる**。
   * 想定内の失敗(gate の拒否・通信の失敗・HTTP エラー)は例外にせず `{ ok: false, reason }` で返す(gate の文面は載せない。リトライしない)。
   * **開催日は pin しない**(一覧だけ見た日に、掃除で消えない行を残さない)。pin 済みで開催日が違えば throw する。
   *
   * **空の一覧はキャッシュしない**(まだ公開前・開催なしの日の空の結果を 6 時間持つと、公開されても見えないため。見るたびに取りに行くが、gate が間隔・ブレーカーで守る)。
   *
   * ## 掃除のアラーム(単一アラームの共有)
   * 取得した一覧の行は、掃除しないと永久に残る(一覧だけ見た日の DO は、他に起きる理由が無い)。**取得に成功したあと**(await の後)に、**同期的に**判定する:
   *  - `queued`・`fetched` のタスクがあれば何もしない(タスクのアラームを潰さない。タスクが終わるときの {@link armAlarm} が、より後ろの期限を設定する)
   *  - なければ、`purge_due_at` が無いか `一覧の行の fetchedAt + 保持期間 + 余裕` より前のときだけ、その時刻に設定する(前へは戻さない)。
   * 判定から `setAlarm` の呼び出しまでの間に `await` を挟まない(挟むと、その間に入った `schedule` のアラームを潰しうる)。
   * 判定を取得の**前**に置かないのは、取得中(gate の待ちで最大 60 秒)に `schedule` が入りうるため。
   * @throws 無効な開催日・venue、pin 済みの開催日と違う日
   */
  async getRaceList(kaisaiDateInput: string, venue: RaceListVenue): Promise<RaceListResult> {
    if (venue !== "central" && venue !== "nar") {
      throw new Error(`venue は central か nar です(渡された値: ${String(venue).slice(0, 32)})`);
    }
    const kaisaiDate = parseKaisaiDate(kaisaiDateInput);
    const pinned = this.metaGet("kaisai_date");
    if (pinned !== null && pinned !== kaisaiDate) {
      throw new Error(`この DO は開催日 ${pinned} 専用です(渡された開催日: ${kaisaiDate})`);
    }
    const url = venue === "central" ? raceListSubUrl(kaisaiDate) : narRaceListSubUrl(kaisaiDate);
    const flightKey = `${venue}:${kaisaiDate}`;
    let flight = this.listInFlight.get(flightKey);
    if (flight === undefined) {
      const started = this.fetchRaceList(venue, kaisaiDate, url).finally(() => {
        this.listInFlight.delete(flightKey);
      });
      this.listInFlight.set(flightKey, started);
      flight = started;
    }
    let races: readonly RaceListEntry[];
    try {
      races = await flight;
    } catch (error) {
      if (error instanceof HttpError) {
        return { ok: false, reason: raceListFailureReason(error) };
      }
      throw error;
    }
    await this.armPurgeForList(url);
    return { ok: true, races };
  }

  private async fetchRaceList(venue: RaceListVenue, kaisaiDate: ReturnType<typeof parseKaisaiDate>, url: string): Promise<readonly RaceListEntry[]> {
    const deps = { fetcher: this.networkFetcher, now: () => new Date(this.now()) };
    const races = venue === "central" ? await listRaces(kaisaiDate, deps) : await listNarRaces(kaisaiDate, deps);
    if (races.length === 0) {
      this.cache.delete(url);
    }
    return races;
  }

  /** 一覧の行の掃除を、掃除専用のアラームに載せる(規則は {@link getRaceList} の「掃除のアラーム」)。行が無ければ(空の一覧)何もしない。 */
  private async armPurgeForList(url: string): Promise<void> {
    const entry = this.cache.get(url);
    if (entry === undefined) {
      return;
    }
    const pending = (this.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('queued', 'fetched')").toArray() as { n: number }[])[0]?.n ?? 0;
    // 計画の仕事(会場の一覧が未完・確定待ち・期限を待つ行)も「仕事あり」(未来の発走前の予約を、掃除の予約で押しのけない。Issue #203)。
    if (pending > 0 || this.plan.hasPlanWork()) {
      return;
    }
    const needed = entry.fetchedAt + CACHE_RETENTION_MS + PURGE_MARGIN_MS;
    const existing = this.metaGet(PURGE_DUE_KEY);
    if (existing !== null && Number(existing) >= needed) {
      return;
    }
    this.sql.exec(
      "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      PURGE_DUE_KEY,
      String(needed),
    );
    await this.rearm();
  }

  /** 朝の prior(無ければ null)。 */
  getMorningPrior(raceId: string): MorningPrior | null {
    const rows = this.sql
      .exec("SELECT computed_at, result_json FROM race_day_morning_prior WHERE race_id = ?", raceId)
      .toArray() as { computed_at: number; result_json: string }[];
    const row = rows[0];
    return row === undefined ? null : { computedAt: row.computed_at, result: JSON.parse(row.result_json) as CloudAnalysisResult };
  }

  // ---- アラームの本処理 ----

  /**
   * 次のステップを1つだけ実行する(1レースの取得 or 計算)。続きの仕事があれば、アラームを設定してから戻る。
   * 順序: (0)期限が来た計画の行を昇格(確定済みの日だけ。手動の分析との重複の確認で D1 に出ることがある)→ (1)計画の段階(次の試行の時刻が来た会場・確定)→ (1.4)救済の後の失敗の判定({@link RescueStage.judge}。Issue #249)→ (1.5)**通知**(時刻が来ていれば1件。Issue #205)→ (2)タスク({@link pickNext}。取得済みで計算待ち、なければ取得待ち。発走前が朝より先)→ (3)**結果の取り込み**(タスクが無く、計画の段階が終わっているときだけ、時刻が来ている 1 レース。期限を待つ planned の行があっても動く。Issue #208・#209)。
   * 仕事が無ければ {@link wakeWithoutWork}。
   */
  async runNextStep(): Promise<StepOutcome> {
    // 期限が来た計画の行を昇格する(同期。pre_race を積む)。続けて、同じ起床の中で、積んだ pre_race を処理できる。
    await this.promoteStage.promoteDue();
    // 事前分析の計画の段階(会場の一覧の取得・確定)。次の試行の時刻が来ているものだけ(再試行の待ちは、時刻で守る)。
    const venue = this.plan.nextListVenue(this.now());
    if (venue !== null) {
      const outcome = await this.planStage.runList(venue);
      await this.armAlarm();
      return outcome;
    }
    if (this.plan.finalizeDue(this.now())) {
      const outcome = await this.planStage.runFinalize();
      await this.armAlarm();
      return outcome;
    }
    // 23 時の再実行(救済)の後の失敗の判定(Issue #249。同期。落ち着くか期限が来たら、結果を永続化し、失敗なら通知の材料を積む)。通知の計画より前(同じ起床で送れる)。
    this.rescueStage.judge();
    // 通知(Issue #205)。**タスクより前**: 発走前の通知は時間に追われる(immediate の行が多い日に、pre_race の連続が通知を押しのけない)。
    // 送信の間隔(1 秒)と失敗のクールダウン(60 秒)があるので、通知がタスクを押しのけ続けることもない。
    const notice = this.notifyPlan().sendNow;
    if (notice !== null) {
      const outcome = await this.notifyStage.runStep(notice);
      await this.armAlarm();
      return outcome;
    }
    // 締切の直前の再計算(Issue #338)。発走の 5 分前・2 分前の時刻が来た行を 1 つ。**タスクより前**: 発走の時刻に締め切りがある(待っている朝の取得・発走前の取得・計算に押しのけられない。ただし実行中のステップは中断できない)。
    const closeDue = this.close.nextDue(this.now());
    if (closeDue !== null) {
      const outcome = await this.closeStage.runStep(closeDue);
      await this.armAlarm();
      return outcome;
    }
    // 馬場の API の取得(Issue #294)。開催日の朝の 1 回だけ。**タスクより前**: 発走前の分析(LLM)に当日の値を間に合わせる。期限は最初の発走前の分析より前なので、分析を遅らせない。
    // 動けるのは、取得口・保存先があり、中央の開催日で、今日が開催日で、期限が来ていて、まだ試みていないときだけ({@link BabaStage.runnable})。失敗しても例外にせず、次の起床でタスクが進む。
    if (this.baba.runnable()) {
      const outcome = await this.baba.run();
      await this.armAlarm();
      return outcome;
    }
    const next = this.pickNext();
    if (next === null) {
      // 結果の取り込み(Issue #208。最も低い優先度)。動けるとき({@link resultsRunnable})だけ、時刻が来ている 1 レース。
      const due = this.resultsRunnable() ? this.results.nextDue(this.now()) : null;
      if (due !== null) {
        const outcome = await this.resultStage.runStep(due);
        await this.maybeRequestReport();
        await this.armAlarm();
        return outcome;
      }
      return this.wakeWithoutWork();
    }
    const outcome = await this.runStep(next);
    await this.armAlarm();
    return outcome;
  }

  // ---- 通知(Issue #205 段階D)----

  private earliest(a: number | null, b: number | null): number | null {
    return a === null ? b : b === null ? a : Math.min(a, b);
  }

  /**
   * 通知の計画(手順は {@link NotifyStage.plan})。**委ねるだけの関数**で、本体の 3 箇所(`runNextStep`・`peekNotifyPlan`・`rearm`)がここを通る。
   * 段階を直接呼ばずにこの関数を残すのは、静的ガード(cloud-config-guard 1695 行)が、`runNextStep` の中の通知・馬場・タスクの順序の検査に、
   * `const notice = this.notifyPlan().sendNow;` という文字列を使うため(文字列が変わるとガードが読めなくなる)。
   */
  private notifyPlan(): NotificationPlan {
    return this.notifyStage.plan();
  }

  // ---- 事前分析の計画(Issue #203 段階2)----

  /**
   * 当日中の結果の取り込みの行を積む(Issue #209。{@link PlanStage.runFinalize} の同期区間から呼ぶ)。発走時刻のある計画の行ごとに(skip の行も含む: 前のレースの傾向の材料になる)、
   * 発走 + {@link SAME_DAY_RESULT_DELAY_MS} を最初の試行とする `queued` の行を積む。`requested_on` は**開催日**(確定が日付をまたいで遅れても、後日の cron の依頼が「同じ日の依頼」と読まない)。
   * 積まない: 結果ストアが無い構成 / 期限を待つ planned の行が 1 つも無い日(当日傾向を使う分析が起きない。全レースが発走済みの日の無駄な取得を避ける)/ 既に行があるレース(確定の再実行で作り直さない)。
   * 上限 {@link MAX_SAME_DAY_RESULT_ROWS}(発走の早い順に取り、超えたぶんは積まない。確定は落とさない)。スキーマは変えない。
   */
  private enqueueSameDayResults(kaisaiDate: string, nowMs: number): void {
    if (this.resultStore === undefined || this.plan.plannedCount() === 0) {
      return;
    }
    let count = this.results.count();
    for (const r of this.plan.rowsWithStartTime()) {
      if (count >= MAX_SAME_DAY_RESULT_ROWS) {
        break;
      }
      if (this.results.row(r.race_id) === null) {
        this.results.enqueue(r.race_id, kaisaiDate, nowMs, r.start_ms + SAME_DAY_RESULT_DELAY_MS);
        count += 1;
      }
    }
  }

  /**
   * 発走前の分析(取得ステップ)を行ったレースの、結果の取り込みの行を積む(Issue #277)。自動の計画の行は {@link enqueueSameDayResults} が確定時に積むが、手動の分析(計画外のレース)は積まれず、
   * 日報の「静か」の判定({@link isDayQuiet})から見えないため、そのレースの結果を待たずに日報が依頼されていた。出馬表の発走時刻が分かるこの時点で、自動の行と同じ規則の行
   * (発走 + {@link SAME_DAY_RESULT_DELAY_MS} が最初の試行・依頼の日は開催日)を積む。
   * 積まない: 結果ストアが無い構成 / 過去の開催日(開催日 < 今日 JST。後日の cron の取り込みの対象) / 発走時刻が無い・読めない / 既に行があるレース(自動の計画のレース・分析し直し。
   * `enqueue` は既存の行を巻き戻すので、必ず先に確かめる) / 当日の行の上限({@link MAX_SAME_DAY_RESULT_ROWS}。翌日以降の cron の依頼のための枠を残す)。
   * 開催日が今日より先でも積む(前日の夜の分析。自動の行も前日夜の確定で、未来の時刻の `queued` として積まれる)。日報の依頼の後に積んだ行は結果の取り込みだけをして、日報は作り直さない(`report_requested`)。
   * 失敗しても分析を止めない(固定の警告だけ)。
   */
  private enqueueResultForAnalyzedRace(raceId: string, startTime: string | undefined): void {
    try {
      const kaisaiDate = this.metaGet("kaisai_date");
      if (this.resultStore === undefined || kaisaiDate === null || startTime === undefined || kaisaiDate < jstKaisaiDate(this.now())) {
        return;
      }
      if (this.results.row(raceId) !== null || this.results.count() >= MAX_SAME_DAY_RESULT_ROWS) {
        return;
      }
      // 出馬表の時刻は 1 桁の時間(`9:50`)を取りうる(`\d{1,2}:\d{2}`)。`startTimeEpochMs` は 2 桁を要求するので揃える。読めなければ(RangeError)積まない。
      const startMs = startTimeEpochMs(kaisaiDate, startTime.padStart(5, "0"));
      this.results.enqueue(raceId, kaisaiDate, this.now(), startMs + SAME_DAY_RESULT_DELAY_MS);
    } catch {
      this.onWarn(`結果の取り込みの行を積めませんでした(${raceId})。分析は続けます`);
    }
  }

  private runStep(task: TaskRow): Promise<StepOutcome> {
    if (task.mode === "pre_race") {
      if (task.status !== "fetched") {
        return this.runPreRaceFetch(task);
      }
      // 地方三連単の段階(Issue #283): 取得済み(fetched)でも、軸ごとの取得が残っていれば、計算より先にそれを進める(計算は pending が尽きるまで待つ)。
      return this.narTrifecta.hasPending(task.race_id, task.queued_at) ? this.runNarTrifectaStep(task) : this.runPreRaceCompute(task);
    }
    return task.status === "fetched" ? this.runCompute(task) : this.runFetch(task);
  }

  /**
   * 実行する仕事が無いときに起きた(= 掃除専用のアラーム。または早く起きた)。
   * 掃除の時刻になっていれば、保持期間を超えたキャッシュの行だけを消し、**アラームは再設定しない**(以後は新しい予約が来るまで何も起きない)。
   * まだ掃除の時刻前なら、何も消さず、同じ時刻にアラームを設定し直す(早く起きても掃除を取りこぼさない)。掃除の予約が無ければ何もしない。
   */
  private async wakeWithoutWork(): Promise<StepOutcome> {
    // 日報の依頼が失敗していたら、この起床(掃除専用のアラームを含む)で再び依頼する(Issue #235)。
    await this.maybeRequestReport();
    const dueText = this.metaGet(PURGE_DUE_KEY);
    if (dueText === null) {
      await this.rearm();
      return { kind: "idle" };
    }
    const due = Number(dueText);
    if (this.now() < due) {
      await this.rearm();
      return { kind: "idle" };
    }
    this.sql.exec("DELETE FROM race_day_meta WHERE key = ?", PURGE_DUE_KEY);
    // 進行中のタスクが無いので、残っている LLM の応答の記録は孤立している(消し損ねた分)。
    SqlLlmResponseStore.clearOrphans(this.sql);
    this.narTrifecta.clearOrphans();
    const purged = this.purgeCache();
    await this.rearm();
    return { kind: "idle", purged };
  }

  /**
   * 次に実行するタスク。**発走前(pre_race)は朝(morning)より先**(発走の時刻に締め切りがある。朝の36件の取得を待たせない。Issue #203)。
   *  1. 計算待ち(fetched): 発走前 → 朝、そのなかで計算の試行回数の少ない順 → 予約の古い順 → レースID 順
   *  2. 取得待ち(queued): **再試行待ち(試行済み)は最後**(間隔を空けて撃ち直す再試行を、モードの優先で即時の撃ち直しにしない)→ 発走前 → 朝 →
   *     試行回数の少ない順 → 予約の古い順 → レースID 順
   * 同じモードどうしの並びは従来のまま(`(attempts > 0)` は `attempts` の単調な関数なので、同じモードの中では `attempts` の昇順と同じ)。
   */
  private pickNext(): TaskRow | null {
    const fetched = this.sql
      .exec("SELECT * FROM race_day_tasks WHERE status = 'fetched' ORDER BY (mode = 'pre_race') DESC, compute_attempts, queued_at, race_id, mode LIMIT 1")
      .toArray() as TaskRow[];
    if (fetched[0] !== undefined) {
      return fetched[0];
    }
    const queued = this.sql
      .exec("SELECT * FROM race_day_tasks WHERE status = 'queued' ORDER BY (attempts > 0), (mode = 'pre_race') DESC, attempts, queued_at, race_id, mode LIMIT 1")
      .toArray() as TaskRow[];
    return queued[0] ?? null;
  }

  /**
   * ステップのあとの張り直し。続きの仕事があればアラームを設定する(再試行待ちだけなら遅らせる)。アラームを張るのは {@link rearm}(最も早い候補に1回だけ)。
   * **仕事が無くなったら、掃除の時刻(保持期間 + 余裕の後)を永続化する**(前の掃除の予約は上書きされる)。{@link rearm} がそれを候補に入れて張る。
   * 取得キャッシュは、仕事が無くなった時点ではどの行も新しい(保持期間の内側)ので、その場では何も消えない。アラームを設定しないと、
   * その日の DO は二度と起きず、期限切れの行が永久に残る(レビュー指摘)。
   */
  private async armAlarm(): Promise<void> {
    const pending = this.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('queued', 'fetched')").toArray() as { n: number }[];
    if ((pending[0]?.n ?? 0) === 0) {
      const due = this.now() + CACHE_RETENTION_MS + PURGE_MARGIN_MS;
      this.sql.exec(
        "INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        PURGE_DUE_KEY,
        String(due),
      );
    }
    await this.rearm();
  }

  /**
   * **`setAlarm` を呼ぶ唯一の口**(Issue #203 段階1)。今の状態から {@link nextAlarmAt} の入力を作り、最も早い時刻に1回だけ張る(候補が無ければ呼ばない)。
   * 状態を読んでから `setAlarm` を呼ぶまでに `await` を挟まない(挟むと、その間に入った `schedule` のアラームを潰しうる。`getRaceList` の掃除の規則と同じ)。
   */
  private async rearm(): Promise<void> {
    const rows = this.sql
      .exec("SELECT status, attempts, compute_attempts FROM race_day_tasks WHERE status IN ('queued', 'fetched')")
      .toArray() as { status: TaskStatus; attempts: number; compute_attempts: number }[];
    // すぐ動かせる仕事(初回の取得・初回の計算)があれば now。再試行待ちだけなら遅らせる。
    const immediateWork = rows.some((r) => (r.status === "fetched" ? r.compute_attempts === 0 : r.attempts === 0));
    const purgeText = this.metaGet(PURGE_DUE_KEY);
    const at = nextAlarmAt({
      nowMs: this.now(),
      retryDelayMs: RETRY_DELAY_MS,
      immediateWork,
      retryWork: rows.length > 0 && !immediateWork,
      planNextTryAtMs: this.plan.nextTryAtMs(),
      planNextDueMs: this.plan.nextDueMs(),
      purgeDueMs: purgeText === null ? null : Number(purgeText),
      notifyAtMs: this.earliest(this.notifyPlan().nextAtMs, this.rescueStage.judgeAtMs()),
      resultAtMs: this.resultsRunnable() ? this.results.nextTryAtMs() : null,
      babaAtMs: this.baba.dueAtMs(),
      reportHoldAtMs: this.reportHold.pendingAlarmAt(),
      reportJudgePending: rows.length === 0 && this.reportHold.judgePending(),
      closeAtMs: this.close.nextAtMs(),
    });
    if (at !== null) {
      await this.setAlarm(at);
    }
  }

  /** 保持期間を超えたキャッシュの行を消し、消した件数を返す(失敗したら警告だけ出して 0)。 */
  private purgeCache(): number {
    try {
      return this.cache.purgeOlderThan(CACHE_RETENTION_MS);
    } catch (error) {
      this.onWarn(`取得キャッシュの掃除に失敗しました: ${errorMessage(error)}`);
      return 0;
    }
  }

  // ---- 結果の取り込み(Issue #208)----

  /**
   * 日報の作成を依頼する(Issue #235)。**その日が静かになった**({@link isDayQuiet})とき、1 回だけ。呼ぶのは、結果の 1 レースを取り込んだ直後と、仕事が無い起床。
   * 依頼先が無い(`requestReport` なし)・開催日が未確定・依頼済み(meta の `report_requested`)・静かでないときは何もしない。
   * 失敗(依頼先の例外)は握る: 例外の本文は残さず、固定の警告だけを出す。印を書かないので、次の起床で再び依頼する(日報の作成は冪等で、作成済み・進行中は依頼先が断る)。
   */
  private async maybeRequestReport(): Promise<void> {
    if (this.requestReport === undefined || this.metaGet(REPORT_REQUESTED_KEY) !== null) {
      return;
    }
    // 下限を過ぎた判定を行った印(Issue #298)。判定の結果は問わない(静かでなくても、依頼が失敗しても付く = アラームの即時のループにならない)。
    this.reportHold.markJudged();
    const kaisaiDate = this.metaGet("kaisai_date");
    if (kaisaiDate === null) {
      return;
    }
    const pending = (this.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('queued', 'fetched')").toArray() as { n: number }[])[0]?.n ?? 0;
    const resultRows = this.results.rows();
    const quiet = isDayQuiet({
      planFinalized: this.plan.finalizedAt() !== null,
      plannedRows: this.plan.plannedCount(),
      pendingTasks: pending,
      resultRows: resultRows.length,
      queuedResults: resultRows.filter((r) => r.state === "queued").length,
      afterReportHold: this.reportHold.isAfterHold(),
    });
    if (!quiet) {
      return;
    }
    try {
      await this.requestReport(kaisaiDate);
    } catch {
      this.onWarn(`日報の作成の依頼に失敗しました(${kaisaiDate}。次の起床で再び依頼します)`);
      return;
    }
    this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", REPORT_REQUESTED_KEY, String(this.now()));
  }

  /**
   * 結果の取り込みが動ける状態か: 結果ストアがあり、**タスク(queued・fetched)が無く、計画の段階が終わっている**({@link PlanStore.planStageSettled}: 会場の一覧・確定の途中でない。
   * **期限を待つ planned の行は数えない** = 今日の DO でも動く。Issue #208 は `hasPlanWork`〈planned の行も数える〉だったので、当日中は一度も動かなかった)。アラームの候補を入れるか({@link rearm})と、動くか({@link runNextStep})の
   * **両方がこれを使う**(別々に書くと、アラームだけ張って動かない〈即時ループ〉か、動くのにアラームが無い〈停止〉が起きる)。
   * タスクの条件が要る理由: {@link pickNext} は queued を時刻を見ずに返すので、結果の候補で起きると、再試行待ちのタスクが間隔を無視して走る。
   */
  private resultsRunnable(): boolean {
    if (this.resultStore === undefined) {
      return false;
    }
    const pending = (this.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks WHERE status IN ('queued', 'fetched')").toArray() as { n: number }[])[0]?.n ?? 0;
    // Issue #209: 期限を待つ planned の行は「仕事」に数えない(今日の DO では最終レースまで残る)。会場の一覧・確定の途中は数える。
    return pending === 0 && this.plan.planStageSettled();
  }

  // ---- 朝(morning) ----

  private async runFetch(task: TaskRow): Promise<StepOutcome> {
    const attempts = task.attempts + 1;
    // 試行回数は取得の前に永続化する(取得の途中でクラッシュしても、再実行が無限に続かない)。
    this.updateTask(task, "queued", attempts, task.error);
    try {
      // 設定(スコアリングの重み。Issue #218)を読んでタスクに固定する(発走前の取得と同じ流儀。取得〜計算で重みが変わらない。再試行では読み直さない)。
      // 読めなければ投げる(下の catch が再試行し、尽きたら failed。既定値の重みで黙って prior を作らない)。`loadSettings` の無い構成は読まない(計算は既定値の重み)。
      let settings: CloudSettings = DEFAULT_CLOUD_SETTINGS;
      if (task.settings_json !== null) {
        settings = coerceCloudSettings(JSON.parse(task.settings_json));
      } else if (this.loadSettings !== undefined) {
        settings = await this.loadSettings();
        this.setTaskFields(task, { settings_json: JSON.stringify(settings) });
      }
      // 騎手の年度別成績(Issue #226)は、ここ(netkeiba に出る取得ステップ)で取っておく。計算ステップはキャッシュだけを読む。
      const race = await scrapeRace(
        parseRaceId(task.race_id),
        // 前走の条件(Issue #421 段階 1-b)の POST に cacheKey の付け忘れが起きないよう、取得器を包む(GET は素通し)。
        { fetcher: requireCacheKeyForPost(this.networkFetcher), now: () => new Date(this.now()), jockeyStore: this.jockeyStore, trainerStore: this.trainerStore },
        { includeComboOdds: false, includeJockeyStats: wantsJockeyStats(settings), includeTrainerStats: wantsTrainerStats(settings), includePrevConditions: true },
      );
      const prevWarnings = this.takePrevConditionWarnings(race.meta.warnings);
      this.dropBrokenNewspaperCache(task.race_id, prevWarnings);
      await this.saveRaceCondition(task.race_id, race.race);
      const missing = race.meta.warnings.filter((w) => w.kind === "戦績");
      if (missing.length > 0) {
        throw new Error(`戦績を取得できなかった馬が ${missing.length} 頭います(${missing[0]!.message})`);
      }
      this.warnPersonStats(`朝の取得(${task.race_id})`, race.meta.warnings);
      this.warnPrevConditions(`朝の取得(${task.race_id})`, prevWarnings);
      this.updateTask(task, "fetched", attempts, null);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "fetch", result: "ok" };
    } catch (error) {
      const message = redactSecrets(errorMessage(error)); // 保存する文面は鍵の形を伏せる(閲覧者にも見える。Issue #245)
      if (isFatalFetchError(error) || attempts >= MAX_ATTEMPTS) {
        this.updateTask(task, "failed", attempts, message);
        this.onWarn(`朝の取得に失敗しました(${task.race_id}。試行 ${attempts} 回): ${message}`);
        return { kind: "ran", raceId: task.race_id, mode: "morning", step: "fetch", result: "failed" };
      }
      this.updateTask(task, "queued", attempts, message);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "fetch", result: "retry" };
    }
  }

  /**
   * 出馬表から読んだレースの条件(負担重量の種別・牝馬限定)を記録先へ渡す(Issue #421 段階 1。朝・発走前の取得ステップで `scrapeRace` の直後に呼ぶ)。**投げない**:
   * 失敗は警告(鍵の形を伏せる)にして戻る(取得ステップを止めない・再試行しない)。記録先が無い構成・条件の欄を読めなかったレース(地方・`RaceData02` 無し)は何もしない。
   * 条件はレースの事実で、分析の成否とは独立なので、戦績の欠落で取得ステップが再試行になる場合でも先に渡す(同じ値の再保存は D1 側が行を書かない)。
   */
  private async saveRaceCondition(raceId: string, race: Parameters<typeof toRaceConditionRecord>[1]): Promise<void> {
    if (this.raceConditionsStore === undefined) {
      return;
    }
    const record = toRaceConditionRecord(raceId, race, this.now());
    if (record === null) {
      return;
    }
    try {
      await this.raceConditionsStore.save(record);
    } catch (error) {
      this.onWarn(`レースの条件を保存できませんでした(${raceId})。取得は続けます: ${redactSecrets(errorMessage(error))}`);
    }
  }

  /**
   * 取得ステップの `scrapeRace` が残した警告のうち、騎手・調教師のものを onWarn に出す(Issue #380)。応答・保存は変えない。
   * 出すのは `scrapeRace` の文面そのまま(取得に失敗した人は 1 人 1 行〈URL を含む。取得ステップの他の警告と同じ〉、取得の上限で取らなかった人は人数をまとめた 1 行、保存先の読み書きの失敗)。
   * ほかの種別(調教・組合せオッズ・出走取消)は出さない(増えすぎる)。戦績が欠けて取得ステップが再試行になる回では呼ばない(同じ警告が試行の回数だけ重なるため)。
   */
  private warnPersonStats(where: string, warnings: readonly { readonly kind: string; readonly message: string }[]): void {
    for (const w of warnings) {
      if (w.kind === "騎手" || w.kind === "調教師") {
        this.onWarn(`${where}: ${w.kind}: ${w.message}`);
      }
    }
  }

  /**
   * `scrapeRace` が残した警告のうち、種別が「前走条件」のものを `meta.warnings` から**取り除いて**返す(その場で取り除く。他の種別の警告は順序も含めて残す)。
   * 前走の条件は段階 1 では貯めるだけで、利用者に見せる機能が無い(分析の結果にも影響しない)。取得の失敗(NG の応答・キャッシュ切れを含む)を
   * `result.warnings`(画面向けの警告)に並べると、影響の無いことで利用者を惑わせるので、**ログ(onWarn)だけ**に出す({@link warnPrevConditions})。ユーザー決定(2026-10-20)。
   */
  private takePrevConditionWarnings(warnings: ScrapeWarning[]): ScrapeWarning[] {
    const taken = warnings.filter((w) => w.kind === "前走条件");
    if (taken.length > 0) {
      const kept = warnings.filter((w) => w.kind !== "前走条件");
      warnings.splice(0, warnings.length, ...kept);
    }
    return taken;
  }

  /**
   * 取り除いた「前走条件」の警告({@link takePrevConditionWarnings})を onWarn に出す(Issue #421 段階 1-b)。応答・保存は変えない。
   * 鍵の形は伏せ、先頭 200 文字に切る(通信の失敗の文面は取得先の URL を含みうる)。戦績が欠けて取得ステップが再試行になる回では呼ばない({@link warnPersonStats} と同じ)。
   */
  private warnPrevConditions(where: string, warnings: readonly { readonly kind: string; readonly message: string }[]): void {
    for (const w of warnings) {
      if (w.kind === "前走条件") {
        this.onWarn(`${where}: 前走条件: ${redactSecrets(w.message).slice(0, 200)}`);
      }
    }
  }

  /**
   * 読めない応答を保存してしまった新聞形式 API のキャッシュを消す(Issue #421 段階 1-b。次の取得で取り直せるように。重賞の傾向の `prefetchGradeWinner` と同じ扱い)。
   * `scrapeRace` が警告に載せる `brokenCacheKey` のうち、このレースの新聞形式のキーと一致するものだけを消す(ほかのキーは消さない)。消せなくても取得ステップは失敗にしない。
   * 戦績の欠けで取得ステップが再試行になる回でも消す(再試行が同じ壊れた応答を読み続けないように)ため、警告の出力とは分けて、`scrapeRace` の直後に呼ぶ。
   */
  private dropBrokenNewspaperCache(raceId: string, warnings: readonly { readonly kind: string; readonly brokenCacheKey?: string }[]): void {
    for (const w of warnings) {
      if (w.kind === "前走条件" && w.brokenCacheKey !== undefined && w.brokenCacheKey === newspaperCacheKey(parseRaceId(raceId))) {
        try {
          this.cache.delete(w.brokenCacheKey);
        } catch {
          // 消せなくても、取得ステップは失敗にしない。
        }
      }
    }
  }

  private async runCompute(task: TaskRow): Promise<StepOutcome> {
    const kaisaiDate = this.metaGet("kaisai_date");
    try {
      if (kaisaiDate === null) {
        throw new Error("開催日が未確定です");
      }
      const raceId = parseRaceId(task.race_id);
      // 取得ステップが固定した設定のスナップショットの重みを使う(Issue #218)。スナップショットの無いタスク(設定を読まない構成・この変更の前に取得まで済んだタスク)は既定値の重み(今までと同じ結果)。
      const settings = task.settings_json === null ? DEFAULT_CLOUD_SETTINGS : coerceCloudSettings(JSON.parse(task.settings_json));
      // 各馬の戦績の蓄積(Issue #256 段階A)のために、この計算ステップで読んだキャッシュ済みの取得結果を控える(取得は増やさない)。
      let scraped: RaceData | undefined;
      const result = await runCloudAnalysis(raceId, parseKaisaiDate(kaisaiDate), {
        scrape: async (id) => {
          scraped = await this.scrapeFromCache(id, { includeComboOdds: false, includeJockeyStats: wantsJockeyStats(settings), includeTrainerStats: wantsTrainerStats(settings), includePrevConditions: true }, `朝の計算(${id})`);
          return scraped;
        },
        analyze: null,
        // 朝の prior は D1・R2 に保存しない(DO のストレージにだけ置く)。ここは何も書かない。
        saveAnalysis: () => undefined,
        allocationSettings: null,
        scorerConfig: buildCloudScorerConfig(settings),
        now: () => new Date(this.now()),
        llmSkipReason: "朝の prior(LLM は発走前だけ)",
      });
      this.sql.exec(
        `INSERT INTO race_day_morning_prior (race_id, computed_at, result_json) VALUES (?, ?, ?)
         ON CONFLICT(race_id) DO UPDATE SET computed_at = excluded.computed_at, result_json = excluded.result_json`,
        task.race_id,
        this.now(),
        JSON.stringify(result),
      );
      this.updateTask(task, "done", task.attempts, null);
      // prior の保存・タスクの完了より後。失敗は握る(分析は止めない)ので、下の catch(計算の失敗)には来ない。
      await this.saveHorseRuns(task.race_id, kaisaiDate, scraped);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "compute", result: "ok" };
    } catch (error) {
      const message = redactSecrets(errorMessage(error)); // 保存する文面は鍵の形を伏せる(閲覧者にも見える。Issue #245)
      this.updateTask(task, "failed", task.attempts, message);
      this.onWarn(`朝の prior の計算に失敗しました(${task.race_id}): ${message}`);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "compute", result: "failed" };
    }
  }

  /**
   * 各馬の戦績を蓄積先へ渡す(Issue #256 段階A。事前分析の計算ステップの末尾から呼ぶ)。**投げない**: 失敗は警告(鍵の形を伏せる)にして戻る(再試行しない)。
   * 渡すのは `scrapeRace` が除外・取消の行(#261)を除いた後の戦績そのまま(日付での絞り込み〈#39〉は分析側の仕事で、ここは事実を渡す)。
   * 蓄積先が無い構成・取得結果が無い(計算の途中で控えられなかった)ときは何もしない。
   */
  private async saveHorseRuns(raceId: string, kaisaiDate: string, scraped: RaceData | undefined): Promise<void> {
    if (this.horseRunsStore === undefined || scraped === undefined) {
      return;
    }
    try {
      const horses = scraped.horses.flatMap((h) => (h.results === null ? [] : [{ horseId: h.shutuba.horseId, results: h.results }]));
      await this.horseRunsStore.saveRace({ raceId, kaisaiDate, savedAt: this.now(), horses });
    } catch (error) {
      this.onWarn(`各馬の戦績を保存できませんでした(${raceId})。分析は続けます: ${redactSecrets(errorMessage(error))}`);
    }
  }

  /**
   * キャッシュだけから `scrapeRace` する(netkeiba には出ない。鮮度は実質無期限)。戦績が1頭でも無ければ投げる(戦績なしの分析を黙って作らない)。
   * `oddsSince`(発走前の分析の取得ステップの開始時刻)を渡すと、**オッズ・組合せオッズは、その時刻以降に取得したキャッシュだけ**を使う
   * (それより古いもの〈前回の発走前の実行で残った、保持 26 時間のキャッシュ〉は、無いものとして扱う)。古い組合せが「今のオッズ」として配分に使われるのを防ぐ。
   * 無い組合せは、exe で組合せの取得が失敗したときと同じく、`scrapeRace` が警告にして、その券種を除く。単勝・複勝のオッズが古い(無い)ときは投げる(必須のデータ)。
   */
  private async scrapeFromCache(
    raceId: Parameters<typeof scrapeRace>[0],
    options: { readonly includeComboOdds: boolean; readonly includeJockeyStats: boolean; readonly includeTrainerStats: boolean; readonly includePrevConditions: boolean },
    warnLabel: string,
    oddsSince?: number,
  ) {
    const fetcher: RaceFetcher =
      oddsSince === undefined
        ? this.cacheOnly
        : {
            fetchText: async (url, options) => {
              if (ODDS_URL_PATTERN.test(url)) {
                const entry = this.cache.get(url);
                if (entry === undefined || entry.fetchedAt < oddsSince) {
                  throw new StaleOddsError(url);
                }
                return entry.value;
              }
              return this.cacheOnly.fetchText(url, options);
            },
          };
    // 騎手の取得の上限(`DEFAULT_JOCKEY_REQUEST_LIMIT`=40)は、サブリクエストの保険で、キャッシュに当たる呼び出しも数える。ここはキャッシュだけから読み、
    // ネットワークに出ない(上限の意味が無い)ので、上限を外す。外さないと、地方 12 頭以上は三連単の全軸を読むだけで 3N+4>=40 に達し、
    // 保存先に無い騎手をキャッシュから読めなくなる(Issue #283)。取得ステップの `scrapeRace` には渡さない(そちらの上限は有効のまま)。
    const race = await scrapeRace(
      raceId,
      { fetcher, now: () => new Date(this.now()), ttl: CACHE_ONLY_TTL, jockeyStore: this.jockeyStore, trainerStore: this.trainerStore },
      { ...options, jockeyRequestLimit: Number.MAX_SAFE_INTEGER },
    );
    // 騎手の成績(種別=騎手)はキャッシュに無くても失敗にしない(その騎手は補正なし。戦績は無いと prior が作れないので失敗にする)。
    const missing = race.meta.warnings.filter((w) => w.kind === "戦績");
    if (missing.length > 0) {
      throw new Error(`キャッシュに戦績がありません(${missing.length} 頭分)。取得をやり直してください`);
    }
    // 前走の条件(Issue #421 段階 1-b)の警告は、画面向けの警告(`result.warnings`)に入れず、ログ(onWarn)だけに出す({@link takePrevConditionWarnings})。
    // キャッシュに無い(取得ステップの失敗・キャッシュの掃除)ときの文面は取得先の URL を含むので、URL を含まない固定の文面に書き換えてから出す(分析は止めない)。
    // 戦績が欠けて再試行になる回は上で投げているので、同じ警告が試行の回数だけ重ならない。
    this.warnPrevConditions(
      warnLabel,
      this.takePrevConditionWarnings(race.meta.warnings).map((w) => (w.message.includes(CACHE_MISS_HEAD) ? { kind: w.kind, message: PREV_CONDITIONS_MISSING_MESSAGE } : w)),
    );
    return race;
  }

  // ---- 発走前(pre_race。Issue #178)----

  /** このタスクは、昇格が積んだもの(自動)か。自動の印が今のタスクのインスタンスを指していれば true(手動の `schedule()` が積み直すと印は消える)。 */
  private isAutoTask(task: Pick<TaskRow, "race_id" | "mode" | "queued_at">): boolean {
    if (task.mode !== "pre_race") {
      return false;
    }
    const marker = this.plan.autoMarker(task.race_id);
    return marker !== null && marker.enqueuedAt === task.queued_at;
  }

  /** 自動の pre_race が failed になるとき、理由を印に書く(手動のタスクには書かない)。 */
  private recordAutoFail(task: TaskRow, reason: AutoFailReason): void {
    if (this.isAutoTask(task)) {
      this.plan.setAutoFailReason(task.race_id, reason);
    }
  }

  /**
   * 自動の pre_race の各ステップの直前のガード(Issue #204 G-C1): 発走(`now ≥ start`)に達していたら、netkeiba にも LLM にも出ずに failed にする(固定のエラー文・理由 `started`)。
   * キューや再試行の待ちで、発走を過ぎることがあるため。**手動の pre_race(自動の印が無い)は変えない。** 試行回数は据え置き。該当しなければ null。
   */
  private failIfStarted(task: TaskRow, step: "fetch" | "compute"): StepOutcome | null {
    if (!this.isAutoTask(task)) {
      return null;
    }
    const plan = this.plan.planRow(task.race_id);
    if (plan === null || plan.start_ms === null || this.now() < plan.start_ms) {
      return null;
    }
    this.updateTask(task, "failed", task.attempts, AUTO_RUN_STARTED_ERROR);
    this.plan.setAutoFailReason(task.race_id, "started");
    SqlLlmResponseStore.clear(this.sql, task.race_id, task.mode);
    this.onWarn(`発走前の分析を実行しませんでした(${task.race_id}): 発走済みです`);
    return { kind: "ran", raceId: task.race_id, mode: "pre_race", step, result: "failed" };
  }

  /**
   * 発走前の取得ステップ: 設定を1回だけ読んでタスクに保存し(スナップショット)、出馬表(取消・天候・馬場を反映。TTL 10 分)・オッズ(**常にキャッシュを迂回**)・
   * 組合せオッズ(設定が ON のときだけ。同じくキャッシュを迂回)を取り直す。戦績・調教は朝のキャッシュがあればそれを使う(無ければ取る)。
   * **地方の三連単だけは、ここでは取らず**(`deferNarTrifecta`)、成功したあと軸を `race_day_nar_trifecta` に登録して次の段階({@link runNarTrifectaStep})に回す(Issue #283)。
   */
  private async runPreRaceFetch(task: TaskRow): Promise<StepOutcome> {
    const started = this.failIfStarted(task, "fetch");
    if (started !== null) {
      return started;
    }
    const attempts = task.attempts + 1;
    this.updateTask(task, "queued", attempts, task.error);
    // 取得ステップの開始時刻は、最初の試行のときに1回だけ永続化する(再試行では進めない)。計算ステップは、オッズ・組合せを、この時刻以降に取得したものだけ使う。
    // 再試行(2・3回目)でも最初の試行の時刻のままなので、最初の試行で取れた組合せを、再試行で取れなくても捨てない。
    if (task.fetch_started_at === null) {
      this.setTaskFields(task, { fetch_started_at: this.now() });
    }
    try {
      let settings: CloudSettings;
      if (task.settings_json !== null) {
        settings = coerceCloudSettings(JSON.parse(task.settings_json));
      } else {
        settings = await this.loadSettings!();
        this.setTaskFields(task, { settings_json: JSON.stringify(settings) });
      }
      const race = await scrapeRace(
        parseRaceId(task.race_id),
        { fetcher: requireCacheKeyForPost(this.networkFetcher), now: () => new Date(this.now()), jockeyStore: this.jockeyStore, trainerStore: this.trainerStore },
        // 地方の三連単は軸ごとに頭数ぶんのリクエストが要るので、この取得ステップ(1回のアラーム)では取らず、次の段階(別のアラーム)に分ける(`deferNarTrifecta`。中央は無視される。Issue #283)。
        { includeComboOdds: settings.includeComboOdds, includeJockeyStats: wantsJockeyStats(settings), includeTrainerStats: wantsTrainerStats(settings), includePrevConditions: true, bypassOddsCache: true, deferNarTrifecta: true },
      );
      const prevWarnings = this.takePrevConditionWarnings(race.meta.warnings);
      this.dropBrokenNewspaperCache(task.race_id, prevWarnings);
      await this.saveRaceCondition(task.race_id, race.race);
      const missing = race.meta.warnings.filter((w) => w.kind === "戦績");
      if (missing.length > 0) {
        throw new Error(`戦績を取得できなかった馬が ${missing.length} 頭います(${missing[0]!.message})`);
      }
      this.warnPersonStats(`発走前の取得(${task.race_id})`, race.meta.warnings);
      this.warnPrevConditions(`発走前の取得(${task.race_id})`, prevWarnings);
      await this.prefetchGradeWinner(task, parseRaceId(task.race_id), race.race.hasGradeBadge);
      // 日報の時刻の下限(Issue #291)を記録する。出馬表の取得が成功した後・結果の行を積む前(取得が失敗した試行では引かない)。失敗しても取得ステップは失敗にしない。
      await this.reportHold.record(task.race_id);
      // 日報がこのレースの結果を待つように、結果の取り込みの行を積む(Issue #277)。タスクが未了(fetched)のあいだに積むので、日報の判定に隙間ができない。
      this.enqueueResultForAnalyzedRace(task.race_id, race.race.startTime);
      // 地方三連単の段階の軸を登録する(組合せが ON の地方だけ。取消馬を除いた出走馬の全馬番。3頭未満は空=段階に入らない)。`fetched` への更新と同じ同期区間。
      if (settings.includeComboOdds && venueKindOfRaceId(parseRaceId(task.race_id)) === "nar") {
        this.narTrifecta.begin(task.race_id, task.queued_at, deriveNarTrifectaAxisUmabans(race.horses.map((h) => h.shutuba.umaban)));
      }
      this.updateTask(task, "fetched", attempts, null);
      return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "fetch", result: "ok" };
    } catch (error) {
      const message = redactSecrets(errorMessage(error)); // 保存する文面は鍵の形を伏せる(閲覧者にも見える。Issue #245)
      if (isFatalFetchError(error) || attempts >= MAX_ATTEMPTS) {
        this.updateTask(task, "failed", attempts, message);
        this.recordAutoFail(task, isFatalFetchError(error) ? "blocked" : "fetch-exhausted");
        this.onWarn(`発走前の取得に失敗しました(${task.race_id}。試行 ${attempts} 回): ${message}`);
        return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "fetch", result: "failed" };
      }
      this.updateTask(task, "queued", attempts, message);
      return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "fetch", result: "retry" };
    }
  }

  /**
   * 重賞の「同レース過去10年傾向」(Issue #181)を、取得ステップで先に取ってキャッシュに載せる。**POST はここだけ**(計算ステップはキャッシュだけを引く)。
   * 出すのは、出馬表に重賞のバッジが無いと判定できなかったとき(`hasGradeBadge !== false`。exe の `runAnalysis` と同じ fail-open)で、
   * かつ LLM を使う構成のときだけ(`llm` が無ければ `runAnalysis` は傾向を使わない)。キャッシュは無期限(確定データ)なので、同じレースの再実行では POST は増えない。
   * **失敗しても取得ステップは失敗にしない**(傾向は補助材料。GET の拒否・`post-blocked`・通信の失敗・壊れた応答のいずれも)。原因つきの警告(`redactSecrets` を通した先頭 200 文字)を残して続ける。
   * 壊れた応答(200 だが読めない)は、`CachedFetcher` が保存した後にパースで失敗するので、キャッシュの行を消す(次の取得ステップでやり直せるように)。
   */
  private async prefetchGradeWinner(task: TaskRow, raceId: ReturnType<typeof parseRaceId>, hasGradeBadge: boolean | undefined): Promise<void> {
    if (this.llm === undefined || hasGradeBadge === false) {
      return;
    }
    try {
      await fetchGradeWinnerEntries(raceId, { fetcher: requireCacheKeyForPost(this.networkFetcher) });
    } catch (error) {
      if (error instanceof GradeWinnerParseError) {
        try {
          this.cache.delete(gradeWinnerCacheKey(raceId));
        } catch {
          // 消せなくても、取得ステップは失敗にしない。
        }
      }
      this.onWarn(`発走前の取得(${task.race_id}): 重賞の過去10年傾向を取得できなかったため、傾向なしで続けます(${redactSecrets(errorMessage(error)).slice(0, 200)})`);
    }
  }

  /**
   * 地方三連単の段階(Issue #283): 取得済み(fetched)の発走前のタスクで、軸ごとの取得が残っているとき、**1回のアラームで最大 {@link NAR_TRIFECTA_AXES_PER_STEP} 軸**を取り、
   * 本文を取得キャッシュ(`fetch_cache`)に積む(パースは計算ステップに任せる=二重に解析しない)。軸の結果(fetched・failed)は**取得の直後に、次の軸を取る前に**表に書く
   * (再開・二重のアラームで、書けた軸を取り直さない。取り直すのは、書く前に落ちた 1 軸だけ)。未取得の軸が尽きたら、次のステップで計算に進む。
   *
   * 外への呼び出しの上限: このステップは gate への取得が最大 9 本(取得ステップの `scrapeRace` の 2N+4+M ≤ 40〈前走の条件・重賞の傾向・日報の下限の一覧を足して最大 43〉とは別のアラーム)で、計算ステップは 0 本。
   * 失敗は軸ごとに隔離する: 1軸の失敗(404・通信エラー・タイムアウト・`queue-full`)はその軸だけ failed にして次へ。**ブレーカー(blocked)・許可リスト外は残りを撃たずに全部 failed**
   * にして打ち切る(30 分のブレーカーの間に撃ち直さない)。どの場合も計算に進み、取れなかった軸は、計算ステップの `scrapeRace` がキャッシュに無い軸として `fetchFailed`
   * (部分被覆の警告)にする。三連単なしでも他の券種で分析は完了する。
   * 自動の発走前は、発走済みなら取得を撃たず failed にする({@link failIfStarted}。計算ステップの失敗と整合)。段階のステップの結果は `step: "fetch"` で返す。
   */
  private async runNarTrifectaStep(task: TaskRow): Promise<StepOutcome> {
    const started = this.failIfStarted(task, "fetch");
    if (started !== null) {
      this.narTrifecta.clear(task.race_id);
      return started;
    }
    const raceId = parseRaceId(task.race_id);
    const axes = this.narTrifecta.pendingAxes(task.race_id, task.queued_at, NAR_TRIFECTA_AXES_PER_STEP);
    for (const axis of axes) {
      let fetchError: unknown = null;
      try {
        // オッズなので常にキャッシュを迂回する(`scrapeRace` の `bypassOddsCache` と同じ)。取得した本文は CachedFetcher が `fetch_cache` に書く。
        await this.networkFetcher.fetchText(narTrifectaOddsAxisUrl(raceId, axis), { bypassCache: true });
      } catch (error) {
        fetchError = error;
      }
      // 結果は取得の直後(次の軸を取る前)に書く。書き込みの例外は軸の失敗として握らない(落ちたら、書けなかった軸だけが再開時に取り直される)。
      this.narTrifecta.mark(task.race_id, task.queued_at, axis, fetchError === null ? "fetched" : "failed");
      if (fetchError === null) {
        continue;
      }
      if (isFatalFetchError(fetchError)) {
        const dropped = this.narTrifecta.failAllPending(task.race_id, task.queued_at);
        this.onWarn(`地方三連単の取得を打ち切りました(${task.race_id}。軸 ${axis} で取得先が拒否。残り ${dropped} 軸は取得しません): ${redactSecrets(errorMessage(fetchError))}`);
        break;
      }
      this.onWarn(`地方三連単の軸 ${axis} を取得できませんでした(${task.race_id}): ${redactSecrets(errorMessage(fetchError))}`);
    }
    return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "fetch", result: "ok" };
  }

  /**
   * 発走前の計算・保存ステップ: **netkeiba には出ず**(gate は0回)、キャッシュだけで prior → LLM(Issue #194)→ EV → 配分を作り、`AnalysisSink` で D1・R2 に保存する。
   * **LLM の呼び出し(Anthropic の API)はこのステップの中**(`analyze`)。「ネットワークに出ない」という前提が守っているのは gate・netkeiba(間隔制御・ブレーカー)で、LLM は別の注入口(sender)から出る。
   * LLM は **常に使う**(`llm` が渡されていれば。費用の上限・ON/OFF の設定は無い)。失敗(API のエラー・切り詰め・拒否・解析失敗)でも止めず、prior で保存し、理由(固定文言)を `AnalysisSaveExtra.llmNote` で渡す。
   * キーが無ければ(`llm` なし)LLM なしで保存し、理由は「API キーが未登録」。
   * 冪等(アラームは少なくとも1回は実行される): 分析時刻(`analyzed_at`)を最初の実行でタスクに永続化し、保存の前に「同じレース・同じ分析時刻の分析が
   * 保存済みか」を確かめる。保存結果(id・R2 の状態)は保存の直後にタスクへ書く。すでに id があれば、計算も保存もしない。
   * 保存先の失敗は、試行回数の上限(3)まで遅らせて再試行する(保存済みなら、再試行で2件目を作らない)。
   * **LLM の二重送信を防ぐ**: 成功した応答を、保存の**前**に DO の表 `race_day_llm_responses` に記録し(`createRecordingSender`)、再試行・再実行ではそれを再生する。
   * 記録は、done・failed・再予約(`schedule`)・掃除のときに消す。
   * **LLM を呼んだ1回ごとの記録**(所要時間・usage・stop_reason・失敗の説明。Issue #197 段2)を `AnalysisSaveExtra.llmCalls` で渡す(D1 の `analyses.llm_calls_json`)。再実行で再生した呼び出しは `replayed:true`
   * (元の呼び出しの所要時間・トークン。二重に数えない)。再実行の前に失敗した呼び出し(課金されず、応答の記録にも残らない)の記録は、再実行では復元されない(既知の限界)。
   */
  private async runPreRaceCompute(task: TaskRow): Promise<StepOutcome> {
    // 分析がすでに保存済み(analysis_id あり)なら、発走を過ぎていても failed にしない(done にするだけ)。
    const started = task.analysis_id === null ? this.failIfStarted(task, "compute") : null;
    if (started !== null) {
      return started;
    }
    const sink = this.sink!;
    const computeAttempts = task.compute_attempts + 1;
    // 試行回数・分析時刻は、計算の前に永続化する(再実行が無限に続かない・再実行でも同じ分析時刻)。
    const analyzedAtMs = task.analyzed_at ?? this.now();
    this.setTaskFields(task, { compute_attempts: computeAttempts, analyzed_at: analyzedAtMs });
    try {
      const kaisaiDate = this.metaGet("kaisai_date");
      if (kaisaiDate === null || task.settings_json === null) {
        throw new Error("開催日または設定のスナップショットが未確定です");
      }
      if (task.fetch_started_at === null) {
        throw new Error("取得ステップの開始時刻が未確定です");
      }
      const oddsSince = task.fetch_started_at;
      const settings = coerceCloudSettings(JSON.parse(task.settings_json));
      let analysisId = task.analysis_id;
      let expected: { horses: number; bets: number } | null = null;
      let scrapeWarnings: readonly { readonly kind: string; readonly message: string; readonly jockeyId?: string; readonly trainerId?: string }[] = [];
      if (analysisId === null) {
        const raceId = parseRaceId(task.race_id);
        // LLM(Issue #194)。clipVariant は1回だけ解決し、補正の最大幅(analyzeRace)と、プロンプト・promptVersion(runAnalysis の deps.clipVariant)の両方に同じ値を使う
        // (文面の許容幅とクリップ幅の食い違いを構造的に防ぐ。旧 exe の pipeline-deps.ts〈#287 で削除。3c1664e まで〉と同じ)。
        const clipVariant = resolveClipVariant(settings.clipVariant);
        // 追加指示は、読む側に上限が無い(D1 に直接入れた長い値)ので、組み立て側で 2,000 UTF-16 単位に切る(サロゲートペアを割らない)。
        const instruction = clampAdditionalInstruction(settings.additionalInstruction);
        if (instruction.clamped) {
          this.onWarn(`発走前の分析(${task.race_id}): 追加指示が長いため、${ADDITIONAL_INSTRUCTION_MAX_LENGTH} 文字(UTF-16 の単位)に切りました`);
        }
        const cloudAnalyze =
          this.llm === undefined
            ? null
            : createCloudAnalyze({
                llm: this.llm,
                selector: this.modelSelectorFor?.(settings.analysisModel),
                store: new SqlLlmResponseStore(this.sql, task.race_id, task.mode),
                maxAdjust: clipVariant.maxAdjust,
                warn: this.onWarn,
                now: this.now, // LLM の呼び出しの所要時間を測る(Issue #197 段2)
              });
        await runCloudAnalysis(raceId, parseKaisaiDate(kaisaiDate), {
          scrape: async (id) => {
            const race = await this.scrapeFromCache(id, { includeComboOdds: settings.includeComboOdds, includeJockeyStats: wantsJockeyStats(settings), includeTrainerStats: wantsTrainerStats(settings), includePrevConditions: true }, `発走前の分析(${id})`, oddsSince);
            scrapeWarnings = race.meta.warnings;
            return race;
          },
          analyze: cloudAnalyze === null ? null : cloudAnalyze.analyze,
          additionalInstruction: instruction.text,
          clipVariant: clipVariant.id,
          saveAnalysis: async (record) => {
            // LLM が実際に効いたとき(フォールバック・スキップでないとき)だけ、モデル名を残す(runAnalysis は、応答があればフォールバックでもモデル名を入れる)。
            const outcome = outcomeOf(cloudAnalyze === null ? null : cloudAnalyze.lastResult());
            const toSave = outcome.effective ? record : { ...record, model: null };
            expected = { horses: record.horses.length, bets: record.allocation?.bets.length ?? 0 };
            const existing = await sink.findByAnalyzedAt(record.raceId, record.analyzedAt);
            if (existing !== null) {
              analysisId = existing;
              this.notifyStage.putAnalysisMaterial(task, record, outcome, existing); // analysis_id より前(同じ同期区間。Issue #205)
              this.closeStage.register(task, record, existing, settings); // 同じ同期区間(Issue #338。積み済みなら何もしない)
              this.setTaskFields(task, { analysis_id: existing });
              return;
            }
            // LLM を呼んだ1回ごとの記録(所要時間・usage・stop_reason。Issue #197 段2)。キー未登録(cloudAnalyze なし)は null(NULL で保存)。
            const saved = await sink.save(toSave, { llmNote: outcome.note, llmCalls: cloudAnalyze === null ? null : cloudAnalyze.calls(), markRepair: outcome.markRepair ?? null });
            analysisId = saved.id;
            // 通知の材料を、analysis_id の永続化より前に積む(Issue #205。同じ同期区間。以降の再実行が、材料の無い done にならない)。
            this.notifyStage.putAnalysisMaterial(task, record, outcome, saved.id);
            // 締切の直前の再計算の入力と回の行(Issue #338)も、同じ同期区間で積む。失敗は握る(分析は止めない)。
            this.closeStage.register(task, record, saved.id, settings);
            // 保存の直後に結果を書く(以降の再実行は、保存も計算もしない)。
            this.setTaskFields(task, { analysis_id: saved.id, detail: saved.detail });
          },
          allocationSettings: allocationSettingsOf(settings),
          evConfig: { threshold: settings.evThreshold },
          scorerConfig: buildCloudScorerConfig(settings), // スコアリングの重み(Issue #218)。取得ステップのスナップショットの値
          now: () => new Date(analyzedAtMs),
          // 当日傾向(Issue #209): 前のレース(自レースより前のレース番号だけ。#153)の結果を D1 から読む(netkeiba には出ない)。結果ストアが無い構成は空(当日傾向なし)。
          // 読み出しの失敗は runAnalysis が握って当日傾向なしで続け、`onSameDayTrendError` に渡す(警告には redactSecrets を通した先頭 200 文字だけ)。
          // 重賞の過去10年傾向(#181): 取得ステップがキャッシュに載せたものだけを引く(`cacheOnly`。netkeiba には出ない)。基準日(分析日。#153)は runAnalysis が渡すものを素通しする。
          // キャッシュに無い(取得ステップの POST が失敗した)ときは、`CacheMissError` で `onGradeWinnerTrendError` に渡り、傾向なしで続ける(警告は redactSecrets を通した先頭 200 文字だけ)。
          getGradeWinnerTrend: (id, conditions, cutoffDate) => collectGradeWinnerTrend(id, conditions, cutoffDate, { fetcher: requireCacheKeyForPost(this.cacheOnly) }),
          onGradeWinnerTrendError: (info) => this.onWarn(`発走前の分析(${info.raceId}): 重賞の過去10年傾向を使えなかったため、傾向なしで続けます(${redactSecrets(info.message).slice(0, 200)})`),
          getRaceResultDetails: async (ids) => (this.resultStore === undefined ? new Map() : this.resultStore.getRaceResultDetails(ids)),
          onSameDayTrendError: (info) => this.onWarn(`発走前の分析(${info.raceId}): 当日傾向を読み出せなかったため、当日傾向なしで続けます(${redactSecrets(info.message).slice(0, 200)})`),
          // 当日の馬場の値(Issue #295): 中央のレースで LLM を使うときだけ runAnalysis が読む(開催日 × 場コードで D1 の 1 行。netkeiba には出ない)。
          // 失敗は runAnalysis が握って値なしで続け、`onBabaError` に渡す。警告は固定の語だけ(例外の文面・D1 の内部のメッセージは出さない)。
          ...(this.babaReader === undefined
            ? {}
            : {
                getBabaConditions: (venueCode: string, date: string) => this.babaReader!.load(date, venueCode),
                onBabaError: (info: { readonly raceId: string }) => this.onWarn(`発走前の分析(${info.raceId}): 当日の馬場の値を読み出せなかったため、馬場の値なしで続けます`),
              }),
          llmSkipReason: LLM_NOTE_NO_KEY,
        });
        // LLM が効かなかったとき(キー未登録・フォールバック)は、固定の理由だけを警告に残す(API のエラーの本文・診断メッセージは出さない)。
        if (this.llm !== undefined && cloudAnalyze !== null) {
          const outcome = outcomeOf(cloudAnalyze.lastResult());
          if (!outcome.effective) {
            this.onWarn(`発走前の分析(${task.race_id}): LLM を使えませんでした: ${outcome.note}`);
          }
        }
        // 取得時の警告(取消馬・組合せオッズの取得失敗〈その券種は配分に入っていない〉など)を、警告として残す。
        for (const warning of scrapeWarnings) {
          this.onWarn(`発走前の分析(${task.race_id}): ${warning.kind}: ${describeScrapeWarning(warning)}`);
        }
        // 保存した子の行(馬・買い目)が、正しい親 id に、保存したレコードの件数だけ紐づいたかを確かめる(最初の実保存で、max(id) の前提を確かめる)。
        if (analysisId !== null && expected !== null) {
          const exp: { horses: number; bets: number } = expected;
          const kids = await sink.countChildren(analysisId);
          const ok = kids.horses === exp.horses && kids.bets === exp.bets;
          this.setTaskFields(task, { children_ok: ok ? 1 : 0 });
          if (!ok) {
            this.onWarn(
              `保存した分析(id ${analysisId})の子の行の件数が一致しません(馬 ${kids.horses}/${exp.horses}・買い目 ${kids.bets}/${exp.bets})。max(id) の前提を確かめてください`,
            );
          }
        }
      }
      this.updateTask(task, "done", task.attempts, null);
      this.narTrifecta.clear(task.race_id); // 地方三連単の段階の行は、完了したら要らない
      // 完了した(保存済み)ので、LLM の応答の記録は要らない。
      SqlLlmResponseStore.clear(this.sql, task.race_id, task.mode);
      return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "compute", result: "ok" };
    } catch (error) {
      const message = redactSecrets(errorMessage(error));
      if (computeAttempts >= MAX_ATTEMPTS) {
        this.updateTask(task, "failed", task.attempts, message);
        this.narTrifecta.clear(task.race_id);
        this.recordAutoFail(task, "compute-exhausted");
        SqlLlmResponseStore.clear(this.sql, task.race_id, task.mode); // 諦めたので、記録は要らない(再予約は新しい実行)
        this.onWarn(`発走前の計算・保存に失敗しました(${task.race_id}。試行 ${computeAttempts} 回): ${message}`);
        return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "compute", result: "failed" };
      }
      this.updateTask(task, "fetched", task.attempts, message);
      return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "compute", result: "retry" };
    }
  }
}
