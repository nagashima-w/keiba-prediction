/**
 * 統計モデルの見直し用の書き出し(Issue #266。#258 の第 2 段で重みを当て直すための標本)の形式。**純関数だけ**で、D1・R2・Worker の型に触れない
 * (DO の側〈`prior-export-core.ts`〉と、開発側のローダ〈`scripts/prior-dataset.ts`〉が同じ定義を使う)。
 *
 * ## ファイル
 * NDJSON(1 行 1 頭)を gzip したもの。**gzip の複数メンバーの連結**で、先頭メンバーがメタ行(`{"_meta": {...}}`)、続くメンバーが処理の 1 回ぶん(`encodeChunk`)の行。
 * 複数メンバーの gzip は 1 回の gunzip で読める(Node の `gunzipSync`・`gunzip` コマンドとも)。1 度に全部を 1 文字列にしない(DO のメモリ 128MB のため)ための形。
 * CSV にしないのは、項目ごとの補正(`contributions`)が入れ子だから。
 *
 * ## 母集団(`selectPriorExportAnalyses`)
 * 「先読みの遮断済み」(`history_cutoff_date` あり)**または**「遮断なしでも、分析が発走より前」(検証画面と同じ `classifyLookaheadSuspicion` が clean)の分析を、レースごとに最新 1 件。
 *  - 遮断済みは検証画面の clean の部分集合ではなく、`history_cutoff_date` があれば LLM のプロンプトの遮断(`prompt_lookahead_guarded`)を問わず入れる。prior・寄与度は履歴だけから決まり、
 *    プロンプトに依らないため。`adjusted_prob` を使うときは `prompt_lookahead_guarded` で絞ること。
 *  - 遮断なしで `start_time` が NULL(検証の DO の補完待ち)の行は判定できないので入れず、`excluded.unchecked` に数える。
 *  - `leak_class`: `guarded` = `history_cutoff_date` あり(ブリーフの A の母集団)、`pre_race` = 遮断なしだが発走前の分析。
 *
 * ## 行の列(`PRIOR_ROW_KEYS`。許可リスト。テストが完全一致を固定する)
 * 追加指示・LLM の生応答・`reason` などの自由文・馬名・設定・買い目は列にない。
 */

import { classifyLookaheadSuspicion } from "../../packages/core/src/ev/lookahead-suspicion.js";
import { kaisaiDateFromNarRaceId, venueKindOfRaceId } from "../../packages/core/src/scraper/ids.js";
import type { RaceId } from "../../packages/core/src/scraper/ids.js";
import { gzipSync } from "node:zlib";

/** ファイルの形式の版。列を足す・意味を変えるときに上げる(ローダは読めない版を例外にする)。 */
export const PRIOR_EXPORT_FORMAT = 1;

/** R2 のキー。固定(完成のたびに原子的に上書きする)。 */
export const PRIOR_EXPORT_KEY = "exports/prior-dataset.ndjson.gz";

export type LeakClass = "guarded" | "pre_race";

/** D1 の `analyses` から読む候補の行(結果のあるレースの分析だけ)。数値の真偽は D1 の 0/1/NULL のまま。 */
export interface CandidateRow {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly kaisaiDate: string | null;
  readonly promptVersion: string | null;
  readonly detailKey: string | null;
  readonly evEstimated: number | null;
  readonly promptLookaheadGuarded: number | null;
  readonly historyCutoffDate: string | null;
  /** 発走時刻の写し(migration 0009): NULL = 未確認・'' = 時刻なし・'?' = 確認できず・'HH:MM'。 */
  readonly startTime: string | null;
}

/** 書き出す対象に選んだ分析。 */
export interface ChosenAnalysis {
  readonly id: number;
  readonly raceId: string;
  readonly analyzedAt: string;
  readonly kaisaiDate: string | null;
  readonly promptVersion: string | null;
  readonly detailKey: string | null;
  readonly evEstimated: boolean;
  readonly promptLookaheadGuarded: boolean | null;
  readonly leakClass: LeakClass;
}

export interface ExcludedCounts {
  /** 遮断なしで、分析が発走より後(先読みの疑い)。 */
  readonly suspect: number;
  /** 遮断なしで、発走の前後を判定できない(時刻なしで開催日の当日中・日付や分析日時が読めない)。 */
  readonly unknown: number;
  /** 遮断なしで、`start_time` が NULL(発走時刻の補完待ち)。 */
  readonly unchecked: number;
  /** 同じレースの、より新しい適格な分析がある。 */
  readonly superseded: number;
}

/** `start_time` が検証の読み(`verify-read.ts` の GLOB '[0-9]*:[0-9][0-9]')で時刻として使われる形か。 */
const START_TIME_LIKE = /^[0-9].*:[0-9][0-9]$/s;

/**
 * 候補から書き出す分析を選ぶ。母集団の規則はファイル先頭の説明。結果は レースID の昇順(1 レース 1 件)。
 * 除外の内訳の和 + 採用 = 候補の総数。
 */
