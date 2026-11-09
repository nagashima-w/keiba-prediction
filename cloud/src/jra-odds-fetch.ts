/**
 * JRA のオッズの頁を 1 本ずつ取る取得口(Issue #673 段階 A。#668-C)。後続の段階(発走前の分析 #675・締切の再計算 #676)が使う。この段階ではどこにも配線しない。
 *
 * ## 取る本(入口は `accessO.html` の 1 つ。見本の記録は `docs/jra-odds-investigation.md`)
 *  1. 開催の選択 `POST accessO.html`(本文 `cname=pw15oli00/6D`。固定)→ 場ごとのレースの選択の cname
 *  2. レースの選択 `POST accessO.html`(本文 `cname=<1 で読んだもの>`)→ その場・日の全レースの、式別ごとのオッズの頁の cname
 *  3. オッズの頁 `POST accessO.html`(本文 `cname=<2 で読んだもの>`)。1 レース・1 式別につき 1 本(全組が 1 頁に入る)
 * cname の末尾は検査値で、計算できない。必ず 1・2 でたどった値をそのまま使う(頁のリンクの値。{@link fetchJraRaceOdds})。
 *
 * ## 守ること(`jra-http.ts` の部品が実現する。出馬表・馬場の取得と同じ)
 * 各 1 回・再試行なし・リダイレクトは追わない・タイムアウト 10 秒(本文の読み出しも含む。1 本ごと)・UA などのヘッダは付けない(`content-type` だけ)。
 * 本文の上限は {@link JRA_ODDS_MAX_BODY_BYTES}(2MiB)。cname・日付の形を確かめてから JRA に出る(形が違えば何も送らず `shape-mismatch`)。
 * netkeiba 用の gate は通さない。例外は投げない(失敗は固定の語。例外の文面・URL・本文は残さない)。デコードは Shift_JIS(`iconv-lite`)。
 *
 * ## 本の間隔
 * 既定は session ごと(`jra-entries-fetch.ts` と同じ。最初の 1 本の前は待たず、2 本目以降は {@link JRA_GAP_MS} 待つ)。
 * **`pacer`(共有の間隔。{@link createJraPacer})を渡すと、session をまたいで**直前の送信から {@link JRA_GAP_MS} 未満なら残りを待つ。
 * DO(RaceDayDO)では馬場の取得口と共有する(`jra-fetchers.ts`。Issue #680)。出馬表の段はこの pacer を使っていない(動きを変えない)。
 *
 * ## param-error の判定について
 * 符号が違うとき、`accessD` は HTTP 200 の「パラメータエラー」の頁(title)を返す。`accessO` で同じ頁が返るかは**未観測**のため、`accessD` と同じ判定
 * を使う。別の形のエラーなら、パーサ側が `unavailable`(見出しが読めない)にして netkeiba に戻る。
 */
import { parseJraOddsCname, parseJraOddsRaceListPage, parseJraOddsVenueListPage, type JraOddsPage, type JraOddsRaceLinks, type JraOddsVenueLink } from "../../packages/core/src/scraper/parse-jra-odds-index";
import { JRA_ACCESS_O_URL, JRA_GAP_MS, JRA_ODDS_MAX_BODY_BYTES, JRA_TIMEOUT_MS, decodeShiftJis, fetchOne, type JraFailure, type JraFetchLike } from "./jra-http";

/** 開催選択の本文(固定。調査記録 §2.1)。 */
const OLI_BODY = "cname=pw15oli00/6D";

/** 取得 1 本の失敗の語(出馬表の取得口〈`jra-entries-fetch.ts`〉と同じ語。出馬表の段への依存を作らないため、ここで定義する)。 */
type JraPageFailure = JraFailure | `http-${number}` | "param-error" | "shape-mismatch";

/** 符号が違うときに HTTP 200 で返る「パラメータエラー」の頁か(<title> で見る。`jra-entries-parse.ts` の同名の関数と同じ判定)。 */
function isParamErrorPage(html: string): boolean {
  const title = /<title>([^<]*)<\/title>/.exec(html);
  return title !== null && title[1]!.includes("パラメータエラー");
}

/** 1 本の失敗の語。上に、指定の場・レースが開催選択・レース選択に無かった `not-found` を足す。 */
export type JraOddsFailure = JraPageFailure | "not-found";
export type JraOddsResult<T> = { readonly status: "ok"; readonly value: T } | { readonly status: JraOddsFailure };

/** 本のあいだの待ちを共有する部品。 */
export interface JraPacer {
  /** 1 本送る前に呼ぶ。直前の送信から {@link JRA_GAP_MS} 未満なら残りを待ち、送信の時刻を記録する。 */
  beforeRequest(): Promise<void>;
}

