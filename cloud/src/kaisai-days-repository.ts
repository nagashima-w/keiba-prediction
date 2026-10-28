/**
 * 開催日ごとの記録 `kaisai_days` の D1 への書き込みと読み出し(Issue #519。migration 0027)。
 *
 * 芝の開催進行(プロンプトの「芝コースの開催進行」の行)に、連続開催の通算の日数と、いまの柵になってから何日目かを足すための材料。
 * 数え方は core の `analyzer/turf-wear.ts`(`assessTurfWear`)。ここは行の読み書きだけで、数えない。
 *
 * ## 書き込み: {@link D1KaisaiDaysStore.record}
 * 発走前の計算が、中央のレースを分析するたびに 1 回呼ぶ(同じ日・同じ場のレースが何十回呼んでも、行は 1 つ)。**SQL 1 文**(UPSERT)。
 *  - 行が無ければ作る。**既にあれば何も書かない**: `kaisai_date` は最初に書いた値を保ち、`fence` は既存が NULL で新しい値が NULL でないときだけ埋める
 *    (`ON CONFLICT DO UPDATE ... WHERE`。既に入っている柵は上書きしない・消さない)。完全な行・埋めるもののない呼び出しは行を書かない(`rows_written` を食わない)。
 *  - 失敗は投げる。**呼び出し側(発走前の計算)が握って警告にする**(分析は止めない)。
 *
 * ## 読み出し: {@link D1KaisaiDaysStore.load}
 * 開催日より前の、その場の行を返す(**SELECT 1 文**)。今日の行は読まない(今日の回・日次はレース ID、今日の柵は出馬表から取る)。
 * 範囲は **「開催年とその前の年」**で切り、日数の窓では切らない:
 * 連続の判定は「前の回の全日がそろっている」ことを確かめるので、窓で切ると、間隔の長い回(例: 3回東京 6/21 → 4回東京 10/3 は 104 日あき、3回の初日 5/30 は 10/3 の 126 日前)で
 * 前の回の初日が窓の外に出て、判定できなくなる。1 つの場で年に 30〜40 行なので、2 年分でも 100 行に満たない。
 * 絞り込みは主キーの先頭(場コード・年)で行い、開催日の比較だけが行ごとの条件になる(副索引は無い)。失敗は投げる(呼び出し側が握って値なしで続ける)。
 */

import type { KaisaiDayRow } from "../../packages/core/src/analyzer/turf-wear";

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type KaisaiDaysDb = Pick<D1Database, "prepare">;

/** 開催日ごとの記録の保存先・読み出し口(本番は {@link D1KaisaiDaysStore})。 */
export interface KaisaiDaysStore {
  /** 1 日分の行を書く(柵は先着。既存の非 NULL の柵は上書きしない)。失敗は投げる。 */
  record(row: KaisaiDayRow): Promise<void>;
  /** 開催日より前の、その場の行(開催年とその前の年)。失敗は投げる。 */
  load(trackCode: string, kaisaiDate: string): Promise<readonly KaisaiDayRow[]>;
}

/** 書き込みの SQL(テストが計画と動作を固定する)。 */
export const RECORD_SQL =
  "INSERT INTO kaisai_days (track_code, year, kai, nichi, kaisai_date, fence) VALUES (?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT (track_code, year, kai, nichi) DO UPDATE SET fence = excluded.fence " +
  "WHERE kaisai_days.fence IS NULL AND excluded.fence IS NOT NULL";

/** 読み出しの SQL(テストが主キーでの絞り込みを計画で固定する)。 */
export const LOAD_SQL =
  "SELECT track_code, year, kai, nichi, kaisai_date, fence FROM kaisai_days WHERE track_code = ? AND year >= ? AND kaisai_date < ?";

export class D1KaisaiDaysStore implements KaisaiDaysStore {
  private readonly db: KaisaiDaysDb;

  constructor(options: { readonly db: KaisaiDaysDb }) {
    this.db = options.db;
  }

  async record(row: KaisaiDayRow): Promise<void> {
    await this.db.prepare(RECORD_SQL).bind(row.trackCode, row.year, row.kai, row.nichi, row.kaisaiDate, row.fence).run();
  }

  async load(trackCode: string, kaisaiDate: string): Promise<readonly KaisaiDayRow[]> {
    const year = Number(kaisaiDate.slice(0, 4));
    const { results } = await this.db.prepare(LOAD_SQL).bind(trackCode, year - 1, kaisaiDate).all<Record<string, unknown>>();
    return results.map((r) => ({
      trackCode: String(r["track_code"]),
      year: Number(r["year"]),
      kai: Number(r["kai"]),
      nichi: Number(r["nichi"]),
      kaisaiDate: String(r["kaisai_date"]),
      fence: typeof r["fence"] === "string" ? r["fence"] : null,
    }));
  }
}
