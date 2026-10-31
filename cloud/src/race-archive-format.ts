/**
 * R2 に置く「1 レースの保存物」の符号化(Issue #551〈#549-A2〉。親は #549)。純関数だけで、R2・D1 には触れない。
 *
 * 保存物 = 結果ページの読み取り結果(`RaceRecord`)と、元の HTML。元の HTML を残すのは、読み取り(パーサ)を直したときに、
 * netkeiba へ取り直しに行かず読み直すため。保存の手順(R2 → D1)・柵・大きさの守りは `race-archive-repository.ts`。
 *
 * 形式(JSON を gzip level 1):
 * `{ format: 1, parserVersion, fetchedAt, record, html }`
 * - `format`: 形式の版。読めない版は「無い」として扱う(null)
 * - `parserVersion`: 読み取りの版(`record.parserVersion` と同じ値。読み出しで食い違いを検査する)
 * - `fetchedAt`: 取得した時刻(ISO 形式の UTC・ミリ秒つき 24 文字。長さが固定なので、同じ中身なら {@link EncodedRaceArchive.rawBytes} が変わらない)
 * - `record`: `buildRaceRecord` の出力そのまま(JSON 往復で値が変わらないことは、実フィクスチャでテストが固定)
 * - `html`: 結果ページの HTML(UTF-8 にデコード済みの文字列)
 *
 * 大きさの目安(手元の 1,258 件から無作為に 300 件を取って測った): HTML は平均 129KB、level 1 の gzip は平均 37KB、レコードは JSON で約 8.6KB。
 * 圧縮は `node:zlib` の `gzipSync`(level 1)。`CompressionStream` は level を選べず CPU が約 4 倍になるので使わない(`analysis-detail.ts` と同じ判断。nodejs_compat が要る)。
 * ★このモジュールは Worker 専用。`cloud/client` から import しない(`node:zlib` がブラウザの束に入る)。
 */

import { gunzipSync, gzipSync } from "node:zlib";
import type { RaceRecord } from "../../packages/core/src/scraper/race-record.js";
import { isRecord } from "../../packages/core/src/common/guards.js";

export const RACE_ARCHIVE_FORMAT = 1;

/** R2 に置く中身(JSON にする前の形)。 */
export interface RaceArchivePayload {
  readonly format: typeof RACE_ARCHIVE_FORMAT;
  readonly parserVersion: number;
  readonly fetchedAt: string;
  readonly record: RaceRecord;
  readonly html: string;
}

export interface EncodedRaceArchive {
  /** gzip 後のバイト列(R2 に put する本文)。 */
  readonly body: Uint8Array;
  /** gzip 前の JSON の UTF-8 バイト数。D1 の目録の `raw_bytes`。同じ中身なら取得時刻が違っても同じ値(圧縮後の長さは同じとは限らないので、比較にはこちらを使う)。 */
  readonly rawBytes: number;
}

const RACE_ID_RE = /^\d{12}$/;
/** `Date.prototype.toISOString()` の形(ミリ秒つきの UTC。24 文字)。 */
const FETCHED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** race_id が 12 桁の数字でなければ RangeError(R2 のキーを作る前の防御。キーに `/` や `..` を入れさせない)。 */
export function assertRaceId(raceId: string): void {
  if (!RACE_ID_RE.test(raceId)) {
    throw new RangeError(`race_id は 12 桁の数字でなければなりません: ${JSON.stringify(raceId)}`);
  }
}

/** R2 のキー。冪等(同じ race_id なら同じキー。再保存は同じキーに上書きする)。 */
export function raceArchiveKeyOf(raceId: string): string {
  assertRaceId(raceId);
  return `race-results/${raceId}.json.gz`;
}

/**
 * レコードと HTML を JSON → gzip(level 1)にする。JSON にできない値(循環参照・BigInt)・形の違う fetchedAt は例外
 * (呼び出し側は、R2 に書く前に呼ぶ)。
 */
export function encodeRaceArchive(input: { readonly record: RaceRecord; readonly html: string; readonly fetchedAt: string }): EncodedRaceArchive {
  if (!FETCHED_AT_RE.test(input.fetchedAt)) {
    throw new RangeError(`fetchedAt は ISO 形式(ミリ秒つきの UTC・24 文字)でなければなりません: ${JSON.stringify(input.fetchedAt)}`);
  }
  const payload: RaceArchivePayload = {
    format: RACE_ARCHIVE_FORMAT,
    parserVersion: input.record.parserVersion,
    fetchedAt: input.fetchedAt,
    record: input.record,
    html: input.html,
  };
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return { body: gzipSync(json, { level: 1 }), rawBytes: json.length };
}

/** gzip → JSON を復元する。壊れている・形が違うときは**例外を投げず null**(読み出し側は「無い」として扱う)。 */
export function decodeRaceArchive(bytes: Uint8Array): RaceArchivePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(gunzipSync(bytes)));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["format"] !== RACE_ARCHIVE_FORMAT) {
    return null;
  }
  const { parserVersion, fetchedAt, record, html } = parsed;
  if (typeof parserVersion !== "number" || typeof fetchedAt !== "string" || typeof html !== "string" || !isRecord(record) || typeof record["raceId"] !== "string") {
    return null;
  }
  if (record["parserVersion"] !== parserVersion) {
    return null;
  }
  return { format: RACE_ARCHIVE_FORMAT, parserVersion, fetchedAt, record: record as unknown as RaceRecord, html };
}
