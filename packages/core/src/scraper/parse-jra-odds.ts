/**
 * JRA 公式サイト(www.jra.go.jp)のオッズの頁のパーサー(Issue #672・#668-B)。
 *
 * 中央のオッズの取得先を netkeiba から JRA の公式サイトへ切り替える(#668)ための、純関数のパーサ。
 * 頁の構造は `docs/jra-odds-investigation.md`(#671)に実測を記録してある。取得とデコードは呼び出し側の仕事
 * (`cloud/src/jra-http.ts`)で、本モジュールは **Shift_JIS をデコードした後の文字列**だけを受ける
 * (core に Shift_JIS のデコーダを持ち込まない)。
 *
 * 戻り値の形は netkeiba のパーサと揃える:
 * - 単勝・複勝: `OddsSnapshot`(`parse-odds.ts` の `parseOdds` と同じ)。
 * - 組合せ: `ComboOddsParseResult`(`parse-combo-odds.ts` の `parseComboOdds` と同じ。キーも `buildComboOddsKey` /
 *   `buildOrderedComboOddsKey` 形式)。
 *
 * ## 発売状態と時刻
 * - 「N時M分現在オッズ」→ `middle`(発売中の暫定)。`officialDatetime` は呼び出し側が渡すレースの日付(JST)と
 *   頁の時刻から `YYYY-MM-DD HH:MM:00` を作る(頁に年月日・秒は無い)。
 * - 「最終オッズ」→ `result`(確定)。頁に時刻が無いので `officialDatetime` は null。
 * - `yoso`(前売り前の予想)は JRA の頁からは作れない。発売前の頁は観測できていないため、
 *   時刻・最終のどちらの表示も無い頁は「読めなかった」(`unavailable`)として返し、throw しない。
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { OddsSnapshot, PlaceOdds, WinOdds } from "./types.js";
import { toNinki } from "./ninki.js";
import { toOddsNumber } from "./odds-number.js";

/** 馬番の上限(1〜18)。 */
const MAX_UMABAN = 18;

/** JRA の頁のオッズ表示の発売状態(`yoso` は作れない)。 */
type JraOddsStatus = "middle" | "result";

/** 頁の見出し(時刻と発売状態)。 */
interface JraOddsHeader {
  readonly oddsStatus: JraOddsStatus;
  readonly officialDatetime: string | null;
}

/**
 * 読めなかった理由。生の信号だけを持つ(`ComboOddsUnavailableReason` と同じ思想)。
 * - `header`: 見出しの表示(「N時M分現在オッズ」「最終オッズ」)が見つからなかった。
 * - `table`: 見出しはあるが、期待する表(単勝・複勝の `table.tanpuku`)が無い、または行が 0 件だった。
 */
export interface JraOddsUnavailableReason {
  readonly missing: "header" | "table";
}

/** 単勝・複勝のパース結果(判別共用体)。 */
export type JraWinPlaceParseResult =
  | { readonly state: "available"; readonly snapshot: OddsSnapshot }
  | { readonly state: "unavailable"; readonly reason: JraOddsUnavailableReason };

/** 日付 `YYYY-MM-DD` の形を検証する(呼び出し側のバグは throw)。 */
function assertRaceDate(raceDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raceDate)) {
    throw new Error(`raceDate は YYYY-MM-DD 形式である必要があります(値: "${raceDate}")`);
  }
}

/**
 * 頁の見出し(`div.cell.time > strong`)から発売状態と時刻を読む。
 * 「発走時刻」の `div.cell.time` も同じクラスを持つため、本文が「現在オッズ」「最終オッズ」の `strong` だけを見る。
 * 見つからなければ null。
 */
export function parseJraOddsHeader(
  $: CheerioAPI,
  raceDate: string,
): JraOddsHeader | null {
  assertRaceDate(raceDate);
  let found: JraOddsHeader | null = null;
  $("div.cell.time strong").each((_, el) => {
    if (found !== null) return;
    const text = $(el).text().replace(/\s+/g, "");
    if (text === "最終オッズ") {
      found = { oddsStatus: "result", officialDatetime: null };
      return;
    }
    const m = /^(\d{1,2})時(\d{1,2})分現在オッズ$/.exec(text);
    if (m !== null) {
      const hh = String(Number(m[1])).padStart(2, "0");
      const mm = String(Number(m[2])).padStart(2, "0");
      found = { oddsStatus: "middle", officialDatetime: `${raceDate} ${hh}:${mm}:00` };
    }
  });
  return found;
}