export function selectPriorExportAnalyses(candidates: readonly CandidateRow[]): { readonly chosen: ChosenAnalysis[]; readonly excluded: ExcludedCounts } {
  let suspect = 0;
  let unknown = 0;
  let unchecked = 0;
  const eligible: ChosenAnalysis[] = [];
  for (const c of candidates) {
    const guarded = c.historyCutoffDate !== null;
    if (!guarded) {
      if (c.startTime === null) {
        unchecked += 1;
        continue;
      }
      const verdict = classifyLookaheadSuspicion({
        raceId: c.raceId,
        analyzedAt: c.analyzedAt,
        kaisaiDate: c.kaisaiDate,
        promptVersion: c.promptVersion,
        historyCutoffDate: c.historyCutoffDate,
        promptLookaheadGuarded: c.promptLookaheadGuarded === null ? null : c.promptLookaheadGuarded === 1,
        raceSnapshot: START_TIME_LIKE.test(c.startTime) ? { race: { startTime: c.startTime } } : null,
      });
      if (verdict === "suspect") {
        suspect += 1;
        continue;
      }
      if (verdict === "unknown") {
        unknown += 1;
        continue;
      }
    }
    eligible.push({
      id: c.id,
      raceId: c.raceId,
      analyzedAt: c.analyzedAt,
      kaisaiDate: c.kaisaiDate,
      promptVersion: c.promptVersion,
      detailKey: c.detailKey,
      evEstimated: c.evEstimated === 1,
      promptLookaheadGuarded: c.promptLookaheadGuarded === null ? null : c.promptLookaheadGuarded === 1,
      leakClass: guarded ? "guarded" : "pre_race",
    });
  }
  const latest = new Map<string, ChosenAnalysis>();
  for (const a of eligible) {
    const current = latest.get(a.raceId);
    if (current === undefined || a.analyzedAt > current.analyzedAt || (a.analyzedAt === current.analyzedAt && a.id > current.id)) {
      latest.set(a.raceId, a);
    }
  }
  const chosen = [...latest.values()].sort((x, y) => (x.raceId < y.raceId ? -1 : x.raceId > y.raceId ? 1 : 0));
  return { chosen, excluded: { suspect, unknown, unchecked, superseded: eligible.length - chosen.length } };
}

/** 項目ごとの補正(寄与度ログの 1 項目)。自由文の `reason` は含めない。 */
export interface PriorContribution {
  readonly biasName: string;
  readonly applied: boolean;
  readonly weight: number | null;
  readonly correction: number | null;
  readonly sampleCount: number | null;
  readonly targetRate: number | null;
  readonly overallRate: number | null;
}

const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * R2 の詳細に入っている馬 1 頭の寄与度(core の `ScoreContribution[]`)を、書き出す形にする。
 * 配列でない・項目が壊れている(オブジェクトでない・`biasName` が文字列でない)ときは null(想定外の形を推測で直さない)。
 */
export function toContributions(raw: unknown): PriorContribution[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: PriorContribution[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>)["biasName"] !== "string") {
      return null;
    }
    const o = item as Record<string, unknown>;
    out.push({
      biasName: o["biasName"] as string,
      applied: o["applied"] === true,
      weight: finiteOrNull(o["weight"]),
      correction: finiteOrNull(o["correction"]),
      sampleCount: finiteOrNull(o["sampleCount"]),
      targetRate: finiteOrNull(o["targetRate"]),
      overallRate: finiteOrNull(o["overallRate"]),
    });
  }
  return out;
}

/** 書き出す行の列(この順で JSON にする)。許可リスト。 */
export const PRIOR_ROW_KEYS = [
  "analysis_id",
  "race_id",
  "kaisai_date",
  "venue_kind",
  "course_type",
  "field_size",
  "umaban",
  "prior",
  "adjusted_prob",
  "place_odds_min",
  "contributions",
  "finish_position",
  "win_odds",
  "ninki",
  "prompt_version",
  "analyzed_at",
  "ev_estimated",
  "prompt_lookahead_guarded",
  "leak_class",
] as const;

export interface PriorDatasetRow {
  readonly analysis_id: number;
  readonly race_id: string;
  readonly kaisai_date: string | null;
  readonly venue_kind: "central" | "nar";
  readonly course_type: string | null;
  /** その分析に載っている馬の数(`analysis_horses` の行数)。出馬表の取消・除外は分析前に除かれるが、分析後の取消は入りうる(そのとき着順は null)。 */
  readonly field_size: number;
  readonly umaban: number;
  readonly prior: number;
  readonly adjusted_prob: number;
  readonly place_odds_min: number | null;
  readonly contributions: PriorContribution[] | null;
  readonly finish_position: number | null;
  readonly win_odds: number | null;
  readonly ninki: number | null;
  readonly prompt_version: string | null;
  readonly analyzed_at: string;
  readonly ev_estimated: boolean;
  readonly prompt_lookahead_guarded: boolean | null;
  readonly leak_class: LeakClass;
}

