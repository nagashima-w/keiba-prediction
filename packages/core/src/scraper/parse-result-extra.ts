/**
 * 結果ページ(result.html)の補助パーサ。Issue #532(過去 5 年の結果を取って仮説の検証に使う)。#549-A1 で `scripts/history-results/result-extra.ts` から core へ移した(開発用スクリプトと、本番の Cloudflare の取得〈#549-A3〉の両方から使う)。
 *
 * 既存の `parseRaceResult`(packages/core)は着順・通過順・後3F・人気・単勝オッズ・払戻を読む。ここでは、それが読まない
 * 項目(騎手名と騎手 ID・斤量・性齢・馬体重と増減・horse_id・調教師 ID と所属・タイム・着差、見出しの日付・天候・馬場・
 * コース・距離・回り・クラス・格・重量種別など)を読む。
 *
 * 読み方の方針(parse-race-result.ts と同じ流儀):
 * - 表の列は**ヘッダの文字から位置を決める**(中央と地方で列の数と class が違う。地方は「コーナー通過順」が無く 14 列)。
 * - 行の td の数がヘッダの th の数と一致しない行は、位置で読む項目(斤量・性齢・タイム・着差・馬体重など)を null にする。
 *   行は捨てない。リンクから読む項目(horse_id・騎手 ID・調教師 ID)と、行内の構造から読む項目(着順の生の文字・所属)は、
 *   位置に依らないので読む。
 * - ヘッダに無い列(取得する年代で表が変わる場合)は、その項目を全行で null にして `missingColumns` に載せる。
 *   馬番・馬名・着順の列が無いときは、行の対応が取れないので例外にする(黙って値を作らない)。
 * - 見出し(日付・天候・馬場・回り)は、中央の新しい形(アイコンの aria-label・Item の span)と、地方の旧い形
 *   (`天候:晴`・`馬場:良`)の両方を読む。馬場の span の class 番号(Item03・Item04…)は馬場の状態で変わるので使わない。
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { RaceIdVenueKind } from "./ids.js";
import { readRaceClass } from "./race-class.js";
import { readRaceConditions, type WeightType } from "./race-condition.js";

/** 補助パーサの構造異常(結果の表が無い・行の対応が取れない)。`category` は parse の「読めなかった理由」の分類。 */
export class ResultExtraError extends Error {
  constructor(
    message: string,
    readonly category: "構造異常" | "ヘッダ不足" = "構造異常",
  ) {
    super(message);
    this.name = "ResultExtraError";
  }
}

export interface ExtraHeader {
  /** `YYYY-MM-DD`(`<title>` の `2021年10月31日` から)。読めなければ null。 */
  readonly date: string | null;
  readonly venueName: string | null;
  readonly raceNumber: number | null;
  /** レース名(`.RaceName` の本文。中央は h1・地方は div。格のアイコンの文字は除く)。 */
  readonly name: string | null;
  /** 格。`<title>` の括弧(G1・G2・G3・JG1〜3・Jpn1〜3・L)。無ければ null。 */
  readonly grade: string | null;
  readonly startTime: string | null;
  readonly courseType: "芝" | "ダ" | "障" | null;
  readonly distance: number | null;
  readonly direction: "左" | "右" | "直線" | null;
  /** 回りの後ろの文字(`B`・`外` など)。障害の `芝` もここに入る。 */
  readonly courseDetail: string | null;
  readonly weather: string | null;
  /** 良・稍重・重・不良のいずれか(span の `稍`・`不` の略記は正規形に直す)。読めなければ null。 */
  readonly going: "良" | "稍重" | "重" | "不良" | null;
  /** 馬場として拾った生の文字(`稍` など)。 */
  readonly goingRaw: readonly string[];
  /** `<link rel="canonical">` の race_id(ページ自身が名乗る ID。無ければ null)。 */
  readonly canonicalRaceId: string | null;
  readonly kai: number | null;
  readonly nichime: number | null;
  readonly fieldSizeDeclared: number | null;
  readonly raceClass: string | null;
  readonly weightType: WeightType | null;
  readonly filliesOnly: boolean;
  /** `.RaceData02` の span の生の文字(空は除く)。 */
  readonly raceData02Spans: readonly string[];
}

