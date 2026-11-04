/**
 * 目録のレース(R2 の読み取り結果)を `horse_runs` に変換して書く部品(Issue #588〈#549-B3-1〉。親は #549)。**呼び出し元は #590(毎晩の DO)**。この Issue の時点では、本番の Worker はこの部品を呼ばない。
 *
 * ## 何をするか
 * `convertRaceArchives(db, targets, now)`: 読み取り結果(`RaceRecord`)を core の `raceRecordToRuns` で 1 走ずつの行にして、**D1 の `batch` 1 回**で次を一緒に書く
 * (一緒に成功するか、一緒に落ちる):
 *  1. 新規の行(`writeResultRuns` と同じ文。`source = 'result'`・`ON CONFLICT DO NOTHING` = **戦績 API の行・既にある結果ページ由来の行に触れない**)
 *  2. 書き直し(`rewriteResultRuns` と同じ文。**結果ページ由来で版が古い行だけ**。`data` と版だけ更新し、初見時刻と出どころは変えない)
 *  3. 済み印(`race_archive.runs_version = RESULT_RUN_VERSION`)。目録の行が**読んだ時と同じ**(`raw_bytes`・`parser_version` が一致)ときだけ付ける。
 *     変換の途中で目録が更新されていたら印を付けない(次の周で読み直す。更新の保存が印を NULL に戻す仕組みと二重の守り)。
 * 複数レースを 1 回の batch に入れる(Worker の Free の 1 呼び出し 50 の内側に収めるため、文の数はレース数に比例させない)。文は
 * 「新規の行(500 行ごとに 1 文)+ 書き直し(同)+ 印 1 文」。印の文は `UPDATE ... FROM (json_each)` で主キーを引くので、目録の全件走査にならない(テストが rows_read で固定)。
 *
 * ## 拒否
 * `raceRecordToRuns` が `ok: false`(頭数の宣言と行数が合わない等。同じ入力には同じ結果が返る)のレースは、**行を書かず、拒否した版で印を付ける**(同じ版では再試行しない)。
 * 理由は戻り値の `outcomes` に返す(記録は呼び出し側)。ほかのレースの変換は妨げない。
 *
 * ## 書き込み行数
 * `rowsWritten` = batch の各文の `meta.rows_written` の合計(D1 の Free の 1 日の書き込みの上限〈10 万行〉に数えられる量)。呼び出し側が 1 晩の上限の管理に使う。
 * 行数の目安: 1 レース 約 13 走 + 印 1。冪等な再実行は horse_runs に書かない(印の更新の 1 行だけ)。
 *
 * ## 限界
 * 目録が変換の途中で更新された場合、書いた horse_runs の行は古い読み取り結果のものになる(印は付かないので、次の周で書き直される。ただし同じ `RESULT_RUN_VERSION` では
 * 書き直しの条件〈版が古い〉に当たらないので、変わった行は残る。過去の確定した結果ページの再取得で中身が変わることはまれで、受け入れる)。
 */

import type { RaceRecord } from "../../packages/core/src/scraper/race-record";
import { encodeHorseRun } from "../../packages/core/src/scraper/horse-run-record";
import { RESULT_RUN_VERSION, raceRecordToRuns } from "../../packages/core/src/scraper/race-record-to-runs";
import { prepareRewriteResultRuns, prepareWriteResultRuns, type ResultRunRow } from "./horse-runs-repository";

/** D1 のうち使う部分(`prepare` と `batch`)。 */
export type RaceArchiveRunsDb = Pick<D1Database, "prepare" | "batch">;

/** 変換の入力 1 件。`rawBytes`・`parserVersion` は、読んだ時点の目録の行の値(印を付ける条件に使う)。 */
export interface ConvertTarget {
  readonly raceId: string;
  readonly rawBytes: number;
  readonly parserVersion: number;
  readonly record: RaceRecord;
}

export type ConvertOutcome =
  | { readonly raceId: string; readonly status: "converted"; readonly runs: number; readonly skippedNonStart: number; readonly skippedNoHorseId: number }
  | { readonly raceId: string; readonly status: "rejected"; readonly reason: string };

