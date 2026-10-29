/**
 * 統計モデルの見直し用の書き出し(Issue #266)を、開発側で読み込んで型つきの行にするローダ。#258 の第 2 段(重みの当て直し。当てる側と確かめる側の分割・ブートストラップ)の入力。
 * 当て直しの分析そのものはここでは作らない(#258 の範囲)。
 *
 * ファイルは管理者が `GET /api/export/prior-dataset` でダウンロードした `prior-dataset-YYYYMMDD-HHMM.ndjson.gz`(NDJSON を gzip の複数メンバーで連結したもの。形式は
 * `cloud/src/prior-export-format.ts`)。先頭行がメタ(`{"_meta": {...}}`)、以降が 1 行 1 頭。
 *
 * **黙って捨てない**: 読めない版・メタ行の無いファイル・件数の食い違い(途中で切れた/混ざった)・壊れた行(JSON でない・列の過不足・型の違い)は、行番号つきの例外にする。
 *
 * **形式 v1〜v4 をすべて読む**(Issue #341・#421・#526)。v1(19 列)の行は、v2 で足した 11 列(出馬表の列)・v3 で足した 2 列(レースの条件)・v4 で足した 2 列(今回の騎手の名前と ID)を null に補い、
 * v2(30 列)の行は v3・v4 の 4 列を、v3(32 列)の行は v4 の 2 列を null に補って、v4 の型の行にする。`meta.format` は元の版のまま。
 * 列の過不足は版ごとに検査する(古い版に新しい版の列があれば「知らない列」、新しい版に足りなければ「列が足りません」。**v2 と名乗るファイルに v1 の行が混ざっても、v4 と名乗るファイルに v3 の行が混ざっても、黙って古い版として読まず例外**)。
 * 古い版を読んだときの「全部 null」を欠損と取り違えないよう、{@link v2ColumnCoverage}・{@link v3ColumnCoverage}・{@link v4ColumnCoverage} で v2〜v4 の列の非 null の件数を見られる(CLI の要約にも出す)。
 *
 * 使い方(リポジトリのルートで): `pnpm tsx scripts/prior-dataset.ts <ファイル>` で要約(行数・レース数・区分別・欠落の件数)を出す。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { PRIOR_ROW_KEYS, PRIOR_ROW_KEYS_V1, PRIOR_ROW_KEYS_V2_ADDED, PRIOR_ROW_KEYS_V3_ADDED, PRIOR_ROW_KEYS_V4_ADDED, type PriorDatasetRow } from "../cloud/src/prior-export-format.js";

export type { PriorDatasetRow } from "../cloud/src/prior-export-format.js";

/** メタ行の中身(書き出し時に付けたもの)。 */
export interface PriorDatasetMeta {
  readonly format: number;
  readonly generatedAt: string;
  readonly rows: number;
  readonly races: number;
  readonly missingDetail: number;
  readonly excluded: { readonly suspect: number; readonly unknown: number; readonly unchecked: number; readonly superseded: number };
  readonly columns: readonly string[];
  readonly notes: readonly string[];
}

