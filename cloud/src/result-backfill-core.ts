/**
 * 結果の補完(Issue #217・#167-C。親は #167)。**純ロジック**(`cloudflare:workers` を import しない。Node でテストできる)。本物の `ctx.storage.sql`・時計・アラーム・D1・
 * 日単位の DO・移行の DO・gate は `result-backfill-do.ts`(DO `ResultBackfill`)が配線する。
 *
 * ## 何をするか
 * exe から移した分析のうち、exe で結果を取り込まなかったレースは、移行後も `race_results` に行が無いまま残る。cron の自動取り込み(`result-dispatch.ts`)は前日までの 7 日(新しい 2 日)だけなので、
 * それより古いレースは対象外。ここは**古いレースの結果を、少しずつ、自動で取り込む**(ユーザー指定 2026-10-09: 手動のボタンは要らない)。
 * 対象は `analyses` に行があって `race_results` に行が 1 件も無いレース全部(exe 由来かどうかは区別しない。cron が取りこぼした web の古い分析も拾う)。
 * **取得と保存は新しく書かない**: 既存の `dispatchResultImports`(`requestResultImport` の呼び出し箇所は `result-dispatch.ts` の 1 つのまま)で、その日の日単位の DO(`RaceDay`)に依頼する。
 * 日単位の DO が、gate 経由・キャッシュなし・1 レースずつ・最も低い優先度で、中央/地方のホストの違い(`raceResultUrl`)も含めて取得・保存する(`runResultStep`)。
 *
 * ## いつ動くか
 *  - **移行が `completed` のときだけ**。`idle`(一度も移行していない)・`failed` は何もしない(アラームも張らない。cron の `kick` が翌日に張り直す)。`verifying`・`importing`・`waiting-*` は 30 分おきに見直す。
 *    移行中に取ると、移行ファイルに入っている結果と重複して取得する無駄が出る・移行の D1 の書き込み予算と競合するため。
 *  - **JST 01:00〜06:00 の間だけ**({@link BACKFILL_WINDOW_START_HOUR_JST}〜{@link BACKFILL_WINDOW_END_HOUR_JST}。開始を含み終了を含まない)。朝の cron(JST 9:00)・発走前の分析の時間帯を避ける。
 *    D1 の日次の書き込み枠(UTC 0:00 = JST 9:00 に戻る)の終わりに近いが、移行の予算(同じ UTC 日)が使い終わった後に動くので競合しない。
 *  - **1 晩 {@link BACKFILL_NIGHTLY_LIMIT} レースまで**、**1 回 {@link BACKFILL_CHUNK_SIZE} レースまで**(1 つの開催日だけ)。飛行中のチャンクは常に 1 つ: 日単位の DO は gate への呼び出しを 1 本に直列化するので、
 *    補完が gate に並べるのは同時に 1 本。当日の DO・cron が依頼した前日の DO と合わせても、gate の待ち行列の上限(8)に届かない。
 *  - **既存の自動実行より常に後回し**: 依頼の前に gate の状態を読み、ブレーカーが開いていれば解除の 1 分後まで待ち、待ちが {@link BACKFILL_GATE_BUSY_PENDING} 以上なら 5 分待つ。
 *    日単位の DO の結果の取り込み自体も最低の優先度(タスクがあれば動かない)。
 *
 * ## D1 の書き込み
 * 結果 1 レースの新規保存は 38〜62 行(保存済みの結果ページ 14 本での `meta.rows_written`。再現: `test/result-rows-written.test.ts`)。1 晩 150 レースなら多くとも約 9,300 行で、Free の 10 万行/日の約 9%。
 *
 * ## 取得できないレース(無限に再試行しない)
 * 日単位の DO が 1 回の依頼で最大 3 回試して諦めた(`gave_up`)レースを、ここが記録する(`backfill_race`)。
 *  - 永続的な分類(`not-confirmed`〈中止・未確定〉・`no-payout`・`parse-error`・`incomplete`・`invalid-race`): 1 サイクルで**永久に除外**。
 *    `invalid-race` は日単位の DO に依頼する前の検査(`checkRaceDate`: 12 桁の中央/地方のレースID・年の一致・地方の月日の一致)で落ちたもの。日単位の DO は不正なレースが 1 つでもあると依頼全体を拒否するので、
 *    チャンクの有効なレースを巻き込まないよう、依頼の前に除外する(exe の分析の開催日が手入力と食い違う、など)。
 *  - 一時的な分類(`fetch-failed`・`save-failed`・`stalled`〈{@link BACKFILL_INFLIGHT_MAX_MS} たっても queued のまま〉): 1 晩に 1 回だけ。{@link BACKFILL_MAX_NIGHTS} 晩目で永久に除外。
 *  - gate の都合(`blocked`・`busy`・日単位の DO への依頼の失敗〈`dispatch-failed`〉): 晩数に数えず、**その晩は止める**。{@link BACKFILL_MAX_DEFER_NIGHTS} 晩続いたら永久に除外(上限があるので無限にならない)。
 * その晩に試したレースは列挙から除外する(日単位の DO は同じ日の `gave_up` を積み直さないので、除外しないと同じレースを延々と列挙する)。
 *
 * ## 対象外(数だけ見せる)
 * 開催日(`kaisai_date`)が NULL の分析: 日単位の DO の宛先(開催日)が決まらない(中央の race_id から開催日は導出できない)。{@link BackfillStatus.undated} に件数を出す。
 *
 * ## 例外を投げない
 * アラームの中の失敗は握って、10 分後に再試行する({@link BACKFILL_ERROR_RETRY_MS})。ログ・警告は固定の分類名と数だけ(例外の文面は出さない)。
 */
