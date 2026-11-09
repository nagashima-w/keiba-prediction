/**
 * RaceDayDO が使う JRA の取得口の組み立て(Issue #680)。**馬場とオッズの取得口に、同じ間隔の部品(pacer。{@link createJraPacer})を渡す**。
 * 馬場の段とオッズの段が重なっても、JRA への送信の間隔は 1.5 秒({@link JRA_GAP_MS})を下回らない。
 * DO のラッパから切り出したのは、この共有が外れたときにテストで気づけるようにするため(`jra-fetchers.test.ts`)。
 * 出馬表の取得口(`createJraEntriesFetcher`)は共有しない(朝の別の時間帯で、動きを変えない)。
 */
import type { BabaFetcher } from "./baba-conditions";
import { createJraBabaFetcher, type CreateJraBabaFetcherDeps } from "./jra-baba-fetch";
import { createJraOddsFetcher, createJraPacer, type JraOddsFetcher, type JraPacer } from "./jra-odds-fetch";

export interface CreateJraFetchersDeps {
  /** JRA のオッズの取得を使うか(`var JRA_ODDS_ENABLED` が "0" でないとき true)。false なら `fetchJraOdds` は無い(今までの動き)。 */
  readonly oddsEnabled: boolean;
  /** 共有する間隔の部品。省略時はここで 1 つ作る(本番)。テストで差し替える。 */
  readonly pacer?: JraPacer;
  /** テスト用: 送信に使う fetch。省略時はグローバルの `fetch`。 */
  readonly fetch?: CreateJraBabaFetcherDeps["fetch"];
  /** テスト用: 間隔の待ち(省略時は `setTimeout`)。 */
  readonly wait?: (ms: number) => Promise<void>;
}

export interface JraFetchers {
  readonly fetchBaba: BabaFetcher;
  readonly fetchJraOdds?: JraOddsFetcher;
}

export function createJraFetchers(deps: CreateJraFetchersDeps): JraFetchers {
  const waitDep = deps.wait === undefined ? {} : { wait: deps.wait };
  const fetchDep = deps.fetch === undefined ? {} : { fetch: deps.fetch };
  const pacer = deps.pacer ?? createJraPacer(waitDep);
  return {
    fetchBaba: createJraBabaFetcher({ ...fetchDep, ...waitDep, pacer }),
    ...(deps.oddsEnabled ? { fetchJraOdds: createJraOddsFetcher({ ...fetchDep, ...waitDep, pacer }) } : {}),
  };
}
