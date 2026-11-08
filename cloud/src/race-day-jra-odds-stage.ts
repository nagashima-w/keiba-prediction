/**
 * JRA のオッズの段階の 1 起床ぶんの処理(Issue #675。#668-D)。`RaceDayCore.runJraOddsStep` が呼ぶ。進み具合の表と頁の分け方は `race-day-jra-odds.ts`、
 * 頁のパースと JSON・差し込み口は `jra-odds-cache.ts`。
 *
 * ## 流れ
 * 1. 次に取る頁(三連単以外をまとめて、残りが三連単だけなら三連単だけ)を表から決める。
 * 2. 場・レースのリンク(cname)を取得キャッシュから読む(raceId・日付・式別が合っているものだけ使う)。無ければ開催選択 → レース選択をたどって拾い、
 *    **その場の全レースのリンクをキャッシュに置く**(同じ場の次のレースは、発見の 2 本を省ける)。
 * 3. 頁を 1 本ずつ取り、その場でパースして JSON を取得キャッシュに置く(生の HTML は置かない)。頁が `param-error`(検査値が古い)なら、たどり直しは**段全体で 1 回だけ**行って取り直す。
 * 4. 結果(done・failed)は頁ごとに、次の頁を取る前に表へ書く。
 *
 * ## 失敗は全部握る(例外を投げない。分析を止めない)
 * 失敗した頁は failed(その券種は netkeiba のまま)。開催選択・レース選択の失敗は残りの頁を全部 failed にする(三連単の起床も無くなる)。警告は**固定の語だけ**(URL・cname・本文・例外の文面は出さない)。
 * 所要時間と本数は `onInfo` に固定の語で残す(公開後に本番で見る)。
 */
import type { ComboBetType } from "../../packages/core/src/scraper/combo-odds-key";
import { JRA_ODDS_PAGES, parseJraOddsCname, type JraOddsPage, type JraOddsRaceLinks } from "../../packages/core/src/scraper/parse-jra-odds-index";
import type { JraOddsFailure, JraOddsFetcher, JraOddsSession } from "./jra-odds-fetch";
import { JRA_PAGE_FOR_BET, jraLinksCacheKey, jraOddsCacheKey, parseJraOddsPage } from "./jra-odds-cache";
import type { JraOddsStagePort } from "./race-day-jra-odds";

/** 取得キャッシュのうち使う部分。 */
export interface JraOddsStageCache {
  get(key: string): { readonly value: string; readonly fetchedAt: number } | undefined;
  set(key: string, value: string): void;
}

export interface JraOddsStageDeps {
  readonly store: JraOddsStagePort;
  readonly fetcher: JraOddsFetcher;
  readonly cache: JraOddsStageCache;
  readonly now: () => number;
  readonly onWarn: (message: string) => void;
  readonly onInfo?: (message: string) => void;
}

const BET_FOR_PAGE: Partial<Record<JraOddsPage, ComboBetType>> = Object.fromEntries(
  (Object.entries(JRA_PAGE_FOR_BET) as [ComboBetType, JraOddsPage][]).map(([bet, page]) => [page, bet]),
);

/** 警告に出してよい語(失敗の語と段の語。それ以外は unknown に丸める)。 */
const safeWord = (word: string): string => (/^[a-z0-9-]{1,40}$/.test(word) ? word : "unknown");

/** リンクがそのレース・その日のものか(式別ごとの cname を分解して、raceId・日付・式別が合っているか)。 */
export function linksMatch(value: unknown, raceId: string, date: string): value is JraOddsRaceLinks {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const links = value as { raceId?: unknown; cnames?: unknown };
  if (links.raceId !== raceId || typeof links.cnames !== "object" || links.cnames === null) {
    return false;
  }
  const cnames = links.cnames as Record<string, unknown>;
  return JRA_ODDS_PAGES.every((page) => {
    const cname = cnames[page];
    if (typeof cname !== "string") {
      return false;
    }
    const parsed = parseJraOddsCname(cname);
    return parsed !== null && parsed.raceId === raceId && parsed.date === date && parsed.page === page;
  });
}

const toIsoDate = (yyyymmdd: string): string => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/** `run` の追加の指定。 */
export interface JraOddsRunOptions {
  /**
   * 時間の守り(Issue #676。締切の再計算が渡す)。**開催選択・レース選択・各頁を送る前に** `now >= stopAt` なら、それ以降は送らず、残りの頁を failed にする(警告の語は `deadline`)。
   * 省略時は守りなし(発走前の分析の段は渡さない)。
   */
  readonly stopAt?: number;
}

export class JraOddsStage {
  constructor(private readonly deps: JraOddsStageDeps) {}

  /** 1 本の頁を「取る → パース → JSON を置く」まで行い、結果の語だけを返す。生の HTML・パースの木・JSON はこの関数の外へ出ない(戻ったら参照が切れる。1 頁ずつ処理するための境界)。 */
  private async fetchAndStore(
    session: JraOddsSession,
    raceId: string,
    page: JraOddsPage,
    cname: string,
    date: string,
  ): Promise<{ readonly status: "ok" } | { readonly status: "fetch-failed"; readonly word: string } | { readonly status: "parse-failed"; readonly word: string }> {
    const result = await session.fetchOdds(cname);
    if (result.status !== "ok") {
      return { status: "fetch-failed", word: result.status };
    }
    const parsed = parseJraOddsPage(page, result.value, toIsoDate(date), BET_FOR_PAGE[page]);
    if (parsed.status !== "ok") {
      return { status: "parse-failed", word: parsed.status };
    }
    this.deps.cache.set(jraOddsCacheKey(raceId, page), parsed.json);
    return { status: "ok" };
  }

