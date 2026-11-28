/**
 * 発走の 5 分前の、中央の単勝・複勝の全頭のオッズの記録(Issue #732。探索〈#700〉と、フォワードテスト〈#741〉の材料)の、定数・型・DO の表・馬ごとの配列の作り方。
 * **型と純関数と SQL だけ**(Worker・DO・D1 の実体を import しない)。取得の手順は `race-day-odds-snapshot-stage.ts`、D1 への保存は `odds-snapshot-repository.ts`。
 *
 * ## 何をするか
 * 計画(`race_day_plan`)の中央のレースごと(**分析したかどうかによらない**。締切の再計算〈`analysis-close.ts`〉は分析したレースだけが対象)に、発走の 10 分前と 5 分前の 2 つの予定を積む
 * (**5 分前が必須。10 分前は比べるための記録**。ユーザー決定 2026-11-13)。時刻が来たら JRA の単勝・複勝の頁を 1 本取り、全頭の単勝と複勝(下限・上限)を
 * D1 の `odds_snapshots`(migration 0046)に **1 レース・1 時点で 1 行**(主キー (race_id, lead_min))で残す。
 * 時刻は発走が基準(締切の正確な時刻は未確認のため)。**`start_ms` と、取った実際の時刻 `taken_at_ms`(予定の時刻ではない)の両方を残す**ので、実際の発走までの残りは引き算で分かる。
 * **追記だけ**: 記録した行は書き換えない(INSERT だけ。同じ鍵が既にあれば何もしない)。
 * 10 分前の取得が遅れて 5 分前の時刻にぶつかるときは、5 分前を優先する(10 分前は取らず too-late で終える。5 分前の行は、2 つが同時に動ける間は常に先に動く)。
 * 締切の再計算の回(`CLOSE_ROUNDS`)には触らない。取得は独立に行う(締切の再計算が同じ時刻に同じ頁を取ることがあるが、初版は重複を許す)。
 *
 * ## DO の表 `race_day_odds_snap`
 * 主キー (race_id, lead_min)。`state`: `pending` → `done`(D1 に保存した)| `abandoned`(保存を諦めた)。結果(`payload_json`)は保存の前に DO に書く(保存の再試行で取り直さない。`race-day-close.ts` の `CloseStore` と同じ型)。
 */
import type { OddsSnapshot } from "../../packages/core/src/scraper/types";
import type { SqlLike } from "./sql-like";

/** 必須の時点: 発走の何ミリ秒前に取るか(ユーザー決定 2026-11-13: 5 分前)。 */
export const ODDS_SNAPSHOT_LEAD_MS = 5 * 60_000;
/** 比べるための時点: 発走の 10 分前(ユーザー決定 2026-11-13。探索の要望)。 */
export const ODDS_SNAPSHOT_EARLY_LEAD_MS = 10 * 60_000;
/**
 * 時点。D1 の `lead_min`。**正の値は発走の何分前か(10・5)。負の値(#787)は発走からの分数ではなく、時点の種類の符号**:
 * `-1` = 前日の夜(前日 21:00 JST 以降の最初の起床。単勝・複勝だけ)/ `-2` = 当日の朝(09:30 JST 以降。単勝・複勝だけ)。
 * 実際に取った時刻は `taken_at_ms`、発走までの残りは `start_ms - taken_at_ms`。
 */
