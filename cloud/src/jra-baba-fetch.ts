/**
 * JRA のページから馬場の値を取りに行く流れ(Issue #478〈#477-B〉。旧 `baba-fetch.ts` の外部の API の取得口に代わる)。日単位の DO の馬場の段階〈`race-day-baba.ts`〉だけが使う。
 *
 * ## 取る順(開催日の 1 回の試み〈1 枠〉の中で、1 本ずつ順に。間は {@link JRA_GAP_MS}〈1.5 秒〉以上)
 *  1. クッション値 `GET _data_cushion.html`
 *  2. 含水率 `GET _data_moist.html`
 *  3. 開催情報(公式の馬場状態・天候)`POST accessJ.html`(本文 `CNAME=pw01iwtS3/CD`)
 *  4. コースの情報 `GET index.html`、続けて `index2.html`・`index3.html`(index.html の場の切り替えタブの数だけ。最大 {@link MAX_COURSE_PAGES} 本)
 * **クッション値と含水率のどちらにも当日の値が無ければ、3 と 4 には出ない**(保存する場が無いので取っても使えない)。
 *
 * ## 守ること(`jra-http.ts` の部品が実現する。#488 の確認口と同じ)
 * 各 1 回・再試行なし・リダイレクトは追わない・タイムアウト 10 秒(本文の読み出しも含む。1 本ごと)・本文は 256KB まで・UA などのヘッダは付けない。
 * netkeiba 用の gate は通さない(許可リストは netkeiba のホストだけ)。間隔はここで守る。
 * 1 枠 1 回の制御・枠の時刻(09:00 から 10 分おきに 12:00 まで)・当日の値がそろうまでの取り直し(#480)は `race-day-baba.ts` の側にある。ここは「呼ばれたら 1 回取る」だけ。
 * 結果には、ページに載っている場の場コード(`listedVenueCodes`。計画から場が取れないときの「全部の場」の分母)と、クッション値のページを取り終えた時刻(`apiFetchedAt`)を含める。
 *
 * ## ページの構造が変わったとき(Issue #490-1)
 * クッション値は全場で計測が 1 件も読めなければ、含水率は計測があるのに値が 1 つも読めなければ、`shape-mismatch` として残す(「当日の計測が無い」と取り違えない)。
 *
 * ## 一部の失敗は、取れたものだけで保存する
 * 失敗した本は、その本由来の項目が null になる(クッション値が失敗なら クッション値 = null、開催情報が失敗なら 芝・ダートの全体の状態 = null、
 * コースの 1 本が失敗ならその場の使用コース・芝丈・芝の状態の文章 = null)。各本の結果は固定の語だけを `rawJson.sources` に残す(例外の文面・本文は残さない)。
 * 結果の分類は、1 場以上を保存できれば `ok`、クッション値も含水率も読めなければクッション値の失敗の語(クッション値が読めて含水率が失敗ならその語、どちらも ok で当日の値が無ければ `no-today-venues`)。
 * 例外は投げない。
 */
import type { BabaFetcher, BabaFetchOutcome, BabaResultClass } from "./baba-conditions";
import {
  assembleBabaVenues,
  parseAccessJson,
  parseCoursePage,
  parseCushionHtml,
  parseMoistHtml,
  type AccessVenue,
  type BabaSources,
  type BabaSourceStatus,
  type CoursePage,
} from "./jra-baba-parse";
import {
  JRA_ACCESS_BODY,
  JRA_ACCESS_URL,
  JRA_CUSHION_URL,
  JRA_GAP_MS,
  JRA_MOIST_URL,
  JRA_TIMEOUT_MS,
  decodeShiftJis,
  fetchOne,
  jraCourseUrl,
  type JraFetchLike,
} from "./jra-http";

export type { BabaFetcher };

/** コースの情報のページの本数の上限(JRA は 1 日に最大 3 場)。 */
const MAX_COURSE_PAGES = 3;

export interface CreateJraBabaFetcherDeps {
  /** 送信に使う fetch。省略時はグローバルの `fetch`(Worker)。テストで差し替える。 */
  readonly fetch?: JraFetchLike;
  /** 本のあいだの待ち。省略時は `setTimeout`。テストで差し替えて実時間を使わない。 */
  readonly wait?: (ms: number) => Promise<void>;
  /** 1 本ごとのタイムアウト(ミリ秒)。省略時は {@link JRA_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
  /** 現在時刻(エポックミリ秒)。`apiFetchedAt`(クッション値のページを取り終えた時刻)に使う。省略時は `Date.now`。テストで固定する。 */
  readonly now?: () => number;
}

/** 既定の待ち(`setTimeout`)。 */
const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 取れた本文(文字列)か、失敗の語。 */
type Page = { readonly status: "ok"; readonly text: string } | { readonly status: Exclude<BabaSourceStatus, "ok"> };

/**
 * 取得口を作る。グローバルの `fetch` を呼ぶのは、`deps.fetch` を省いたときの既定の 1 箇所だけ。
 * 返す関数は `nowMs`(UTC のエポックミリ秒)の JST の暦日を「今日」として、当日の値だけを集める。
 */
