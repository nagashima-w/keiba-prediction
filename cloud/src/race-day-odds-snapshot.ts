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
/** 時点(発走の何分前か)。D1 の `lead_min`。 */
export type OddsSnapshotLeadMin = 10 | 5;
export const ODDS_SNAPSHOT_LEAD_MINS: readonly OddsSnapshotLeadMin[] = [10, 5];
export const oddsSnapshotLeadMs = (leadMin: OddsSnapshotLeadMin): number => (leadMin === 10 ? ODDS_SNAPSHOT_EARLY_LEAD_MS : ODDS_SNAPSHOT_LEAD_MS);
/**
 * その時点の取得が意味を持つ最後の時刻(これ以降に起きたら取りに行かない)。**5 分前は発走、10 分前は 5 分前の時刻**(5 分前を優先する)。
 * 再試行も、この時刻より前に限る。
 */
export const oddsSnapshotSupersedeMs = (startMs: number, leadMin: OddsSnapshotLeadMin): number => (leadMin === 10 ? startMs - ODDS_SNAPSHOT_LEAD_MS : startMs);
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

const isNumOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const isHorse = (v: unknown): v is OddsSnapshotHorse =>
  Array.isArray(v) && v.length === 6 && typeof v[0] === "number" && v.slice(1, 5).every(isNumOrNull) && (v[5] === null || typeof v[5] === "string");

/** DO に持つ結果(`payload_json`)を読む。形が違う・整合しないなら null(呼び出し側は、持っていないものとして取り直す)。 */
export function parseOddsSnapshotPayload(text: string): OddsSnapshotPayload | null {
  try {
    const p = JSON.parse(text) as Record<string, unknown>;
    if (p.leadMin !== 10 && p.leadMin !== 5) {
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
    if (p.status === "ok") {
      if (p.reason !== null || !Array.isArray(p.horses) || !p.horses.every(isHorse)) {
        return null;
      }
    } else if (p.horses !== null || (p.reason !== "too-late" && p.reason !== "fetch-failed")) {
      return null;
    }
    return p as unknown as OddsSnapshotPayload;
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

  /** 予定の行(10 分前・5 分前の 2 行)を積む(**同期**)。**発走を過ぎていれば積まない**(false)。既にある行は変えない(確定の再実行で巻き戻さない)。 */
  register(reg: OddsSnapshotRegistration): boolean {
    if (reg.startMs <= reg.now) {
      return false;
    }
    for (const leadMin of ODDS_SNAPSHOT_LEAD_MINS) {
      this.sql.exec(
        "INSERT INTO race_day_odds_snap (race_id, lead_min, kaisai_date, start_ms, due_ms, state) VALUES (?, ?, ?, ?, ?, 'pending') ON CONFLICT(race_id, lead_min) DO NOTHING",
        reg.raceId,
        leadMin,
        reg.kaisaiDate,
        reg.startMs,
        reg.startMs - oddsSnapshotLeadMs(leadMin),
      );
    }
    return true;
  }

  /** 起こす時刻が来ている pending の行のうち、**5 分前の行を先に**、その中で最も早いもの(同じ時刻はレース ID の順。5 分前が必須で、10 分前の遅れが 5 分前を押しのけないため)。 */
  nextDue(now: number): OddsSnapshotTaskRow | null {
    const rows = this.sql
      .exec("SELECT * FROM race_day_odds_snap WHERE state = 'pending' AND COALESCE(next_try_at, due_ms) <= ? ORDER BY lead_min, COALESCE(next_try_at, due_ms), race_id LIMIT 1", now)
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