export interface PriorDataset {
  readonly meta: PriorDatasetMeta;
  readonly rows: PriorDatasetRow[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumOrNull = (v: unknown): boolean => v === null || isNum(v);
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === "string";

/** 読める形式の版。 */
const READABLE_FORMATS = [1, 2, 3, 4] as const;

type Format = (typeof READABLE_FORMATS)[number];

/** v2 で足した列の型の検査(v2 の行だけ)。distance・wakuban・age は整数、body_weight・kinryo は有限の数、ほかは文字列。いずれも null あり。 */
function v2Checks(row: Record<string, unknown>): Array<[string, boolean]> {
  const isIntOrNull = (v: unknown): boolean => v === null || Number.isInteger(v);
  return [
    ["race_name", isStrOrNull(row["race_name"])],
    ["grade", isStrOrNull(row["grade"])],
    ["distance", isIntOrNull(row["distance"])],
    ["track_condition", isStrOrNull(row["track_condition"])],
    ["wakuban", isIntOrNull(row["wakuban"])],
    ["sex", isStrOrNull(row["sex"])],
    ["age", isIntOrNull(row["age"])],
    ["body_weight", isNumOrNull(row["body_weight"])],
    ["kinryo", isNumOrNull(row["kinryo"])],
    ["oikiri_rank", isStrOrNull(row["oikiri_rank"])],
    ["oikiri_critic", isStrOrNull(row["oikiri_critic"])],
  ];
}

/** v3 で足した列の型の検査(v3 の行だけ)。weight_type は文字列、fillies_only は真偽値。いずれも null あり。 */
function v3Checks(row: Record<string, unknown>): Array<[string, boolean]> {
  return [
    ["weight_type", isStrOrNull(row["weight_type"])],
    ["fillies_only", row["fillies_only"] === null || typeof row["fillies_only"] === "boolean"],
  ];
}

/** v4 で足した列の型の検査(v4 の行だけ)。jockey_name・jockey_id はいずれも文字列(null あり。ID は "01001" のような先頭 0 を含む文字列で、数に直さない)。 */
function v4Checks(row: Record<string, unknown>): Array<[string, boolean]> {
  return [
    ["jockey_name", isStrOrNull(row["jockey_name"])],
    ["jockey_id", isStrOrNull(row["jockey_id"])],
  ];
}

/** 版ごとの列(1 は v1 の 19 列、2 は v2 の 30 列、3 は v3 の 32 列、4 は v4 の 34 列)。 */
const KEYS_BY_FORMAT: Readonly<Record<Format, readonly string[]>> = {
  1: PRIOR_ROW_KEYS_V1,
  2: [...PRIOR_ROW_KEYS_V1, ...PRIOR_ROW_KEYS_V2_ADDED],
  3: [...PRIOR_ROW_KEYS_V1, ...PRIOR_ROW_KEYS_V2_ADDED, ...PRIOR_ROW_KEYS_V3_ADDED],
  4: PRIOR_ROW_KEYS,
};

/** 行 1 つの列・型を検査する(`format` はメタ行の版。{@link KEYS_BY_FORMAT})。問題があれば理由の文字列、なければ null。 */
function rowProblem(row: unknown, format: Format): string | null {
  if (!isObject(row)) return "オブジェクトではありません";
  const expected: readonly string[] = KEYS_BY_FORMAT[format];
  const keys = Object.keys(row);
  const missing = expected.filter((k) => !keys.includes(k));
  if (missing.length > 0) return `列が足りません(${missing.join("・")})`;
  const extra = keys.filter((k) => !expected.includes(k));
  if (extra.length > 0) return `知らない列があります(${extra.join("・")})`;
  const checks: Array<[string, boolean]> = [
    ["analysis_id", Number.isInteger(row["analysis_id"])],
    ["race_id", typeof row["race_id"] === "string"],
    ["kaisai_date", isStrOrNull(row["kaisai_date"])],
    ["venue_kind", row["venue_kind"] === "central" || row["venue_kind"] === "nar"],
    ["course_type", isStrOrNull(row["course_type"])],
    ["field_size", Number.isInteger(row["field_size"])],
    ["umaban", Number.isInteger(row["umaban"])],
    ["prior", isNum(row["prior"])],
    ["adjusted_prob", isNum(row["adjusted_prob"])],
    ["place_odds_min", isNumOrNull(row["place_odds_min"])],
    ["finish_position", isNumOrNull(row["finish_position"])],
    ["win_odds", isNumOrNull(row["win_odds"])],
    ["ninki", isNumOrNull(row["ninki"])],
    ["prompt_version", isStrOrNull(row["prompt_version"])],
    ["analyzed_at", typeof row["analyzed_at"] === "string"],
    ["ev_estimated", typeof row["ev_estimated"] === "boolean"],
    ["prompt_lookahead_guarded", row["prompt_lookahead_guarded"] === null || typeof row["prompt_lookahead_guarded"] === "boolean"],
    ["leak_class", row["leak_class"] === "guarded" || row["leak_class"] === "pre_race"],
    [
      "contributions",
      row["contributions"] === null ||
        (Array.isArray(row["contributions"]) &&
          (row["contributions"] as unknown[]).every(
            (c) =>
              isObject(c) &&
              typeof c["biasName"] === "string" &&
              typeof c["applied"] === "boolean" &&
              ["weight", "correction", "sampleCount", "targetRate", "overallRate"].every((k) => isNumOrNull(c[k])),
          )),
    ],
  ];
  if (format >= 2) checks.push(...v2Checks(row));
  if (format >= 3) checks.push(...v3Checks(row));
  if (format === 4) checks.push(...v4Checks(row));
  const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
  return bad.length > 0 ? `型が違います(${bad.join("・")})` : null;
}

/** v2 で足した列をすべて null にしたもの(v1 の行に補う)。 */
const V2_NULLS: Readonly<Record<string, null>> = Object.fromEntries(PRIOR_ROW_KEYS_V2_ADDED.map((k) => [k, null]));
/** v3 で足した列をすべて null にしたもの(v1・v2 の行に補う)。 */
const V3_NULLS: Readonly<Record<string, null>> = Object.fromEntries(PRIOR_ROW_KEYS_V3_ADDED.map((k) => [k, null]));
/** v4 で足した列をすべて null にしたもの(v1〜v3 の行に補う)。 */
const V4_NULLS: Readonly<Record<string, null>> = Object.fromEntries(PRIOR_ROW_KEYS_V4_ADDED.map((k) => [k, null]));

/** gzip(複数メンバー可)のバイト列から読む。 */
export function parsePriorDataset(bytes: Uint8Array): PriorDataset {
  const lines = new TextDecoder().decode(gunzipSync(bytes)).split("\n");
  if (lines.at(-1) === "") lines.pop();
  let head: unknown;
  try {
    head = lines.length === 0 ? undefined : JSON.parse(lines[0]!);
  } catch {
    head = undefined;
  }
  if (!isObject(head) || !isObject(head["_meta"])) {
    throw new Error("先頭行がメタ行(_meta)ではありません。書き出しのファイルではない可能性があります");
  }
  const meta = head["_meta"] as unknown as PriorDatasetMeta;
  const format = (READABLE_FORMATS as readonly unknown[]).includes(meta.format) ? (meta.format as Format) : null;
  if (format === null) {
    throw new Error(`読めない版のファイルです(format ${String(meta.format)}。このローダは ${READABLE_FORMATS.join("・")} を読みます)`);
  }
  const rows: PriorDatasetRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      throw new Error(`${i + 1} 行目が JSON ではありません`);
    }
    const problem = rowProblem(parsed, format);
    if (problem !== null) {
      throw new Error(`${i + 1} 行目: ${problem}`);
    }
    // 古い版の行は、足りない版の列を null に補って v4 の型にする(元の列の値は変えない。列の順序は PRIOR_ROW_KEYS)。
    const padding = format === 1 ? { ...V2_NULLS, ...V3_NULLS, ...V4_NULLS } : format === 2 ? { ...V3_NULLS, ...V4_NULLS } : format === 3 ? V4_NULLS : {};
    rows.push((format === 4 ? parsed : { ...(parsed as Record<string, unknown>), ...padding }) as PriorDatasetRow);
  }
  if (rows.length !== meta.rows) {
    throw new Error(`件数が合いません(メタ行は ${String(meta.rows)} 行、実際は ${rows.length} 行。途中で切れたか、別のファイルが混ざった可能性があります)`);
  }
  return { meta, rows };
}

