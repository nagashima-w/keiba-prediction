/**
 * JRA の馬ごとの頁から、2021 年以降に中央で走った馬の父・母・母の父・生産者を埋め戻す段取り(Issue #697。親は #695)。**純ロジック**(`cloudflare:workers` を import しない。Node でテストできる)。
 * 本物の `ctx.storage.sql`・時計・アラーム・D1・JRA への取得を配線するのは `jra-horse-backfill-do.ts`(DO `JraHorseBackfillDO`)。
 * 構造は `market-edge-core.ts` を写した: 依存を引数で受け、状態は DO の SQLite(`CREATE TABLE IF NOT EXISTS`)、アラームの中の失敗は握って再試行する。
 * **netkeiba にも gate にも出ない**(JRA の公式サイトと D1 だけ)。
 *
 * ## 何をするか
 *  - 対象は `horse_runs` の馬(カーソルは地方だけの馬も通り過ぎる)。馬の ID の順にカーソルで進み(主キーの範囲読み。1 回 {@link HORSE_BACKFILL_PAGE} 頭)、`horse_profiles` にいない、かつ中央の走がある馬だけ頁を取る(地方・海外だけの馬は JRA に頁が無いので取らず、`hb_skip` にも入れない。後で中央の走が入れば次の周で取る。Issue #725)。
 *  - 取れた馬は `horse_profiles` に `source = 'jra_horse'` で書く(既にいる馬は上書きしない。馬主は書かない)。
 *  - 最後まで進んだらカーソルを先頭に戻す(戦績の変換が進むと、前の位置より小さい ID の馬が増えるため)。1 周で取った馬が 1 頭も無ければ、アラームを張らずに休む(次の kick まで)。
 *
 * ## 既存の取得の DO(`RaceArchiveFetchCore`)と違うところ
 *  - あちらは 1 アラームで 1 ステップ(1 リクエスト)。こちらは **1 回の起床で最大 {@link HORSE_BACKFILL_PER_WAKE} 頭を直列で取る**。理由: 取る頁が多く(約 3 万頭)、
 *    1 アラーム 1 本では D1 の読み出し(範囲読みと「いるか」の確認)が 1 本ごとに付いて無駄が大きい。1 回の起床は 40 本 × 約 4 秒 ≈ 3 分で、アラームの処理の時間に収まる。
 *    サブリクエストは、D1 の読みと書きの数本 + 取得 40 本で、Free の上限 50 に収まる。
 *  - 間隔は {@link HORSE_BACKFILL_GAP_MS}(開始から開始まで 3 秒)。本番の他の JRA の取得(`createJraPacer` の 1.5 秒)より広い。量が多いため。**ペーサーは通さない**(この DO の中で守る)。
 *
 * ## いつ動くか
 *  - **終日**(2026-11-11 のユーザーの指示で、以前の JST 18:00〜翌 8:00 から広げた。理由は {@link HORSE_BACKFILL_WINDOW_START_MIN} の注)。間隔・1 回の起床の頭数・1 日の書き込みの上限は変えていない。
 *  - **1 日(JST)の書き込みは `horse_profiles` の行で {@link HORSE_BACKFILL_DAILY_ROWS_MAX} 行まで**(var で下げることだけできる)。超えたら翌日 0:00(日付が変わって枠が戻る時刻)まで休む。
 *    起床ごとに取る頭数を「残りの枠」で頭打ちにするので、枠を超えて書かない(1 頭で書く行は高々 1)。
 *  - 無効(var が `"0"`): アラームを張らず、起きても何もしない。
 *
 * ## 失敗
 *  - 誤りの頁・馬名が読めない頁・結果の頁・大きすぎる頁・計算できない ID は、DO の SQLite(`hb_skip`)に記録して飛ばす(繰り返し取りに行かない)。
 *  - timeout・network・redirect・HTTP の失敗は記録せず、次の周で再試行する。
 *  - **連続 {@link HORSE_BACKFILL_FAILURE_LIMIT} 回の起床で 1 頭も読めなかったら止まる**(翌日 0:00 に自動で再開。手での再開の口は無い)。「読めなかった」は、取得を 1 本以上試して、頁が 1 つも馬の頁として読めなかった起床。
 *    誤りの頁ばかりの起床も数える(cname の計算が外れたとき、全馬を飛ばし続けない)。取得を試さなかった起床は、数えもリセットもしない。
 *  - アラームの中の例外(D1 の失敗など): 握って 10 分後に再試行し、同じく連続に数える。書けなかった起床は、カーソルも飛ばす記録も進めない。
 *
 * ## ログ
 * 固定の文と数(取った数・書いた数・飛ばした数・失敗した数)だけ。URL・馬名・応答の本文・例外のメッセージは出さない。
 */
