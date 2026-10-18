/**
 * 騎手の年ごとの成績の D1 への保存・読み出し(Issue #226。migration 0012 の表 `jockey_results`)。
 *
 * core の {@link JockeyResultsStore} の D1 実装。`scrapeRace` が取得の前にまとめて読み(`loadMany`。取得日時から 7 日以内なら netkeiba に出ない)、
 * 取得したぶんを取得の後にまとめて書く(`saveMany`)。ユーザー決定(2026-10-11): 騎手の成績の更新は週に 1 回で十分。
 *
 * 1 騎手・1 区分で 1 行(年ごとの成績は `[[年, 騎乗数, 3着内], ...]` の JSON 1 つ)。読みは 1 クエリ(`IN` で全員)、書き込みは 20 人で 1 クエリ
 * (複数行の `INSERT … ON CONFLICT DO UPDATE`。バインド変数は 1 人 4 つ×20 人 = 80 で、D1 の上限 100 の内側)。`batch` は使わない。
 * 壊れた行(JSON でない・形が違う)は無いものとして扱う(取得へフォールバックして上書きされる。分析を止めない)。
 * D1 の失敗は投げる(呼び出し側の `scrapeRace` が警告にして取得へフォールバックする)。
 */

import type { JockeyResultsSaveEntry, JockeyResultsStore, StoredJockeyResults } from "../../packages/core/src/scraper/jockey-results-store";
import type { RaceIdVenueKind } from "../../packages/core/src/scraper/ids";
import type { JockeyYearRecord } from "../../packages/core/src/scraper/parse-jockey-results";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type JockeyResultsDb = Pick<D1Database, "prepare">;

/** 1 回の INSERT に入れる行数(1 行 4 変数 × 20 = 80 ≤ D1 のバインド変数の上限 100)。 */
export const JOCKEY_SAVE_CHUNK = 20;

const SAVE_HEAD = "INSERT INTO jockey_results (jockey_id, kind, years_json, fetched_at) VALUES ";
const SAVE_TAIL = " ON CONFLICT (jockey_id, kind) DO UPDATE SET years_json = excluded.years_json, fetched_at = excluded.fetched_at";

/** 年ごとの成績を保存する形(`[[年, 騎乗数, 3着内], ...]`)にする。 */
export function encodeYears(years: readonly JockeyYearRecord[]): string {
  return JSON.stringify(years.map((y) => [y.year, y.starts, y.placed]));
}

/** 保存した形から年ごとの成績に戻す。形が違えば null(その行は無いものとして扱う)。 */
export function decodeYears(json: string): JockeyYearRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: JockeyYearRecord[] = [];
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length !== 3) {
      return null;
    }
    const [year, starts, placed] = item as unknown[];
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(starts) ||
      !Number.isInteger(placed) ||
      (starts as number) < 0 ||
      (placed as number) < 0 ||
      (placed as number) > (starts as number)
    ) {
      return null;
    }
    out.push({ year: year as number, starts: starts as number, placed: placed as number });
  }
  return out;
}

export class D1JockeyResultsStore implements JockeyResultsStore {
  private readonly db: JockeyResultsDb;

  constructor(options: { readonly db: JockeyResultsDb }) {
    this.db = options.db;
  }

  async loadMany(jockeyIds: readonly string[], kind: RaceIdVenueKind): Promise<ReadonlyMap<string, StoredJockeyResults>> {
    const out = new Map<string, StoredJockeyResults>();
    if (jockeyIds.length === 0) {
      return out;
    }
    const placeholders = jockeyIds.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(`SELECT jockey_id AS jockeyId, years_json AS yearsJson, fetched_at AS fetchedAt FROM jockey_results WHERE kind = ? AND jockey_id IN (${placeholders})`)
      .bind(kind, ...jockeyIds)
      .all<{ jockeyId: string; yearsJson: string; fetchedAt: number }>();
    for (const row of results) {
      const years = decodeYears(row.yearsJson);
      if (years !== null && Number.isFinite(row.fetchedAt)) {
        out.set(row.jockeyId, { fetchedAtMs: row.fetchedAt, years });
      }
    }
    return out;
  }

  async saveMany(kind: RaceIdVenueKind, entries: readonly JockeyResultsSaveEntry[]): Promise<void> {
    for (let i = 0; i < entries.length; i += JOCKEY_SAVE_CHUNK) {
      const chunk = entries.slice(i, i + JOCKEY_SAVE_CHUNK);
      const values = chunk.map(() => "(?, ?, ?, ?)").join(", ");
      const binds = chunk.flatMap((e) => [e.jockeyId, kind, encodeYears(e.years), e.fetchedAtMs]);
      await this.db.prepare(`${SAVE_HEAD}${values}${SAVE_TAIL}`).bind(...binds).run();
    }
  }
}
