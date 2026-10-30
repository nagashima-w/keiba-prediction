/**
 * 出馬表の調教師名と調教師 ID の組 `trainer_names` の D1 への書き込み(Issue #540。migration 0030)。
 *
 * 統計モデル用の書き出しの `trainer_id` を、調教師名から過去の分析にさかのぼって埋めるための材料。出馬表の調教師名は略した名前
 * (中央は「藤野」「和田雄」、地方はフルネーム)で、ほかの調教師名とは突き合わせられないので、出馬表どうしで対応を貯める。
 * 読み出し(ID がちょうど 1 つの名前だけを取る)は統計モデル用の書き出しのストア(`prior-export-store.ts` の `readLookups`)が行う。ここは書き込みだけ。
 *
 * ## 書き込み: {@link D1TrainerNamesStore.record}
 * 発走前の計算が、レースを分析するたびに 1 回呼ぶ(中央・地方とも)。**1 レースの全馬を SQL 1 文**(複数行の INSERT)で書く。
 *  - 同じ組は `ON CONFLICT DO NOTHING`。既にある組は行を書かない(`rows_written` を食わない)。`first_seen` は最初に書いた値が残る。
 *  - 同じ名前に別の ID、同じ ID に別の名前は、別の行として残る(書き出しが「ID が 2 つ以上の名前は埋めない」を判定するため)。
 *  - 束縛数は 3 × 組の数。D1 の 1 文あたり 100 個の上限に収まるよう {@link TRAINER_NAMES_CHUNK} 組ずつに分ける(1 レースは最大 18 頭なので、ふつうは 1 文)。
 *  - 失敗は投げる。**呼び出し側(発走前の計算)が握って警告にする**(分析は止めない)。
 */

/** D1 のうち使う部分(`D1Database` の構造的な部分集合)。 */
export type TrainerNamesDb = Pick<D1Database, "prepare">;

/** 調教師名と調教師 ID の組(どちらも空でない文字列)。 */
export interface TrainerNamePair {
  readonly trainerName: string;
  readonly trainerId: string;
}

/** 1 文に入れる組の数の上限。束縛数 = 3 × 組の数 が D1 の上限 100 に収まる大きさ。 */
export const TRAINER_NAMES_CHUNK = 30;

/** 書き込みの保存先(本番は {@link D1TrainerNamesStore})。 */
export interface TrainerNamesStore {
  /** 組を書く(既にある組は書かない)。`firstSeen` は開催日(YYYYMMDD)。失敗は投げる。 */
  record(pairs: readonly TrainerNamePair[], firstSeen: string): Promise<void>;
}

/** `n` 組を 1 文で書く SQL(テストが計画と動作を固定する)。 */
export function recordSql(n: number): string {
  return `INSERT INTO trainer_names (trainer_name, trainer_id, first_seen) VALUES ${Array.from({ length: n }, () => "(?, ?, ?)").join(", ")} ON CONFLICT DO NOTHING`;
}

/**
 * 出馬表の馬から書く組を集める。純関数。名前も ID も空でない文字列の馬だけ採り(調教師未定・リンクが無い馬は採らない)、同じ組は 1 つにまとめる(最初に現れた順)。
 * 名前は直さない(空白・全角・半角もそのまま。突き合わせは厳密な文字列一致)。
 */
export function collectTrainerPairs(horses: readonly { readonly trainerName: string; readonly trainerId: string | null }[]): TrainerNamePair[] {
  const seen = new Set<string>();
  const pairs: TrainerNamePair[] = [];
  for (const h of horses) {
    const id = h.trainerId;
    if (typeof h.trainerName !== "string" || h.trainerName === "" || typeof id !== "string" || id === "") {
      continue;
    }
    const key = JSON.stringify([h.trainerName, id]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pairs.push({ trainerName: h.trainerName, trainerId: id });
  }
  return pairs;
}

/** 組を {@link TRAINER_NAMES_CHUNK} 組ずつに分ける(順序を保つ)。 */
export function chunkPairs(pairs: readonly TrainerNamePair[]): TrainerNamePair[][] {
  const chunks: TrainerNamePair[][] = [];
  for (let i = 0; i < pairs.length; i += TRAINER_NAMES_CHUNK) {
    chunks.push(pairs.slice(i, i + TRAINER_NAMES_CHUNK));
  }
  return chunks;
}

export class D1TrainerNamesStore implements TrainerNamesStore {
  private readonly db: TrainerNamesDb;

  constructor(options: { readonly db: TrainerNamesDb }) {
    this.db = options.db;
  }

  async record(pairs: readonly TrainerNamePair[], firstSeen: string): Promise<void> {
    for (const chunk of chunkPairs(pairs)) {
      await this.db
        .prepare(recordSql(chunk.length))
        .bind(...chunk.flatMap((p) => [p.trainerName, p.trainerId, firstSeen]))
        .run();
    }
  }
}
