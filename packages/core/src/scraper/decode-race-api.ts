/**
 * netkeiba の `race_api`(`compress=1`)の応答の、共通の復号(Issue #421 段階 1-b)。
 *
 * 同レース過去10年結果(`AplGradeWinner`。`parse-grade-winner.ts`)と新聞形式(`AplNewsPaper`。`parse-newspaper.ts`)は、
 * どちらも `{status, reason, data}` の JSON で、`data` のキーの 1 つの値が base64 + zlib(deflate)の JSON になっている。
 * この復号とキーの特定だけを共有する(`status` の扱いと正規化後の型は、API ごとに違うのでそれぞれのパーサが持つ)。
 *
 * 呼び出し側ごとの例外の文言を保つため、ここは文言を持たない例外(`RaceApiDecodeError`)と判別可能な値を返し、
 * 各パーサが自分の例外クラス・文言に直す(`GradeWinnerParseError` の文言は #421 より前から変えていない)。
 */

import { inflateSync } from "node:zlib";

/** 復号の失敗。`stage` は、base64/zlib の展開で失敗したか(inflate)、展開後の JSON の解析で失敗したか(json)。 */
export class RaceApiDecodeError extends Error {
  constructor(
    readonly stage: "inflate" | "json",
    readonly cause: unknown,
  ) {
    super(`race_api の応答の復号に失敗しました(${stage}): ${String(cause)}`);
    this.name = "RaceApiDecodeError";
  }
}

/** base64 → zlib → UTF-8 → JSON.parse。失敗は {@link RaceApiDecodeError}。 */
export function decodeRaceApiPayload(encoded: string): unknown {
  let text: string;
  try {
    // Buffer.from(...) で包むのは、型の解決のため(Issue #176: cloud の型検査は @cloudflare/workers-types と @types/node を併用し、
    // 前者の inflateSync の戻り値の型では toString("utf-8") が通らない。実行時は inflateSync が返す Buffer のコピーで、結果は同じ)。
    text = Buffer.from(inflateSync(Buffer.from(encoded, "base64"))).toString("utf-8");
  } catch (error) {
    throw new RaceApiDecodeError("inflate", error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RaceApiDecodeError("json", error);
  }
}

/** {@link findEncodedPayload} の結果。 */
export type EncodedPayload =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "no-key" | "not-string" };

/**
 * `data` から、ハッシュ付きキー(`_last_dt` で終わらないキー)の値(base64 文字列)を取り出す。
 * キー名をハードコードしない(grade-winner はキーにハッシュを含む。2026-07-28 recon 合意)。
 */
export function findEncodedPayload(data: Record<string, unknown>): EncodedPayload {
  const key = Object.keys(data).find((k) => !k.endsWith("_last_dt"));
  if (key === undefined) {
    return { ok: false, reason: "no-key" };
  }
  const value = data[key];
  return typeof value === "string" ? { ok: true, value } : { ok: false, reason: "not-string" };
}
