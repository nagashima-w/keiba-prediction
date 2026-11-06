/**
 * JRA の出馬表のページを 1 本ずつ取る取得口(Issue #639)。日単位の DO の出馬表の段〈`race-day-jra-entries.ts`〉だけが使う。
 *
 * ## 取る本(馬場の取得と同じ入口 `accessD.html`。見本の記録は #636・#637 のコメント)
 *  1. 開催の選択 `POST accessD.html`(本文 `cname=pw01dli00/F3`。固定)→ 場ごとの「レースの選択」の CNAME
 *  2. レースの選択 `POST accessD.html`(本文 `cname=<1 で読んだ CNAME>`)→ その場の 12 レースの詳細の CNAME
 *  3. 詳細 `GET accessD.html?CNAME=<2 で読んだ CNAME>`(1 レース 1 本。血統・馬主・生産者・ブリンカーが載る)
 * CNAME の末尾は確認用の符号で、計算できない(違うと HTTP 200 の「パラメータエラー」のページが返る)。必ず 1・2 でたどった値をそのまま使う。
 * CNAME は DO の meta に置いて使い回せる(再試行で 1・2 をたどり直さない)。
 *
 * ## 守ること(`jra-http.ts` の部品が実現する。馬場の取得と同じ)
 * 各 1 回・再試行なし・リダイレクトは追わない・タイムアウト 10 秒(本文の読み出しも含む。1 本ごと)・UA などのヘッダは付けない。
 * 本の間隔は {@link JRA_GAP_MS}(1.5 秒)以上。**間隔は session ごとに数える**: 1 起床 = 1 session で、最初の 1 本の前は待たない(起床と起床の間隔は段の側が空ける)。
 * 本文の上限は、詳細ページだけ {@link JRA_ENTRY_MAX_BODY_BYTES}(1MB。約 25 万バイトあり、馬場の既定 256KB の手前)、ほかの 2 本は既定。
 * CNAME・日付・場コードの形を確かめてから JRA に出る(形が違えば何も送らず `shape-mismatch`)。
 * netkeiba 用の gate は通さない(許可リストは netkeiba のホストだけ)。例外は投げない(失敗は固定の語。例外の文面・URL・本文は残さない)。
 */
import { isParamErrorPage, parseEntryPage, parseRaceCname, parseRaceListPage, parseVenueListPage, type JraEntryHorse, type JraRaceCname, type JraVenueLink } from "./jra-entries-parse";
import { JRA_ENTRY_MAX_BODY_BYTES, JRA_GAP_MS, JRA_TIMEOUT_MS, decodeShiftJis, fetchOne, type JraFailure, type JraFetchLike } from "./jra-http";

const ACCESS_D_URL = "https://www.jra.go.jp/JRADB/accessD.html";
/** 開催の選択の本文(固定。#636 で実際に通した値)。 */
const DLI_BODY = "cname=pw01dli00/F3";

/** 1 本の失敗の語。 */
export type JraPageFailure = JraFailure | `http-${number}` | "param-error" | "shape-mismatch" | "race-mismatch";

export type JraPageResult<T> = { readonly status: "ok"; readonly value: T } | { readonly status: JraPageFailure };

/** 詳細ページを読んだ結果。 */
export interface JraRaceEntries {
  readonly race: JraRaceCname;
  readonly horses: readonly JraEntryHorse[];
  /** 馬の ID が 10 桁でないなどで保存しなかった行の数。 */
  readonly skipped: number;
}

/** 1 起床ぶんの取得。 */
export interface JraEntriesSession {
  /** 開催の選択(1 本)。指定の日の場ごとのレースの選択の CNAME(場コードの順)。 */
  listVenues(date: string): Promise<JraPageResult<readonly JraVenueLink[]>>;
  /** レースの選択(1 本)。その場・日の詳細の CNAME(R の順)。 */
  listRaces(drlCname: string, date: string, venueCode: string): Promise<JraPageResult<readonly string[]>>;
  /** 詳細(1 本)。 */
  fetchRace(cname: string): Promise<JraPageResult<JraRaceEntries>>;
  /** この session で JRA に送った本数(失敗した本も数える)。 */
  readonly requestCount: number;
}