export type OddsSnapshotLeadMin = 10 | 5 | -1 | -2;
/** 前日の夜の時点(`lead_min = -1`)。 */
export const ODDS_SNAPSHOT_EVENING = -1;
/** 当日の朝の時点(`lead_min = -2`)。 */
export const ODDS_SNAPSHOT_MORNING = -2;
export const ODDS_SNAPSHOT_LEAD_MINS: readonly OddsSnapshotLeadMin[] = [10, 5, -1, -2];
/** 前日の夜の行を取り始める時刻(前日の JST)と、最後の時刻(開催日の JST)の時。 */
export const ODDS_SNAPSHOT_EVENING_DUE_HOUR_JST = 21;
export const ODDS_SNAPSHOT_EVENING_LAST_HOUR_JST = 5;
/** 当日の朝の行を取り始める時刻(開催日の 09:30 JST)。 */
export const ODDS_SNAPSHOT_MORNING_DUE_JST = "09:30";
export const oddsSnapshotLeadMs = (leadMin: 10 | 5): number => (leadMin === 10 ? ODDS_SNAPSHOT_EARLY_LEAD_MS : ODDS_SNAPSHOT_LEAD_MS);
/** 開催日(YYYYMMDD)の JST の時刻(HH:MM)のエポックミリ秒。 */
const jstMs = (kaisaiDate: string, hhmm: string): number => Date.parse(`${kaisaiDate.slice(0, 4)}-${kaisaiDate.slice(4, 6)}-${kaisaiDate.slice(6, 8)}T${hhmm}:00+09:00`);
const DAY_MS = 86_400_000;
/** 取る予定の時刻(`due_ms`)。10・5 は発走から逆算、-1 は前日 21:00 JST、-2 は開催日 09:30 JST。 */
export const oddsSnapshotDueMs = (leadMin: OddsSnapshotLeadMin, startMs: number, kaisaiDate: string): number =>
  leadMin === ODDS_SNAPSHOT_EVENING
    ? jstMs(kaisaiDate, `${String(ODDS_SNAPSHOT_EVENING_DUE_HOUR_JST).padStart(2, "0")}:00`) - DAY_MS
    : leadMin === ODDS_SNAPSHOT_MORNING
      ? jstMs(kaisaiDate, ODDS_SNAPSHOT_MORNING_DUE_JST)
      : startMs - oddsSnapshotLeadMs(leadMin);
/**
 * その時点の取得が意味を持つ最後の時刻(これ以降に起きたら取りに行かない)。**5 分前は発走、10 分前は 5 分前の時刻**(5 分前を優先する)、
 * **前日の夜は開催日の 05:00 JST、当日の朝は発走の 10 分前**(#787)。再試行も、この時刻より前に限る。
 */
export const oddsSnapshotSupersedeMs = (startMs: number, leadMin: OddsSnapshotLeadMin, kaisaiDate: string): number =>
  leadMin === ODDS_SNAPSHOT_EVENING
    ? jstMs(kaisaiDate, `${String(ODDS_SNAPSHOT_EVENING_LAST_HOUR_JST).padStart(2, "0")}:00`)
    : leadMin === ODDS_SNAPSHOT_MORNING
      ? startMs - ODDS_SNAPSHOT_EARLY_LEAD_MS
      : leadMin === 10
        ? startMs - ODDS_SNAPSHOT_LEAD_MS
        : startMs;
/** 取得の試行の上限(初回 + 再試行 3 回。ユーザー決定 2026-11-13: 再試行は発走前に限り 3 回まで)。 */
export const ODDS_SNAPSHOT_FETCH_MAX_ATTEMPTS = 4;
/** 取得の再試行の間隔(締切の再計算の {@link import("./race-day-close").CLOSE_FETCH_RETRY_DELAY_MS} と同じ 15 秒)。 */
export const ODDS_SNAPSHOT_FETCH_RETRY_DELAY_MS = 15_000;
/** D1 への保存の試行の上限(締切の再計算と同じ 3 回)。 */
export const ODDS_SNAPSHOT_SAVE_MAX_ATTEMPTS = 3;
/** D1 への保存の再試行の間隔(締切の再計算と同じ 20 秒)。 */
export const ODDS_SNAPSHOT_SAVE_RETRY_DELAY_MS = 20_000;
export type OddsSnapshotStatus = "ok" | "failed" | "skipped";
/** 理由の語(固定。例外の文面・URL・本文は残さない)。`too-late` = 起きたのが、その時点の取得が意味を持つ最後の時刻の後(10 分前は 5 分前の時刻、5 分前は発走。skipped)/ `fetch-failed` = 頁を取れなかった・読めなかった(failed)。 */
export type OddsSnapshotReason = "too-late" | "fetch-failed";
export type OddsSnapshotState = "pending" | "done" | "abandoned";

