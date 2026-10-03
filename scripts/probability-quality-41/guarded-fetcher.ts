/**
 * 取得の安全装置(`docs/investigations/probability-quality-41/measurement-plan.md` §4)。
 * HTTP 400・403・429(ブロックの兆候)が**連続2回**で取得を止める(成功を返したら連続回数を0に戻す)。止めた後は内側の
 * フェッチャ(=ネットワーク)を叩かず、即座に `FetchHaltedError` を投げる。
 *
 * `scrapeRace` は馬ごとの戦績の例外を警告に握りつぶして次の馬へ進むため、`scrapeRace` の外側で
 * 例外を待つだけでは止められない。フェッチャを包んで数える。ブロックの兆候以外の失敗(404・5xx・ネットワーク)は
 * 数えないが、成功が無い限り連続回数も戻さない(400→500→400 は連続とみなす。止める側に倒す)。
 * `CachedFetcher` の外側に置くため、キャッシュ命中も「成功」に数えられる(本測定ではキャッシュ命中は
 * ほぼ起きない)。
 */

import type { CachedFetchTextOptions } from "../../packages/core/src/index.js";

/** 取得を止めたことを表す例外。レース単位の除外ではなく、取得全体の停止として扱う。 */
export class FetchHaltedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchHaltedError";
  }
}

/** 包まれるフェッチャの最小インターフェース(`CachedFetcher`・`RaceFetcher` が満たす)。 */
export interface TextFetcherLike {
  fetchText(url: string, options?: CachedFetchTextOptions): Promise<string>;
}

/** HTTP 400・403・429 が連続 `maxConsecutive` 回で止まるフェッチャ。 */
export class HaltOnConsecutiveBlockFetcher implements TextFetcherLike {
  private consecutive = 0;
  private halted = false;
  private requests = 0;
  private readonly urlsBlockedList: string[] = [];

  constructor(
    private readonly inner: TextFetcherLike,
    private readonly maxConsecutive: number = 2,
  ) {}

  /** 止まったか。 */
  get tripped(): boolean {
    return this.halted;
  }

  /** 現在のブロックの兆候の連続回数。 */
  get consecutiveBlocked(): number {
    return this.consecutive;
  }

  /** 内側へ渡した呼び出し回数(止まった後の拒否は数えない)。 */
  get requestCount(): number {
    return this.requests;
  }

  /** ブロックの兆候(400・403・429)を受けたURL(受けた順)。 */
  get urlsBlocked(): readonly string[] {
    return this.urlsBlockedList;
  }

  async fetchText(url: string, options?: CachedFetchTextOptions): Promise<string> {
    if (this.halted) {
      throw new FetchHaltedError(
        `HTTP 400・403・429 が連続${this.maxConsecutive}回に達したため取得を停止しています(${url} は要求していません)`,
      );
    }
    this.requests += 1;
    try {
      const text = await this.inner.fetchText(url, options);
      this.consecutive = 0;
      return text;
    } catch (error) {
      if (isBlockSignal(error)) {
        this.consecutive += 1;
        this.urlsBlockedList.push(url);
        if (this.consecutive >= this.maxConsecutive) {
          this.halted = true;
        }
      }
      throw error;
    }
  }
}

/** ブロックの兆候として数える HTTP ステータス(netkeiba への負荷を抑えるため 403・429 も数える)。 */
export const BLOCK_SIGNAL_STATUSES: readonly number[] = [400, 403, 429];

function isBlockSignal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && BLOCK_SIGNAL_STATUSES.includes(status);
}
