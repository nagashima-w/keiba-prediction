/**
 * 発走 5 分前の単勝・複勝の全頭のオッズの記録 `odds_snapshots` の D1 への書き込み(Issue #732。migration 0046)。
 *
 * 1 レース・1 時点(発走の 10 分前・5 分前)で 1 行(主キーは (race_id, lead_min))。**追記だけ**: SQL 1 文(INSERT。同じ鍵が既にあれば何もしない)。UPDATE・DELETE は書かない。保存の再試行・保存済みの再実行が、先に入った行を書き換えず、書き込みの行も食わない。
 * 読み出しは {@link readWinOdds5} だけ(Issue #796。分析の画面が、5 分前の単勝を主キーで 1 行だけ引く。探索は本番の D1 を SELECT で直接読む)。失敗は投げる(呼び出し側の段が再試行する。分析は止めない)。
 */
import type { OddsSnapshotPayload } from "./race-day-odds-snapshot";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type OddsSnapshotDb = Pick<D1Database, "prepare">;

/** 保存の口(本番は {@link D1OddsSnapshotStore})。 */
export interface OddsSnapshotSink {
  /** 1 レース・1 時点の記録を追記する(先着)。失敗は投げる。 */
  save(payload: OddsSnapshotPayload): Promise<void>;
}

/** 書き込みの SQL(テストが計画と動作を固定する)。 */
export const INSERT_ODDS_SNAPSHOT_SQL =
  "INSERT INTO odds_snapshots (race_id, lead_min, kaisai_date, start_ms, due_ms, taken_at_ms, official_datetime, odds_status, status, reason, attempts, horses_json, combos_json, fail_detail) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (race_id, lead_min) DO NOTHING";

/** 5 分前の 1 行(主キー (race_id, lead_min) の引き。読む行は多くとも 1)。Issue #796。 */
export const SELECT_ODDS_SNAPSHOT_WIN5_SQL = "SELECT status, horses_json FROM odds_snapshots WHERE race_id = ? AND lead_min = 5";

/** 読み取りに使う D1 の部分集合。 */
export type OddsSnapshotReadDb = { prepare(sql: string): { bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> } } };

/**
 * 5 分前の単勝(馬番 → 単勝)。行が無い・`status` が ok でない・`horses_json` が読めない・単勝が 1 頭も読めないときは null。
 * 単勝が null・0 以下・有限でない馬は表に載せない。D1 の失敗は投げる(呼び出し側が握る)。
 */
export async function readWinOdds5(db: OddsSnapshotReadDb, raceId: string): Promise<Map<number, number> | null> {
  const row = await db.prepare(SELECT_ODDS_SNAPSHOT_WIN5_SQL).bind(raceId).first<{ status: unknown; horses_json: unknown }>();
  if (row === null || row.status !== "ok" || typeof row.horses_json !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.horses_json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out = new Map<number, number>();
  for (const h of parsed as unknown[]) {
    if (!Array.isArray(h)) continue;
    const [umaban, win] = h as unknown[];
    if (typeof umaban === "number" && Number.isInteger(umaban) && typeof win === "number" && Number.isFinite(win) && win > 0) {
      out.set(umaban, win);
    }
  }
  return out.size === 0 ? null : out;
}

export class D1OddsSnapshotStore implements OddsSnapshotSink {
  private readonly db: OddsSnapshotDb;

  constructor(options: { readonly db: OddsSnapshotDb }) {
    this.db = options.db;
  }

  async save(p: OddsSnapshotPayload): Promise<void> {
    await this.db
      .prepare(INSERT_ODDS_SNAPSHOT_SQL)
      .bind(p.raceId, p.leadMin, p.kaisaiDate, p.startMs, p.dueMs, p.takenAtMs, p.officialDatetime, p.oddsStatus, p.status, p.reason, p.attempts, p.horses === null ? null : JSON.stringify(p.horses), p.combos === null ? null : JSON.stringify(p.combos), p.failDetail ?? null)
      .run();
  }
}
