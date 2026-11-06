/**
 * JRA の出馬表(詳細ページ)の読み取り(Issue #639)。**純関数**: ネットワーク・D1・DO に触れない。見本は `fixtures/jra_639_*`(2026-11-06 に取った Shift_JIS の原本)。
 *
 * ## 読むもの
 *  - 開催の選択 `accessD.html`(本文 `cname=pw01dli00/F3`)({@link parseVenueListPage}): 指定の日の場ごとの「レースの選択」(`pw01drl00…`)の CNAME。
 *  - レースの選択({@link parseRaceListPage}): その場・日の詳細ページ(`pw01dde…`)の CNAME。ナビには別の日・別の場のリンクもあるので、場コードと日付で絞る。
 *  - 詳細ページ({@link parseEntryPage}): 馬ごとに、馬の ID(`accessU.html?CNAME=pw01dud00<10 桁>/…` の 10 桁。netkeiba の馬の ID と同じ。#637 で 18 頭が全部一致)・馬名・馬番・
 *    ブリンカー(馬番のセルの `span.horse_icon.blinker`)・減量(今回の騎手の `p.jockey > span.mark.jockey` の `title="3kg減量"`)・マルガイ(馬名の前の `maru-gai.png`)・
 *    父(`li.sire`)・母と母の父(`li.mare`・`span.bloodmare`)・馬主(`p.owner`)・生産者(`p.breeder`)。
 *    確かめられていない印(マルチ・カクチなど)は、詳細ページで載り方を確かめていないので読まない。
 *
 * ## 速さのために正規表現で読む(HTML のパーサは使わない)
 * 詳細ページは約 25 万バイト(勝負服の画像を base64 で埋め込む)。DOM を作らず、馬ごとの行(`<td class="waku"` から `<td class="past` まで)を切り出して読む。
 * **過去 5 年の成績の表**(`td.horse` が並ぶが `td.waku` が無い)と、馬柱の過去の走りの騎手(`div.jockey`)は、行の切り出しで構造的に除かれる。
 *
 * ## 失敗の判定(状態コードだけでは足りない)
 * CNAME の末尾の符号が違うと、HTTP 200 で「パラメータエラー」のページが返る。{@link parseEntryPage} は、<title> がそれなら `param-error`、
 * 馬の行が 1 頭も読めなければ `shape-mismatch`、ページの日付・場・回・日目・R が取りに行った CNAME と合わなければ `race-mismatch`。
 *
 * ## 秘匿・上限
 * 外部の文章(馬名・血統・馬主・生産者)は、HTML の実体参照を戻し、制御文字を除き、長さを切る。
 */
import { VENUE_BY_TRACK_CODE } from "../../packages/core/src/analysis/venue-codes";

/** 馬名・血統・馬主・生産者の文字数の上限。 */
export const JRA_ENTRY_TEXT_LIMIT = 64;

/** レースの CNAME(`pw01dde…`)を分解したもの。 */
export interface JraRaceCname {
  /** JRA の場コード 2 桁(netkeiba の race_id の 5〜6 桁目と同じ)。 */
  readonly venueCode: string;
  readonly year: string;
  readonly kai: string;
  readonly day: string;
  readonly race: string;
  /** 開催日 YYYYMMDD。 */
  readonly date: string;
  /** netkeiba の race_id(年 + 場 + 回 + 日目 + R の 12 桁)。 */
  readonly raceId: string;
}

const RACE_CNAME = /^pw01dde(\d{2})(\d{2})(\d{4})(\d{2})(\d{2})(\d{2})(\d{8})\/[0-9A-F]{2}$/;

/** `pw01dde` + `01` + 場 + 年 + 回 + 日目 + R + 開催日 + `/` + 符号。形が違えば null。 */
export function parseRaceCname(cname: string): JraRaceCname | null {
  const m = RACE_CNAME.exec(cname);
  if (m === null) {
    return null;
  }
  const [, , venueCode, year, kai, day, race, date] = m as unknown as [string, string, string, string, string, string, string, string];
  return { venueCode, year, kai, day, race, date, raceId: `${year}${venueCode}${kai}${day}${race}` };
}

