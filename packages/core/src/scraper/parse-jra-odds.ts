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
import {
  buildComboOddsCellMapFor,
  COMBO_SIZE,
  ComboOddsKeyError,
  validateComboUmabansFor,
  type ComboBetType,
  type ComboOddsEntry,
} from "./combo-odds-key.js";
import { ComboOddsParseError, toComboOddsNumber, type ComboOddsParseResult } from "./parse-combo-odds.js";
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

/** 券種 → JRA の頁で組を包む表のクラス(`docs/jra-odds-investigation.md` §4)。確定後の頁の発売票数の表(`div#votes`)を除くための絞り込み。 */
const COMBO_TABLE_SELECTOR: Record<ComboBetType, string> = {
  bracketQuinella: "table.waku",
  quinella: "table.umaren",
  wide: "table.wide",
  exacta: "table.umatan",
  trio: "table.fuku3",
  trifecta: "table.tan3",
};

function comboUnavailable(rawStatus: string | null, missingKey: string | null): ComboOddsParseResult {
  return { state: "unavailable", reason: { rawStatus, rawReason: null, missingKey } };
}

/** 整数だけの文字列を数値化する。それ以外は null。 */
function toInt(text: string): number | null {
  return /^[0-9]+$/.test(text) ? Number(text) : null;
}

/** 枠連の caption(`<img alt="枠1白">`、クラス `waku1`)から枠番を読む。 */
function wakubanOfCaption(caption: ReturnType<CheerioAPI>): number | null {
  const cls = /\bwaku([1-8])\b/.exec(caption.attr("class") ?? "");
  if (cls !== null) return Number(cls[1]);
  const alt = /^枠([1-8])/.exec(caption.find("img").first().attr("alt") ?? "");
  return alt !== null ? Number(alt[1]) : null;
}

/**
 * JRA の組合せオッズの頁(枠連・馬連・ワイド・馬単・3連複・3連単)をパースする。
 * 戻り値・キー形式は `parseComboOdds`(netkeiba)と同じ。
 *
 * - 表のクラスで絞る(`COMBO_TABLE_SELECTOR`)。確定後の頁の発売票数の表は混ざらない。
 * - 組の読み方: 馬連・ワイド=`caption`が若い馬番・`th`が大きい馬番、馬単=`caption`が1着・`th`が2着、
 *   枠連=`caption`が若い枠・`th`が大きい枠(同枠も有効)、3連複=`caption`が`小-中`・`th`が大
 *   (軸馬を指定した頁は caption が中の1頭で、小は `div.fuku3_unit` の見出し)、
 *   3連単=表を包む `li` 直下の2つの `div.p_line` が1着・2着・`th`が3着。
 * - ワイドの値は幅(`span.min` / `span.max`)で `oddsMin` / `oddsMax` に分ける。ほかの券種の `oddsMax` は null。
 * - 人気は頁に無いので常に null。
 * - **空きのセル(`&nbsp;`。自分自身との組・1頭だけの枠の同枠)は組が存在しないのでキーを作らない。**
 *   **票数なし(`td.zero`)のセルは、netkeiba の「数値でない」セルと同じくキーを残して `oddsMin: null`** にする。
 *   全セルが null なら `unavailable`(地方 `parseNarComboOdds` の「全セル0」と同じ扱い)。
 * - 見出しが読めない・券種の表が無い・組が0件の頁は `unavailable`(throw しない)。馬番が範囲外などの構造の壊れは
 *   `ComboOddsParseError` で throw する。
 */
