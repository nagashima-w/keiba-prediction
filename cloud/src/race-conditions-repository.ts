/**
 * レースの条件の D1 への保存(Issue #421 段階 1。migration 0022 の表 `race_conditions`)。
 *
 * 1 回の保存は D1 への問い合わせ 1 文(UPSERT)。**同じ値の再保存は行を書かない**: `ON CONFLICT DO UPDATE ... WHERE` が、種別か牝馬限定が既存の行と違うときだけ更新する
 * (朝の取得と発走前の取得が同じ値を 2 回書くので、`rows_written` を食わないようにする)。値が違えば最後の値で上書きする
 * (パーサを直したときに、直した値へ寄る。種別が読めなくなった場合は NULL に戻る=現在のパーサの結果がそのまま正)。
 * 失敗は投げる。**呼び出し側(RaceDay の取得ステップ)が握って警告にする**(分析は止めない)。
 */

import type { RaceConditionRecord, RaceConditionsStore } from "./race-conditions";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type RaceConditionsDb = Pick<D1Database, "prepare">;

const UPSERT_SQL =
  "INSERT INTO race_conditions (race_id, weight_type, fillies_only, saved_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT (race_id) DO UPDATE SET weight_type = excluded.weight_type, fillies_only = excluded.fillies_only, saved_at = excluded.saved_at " +
  "WHERE race_conditions.weight_type IS NOT excluded.weight_type OR race_conditions.fillies_only IS NOT excluded.fillies_only";

export class D1RaceConditionsStore implements RaceConditionsStore {
  private readonly db: RaceConditionsDb;

  constructor(options: { readonly db: RaceConditionsDb }) {
    this.db = options.db;
  }

  async save(record: RaceConditionRecord): Promise<void> {
    await this.db.prepare(UPSERT_SQL).bind(record.raceId, record.weightType, record.filliesOnly ? 1 : 0, record.savedAt).run();
  }
}