export function loadPriorDataset(file: string): PriorDataset {
  return parsePriorDataset(new Uint8Array(readFileSync(file)));
}

/** `history_cutoff_date` ありの母集団(先読みの遮断済み)だけ。`pre_race`(遮断なしだが分析が発走より前)を含めない。 */
export function guardedOnly(rows: readonly PriorDatasetRow[]): PriorDatasetRow[] {
  return rows.filter((r) => r.leak_class === "guarded");
}

/** レースごとに行を束ねる(出現順を保つ)。 */
export function groupByRace(rows: readonly PriorDatasetRow[]): Map<string, PriorDatasetRow[]> {
  const map = new Map<string, PriorDatasetRow[]>();
  for (const row of rows) {
    const group = map.get(row.race_id);
    if (group === undefined) map.set(row.race_id, [row]);
    else group.push(row);
  }
  return map;
}

export interface PriorDatasetSummary {
  readonly rows: number;
  readonly races: number;
  readonly byVenueKind: { readonly central: number; readonly nar: number };
  readonly byLeakClass: { readonly guarded: number; readonly pre_race: number };
  /** 寄与度(contributions)が null の行(詳細〈R2〉が無い・読めないレース。または分析に寄与度の記録が無い馬)。 */
  readonly withoutContributions: number;
  /** 着順が null の行(中止・取消・除外のいずれか。区別できない)。 */
  readonly withoutFinish: number;
}