export interface JraEntriesFetcher {
  open(): JraEntriesSession;
}

export interface CreateJraEntriesFetcherDeps {
  /** 送信に使う fetch。省略時はグローバルの `fetch`(Worker)。テストで差し替える。 */
  readonly fetch?: JraFetchLike;
  /** 本のあいだの待ち。省略時は `setTimeout`。テストで差し替えて実時間を使わない。 */
  readonly wait?: (ms: number) => Promise<void>;
  /** 1 本ごとのタイムアウト(ミリ秒)。省略時は {@link JRA_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
}

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const DATE_PATTERN = /^\d{8}$/;
const VENUE_PATTERN = /^\d{2}$/;
const DRL_CNAME_PATTERN = /^pw01drl00\d{2}\d{4}\d{2}\d{2}\d{8}\/[0-9A-F]{2}$/;

/** 取得口を作る。グローバルの `fetch` を呼ぶのは、`deps.fetch` を省いたときの既定の 1 箇所だけ。 */
export function createJraEntriesFetcher(deps: CreateJraEntriesFetcherDeps = {}): JraEntriesFetcher {
  const fetchFn: JraFetchLike = deps.fetch ?? ((target, init) => fetch(target, init));
  const wait = deps.wait ?? defaultWait;
  const timeoutMs = deps.timeoutMs ?? JRA_TIMEOUT_MS;

  return {
    open(): JraEntriesSession {
      let sent = 0;
      /** 1 本を取って文字列にする。2 本目以降は先に待つ。失敗は語に落とす(投げない)。 */
      const page = async (url: string, init: RequestInit, maxBytes?: number): Promise<{ readonly status: "ok"; readonly text: string } | { readonly status: JraPageFailure }> => {
        if (sent > 0) {
          await wait(JRA_GAP_MS);
        }
        sent += 1;
        const fetched = await fetchOne(fetchFn, url, init, timeoutMs, maxBytes);
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

      const post = (body: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });

      return {
        get requestCount(): number {
          return sent;
        },
        async listVenues(date) {
          if (!DATE_PATTERN.test(date)) {
            return { status: "shape-mismatch" };
          }
          const p = await page(ACCESS_D_URL, post(DLI_BODY));
          if (p.status !== "ok") {
            return { status: p.status };
          }
          // 開催の選択のページには、開催している週のレースの選択が必ずある。1 つも読めなければ形が違う(指定の日だけが無いのとは別)。
          const anyDay = /pw01drl00\d{2}\d{4}\d{2}\d{2}\d{8}\/[0-9A-F]{2}/.test(p.text);
          return anyDay ? { status: "ok", value: parseVenueListPage(p.text, date) } : { status: "shape-mismatch" };
        },
        async listRaces(drlCname, date, venueCode) {
          if (!DRL_CNAME_PATTERN.test(drlCname) || !DATE_PATTERN.test(date) || !VENUE_PATTERN.test(venueCode)) {
            return { status: "shape-mismatch" };
          }
          const p = await page(ACCESS_D_URL, post(`cname=${drlCname}`));
          if (p.status !== "ok") {
            return { status: p.status };
          }
          const races = parseRaceListPage(p.text, date, venueCode);
          return races.length > 0 ? { status: "ok", value: races } : { status: "shape-mismatch" };
        },
        async fetchRace(cname) {
          const expected = parseRaceCname(cname);
          if (expected === null) {
            return { status: "shape-mismatch" };
          }
          const p = await page(`${ACCESS_D_URL}?CNAME=${cname}`, { method: "GET" }, JRA_ENTRY_MAX_BODY_BYTES);
          if (p.status !== "ok") {
            return { status: p.status };
          }
          const parsed = parseEntryPage(p.text, expected);
          return parsed.status === "ok" ? { status: "ok", value: { race: expected, horses: parsed.horses, skipped: parsed.skipped } } : { status: parsed.status };
        },
      };
    },
  };
}
