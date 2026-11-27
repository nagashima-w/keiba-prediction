/**
 * Durable Object の stub を作る唯一の入口（Issue #811）。
 *
 * すべての DO を、日本に近いアジア太平洋(`apac`)に置く希望(`locationHint`)を付けて作る。
 * DO は最初に作られた拠点に固定され、cron などの最初の呼び出し元の近く(米国・欧州)に作られていた。JRA への取得が海外の拠点から出ると、手前の防御に弾かれやすい疑いがある(#804)。
 * **希望であって保証ではない**。希望が効くのは新しく作られる DO だけで、既にある DO の場所は変わらない。
 * `cloud/src` で DO の名前空間に `.get(` を直接呼ぶ箇所をこの関数の外に作らない(`cloud/test/do-stub.test.ts` が wrangler.toml の binding 名から検査する)。
 */

/** DO の stub を作るときに渡す場所の希望。 */
export interface DoGetOptions {
  readonly locationHint?: "apac";
}

/** 名前空間の、使う部分だけの型（Workers の `DurableObjectNamespace` の部分集合。`get` は第 2 引数を受けなくてもよい）。 */
export interface DoNamespaceLike<S> {
  idFromName(name: string): any;
  get(id: any, options?: DoGetOptions): S;
}

/** DO の場所の希望(apac)。 */
export const DO_LOCATION_HINT = "apac" as const;

/** 名前から DO の stub を引く(場所の希望 apac 付き)。 */
export function doStub<S>(ns: DoNamespaceLike<S>, name: string): S {
  return ns.get(ns.idFromName(name), { locationHint: DO_LOCATION_HINT });
}
