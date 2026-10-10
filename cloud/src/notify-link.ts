/**
 * 通知のリンク(Issue #230)。**純関数**: 時計・DO・送信を持たない。
 *
 * サイトの URL は公開リポジトリに書けないので、Worker の secret `APP_BASE_URL`(ユーザーが登録する)から読む。
 *  - {@link resolveAppBaseUrl}: secret の値の検証。**https のオリジンだけ**を受け付ける(`javascript:`・`data:`・http・userinfo・パス・クエリ・フラグメントは拒否)。
 *    結果に入力の値は入れない(invalid のとき、値の一部もログ・応答に出ない)。
 *  - {@link buildAnalysisLink}: 分析画面へのリンク。ハッシュの形は、クライアントの `buildHash`(`cloud/client/route.ts`。`parseHash` が読む)をそのまま使う(形を二重に持たない)。
 */
import { buildHash, buildReportHash } from "../client/route";

export type AppBaseUrlResolution =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly origin: string };

/**
 * secret の値(未登録なら undefined)から、リンクの基点(オリジン。末尾の `/` なし)を決める。前後の空白・末尾の改行(貼り付けで付く)は取り除いて判定する。
 * `absent` = 未登録・空白だけ / `invalid` = 登録されているが、https のオリジンの形でない / `valid`。
 */
export function resolveAppBaseUrl(raw: string | undefined): AppBaseUrlResolution {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { status: "absent" };
  }
  const text = raw.trim();
  // `URL` は空のクエリ(`?`)・空のフラグメント(`#`)を `search`・`hash` に残さないので、文字列の段階で拒否する。空白・制御文字は `URL` が黙って取り除くことがあるので、これも拒否する。
  if (/[?#\s\u0000-\u001f\u007f]/.test(text)) {
    return { status: "invalid" };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { status: "invalid" };
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/" || url.host === "") {
    return { status: "invalid" };
  }
  return { status: "valid", origin: url.origin };
}

/** サーバの分析 id の上限(`cloud/client/route.ts` の `ANALYSIS_ID_MAX` と同じ。`parseHash` が捨てない範囲に収める)。 */
const ANALYSIS_ID_MAX = 2_147_483_647;

export interface AnalysisLinkInput {
  /** 開催日(YYYYMMDD)。 */
  readonly date: string;
  readonly venue: "central" | "nar";
  readonly raceId: string;
  readonly analysisId: number;
}

/**
 * 分析画面へのリンク(`<オリジン>/#date=…&venue=…&race=…&analysis=…`)。分析 id が正の整数(サーバの上限以内)でなければ undefined(リンクを作らない)。
 * 日付が 8 桁でないときは分析 id だけ(`#analysis=<id>`。クライアントは日付なしのレース ID を採らないため。分析は開ける)。レース ID が 12 桁でないときは `race` を省く。
 */
export function buildAnalysisLink(origin: string, input: AnalysisLinkInput): string | undefined {
  const { analysisId } = input;
  if (!Number.isInteger(analysisId) || analysisId < 1 || analysisId > ANALYSIS_ID_MAX) {
    return undefined;
  }
  if (!/^[0-9]{8}$/.test(input.date)) {
    return `${origin}/#analysis=${analysisId}`;
  }
  const race = /^[0-9]{12}$/.test(input.raceId) ? input.raceId : null;
  return `${origin}/${buildHash({ date: input.date, venue: input.venue, race, analysis: analysisId })}`;
}

/** その日の日報へのリンク(`<オリジン>/#report=YYYYMMDD`。Issue #235)。開催日が 8 桁の数字でなければ undefined(リンクを作らない)。 */
export function buildReportLink(origin: string, kaisaiDate: string): string | undefined {
  return /^[0-9]{8}$/.test(kaisaiDate) ? `${origin}/${buildReportHash(kaisaiDate)}` : undefined;
}