/**
 * 馬ごとの [馬番, 単勝, 単勝の人気, 複勝の下限, 複勝の上限, 馬の ID(10 桁の文字列)]。値が無い(読めない・取消・発売前・リンクが無い)ものは null。
 * 馬の ID は JRA の頁の馬のリンクから読んだもの(netkeiba の馬の ID と同じかは、#637 で 18 頭を確かめただけ)。探索は、この ID か馬番を出馬表と突き合わせて使う。
 */
export type OddsSnapshotHorse = readonly [number, number | null, number | null, number | null, number | null, string | null];

/**
 * 組合せの頁が取れなかった理由(固定の語)。`fetch-failed` = 頁を取れなかった / `unavailable` = 表が読めない・全組が票数なし / `parse-error` = 読み取りの失敗 /
 * `not-sold` = そのレースにその券種の発売が無い(Issue #817。枠連は 8 頭以下で発売されず、JRA のレース選択の頁にリンクが無い。取りに行っていない。取れなかったのではないので、`fetch-failed` と区別する)。
 */
export type OddsSnapshotComboErr = "fetch-failed" | "unavailable" | "parse-error" | "not-sold";
/** 組合せの 1 頁(馬連・枠連・3連複)。取れたとき = 取った時刻 t・頁の時刻 dt・頁の状態 st・組ごとの値 o(キーは小さい番号を先にした 2 桁連結。票数なしは null)。取れなかったとき = {err}。 */
export type OddsSnapshotComboPage =
  | { readonly t: number; readonly dt: string | null; readonly st: string | null; readonly o: Readonly<Record<string, number | null>> }
  | { readonly err: OddsSnapshotComboErr };
/**
 * ワイドの 1 頁。組合せの頁(上の {@link OddsSnapshotComboPage})と同じ形で、`o` の値だけが幅の [下限, 上限](組ごと。票数なしの組は null、上限が読めないときは [下限, null])。
 * 取れなかったとき = {err}。
 */
export type OddsSnapshotWidePage =
  | { readonly t: number; readonly dt: string | null; readonly st: string | null; readonly o: Readonly<Record<string, readonly [number | null, number | null] | null>> }
  | { readonly err: OddsSnapshotComboErr };
/**
 * 馬連・枠連・ワイド・3連複の記録(#751)。D1 の `combos_json`。
 * `wide`・`sanrenpuku` は 2 段目で足した(馬連・枠連だけの古い形も有効。デプロイの前に DO に置かれた結果は、この 2 つが無いまま読む)。書くときは 4 つとも書く。
 */
export interface OddsSnapshotCombos {
  readonly umaren: OddsSnapshotComboPage;
  readonly wakuren: OddsSnapshotComboPage;
  readonly wide?: OddsSnapshotWidePage;
  readonly sanrenpuku?: OddsSnapshotComboPage;
  /**
   * 馬単(#794)。頁の形は馬連と同じ(値は単一)。**キーは順序つき**: 1 着・2 着の順の 2 桁連結(例: "0102" = 1 着 01・2 着 02。"0201" は別の組)。馬連・3連複のように小さい番号を先にしない。
   * 10 分前・5 分前の両方の行に入る。無い古い形も有効(キーが無いことと {err} は別)。
   */
  readonly umatan?: OddsSnapshotComboPage;
  /**
   * 三連単(#794)。頁の形は馬連と同じ(値は単一)。**キーは順序つき**: 1 着・2 着・3 着の順の 6 桁連結(例: "010203")。票数なしの組は null のまま残す。
   * **5 分前の行にだけ**入る(10 分前の行にはキーが無い。D1 の増えを抑えるため。ユーザー決定)。
   */
  readonly sanrentan?: OddsSnapshotComboPage;
}

