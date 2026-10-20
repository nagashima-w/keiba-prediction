/**
 * 日単位の DO(`RaceDayCore`)の、**締切の直前の再計算の段階**(Issue #338〈#335-A1〉。Issue #399〈#390 R-9a〉で `race-day-core.ts` から切り出した)。
 * **純ロジック**: `cloudflare:workers` を import しない。DO の SQLite の表は `CloseStore`(`race-day-close.ts`)が持ち、この段階は**取得・再計算・保存の手順**だけを持つ。
 * 時計・保存先・取得口・警告の出口は注入(`CloseStageDeps`)。`BabaStage`(`race-day-baba.ts`)と同じ形で、`setAlarm`・`rearm` には触れない(アラームは本体が `runNextStep` の中で張る)。
 *
 * ## 本体との境界
 *  - 登録: 本体の計算ステップ(`runPreRaceCompute`)の `saveAnalysis` が、分析の保存と**同じ同期区間**で {@link CloseStage.register} を呼ぶ(2 箇所)。
 *  - 実行: 本体の `runNextStep` が、通知の後・馬場とタスクの前に、時刻が来た行(`CloseStore.nextDue`)を {@link CloseStage.runStep} に渡す。戻り値のあとの `armAlarm` は本体。
 *  - 再予約でのそのレースの行の削除(`CloseStore.clear`)、アラームの候補(`CloseStore.nextAtMs`)は本体が `CloseStore` を直接使う。
 *
 * 手順の仕様(順序・再試行・理由の語彙)は、各メソッドの JSDoc と `race-day-core.ts` 冒頭の「締切の直前の再計算」を参照。メソッドの本体は切り出し前から変えていない。
 */
