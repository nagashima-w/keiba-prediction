/**
 * #156(#41-B)重賞の過去結果(`AplGradeWinner`)の応答の記録・再生フェッチャ。
 *
 * - 記録が `<dir>/<raceId>.json` にあれば、ネットワークを使わずそれを返す(再生)。
 * - 記録が無く `network` があれば、取得して**生の応答本文を保存**してから返す(記録)。
 *   取得に失敗したときは何も保存しない。
 * - `network: null` は再生専用(段階3。記録が無ければネットワークに出ずに失敗する)。
 *
 * 要約値ではなく生の応答を保存するのは、`collectGradeWinnerTrend`(cutoff の除外ロジックを含む
 * production と同じ関数)を段階1・段階3の両方で本物のまま通すため。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GradeWinnerFetcher } from "../../packages/core/src/index.js";

export interface RecordedGradeFetcherOptions {
  /** 記録の保存先ディレクトリ。 */
  readonly dir: string;
  readonly raceId: string;
  /** ネットワーク取得(記録用)。null なら再生専用。 */
  readonly network: GradeWinnerFetcher | null;
}

export function createRecordedGradeFetcher(options: RecordedGradeFetcherOptions): GradeWinnerFetcher {
  const file = path.join(options.dir, `${options.raceId}.json`);
  return {
    fetchText: async (url, fetchOptions) => {
      if (existsSync(file)) {
        return readFileSync(file, "utf-8");
      }
      if (options.network === null) {
        throw new Error(`重賞の過去結果の記録がありません(${file})。段階1で取得してください`);
      }
      const body = await options.network.fetchText(url, fetchOptions);
      mkdirSync(options.dir, { recursive: true });
      writeFileSync(file, body, "utf-8");
      return body;
    },
  };
}
