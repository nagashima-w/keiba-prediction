import { readFileSync } from "node:fs";
import iconv from "iconv-lite";

import { pathFromMeta } from "./meta-path";

/**
 * Issue #478(#477-B): JRA の馬場のページの読み取り・取得のテストが共有する見本。
 *
 *  - 実物のフィクスチャ(`fixtures/jra_*_20261025.*`)は、2026-10-25(日)に作業環境から JRA へ取得した応答の生のバイト(Shift_JIS)。東京・京都・新潟の 3 場が開催。
 *  - 合成の見本(`cushionHtml` ほか)は、実物と同じ作りの HTML・JSON を Shift_JIS で組み立てる(境界・欠落・失敗の検査用)。
 */

const FIXTURES = pathFromMeta("../../fixtures/", import.meta.url);

/** フィクスチャの生のバイト(Shift_JIS)。 */
export const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(`${FIXTURES}${name}`));

/** フィクスチャを Shift_JIS で読んだ文字列。 */
export const fixtureText = (name: string): string => iconv.decode(Buffer.from(fixtureBytes(name)), "shift_jis");

/** 文字列を実サイトと同じ Shift_JIS のバイト列にする。 */
export const sjis = (text: string): Uint8Array => new Uint8Array(iconv.encode(text, "shift_jis"));

export const FIXTURE_NAMES = {
  cushion: "jra_baba_cushion_20261025.html",
  moist: "jra_baba_moist_20261025.html",
  access: "jra_access_j_20261025.json",
  index1: "jra_baba_index_20261025.html",
  index2: "jra_baba_index2_20261025.html",
  index3: "jra_baba_index3_20261025.html",
} as const;

/** 2026-10-25(日)09:35 JST。本番の取得(09:30 JST)の直後。 */
export const NOW_SUNDAY = Date.parse("2026-10-25T00:35:00.000Z");
/** 2026-10-26(月)09:35 JST。開催の翌日(フィクスチャの計測はどれも前日になる)。 */
export const NOW_MONDAY = Date.parse("2026-10-26T00:35:00.000Z");

/** クッション値のページ(`_data_cushion.html`)を組み立てる。`units` は新しい順の [時刻の文字列, 値の文字列]。 */
export function cushionHtml(venues: readonly { readonly name: string; readonly units: readonly (readonly [string, string])[] }[]): string {
  const body = venues
    .map(
      (v, i) =>
        `<div id="rc${String.fromCharCode(65 + i)}" title="${v.name}">\n\n` +
        v.units.map(([time, value]) => `<div class="unit">\n<div class="time">${time}</div>\n<div class="cushion">${value}</div>\n</div>\n`).join("\n") +
        "\n</div>\n",
    )
    .join("\n");
  return `<div id="cushion_data_list">\n\n\n${body}\n</div>\n`;
}

/** 含水率の 1 面。[ゴール前の値の文字列, ゴール前の data-condition, 4 角の値の文字列, 4 角の data-condition]。 */
export type MoistFace = readonly [string, string, string, string];

export interface MoistUnitSample {
  readonly time: string;
  readonly turf: MoistFace;
  readonly dirt: MoistFace;
  /** `<li>` の注記の文章(「注記：」より後ろ)。 */
  readonly note?: string;
}

/** 含水率のページ(`_data_moist.html`)を組み立てる。`units` は新しい順。 */
export function moistHtml(venues: readonly { readonly name: string; readonly units: readonly MoistUnitSample[] }[]): string {
  const face = (cls: string, f: MoistFace): string =>
    `<div class="${cls}">\n<span class="mg" data-condition="${f[1]}">${f[0]}</span>\n<span class="m4c" data-condition="${f[3]}">${f[2]}</span>\n</div>\n`;
  const body = venues
    .map(
      (v, i) =>
        `<div id="rc${String.fromCharCode(65 + i)}" title="${v.name}">\n\n` +
        v.units
          .map(
            (u) =>
              `<div class="unit">\n<div class="time">${u.time}</div>\n${face("turf", u.turf)}${face("dirt", u.dirt)}<ul class="note_list narrow mt10 moist_caution">\n<li>注記：${u.note ?? "特になし"}</li>\n</ul>\n</div>\n`,
          )
          .join("\n") +
        "\n</div>\n",
    )
    .join("\n");
  return `<div id="moist_data_list">\n\n\n${body}\n</div>\n`;
}

export interface AccessSample {
  readonly jyoname: string;
  readonly kaisai_ymd: string;
  readonly weather?: string;
  readonly ba_s?: unknown;
  readonly ba_d?: unknown;
}

/** 開催情報の JSON(`accessJ.html` の POST の応答)を組み立てる。 */
export function accessJson(items: readonly AccessSample[]): string {
  return JSON.stringify({ kaisai_info: items.map((i) => ({ sort: "A", weather: "曇", ba_s: "", ba_d: "", race: [], ...i })) }, null, 2);
}

export interface CoursePageSample {
  /** 見出し(`馬場情報（○○競馬場）`)の場名。 */
  readonly name: string;
  /** 切り替えタブの場名(`index.html`〜の順)。 */
  readonly tabs: readonly string[];
  readonly usedCourse?: string;
  readonly turfConditionText?: string;
  /** 芝丈の行: [行の見出し, 野芝, 洋芝]。 */
  readonly turfRows?: readonly (readonly [string, string, string])[];
}

/** コースの情報のページ(`index.html`〜)を、実物と同じ要所だけで組み立てる。 */
export function coursePage(s: CoursePageSample): string {
  const tabs = s.tabs
    .map((t, i) => `<div${t === s.name ? ' class="current"' : ""}><a href="index${i === 0 ? "" : String(i + 1)}.html">${t}競馬場</a></div>\n`)
    .join("\n");
  const cell = (v: string): string => (v === "なし" ? '<td><span class="cap">なし</span></td>' : `<td>${v.replace("から", '<span class="cap">から</span>')}</td>`);
  const rows = (s.turfRows ?? [["芝", "10から12", "10から14"]]).map(([h, a, b]) => `<tr>\n<th scope="row">${h}</th>\n${cell(a)}\n${cell(b)}\n</tr>\n`).join("\n");
  return (
    `<html><head><title>馬場情報（${s.name}競馬場）　JRA</title></head><body>\n` +
    `<div class="kaisai_tab">\n<div class="nav tab">\n${tabs}\n</div>\n</div>\n` +
    `<div class="turf_length">\n<table class="basic narrow fixed">\n<thead>\n<tr>\n<th scope="col" class="type"></th>\n<th scope="col">野芝</th>\n<th scope="col">洋芝</th>\n</tr>\n</thead>\n<tbody>\n${rows}</tbody>\n</table>\n</div>\n` +
    `<div class="course">\n<ul class="data_line_list wide">\n<li>\n<div class="data_list_unit">\n<div class="head"><h3>使用コース</h3></div>\n<div class="content"><p>${s.usedCourse ?? "<strong>A</strong>コース（内柵を最内に設置）"}</p>\n</div>\n</div>\n</li>\n</ul>\n</div>\n` +
    `<div class="turf_condition">\n<ul class="data_line_list wide">\n<li>\n<div class="data_list_unit">\n<div class="head"><h3>芝の状態</h3></div>\n<div class="content"><p>${s.turfConditionText ?? "全体に良好です。"}</p></div>\n</div>\n</li>\n</ul>\n</div>\n` +
    `</body></html>\n`
  );
}
