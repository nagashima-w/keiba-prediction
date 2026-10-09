/**
 * クラウド移行ファイルの書き出し元の実装(Issue #215・#167-A。better-sqlite3 に依存する側)。
 *
 * `cloud-migration-lines.ts` の {@link CloudMigrationSource} を、exe の SQLite(AnalysisStore と同じ接続)に対して実装する。
 *
 * - **キーセット・ページング**(`WHERE id > ? ORDER BY id LIMIT n`・race_id も同様)。OFFSET は使わない。
 * - **`.all()` で読み切る。`.iterate()` は使わない**: better-sqlite3 は iterate の途中で同じ接続に別の文を発行すると
 *   「connection is busy」になる。書き出しは await をまたいで進むので、その間に他の IPC(分析の保存など)が走る。
 * - **`SELECT *` ではなく、定義表({@link MIGRATION_TABLES})の列を明示して SELECT する**。長い期間の migration を経た
 *   実 DB に定義表に無い古い列が残っていても、書き出す行は常に形式に合う。
 * - 1 ページ(分析なら親+子 3 表、結果なら 4 表)は await をはさまず同期で読むので、ページ内は整合している。
 */

import type Database from "better-sqlite3";

import { MIGRATION_TABLES, type MigrationRow, type MigrationTableName } from "./cloud-migration-format.js";
import type {
  CloudMigrationSource,
  MigrationAnalysisPageItem,
  MigrationResultPageItem,
} from "./cloud-migration-lines.js";

/** 列を明示した SELECT 句。 */
function columnList(table: MigrationTableName): string {
  return MIGRATION_TABLES[table].columns.map((c) => c.name).join(", ");
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** 行を owner(親のキー)ごとにまとめる。 */
function groupBy<K extends string | number>(
  rows: readonly MigrationRow[],
  column: string,
): Map<K, MigrationRow[]> {
  const map = new Map<K, MigrationRow[]>();
  for (const row of rows) {
    const key = row[column] as K;
    const list = map.get(key);
    if (list === undefined) {
      map.set(key, [row]);
    } else {
      list.push(row);
    }
  }
  return map;
}

/** 実 DB から書き出し元を作る。 */
export function createCloudMigrationSource(db: Database.Database): CloudMigrationSource {
  return {
    readAnalysisPage(afterId: number, limit: number): readonly MigrationAnalysisPageItem[] {
      const analyses = db
        .prepare(`SELECT ${columnList("analyses")} FROM analyses WHERE id > ? ORDER BY id LIMIT ?`)
        .all(afterId, limit) as MigrationRow[];
      if (analyses.length === 0) {
        return [];
      }
      const ids = analyses.map((a) => a["id"] as number);
      const marks = placeholders(ids.length);
      const horses = groupBy<number>(
        db
          .prepare(
            `SELECT ${columnList("analysis_horses")} FROM analysis_horses WHERE analysis_id IN (${marks}) ORDER BY analysis_id, umaban`,
          )
          .all(...ids) as MigrationRow[],
        "analysis_id",
      );
      const bets = groupBy<number>(
        db
          .prepare(
            `SELECT ${columnList("analysis_bets")} FROM analysis_bets WHERE analysis_id IN (${marks}) ORDER BY analysis_id, bet_type, combo_key`,
          )
          .all(...ids) as MigrationRow[],
        "analysis_id",
      );
      const metas = new Map<number, MigrationRow>(
        (
          db
            .prepare(
              `SELECT ${columnList("analysis_allocation_meta")} FROM analysis_allocation_meta WHERE analysis_id IN (${marks})`,
            )
            .all(...ids) as MigrationRow[]
        ).map((m) => [m["analysis_id"] as number, m]),
      );
      return analyses.map((analysis) => {
        const id = analysis["id"] as number;
        return {
          analysis,
          horses: horses.get(id) ?? [],
          bets: bets.get(id) ?? [],
          allocationMeta: metas.get(id) ?? null,
        };
      });
    },

    readResultPage(afterRaceId: string, limit: number): readonly MigrationResultPageItem[] {
      // 4 表のどれかに現れる race_id の和集合(昇順)。結果の行・メタ・組合せ払戻・取込記録のどれか 1 つだけに現れるレースも落とさない。
      const raceIds = (
        db
          .prepare(
            `SELECT race_id FROM (
               SELECT race_id FROM race_results WHERE race_id > ?
               UNION SELECT race_id FROM race_result_meta WHERE race_id > ?
               UNION SELECT race_id FROM race_combo_payouts WHERE race_id > ?
               UNION SELECT race_id FROM race_combo_payout_imports WHERE race_id > ?
             ) ORDER BY race_id LIMIT ?`,
          )
          .all(afterRaceId, afterRaceId, afterRaceId, afterRaceId, limit) as Array<{ race_id: string }>
      ).map((r) => r.race_id);
      if (raceIds.length === 0) {
        return [];
      }
      const marks = placeholders(raceIds.length);
      const results = groupBy<string>(
        db
          .prepare(
            `SELECT ${columnList("race_results")} FROM race_results WHERE race_id IN (${marks}) ORDER BY race_id, umaban`,
          )
          .all(...raceIds) as MigrationRow[],
        "race_id",
      );
      const metas = new Map<string, MigrationRow>(
        (
          db
            .prepare(`SELECT ${columnList("race_result_meta")} FROM race_result_meta WHERE race_id IN (${marks})`)
            .all(...raceIds) as MigrationRow[]
        ).map((m) => [m["race_id"] as string, m]),
      );
      const payouts = groupBy<string>(
        db
          .prepare(
            `SELECT ${columnList("race_combo_payouts")} FROM race_combo_payouts WHERE race_id IN (${marks}) ORDER BY race_id, bet_type, combo_key`,
          )
          .all(...raceIds) as MigrationRow[],
        "race_id",
      );
      const imports = groupBy<string>(
        db
          .prepare(
            `SELECT ${columnList("race_combo_payout_imports")} FROM race_combo_payout_imports WHERE race_id IN (${marks}) ORDER BY race_id, bet_type`,
          )
          .all(...raceIds) as MigrationRow[],
        "race_id",
      );
      return raceIds.map((raceId) => ({
        raceId,
        results: results.get(raceId) ?? [],
        meta: metas.get(raceId) ?? null,
        comboPayouts: payouts.get(raceId) ?? [],
        comboPayoutImports: imports.get(raceId) ?? [],
      }));
    },
  };
}