export interface PriorHorseInput {
  readonly umaban: number;
  readonly prior: number;
  readonly adjustedProb: number;
  readonly placeOddsMin: number | null;
}

export interface PriorResultInput {
  readonly umaban: number;
  readonly finishPosition: number | null;
  readonly winOdds: number | null;
  readonly ninki: number | null;
}

/** 分析 1 件ぶんの行(馬番の昇順)。結果の無い馬は着順・オッズ・人気が null。寄与度は馬番 → 書き出す形(無い・読めない馬は null)。 */
export function buildRaceRows(
  analysis: ChosenAnalysis,
  horses: readonly PriorHorseInput[],
  results: readonly PriorResultInput[],
  courseType: string | null,
  contributions: ReadonlyMap<number, PriorContribution[] | null>,
): PriorDatasetRow[] {
  const resultByUmaban = new Map(results.map((r) => [r.umaban, r] as const));
  const venueKind = venueKindOfRaceId(analysis.raceId as RaceId);
  const kaisaiDate = analysis.kaisaiDate ?? kaisaiDateFromNarRaceId(analysis.raceId);
  return [...horses]
    .sort((a, b) => a.umaban - b.umaban)
    .map((h): PriorDatasetRow => {
      const r = resultByUmaban.get(h.umaban);
      return {
        analysis_id: analysis.id,
        race_id: analysis.raceId,
        kaisai_date: kaisaiDate,
        venue_kind: venueKind,
        course_type: courseType,
        field_size: horses.length,
        umaban: h.umaban,
        prior: h.prior,
        adjusted_prob: h.adjustedProb,
        place_odds_min: h.placeOddsMin,
        contributions: contributions.get(h.umaban) ?? null,
        finish_position: r?.finishPosition ?? null,
        win_odds: r?.winOdds ?? null,
        ninki: r?.ninki ?? null,
        prompt_version: analysis.promptVersion,
        analyzed_at: analysis.analyzedAt,
        ev_estimated: analysis.evEstimated,
        prompt_lookahead_guarded: analysis.promptLookaheadGuarded,
        leak_class: analysis.leakClass,
      };
    });
}

/** 行を NDJSON(末尾改行つき)にして、gzip の 1 メンバーにする。 */
export function encodeChunk(rows: readonly PriorDatasetRow[]): Uint8Array {
  return gzipSync(new TextEncoder().encode(rows.map((r) => `${JSON.stringify(r)}\n`).join("")), { level: 1 });
}

export interface PriorExportMetaInput {
  readonly generatedAt: string;
  readonly rows: number;
  readonly races: number;
  /** 寄与度の詳細(R2)が無い・読めなかったレースの数(そのレースの行は `contributions: null`)。 */
  readonly missingDetail: number;
  readonly excluded: ExcludedCounts;
}

/** メタ行の注記。読み手が誤解しやすい点(この形式で分からないこと)を書く。 */
const NOTES: readonly string[] = [
  "scorer の設定の版は記録されていない(D1・R2 のどこにも保存していない)。有効な重みは contributions[].weight(バイアスは減衰後の値)から読む。コードの版との対応は analyzed_at と prompt_version(scorer の変更を兼ねて上げた版がある)と git の履歴で引く。",
  "leak_class: guarded = history_cutoff_date あり(先読みの遮断済み)、pre_race = 遮断なしだが分析が発走より前(検証画面と同じ判定)。prior・contributions は履歴だけから決まる。adjusted_prob を使うときは prompt_lookahead_guarded で絞ること。",
  "field_size は分析に載っている馬の数。出馬表の取消・除外は分析前に除かれるが、分析後の取消は入りうる(着順は null)。着順が null の馬は中止・取消・除外のいずれか(区別できない)。",
  "win_odds・ninki は結果ページの確定値。取り込み前の旧い行・欄が空の馬は null(Issue #259)。",
  "contributions は寄与度ログ(自由文の reason は除く)。詳細(R2)が無い・読めないレースは null。",
];

/** ファイルを組み立てる: メタ行のメンバー + チャンクの連結。 */
export function assembleFile(meta: PriorExportMetaInput, chunks: readonly Uint8Array[]): Uint8Array {
  const head = gzipSync(
    new TextEncoder().encode(`${JSON.stringify({ _meta: { format: PRIOR_EXPORT_FORMAT, ...meta, columns: [...PRIOR_ROW_KEYS], notes: [...NOTES] } })}\n`),
    { level: 1 },
  );
  const parts = [head, ...chunks];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** ダウンロードのファイル名(JST の日時)。 */
export function exportFilename(generatedAtIso: string): string {
  const jst = new Date(Date.parse(generatedAtIso) + 9 * 60 * 60_000).toISOString();
  return `prior-dataset-${jst.slice(0, 10).replaceAll("-", "")}-${jst.slice(11, 16).replace(":", "")}.ndjson.gz`;
}
