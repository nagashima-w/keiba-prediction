/**
 * 調教師の年ごとの成績の D1 への保存・読み出し(Issue #354。migration 0020 の表 `trainer_results`)。
 *
 * core の {@link TrainerResultsStore} の D1 実装。形は騎手の `D1JockeyResultsStore`(`jockey-results-repository.ts`)と同じで、
 * 年ごとの成績の符号化(`[[年, 出走数, 3着内], ...]`)も共有する。`scrapeRace` が取得の前にまとめて読み(`loadMany`。取得日時が
 * レースの年の 1 月 1 日〈JST〉以降なら netkeiba に出ない)、取得したぶんを取得の後にまとめて書く(`saveMany`)。
 *
 * 1 調教師・1 区分で 1 行。読みは 1 クエリ(`IN` で全員)、書き込みは 20 人で 1 クエリ(バインド変数は 1 人 4 つ×20 人 = 80 で、D1 の上限 100 の内側)。
 * `batch` は使わない。壊れた行(JSON でない・形が違う)は無いものとして扱う(取得へフォールバックして上書きされる。分析を止めない)。
 * D1 の失敗は投げる(呼び出し側の `scrapeRace` が警告にして取得へフォールバックする)。
 */

import type { RaceIdVenueKind } from "../../packages/core/src/scraper/ids";
import type { StoredTrainerResults, TrainerResultsSaveEntry, TrainerResultsStore } from "../../packages/core/src/scraper/trainer-results-store";
import { decodeYears, encodeYears } from "./jockey-results-repository";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type TrainerResultsDb = Pick<D1Database, "prepare">;

/** 1 回の INSERT に入れる行数(1 行 4 変数 × 20 = 80 ≤ D1 のバインド変数の上限 100)。 */
export const TRAINER_SAVE_CHUNK = 20;

const SAVE_HEAD = "INSERT INTO trainer_results (trainer_id, kind, years_json, fetched_at) VALUES ";
const SAVE_TAIL = " ON CONFLICT (trainer_id, kind) DO UPDATE SET years_json = excluded.years_json, fetched_at = excluded.fetched_at";

export class D1TrainerResultsStore implements TrainerResultsStore {
  private readonly db: TrainerResultsDb;

  constructor(options: { readonly db: TrainerResultsDb }) {
    this.db = options.db;
  }

  async loadMany(trainerIds: readonly string[], kind: RaceIdVenueKind): Promise<ReadonlyMap<string, StoredTrainerResults>> {
    const out = new Map<string, StoredTrainerResults>();
    if (trainerIds.length === 0) {
      return out;
    }
    const placeholders = trainerIds.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(`SELECT trainer_id AS trainerId, years_json AS yearsJson, fetched_at AS fetchedAt FROM trainer_results WHERE kind = ? AND trainer_id IN (${placeholders})`)
      .bind(kind, ...trainerIds)
      .all<{ trainerId: string; yearsJson: string; fetchedAt: number }>();
    for (const row of results) {
      const years = decodeYears(row.yearsJson);
      if (years !== null && Number.isFinite(row.fetchedAt)) {
        out.set(row.trainerId, { fetchedAtMs: row.fetchedAt, years });
      }
    }
    return out;
  }

  async saveMany(kind: RaceIdVenueKind, entries: readonly TrainerResultsSaveEntry[]): Promise<void> {
    for (let i = 0; i < entries.length; i += TRAINER_SAVE_CHUNK) {
      const chunk = entries.slice(i, i + TRAINER_SAVE_CHUNK);
      const values = chunk.map(() => "(?, ?, ?, ?)").join(", ");
      const binds = chunk.flatMap((e) => [e.trainerId, kind, encodeYears(e.years), e.fetchedAtMs]);
      await this.db.prepare(`${SAVE_HEAD}${values}${SAVE_TAIL}`).bind(...binds).run();
    }
  }
}
