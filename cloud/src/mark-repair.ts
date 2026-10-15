/**
 * 印の補修の記録(Issue #317)。**純ロジック**。
 * クラウド版の分析で、LLM の印が規則に違反したとき、core の `analyzeRace` が `markRepair`(違反の種類・補修で印が変わった馬)を返す。
 * それを `analyses.mark_repair_json`(JSON 文字列。migration 0018)に保存し、(1) 結果画面・通知で「直」と元の印を出し、
 * (2) どの規則でよく外れるかを後から数えられるようにする(`json_each(mark_repair_json -> '$.attempts')` の `kinds`)。
 *
 * 保存・復元するのは**固定の語彙**だけ: 違反の種類(core の `MARK_VIOLATION_KINDS`)・既知の印6種・「なし」「不明」。LLM の生の文字列は入らない。
 * 復元は例外を投げず、語彙の外の値は捨てる(保存した値を画面に出す前の最後の関門)。
 */

import type { MarkRepairReport } from "@keiba/core/llm";
import { MARK_VIOLATION_KINDS, PREDICTION_MARKS, type MarkViolationKind, type PredictionMark } from "../../packages/core/src/analyzer/parse-response";
import type { MarkOrigin } from "../../packages/core/src/analyzer/repair-marks";

/** 保存の形の版。 */
export const MARK_REPAIR_VERSION = 1;

/** 復元した記録(保存の形)。 */
export interface MarkRepairRecord {
  readonly v: 1;
  /** 採用した応答の印を、実際に補修したか。聞き直しで解消した(違反が初回だけだった)ときは false。 */
  readonly repaired: boolean;
  /** 採用した応答の試行番号(1 = 初回、2 = 聞き直し)。 */
  readonly adoptedAttempt: 1 | 2;
  /** 印の違反があった試行ごとの違反の種類。 */
  readonly attempts: ReadonlyArray<{ readonly n: 1 | 2; readonly kinds: readonly MarkViolationKind[] }>;
  /** 補修で印が変わった馬(補修前の印 → 補修後の印)。 */
  readonly horses: ReadonlyArray<{ readonly umaban: number; readonly from: MarkOrigin; readonly to: PredictionMark | null }>;
}

const KIND_SET: ReadonlySet<string> = new Set(MARK_VIOLATION_KINDS);
const MARK_SET: ReadonlySet<string> = new Set(PREDICTION_MARKS);
const ORIGIN_SET: ReadonlySet<string> = new Set([...PREDICTION_MARKS, "なし", "不明"]);

/** 保存する JSON 文字列。記録なし(null・undefined)は null(NULL で保存する)。 */
export function serializeMarkRepair(report: MarkRepairReport | null | undefined): string | null {
  if (report === null || report === undefined) {
    return null;
  }
  return JSON.stringify({
    v: MARK_REPAIR_VERSION,
    repaired: report.repaired,
    adoptedAttempt: report.adoptedAttempt,
    attempts: report.attempts.map((a) => ({ n: a.n, kinds: [...a.kinds] })),
    horses: report.changes.map((c) => ({ umaban: c.umaban, from: c.from, to: c.to })),
  });
}

const isAttempt = (v: unknown): v is 1 | 2 => v === 1 || v === 2;

/**
 * 保存した JSON 文字列から記録を復元する。**例外を投げない**: NULL・壊れた JSON・形の違う値は null。
 * 語彙の外の値(未知の違反の種類・印・不正な馬番・試行番号)は、その要素だけ捨てる。許可したキーだけを返す。
 */
export function parseMarkRepair(raw: string | null | undefined): MarkRepairRecord | null {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  if (o["v"] !== MARK_REPAIR_VERSION || typeof o["repaired"] !== "boolean" || !isAttempt(o["adoptedAttempt"])) {
    return null;
  }
  const attempts: Array<{ n: 1 | 2; kinds: MarkViolationKind[] }> = [];
  if (Array.isArray(o["attempts"])) {
    for (const a of o["attempts"]) {
      if (typeof a !== "object" || a === null || Array.isArray(a)) continue;
      const rec = a as Record<string, unknown>;
      if (!isAttempt(rec["n"]) || !Array.isArray(rec["kinds"])) continue;
      attempts.push({ n: rec["n"], kinds: rec["kinds"].filter((k): k is MarkViolationKind => typeof k === "string" && KIND_SET.has(k)) });
    }
  }
  const horses: Array<{ umaban: number; from: MarkOrigin; to: PredictionMark | null }> = [];
  if (Array.isArray(o["horses"])) {
    for (const h of o["horses"]) {
      if (typeof h !== "object" || h === null || Array.isArray(h)) continue;
      const rec = h as Record<string, unknown>;
      const { umaban, from, to } = rec;
      if (typeof umaban !== "number" || !Number.isInteger(umaban) || umaban < 1) continue;
      if (typeof from !== "string" || !ORIGIN_SET.has(from)) continue;
      if (to !== null && !(typeof to === "string" && MARK_SET.has(to))) continue;
      horses.push({ umaban, from: from as MarkOrigin, to: to as PredictionMark | null });
    }
  }
  return { v: 1, repaired: o["repaired"], adoptedAttempt: o["adoptedAttempt"], attempts, horses };
}

/**
 * 補修で印が変わった馬の、補修前の印(馬番 → 印)。画面・通知の「直」の材料。
 * 補修していない(repaired:false。聞き直しで解消した)・記録なしは空。**現在の印が記録の補修後の印(to)と一致する馬だけ**を返す
 * (保存後に印が書き換わった等で食い違う馬に「直」を付けると、表示が事実と違うため)。
 * @param currentMarks 馬番 → 現在の印(D1 の `analysis_horses.mark`)
 */
export function markFromByUmaban(record: MarkRepairRecord | null, currentMarks: ReadonlyMap<number, string | null>): Map<number, MarkOrigin> {
  const m = new Map<number, MarkOrigin>();
  if (record === null || !record.repaired) {
    return m;
  }
  for (const h of record.horses) {
    if (currentMarks.has(h.umaban) && currentMarks.get(h.umaban) === h.to) {
      m.set(h.umaban, h.from);
    }
  }
  return m;
}