/** `failDetail` の形(`buildFailDetail` の出力: p・k・(h)・(c))。 */
const FAIL_DETAIL_SHAPE = /^\{"p":"[a-z]{1,12}","k":"[a-z0-9-]{1,12}"(,"h":[1-5]\d\d)?(,"c":"[A-Z]{3}")?\}$/;

/** 1 レースの記録(DO の `payload_json` と、D1 の行の元)。 */
export interface OddsSnapshotPayload {
  readonly raceId: string;
  /** 時点(発走の何分前の予定か)。 */
  readonly leadMin: OddsSnapshotLeadMin;
  readonly kaisaiDate: string;
  readonly startMs: number;
  readonly dueMs: number;
  /** 実際に取った時刻(予定の時刻ではない。頁を取って取得キャッシュに置いた時刻)。`ok` 以外は、取れなかった・取らないと決めた時刻(最後の試行)。 */
  readonly takenAtMs: number;
  /** JRA の頁の時刻(`YYYY-MM-DD HH:MM:00`)。頁に無ければ null。 */
  readonly officialDatetime: string | null;
  /** 頁の発売状態(middle・result・yoso)。`ok` のときだけ。 */
  readonly oddsStatus: string | null;
  readonly status: OddsSnapshotStatus;
  readonly reason: OddsSnapshotReason | null;
  readonly attempts: number;
  /** `ok` のときだけ(馬番の昇順)。 */
  readonly horses: readonly OddsSnapshotHorse[] | null;
  /** 馬連・枠連・ワイド・3連複の全組(#751)。`ok` のときだけ(それ以外は null。古い形の DO の結果にも無い)。単勝・複勝が取れていれば、組合せが取れなくても `ok`(頁ごとに {err})。 */
  readonly combos: OddsSnapshotCombos | null;
  /**
   * 取れなかった(`failed`)行の失敗の詳細(Issue #804。D1 の `odds_snapshots.fail_detail`)。固定の鍵と語だけの短い JSON(`{"p":頁,"k":種類,"h":HTTP の状態,"c":拠点}`。
   * 組み立ては `jra-fail-detail.ts` の `buildFailDetail`)。`failed` の行にだけ付く(ok・skipped と、導入前に DO に置かれた結果には無い)。
   */
  readonly failDetail?: string | null;
}

/** 頁の値から馬ごとの配列を作る(馬番の昇順。単勝・複勝・馬の ID のどれかにだけある馬番も落とさない)。 */
export function horsesOfSnapshot(snapshot: OddsSnapshot, horseIds: Readonly<Record<number, string>> = {}): OddsSnapshotHorse[] {
  const numbers = new Set<number>([...Object.keys(snapshot.win), ...Object.keys(snapshot.place), ...Object.keys(horseIds)].map(Number));
  return [...numbers]
    .sort((a, b) => a - b)
    .map((n): OddsSnapshotHorse => {
      const win = snapshot.win[n];
      const place = snapshot.place[n];
      return [n, win?.odds ?? null, win?.ninki ?? null, place?.oddsMin ?? null, place?.oddsMax ?? null, horseIds[n] ?? null];
    });
}

/**
 * 取得キャッシュの組合せの JSON(`jra-odds-cache.ts` の形。`cells` = [キー, {oddsMin, ...}] の配列)から、記録の 1 頁を作る。形が違えば null。
 * 値は `oddsMin` だけ(馬連・枠連は単一の値で、`oddsMax`・人気は無い)。票数なしの組は null のまま残す。
 */
export function comboPageOfCache(json: string, fetchedAt: number): OddsSnapshotComboPage | null {
  return pageOfCache(json, fetchedAt, (cell) => finiteOrNull(cell?.oddsMin));
}

/**
 * ワイド版(#751 の 2 段目)。値は幅 [下限, 上限]。下限が読めない組(票数なし)は null、上限が読めなければ [下限, null]。形が違えば null。
 * 馬連・枠連・3連複の {@link comboPageOfCache} は下限だけを単一値にするので、ワイドにそれを使うと上限が落ちる。
 */