import type { CachedFetcher } from "../../packages/core/src/scraper/cached-fetcher";
import { scrapeRace, type RaceData, type RaceFetcher } from "../../packages/core/src/scraper/scrape-race";
import { parseRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids";
import { narOddsPageUrl } from "../../packages/core/src/scraper/urls";
import { toSafeRaceSnapshot } from "../../packages/core/src/analysis/analysis-export";
import { recomputeAllocationFromProbs } from "../../packages/core/src/analysis/recompute-allocation";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { closeComboBasis, type CloseReason, type CloseRound, type CloseSavePayload } from "./analysis-close";
import type { DoSqlCacheStore } from "./do-cache-store";
import { redactSecrets } from "./llm-run";
import { startTimeEpochMs } from "./pre-race-time";
import {
  CLOSE_FETCH_MAX_ATTEMPTS,
  CLOSE_FETCH_RETRY_DELAY_MS,
  CLOSE_SAVE_MAX_ATTEMPTS,
  CLOSE_SAVE_RETRY_DELAY_MS,
  parseCloseInput,
  parseClosePayload,
  type CloseInput,
  type CloseStore,
  type CloseTaskRow,
} from "./race-day-close";
import { allocationSettingsOf, CACHE_ONLY_TTL, CacheMissError, errorMessage, isFatalFetchError, ODDS_URL_PATTERN } from "./race-day-support";
import type { CloudSettings } from "./settings";

/** 1 ステップの結果(`StepOutcome` の 1 種)。`round` は回(1 = 発走 5 分前、2 = 2 分前〈暫定〉)。`ok` は再計算できて D1 に保存した、`retry` は取得か保存の再試行待ち、`failed` は再計算できなかった・行わなかった(D1 に失敗・スキップの行を保存した。保存を諦めた回も含む)。`reason` は D1 に書いた固定の理由(`ok`・`retry` は null)。 */
export interface CloseStepOutcome {
  readonly kind: "ran";
  readonly raceId: string;
  readonly mode: "close";
  readonly step: "recompute";
  readonly round: number;
  readonly result: "ok" | "retry" | "failed";
  readonly reason: CloseReason | null;
}

/** 保存先のうち、この段階が使う部分(`AnalysisSink.saveClose`。省略可=無い構成では再計算の仕組み全体が無効)。 */
export interface CloseSink {
  saveClose?(analysisId: number, payload: CloseSavePayload): Promise<void>;
}

/** 登録に要る、発走前のタスクの列(`TaskRow` の一部)。 */
export interface CloseRegisterTask {
  readonly race_id: string;
  readonly queued_at: number;
  readonly fetch_started_at: number | null;
}

export interface CloseStageDeps {
  /** 締切の再計算の表(本体も同じものを持つ: 再予約での削除・アラームの候補)。 */
  readonly store: CloseStore;
  readonly now: () => number;
  /** 警告の出口(本体の `onWarn`。鍵の形を伏せる包みを通した後のもの)。 */
  readonly onWarn: (message: string) => void;
  readonly sink: CloseSink | undefined;
  /** DO が固定された開催日(YYYYMMDD。`race_day_meta` の `kaisai_date`)。未確定は null。呼ぶたびに読む。 */
  readonly kaisaiDate: () => string | null;
  /** gate 経由の取得(キャッシュ付き)。オッズだけをキャッシュを迂回して取るのに使う。 */
  readonly networkFetcher: CachedFetcher;
  /** キャッシュだけを読む取得(無ければ {@link CacheMissError})。 */
  readonly cacheOnly: CachedFetcher;
  /** 取得キャッシュ(`fetch_cache`)。地方の部分的な取り直しが、分析時の組合せオッズを読むのに使う。 */
  readonly cache: Pick<DoSqlCacheStore, "get">;
}

export class CloseStage {
  private readonly close: CloseStore;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;
  private readonly sink: CloseSink | undefined;
  private readonly kaisaiDate: () => string | null;
  private readonly networkFetcher: CachedFetcher;
  private readonly cacheOnly: CachedFetcher;
  private readonly cache: Pick<DoSqlCacheStore, "get">;

  constructor(deps: CloseStageDeps) {
    this.close = deps.store;
    this.now = deps.now;
    this.onWarn = deps.onWarn;
    this.sink = deps.sink;
    this.kaisaiDate = deps.kaisaiDate;
    this.networkFetcher = deps.networkFetcher;
    this.cacheOnly = deps.cacheOnly;
    this.cache = deps.cache;
  }

  /**
   * 発走前の分析の保存と同じ同期区間で、再計算の入力(馬ごとの確率・枠番・馬名と、配分に使う設定)と、回の行(発走の 5 分前・2 分前)を積む。**自動・手動のどちらの分析でも積む**
   * (自動の印を見ない)。保存先が `saveClose` を持たない構成・発走を過ぎている分析は積まない。**失敗は握って警告にする**(分析の保存を止めない。この機能が壊れても分析は完了する)。
   * 計算ステップの再実行(`existing` の経路を含む)では、積み済みの行・入力を変えない(`CloseStore.register` が `ON CONFLICT DO NOTHING`)。
   */
  register(task: CloseRegisterTask, record: AnalysisRecord, analysisId: number, settings: CloudSettings): void {
    if (this.sink?.saveClose === undefined) {
      return;
    }
    try {
      const kaisaiDate = this.kaisaiDate();
      const snapshot = toSafeRaceSnapshot(record.raceSnapshot);
      const startTime = snapshot.race.startTime;
      if (kaisaiDate === null || typeof startTime !== "string") {
        this.onWarn(`締切の直前の再計算の入力を積めませんでした(${task.race_id}): 開催日または発走時刻が分かりません`);
        return;
      }
      // 出馬表の時刻は 1 桁の時間(`9:50`)を取りうる。`startTimeEpochMs` は 2 桁を要求するので揃える(`enqueueResultForAnalyzedRace` と同じ)。
      const startMs = startTimeEpochMs(kaisaiDate, startTime.padStart(5, "0"));
      const horses = record.horses.map((h) => {
        const snap = snapshot.horsesByUmaban.get(h.umaban);
        if (snap === undefined || typeof snap.wakuban !== "number" || typeof snap.name !== "string") {
          throw new RangeError(`馬番 ${h.umaban} の枠番・馬名がスナップショットにありません`);
        }
        return {
          umaban: h.umaban,
          wakuban: snap.wakuban,
          horseName: snap.name,
          prior: h.prior,
          adjustedProb: h.adjustedProb,
          hadWinOdds: typeof snap.winOdds === "number",
          hadPlaceOdds: h.placeOddsMin !== null,
        };
      });
      const input: CloseInput = {
        v: 1,
        kaisaiDate,
        horses,
        allocationSettings: allocationSettingsOf(settings),
        evThreshold: settings.evThreshold,
        baseRoute: record.allocation?.meta.route ?? null,
        // 組合せが ON のときだけ、分析時の組合せオッズを取得キャッシュから読んでよい期間を控える(Issue #379。地方の部分的な取り直しが使う。下限 = 取得ステップの開始、上限 = いま=分析の保存)。
        ...(settings.includeComboOdds && task.fetch_started_at !== null ? { comboFromMs: task.fetch_started_at, comboToMs: this.now() } : {}),
      };
      this.close.register({ raceId: task.race_id, instance: task.queued_at, analysisId, startMs, now: this.now(), input });
    } catch (error) {
      this.onWarn(`締切の直前の再計算の入力を積めませんでした(${task.race_id})。分析は続けます: ${redactSecrets(errorMessage(error)).slice(0, 200)}`);
    }
  }

  /**
   * 締切の再計算の取得口。オッズ(`ODDS_URL_PATTERN`)はキャッシュを迂回して取り、それ以外(出馬表・戦績・調教)はキャッシュだけから読む(キャッシュに無ければ投げる=ネットワークに出ない)。
   * **`comboWindow` を渡すと(地方で組合せが ON=部分的な取り直し。Issue #379)**、単勝・複勝のページ(`narOddsPageUrl`)だけをネットワークから取り、ほかのオッズ(組合せ。三連複・三連単は軸馬別)は
   * **取得キャッシュの分析時のエントリを読む**(分析の計算ステップが組合せを読むのと同じ。ネットワークに出ない)。エントリは取得時刻が `[from, to]` の範囲にあるものだけ使う
   * (範囲の外 = 前の実行の残り、または分析の後の別の取得で上書きされたもの = 分析時のオッズではない。無いものとして {@link CacheMissError} を投げる)。
   *
   * 同じ取得キャッシュ(`fetch_cache`)に組合せのキー(`/odds/` 配下の単勝・複勝以外)を書く経路は 3 つだけ: 本体(`race-day-core.ts`)の発走前の取得ステップ(`runPreRaceFetch`)と地方三連単の軸の取得(`runNarTrifectaStep`)が
   * `networkFetcher` で書く 2 つと、この取得口(中央の組合せ ON の再計算。`comboWindow` 無し)。本体の `networkFetcher` の使用箇所は `grep -n "this.networkFetcher" cloud/src/race-day-core.ts` で一覧できる。
   * 朝の取得(`includeComboOdds: false`)・一覧・重賞の過去10年は組合せのキーを書かない。地方の部分的な取り直しは単勝・複勝のキーしか書かない。
   */
  private closeFetcher(singleOddsUrl: string, comboWindow: { readonly from: number; readonly to: number } | null): RaceFetcher {
    return {
      fetchText: (url, options) => {
        if (!ODDS_URL_PATTERN.test(url)) {
          return this.cacheOnly.fetchText(url, options);
        }
        if (comboWindow !== null && url !== singleOddsUrl) {
          const entry = this.cache.get(url);
          if (entry === undefined || entry.fetchedAt < comboWindow.from || entry.fetchedAt > comboWindow.to) {
            return Promise.reject(new CacheMissError(url));
          }
          return Promise.resolve(entry.value);
        }
        return this.networkFetcher.fetchText(url, { ...options, bypassCache: true });
      },
    };
  }

  /**
   * 締切の直前の再計算の 1 ステップ(1 回ぶん)。順序: (1)最初に動いた時刻を永続化 → (2)DO に結果(`payload_json`)があれば取り直さずに(3)へ / 無ければ {@link CloseStage.computeClosePayload} で
   * 取得・再計算(または行わない・失敗の判断)をして、**保存の前に**結果を DO に書く → (3)D1 に保存(`saveClose`。(分析, 回)の UPSERT なので再保存は冪等)→ done。
   * 取得の再試行は {@link CLOSE_FETCH_MAX_ATTEMPTS} まで、保存の再試行は {@link CLOSE_SAVE_MAX_ATTEMPTS} まで(尽きたら abandoned。D1 に行は残らず、警告だけを残す)。
   * 例外は投げない(失敗は状態と戻り値に出る)。通知はしない。
   */
  async runStep(row: CloseTaskRow): Promise<CloseStepOutcome> {
    const raceId = row.race_id;
    const round = row.round;
    const now = this.now();
    this.close.markFired(raceId, round, now);
    const firedAtMs = row.fired_at ?? now;
    const lateMs = Math.max(0, firedAtMs - row.due_ms);
    const outcome = (result: "ok" | "retry" | "failed", reason: CloseReason | null): CloseStepOutcome => ({ kind: "ran", raceId, mode: "close", step: "recompute", round, result, reason });
    const saveClose = this.sink?.saveClose?.bind(this.sink);
    if (saveClose === undefined) {
      this.close.markAbandoned(raceId, round, row.save_attempts);
      this.onWarn(`締切の直前の再計算を保存できません(${raceId}。回 ${round}): 保存先が対応していません`);
      return outcome("failed", null);
    }
    let payload = row.payload_json === null ? null : parseClosePayload(row.payload_json);
    if (payload === null) {
      const computed = await this.computeClosePayload(row, now, firedAtMs, lateMs);
      if (computed.kind === "retry") {
        this.close.markFetchRetry(raceId, round, computed.attempts, computed.nextTryAt);
        return outcome("retry", null);
      }
      payload = computed.payload;
      this.close.setAttempts(raceId, round, computed.attempts);
      this.close.setPayload(raceId, round, JSON.stringify(payload));
      if (payload.status !== "ok") {
        this.onWarn(`締切の直前の再計算を行いませんでした(${raceId}。回 ${round}): ${payload.status} ${payload.reason ?? ""}`);
      }
    }
    try {
      await saveClose(row.analysis_id, payload);
    } catch (error) {
      const saveAttempts = row.save_attempts + 1;
      if (saveAttempts >= CLOSE_SAVE_MAX_ATTEMPTS) {
        this.close.markAbandoned(raceId, round, saveAttempts);
        this.onWarn(`締切の直前の再計算の保存を諦めました(${raceId}。回 ${round}。試行 ${saveAttempts} 回): ${redactSecrets(errorMessage(error)).slice(0, 200)}`);
        return outcome("failed", payload.reason);
      }
      this.close.markSaveRetry(raceId, round, saveAttempts, now + CLOSE_SAVE_RETRY_DELAY_MS);
      return outcome("retry", null);
    }
    this.close.markDone(raceId, round);
    return outcome(payload.status === "ok" ? "ok" : "failed", payload.reason);
  }

  /**
   * 1 回ぶんの結果を決める(取得・再計算、または行わない・失敗の判断)。**静的な事実(地方・未設定)→ 時刻(too-late)→ 取得 → 馬の集合の確認 → 再計算**の順で、最初に当たったものが結果になる。
   * 取得は {@link CloseStage.closeFetcher}(オッズだけネットワーク)。ブレーカー(blocked)・許可リスト外は再試行しない。それ以外の取得の失敗(組合せオッズの取得の警告を含む)は、試行が
   * {@link CLOSE_FETCH_MAX_ATTEMPTS} 未満で、再試行の時刻が次の回の時刻(最後の回は発走)より前のときだけ再試行を返す(それ以外は fetch-failed)。
   */
  private async computeClosePayload(
    row: CloseTaskRow,
    now: number,
    firedAtMs: number,
    lateMs: number,
  ): Promise<{ readonly kind: "payload"; readonly payload: CloseSavePayload; readonly attempts: number } | { readonly kind: "retry"; readonly attempts: number; readonly nextTryAt: number }> {
    const attempts = row.attempts + 1;
    const base = { round: row.round as CloseRound, dueAtMs: row.due_ms, firedAtMs, lateMs };
    const result = (payload: CloseSavePayload) => ({ kind: "payload" as const, payload, attempts });
    const failed = (reason: "analysis-failed" | "fetch-failed" | "horse-set-mismatch" | "compute-failed" | "blocked" | "combo-missing") =>
      result({ ...base, status: "failed", reason, oddsOfficialDatetime: null, allocation: null });
    const skipped = (reason: "too-late" | "unset") => result({ ...base, status: "skipped", reason, oddsOfficialDatetime: null, allocation: null });

    const inputRow = this.close.inputRow(row.race_id);
    const input = inputRow === null ? null : parseCloseInput(inputRow.input_json);
    if (inputRow === null || input === null) {
      return failed("analysis-failed");
    }
    let raceId: ReturnType<typeof parseRaceId>;
    try {
      raceId = parseRaceId(row.race_id);
    } catch {
      return failed("analysis-failed");
    }
    if (input.baseRoute === "unset") {
      return skipped("unset");
    }
    // この回が意味を持つのは、次の回の時刻(最後の回は発走)より前。起きたのが遅く、過ぎていたら、取りに行かない。
    const supersedeAt = this.close.nextRoundDueMs(row.race_id, row.round) ?? inputRow.start_ms;
    if (now >= supersedeAt) {
      return skipped("too-late");
    }
    // 地方で組合せが ON: 部分的な取り直し(単勝・複勝だけ取り、組合せは分析時のオッズ。Issue #379)。期間が無い入力(この機能の前に積まれたもの)は、読めないので何も取らずに combo-missing。
    const venueKind = venueKindOfRaceId(raceId);
    const partial = closeComboBasis(venueKind, input.allocationSettings.includeComboOdds) === "analysis";
    if (partial && (input.comboFromMs === undefined || input.comboToMs === undefined)) {
      return failed("combo-missing");
    }
    const comboWindow = partial ? { from: input.comboFromMs!, to: input.comboToMs! } : null;
    const fetchFailure = (error: unknown) => {
      this.onWarn(`締切の直前の再計算の取得に失敗しました(${row.race_id}。回 ${row.round}。試行 ${attempts} 回): ${errorMessage(error)}`);
      const retryAt = now + CLOSE_FETCH_RETRY_DELAY_MS;
      // キャッシュに無い(出馬表などが掃除された)のは、待っても直らない。ネットワークに出ないので、再試行しない。
      const retryable = !(error instanceof CacheMissError);
      return retryable && attempts < CLOSE_FETCH_MAX_ATTEMPTS && retryAt < supersedeAt ? ({ kind: "retry" as const, attempts, nextTryAt: retryAt }) : failed("fetch-failed");
    };
    let race: RaceData;
    try {
      race = await scrapeRace(
        raceId,
        { fetcher: this.closeFetcher(venueKind === "nar" ? narOddsPageUrl(raceId) : "", comboWindow), now: () => new Date(this.now()), ttl: CACHE_ONLY_TTL },
        // 騎手の成績は要らない(オッズだけを取り直す)。組合せは分析時の設定(スナップショット)と同じ。地方三連単の段階取得(`deferNarTrifecta`)は使わない(部分的な取り直しは、軸ごとのページもキャッシュから読む)。
        { includeComboOdds: input.allocationSettings.includeComboOdds, includeJockeyStats: false, bypassOddsCache: true },
      );
    } catch (error) {
      return isFatalFetchError(error) ? failed("blocked") : fetchFailure(error);
    }
    // 組合せオッズの取得に警告(失敗・部分被覆・構造異常)があれば、その券種が配分から静かに抜ける=見かけの買い目の削除になる。結果にしない。
    const comboWarning = race.meta.warnings.find((w) => w.kind === "組合せオッズ");
    if (comboWarning !== undefined) {
      // 部分的な取り直しでは、組合せはキャッシュからしか読まない=待っても直らない。再試行せず combo-missing。
      return partial ? failed("combo-missing") : fetchFailure(new Error(comboWarning.message));
    }
    // 馬の集合の確認: 出馬表(キャッシュ)の馬が分析時と同じで、分析時にオッズのあった馬のオッズが今もあること(取消などで抜けた馬があれば、確率の前提が崩れる)。
    const racers = new Set(race.horses.map((h) => h.shutuba.umaban));
    const sameSet = racers.size === input.horses.length && input.horses.every((h) => racers.has(h.umaban));
    const oddsMissing = input.horses.some(
      (h) => (h.hadWinOdds && (race.odds.win[h.umaban]?.odds ?? null) === null) || (h.hadPlaceOdds && (race.odds.place[h.umaban]?.oddsMin ?? null) === null),
    );
    if (!sameSet || oddsMissing) {
      return failed("horse-set-mismatch");
    }
    try {
      const recomputed = recomputeAllocationFromProbs({
        raceId: row.race_id,
        horses: input.horses,
        odds: race.odds,
        comboOdds: race.meta.comboOdds,
        allocationSettings: input.allocationSettings,
        evConfig: { threshold: input.evThreshold },
      });
      if (recomputed.allocation.meta.route === "invalid") {
        return failed("compute-failed");
      }
      return result({ ...base, status: "ok", reason: null, oddsOfficialDatetime: race.odds.officialDatetime, allocation: recomputed.allocation });
    } catch {
      return failed("compute-failed");
    }
  }
}
