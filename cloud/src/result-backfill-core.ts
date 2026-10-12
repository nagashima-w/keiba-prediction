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
 *  - **JST 01:00〜06:00 の間だけ**({@link BACKFILL_WINDOW_START_HOUR_JST}〜{@link BACKFILL_WINDOW_END_HOUR_JST}。開始を含み終了を含まない)。事前分析の cron(21:00・23:00 JST)・発走前の分析の時間帯を避ける。
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
 *    **ただし系統的な障害**(チャンクで取り込みが 0 件で、失敗が全件、同じ永続的な分類。netkeiba が夜間に 200 のメンテナンス画面を返す等)は、一時的な扱い(下)にする。
 *    取り込めたレースが 1 つでもあれば、ページは読めているので分類を信用する。
 *  - 一時的な分類(`fetch-failed`・`save-failed`・`stalled`〈{@link BACKFILL_INFLIGHT_MAX_MS} たっても queued のまま〉): 1 晩に 1 回だけ。{@link BACKFILL_MAX_NIGHTS} 晩目で永久に除外。
 *  - gate の都合(`blocked`・`busy`・日単位の DO への依頼の失敗〈`dispatch-failed`〉): 晩数に数えず、**その晩は止める**。{@link BACKFILL_MAX_DEFER_NIGHTS} 晩続いたら永久に除外(上限があるので無限にならない)。
 * その晩に試したレースは列挙から除外する(日単位の DO は同じ日の `gave_up` を積み直さないので、除外しないと同じレースを延々と列挙する)。
 *
 * ## 段階 2: 確定の単勝オッズ・人気の補完(Issue #259)と、取消・除外の記録の補完(Issue #270)
 * 段階 1 が尽きたら(列挙が空で、不正なレースの除外もなかったとき)、**結果は取り込み済みだが、次の (A) または (B) に当たるレース**を、同じ仕組みで少しずつ埋める。
 *  - (A)(Issue #259)オッズが 1 頭も入っていない(`race_results.win_odds` が全頭 NULL。migration 0011 より前に取り込んだ約 1,300 レース)
 *  - (B)(Issue #270。#72 の残り)着順が NULL で `scratched` が NULL の行がある(`scratched` を記録する前〈migration 0013 より前〉に取り込んだ行・exe から移した行。取消か中止か判別できず、検証は不的中として数えている)
 * 取得は同じ `dispatchResultImports`(呼び出し箇所は増えない)に **`winOddsOnly: true`** を渡して依頼し、日単位の DO が結果ページを**1 回**取り直して、NULL の列だけを保存する:
 * 確定の単勝オッズ・人気(`saveWinOdds`)と、取消・除外の記録(`saveScratched`。着順が NULL で scratched が NULL の行にだけ。取消・除外は 1・それ以外は 0)。
 * 着順・払戻・組合せ払戻は上書きしない。(A) と (B) の両方に当たるレースも、取得は 1 本で済む。窓・1 晩 {@link BACKFILL_NIGHTLY_LIMIT} レース・1 回 {@link BACKFILL_CHUNK_SIZE} レース・gate の都合・失敗の扱いは**段階 1 と共有**する。
 * 違いは記録の状態だけ: 取り込めたレースは `fill_done`(ページにオッズが無くても、着順なしの馬が D1 に残っても、**二度と列挙しない**。毎晩の再列挙を防ぐ)、失敗は `odds_tried`・`odds_abandoned`(段階 1 の `tried`・`abandoned` と別に数える)。
 * **旧い `odds_done`**(Issue #270 より前の、オッズだけの補完を終えた印)は列挙の除外に含めない: それらのレースは scratched が NULL のままなので、(B) に当たる限り 1 回だけ取り直し、`fill_done` に上書きされる。
 * `odds_abandoned` のレースは従来どおり除外のまま(取得の失敗が永続した分を、scratched のためだけに救済しない)。
 * 1 晩の上限(150)は、(A)・(B) の合計に対する上限のまま。対象は (B) の分だけ増えるが、1 晩に取得する本数は増えない(多いぶんは、翌晩以降に回る)。
 * 開催日が NULL の分析のレースは、段階 1 と同じ理由で対象外({@link BackfillStatus.winOdds} の `undated` に件数を出す)。
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
import type { BackfillCounts, CountBackfillOptions, ListBackfillOptions, UnimportedRace, WinOddsBackfillCounts } from "./result-repository";
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

/**
 * 補完を止める設定の判定(Worker の var `RESULT_BACKFILL_NIGHTLY_LIMIT`)。**文字列 `"0"`(前後の空白は無視)だけ**が「無効」。それ以外(未設定・空・数でない値・`"00"` など)は無効にしない
 * (1〜150 の値は上限を下げる指定として別に解釈する。誤記で止まったまま気づかない、または誤記で全開になる、のどちらも避けるため、完全一致にする)。
 */
export function isBackfillDisabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "0";
}

export interface BackfillOptions {
  /** 補完を止める(`kick` はアラームを張らず、アラームが起きても何もしない)。状態は `disabled`。smoke・CI で netkeiba に出ないことを保証する、または利用者が止めるため。 */
  readonly disabled?: boolean;
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
  /** 段階 2(Issue #259・#270): 結果はあるが、オッズが 1 頭も入っていない、または scratched が欠ける(着順が NULL で scratched が NULL の行がある)レース。 */
  listWinOddsBackfillRaces(options: ListBackfillOptions): Promise<UnimportedRace[]>;
  countWinOddsBackfill(options: CountBackfillOptions): Promise<WinOddsBackfillCounts>;
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

export type BackfillState = "disabled" | "waiting-migration" | "ready" | "running" | "paused" | "waiting-window" | "done";

export interface BackfillStatus {
  /**
   * `disabled`: 止める設定(`RESULT_BACKFILL_NIGHTLY_LIMIT=0`)。自動では何も取り込まない / `waiting-migration`: 移行が完了していない(移行の状態を読めないときを含む) / `running`: チャンクが飛行中 / `done`: 残りが 0 /
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
  /**
   * 段階 2(Issue #259 の確定の単勝オッズ・人気の補完と、Issue #270 の取消・除外の記録〈scratched〉の補完)。`remaining` = 結果はあるが、オッズが 1 頭も無い、または scratched が欠ける(着順が NULL で scratched が NULL の行がある)レースのうち、
   * 開催日が昨日以前で、永久に除外していないものの数 / `undated` = 同じ条件で開催日がすべて NULL(補完の対象外)/ `filled` = 補完を終えたレースの累計(`fill_done`。Issue #270 より前の印 `odds_done` を含む)/
   * `scratchedMissing` = `remaining` のうち scratched が欠けるレースの数(オッズも欠けているレースを含む。本番の件数を後から確かめる観測値)/ `abandoned` = 取得できず永久に除外したレース(段階 1 の `abandoned` とは別)。
   */
  readonly winOdds: {
    readonly remaining: number;
    readonly undated: number;
    readonly filled: number;
    readonly scratchedMissing: number;
    readonly abandoned: { readonly total: number; readonly byClass: Readonly<Record<string, number>> };
  };
  readonly tonight: { readonly night: string; readonly dispatched: number; readonly limit: number };
  readonly inflight: { readonly day: string; readonly races: number; readonly since: string } | null;
  /** 次にアラームが起きる時刻(ISO。無ければ null)。 */
  readonly nextRunAt: string | null;
  readonly window: { readonly startHour: number; readonly endHour: number };
}

/** 補完の段階: `results` = 結果の取り込み(段階 1)/ `win-odds` = 確定の単勝オッズ・人気の補完(段階 2。Issue #259)。 */
type BackfillKind = "results" | "win-odds";

interface Inflight {
  /** 段階。省略(この変更より前に保存された飛行中の記録)は `results`。 */
  readonly kind?: BackfillKind;
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
  /**
   * 段階 1: `tried`・`abandoned` / 段階 2(Issue #259): `odds_tried`・`odds_abandoned`・`fill_done`(Issue #270 で `odds_done` から改名した完了の印)。
   * `odds_done` は Issue #270 より前に書かれた旧い印で、**新しくは書かない**。列挙の除外にも含めない(下の `excludedIds`)。
   */
  readonly state: "tried" | "abandoned" | "odds_tried" | "odds_abandoned" | "odds_done" | "fill_done";
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
  private readonly disabled: boolean;

  constructor(deps: BackfillDeps, options: BackfillOptions = {}) {
    this.deps = deps;
    this.nightlyLimit = options.nightlyLimit ?? BACKFILL_NIGHTLY_LIMIT;
    this.chunkSize = options.chunkSize ?? BACKFILL_CHUNK_SIZE;
    this.startHour = options.windowStartHour ?? BACKFILL_WINDOW_START_HOUR_JST;
    this.endHour = options.windowEndHour ?? BACKFILL_WINDOW_END_HOUR_JST;
    this.disabled = options.disabled === true;
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

  /**
   * 列挙から除外するレース ID: 永久に除外したもの + その晩に試したもの。段階 2 の `odds_abandoned`・`fill_done`(補完を終えた)も含める
   * (段階 1 の列挙に混ざっても、そのレースは結果があるので当たらない。段階 2 の列挙は、これで補完済みのレースを再び選ばない)。
   * **旧い `odds_done`(Issue #270 より前に、オッズだけの補完を終えた印)は含めない**: それらのレースは scratched が NULL のままなので、D1 の条件(scratched の欠け)が選ぶ限り取り直す。
   * 取り込めたら `fill_done` に上書きされ、以後は除外される(1 つの `race_id` に状態は 1 つなので、`odds_done` ↔ 別の状態で行き来しない)。
   */
  private excludedIds(night: string): string[] {
    const rows = this.deps.sql
      .exec("SELECT race_id FROM backfill_race WHERE state IN ('abandoned', 'odds_abandoned', 'fill_done') OR last_night = ? ORDER BY race_id", night)
      .toArray() as { race_id: string }[];
    return rows.map((r) => r.race_id);
  }

  /** 段階 1 の残りの数えで除く、永久に除外したレース ID(段階 2 の状態は含めない)。 */
  private abandonedIds(): string[] {
    const rows = this.deps.sql.exec("SELECT race_id FROM backfill_race WHERE state = 'abandoned' ORDER BY race_id").toArray() as { race_id: string }[];
    return rows.map((r) => r.race_id);
  }

  /** 段階 2 の残りの数えで除く、補完を終えた(`fill_done`)・永久に除外した(`odds_abandoned`)レース ID。旧い `odds_done` は含めない(`excludedIds` の説明)。 */
  private oddsExcludedIds(): string[] {
    const rows = this.deps.sql.exec("SELECT race_id FROM backfill_race WHERE state IN ('odds_abandoned', 'fill_done') ORDER BY race_id").toArray() as { race_id: string }[];
    return rows.map((r) => r.race_id);
  }

  /** 取得できなかったレースを記録する(上の「取得できないレース」の規則)。 */
  private recordFailure(raceId: string, cls: string, night: string, systemic = false, kind: BackfillKind = "results"): void {
    const prev = (this.deps.sql.exec("SELECT * FROM backfill_race WHERE race_id = ?", raceId).toArray() as RaceRecord[])[0];
    const deferral = DEFERRAL_CLASSES.has(cls);
    const nights = (prev?.nights ?? 0) + (deferral ? 0 : 1);
    const defers = (prev?.defers ?? 0) + (deferral ? 1 : 0);
    const abandon = (PERMANENT_CLASSES.has(cls) && !systemic) || nights >= BACKFILL_MAX_NIGHTS || defers >= BACKFILL_MAX_DEFER_NIGHTS;
    this.deps.sql.exec(
      `INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(race_id) DO UPDATE SET nights = excluded.nights, defers = excluded.defers, last_night = excluded.last_night, last_class = excluded.last_class, state = excluded.state`,
      raceId,
      nights,
      defers,
      night,
      cls,
      kind === "win-odds" ? (abandon ? "odds_abandoned" : "odds_tried") : abandon ? "abandoned" : "tried",
    );
  }

  /** 段階 2 で補完を終えたレースを記録する(ページにオッズが無くて列に入らなかった、または着順なしの馬が D1 に残ったレースも、二度と列挙しない)。旧い `odds_done` の行は `fill_done` に上書きする。 */
  private recordFillDone(raceId: string, night: string): void {
    this.deps.sql.exec(
      `INSERT INTO backfill_race (race_id, nights, defers, last_night, last_class, state) VALUES (?, 0, 0, ?, 'imported', 'fill_done')
       ON CONFLICT(race_id) DO UPDATE SET nights = 0, defers = 0, last_night = excluded.last_night, last_class = 'imported', state = 'fill_done'`,
      raceId,
      night,
    );
  }

  // ---- アラーム ----

  private async setAlarm(at: number): Promise<void> {
    await this.deps.setAlarm(at);
  }

  /** アラームが無ければ張る(cron から毎日 1 回・状態の読み取りから)。飛行中のチャンクがあれば今(進行を見る)、無ければ次の窓の開始(窓の中なら今)。 */
  async kick(): Promise<void> {
    if (this.disabled || (await this.deps.getAlarm()) !== null) {
      return;
    }
    const now = this.deps.now();
    await this.setAlarm(this.loadInflight() !== null ? now : nextBackfillWindowStart(now, false, this.startHour, this.endHour));
  }

  // ---- 1 ステップ ----

  /** アラーム: 次のステップを 1 つ実行する。例外は投げない(失敗は 10 分後の再試行)。 */
  async runNextStep(): Promise<void> {
    if (this.disabled) {
      return; // 止める設定: 何も読まず・書かず、アラームも張り直さない(止める前に張られていたアラームは、これで連鎖が終わる)
    }
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
    //    段階 1(未取込の結果)が尽きたら(列挙が空で、不正な除外もなかったとき)、段階 2(確定の単勝オッズ・人気の補完。Issue #259)を同じ仕組みで列挙・依頼する。
    const to = addDaysToKaisaiDate(night, -1);
    const limit = Math.min(this.chunkSize, remainingTonight);
    let kind: BackfillKind = "results";
    let attempted = await this.listAndDispatch("results", night, to, limit);
    if (!attempted.result.listFailed && attempted.listed.length === 0 && attempted.skipped === 0) {
      kind = "win-odds";
      attempted = await this.listAndDispatch("win-odds", night, to, limit);
    }
    const { listed, skipped, result } = attempted;
    if (result.listFailed) {
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
        this.recordFailure(race.raceId, "dispatch-failed", night, false, kind);
      }
      this.metaPut("paused_night", night);
      await this.setAlarm(nextNight);
      return;
    }
    const inflightNext: Inflight = { kind, day: listed[0]!.kaisaiDate, raceIds: listed.map((r) => r.raceId), at: now, night };
    this.metaPut("inflight", JSON.stringify(inflightNext));
    this.addDispatched(night, listed.length);
    await this.setAlarm(now + BACKFILL_POLL_MS);
  }

  /**
   * 1 つの段階の列挙 → 依頼(Issue #259 で、段階 1 の本文をそのまま切り出した)。不正なレースは依頼の前に記録して除外し、チャンクが全部不正だったら列挙し直す(有限回)。
   * 段階 2(`win-odds`)は列挙を `listWinOddsBackfillRaces` に、依頼を `winOddsOnly: true` に替えるだけで、検査・記録・依頼の仕方は同じ。
   */
  private async listAndDispatch(
    kind: BackfillKind,
    night: string,
    to: string,
    limit: number,
  ): Promise<{ listed: UnimportedRace[]; skipped: number; result: Awaited<ReturnType<typeof dispatchResultImports>> }> {
    let listed: UnimportedRace[] = [];
    let skipped = 0;
    let result: Awaited<ReturnType<typeof dispatchResultImports>> | null = null;
    for (let attempt = 0; attempt < BACKFILL_MAX_RELIST; attempt += 1) {
      const exclude = this.excludedIds(night);
      listed = [];
      skipped = 0;
      const store: DispatchStore = {
        listUnimportedRacesByDay: async () => {
          const found = kind === "win-odds" ? await this.deps.store.listWinOddsBackfillRaces({ to, exclude, limit }) : await this.deps.store.listBackfillRaces({ to, exclude, limit });
          for (const race of found) {
            if (checkRaceDate(race.raceId, race.kaisaiDate).ok) {
              listed.push(race);
            } else {
              this.recordFailure(race.raceId, "invalid-race", night, false, kind);
              skipped += 1;
            }
          }
          return listed;
        },
      };
      result = await dispatchResultImports({
        from: BACKFILL_FROM,
        to,
        maxDays: 1,
        store,
        stubFor: this.deps.stubFor,
        log: this.deps.log,
        ...(kind === "win-odds" ? { winOddsOnly: true } : {}),
      });
      if (result.listFailed || listed.length > 0 || skipped === 0) {
        break;
      }
    }
    return { listed, skipped, result: result! };
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
    const kind: BackfillKind = inflight.kind ?? "results";
    let imported = 0;
    let pause = false;
    const failures: Array<{ raceId: string; cls: string }> = [];
    for (const raceId of inflight.raceIds) {
      const row = byId.get(raceId);
      if (row?.state === "imported") {
        imported += 1;
        if (kind === "win-odds") {
          this.recordFillDone(raceId, inflight.night); // 補完を終えた(ページにオッズが無くても・着順なしの馬が残っても、二度と列挙しない)
        } else {
          this.deps.sql.exec("DELETE FROM backfill_race WHERE race_id = ?", raceId);
        }
        continue;
      }
      const cls = row?.state === "gave_up" ? (row.lastClass ?? "fetch-failed") : "stalled";
      if (DEFERRAL_CLASSES.has(cls)) {
        pause = true;
      }
      failures.push({ raceId, cls });
    }
    // 系統的な障害(netkeiba が 200 のメンテナンス画面を返す等): チャンクで取り込みが 0 件で、失敗が全件、同じ永続的な分類。
    // 永続的な分類を鵜呑みにすると、その晩のレースが一括で永久に除外され二度と取り込まれないので、一時的な扱い(晩数に数える。BACKFILL_MAX_NIGHTS 晩目で除外)にする。
    // 本当に未確定・払戻なしのレースも、数晩後には除外される(無限には再試行しない)。取り込めたレースが 1 つでもあれば、ページは読めているので分類を信用する。
    const classes = new Set(failures.map((f) => f.cls));
    const systemic = imported === 0 && failures.length > 0 && classes.size === 1 && PERMANENT_CLASSES.has(failures[0]!.cls);
    for (const f of failures) {
      this.recordFailure(f.raceId, f.cls, inflight.night, systemic, kind);
    }
    if (kind === "results") {
      this.metaPut("imported", String(this.count("imported") + imported));
    }
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
    const oddsCounts = await this.deps.store.countWinOddsBackfill({ to, exclude: this.oddsExcludedIds() });
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
    const oddsByClass: Record<string, number> = {};
    let oddsAbandoned = 0;
    for (const row of this.deps.sql.exec("SELECT last_class AS cls, COUNT(*) AS n FROM backfill_race WHERE state = 'odds_abandoned' GROUP BY last_class ORDER BY last_class").toArray() as { cls: string; n: number }[]) {
      oddsByClass[row.cls] = row.n;
      oddsAbandoned += row.n;
    }
    const filled = (this.deps.sql.exec("SELECT COUNT(*) AS n FROM backfill_race WHERE state IN ('odds_done', 'fill_done')").toArray() as { n: number }[])[0]?.n ?? 0;
    let state: BackfillState;
    if (this.disabled) {
      state = "disabled";
    } else if (migrationState !== "completed") {
      state = "waiting-migration";
    } else if (inflight !== null) {
      state = "running";
    } else if (counts.dated === 0 && oddsCounts.dated === 0) {
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
      winOdds: { remaining: oddsCounts.dated, undated: oddsCounts.undated, filled, scratchedMissing: oddsCounts.scratchedMissing, abandoned: { total: oddsAbandoned, byClass: oddsByClass } },
      tonight: { night, dispatched, limit: this.nightlyLimit },
      inflight: inflight === null ? null : { day: inflight.day, races: inflight.raceIds.length, since: new Date(inflight.at).toISOString() },
      nextRunAt: alarm === null ? null : new Date(alarm).toISOString(),
      window: { startHour: this.startHour, endHour: this.endHour },
    };
  }
}