export function widePageOfCache(json: string, fetchedAt: number): OddsSnapshotWidePage | null {
  return pageOfCache(json, fetchedAt, (cell) => {
    const lo = finiteOrNull(cell?.oddsMin);
    return lo === null ? null : ([lo, finiteOrNull(cell?.oddsMax)] as const);
  });
}

const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function pageOfCache<V>(
  json: string,
  fetchedAt: number,
  valueOf: (cell: { oddsMin?: unknown; oddsMax?: unknown } | null) => V,
): { readonly t: number; readonly dt: string | null; readonly st: string | null; readonly o: Readonly<Record<string, V>> } | null {
  try {
    const p = JSON.parse(json) as { officialDatetime?: unknown; oddsStatus?: unknown; cells?: unknown };
    if (!Array.isArray(p.cells)) {
      return null;
    }
    const o: Record<string, V> = {};
    for (const cell of p.cells as unknown[]) {
      if (!Array.isArray(cell) || typeof cell[0] !== "string") {
        return null;
      }
      o[cell[0]] = valueOf(cell[1] as { oddsMin?: unknown; oddsMax?: unknown } | null);
    }
    return {
      t: fetchedAt,
      dt: typeof p.officialDatetime === "string" ? p.officialDatetime : null,
      st: typeof p.oddsStatus === "string" ? p.oddsStatus : null,
      o,
    };
  } catch {
    return null;
  }
}

const isNumOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const isHorse = (v: unknown): v is OddsSnapshotHorse =>
  Array.isArray(v) && v.length === 6 && typeof v[0] === "number" && v.slice(1, 5).every(isNumOrNull) && (v[5] === null || typeof v[5] === "string");

const isNumPairOrNull = (v: unknown): boolean => v === null || (Array.isArray(v) && v.length === 2 && v.every(isNumOrNull));

/** 頁の形(`err` か、t・dt・st・o)。`o` の値の検査は引数(馬連・枠連・3連複は単一値、ワイドは幅)。 */
const isPageWith = (v: unknown, valueOk: (x: unknown) => boolean): boolean => {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const page = v as Record<string, unknown>;
  if ("err" in page) {
    return page.err === "fetch-failed" || page.err === "unavailable" || page.err === "parse-error" || page.err === "not-sold";
  }
  return (
    typeof page.t === "number" && Number.isFinite(page.t) && (page.dt === null || typeof page.dt === "string") && (page.st === null || typeof page.st === "string") &&
    typeof page.o === "object" && page.o !== null && !Array.isArray(page.o) && Object.values(page.o).every(valueOk)
  );
};
const isComboPage = (v: unknown): v is OddsSnapshotComboPage => isPageWith(v, isNumOrNull);
const isWidePage = (v: unknown): v is OddsSnapshotWidePage => isPageWith(v, isNumPairOrNull);