export interface ExtraRow {
  readonly finishRaw: string;
  readonly wakuban: number | null;
  readonly umaban: number | null;
  readonly horseId: string | null;
  readonly horseName: string | null;
  readonly sexAgeRaw: string | null;
  readonly sex: "牡" | "牝" | "セ" | null;
  readonly age: number | null;
  readonly burden: number | null;
  readonly jockeyId: string | null;
  readonly jockeyName: string | null;
  /** 減量騎手の印(▲△☆◇)。 */
  readonly jockeyMark: string | null;
  readonly timeRaw: string | null;
  readonly timeSec: number | null;
  readonly marginRaw: string | null;
  readonly trainerId: string | null;
  readonly trainerName: string | null;
  /** 所属(中央は美浦・栗東、地方は所属場)。 */
  readonly trainerArea: string | null;
  readonly bodyWeight: number | null;
  readonly bodyWeightRaw: string | null;
  readonly bodyWeightDiff: number | null;
  readonly bodyWeightDiffRaw: string | null;
  /** この行の td の数がヘッダの th の数と一致したか。false の行は位置で読む項目がすべて null。 */
  readonly cellsAligned: boolean;
}

export interface ResultExtra {
  readonly header: ExtraHeader;
  readonly rows: ExtraRow[];
  /** ヘッダに無かった列(例: 地方の「コーナー通過順」)。 */
  readonly missingColumns: string[];
}