export function summarize(rows: readonly PriorDatasetRow[]): PriorDatasetSummary {
  return {
    rows: rows.length,
    races: new Set(rows.map((r) => r.race_id)).size,
    byVenueKind: { central: rows.filter((r) => r.venue_kind === "central").length, nar: rows.filter((r) => r.venue_kind === "nar").length },
    byLeakClass: { guarded: rows.filter((r) => r.leak_class === "guarded").length, pre_race: rows.filter((r) => r.leak_class === "pre_race").length },
    withoutContributions: rows.filter((r) => r.contributions === null).length,
    withoutFinish: rows.filter((r) => r.finish_position === null).length,
  };
}

/**
 * v2 で足した 11 列ごとの、非 null の行数(キーの順は `PRIOR_ROW_KEYS_V2_ADDED`)。v1 のファイルを読むと全列 0。
 * v1 を v2 の型で読んだときの全 null を欠損と取り違えない・列ごとの欠けの多さ(地方の調教など)を見るために使う。
 */
export function v2ColumnCoverage(rows: readonly PriorDatasetRow[]): Record<(typeof PRIOR_ROW_KEYS_V2_ADDED)[number], number> {
  return Object.fromEntries(PRIOR_ROW_KEYS_V2_ADDED.map((k) => [k, rows.filter((r) => r[k] !== null).length])) as Record<(typeof PRIOR_ROW_KEYS_V2_ADDED)[number], number>;
}

/**
 * v3 で足した 2 列ごとの、非 null の行数(キーの順は `PRIOR_ROW_KEYS_V3_ADDED`)。v1・v2 のファイルを読むと全列 0。
 * 地方・読めなかったレース・この項目を保存する前の旧スナップショットは null なので、中央の新しい分析の件数を見る目安になる。
 */
export function v3ColumnCoverage(rows: readonly PriorDatasetRow[]): Record<(typeof PRIOR_ROW_KEYS_V3_ADDED)[number], number> {
  return Object.fromEntries(PRIOR_ROW_KEYS_V3_ADDED.map((k) => [k, rows.filter((r) => r[k] !== null).length])) as Record<(typeof PRIOR_ROW_KEYS_V3_ADDED)[number], number>;
}

/**
 * v4 で足した 2 列ごとの、非 null の行数(キーの順は `PRIOR_ROW_KEYS_V4_ADDED`)。v1〜v3 のファイルを読むと全列 0。
 * `jockey_id` は 2026-10-29 より前の分析・騎手のリンクが無い馬で null、`jockey_name` は騎手未定・詳細が無いレースで null なので、実際に使える件数の目安になる。
 */
export function v4ColumnCoverage(rows: readonly PriorDatasetRow[]): Record<(typeof PRIOR_ROW_KEYS_V4_ADDED)[number], number> {
  return Object.fromEntries(PRIOR_ROW_KEYS_V4_ADDED.map((k) => [k, rows.filter((r) => r[k] !== null).length])) as Record<(typeof PRIOR_ROW_KEYS_V4_ADDED)[number], number>;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (file === undefined) {
    console.error("使い方: pnpm tsx scripts/prior-dataset.ts <prior-dataset-*.ndjson.gz>");
    process.exitCode = 1;
  } else {
    const { meta, rows } = loadPriorDataset(file);
    console.log(`生成 ${meta.generatedAt}(形式 ${meta.format})`);
    console.log(`要約: ${JSON.stringify(summarize(rows))}`);
    console.log(`除外: ${JSON.stringify(meta.excluded)}・詳細なしのレース ${meta.missingDetail}`);
    console.log(`v2 の列の非 null の件数${meta.format === 1 ? "(形式 1 のファイルなので全列 0)" : ""}: ${JSON.stringify(v2ColumnCoverage(rows))}`);
    console.log(`v3 の列の非 null の件数${meta.format < 3 ? `(形式 ${meta.format} のファイルなので全列 0)` : ""}: ${JSON.stringify(v3ColumnCoverage(rows))}`);
    console.log(`v4 の列の非 null の件数${meta.format < 4 ? `(形式 ${meta.format} のファイルなので全列 0)` : ""}: ${JSON.stringify(v4ColumnCoverage(rows))}`);
  }
}