/** DO に持つ結果(`payload_json`)を読む。形が違う・整合しないなら null(呼び出し側は、持っていないものとして取り直す)。 */
export function parseOddsSnapshotPayload(text: string): OddsSnapshotPayload | null {
  try {
    const p = JSON.parse(text) as Record<string, unknown>;
    if (p.leadMin !== 10 && p.leadMin !== 5 && p.leadMin !== -1 && p.leadMin !== -2) {
      return null;
    }
    if (typeof p.raceId !== "string" || typeof p.kaisaiDate !== "string" || typeof p.startMs !== "number" || typeof p.dueMs !== "number" || typeof p.attempts !== "number") {
      return null;
    }
    if (p.status !== "ok" && p.status !== "failed" && p.status !== "skipped") {
      return null;
    }
    if (typeof p.takenAtMs !== "number" || !Number.isFinite(p.takenAtMs) || !(p.officialDatetime === null || typeof p.officialDatetime === "string") || !(p.oddsStatus === null || typeof p.oddsStatus === "string")) {
      return null;
    }
    // combos は #751 で足した。無い(undefined)古い形も受け付け、null として読む(デプロイの前に DO に置かれた結果を捨てない)。
    const combos = p.combos ?? null;
    if (combos !== null) {
      const c = combos as Record<string, unknown>;
      // wide・sanrenpuku は 2 段目で足した。無い古い形(馬連・枠連だけ)は有効(undefined は許す)。ある場合は形を検査する。
      if (
        typeof combos !== "object" ||
        !isComboPage(c.umaren) ||
        !isComboPage(c.wakuren) ||
        !(c.wide === undefined || isWidePage(c.wide)) ||
        !(c.sanrenpuku === undefined || isComboPage(c.sanrenpuku)) ||
        !(c.umatan === undefined || isComboPage(c.umatan)) ||
        !(c.sanrentan === undefined || isComboPage(c.sanrentan)) ||
        p.status !== "ok"
      ) {
        return null;
      }
    }
    if (p.status === "ok") {
      if (p.reason !== null || !Array.isArray(p.horses) || !p.horses.every(isHorse)) {
        return null;
      }
    } else if (p.horses !== null || (p.reason !== "too-late" && p.reason !== "fetch-failed")) {
      return null;
    }
    // failDetail(#804)は、無い古い形も有効。ある場合は failed の行の固定の形だけ(DO の状態から D1 へ外の文字列を通さない)。
    if (p.failDetail !== undefined && p.failDetail !== null && (p.status !== "failed" || typeof p.failDetail !== "string" || !FAIL_DETAIL_SHAPE.test(p.failDetail))) {
      return null;
    }
    return { ...p, combos } as unknown as OddsSnapshotPayload;
  } catch {
    return null;
  }
}

export interface OddsSnapshotRegistration {
  readonly raceId: string;
  /** 開催日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
  readonly startMs: number;
  readonly now: number;
}

export interface OddsSnapshotTaskRow {
  readonly race_id: string;
  readonly lead_min: OddsSnapshotLeadMin;
  readonly kaisai_date: string;
  readonly start_ms: number;
  readonly due_ms: number;
  readonly state: OddsSnapshotState;
  readonly attempts: number;
  readonly save_attempts: number;
  readonly next_try_at: number | null;
  readonly fired_at: number | null;
  readonly payload_json: string | null;
}

export class OddsSnapshotStore {
  constructor(private readonly sql: SqlLike) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS race_day_odds_snap (
         race_id TEXT NOT NULL, lead_min INTEGER NOT NULL, kaisai_date TEXT NOT NULL, start_ms INTEGER NOT NULL, due_ms INTEGER NOT NULL, state TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0, save_attempts INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER, fired_at INTEGER, payload_json TEXT,
         PRIMARY KEY (race_id, lead_min))`,
    );
  }

  /**
   * 予定の行を積む(**同期**)。**発走を過ぎていれば積まない**(false)。既にある行は変えない(確定の再実行で巻き戻さない)。
   * 10 分前・5 分前は常に積む。**前日の夜(-1)と当日の朝(-2)は、最後の時刻より前のときだけ**積む(#787。過ぎてから確定した日に、取れない行を残さない)。
   */
  register(reg: OddsSnapshotRegistration): boolean {
    if (reg.startMs <= reg.now) {
      return false;
    }
    for (const leadMin of ODDS_SNAPSHOT_LEAD_MINS) {
      if (leadMin < 0 && reg.now >= oddsSnapshotSupersedeMs(reg.startMs, leadMin, reg.kaisaiDate)) {
        continue;
      }
      this.sql.exec(
        "INSERT INTO race_day_odds_snap (race_id, lead_min, kaisai_date, start_ms, due_ms, state) VALUES (?, ?, ?, ?, ?, 'pending') ON CONFLICT(race_id, lead_min) DO NOTHING",
        reg.raceId,
        leadMin,
        reg.kaisaiDate,
        reg.startMs,
        oddsSnapshotDueMs(leadMin, reg.startMs, reg.kaisaiDate),
      );
    }
    return true;
  }

