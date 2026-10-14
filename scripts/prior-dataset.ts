/**
 * 統計モデルの見直し用の書き出し(Issue #266)を、開発側で読み込んで型つきの行にするローダ。#258 の第 2 段(重みの当て直し。当てる側と確かめる側の分割・ブートストラップ)の入力。
 * 当て直しの分析そのものはここでは作らない(#258 の範囲)。
 *
 * ファイルは管理者が `GET /api/export/prior-dataset` でダウンロードした `prior-dataset-YYYYMMDD-HHMM.ndjson.gz`(NDJSON を gzip の複数メンバーで連結したもの。形式は
 * `cloud/src/prior-export-format.ts`)。先頭行がメタ(`{"_meta": {...}}`)、以降が 1 行 1 頭。
 *
 * **黙って捨てない**: 読めない版・メタ行の無いファイル・件数の食い違い(途中で切れた/混ざった)・壊れた行(JSON でない・列の過不足・型の違い)は、行番号つきの例外にする。
 *
 * 使い方(リポジトリのルートで): `pnpm tsx scripts/prior-dataset.ts <ファイル>` で要約(行数・レース数・区分別・欠落の件数)を出す。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { PRIOR_EXPORT_FORMAT, PRIOR_ROW_KEYS, type PriorDatasetRow } from "../cloud/src/prior-export-format.js";

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

/** 行 1 つの列・型を検査する。問題があれば理由の文字列、なければ null。 */
function rowProblem(row: unknown): string | null {
  if (!isObject(row)) return "オブジェクトではありません";
  const keys = Object.keys(row);
  const missing = PRIOR_ROW_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) return `列が足りません(${missing.join("・")})`;
  const extra = keys.filter((k) => !(PRIOR_ROW_KEYS as readonly string[]).includes(k));
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
  const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
  return bad.length > 0 ? `型が違います(${bad.join("・")})` : null;
}

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
  if (meta.format !== PRIOR_EXPORT_FORMAT) {
    throw new Error(`読めない版のファイルです(format ${String(meta.format)}。このローダは ${PRIOR_EXPORT_FORMAT} を読みます)`);
  }
  const rows: PriorDatasetRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      throw new Error(`${i + 1} 行目が JSON ではありません`);
    }
    const problem = rowProblem(parsed);
    if (problem !== null) {
      throw new Error(`${i + 1} 行目: ${problem}`);
    }
    rows.push(parsed as PriorDatasetRow);
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
  }
}
