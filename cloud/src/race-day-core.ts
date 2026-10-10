/**
 * 日単位の Durable Object `RaceDay` の中身(Issue #177〈#164-b〉)。**純ロジック**: `cloudflare:workers` を import しない。
 * ストレージ(`ctx.storage.sql`)・時計・ゲート・アラームの設定を引数で受けるので、Node の vitest で(本物の SQLite の意味論で)テストできる。
 * DO のラッパ(`race-day-do.ts`)は、これらを本物に配線するだけ。
 *
 * ## 役割
 * 開催日(`idFromName(kaisaiDate)`)ごとに1つの DO が、その日の全レースの**朝の準備**を直列に処理する(gate の待ち行列の上限 8 に当たらない)。
 *  - **ステップ1(取得 `fetch`)**: `scrapeRace`(変更なし。組合せオッズは取らない。単勝・複勝のオッズを1本取る)でキャッシュを埋める。中央16頭の
 *    冷えた状態で gate への取得は **19 本**(出馬表 1・戦績 16・調教 1・単勝複勝 1)。
 *  - **ステップ2(計算 `compute`)**: **netkeiba には出ず**(gate は0回)、キャッシュだけで `runCloudAnalysis(analyze: null, allocationSettings: null)` を走らせ、
 *    朝の prior(`AnalysisResult`)を **DO のストレージにだけ**置く(**D1・R2 には書かない**。ユーザー判断 2026-10-06: 保存するのは発走前の分析だけ)。
 *    取得のあとで TTL が切れても読めるよう、キャッシュの鮮度を実質無期限にして読む。キャッシュに戦績が無ければ(掃除された等)、netkeiba に出ず失敗にする
 *    (`scrapeRace` は戦績の失敗を警告にして続けるので、戦績なしの prior を黙って作らないよう検出する)。
 *  - 2つのステップは**別々のアラーム呼び出し**で動かす(1呼び出しの中のサブリクエスト数〈Free は 50〉を抑える・再試行でネットワークを撃ち直さない)。
 *    1回の `runNextStep` は1レースの1ステップだけを行い、続きがあればアラームを設定して戻る。
 *
 * ## 予約(schedule)
 * 予約だけをして戻る(`setAlarm(now)`)。本処理はアラームの中(`runNextStep`)。同じレースが実行中(queued・fetched)なら受け付けない。
 * DO は1つの開催日だけを扱う(最初の予約の開催日に固定し、別の日・raceId の年と違う日は拒否する)。
 *
 * ## アラームの合成(Issue #203 段階1)
 * DO のアラームは1つだけ。**`setAlarm` を呼ぶのは {@link RaceDayCore.rearm} の1箇所だけ**で、起こしたい理由(今すぐの仕事・再試行待ち・計画・掃除)の最も早い時刻に張る({@link nextAlarmAt})。
 * 計画(段階2)の候補が入っても、掃除や一覧の取得が未来の予約を潰さない。`pickNext` は**発走前(pre_race)を朝(morning)より先**に処理する(再試行待ちは最後)。
 *
 * ## 朝の計画(Issue #203 段階2)
 * `requestPlan` → 計画の段階(会場の一覧)→ 確定(計画の表と morning の投入)→ 期限が来たら pre_race の投入。仕組みと冪等性の規則は {@link RaceDayCore.requestPlan}・`runPlanFinalize`・`promoteDuePlans`、表は `race-day-plan.ts`。
 * ## 発走前の予約のガード(Issue #204 段階C)
 * 昇格は**確定済みの日だけ**。昇格の判定は {@link RaceDayCore.promoteRow}(実行中の手動・時刻・手動の分析との重複・上限)、自動で積んだ pre_race は印(`race_day_auto_pre_race`)で手動と区別し、
 * 各ステップの直前に発走済みなら netkeiba にも LLM にも出ずに failed にする({@link RaceDayCore.failIfStarted})。結果は {@link RaceDayCore.getAutoRunResults} が状態から読む(`auto-run-result.ts`)。
 *
 * ## 通知(Issue #205 段階D)
 * Discord への通知は、コールバックではなく**状態から作る**(`planNotifications`〈`notify-plan.ts`。純関数〉が、`getAutoRunResults`・`getPlanProgress`・通知の表〈`race_day_notify`。`notify-store.ts`〉から、
 * 「いま送るもの」と「次にアラームを張る時刻」を同じ関数で返す)。送信は {@link RaceDayCore.runNotifyStep}(**多くとも1回**: 送る前に `sending` の行を書く。落ちたものは再送しない)。処理の順は
 * 昇格 → 計画 → **通知** → タスク。completed の embed は、計算ステップの `saveAnalysis` コールバックの中で、保存する `record` から作って `analysis_id` の永続化より前に積む({@link RaceDayCore.putAnalysisMaterial})。
 * **webhook が無効なら(`notifier` なし)、行も材料も積まず、通知のためのアラームも張らない。** URL は `notifier` のクロージャの中だけにあり、ここには渡らない。
 *
 * ## 結果の取り込み(Issue #208〈#182-B〉)
 * 過去の開催日の結果(着順・払戻)を、アラームの 1 ステップにつき **1 レース**だけ取り込む(`requestResultImport` で依頼 → {@link RaceDayCore.runResultStep})。状態は**専用の新しい表**(`race_day_result`。`race-day-result.ts`)。
 * 取得は gate 経由・キャッシュを通さない生の `HttpClient`(結果のページをキャッシュに溜めない)、保存は D1(`resultStore`)。**払戻のテーブルが出てから保存する**(審議中の暫定の着順を固めない)。
 * 優先度は最も低い: **タスク(queued・fetched)が無く、計画の段階〈会場の一覧・確定〉が終わっているときだけ**動く({@link RaceDayCore.resultsRunnable}。アラームの候補を入れるかと、動くかの両方がこれを使う)。通知は {@link RaceDayCore.runNextStep} の順序で、送るべきものがあれば先に出る。
 * **期限を待つ planned の行は止めない**ので、今日の DO でも、期限が来た行の昇格〈各ステップの先頭〉→ タスク → 結果の順で動く(Issue #209)。
 *
 * ## 当日中の結果の取り込みと当日傾向(Issue #209)
 * 計画の確定時に、発走時刻のある計画の行(skip の行も含む)ごとに結果の行を積む({@link RaceDayCore.runPlanFinalize}。`requested_on` = 開催日。最初の試行は発走 + 15 分)。
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
 */
