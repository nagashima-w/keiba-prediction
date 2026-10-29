/**
 * 出馬表の騎手名と騎手 ID の組 `jockey_names` の D1 への書き込み(Issue #526 段階 1b。migration 0028)。
 *
 * 統計モデル用の書き出しの `jockey_id` を、騎手名から過去の分析にさかのぼって埋めるための材料。出馬表の騎手名は略した名前
 * (中央は「戸崎圭」、地方はフルネーム)で、戦績の騎手名(フルネーム)とは突き合わせられないので、出馬表どうしで対応を貯める。
 * 読み出し(ID がちょうど 1 つの名前だけを取る)は統計モデル用の書き出しのストア(`prior-export-store.ts` の `readLookups`)が行う。ここは書き込みだけ。
 *
 * ## 書き込み: {@link D1JockeyNamesStore.record}
 * 発走前の計算が、レースを分析するたびに 1 回呼ぶ(中央・地方とも)。**1 レースの全馬を SQL 1 文**(複数行の INSERT)で書く。
 *  - 同じ組は `ON CONFLICT DO NOTHING`。既にある組は行を書かない(`rows_written` を食わない)。`first_seen` は最初に書いた値が残る。
 *  - 同じ名前に別の ID、同じ ID に別の名前は、別の行として残る(書き出しが「ID が 2 つ以上の名前は埋めない」を判定するため)。
 *  - 束縛数は 3 × 組の数。D1 の 1 文あたり 100 個の上限に収まるよう {@link JOCKEY_NAMES_CHUNK} 組ずつに分ける(1 レースは最大 18 頭なので、ふつうは 1 文)。
 *  - 失敗は投げる。**呼び出し側(発走前の計算)が握って警告にする**(分析は止めない)。
 */

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type JockeyNamesDb = Pick<D1Database, "prepare">;

/** 騎手名と騎手 ID の組(どちらも空でない文字列)。 */
export interface JockeyNamePair {
  readonly jockeyName: string;
  readonly jockeyId: string;
}

/** 1 文に入れる組の数の上限。束縛数 = 3 × 組の数 が D1 の上限 100 に収まる大きさ。 */
export const JOCKEY_NAMES_CHUNK = 30;

/** 書き込みの保存先(本番は {@link D1JockeyNamesStore})。 */
export interface JockeyNamesStore {
  /** 組を書く(既にある組は書かない)。`firstSeen` は開催日(YYYYMMDD)。失敗は投げる。 */
  record(pairs: readonly JockeyNamePair[], firstSeen: string): Promise<void>;
}

/** `n` 組を 1 文で書く SQL(テストが計画と動作を固定する)。 */
export function recordSql(n: number): string {
  return `INSERT INTO jockey_names (jockey_name, jockey_id, first_seen) VALUES ${Array.from({ length: n }, () => "(?, ?, ?)").join(", ")} ON CONFLICT DO NOTHING`;
}

/**
 * 出馬表の馬から書く組を集める。純関数。名前も ID も空でない文字列の馬だけ採り(騎手未定・リンクが無い馬は採らない)、同じ組は 1 つにまとめる(最初に現れた順)。
 * 名前は直さない(空白・全角・半角もそのまま。突き合わせは厳密な文字列一致)。
 */
export function collectJockeyPairs(horses: readonly { readonly jockeyName: string; readonly jockeyId: string | null }[]): JockeyNamePair[] {
  const seen = new Set<string>();
  const pairs: JockeyNamePair[] = [];
  for (const h of horses) {
    const id = h.jockeyId;
    if (typeof h.jockeyName !== "string" || h.jockeyName === "" || typeof id !== "string" || id === "") {
      continue;
    }
    const key = JSON.stringify([h.jockeyName, id]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pairs.push({ jockeyName: h.jockeyName, jockeyId: id });
  }
  return pairs;
}

/** 組を {@link JOCKEY_NAMES_CHUNK} 組ずつに分ける(順序を保つ)。 */
export function chunkPairs(pairs: readonly JockeyNamePair[]): JockeyNamePair[][] {
  const chunks: JockeyNamePair[][] = [];
  for (let i = 0; i < pairs.length; i += JOCKEY_NAMES_CHUNK) {
    chunks.push(pairs.slice(i, i + JOCKEY_NAMES_CHUNK));
  }
  return chunks;
}

export class D1JockeyNamesStore implements JockeyNamesStore {
  private readonly db: JockeyNamesDb;

  constructor(options: { readonly db: JockeyNamesDb }) {
    this.db = options.db;
  }

  async record(pairs: readonly JockeyNamePair[], firstSeen: string): Promise<void> {
    for (const chunk of chunkPairs(pairs)) {
      await this.db
        .prepare(recordSql(chunk.length))
        .bind(...chunk.flatMap((p) => [p.jockeyName, p.jockeyId, firstSeen]))
        .run();
    }
  }
}
