import type { AnalysisMissedBetRecord } from "../../packages/core/src/ev/analysis-store-types.js";

/**
 * 外した買い目の記録(Issue #470)の、D1 の列 `analysis_allocation_meta.missed_json` への写し。依存を持たない純モジュール。
 *
 * 表し方(`AnalysisAllocationMetaRecord.missed` と同じ):
 *  - null(NULL): 記録していない(旧い行・下限なし・外れた候補なし・外さなかった場合の賭け金を計算しなかった・配分未到達)
 *  - `[]`: 外れた候補はあったが、外さなかった場合でも賭け金が付いたものは無かった
 *  - 1件以上: 外さなかった場合に賭け金が付いた候補(`would_stake > 0` のものだけ)
 * JSON の各要素のキーは snake_case(bet_type・combo_key・hit_prob・odds・ev・would_stake)。`json_each` で集計できる:
 *   SELECT json_extract(j.value, '$.bet_type'), sum(json_extract(j.value, '$.would_stake'))
 *   FROM analysis_allocation_meta m, json_each(m.missed_json) j GROUP BY 1;
 * `combo_key` は `analysis_bets.combo_key` と同じ形(`buildAllocationBetComboKey`)なので、払戻の表(`race_combo_payouts`)と同じキーで突き合わせられる。
 */
export function serializeMissed(missed: readonly AnalysisMissedBetRecord[] | null | undefined): string | null {
  if (missed === null || missed === undefined) {
    return null;
  }
  return JSON.stringify(
    missed.map((m) => ({ bet_type: m.betType, combo_key: m.comboKey, hit_prob: m.hitProb, odds: m.odds, ev: m.ev, would_stake: m.wouldStake })),
  );
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 保存した JSON を読み戻す。NULL は null、壊れている・形が違うものも null(読めないだけで例外にしない)。 */
export function parseMissedJson(text: string | null): readonly AnalysisMissedBetRecord[] | null {
  if (text === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: AnalysisMissedBetRecord[] = [];
  for (const e of raw as unknown[]) {
    if (typeof e !== "object" || e === null) return null;
    const r = e as Record<string, unknown>;
    if (typeof r["bet_type"] !== "string" || typeof r["combo_key"] !== "string" || !isNum(r["hit_prob"]) || !isNum(r["odds"]) || !isNum(r["ev"]) || !isNum(r["would_stake"])) {
      return null;
    }
    out.push({ betType: r["bet_type"], comboKey: r["combo_key"], hitProb: r["hit_prob"], odds: r["odds"], ev: r["ev"], wouldStake: r["would_stake"] });
  }
  return out;
}
