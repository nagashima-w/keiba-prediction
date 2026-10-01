/**
 * 取得の安全装置(`docs/investigations/probability-quality-41/measurement-plan.md` §4)。
 * HTTP 400 が**連続2回**で取得を止める(成功を返したら連続回数を0に戻す)。止めた後は内側の
 * フェッチャ(=ネットワーク)を叩かず、即座に `FetchHaltedError` を投げる。
 *
 * `scrapeRace` は馬ごとの戦績の例外を警告に握りつぶして次の馬へ進むため、`scrapeRace` の外側で
 * 例外を待つだけでは止められない。フェッチャを包んで数える。400 以外の失敗(5xx・ネットワーク)は
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

/** HTTP 400 が連続 `maxConsecutive` 回で止まるフェッチャ。 */
export class HaltOnConsecutive400Fetcher implements TextFetcherLike {
  private consecutive = 0;
  private halted = false;
  private requests = 0;
  private readonly urls400: string[] = [];

  constructor(
    private readonly inner: TextFetcherLike,
    private readonly maxConsecutive: number = 2,
  ) {}

  /** 止まったか。 */
  get tripped(): boolean {
    return this.halted;
  }

  /** 現在の400の連続回数。 */
  get consecutive400(): number {
    return this.consecutive;
  }

  /** 内側へ渡した呼び出し回数(止まった後の拒否は数えない)。 */
  get requestCount(): number {
    return this.requests;
  }

  /** 400 を受けたURL(受けた順)。 */
  get urlsWith400(): readonly string[] {
    return this.urls400;
  }

  async fetchText(url: string, options?: CachedFetchTextOptions): Promise<string> {
    if (this.halted) {
      throw new FetchHaltedError(
        `HTTP 400 が連続${this.maxConsecutive}回に達したため取得を停止しています(${url} は要求していません)`,
      );
    }
    this.requests += 1;
    try {
      const text = await this.inner.fetchText(url, options);
      this.consecutive = 0;
      return text;
    } catch (error) {
      if (isHttp400(error)) {
        this.consecutive += 1;
        this.urls400.push(url);
        if (this.consecutive >= this.maxConsecutive) {
          this.halted = true;
        }
      }
      throw error;
    }
  }
}

function isHttp400(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 400
  );
}