export interface CreateJraPacerDeps {
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
}

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 共有の間隔の部品を作る(同じ DO の中で、段をまたいで 1 つを共有する)。呼び出しは順番に待つ(同時の呼び出しも間隔をあける)。 */
export function createJraPacer(deps: CreateJraPacerDeps = {}): JraPacer {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? defaultWait;
  let lastAt: number | null = null;
  let chain: Promise<void> = Promise.resolve();
  return {
    beforeRequest(): Promise<void> {
      const next = chain.then(async () => {
        if (lastAt !== null) {
          const rest = JRA_GAP_MS - (now() - lastAt);
          if (rest > 0) {
            await wait(rest);
          }
        }
        lastAt = now();
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
}

/** 1 起床ぶんの取得。 */
export interface JraOddsSession {
  /** 開催の選択(1 本)。指定の日(YYYYMMDD)の場ごとのレース選択の入口(場コードの順)。 */
  listVenues(date: string): Promise<JraOddsResult<readonly JraOddsVenueLink[]>>;
  /** レースの選択(1 本)。その場・日の全レースの、式別ごとの cname(R の順)。 */
  listRaces(venue: JraOddsVenueLink): Promise<JraOddsResult<readonly JraOddsRaceLinks[]>>;
  /** オッズの頁(1 本)。Shift_JIS をデコードした文字列を返す。 */
  fetchOdds(cname: string): Promise<JraOddsResult<string>>;
  /** この session で JRA に送った本数(失敗した本も数える)。 */
  readonly requestCount: number;
}

export interface JraOddsFetcher {
  open(): JraOddsSession;
}

export interface CreateJraOddsFetcherDeps {
  /** 送信に使う fetch。省略時はグローバルの `fetch`(Worker)。テストで差し替える。 */
  readonly fetch?: JraFetchLike;
  /** 本のあいだの待ち(session ごとの既定の間隔に使う)。省略時は `setTimeout`。 */
  readonly wait?: (ms: number) => Promise<void>;
  /** 共有の間隔。渡すと session ごとの既定の間隔の代わりに使う。 */
  readonly pacer?: JraPacer;
  /** 1 本ごとのタイムアウト(ミリ秒)。省略時は {@link JRA_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
}

const DATE_PATTERN = /^\d{8}$/;
const ORL_CNAME_PATTERN = /^pw15orl\d{2}\d{2}\d{4}\d{2}\d{2}\d{8}\/[0-9A-F]{2}$/;

/** 取得口を作る。グローバルの `fetch` を呼ぶのは、`deps.fetch` を省いたときの既定の 1 箇所だけ。 */
export function createJraOddsFetcher(deps: CreateJraOddsFetcherDeps = {}): JraOddsFetcher {
  const fetchFn: JraFetchLike = deps.fetch ?? ((target, init) => fetch(target, init));
  const wait = deps.wait ?? defaultWait;
  const timeoutMs = deps.timeoutMs ?? JRA_TIMEOUT_MS;

  return {
    open(): JraOddsSession {
      let sent = 0;
      /** 1 本を取って文字列にする。失敗は語に落とす(投げない)。 */
      const page = async (body: string): Promise<{ readonly status: "ok"; readonly text: string } | { readonly status: JraPageFailure }> => {
        if (deps.pacer !== undefined) {
          await deps.pacer.beforeRequest();
        } else if (sent > 0) {
          await wait(JRA_GAP_MS);
        }
        sent += 1;
        const init: RequestInit = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body };
        const fetched = await fetchOne(fetchFn, JRA_ACCESS_O_URL, init, timeoutMs, JRA_ODDS_MAX_BODY_BYTES);
        const status = fetched.summary.status;
        if (typeof status !== "number") {
          return { status };
        }
        if (status < 200 || status >= 300 || fetched.body === null) {
          return { status: `http-${status}` };
        }
        let text: string;
        try {
          text = decodeShiftJis(fetched.body);
        } catch {
          return { status: "shape-mismatch" };
        }
        return isParamErrorPage(text) ? { status: "param-error" } : { status: "ok", text };
      };

      return {
        get requestCount(): number {
          return sent;
        },
        async listVenues(date) {
          if (!DATE_PATTERN.test(date)) {
            return { status: "shape-mismatch" };
          }
          const p = await page(OLI_BODY);
          if (p.status !== "ok") {
            return { status: p.status };
          }
          // 開催の選択の頁には、開催している週のレース選択のリンクが必ずある。1 つも読めなければ形が違う(指定の日だけが無いのとは別)。
          const venues = parseJraOddsVenueListPage(p.text, date);
          return venues === null ? { status: "shape-mismatch" } : { status: "ok", value: venues };
        },
        async listRaces(venue) {
          if (!ORL_CNAME_PATTERN.test(venue.racesCname) || !DATE_PATTERN.test(venue.date) || !/^\d{2}$/.test(venue.venueCode)) {
            return { status: "shape-mismatch" };
          }
          const p = await page(`cname=${venue.racesCname}`);
          if (p.status !== "ok") {
            return { status: p.status };
          }
          const races = parseJraOddsRaceListPage(p.text, venue.date, venue.venueCode);
          return races.length > 0 ? { status: "ok", value: races } : { status: "shape-mismatch" };
        },
        async fetchOdds(cname) {
          if (parseJraOddsCname(cname) === null) {
            return { status: "shape-mismatch" };
          }
          const p = await page(`cname=${cname}`);
          return p.status === "ok" ? { status: "ok", value: p.text } : { status: p.status };
        },
      };
    },
  };
}

/** {@link fetchJraRaceOdds} の入力。 */
export interface FetchJraRaceOddsRequest {
  /** 開催日 YYYYMMDD。 */
  readonly date: string;
  /** netkeiba の race_id(12 桁)。 */
  readonly raceId: string;
  /** 取る式別。重複は 1 本にまとめる。 */
  readonly pages: readonly JraOddsPage[];
  /** 前に拾った cname(取得キャッシュなどから)。あれば開催選択・レース選択を飛ばす。 */
  readonly links?: JraOddsRaceLinks;
}

export interface FetchJraRaceOddsResult {
  /** 使った(または拾い直した)cname。拾えなかったときは null。呼び出し側がキャッシュに置き直せる。 */
  readonly links: JraOddsRaceLinks | null;
  /** 開催選択・レース選択からたどり直したか(`param-error` の後の 1 回)。 */
  readonly rediscovered: boolean;
  /** 式別ごとの頁(Shift_JIS をデコードした文字列)または失敗の語。要求した式別だけが入る。 */
  readonly pages: Partial<Record<JraOddsPage, JraOddsResult<string>>>;
}

/**
 * 1 レースの指定の式別の頁を取る。cname が無ければ、開催選択 → レース選択をたどって拾う(本数 = 2 + 頁数)。
 * 頁が `param-error`(検査値が古い)になったら、**たどり直しは 1 回だけ**行い、その頁を取り直す(2 回目以降の param-error はそのまま失敗の語)。
 * 失敗は頁ごとに隔離する(ある頁の失敗はほかの頁を止めない)。開催選択・レース選択の失敗は、要求した全頁に同じ語を返す。例外は投げない。
 */
export async function fetchJraRaceOdds(session: JraOddsSession, request: FetchJraRaceOddsRequest): Promise<FetchJraRaceOddsResult> {
  const wanted = [...new Set(request.pages)];
  const out: Partial<Record<JraOddsPage, JraOddsResult<string>>> = {};
  const failAll = (status: JraOddsFailure, links: JraOddsRaceLinks | null, rediscovered: boolean): FetchJraRaceOddsResult => {
    for (const page of wanted) {
      out[page] = { status };
    }
    return { links, rediscovered, pages: out };
  };
  if (!/^\d{12}$/.test(request.raceId) || !DATE_PATTERN.test(request.date)) {
    return failAll("shape-mismatch", null, false);
  }
  const venueCode = request.raceId.slice(4, 6);

  const discover = async (): Promise<{ readonly status: "ok"; readonly links: JraOddsRaceLinks } | { readonly status: JraOddsFailure }> => {
    const venues = await session.listVenues(request.date);
    if (venues.status !== "ok") {
      return { status: venues.status };
    }
    const venue = venues.value.find((v) => v.venueCode === venueCode);
    if (venue === undefined) {
      return { status: "not-found" };
    }
    const races = await session.listRaces(venue);
    if (races.status !== "ok") {
      return { status: races.status };
    }
    const links = races.value.find((r) => r.raceId === request.raceId);
    return links === undefined ? { status: "not-found" } : { status: "ok", links };
  };

  let links: JraOddsRaceLinks | null = request.links ?? null;
  let rediscovered = false;
  if (links === null) {
    const found = await discover();
    if (found.status !== "ok") {
      return failAll(found.status, null, false);
    }
    links = found.links;
  }
  for (const page of wanted) {
    let result = await session.fetchOdds(links.cnames[page]);
    if (result.status === "param-error" && !rediscovered) {
      rediscovered = true;
      const found = await discover();
      if (found.status === "ok") {
        links = found.links;
        result = await session.fetchOdds(links.cnames[page]);
      } else {
        result = { status: found.status };
      }
    }
    out[page] = result;
  }
  return { links, rediscovered, pages: out };
}