  /** 1 起床ぶん。`date` は開催日 YYYYMMDD。例外を投げない。 */
  async run(raceId: string, instance: number, date: string, options: JraOddsRunOptions = {}): Promise<void> {
    const { store, cache } = this.deps;
    const startedAt = this.deps.now();
    const batch = store.nextBatch(raceId, instance);
    if (batch.length === 0) {
      return;
    }
    const pastStop = (): boolean => options.stopAt !== undefined && this.deps.now() >= options.stopAt;
    let sent = 0;
    try {
      const session = this.deps.fetcher.open();
      const readLinks = (): JraOddsRaceLinks | null => {
        try {
          const entry = cache.get(jraLinksCacheKey(raceId));
          const parsed: unknown = entry === undefined ? null : JSON.parse(entry.value);
          return linksMatch(parsed, raceId, date) ? parsed : null;
        } catch {
          return null;
        }
      };
      /** 開催選択 → レース選択をたどり、場の全レースのリンクを置く。失敗の語か、このレースのリンクを返す。 */
      const discover = async (): Promise<{ readonly links: JraOddsRaceLinks } | { readonly failure: JraOddsFailure }> => {
        const venues = await session.listVenues(date);
        if (venues.status !== "ok") {
          return { failure: venues.status };
        }
        const venue = venues.value.find((v) => v.venueCode === raceId.slice(4, 6));
        if (venue === undefined) {
          return { failure: "not-found" };
        }
        const races = await session.listRaces(venue);
        if (races.status !== "ok") {
          return { failure: races.status };
        }
        let mine: JraOddsRaceLinks | null = null;
        for (const links of races.value) {
          if (!linksMatch(links, links.raceId, date)) {
            continue; // 日付・式別が合わないリンクは置かない
          }
          cache.set(jraLinksCacheKey(links.raceId), JSON.stringify(links));
          if (links.raceId === raceId) {
            mine = links;
          }
        }
        return mine === null ? { failure: "not-found" } : { links: mine };
      };

      let links = readLinks();
      let rediscovered = false;
      if (links === null) {
        if (pastStop()) {
          this.failAll(raceId, instance, "deadline");
          this.info(raceId, batch.length, 0, batch.length, session.requestCount, startedAt);
          return;
        }
        const found = await discover();
        if ("failure" in found) {
          sent = session.requestCount;
          this.failAll(raceId, instance, found.failure);
          this.info(raceId, batch.length, 0, batch.length, sent, startedAt);
          return;
        }
        links = found.links;
      }

      let ok = 0;
      let failed = 0;
      for (const page of batch) {
        if (pastStop()) {
          // 残りの頁は送らない(その券種は netkeiba のまま)。この頁以降をまとめて failed にする。
          const rest = batch.length - ok - failed;
          this.failAll(raceId, instance, "deadline");
          failed += rest;
          break;
        }
        let result = await this.fetchAndStore(session, raceId, page, links.cnames[page], date);
        if (result.status === "fetch-failed" && result.word === "param-error" && !rediscovered) {
          rediscovered = true; // たどり直しは段全体で 1 回だけ
          const found = await discover();
          if ("failure" in found) {
            result = { status: "fetch-failed", word: found.failure };
          } else {
            links = found.links;
            result = await this.fetchAndStore(session, raceId, page, links.cnames[page], date);
          }
        }
        if (result.status === "fetch-failed") {
          store.mark(raceId, instance, page, "failed");
          failed += 1;
          this.deps.onWarn(`JRA オッズの取得に失敗しました(${raceId}。頁 ${page}): ${safeWord(result.word)}`);
          continue;
        }
        if (result.status === "parse-failed") {
          store.mark(raceId, instance, page, "failed");
          failed += 1;
          this.deps.onWarn(`JRA オッズの読み取りに失敗しました(${raceId}。頁 ${page}): ${result.word}`);
          continue;
        }
        store.mark(raceId, instance, page, "done");
        ok += 1;
      }
      sent = session.requestCount;
      this.info(raceId, batch.length, ok, failed, sent, startedAt);
    } catch {
      // 取得口・キャッシュ・表の例外。文面は残さない(URL・cname が入りうる)。残りは failed にして計算に進む。
      this.failAll(raceId, instance, "exception");
      this.info(raceId, batch.length, 0, batch.length, sent, startedAt);
    }
  }

  private failAll(raceId: string, instance: number, word: string): void {
    let dropped = 0;
    try {
      dropped = this.deps.store.failAllPending(raceId, instance);
    } catch {
      // 表に書けなくても分析は止めない(次の起床で同じ頁を取り直すだけ)
    }
    this.deps.onWarn(`JRA オッズの取得を打ち切りました(${raceId}。残り ${dropped} 頁は netkeiba のまま): ${safeWord(word)}`);
  }

  private info(raceId: string, pages: number, ok: number, failed: number, sent: number, startedAt: number): void {
    this.deps.onInfo?.(`JRA オッズの段(${raceId}): 頁 ${pages} 本(成功 ${ok}・失敗 ${failed})・送信 ${sent} 本・${this.deps.now() - startedAt}ms`);
  }
}