import { JST_OFFSET_MS } from "../../packages/core/src/common/jst";
import { horseCnameSuffix } from "./jra-horse-cname";
import { parseHorseProfilePage } from "./jra-horse-parse";
import type { JraHorseStoreLike, SavedHorseProfile } from "./jra-horse-repository";
import type { SqlLike } from "./sql-like";
import { shouldRearm } from "./stale-alarm";

/** 単一インスタンスの固定名。cron の `scheduled` が引く。 */
export const JRA_HORSE_BACKFILL_NAME = "main";
/** 時間帯(JST の 0 時からの分。開始は含み、終了は含まない)。**終日**(0:00〜24:00)。以前は 18:00〜翌 8:00 だった(ユーザーの指示 2026-11-11: 探索の分析が止まっているので早くそろえたい。残りは約 1 万頭で、1 日 15,000 行の上限から、週末の開催日より前に終わる見込み。JRA への間隔は 3 秒のままで、手元からの調査の決まり〈3 秒以上〉の内側)。 */
export const HORSE_BACKFILL_WINDOW_START_MIN = 0;
export const HORSE_BACKFILL_WINDOW_END_MIN = 24 * 60;
/** 1 回の起床で取る馬の最大数。 */
export const HORSE_BACKFILL_PER_WAKE = 40;
/** 馬の頁の取得の間隔(開始から開始まで。ミリ秒)。 */
export const HORSE_BACKFILL_GAP_MS = 3_000;
/** 起床の終わりから次のアラームまで。取った起床は 30 秒後、読むだけだった起床(取る馬がいなかった)は 1 秒後。 */
export const HORSE_BACKFILL_NEXT_DELAY_MS = 30_000;
export const HORSE_BACKFILL_SCAN_DELAY_MS = 1_000;
/** 1 回の範囲読みで見る馬の数。 */
export const HORSE_BACKFILL_PAGE = 100;
/** 1 日(JST)に horse_profiles へ書く行数の上限(var で下げることだけできる)。 */
export const HORSE_BACKFILL_DAILY_ROWS_MAX = 15_000;
export const HORSE_BACKFILL_FAILURE_LIMIT = 3;
export const HORSE_BACKFILL_ERROR_RETRY_MS = 10 * 60_000;

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/** 止める設定の判定(Worker の var `JRA_HORSE_BACKFILL_ENABLED`)。**文字列 `"0"`(前後の空白は無視)だけ**が無効。未設定・それ以外は有効。 */
export function isJraHorseBackfillDisabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "0";
}

/** JRA への 1 本の取得の結果(取得口が分類して返す)。 */
export type HorseFetchOutcome = { readonly kind: "page"; readonly html: string } | { readonly kind: "failed"; readonly reason: "timeout" | "network" | "redirect" | "http" | "too-large" };

export interface JraHorseBackfillOptions {
  readonly disabled?: boolean;
  /** 1 日の書き込み行数の上限(下げる方向の上書き。上限を超える値・不正な値は既定の上限)。 */
  readonly dailyRows?: number;
}

export interface JraHorseBackfillDeps {
  /** DO の SQLite(`ctx.storage.sql`)。表 `hb_meta`・`hb_skip` を `CREATE TABLE IF NOT EXISTS` で作る。 */
  readonly sql: SqlLike;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly setAlarm: (at: number) => void | Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  readonly store: JraHorseStoreLike;
  /** 馬の頁を 1 本取る(馬の ID と、cname の末尾の 2 桁を渡す。URL は取得口の中にだけある。例外は投げない。失敗は分類に落とす)。 */
  readonly fetchProfile: (horseId: string, suffix: string) => Promise<HorseFetchOutcome>;
  readonly log: (line: string, level: "info" | "error") => void;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "Error" : "non-error";
}