export interface ConvertBatchResult {
  readonly outcomes: ConvertOutcome[];
  /** batch の各文の rows_written の合計。 */
  readonly rowsWritten: number;
  /** 印を付けた(更新できた)レースの数。目録の行が変わっていたレースは数えない。 */
  readonly markedRaces: number;
  /** batch の最後の結果の `meta.size_after`(数でなければ null)。 */
  readonly dbSizeBytes: number | null;
}

/**
 * 済み印を付ける。目録の行が読んだ時と同じ(raw_bytes・parser_version が一致)ものだけ。主キーで引く(`UPDATE ... FROM`)。
 * 値は [race_id, raw_bytes, parser_version] の配列の JSON 1 個をバインドする(1 文あたりの変数の上限に当たらない)。
 */
const MARK_SQL =
  "UPDATE race_archive SET runs_version = ? FROM (" +
  "SELECT json_extract(value, '$[0]') AS race_id, json_extract(value, '$[1]') AS raw_bytes, json_extract(value, '$[2]') AS parser_version FROM json_each(?)" +
  ") AS v WHERE race_archive.race_id = v.race_id AND race_archive.raw_bytes = v.raw_bytes AND race_archive.parser_version = v.parser_version";

const RACE_ID_RE = /^\d{12}$/;

function sizeOf(meta: { readonly size_after?: unknown } | undefined): number | null {
  const size = meta?.size_after;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

/**
 * 目録のレースを変換して `horse_runs` に書き、済み印を付ける。手順・拒否・書き込み行数はファイル先頭の説明。
 * `targets` が空なら D1 に触れない。入力の食い違い(race_id が 12 桁でない・record.raceId と違う・重複)は RangeError(D1 に触れる前)。
 * D1 の batch が失敗したら例外(何も書かれていない)。
 */
export async function convertRaceArchives(db: RaceArchiveRunsDb, targets: readonly ConvertTarget[], now: Date): Promise<ConvertBatchResult> {
  const seen = new Set<string>();
  for (const t of targets) {
    if (!RACE_ID_RE.test(t.raceId)) {
      throw new RangeError(`race_id は 12 桁の数字でなければなりません: ${JSON.stringify(t.raceId)}`);
    }
    if (t.record.raceId !== t.raceId) {
      throw new RangeError(`race_id(${t.raceId})と record.raceId(${t.record.raceId})が食い違います`);
    }
    if (seen.has(t.raceId)) {
      throw new RangeError(`race_id が重複しています: ${t.raceId}`);
    }
    seen.add(t.raceId);
  }
  if (targets.length === 0) {
    return { outcomes: [], rowsWritten: 0, markedRaces: 0, dbSizeBytes: null };
  }

  const firstSeenAt = now.getTime();
  const rows: ResultRunRow[] = [];
  const outcomes: ConvertOutcome[] = [];
  for (const t of targets) {
    const converted = raceRecordToRuns(t.record);
    if (!converted.ok) {
      outcomes.push({ raceId: t.raceId, status: "rejected", reason: converted.reason });
      continue;
    }
    for (const r of converted.runs) {
      rows.push({ horseId: r.horseId, raceKey: r.raceKey, parserVersion: RESULT_RUN_VERSION, firstSeenAt, data: JSON.stringify(encodeHorseRun(r.run)) });
    }
    outcomes.push({ raceId: t.raceId, status: "converted", runs: converted.runs.length, skippedNonStart: converted.skippedNonStart, skippedNoHorseId: converted.skippedNoHorseId });
  }

  const statements = [
    ...prepareWriteResultRuns(db, rows),
    ...prepareRewriteResultRuns(db, rows),
    db.prepare(MARK_SQL).bind(RESULT_RUN_VERSION, JSON.stringify(targets.map((t) => [t.raceId, t.rawBytes, t.parserVersion]))),
  ];
  const results = await db.batch(statements);
  const markResult = results[results.length - 1];
  return {
    outcomes,
    rowsWritten: results.reduce((sum, r) => sum + (r.meta.rows_written ?? 0), 0),
    markedRaces: markResult?.meta.changes ?? 0,
    dbSizeBytes: sizeOf(markResult?.meta),
  };
}