import { jstKaisaiDate } from "./auto-run-plan";
import { checkRaceDate } from "./race-date";
import type { MigrationState } from "./migration-core";
import type { ResultImportProgress } from "./race-day-core";
import { addDaysToKaisaiDate, dispatchResultImports, errorKind, type DispatchStore, type ResultDayStub } from "./result-dispatch";
import type { BackfillCounts, CountBackfillOptions, ListBackfillOptions, UnimportedRace } from "./result-repository";
import type { SqlLike } from "./sql-like";

/** 結果の補完の DO(`ResultBackfill`)の固定名(単一インスタンス)。cron の `scheduled` と `GET /api/results/backfill` が引く。 */
export const RESULT_BACKFILL_NAME = "main";
/** 補完の窓の開始時刻(JST の時。含む)。 */
export const BACKFILL_WINDOW_START_HOUR_JST = 1;
/** 補完の窓の終了時刻(JST の時。含まない)。 */
export const BACKFILL_WINDOW_END_HOUR_JST = 6;
/** 1 晩に依頼するレースの数の上限。 */
export const BACKFILL_NIGHTLY_LIMIT = 150;
/** 1 回の依頼のレースの数の上限(1 つの開催日だけ)。 */
export const BACKFILL_CHUNK_SIZE = 30;
/** 飛行中のチャンクの進行を見る間隔(ミリ秒)。 */
export const BACKFILL_POLL_MS = 30_000;
/** 飛行中のチャンクを待つ上限(ミリ秒)。日単位の DO は失敗するレースを 10 分おきに最大 3 回試す(約 20 分)ので、それに余裕を足した値。超えたら queued のまま stalled として数える。 */
export const BACKFILL_INFLIGHT_MAX_MS = 40 * 60_000;
/** 移行が進行中のとき、見直す間隔(ミリ秒)。 */
export const BACKFILL_MIGRATION_POLL_MS = 30 * 60_000;
/** gate の待ち(進行中 + 待ち)がこの数以上なら依頼しない。gate の待ち行列の上限(8)の半分。 */
export const BACKFILL_GATE_BUSY_PENDING = 4;
/** gate が混んでいるとき、見直す間隔(ミリ秒)。 */
export const BACKFILL_GATE_BUSY_DELAY_MS = 5 * 60_000;
/** 失敗(D1・RPC)のあと、再試行する間隔(ミリ秒)。 */
export const BACKFILL_ERROR_RETRY_MS = 10 * 60_000;
/** 一時的な失敗でレースを諦めるまでの晩数。 */
export const BACKFILL_MAX_NIGHTS = 3;
/** gate の都合の失敗が続いてレースを諦めるまでの晩数。 */
export const BACKFILL_MAX_DEFER_NIGHTS = 5;