function msOfJstDay(ms: number): number {
  return (((ms + JST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
}

/** 時間帯の中か(開始〜終了の分の範囲。終日なので常に true)。 */
export function inHorseBackfillWindow(ms: number): boolean {
  const t = msOfJstDay(ms);
  return t >= HORSE_BACKFILL_WINDOW_START_MIN * MIN_MS && t < HORSE_BACKFILL_WINDOW_END_MIN * MIN_MS;
}

/** いま以降で最初に時間帯に入る時刻(中ならいま)。終日なので常にいま。 */
export function nextHorseBackfillStart(ms: number): number {
  if (inHorseBackfillWindow(ms)) return ms;
  return ms - msOfJstDay(ms) + DAY_MS + HORSE_BACKFILL_WINDOW_START_MIN * MIN_MS;
}

/** 翌日(JST)の時間帯の開始(終日なので 0:00)。0 時を過ぎてから呼んでも、その日の翌日。 */
export function nextDayStart(ms: number): number {
  return ms - msOfJstDay(ms) + DAY_MS + HORSE_BACKFILL_WINDOW_START_MIN * MIN_MS;
}

/** JST の日付(YYYYMMDD)。 */
function jstDay(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");
}

type SkipReason = "param-error" | "not-profile" | "unparsable" | "too-large" | "uncomputable";

export class JraHorseBackfillCore {
  private readonly deps: JraHorseBackfillDeps;
  private readonly disabled: boolean;
  private readonly dailyRows: number;
  private readonly metaCache = new Map<string, string | null>();

  constructor(deps: JraHorseBackfillDeps, options: JraHorseBackfillOptions = {}) {
    this.deps = deps;
    this.disabled = options.disabled === true;
    this.dailyRows =
      options.dailyRows !== undefined && Number.isInteger(options.dailyRows) && options.dailyRows >= 1 ? Math.min(options.dailyRows, HORSE_BACKFILL_DAILY_ROWS_MAX) : HORSE_BACKFILL_DAILY_ROWS_MAX;
    deps.sql.exec("CREATE TABLE IF NOT EXISTS hb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    deps.sql.exec("CREATE TABLE IF NOT EXISTS hb_skip (horse_id TEXT PRIMARY KEY, reason TEXT NOT NULL, day TEXT NOT NULL) WITHOUT ROWID");
  }

  // ---- 状態の読み書き(主キーの引きだけ) ----

  private metaGet(key: string): string | null {
    const cached = this.metaCache.get(key);
    if (cached !== undefined) return cached;
    const rows = this.deps.sql.exec("SELECT value FROM hb_meta WHERE key = ?", key).toArray() as { value: string }[];
    const value = rows[0]?.value ?? null;
    this.metaCache.set(key, value);
    return value;
  }

  /** 値が変わるときだけ書く(DO の SQLite の書き込み行数を減らす)。 */
  private metaSet(key: string, value: string): void {
    if (this.metaGet(key) === value) return;
    this.deps.sql.exec("INSERT INTO hb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    this.metaCache.set(key, value);
  }

  private metaNum(key: string): number {
    const n = Number(this.metaGet(key));
    return Number.isFinite(n) ? n : 0;
  }

  // ---- アラーム ----

  /** アラームが無ければ張る(cron の `scheduled` が呼ぶ)。 */
  async kick(): Promise<void> {
    if (this.disabled) return;
    const now = this.deps.now();
    if (!shouldRearm(await this.deps.getAlarm(), now, (iso) => this.deps.log(`jra-horse-backfill: stale alarm at=${iso} re-armed`, "info"))) return;
    await this.deps.setAlarm(nextHorseBackfillStart(now));
  }

  /** アラーム: 次の起床を 1 回実行する。例外は投げない(失敗は 10 分後の再試行)。 */
  async runNextStep(): Promise<void> {
    if (this.disabled) return;
    try {
      await this.step();
    } catch (error) {
      this.deps.log(`jra-horse-backfill: step failed error=${errorKind(error)}`, "error");
      try {
        if (this.countFailure()) {
          await this.halt();
        } else {
          await this.deps.setAlarm(this.deps.now() + HORSE_BACKFILL_ERROR_RETRY_MS);
        }
      } catch {
        // アラームを張れなければ、cron の kick が張り直す。
      }
    }
  }

  /** 失敗の連続を 1 つ増やす。上限に達したら true(連続は 0 に戻す)。 */
  private countFailure(): boolean {
    const streak = this.metaNum("streak") + 1;
    if (streak >= HORSE_BACKFILL_FAILURE_LIMIT) {
      this.metaSet("streak", "0");
      return true;
    }
    this.metaSet("streak", String(streak));
    return false;
  }

  private async halt(): Promise<void> {
    this.metaSet("wait_reason", "halted");
    this.deps.log("jra-horse-backfill: halted (no profile could be read in consecutive wakes); resumes next day", "error");
    await this.deps.setAlarm(nextDayStart(this.deps.now()));
  }

  private skippedAmong(ids: readonly string[]): Set<string> {
    if (ids.length === 0) return new Set();
    const rows = this.deps.sql.exec("SELECT horse_id FROM hb_skip WHERE horse_id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).toArray() as { horse_id: string }[];
    return new Set(rows.map((r) => r.horse_id));
  }

  private async step(): Promise<void> {
    const { deps } = this;
    const start = deps.now();
    if (!inHorseBackfillWindow(start)) {
      this.metaSet("wait_reason", "outside-window");
      await deps.setAlarm(nextHorseBackfillStart(start));
      return;
    }
    const day = jstDay(start);
    if (this.metaGet("day") !== day) {
      this.metaSet("day", day);
      this.metaSet("day_rows", "0");
    }
    const remaining = this.dailyRows - this.metaNum("day_rows");
    if (remaining <= 0) {
      this.metaSet("wait_reason", "daily-limit");
      await deps.setAlarm(nextDayStart(start));
      return;
    }
    const budget = Math.min(HORSE_BACKFILL_PER_WAKE, remaining);

    const cursor = this.metaGet("cursor") ?? "";
    const page = await deps.store.listHorseIdsAfter(cursor, HORSE_BACKFILL_PAGE);
    const atEnd = page.length < HORSE_BACKFILL_PAGE;
    const missing = await deps.store.filterTargets(page);
    const skipped = this.skippedAmong(missing);

    const profiles: SavedHorseProfile[] = [];
    const newSkips: { id: string; reason: SkipReason }[] = [];
    let attempted = 0;
    let failed = 0;
    let lastId: string | null = null;
    let cut = false;
    let lastStartAt: number | null = null;
    for (const id of missing) {
      if (skipped.has(id)) continue;
      if (attempted >= budget || !inHorseBackfillWindow(deps.now())) {
        cut = true;
        break;
      }
      const suffix = horseCnameSuffix(id);
      if (suffix === null) {
        newSkips.push({ id, reason: "uncomputable" });
        lastId = id;
        continue;
      }
      if (lastStartAt !== null) {
        const wait = HORSE_BACKFILL_GAP_MS - (deps.now() - lastStartAt);
        if (wait > 0) await deps.sleep(wait);
        if (!inHorseBackfillWindow(deps.now())) {
          cut = true;
          break;
        }
      }
      lastStartAt = deps.now();
      attempted += 1;
      const outcome = await deps.fetchProfile(id, suffix);
      lastId = id;
      if (outcome.kind === "failed") {
        if (outcome.reason === "too-large") newSkips.push({ id, reason: "too-large" });
        else failed += 1;
        continue;
      }
      const parsed = parseHorseProfilePage(outcome.html);
      if (parsed.ok) profiles.push({ horseId: id, ...parsed.profile });
      else newSkips.push({ id, reason: parsed.reason });
    }

    // 書く(失敗したら例外のまま抜ける: カーソルも飛ばす記録も進めない)。
    const written = profiles.length > 0 ? await deps.store.insertProfiles(profiles, day) : 0;
    for (const s of newSkips) {
      deps.sql.exec("INSERT INTO hb_skip (horse_id, reason, day) VALUES (?, ?, ?) ON CONFLICT(horse_id) DO NOTHING", s.id, s.reason, day);
    }
    this.metaSet("day_rows", String(this.metaNum("day_rows") + written));
    const lapAttempts = this.metaNum("lap_attempts") + attempted;
    this.metaSet("lap_attempts", String(lapAttempts));
    this.metaSet("cursor", cut ? (lastId ?? cursor) : atEnd ? "" : (page[page.length - 1] ?? cursor));
    deps.log(`jra-horse-backfill: wake fetched=${attempted} saved=${written} skipped=${newSkips.length} failed=${failed}`, "info");

    if (attempted > 0) {
      if (profiles.length === 0) {
        if (this.countFailure()) {
          await this.halt();
          return;
        }
      } else {
        this.metaSet("streak", "0");
      }
    }

    if (!cut && atEnd) {
      this.metaSet("lap_attempts", "0");
      if (lapAttempts === 0) {
        this.metaSet("wait_reason", "idle");
        return; // この周で取った馬が無い: アラームを張らず、次の kick まで休む。
      }
    }
    this.metaSet("wait_reason", "active");
    await deps.setAlarm(deps.now() + (attempted > 0 ? HORSE_BACKFILL_NEXT_DELAY_MS : HORSE_BACKFILL_SCAN_DELAY_MS));
  }
}
