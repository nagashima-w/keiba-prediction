/**
 * R2 に置く「分析の詳細オブジェクト」の符号化(Issue #175・#172-b)。純関数だけで、R2・D1 には触れない。
 *
 * 詳細 = **大きな列 3 つ**(`race_snapshot_json`・`raw_response`・馬ごとの `contributions_json`)。D1 の1分析は約 6.6KB に収まり、
 * 詳細は約 129KB(平文)・level 1 の gzip で約 34KB(`docs/current-spec.md` の「R2 の詳細オブジェクトの圧縮」)。
 * 要約(D1)と詳細(R2)の分け方・書き込み順は `analysis-repository.ts`。
 *
 * 形式(JSON を gzip):
 * `{ format: 1, raceId, raceSnapshot, rawResponse, contributions: { "<馬番>": <値> } }`
 * - `format`: 形式の版。読めない版は「詳細なし」として扱う(後方互換の判断を読み出し側に押し付けない)
 * - `raceId`: 保存した分析のレース ID。読み出し側が D1 の行と一致を確かめる(キーの取り違えの防御)
 * - `contributions`: 馬ごとの寄与度。**null・undefined の馬は含めない**(codec の `toJsonOrNull` と同じ: NULL は「記録なし」)。
 *   空オブジェクト・0・false・空文字は null と区別して残す
 *
 * 圧縮は `node:zlib` の gzipSync(level 1)。CompressionStream はレベルを指定できず、level 6 相当(CPU が約4倍)になるため使わない
 * (workerd 上の CPU の実測は `scripts/measure-worker-cpu.ts`)。nodejs_compat が必要(wrangler.toml)。
 */

import { gunzipSync, gzipSync } from "node:zlib";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";

export const DETAIL_FORMAT = 1;

/** R2 に置く詳細オブジェクトの中身(JSON にする前の形)。 */
export interface AnalysisDetailPayload {
  readonly format: typeof DETAIL_FORMAT;
  readonly raceId: string;
  readonly raceSnapshot: unknown;
  readonly rawResponse: string | null;
  /** 馬番(文字列)→ 寄与度。null の馬は含めない。 */
  readonly contributions: Readonly<Record<string, unknown>>;
}

/** R2 のキー。冪等(同じ分析 id なら同じキー。再試行は同じキーに上書きする)。D1 の `detail_key` の式({@link DETAIL_KEY_SQL})と同じ形。 */
export function detailKeyOf(analysisId: number): string {
  return `analyses/${analysisId}.json.gz`;
}

/** D1 側(batch の UPDATE)で `detail_key` を作る SQL の式。{@link detailKeyOf} と同じ形(テストが D1 の値と突き合わせる)。 */
export const DETAIL_KEY_SQL = "'analyses/' || id || '.json.gz'";

/** 保存する分析から、R2 に置く部分だけを取り出す。 */
export function buildDetailPayload(rec: AnalysisRecord): AnalysisDetailPayload {
  const contributions: Record<string, unknown> = {};
  for (const horse of rec.horses) {
    if (horse.contributions !== undefined && horse.contributions !== null) {
      contributions[String(horse.umaban)] = horse.contributions;
    }
  }
  return {
    format: DETAIL_FORMAT,
    raceId: rec.raceId,
    raceSnapshot: rec.raceSnapshot === undefined ? null : rec.raceSnapshot,
    rawResponse: rec.rawResponse ?? null,
    contributions,
  };
}

/** 詳細オブジェクトを JSON → gzip(level 1)にする。JSON にできない値(循環参照・BigInt)は例外(呼び出し側は、D1 に書く前に呼ぶ)。 */
export function encodeDetail(rec: AnalysisRecord): Uint8Array {
  const json = JSON.stringify(buildDetailPayload(rec));
  return gzipSync(new TextEncoder().encode(json), { level: 1 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** gzip → JSON を復元する。壊れている・形が違うときは**例外を投げず null**(読み出し側は「詳細なし」として扱う)。 */
export function decodeDetail(bytes: Uint8Array): AnalysisDetailPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(gunzipSync(bytes)));
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed["format"] !== DETAIL_FORMAT ||
    typeof parsed["raceId"] !== "string" ||
    !("raceSnapshot" in parsed) ||
    !(parsed["rawResponse"] === null || typeof parsed["rawResponse"] === "string") ||
    !isRecord(parsed["contributions"])
  ) {
    return null;
  }
  return {
    format: DETAIL_FORMAT,
    raceId: parsed["raceId"],
    raceSnapshot: parsed["raceSnapshot"],
    rawResponse: parsed["rawResponse"],
    contributions: parsed["contributions"],
  };
}

/** 馬番から寄与度を引く。無ければ null(継承されたプロパティは引かない)。 */
export function contributionsOf(payload: AnalysisDetailPayload, umaban: number): unknown {
  const key = String(umaban);
  return Object.prototype.hasOwnProperty.call(payload.contributions, key) ? payload.contributions[key] : null;
}