/** 1 回のステップで、不正なレースを除外しながら列挙し直す回数の上限(除外のたびに必ず 1 件以上減るので有限。使い切ったら次のステップ〈30 秒後〉に続ける)。 */
export const BACKFILL_MAX_RELIST = 5;

/** 窓の下限は無い(`to` 以前の全部)。{@link dispatchResultImports} の `from` に渡すだけで、補完の列挙は使わない。 */
const BACKFILL_FROM = "20000101";
/** gate のブレーカーが解けた後、少し待つ時間(ミリ秒)。 */
const BREAKER_MARGIN_MS = 60_000;
const JST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

/** 1 サイクルで永久に除外する分類(再試行しても直らない)。 */
const PERMANENT_CLASSES: ReadonlySet<string> = new Set(["not-confirmed", "no-payout", "parse-error", "incomplete", "invalid-race"]);
/** 晩数に数えない分類(gate の都合・依頼の失敗)。 */
const DEFERRAL_CLASSES: ReadonlySet<string> = new Set(["blocked", "busy", "dispatch-failed"]);
const BUSY_MIGRATION_STATES: readonly MigrationState[] = ["verifying", "importing", "waiting-budget", "waiting-r2"];

export interface BackfillOptions {
  /** 1 晩の上限(下げる方向の上書き)。 */
  readonly nightlyLimit?: number;
  readonly chunkSize?: number;
  readonly windowStartHour?: number;
  readonly windowEndHour?: number;
}

/** 日単位の DO のスタブのうち、補完が使う部分(RPC なので Promise)。 */
export interface BackfillDayStub extends ResultDayStub {
  getResultImportProgress(): Promise<ResultImportProgress>;
}

/** 補完が使う D1 の部分(`D1ResultStore`)。 */
export interface BackfillStore {
  listBackfillRaces(options: ListBackfillOptions): Promise<UnimportedRace[]>;
  countBackfill(options: CountBackfillOptions): Promise<BackfillCounts>;
}

export interface BackfillDeps {
  /** DO の SQLite(`ctx.storage.sql`)。表 `backfill_meta`・`backfill_race` を `CREATE TABLE IF NOT EXISTS` で作る。 */
  readonly sql: SqlLike;
  readonly now: () => number;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  /** 移行の DO の状態(`CloudMigration.getStatus().state`)。失敗は throw。 */
  readonly migrationState: () => Promise<MigrationState>;
  /** gate の状態(ブレーカーの解除時刻・進行中 + 待ちの数)。失敗は throw。 */
  readonly gateStatus: () => Promise<{ readonly blockedUntil: number | null; readonly pending: number }>;
  readonly store: BackfillStore;
  readonly stubFor: (kaisaiDate: string) => BackfillDayStub;
  readonly log: (line: string, level: "info" | "error") => void;
  readonly onWarn: (message: string) => void;
}

export type BackfillState = "waiting-migration" | "ready" | "running" | "paused" | "waiting-window" | "done";

export interface BackfillStatus {
  /**
   * `waiting-migration`: 移行が完了していない(移行の状態を読めないときを含む) / `running`: チャンクが飛行中 / `done`: 残りが 0 /
   * `paused`: その晩は止めている(gate の都合・依頼の失敗) / `waiting-window`: 窓の外、または 1 晩の上限に達した / `ready`: 窓の中で、次の依頼を待っている。
   */
  readonly state: BackfillState;
  /** 移行の状態。読めなかったときは null。 */
  readonly migrationState: MigrationState | null;
  /** 残り: 開催日があり、昨日(JST)以前で、結果が無く、永久に除外していないレースの数。 */
  readonly remaining: number;
  /** 開催日が分からず(`kaisai_date` が NULL)、補完の対象外のレースの数。 */
  readonly undated: number;
  /** 補完で取り込めたレースの累計。 */
  readonly imported: number;
  /** 永久に除外したレース(取得できなかった)の数と、最後の分類ごとの内訳。 */
  readonly abandoned: { readonly total: number; readonly byClass: Readonly<Record<string, number>> };
  readonly tonight: { readonly night: string; readonly dispatched: number; readonly limit: number };
  readonly inflight: { readonly day: string; readonly races: number; readonly since: string } | null;
  /** 次にアラームが起きる時刻(ISO。無ければ null)。 */
  readonly nextRunAt: string | null;
  readonly window: { readonly startHour: number; readonly endHour: number };
}