/** nbsp を空白にし、空白を詰めて trim する。 */
function norm(raw: string): string {
  return raw.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** すべての空白を除く(ヘッダの文字の比較用。`着<br>順` は `着順` になる)。 */
function compact(raw: string): string {
  return raw.replace(/[\s ]+/g, "");
}

function intOrNull(raw: string | undefined): number | null {
  return raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : null;
}

function numberOrNull(raw: string): number | null {
  const t = norm(raw);
  return /^[0-9]+(\.[0-9]+)?$/.test(t) ? Number(t) : null;
}

/** `1:57.9` → 117.9、`59.8` → 59.8。読めなければ null。 */
export function toTimeSec(raw: string): number | null {
  const t = norm(raw);
  const m = /^(\d+):(\d{2})\.(\d)$/.exec(t);
  if (m) {
    return (Number(m[1]) * 600 + Number(m[2]) * 10 + Number(m[3])) / 10;
  }
  const s = /^(\d{1,2})\.(\d)$/.exec(t);
  return s ? (Number(s[1]) * 10 + Number(s[2])) / 10 : null;
}

const GOING_MAP: Readonly<Record<string, ExtraHeader["going"]>> = {
  良: "良",
  稍: "稍重",
  稍重: "稍重",
  重: "重",
  不: "不良",
  不良: "不良",
};

function parseHeader($: CheerioAPI, kind: RaceIdVenueKind): ExtraHeader {
  // title: `天皇賞（秋）(G1) 結果・払戻 | 2021年10月31日 東京11R レース情報(JRA) - netkeiba`
  const title = norm($("title").first().text());
  const dm = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(title);
  const date = dm ? `${dm[1]}-${dm[2]!.padStart(2, "0")}-${dm[3]!.padStart(2, "0")}` : null;
  const vm = /\d{1,2}日\s*([^\s\d]+?)(\d{1,2})R/.exec(title);
  const gm = /\((G[123]|JG[123]|Jpn[123]|L)\)/.exec(title);

  const $h1 = $(".RaceName").first().clone();
  $h1.find("*").remove();
  const name = norm($h1.text()) || null;

  const $d1 = $(".RaceData01").first();
  const d1 = $d1.text().replace(/ /g, " ");
  const segments = d1.split("/");
  const tm = /(\d{1,2}):(\d{2})発走/.exec(d1);
  const courseSeg = segments.find((s) => /(芝|ダ|障)\s*\d+\s*m/.test(s)) ?? "";
  const cm = /(芝|ダ|障)\s*(\d+)\s*m/.exec(courseSeg);
  const rest = cm ? norm(courseSeg.slice(cm.index + cm[0].length)) : "";
  const dirMatch = /(左|右|直線)/.exec(rest);
  const courseDetail = norm(rest.replace(/[()（）]/g, " ").replace(/(左|右|直線)/, " ")) || null;

  const iconWeather = $d1.find("[class*='Icon_Weather'][aria-label]").first().attr("aria-label");
  const weather = iconWeather !== undefined ? norm(iconWeather) : /天候[:：]\s*([^\s/]+)/.exec(d1)?.[1] ?? null;

  const goingRaw: string[] = [];
  $d1.find("span").each((_, el) => {
    const t = norm($(el).text());
    if (t in GOING_MAP) {
      goingRaw.push(t);
    }
  });
  const goingText = /馬場[:：]\s*([^\s/]+)/.exec(d1)?.[1];
  if (goingRaw.length === 0 && goingText !== undefined) {
    goingRaw.push(goingText);
  }

  const spans = $(".RaceData02 span")
    .map((_, el) => norm($(el).text()))
    .get()
    .filter((t) => t !== "");
  const pick = (re: RegExp): number | null => {
    for (const s of spans) {
      const m = re.exec(s);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const cond = readRaceConditions(spans);

  return {
    date,
    venueName: vm ? vm[1]! : null,
    raceNumber: vm ? Number(vm[2]) : null,
    name,
    grade: gm ? gm[1]! : null,
    startTime: tm ? `${tm[1]!.padStart(2, "0")}:${tm[2]}` : null,
    courseType: cm ? (cm[1] as "芝" | "ダ" | "障") : null,
    distance: cm ? Number(cm[2]) : null,
    direction: dirMatch ? (dirMatch[1] as "左" | "右" | "直線") : null,
    courseDetail,
    weather,
    going: goingRaw.length > 0 ? (GOING_MAP[goingRaw[0]!] ?? null) : null,
    goingRaw,
    canonicalRaceId: /race_id=(\d{12})/.exec($('link[rel="canonical"]').first().attr("href") ?? "")?.[1] ?? null,
    kai: pick(/^(\d+)回$/),
    nichime: pick(/^(\d+)日目$/),
    fieldSizeDeclared: pick(/^(\d+)頭$/),
    raceClass: readRaceClass(spans, kind) ?? null,
    weightType: cond.weightType ?? null,
    filliesOnly: cond.filliesOnly,
    raceData02Spans: spans,
  };
}

/** ヘッダの文字(空白を除いたもの)と、欠けたときに報告する列の名前。 */
const OPTIONAL_COLUMNS = [
  "枠",
  "性齢",
  "斤量",
  "騎手",
  "タイム",
  "着差",
  "人気",
  "単勝オッズ",
  "後3F",
  "コーナー通過順",
  "厩舎",
  "馬体重",
] as const;

const MARKS = /^([▲△☆◇★◆])\s*/;

/**
 * 結果ページを補助パーサで読む。
 * @throws ResultExtraError 結果の表が無い、または馬番・馬名・着順の列が無い
 */
export function parseResultExtra(html: string, kind: RaceIdVenueKind): ResultExtra {
  const $ = cheerio.load(html);
  const header = parseHeader($, kind);

  const $table = $("#All_Result_Table").first();
  if ($table.length === 0) {
    throw new ResultExtraError("結果テーブル(#All_Result_Table)が見つかりません");
  }
  const heads = $table
    .find("thead tr")
    .first()
    .find("th")
    .toArray()
    .map((th) => compact($(th).text()));
  const idx = (label: string): number | null => {
    const i = heads.findIndex((h) => (label === "馬体重" ? h.startsWith("馬体重") : h === label));
    return i === -1 ? null : i;
  };
  const iFinish = idx("着順");
  const iUmaban = idx("馬番");
  const iHorse = idx("馬名");
  for (const [label, i] of [
    ["着順", iFinish],
    ["馬番", iUmaban],
    ["馬名", iHorse],
  ] as const) {
    if (i === null) {
      throw new ResultExtraError(`結果テーブルのヘッダに「${label}」の列がありません(ヘッダ: ${heads.join("|")})`, "ヘッダ不足");
    }
  }
  const col = Object.fromEntries(OPTIONAL_COLUMNS.map((l) => [l, idx(l)])) as Record<(typeof OPTIONAL_COLUMNS)[number], number | null>;
  const missingColumns = OPTIONAL_COLUMNS.filter((l) => col[l] === null);

  const rows: ExtraRow[] = [];
  $table.find("tbody > tr").each((_, tr) => {
    const $row = $(tr);
    const $cells = $row.children("td");
    const aligned = heads.length > 0 && $cells.length === heads.length;
    const cell = (i: number | null): string | null => (aligned && i !== null ? $cells.eq(i).text().replace(/ /g, " ") : null);

    // 位置に依らない項目(リンク・行内の構造)
    const $horse = $row.find('a[href*="/horse/"]').first();
    const horseId = /\/horse\/([0-9A-Za-z]+)/.exec($horse.attr("href") ?? "")?.[1] ?? null;
    const horseName = $horse.length > 0 ? norm($horse.attr("title") ?? $horse.text()) : null;
    const $jockey = $row.find('td.Jockey a[href*="/jockey/"]').first();
    const jockeyId = /\/jockey\/result\/recent\/([0-9A-Za-z]+)/.exec($jockey.attr("href") ?? "")?.[1] ?? null;
    const jockeyFull = $jockey.length > 0 ? norm($jockey.text()) : null;
    const markMatch = jockeyFull !== null ? MARKS.exec(jockeyFull) : null;
    const jockeyName = jockeyFull !== null ? jockeyFull.replace(MARKS, "") || null : null;
    const $trainer = $row.find('td.Trainer a[href*="/trainer/"]').first();
    const trainerId = /\/trainer\/result\/recent\/([0-9A-Za-z]+)/.exec($trainer.attr("href") ?? "")?.[1] ?? null;
    const trainerName = $trainer.length > 0 ? norm($trainer.attr("title") ?? $trainer.text()) : null;
    const area = $row.find("td.Trainer").first().find("[class^='Label']").first().text();
    const trainerArea = norm(area) || null;

    // 位置で読む項目
    const num = (i: number | null): number | null => {
      const t = cell(i);
      return t === null ? null : intOrNull(norm(t));
    };
    const sexAgeText = cell(col["性齢"]);
    const sexAgeRaw = sexAgeText === null ? null : compact(sexAgeText);
    const sam = sexAgeRaw === null ? null : /^(牡|牝|セ)(\d+)$/.exec(sexAgeRaw);
    const burdenText = cell(col["斤量"]);
    const timeText = cell(col["タイム"]);
    const marginText = cell(col["着差"]);
    const bwText = cell(col["馬体重"]);
    const bwRaw = bwText === null ? null : compact(bwText);
    const diffRaw = bwRaw === null ? null : (/[(（]([^)）]*)[)）]/.exec(bwRaw)?.[1] ?? "");

    rows.push({
      finishRaw: norm($row.find(".Rank").first().text()),
      wakuban: num(col["枠"]),
      umaban: num(iUmaban),
      horseId,
      horseName,
      sexAgeRaw,
      sex: sam ? (sam[1] as "牡" | "牝" | "セ") : null,
      age: sam ? Number(sam[2]) : null,
      burden: burdenText === null ? null : numberOrNull(burdenText),
      jockeyId,
      jockeyName,
      jockeyMark: markMatch ? markMatch[1]! : null,
      timeRaw: timeText === null ? null : norm(timeText),
      timeSec: timeText === null ? null : toTimeSec(timeText),
      marginRaw: marginText === null ? null : norm(marginText),
      trainerId,
      trainerName,
      trainerArea,
      bodyWeight: bwRaw === null ? null : intOrNull(/^(\d+)/.exec(bwRaw)?.[1]),
      bodyWeightRaw: bwRaw,
      bodyWeightDiff: diffRaw !== null && /^[+-]?\d+$/.test(diffRaw) ? Number(diffRaw) : null,
      bodyWeightDiffRaw: diffRaw,
      cellsAligned: aligned,
    });
  });

  return { header, rows, missingColumns };
}