/** 場ごとの「レースの選択」への入口。 */
export interface JraVenueLink {
  readonly venueCode: string;
  readonly drlCname: string;
}

/** `pw01drl00` + 場 2 桁 + 年 4 桁 + 回 2 桁 + 日目 2 桁 + 開催日 8 桁 + `/` + 符号。 */
const DRL_CNAME_GLOBAL = /pw01drl00(\d{2})\d{4}\d{2}\d{2}(\d{8})\/[0-9A-F]{2}/g;

/** 開催の選択のページから、指定の日の場ごとの CNAME を、場コードの順に返す(重複は 1 つ)。 */
export function parseVenueListPage(html: string, date: string): readonly JraVenueLink[] {
  const found = new Map<string, string>();
  for (const m of html.matchAll(DRL_CNAME_GLOBAL)) {
    if (m[2] === date && !found.has(m[1]!)) {
      found.set(m[1]!, m[0]);
    }
  }
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([venueCode, drlCname]) => ({ venueCode, drlCname }));
}

const DDE_CNAME_GLOBAL = /pw01dde\d{2}\d{2}\d{4}\d{2}\d{2}\d{2}\d{8}\/[0-9A-F]{2}/g;

/** レースの選択のページから、指定の場・日の詳細ページの CNAME を、R の順に返す(R の重複は先の 1 つ)。 */
export function parseRaceListPage(html: string, date: string, venueCode: string): readonly string[] {
  const byRace = new Map<string, string>();
  for (const m of html.matchAll(DDE_CNAME_GLOBAL)) {
    const parsed = parseRaceCname(m[0]);
    if (parsed !== null && parsed.date === date && parsed.venueCode === venueCode && !byRace.has(parsed.race)) {
      byRace.set(parsed.race, m[0]);
    }
  }
  return [...byRace.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, cname]) => cname);
}

/** 符号が違うときに HTTP 200 で返る「パラメータエラー」のページか(<title> で見る)。 */
export function isParamErrorPage(html: string): boolean {
  const title = /<title>([^<]*)<\/title>/.exec(html);
  return title !== null && title[1]!.includes("パラメータエラー");
}

/** 詳細ページの馬 1 頭。 */
export interface JraEntryHorse {
  /** netkeiba の馬の ID と同じ 10 桁。 */
  readonly horseId: string;
  readonly name: string;
  /** 馬番。まだ決まっていなければ null。 */
  readonly umaban: number | null;
  readonly blinker: boolean;
  /** 今回の騎手の減量(kg)。無ければ 0。 */
  readonly reductionKg: number;
  /** 馬名の前のマルガイ(外国産馬)の印。 */
  readonly foreignMark: boolean;
  readonly sire: string;
  readonly dam: string;
  readonly damSire: string;
  readonly owner: string;
  readonly breeder: string;
}

export type ParseEntryResult =
  | { readonly status: "ok"; readonly horses: readonly JraEntryHorse[]; /** 馬の ID が 10 桁でない・馬名が読めないなどで保存しなかった行の数。 */ readonly skipped: number }
  | { readonly status: "param-error" | "shape-mismatch" | "race-mismatch" };

/** HTML の実体参照を戻す(使うのは名前付き 5 種と数値参照だけ)。 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    const code = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** タグを除き、実体参照を戻し、制御文字を除き、前後の空白を落とし、長さを切る。 */
function cleanText(fragment: string): string {
  // eslint-disable-next-line no-control-regex
  return decodeEntities(fragment.replace(/<[^>]*>/g, "")).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, JRA_ENTRY_TEXT_LIMIT);
}

function textOf(row: string, pattern: RegExp): string {
  const m = pattern.exec(row);
  return m === null ? "" : cleanText(m[1]!);
}

const ROW_START = '<td class="waku"';
const PAST_START = '<td class="past';