interface Inflight {
  readonly day: string;
  readonly raceIds: readonly string[];
  readonly at: number;
  /** 依頼した晩(JST の暦日)。 */
  readonly night: string;
}

interface RaceRecord {
  readonly race_id: string;
  readonly nights: number;
  readonly defers: number;
  readonly last_night: string;
  readonly last_class: string;
  readonly state: "tried" | "abandoned";
}

/** JST の時刻(時)で窓の中か。 */
export function inBackfillWindow(nowMs: number, startHour = BACKFILL_WINDOW_START_HOUR_JST, endHour = BACKFILL_WINDOW_END_HOUR_JST): boolean {
  const hour = new Date(nowMs + JST_OFFSET_MS).getUTCHours();
  return hour >= startHour && hour < endHour;
}

/**
 * 次に動いてよい時刻。窓の中で `skipCurrent` が偽なら今。窓の前なら当日の開始、窓の後(または `skipCurrent`)なら翌日の開始。
 */
export function nextBackfillWindowStart(nowMs: number, skipCurrent: boolean, startHour = BACKFILL_WINDOW_START_HOUR_JST, endHour = BACKFILL_WINDOW_END_HOUR_JST): number {
  const jstMs = nowMs + JST_OFFSET_MS;
  const dayStartJst = Math.floor(jstMs / DAY_MS) * DAY_MS;
  const todayStart = dayStartJst + startHour * 3600_000 - JST_OFFSET_MS;
  const todayEnd = dayStartJst + endHour * 3600_000 - JST_OFFSET_MS;
  if (nowMs < todayStart) {
    return todayStart;
  }
  if (!skipCurrent && nowMs < todayEnd) {
    return nowMs;
  }
  return todayStart + DAY_MS;
}

export class ResultBackfillCore {
  private readonly deps: BackfillDeps;
  private readonly nightlyLimit: number;
  private readonly chunkSize: number;
  private readonly startHour: number;
  private readonly endHour: number;

  constructor(deps: BackfillDeps, options: BackfillOptions = {}) {
    this.deps = deps;
    this.nightlyLimit = options.nightlyLimit ?? BACKFILL_NIGHTLY_LIMIT;
    this.chunkSize = options.chunkSize ?? BACKFILL_CHUNK_SIZE;
    this.startHour = options.windowStartHour ?? BACKFILL_WINDOW_START_HOUR_JST;
    this.endHour = options.windowEndHour ?? BACKFILL_WINDOW_END_HOUR_JST;
    deps.sql.exec("CREATE TABLE IF NOT EXISTS backfill_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    deps.sql.exec(
      `CREATE TABLE IF NOT EXISTS backfill_race (
         race_id TEXT PRIMARY KEY, nights INTEGER NOT NULL, defers INTEGER NOT NULL, last_night TEXT NOT NULL, last_class TEXT NOT NULL, state TEXT NOT NULL)`,
    );
  }

  // ---- 永続 ----

  private metaGet(key: string): string | null {
    const rows = this.deps.sql.exec("SELECT value FROM backfill_meta WHERE key = ?", key).toArray() as { value: string }[];
    return rows[0]?.value ?? null;
  }