import { CachedFetcher, type TextFetcher } from "../../packages/core/src/scraper/cached-fetcher";
import { HttpError, type HttpClient } from "../../packages/core/src/scraper/http-client";
import { collectGradeWinnerTrend } from "../../packages/core/src/analyzer/grade-winner-trend";
import { fetchGradeWinnerEntries, gradeWinnerCacheKey } from "../../packages/core/src/scraper/fetch-grade-winner";
import { GradeWinnerParseError } from "../../packages/core/src/scraper/parse-grade-winner";
import { importRaceResult } from "../../packages/core/src/ev/result-import";
import { parseRaceFieldSize, parseRaceResult, RaceResultNotConfirmedError } from "../../packages/core/src/scraper/parse-race-result";
import { DEFAULT_RESULTS_TTL_MS, listNarRaces, listRaces, scrapeRace, type RaceFetcher, type ScrapeTtlConfig } from "../../packages/core/src/scraper/scrape-race";
import { parseKaisaiDate, parseRaceId } from "../../packages/core/src/scraper/ids";
import type { RaceListEntry } from "../../packages/core/src/scraper/types";
import { narRaceListSubUrl, raceListSubUrl } from "../../packages/core/src/scraper/urls";
import { checkRaceDate } from "./race-date";
import { jstKaisaiDate, planPreRaceDue, selectAutoRunTargets } from "./auto-run-plan";
import { AUTO_RUN_STARTED_ERROR, classifyAutoRun, type AutoFailReason, type AutoRunOutcome } from "./auto-run-result";
import { buildAnalysisLink } from "./notify-link";
import { buildAnalysisNotificationEmbed, buildFailureEmbed, buildManualSkipEmbed, buildMinimalAnalysisEmbed, buildSummaryEmbed, notificationText, type CloudEmbed, type RaceLabel } from "./notify-embeds";
import { FAILURE_COOLDOWN_MS, planNotifications, SEND_SPACING_MS, type NotificationPlan, type NotifyItem, type NotifyKind, type NotifyState } from "./notify-plan";
import { classifyNotifyError, type DiscordNotifier } from "./notify-send";
import { NotifyStore } from "./notify-store";
import { DEFAULT_PRE_RACE_OFFSET_MINUTES, startTimeEpochMs } from "./pre-race-time";
import {
  MAX_RESULT_ATTEMPTS,
  MAX_RESULT_DEFERRALS,
  MAX_RESULT_RACES_PER_REQUEST,
  MAX_RESULT_ROWS_PER_DAY,
  MAX_SAME_DAY_ATTEMPTS,
  MAX_SAME_DAY_RESULT_ROWS,
  MAX_SAME_DAY_UNKNOWN_SIZE_ATTEMPTS,
  RESULT_BUSY_DELAY_MS,
  RESULT_RETRY_DELAY_MS,
  ResultImportStore,
  SAME_DAY_RESULT_DELAY_MS,
  SAME_DAY_RETRY_DELAY_MS,
  type ResultClass,
  type ResultRow,
  type ResultState,
} from "./race-day-result";
import type { ResultRepository } from "./result-repository";
import { requireCacheKeyForPost } from "./post-cache-guard";
import { PLAN_VENUES, PlanStore, type PlanRowRecord, type PlanSkipReason, type PlanVenue } from "./race-day-plan";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { DoSqlCacheStore } from "./do-cache-store";
import { createGateHttpClient, GateRefusedError, type GateLike } from "./gate-fetch";
import { resolveClipVariant } from "@keiba/core/pipeline";
import type { AnalysisSaveExtra, RecentAnalysis } from "./analysis-save-extra";
export type { AnalysisSaveExtra, RecentAnalysis };
import { clampAdditionalInstruction, createCloudAnalyze, createCloudModelSelectors, LLM_NOTE_NO_KEY, outcomeOf, redactSecrets, type LlmOutcome, type ModelSelectorFor } from "./llm-run";
import { SqlLlmResponseStore } from "./llm-response-store";
import type { CloudLlm } from "./llm-sender";
import { runCloudAnalysis, type CloudAnalysisResult } from "./pipeline";
import { buildCloudScorerConfig } from "./scorer-config";
import { ADDITIONAL_INSTRUCTION_MAX_LENGTH, coerceCloudSettings, DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "./settings";
import type { SqlLike } from "./sql-like";

/** 掃除の時刻(エポックミリ秒)を永続化するキー。 */
const PURGE_DUE_KEY = "purge_due_at";

/**
 * 1日(1つの DO)に受け付けるレースの数の上限。中央は 1日 最大 36 レース(3場 × 12R)。地方を手動で足しても余裕のある値。
 * 手動起動の入口(#180)から、netkeiba への取得が際限なく積まれないための歯止め(すでにあるレースの再予約は数えない)。
 */
export const MAX_TASKS_PER_DAY = 100;

/** 取得ステップの試行回数の上限。 */
export const MAX_ATTEMPTS = 3;
/**
 * 手動の分析との重複とみなす窓(Issue #204)。自動の期限の **15 分前から今まで**(両端を含む)に、現行の prompt_version で LLM が効いた手動の分析があれば、自動はスキップする。
 * それより前の手動の分析は無視して、自動で分析する(ユーザー判断 2026-10-07)。
 */
export const MANUAL_DUPLICATE_WINDOW_MS = 15 * 60_000;
/** 取得ステップの再試行までの間隔(ミリ秒)。 */
export const RETRY_DELAY_MS = 60_000;
/** 結果の取り込みで、ブレーカーの解除を待つ時間の上限(ミリ秒)。ブレーカーは 30 分なので、それより長くは待たない(解除時刻が壊れていても、延々と先送りしない)。 */
const MAX_BLOCKED_WAIT_MS = 60 * 60_000;
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
   * 通知(Discord。Issue #205)の次の時刻: 送るものがあれば送れる時刻(送信の間隔・失敗のクールダウンの時刻)、まとめの保険の時刻だけが残っていればその時刻({@link planNotifications} の `nextAtMs`)。
   * 計画の候補と同じ扱い(仕事の有無によらず候補。過去は now)。省略・null は候補なし(webhook が無効なとき・既存の呼び出し)。
   */
  readonly notifyAtMs?: number | null;
  /**
   * 結果の取り込み(Issue #208)の次の試行の時刻(`queued` の行の最小)。**動けるとき**({@link RaceDayCore.resultsRunnable}: タスクが無く、計画の段階〈会場の一覧・確定〉が終わっている。期限を待つ planned の行は止めない。Issue #209)だけ入れる。
   * 省略・null は候補なし。タスクがあるあいだに入れない理由: `pickNext` は再試行待ちのタスクを時刻を見ずに返すので、結果の候補で起きると、再試行の間隔を無効にして撃ち直してしまう。
   */
  readonly resultAtMs?: number | null;
}

/**
 * 次にアラームを張る時刻(UTC のエポックミリ秒)。候補のうち**最も早いもの**。候補が1つも無ければ null(アラームを設定しない)。
 *  - 即時の仕事 → now / 再試行待ちだけ → now + 間隔
 *  - 計画の次の試行・期限 → `max(それ, now)`(過去の時刻は now。仕事の有無によらず候補)
 *  - 結果の取り込みの次の試行 → `max(それ, now)`(呼び出し側が、動けるときだけ入れる)
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
  if (i.purgeDueMs !== null && !i.immediateWork && !i.retryWork) {
    candidates.push(Math.max(i.purgeDueMs, i.nowMs));
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** 計算ステップが、取得済みのキャッシュを鮮度に関係なく読むための TTL(実質無期限)。 */
const FOREVER_MS = Number.MAX_SAFE_INTEGER;
const CACHE_ONLY_TTL: ScrapeTtlConfig = {
  shutubaMs: FOREVER_MS,
  resultsMs: FOREVER_MS,
  oikiriMs: FOREVER_MS,
  oddsMs: FOREVER_MS,
  raceListMs: FOREVER_MS,
};

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
  /** `extra.llmNote`(発走前の計算ステップは常に渡す): LLM が使われなかった・一部しか使われなかった理由(固定文言。問題なく効いたときは null)。D1 の `analyses.llm_note` に保存される(Issue #194 b2)。`extra.llmCalls`: LLM を呼んだ1回ごとの記録(キー未登録は null)。D1 の `analyses.llm_calls_json` に保存される(Issue #197 段2)。 */
  save(record: AnalysisRecord, extra?: AnalysisSaveExtra): Promise<{ readonly id: number; readonly detail: "stored" | "failed" | "skipped" }>;
  findByAnalyzedAt(raceId: string, analyzedAt: string): Promise<number | null>;
  /**
   * 同じレースの、分析時刻が `[fromIso, toIso]`(両端を含む。ISO 8601 の UTC)の分析(id・分析時刻・prompt_version・model だけ)。**自動の昇格が、手動の分析との重複を確かめる**ために呼ぶ
   * (Issue #204。呼ぶのは、DO にそのレースの pre_race の行〈done・failed〉があるときだけ)。
   */
  findRecentByRace(raceId: string, fromIso: string, toIso: string): Promise<readonly RecentAnalysis[]>;
  countChildren(analysisId: number): Promise<{ readonly horses: number; readonly bets: number }>;
}

/** 結果の保存先のうち、日単位の DO が使う部分: 取り込みの保存(`saveResult`)と、発走前の分析の当日傾向の読み出し(`getRaceResultDetails`。Issue #209)。 */
export type ResultStoreDeps = Pick<ResultRepository, "saveResult" | "getRaceResultDetails">;

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
  /**
   * 朝の計画の段階の1ステップ(Issue #203。`mode: "plan"`)。`step: "list"` は1会場の一覧の取得(`raceId` は会場 `central`・`nar`)、`step: "finalize"` は確定(`raceId` は `plan`)。
   * 既存の `ran` と同じ形にしてあるのは、結果を `${raceId}:${mode}:${step}:${result}` のように読む呼び出し側を壊さないため。
   */
  | { readonly kind: "ran"; readonly raceId: string; readonly mode: "plan"; readonly step: "list" | "finalize"; readonly result: "ok" | "retry" | "failed" }
  /** 通知の送信(Issue #205。`mode: "notify"`)。`raceId` は、レースごとの通知ではそのレース、朝のまとめでは `summary`。`failed` は送信の失敗(再送しない)。 */
  | { readonly kind: "ran"; readonly raceId: string; readonly mode: "notify"; readonly step: "send"; readonly result: "ok" | "failed" }
  /**
   * 結果の取り込みの 1 ステップ(Issue #208。`mode: "result"`)。`raceId` は取り込んだレース。`ok` は D1 に保存した、`retry` は再試行(保留を含む)、`failed` はこの依頼としては諦めた。
   */
  | { readonly kind: "ran"; readonly raceId: string; readonly mode: "result"; readonly step: "import"; readonly result: "ok" | "retry" | "failed" };

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

