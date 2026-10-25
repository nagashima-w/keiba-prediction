/**
 * JRA のページに Worker から届くかの確認(Issue #488〈#477-A1〉。管理者が `GET /api/jra/check` を開いたときだけ)。
 *
 * netkeiba は Cloudflare からの通常の fetch を弾くので DO の TCP ソケットで取っている(#159・#160・#162)。JRA で同じことが起きるかは、作業環境のコンテナからの取得(#477)では分からない。
 * そこで本番の Worker の**素のグローバルの fetch**(UA などのヘッダは付けない)で、次の 2 本を 1 回ずつ取り、結果の要約だけを返す:
 *  1. `GET https://www.jra.go.jp/keiba/baba/_data_cushion.html`(クッション値のページ。Shift_JIS)
 *  2. `POST https://www.jra.go.jp/JRADB/accessJ.html`(本文 `CNAME=pw01iwtS3/CD`。開催情報の JSON。Shift_JIS)
 *
 * 守ること(取得の部品は `jra-http.ts`〈#478 で切り出した。馬場の取得と共有〉。ここは gate〈1.5 秒間隔・ブレーカー・許可リスト〉を通らない別系統なので、間隔はここで守る):
 *  - 各 1 回だけ。再試行しない。リダイレクトは追わない(`redirect: "manual"`。3xx は `redirect` の失敗)。
 *  - 2 本の間は {@link JRA_CHECK_GAP_MS}(1.5 秒以上)あける。**1 本目が失敗しても 2 本目は取る**(2 本は独立した計測)が、間は同じようにあける。
 *  - タイムアウトは {@link JRA_CHECK_TIMEOUT_MS}(本文の読み出しも含む。1 本ごと)。本文は {@link JRA_CHECK_MAX_BODY_BYTES} まで(超えたら打ち切って `too-large`)。
 *  - 取得の起点はこの関数を呼ぶ管理者の確認口だけ。cron・DO からは呼ばない(`cloud-config-guard.test.ts` が固定する)。
 *
 * 返すのは明示の許可リストの形だけ: 状態・本文の大きさ・Content-Type・期待した形が見えたか・中身の短い要約。**本文もヘッダ全体(Location・Set-Cookie を含む)も返さない**。
 * 例外のメッセージも返さない(失敗は分類名だけ)。Shift_JIS は `iconv-lite` で読む(`TextDecoder("shift_jis")` が workerd で使えるかには頼らない)。
 */
import {
  JRA_ACCESS_BODY,
  JRA_ACCESS_URL,
  JRA_CUSHION_URL,
  JRA_GAP_MS,
  JRA_MAX_BODY_BYTES,
  JRA_TIMEOUT_MS,
  cap,
  decodeShiftJis,
  fetchOne,
  type JraFailure,
  type JraFetchLike,
  type JraFetchSummary,
  type JraFetched,
} from "./jra-http";

export { JRA_ACCESS_BODY, JRA_ACCESS_URL, JRA_CUSHION_URL };
export type { JraFailure, JraFetchLike, JraFetchSummary };

/** 1 本ごとのタイムアウト(ミリ秒)。応答の待ちと本文の読み出しの合計(`jra-http.ts` の値)。 */
export const JRA_CHECK_TIMEOUT_MS = JRA_TIMEOUT_MS;
/** 本文の上限(バイト。`jra-http.ts` の値)。 */
export const JRA_CHECK_MAX_BODY_BYTES = JRA_MAX_BODY_BYTES;
/** 2 本の間の待ち(ミリ秒。`jra-http.ts` の値)。JRA への取得は 1.5 秒以上あける(#477 の承認の範囲)。 */
export const JRA_CHECK_GAP_MS = JRA_GAP_MS;

/** 要約の長さの上限(応答が大きくならないように、見えた中身を切る)。 */
const MAX_VENUE_NAME_CHARS = 20;
const MAX_VENUES = 20;
const MAX_TIME_CHARS = 60;
const MAX_KAISAI_INFO_ITEMS = 20;
const MAX_ITEM_CHARS = 20;

export interface JraCheckDeps {
  /** 送信に使う fetch。省略時はグローバルの `fetch`(Worker)。テストで差し替える。 */
  readonly fetch?: JraFetchLike;
  /** 2 本の間の待ち。省略時は `setTimeout`。テストで差し替えて実時間を使わない。 */
  readonly wait?: (ms: number) => Promise<void>;
  /** 1 本ごとのタイムアウト(ミリ秒)。省略時は {@link JRA_CHECK_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
}

export interface JraCushionSummary extends JraFetchSummary {
  /** `<div id="rc." title="場名">` の場名の一覧(長さ・数を抑えて)。 */
  readonly venues: readonly string[];
  /** 最初の場の先頭の `<div class="time">` の文字列。無ければ null。 */
  readonly firstTime: string | null;
}