  /**
   * 起こす時刻が来ている pending の行のうち、**優先は 5 分前 → 10 分前 → 前日の夜(-1)→ 当日の朝(-2)**。その中で最も早いもの(同じ時刻はレース ID の順)。
   * 5 分前が必須で、10 分前の遅れが 5 分前を押しのけず、#787 の 2 つ(負の値)がどちらも先に動かないため。`ORDER BY lead_min` の昇順では -2 が 5 より先に来るので、明示する。
   */
  nextDue(now: number): OddsSnapshotTaskRow | null {
    const rows = this.sql
      .exec("SELECT * FROM race_day_odds_snap WHERE state = 'pending' AND COALESCE(next_try_at, due_ms) <= ? ORDER BY CASE lead_min WHEN 5 THEN 0 WHEN 10 THEN 1 WHEN -1 THEN 2 ELSE 3 END, COALESCE(next_try_at, due_ms), race_id LIMIT 1", now)
      .toArray() as OddsSnapshotTaskRow[];
    return rows[0] ?? null;
  }

  /** アラームの候補: pending の行の、起こす時刻の最小(無ければ null。過去の時刻でもそのまま返す)。 */
  nextAtMs(): number | null {
    const rows = this.sql.exec("SELECT MIN(COALESCE(next_try_at, due_ms)) AS t FROM race_day_odds_snap WHERE state = 'pending'").toArray() as { t: number | null }[];
    return rows[0]?.t ?? null;
  }

  /** 最初に動き始めた時刻を書く(既にあれば変えない)。 */
  markFired(raceId: string, leadMin: OddsSnapshotLeadMin, now: number): void {
    this.sql.exec("UPDATE race_day_odds_snap SET fired_at = ? WHERE race_id = ? AND lead_min = ? AND fired_at IS NULL", now, raceId, leadMin);
  }

  setPayload(raceId: string, leadMin: OddsSnapshotLeadMin, payloadJson: string): void {
    this.sql.exec("UPDATE race_day_odds_snap SET payload_json = ? WHERE race_id = ? AND lead_min = ?", payloadJson, raceId, leadMin);
  }

  setAttempts(raceId: string, leadMin: OddsSnapshotLeadMin, attempts: number): void {
    this.sql.exec("UPDATE race_day_odds_snap SET attempts = ? WHERE race_id = ? AND lead_min = ?", attempts, raceId, leadMin);
  }

  /** 取得の再試行を待つ(試行回数を書き、`next_try_at` に起こす)。 */
  markFetchRetry(raceId: string, leadMin: OddsSnapshotLeadMin, attempts: number, nextTryAt: number): void {
    this.sql.exec("UPDATE race_day_odds_snap SET attempts = ?, next_try_at = ? WHERE race_id = ? AND lead_min = ?", attempts, nextTryAt, raceId, leadMin);
  }

  /** 保存の再試行を待つ。 */
  markSaveRetry(raceId: string, leadMin: OddsSnapshotLeadMin, saveAttempts: number, nextTryAt: number): void {
    this.sql.exec("UPDATE race_day_odds_snap SET save_attempts = ?, next_try_at = ? WHERE race_id = ? AND lead_min = ?", saveAttempts, nextTryAt, raceId, leadMin);
  }

  markDone(raceId: string, leadMin: OddsSnapshotLeadMin): void {
    this.sql.exec("UPDATE race_day_odds_snap SET state = 'done', next_try_at = NULL WHERE race_id = ? AND lead_min = ?", raceId, leadMin);
  }

  markAbandoned(raceId: string, leadMin: OddsSnapshotLeadMin, saveAttempts: number): void {
    this.sql.exec("UPDATE race_day_odds_snap SET state = 'abandoned', save_attempts = ?, next_try_at = NULL WHERE race_id = ? AND lead_min = ?", saveAttempts, raceId, leadMin);
  }

  /** 行の数(テスト・診断用)。 */
  rows(): OddsSnapshotTaskRow[] {
    return this.sql.exec("SELECT * FROM race_day_odds_snap ORDER BY race_id, lead_min DESC").toArray() as OddsSnapshotTaskRow[];
  }
}