/** セルの表示テキスト(前後の空白・全角空白を除く)。 */
function cellText($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string {
  return $(el).text().replace(/[\s 　]+/g, " ").trim();
}

/** 馬番(`td.num`)を検証して数値化する。範囲外・非数値の行は null(取消などの未観測の形は読み飛ばさず null にする)。 */
function toUmaban(text: string): number | null {
  if (!/^[0-9]+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_UMABAN ? n : null;
}

/**
 * 単勝オッズの昇順で人気順位を作る(馬番順の頁には人気の列が無いため)。
 * 同じオッズは同じ順位(小さい方。例: 4.3, 4.6, 4.6, 5.0 → 1, 2, 2, 4)。
 * オッズが null・0 以下の馬は順位を持たない(ほかの馬の順位にも数えない)。
 *
 * **JRA の公式の人気と食い違いうる**: 公式の人気順の頁(`op`)で単勝 4.6 倍の馬番 2 と 7 は、ともに 2 位、
 * 次の馬番 14(7.0 倍)は 4 位で、ここで作る順位と一致した(`jra_odds_tanpuku_ninki_202605050208.html`)。
 * ただし観測は 1 レース分だけで、公式が同オッズに別の順位を付ける場合や、表示の丸め(小数 1 桁)の下で
 * 実際の票数順が違う場合は一致しない。公式の人気が要るときは人気順の頁を渡す(`td.pop` を優先する)。
 */
function rankByWinOdds(win: Record<number, WinOdds>): void {
  const usable = Object.entries(win)
    .map(([k, w]) => ({ umaban: Number(k), odds: w.odds }))
    .filter((e): e is { umaban: number; odds: number } => e.odds !== null && e.odds > 0);
  for (const e of usable) {
    const rank = 1 + usable.filter((o) => o.odds < e.odds).length;
    win[e.umaban] = { odds: e.odds, ninki: rank };
  }
}

/**
 * JRA の単勝・複勝の頁(`pw151ou…`/`pw151op…`、`table.tanpuku`)をパースする。
 *
 * - 馬番順の頁(`ou`)は人気の列が無いため、`ninki` は単勝オッズの昇順で作る(`rankByWinOdds`。同オッズは同順位)。
 *   人気順の頁(`op`、`td.pop` がある)は公式の人気を優先する。複勝の `ninki` は同じ馬の単勝の人気と同じ値にする。
 * - 取消馬などでオッズ欄が数値でない行は、オッズ null で残す(構造異常ではない)。
 * - 複勝の幅は `span.min` / `span.max`(netkeiba の `oddsMin` / `oddsMax` と同じ意味)。
 * - 見出しが読めない・表が無い・行が 0 件の頁は `unavailable`(throw しない)。
 *
 * @param html Shift_JIS をデコードした後の頁
 * @param raceDate レースの日付 `YYYY-MM-DD`(JST)。`officialDatetime` を作るのに使う。形が不正なら throw
 */
export function parseJraWinPlaceOdds(html: string, raceDate: string): JraWinPlaceParseResult {
  assertRaceDate(raceDate);
  const $ = cheerio.load(html);
  const header = parseJraOddsHeader($, raceDate);
  if (header === null) {
    return { state: "unavailable", reason: { missing: "header" } };
  }

  const win: Record<number, WinOdds> = {};
  const place: Record<number, PlaceOdds> = {};
  let hasOfficialPop = false;
  $("table.tanpuku tbody tr").each((_, tr) => {
    const umaban = toUmaban(cellText($, $(tr).find("td.num").first()));
    if (umaban === null) return;
    const popText = cellText($, $(tr).find("td.pop").first());
    const pop = popText === "" ? null : toNinki(popText);
    if (pop !== null) hasOfficialPop = true;
    win[umaban] = {
      odds: toOddsNumber(cellText($, $(tr).find("td.odds_tan").first())),
      ninki: pop,
    };
    const fuku = $(tr).find("td.odds_fuku").first();
    place[umaban] = {
      oddsMin: toOddsNumber(cellText($, fuku.find("span.min").first())),
      oddsMax: toOddsNumber(cellText($, fuku.find("span.max").first())),
      ninki: pop,
    };
  });

  if (Object.keys(win).length === 0) {
    return { state: "unavailable", reason: { missing: "table" } };
  }

  if (!hasOfficialPop) {
    rankByWinOdds(win);
    for (const key of Object.keys(place)) {
      const umaban = Number(key);
      place[umaban] = { ...place[umaban]!, ninki: win[umaban]?.ninki ?? null };
    }
  }

  return {
    state: "available",
    snapshot: { officialDatetime: header.officialDatetime, oddsStatus: header.oddsStatus, win, place },
  };
}