export interface JraKaisaiInfoItem {
  readonly jyoname: string | null;
  readonly kaisai_ymd: string | null;
}

export interface JraAccessSummary extends JraFetchSummary {
  /** Shift_JIS で読んだ本文が JSON として解釈できたか。 */
  readonly parsedJson: boolean;
  /** `kaisai_info` が配列のときの実際の件数。そうでなければ null。 */
  readonly kaisaiInfoCount: number | null;
  /** 先頭から {@link MAX_KAISAI_INFO_ITEMS} 件までの `jyoname`・`kaisai_ymd`。 */
  readonly kaisaiInfo: readonly JraKaisaiInfoItem[];
}

export interface JraCheckResult {
  readonly cushion: JraCushionSummary;
  readonly access: JraAccessSummary;
}

const VENUE_PATTERN = /<div\s+id="rc[^"]*"\s+title="([^"]*)"/g;
const TIME_PATTERN = /<div\s+class="time">([^<]*)<\/div>/;

function summarizeCushion(fetched: JraFetched): JraCushionSummary {
  const base = fetched.summary;
  let venues: string[] = [];
  let firstTime: string | null = null;
  if (fetched.body !== null) {
    try {
      const html = decodeShiftJis(fetched.body);
      const matches = [...html.matchAll(VENUE_PATTERN)];
      venues = matches.slice(0, MAX_VENUES).map((m) => cap(m[1] ?? "", MAX_VENUE_NAME_CHARS));
      const first = matches[0];
      if (first !== undefined) {
        const start = first.index + first[0].length;
        const next = matches[1];
        const section = html.slice(start, next === undefined ? html.length : next.index);
        const time = TIME_PATTERN.exec(section);
        firstTime = time === null ? null : cap(time[1] ?? "", MAX_TIME_CHARS);
      }
    } catch {
      venues = [];
      firstTime = null;
    }
  }
  return { ...base, ok: base.status === 200 && venues.length >= 1 && firstTime !== null, venues, firstTime };
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? cap(value, MAX_ITEM_CHARS) : null;
}

function summarizeAccess(fetched: JraFetched): JraAccessSummary {
  const base = fetched.summary;
  let parsedJson = false;
  let count: number | null = null;
  let items: JraKaisaiInfoItem[] = [];
  if (fetched.body !== null) {
    try {
      const parsed: unknown = JSON.parse(decodeShiftJis(fetched.body));
      parsedJson = true;
      const info = typeof parsed === "object" && parsed !== null ? (parsed as { kaisai_info?: unknown }).kaisai_info : undefined;
      if (Array.isArray(info)) {
        count = info.length;
        items = info.slice(0, MAX_KAISAI_INFO_ITEMS).map((item: unknown) => {
          const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
          return { jyoname: textOrNull(record.jyoname), kaisai_ymd: textOrNull(record.kaisai_ymd) };
        });
      }
    } catch {
      parsedJson = false;
      count = null;
      items = [];
    }
  }
  return { ...base, ok: base.status === 200 && parsedJson && count !== null, parsedJson, kaisaiInfoCount: count, kaisaiInfo: items };
}

/** 既定の待ち(`setTimeout`)。 */
const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 2 本を順に取って要約を返す。例外は投げない(各取得の失敗は分類名で返す)。
 * グローバルの `fetch` を呼ぶのはこのファイルの既定(`deps.fetch` を省いたとき)の 1 箇所だけ。
 */
export async function runJraCheck(deps: JraCheckDeps = {}): Promise<JraCheckResult> {
  const fetchFn: JraFetchLike = deps.fetch ?? ((target, init) => fetch(target, init));
  const wait = deps.wait ?? defaultWait;
  const timeoutMs = deps.timeoutMs ?? JRA_CHECK_TIMEOUT_MS;

  const cushionFetched = await fetchOne(fetchFn, JRA_CUSHION_URL, { method: "GET" }, timeoutMs);
  await wait(JRA_CHECK_GAP_MS);
  const accessFetched = await fetchOne(
    fetchFn,
    JRA_ACCESS_URL,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: JRA_ACCESS_BODY },
    timeoutMs,
  );
  return { cushion: summarizeCushion(cushionFetched), access: summarizeAccess(accessFetched) };
}