export function createJraBabaFetcher(deps: CreateJraBabaFetcherDeps = {}): BabaFetcher {
  const fetchFn: JraFetchLike = deps.fetch ?? ((target, init) => fetch(target, init));
  const wait = deps.wait ?? defaultWait;
  const timeoutMs = deps.timeoutMs ?? JRA_TIMEOUT_MS;
  const clock = deps.now ?? Date.now;

  return async (nowMs: number): Promise<BabaFetchOutcome> => {
    let first = true;
    /** 1 本を取って文字列にする。2 本目以降は先に待つ。失敗は語に落とす(投げない)。 */
    const page = async (url: string, init: RequestInit): Promise<Page> => {
      if (!first) {
        await wait(JRA_GAP_MS);
      }
      first = false;
      const fetched = await fetchOne(fetchFn, url, init, timeoutMs);
      const status = fetched.summary.status;
      if (typeof status !== "number") {
        return { status };
      }
      if (status < 200 || status >= 300 || fetched.body === null) {
        return { status: `http-${status}` };
      }
      try {
        return { status: "ok", text: decodeShiftJis(fetched.body) };
      } catch {
        return { status: "shape-mismatch" };
      }
    };

    const cushionPage = await page(JRA_CUSHION_URL, { method: "GET" });
    const cushion = cushionPage.status === "ok" ? parseCushionHtml(cushionPage.text) : null;
    const cushionStatus: BabaSourceStatus = cushionPage.status === "ok" && cushion === null ? "shape-mismatch" : cushionPage.status;
    // クッション値のページを取り終えた時刻(以降の本を待つあいだに進んだ時計ではない)。読めなかった(shape-mismatch)ときは null。
    const apiFetchedAt = cushionStatus === "ok" ? new Date(clock()).toISOString() : null;

    const moistPage = await page(JRA_MOIST_URL, { method: "GET" });
    const moist = moistPage.status === "ok" ? parseMoistHtml(moistPage.text) : null;
    const moistStatus: BabaSourceStatus = moistPage.status === "ok" && moist === null ? "shape-mismatch" : moistPage.status;

    let sources: BabaSources = { cushion: cushionStatus, moist: moistStatus, access: "skipped", course: "skipped" };

    // 当日の値のある場が無ければ、開催情報とコースには出ない(保存する場が無い)。
    const measured = assembleBabaVenues({ nowMs, cushion, moist, access: null, courses: [], sources });
    if (measured.venues.length === 0) {
      return { result: failureClass(cushionStatus, moistStatus), venues: [], dropped: measured.dropped, droppedDetails: measured.droppedDetails, apiFetchedAt, listedVenueCodes: measured.listedVenueCodes };
    }

    // 開催情報(公式の馬場状態)。
    const accessPage = await page(JRA_ACCESS_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: JRA_ACCESS_BODY,
    });
    const access: AccessVenue[] | null = accessPage.status === "ok" ? parseAccessJson(accessPage.text) : null;
    const accessStatus: BabaSourceStatus = accessPage.status === "ok" && access === null ? "shape-mismatch" : accessPage.status;

    // コースの情報。index.html の切り替えタブの数だけ(最大 3 本)。index.html が読めなければ、以降は取らない。
    const courses: CoursePage[] = [];
    let courseStatus: BabaSourceStatus = "ok";
    const noteCourse = (status: BabaSourceStatus): void => {
      if (courseStatus === "ok") {
        courseStatus = status;
      }
    };
    const firstPage = await page(jraCourseUrl(1), { method: "GET" });
    const firstCourse = firstPage.status === "ok" ? parseCoursePage(firstPage.text) : null;
    if (firstCourse === null) {
      noteCourse(firstPage.status === "ok" ? "shape-mismatch" : firstPage.status);
    } else {
      courses.push(firstCourse);
      const count = Math.min(firstCourse.tabs.length, MAX_COURSE_PAGES);
      for (let n = 2; n <= count; n += 1) {
        const next = await page(jraCourseUrl(n), { method: "GET" });
        const parsed = next.status === "ok" ? parseCoursePage(next.text) : null;
        if (parsed === null) {
          noteCourse(next.status === "ok" ? "shape-mismatch" : next.status);
        } else {
          courses.push(parsed);
        }
      }
    }

    sources = { cushion: cushionStatus, moist: moistStatus, access: accessStatus, course: courseStatus };
    const assembled = assembleBabaVenues({ nowMs, cushion, moist, access, courses, sources });
    return {
      result: assembled.venues.length > 0 ? "ok" : failureClass(cushionStatus, moistStatus),
      venues: assembled.venues,
      dropped: assembled.dropped,
      droppedDetails: assembled.droppedDetails,
      apiFetchedAt,
      listedVenueCodes: assembled.listedVenueCodes,
    };
  };
}

/** 保存する場が無いときの分類。両方とも読めていれば当日の値が無い(`no-today-venues`)。読めなかった側があれば、その失敗の語(クッション値を先に見る)。 */
function failureClass(cushion: BabaSourceStatus, moist: BabaSourceStatus): BabaResultClass {
  if (cushion !== "ok") {
    return toResultClass(cushion);
  }
  if (moist !== "ok") {
    return toResultClass(moist);
  }
  return "no-today-venues";
}

function toResultClass(status: Exclude<BabaSourceStatus, "ok">): BabaResultClass {
  if (status === "skipped") {
    return "other";
  }
  return status;
}