/** 朝のまとめ(#205)のための、計画の読み取り(状態は変えない)。 */
export interface PlanProgress {
  /** `none`: 依頼の前 / `pending`: 依頼後〜確定の前 / `done`: 確定済み。 */
  readonly stage: "none" | "pending" | "done";
  readonly requestedAt: number | null;
  readonly finalizedAt: number | null;
  /** 計画時点で決めた offset(分)。確定の前は null。 */
  readonly offsetMinutes: number | null;
  /** `default-fallback` は、設定を読めず既定値で計画したことを表す(朝のまとめに「既定値で計画した」と出すため)。 */
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
   * 朝の準備がすべて終わったか: 確定済みで、計画の行に対する morning がすべて終端(done・failed)。**一部が failed でも true**。morning を積んでいない行(skipped)は数えない。
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

/** オッズ・組合せオッズの取得先(中央の `api_get_jra_odds`・地方の `nar.netkeiba.com/odds/` 配下: `index.html`〈単勝複勝・馬連・ワイドほか〉と `odds_get_form.html`〈3連複・3連単の軸馬別〉)。発走前の計算ステップは、これらだけ、取得ステップの開始以降のキャッシュに限る。 */
export const ODDS_URL_PATTERN = /api_get_jra_odds|\/odds\//;

/** 計算ステップで、オッズのキャッシュが今回の取得より古い(前回の実行の残り)ときに投げる。 */
class StaleOddsError extends Error {
  constructor(url: string) {
    super(`オッズのキャッシュが今回の取得より前のものです(使いません): ${url}`);
    this.name = "StaleOddsError";
  }
}

/** 計算ステップで、キャッシュに無いものをネットワークに取りに行かないための取得器(呼ばれたら投げる)。 */
class CacheMissError extends Error {
  constructor(url: string) {
    super(`キャッシュに無い取得先です(計算ステップは netkeiba には出ません): ${url}`);
    this.name = "CacheMissError";
  }
}

const cacheOnlyFetcher: TextFetcher = {
  fetchText: async (url) => {
    throw new CacheMissError(url);
  },
};

function errorMessage(error: unknown): string {
  if (error instanceof HttpError && error.cause instanceof GateRefusedError) {
    return error.cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 再試行しても直らない失敗(ブレーカーが開いている・許可リスト外)。 */
function isFatalFetchError(error: unknown): boolean {
  if (error instanceof HttpError && error.cause instanceof GateRefusedError) {
    return error.cause.reason === "blocked" || error.cause.reason === "disallowed-url";
  }
  return false;
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
  private readonly llm: CloudLlm | undefined;
  /** 分析モデルの選択(`analysisModel`)に応じたモデルの自動選択(系統ごとの取得結果・降格を、この DO の寿命の間だけ覚える。`llm.lister` が無ければ undefined。Issue #158)。 */
  private readonly modelSelectorFor: ModelSelectorFor | undefined;
  private readonly plan: PlanStore;
  /** 通知の表(Issue #205。新しい表だけ)。 */
  private readonly notifyStore: NotifyStore;
  /** Discord への送信。無ければ(webhook が無効)通知の仕組み全体が無効。 */
  private readonly notifier: DiscordNotifier | undefined;
  private readonly appBaseUrl: string | undefined;
  /** 結果の取り込みの表(Issue #208。新しい表だけ)。 */
  private readonly results: ResultImportStore;
  /** 結果の保存先。無ければ結果の仕組み全体が無効。 */
  private readonly resultStore: ResultStoreDeps | undefined;
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
    this.onWarn = deps.onWarn;
    this.sink = deps.sink;
    this.loadSettings = deps.loadSettings;
    this.llm = deps.llm;
    this.modelSelectorFor = deps.llm === undefined ? undefined : createCloudModelSelectors(deps.llm, deps.onWarn);
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
    // 朝の計画の表(Issue #203。新しい表だけ。既存の表には ALTER しない)。
    this.plan = new PlanStore(this.sql);
    // 通知の表(Issue #205。新しい表だけ。既存の表には ALTER しない)。
    this.notifyStore = new NotifyStore(this.sql);
    this.notifier = deps.notifier;
    this.appBaseUrl = deps.appBaseUrl;
    // 結果の取り込みの表(Issue #208。新しい表だけ。既存の表には ALTER しない)。
    this.results = new ResultImportStore(this.sql);
    this.resultStore = deps.resultStore;
    this.cache = new DoSqlCacheStore({ sql: this.sql, now: this.now, onWarn: this.onWarn });
    // RaceDay から gate への呼び出しは直列(同時に1本)。HttpClient は間隔 0・再試行 0(間隔制御は gate だけが行う)。
    // 結果のページは同じ HttpClient(同じ直列化した gate)を、キャッシュを通さずに使う(DO の SQLite に結果のページを溜めない。Issue #208)。
    const httpClient = createGateHttpClient(serializeGate(deps.gate), { onWarn: deps.onWarn });
    this.httpClient = httpClient;
    this.networkFetcher = new CachedFetcher({ fetcher: httpClient, cache: this.cache });
    this.cacheOnly = new CachedFetcher({ fetcher: cacheOnlyFetcher, cache: this.cache });
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
   * レースの朝の準備(`morning`。既定)または発走前の分析(`pre_race`)を予約する。予約だけをして戻る(取得はしない)。
   * @throws 無効な raceId・開催日・mode、DO の開催日と違う日、raceId の年と開催日の年が違う(地方は月日も)、1日の上限、発走前の分析の保存先が無い構成
   */
  async schedule(input: ScheduleInput): Promise<ScheduleResult> {
    const mode = input.mode ?? "morning";
    if (!TASK_MODES.includes(mode)) {
      throw new Error(`mode は morning か pre_race です(渡された値: ${String(mode).slice(0, 32)})`);
    }
    const raceId = parseRaceId(input.raceId);
    const kaisaiDate = parseKaisaiDate(input.kaisaiDate);
    const pinned = this.metaGet("kaisai_date");
    if (pinned !== null && pinned !== kaisaiDate) {
      throw new Error(`この DO は開催日 ${pinned} 専用です(渡された開催日: ${kaisaiDate})`);
    }
    // 年(どのレースでも)・月日(地方のレースID。中央は日付を含まない)の整合。入口(handler.ts)でも確かめているが、RPC を直接呼ばれても守る。
    const consistent = checkRaceDate(raceId, kaisaiDate);
    if (!consistent.ok) {
      throw new Error(consistent.message);
    }
    if (mode === "pre_race" && (this.sink === undefined || this.loadSettings === undefined)) {
      throw new Error("発走前の分析の保存先(D1・R2)・設定が、この構成にはありません");
    }
    if (pinned === null) {
      this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('kaisai_date', ?)", kaisaiDate);
    }
    const existing = this.task(raceId, mode);
    if (existing !== null && (existing.status === "queued" || existing.status === "fetched")) {
      return { accepted: false, raceId, mode, status: existing.status };
    }
    if (existing === null) {
      const count = (this.sql.exec("SELECT COUNT(*) AS n FROM race_day_tasks").toArray() as { n: number }[])[0]?.n ?? 0;
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
   * タスクを queued で積む(新しい実行として作り直す)。**検証・上限・実行中の確認は呼び出し側**(`schedule`・計画の確定・期限の昇格)。アラームは張らない(呼び出し側が `rearm` する)。
   */
  private enqueueTask(raceId: string, mode: TaskMode, now: number): void {
    // 新しい実行: 前の実行の LLM の応答の記録も消す(新しい分析は、あらためて LLM に送る。前の記録を再生しない)。
    SqlLlmResponseStore.clear(this.sql, raceId, mode);
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
   * 朝の計画を依頼する(Issue #203 段階2。cron の `scheduled`〈scheduled.ts。#206〉から呼ぶ入口)。**依頼だけをして戻る**(一覧の取得・確定はアラームの中)。
   * 会場2つ(中央・地方)を pending で作り、アラームを張る。**2回目以降(cron の重複配信・scheduled の再試行)は受理せず、状態を変えない**(`already-planned`)。
   * ただし**アラームは状態から張り直す**(Issue #206 G-E2。1回目が行を書いたあと `setAlarm` で失敗した場合に、再配信でアラームが戻る)。
   * @throws 無効な開催日、DO の開催日と違う日、発走前の分析の保存先・設定が無い構成(pre_race を予約できない計画は作らない)
   */
  async requestPlan(input: { readonly kaisaiDate: string }): Promise<RequestPlanResult> {
    const kaisaiDate = parseKaisaiDate(input.kaisaiDate);
    const pinned = this.metaGet("kaisai_date");
    if (pinned !== null && pinned !== kaisaiDate) {
      throw new Error(`この DO は開催日 ${pinned} 専用です(渡された開催日: ${kaisaiDate})`);
    }
    if (this.sink === undefined || this.loadSettings === undefined) {
      throw new Error("発走前の分析の保存先(D1・R2)・設定が、この構成にはありません");
    }
    if (this.plan.requested()) {
      // Issue #206(G-E2。#203 の【記録】5): 依頼を書いたあとに `setAlarm` が失敗していると、アラームが無いまま止まる。cron の再配信(または再試行)が来たときに、
      // 状態からアラームを張り直す。`rearm` は状態を変えず、候補が無ければ何もしない(冪等)。
      await this.rearm();
      return { accepted: false, reason: "already-planned" };
    }
    if (pinned === null) {
      this.sql.exec("INSERT INTO race_day_meta (key, value) VALUES ('kaisai_date', ?)", kaisaiDate);
    }
    this.plan.request(this.now());
    await this.rearm();
    return { accepted: true };
  }

  /** 朝のまとめ(#205)のための、計画の読み取り(状態は変えない)。 */
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
   * @throws 結果ストアが無い構成、無効な開催日・レースID、**今日以降の開催日**(当日中の取り込みは対象外)、年・地方の月日の不整合、1 回の件数の上限、1 日の行数の上限(1 件も積まない)
   */
  async requestResultImport(input: { readonly kaisaiDate: string; readonly raceIds: readonly string[] }): Promise<RequestResultImportResult> {
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
   * 順序: (0)期限が来た計画の行を昇格(確定済みの日だけ。手動の分析との重複の確認で D1 に出ることがある)→ (1)計画の段階(次の試行の時刻が来た会場・確定)→ (1.5)**通知**(時刻が来ていれば1件。Issue #205)→ (2)タスク({@link pickNext}。取得済みで計算待ち、なければ取得待ち。発走前が朝より先)→ (3)**結果の取り込み**(タスクが無く、計画の段階が終わっているときだけ、時刻が来ている 1 レース。期限を待つ planned の行があっても動く。Issue #208・#209)。
   * 仕事が無ければ {@link wakeWithoutWork}。
   */
  async runNextStep(): Promise<StepOutcome> {
    // 期限が来た計画の行を昇格する(同期。pre_race を積む)。続けて、同じ起床の中で、積んだ pre_race を処理できる。
    await this.promoteDuePlans();
    // 朝の計画の段階(会場の一覧の取得・確定)。次の試行の時刻が来ているものだけ(再試行の待ちは、時刻で守る)。
    const venue = this.plan.nextListVenue(this.now());
    if (venue !== null) {
      const outcome = await this.runPlanList(venue);
      await this.armAlarm();
      return outcome;
    }
    if (this.plan.finalizeDue(this.now())) {
      const outcome = await this.runPlanFinalize();
      await this.armAlarm();
      return outcome;
    }
    // 通知(Issue #205)。**タスクより前**: 発走前の通知は時間に追われる(immediate の行が多い日に、pre_race の連続が通知を押しのけない)。
    // 送信の間隔(1 秒)と失敗のクールダウン(60 秒)があるので、通知がタスクを押しのけ続けることもない。
    const notice = this.notifyPlan().sendNow;
    if (notice !== null) {
      const outcome = await this.runNotifyStep(notice);
      await this.armAlarm();
      return outcome;
    }
    const next = this.pickNext();
    if (next === null) {
      // 結果の取り込み(Issue #208。最も低い優先度)。動けるとき({@link resultsRunnable})だけ、時刻が来ている 1 レース。
      const due = this.resultsRunnable() ? this.results.nextDue(this.now()) : null;
      if (due !== null) {
        const outcome = await this.runResultStep(due);
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

  /** 通知の計画。webhook が無効(`notifier` なし)なら何もしない(行も材料も積まず、アラームの候補も出さない)。 */
  private notifyPlan(): NotificationPlan {
    if (this.notifier === undefined) {
      return { sendNow: null, nextAtMs: null };
    }
    return planNotifications({
      enabled: true,
      nowMs: this.now(),
      auto: this.getAutoRunResults(),
      progress: this.getPlanProgress(),
      rows: this.notifyStore.stateMap(),
      paceUntilMs: this.notifyStore.paceUntil(),
    });
  }

  /**
   * 通知を1件送る(**多くとも1回**)。順序: (1)送る内容を作る(同期)→ (2)**送る前に `sending` の行を書く**(同期)→ (3)`await` で送る → (4)`sent`・`failed` を書き、次の送信の時刻(間隔・クールダウン)を置く(同期)。
   * 落ちて `sending` のまま残った行は、計画({@link planNotifications})が二度と候補にしない(再送しない)。送信の失敗は分析の状態に影響しない(例外は握り、分類だけを残す)。
   * **URL・例外のメッセージ・応答の本文は、状態にもログにも出さない**(`classifyNotifyError` の分類だけ)。
   */
  private async runNotifyStep(item: NotifyItem): Promise<StepOutcome> {
    const raceId = item.kind === "summary" ? "summary" : item.raceId;
    const outcomeOf_ = (result: "ok" | "failed"): StepOutcome => ({ kind: "ran", raceId, mode: "notify", step: "send", result });
    let payloadJson: string;
    let analysisId: number | null = null;
    try {
      if (item.kind === "analysis") {
        const row = this.notifyStore.row(item.key);
        if (row === null || row.payload_json === null) {
          throw new Error("通知の材料がありません");
        }
        payloadJson = row.payload_json;
        analysisId = row.analysis_id;
      } else if (item.kind === "summary") {
        const kaisaiDate = this.metaGet("kaisai_date");
        if (kaisaiDate === null) {
          throw new Error("開催日が未確定です");
        }
        payloadJson = JSON.stringify(buildSummaryEmbed({ kaisaiDate, progress: this.getPlanProgress() }));
      } else {
        const result = this.getAutoRunResults().results.find((r) => r.raceId === item.raceId);
        if (result === undefined) {
          throw new Error("結果が見つかりません");
        }
        const label: RaceLabel = { raceId: result.raceId, venueName: result.venueName, raceNumber: result.raceNumber, raceName: result.raceName, startTime: result.startTime };
        const embed = item.kind === "skipped-manual" ? buildManualSkipEmbed(label) : buildFailureEmbed(label, notificationText(result.outcome));
        payloadJson = JSON.stringify(embed);
      }
    } catch (error) {
      // 送る内容を作れなかった: 送らず、failed(分類 build)にして終える(同じ項目を、毎回の起床で作り直し続けない)。
      const now = this.now();
      this.notifyStore.begin(item.key, item.kind, null, analysisId, now);
      this.notifyStore.finish(item.key, "failed", "build", now);
      this.notifyStore.setPaceUntil(now + SEND_SPACING_MS);
      this.onWarn(`Discord の通知の内容を作れませんでした(${item.key}): ${errorMessage(error)}`);
      return outcomeOf_("failed");
    }
    // 送る前に sending を書く(ここまで同期。落ちても再送しない)。
    if (!this.notifyStore.begin(item.key, item.kind, payloadJson, analysisId, this.now())) {
      return outcomeOf_("failed"); // 到達しない(計画は ready か行なしだけを返す)。二重に送らない。
    }
    let errorClass: string | null = null;
    try {
      await this.notifier!.send({ embeds: [this.withAnalysisLink(JSON.parse(payloadJson) as CloudEmbed, item, analysisId)] });
    } catch (error) {
      errorClass = classifyNotifyError(error);
    }
    const end = this.now();
    this.notifyStore.finish(item.key, errorClass === null ? "sent" : "failed", errorClass, end);
    this.notifyStore.setPaceUntil(end + (errorClass === null ? SEND_SPACING_MS : FAILURE_COOLDOWN_MS));
    if (errorClass !== null) {
      this.onWarn(`Discord への通知に失敗しました(${item.key}。分類: ${errorClass}。再送しません)`);
    }
    return outcomeOf_(errorClass === null ? "ok" : "failed");
  }

  /**
   * 分析の通知の embed に、タイトルのリンク(分析画面)を足す(Issue #230)。**送信の直前**に足す(材料には URL を入れない)。
   * 足すのは分析の通知(`kind: "analysis"`)で、基点(`appBaseUrl`)があり、分析 id が分かるときだけ。それ以外は embed のまま(リンクなしで通知する)。
   * 開催日は日のメタ(`kaisai_date`)、会場区分は計画の行(`venue`。行が無ければ中央)から取る。
   */
  private withAnalysisLink(embed: CloudEmbed, item: NotifyItem, analysisId: number | null): CloudEmbed {
    if (this.appBaseUrl === undefined || item.kind !== "analysis" || analysisId === null) {
      return embed;
    }
    const link = buildAnalysisLink(this.appBaseUrl, {
      date: this.metaGet("kaisai_date") ?? "",
      venue: this.plan.planRow(item.raceId)?.venue === "nar" ? "nar" : "central",
      raceId: item.raceId,
      analysisId,
    });
    return link === undefined ? embed : { ...embed, url: link };
  }

  /**
   * 発走前の分析が保存された直後に、通知の材料(完成した embed)を積む。**保存した `record` から作る**(馬名・コース・距離は `record.raceSnapshot` にある。D1 の要約には無く、R2 は使えないことがある)。
   * 呼び出しは、`analysis_id` を永続化する**より前**(同じ同期区間)。ここで例外になれば `analysis_id` は永続されず、再試行が保存済みを検出して、もう一度ここを通る
   * (`analysis_id` があるのに材料が無い状態が、一瞬も現れない)。**webhook が無効・手動の pre_race(自動の印が無い)なら何もしない。**
   * embed の構築の失敗は握り、最小の embed(画面で確認)に代える(通知の失敗が分析を止めない)。材料の書き込みの SQL の例外は握らない(上の理由)。
   */
  private putAnalysisMaterial(task: TaskRow, record: AnalysisRecord, outcome: LlmOutcome, analysisId: number): void {
    if (this.notifier === undefined || !this.isAutoTask(task)) {
      return;
    }
    const row = this.plan.planRow(task.race_id);
    const label: RaceLabel = {
      raceId: task.race_id,
      venueName: row?.venue_name ?? null,
      raceNumber: row?.race_number ?? null,
      raceName: row?.race_name ?? null,
      startTime: row?.start_time ?? null,
    };
    let embed: CloudEmbed;
    try {
      embed = buildAnalysisNotificationEmbed(record, outcome, label);
    } catch (error) {
      this.onWarn(`発走前の分析(${task.race_id}): 通知の材料を組み立てられませんでした(最小の通知に代えます): ${errorMessage(error)}`);
      embed = buildMinimalAnalysisEmbed(label);
    }
    this.notifyStore.putReady(`race:${task.race_id}`, JSON.stringify(embed), analysisId, this.now());
  }

  // ---- 朝の計画(Issue #203 段階2)----

  /**
   * 期限が来た計画の行(planned で `due_ms ≤ now`)を昇格する。**確定済みの日だけ**(Issue #204 G-C3: 確定の途中で落ちた状態で先に昇格すると、その行には morning が積まれず、
   * `morningAllTerminal` が偽のまま残る。確定の前の期限は、アラームの候補にもしない〈{@link PlanStore.nextDueMs}〉)。
   * 行ごとに: 手動の分析との重複の確認(D1。必要なときだけ。{@link hasRecentManualAnalysis})→ 同期の判定と投入({@link promoteRow})。
   * **起きたときに必ず状態が変わる**(積めなくても skipped にする)。
   */
  private async promoteDuePlans(): Promise<void> {
    if (this.plan.finalizedAt() === null) {
      return;
    }
    for (const row of this.plan.dueRows(this.now())) {
      // D1 に出るのは、DO にそのレースの pre_race の行(done・failed)があるときだけ(D1 の analyses を書くのは pre_race の計算だけで、起動するのは schedule〈手動・この昇格〉だけ。
      // 行が無ければ手動の分析は存在しえない)。時刻の判定でスキップになる行・実行中の手動(queued・fetched)も、D1 に聞くまでもない。
      const existing = this.task(row.race_id, "pre_race");
      const duplicate =
        existing !== null && (existing.status === "done" || existing.status === "failed") && this.promotionTiming(row).kind !== "skip"
          ? await this.hasRecentManualAnalysis(row)
          : false;
      this.promoteRow(row.race_id, duplicate);
    }
  }

  /**
   * 昇格の時点の時刻の判定: **発走済み(`now ≥ start_ms`)だけ**をスキップ(`started`)にする。発走前なら、何分前でも昇格する。
   * 「発走まで 10 分未満〈too-late〉」は**計画の時点の判定にだけ**残す(`planPreRaceDue`)。昇格の時点でも判定すると、offset = 10 分(設定の最小値)では、アラームが期限から 1ms 遅れただけで
   * 全レースが too-late になる(期限 = 発走 − 10 分のため)。昇格が遅れて発走が近いときは走らせ、発走を過ぎたら取得・計算の各ステップの直前のガード({@link failIfStarted})が止める。
   * `start_ms` が null の行は計画の時点で `no-start-time` のスキップになっていて planned には来ない(到達しない分岐。来たらスキップにする)。
   */
  private promotionTiming(row: PlanRowRecord): { readonly kind: "ok" } | { readonly kind: "skip"; readonly reason: "started" | "no-start-time" } {
    if (row.start_ms === null) {
      return { kind: "skip", reason: "no-start-time" };
    }
    return this.now() >= row.start_ms ? { kind: "skip", reason: "started" } : { kind: "ok" };
  }

  /**
   * 手動の分析が直前にあるか(Issue #204 AC-C4)。同じレースの、分析時刻が **[期限 − 15 分, 今]**(両端を含む)の分析のうち、**現行の prompt_version で、LLM が実際に効いた**もの
   * (`model` あり。LLM が効かなかった fallback と、キー未登録の分析は数えない: 数えると、そのレースには prior のままの分析しか残らない)が 1 件でもあれば true。
   * 現行 = `resolveClipVariant(設定の clipVariant).promptVersion`。設定は、候補があるときだけ読む。
   * **読み取り(D1・設定)が失敗したら false(走らせる側に倒す)**: スキップに倒すと、そのレースの分析と通知が無くなる(利用者に見える損失)。重複した場合の被害は LLM 1 回分の費用と重複行だけ。
   */
  private async hasRecentManualAnalysis(row: PlanRowRecord): Promise<boolean> {
    try {
      const dueMs = row.due_ms;
      if (dueMs === null) {
        return false; // 到達しない(planned の行は期限を持つ)
      }
      const recent = await this.sink!.findRecentByRace(row.race_id, new Date(dueMs - MANUAL_DUPLICATE_WINDOW_MS).toISOString(), new Date(this.now()).toISOString());
      const candidates = recent.filter((a) => a.promptVersion !== null && a.model !== null);
      if (candidates.length === 0) {
        return false;
      }
      const settings = await this.loadSettings!();
      const current = resolveClipVariant(settings.clipVariant).promptVersion;
      return candidates.some((a) => a.promptVersion === current);
    } catch (error) {
      this.onWarn(`朝の計画: ${row.race_id} の手動の分析の確認に失敗したため、重複なしとして続けます(${redactSecrets(errorMessage(error))})`);
      return false;
    }
  }

  /**
   * 1行の昇格(同期。await なし)。`duplicate` は、手動の分析との重複の確認の結果(await の前に調べたもの)。**判定はここで、状態を読み直してから行う**(確認の await の間に、手動の予約が入りうる)。
   *  1. 行が planned でなければ何もしない
   *  2. 同じレースの pre_race が実行中(queued・fetched): 自動の印が今のタスクを指していれば(昇格で積んだあと、promoted にする前に落ちた再実行)promoted にするだけ。
   *     そうでなければ手動の実行中なので、積み直さず skipped(manual)
   *  3. 時刻の判定(発走済み〈started〉。時刻なしは到達しない)でスキップ(too-late は昇格の時点では判定しない: {@link promotionTiming})
   *  4. 手動の分析との重複 → skipped(manual)
   *  5. 上限に達していれば skipped(cap)
   *  6. pre_race を積み、自動の印を書き、promoted にする(同じ `now`)
   */
  private promoteRow(raceId: string, duplicate: boolean): void {
    const row = this.plan.planRow(raceId);
    if (row === null || row.state !== "planned") {
      return;
    }
    const now = this.now();
    const existing = this.task(raceId, "pre_race");
    if (existing !== null && (existing.status === "queued" || existing.status === "fetched")) {
      const marker = this.plan.autoMarker(raceId);
      if (marker !== null && marker.enqueuedAt === existing.queued_at) {
        this.plan.markPromoted(raceId, now);
      } else {
        this.plan.markSkipped(raceId, "manual");
      }
      return;
    }
    const timing = this.promotionTiming(row);
    if (timing.kind === "skip") {
      this.plan.markSkipped(raceId, timing.reason);
      return;
    }
    if (duplicate) {
      this.plan.markSkipped(raceId, "manual");
      return;
    }
    if (existing === null && this.taskCount() >= MAX_TASKS_PER_DAY) {
      this.plan.markSkipped(raceId, "cap");
      return;
    }
    this.enqueueTask(raceId, "pre_race", now);
    this.plan.markAuto(raceId, now);
    this.plan.markPromoted(raceId, now);
  }

  /**
   * 計画の段階: 1会場の一覧を取る(1ステップ = gate への取得 1 本)。試行回数は取得の**前**に永続化する(クラッシュしても再実行が無限に続かない)。
   * 成功(空の一覧も)→ ok。失敗は、`blocked`(ブレーカー・許可リスト外)なら再試行せず failed、それ以外(busy・failed)は上限 {@link MAX_ATTEMPTS} まで {@link RETRY_DELAY_MS} 後に再試行して、尽きたら failed。
   * 全会場が終端(ok・failed)になったら、確定の試行を now に予約する(次のステップが確定)。
   */
  private async runPlanList(venue: PlanVenue): Promise<StepOutcome> {
    const row = this.plan.venueRow(venue)!;
    const attempts = row.attempts + 1;
    this.plan.markListAttempt(venue, attempts, this.now());
    const kaisaiDate = this.metaGet("kaisai_date");
    let result: RaceListResult;
    try {
      if (kaisaiDate === null) {
        throw new Error("開催日が未確定です");
      }
      result = await this.getRaceList(kaisaiDate, venue);
    } catch (error) {
      this.onWarn(`朝の計画: ${venue} の一覧の取得で想定外の失敗(${errorMessage(error)})`);
      result = { ok: false, reason: "failed" };
    }
    const now = this.now();
    if (result.ok) {
      this.plan.markListOk(venue, result.races.length, JSON.stringify(result.races), now);
      this.afterPlanVenueSettled(now);
      return { kind: "ran", raceId: venue, mode: "plan", step: "list", result: "ok" };
    }
    if (result.reason === "blocked" || attempts >= MAX_ATTEMPTS) {
      this.plan.markListFailed(venue, result.reason, now);
      this.onWarn(`朝の計画: ${venue} の一覧を取得できませんでした(試行 ${attempts} 回。理由: ${result.reason})`);
      this.afterPlanVenueSettled(now);
      return { kind: "ran", raceId: venue, mode: "plan", step: "list", result: "failed" };
    }
    this.plan.markListRetry(venue, now + RETRY_DELAY_MS, result.reason, now);
    return { kind: "ran", raceId: venue, mode: "plan", step: "list", result: "retry" };
  }

  /** 会場が終端になったとき、全会場が終端なら、確定の試行を今に予約する(確定は別のステップ)。 */
  private afterPlanVenueSettled(now: number): void {
    if (this.plan.allVenuesTerminal() && this.plan.finalizedAt() === null) {
      this.plan.setFinalizeNextTryAt(now);
    }
  }

  /**
   * 計画の確定: offset を決め(設定を読む。読めなければ {@link MAX_ATTEMPTS} 回まで {@link RETRY_DELAY_MS} 後に再試行し、尽きたら**既定の 45 分で確定して `plan_offset_source` に `default-fallback` を残す**)、
   * 対象(中央は全件・地方は Jpn だけ。取得できなかった会場は 0 件)ごとに、期限を計算して計画の行を書き、pre_race を走らせる行には morning を積む。
   *
   * **原子性に頼らない冪等性**(確定の途中で落ちても、再実行で正しく続く): 確定の印(`plan_finalized_at`)は最後に書く。計画の行は `ON CONFLICT DO NOTHING`(最初の計画を変えない)、
   * morning は**行がまだ無いときだけ**積む(状態に関係なく、既にあれば積み直さない)、offset は最初に決めた値を残す。再実行は、既にある行を飛ばして、足りない行・morning だけを足す。
   * skip の行には morning を積まない(pre_race が走らないので、取得のための 19 本を無駄にしない)。
   * 上限: 対象1件は morning と pre_race の2行を使うので、`既存のタスク行 + 計画済み(planned)の行 + 今回の行ぶん(2、または morning が既にあれば 1)> MAX_TASKS_PER_DAY` なら skipped(cap)。
   */
  private async runPlanFinalize(): Promise<StepOutcome> {
    const attempts = this.plan.finalizeAttempts() + 1;
    this.plan.setFinalizeAttempts(attempts);
    if (this.plan.offset() === null) {
      try {
        const settings = await this.loadSettings!();
        this.plan.decideOffset(settings.preRaceOffsetMinutes, "settings");
      } catch (error) {
        if (attempts < MAX_ATTEMPTS) {
          this.plan.setFinalizeNextTryAt(this.now() + RETRY_DELAY_MS);
          this.onWarn(`朝の計画: 設定を読めませんでした(試行 ${attempts} 回。再試行します): ${errorMessage(error)}`);
          return { kind: "ran", raceId: "plan", mode: "plan", step: "finalize", result: "retry" };
        }
        this.plan.decideOffset(DEFAULT_PRE_RACE_OFFSET_MINUTES, "default-fallback");
        this.onWarn(`朝の計画: 設定を読めなかったため、既定の ${DEFAULT_PRE_RACE_OFFSET_MINUTES} 分で計画しました(試行 ${attempts} 回): ${errorMessage(error)}`);
      }
    }
    // ここから await なし(同期の区間)。
    const kaisaiDate = this.metaGet("kaisai_date");
    const offset = this.plan.offset();
    if (kaisaiDate === null || offset === null) {
      throw new Error("開催日または offset が未確定です"); // 到達しない(依頼で開催日を固定し、上で offset を決めている)
    }
    const nowMs = this.now();
    const entriesOf = (venue: PlanVenue): RaceListEntry[] => {
      const row = this.plan.venueRow(venue);
      return row !== null && row.state === "ok" && row.entries_json !== null ? (JSON.parse(row.entries_json) as RaceListEntry[]) : [];
    };
    const targets = selectAutoRunTargets({ central: entriesOf("central"), nar: entriesOf("nar") });
    for (const target of targets) {
      const entry = target.entry;
      let row = this.plan.planRow(entry.raceId);
      if (row === null) {
        row = this.buildPlanRow(target.venue, entry, kaisaiDate, offset.minutes, nowMs);
        this.plan.insertPlanRow(row);
      }
      if (row.state === "planned" && this.task(entry.raceId, "morning") === null) {
        this.enqueueTask(entry.raceId, "morning", nowMs);
      }
    }
    for (const venue of PLAN_VENUES) {
      // 取得できた会場だけ(取得できなかった会場の「0 件」は、対象が無かったのか取れなかったのかが区別できない)。
      if (this.plan.venueRow(venue)?.state === "ok") {
        this.plan.setTargeted(venue, targets.filter((t) => t.venue === venue).length);
      }
    }
    this.enqueueSameDayResults(kaisaiDate, nowMs);
    this.plan.markFinalized(nowMs);
    this.plan.clearEntries();
    return { kind: "ran", raceId: "plan", mode: "plan", step: "finalize", result: "ok" };
  }

  /**
   * 当日中の結果の取り込みの行を積む(Issue #209。{@link runPlanFinalize} の同期区間から呼ぶ)。発走時刻のある計画の行ごとに(skip の行も含む: 前のレースの傾向の材料になる)、
   * 発走 + {@link SAME_DAY_RESULT_DELAY_MS} を最初の試行とする `queued` の行を積む。`requested_on` は**開催日**(確定が日付をまたいで遅れても、翌朝の依頼が「同じ日の依頼」と読まない)。
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

  /** 1対象の計画の行を作る(期限・すぐ実行・スキップの判定と、上限)。 */
  private buildPlanRow(venue: PlanVenue, entry: RaceListEntry, kaisaiDate: string, offsetMinutes: number, nowMs: number): PlanRowRecord {
    const due = planPreRaceDue({ kaisaiDate, startTime: entry.startTime, offsetMinutes, nowMs });
    let startMs: number | null = null;
    if (entry.startTime !== undefined) {
      try {
        startMs = startTimeEpochMs(kaisaiDate, entry.startTime);
      } catch {
        startMs = null; // 読めない時刻は no-start-time(due.kind === "skip")になっている
      }
    }
    let disposition: PlanRowRecord["disposition"] = due.kind === "skip" ? "skip" : due.kind;
    let skipReason: PlanSkipReason | null = due.kind === "skip" ? due.reason : null;
    let state: PlanRowRecord["state"] = due.kind === "skip" ? "skipped" : "planned";
    if (state === "planned") {
      const need = this.task(entry.raceId, "morning") === null ? 2 : 1; // morning(まだ無ければ)と pre_race の行
      if (this.taskCount() + this.plan.plannedCount() + need > MAX_TASKS_PER_DAY) {
        disposition = "skip";
        skipReason = "cap";
        state = "skipped";
      }
    }
    return {
      race_id: entry.raceId,
      venue,
      venue_name: entry.venue ?? null,
      race_number: entry.raceNumber,
      race_name: entry.name,
      grade: entry.grade ?? null,
      start_time: entry.startTime ?? null,
      start_ms: startMs,
      due_ms: state === "planned" && due.kind !== "skip" ? due.dueMs : null,
      offset_minutes: offsetMinutes,
      disposition,
      skip_reason: skipReason,
      state,
      planned_at: nowMs,
      promoted_at: null,
    };
  }

  private runStep(task: TaskRow): Promise<StepOutcome> {
    if (task.mode === "pre_race") {
      return task.status === "fetched" ? this.runPreRaceCompute(task) : this.runPreRaceFetch(task);
    }
    return task.status === "fetched" ? this.runCompute(task) : this.runFetch(task);
  }

  /**
   * 実行する仕事が無いときに起きた(= 掃除専用のアラーム。または早く起きた)。
   * 掃除の時刻になっていれば、保持期間を超えたキャッシュの行だけを消し、**アラームは再設定しない**(以後は新しい予約が来るまで何も起きない)。
   * まだ掃除の時刻前なら、何も消さず、同じ時刻にアラームを設定し直す(早く起きても掃除を取りこぼさない)。掃除の予約が無ければ何もしない。
   */
  private async wakeWithoutWork(): Promise<StepOutcome> {
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
      notifyAtMs: this.notifyPlan().nextAtMs,
      resultAtMs: this.resultsRunnable() ? this.results.nextTryAtMs() : null,
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

  /**
   * 結果の 1 レースを取り込む(取得 → パース → **単勝の払戻が出ていれば**保存)。**多くとも 1 レース・D1 への書き込みは 1 レースぶん(最大 5 文の 1 batch)**。
   * 取得は gate 経由・キャッシュなし。core の `importRaceResult` を、`parse` を包んで使う(単勝の払戻が 0 件なら `RaceResultNotConfirmedError` を投げる = 審議中の暫定の着順を保存しない)。
   * 試行回数は取得の前に永続化する(クラッシュしても無限に続かない)。失敗の扱い:
   *  - 未確定・払戻なし・構造の異常・取得の失敗・保存の失敗 → 試行を数えて、{@link RESULT_RETRY_DELAY_MS} 後に再試行。{@link MAX_RESULT_ATTEMPTS} 回で諦める
   *  - gate の `queue-full`・`blocked` → **試行を数えない保留**({@link RESULT_BUSY_DELAY_MS} 後。`blocked` は解除時刻の 1 秒後)。{@link MAX_RESULT_DEFERRALS} 回を超えたら諦める
   *  - 許可リスト外(`disallowed-url`) → 即座に諦める(再試行しても直らない)
   * どの経路でも状態(試行・保留・状態・次の時刻)が変わる(アラームの候補が過去のまま残って、即時に起き続けない)。警告は諦めたときだけ、分類と回数だけ(メッセージは出さない)。
   */
  private async runResultStep(row: ResultRow): Promise<StepOutcome> {
    const raceId = row.race_id;
    const outcomeOf_ = (result: "ok" | "retry" | "failed"): StepOutcome => ({ kind: "ran", raceId, mode: "result", step: "import", result });
    const attempts = row.attempts + 1;
    this.results.markAttempt(raceId, attempts, this.now());
    // 当日の行(Issue #209): 計画の確定で積んだ行 = 依頼の日が開催日。全頭の着順がそろった確認と、5 分おき・10 回の再試行が加わる。過去日の行(翌朝の依頼)は従来どおり。
    const sameDay = row.requested_on === this.metaGet("kaisai_date");
    const progress: { stage: "fetch" | "parse" | "save"; noPayout: boolean; incomplete: "short" | "unknown-size" | null } = { stage: "fetch", noPayout: false, incomplete: null };
    let imported = false;
    let failure: unknown = null;
    try {
      const outcome = await importRaceResult(parseRaceId(raceId), {
        // bypassCache は無視する: この取得はキャッシュを通らない(HttpClient を直接使う)。
        fetchText: (url) => this.httpClient.fetchText(url),
        parse: (html) => {
          progress.stage = "parse";
          const parsed = parseRaceResult(html);
          if (parsed.winPayouts.length === 0) {
            // 着順の行はあるが払戻のテーブルが出ていない(審議中の暫定の着順)。保存しない。
            progress.noPayout = true;
            throw new RaceResultNotConfirmedError("払戻のテーブルがまだありません(審議中の可能性があります)");
          }
          if (sameDay) {
            // 払戻が先に出て、全頭の着順が数分遅れて出るページ(地方で実測)を保存しない。**着順が確定している行**(`finishPosition !== null`。数値の着順と、取消・除外・中止などの非数値の着順を含む。
            // 着順のセルが空の行は数えない = 行は全頭分あっても着順が空のページも未完了)の数が、ページ自身の「N頭」に満たなければ未完了。「N頭」が取れないときは判定できないので保存しない。
            const fieldSize = parseRaceFieldSize(html);
            if (fieldSize === null || parsed.horses.filter((h) => h.finishPosition !== null).length < fieldSize) {
              progress.incomplete = fieldSize === null ? "unknown-size" : "short";
              throw new RaceResultNotConfirmedError("全頭の着順がまだそろっていません");
            }
          }
          return parsed;
        },
        saveResult: async (id, entries, courseType, comboPayouts) => {
          progress.stage = "save";
          await this.resultStore!.saveResult(id, entries, courseType, comboPayouts);
        },
      });
      imported = outcome.status === "imported";
    } catch (error) {
      failure = error;
    }
    const now = this.now();
    if (imported) {
      this.results.markImported(raceId, now);
      return outcomeOf_("ok");
    }
    if (failure === null) {
      const lastClass: ResultClass = progress.noPayout ? "no-payout" : progress.incomplete !== null ? "incomplete" : "not-confirmed";
      return this.failResult(row, attempts, lastClass, outcomeOf_, sameDay, progress.incomplete === "unknown-size" ? MAX_SAME_DAY_UNKNOWN_SIZE_ATTEMPTS : undefined);
    }
    if (progress.stage === "parse") {
      return this.failResult(row, attempts, "parse-error", outcomeOf_, sameDay);
    }
    if (progress.stage === "save") {
      return this.failResult(row, attempts, "save-failed", outcomeOf_, sameDay);
    }
    // 取得の失敗: gate の拒否は保留または即座の諦め、それ以外は試行を数える再試行。
    if (failure instanceof HttpError && failure.cause instanceof GateRefusedError) {
      const reason = failure.cause.reason;
      if (reason === "disallowed-url") {
        this.results.markGaveUp(raceId, row.deferrals, "blocked", now);
        this.warnGaveUp(raceId, "blocked", attempts, row.deferrals);
        return outcomeOf_("failed");
      }
      if (reason === "queue-full" || reason === "blocked") {
        const deferrals = row.deferrals + 1;
        const lastClass: ResultClass = reason === "blocked" ? "blocked" : "busy";
        const until = failure.cause.blockedUntil;
        const nextTryAt = reason === "blocked" && until !== undefined && until > now ? Math.min(until + 1000, now + MAX_BLOCKED_WAIT_MS) : now + RESULT_BUSY_DELAY_MS;
        // 試行は数えない(取得の前に数えた分を戻す)。
        this.results.markDeferred(raceId, row.attempts, deferrals, nextTryAt, lastClass, now);
        if (deferrals > MAX_RESULT_DEFERRALS) {
          this.results.markGaveUp(raceId, deferrals, lastClass, now);
          this.warnGaveUp(raceId, lastClass, row.attempts, deferrals);
          return outcomeOf_("failed");
        }
        return outcomeOf_("retry");
      }
    }
    return this.failResult(row, attempts, "fetch-failed", outcomeOf_, sameDay);
  }

  /**
   * 試行を数える失敗: 上限までは再試行、上限で諦める。過去日の行は {@link RESULT_RETRY_DELAY_MS} 後に {@link MAX_RESULT_ATTEMPTS} 回まで。
   * 当日の行(Issue #209)は {@link SAME_DAY_RETRY_DELAY_MS} おきに {@link MAX_SAME_DAY_ATTEMPTS} 回まで(`maxAttempts` で、判定不能のときの上限〈{@link MAX_SAME_DAY_UNKNOWN_SIZE_ATTEMPTS}〉に絞れる)。
   */
  private failResult(
    row: ResultRow,
    attempts: number,
    lastClass: ResultClass,
    outcomeOf_: (r: "ok" | "retry" | "failed") => StepOutcome,
    sameDay: boolean,
    maxAttempts?: number,
  ): StepOutcome {
    const now = this.now();
    const limit = maxAttempts ?? (sameDay ? MAX_SAME_DAY_ATTEMPTS : MAX_RESULT_ATTEMPTS);
    if (attempts >= limit) {
      this.results.markGaveUp(row.race_id, row.deferrals, lastClass, now);
      this.warnGaveUp(row.race_id, lastClass, attempts, row.deferrals);
      return outcomeOf_("failed");
    }
    this.results.markRetry(row.race_id, now + (sameDay ? SAME_DAY_RETRY_DELAY_MS : RESULT_RETRY_DELAY_MS), lastClass, now);
    return outcomeOf_("retry");
  }

  private warnGaveUp(raceId: string, lastClass: ResultClass, attempts: number, deferrals: number): void {
    this.onWarn(`結果の取り込みを諦めました(${raceId}。分類 ${lastClass}。試行 ${attempts} 回・保留 ${deferrals} 回)`);
  }

  // ---- 朝(morning) ----

  private async runFetch(task: TaskRow): Promise<StepOutcome> {
    const attempts = task.attempts + 1;
    // 試行回数は取得の前に永続化する(取得の途中でクラッシュしても、再実行が無限に続かない)。
    this.updateTask(task, "queued", attempts, task.error);
    try {
      // 設定(スコアリングの重み。Issue #218)を読んでタスクに固定する(発走前の取得と同じ流儀。取得〜計算で重みが変わらない。再試行では読み直さない)。
      // 読めなければ投げる(下の catch が再試行し、尽きたら failed。既定値の重みで黙って prior を作らない)。`loadSettings` の無い構成は読まない(計算は既定値の重み)。
      if (task.settings_json === null && this.loadSettings !== undefined) {
        const settings = await this.loadSettings();
        this.setTaskFields(task, { settings_json: JSON.stringify(settings) });
      }
      const race = await scrapeRace(
        parseRaceId(task.race_id),
        { fetcher: this.networkFetcher, now: () => new Date(this.now()) },
        { includeComboOdds: false },
      );
      const missing = race.meta.warnings.filter((w) => w.kind === "戦績");
      if (missing.length > 0) {
        throw new Error(`戦績を取得できなかった馬が ${missing.length} 頭います(${missing[0]!.message})`);
      }
      this.updateTask(task, "fetched", attempts, null);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "fetch", result: "ok" };
    } catch (error) {
      const message = errorMessage(error);
      if (isFatalFetchError(error) || attempts >= MAX_ATTEMPTS) {
        this.updateTask(task, "failed", attempts, message);
        this.onWarn(`朝の取得に失敗しました(${task.race_id}。試行 ${attempts} 回): ${message}`);
        return { kind: "ran", raceId: task.race_id, mode: "morning", step: "fetch", result: "failed" };
      }
      this.updateTask(task, "queued", attempts, message);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "fetch", result: "retry" };
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
      const result = await runCloudAnalysis(raceId, parseKaisaiDate(kaisaiDate), {
        scrape: (id) => this.scrapeFromCache(id, false),
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
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "compute", result: "ok" };
    } catch (error) {
      const message = errorMessage(error);
      this.updateTask(task, "failed", task.attempts, message);
      this.onWarn(`朝の prior の計算に失敗しました(${task.race_id}): ${message}`);
      return { kind: "ran", raceId: task.race_id, mode: "morning", step: "compute", result: "failed" };
    }
  }

  /**
   * キャッシュだけから `scrapeRace` する(netkeiba には出ない。鮮度は実質無期限)。戦績が1頭でも無ければ投げる(戦績なしの分析を黙って作らない)。
   * `oddsSince`(発走前の分析の取得ステップの開始時刻)を渡すと、**オッズ・組合せオッズは、その時刻以降に取得したキャッシュだけ**を使う
   * (それより古いもの〈前回の発走前の実行で残った、保持 26 時間のキャッシュ〉は、無いものとして扱う)。古い組合せが「今のオッズ」として配分に使われるのを防ぐ。
   * 無い組合せは、exe で組合せの取得が失敗したときと同じく、`scrapeRace` が警告にして、その券種を除く。単勝・複勝のオッズが古い(無い)ときは投げる(必須のデータ)。
   */
  private async scrapeFromCache(raceId: Parameters<typeof scrapeRace>[0], includeComboOdds: boolean, oddsSince?: number) {
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
    const race = await scrapeRace(
      raceId,
      { fetcher, now: () => new Date(this.now()), ttl: CACHE_ONLY_TTL },
      { includeComboOdds },
    );
    const missing = race.meta.warnings.filter((w) => w.kind === "戦績");
    if (missing.length > 0) {
      throw new Error(`キャッシュに戦績がありません(${missing.length} 頭分)。取得をやり直してください`);
    }
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
        { fetcher: this.networkFetcher, now: () => new Date(this.now()) },
        { includeComboOdds: settings.includeComboOdds, bypassOddsCache: true },
      );
      const missing = race.meta.warnings.filter((w) => w.kind === "戦績");
      if (missing.length > 0) {
        throw new Error(`戦績を取得できなかった馬が ${missing.length} 頭います(${missing[0]!.message})`);
      }
      await this.prefetchGradeWinner(task, parseRaceId(task.race_id), race.race.hasGradeBadge);
      this.updateTask(task, "fetched", attempts, null);
      return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "fetch", result: "ok" };
    } catch (error) {
      const message = errorMessage(error);
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
      let scrapeWarnings: readonly { readonly kind: string; readonly message: string }[] = [];
      if (analysisId === null) {
        const raceId = parseRaceId(task.race_id);
        // LLM(Issue #194)。clipVariant は1回だけ解決し、補正の最大幅(analyzeRace)と、プロンプト・promptVersion(runAnalysis の deps.clipVariant)の両方に同じ値を使う
        // (文面の許容幅とクリップ幅の食い違いを構造的に防ぐ。exe の pipeline-deps.ts と同じ)。
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
            const race = await this.scrapeFromCache(id, settings.includeComboOdds, oddsSince);
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
              this.putAnalysisMaterial(task, record, outcome, existing); // analysis_id より前(同じ同期区間。Issue #205)
              this.setTaskFields(task, { analysis_id: existing });
              return;
            }
            // LLM を呼んだ1回ごとの記録(所要時間・usage・stop_reason。Issue #197 段2)。キー未登録(cloudAnalyze なし)は null(NULL で保存)。
            const saved = await sink.save(toSave, { llmNote: outcome.note, llmCalls: cloudAnalyze === null ? null : cloudAnalyze.calls() });
            analysisId = saved.id;
            // 通知の材料を、analysis_id の永続化より前に積む(Issue #205。同じ同期区間。以降の再実行が、材料の無い done にならない)。
            this.putAnalysisMaterial(task, record, outcome, saved.id);
            // 保存の直後に結果を書く(以降の再実行は、保存も計算もしない)。
            this.setTaskFields(task, { analysis_id: saved.id, detail: saved.detail });
          },
          allocationSettings: {
            bankroll: settings.bankroll,
            perRaceCap: settings.perRaceCap,
            kellyFraction: settings.kellyFraction,
            includeComboOdds: settings.includeComboOdds,
            includeWideInAllocation: settings.includeWideInAllocation,
            includeTrioInAllocation: settings.includeTrioInAllocation,
            includeQuinellaInAllocation: settings.includeQuinellaInAllocation,
            includeExactaInAllocation: settings.includeExactaInAllocation,
            includeTrifectaInAllocation: settings.includeTrifectaInAllocation,
            includeBracketQuinellaInAllocation: settings.includeBracketQuinellaInAllocation,
          },
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
          this.onWarn(`発走前の分析(${task.race_id}): ${warning.kind}: ${warning.message}`);
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
      // 完了した(保存済み)ので、LLM の応答の記録は要らない。
      SqlLlmResponseStore.clear(this.sql, task.race_id, task.mode);
      return { kind: "ran", raceId: task.race_id, mode: "pre_race", step: "compute", result: "ok" };
    } catch (error) {
      const message = redactSecrets(errorMessage(error));
      if (computeAttempts >= MAX_ATTEMPTS) {
        this.updateTask(task, "failed", task.attempts, message);
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