export function parseJraComboOdds(html: string, betType: ComboBetType): ComboOddsParseResult {
  const $ = cheerio.load(html);
  const header = parseJraOddsHeader($, "1970-01-01");
  if (header === null) return comboUnavailable(null, "header");
  const selector = COMBO_TABLE_SELECTOR[betType];
  const tables = $(selector);
  if (tables.length === 0) return comboUnavailable(header.oddsStatus, selector);

  const comboSize = COMBO_SIZE[betType];
  const entries: ComboOddsEntry[] = [];
  tables.each((_, table) => {
    const caption = $(table).find("caption").first();
    const head = headNumbers($, $(table), caption, betType);
    if (head === null) {
      throw new ComboOddsParseError(`caption を読めません(betType=${betType}, 値: "${cellText($, caption)}")`);
    }
    $(table)
      .find("tr")
      .each((__, tr) => {
        const th = toInt(cellText($, $(tr).find("th").first()));
        const td = $(tr).find("td").first();
        if (th === null || td.length === 0) return;
        if (isEmptyCell($, td)) return; // 組が存在しない
        const umabans = [...head, th];
        if (umabans.length !== comboSize) {
          throw new ComboOddsParseError(`組の要素数が券種と一致しません(betType=${betType})`);
        }
        try {
          validateComboUmabansFor(betType, umabans, comboSize);
        } catch (e) {
          if (e instanceof ComboOddsKeyError) throw new ComboOddsParseError(e.message);
          throw e;
        }
        entries.push({ umabans, cell: cellOf($, td, betType) });
      });
  });

  if (entries.length === 0 || entries.every((e) => e.cell.oddsMin === null)) {
    return comboUnavailable(header.oddsStatus, null);
  }
  try {
    return { state: "available", odds: buildComboOddsCellMapFor(betType, entries) };
  } catch (e) {
    if (e instanceof ComboOddsKeyError) throw new ComboOddsParseError(e.message);
    throw e;
  }
}

/** 表の caption が示す、組の先頭側の番号(`th` の前に付く要素)。読めなければ null。 */
function headNumbers(
  $: CheerioAPI,
  table: ReturnType<CheerioAPI>,
  caption: ReturnType<CheerioAPI>,
  betType: ComboBetType,
): number[] | null {
  if (betType === "trio") {
    const text = cellText($, caption);
    const m = /^([0-9]+)-([0-9]+)$/.exec(text);
    if (m !== null) return [Number(m[1]), Number(m[2])];
    // 軸馬を指定した頁(`Z01` など)は caption が中の1頭だけで、軸馬は組を包む `div.fuku3_unit` の見出し(`h4 .num`)にある。
    const mid = toInt(text);
    const axis = toInt(cellText($, table.closest("div.fuku3_unit").find("h4 .num").first()));
    return mid === null || axis === null ? null : [axis, mid];
  }
  if (betType === "trifecta") {
    // 1着・2着は表の外(同じ li の直下の div.p_line)にある。caption の p_line は3着の見出しで、ここには含まない。
    const nums = table
      .closest("li")
      .children("div.p_line")
      .find(".num")
      .map((_, el) => toInt(cellText($, $(el))))
      .get();
    return nums.length === 2 && nums.every((n): n is number => n !== null) ? nums : null;
  }
  if (betType === "bracketQuinella") {
    const w = wakubanOfCaption(caption);
    return w === null ? null : [w];
  }
  const n = toInt(cellText($, caption));
  return n === null ? null : [n];
}

/** 空きのセル(`&nbsp;` だけ)か。票数なし(`td.zero`)は空きではない。 */
function isEmptyCell($: CheerioAPI, td: ReturnType<CheerioAPI>): boolean {
  return !td.hasClass("zero") && cellText($, td) === "";
}

/** セルの値。ワイドは幅、それ以外は単一値。票数なし・非数値は null。 */
function cellOf($: CheerioAPI, td: ReturnType<CheerioAPI>, betType: ComboBetType): ComboOddsEntry["cell"] {
  if (betType === "wide") {
    const oddsMin = toComboOddsNumber(cellText($, td.find("span.min").first()));
    const max = toComboOddsNumber(cellText($, td.find("span.max").first()));
    return { oddsMin, oddsMax: max === 0 ? null : max, ninki: null };
  }
  return { oddsMin: toComboOddsNumber(cellText($, td)), oddsMax: null, ninki: null };
}
