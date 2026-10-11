/**
 * スマホ画面の状態(URL のハッシュ)の解析と組み立て(Issue #184)。純関数。
 *
 * ハッシュは `#date=YYYYMMDD&venue=central|nar[&race=<12桁>][&analysis=<id>]`。利用者(または他のページのリンク)が自由に書き換えられる入力なので、
 * **値はすべて検証し、不正な項目は捨てて既定に落とす**(例外にしない)。既定: 日付は今日(JST)・区分は central・race と analysis は null。
 * 同じキーが重複していたら、そのキーは不正(どちらを採るかを曖昧にしない)。未知のキーは無視する。
 * `race` は **有効な `date` があるときだけ**採る(中央のレースIDは日付を含まず、日付なしでは別の日のレースと取り違えるため)。
 * `race`(レース画面)・`analysis`(結果画面)を使う画面は Issue #185。両方あれば analysis が優先(`app.ts`)。
 */
import { isRealYmd } from "./date";

export type Venue = "central" | "nar";

export interface Route {
  /** 開催日(YYYYMMDD)。 */
  readonly date: string;
  readonly venue: Venue;
  /** レースID(12桁)。無ければ null。 */
  readonly race: string | null;
  /** 分析 id(正の整数。サーバの上限と同じ 2147483647 まで)。無ければ null。 */
  readonly analysis: number | null;
  /** 設定画面(`#settings` の**完全一致**のときだけ true。Issue #189)。 */
  readonly settings: boolean;
  /**
   * 移行画面(`#migration` の**完全一致**のときだけ true。Issue #222)。**省略は false**(`#migration` のときだけ true を付ける。
   * 既存の route の組み立て〈テスト・画面の表示用データ〉を変えないための任意項目)。
   */
  readonly migration?: boolean;
  /** 検証画面(`#verify` の**完全一致**のときだけ true。Issue #219)。**省略は false**(`migration` と同じ流儀)。 */
  readonly verify?: boolean;
  /**
   * 日報画面(Issue #235)。`#report`(完全一致。`date` は null = 最新)と `#report=YYYYMMDD`(実在の日付の完全一致)のときだけ付く。**省略は日報画面ではない**
   * (`migration`・`verify` と同じ流儀)。
   */
  readonly report?: { readonly date: string | null };
}

/** 設定画面のハッシュ(Issue #189)。一覧のトップの入口のリンク先。 */
export const SETTINGS_HASH = "#settings";

/** 移行画面のハッシュ(Issue #222)。設定画面の「exe から移行」の節のリンク先。 */
export const MIGRATION_HASH = "#migration";

/** 検証画面のハッシュ(Issue #219)。一覧のトップの入口のリンク先。 */
export const VERIFY_HASH = "#verify";

/** 日報画面のハッシュ(Issue #235)。`#report`(日付の一覧と最新の日報)と `#report=YYYYMMDD`(その日の日報)。 */
export const REPORT_HASH = "#report";

/** その日の日報のハッシュ(`#report=YYYYMMDD`)。通知のリンクにも使う。 */
export function buildReportHash(date: string): string {
  return `${REPORT_HASH}=${date}`;
}

const ANALYSIS_ID_MAX = 2_147_483_647;

/** 1 つのキーの値。キーが無い・重複・デコードできないときは null。 */
function single(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 ? values[0]! : null;
}

export function parseHash(hash: string, today: string): Route {
  // 設定画面は `#settings` の完全一致だけ(`#settings&date=…` などは従来どおりの解析。日付・区分などを持たない画面なので、混ぜない)。
  if (hash === SETTINGS_HASH) {
    return { date: today, venue: "central", race: null, analysis: null, settings: true };
  }
  // 移行画面も `#migration` の完全一致だけ(設定画面と同じ理由。日付・区分などを持たない画面)。
  if (hash === MIGRATION_HASH) {
    return { date: today, venue: "central", race: null, analysis: null, settings: false, migration: true };
  }
  // 検証画面も `#verify` の完全一致だけ(日付・区分などを持たない画面)。
  if (hash === VERIFY_HASH) {
    return { date: today, venue: "central", race: null, analysis: null, settings: false, verify: true };
  }
  // 日報画面は `#report` と `#report=YYYYMMDD`(実在の日付)の完全一致だけ(日付以外・区分などを持たない画面)。
  if (hash === REPORT_HASH) {
    return { date: today, venue: "central", race: null, analysis: null, settings: false, report: { date: null } };
  }
  const reportMatch = /^#report=([0-9]{8})$/.exec(hash);
  if (reportMatch !== null && isRealYmd(reportMatch[1]!)) {
    return { date: today, venue: "central", race: null, analysis: null, settings: false, report: { date: reportMatch[1]! } };
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  } catch {
    params = new URLSearchParams("");
  }
  const dateValue = single(params, "date");
  const dateValid = dateValue !== null && isRealYmd(dateValue);
  const venueValue = single(params, "venue");
  const raceValue = single(params, "race");
  const analysisValue = single(params, "analysis");
  const analysis = analysisValue !== null && /^[1-9][0-9]{0,9}$/.test(analysisValue) ? Number(analysisValue) : null;
  return {
    date: dateValid ? dateValue : today,
    venue: venueValue === "nar" ? "nar" : "central",
    race: dateValid && raceValue !== null && /^[0-9]{12}$/.test(raceValue) ? raceValue : null,
    analysis: analysis !== null && analysis <= ANALYSIS_ID_MAX ? analysis : null,
    settings: false,
  };
}

export function buildHash(route: { readonly date: string; readonly venue: Venue; readonly race?: string | null; readonly analysis?: number | null }): string {
  const parts = [`date=${route.date}`, `venue=${route.venue}`];
  if (route.race !== undefined && route.race !== null) {
    parts.push(`race=${route.race}`);
  }
  if (route.analysis !== undefined && route.analysis !== null) {
    parts.push(`analysis=${route.analysis}`);
  }
  return `#${parts.join("&")}`;
}

/** 今の画面(Issue #191)。 */
export type Screen = "list" | "race" | "result" | "settings" | "migration" | "verify" | "report";

/**
 * 「今どの画面か」の判定の**唯一の場所**(Issue #191。#188 の申し送り)。`app.ts` は、画面ごとの分岐をすべてこの関数の `switch` で行う
 * (`route.analysis !== null` のような直接の比較を散らさない。画面を足すときは、ここと、各 `switch` の `never` による網羅チェックが漏れを教える)。
 * 優先順位: settings(設定画面。`#settings` の完全一致だけ。Issue #189)> migration(移行画面。`#migration` の完全一致だけ。Issue #222)> verify(検証画面。`#verify` の完全一致だけ。Issue #219)> analysis(結果画面)> race(レース画面)> 一覧。`race` と `analysis` が両方あれば結果画面。
 */
export function screenOf(route: Route): Screen {
  if (route.settings) return "settings";
  if (route.migration === true) return "migration";
  if (route.verify === true) return "verify";
  if (route.report !== undefined) return "report";
  if (route.analysis !== null) return "result";
  if (route.race !== null) return "race";
  return "list";
}