/** 馬 1 頭の行(`<td class="waku"` から `<td class="past` の手前まで)。 */
function readRow(row: string): JraEntryHorse | null {
  const idMatch = /<a href="[^"]*accessU\.html\?CNAME=pw01dud00([^"/]*)\/[0-9A-F]{2}"[^>]*>([^<]*)<\/a>/.exec(row);
  if (idMatch === null || !/^\d{10}$/.test(idMatch[1]!)) {
    return null;
  }
  const name = cleanText(idMatch[2]!);
  if (name === "") {
    return null;
  }
  const numCell = /<td class="num">\s*(\d*)([\s\S]*?)<\/td>/.exec(row);
  const umaban = numCell !== null && numCell[1] !== "" ? Number(numCell[1]) : null;
  const blinker = numCell !== null && /class="horse_icon blinker"/.test(numCell[2]!);
  // 馬名のセル(td.horse)の中の、馬名の前にある印。
  const horseCell = /<td class="horse">([\s\S]*?)<\/td>/.exec(row)?.[1] ?? "";
  const foreignMark = /<span class="horse_icon"><img src="[^"]*kigo\/maru-gai\.png"/.test(horseCell);
  // 今回の騎手(td.jockey の p.jockey)の減量。馬柱の過去の走りは `<td class="past` 以降なので、この行には入らない。
  const reduction = /<p class="jockey"><span title="(\d+(?:\.\d+)?)kg減量" class="mark jockey">/.exec(row);
  return {
    horseId: idMatch[1]!,
    name,
    umaban,
    blinker,
    reductionKg: reduction === null ? 0 : Number(reduction[1]),
    foreignMark,
    sire: textOf(row, /<li class="sire"><span>父：<\/span>([\s\S]*?)<\/li>/),
    dam: textOf(row, /<li class="mare"><span>母：<\/span>([\s\S]*?)<span class="bloodmare">/),
    damSire: textOf(row, /<span class="bloodmare">\(母の父：([\s\S]*?)\)<\/span>/),
    owner: textOf(row, /<p class="owner">([\s\S]*?)<\/p>/),
    breeder: textOf(row, /<p class="breeder">([\s\S]*?)<\/p>/),
  };
}

/** ページの日付・場・回・日目・R が、取りに行ったレースと合うか。 */
function matchesRace(html: string, expected: JraRaceCname): boolean {
  const head = /<div class="race_header">[\s\S]*?<div class="race_title">[\s\S]*?<div class="race_number"><img [^>]*alt="(\d+)レース"/.exec(html);
  const when = /<div class="cell date">\s*(\d{4})年(\d{1,2})月(\d{1,2})日[^<]*?(\d+)回(\S+?)(\d+)日\s*<\/div>/.exec(html);
  if (head === null || when === null) {
    return false;
  }
  const date = `${when[1]}${when[2]!.padStart(2, "0")}${when[3]!.padStart(2, "0")}`;
  return (
    Number(head[1]) === Number(expected.race) &&
    date === expected.date &&
    Number(when[4]) === Number(expected.kai) &&
    Number(when[6]) === Number(expected.day) &&
    when[5] === VENUE_BY_TRACK_CODE.get(expected.venueCode)
  );
}

/** 詳細ページを読む。例外は投げない。 */
export function parseEntryPage(html: string, expected: JraRaceCname): ParseEntryResult {
  if (isParamErrorPage(html)) {
    return { status: "param-error" };
  }
  // 出馬表の表(`<div id="syutsuba">` 以降)だけを見る。
  const start = html.indexOf('<div id="syutsuba">');
  if (start < 0) {
    return { status: "shape-mismatch" };
  }
  const body = html.slice(start);
  const rows = body.split(ROW_START).slice(1);
  const horses: JraEntryHorse[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const raw of rows) {
    const end = raw.indexOf(PAST_START);
    const horse = readRow(end < 0 ? raw : raw.slice(0, end));
    if (horse === null || seen.has(horse.horseId)) {
      skipped += 1;
      continue;
    }
    seen.add(horse.horseId);
    horses.push(horse);
  }
  if (horses.length === 0) {
    return { status: "shape-mismatch" };
  }
  if (!matchesRace(html, expected)) {
    return { status: "race-mismatch" };
  }
  return { status: "ok", horses, skipped };
}
