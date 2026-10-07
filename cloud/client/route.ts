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
}

/** 設定画面のハッシュ(Issue #189)。一覧のトップの入口のリンク先。 */
export const SETTINGS_HASH = "#settings";

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
export type Screen = "list" | "race" | "result" | "settings";

/**
 * 「今どの画面か」の判定の**唯一の場所**(Issue #191。#188 の申し送り)。`app.ts` は、画面ごとの分岐をすべてこの関数の `switch` で行う
 * (`route.analysis !== null` のような直接の比較を散らさない。画面を足すときは、ここと、各 `switch` の `never` による網羅チェックが漏れを教える)。
 * 優先順位: settings(設定画面。`#settings` の完全一致だけ。Issue #189)> analysis(結果画面)> race(レース画面)> 一覧。`race` と `analysis` が両方あれば結果画面。
 */
export function screenOf(route: Route): Screen {
  if (route.settings) return "settings";
  if (route.analysis !== null) return "result";
  if (route.race !== null) return "race";
  return "list";
}
