/**
 * `undici` の差し替え用スタブ(Issue #162 段階2。#159 のスパイクで作ったものを本番用に写した)。
 *
 * core の `http-client.ts` は、fetch が注入されないときのために `import("undici")` を動的に書いている。
 * バンドラは動的 import の文字列リテラルも解決して巨大な undici を取り込んでしまうため、wrangler.toml の
 * `[alias]`・tsconfig の `paths`・vitest の `alias` でこのスタブに差し替える。本番では必ず `createGateFetch`(DO の `fetchRaw` を呼ぶ fetch)を注入するので、
 * ここに到達したら設定ミス(例外で気づく)。cheerio も fromURL 用に undici を import するが、
 * fromURL は使わない。
 */

export interface Dispatcher {
  readonly stub: true;
}

export class EnvHttpProxyAgent implements Dispatcher {
  readonly stub = true as const;
}

export function fetch(_url?: unknown, _init?: unknown): never {
  throw new Error("undici はクラウド版の Worker では使えません(createGateFetch を注入してください)");
}