  private metaPut(key: string, value: string): void {
    this.deps.sql.exec("INSERT INTO backfill_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private metaDelete(key: string): void {
    this.deps.sql.exec("DELETE FROM backfill_meta WHERE key = ?", key);
  }

  private loadInflight(): Inflight | null {
    const raw = this.metaGet("inflight");
    return raw === null ? null : (JSON.parse(raw) as Inflight);
  }

  private count(key: string): number {
    return Number(this.metaGet(key) ?? "0");
  }

  /** その晩の依頼の数。晩が替わっていれば 0 に戻す。 */
  private dispatchedTonight(night: string): number {
    return this.metaGet("dispatched_night") === night ? this.count("dispatched") : 0;
  }

  private addDispatched(night: string, n: number): void {
    const current = this.dispatchedTonight(night);
    this.metaPut("dispatched_night", night);
    this.metaPut("dispatched", String(current + n));
  }

  /** 列挙から除外するレース ID: 永久に除外したもの + その晩に試したもの。 */
  private excludedIds(night: string): string[] {
    const rows = this.deps.sql.exec("SELECT race_id FROM backfill_race WHERE state = 'abandoned' OR last_night = ? ORDER BY race_id", night).toArray() as { race_id: string }[];
    return rows.map((r) => r.race_id);
  }

  private abandonedIds(): string[] {
    const rows = this.deps.sql.exec("SELECT race_id FROM backfill_race WHERE state = 'abandoned' ORDER BY race_id").toArray() as { race_id: string }[];
    return rows.map((r) => r.race_id);
  }

  /** 取得できなかったレースを記録する(上の「取得できないレース」の規則)。 */
  private recordFailure(raceId: string, cls: string, night: string): void {
    const prev = (this.deps.sql.exec("SELECT * FROM backfill_race WHERE race_id = ?", raceId).toArray() as RaceRecord[])[0];
    const deferral = DEFERRAL_CLASSES.has(cls);
    const nights = (prev?.nights ?? 0) + (deferral ? 0 : 1);
    const defers = (prev?.defers ?? 0) + (deferral ? 1 : 0);
    const abandon = PERMANENT_CLASSES.has(cls) || nights >= BACKFILL_MAX_NIGHTS || defers >= BACKFILL_MAX_DEFER_NIGHTS;
    this.deps.sql.exec(
      `INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(race_id) DO UPDATE SET nights = excluded.nights, defers = excluded.defers, last_night = excluded.last_night, last_class = excluded.last_class, state = excluded.state`,
      raceId,
      nights,
      defers,
      night,
      cls,
      abandon ? "abandoned" : "tried",
    );
  }

  // ---- アラーム ----

  private async setAlarm(at: number): Promise<void> {
    await this.deps.setAlarm(at);
  }

  /** アラームが無ければ張る(cron から毎日 1 回・状態の読み取りから)。飛行中のチャンクがあれば今(進行を見る)、無ければ次の窓の開始(窓の中なら今)。 */
  async kick(): Promise<void> {
    if ((await this.deps.getAlarm()) !== null) {
      return;
    }
    const now = this.deps.now();
    await this.setAlarm(this.loadInflight() !== null ? now : nextBackfillWindowStart(now, false, this.startHour, this.endHour));
  }

  // ---- 1 ステップ ----

  /** アラーム: 次のステップを 1 つ実行する。例外は投げない(失敗は 10 分後の再試行)。 */
  async runNextStep(): Promise<void> {
    try {
      await this.step();
    } catch (error) {
      this.deps.onWarn(`result-backfill: step failed error=${errorKind(error)}`);
      try {
        await this.setAlarm(this.deps.now() + BACKFILL_ERROR_RETRY_MS);
      } catch {
        // アラームを張れなければ、cron の kick が翌日に張り直す。
      }
    }
  }

  private async step(): Promise<void> {
    const startedAt = this.deps.now();
    // 1. 飛行中のチャンクの進行を見る(窓の外でも、移行が進行中でも回収する: 依頼済みの分の記録を落とさない)。
    const inflight = this.loadInflight();
    if (inflight !== null && !(await this.harvest(inflight, startedAt))) {
      await this.setAlarm(startedAt + BACKFILL_POLL_MS);
      return;
    }
    const now = this.deps.now();

    // 2. 移行が完了しているか。
    let migration: MigrationState;
    try {
      migration = await this.deps.migrationState();
    } catch {
      await this.setAlarm(now + BACKFILL_MIGRATION_POLL_MS);
      return;
    }
    if (migration !== "completed") {
      if (BUSY_MIGRATION_STATES.includes(migration)) {
        await this.setAlarm(now + BACKFILL_MIGRATION_POLL_MS);
      }
      return; // idle・failed: アラームを張らない(cron の kick が翌日に張り直す)
    }

    // 3. 窓・その晩の停止・上限。
    if (!inBackfillWindow(now, this.startHour, this.endHour)) {
      await this.setAlarm(nextBackfillWindowStart(now, false, this.startHour, this.endHour));
      return;
    }
    const night = jstKaisaiDate(now);
    const nextNight = nextBackfillWindowStart(now, true, this.startHour, this.endHour);
    const remainingTonight = this.nightlyLimit - this.dispatchedTonight(night);
    if (this.metaGet("paused_night") === night || remainingTonight <= 0) {
      await this.setAlarm(nextNight);
      return;
    }

    // 4. gate が混んでいたら引く(既存の自動実行が先)。
    let gate: { readonly blockedUntil: number | null; readonly pending: number };
    try {
      gate = await this.deps.gateStatus();
    } catch {
      await this.setAlarm(now + BACKFILL_ERROR_RETRY_MS);
      return;
    }
    if (gate.blockedUntil !== null) {
      await this.setAlarm(gate.blockedUntil + BREAKER_MARGIN_MS);
      return;
    }
    if (gate.pending >= BACKFILL_GATE_BUSY_PENDING) {
      await this.setAlarm(now + BACKFILL_GATE_BUSY_DELAY_MS);
      return;
    }

    // 5. 列挙 → 日単位の DO に依頼(既存の dispatchResultImports。列挙だけを補完用に差し替える)。不正なレースは依頼の前に除外し、チャンクが全部不正だったら列挙し直す。
    const to = addDaysToKaisaiDate(night, -1);
    const limit = Math.min(this.chunkSize, remainingTonight);
    let listed: UnimportedRace[] = [];
    let skipped = 0;
    let result: Awaited<ReturnType<typeof dispatchResultImports>> | null = null;
    for (let attempt = 0; attempt < BACKFILL_MAX_RELIST; attempt += 1) {
      const exclude = this.excludedIds(night);
      listed = [];
      skipped = 0;
      const store: DispatchStore = {
        listUnimportedRacesByDay: async () => {
          for (const race of await this.deps.store.listBackfillRaces({ to, exclude, limit })) {
            if (checkRaceDate(race.raceId, race.kaisaiDate).ok) {
              listed.push(race);
            } else {
              this.recordFailure(race.raceId, "invalid-race", night);
              skipped += 1;
            }
          }
          return listed;
        },
      };
      result = await dispatchResultImports({ from: BACKFILL_FROM, to, maxDays: 1, store, stubFor: this.deps.stubFor, log: this.deps.log });
      if (result.listFailed || listed.length > 0 || skipped === 0) {
        break;
      }
    }
    if (result === null || result.listFailed) {
      await this.setAlarm(now + BACKFILL_ERROR_RETRY_MS);
      return;
    }
    if (listed.length === 0) {
      // 不正なレースの除外で再列挙の上限を使い切ったなら、続きは次のステップ。そうでなければ、その晩に試せるレースが無い(残りが 0、または全部その晩に試した)。
      await this.setAlarm(skipped > 0 ? now + BACKFILL_POLL_MS : nextNight);
      return;
    }
    if (result.days > 0 && result.failedDays === result.days) {
      // 日単位の DO への依頼が失敗した: 記録して(晩数には数えない)その晩は止める。
      for (const race of listed) {
        this.recordFailure(race.raceId, "dispatch-failed", night);
      }
      this.metaPut("paused_night", night);
      await this.setAlarm(nextNight);
      return;
    }
    const inflightNext: Inflight = { day: listed[0]!.kaisaiDate, raceIds: listed.map((r) => r.raceId), at: now, night };
    this.metaPut("inflight", JSON.stringify(inflightNext));
    this.addDispatched(night, listed.length);
    await this.setAlarm(now + BACKFILL_POLL_MS);
  }

  /**
   * 飛行中のチャンクの進行を見る。まだ queued が残っていて {@link BACKFILL_INFLIGHT_MAX_MS} 以内なら false(待つ)。それ以外は回収して true:
   * 取り込み済みは数え、諦めた・止まっているものは分類を記録する。gate の都合の分類があれば、その晩は止める。進行を読めないときは、待ちの途中なら投げ直し(10 分後に再試行)、
   * 打ち切りを過ぎていれば全部 stalled として回収する。
   */
  private async harvest(inflight: Inflight, now: number): Promise<boolean> {
    const timedOut = now - inflight.at >= BACKFILL_INFLIGHT_MAX_MS;
    let progress: ResultImportProgress | null = null;
    try {
      progress = await this.deps.stubFor(inflight.day).getResultImportProgress();
    } catch (error) {
      if (!timedOut) {
        throw error;
      }
    }
    const byId = new Map((progress?.races ?? []).map((r) => [r.raceId, r] as const));
    if (!timedOut && inflight.raceIds.some((id) => byId.get(id)?.state === "queued")) {
      return false;
    }
    let imported = 0;
    let pause = false;
    for (const raceId of inflight.raceIds) {
      const row = byId.get(raceId);
      if (row?.state === "imported") {
        imported += 1;
        this.deps.sql.exec("DELETE FROM backfill_race WHERE race_id = ?", raceId);
        continue;
      }
      const cls = row?.state === "gave_up" ? (row.lastClass ?? "fetch-failed") : "stalled";
      if (DEFERRAL_CLASSES.has(cls)) {
        pause = true;
      }
      this.recordFailure(raceId, cls, inflight.night);
    }
    this.metaPut("imported", String(this.count("imported") + imported));
    if (pause) {
      this.metaPut("paused_night", inflight.night);
    }
    this.metaDelete("inflight");
    return true;
  }

  // ---- 観測 ----

  /** 進捗(D1 を 1 回、移行の DO を 1 回読む。状態は変えない)。 */
  async getStatus(): Promise<BackfillStatus> {
    const now = this.deps.now();
    const night = jstKaisaiDate(now);
    const to = addDaysToKaisaiDate(night, -1);
    const counts = await this.deps.store.countBackfill({ to, exclude: this.abandonedIds() });
    let migrationState: MigrationState | null = null;
    try {
      migrationState = await this.deps.migrationState();
    } catch {
      migrationState = null;
    }
    const inflight = this.loadInflight();
    const dispatched = this.dispatchedTonight(night);
    const byClass: Record<string, number> = {};
    let total = 0;
    for (const row of this.deps.sql.exec("SELECT last_class AS cls, COUNT(*) AS n FROM backfill_race WHERE state = 'abandoned' GROUP BY last_class ORDER BY last_class").toArray() as { cls: string; n: number }[]) {
      byClass[row.cls] = row.n;
      total += row.n;
    }
    let state: BackfillState;
    if (migrationState !== "completed") {
      state = "waiting-migration";
    } else if (inflight !== null) {
      state = "running";
    } else if (counts.dated === 0) {
      state = "done";
    } else if (this.metaGet("paused_night") === night) {
      state = "paused";
    } else if (!inBackfillWindow(now, this.startHour, this.endHour) || dispatched >= this.nightlyLimit) {
      state = "waiting-window";
    } else {
      state = "ready";
    }
    const alarm = await this.deps.getAlarm();
    return {
      state,
      migrationState,
      remaining: counts.dated,
      undated: counts.undated,
      imported: this.count("imported"),
      abandoned: { total, byClass },
      tonight: { night, dispatched, limit: this.nightlyLimit },
      inflight: inflight === null ? null : { day: inflight.day, races: inflight.raceIds.length, since: new Date(inflight.at).toISOString() },
      nextRunAt: alarm === null ? null : new Date(alarm).toISOString(),
      window: { startHour: this.startHour, endHour: this.endHour },
    };
  }
}
