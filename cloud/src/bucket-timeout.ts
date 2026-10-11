/**
 * R2 の `put` に上限時間を設ける(Issue #178〈#164-c〉。#175 の申し送り: put そのものには上限時間が無く、ストアが再試行するのは例外が出たときだけ)。
 * 上限を超えた put は例外にする(ストアが再試行し〈`DETAIL_PUT_RETRIES`〉、それでも駄目なら `detail: "failed"` で要約だけを残す)。
 * 超えた put が、あとから実際には完了することはありうる(同じキーに書き直すので、結果は同じ内容)。`get` は包まずに通す。
 */
import type { AnalysisBucket } from "./analysis-repository";

export function withPutTimeout(bucket: AnalysisBucket, timeoutMs: number): AnalysisBucket {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`上限時間は正の整数(ミリ秒)で指定してください(渡された値: ${String(timeoutMs)})`);
  }
  return {
    get: (...args: Parameters<AnalysisBucket["get"]>) => bucket.get(...args),
    put: (...args: Parameters<AnalysisBucket["put"]>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`R2 の put がタイムアウトしました(${timeoutMs}ms)`)), timeoutMs);
      });
      return Promise.race([bucket.put(...args), timeout]).finally(() => {
        clearTimeout(timer);
      }) as ReturnType<AnalysisBucket["put"]>;
    },
  };
}
